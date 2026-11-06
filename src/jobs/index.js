'use strict';
/**
 * jobs/index.js — durable job lifecycle facade (Phase 7).
 *
 * Side-effect-free on require: nothing opens SQLite until init() runs with
 * flags on. Until init() reaches mode 'active', begin() returns NOOP_HANDLE,
 * getSummary() returns { mode:'off' } and reconcile() { ok:false, code:'off' },
 * all without SQL. All flags default OFF (= today's behavior).
 *
 *   init()                       idempotent, never throws; flags -> effective map ->
 *                                engine availability -> ensureSchema -> recover -> prune
 *   begin({ type, scopeKey })    durable handle or a NOOP handle
 *   getStatus() / getSummary(now) / reconcile(id, outcome)
 *   isEffective(type) / peek({ type, scopeKey })   read-only, null/false when off
 *
 * Degraded (flags on, node:sqlite unavailable or schema failed): NOOP handles,
 * adopted bodies run today's legacy path, one warn per process.
 */

const os = require('os');
const crypto = require('crypto');
const engine = require('../store/sqlite_engine');
const schema = require('./schema');
const types = require('./types');
const { createHandle, NOOP_HANDLE, _noop } = require('./handle');

let _defaultLog;
try { _defaultLog = require('../utils/logger')('jobs'); } catch (_) { _defaultLog = { debug() {}, info() {}, warn() {}, error() {} }; }

const BOOT_ID = crypto.randomBytes(6).toString('hex');
const OWNER = os.hostname() + '|' + process.pid + '|' + BOOT_ID;
const JOB_TYPES = ['deepScan', 'repairIntel', 'longDwellAiFill', 'rcaAutofill', 'emailTriage'];
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
const SCOPE_RE = /^[A-Za-z0-9_.:|-]{1,200}$/;

const engineAdapter = {
  get id() { return engine._currentDbPath(); },
  exec: (s) => engine.exec(s),
  prepare: (s) => engine.prepare(s),
  getDb: () => engine.getDb(),
};

const BUSY_NOOP = _noop({ busy: true });
const DEGRADED_NOOP = _noop({ degraded: true });
const _blockedNoops = {};

let _store = null;
let _mode = 'off';
let _status = null;
let _degradedLogged = false;
let _flags = null;
let _testOverrides = {};
let _testEffective = new Set();
let _warnedTypes = new Set();
let _infoOnce = new Set();

