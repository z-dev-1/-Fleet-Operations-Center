'use strict';
/**
 * cluster/aea-keepalive.js — unattended AEA posture-cookie refresher (Stage 12).
 *
 * WHY: The DevSpace standby pulls LIVE AAP reads (Stage 10/11) only while its
 * Midway/AEA session is valid. Two cookies with different lifetimes gate that:
 *
 *   amazon_enterprise_access (AEA)  ~2h  — short-lived posture cookie AAP
 *                                           enforces server-side. Re-minted by
 *                                           `mwinit --refresh-aea`.
 *   __Host-session / session        ~20h — the real Midway session credential.
 *
 * PROVEN ON THE DEVSPACE (2026-08): `mwinit --refresh-aea` runs NON-INTERACTIVELY
 * — no YubiKey tap, no OTP — and re-mints AEA (observed 63min → 120min) AS LONG
 * AS the ~20h session is still alive. It REUSES the live session.
 *
 * SO: this keep-alive timer refreshes AEA on a cadence, which keeps the standby
 * live for the ENTIRE session window with zero human interaction. Once per
 * session (~20h) the session itself expires and a human must run `mwinit -o`
 * (YubiKey) once — that step is identity re-attestation and is deliberately
 * NOT automatable. When that happens this module does NOT silently stall: it
 * detects the expired session and surfaces a clear, actionable log line.
 *
 * SCOPE / SAFETY:
 *   - Flag-gated. Runs only when the cluster is enabled AND this host opts in
 *     (settings.cluster.aeaKeepalive or env FLEET_AEA_KEEPALIVE=1). Default OFF.
 *   - Spawns ONLY `mwinit --refresh-aea` — a read-of-session, re-mint-of-AEA
 *     operation. It performs NO production side-effect and writes nothing but
 *     the local cookie file. Never spawns a full interactive `mwinit`.
 *   - Cross-platform: uses spawn(cmd, args) directly (no cmd.exe .bat), so it
 *     works on the Linux DevSpace. On a host without `mwinit` it logs and idles.
 *   - Single in-flight guard so overlapping ticks can't race two refreshes
 *     (a known cause of 'used_too_late').
 */

const { spawn } = require('child_process');
let logger; try { logger = require('../utils/logger')('aea-keepalive'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

// Defaults: check every 20 min; refresh when AEA has < 45 min left. AEA lives
// ~2h, so a 45-min floor leaves comfortable margin even if one tick is missed.
const DEFAULT_CHECK_MS = 20 * 60 * 1000;
const DEFAULT_MIN_AEA_MIN = 45;
const REFRESH_TIMEOUT_MS = 90 * 1000;

let _timer = null;
let _running = false;
let _inFlight = null;
let _lastResult = null;

// Indirection seam: tick() calls through _deps so tests can inject fakes for
// the two side-effecting operations (reading the cookie file, spawning mwinit)
// without a real box. Defaults point at the live implementations below.
const _deps = {
  readExpiry: (...a) => _readExpiry(...a),
  spawnRefresh: (...a) => _spawnRefresh(...a),
};

// Resolve opt-in from env or settings. Default OFF.
function _optedIn() {
  if (process.env.FLEET_AEA_KEEPALIVE === '1') return true;
  if (process.env.FLEET_AEA_KEEPALIVE === '0') return false;
  try {
    const store = require('../store');
    const c = (store.load('settings', {}) || {}).cluster || {};
    return !!c.aeaKeepalive;
  } catch (_) { return false; }
}

// Read current session + AEA expiry (minutes) via the existing auth parser.
// Returns { sessionOk, sessionMin, aeaMin } — all best-effort.
function _readExpiry() {
  try {
    const auth = require('../scrapers/auth');
    const chk = auth.checkMwinit();
    return {
      sessionOk: !!chk.ok,
      sessionMin: typeof chk.expiresInMin === 'number' ? chk.expiresInMin : null,
      aeaMin: typeof chk.aeaExpiresInMin === 'number' ? chk.aeaExpiresInMin
              : (typeof auth.aeaFileExpiryMin === 'function' ? auth.aeaFileExpiryMin() : null),
    };
  } catch (e) {
    return { sessionOk: false, sessionMin: null, aeaMin: null, error: e.message };
  }
}

// Spawn `mwinit --refresh-aea` cross-platform. Resolves { ok, aeaMin, code }.
// NON-interactive: inherits no TTY; if mwinit ever needs a tap it will exit
// non-zero rather than block (we bound it with a timeout regardless).
function _spawnRefresh() {
  if (_inFlight) return _inFlight;
  _inFlight = new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let child;
    try {
      child = spawn('mwinit', ['--refresh-aea'], { stdio: 'ignore' });
    } catch (e) {
      finish({ ok: false, error: 'spawn:' + e.message });
      return;
    }

    const to = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: 'timeout', aeaMin: _readExpiry().aeaMin });
    }, REFRESH_TIMEOUT_MS);
    if (to.unref) to.unref();

    child.on('error', (e) => { clearTimeout(to); finish({ ok: false, error: 'proc:' + e.message }); });
    child.on('exit', (code) => {
      clearTimeout(to);
      const after = _readExpiry();
      // Success = a live AEA cookie now present with time left. We judge by the
      // cookie file (truth), not mwinit's exit code — the cert step can exit
      // non-zero while the AEA cookie we actually need was written fine.
      const ok = after.aeaMin != null && after.aeaMin > 0;
      finish({ ok, aeaMin: after.aeaMin, code });
    });
  });
  _inFlight.finally(() => { _inFlight = null; });
  return _inFlight;
}

