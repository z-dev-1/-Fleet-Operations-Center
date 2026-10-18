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
  };
}
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
  _state.coord = (opts.coord) || new LocalCoordStore({ store: opts.store });

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
  return getStatus();
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
  return getRole() === 'ACTIVE' && _state.fencingToken != null;
}

// The gate pass-throughs every side-effect path will call.
function canSideEffect(kind) { return gate.canSideEffect(kind); }
function assertCanSideEffect(kind) { return gate.assertCanSideEffect(kind); }

// Internal: used by the (future) lease loop to record the held token.
function _setLease(token, expiresAt) { _state.fencingToken = token; _state.leaseExpiresAt = expiresAt; }

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
  };
}

// Test/reset hook.
function _reset() { _state = _freshState(); gate._reset(); }

module.exports = {
  init, isEnabled, getInstanceId, getDeviceId, getRole, getCoord, isLeader,
  canSideEffect, assertCanSideEffect, getStatus, _setLease, MODES: gate.MODES, _reset,
  // expose the coord-store ctor for the harness/tests
  LocalCoordStore,
};
