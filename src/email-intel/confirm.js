'use strict';
/**
 * email-intel/confirm.js — confirmation tokens + native human proof (design 1.7, F-18).
 *
 * Nothing consequential (send, delete, approve, spend, operator DM) runs without
 * BOTH a server-side single-use token AND an accepted native main-process dialog:
 *
 *   prepare(kind, payload, { now })          -> { ok, token, summary, expiresAt } | { ok:false, code }
 *   confirm(token, { event, _dialog, now })  -> executor result | { ok:false, code }
 *   registerExecutor(kind, { summarize, run })
 *
 * Tokens: 16 random bytes hex, in memory only, TTL 5 minutes, single use, bound
 * to a hash of the payload, at most 50 live (oldest dropped). The summary is
 * built here, in the main process, from the payload. A token minted by code is
 * not evidence of a click, so for the consequential kinds confirm() opens an OS
 * dialog (dialog.showMessageBox, owned by the main process) before running
 * anything. A cancelled or failed dialog consumes the token and runs nothing.
 *
 * Failure codes: TOKEN_UNKNOWN | TOKEN_EXPIRED | TOKEN_USED | USER_CANCELLED
 * (plus BAD_KIND, BAD_ARG, KIND_UNAVAILABLE, PAYLOAD_MISMATCH, DIALOG_UNAVAILABLE,
 * DIALOG_FAILED, EXECUTOR_FAILED). Tokens are logged by their first 4 hex chars only.
 */
