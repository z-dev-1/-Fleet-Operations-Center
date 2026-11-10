'use strict';
/**
 * src/zoom/studio/obs-client.js — minimal obs-websocket v5 client (design §4.3), main process only.
 *
 *   createObsClient({WebSocket = require('ws'), timeoutMs = 5000, log})
 *     -> {connect, request, sendRaw, close, on, connected}
 *
 *   connect({host, port, password}) -> Promise<{obsWebSocketVersion, rpcVersion}>
 *     Hello (op 0) -> exactly one Identify (op 1) {rpcVersion:1, authentication?, eventSubscriptions:65}
 *     -> Identified (op 2). Rejects ZoomError OBS_UNREACHABLE | OBS_PASSWORD_REQUIRED | OBS_AUTH_FAILED |
 *     OBS_UNSUPPORTED | OBS_CLOSED | TIMEOUT. The first of error / close / timer wins (single `settled`).
 *   request(type, data) -> Promise<responseData>  op 6 / op 7 correlated by requestId; 207 retried 5x
 *     500 ms apart; any other non-100 status -> OBS_REQUEST_FAILED {status, reason: type}; TIMEOUT.
 *   sendRaw(type, data) -> boolean  synchronous fire-and-forget op 6 (quit hook only), no response awaited.
 *   on('event', cb({eventType, eventData})) | on('close', cb({code})) -> unsubscribe()
 *   connected -> boolean (getter): Identified and the socket is open.
 *
 * The password is a local of connect() only and is never logged; logs carry codes only.
 */
const { EventEmitter } = require('events');
const { ZoomError } = require('../errors');
const { authString, closeCodeToError, isRefused } = require('./obs-auth');

const SUBPROTOCOL = 'obswebsocket.json';
const EVENT_SUBSCRIPTIONS = 65;   // General (ExitStarted) | Outputs (VirtualcamStateChanged)
const RETRY_207 = 5;
const RETRY_DELAY_MS = 500;
const OPEN = 1;

