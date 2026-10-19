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
  // VPN: CONTEXT ONLY. Best-effort read; never gates anything.
  try {
    const vpn = require('../utils/vpn');
    if (vpn && typeof vpn.checkVpnState === 'function') {
      const v = await vpn.checkVpnState();
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

function getState() { return _state; }
function getSnapshot() { return _lastSnapshot; }
function getHistory() { return _history.slice(); }

function _setState(next, reason) {
  if (next === _state) return;
  logger.info('[auth-supervisor] state ' + _state + ' -> ' + next + (reason ? ' (' + reason + ')' : ''));
  _state = next;
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
    _setState(STATE.HEALTHY, 'verified at rung 0');
    _lastSnapshot = await buildSnapshot({ state: _state, api: v0.api, verify: v0 });
    return _result(true, { state: _state, recovered: false, rung: 'verify', prompted: false, verified: true, via: v0.via, latencyMs: Date.now() - t0 });
  }

  // Not healthy -> DEGRADED, then run the proven recovery ladder.
  _setState(STATE.DEGRADED, 'verify failed: ' + (v0.class || 'unknown'));
  const failClass = v0.class || FAIL.AAP_AUTH_REJECTED;

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
    _setState(STATE.HEALTHY, 'verified after ladder rung=' + ladder.rung);
    _lastSnapshot = await buildSnapshot({ state: _state, api: v1.api, verify: v1 });
    return _result(true, { state: _state, recovered: true, rung: ladder.rung, prompted: !!ladder.prompted, verified: true, via: v1.via, latencyMs: Date.now() - t0 });
  }

  // Ladder ran (maybe even reported recovered) but AAP still rejects → NOT
  // healthy. If it needs a prompt we weren't allowed to give, say so; else
  // this is where Phase C's bounded COOLDOWN auto-retry takes over.
  const needsPrompt = ladder.rung === 'needs-prompt' || (!allowPrompt && !verified);
  _setState(needsPrompt && !allowPrompt ? STATE.WAITING_FOR_USER : STATE.COOLDOWN,
    verified ? 'verified' : 'still rejected after ladder');
  _lastSnapshot = await buildSnapshot({ state: _state, api: v1.api, verify: v1 });
  return _result(false, {
    state: _state, recovered: false, rung: ladder.rung, prompted: !!ladder.prompted,
    verified: false, class: v1.class || failClass,
    reason: ladder.error || (v1.class ? ('AAP still ' + v1.class) : 'AAP still rejected after recovery'),
    latencyMs: Date.now() - t0,
  });
}

function _result(ok, fields) { return Object.assign({ ok: !!ok }, fields); }

// ── Injectable deps (spec #26) so the ladder/verification are deterministically
// testable without a live box. Defaults point at the live implementations. ─────
const _deps = {
  isOffline: () => _isOfflineNow(),
  aapApi: null,   // null -> lazy require('../scrapers/aap_api')
  auth: null,     // null -> lazy require('../scrapers/auth')
};
function _setDeps(d) { if (d && typeof d === 'object') Object.assign(_deps, d); }
function _reset() {
  _deps.isOffline = () => _isOfflineNow(); _deps.aapApi = null; _deps.auth = null;
  _state = STATE.UNKNOWN; _authRecoveryInFlight = null; _lastSnapshot = null; _history.length = 0;
}

module.exports = {
  STATE, FAIL,
  classifyFailure,
  apiSmokeTest,
  verifyHealthy,
  buildSnapshot,
  ensureHealthy,
  getState, getSnapshot, getHistory,
  _setDeps, _reset,
};
