'use strict';
/**
 * src/dtna/aura.js — Aura transport for DTNA Service Tracker (findings §3.5).
 *
 * Form-encoded POSTs through the persist:vendor-dtna session with the context/token/pageURI the
 * capture took from the page's own requests. Never throws; returns {ok:true, value} | {ok:false, code}.
 * Only READ_METHODS reach callApex; _callApexRaw (dev probe only) refuses anything write-like.
 * getCaseNumberRecord is the one non-Apex read (the portal's RecordUi getRecordWithFields, Case.CaseNumber).
 * A {silent:true} call (the sync pass) asks the session for a silent context only: no sign-in, no auto-login.
 * WRITE_METHODS (postComment, changeStatus) reach only callWrite, and only with a single-use write-gate
 * approval token; callApex and _callApexRaw refuse both.
 * One log line per call: { method, caseTag, code, status, ms }. No bodies, URLs or messages are logged.
 */
const C = require('./constants');
const capture = require('./capture');
const { safeErr, caseTag } = require('./redact');
const { safeJson } = require('./safe-json');
const log = require('../utils/logger')('dtna');

// Test seam: { fetch, session, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _session() { return _deps.session || require('./session'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }

let _seq = 0;

const RETRY_CODES = new Set(['DTNA_SESSION_EXPIRED', 'DTNA_OUT_OF_SYNC']);

/** parseEnvelope(text) -> {ok:true, value} | {ok:false}. Strips 'while(1);', a leading '*\/' and a trailing '/*ERROR*\/'. */
function parseEnvelope(text) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (t.startsWith('while(1);')) t = t.slice(9).trim();
  if (t.startsWith('*/')) t = t.slice(2).trim();
  if (t.endsWith('/*ERROR*/')) t = t.slice(0, -9).trim();
  if (!t) return { ok: false };
  const j = safeJson(t);
  return j.ok ? { ok: true, value: j.value } : { ok: false };
}

function _isLoginUrl(url) {
  try { return C.LOGIN_HOST_RE.test(new URL(String(url || '')).hostname); } catch (_) { return false; }
}

function _descriptors(v) {
  const out = [];
  if (!v || typeof v !== 'object') return out;
  if (v.event && typeof v.event.descriptor === 'string') out.push(v.event.descriptor);
  if (Array.isArray(v.events)) for (const e of v.events) if (e && typeof e.descriptor === 'string') out.push(e.descriptor);
  if (v.exceptionEvent === true && typeof v.descriptor === 'string') out.push(v.descriptor);
  return out;
}

