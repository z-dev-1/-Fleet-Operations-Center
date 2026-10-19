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

// ── Injectable deps (spec #26) so the ladder/verification are deterministically
// testable without a live box. Defaults point at the live implementations. ─────
const _deps = {
  isOffline: () => _isOfflineNow(),
  aapApi: null,   // null -> lazy require('../scrapers/aap_api')
  auth: null,     // null -> lazy require('../scrapers/auth')
};
function _setDeps(d) { if (d && typeof d === 'object') Object.assign(_deps, d); }
function _reset() { _deps.isOffline = () => _isOfflineNow(); _deps.aapApi = null; _deps.auth = null; }

module.exports = {
  STATE, FAIL,
  classifyFailure,
  apiSmokeTest,
  verifyHealthy,
  buildSnapshot,
  _setDeps, _reset,
};
