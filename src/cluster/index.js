'use strict';
/**
 * cluster/index.js — dual-instance coordination facade (Stage 1 skeleton).
 *
 * The single entry point the rest of the app talks to for anything about
 * "which instance am I, am I the leader, may I perform this side-effect". Later
 * stages add the heartbeat loop, lease acquisition/renewal, event-log sync, and
 * failover; Stage 1 establishes the facade + identity + the mode gate wiring,
 * all behind a feature flag that defaults OFF so the live app is unchanged.
 *
 * DESIGN INVARIANTS (enforced from here on):
 *   - A production side-effect is permitted ONLY when assertCanSideEffect()
 *     passes — which requires the right mode AND (for browser-bound work) local
 *     capability. Backend-enforced; UI cannot bypass.
 *   - Leadership is a fencing-token lease (see coord-store). Takeover requires
 *     lease expiry AND a successful atomic CAS — never a missed heartbeat alone.
 *   - If leadership can't be established, production WRITES fail closed.
 *
 * CAPABILITY FACTS (verified 2026-10 against the Amazon DevSpace standby host):
 *   - browser:false on a headless host ($DISPLAY empty) → lifecycle DOM flips,
 *     SharePoint push, OWA send fail closed there.
 *   - aapLivePull:false on the DevSpace → AAP needs AEA browser step-up the
 *     headless box can't satisfy (307 → midway-auth AEA gateway). The standby
 *     relies on SYNCED fleet snapshots, not live pull.
 *   - smtp:true is possible (ballard.amazon.com:1587 via nodemailer) — pending
 *     port-reachability confirmation; a later stage adds the adapter.
 *   These are advertised flags; the coordination/lease/sync code is identical
 *   on every host regardless.
 *
 * FLAG: enable via settings.cluster.enabled OR env FLEET_CLUSTER=1. Default OFF.
 */

const os = require('os');
const crypto = require('crypto');
const gate = require('./mode-gate');
const { LocalCoordStore } = require('./coord-store');
const { LeaseManager } = require('./lease-manager');
const { SyncEngine, isShared } = require('./sync-engine');
const { HttpCoordStore } = require('./http-coord-store');
let logger; try { logger = require('../utils/logger')('cluster'); } catch (_) { logger = { info() {}, warn() {} }; }

// ── Instance identity (stable per machine+install, unique per instance) ──────
// deviceId is stable across restarts (hostname + data dir); instanceId adds a
// short random suffix so two instances sharing a data dir (the test harness)
// are still distinguishable.
function _deviceId() {
  try {
    const { P } = require('../config/paths');
    const base = os.hostname() + '|' + (P && P.dataDir ? P.dataDir : '');
    return crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
  } catch (_) {
    return crypto.createHash('sha1').update(os.hostname()).digest('hex').slice(0, 12);
  }
}

function _freshState() {
  return {
    started: false,
    enabled: false,
    deviceId: _deviceId(),
    instanceId: null,
    role: 'ACTIVE',            // ACTIVE | STANDBY | DEVELOPMENT
    fencingToken: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    lastSyncSeq: 0,
    coord: null,
    lease: null,              // LeaseManager instance (Stage 2), when enabled
    sync: null,               // SyncEngine instance (Stage 4), when enabled
    _syncTimer: null,         // periodic sync-pull timer handle (Stage 5)
    _clearSyncTimer: null,
    failoverHistory: [],      // recent promote/demote/takeover events (Stage 7)
    autoFailover: true,       // can be toggled from the dashboard (Stage 7)
    coordKind: 'local',       // 'local' | 'http' — which coordinator backend (Stage 8)
  };
}
const FAILOVER_HISTORY_CAP = 50;
let _state = _freshState();

// Resolve the feature flag + initial mode from settings/env. Kept tiny and
// dependency-light so this can be called very early in bootstrap.
function _resolveConfig() {
  let cfg = { enabled: false, mode: 'ACTIVE', capabilities: {} };
  try {
    const store = require('../store');
    const s = store.load('settings', {}) || {};
    const c = s.cluster || {};
    if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
    if (c.mode && gate.MODES.includes(c.mode)) cfg.mode = c.mode;
    if (c.capabilities && typeof c.capabilities === 'object') cfg.capabilities = c.capabilities;
  } catch (_) {}
  // Env overrides (useful for the DevSpace standby + the test harness).
  if (process.env.FLEET_CLUSTER === '1') cfg.enabled = true;
  if (process.env.FLEET_CLUSTER === '0') cfg.enabled = false;
  if (process.env.FLEET_CLUSTER_MODE && gate.MODES.includes(process.env.FLEET_CLUSTER_MODE)) cfg.mode = process.env.FLEET_CLUSTER_MODE;
  // A headless host (no DISPLAY on Linux) cannot do browser side-effects.
  if (cfg.capabilities.browser === undefined) {
    cfg.capabilities.browser = !(process.platform === 'linux' && !process.env.DISPLAY);
  }
  return cfg;
}

