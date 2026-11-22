'use strict';
/**
 * src/dtna/auto-auth.js — when the app signs in to DTNA on its own (Phase E).
 *
 * start(ctx) is called once from src/app.js after the main window exists. It never blocks: every trigger
 * is a one-shot, unref'd timer, and each runs session.backgroundLogin (a HIDDEN window with the stored-
 * credential auto-login; single-flight and rate limited in session.js), so no trigger can loop.
 *  - startup: C.BG_STARTUP_DELAY_MS after start.
 *  - expired: the session status turns 'expired' (an Aura invalid-session, a 0 s SessionTimeServlet
 *    reading, an old capture), debounced EXPIRED_DEBOUNCE_MS.
 *  - expiry: one timer armed from the last SessionTimeServlet reading (expiresInSec + slack, clamped
 *    1 min .. C.BG_EXPIRY_MAX_MS) and replaced on each reading. When it fires the servlet is read again;
 *    only a session that is still (nearly) out signs in again.
 * After a successful sign-in the servlet is read once (integers only) so the pill shows the time left.
 * No time-of-day schedule and no repeating timer. Logs: { op, reason, code } only.
 */
const C = require('./constants');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('dtna');

// Test seam: { session, sessionTime, setTimeout, clearTimeout, electron }.
let _deps = {};
function _session() { return _deps.session || require('./session'); }
function _sessionTime() { return _deps.sessionTime || require('./session-time'); }
function _electron() { return _deps.electron || require('electron'); }
function _arm(fn, ms) {
  const set = typeof _deps.setTimeout === 'function' ? _deps.setTimeout : setTimeout;
  const t = set(() => { try { fn(); } catch (e) { log.warn('[dtna] auto-auth', safeErr(e)); } }, ms);
  try { if (t && typeof t.unref === 'function') t.unref(); } catch (_) {}
  return t;
}
function _disarm(t) {
  if (t == null) return;
  const clear = typeof _deps.clearTimeout === 'function' ? _deps.clearTimeout : clearTimeout;
  try { clear(t); } catch (_) {}
}

const EXPIRED_DEBOUNCE_MS = 3e3;
const EXPIRY_MIN_MS = 60e3;

let _started = false;
let _startupT = null;
let _expiredT = null;
let _expiryT = null;
let _off = null;
let _lastState = null;

function _readTime() {
  return Promise.resolve()
    .then(() => _sessionTime().read())
    .catch((e) => { log.warn('[dtna] auto-auth', safeErr(e)); return null; });
}

/** _login(reason) -> backgroundLogin result; on ok one SessionTimeServlet read (fail-open). */
function _login(reason) {
  return Promise.resolve()
    .then(() => _session().backgroundLogin({ reason }))
    .catch((e) => { log.warn('[dtna] auto-auth', safeErr(e)); return { ok: false, code: 'DTNA_INTERNAL' }; })
    .then(async (r) => {
      const code = r && r.ok ? 'OK' : String((r && r.code) || 'DTNA_INTERNAL').slice(0, 40);
      log.info('[dtna] auto-auth', { op: 'trigger', reason, code });
      if (r && r.ok) await _readTime();
      return r;
    });
}

// Expiry timer fired: re-read the servlet; sign in again only when the session is (nearly) out.
async function _onExpiry() {
  const t = await _readTime();
  if (t && t.ok && !t.expired && t.remainingSec >= C.SESSION_PREFLIGHT_MIN_SEC) return; // the new reading re-armed the timer
  await _login('expiry');
}

function _onStatus(s) {
  if (!_started || !s || typeof s !== 'object') return;
  const st = s.state;
  // Into 'expired' from anything but our own (or the user's) sign-in attempt.
  if (st === 'expired' && _lastState !== 'expired' && _lastState !== 'connecting') {
    _disarm(_expiredT);
    _expiredT = _arm(() => { _expiredT = null; _login('expired'); }, EXPIRED_DEBOUNCE_MS);
  }
  _lastState = st;
  const exp = s.expiresInSec;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
    _disarm(_expiryT);
    const ms = Math.min(C.BG_EXPIRY_MAX_MS, Math.max(EXPIRY_MIN_MS, exp * 1000 + C.BG_EXPIRY_SLACK_MS));
    _expiryT = _arm(() => { _expiryT = null; _onExpiry().catch(() => {}); }, ms);
  }
}

/**
 * start(ctx, deps) — idempotent. Arms the startup sign-in and subscribes to session status.
 * Returns { ok:true, already? }.
 */
function start(ctx, deps) {
  if (_started) return { ok: true, already: true };
  _deps = deps || {};
  _started = true;
  try { _lastState = _session().status().state; } catch (_) { _lastState = null; }
  try { _off = _session().onStatus(_onStatus); } catch (e) { log.warn('[dtna] auto-auth', safeErr(e)); _off = null; }
  _startupT = _arm(() => { _startupT = null; _login('startup'); }, C.BG_STARTUP_DELAY_MS);
  try {
    const app = _electron().app;
    if (app && typeof app.once === 'function') app.once('before-quit', stop);
  } catch (e) { log.warn('[dtna] auto-auth quit hook', safeErr(e)); }
  log.info('[dtna] auto-auth', { op: 'start', delayMs: C.BG_STARTUP_DELAY_MS });
  return { ok: true };
}

/** stop() — clear every timer and unsubscribe (app before-quit). */
function stop() {
  _disarm(_startupT); _disarm(_expiredT); _disarm(_expiryT);
  _startupT = null; _expiredT = null; _expiryT = null;
  try { if (_off) _off(); } catch (_) {}
  _off = null;
  _started = false;
  _lastState = null;
}

function _resetForTests() { stop(); _deps = {}; }

module.exports = { start, stop, _resetForTests, EXPIRED_DEBOUNCE_MS };
