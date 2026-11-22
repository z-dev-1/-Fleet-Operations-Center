'use strict';
/**
 * src/aperia/transport.js — READ-ONLY transport: GET https://amazon.aperiatech.com/api/v1/* via ses.fetch
 * on the persist:aperia session with the captured Bearer. No other method exists here.
 * Results carry status / code / parsed value only; never the token, headers, cookies or the URL.
 */
const C = require('./constants');
const capture = require('./capture');
const { safeErr, pathPattern } = require('./redact');
const { safeJson } = require('./safe-json');
const log = require('../utils/logger')('aperia');

// Test seam: { session } (an object with getSession()).
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _session() { return _deps.session || require('./session'); }

/**
 * getJson(path, {timeoutMs}) -> {ok:true, status, value} | {ok:false, code, status?}
 * path must be an /api/v1/ path (with optional query) and not a forbidden endpoint.
 */
async function getJson(apiPath, opts) {
  const p = String(apiPath || '');
  const pathname = p.split('?')[0];
  if (!p.startsWith(C.API_PREFIX) || /[\s#]/.test(p) || pathname.includes('..')) return { ok: false, code: 'INVALID_INPUT' };
  if (C.isForbiddenPath(pathname)) return { ok: false, code: 'APERIA_FORBIDDEN_ENDPOINT' };
  if (!C.isAllowedApiPath(pathname)) return { ok: false, code: 'APERIA_PATH_NOT_ALLOWED' };
  const token = capture.current();
  if (!token) return { ok: false, code: 'APERIA_SIGNIN_REQUIRED' };
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : C.FETCH_TIMEOUT_MS;
  const t0 = Date.now();
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => { try { ac.abort(); } catch (_) {} }, timeoutMs) : null;
  try {
    const ses = _session().getSession();
    const res = await ses.fetch(C.BASE_URL + p, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      credentials: 'include',
      redirect: 'manual',
      signal: ac ? ac.signal : undefined,
    });
    const status = Number(res && res.status) || 0;
    const ms = Date.now() - t0;
    if (status === 401) {
      capture.clear();
      try { _session().noteResult('APERIA_SESSION_EXPIRED'); } catch (_) {}
      log.warn('[aperia] get', { path: pathPattern(pathname), status, ms, code: 'APERIA_SESSION_EXPIRED' });
      return { ok: false, code: 'APERIA_SESSION_EXPIRED', status };
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > C.MAX_BODY_BYTES) return { ok: false, code: 'APERIA_RESPONSE_TOO_LARGE', status };
    if (status < 200 || status >= 300) {
      log.warn('[aperia] get', { path: pathPattern(pathname), status, ms, code: 'APERIA_HTTP' });
      return { ok: false, code: 'APERIA_HTTP', status };
    }
    const j = safeJson(text);
    if (!j.ok) return { ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED', status };
    log.info('[aperia] get', { path: pathPattern(pathname), status, ms });
    return { ok: true, status, value: j.value };
  } catch (e) {
    const name = e && e.name === 'AbortError' ? 'APERIA_TIMEOUT' : 'APERIA_NETWORK';
    log.warn('[aperia] get', Object.assign({ path: pathPattern(pathname), code: name }, safeErr(e)));
    return { ok: false, code: name };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { getJson, _setDeps };
