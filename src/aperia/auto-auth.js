'use strict';
/**
 * src/aperia/auto-auth.js — when the app signs in to Aperia on its own (Phase E).
 *
 * start(ctx) is called once from src/app.js after the main window exists (after the DTNA one; the
 * startup delays are staggered). It never blocks: every trigger is a one-shot, unref'd timer running
 * session.backgroundLogin (a HIDDEN portal window with the stored-credential auto-login; single-flight
 * and rate limited in session.js), so no trigger can loop.
 *  - startup: C.BG_STARTUP_DELAY_MS after start.
 *  - expired: the session status turns 'expired' (a 401 cleared the Bearer), debounced EXPIRED_DEBOUNCE_MS.
 * Each session status change is pushed to the renderer as aperia:alert { type:'session' } (no other
 * field), so the pill and the panel re-read the Aperia status over IPC. Background sign-in never turns tire alerts
 * on: that stays the user's opt-in toggle. Logs: { op, reason, code } only.
 */
const C = require('./constants');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

// Test seam: { session, setTimeout, clearTimeout, electron }.
let _deps = {};
function _session() { return _deps.session || require('./session'); }
function _electron() { return _deps.electron || require('electron'); }
function _arm(fn, ms) {
  const set = typeof _deps.setTimeout === 'function' ? _deps.setTimeout : setTimeout;
  const t = set(() => { try { fn(); } catch (e) { log.warn('[aperia] auto-auth', safeErr(e)); } }, ms);
  try { if (t && typeof t.unref === 'function') t.unref(); } catch (_) {}
  return t;
}
function _disarm(t) {
  if (t == null) return;
  const clear = typeof _deps.clearTimeout === 'function' ? _deps.clearTimeout : clearTimeout;
  try { clear(t); } catch (_) {}
}

const EXPIRED_DEBOUNCE_MS = 3e3;

let _started = false;
let _ctx = null;
let _startupT = null;
let _expiredT = null;
let _off = null;
let _lastState = null;

function _login(reason) {
  return Promise.resolve()
    .then(() => _session().backgroundLogin({ reason }))
    .catch((e) => { log.warn('[aperia] auto-auth', safeErr(e)); return { ok: false, code: 'APERIA_INTERNAL' }; })
    .then((r) => {
      const code = r && r.ok ? 'OK' : String((r && r.code) || 'APERIA_INTERNAL').slice(0, 40);
      log.info('[aperia] auto-auth', { op: 'trigger', reason, code });
      return r;
    });
}

function _push() {
  try { if (_ctx && typeof _ctx.sendToWindow === 'function') _ctx.sendToWindow('aperia:alert', { type: 'session' }); } catch (e) { log.warn('[aperia] auto-auth send', safeErr(e)); }
}

function _onStatus(s) {
  if (!_started || !s || typeof s !== 'object') return;
  _push();
  const st = s.state;
  // Into 'expired' from anything but our own (or the user's) sign-in attempt.
  if (st === 'expired' && _lastState !== 'expired' && _lastState !== 'connecting') {
    _disarm(_expiredT);
    _expiredT = _arm(() => { _expiredT = null; _login('expired'); }, EXPIRED_DEBOUNCE_MS);
  }
  _lastState = st;
}

/** start(ctx, deps) — idempotent. Arms the startup sign-in and subscribes to session status. */
function start(ctx, deps) {
  if (_started) return { ok: true, already: true };
  _deps = deps || {};
  _ctx = ctx || null;
  _started = true;
  try { _lastState = _session().status().state; } catch (_) { _lastState = null; }
  try { _off = _session().onStatus(_onStatus); } catch (e) { log.warn('[aperia] auto-auth', safeErr(e)); _off = null; }
  _startupT = _arm(() => { _startupT = null; _login('startup'); }, C.BG_STARTUP_DELAY_MS);
  try {
    const app = _electron().app;
    if (app && typeof app.once === 'function') app.once('before-quit', stop);
  } catch (e) { log.warn('[aperia] auto-auth quit hook', safeErr(e)); }
  log.info('[aperia] auto-auth', { op: 'start', delayMs: C.BG_STARTUP_DELAY_MS });
  return { ok: true };
}

/** stop() — clear every timer and unsubscribe (app before-quit). */
function stop() {
  _disarm(_startupT); _disarm(_expiredT);
  _startupT = null; _expiredT = null;
  try { if (_off) _off(); } catch (_) {}
  _off = null;
  _started = false;
  _lastState = null;
  _ctx = null;
}

function _resetForTests() { stop(); _deps = {}; }

module.exports = { start, stop, _resetForTests, EXPIRED_DEBOUNCE_MS };
