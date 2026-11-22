'use strict';
/**
 * src/aperia/capture.js — PASSIVE Bearer capture from the portal's own API calls over CDP.
 *
 * The sign-in window's webContents.debugger is attached before the first load; requests to
 * https://amazon.aperiatech.com/api/v1/* carrying `Authorization: Bearer ...` are noted, and the token is
 * kept once the portal's request succeeds (2xx). No webRequest listener is installed, so no other
 * partition's listener can be clobbered. The token lives in this module's memory only: it is never
 * logged, written, or returned by describe().
 */
const C = require('./constants');
const { safeErr } = require('./redact');
const { safeJson } = require('./safe-json');
const log = require('../utils/logger')('aperia');

let _token = null;
let _expAt = null;     // JWT exp (epoch seconds) | null
let _capturedAt = 0;   // ms

/** _jwtExpAt(token) -> exp claim (epoch seconds) | null. Only exp is read. */
function _jwtExpAt(token) {
  try {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(String(token || ''));
    if (!m) return null;
    const j = safeJson(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return j.ok && j.value && typeof j.value.exp === 'number' ? j.value.exp : null;
  } catch (_) { return null; }
}

function _bearerOf(headers) {
  if (!headers || typeof headers !== 'object') return null;
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() !== 'authorization') continue;
    const m = /^\s*Bearer\s+([A-Za-z0-9._~+/=-]{10,})\s*$/i.exec(String(headers[k] || ''));
    return m ? m[1] : null;
  }
  return null;
}

/** current() -> the in-memory Bearer token | null (transport only; never log or return it). */
function current() {
  if (_token && typeof _expAt === 'number' && _expAt * 1000 <= Date.now()) clear();
  return _token;
}
function ageMs() { return _token ? Date.now() - _capturedAt : Infinity; }
function secondsLeft() { return _token && typeof _expAt === 'number' ? Math.round(_expAt - Date.now() / 1000) : null; }
function clear() { _token = null; _expAt = null; _capturedAt = 0; }
/** describe() -> { hasToken, secondsLeft } (no token). */
function describe() { return { hasToken: !!current(), secondsLeft: secondsLeft() }; }

function _set(token) {
  _token = token;
  _expAt = _jwtExpAt(token);
  _capturedAt = Date.now();
}

/**
 * createCapture(webContents, { onConnected, onUnauthorized }) -> { attach, detach }
 * onConnected() fires each time a Bearer-carrying /api/v1 request gets a 2xx response.
 */
function createCapture(webContents, opts) {
  const o = opts || {};
  const dbg = webContents && webContents.debugger;
  const pending = new Map(); // requestId -> token (until the response arrives)
  const _apiIds = new Set(); // requestIds of /api/v1 requests (for the ExtraInfo header fill-in)
  let listening = false;

  function _note(requestId, url, headers) {
    if (!C.isApiUrl(url)) return;
    const t = _bearerOf(headers);
    if (t) pending.set(requestId, t);
  }

  function onMessage(_e, method, params) {
    try {
      if (method === 'Network.requestWillBeSent') {
        const rq = params && params.request;
        if (rq) _note(params.requestId, rq.url, rq.headers);
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        // Same requestId; the URL was seen in requestWillBeSent. Only fill in if it was an API request.
        const id = params && params.requestId;
        if (id && !pending.has(id) && _apiIds.has(id)) {
          const t = _bearerOf(params.headers);
          if (t) pending.set(id, t);
        }
      } else if (method === 'Network.responseReceived') {
        const id = params && params.requestId;
        const status = Number(params && params.response && params.response.status);
        const t = pending.get(id);
        if (!t) return;
        pending.delete(id);
        if (status >= 200 && status < 300) {
          if (t !== _token) _set(t);
          if (typeof o.onConnected === 'function') o.onConnected();
        } else if (status === 401) {
          if (t === _token) clear();
          if (typeof o.onUnauthorized === 'function') o.onUnauthorized();
        }
      } else if (method === 'Network.loadingFailed') {
        pending.delete(params && params.requestId);
      }
    } catch (e) {
      try { log.warn('[aperia] cdp', safeErr(e)); } catch (_) {}
    }
  }

  function onRequestIds(_e, method, params) {
    if (method !== 'Network.requestWillBeSent') return;
    const rq = params && params.request;
    if (rq && C.isApiUrl(rq.url)) {
      _apiIds.add(params.requestId);
      if (_apiIds.size > 2000) _apiIds.clear();
    }
  }

  return {
    /** attach() — debugger.attach('1.3') + Network.enable. Throws when attach fails. */
    attach() {
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (!listening) { dbg.on('message', onRequestIds); dbg.on('message', onMessage); listening = true; }
      Promise.resolve()
        .then(() => dbg.sendCommand('Network.enable', {}))
        .catch((e) => { try { log.warn('[aperia] cdp enable', safeErr(e)); } catch (_) {} });
    },
    detach() {
      try { if (listening) { dbg.removeListener('message', onMessage); dbg.removeListener('message', onRequestIds); } } catch (e) { log.warn('[aperia] cdp detach', safeErr(e)); }
      listening = false;
      pending.clear();
      _apiIds.clear();
      try { if (dbg.isAttached()) dbg.detach(); } catch (e) { log.warn('[aperia] cdp detach', safeErr(e)); }
    },
  };
}

function _resetForTests() { clear(); }

module.exports = { createCapture, current, ageMs, secondsLeft, clear, describe, _jwtExpAt, _bearerOf, _resetForTests };
