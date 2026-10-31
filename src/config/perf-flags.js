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

module.exports = { resolveFlags, load };
