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
 * Phase 5 worker supervisor (default OFF; see resolveWorkerFlags below):
 *
 *   settings.workers.supervisor.enabled   default OFF (only `true` enables) /
 *                                         FLEET_WORKERS '0' | '1'
 *   settings.workers.<name>.supervised    default OFF (only `true` enables) /
 *                                         FLEET_WORKER_<UPPER_SNAKE> '0' | '1'
 *   (<name> in WORKER_NAMES; a per-worker `true` with the supervisor off
 *   means the legacy timer keeps ownership.)
 *
 * Phase 4b Slack poll speed-ups (all default OFF; see resolveSlackSpeedupFlags):
 *
 *   settings.comms.speedup.{dmPeerCache, dmSkipUnchanged, pmAlertSharedHistory,
 *     laneConcurrency, laneTierPacing, laneFairness} / FLEET_SLACK_*
 *   (S3 threadReplyReuse is deferred to its own round and is not a flag here.)
 *
 * Phase 9 auth coordination (all default OFF; see resolveAuthCoordFlags):
 *
 *   settings.auth.singleFlight          / FLEET_AUTH_SINGLE_FLIGHT          '0' | '1'
 *   settings.auth.singleOwner.aea       / FLEET_AUTH_SINGLE_OWNER_AEA       '0' | '1'
 *   settings.auth.singleOwner.reconnect / FLEET_AUTH_SINGLE_OWNER_RECONNECT '0' | '1'
 *
 * Phase 7 durable jobs (all default OFF; see resolveJobsFlags below):
 *
 *   settings.jobs.durable.enabled / FLEET_JOBS_DURABLE '0' | '1'
 *   settings.jobs.<type>.durable  / FLEET_JOBS_<UPPER_SNAKE> '0' | '1'
 *
 * Just Me context reader (default OFF; see resolveJustMeContextFlags below):
 *
 *   settings.comms.justMeReadContext / FLEET_JUSTME_READ_CONTEXT '0' | '1'
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

// ── Phase 5: worker supervisor flags (all default OFF) ──────────────────────
//   settings.workers.supervisor.enabled  boolean (=== true) / FLEET_WORKERS              '0'|'1'
//   settings.workers.<name>.supervised   boolean (=== true) / FLEET_WORKER_<UPPER_SNAKE> '0'|'1'
// Read once by src/workers/supervisor.js init() and memoized (restart to
// change). No new store key: 'settings' is already in the store REGISTRY.
const WORKER_NAMES = [
  'repairIntel', 'emailTriage', 'carrierBriefing', 'longDwell',
  'dailyTasks', 'fasCoverage', 'apiFleetRefresh',
];

const WORKER_ENV = {
  repairIntel: 'FLEET_WORKER_REPAIR_INTEL',
  emailTriage: 'FLEET_WORKER_EMAIL_TRIAGE',
  carrierBriefing: 'FLEET_WORKER_CARRIER_BRIEFING',
  longDwell: 'FLEET_WORKER_LONG_DWELL',
  dailyTasks: 'FLEET_WORKER_DAILY_TASKS',
  fasCoverage: 'FLEET_WORKER_FAS_COVERAGE',
  apiFleetRefresh: 'FLEET_WORKER_API_FLEET_REFRESH',
};

function resolveWorkerFlags(settings, env) {
  const w = _obj(_obj(settings).workers);
  const flags = {
    supervisorEnabled: _obj(w.supervisor).enabled === true,
    supervised: {},
  };
  const eSup = _envBool(env, 'FLEET_WORKERS');
  if (eSup !== null) flags.supervisorEnabled = eSup;
  for (const name of WORKER_NAMES) {
    let on = _obj(w[name]).supervised === true;
    const e = _envBool(env, WORKER_ENV[name]);
    if (e !== null) on = e;
    flags.supervised[name] = on;
  }
  return flags;
}

function loadWorkers(deps = {}) {
  const env = deps.env || process.env;
  let settings = {};
  try {
    const loadFn = deps.load || require('../store').load;
    settings = loadFn('settings', {}) || {};
  } catch (_) { settings = {}; }
  return resolveWorkerFlags(settings, env);
}