// The SHARED coordinator URL, if configured (settings.cluster.coordUrl or env
// FLEET_COORD_URL). When present, the cluster uses the HTTP coordinator so the
// laptop and the DevSpace coordinate through ONE authoritative record. When
// absent, it stays on the single-host LocalCoordStore.
function _resolveCoordUrl() {
  if (process.env.FLEET_COORD_URL) return process.env.FLEET_COORD_URL;
  try {
    const store = require('../store');
    const c = (store.load('settings', {}) || {}).cluster || {};
    if (c.coordUrl && typeof c.coordUrl === 'string') return c.coordUrl;
  } catch (_) {}
  return null;
}

/**
 * init(opts) — wire the facade. SAFE to call unconditionally at bootstrap.
 * When the flag is OFF this only sets identity and leaves the gate in its
 * no-op (ACTIVE-everything) state, so the app is byte-for-byte unchanged.
 * opts.store / opts.coord are injectable for tests + the two-instance harness.
 */
function init(opts) {
  opts = opts || {};
  if (_state.started && !opts.force) return getStatus();
  const cfg = _resolveConfig();
  if (opts.enabled !== undefined) cfg.enabled = !!opts.enabled;
  if (opts.mode && gate.MODES.includes(opts.mode)) cfg.mode = opts.mode;
  if (opts.capabilities) cfg.capabilities = { ...cfg.capabilities, ...opts.capabilities };

  _state.enabled = cfg.enabled;
  _state.instanceId = (opts.instanceId) || (_state.deviceId + '-' + crypto.randomBytes(3).toString('hex'));
  // Coordinator backend selection (Stage 8):
  //   - opts.coord (tests)            → use as-is.
  //   - a coordinator URL configured  → HttpCoordStore (SHARED, cross-machine).
  //   - otherwise                     → LocalCoordStore (single-host / harness).
  // The URL comes from opts, settings.cluster.coordUrl, or FLEET_COORD_URL.
  const coordUrl = opts.coordUrl || _resolveCoordUrl();
  if (opts.coord) {
    _state.coord = opts.coord;
  } else if (coordUrl) {
    try {
      _state.coord = new HttpCoordStore({ baseUrl: coordUrl, token: opts.coordToken, now: opts.now });
      _state.coordKind = 'http';
      logger.info('[cluster] using SHARED HTTP coordinator at ' + coordUrl);
    } catch (e) {
      logger.warn('[cluster] HTTP coordinator unavailable (' + e.message + ') — falling back to local coord-store');
      _state.coord = new LocalCoordStore({ store: opts.store, now: opts.now });
      _state.coordKind = 'local';
    }
  } else {
    _state.coord = new LocalCoordStore({ store: opts.store, now: opts.now });
    _state.coordKind = 'local';
  }

  gate.setEnabled(cfg.enabled);
  gate.setCapabilities(cfg.capabilities);
  gate.setMode(cfg.mode);
  _state.role = gate.getMode();
  _state.started = true;

  if (cfg.enabled) {
    logger.info('[cluster] init ENABLED instance=' + _state.instanceId + ' mode=' + _state.role +
      ' browser=' + cfg.capabilities.browser);
  } else {
    logger.info('[cluster] init (disabled — legacy single-host) instance=' + _state.instanceId);
  }
  // Keep the facade-level lease options (used by start()).
  _state._leaseOpts = {
    leaseMs: opts.leaseMs, heartbeatMs: opts.heartbeatMs, pollMs: opts.pollMs,
    now: opts.now, setTimer: opts.setTimer, clearTimer: opts.clearTimer,
  };
  return getStatus();
}

