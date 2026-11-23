'use strict';
/**
 * src/dtna/writes.js — the DTNA writes: post a comment on a Service Tracker case, post to the case
 * Chatter feed (postApprovedChatter), and move a case forward to a later stage (postApprovedStageChange,
 * below). All are dealer-visible and approval-gated.
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

// Test seam: { aura, config, stageConfig, chatterConfig } (override constants.POST_COMMENT_PARAMS /
// STAGE_CHANGE_PARAMS / CHATTER_POST_PARAMS; null keeps them unset).
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

// ── Change DTNA Stage (forward only; dealer-visible) ───────────────────────
// postApprovedStageChange is called ONLY by src/writes/write-gate.js _send('dtnaStage') after the user
// approved the exact from -> to change, and is the only caller of callWrite('changeStatus'). The Apex
// params come from constants.STAGE_CHANGE_PARAMS; while that is null nothing can be sent
// (DTNA_STAGE_NOT_CONFIGURED). Logs: method, caseTag, from / to stage labels, code, status, ms only.
function _stageConfig() { return Object.prototype.hasOwnProperty.call(_deps, 'stageConfig') ? _deps.stageConfig : C.STAGE_CHANGE_PARAMS; }

const STAGE_PLACEHOLDERS = ['$caseId', '$status', '$fromStatus'];

function _statusValue(cfg, name) {
  const sv = cfg && cfg.statusValues && typeof cfg.statusValues === 'object' && !Array.isArray(cfg.statusValues) ? cfg.statusValues : null;
  if (!sv || C.stageIndex(name) < 0 || !Object.prototype.hasOwnProperty.call(sv, name)) return '';
  const v = sv[name];
  return typeof v === 'string' && v.trim() && v.length <= 80 ? v : '';
}

/**
 * buildStageParams(cfg, payload) -> Apex params object | null
 * cfg: STAGE_CHANGE_PARAMS shape (constants.js). payload: { caseId, fromStage, toStage } (CASE_STAGES names).
 */
function buildStageParams(cfg, payload) {
  if (!cfg || typeof cfg !== 'object' || !cfg.params || typeof cfg.params !== 'object' || Array.isArray(cfg.params)) return null;
  if (cfg.classname !== C.WRITE_METHODS.changeStatus.classname || cfg.method !== 'changeStatus') return null;
  const p = payload && typeof payload === 'object' ? payload : {};
  const keys = Object.keys(cfg.params);
  if (!keys.length || keys.length > 10) return null;
  const vals = keys.map((k) => cfg.params[k]);
  if (!vals.includes('$caseId') || !vals.includes('$status')) return null;
  const out = {};
  for (const k of keys) {
    if (!/^\w{1,60}$/.test(k)) return null;
    const v = cfg.params[k];
    if (v === '$caseId') {
      if (!C.CASE_ID_RE.test(_str(p.caseId))) return null;
      out[k] = _str(p.caseId);
    } else if (v === '$status' || v === '$fromStatus') {
      const s = _statusValue(cfg, _str(v === '$status' ? p.toStage : p.fromStage));
      if (!s) return null;
      out[k] = s;
    } else if (typeof v === 'string' && v.startsWith('$')) {
      return null; // unknown placeholder
    } else if (v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)) {
      out[k] = v;
    } else {
      return null;
    }
  }
  return out;
}

/** isStageConfigured() -> true only when STAGE_CHANGE_PARAMS builds params for a dummy forward change. */
function isStageConfigured() {
  const cfg = _stageConfig();
  const sv = cfg && cfg.statusValues && typeof cfg.statusValues === 'object' ? cfg.statusValues : null;
  if (!sv) return false;
  const mapped = C.CASE_STAGES.filter((s) => _statusValue(cfg, s));
  if (!mapped.length) return false;
  const to = mapped[mapped.length - 1];
  const from = mapped.length > 1 ? mapped[0] : C.CASE_STAGES[0];
  return !!buildStageParams(cfg, { caseId: DUMMY.caseId, fromStage: from, toStage: to });
}

