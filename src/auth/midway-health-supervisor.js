'use strict';
/**
 * src/auth/midway-health-supervisor.js — Midway/AAP auth HEALTH SUPERVISOR.
 *
 * ONE authority for Midway authentication health + recovery. It REUSES the
 * proven primitives in src/scrapers/auth.js (cookie parse/inject, probeSession,
 * silent AEA refresh, mwinit --refresh-aea, AEA-agent self-heal, interactive
 * mwinit) — it does NOT re-implement them. Its job is orchestration done right:
 *
 *   - Health is defined by SUCCESSFUL AUTHENTICATED ACCESS TO THE REAL AAP
 *     TARGET — never by VPN status, never by mere cookie existence, never by a
 *     command completing (spec invariant #5/#6/#30).
 *   - VPN is NEVER a hard gate (spec #1/#29). It is optional diagnostic context
 *     and at most an optional recovery hint.
 *   - One global recovery lock; an explicit, auditable state machine; bounded
 *     auto-retry so a single failed pass never leaves auth permanently stuck.
 *
 * PHASE A (this file, additive — no wiring yet): the VERIFICATION primitives
 * that make "healthy" mean real-target acceptance:
 *   - verifyHealthy()   : authenticated AAP API smoke test (+ browser probe)
 *   - classifyFailure() : normalize any auth-looking failure into a class
 *   - buildSnapshot()   : structured, secret-free health snapshot
 * Later phases add the state machine, the recovery ladder wrapper, persistent
 * convergence, caller migration, and the health UI.
 */

