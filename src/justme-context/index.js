'use strict';
// src/justme-context/index.js — the gather orchestrator (design §7.3) and the
// "What I read" report (design §12.2). Files first, then links from Z's typed
// msg.text ONLY (never from fetched or extracted content: no crawling), one at a
// time under the budget. Items live in memory only. This module never sends
// anything to Slack; the caller owns the single reply.

const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');
const { extractUrls, classifyUrl, linkLabel } = require('./url-policy');
const { fileLabel } = require('./slack-files');

// Default intents for messages with no typed text. Both avoid every _fleetKw term
// in processOrchaAction (src/ipc/ai.js:379) and its id-like regex, and neither
// starts a clause with a command verb the action gate would allow.
const DEFAULT_INTENT_FILES = "Read the attached content and tell me briefly what it covers, then ask me how I'd like to use it.";
const DEFAULT_INTENT_LINKS = "Read the linked page(s) and tell me briefly what they cover, then ask me how I'd like to use them.";

// Extra links beyond MAX_LINKS are listed as skipped, up to this many.
const LINK_SCAN_MAX = 50;

function _logger(deps) {
  return (deps && deps.logger) || require('../utils/logger').createLogger('justme-context');
}

/** True when the message has Slack files or URLs in its typed text. */
function hasContext(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (Array.isArray(msg.files) && msg.files.length > 0) return true;
  try { return extractUrls(msg.text || '', 1).length > 0; } catch (_) { return false; }
}

const _blank = (base, status, reason) => Object.assign({ kind: 'file', text: '', chars: 0, truncated: false, meta: {} }, base, { status, reason });

// Slack unfurl fallback for a failed link: the attachment whose from_url/original_url matches.
function _unfurlFor(msg, url) {
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const a of atts) {
    if (!a || typeof a !== 'object') continue;
    for (const k of ['from_url', 'original_url']) {
      let href = null;
      try { href = a[k] ? new URL(String(a[k])).href : null; } catch (_) { href = null; }
      if (href && href === url) {
        const text = [a.title, a.text].filter((s) => typeof s === 'string' && s.trim()).join('\n').slice(0, LIMITS.RAW_TEXT_MAX_CHARS);
        if (text) return text;
      }
    }
  }
  return '';
}

/**
 * gatherContext(msg, { signal, deadline, jobId }, deps) -> { items, hasFiles, hasLinks }
 * deps (all optional): readSlackFile, fetchInternal, fetchExternal, plus anything
 * those pass through (slackSend, electron, https, http, dns, extractItem, bedrock,
 * spawnWorker, getChildRss, logger, now). The worker session is created lazily by
 * extractItem on ctx.session and closed here in finally.
 */
