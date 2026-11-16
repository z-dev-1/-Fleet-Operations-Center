'use strict';
/**
 * health/fleet-freshness.js — record of the last SUCCESSFUL fleet build.
 *
 * payload.syncedAt cannot be trusted for this: hydrate / PM-fill / Uptake
 * re-pushes of old rows bump it to "now". This process singleton is fed by the
 * window loader (src/window/index.js) and the manual build IPC
 * (src/ipc/aap-api.js), reads in-flight state from the existing
 * _apiLoadGuard.snapshot() and AAP call counters from aap_api.getCallStats(),
 * and evaluates a green/amber/red/grey level (plan.md D1/D2).
 *
 * Read-only consumers: ipc/fleet-freshness.js (fleet:get-freshness),
 * health/snapshot.js (fleet section + apiFleetRefresh overlay). Subscribers
 * get { snapshot, evaluation } after every record* call.
 */
const { API_LOAD_MAX_AGE_MS } = require('../window/api-load-guard');
const DEFAULTS = require('../config/defaults');

const INFLIGHT_AMBER_MS = 5 * 60 * 1000;
const INFLIGHT_RED_MS = API_LOAD_MAX_AGE_MS;
const AMBER_AGE_FACTOR = 2;
const RED_AGE_FACTOR = 3;
const AAP_TIMEOUT_STREAK_RED = 3;
const DEFAULT_INTERVAL_MS = DEFAULTS.SYNC_INTERVAL_MS;
const STORE_KEY = 'fleetFreshness';

const HEALTH = { green: 'healthy', amber: 'degraded', red: 'unhealthy', grey: 'unknown' };

let _deps = null;
let _inited = false;
let _state = _blank();
let _listeners = new Set();

function _blank() {
  return {
    lastOkAt: null, lastOkCount: null,
    lastFailAt: null, lastFailCode: null, lastFailMessage: null,
    consecutiveFailures: 0,
    supersededCount: 0, lastSupersededAt: null,
  };
}

