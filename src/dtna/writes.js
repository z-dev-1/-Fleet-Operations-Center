'use strict';
/**
 * src/dtna/writes.js — the one DTNA write: post a comment on a Service Tracker case.
 *
 * postApprovedComment is called ONLY by src/writes/write-gate.js _send('dtnaComment') after the user
 * approved the exact text. It passes the gate's single-use token on to aura.callWrite, which refuses a
 * write without it. The Apex param keys come from constants.POST_COMMENT_PARAMS; while that is null
 * nothing can be sent (DTNA_POST_NOT_CONFIGURED). The comment is visible to the dealer.
 * Logs: caseTag, len, code, ms only (never the text, ids beyond the tag, or the response).
 */
const C = require('./constants');
const { caseTag } = require('./redact');
const log = require('../utils/logger')('dtna');

// Test seam: { aura, config } (config overrides constants.POST_COMMENT_PARAMS; null keeps it unset).
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _aura() { return _deps.aura || require('./aura'); }
function _config() { return Object.prototype.hasOwnProperty.call(_deps, 'config') ? _deps.config : C.POST_COMMENT_PARAMS; }

const PLACEHOLDERS = ['$caseId', '$repairOrderId', '$text'];
const RECORD_ID_RE = /^[A-Za-z0-9]{15,18}$/;

function _str(v) { return v == null ? '' : String(v); }

/**
 * buildPostParams(cfg, payload) -> Apex params object | null
 * cfg: { params: { key: '$caseId'|'$repairOrderId'|'$text'|literal }, maxLen? }. null when cfg is missing,
 * lacks a '$text' key, lacks a '$caseId' / '$repairOrderId' key, has a bad key or literal, or a needed
 * payload value is missing.
 */
function buildPostParams(cfg, payload) {
  if (!cfg || typeof cfg !== 'object' || !cfg.params || typeof cfg.params !== 'object' || Array.isArray(cfg.params)) return null;
  const p = payload && typeof payload === 'object' ? payload : {};
  const keys = Object.keys(cfg.params);
  if (!keys.length || keys.length > 10) return null;
  const vals = keys.map((k) => cfg.params[k]);
  if (!vals.includes('$text')) return null;
  if (!vals.includes('$caseId') && !vals.includes('$repairOrderId')) return null;
  const out = {};
  for (const k of keys) {
    if (!/^\w{1,60}$/.test(k)) return null;
    const v = cfg.params[k];
    if (v === '$caseId') {
      if (!C.CASE_ID_RE.test(_str(p.caseId))) return null;
      out[k] = _str(p.caseId);
    } else if (v === '$repairOrderId') {
      if (!RECORD_ID_RE.test(_str(p.repairOrderId))) return null;
      out[k] = _str(p.repairOrderId);
    } else if (v === '$text') {
      out[k] = _str(p.text);
    } else if (typeof v === 'string' && v.startsWith('$')) {
      return null; // unknown placeholder
    } else if (v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) {
      out[k] = v;
    } else if (Array.isArray(v) && v.length === 0) {
      out[k] = []; // e.g. files: [] (text-only comment; attachments are not wired yet)
    } else {
      return null;
    }
  }
  return out;
}

const DUMMY = { caseId: '500000000000000AAA', repairOrderId: 'a1B000000000000AAA', text: 'x' };

/** isPostConfigured() -> true only when POST_COMMENT_PARAMS builds params for a dummy payload. */
function isPostConfigured() {
  return !!buildPostParams(_config(), DUMMY);
}

function _maxLen(cfg) {
  const n = cfg && Number(cfg.maxLen);
  return Number.isFinite(n) && n > 0 ? Math.min(n, C.POST_COMMENT_MAX) : C.POST_COMMENT_MAX;
}

// cfg.successValue: the Apex returnValue that means "sent" (the portal composer checks 201). Any other
// value is DTNA_POST_REJECTED ("Message not sent to Repair Facility").
function _hasSuccessValue(cfg) {
  return !!cfg && (typeof cfg.successValue === 'number' || typeof cfg.successValue === 'string');
}

function _commentId(v) {
  if (typeof v === 'string') return C.COMMENT_ID_RE.test(v) ? v : '';
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of ['Id', 'CommentId']) if (typeof v[k] === 'string' && C.COMMENT_ID_RE.test(v[k])) return v[k];
  }
  return '';
}

/**
 * postApprovedComment(payload, token) -> {ok:true, commentId} | {ok:false, code}
 * payload: { caseId, repairOrderId, repairOrderNo, text } (the write gate's stored payload).
 */
async function postApprovedComment(payload, token) {
  const t0 = Date.now();
  const p = payload && typeof payload === 'object' ? payload : {};
  const tag = caseTag(_str(p.caseId));
  const text = _str(p.text);
  const cfg = _config();
  let r;
  if (!isPostConfigured()) r = { ok: false, code: 'DTNA_POST_NOT_CONFIGURED' };
  else if (!C.CASE_ID_RE.test(_str(p.caseId)) || !text.trim()) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
  else if (text.length > _maxLen(cfg)) r = { ok: false, code: 'DTNA_TEXT_TOO_LONG' };
  else {
    const params = buildPostParams(cfg, p);
    if (!params) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
    else {
      let a;
      try { a = await _aura().callWrite('postComment', params, token); } catch (_) { a = { ok: false, code: 'DTNA_INTERNAL' }; }
      if (!a || !a.ok) r = { ok: false, code: _str((a && a.code) || 'DTNA_INTERNAL').slice(0, 40) };
      else if (_hasSuccessValue(cfg) && String(a.value) !== String(cfg.successValue)) r = { ok: false, code: 'DTNA_POST_REJECTED' };
      else r = { ok: true, commentId: _commentId(a.value) };
    }
  }
  log.info('[dtna] post-comment', { caseTag: tag, len: text.length, code: r.ok ? 'OK' : r.code, ms: Date.now() - t0 });
  return r;
}

module.exports = { buildPostParams, isPostConfigured, postApprovedComment, PLACEHOLDERS, _setDeps };