function _log() { return _testOverrides.logger || _defaultLog; }
function _now() { return (_testOverrides.now || Date.now)(); }
function _clip(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function _normFlags(f) {
  const src = f && typeof f === 'object' ? f : {};
  const t = src.types && typeof src.types === 'object' ? src.types : {};
  const out = { enabled: src.enabled === true, types: {} };
  for (const k of JOB_TYPES) out.types[k] = t[k] === true;
  return out;
}

function _degrade(reason) {
  _mode = 'degraded';
  _store = null;
  _status = { mode: 'degraded', reason: _clip(reason, 120) };
  if (!_degradedLogged) {
    _degradedLogged = true;
    const flagged = _flags ? JOB_TYPES.filter((t) => _flags.effective[t]).join(', ') : '';
    try { _log().warn('[jobs] durable jobs requested for ' + (flagged || 'none') + ' but ' + _status.reason + ' — running non-durable (legacy) behavior; status: degraded'); } catch (_) {}
  }
  return _status;
}

function init() {
  if (_status) return _status;
  let flags;
  try {
    flags = _testOverrides.flags ? _normFlags(_testOverrides.flags) : _normFlags(require('../config/perf-flags').loadJobs());
  } catch (e) {
    try { _log().warn('[jobs] could not read flags (durable jobs off): ' + ((e && e.message) || e)); } catch (_) {}
    _status = { mode: 'off' };
    return _status;
  }
  try {
    const effective = {};
    for (const t of JOB_TYPES) effective[t] = flags.enabled && flags.types[t] === true && types.ADOPTED[t] === true;
    _flags = { enabled: flags.enabled, types: flags.types, effective };
    if (!JOB_TYPES.some((t) => effective[t])) {
      _mode = 'off';
      _status = { mode: 'off' };
      try { _log().debug('[jobs] durable jobs off'); } catch (_) {}
      return _status;
    }
    const adapter = _testOverrides.adapter || engineAdapter;
    const available = adapter === engineAdapter
      ? engine.isAvailable()
      : (typeof adapter.isAvailable === 'function' ? !!adapter.isAvailable() : true);
    if (!available) return _degrade('node:sqlite unavailable');
    const s = schema.ensureSchema(adapter);
    if (!s.ok) {
      if (s.code === 'unavailable') return _degrade('node:sqlite unavailable');
      if (s.code === 'busy') return _degrade('schema init busy');
      return _degrade('schema init failed: ' + (s.error || 'unknown'));
    }
    _store = require('./store').createJobStore({ adapter, now: _testOverrides.now || Date.now, owner: _testOverrides.owner || OWNER, log: _log() });
    _mode = 'active';
    const r = _store.recover(_now());
    if (!r.ok && r.code === 'busy') {
      _store._recoveryPending = true;
      _status = { mode: 'active', recovery: 'deferred' };
      return _status;
    }
    const p = _store.prune(_now());
    if (p.ok) _store._lastPrune = _now();
    _status = { mode: 'active' };
    return _status;
  } catch (e) {
    return _degrade('init failed: ' + ((e && e.message) || e));
  }
}

function _warnTypeOnce(type, msg) {
  const k = String(type);
  if (_warnedTypes.has(k)) return;
  _warnedTypes.add(k);
  try { _log().warn('[jobs] begin(' + _clip(k, 60) + '): ' + msg); } catch (_) {}
}
function _infoJobOnce(id, msg) {
  if (_infoOnce.has(id)) return;
  _infoOnce.add(id);
  try { _log().info(msg); } catch (_) {}
}
function _blocked(state) {
  if (!_blockedNoops[state]) _blockedNoops[state] = _noop({ blockedBy: state });
  return _blockedNoops[state];
}

function begin(args) {
  const a = args || {};
  const type = a.type;
  const scopeKey = a.scopeKey;
  // Step -1 (round-3 fix 3): no SQL until mode, type, per-type flag and scope pass.
  if (_mode !== 'active' || !_store) return _mode === 'degraded' ? DEGRADED_NOOP : NOOP_HANDLE;
  const def = types.get(type);
  if (!def) { _warnTypeOnce(type, 'unknown job type'); return NOOP_HANDLE; }
  if (!(_flags && _flags.effective[type] === true) && !_testEffective.has(type)) return NOOP_HANDLE;   // silent
  if (typeof scopeKey !== 'string' || !SCOPE_RE.test(scopeKey)) { _warnTypeOnce(type, 'invalid scopeKey'); return NOOP_HANDLE; }

  // Step 0: deferred startup sweep (own transactions, before begin's).
  if (_store._recoveryPending) {
    const r = _store.recover(_now());
    if (!r.ok) return r.code === 'busy' ? BUSY_NOOP : NOOP_HANDLE;
    _store._recoveryPending = false;
  }
  // Step 1: prune gate (own transaction, before begin's).
  const t = _now();
  if (t - _store._lastPrune >= PRUNE_EVERY_MS) {
    _store._lastPrune = t;
    const p = _store.prune(t);
    if (!p.ok && p.code === 'busy') return BUSY_NOOP;
  }
  // Step 2: begin's own transaction.
  const r = _store.begin(type, scopeKey, def);
  if (!r.ok) return r.code === 'busy' ? BUSY_NOOP : NOOP_HANDLE;
  if (r.kind === 'busy') {
    if (r.row) _infoJobOnce(r.row.id, '[jobs] ' + type + ' job ' + r.row.id + ' busy (owned by a live run); running non-durably');
    return BUSY_NOOP;
  }
  if (r.kind === 'blocked') {
    _infoJobOnce(r.row.id, '[jobs] ' + type + ' job ' + r.row.id + ' blocked (' + r.state + '); running non-durably');
    return _blocked(r.state);
  }
  return createHandle(_store, { row: r.row, def, type, resumed: r.resumed, checkpoints: r.checkpoints, log: _log() });
}

function _typeModes() {
  const out = {};
  for (const t of JOB_TYPES) {
    const adopted = types.ADOPTED[t] === true;
    const flag = !!(_flags && _flags.enabled && _flags.types[t]);
    const effective = !!(_flags && _flags.effective[t]);
    let mode = 'off';
    if (!adopted) mode = 'deferred';
    else if (effective) mode = _mode === 'active' ? 'durable' : (_mode === 'degraded' ? 'legacy' : 'off');
    out[t] = { flag, effective: effective && _mode === 'active', adopted, mode };
  }
  return out;
}

function getStatus() {
  return {
    mode: _mode,
    reason: _status && _status.reason ? _status.reason : null,
    recovery: _status && _status.recovery ? _status.recovery : null,
    recoveryPending: !!(_store && _store._recoveryPending),
    lastRecovery: _store ? _store.lastRecovery : null,
    lastError: _store && _store.lastError ? { message: _store.lastError.message, at: _store.lastError.at, code: _store.lastError.code } : null,
  };
}

function getSummary(now) {
  const base = {
    mode: _mode,
    reason: _status && _status.reason ? _status.reason : null,
    types: _typeModes(),
  };
  if (_mode !== 'active' || !_store) {
    return Object.assign(base, {
      counts: {}, totals: { open: 0, recoveryRequired: 0, failed24h: 0, foreign: 0 },
      oldestRunning: null, recoveryRequiredCount: 0, recoveryRequired: [], lastRecovery: null, lastError: null,
    });
  }
  return Object.assign(base, _store.summary(now != null ? now : _now()));
}

function reconcile(id, outcome) {
  if (_mode !== 'active' || !_store) return { ok: false, code: 'off' };
  return _store.reconcile(id, outcome);
}

// True when begin() for this type can return a durable handle (mode active,
// type flagged + adopted). No SQL.
function isEffective(type) {
  if (_mode !== 'active' || !_store || !types.get(type)) return false;
  return !!(_flags && _flags.effective[type] === true) || _testEffective.has(type);
}

// Read-only look at the open (non-terminal) row for (type, scope):
// { id, state, attempt, checkpoint, settled } or null. null (and no SQL)
// unless mode is active and the type is effective.
function peek(args) {
  const a = args || {};
  if (!isEffective(a.type)) return null;
  if (typeof a.scopeKey !== 'string' || !SCOPE_RE.test(a.scopeKey)) return null;
  const r = _store.peekOpen(a.type, a.scopeKey);
  return r && r.ok ? r.row : null;
}

function _resetForTests(opts = {}) {
  if (_store) _store._stopAllTimersForTests();
  _store = null; _mode = 'off'; _status = null; _degradedLogged = false; _flags = null;
  _testOverrides = { owner: opts.owner, now: opts.now, flags: opts.flags, adapter: opts.adapter, logger: opts.logger };
  _testEffective = new Set();
  _warnedTypes = new Set();
  _infoOnce = new Set();
  schema._resetForTests();
}

function _registerTypeForTests(name, def) {
  types._registerTypeForTests(name, def);
  _testEffective.add(name);
}

function _storeForTests() { return _store; }

module.exports = {
  init, begin, getStatus, getSummary, reconcile, isEffective, peek, NOOP_HANDLE,
  BOOT_ID, OWNER, engineAdapter,
  _resetForTests, _registerTypeForTests, _storeForTests,
};