// One tick: refresh AEA if it's low (or forced). Handles the session-expired
// case explicitly so it never silently stalls.
async function tick(opts) {
  opts = opts || {};
  const minAea = opts.minAeaMin != null ? opts.minAeaMin : DEFAULT_MIN_AEA_MIN;
  const before = _deps.readExpiry();

  // Session itself expired → AEA refresh will NOT help (it reuses the session).
  // Surface a clear, actionable message instead of spinning.
  if (!before.sessionOk) {
    const msg = '[aea-keepalive] Midway SESSION expired — AEA refresh cannot help. ' +
                'A human must run `mwinit -o` (YubiKey) on this host once to restore live pull.';
    logger.warn(msg);
    _lastResult = { ok: false, reason: 'session-expired', sessionMin: before.sessionMin, aeaMin: before.aeaMin, at: new Date().toISOString() };
    return _lastResult;
  }

  // AEA still has comfortable headroom and not forced → nothing to do.
  if (!opts.force && before.aeaMin != null && before.aeaMin >= minAea) {
    _lastResult = { ok: true, reason: 'aea-fresh', sessionMin: before.sessionMin, aeaMin: before.aeaMin, at: new Date().toISOString() };
    return _lastResult;
  }

  logger.info('[aea-keepalive] refreshing AEA (was ' + before.aeaMin + 'min, session ' + before.sessionMin + 'min)…');
  const r = await _deps.spawnRefresh();
  if (r.ok) {
    logger.info('[aea-keepalive] AEA refreshed → ' + r.aeaMin + 'min (session still ' + before.sessionMin + 'min)');
    _lastResult = { ok: true, reason: 'refreshed', sessionMin: before.sessionMin, aeaMin: r.aeaMin, at: new Date().toISOString() };
  } else {
    logger.warn('[aea-keepalive] AEA refresh did not land: ' + (r.error || ('exit ' + r.code)));
    _lastResult = { ok: false, reason: r.error || 'refresh-failed', sessionMin: before.sessionMin, aeaMin: r.aeaMin != null ? r.aeaMin : before.aeaMin, at: new Date().toISOString() };
  }
  return _lastResult;
}

/**
 * start(opts) — begin the keep-alive loop. No-op unless opted in (so wiring it
 * into bootstrap unconditionally is safe). opts: { checkMs, minAeaMin, setTimer,
 * clearTimer } (timers injectable for tests).
 */
function start(opts) {
  opts = opts || {};
  if (_running) return { ok: true, already: true };
  if (!opts.force && !_optedIn()) {
    logger.info('[aea-keepalive] not opted in (FLEET_AEA_KEEPALIVE / settings.cluster.aeaKeepalive) — idle');
    return { ok: false, skipped: 'not-opted-in' };
  }
  const checkMs = opts.checkMs || DEFAULT_CHECK_MS;
  const setT = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clrT = opts.clearTimer || ((h) => clearTimeout(h));
  _running = true;
  _clearTimer = clrT;

  const loop = async () => {
    try { await tick({ minAeaMin: opts.minAeaMin }); } catch (e) { logger.warn('[aea-keepalive] tick error: ' + e.message); }
    if (_running) _timer = setT(loop, checkMs);
  };
  // Run one tick promptly so a just-started standby tops up AEA immediately,
  // then settle into the cadence.
  _timer = setT(loop, opts.immediate === false ? checkMs : 0);
  logger.info('[aea-keepalive] started (check every ' + Math.round(checkMs / 60000) + 'min, floor ' + (opts.minAeaMin || DEFAULT_MIN_AEA_MIN) + 'min)');
  return { ok: true };
}

let _clearTimer = (h) => clearTimeout(h);

function stop() {
  _running = false;
  if (_timer != null) { try { _clearTimer(_timer); } catch (_) {} _timer = null; }
}

function getState() {
  return { running: _running, optedIn: _optedIn(), last: _lastResult };
}

// Test hooks: override the side-effecting seams; reset restores live impls.
function _setDeps(d) { if (d && d.readExpiry) _deps.readExpiry = d.readExpiry; if (d && d.spawnRefresh) _deps.spawnRefresh = d.spawnRefresh; }
function _reset() {
  stop(); _inFlight = null; _lastResult = null;
  _deps.readExpiry = (...a) => _readExpiry(...a);
  _deps.spawnRefresh = (...a) => _spawnRefresh(...a);
}

module.exports = {
  start, stop, tick, getState,
  _readExpiry, _spawnRefresh, _optedIn, _setDeps, _reset,
  DEFAULT_CHECK_MS, DEFAULT_MIN_AEA_MIN,
};
