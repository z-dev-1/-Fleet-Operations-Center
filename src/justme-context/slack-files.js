'use strict';
// src/justme-context/slack-files.js — Slack file reader for Just Me context.
// Round-3 fix 14, exact order: (1) the id is validated before ANY Slack call;
// (2) mode and declared size pre-checks; (3) files.info only when the payload
// needs it, merged over the original; (4) the download URL is validated on the
// MERGED record (https + SLACK_AUTH_HOSTS), so files.info can't swap in another
// host; (5) bounded download, then the extraction worker, with the Slack preview
// text as a fallback. Logs ids, sizes, status and ms only.

const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');
const { hostIn, SLACK_AUTH_HOSTS, slackFileIdFromPermalink } = require('./url-policy');

const FILE_ID_RE = /^F[A-Z0-9]+$/;
const DEAD_MODES = new Set(['external', 'tombstone', 'hidden_by_limit']);
const PREVIEW_MODES = new Set(['canvas', 'post', 'quip', 'docs', 'list']);
const PREVIEW_TYPES = new Set(['canvas', 'post', 'quip', 'docs', 'list']);
const MAX_DOWNLOAD = Math.max(...Object.values(LIMITS.MAX_BYTES));
const SNIPPET_MAX = LIMITS.MAX_BYTES.text;

function _logger(deps) {
  return (deps && deps.logger) || require('../utils/logger').createLogger('justme-context');
}

