'use strict';
/**
 * email-intel/attach/extract.js — attachment extraction through the existing extractor
 * (design 7.5, 7.6; R6.1, R6.3, R6.5, R6.6, F-14, F-28).
 *
 *   withExtractSession(fn, base)       runs fn(ctx) and ALWAYS closes ctx.session in finally
 *   mapItem(item, { noticePending })   extractItem result -> { analysis, text } (status mapping below)
 *   analyzeAttachments(o)              policy -> fetch -> extract -> map -> excerpt for one message
 *   markPendingReextract(attachments)  analyzed attachments of a message whose analysis did not finish
 *   hasPendingReextract(rec) / reextractTargets(doc, { max }) / markNotFound(attachments, indexes)
 *
 * Status mapping: read -> content, truncated -> content-partial, failed / unsupported -> unreadable
 * (with the extractor's fixed user-facing reason text, never file content), skipped -> skipped. A
 * findSecret hit on the extracted text discards it: unreadable `sensitive-content-withheld`.
 *
 * Persisted per attachment (analysis): status, via, chars, contentHash, reason, reasonText,
 * reextractAttempts. The extracted text and the excerpt are returned to the caller only (memory, F-14);
 * nothing here stores or logs them. Vision (images, scanned PDFs) goes through extractItem's existing
 * reader only while ctx.visionLeft > 0, which is 0 until the user acknowledged the one-time notice.
 */
const crypto = require('crypto');
const { findSecret } = require('../../justme-context/secret-scrub');
const { REASONS } = require('../../justme-context/constants');
const policyMod = require('./policy');
const excerptMod = require('./excerpt');

const REEXTRACT_MAX = 3;
const ANALYZED = new Set(['content', 'content-partial']);
const VIA = Object.freeze({ pdf: 'pdf-text', docx: 'docx', xlsx: 'xlsx', xls: 'xls', ods: 'xlsx', image: 'vision' });
// Fetch failures that may succeed on a later scan (counted toward reextractAttempts).
const RETRYABLE = new Set(['timeout', 'http-error', 'fetch-failed', 'no-chip', 'auth-wall', 'open-failed']);

function _extractItem(deps) {
  if (deps && typeof deps.extractItem === 'function') return deps.extractItem;
  return require('../../justme-context/extract-host').extractItem;
}

/** Runs fn(ctx); ctx.session (created lazily by extractItem) is closed on every path. */
async function withExtractSession(fn, base) {
  const ctx = Object.assign({ session: null }, base || {});
  try {
    return await fn(ctx);
  } finally {
    const s = ctx.session;
    ctx.session = null;
    if (s && typeof s.close === 'function') { try { s.close(); } catch (_) { /* worker already gone */ } }
  }
}

function _reasonCode(reasonString) {
  for (const k of Object.keys(REASONS)) if (REASONS[k] === reasonString) return k.toLowerCase().replace(/_/g, '-');
  return reasonString ? 'extract-failed' : '';
}

/** extractItem result -> { analysis, text }. text is null unless the status is content / content-partial. */
function mapItem(item, o) {
  const it = item || {};
  const noticePending = !!(o && o.noticePending);
  const visionCode = (o && o.visionReason) || (noticePending ? 'vision-notice-pending' : 'vision-limit');
  const reasonStr = typeof it.reason === 'string' ? it.reason : '';
  const via = it.meta && it.meta.via === 'vision' ? 'vision' : (VIA[it.kind] || String(it.kind || 'file').replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'file');
  if (it.status === 'read' || it.status === 'truncated') {
    const text = typeof it.text === 'string' ? it.text : '';
    if (findSecret(text)) return { analysis: { status: 'unreadable', via, reason: 'sensitive-content-withheld', reasonText: policyMod.reasonText('sensitive-content-withheld') }, text: null };
    if (!text.trim()) return { analysis: { status: 'unreadable', via, reason: 'empty', reasonText: REASONS.EMPTY }, text: null };
    return {
      analysis: { status: it.status === 'read' ? 'content' : 'content-partial', via, chars: text.length, contentHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) },
      text,
    };
  }
  if (it.status === 'skipped') {
    if (reasonStr === REASONS.VISION_CAP) {
      return { analysis: { status: 'skipped', via, reason: visionCode, reasonText: policyMod.reasonText(visionCode) }, text: null };
    }
    return { analysis: { status: 'skipped', via, reason: _reasonCode(reasonStr) || 'time-budget', reasonText: reasonStr ? reasonStr.slice(0, 80) : policyMod.reasonText('time-budget') }, text: null };
  }
  return { analysis: { status: 'unreadable', via, reason: _reasonCode(reasonStr) || 'extract-failed', reasonText: (reasonStr || REASONS.PARSE_FAILED).slice(0, 80) }, text: null };
}