/** stageTargets(fromName) -> CASE_STAGES names after fromName (only portal-mapped ones once configured). */
function stageTargets(fromName) {
  const i = C.stageIndex(fromName);
  if (i < 0) return [];
  const later = C.CASE_STAGES.slice(i + 1);
  if (!isStageConfigured()) return later;
  const cfg = _stageConfig();
  return later.filter((s) => _statusValue(cfg, s));
}

/**
 * postApprovedStageChange(payload, token) -> {ok:true, toStage} | {ok:false, code}
 * payload: { caseId, fromStage, toStage, repairOrderNo } (the write gate's stored payload).
 */
async function postApprovedStageChange(payload, token) {
  const t0 = Date.now();
  const p = payload && typeof payload === 'object' ? payload : {};
  const tag = caseTag(_str(p.caseId));
  const from = C.stageIndex(_str(p.fromStage)) >= 0 ? _str(p.fromStage) : '';
  const to = C.stageIndex(_str(p.toStage)) >= 0 ? _str(p.toStage) : '';
  const cfg = _stageConfig();
  let r;
  let status;
  if (!isStageConfigured()) r = { ok: false, code: 'DTNA_STAGE_NOT_CONFIGURED' };
  else if (!C.CASE_ID_RE.test(_str(p.caseId)) || !from || !to) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
  else if (!C.isForwardStage(from, to)) r = { ok: false, code: 'DTNA_STAGE_NOT_FORWARD' };
  else {
    const params = buildStageParams(cfg, p);
    if (!params) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
    else {
      let a;
      try { a = await _aura().callWrite('changeStatus', params, token); } catch (_) { a = { ok: false, code: 'DTNA_INTERNAL' }; }
      status = a && Number.isFinite(a.status) ? a.status : undefined;
      if (!a || !a.ok) r = { ok: false, code: _str((a && a.code) || 'DTNA_INTERNAL').slice(0, 40) };
      else if (_hasSuccessValue(cfg) && String(a.value) !== String(cfg.successValue)) r = { ok: false, code: 'DTNA_STAGE_REJECTED' };
      else r = { ok: true, toStage: to };
    }
  }
  log.info('[dtna] change-stage', { method: 'changeStatus', caseTag: tag, from, to, code: r.ok ? 'OK' : r.code, status, ms: Date.now() - t0 });
  return r;
}

// ── Post to the case Chatter feed (dealer-visible) ─────────────────────────
// postApprovedChatter is called ONLY by src/writes/write-gate.js _send('dtnaChatter') after the user
// approved the exact text, and is the only caller of aura.callChatterWrite. The action and params come
// from constants.CHATTER_POST_PARAMS; while that is null nothing can be sent (DTNA_CHATTER_NOT_CONFIGURED).
// Logs: caseTag, len, code, ms only.
function _chatterConfig() { return Object.prototype.hasOwnProperty.call(_deps, 'chatterConfig') ? _deps.chatterConfig : C.CHATTER_POST_PARAMS; }

const CHATTER_MAX_DEPTH = 6;

/**
 * buildChatterParams(cfg, payload) -> params (deep copy of cfg.params with '$caseId' / '$text' resolved) | null.
 * null when cfg is missing, a '$...' string is not one of the two placeholders, '$text' or '$caseId' is
 * absent, the template is too deep / not JSON-safe, or the payload case id is invalid.
 */
function buildChatterParams(cfg, payload) {
  if (!cfg || typeof cfg !== 'object' || !cfg.params || typeof cfg.params !== 'object' || Array.isArray(cfg.params)) return null;
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!C.CASE_ID_RE.test(_str(p.caseId))) return null;
  const seen = { text: false, caseId: false };
  let bad = false;
  const walk = (v, depth) => {
    if (bad) return null;
    if (depth > CHATTER_MAX_DEPTH) { bad = true; return null; }
    if (v === '$caseId') { seen.caseId = true; return _str(p.caseId); }
    if (v === '$text') { seen.text = true; return _str(p.text); }
    if (typeof v === 'string') { if (v.startsWith('$') || v.length > 200) bad = true; return v; }
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad = true; return v; }
    if (Array.isArray(v)) { if (v.length > 20) bad = true; return v.map((x) => walk(x, depth + 1)); }
    if (typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v);
      if (keys.length > 20) bad = true;
      for (const k of keys) {
        if (!/^\w{1,60}$/.test(k)) { bad = true; return null; }
        out[k] = walk(v[k], depth + 1);
      }
      return out;
    }
    bad = true;
    return null;
  };
  const out = walk(cfg.params, 0);
  if (bad || !seen.text || !seen.caseId) return null;
  return out;
}

