'use strict';
/**
 * workers/isolation/index.js — Phase 8 worker-isolation registry (singleton).
 *
 * NO load-time side effects: no timers, no electron, flags are read only
 * inside init(). init() is memoized (restart to change), like the Phase 5
 * supervisor. It is the ONLY createHost() call site, so with flags off nothing
 * is created, nothing is spawned, electron is never required, no process
 * 'exit' listener is added and nothing is logged at INFO or above.
 *
 * Effective for a group = supervisor.isEnabled() && flags.enabled && flags.groups[g].
 * Isolation flags on with the supervisor off → one INFO line, stay in-process.
 *
 * No-orphan layers (design §8): (1) onBeforeQuit → host.shutdown() (graceful,
 * 1500 ms kill timer); (2) the first spawn adds ONE process.once('exit',
 * killAllSync), which always follows child.kill() with process.kill(pid,0) +
 * process.kill(pid) for every pid whose exit was not observed; (3) the worker's
 * own ppid poll / silence watchdog (worker-runtime.js).
 */

let _initResult = null;
let _hosts = new Map();        // group → host handle
let _spawnedPids = new Set();  // pids spawned and not yet observed to exit
let _exitHooked = false;
let _processKill = (pid, sig) => process.kill(pid, sig);
let _logger = null;

function _noopLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
function _log(level, msg) {
  try {
    if (!_logger) { try { _logger = require('../../utils/logger')('workers-isolation'); } catch (_) { _logger = _noopLogger(); } }
    _logger[level](msg);
  } catch (_) { /* ignore */ }
}
function _errMsg(e) { try { return String((e && e.message) || e); } catch (_) { return 'unknown error'; } }

function _onSpawn(pid) {
  _spawnedPids.add(pid);
  if (!_exitHooked) {
    _exitHooked = true;
    process.once('exit', killAllSync);
  }
}
function _onExit(pid) { _spawnedPids.delete(pid); }

/**
 * init({ flags?, supervisor?, notify?, logger?, deps? }) → { enabled, groups }
 * deps: forwarded to createHost (spawn, timers, now, …); deps.createHost
 * (tests) replaces the host factory.
 */
function init(opts = {}) {
  if (_initResult) return _initResult;
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    const perfFlags = require('../../config/perf-flags');
    const flags = o.flags || perfFlags.loadWorkerIsolation();
    const groupsOn = (flags && flags.groups && typeof flags.groups === 'object') ? flags.groups : {};
    const wanted = perfFlags.ISOLATION_GROUPS.filter((g) => groupsOn[g] === true);
    if (!flags || flags.enabled !== true || !wanted.length) {
      _initResult = { enabled: false, groups: [] };
      return _initResult;   // flags off: silent (nothing at INFO or above)
    }
    if (o.logger) _logger = o.logger;
    const sup = o.supervisor || require('../supervisor');
    if (!sup || typeof sup.isEnabled !== 'function' || sup.isEnabled() !== true) {
      _log('info', '[workers:isolation] isolation flags are on but the worker supervisor is off (workers.supervisor.enabled) — staying in-process');
      _initResult = { enabled: false, groups: [], reason: 'supervisor-off' };
      return _initResult;
    }
    const groups = require('./groups').GROUPS;
    const deps = Object.assign({}, o.deps || {});
    const factory = typeof deps.createHost === 'function' ? deps.createHost : require('./host').createHost;
    if (typeof deps.processKill === 'function') _processKill = deps.processKill;
    for (const g of wanted) {
      const spec = groups[g];
      if (!spec) continue;
      const host = factory(spec, Object.assign({}, deps, {
        notify: typeof o.notify === 'function' ? o.notify : deps.notify,
        logger: deps.logger || o.logger,
        onSpawn: _onSpawn,
        onExit: _onExit,
      }));
      try { sup.registerHost(host); } catch (e) {
        _log('warn', '[workers:isolation] registerHost(' + g + ') failed (in-process): ' + _errMsg(e));
        continue;
      }
      _hosts.set(g, host);
      try { host.start(); } catch (e) { _log('warn', '[workers:isolation] ' + g + ' start failed (in-process): ' + _errMsg(e)); }
    }
    _initResult = { enabled: _hosts.size > 0, groups: Array.from(_hosts.keys()) };
    if (_hosts.size) _log('info', '[workers:isolation] enabled for ' + _initResult.groups.join(', '));
  } catch (e) {
    _log('warn', '[workers:isolation] init failed (non-fatal, in-process): ' + _errMsg(e));
    _initResult = { enabled: false, groups: [] };
  }
  return _initResult;
}

function isActive(group) { return !!(_initResult && _initResult.enabled && _hosts.has(group)); }
function getHost(group) { return _hosts.get(group) || null; }

function onBeforeQuit() {
  for (const h of _hosts.values()) { try { h.shutdown(); } catch (_) { /* ignore */ } }
}
function onWillQuit() { killAllSync(); }
function resume() {
  for (const h of _hosts.values()) { try { h.resume(); } catch (_) { /* ignore */ } }
}

/** killAllSync() — synchronous, never throws; safe inside process 'exit'. */
function killAllSync() {
  try {
    const covered = new Set();
    for (const h of _hosts.values()) {
      try { const pid = h.pid; if (pid != null) covered.add(pid); h.killSync(); } catch (_) { /* ignore */ }
    }
    for (const pid of Array.from(_spawnedPids)) {
      if (covered.has(pid)) continue;
      try { _processKill(pid, 0); _processKill(pid); } catch (e) {
        if (!e || e.code !== 'ESRCH') { try { _log('error', '[workers:isolation] killAllSync pid=' + pid + ' failed: ' + _errMsg(e)); } catch (_) { /* ignore */ } }
      }
    }
  } catch (_) { /* never throw */ }
}

function _resetForTests() {
  for (const h of _hosts.values()) { try { h._dispose && h._dispose(); } catch (_) { /* ignore */ } }
  if (_exitHooked) { try { process.removeListener('exit', killAllSync); } catch (_) { /* ignore */ } }
  _initResult = null;
  _hosts = new Map();
  _spawnedPids = new Set();
  _exitHooked = false;
  _processKill = (pid, sig) => process.kill(pid, sig);
  _logger = null;
}

module.exports = {
  init, isActive, getHost, onBeforeQuit, onWillQuit, killAllSync, resume, _resetForTests,
  _spawnedPids: () => new Set(_spawnedPids),
};