const crypto = require('crypto');
const C = require('./constants');
const { safeErr, tokenTag } = require('./redact');
let logger;
try { logger = require('../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const KINDS = Object.freeze(['send-reply', 'delete', 'delete-batch', 'approve-staged', 'reject-staged', 'mark-send-resolution', 'send-ready-dm']);
// Everything except reject-staged (a local, non-consequential decision) needs the native dialog.
const CONSEQUENTIAL = Object.freeze(['send-reply', 'delete', 'delete-batch', 'approve-staged', 'mark-send-resolution', 'send-ready-dm']);

const KIND_TITLE = Object.freeze({
  'send-reply': 'Send reply', 'delete': 'Delete email', 'delete-batch': 'Delete emails',
  'approve-staged': 'Apply staged update', 'reject-staged': 'Reject staged update',
  'mark-send-resolution': 'Resolve uncertain send', 'send-ready-dm': 'Send ready message',
});
const KIND_BUTTON = Object.freeze({
  'send-reply': 'Send', 'delete': 'Delete', 'delete-batch': 'Delete', 'approve-staged': 'Apply',
  'reject-staged': 'Reject', 'mark-send-resolution': 'Confirm', 'send-ready-dm': 'Send',
});

const TOKEN_RE = /^[0-9a-f]{32}$/;
const MAX_USED_REMEMBERED = 500;
const HEADLINE_MAX = 200;

const _executors = new Map();
const _live = new Map();      // token -> { kind, payload, hash, summary, expiresAt }
const _gone = new Map();      // token -> 'TOKEN_USED' | 'TOKEN_EXPIRED' (bounded) so a replay or a late confirm is reported precisely

// ── helpers ────────────────────────────────────────────────────────────────────
const CTRL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

/** cleanLabel(s, max): control-stripped, whitespace-collapsed, capped (default 60) display text. */
function cleanLabel(s, max) {
  const n = Number.isFinite(max) ? max : C.CONFIRM_LABEL_MAX_CHARS;
  const t = String(s == null ? '' : s).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '\u2026' : t;
}

function _cleanDetail(s) {
  const t = String(s == null ? '' : s).replace(CTRL_RE, (c) => (c === '\n' ? c : ' ')).trim();
  return t.length > C.CONFIRM_DETAIL_MAX_CHARS ? t.slice(0, C.CONFIRM_DETAIL_MAX_CHARS - 1) + '\u2026' : t;
}

function _stable(v) {
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
function payloadHash(payload) { return crypto.createHash('sha256').update(_stable(payload)).digest('hex'); }

function _isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

function _remember(token, code) {
  _gone.set(token, code);
  while (_gone.size > MAX_USED_REMEMBERED) _gone.delete(_gone.keys().next().value);
}
function _purgeExpired(now) {
  for (const [t, r] of _live) if (r.expiresAt <= now) { _live.delete(t); _remember(t, 'TOKEN_EXPIRED'); }
}

// ── registry ───────────────────────────────────────────────────────────────────
/**
 * registerExecutor(kind, { summarize(payload) -> { headline, detailText, ... }, run(payload, ctx) -> result })
 * summarize is optional (a generic summary is used); run is required.
 */
function registerExecutor(kind, spec) {
  if (!KINDS.includes(kind)) throw new Error('unknown confirm kind: ' + kind);
  if (!spec || typeof spec.run !== 'function') throw new Error('executor.run is required');
  _executors.set(kind, { summarize: typeof spec.summarize === 'function' ? spec.summarize : null, run: spec.run });
}
function hasExecutor(kind) { return _executors.has(kind); }

// ── prepare ────────────────────────────────────────────────────────────────────
function prepare(kind, payload, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!KINDS.includes(kind)) return { ok: false, code: 'BAD_KIND' };
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  const ex = _executors.get(kind);
  if (!ex) return { ok: false, code: 'KIND_UNAVAILABLE' };
  let frozen;
  try { frozen = JSON.parse(JSON.stringify(payload)); } catch (_) { return { ok: false, code: 'BAD_ARG', field: 'payload' }; }
  let built;
  try { built = ex.summarize ? ex.summarize(JSON.parse(JSON.stringify(frozen))) : null; } catch (e) {
    logger.warn('[email-intel] confirm summarize failed kind=' + kind + ' ' + safeErr(e));
    return { ok: false, code: 'BAD_ARG', field: 'payload' };
  }
  const hash = payloadHash(frozen);
  const summary = Object.assign({}, built || {}, {
    kind,
    headline: cleanLabel((built && built.headline) || KIND_TITLE[kind], HEADLINE_MAX),
    detailText: _cleanDetail(built && built.detailText),
    payloadHash: hash.slice(0, 12),
  });
  _purgeExpired(now);
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = now + C.CONFIRM_TTL_MS;
  _live.set(token, { kind, payload: frozen, hash, summary, expiresAt });
  while (_live.size > C.CONFIRM_MAX_LIVE_TOKENS) {
    const oldest = _live.keys().next().value;
    _live.delete(oldest); // dropped tokens are simply unknown afterwards
  }
  return { ok: true, token, summary, expiresAt };
}

// ── native human proof ─────────────────────────────────────────────────────────
async function _nativeConfirm(rec, opts) {
  let electron = null;
  try { electron = require('electron'); } catch (_) { electron = null; }
  const dialog = opts._dialog || (electron && electron.dialog);
  if (!dialog || typeof dialog.showMessageBox !== 'function') return { ok: false, code: 'DIALOG_UNAVAILABLE' };
  let parent;
  try {
    const BW = electron && electron.BrowserWindow;
    if (BW && typeof BW.fromWebContents === 'function' && opts.event && opts.event.sender) parent = BW.fromWebContents(opts.event.sender) || undefined;
  } catch (_) { parent = undefined; }
  const box = {
    type: 'warning',
    title: KIND_TITLE[rec.kind],
    message: rec.summary.headline,
    detail: rec.summary.detailText,
    buttons: ['Cancel', KIND_BUTTON[rec.kind]],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  let r;
  try { r = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box); } catch (e) {
    logger.warn('[email-intel] confirm dialog failed kind=' + rec.kind + ' ' + safeErr(e));
    return { ok: false, code: 'DIALOG_FAILED' };
  }
  if (!r || r.response !== 1) return { ok: false, code: 'USER_CANCELLED' };
  return { ok: true };
}

// ── confirm ────────────────────────────────────────────────────────────────────
async function confirm(token, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const t = typeof token === 'string' ? token : '';
  const rec = TOKEN_RE.test(t) ? _live.get(t) : undefined;
  if (!rec) {
    const code = (TOKEN_RE.test(t) && _gone.get(t)) || 'TOKEN_UNKNOWN';
    logger.warn('[email-intel] confirm rejected code=' + code + ' tok=' + tokenTag(t));
    return { ok: false, code };
  }
  // Single use: consumed from here on, whatever happens next.
  _live.delete(t); _remember(t, 'TOKEN_USED');
  if (rec.expiresAt <= now) {
    logger.warn('[email-intel] confirm rejected code=TOKEN_EXPIRED kind=' + rec.kind + ' tok=' + tokenTag(t));
    return { ok: false, code: 'TOKEN_EXPIRED' };
  }
  if (payloadHash(rec.payload) !== rec.hash || (opts.payloadHash != null && !(String(opts.payloadHash).length >= 12 && rec.hash.startsWith(String(opts.payloadHash))))) {
    logger.warn('[email-intel] confirm rejected code=PAYLOAD_MISMATCH kind=' + rec.kind + ' tok=' + tokenTag(t));
    return { ok: false, code: 'PAYLOAD_MISMATCH' };
  }
  const ex = _executors.get(rec.kind);
  if (!ex) return { ok: false, code: 'KIND_UNAVAILABLE' };
  if (CONSEQUENTIAL.includes(rec.kind)) {
    const human = await _nativeConfirm(rec, opts);
    if (!human.ok) {
      logger.warn('[email-intel] confirm not executed code=' + human.code + ' kind=' + rec.kind + ' tok=' + tokenTag(t));
      return { ok: false, code: human.code };
    }
  }
  try {
    const result = await ex.run(JSON.parse(JSON.stringify(rec.payload)), { kind: rec.kind, summary: rec.summary, now, event: opts.event });
    logger.info('[email-intel] confirm executed kind=' + rec.kind + ' tok=' + tokenTag(t));
    return result === undefined ? { ok: true } : result;
  } catch (e) {
    logger.warn('[email-intel] confirm executor failed kind=' + rec.kind + ' ' + safeErr(e));
    return { ok: false, code: 'EXECUTOR_FAILED' };
  }
}

function _liveCount() { return _live.size; }
function _resetForTests(opts) {
  _live.clear(); _gone.clear();
  if (!opts || !opts.keepExecutors) _executors.clear();
}

module.exports = {
  KINDS, CONSEQUENTIAL, KIND_TITLE, KIND_BUTTON,
  prepare, confirm, registerExecutor, hasExecutor, payloadHash, cleanLabel,
  _liveCount, _resetForTests,
};