function _chatterTransportOk(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (cfg.transport === 'aura') return typeof cfg.descriptor === 'string' && /^(aura|serviceComponent):\/\/[\w.\/]+\/ACTION\$\w{1,80}$/.test(cfg.descriptor);
  if (cfg.transport === 'apex') return typeof cfg.classname === 'string' && /^E2E_\w{1,80}$/.test(cfg.classname) && typeof cfg.method === 'string' && /^\w{1,80}$/.test(cfg.method);
  return false;
}

/** isChatterConfigured() -> true only when CHATTER_POST_PARAMS has a valid transport and builds params for a dummy payload. */
function isChatterConfigured() {
  const cfg = _chatterConfig();
  return _chatterTransportOk(cfg) && !!buildChatterParams(cfg, DUMMY);
}

function _pathOf(v, dotted) {
  let cur = v;
  for (const part of String(dotted || '').split('.')) {
    if (!part || cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * postApprovedChatter(payload, token) -> {ok:true, feedItemId} | {ok:false, code}
 * payload: { caseId, repairOrderNo, text } (the write gate's stored payload).
 */
async function postApprovedChatter(payload, token) {
  const t0 = Date.now();
  const p = payload && typeof payload === 'object' ? payload : {};
  const tag = caseTag(_str(p.caseId));
  const text = _str(p.text);
  const cfg = _chatterConfig();
  let r;
  if (!isChatterConfigured()) r = { ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' };
  else if (!C.CASE_ID_RE.test(_str(p.caseId)) || !text.trim()) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
  else if (text.length > C.CHATTER_POST_MAX) r = { ok: false, code: 'DTNA_TEXT_TOO_LONG' };
  else {
    const params = buildChatterParams(cfg, p);
    if (!params) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
    else {
      let a;
      try { a = await _aura().callChatterWrite(params, token); } catch (_) { a = { ok: false, code: 'DTNA_INTERNAL' }; }
      const success = cfg.success && typeof cfg.success === 'object' ? cfg.success : null;
      if (!a || !a.ok) r = { ok: false, code: _str((a && a.code) || 'DTNA_INTERNAL').slice(0, 40) };
      else if (success && (typeof success.value === 'number' || typeof success.value === 'string') && String(a.value) !== String(success.value)) r = { ok: false, code: 'DTNA_CHATTER_REJECTED' };
      else if (success && typeof success.idPath === 'string') {
        const id = _str(_pathOf(a.value, success.idPath));
        r = C.FEED_ITEM_ID_RE.test(id) ? { ok: true, feedItemId: id } : { ok: false, code: 'DTNA_CHATTER_REJECTED' };
      } else {
        const v = a.value;
        const id = typeof v === 'string' ? v : (v && typeof v === 'object' ? _str(v.id || v.Id) : '');
        r = { ok: true, feedItemId: C.FEED_ITEM_ID_RE.test(id) ? id : '' };
      }
    }
  }
  log.info('[dtna] post-chatter', { caseTag: tag, len: text.length, code: r.ok ? 'OK' : r.code, ms: Date.now() - t0 });
  return r;
}

module.exports = {
  buildChatterParams, isChatterConfigured, postApprovedChatter,
  buildPostParams, isPostConfigured, postApprovedComment, PLACEHOLDERS,
  buildStageParams, isStageConfigured, stageTargets, postApprovedStageChange, STAGE_PLACEHOLDERS,
  _setDeps,
};