// ── Phase 4b: Slack poll speed-ups (all default OFF) ─────────────────────────
//   settings.comms.speedup.dmPeerCache          bool (=== true)     / FLEET_SLACK_DM_PEER_CACHE      '0'|'1'
//   settings.comms.speedup.dmSkipUnchanged      'off'|'shadow'|'on' / FLEET_SLACK_DM_SKIP_UNCHANGED  'off'|'shadow'|'on'
//   settings.comms.speedup.pmAlertSharedHistory bool (=== true)     / FLEET_SLACK_PM_SHARED_HISTORY  '0'|'1'
//   settings.comms.speedup.laneConcurrency      integer 1..4 (1)    / FLEET_SLACK_LANE_CONCURRENCY   '1'..'4'
//   settings.comms.speedup.laneTierPacing       bool (=== true)     / FLEET_SLACK_LANE_TIER_PACING   '0'|'1'
//   settings.comms.speedup.laneFairness         bool (=== true)     / FLEET_SLACK_LANE_FAIRNESS      '0'|'1'
//     (fair lane: write priority + round-robin reads by origin; only with
//      laneConcurrency 1 and laneTierPacing off, otherwise ignored)
// Modes (settings and env) are trimmed + case-insensitive; anything outside
// off|shadow|on is 'off' in settings and ignored in env. laneConcurrency must be
// a JS integer 1..4 in settings (anything else -> 1); env accepts digit strings
// resolving to 1..4 only. Separate resolver so resolveCommsFlags is unchanged.
// S3 (threadReplyReuse) is deferred and deliberately absent.
// S1/S2/S4 are read once per engine run; S5/S6 once per process by slack_send.
const SPEEDUP_MODES = ['off', 'shadow', 'on'];
const LANE_CONCURRENCY_MAX = 4;

function _spMode(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return SPEEDUP_MODES.includes(s) ? s : null;
}

function _laneK(v) {
  return (Number.isInteger(v) && v >= 1 && v <= LANE_CONCURRENCY_MAX) ? v : null;
}

function resolveSlackSpeedupFlags(settings, env) {
  const sp = _obj(_obj(_obj(settings).comms).speedup);
  const flags = {
    dmPeerCache: sp.dmPeerCache === true,
    dmSkipUnchanged: _spMode(sp.dmSkipUnchanged) || 'off',
    pmAlertSharedHistory: sp.pmAlertSharedHistory === true,
    laneConcurrency: _laneK(sp.laneConcurrency) || 1,
    laneTierPacing: sp.laneTierPacing === true,
    laneFairness: sp.laneFairness === true,
  };
  const eP = _envBool(env, 'FLEET_SLACK_DM_PEER_CACHE');
  if (eP !== null) flags.dmPeerCache = eP;
  const eS = _spMode(env && env.FLEET_SLACK_DM_SKIP_UNCHANGED);
  if (eS) flags.dmSkipUnchanged = eS;
  const eH = _envBool(env, 'FLEET_SLACK_PM_SHARED_HISTORY');
  if (eH !== null) flags.pmAlertSharedHistory = eH;
  const rawK = env && env.FLEET_SLACK_LANE_CONCURRENCY;
  if (typeof rawK === 'string' && /^\d+$/.test(rawK.trim())) {
    const k = _laneK(parseInt(rawK.trim(), 10));
    if (k) flags.laneConcurrency = k;
  }
  const eT = _envBool(env, 'FLEET_SLACK_LANE_TIER_PACING');
  if (eT !== null) flags.laneTierPacing = eT;
  const eF = _envBool(env, 'FLEET_SLACK_LANE_FAIRNESS');
  if (eF !== null) flags.laneFairness = eF;
  return flags;
}

function loadSlackSpeedup(deps = {}) {
  try {
    const env = deps.env || process.env;
    let settings = {};
    try {
      const loadFn = deps.load || require('../store').load;
      settings = loadFn('settings', {}) || {};
    } catch (_) { settings = {}; }
    return resolveSlackSpeedupFlags(settings, env);
  } catch (_) {
    return resolveSlackSpeedupFlags({}, {});
  }
}

// ── Phase 9: auth coordination flags (all default OFF) ──────────────────────
//   settings.auth.singleFlight          boolean (=== true) / FLEET_AUTH_SINGLE_FLIGHT          '0'|'1'
//   settings.auth.singleOwner.aea       boolean (=== true) / FLEET_AUTH_SINGLE_OWNER_AEA       '0'|'1'
//   settings.auth.singleOwner.reconnect boolean (=== true) / FLEET_AUTH_SINGLE_OWNER_RECONNECT '0'|'1'
// Read once per process: auth.js memoizes on first use, app.js at heartbeat setup,
// startOnlineReauthWatch at subscribe time. Restart to change. No new store key:
// 'settings' is already in the store REGISTRY; settings.auth is unused today.
const AUTH_COORD_ENV = {
  singleFlight: 'FLEET_AUTH_SINGLE_FLIGHT',
  singleOwnerAea: 'FLEET_AUTH_SINGLE_OWNER_AEA',
  singleOwnerReconnect: 'FLEET_AUTH_SINGLE_OWNER_RECONNECT',
};