let logger; try { logger = require('../utils/logger').createLogger('auth-supervisor'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

function _auth() { try { return require('../scrapers/auth'); } catch (_) { return null; } }
function _aapApi() { try { return require('../scrapers/aap_api'); } catch (_) { return null; } }
function _isOfflineNow() { try { return !!require('../orcha/offline').isOffline(); } catch (_) { return false; } }

// ── Health states (spec #3) ──────────────────────────────────────────────────
const STATE = {
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  RECOVERING: 'RECOVERING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  COOLDOWN: 'COOLDOWN',
  OFFLINE: 'OFFLINE',
  FAILED: 'FAILED',
};

// ── Failure classes (spec #17) ───────────────────────────────────────────────
const FAIL = {
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  NETWORK_DNS: 'NETWORK_DNS',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  TARGET_UNREACHABLE: 'TARGET_UNREACHABLE',
  MIDWAY_SESSION_EXPIRED: 'MIDWAY_SESSION_EXPIRED',
  AEA_MISSING: 'AEA_MISSING',
  AEA_EXPIRED: 'AEA_EXPIRED',
  AEA_AGENT_HUNG: 'AEA_AGENT_HUNG',
  SSO_LOGIN_WALL: 'SSO_LOGIN_WALL',
  COOKIE_INJECTION_FAILED: 'COOKIE_INJECTION_FAILED',
  AAP_AUTH_REJECTED: 'AAP_AUTH_REJECTED',
  AAP_API_UNAUTHORIZED: 'AAP_API_UNAUTHORIZED',
  AAP_SERVER_ERROR: 'AAP_SERVER_ERROR',
  UNKNOWN_AUTH_FAILURE: 'UNKNOWN_AUTH_FAILURE',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',   // auth.propagation: status-only class, never returned by classifyFailure
};

/**
 * classifyFailure(err, ctx) -> one of FAIL.*
 * Normalizes any auth-looking failure. CRITICAL (spec #17): an AAP HTTP 500 is a
 * SERVER error, NOT an auth failure — it must never trigger mwinit. A DNS/offline
 * error is a NETWORK class, not a rejected session. ctx is optional
 * ({ offline, where }). Deps injectable for tests via _deps.isOffline.
 */
function classifyFailure(err, ctx) {
  ctx = ctx || {};
  const msg = String((err && (err.message || err)) || '').toLowerCase();
  const status = err && (err.status || err.statusCode);
  const code = err && err.code;

  if (ctx.offline || _deps.isOffline()) return FAIL.NETWORK_OFFLINE;
  if (code === 'MIDWAY_SESSION_INVALID') return FAIL.AAP_API_UNAUTHORIZED;
  if (status === 401 || status === 403) return FAIL.AAP_API_UNAUTHORIZED;
  if (status === 500 || status === 502 || status === 503 || status === 504 ||
      /\baap api 5\d\d\b|server error|internal server/i.test(msg)) return FAIL.AAP_SERVER_ERROR;

  if (/getaddrinfo|dns|enotfound/i.test(msg)) return FAIL.NETWORK_DNS;
  if (/etimedout|timed out|timeout/i.test(msg)) return FAIL.NETWORK_TIMEOUT;
  if (/econnrefused|econnreset|ehostunreach|enetunreach|socket hang up|network error/i.test(msg)) return FAIL.TARGET_UNREACHABLE;

  if (/sso|login wall|midway-auth|signin|rejected session|session rejected/i.test(msg)) return FAIL.SSO_LOGIN_WALL;
  if (/session.*(expired|missing|invalid)|__host-session|run mwinit/i.test(msg)) return FAIL.MIDWAY_SESSION_EXPIRED;
  if (/aea.*(missing|expired)|enterprise_access/i.test(msg)) return FAIL.AEA_EXPIRED;
  if (/posture|enterpriseaccessconsole|agent.*hung/i.test(msg)) return FAIL.AEA_AGENT_HUNG;
  if (/inject|cookie.*(failed|write)/i.test(msg)) return FAIL.COOKIE_INJECTION_FAILED;
  return FAIL.UNKNOWN_AUTH_FAILURE;
}

/**
 * apiSmokeTest(opts) -> { ok, status?, class?, latencyMs }
 * The PRIMARY authenticated-access check (spec #16): a READ-ONLY, lightweight,
 * unit-independent AAP API call (GET /api/v1/user/details). A 200 means we are
 * really logged in; a 401/403 (MIDWAY_SESSION_INVALID) means not authed; a 500
 * is a server error (NOT auth). Never mutates anything.
 */
async function apiSmokeTest(opts) {
  opts = opts || {};
  const t0 = Date.now();
  if (_deps.isOffline()) return { ok: false, class: FAIL.NETWORK_OFFLINE, latencyMs: 0 };
  const api = _deps.aapApi || _aapApi();
  if (!api || typeof api.getUserDetails !== 'function') {
    return { ok: false, class: FAIL.UNKNOWN_AUTH_FAILURE, error: 'aap_api.getUserDetails unavailable', latencyMs: Date.now() - t0 };
  }
  try {
    const res = await api.getUserDetails();
    // A truthy object back = authenticated. (getUserDetails returns the user.)
    const ok = !!res && typeof res === 'object';
    return { ok, status: 200, latencyMs: Date.now() - t0, class: ok ? null : FAIL.AAP_AUTH_REJECTED };
  } catch (e) {
    const cls = classifyFailure(e);
    return { ok: false, status: e && (e.status || e.statusCode), class: cls, error: String(e && e.message || e).slice(0, 200), latencyMs: Date.now() - t0 };
  }
}

/**
 * verifyHealthy(opts) -> { healthy, via[], api, probe, class?, latencyMs }
 * Real-target verification (spec #5/#6). HEALTHY requires the authenticated API
 * smoke test to pass. The browser probe is corroborating: if the API smoke
 * passes we trust it (and skip the heavier browser probe unless forceProbe);
 * if the API smoke is inconclusive (e.g. unavailable) we fall back to the probe.
 * Cookie files / mtimes / command completion are NEVER sufficient here.
 */
async function verifyHealthy(opts) {
  opts = opts || {};
  const t0 = Date.now();
  if (_deps.isOffline()) {
    return { healthy: false, offline: true, via: [], class: FAIL.NETWORK_OFFLINE, latencyMs: Date.now() - t0 };
  }
  const api = await apiSmokeTest(opts);
  const via = [];
  if (api.ok) {
    via.push('aap-api-smoke');
    if (!opts.forceProbe) {
      return { healthy: true, via, api, latencyMs: Date.now() - t0 };
    }
  }
  // Corroborate / fall back with the browser probe.
  let probe = null;
  const auth = _deps.auth || _auth();
  if (auth && typeof auth.probeSession === 'function') {
    try { probe = await auth.probeSession(); } catch (_) { probe = false; }
    if (probe) via.push('aap-probe');
  }
  const healthy = !!api.ok || !!probe;
  return {
    healthy,
    via,
    api,
    probe,
    class: healthy ? null : (api.class || FAIL.AAP_AUTH_REJECTED),
    latencyMs: Date.now() - t0,
  };
}

/**
 * buildSnapshot(opts) -> structured, SECRET-FREE health snapshot (spec #7).
 * Combines disk cookie diagnostics (checkMwinit — evidence only), offline state,
 * VPN state (connected + required:false — NEVER a gate), and the latest
 * verification result when provided. Persists NO cookie values/tokens.
 */
async function buildSnapshot(opts) {
  opts = opts || {};
  const auth = _deps.auth || _auth();
  const snap = {
    state: opts.state || STATE.UNKNOWN,
    at: new Date().toISOString(),
    internet: { online: !_deps.isOffline() },
    vpn: { connected: null, required: false },   // required is ALWAYS false (spec #1/#29)
    diskSession: { present: false, expiresInMin: null },
    diskAea: { present: false, expiresInMin: null },
    aapApiSmokeTest: opts.api || null,
    aapProbe: (opts.verify && 'probe' in opts.verify) ? { ok: opts.verify.probe } : null,
    lastRecovery: opts.lastRecovery || null,
    nextRetryAt: opts.nextRetryAt || null,
  };
  // Disk cookie diagnostics (evidence, not authority).
  try {
    if (auth && typeof auth.checkMwinit === 'function') {
      const chk = auth.checkMwinit();
      snap.diskSession = { present: !!chk.ok, expiresInMin: typeof chk.expiresInMin === 'number' ? chk.expiresInMin : null };
      snap.diskAea = {
        present: typeof chk.aeaExpiresInMin === 'number' && chk.aeaExpiresInMin > 0,
        expiresInMin: typeof chk.aeaExpiresInMin === 'number' ? chk.aeaExpiresInMin : null,
      };
    }
  } catch (_) { /* best-effort */ }
  // VPN: CONTEXT ONLY. Best-effort read; never gates anything. Injectable so
  // tests don't shell out to the real VPN checker (which spawns a process).
  try {
    const checkVpn = _deps.checkVpnState ||
      (() => { try { const vpn = require('../utils/vpn'); return vpn && vpn.checkVpnState; } catch (_) { return null; } })();
    if (typeof checkVpn === 'function') {
      const v = await checkVpn();
      snap.vpn = { connected: !!(v && v.connected), status: (v && v.status) || null, required: false };
    }
  } catch (_) { /* vpn module optional */ }
  return snap;
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE B — state machine + one global lock + ensureHealthy() (spec #3/#4/#6/#19)
// ══════════════════════════════════════════════════════════════════════════

let _state = STATE.UNKNOWN;
let _authRecoveryInFlight = null;   // THE single global recovery lock (spec #4)
let _lastSnapshot = null;
const _HISTORY_CAP = 30;
const _history = [];                // bounded recovery history (spec #25)

// ── auth.propagation state (flag-gated; all reset in _reset()) ───────────────
// Only written when _propOn() is true, so flag OFF behavior is unchanged.
let _cause = null;                  // { source } — why the latest transition/outcome happened
let _lastFailClass = null;          // last FAIL.* seen; null on every HEALTHY transition
let _lastApiOkAt = null;            // ms epoch of the last observed AAP 2xx
let _lastApiFailAt = null;          // ms epoch of the last observed AAP 401/403
let _verifiedAt = null;             // ms epoch of the last verification that reached HEALTHY
let _verifiedBy = null;             // 'verify:<cause>' | 'ladder:<rung>' | 'api:<source>' | 'monitor'
let _stepUpPasses = 0;              // consecutive class-B (step-up signature) passes
let _stepUpSignalAt = 0;            // ms epoch of the last explicit step-up signal (RCA fallback)
let _stepUpSignalTimer = null;      // lapse timer for the explicit signal
let _stepUpMwinitAt = null;         // ms epoch when ensureHealthyFullSignIn's runMwinit resolved (F9)
let _fullSignInActive = null;       // promise while ensureHealthyFullSignIn runs (F1)
let _seq = 0;
let _evidence = _emptyEvidence();
const _listeners = new Set();
let _emitQueue = [];
let _flushScheduled = false;
const _warnedListeners = new WeakSet();
let _statusWarned = false;
let _throttleLoggedFor = null;

const _STEP_UP_SIGNAL_MS = 30 * 60 * 1000;
const _STEP_UP_STATES = ['DEGRADED', 'RECOVERING', 'COOLDOWN'];

function _emptyEvidence() { return { sessionMin: null, diskAeaMin: null, liveAeaMin: null, aeaCountToMidway: null, online: null, at: null }; }

/** F4: flag read at call time (never at module load). */
function _propOn() {
  if (typeof _deps.propagation === 'boolean') return _deps.propagation;
  try { return require('./auth-report').isEnabled() === true; } catch (_) { return false; }
}
function _now() { return (typeof _deps.now === 'function') ? _deps.now() : Date.now(); }

function getState() { return _state; }
function getSnapshot() { return _lastSnapshot; }
function getHistory() { return _history.slice(); }

function _setState(next, reason) {
  if (next === _state) return;
  logger.info('[auth-supervisor] state ' + _state + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
  const from = _state;
  _state = next;
  if (_propOn()) {
    if (next === STATE.HEALTHY) { _clearStepUp(); _lastFailClass = null; }
    _emit({ type: 'state', from, to: next });
  }
}

/** Reset all step-up evidence (any HEALTHY transition, observed success, _reset). */
function _clearStepUp() {
  _stepUpPasses = 0;
  _stepUpSignalAt = 0;
  _stepUpMwinitAt = null;
  if (_stepUpSignalTimer != null) { try { _timers.clear(_stepUpSignalTimer); } catch (_) {} _stepUpSignalTimer = null; }
}

function _markVerified(by) { _verifiedAt = _now(); _verifiedBy = String(by || 'verify').slice(0, 80); }

function _isStepUp() {
  if (!_propOn()) return false;
  if (!_STEP_UP_STATES.includes(_state)) return false;
  if (_stepUpPasses >= 2) return true;
  return _stepUpSignalAt > 0 && (_now() - _stepUpSignalAt) < _STEP_UP_SIGNAL_MS;
}

/**
 * getStatus() -> normalized, secret-free AuthStatus (src/auth/auth-status.js).
 * Never throws: an internal error yields an UNKNOWN status.
 */
function getStatus() {
  try {
    return require('./auth-status').deriveStatus({
      state: _state,
      stepUp: _isStepUp(),
      stepUpMwinitAt: _stepUpMwinitAt,
      now: _now(),
      seq: _seq,
      failClass: _lastFailClass,
      verifiedAt: _verifiedAt,
      verifiedBy: _verifiedBy,
      lastApiOkAt: _lastApiOkAt,
      lastApiFailAt: _lastApiFailAt,
      nextRetryAt: _nextRetryAt,
      retryStreak: _failStreak,
      evidence: _evidence,
    });
  } catch (e) {
    if (!_statusWarned) { _statusWarned = true; logger.warn('[auth-supervisor] getStatus failed: ' + (e && e.message)); }
    return { v: 1, seq: _seq, at: new Date().toISOString(), state: 'UNKNOWN', level: 'unknown', ok: null, action: 'wait',
      stepUp: false, failClass: null, message: 'Auth status unavailable', verifiedAt: null, verifiedBy: null,
      lastApiOkAt: null, lastApiFailAt: null, nextRetryAt: null, retryStreak: 0, evidence: _emptyEvidence() };
  }
}

/** subscribe(fn) -> unsubscribe. Listeners get { type, from, to, cause, status }, always asynchronously. */
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/**
 * Queue an event and schedule ONE asynchronous flush (_timers.immediate). No
 * listener ever runs inside _setState / noteApiOutcome / aap_api._withLock.
 * Flag off: returns immediately (no queue, no setImmediate).
 */
function _emit(evt) {
  if (!_propOn()) return;
  _seq += 1;
  _emitQueue.push({ type: evt.type, from: evt.from || null, to: evt.to || _state, cause: _cause ? _cause.source : null, stepUp: _isStepUp() });
  if (_flushScheduled) return;
  _flushScheduled = true;
  try { _timers.immediate(_flush); } catch (_) { _flushScheduled = false; }
}

function _flush() {
  _flushScheduled = false;
  const q = _emitQueue; _emitQueue = [];
  if (!q.length || !_listeners.size) return;
  // Collapse consecutive events with identical (to, stepUp); a 'state' event wins over others.
  const out = [];
  for (const e of q) {
    const prev = out[out.length - 1];
    if (prev && prev.to === e.to && prev.stepUp === e.stepUp) {
      if (e.type === 'state' || prev.type !== 'state') out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  const status = getStatus();
  for (const e of out) {
    const payload = { type: e.type, from: e.from, to: e.to, cause: e.cause, status };
    for (const fn of Array.from(_listeners)) {
      try { fn(payload); }
      catch (err) {
        if (!_warnedListeners.has(fn)) { _warnedListeners.add(fn); logger.warn('[auth-supervisor] status listener threw: ' + (err && err.message)); }
      }
    }
  }
}

/**
 * noteApiOutcome({ ok, err?, source? }) — real AAP traffic (via auth-report.report).
 * Never throws, never awaits recovery (aap_api._request calls it under _withLock).
 */
function noteApiOutcome(o) {
  try {
    if (!_propOn()) return { handled: false };
    o = o || {};
    if (typeof o.ok !== 'boolean') return { handled: false, reason: 'bad-input' };
    if (_shuttingDown) return { handled: false, reason: 'shutting-down' };
    const src = String(o.source || 'unknown').slice(0, 40);
    const now = _now();
    if (o.ok === true) {
      if (_authRecoveryInFlight) { _lastApiOkAt = now; return { handled: false, reason: 'in-flight' }; }
      if (_deps.isOffline()) return { handled: false, reason: 'offline' };
      _lastApiOkAt = now;
      if (_state === STATE.HEALTHY) return { handled: true, transitioned: false };
      const from = _state;
      _failStreak = 0; _clearRetry();
      _clearStepUp();
      _cause = { source: 'api:' + src };
      _lastFailClass = null;
      _markVerified('api:' + src);
      _setState(STATE.HEALTHY, 'observed AAP API success');
      const base = _lastSnapshot || {
        internet: { online: true }, vpn: { connected: null, required: false },
        diskSession: { present: false, expiresInMin: null }, diskAea: { present: false, expiresInMin: null },
        aapProbe: null, lastRecovery: null,
      };
      _lastSnapshot = Object.assign({}, base, {
        state: _state, at: new Date(now).toISOString(),
        aapApiSmokeTest: { ok: true, status: 200, via: 'observed-traffic' }, nextRetryAt: null,
      });
      _recordHistory({ reason: 'api:' + src, initialState: from, attempts: [], result: STATE.HEALTHY, verifiedBy: ['observed-traffic'], ladderReported: false, durationMs: 0 });
      return { handled: true, transitioned: true };
    }
    const err = o.err || {};
    const isAuth = err.code === 'MIDWAY_SESSION_INVALID' || err.status === 401 || err.status === 403;
    if (!isAuth) return { handled: false, reason: 'not-auth' };   // 5xx / network / step-up code: ignored
    if (_deps.isOffline()) return { handled: false, reason: 'offline' };
    _lastApiFailAt = now;
    _lastFailClass = FAIL.AAP_API_UNAUTHORIZED;
    if ((_state === STATE.HEALTHY || _state === STATE.UNKNOWN) && !_authRecoveryInFlight) {
      _cause = { source: 'api:' + src };
      _setState(STATE.DEGRADED, 'api: session rejected');
      _scheduleRetry('api-outcome');                     // timer only; never a synchronous ladder
      return { handled: true, transitioned: true };
    }
    _emit({ type: 'outcome' });
    return { handled: true, transitioned: false };
  } catch (e) {
    logger.warn('[auth-supervisor] noteApiOutcome error: ' + (e && e.message));
    return { handled: false, reason: 'error' };
  }
}

/**
 * noteStepUpSignal({ source }) — explicit server-worded step-up evidence (RCA
 * cookie-file fallback only). Never changes _state. F5: emits 'stepup' now when
 * not HEALTHY, and again when the 30-min lapse timer fires.
 */
function noteStepUpSignal(o) {
  try {
    if (!_propOn()) return { handled: false };
    if (_shuttingDown) return { handled: false, reason: 'shutting-down' };
    _stepUpSignalAt = _now();
    if (_stepUpSignalTimer != null) { try { _timers.clear(_stepUpSignalTimer); } catch (_) {} _stepUpSignalTimer = null; }
    _stepUpSignalTimer = _timers.set(() => {
      _stepUpSignalTimer = null;
      _stepUpSignalAt = 0;
      _emit({ type: 'stepup' });
    }, _STEP_UP_SIGNAL_MS);
    if (_stepUpSignalTimer && _stepUpSignalTimer.unref) _stepUpSignalTimer.unref();
    if (_state !== STATE.HEALTHY) _emit({ type: 'stepup' });
    return { handled: true, source: String((o && o.source) || 'unknown').slice(0, 40) };
  } catch (e) {
    logger.warn('[auth-supervisor] noteStepUpSignal error: ' + (e && e.message));
    return { handled: false, reason: 'error' };
  }
}

/** noteEvidence({ sessionMin, diskAeaMin, liveAeaMin, aeaCountToMidway, online }) — numbers only. */
function noteEvidence(o) {
  try {
    if (!_propOn()) return { handled: false };
    o = o || {};
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= -1e6 && v <= 1e6) ? v : null;
    const next = Object.assign({}, _evidence);
    for (const k of ['sessionMin', 'diskAeaMin', 'liveAeaMin', 'aeaCountToMidway']) if (k in o) next[k] = n(o[k]);
    if ('online' in o) next.online = typeof o.online === 'boolean' ? o.online : null;
    next.at = _now();
    _evidence = next;
    _emit({ type: 'evidence' });
    return { handled: true };
  } catch (e) {
    return { handled: false, reason: 'error' };
  }
}

function _recordHistory(entry) {
  _history.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (_history.length > _HISTORY_CAP) _history.length = _HISTORY_CAP;
}

/**
 * ensureHealthy({ reason, allowPrompt=true, forceVerify=false }) ->
 *   { ok, state, recovered, rung, prompted, verified, latencyMs, class?, reason?, via? }
 *
 * THE caller contract (spec #18/#19). Every Midway-dependent subsystem calls
 * this instead of inventing its own recovery. Behavior:
 *   1. If a recovery is already running, AWAIT it (single global lock, spec #4).
 *   2. RUNG 0 — verify the REAL target first (API smoke + probe). If healthy,
 *      return HEALTHY immediately — regardless of VPN (spec #1/#8 Rung 0).
 *   3. Otherwise run the recovery ladder (delegated to auth.recoverAuth, the
 *      proven rungs) and then RE-VERIFY against the real target. Only a passing
 *      verification yields recovered:true / HEALTHY (spec #6 — no false success).
 *
 * This NEVER returns HEALTHY on cookie/command completion alone.
 */
async function ensureHealthy(opts) {
  opts = opts || {};
  // Single global lock: concurrent callers share ONE workflow (spec #4).
  if (_authRecoveryInFlight) {
    return _authRecoveryInFlight.then((r) => Object.assign({}, r, { coalesced: true }));
  }
  _authRecoveryInFlight = _runEnsureHealthy(opts);
  try { return await _authRecoveryInFlight; }
  finally { _authRecoveryInFlight = null; }
}

async function _runEnsureHealthy(opts) {
  const propOn = _propOn();
  if (propOn) _cause = { source: String(opts.reason || 'unspecified').slice(0, 60) };
  const r = await _runEnsureHealthyPass(opts, propOn);
  if (propOn) r.stepUp = _isStepUp();
  return r;
}

async function _runEnsureHealthyPass(opts, propOn) {
  const t0 = Date.now();
  const reason = opts.reason || 'unspecified';
  const allowPrompt = opts.allowPrompt !== false;

  // Offline is NOT a rejected session (spec #1 Rung 1): defer, never prompt.
  if (_deps.isOffline()) {
    _setState(STATE.OFFLINE, 'no internet');
    _lastSnapshot = await buildSnapshot({ state: _state });
    return _result(false, { state: _state, recovered: false, rung: 'offline', prompted: false, verified: false, latencyMs: Date.now() - t0, reason: 'offline' });
  }

  // RUNG 0 — verify the real target FIRST (spec #8). Healthy = done, regardless
  // of VPN. forceVerify forces a fresh check even if we think we're healthy.
  const v0 = await verifyHealthy({ forceProbe: !!opts.forceVerify });
  if (v0.healthy) {
    if (propOn) _markVerified('verify:' + (_cause ? _cause.source : reason));
    _setState(STATE.HEALTHY, 'verified at rung 0');
    _lastSnapshot = await buildSnapshot({ state: _state, api: v0.api, verify: v0 });
    return _result(true, { state: _state, recovered: false, rung: 'verify', prompted: false, verified: true, via: v0.via, latencyMs: Date.now() - t0 });
  }

  // Not healthy -> DEGRADED, then run the proven recovery ladder.
  _setState(STATE.DEGRADED, 'verify failed: ' + (v0.class || 'unknown'));
  const failClass = v0.class || FAIL.AAP_AUTH_REJECTED;
  if (propOn) _lastFailClass = failClass;

  // An AAP SERVER error (500) is NOT an auth problem — do not run the ladder
  // or prompt (spec #17). Surface as degraded-but-not-auth and let the caller
  // retry later.
  if (failClass === FAIL.AAP_SERVER_ERROR) {
    _lastSnapshot = await buildSnapshot({ state: _state, api: v0.api, verify: v0 });
    _recordHistory({ reason, initialState: STATE.DEGRADED, attempts: [], result: STATE.DEGRADED, failClass, note: 'AAP 5xx — server error, not auth' });
    return _result(false, { state: _state, recovered: false, rung: 'none', prompted: false, verified: false, class: failClass, reason: 'AAP server error (not auth)', latencyMs: Date.now() - t0 });
  }

  _setState(STATE.RECOVERING, 'running ladder');
  const auth = _deps.auth || _auth();
  let ladder = { recovered: false, rung: 'unavailable', prompted: false };
  if (auth && typeof auth.recoverAuth === 'function') {
    try { ladder = await auth.recoverAuth(reason, { allowPrompt }); }
    catch (e) { ladder = { recovered: false, rung: 'error', prompted: false, error: e.message }; }
  }

  // #6 FIX — NEVER trust the ladder's self-reported recovered flag. RE-VERIFY
  // against the real AAP target. Only a passing verification = HEALTHY.
  const v1 = await verifyHealthy({ forceProbe: true });
  const verified = !!v1.healthy;

  _recordHistory({
    reason, initialState: STATE.DEGRADED,
    attempts: [ladder.rung].filter(Boolean),
    result: verified ? STATE.HEALTHY : STATE.COOLDOWN,
    verifiedBy: verified ? v1.via : [],
    ladderReported: !!ladder.recovered,
    durationMs: Date.now() - t0,
  });

  if (verified) {
    if (propOn) _markVerified('ladder:' + ladder.rung);
    _setState(STATE.HEALTHY, 'verified after ladder rung=' + ladder.rung);
    _lastSnapshot = await buildSnapshot({ state: _state, api: v1.api, verify: v1 });
    return _result(true, { state: _state, recovered: true, rung: ladder.rung, prompted: !!ladder.prompted, verified: true, via: v1.via, latencyMs: Date.now() - t0 });
  }

  // Ladder ran (maybe even reported recovered) but AAP still rejects → NOT
  // healthy. The ONLY thing that justifies WAITING_FOR_USER is a POSITIVE
  // determination that interactive user auth is genuinely required — i.e. the
  // supervisor established that the real Midway SESSION is expired/missing, or
  // mwinit itself reported no valid session. A background pass that merely was
  // not allowed to prompt (allowPrompt=false) must NEVER become
  // WAITING_FOR_USER: that falsely trips the retry gate and strands auth
  // forever (the stuck-recovery bug). Use the structured signals recoverAuth
  // now surfaces; do NOT infer "user required" from allowPrompt alone.
  // Only POSITIVE signals that interactive user auth is genuinely required.
  // Notably NOT "mwinit already ran but AAP still rejects": the user already
  // acted, so that must COOLDOWN + retry, not strand in WAITING_FOR_USER. And
  // NOT "allowPrompt was false": that is the stuck-recovery bug.
  const actuallyNeedsUser =
    ladder.requiresInteractiveAuth === true ||
    ladder.sessionInvalid === true ||
    failClass === FAIL.MIDWAY_SESSION_EXPIRED;

  // auth.propagation step-up counter (flag on only, so flag off makes no extra
  // call and no extra await). A pass counts only for the class-B signature:
  // valid disk session, silent rungs ran, live AEA with time left, AAP walled.
  if (propOn) {
    let liveAea = null;
    if (auth && typeof auth.aeaSessionExpiryMin === 'function') {
      try { liveAea = await auth.aeaSessionExpiryMin(); } catch (_) { liveAea = null; }
    }
    const countable = !actuallyNeedsUser && ladder.sessionInvalid !== true &&
      !['error', 'unavailable', 'offline'].includes(ladder.rung) &&
      [FAIL.AAP_API_UNAUTHORIZED, FAIL.SSO_LOGIN_WALL, FAIL.AAP_AUTH_REJECTED].includes(failClass) &&
      typeof liveAea === 'number' && Number.isFinite(liveAea) && liveAea > 0;
    _stepUpPasses = countable ? _stepUpPasses + 1 : 0;
    _lastFailClass = v1.class || failClass;
    if (typeof liveAea === 'number' && Number.isFinite(liveAea)) _evidence = Object.assign({}, _evidence, { liveAeaMin: liveAea, at: _now() });
  }

  const nextState = actuallyNeedsUser ? STATE.WAITING_FOR_USER : STATE.COOLDOWN;
  _setState(nextState, actuallyNeedsUser ? 'interactive mwinit genuinely required' : 'still rejected after silent ladder (will retry)');
  _lastSnapshot = await buildSnapshot({ state: _state, api: v1.api, verify: v1 });
  logger.info('[auth-supervisor] ensureHealthy result' +
    ' state=' + _state +
    ' reason=' + (v1.class || failClass) +
    ' allowPrompt=' + allowPrompt +
    ' rung=' + ladder.rung +
    ' verified=' + verified +
    ' requiresUser=' + actuallyNeedsUser +
    ' retryStreak=' + _failStreak);
  return _result(false, {
    state: _state, recovered: false, rung: ladder.rung, prompted: !!ladder.prompted,
    verified: false, class: v1.class || failClass,
    requiresUser: actuallyNeedsUser,
    reason: ladder.error || (v1.class ? ('AAP still ' + v1.class) : 'AAP still rejected after recovery'),
    latencyMs: Date.now() - t0,
  });
}

function _result(ok, fields) { return Object.assign({ ok: !!ok }, fields); }

// ══════════════════════════════════════════════════════════════════════════
// PHASE C — persistent convergence (spec #9/#10/#23). A failed recovery must
// NOT leave auth stuck until some external event. Schedule a bounded-backoff
// auto-retry that re-enters ensureHealthy until verified HEALTHY. Reset on
// success. Never retry while offline, waiting on the user, or shutting down.
// ══════════════════════════════════════════════════════════════════════════

// Backoff schedule (ms): 30s, 1m, 2m, 5m, then capped ~10–15m. Jittered.
const _BACKOFF_MS = [30000, 60000, 120000, 300000, 600000, 900000];
let _retryTimer = null;
let _failStreak = 0;
let _nextRetryAt = null;
let _shuttingDown = false;

// Injectable timer seam (spec #26).
const _timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h),
  immediate: (fn) => setImmediate(fn),   // auth.propagation event delivery (flag on only)
};
function _setTimers(t) {
  if (t && t.set) _timers.set = t.set;
  if (t && t.clear) _timers.clear = t.clear;
  if (t && t.immediate) _timers.immediate = t.immediate;
}

function _jitter(ms) { return Math.round(ms * (0.85 + Math.random() * 0.3)); } // ±15%

function _backoffFor(streak) {
  const idx = Math.min(Math.max(streak - 1, 0), _BACKOFF_MS.length - 1);
  return _jitter(_BACKOFF_MS[idx]);
}

function _clearRetry() {
  if (_retryTimer != null) { try { _timers.clear(_retryTimer); } catch (_) {} _retryTimer = null; }
  _nextRetryAt = null;
}

/**
 * Schedule the NEXT bounded auto-retry after a failed pass. No-op when shutting
 * down, when a prompt is pending (WAITING_FOR_USER — the user is the gate), or
 * when offline (the reconnect watcher re-arms on online). Single timer only.
 */
function _scheduleRetry(reason) {
  if (_shuttingDown) return;
  if (_fullSignInActive) return;                   // F1: the full sign-in re-arms once when it finishes (flag on only)
  if (_state === STATE.WAITING_FOR_USER) return;   // don't hammer while user acts
  if (_state === STATE.HEALTHY) { _failStreak = 0; _clearRetry(); return; }
  if (_deps.isOffline()) { _clearRetry(); return; } // reconnect watcher handles online-return
  if (_retryTimer != null) return;                 // one pending retry at a time

  _failStreak += 1;
  const delay = _backoffFor(_failStreak);
  _nextRetryAt = new Date(Date.now() + delay).toISOString();
  logger.info('[auth-supervisor] retry armed' +
    ' state=' + _state +
    ' reason=' + (reason || 'converge') +
    ' retryStreak=' + _failStreak +
    ' nextRetry=' + Math.round(delay / 1000) + 's' +
    ' requiresUser=false');
  _retryTimer = _timers.set(async () => {
    _retryTimer = null; _nextRetryAt = null;
    if (_shuttingDown || _deps.isOffline()) { _scheduleRetry('deferred'); return; }
    try {
      const r = await ensureHealthy({ reason: 'auto-retry#' + _failStreak, allowPrompt: false });
      if (r.ok && r.verified) { _failStreak = 0; _clearRetry(); logger.info('[auth-supervisor] auto-retry converged to HEALTHY'); }
      else { _scheduleRetry('still-unhealthy'); }
    } catch (e) { logger.warn('[auth-supervisor] auto-retry error: ' + e.message); _scheduleRetry('retry-error'); }
  }, delay);
  if (_retryTimer && _retryTimer.unref) _retryTimer.unref();
}

/**
 * ensureHealthyConverging(opts) — like ensureHealthy, but on failure it ARMS
 * the bounded auto-retry so auth converges back to HEALTHY on its own (spec #9).
 * This is what long-lived callers / the background monitor use.
 */
async function ensureHealthyConverging(opts) {
  // auth.propagation throttle (D6, flag on only): the 5-minute API refresh
  // (data-source-*) does not start a new pass while COOLDOWN backoff is armed.
  // ui:*, aea-captured, reconnect, heartbeat:*, startup, post-reauth, monitor:*
  // are never throttled; auto-retry calls ensureHealthy directly.
  const reasonStr = (opts && opts.reason) || '';
  if (/^data-source-/.test(reasonStr) && _state === STATE.COOLDOWN &&
      _nextRetryAt && Date.parse(_nextRetryAt) > Date.now() && _propOn()) {
    if (_throttleLoggedFor !== _nextRetryAt) {
      _throttleLoggedFor = _nextRetryAt;
      logger.info('[auth-supervisor] ' + reasonStr + ' deferred: auth recovery backoff in effect until ' + _nextRetryAt);
    }
    return {
      ok: false, state: _state, recovered: false, rung: 'deferred', prompted: false, verified: false,
      deferred: true, requiresUser: false, class: _lastFailClass, stepUp: _isStepUp(),
      nextRetryAt: _nextRetryAt, reason: 'auth recovery backoff in effect', latencyMs: 0,
    };
  }
  const r = await ensureHealthy(opts || {});
  if (r.ok && r.verified) {
    _failStreak = 0; _clearRetry();
  } else if (_isTerminalForRetry()) {
    // OFFLINE (reconnect watcher owns online-return), WAITING_FOR_USER (real
    // user action required), or shutting down — do NOT auto-retry.
    _clearRetry();
  } else {
    // Any non-terminal unhealthy state (DEGRADED / RECOVERING / COOLDOWN) MUST
    // keep converging with bounded backoff until verified HEALTHY.
    _scheduleRetry(r.reason || r.class);
  }
  return Object.assign({}, r, { nextRetryAt: _nextRetryAt });
}

/**
 * A state in which the supervisor legitimately stops auto-retrying:
 *   - OFFLINE           — the reconnect watcher re-arms on online-return
 *   - WAITING_FOR_USER  — genuine interactive user action is required
 *   - shutting down
 * Everything else (DEGRADED / RECOVERING / COOLDOWN / UNKNOWN) must converge.
 */
function _isTerminalForRetry() {
  return _shuttingDown || _state === STATE.OFFLINE || _state === STATE.WAITING_FOR_USER;
}

/**
 * ensureHealthyFullSignIn(opts) — F1: the "Run mwinit" action while step-up is
 * active. Flag off: exactly the legacy ensureHealthyConverging({ reason:
 * 'ui:run-mwinit', allowPrompt:true }). Flag on, under the supervisor lock:
 *   1. wait for any in-flight pass, clear the retry timer;
 *   2. take _authRecoveryInFlight with a pass that runs the interactive
 *      auth.runMwinit() (never recoverAuth / refreshAeaViaMwinit), then
 *      injectCookies(), then verifyHealthy({ forceProbe:true });
 *   3. HEALTHY (verifiedBy 'ladder:mwinit') or COOLDOWN; on failure re-arm
 *      exactly one retry timer.
 * Callers that arrive meanwhile coalesce onto the lock. The returned result
 * comes from this call's own verify and is never coalesced:true.
 */
async function ensureHealthyFullSignIn(opts) {
  if (!_propOn()) return ensureHealthyConverging({ reason: 'ui:run-mwinit', allowPrompt: true });
  if (_fullSignInActive) return Object.assign({}, await _fullSignInActive);
  let release;
  _fullSignInActive = new Promise((res) => { release = res; });
  let r;
  try {
    while (_authRecoveryInFlight) { try { await _authRecoveryInFlight; } catch (_) {} }
    _clearRetry();
    const pass = _runFullSignIn(opts || {});
    _authRecoveryInFlight = pass;
    try { r = await pass; }
    finally { if (_authRecoveryInFlight === pass) _authRecoveryInFlight = null; }
  } catch (e) {
    logger.warn('[auth-supervisor] full sign-in error: ' + (e && e.message));
    r = _result(false, { state: _state, recovered: false, rung: 'mwinit', prompted: true, verified: false, reason: 'full-sign-in-error', latencyMs: 0 });
  } finally {
    _fullSignInActive = null;
  }
  if (_state === STATE.HEALTHY) { _failStreak = 0; _clearRetry(); }
  else _scheduleRetry('post-stepup-mwinit');
  const out = Object.assign({}, r, { stepUp: _isStepUp(), nextRetryAt: _nextRetryAt });
  delete out.coalesced;
  release(out);
  return out;
}

async function _runFullSignIn() {
  const t0 = Date.now();
  const initialState = _state;
  _cause = { source: 'ui:run-mwinit-stepup' };
  const auth = _deps.auth || _auth();
  if (!auth || typeof auth.runMwinit !== 'function') {
    return _result(false, { state: _state, recovered: false, rung: 'mwinit', prompted: false, verified: false, reason: 'mwinit-unavailable', latencyMs: Date.now() - t0 });
  }
  logger.info('[auth-supervisor] step-up: running interactive mwinit (full sign-in)');
  let mw;
  try { mw = await auth.runMwinit(); }
  catch (e) {
    logger.warn('[auth-supervisor] interactive mwinit failed: ' + (e && e.message));
    return _result(false, { state: _state, recovered: false, rung: 'mwinit', prompted: true, verified: false, reason: 'mwinit-failed', latencyMs: Date.now() - t0 });
  }
  if (mw && mw.skipped === 'offline') {
    return _result(false, { state: _state, recovered: false, rung: 'mwinit', prompted: false, verified: false, reason: 'offline', latencyMs: Date.now() - t0 });
  }
  _stepUpMwinitAt = _now();                       // F9: the full sign-in completed
  try { if (typeof auth.injectCookies === 'function') await auth.injectCookies(); } catch (_) {}
  const v = await verifyHealthy({ forceProbe: true });
  const verified = !!v.healthy;
  _recordHistory({
    reason: 'ui:run-mwinit-stepup', initialState,
    attempts: ['mwinit'],
    result: verified ? STATE.HEALTHY : STATE.COOLDOWN,
    verifiedBy: verified ? v.via : [],
    ladderReported: true,
    durationMs: Date.now() - t0,
  });
  if (verified) {
    _markVerified('ladder:mwinit');
    _setState(STATE.HEALTHY, 'verified after step-up mwinit');
    _clearStepUp(); _lastFailClass = null;        // also when already HEALTHY (no transition)
    _lastSnapshot = await buildSnapshot({ state: _state, api: v.api, verify: v });
    return _result(true, { state: _state, recovered: true, rung: 'mwinit', prompted: true, verified: true, via: v.via, latencyMs: Date.now() - t0 });
  }
  _lastFailClass = v.class || FAIL.AAP_AUTH_REJECTED;
  _setState(STATE.COOLDOWN, 'still rejected after step-up mwinit (will retry)');
  _lastSnapshot = await buildSnapshot({ state: _state, api: v.api, verify: v });
  return _result(false, {
    state: _state, recovered: false, rung: 'mwinit', prompted: true, verified: false,
    class: _lastFailClass, reason: 'AAP still ' + _lastFailClass, latencyMs: Date.now() - t0,
  });
}

/**
 * ensureRecoveryArmed() — WATCHDOG / defense-in-depth (spec #12/#20). Detects the
 * illegal "stuck" condition — unhealthy + online + not shutting down + no real
 * user gate + no recovery in flight + no retry timer — and arms a convergence
 * retry so a future missed-scheduling bug can never strand auth silently.
 * Idempotent: it will NOT create a duplicate timer (relies on _scheduleRetry's
 * single-timer guard). Safe to call from the monitor tick and on reconnect.
 */
function ensureRecoveryArmed() {
  if (_shuttingDown) return false;
  if (_state === STATE.HEALTHY || _state === STATE.OFFLINE || _state === STATE.WAITING_FOR_USER) return false;
  if (_deps.isOffline()) return false;         // offline: reconnect watcher owns it
  if (_authRecoveryInFlight) return false;     // a recovery is already running
  if (_retryTimer != null) return false;       // a retry is already armed
  logger.warn('[auth-supervisor] WATCHDOG: unhealthy (' + _state + ') while online with no retry armed and no recovery in flight — arming convergence');
  _scheduleRetry('watchdog');
  return true;
}

/**
 * onReconnect() — call when the network transitions offline→online (spec #10).
 * Does NOT assume auth is stale and does NOT prompt: it verifies the real
 * target after a brief settle and only recovers if needed.
 */
async function onReconnect() {
  if (_shuttingDown) return { ok: false, reason: 'shutting-down' };
  logger.info('[auth-supervisor] reconnect — verifying real target (no prompt, no VPN assumption)');
  _failStreak = 0; _clearRetry();
  return ensureHealthyConverging({ reason: 'reconnect', allowPrompt: false });
}

// ── Background health monitor (spec #20) ─────────────────────────────────────
// A single periodic verifier owned by the supervisor (keeps the single-
// supervisor invariant). It:
//   - subscribes to offline→online transitions and routes them through
//     onReconnect() (no prompt, verifies the real target);
//   - on an interval, verifies health against the REAL AAP target and, if the
//     session is genuinely degraded while online, arms bounded auto-recovery
//     via ensureHealthyConverging (no prompt — interactive mwinit stays a
//     user-driven action).
// Idempotent: a second call tears down the prior monitor first. No-op if a
// retry/recovery is already in flight for a given tick.
let _monitorTimer = null;
let _monitorUnsub = null;
let _monitorInFlight = false;
const _MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 min; retries use their own backoff

function startHealthMonitor(opts) {
  opts = opts || {};
  const intervalMs = typeof opts.intervalMs === 'number' ? opts.intervalMs : _MONITOR_INTERVAL_MS;
  stopHealthMonitor();
  _shuttingDown = false;

  // Offline→online: re-verify the SAME session (no prompt, no VPN assumption).
  try {
    const offline = require('../orcha/offline');
    if (offline && typeof offline.onChange === 'function') {
      _monitorUnsub = offline.onChange((status) => {
        if (status !== 'online') return;
        setTimeout(() => { onReconnect().catch(() => {}); }, 2500);
      });
    }
  } catch (_) { /* offline module optional */ }

  const tick = async () => {
    if (_shuttingDown || _monitorInFlight) return;
    if (_deps.isOffline()) return;              // offline: wait for reconnect
    // WATCHDOG first (spec #12): even if a prior pass somehow left us unhealthy
    // with no armed retry, re-arm convergence. Cheap and idempotent.
    try { ensureRecoveryArmed(); } catch (_) {}
    if (_authRecoveryInFlight) return;          // a recovery is already running
    _monitorInFlight = true;
    try {
      const v = await verifyHealthy({});
      if (v && v.healthy) {
        if (_state !== STATE.HEALTHY) {
          if (_propOn()) { _cause = { source: 'monitor' }; _markVerified('monitor'); }
          _setState(STATE.HEALTHY, 'monitor: verified'); _failStreak = 0; _clearRetry();
        }
        _lastSnapshot = await buildSnapshot({ state: _state, api: v.api, verify: v });
        return;
      }
      // Genuinely degraded while online. AAP 5xx is a server problem, not auth —
      // ensureHealthyConverging already short-circuits that case without a ladder.
      await ensureHealthyConverging({ reason: 'monitor:degraded', allowPrompt: false });
    } catch (e) {
      logger.warn('[auth-supervisor] monitor tick error: ' + (e && e.message || e));
    } finally {
      _monitorInFlight = false;
    }
  };

  _monitorTimer = setInterval(tick, intervalMs);
  if (_monitorTimer && _monitorTimer.unref) _monitorTimer.unref();
  logger.info('[auth-supervisor] background health monitor started (interval ' + Math.round(intervalMs / 1000) + 's)');
  // Kick an initial verify shortly after start (deferred so startup isn't blocked).
  setTimeout(() => { tick().catch(() => {}); }, 3000);
  return () => stopHealthMonitor();
}

function stopHealthMonitor() {
  if (_monitorTimer) { try { clearInterval(_monitorTimer); } catch (_) {} _monitorTimer = null; }
  if (_monitorUnsub) { try { _monitorUnsub(); } catch (_) {} _monitorUnsub = null; }
}

/** shutdown() — cancel pending retries cleanly (spec #27). */
function shutdown() {
  _shuttingDown = true; _clearRetry(); stopHealthMonitor();
  if (_stepUpSignalTimer != null) { try { _timers.clear(_stepUpSignalTimer); } catch (_) {} _stepUpSignalTimer = null; }
  _emitQueue = [];
}
function _resetConvergence() { _shuttingDown = false; _failStreak = 0; _clearRetry(); _timers.set = (fn, ms) => setTimeout(fn, ms); _timers.clear = (h) => clearTimeout(h); _timers.immediate = (fn) => setImmediate(fn); }

/** Clear every auth.propagation variable (listeners included). Uses the current timers. */
function _resetPropagation() {
  if (_stepUpSignalTimer != null) { try { _timers.clear(_stepUpSignalTimer); } catch (_) {} _stepUpSignalTimer = null; }
  _cause = null; _lastFailClass = null; _lastApiOkAt = null; _lastApiFailAt = null;
  _verifiedAt = null; _verifiedBy = null;
  _stepUpPasses = 0; _stepUpSignalAt = 0; _stepUpMwinitAt = null; _fullSignInActive = null;
  _seq = 0; _evidence = _emptyEvidence();
  _listeners.clear(); _emitQueue = []; _flushScheduled = false;
  _statusWarned = false; _throttleLoggedFor = null;
}

// ── Injectable deps (spec #26) so the ladder/verification are deterministically
// testable without a live box. Defaults point at the live implementations. ─────
const _deps = {
  isOffline: () => _isOfflineNow(),
  aapApi: null,   // null -> lazy require('../scrapers/aap_api')
  auth: null,     // null -> lazy require('../scrapers/auth')
  checkVpnState: null, // null -> lazy require('../utils/vpn').checkVpnState (context only)
  propagation: null,   // null -> auth-report.isEnabled() at call time (F4); boolean overrides (tests)
  now: null,           // null -> Date.now (auth.propagation clock; tests inject)
};
function _setDeps(d) { if (d && typeof d === 'object') Object.assign(_deps, d); }
function _reset() {
  _deps.isOffline = () => _isOfflineNow(); _deps.aapApi = null; _deps.auth = null; _deps.checkVpnState = null;
  _deps.propagation = null; _deps.now = null;
  _state = STATE.UNKNOWN; _authRecoveryInFlight = null; _lastSnapshot = null; _history.length = 0;
  _resetPropagation();
  _resetConvergence();
}

module.exports = {
  STATE, FAIL,
  classifyFailure,
  apiSmokeTest,
  verifyHealthy,
  buildSnapshot,
  ensureHealthy,
  ensureHealthyConverging,
  ensureRecoveryArmed,
  onReconnect,
  startHealthMonitor, stopHealthMonitor,
  shutdown,
  getState, getSnapshot, getHistory,
  // auth.propagation (flag-gated; inert when the flag is off)
  getStatus, subscribe,
  noteApiOutcome, noteStepUpSignal, noteEvidence,
  ensureHealthyFullSignIn,
  _setDeps, _setTimers, _reset,
  _scheduleRetry, _backoffFor,  // exported for convergence tests
};