async function gatherContext(msg, opts, deps) {
  msg = msg || {};
  opts = opts || {};
  deps = deps || {};
  const now = deps.now || Date.now;
  const log = _logger(deps);
  const jobId = opts.jobId || '-';
  const deadline = Number.isFinite(opts.deadline) ? opts.deadline : now() + LIMITS.EXTRACT_BUDGET_MS;

  // One internal signal: aborts on the caller's signal or at the deadline, so a
  // hanging fetch is cut off and every fetcher sees the same abort.
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', onOuter, { once: true }); }
  const dTimer = setTimeout(() => ac.abort(), Math.min(0x7fffffff, Math.max(0, deadline - now())));

  const ctx = { signal: ac.signal, deadline, jobId, visionLeft: LIMITS.MAX_VISION, session: null };
  const items = [];
  const files = Array.isArray(msg.files) ? msg.files : [];
  let urls = [];
  try { urls = extractUrls(msg.text || '', LINK_SCAN_MAX); } catch (_) { urls = []; }
  let seq = 0;
  const nextId = () => 'c' + (++seq);
  let budgetWarned = false;
  const outOfBudget = () => ac.signal.aborted || now() >= deadline;
  const skipBudget = (base) => {
    if (!budgetWarned) { budgetWarned = true; log.warn('[jmctx][' + jobId + '] time budget reached'); }
    items.push(_blank(base, 'skipped', REASONS.BUDGET));
  };
  // Race one item against the abort, so a never-settling dependency can't hold the gather.
  const bounded = (fn) => new Promise((resolve) => {
    if (ac.signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    ac.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(fn).then(
      (v) => { ac.signal.removeEventListener('abort', onAbort); resolve(v || null); },
      (e) => { ac.signal.removeEventListener('abort', onAbort); resolve({ __error: errTag(e) }); },
    );
  });
  const push = (base, r) => {
    if (r === null) return skipBudget(base);
    if (r.__error) { log.warn('[jmctx][' + jobId + '] ' + base.source + ' read failed: ' + r.__error); return items.push(_blank(base, 'failed', REASONS.PARSE_FAILED)); }
    const label = base.source === 'file' && r.label ? r.label : base.label;
    const it = Object.assign({}, r, { id: base.id, source: base.source, label });
    if (!it.kind) it.kind = base.kind;
    if (typeof it.text !== 'string') it.text = '';
    it.chars = it.text.length;
    items.push(it);
  };

  const readSlackFile = deps.readSlackFile || require('./slack-files').readSlackFile;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {};
      const base = { id: nextId(), source: 'file', kind: 'file', label: fileLabel(f.name || f.title) };
      if (i >= LIMITS.MAX_FILES) { items.push(_blank(base, 'skipped', REASONS.MORE_FILES)); continue; }
      if (outOfBudget()) { skipBudget(base); continue; }
      push(base, await bounded(() => readSlackFile(f, ctx, deps)));
    }
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      const base = { id: nextId(), source: 'link', kind: 'page', label: linkLabel(u) };
      if (i >= LIMITS.MAX_LINKS) { items.push(_blank(base, 'skipped', REASONS.MORE_LINKS)); continue; }
      const cls = classifyUrl(u);
      if (cls.kind === 'blocked') {
        log.info('[jmctx][' + jobId + '] link blocked ' + (cls.host || '-'));
        items.push(_blank(base, 'blocked', cls.reason));
        continue;
      }
      if (cls.kind === 'slack' && !cls.fileId) { items.push(_blank(base, 'unsupported', cls.reason)); continue; }
      if (outOfBudget()) { skipBudget(base); continue; }
      let r;
      if (cls.kind === 'slack') {
        base.source = 'file';
        r = await bounded(() => readSlackFile({ id: cls.fileId }, ctx, deps));
        if (r && !r.__error && r.label === 'file') r.label = base.label;
      } else if (cls.kind === 'internal' || cls.kind === 'vendor') {
        const fetchInternal = deps.fetchInternal || require('./fetch-internal').fetchInternal;
        r = await bounded(() => fetchInternal(u, cls, ctx, deps));
      } else {
        const fetchExternal = deps.fetchExternal || require('./fetch-external').fetchExternal;
        r = await bounded(() => fetchExternal(u, ctx, deps));
      }
      if (r && !r.__error && (r.status === 'failed' || r.status === 'blocked') && cls.kind !== 'slack') {
        const text = _unfurlFor(msg, u);
        if (text) r = { kind: 'page', status: 'read', text, chars: text.length, truncated: false, reason: REASONS.SLACK_PREVIEW, meta: { via: 'slack-preview' } };
      }
      push(base, r);
    }
  } finally {
    clearTimeout(dTimer);
    if (opts.signal) opts.signal.removeEventListener('abort', onOuter);
    if (ctx.session) { try { ctx.session.close(); } catch (_) { /* already gone */ } }
  }
  return { items, hasFiles: files.length > 0, hasLinks: urls.length > 0 };
}

const REPORT_HEAD = '\n\n📎 *What I read*';

/** "What I read" report lines (design §12.2). Built only from fixed strings and sanitized labels. */
function buildReport(jmCtx, packing) {
  if (!jmCtx || typeof jmCtx !== 'object') return '';
  if (jmCtx.fatal) return REPORT_HEAD + "\n• I couldn't read the attachments or links (internal error)";
  const items = Array.isArray(jmCtx.items) ? jmCtx.items : [];
  if (!items.length) return '';
  let out = REPORT_HEAD;
  let shown = 0;
  for (const it of items) {
    if (shown >= LIMITS.REPORT_MAX_LINES) break;
    const p = packing && it && packing[it.id];
    const status = (p && typeof p.status === 'string' && p.status) || it.status || 'failed';
    const label = String(it.label || (it.source === 'link' ? 'link' : 'file')).replace(/[`\r\n]/g, '').slice(0, 80);
    const kind = String(it.kind || (it.source === 'link' ? 'page' : 'file')).replace(/[^a-z0-9]/gi, '').slice(0, 20);
    const line = '\n• `' + label + '` — ' + kind + ' — ' + status + (it.reason ? ': ' + it.reason : '');
    const rest = items.length - shown - 1;
    const tailRoom = rest > 0 ? ('\n…and ' + rest + ' more').length : 0;
    if (out.length + line.length + tailRoom > LIMITS.REPORT_MAX_CHARS) break;
    out += line;
    shown++;
  }
  if (items.length > shown) out += '\n…and ' + (items.length - shown) + ' more';
  return out.slice(0, LIMITS.REPORT_MAX_CHARS);
}

module.exports = { gatherContext, hasContext, buildReport, DEFAULT_INTENT_FILES, DEFAULT_INTENT_LINKS, LIMITS, REASONS };