function resolveAuthCoordFlags(settings, env) {
  const a = _obj(_obj(settings).auth);
  const so = _obj(a.singleOwner);
  const flags = {
    singleFlight: a.singleFlight === true,
    singleOwnerAea: so.aea === true,
    singleOwnerReconnect: so.reconnect === true,
  };
  for (const k of Object.keys(AUTH_COORD_ENV)) {
    const e = _envBool(env, AUTH_COORD_ENV[k]);
    if (e !== null) flags[k] = e;
  }
  return flags;
}

function loadAuthCoord(deps = {}) {
  try {
    const env = deps.env || process.env;
    let settings = {};
    try {
      const loadFn = deps.load || require('../store').load;
      settings = loadFn('settings', {}) || {};
    } catch (_) { settings = {}; }
    return resolveAuthCoordFlags(settings, env);
  } catch (_) {
    return resolveAuthCoordFlags({}, {});
  }
}

// ── Phase 7: durable job lifecycle (all default OFF) ─────────────────────────
//   settings.jobs.durable.enabled   boolean (=== true) / FLEET_JOBS_DURABLE            '0'|'1'
//   settings.jobs.<type>.durable    boolean (=== true) / FLEET_JOBS_<UPPER_SNAKE>      '0'|'1'
// Effective for a type = enabled && type flag && type adopted (longDwellAiFill is
// deferred in Phase 7: resolvable but never effective). Read once by
// src/jobs/index.js init() and memoized (restart to change).
const JOB_TYPES = ['deepScan', 'repairIntel', 'longDwellAiFill', 'rcaAutofill'];
const JOB_ENV = {
  deepScan: 'FLEET_JOBS_DEEP_SCAN',
  repairIntel: 'FLEET_JOBS_REPAIR_INTEL',
  longDwellAiFill: 'FLEET_JOBS_LONG_DWELL_AI_FILL',
  rcaAutofill: 'FLEET_JOBS_RCA_AUTOFILL',
};

function resolveJobsFlags(settings, env) {
  const j = _obj(_obj(settings).jobs);
  const flags = { enabled: _obj(j.durable).enabled === true, types: {} };
  const eEn = _envBool(env, 'FLEET_JOBS_DURABLE');
  if (eEn !== null) flags.enabled = eEn;
  for (const t of JOB_TYPES) {
    let on = _obj(j[t]).durable === true;
    const e = _envBool(env, JOB_ENV[t]);
    if (e !== null) on = e;
    flags.types[t] = on;
  }
  return flags;
}

function loadJobs(deps = {}) {
  try {
    const env = deps.env || process.env;
    let settings = {};
    try {
      const loadFn = deps.load || require('../store').load;
      settings = loadFn('settings', {}) || {};
    } catch (_) { settings = {}; }
    return resolveJobsFlags(settings, env);
  } catch (_) {
    return resolveJobsFlags({}, {});
  }
}

// ── Just Me context reader (default OFF) ─────────────────────────────────────
//   settings.comms.justMeReadContext  boolean (=== true) / FLEET_JUSTME_READ_CONTEXT '0'|'1'
// Read once per Just Me job (slack_channel_watch._runJustMeJob) and once per
// DM auto-reply poll (self-DM yield). No new store key: 'settings' is registered.
function resolveJustMeContextFlags(settings, env) {
  const c = _obj(_obj(settings).comms);
  const flags = { readContext: c.justMeReadContext === true };
  const e = _envBool(env, 'FLEET_JUSTME_READ_CONTEXT');
  if (e !== null) flags.readContext = e;
  return flags;
}

function loadJustMeContext(deps = {}) {
  try {
    const env = deps.env || process.env;
    let settings = {};
    try {
      const loadFn = deps.load || require('../store').load;
      settings = loadFn('settings', {}) || {};
    } catch (_) { settings = {}; }
    return resolveJustMeContextFlags(settings, env);
  } catch (_) {
    return resolveJustMeContextFlags({}, {});
  }
}

module.exports = {
  resolveFlags, load, resolveAiGatewayFlags, loadAiGateway, AI_GW_RESERVE_DEFAULT,
  resolveCommsFlags, loadComms, COMMS_POLLING_MODES,
  resolveWorkerFlags, loadWorkers, WORKER_NAMES, WORKER_ENV,
  resolveSlackSpeedupFlags, loadSlackSpeedup, SPEEDUP_MODES, LANE_CONCURRENCY_MAX,
  resolveAuthCoordFlags, loadAuthCoord, AUTH_COORD_ENV,
  resolveJobsFlags, loadJobs, JOB_TYPES, JOB_ENV,
  resolveJustMeContextFlags, loadJustMeContext,
};
