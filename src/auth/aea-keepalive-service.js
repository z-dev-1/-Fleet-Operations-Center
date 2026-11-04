'use strict';
/**
 * src/auth/aea-keepalive-service.js — THE single owner of AEA freshness.
 *
 * GOAL (the one the user actually needs): the app's Electron session must ALWAYS
 * carry a fresh, valid amazon_enterprise_access (AEA) cookie, with no manual
 * steps and no stale windows — 100% uptime on AEA.
 *
 * WHY the old approach failed (all confirmed live 2026-10-19):
 *   1. WRONG LIFETIME ASSUMPTION — the legacy refreshers assume AEA lives ~2h
 *      and poll every 5–20 min with a 45-min floor. On this machine the ACME
 *      posture token (which IS the AEA value) has a **15-minute TTL**, rolled by
 *      ACME every ~10 min. A 20-min poll cannot keep a 15-min token alive.
 *   2. WRONG SOURCE — the legacy refreshers shell out to `mwinit --refresh-aea`,
 *      which depends on the AEA BROWSER EXTENSION. That extension is broken here
 *      (StatusCode 7 / native-messaging registry errors), so those refreshes
 *      mint NOTHING. The reliable source is the ACME posture token FILE, which
 *      the ACME daemon always keeps fresh regardless of the extension.
 *   3. REACTIVE — AEA was only refreshed AFTER a request failed, so the app
 *      always hit a broken window first.
 *
 * THE SYSTEM this module implements:
 *   - SOURCE OF TRUTH: the ACME posture token on disk (auth.injectAeaFromPostureToken).
 *     It injects that JWT as the AEA cookie directly into the Electron session —
 *     no browser extension, no mwinit, no YubiKey.
 *   - TIGHT, TTL-MATCHED CADENCE: a short interval (default 60s) re-reads the
 *     live session AEA + the posture-token TTL and RE-INJECTS proactively well
 *     before expiry (when the live AEA drops below a safety floor, default 8 min,
 *     i.e. roughly half of the 15-min token life). A 15-min token refreshed on a
 *     1-min loop with an 8-min floor cannot go stale under normal operation.
 *   - EVENT-DRIVEN: also WATCHES the posture token file, so the instant ACME
 *     rolls a new token the app captures it immediately (zero lag).
 *   - SELF-VERIFYING + HONEST DEGRADE: after each inject it checks the live
 *     session AEA. The ONLY unrecoverable case is the ACME posture token being
 *     missing/expired (ACME agent down) or the Midway SESSION being dead — both
 *     surfaced as a single, clear, actionable state (not a silent stall).
 *   - ALWAYS ON for the app (not opt-in like the DevSpace cluster keep-alive).
 *   - SINGLE-FLIGHT: overlapping ticks can never run two injects at once.
 *   - INJECTABLE seams (timers, auth) so it is deterministically testable.
 *
 * This does NOT replace the health SUPERVISOR (which owns verify + recovery
 * policy). It keeps AEA so fresh that the supervisor almost never has to
 * recover. If AEA ever does lapse (ACME down), the supervisor still handles it.
 */