function _unwrap(rv) {
  // ApexActionController wraps the Apex result: { returnValue: <result>, cacheable }.
  if (rv && typeof rv === 'object' && !Array.isArray(rv) && Object.prototype.hasOwnProperty.call(rv, 'returnValue')
    && Object.keys(rv).every((k) => k === 'returnValue' || k === 'cacheable')) rv = rv.returnValue;
  if (typeof rv === 'string' && /^\s*[[{]/.test(rv)) {
    const j = safeJson(rv);
    if (j.ok) return j.value;
  }
  return rv;
}

/**
 * classify(httpStatus, envelope, location?) -> {ok:true, value, status} | {ok:false, code, status, exceptionType?}
 */
function classify(httpStatus, envelope, location) {
  const status = Number(httpStatus) || 0;
  if (status === 401) return { ok: false, code: 'DTNA_SESSION_EXPIRED', status };
  if (status >= 300 && status < 400) {
    return _isLoginUrl(location) ? { ok: false, code: 'DTNA_SESSION_EXPIRED', status } : { ok: false, code: 'DTNA_HTTP_ERROR', status };
  }
  const v = envelope && envelope.ok ? envelope.value : undefined;
  const desc = _descriptors(v).join(' ');
  if (/aura:invalidSession/.test(desc)) return { ok: false, code: 'DTNA_SESSION_EXPIRED', status };
  if (/aura:clientOutOfSync/.test(desc)) return { ok: false, code: 'DTNA_OUT_OF_SYNC', status };
  const a = v && Array.isArray(v.actions) ? v.actions[0] : null;
  if (a && a.state === 'SUCCESS') return { ok: true, value: _unwrap(a.returnValue), status };
  if (a && a.state === 'ERROR') {
    const e0 = Array.isArray(a.error) ? a.error[0] : null;
    const et = e0 && typeof e0.exceptionType === 'string' ? e0.exceptionType.replace(/[^\w.]/g, '').slice(0, 60) : '';
    return et ? { ok: false, code: 'DTNA_APEX_ERROR', status, exceptionType: et } : { ok: false, code: 'DTNA_APEX_ERROR', status };
  }
  if (status >= 400) return { ok: false, code: 'DTNA_HTTP_ERROR', status };
  return { ok: false, code: 'DTNA_SHAPE', status };
}

function _fetchFn() {
  if (typeof _deps.fetch === 'function') return _deps.fetch;
  const ses = _session().getSession();
  return (url, init) => ses.fetch(url, init);
}

/** _post(query, message) -> classify(...) | {ok:false, code:'DTNA_TIMEOUT'|'DTNA_NETWORK'|'DTNA_SIGNIN_REQUIRED'} */
async function _post(query, message) {
  const ctx = capture.current();
  if (!ctx || !ctx.context) return { ok: false, code: 'DTNA_SIGNIN_REQUIRED' };
  const body = new URLSearchParams();
  body.set('message', message);
  body.set('aura.context', ctx.context);
  body.set('aura.pageURI', ctx.pageURI || '');
  body.set('aura.token', ctx.token || '');
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (_) {} }, C.CALL_TIMEOUT_MS);
  try {
    const res = await _fetchFn()(C.AURA_URL + query, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*' },
      body: body.toString(),
      signal: ac.signal,
    });
    // redirect:'manual' may surface as an opaque redirect (no status/location): an aura POST is only
    // ever redirected to sign-in.
    if (res && res.type === 'opaqueredirect') return { ok: false, code: 'DTNA_SESSION_EXPIRED', status: 0 };
    const status = res ? res.status : 0;
    let location = '';
    try { location = res && res.headers && typeof res.headers.get === 'function' ? (res.headers.get('location') || '') : ''; } catch (_) { location = ''; }
    let text = '';
    if (!(status >= 300 && status < 400) && status !== 401) text = await res.text();
    return classify(status, parseEnvelope(text), location);
  } catch (e) {
    if (timedOut || (e && e.name === 'AbortError')) return { ok: false, code: 'DTNA_TIMEOUT' };
    log.warn('[dtna] post', safeErr(e));
    return { ok: false, code: 'DTNA_NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

/** _run(send, logInfo) — ensureContext, send, retry once after a forced refresh on expired / out-of-sync. */
async function _run(send, info) {
  const t0 = _now();
  const S = _session();
  let r;
  try {
    // silent (the sync pass, src/dtna/auto.js): ensureContext never opens a sign-in or auto-login.
    const e = info.silent ? await S.ensureContext({ silent: true }) : await S.ensureContext();
    if (!e || !e.ok) {
      r = { ok: false, code: (e && e.code) || 'DTNA_SIGNIN_REQUIRED' };
    } else {
      r = await send();
      if (!r.ok && RETRY_CODES.has(r.code) && info.noRetry) {
        capture.clear();
        r = { ok: false, code: 'DTNA_SIGNIN_REQUIRED', status: r.status };
      } else if (!r.ok && RETRY_CODES.has(r.code)) {
        capture.clear();
        const e2 = await S.ensureContext(info.silent ? { force: true, silent: true } : { force: true });
        if (!e2 || !e2.ok) r = { ok: false, code: 'DTNA_SIGNIN_REQUIRED' };
        else {
          r = await send();
          if (!r.ok && RETRY_CODES.has(r.code)) r = { ok: false, code: 'DTNA_SIGNIN_REQUIRED', status: r.status };
        }
      }
    }
  } catch (e) {
    log.warn('[dtna] apex', safeErr(e));
    r = { ok: false, code: 'DTNA_NETWORK' };
  }
  const code = r.ok ? 'OK' : r.code;
  try { S.noteResult(code); } catch (e) { log.warn('[dtna] status', safeErr(e)); }
  const line = { method: info.method, caseTag: info.caseTag, code, status: r.status, ms: _now() - t0 };
  if (r.exceptionType) line.exceptionType = r.exceptionType;
  log.info('[dtna] apex', line);
  return r;
}

function _apexMessage(classname, method, params) {
  const id = ++_seq;
  return {
    id,
    message: JSON.stringify({
      actions: [{
        id: id + ';a',
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: { namespace: '', classname, method, params, cacheable: false, isContinuation: false },
      }],
    }),
  };
}

function _send(classname, method, params) {
  return () => {
    const m = _apexMessage(classname, method, params);
    return _post('?r=' + m.id + '&aura.ApexAction.execute=1', m.message);
  };
}

function _isPlainObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/** callApex(name, params, {silent}) — allowlisted reads only; validated before any request. */
async function callApex(name, params, opts) {
  const spec = typeof name === 'string' && Object.prototype.hasOwnProperty.call(C.READ_METHODS, name) ? C.READ_METHODS[name] : null;
  if (!spec) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  const p = _isPlainObject(params) ? params : null;
  const keys = p ? Object.keys(p) : [];
  const valid = p && keys.length === spec.params.length && spec.params.every((k) => keys.includes(k))
    && keys.every((k) => typeof p[k] === 'string')
    && (!('caseId' in p) || C.CASE_ID_RE.test(p.caseId))
    && (!('commentId' in p) || C.COMMENT_ID_RE.test(p.commentId));
  if (!valid) {
    log.info('[dtna] apex', { method: name, code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  const seen = capture.classFor(name);
  const classname = seen && /^E2E_\w+$/.test(seen) ? seen : C.APEX_CLASS[name];
  const clean = {};
  for (const k of spec.params) clean[k] = p[k];
  return _run(_send(classname, name, clean), { method: name, caseTag: caseTag(p.caseId), silent: !!(opts && opts.silent) });
}

/**
 * getCaseNumberRecord(caseId, {silent}) — the Case's human case number through the portal's own record
 * read (constants.CASE_NUMBER_READ). Read-only; returns the raw record value ({ fields: { CaseNumber } }).
 */
async function getCaseNumberRecord(caseId, opts) {
  if (typeof caseId !== 'string' || !C.CASE_ID_RE.test(caseId)) {
    log.info('[dtna] apex', { method: 'getRecordWithFields', code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  const send = () => {
    const id = ++_seq;
    const message = JSON.stringify({
      actions: [{
        id: id + ';a',
        descriptor: C.CASE_NUMBER_READ.descriptor,
        callingDescriptor: 'UNKNOWN',
        params: { recordId: caseId, fields: [C.CASE_NUMBER_READ.field], optionalFields: [] },
      }],
    });
    return _post('?r=' + id + '&aura.RecordUi.getRecordWithFields=1', message);
  };
  return _run(send, { method: 'getRecordWithFields', caseTag: caseTag(caseId), silent: !!(opts && opts.silent) });
}

/**
 * callWrite(name, params, token) — the ONLY DTNA write path (src/dtna/writes.js postApprovedComment and
 * postApprovedStageChange).
 * name must be in WRITE_METHODS, and token a live single-use write-gate approval token, else zero
 * requests. No retry: a dealer-visible write is sent at most once per approval.
 */
async function callWrite(name, params, token) {
  const spec = typeof name === 'string' && Object.prototype.hasOwnProperty.call(C.WRITE_METHODS, name) ? C.WRITE_METHODS[name] : null;
  if (!spec) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  const isToken = typeof _deps.isApprovalToken === 'function' ? _deps.isApprovalToken : require('../writes/write-gate').isApprovalToken;
  let approved = false;
  try { approved = isToken(token) === true; } catch (_) { approved = false; }
  if (!approved) {
    log.info('[dtna] apex', { method: name, code: 'DTNA_WRITE_NOT_APPROVED' });
    return { ok: false, code: 'DTNA_WRITE_NOT_APPROVED' };
  }
  const p = _isPlainObject(params) ? params : null;
  const keys = p ? Object.keys(p) : [];
  const valid = p && keys.length > 0 && keys.length <= 10 && keys.every((k) => /^\w{1,60}$/.test(k))
    && keys.every((k) => p[k] === null || typeof p[k] === 'string' || typeof p[k] === 'boolean' || (Array.isArray(p[k]) && p[k].length === 0))
    && keys.every((k) => !/caseid/i.test(k) || C.CASE_ID_RE.test(String(p[k])));
  if (!valid) {
    log.info('[dtna] apex', { method: name, code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  const caseKey = keys.find((k) => /caseid/i.test(k));
  return _run(_send(spec.classname, name, Object.assign({}, p)), { method: name, caseTag: caseTag(caseKey ? p[caseKey] : ''), noRetry: true });
}

/** replayGetItems(mutate, {silent}) — re-send the page's captured list action (deep copy), mutate(params) first. */
// No list template held: one forced hidden window on the Cases list (single-flight), so the page's own
// getItems action is captured; then the replay is retried once.
let _listLoadP = null;
let _listBuilt = false; // the last replay used the built template (no live capture)
// At most one lazy list load per gap (later pages and calls use the built template meanwhile).
const LIST_LOAD_GAP_MS = 10 * 60e3;
let _listLoadAt = -Infinity;

/** _builtListTemplate() -> { query, action } from C.LIST_ACTION_* (fresh copy). */
function _builtListTemplate() {
  return {
    query: C.LIST_ACTION_QUERY,
    action: { id: '0;a', descriptor: C.LIST_ACTION_DESCRIPTOR, callingDescriptor: 'UNKNOWN', params: Object.assign({}, C.LIST_ACTION_PARAMS) },
    built: true,
  };
}
/** listTemplateBuilt() -> true when the last list replay had no live template and used the built one. */
function listTemplateBuilt() { return _listBuilt; }
function _loadListTemplate(silent) {
  if (!_listLoadP) {
    _listLoadP = Promise.resolve()
      .then(() => _session().ensureContext(silent ? { force: true, silent: true } : { force: true }))
      .catch(() => null)
      .finally(() => { _listLoadP = null; });
  }
  return _listLoadP;
}

async function replayGetItems(mutate, opts) {
  const silent = !!(opts && opts.silent);
  const send = async () => {
    let t = capture.getItemsTemplate();
    if ((!t || !t.action) && _now() - _listLoadAt >= LIST_LOAD_GAP_MS) {
      _listLoadAt = _now();
      await _loadListTemplate(silent);
      t = capture.getItemsTemplate();
    }
    // Still none: the known Cases-list action, sent with the live captured aura context.
    _listBuilt = !t || !t.action;
    if (_listBuilt) t = _builtListTemplate();
    const action = t.action;
    action.id = (++_seq) + ';a';
    if (!_isPlainObject(action.params)) action.params = {};
    if (typeof mutate === 'function') mutate(action.params);
    return _post(t.query || '', JSON.stringify({ actions: [action] }));
  };
  return _run(send, { method: 'getItems', caseTag: '------', silent });
}

/** _callApexRaw(classname, method, params) — dev probe only (src/dev/dev-dtna-probe.js). Reads only. */
async function _callApexRaw(classname, method, params) {
  const cls = typeof classname === 'string' ? classname : '';
  const meth = typeof method === 'string' ? method : '';
  if (!/^\w{1,80}$/.test(meth) || C.WRITE_RE.test(meth) || !/^(get|list|fetch)/.test(meth) || !/^E2E_\w{1,80}$/.test(cls)) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  const p = params == null ? {} : params;
  if (!_isPlainObject(p) || !Object.values(p).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  return _run(_send(cls, meth, Object.assign({}, p)), { method: meth, caseTag: caseTag(p.caseId) });
}

// ── Chatter feed + attachments (configured in constants; null = not configured, zero requests) ──
function _cfg(key, fallback) { return Object.prototype.hasOwnProperty.call(_deps, key) ? _deps[key] : fallback; }

const READ_DESCRIPTOR_RE = /^(aura|serviceComponent):\/\/[\w.\/]+\/ACTION\$(get|list|fetch)\w*$/;
const ANY_DESCRIPTOR_RE = /^(aura|serviceComponent):\/\/[\w.\/]+\/ACTION\$\w{1,80}$/;
const QUERY_RE = /^\?[\w.\-=&]{0,300}$/;

function _actionName(descriptor) { const i = descriptor.lastIndexOf('$'); return i >= 0 ? descriptor.slice(i + 1) : ''; }

/** _flatParams(tpl, caseId) -> flat params with '$caseId' substituted | null (bad key / value / placeholder). */
function _flatParams(tpl, caseId) {
  if (!_isPlainObject(tpl)) return null;
  const keys = Object.keys(tpl);
  if (keys.length > 10) return null;
  const out = {};
  for (const k of keys) {
    if (!/^\w{1,60}$/.test(k)) return null;
    const v = tpl[k];
    if (v === '$caseId') out[k] = caseId;
    else if (typeof v === 'string' && v.startsWith('$')) return null;
    else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200)) out[k] = v;
    else return null;
  }
  return out;
}

function _auraAction(descriptor, query, params) {
  return () => {
    const id = ++_seq;
    const message = JSON.stringify({ actions: [{ id: id + ';a', descriptor, callingDescriptor: 'UNKNOWN', params }] });
    return _post(typeof query === 'string' && QUERY_RE.test(query) ? query : '', message);
  };
}

/**
 * getFeedModel(caseId, {silent}) — the case feed's own config read (constants.CHATTER_FEED_READ). Read only.
 * -> {ok:true, value} | {ok:false, code}. Not configured -> DTNA_CHATTER_NOT_CONFIGURED, zero requests.
 */
async function getFeedModel(caseId, opts) {
  const cfg = _cfg('chatterFeedRead', C.CHATTER_FEED_READ);
  if (!cfg) return { ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' };
  if (typeof caseId !== 'string' || !C.CASE_ID_RE.test(caseId)) {
    log.info('[dtna] apex', { method: 'getFeedModel', code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  const d = typeof cfg.descriptor === 'string' ? cfg.descriptor : '';
  if (!READ_DESCRIPTOR_RE.test(d) || C.WRITE_RE.test(_actionName(d))) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  const params = _flatParams(cfg.params == null ? {} : cfg.params, caseId);
  if (!params) {
    log.info('[dtna] apex', { method: 'getFeedModel', code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  return _run(_auraAction(d, cfg.query, params), { method: 'getFeedModel', caseTag: caseTag(caseId), silent: !!(opts && opts.silent) });
}

/**
 * listAttachmentsRaw(caseId, {silent}) — the case files read (constants.ATTACHMENT_LIST_READ, source 'apex').
 * Read only, same rules as callApex. Not configured -> DTNA_ATTACHMENTS_NOT_CONFIGURED, zero requests.
 */
async function listAttachmentsRaw(caseId, opts) {
  const cfg = _cfg('attachmentListRead', C.ATTACHMENT_LIST_READ);
  if (!cfg || cfg.source !== 'apex') return { ok: false, code: 'DTNA_ATTACHMENTS_NOT_CONFIGURED' };
  if (typeof caseId !== 'string' || !C.CASE_ID_RE.test(caseId)) {
    log.info('[dtna] apex', { method: 'listAttachments', code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  const cls = typeof cfg.classname === 'string' ? cfg.classname : '';
  const meth = typeof cfg.method === 'string' ? cfg.method : '';
  if (!/^E2E_\w{1,80}$/.test(cls) || !/^\w{1,80}$/.test(meth) || !/^(get|list|fetch)/.test(meth) || C.WRITE_RE.test(meth)) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  const tpl = cfg.params == null ? {} : cfg.params;
  const params = _isPlainObject(tpl) && Object.values(tpl).every((v) => typeof v === 'string') ? _flatParams(tpl, caseId) : null;
  if (!params) {
    log.info('[dtna] apex', { method: meth, code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  return _run(_send(cls, meth, params), { method: meth, caseTag: caseTag(caseId), silent: !!(opts && opts.silent) });
}

const CHATTER_PARAMS_MAX_DEPTH = 6;
const CHATTER_PARAMS_MAX_LEN = 12000;
const ID_KEY_RE = /caseid|subjectid|parentid|recordid/i;

/** _chatterParamsOk(v, depth) -> JSON-safe, depth-bounded, every id-like key holds a case id. */
function _chatterParamsOk(v, depth) {
  if (depth > CHATTER_PARAMS_MAX_DEPTH) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 50 && v.every((x) => _chatterParamsOk(x, depth + 1));
  if (!_isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 30) return false;
  for (const k of keys) {
    if (!/^\w{1,60}$/.test(k)) return false;
    if (ID_KEY_RE.test(k) && !(typeof v[k] === 'string' && C.CASE_ID_RE.test(v[k]))) return false;
    if (!_chatterParamsOk(v[k], depth + 1)) return false;
  }
  return true;
}

function _findCaseId(v, depth) {
  if (depth > CHATTER_PARAMS_MAX_DEPTH || !v || typeof v !== 'object') return '';
  for (const k of Object.keys(v)) {
    if (ID_KEY_RE.test(k) && typeof v[k] === 'string' && C.CASE_ID_RE.test(v[k])) return v[k];
    const x = _findCaseId(v[k], depth + 1);
    if (x) return x;
  }
  return '';
}

/**
 * callChatterWrite(params, token) — the ONLY Chatter write path (src/dtna/writes.js postApprovedChatter).
 * Sends exactly the configured constants.CHATTER_POST_PARAMS action with the built params, only with a live
 * single-use write-gate approval token, else zero requests. No retry.
 */
async function callChatterWrite(params, token) {
  const cfg = _cfg('chatterConfig', C.CHATTER_POST_PARAMS);
  if (!cfg) return { ok: false, code: 'DTNA_CHATTER_NOT_CONFIGURED' };
  const isToken = typeof _deps.isApprovalToken === 'function' ? _deps.isApprovalToken : require('../writes/write-gate').isApprovalToken;
  let approved = false;
  try { approved = isToken(token) === true; } catch (_) { approved = false; }
  if (!approved) {
    log.info('[dtna] apex', { method: 'chatterPost', code: 'DTNA_WRITE_NOT_APPROVED' });
    return { ok: false, code: 'DTNA_WRITE_NOT_APPROVED' };
  }
  let send = null;
  if (cfg.transport === 'aura' && typeof cfg.descriptor === 'string' && ANY_DESCRIPTOR_RE.test(cfg.descriptor)) {
    send = (p) => _auraAction(cfg.descriptor, cfg.query, p);
  } else if (cfg.transport === 'apex' && typeof cfg.classname === 'string' && /^E2E_\w{1,80}$/.test(cfg.classname)
    && typeof cfg.method === 'string' && /^\w{1,80}$/.test(cfg.method)) {
    send = (p) => _send(cfg.classname, cfg.method, p);
  }
  if (!send) {
    log.info('[dtna] apex', { method: 'refused', code: 'DTNA_METHOD_NOT_ALLOWED' });
    return { ok: false, code: 'DTNA_METHOD_NOT_ALLOWED' };
  }
  let json = '';
  try { json = _isPlainObject(params) && _chatterParamsOk(params, 0) ? JSON.stringify(params) : ''; } catch (_) { json = ''; }
  const caseId = json ? _findCaseId(params, 0) : '';
  if (!json || json.length > CHATTER_PARAMS_MAX_LEN || !caseId) {
    log.info('[dtna] apex', { method: 'chatterPost', code: 'DTNA_INVALID_INPUT' });
    return { ok: false, code: 'DTNA_INVALID_INPUT' };
  }
  // A JSON round-trip copy: what is sent is what was validated.
  const copy = safeJson(json).value;
  return _run(send(copy), { method: 'chatterPost', caseTag: caseTag(caseId), noRetry: true });
}

function _resetForTests() { _deps = {}; _seq = 0; _listLoadP = null; _listBuilt = false; _listLoadAt = -Infinity; }

module.exports = {
  parseEnvelope, classify, callApex, callWrite, replayGetItems, listTemplateBuilt, getCaseNumberRecord, _callApexRaw, _post, _setDeps, _resetForTests,
  getFeedModel, listAttachmentsRaw, callChatterWrite,
};