/**
 * start(opts) — begin the heartbeat + lease loop (Stage 2). No-op when the
 * cluster flag is OFF (legacy single-host stays leader-by-default with no
 * timers). Safe to call once after init() during app bootstrap.
 *
 * The LeaseManager drives active/standby failover; its onChange updates the
 * facade's held fencing token so isLeader()/the mode gate reflect reality:
 * a leader holds a token (production writes allowed); a follower holds none
 * (production writes fail closed).
 */
function start(opts) {
  opts = opts || {};
  if (!_state.enabled) return getStatus();          // legacy: nothing to run
  if (_state.lease) return getStatus();             // already started
  const lo = { ..._state._leaseOpts, ...opts };
  _state.lease = new LeaseManager({
    coord: _state.coord,
    instanceId: _state.instanceId,
    mode: getRole(),
    leaseMs: lo.leaseMs, heartbeatMs: lo.heartbeatMs, pollMs: lo.pollMs,
    now: lo.now, setTimer: lo.setTimer, clearTimer: lo.clearTimer,
    onChange: _onLeaseChange,
  });
  // Stage 4: the sync engine shares committed operational state via the event
  // log. It PRODUCES only when we're the leader (isLeader) and CONSUMES always
  // (so a standby stays current and a reconnecting instance catches up).
  _state.sync = new SyncEngine({
    coord: _state.coord,
    store: opts.store,
    instanceId: _state.instanceId,
    isLeader: () => isLeader(),
    getToken: () => _state.fencingToken,
    now: lo.now,
    onApplied: (key, version) => { _state.lastSyncSeq = _state.sync ? _state.sync.lastSyncSeq : _state.lastSyncSeq; },
  });
  _state.lease.start();
  // Stage 5: periodic sync pull so EVERY instance (leader + standby) stays
  // current from the event log. Interval is injectable for tests; defaults to
  // a real timer. Skipped entirely when no setTimer is wired AND we're in a
  // test that drives pull() manually (opts.noSyncTimer).
  if (!opts.noSyncTimer) {
    const setT = lo.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clrT = lo.clearTimer || ((h) => clearTimeout(h));
    const syncMs = lo.syncMs || 15000;
    const tick = async () => {
      if (!_state.sync) return;
      try { await pullSharedState(); } catch (_) {}
      if (_state._syncTimer != null) _state._syncTimer = setT(tick, syncMs);
    };
    _state._syncTimer = setT(tick, syncMs);
    _state._clearSyncTimer = clrT;
  }
  return getStatus();
}

async function stop() {
  if (_state._syncTimer != null && _state._clearSyncTimer) { try { _state._clearSyncTimer(_state._syncTimer); } catch (_) {} }
  _state._syncTimer = null;
  if (_state.lease) { try { await _state.lease.stop(); } catch (_) {} _state.lease = null; }
  _state.sync = null;
  _state.fencingToken = null;
  _state.leaseExpiresAt = null;
}

// React to lease state transitions: mirror the held token onto the facade so
// isLeader() + the mode gate see it. A follower (no token) fails writes closed.
function _onLeaseChange(evt) {
  const s = (evt && evt.state) || {};
  _state.fencingToken = s.isLeader ? s.fencingToken : null;
  _state.leaseExpiresAt = s.isLeader ? s.leaseExpiresAt : null;
  if (s.lastHeartbeatAt) _state.lastHeartbeatAt = s.lastHeartbeatAt;
  // Record promote/demote transitions for the Instance Management history pane.
  if (evt && (evt.type === 'promoted' || evt.type === 'demoted')) {
    _state.failoverHistory.unshift({
      type: evt.type, reason: evt.reason || '', token: evt.token != null ? evt.token : null,
      instanceId: _state.instanceId, at: new Date().toISOString(),
    });
    if (_state.failoverHistory.length > FAILOVER_HISTORY_CAP) _state.failoverHistory.length = FAILOVER_HISTORY_CAP;
  }
}

// ── Public API the rest of the app uses ──────────────────────────────────────

function isEnabled() { return _state.enabled; }
function getInstanceId() { return _state.instanceId; }
function getDeviceId() { return _state.deviceId; }
function getRole() { return gate.getMode(); }
function getCoord() { return _state.coord; }

