'use strict';
/**
 * src/dtna/session-time.js — how long the DTNA (Salesforce) session has left.
 *
 * GET SESSION_TIME_URL?buster=<ts> through the persist:vendor-dtna session: cookie-only, no Aura token.
 * The servlet answers 'while(1);{"sp":<period secs>,"sr":<remaining secs>}'. Only the two integers ever
 * leave this module; the body is never logged, stored or returned. The OIDC user-info handler (which
 * returns an id token) is never called: that ~1 h token does not authorize the Aura API.
 * Runs on a user action (DTNA panel open / Check session, or a pre-flight before a write or bulk
 * pull) and once after a background sign-in or when its expiry timer fires (src/dtna/auto-auth.js).
 * Nothing here schedules anything. Never throws.
 * Logs: { code, remainingSec, ms } only.
 */
const C = require('./constants');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('dtna');

const BODY_MAX = 4096;

// Test seam: { fetch, session, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _session() { return _deps.session || require('./session'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _fetchFn() {
  if (typeof _deps.fetch === 'function') return _deps.fetch;
  const ses = _session().getSession();
  return (url, init) => ses.fetch(url, init);
}

/** parseSessionTime(text) -> {ok:true, remainingSec, periodSec} | {ok:false, code:'DTNA_SHAPE'} */
function parseSessionTime(text) {
  let t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > BODY_MAX) return { ok: false, code: 'DTNA_SHAPE' };
  if (t.startsWith('while(1);')) t = t.slice(9).trim();
  const j = safeJson(t);
  const v = j.ok ? j.value : null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'DTNA_SHAPE' };
  const sr = v.sr;
  const sp = v.sp;
  if (typeof sr !== 'number' || typeof sp !== 'number' || !Number.isFinite(sr) || !Number.isFinite(sp)) return { ok: false, code: 'DTNA_SHAPE' };
  return { ok: true, remainingSec: Math.max(0, Math.floor(sr)), periodSec: Math.max(0, Math.floor(sp)) };
}

function _isLoginUrl(url) {
  try { return C.LOGIN_HOST_RE.test(new URL(String(url || '')).hostname); } catch (_) { return false; }
}

const EXPIRED = Object.freeze({ ok: true, remainingSec: 0, periodSec: null, expired: true });

/** read() -> {ok:true, remainingSec, periodSec, expired} | {ok:false, code} */
async function read() {
  const t0 = _now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (_) {} }, C.SESSION_TIME_TIMEOUT_MS);
  let r;
  try {
    const res = await _fetchFn()(C.SESSION_TIME_URL + '?buster=' + _now(), {
      method: 'GET', credentials: 'include', redirect: 'manual', headers: { Accept: '*/*' }, signal: ac.signal,
    });
    const status = res ? Number(res.status) || 0 : 0;
    let location = '';
    try { location = res && res.headers && typeof res.headers.get === 'function' ? (res.headers.get('location') || '') : ''; } catch (_) { location = ''; }
    if (res && res.type === 'opaqueredirect') r = Object.assign({}, EXPIRED);
    else if (status === 401) r = Object.assign({}, EXPIRED);
    else if (status >= 300 && status < 400) r = _isLoginUrl(location) ? Object.assign({}, EXPIRED) : { ok: false, code: 'DTNA_HTTP_ERROR' };
    else if (status === 200) {
      let text = '';
      try { text = await res.text(); } catch (_) { text = ''; }
      const p = parseSessionTime(text);
      text = '';
      r = p.ok ? { ok: true, remainingSec: p.remainingSec, periodSec: p.periodSec, expired: p.remainingSec <= 0 } : { ok: false, code: p.code };
    } else r = { ok: false, code: 'DTNA_HTTP_ERROR' };
  } catch (e) {
    if (timedOut || (e && e.name === 'AbortError')) r = { ok: false, code: 'DTNA_TIMEOUT' };
    else { log.warn('[dtna] session-time', safeErr(e)); r = { ok: false, code: 'DTNA_NETWORK' }; }
  } finally {
    clearTimeout(timer);
  }
  if (r.ok) {
    try { _session().noteSessionTime({ remainingSec: r.remainingSec, periodSec: r.periodSec }); } catch (e) { log.warn('[dtna] session-time', safeErr(e)); }
  }
  log.info('[dtna] session-time', { code: r.ok ? (r.expired ? 'EXPIRED' : 'OK') : r.code, remainingSec: r.ok ? r.remainingSec : null, ms: _now() - t0 });
  return r;
}

/**
 * preflight(minSec) -> {block:false, remainingSec|null} | {block:true, code:'DTNA_SESSION_LOW', remainingSec}
 * Blocks only when the servlet says expired or fewer than minSec seconds are left. A failed read does
 * not block (the request then runs exactly as before, and its own sign-in handling applies).
 */
async function preflight(minSec) {
  const min = Number.isFinite(minSec) ? minSec : C.SESSION_PREFLIGHT_MIN_SEC;
  let r;
  try { r = await read(); } catch (_) { r = { ok: false }; }
  if (!r || !r.ok) return { block: false, remainingSec: null };
  if (r.expired || r.remainingSec < min) return { block: true, code: 'DTNA_SESSION_LOW', remainingSec: r.remainingSec };
  return { block: false, remainingSec: r.remainingSec };
}

function _resetForTests() { _deps = {}; }

module.exports = { parseSessionTime, read, preflight, _setDeps, _resetForTests };