function _fin(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function _clip(s, n) { return s == null ? null : String(s).slice(0, n); }

function _store() {
  if (_deps && _deps.store) return _deps.store;
  return require('../store');
}
function _now() {
  return (_deps && typeof _deps.now === 'function') ? _deps.now() : Date.now();
}

function _defaultIntervalMs() {
  try {
    const s = require('../store').load('settings', {}) || {};
    const mins = Number(s.syncIntervalMinutes);
    if (Number.isFinite(mins) && Number.isInteger(mins) && mins >= 1 && mins <= 360) return mins * 60 * 1000;
  } catch (_) {}
  return DEFAULT_INTERVAL_MS;
}

function _intervalMs() {
  try {
    const fn = _deps && typeof _deps.getIntervalMs === 'function' ? _deps.getIntervalMs : _defaultIntervalMs;
    const v = fn();
    return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : DEFAULT_INTERVAL_MS;
  } catch (_) { return DEFAULT_INTERVAL_MS; }
}

function init(deps) {
  if (_inited) return;
  _inited = true;
  _deps = Object.assign({}, deps || {});
  try {
    const saved = _store().load(STORE_KEY, null);
    if (saved && typeof saved === 'object') {
      if (_fin(saved.lastOkAt) != null) _state.lastOkAt = saved.lastOkAt;
      if (_fin(saved.lastOkCount) != null) _state.lastOkCount = saved.lastOkCount;
    }
  } catch (_) {}
}

function _notify() {
  if (!_listeners.size) return;
  const now = _now();
  const payload = { snapshot: getSnapshot(now), evaluation: evaluate(now) };
  for (const fn of Array.from(_listeners)) {
    try { fn(payload); } catch (_) {}
  }
}

function recordBuildOk({ count, at } = {}) {
  _state.lastOkAt = _fin(at) != null ? at : _now();
  _state.lastOkCount = _fin(count);
  _state.consecutiveFailures = 0;
  try { _store().save(STORE_KEY, { lastOkAt: _state.lastOkAt, lastOkCount: _state.lastOkCount }); } catch (_) {}
  _notify();
}

function recordBuildFailed({ code, message, at } = {}) {
  _state.lastFailAt = _fin(at) != null ? at : _now();
  _state.lastFailCode = _clip(code || 'ERROR', 40);
  _state.lastFailMessage = _clip(message, 160);
  _state.consecutiveFailures++;
  _notify();
}

function recordSuperseded({ at } = {}) {
  _state.supersededCount++;
  _state.lastSupersededAt = _fin(at) != null ? at : _now();
  _notify();
}

function getSnapshot(now) {
  const t = _fin(now) != null ? now : _now();
  let busy = false;
  let startedAt = null;
  try {
    const g = _deps && typeof _deps.getGuardSnapshot === 'function' ? _deps.getGuardSnapshot() : null;
    if (g && g.busy) { busy = true; startedAt = _fin(g.startedAt) || null; }
  } catch (_) {}
  let aap = null;
  try {
    const a = _deps && typeof _deps.getAapStats === 'function' ? _deps.getAapStats() : null;
    if (a && typeof a === 'object') {
      aap = {
        timeouts: _fin(a.timeouts) || 0,
        consecutiveTimeouts: _fin(a.consecutiveTimeouts) || 0,
        lastTimeoutAt: _fin(a.lastTimeoutAt),
        lastOkAt: _fin(a.lastOkAt),
      };
    }
  } catch (_) { aap = null; }
  return {
    v: 1,
    at: t,
    intervalMs: _intervalMs(),
    lastOkAt: _state.lastOkAt,
    lastOkCount: _state.lastOkCount,
    lastFailAt: _state.lastFailAt,
    lastFailCode: _state.lastFailCode,
    lastFailMessage: _state.lastFailMessage,
    consecutiveFailures: _state.consecutiveFailures,
    buildInFlight: busy,
    buildStartedAt: startedAt,
    supersededCount: _state.supersededCount,
    lastSupersededAt: _state.lastSupersededAt,
    aap,
  };
}

function evaluate(now) {
  const s = getSnapshot(now);
  const t = s.at;
  const intervalMs = s.intervalMs;
  const ageMs = s.lastOkAt != null ? Math.max(0, t - s.lastOkAt) : null;
  const inFlightMs = s.buildInFlight && s.buildStartedAt != null ? Math.max(0, t - s.buildStartedAt) : 0;

  const red = [];
  if (ageMs != null && ageMs > RED_AGE_FACTOR * intervalMs) red.push('age>3x');
  if (s.lastSupersededAt != null && s.lastSupersededAt > (s.lastOkAt || 0)) red.push('superseded');
  if (s.buildInFlight && inFlightMs >= INFLIGHT_RED_MS) red.push('wedged');
  if (s.aap && s.aap.consecutiveTimeouts >= AAP_TIMEOUT_STREAK_RED) red.push('aap-timeouts');

  let level;
  let reasons;
  if (red.length) {
    level = 'red'; reasons = red;
  } else {
    const amber = [];
    if (ageMs != null && ageMs > AMBER_AGE_FACTOR * intervalMs) amber.push('age>2x');
    if (s.buildInFlight && inFlightMs > INFLIGHT_AMBER_MS) amber.push('in-flight>5m');
    if (amber.length) {
      level = 'amber'; reasons = amber;
    } else if (s.lastOkAt == null) {
      level = 'grey'; reasons = ['no-success-yet'];
    } else {
      level = 'green'; reasons = [];
      if (ageMs >= intervalMs) reasons.push('aging');
    }
  }
  if (s.lastFailAt != null && s.lastFailAt > (s.lastOkAt || 0)) reasons.push('last-build-failed');
  return { level, health: HEALTH[level], reasons, ageMs, inFlightMs, intervalMs };
}

function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// True only when a build came back empty while the last saved fleet had rows,
// i.e. writing it would replace good data with nothing.
function isEmptyBuildOverGood(rows, prevRows) {
  const empty = !Array.isArray(rows) || rows.length === 0;
  return empty && Array.isArray(prevRows) && prevRows.length > 0;
}

function _resetForTests() {
  _deps = null;
  _inited = false;
  _state = _blank();
  _listeners = new Set();
}

module.exports = {
  init,
  recordBuildOk,
  recordBuildFailed,
  recordSuperseded,
  getSnapshot,
  evaluate,
  subscribe,
  isEmptyBuildOverGood,
  _resetForTests,
  INFLIGHT_AMBER_MS,
  INFLIGHT_RED_MS,
  AMBER_AGE_FACTOR,
  RED_AGE_FACTOR,
  AAP_TIMEOUT_STREAK_RED,
  DEFAULT_INTERVAL_MS,
  STORE_KEY,
};
