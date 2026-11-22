'use strict';
/**
 * src/aperia/ws.js — the Aperia alert WebSocket (wss://amazon.aperiatech.com/api/ws/events), main process only.
 *
 *   createAlertSocket({ token, WebSocket = require('ws'), onAlert, onState, timers })
 *     -> { open(), close(), state() }
 *
 *   States: connecting | open | closed | failed | unauthorized; onState(state) on every change.
 *   Pings C.WS_PING every C.WS_PING_MS while open; C.WS_PONG and non-JSON frames are ignored.
 *   A JSON frame { type, data } with type in C.WS_ALERT_TYPES and data.id ->
 *     onAlert({ id, severity, state, vehicleId, fleetVehicleId }).
 *   Unclean close or open timeout -> reconnect with backoff (5 s doubling, max 5 min) up to C.WS_MAX_RECONNECTS,
 *   then 'failed'. A 401/403 handshake ('unexpected-response') -> 'unauthorized', no reconnect.
 *
 * The socket URL carries the token in its query: it is built here, never logged and never returned.
 * The socket only subscribes; nothing is ever sent except the keepalive ping.
 */
const C = require('./constants');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const OPEN = 1;
const BACKOFF_START_MS = 5e3;
const BACKOFF_MAX_MS = 5 * 60e3;

function _s(v, max) { return v === null || v === undefined ? '' : String(v).slice(0, max); }

function _defaultTimers() {
  return {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (t) => globalThis.clearTimeout(t),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (t) => globalThis.clearInterval(t),
  };
}

function _unref(t) { try { if (t && typeof t.unref === 'function') t.unref(); } catch (_) {} return t; }

function createAlertSocket(opts) {
  const o = opts || {};
  const token = typeof o.token === 'string' ? o.token : '';
  const WebSocket = o.WebSocket || require('ws');
  const onAlert = typeof o.onAlert === 'function' ? o.onAlert : () => {};
  const onState = typeof o.onState === 'function' ? o.onState : () => {};
  const timers = Object.assign(_defaultTimers(), o.timers || {});

  let state = 'closed';
  let sock = null;
  let stopped = true;
  let reconnects = 0;
  let pingTimer = null;
  let openTimer = null;
  let retryTimer = null;

  function _set(s) {
    if (s === state) return;
    state = s;
    try { onState(s); } catch (e) { log.warn('[aperia] ws onState', { code: 'APERIA_WS_CALLBACK', err: safeErr(e) }); }
  }

  function _clearTimers() {
    if (pingTimer) { timers.clearInterval(pingTimer); pingTimer = null; }
    if (openTimer) { timers.clearTimeout(openTimer); openTimer = null; }
    if (retryTimer) { timers.clearTimeout(retryTimer); retryTimer = null; }
  }

  function _drop(s) {
    try { if (typeof s.terminate === 'function') s.terminate(); else s.close(); } catch (_) {}
  }

  function _onMessage(data, isBinary) {
    if (isBinary) return;
    const text = String(data);
    if (text === C.WS_PONG || text === C.WS_PING) return;
    const p = safeJson(text);
    const m = p.ok ? p.value : null;
    if (!m || typeof m !== 'object' || !C.WS_ALERT_TYPES.includes(m.type)) return;
    const d = m.data;
    if (!d || typeof d !== 'object' || d.id === null || d.id === undefined || d.id === '') return;
    const v = d.vehicle && typeof d.vehicle === 'object' ? d.vehicle : {};
    try {
      onAlert({
        id: _s(d.id, 64),
        severity: _s(d.severity, 20),
        state: _s(d.type, 60),
        vehicleId: _s(v.id, 64),
        fleetVehicleId: _s(v.fleetVehicleId, 60),
      });
    } catch (e) { log.warn('[aperia] ws onAlert', { code: 'APERIA_WS_CALLBACK', err: safeErr(e) }); }
  }

  /** _down(clean) — the current socket is gone: reconnect with backoff or give up. */
  function _down(clean) {
    _clearTimers();
    sock = null;
    if (stopped) return;
    if (clean) { stopped = true; log.info('[aperia] ws', { op: 'closed', clean: true }); _set('closed'); return; }
    if (reconnects >= C.WS_MAX_RECONNECTS) {
      stopped = true;
      log.warn('[aperia] ws', { op: 'reconnect', code: 'APERIA_WS_FAILED', attempts: reconnects });
      _set('failed');
      return;
    }
    const delay = Math.min(BACKOFF_START_MS * Math.pow(2, reconnects), BACKOFF_MAX_MS);
    reconnects++;
    _set('closed');
    retryTimer = _unref(timers.setTimeout(() => { retryTimer = null; if (!stopped) _connect(); }, delay));
  }

  function _connect() {
    _set('connecting');
    let s;
    try {
      s = new WebSocket(C.WS_URL + '?' + C.WS_TOKEN_PARAM + '=' + encodeURIComponent(token), { headers: { Origin: C.BASE_URL } });
    } catch (e) {
      log.warn('[aperia] ws', { op: 'connect', code: 'APERIA_WS_ERROR', err: safeErr(e) });
      _down(false);
      return;
    }
    sock = s;
    openTimer = _unref(timers.setTimeout(() => {
      openTimer = null;
      if (sock !== s) return;
      log.warn('[aperia] ws', { op: 'connect', code: 'APERIA_WS_TIMEOUT' });
      sock = null;
      _drop(s);
      _down(false);
    }, C.WS_OPEN_TIMEOUT_MS));

    s.on('open', () => {
      if (sock !== s) return;
      if (openTimer) { timers.clearTimeout(openTimer); openTimer = null; }
      reconnects = 0;
      pingTimer = _unref(timers.setInterval(() => {
        try { if (sock === s && s.readyState === OPEN) s.send(C.WS_PING); } catch (e) { log.warn('[aperia] ws ping', { code: 'APERIA_WS_ERROR', err: safeErr(e) }); }
      }, C.WS_PING_MS));
      log.info('[aperia] ws', { op: 'open' });
      _set('open');
    });
    s.on('message', (data, isBinary) => { if (sock === s) _onMessage(data, isBinary); });
    s.on('unexpected-response', (_req, res) => {
      if (sock !== s) return;
      const status = res && Number(res.statusCode);
      sock = null;
      _drop(s);
      if (status === 401 || status === 403) {
        _clearTimers();
        stopped = true;
        log.warn('[aperia] ws', { op: 'handshake', code: 'APERIA_WS_UNAUTHORIZED', status });
        _set('unauthorized');
        return;
      }
      log.warn('[aperia] ws', { op: 'handshake', code: 'APERIA_WS_HANDSHAKE', status: Number.isFinite(status) ? status : 0 });
      _down(false);
    });
    s.on('error', (e) => { log.warn('[aperia] ws', { op: 'error', code: 'APERIA_WS_ERROR', err: safeErr(e) }); });
    s.on('close', (code) => {
      if (sock !== s) return;
      _down(Number(code) === 1000);
    });
  }

  function open() {
    if (!stopped || !token) return;
    stopped = false;
    reconnects = 0;
    _connect();
  }

  function close() {
    stopped = true;
    _clearTimers();
    const s = sock;
    sock = null;
    if (s) { try { s.close(1000); } catch (_) {} }
    _set('closed');
  }

  return { open, close, state: () => state };
}

module.exports = { createAlertSocket };