let logger; try { logger = require('../utils/logger').createLogger('aea-keepalive'); } catch (_) {
  try { logger = require('../utils/logger')('aea-keepalive'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }
}

function _auth() { try { return require('../scrapers/auth'); } catch (_) { return null; } }

// ── Tunables (matched to the real ACME cadence: 15-min token, rolled ~10 min) ──
const DEFAULT_CHECK_MS = 60 * 1000;   // re-evaluate every 60s
const DEFAULT_FLOOR_MIN = 8;          // re-inject when live AEA < 8 min left (~half the 15-min token)
const DEGRADED_LOG_THROTTLE_MS = 5 * 60 * 1000; // don't spam the degraded line

// ── State ────────────────────────────────────────────────────────────────────
let _running = false;
let _timer = null;
let _watchHandle = null;
let _inFlight = false;
let _lastResult = null;           // { ok, reason, aeaMin, tokenMin, at }
let _lastState = 'UNKNOWN';       // FRESH | REINJECTED | DEGRADED | SESSION_EXPIRED | ACME_DOWN | UNKNOWN
let _lastDegradedLogAt = 0;
let _consecutiveFailures = 0;

// Injectable seams for tests.
const _timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
const _deps = { auth: null };     // null → lazy require('../scrapers/auth')
function _a() { return _deps.auth || _auth(); }

function getState() {
  return {
    running: _running,
    state: _lastState,
    last: _lastResult,
    consecutiveFailures: _consecutiveFailures,
  };
}

function _setState(next, reason) {
  if (next !== _lastState) {
    logger.info('[aea-keepalive] state ' + _lastState + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
    _lastState = next;
  }
}

/**
 * tick(opts) — the heart of the keep-alive. Decides whether the live session
 * AEA needs a re-inject and does it from the ACME posture token. Pure policy on
 * top of the auth primitives; safe to call on a timer, on a file-change, or on
 * demand. Single-flight: a tick already running makes a concurrent call a no-op.
 *   opts.force      → inject regardless of current freshness
 *   opts.floorMin   → re-inject when live AEA below this (default DEFAULT_FLOOR_MIN)
 */
async function tick(opts) {
  opts = opts || {};
  if (_inFlight) return _lastResult || { ok: false, reason: 'in-flight' };
  _inFlight = true;
  const floorMin = opts.floorMin != null ? opts.floorMin : DEFAULT_FLOOR_MIN;
  const auth = _a();
  const now = () => new Date().toISOString();
  try {
    if (!auth) { _setState('UNKNOWN', 'auth module unavailable'); return (_lastResult = { ok: false, reason: 'auth-unavailable', at: now() }); }

    // 1) How fresh is the app's LIVE session AEA right now? (truth AAP uses)
    let liveAea = null;
    try { liveAea = await auth.aeaSessionExpiryMin(); } catch (_) {}

    // 2) How much life does the ACME posture token currently offer? This is the
    //    ceiling on how fresh we can make the AEA cookie.
    const tokenMin = (typeof auth.postureTokenExpiryMin === 'function') ? auth.postureTokenExpiryMin() : null;

    // 3) If the posture token is gone/expired, ACME itself is down or the device
    //    fell out of compliance — we CANNOT mint AEA. Surface it honestly.
    if (tokenMin == null) {
      _consecutiveFailures++;
      _throttledDegraded('ACME_DOWN', 'posture token missing/unreadable — ACME agent may be down or device non-compliant');
      return (_lastResult = { ok: false, reason: 'posture-token-missing', aeaMin: liveAea, tokenMin: null, at: now() });
    }
    if (tokenMin <= 0) {
      _consecutiveFailures++;
      _throttledDegraded('ACME_DOWN', 'posture token expired and ACME has not rolled a fresh one');
      return (_lastResult = { ok: false, reason: 'posture-token-expired', aeaMin: liveAea, tokenMin, at: now() });
    }

    // 4) Decide whether to re-inject. Re-inject when: forced, OR no live AEA, OR
    //    live AEA is below the floor, OR the disk token is meaningfully fresher
    //    than what's in the session (ACME just rolled a new token → capture it).
    const needsInject =
      opts.force ||
      liveAea == null ||
      liveAea < floorMin ||
      (tokenMin - (liveAea || 0) >= 2);   // a newer token is available on disk

    if (!needsInject) {
      _consecutiveFailures = 0;
      _setState('FRESH', 'live AEA ' + liveAea + 'min >= floor ' + floorMin + 'min');
      return (_lastResult = { ok: true, reason: 'fresh', aeaMin: liveAea, tokenMin, at: now() });
    }

    // 5) Re-inject the posture token as the AEA cookie into the live session.
    const r = await auth.injectAeaFromPostureToken();
    if (r && r.ok) {
      _consecutiveFailures = 0;
      _setState('REINJECTED', 'live AEA was ' + (liveAea == null ? 'missing' : liveAea + 'min') + ' → now ' + (r.aeaMin == null ? '?' : r.aeaMin + 'min'));
      return (_lastResult = { ok: true, reason: 'reinjected', aeaMin: r.aeaMin, tokenMin, at: now() });
    }

    // Inject failed despite a live-looking token — rare; count and report.
    _consecutiveFailures++;
    _throttledDegraded('DEGRADED', 'posture-token inject did not land: ' + (r && r.reason || 'unknown'));
    return (_lastResult = { ok: false, reason: (r && r.reason) || 'inject-failed', aeaMin: liveAea, tokenMin, at: now() });
  } catch (e) {
    _consecutiveFailures++;
    logger.warn('[aea-keepalive] tick error: ' + (e && e.message || e));
    return (_lastResult = { ok: false, reason: 'tick-error:' + (e && e.message || e), at: now() });
  } finally {
    _inFlight = false;
  }
}

function _throttledDegraded(state, msg) {
  _setState(state, msg);
  const t = Date.now();
  if (t - _lastDegradedLogAt > DEGRADED_LOG_THROTTLE_MS) {
    _lastDegradedLogAt = t;
    logger.warn('[aea-keepalive] ' + msg +
      ' — the app cannot get a fresh AEA until this clears. If it persists, the ACME/Enterprise Access agent needs attention (device-trust), not the app.');
  }
}

/**
 * start(opts) — begin the always-on keep-alive loop + posture-token file watch.
 * Idempotent. opts: { checkMs, floorMin, immediate, setTimer, clearTimer }.
 */
function start(opts) {
  opts = opts || {};
  if (_running) return { ok: true, already: true };
  _running = true;
  const checkMs = opts.checkMs || DEFAULT_CHECK_MS;
  const floorMin = opts.floorMin != null ? opts.floorMin : DEFAULT_FLOOR_MIN;
  if (opts.setTimer) _timers.set = opts.setTimer;
  if (opts.clearTimer) _timers.clear = opts.clearTimer;

  // Tight interval loop.
  const loop = async () => {
    try { await tick({ floorMin }); } catch (e) { logger.warn('[aea-keepalive] loop error: ' + (e && e.message || e)); }
    if (_running) _timer = _timers.set(loop, checkMs);
  };
  _timer = _timers.set(loop, opts.immediate === false ? checkMs : 0);

  // Event-driven: capture a freshly-rolled posture token the instant ACME
  // writes it (don't wait up to checkMs). Best-effort; the loop is the floor.
  try {
    const auth = _a();
    const tokenPath = auth && auth.ACME_POSTURE_TOKEN;
    if (tokenPath) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(tokenPath);
      const base = path.basename(tokenPath);
      let debounce = null;
      _watchHandle = fs.watch(dir, (_evt, fname) => {
        if (fname && fname !== base) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { tick({ force: true }).catch(() => {}); }, 500);
      });
      logger.info('[aea-keepalive] watching posture token: ' + tokenPath);
    }
  } catch (e) {
    logger.warn('[aea-keepalive] posture-token watch failed to start: ' + (e && e.message || e));
  }

  logger.info('[aea-keepalive] STARTED — always-on AEA owner (check ' + Math.round(checkMs / 1000) + 's, floor ' + floorMin + 'min, source=ACME posture token)');
  return { ok: true };
}

function stop() {
  _running = false;
  if (_timer != null) { try { _timers.clear(_timer); } catch (_) {} _timer = null; }
  if (_watchHandle) { try { _watchHandle.close(); } catch (_) {} _watchHandle = null; }
}

// ── Test seams ────────────────────────────────────────────────────────────────
function _setDeps(d) { if (d && d.auth) _deps.auth = d.auth; }
function _setTimers(t) { if (t && t.set) _timers.set = t.set; if (t && t.clear) _timers.clear = t.clear; }
function _reset() {
  stop();
  _inFlight = false; _lastResult = null; _lastState = 'UNKNOWN';
  _lastDegradedLogAt = 0; _consecutiveFailures = 0;
  _deps.auth = null;
  _timers.set = (fn, ms) => setTimeout(fn, ms);
  _timers.clear = (h) => clearTimeout(h);
}

module.exports = {
  start, stop, tick, getState,
  DEFAULT_CHECK_MS, DEFAULT_FLOOR_MIN,
  _setDeps, _setTimers, _reset,
};
