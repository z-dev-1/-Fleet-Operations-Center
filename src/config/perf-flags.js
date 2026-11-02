'use strict';
/**
 * config/perf-flags.js — Phase 2a/2b performance + telemetry flags.
 *
 * Settings live as nested objects in settings.json (settings:save only accepts
 * flat top-level keys, so dotted names map to nested objects):
 *
 *   settings.telemetry.enabled            default ON  (only `false` disables)
 *   settings.perf.trayAnimateOnlyWhenBusy default OFF (only `true` enables)
 *   settings.perf.deepScanMatchPool       default OFF (only `true` enables)
 *
 * Env overrides (win over settings when set to '0' / '1'), mirroring the
 * FLEET_CLUSTER pattern in src/cluster/index.js, so off/on can be measured
 * without editing the user's settings:
 *
 *   FLEET_TELEMETRY           '0' | '1'
 *   FLEET_PERF_TRAY_BUSY      '0' | '1'
 *   FLEET_PERF_DS_MATCH_POOL  '0' | '1'
 *
 * Phase 4 communications poller (default OFF; see resolveCommsFlags below):
 *
 *   settings.comms.mainProcessPolling 'off'|'shadow'|'on' / FLEET_COMMS_POLLING
 *   settings.comms.channelWatchClaims  default OFF (only `true` enables) /
 *                                      FLEET_COMMS_CHANNEL_CLAIMS '0' | '1'
 *
 * Read at point of use (startup / once per run), never per tick.
 */

function _obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function _envBool(env, name) {
  const v = env && env[name];
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

function resolveFlags(settings, env) {
  const s = _obj(settings);
  const t = _obj(s.telemetry);
  const p = _obj(s.perf);
  const flags = {
    telemetryEnabled: t.enabled !== false,
    trayAnimateOnlyWhenBusy: p.trayAnimateOnlyWhenBusy === true,
    deepScanMatchPool: p.deepScanMatchPool === true,
  };
  const eT = _envBool(env, 'FLEET_TELEMETRY');
  if (eT !== null) flags.telemetryEnabled = eT;
  const eTray = _envBool(env, 'FLEET_PERF_TRAY_BUSY');
  if (eTray !== null) flags.trayAnimateOnlyWhenBusy = eTray;
  const eDs = _envBool(env, 'FLEET_PERF_DS_MATCH_POOL');
  if (eDs !== null) flags.deepScanMatchPool = eDs;
  return flags;
}

function load(deps = {}) {
  const env = deps.env || process.env;
  let settings = {};
  try {
    const loadFn = deps.load || require('../store').load;
    settings = loadFn('settings', {}) || {};
  } catch (_) { settings = {}; }
  return resolveFlags(settings, env);
}

// ── Phase 3: AI gateway flags (all default OFF) ─────────────────────────────
//   settings.ai.gateway.priorities      / FLEET_AI_GW_PRIORITIES '0'|'1'
//   settings.ai.gateway.abortOnTimeout  / FLEET_AI_GW_ABORT      '0'|'1'
//   settings.ai.gateway.dedupe          / FLEET_AI_GW_DEDUPE     '0'|'1'
//   settings.ai.gateway.routerDecides   / FLEET_AI_GW_ROUTER     '0'|'1'
//   settings.ai.gateway.reserveSlots    / FLEET_AI_GW_RESERVE    integer 0..4 (default 2)
// Only `=== true` enables; env '0'/'1' wins over settings. Read by relay.js
// through a 15 s cache, never per call.
const AI_GW_RESERVE_DEFAULT = 2;

function _reserve(v) {
  return (Number.isInteger(v) && v >= 0 && v <= 4) ? v : null;
}

function resolveAiGatewayFlags(settings, env) {
  const s = _obj(settings);
  const g = _obj(_obj(s.ai).gateway);
  const flags = {
    priorities: g.priorities === true,
    abortOnTimeout: g.abortOnTimeout === true,
    dedupe: g.dedupe === true,
    routerDecides: g.routerDecides === true,
    reserveSlots: _reserve(g.reserveSlots) != null ? g.reserveSlots : AI_GW_RESERVE_DEFAULT,
  };
  const ePr = _envBool(env, 'FLEET_AI_GW_PRIORITIES');
  if (ePr !== null) flags.priorities = ePr;
  const eAb = _envBool(env, 'FLEET_AI_GW_ABORT');
  if (eAb !== null) flags.abortOnTimeout = eAb;
  const eDd = _envBool(env, 'FLEET_AI_GW_DEDUPE');
  if (eDd !== null) flags.dedupe = eDd;
  const eRt = _envBool(env, 'FLEET_AI_GW_ROUTER');
  if (eRt !== null) flags.routerDecides = eRt;
  const rawRes = env && env.FLEET_AI_GW_RESERVE;
  if (typeof rawRes === 'string' && /^\d+$/.test(rawRes.trim())) {
    const n = _reserve(parseInt(rawRes.trim(), 10));
    if (n != null) flags.reserveSlots = n;
  }
  return flags;
}

function loadAiGateway(deps = {}) {
  const env = deps.env || process.env;
  let settings = {};
  try {
    const loadFn = deps.load || require('../store').load;
    settings = loadFn('settings', {}) || {};
  } catch (_) { settings = {}; }
  return resolveAiGatewayFlags(settings, env);
}

// ── Phase 4: communications poller flags (default OFF) ──────────────────────
//   settings.comms.mainProcessPolling   'off'|'shadow'|'on' / FLEET_COMMS_POLLING        'off'|'shadow'|'on'
//   settings.comms.channelWatchClaims   boolean (=== true)  / FLEET_COMMS_CHANNEL_CLAIMS '0'|'1'
// mainProcessPolling: string (trimmed, case-insensitive) in COMMS_POLLING_MODES,
// anything else -> 'off' (fail safe to today's renderer polling). Read once per
// process by src/slack/poller.js getMode(); channelWatchClaims once per run.
const COMMS_POLLING_MODES = ['off', 'shadow', 'on'];

function _mode(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return COMMS_POLLING_MODES.includes(s) ? s : null;
}

function resolveCommsFlags(settings, env) {
  const c = _obj(_obj(settings).comms);
  const flags = {
    mainProcessPolling: _mode(c.mainProcessPolling) || 'off',
    channelWatchClaims: c.channelWatchClaims === true,
  };
  const eMode = _mode(env && env.FLEET_COMMS_POLLING);
  if (eMode) flags.mainProcessPolling = eMode;
  const eCl = _envBool(env, 'FLEET_COMMS_CHANNEL_CLAIMS');
  if (eCl !== null) flags.channelWatchClaims = eCl;
  return flags;
}

function loadComms(deps = {}) {
  const env = deps.env || process.env;
  let settings = {};
  try {
    const loadFn = deps.load || require('../store').load;
    settings = loadFn('settings', {}) || {};
  } catch (_) { settings = {}; }
  return resolveCommsFlags(settings, env);
}

module.exports = {
  resolveFlags, load, resolveAiGatewayFlags, loadAiGateway, AI_GW_RESERVE_DEFAULT,
  resolveCommsFlags, loadComms, COMMS_POLLING_MODES,
};