function _keep(prev, next) {
  const out = Object.assign({}, next);
  const n = prev && Number.isFinite(prev.reextractAttempts) ? prev.reextractAttempts : 0;
  if (n) out.reextractAttempts = n;
  return out;
}

/**
 * analyzeAttachments(o) -> { attachments, excerpts, stats, authBlocked }
 * o: { attachments, fetchOne(att, index, { maxBytes, timeoutMs }) -> { ok, buffer, mimetype } | { ok:false, reason },
 *      budget (policy.createBudget), flagOn, unitIds, signal, only:Set<index>|null (re-extract targets),
 *      reextract:boolean, now(), deps:{ extractItem } }
 * Returns copies; the input array is not changed. excerpts: [{ index, status, text }] (memory only).
 */
async function analyzeAttachments(o) {
  const opts = o || {};
  const list = Array.isArray(opts.attachments) ? opts.attachments : [];
  const out = list.map((a) => Object.assign({}, a, { analysis: Object.assign({}, (a && a.analysis) || { status: 'filename-only' }) }));
  const stats = { considered: 0, fetched: 0, analyzed: 0, unreadable: 0, skipped: 0, retry: 0 };
  const texts = [];
  let authBlocked = false;
  const budget = opts.budget;
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const extract = _extractItem(opts.deps);
  let perMessage = 0;

  await withExtractSession(async (ctx) => {
    for (let i = 0; i < out.length; i++) {
      if (opts.only && !opts.only.has(i)) continue;
      const att = out[i];
      const prev = att.analysis || {};
      stats.considered++;
      const d = policyMod.decide(att, budget, { flagOn: opts.flagOn === true, perMessageUsed: perMessage, now: clock() });
      if (!d.allow) {
        att.analysis = _keep(prev, { status: d.status, reason: d.reason, reasonText: policyMod.reasonText(d.reason) });
        if (d.status === 'skipped') stats.skipped++; else if (d.status === 'unreadable') stats.unreadable++;
        continue;
      }
      perMessage++;
      budget.take();
      let f = null;
      try {
        f = await opts.fetchOne(att, i, { maxBytes: budget.policy.maxBytes, timeoutMs: Math.max(1, Math.min(budget.policy.fetchTimeoutMs, budget.remainingMs(clock()))) });
      } catch (_) { f = { ok: false, reason: 'fetch-failed' }; }
      if (!f || !f.ok || !f.buffer) {
        const reason = (f && f.reason) || 'fetch-failed';
        if (reason === 'auth-wall') authBlocked = true;
        if (opts.reextract && RETRYABLE.has(reason)) {
          const n = (Number.isFinite(prev.reextractAttempts) ? prev.reextractAttempts : 0) + 1;
          att.analysis = n >= REEXTRACT_MAX
            ? { status: 'unreadable', reason: 'reextract-exhausted', reasonText: policyMod.reasonText('reextract-exhausted'), reextractAttempts: n }
            : Object.assign({}, prev, { status: 'pending-reextract', reextractAttempts: n, lastError: reason });
          if (n < REEXTRACT_MAX) stats.retry++; else stats.unreadable++;
        } else {
          att.analysis = _keep(prev, { status: 'unreadable', reason, reasonText: policyMod.reasonText(reason) });
          stats.unreadable++;
        }
        if (authBlocked) break;
        continue;
      }
      stats.fetched++;
      ctx.deadline = budget.deadline;
      ctx.visionLeft = budget.visionLeft;
      let item = null;
      try {
        item = await extract({ buffer: f.buffer, name: att.name || '', mimetype: f.mimetype || '', source: 'email_attachment' }, ctx, opts.deps || {});
      } catch (_) { item = { status: 'failed', reason: REASONS.PARSE_FAILED, kind: 'file' }; }
      budget.visionLeft = Number.isFinite(ctx.visionLeft) ? ctx.visionLeft : budget.visionLeft;
      const m = mapItem(item, { noticePending: budget.noticePending, visionReason: policyMod.visionReason(budget) });
      att.analysis = _keep(prev, Object.assign(m.analysis, { analyzedAt: new Date(clock()).toISOString() }));
      if (m.text) {
        stats.analyzed++;
        texts.push({ index: i, status: m.analysis.status, text: excerptMod.selectExcerpt(m.text, { unitIds: opts.unitIds }) });
      } else if (m.analysis.status === 'skipped') stats.skipped++; else stats.unreadable++;
      if (opts.signal && opts.signal.aborted) break;
    }
  }, { signal: opts.signal, deadline: budget ? budget.deadline : Date.now(), visionLeft: budget ? budget.visionLeft : 0 });

  return { attachments: out, excerpts: excerptMod.messageExcerpts(texts), stats, authBlocked };
}