// isLeader(): in Stage 1 (no lease loop yet) this reflects mode only. When the
// flag is OFF (legacy single-host) we are ALWAYS leader so nothing is gated
// off. When enabled, leadership additionally requires a held fencing token
// (set by the lease loop in a later stage) — until then an ACTIVE+enabled
// instance is NOT yet leader, which correctly fails production writes CLOSED
// rather than letting an un-leased instance act.
function isLeader() {
  if (!_state.enabled) return true;             // legacy single-host = always leader
  // When the lease loop is running it is authoritative; otherwise fall back to
  // the held token (set directly in tests via _setLease).
  if (_state.lease) return _state.lease.isLeader();
  return getRole() === 'ACTIVE' && _state.fencingToken != null;
}

// The gate pass-throughs every side-effect path will call.
function canSideEffect(kind) { return gate.canSideEffect(kind); }
function assertCanSideEffect(kind) { return gate.assertCanSideEffect(kind); }

// mayRunProduction() — the single predicate every background producer (the
// scheduler's SP/email/DBR fires, the Slack poll loops) checks before doing
// production work. True when the cluster is OFF (legacy single-host) OR this
// instance currently holds the leadership lease. False on a standby/non-leader
// so the laptop and the Dev Space never run the same production operation.
function mayRunProduction() {
  if (!_state.enabled) return true;   // legacy single-host
  return isLeader();
}

// ── Shared-state sync (Stage 4) ─────────────────────────────────────────────
// publishSharedKey(key) — the leader calls this AFTER committing a change to a
// shared-operational store key, to broadcast it to the other instance. No-op
// when the cluster is OFF, the key isn't shared, or we aren't the leader.
async function publishSharedKey(key) {
  if (!_state.enabled || !_state.sync) return { ok: false, skipped: 'disabled' };
  return _state.sync.publish(key);
}
// pullSharedState() — every instance calls this (on a timer + on reconnect) to
// apply any committed changes it is missing. No-op when the cluster is OFF.
async function pullSharedState(limit) {
  if (!_state.enabled || !_state.sync) return { ok: false, skipped: 'disabled', applied: 0 };
  const r = await _state.sync.pull(limit);
  if (r && typeof r.cursor === 'number') _state.lastSyncSeq = r.cursor;
  return r;
}
function isSharedKey(key) { return isShared(key); }
function getSyncState() { return _state.sync ? _state.sync.getState() : null; }

// Internal/test shim: record a held lease on the facade. When a lease manager
// is running it is authoritative for isLeader(), so keep the two in sync by
// reflecting the token onto it too (otherwise the facade and the lease loop
// could disagree).
function _setLease(token, expiresAt) {
  _state.fencingToken = token;
  _state.leaseExpiresAt = expiresAt;
  if (_state.lease) {
    if (token != null) { _state.lease.role = 'leader'; _state.lease.fencingToken = token; _state.lease.leaseExpiresAt = expiresAt; }
    else { _state.lease.role = 'follower'; _state.lease.fencingToken = null; _state.lease.leaseExpiresAt = null; }
  }
}

function getStatus() {
  return {
    enabled: _state.enabled,
    deviceId: _state.deviceId,
    instanceId: _state.instanceId,
    role: getRole(),
    isLeader: isLeader(),
    fencingToken: _state.fencingToken,
    leaseExpiresAt: _state.leaseExpiresAt,
    lastHeartbeatAt: _state.lastHeartbeatAt,
    lastSyncSeq: _state.lastSyncSeq,
    capabilities: gate.getCapabilities(),
    coordKind: _state.coordKind,
  };
}

// Test/reset hook.
function _reset() {
  if (_state.lease) { try { _state.lease._running = false; if (_state.lease._timer != null) _state.lease._clearTimer(_state.lease._timer); } catch (_) {} }
  _state = _freshState();
  gate._reset();
}

// Expose the lease manager's live state in getStatus when running.
function getLeaseState() { return _state.lease ? _state.lease.getState() : null; }