function createObsClient(opts = {}) {
  const WebSocket = opts.WebSocket || require('ws');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
  const log = opts.log || require('../../utils/logger')('zoom:studio');
  const emitter = new EventEmitter();
  const pending = new Map();   // requestId -> {resolve, reject, timer}
  let ws = null;
  let identified = false;
  let seq = 0;

  const _log = (level, fields) => { try { log[level]('[zoom-studio] obs-client', fields); } catch (_) {} };

  function _failPending(code) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new ZoomError(code));
    }
  }

  function _parse(data, isBinary) {
    const len = data && typeof data.length === 'number' ? data.length : 0;
    if (isBinary) { _log('debug', { op: 'malformed', len }); return null; }
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { msg = null; }
    if (!msg || typeof msg !== 'object' || typeof msg.op !== 'number' || !msg.d || typeof msg.d !== 'object') {
      _log('debug', { op: 'malformed', len });
      return null;
    }
    return msg;
  }

  function _onResponse(d) {
    const p = pending.get(d.requestId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(d.requestId);
    p.resolve(d);
  }

  function connect({ host, port, password } = {}) {
    if (ws) { try { ws.terminate ? ws.terminate() : ws.close(); } catch (_) {} ws = null; }
    identified = false;
    _failPending('OBS_CLOSED');
    return new Promise((resolve, reject) => {
      let settled = false;
      let hello = null;
      let identifySent = false;
      let sock;
      const timer = setTimeout(() => {
        _log('warn', { op: 'connect', code: 'TIMEOUT' });
        settle(new ZoomError('TIMEOUT'));
        _drop(sock);
      }, timeoutMs);

      function settle(err, val) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(val);
      }

      try {
        sock = new WebSocket('ws://' + host + ':' + port, SUBPROTOCOL);
      } catch (e) {
        _log('info', { op: 'connect', code: 'OBS_UNREACHABLE' });
        settle(new ZoomError('OBS_UNREACHABLE'));
        return;
      }
      ws = sock;

      sock.on('error', (e) => {
        if (settled) return;
        const code = isRefused(e) ? 'OBS_UNREACHABLE' : 'OBS_CLOSED';
        _log(code === 'OBS_UNREACHABLE' ? 'info' : 'warn', { op: 'connect', code });
        settle(new ZoomError(code));
      });

      sock.on('close', (closeCode) => {
        const current = ws === sock;
        if (current) ws = null;
        if (!current) { settle(new ZoomError('OBS_CLOSED')); return; }   // superseded by a newer connect()
        if (identified && settled) {
          identified = false;
          _failPending('OBS_CLOSED');
          emitter.emit('close', { code: closeCode });
          return;
        }
        if (settled) return;
        const code = closeCodeToError(closeCode);
        _log('warn', { op: 'connect', code, closeCode });
        settle(new ZoomError(code));
      });

      sock.on('message', (data, isBinary) => {
        const msg = _parse(data, isBinary);
        if (!msg) return;
        const d = msg.d;
        if (msg.op === 0) {
          if (identifySent || settled) return;
          hello = d;
          const ident = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
          if (d.authentication) {
            if (typeof password !== 'string' || !password) {
              _log('info', { op: 'connect', code: 'OBS_PASSWORD_REQUIRED' });
              settle(new ZoomError('OBS_PASSWORD_REQUIRED'));
              _drop(sock);
              return;
            }
            ident.authentication = authString(password, d.authentication.salt, d.authentication.challenge);
          }
          identifySent = true;
          try { sock.send(JSON.stringify({ op: 1, d: ident })); } catch (_) {}
          return;
        }
        if (msg.op === 2) {
          if (settled || !identifySent) return;
          identified = true;
          _log('info', { op: 'connect', code: 'OK' });
          settle(null, { obsWebSocketVersion: hello && hello.obsWebSocketVersion, rpcVersion: d.negotiatedRpcVersion });
          return;
        }
        if (msg.op === 5) {
          if (!identified) return;
          emitter.emit('event', { eventType: d.eventType, eventData: d.eventData });
          return;
        }
        if (msg.op === 7) _onResponse(d);
      });
    });
  }

  function _drop(sock) {
    if (!sock) return;
    try { sock.close(1000); } catch (_) {}
  }

  function _requestOnce(type, data) {
    return new Promise((resolve, reject) => {
      if (!ws || !identified || ws.readyState !== OPEN) { reject(new ZoomError('OBS_CLOSED')); return; }
      const requestId = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(requestId);
        _log('warn', { op: 'request', code: 'TIMEOUT' });
        reject(new ZoomError('TIMEOUT'));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      const d = { requestType: type, requestId };
      if (data !== undefined) d.requestData = data;
      try {
        ws.send(JSON.stringify({ op: 6, d }));
      } catch (_) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new ZoomError('OBS_CLOSED'));
      }
    });
  }

  async function request(type, data) {
    for (let attempt = 0; ; attempt++) {
      const res = await _requestOnce(type, data);
      const st = (res && res.requestStatus) || {};
      if (st.code === 100) return (res && res.responseData) || {};
      if (st.code === 207 && attempt < RETRY_207) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      _log('warn', { op: 'request', code: 'OBS_REQUEST_FAILED', status: st.code });
      throw new ZoomError('OBS_REQUEST_FAILED', { status: st.code, reason: type });
    }
  }

  function sendRaw(type, data) {
    if (!ws || ws.readyState !== OPEN) return false;
    const d = { requestType: type, requestId: 'raw-' + (++seq) };
    if (data !== undefined) d.requestData = data;
    try { ws.send(JSON.stringify({ op: 6, d })); return true; } catch (_) { return false; }
  }

  function close() {
    const s = ws;
    _failPending('OBS_CLOSED');
    _drop(s);
  }

  function on(event, cb) {
    emitter.on(event, cb);
    return () => emitter.removeListener(event, cb);
  }

  return {
    connect,
    request,
    sendRaw,
    close,
    on,
    get connected() { return !!(ws && identified && ws.readyState === OPEN); },
  };
}

module.exports = { createObsClient, SUBPROTOCOL, EVENT_SUBSCRIPTIONS, RETRY_207, RETRY_DELAY_MS };