/** Analysis of the message did not finish this scan: analyzed attachments are re-fetched next scan (F-14). */
function markPendingReextract(attachments) {
  let n = 0;
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a || !a.analysis || !ANALYZED.has(a.analysis.status)) continue;
    a.analysis = Object.assign({}, a.analysis, { status: 'pending-reextract' });
    n++;
  }
  return n;
}

function hasPendingReextract(rec) {
  return ((rec && rec.attachments) || []).some((a) => a && a.analysis && a.analysis.status === 'pending-reextract');
}

/** A row that cannot be found again ends its pending attachments as unreadable: not-found. */
function markNotFound(attachments, indexes) {
  let n = 0;
  (Array.isArray(attachments) ? attachments : []).forEach((a, i) => {
    if (!a || !a.analysis || a.analysis.status !== 'pending-reextract' || (indexes && !indexes.has(i))) return;
    a.analysis = { status: 'unreadable', reason: 'not-found', reasonText: policyMod.reasonText('not-found'), reextractAttempts: a.analysis.reextractAttempts || 0 };
    n++;
  });
  return n;
}

/** The message could not be re-opened this scan: one more attempt, then unreadable: reextract-exhausted. */
function recordReextractFailure(attachments, indexes, reason) {
  let n = 0;
  (Array.isArray(attachments) ? attachments : []).forEach((a, i) => {
    if (!a || !a.analysis || a.analysis.status !== 'pending-reextract' || (indexes && !indexes.has(i))) return;
    const k = (Number.isFinite(a.analysis.reextractAttempts) ? a.analysis.reextractAttempts : 0) + 1;
    a.analysis = k >= REEXTRACT_MAX
      ? { status: 'unreadable', reason: 'reextract-exhausted', reasonText: policyMod.reasonText('reextract-exhausted'), reextractAttempts: k }
      : Object.assign({}, a.analysis, { reextractAttempts: k, lastError: reason || 'open-failed' });
    n++;
  });
  return n;
}

/**
 * reextractTargets(doc, { max }) -> { targets:[{ messageKey, conversationKey, convIdRaw, folder, indexes:[i] }], unreachable:[messageKey] }
 * Messages without a real OWA conversation id cannot be re-selected and are reported as unreachable.
 */
function reextractTargets(doc, o) {
  const max = o && Number.isFinite(o.max) ? o.max : 8;
  const targets = []; const unreachable = [];
  const recs = Object.values((doc && doc.messages) || {}).filter(hasPendingReextract)
    .sort((a, b) => (Date.parse(b.receivedAt || '') || 0) - (Date.parse(a.receivedAt || '') || 0));
  for (const r of recs) {
    if (r.convIdSource === 'derived' || !r.convIdRaw) { unreachable.push(r.messageKey); continue; }
    if (targets.length >= max) break;
    const indexes = [];
    (r.attachments || []).forEach((a, i) => { if (a && a.analysis && a.analysis.status === 'pending-reextract') indexes.push(i); });
    targets.push({ messageKey: r.messageKey, conversationKey: r.conversationKey, convIdRaw: r.convIdRaw, folder: r.folder || 'Inbox', indexes });
  }
  return { targets, unreachable };
}

module.exports = {
  REEXTRACT_MAX, ANALYZED, RETRYABLE,
  withExtractSession, mapItem, analyzeAttachments, markPendingReextract, hasPendingReextract, markNotFound, recordReextractFailure, reextractTargets,
};