// ── Instance Management dashboard (Stage 7) ─────────────────────────────────
// getDashboard() — a single read the UI renders. Combines THIS instance's local
// status with the SHARED leadership record from the coordination store (so the
// dashboard can show who the current leader is, even when that's the OTHER
// instance). Read-only; never mutates coordination state.
async function getDashboard() {
  const self = getStatus();
  let shared = null;
  try { if (_state.coord) shared = await _state.coord.getLeadership(); } catch (_) {}
  const sy = getSyncState();
  const now = Date.now();
  const leaseLive = !!(shared && shared.expiresAt && shared.expiresAt > now);
  return {
    enabled: _state.enabled,
    autoFailover: _state.autoFailover,
    self: {
      instanceId: self.instanceId, deviceId: self.deviceId, role: self.role,
      isLeader: self.isLeader, fencingToken: self.fencingToken,
      lastHeartbeatAt: self.lastHeartbeatAt, capabilities: self.capabilities,
      appVersion: _appVersion(),
    },
    leader: shared ? {
      instanceId: shared.leader, mode: shared.mode, fencingToken: shared.fencingToken,
      acquiredAt: shared.acquiredAt ? new Date(shared.acquiredAt).toISOString() : null,
      expiresAt: shared.expiresAt ? new Date(shared.expiresAt).toISOString() : null,
      heartbeatAt: shared.heartbeatAt ? new Date(shared.heartbeatAt).toISOString() : null,
      live: leaseLive,
      isSelf: !!(shared.leader && shared.leader === self.instanceId),
    } : null,
    sync: { lastSyncSeq: sy ? sy.lastSyncSeq : _state.lastSyncSeq, sharedKeyCount: sy ? sy.sharedKeyCount : 0 },
    failoverHistory: _state.failoverHistory.slice(0, 20),
  };
}

function _appVersion() {
  try { const { app } = require('electron'); return app && app.getVersion ? app.getVersion() : null; }
  catch (_) { try { return require('../../package.json').version; } catch (__) { return null; } }
}

// setAutoFailover(on) — toggle whether this instance's lease loop is allowed to
// take over. When OFF, a standby will NOT acquire leadership even if the lease
// expires (the operator has chosen manual control). Backend-enforced.
function setAutoFailover(on) {
  _state.autoFailover = !!on;
  if (_state.lease) _state.lease.setAutoFailover(_state.autoFailover);
  logger.info('[cluster] autoFailover = ' + _state.autoFailover);
  return { ok: true, autoFailover: _state.autoFailover };
}

// handoffLeadership() — SAFE manual handoff: only the CURRENT leader may release
// its lease, which lets the standby take over on its next poll. Returns an
// error (never force-steals) if we aren't the leader — so a UI click can't
// bypass the backend's leadership rules.
async function handoffLeadership() {
  if (!_state.enabled) return { ok: false, error: 'cluster disabled' };
  if (!isLeader()) return { ok: false, error: 'not the current leader — cannot hand off' };
  if (!_state.lease) return { ok: false, error: 'lease manager not running' };
  try {
    await _state.coord.releaseLeadership(_state.instanceId, _state.fencingToken);
    _state.lease._demote('manual-handoff');
    _onLeaseChange({ type: 'demoted', reason: 'manual-handoff', state: _state.lease.getState() });
    logger.info('[cluster] manual leadership handoff by ' + _state.instanceId);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// setModeRuntime(mode) — switch ACTIVE/STANDBY/DEVELOPMENT at runtime. Enforced
// in the backend gate (not just the UI). DEVELOPMENT demotes any held lease so
// a dev instance never keeps leadership.
function setModeRuntime(mode) {
  if (!gate.MODES.includes(mode)) return { ok: false, error: 'invalid mode' };
  gate.setMode(mode);
  _state.role = gate.getMode();
  if (_state.lease) _state.lease.mode = mode;
  if (mode === 'DEVELOPMENT' && isLeader() && _state.lease) {
    // A dev instance must not hold production leadership.
    handoffLeadership().catch(() => {});
  }
  logger.info('[cluster] runtime mode -> ' + mode);
  return { ok: true, mode };
}

// requestReconcile() — force a full sync pull now (the dashboard's "reconcile"
// button). Pulls every missed event and applies it. No-op when disabled.
async function requestReconcile() {
  if (!_state.enabled || !_state.sync) return { ok: false, skipped: 'disabled' };
  const r = await pullSharedState(100000);
  return { ok: true, applied: r.applied, cursor: r.cursor };
}

module.exports = {
  init, start, stop, isEnabled, getInstanceId, getDeviceId, getRole, getCoord, isLeader,
  canSideEffect, assertCanSideEffect, mayRunProduction,
  publishSharedKey, pullSharedState, isSharedKey, getSyncState,
  getStatus, getLeaseState, _setLease, MODES: gate.MODES, _reset,
  // Stage 7 — Instance Management dashboard + controls
  getDashboard, setAutoFailover, handoffLeadership, setModeRuntime, requestReconcile,
  // expose the coord-store ctor for the harness/tests
  LocalCoordStore,
};