/** Report label for a file: the name without control chars, backticks or <>|, ≤ 80 chars. */
function fileLabel(name) {
  return String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f`<>|]/g, '').trim().slice(0, 80) || 'file';
}

const _item = (kind, status, reason, extra) => Object.assign({ kind, status, text: '', chars: 0, truncated: false, reason, meta: {} }, extra || {});

function _previewText(f) {
  for (const k of ['plain_text', 'preview_plain_text', 'preview']) {
    if (typeof f[k] === 'string' && f[k].trim()) return f[k].slice(0, LIMITS.RAW_TEXT_MAX_CHARS);
  }
  return '';
}
function _isPreviewMode(f) {
  return PREVIEW_MODES.has(String(f.mode || '')) || PREVIEW_TYPES.has(String(f.filetype || ''));
}
function _validUrl(f) {
  const raw = f.url_private_download || f.url_private;
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && hostIn(u.hostname, SLACK_AUTH_HOSTS);
  } catch (_) { return false; }
}

// downloadFileBounded reasons are free strings; map them to fixed REASONS.
function _dlReason(r) {
  const s = String(r || '');
  if (s === 'aborted') return { status: 'skipped', reason: REASONS.BUDGET };
  if (s === 'too-large') return { status: 'failed', reason: REASONS.TOO_LARGE };
  if (s === 'Slack file download needs re-auth') return { status: 'failed', reason: REASONS.SLACK_REAUTH };
  if (s === 'not a Slack file URL' || s === 'redirected off Slack') return { status: 'failed', reason: REASONS.INVALID_FILE };
  return { status: 'failed', reason: REASONS.SLACK_DOWNLOAD_FAILED };
}

/**
 * readSlackFile(file, ctx, deps) -> item { kind, status, text, chars, truncated, reason, meta, label }
 * ctx = the gather context { signal, deadline, jobId, visionLeft, session }.
 * deps: slackSend ({ getFileInfo, downloadFileBounded }), extractItem, logger, now.
 */
async function readSlackFile(file, ctx, deps) {
  ctx = ctx || {};
  deps = deps || {};
  const now = deps.now || Date.now;
  const log = _logger(deps);
  const t0 = now();
  const tag = '[jmctx][' + (ctx.jobId || '-') + '] file ';
  const f0 = file && typeof file === 'object' ? file : {};
  const label = fileLabel(f0.name || f0.title);
  const done = (item, id, bytes) => {
    item.label = item.label || label;
    try { log.info(tag + (id || '?') + ' ' + item.status + ' ' + (bytes || 0) + 'B ' + (now() - t0) + 'ms'); } catch (_) {}
    return item;
  };

  // (1) id first: no Slack call of any kind for a bad id.
  if (typeof f0.id !== 'string' || !FILE_ID_RE.test(f0.id)) return done(_item('file', 'failed', REASONS.INVALID_FILE), null, 0);
  const id = f0.id;

  // (2) mode and declared size.
  if (DEAD_MODES.has(String(f0.mode || ''))) return done(_item('file', 'failed', REASONS.FILE_EXTERNAL), id, 0);
  if (Number.isFinite(f0.size) && f0.size > MAX_DOWNLOAD) return done(_item('file', 'failed', REASONS.TOO_LARGE), id, 0);

  const slackSend = deps.slackSend || require('../scrapers/slack_send');

  // (3) files.info when the shared payload is a stub, has no URL, or needs preview text.
  let f = f0;
  if (f0.file_access === 'check_file_info' || !(f0.url_private_download || f0.url_private) || _isPreviewMode(f0)) {
    try {
      const info = await slackSend.getFileInfo(id);
      if (info && info.ok && info.file && typeof info.file === 'object') f = Object.assign({}, f0, info.file);
      else log.warn('[jmctx] files.info failed ' + id + ': ' + errTag({ code: info && info.error }));
    } catch (e) { log.warn('[jmctx] files.info failed ' + id + ': ' + errTag(e)); }
    if (DEAD_MODES.has(String(f.mode || ''))) return done(_item('file', 'failed', REASONS.FILE_EXTERNAL), id, 0);
    if (Number.isFinite(f.size) && f.size > MAX_DOWNLOAD) return done(_item('file', 'failed', REASONS.TOO_LARGE), id, 0);
  }
  const name = f.name || f.title || '';
  const lbl = fileLabel(name || label);
  const preview = _previewText(f);
  const fromPreview = (kind) => {
    const text = preview;
    return _item(kind, 'read', REASONS.SLACK_PREVIEW, { text, chars: text.length, meta: { via: 'slack-preview' }, label: lbl });
  };

  // Canvases, posts, quips: Slack-provided text only (design §8 table).
  if (_isPreviewMode(f) && String(f.mode || '') !== 'snippet') {
    return done(preview ? fromPreview(String(f.filetype || f.mode || 'canvas').replace(/[^a-z0-9]/g, '').slice(0, 20) || 'canvas') : _item('file', 'failed', REASONS.SLACK_NO_TEXT, { label: lbl }), id, 0);
  }

  // (4) URL validated on the MERGED record.
  if (!_validUrl(f)) return done(_item('file', 'failed', REASONS.INVALID_FILE, { label: lbl }), id, 0);

  // (5) bounded download -> worker.
  const snippet = String(f.mode || '') === 'snippet';
  const left = Number.isFinite(ctx.deadline) ? ctx.deadline - now() : LIMITS.SLACK_DL_TIMEOUT_MS;
  if (left <= 0 || (ctx.signal && ctx.signal.aborted)) return done(_item('file', 'skipped', REASONS.BUDGET, { label: lbl }), id, 0);
  const dl = await slackSend.downloadFileBounded(f, {
    maxBytes: snippet ? SNIPPET_MAX : MAX_DOWNLOAD,
    timeoutMs: Math.min(LIMITS.SLACK_DL_TIMEOUT_MS, left),
    signal: ctx.signal,
  });
  if (!dl || !dl.ok) {
    const m = _dlReason(dl && dl.reason);
    if (m.status !== 'skipped' && preview) return done(fromPreview('file'), id, 0);
    return done(_item('file', m.status, m.reason, { label: lbl }), id, 0);
  }
  const extractItem = deps.extractItem || require('./extract-host').extractItem;
  const mimetype = snippet && !/^text\//.test(String(f.mimetype || '')) ? 'text/plain' : (dl.mimetype || f.mimetype || '');
  const item = await extractItem({ buffer: dl.buffer, name: name || dl.name || '', mimetype }, ctx, deps);
  item.label = lbl;
  if ((item.status === 'unsupported' || item.status === 'failed') && preview) {
    const p = fromPreview(item.kind || 'file');
    if (item.status === 'unsupported') p.reason = item.reason + ' — ' + REASONS.SLACK_PREVIEW;
    return done(p, id, dl.buffer.length);
  }
  return done(item, id, dl.buffer.length);
}

module.exports = { readSlackFile, slackFileIdFromPermalink, fileLabel };
