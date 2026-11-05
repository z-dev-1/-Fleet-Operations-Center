'use strict';
/**
 * ipc/long-dwell-ai.js — durable Long Dwell AI Fill IPC (Phase 7 follow-up).
 *
 *   long-dwell-ai:status      ()                                   -> { ok, durable, day, pending, filledToday }
 *   long-dwell-ai:plan        ({ table, resume?, units })          -> { ok, runId, durable, resumed, busy, toFill, skipped, counts }
 *   long-dwell-ai:unit-start  ({ runId, key })                     -> { ok }
 *   long-dwell-ai:commit      ({ runId|null, table, key, fp, result, force?, base?, failed? }) -> { ok, outcome, ... }
 *   long-dwell-ai:finish      ({ runId, aborted?, error? })        -> { ok, counts }
 *   long-dwell-ai:today       ({ table })                          -> { ok, day, entries }
 *
 * Thin layer over src/jobs/long-dwell-ai-fill.js. With the flag off (or the
 * jobs layer degraded) every channel except status returns
 * { ok:false, code:'off' } and nothing touches a store, SQLite or a timer.
 * The 60 s idle sweep is created lazily on the first successful plan.
 */

const { handle, requireObject, requireStringMax } = require('./_safe');
const { ConfigError } = require('../utils/errors');

const TABLES = ['computed', 'csv'];
const MAX_UNITS = 5000;
const MAX_KEY = 256;
const MAX_FP = 64;
const MAX_RUN_ID = 64;
const SWEEP_MS = 60 * 1000;

let _core = null;
let _sweepTimer = null;

function _getCore() {
  if (!_core) _core = require('../jobs/long-dwell-ai-fill').getDefaultCore();
  return _core;
}

function _table(v) {
  if (typeof v !== 'string' || !TABLES.includes(v)) throw new ConfigError('table must be one of ' + TABLES.join(', '), 'table');
  return v;
}
function _key(v) {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_KEY) throw new ConfigError('key must be a non-empty string of at most ' + MAX_KEY + ' characters', 'key');
  return v;
}
function _fp(v) {
  if (typeof v !== 'string' || v.length > MAX_FP) throw new ConfigError('fp must be a string of at most ' + MAX_FP + ' characters', 'fp');
  return v;
}
function _runId(v, nullable) {
  if (nullable && v == null) return null;
  return requireStringMax(v, 'runId', MAX_RUN_ID);
}
function _units(v) {
  if (!Array.isArray(v)) throw new ConfigError('units must be an array', 'units');
  if (v.length > MAX_UNITS) throw new ConfigError('units exceeds maximum batch size of ' + MAX_UNITS + ' (got ' + v.length + ')', 'units');
  for (const u of v) {
    requireObject(u, 'unit');
    _key(u.key); _fp(u.fp);
  }
  return v;
}
function _result(v) {
  if (v == null) return null;
  requireObject(v, 'result');
  for (const f of ['delayReason', 'escalation', 'summary']) {
    if (v[f] != null && typeof v[f] !== 'string') throw new ConfigError('result.' + f + ' must be a string', 'result');
  }
  return v;
}

function _ensureSweep(core) {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => { try { core.sweepIdle(); } catch (_) {} }, SWEEP_MS);
  if (_sweepTimer.unref) _sweepTimer.unref();
}

function registerLongDwellAiIPC() {
  handle('long-dwell-ai:status', () => _getCore().status());

  handle('long-dwell-ai:plan', (e, payload) => {
    requireObject(payload, 'payload');
    const core = _getCore();
    const res = core.plan({ table: _table(payload.table), resume: payload.resume === true, units: _units(payload.units) });
    if (res && res.ok && res.runId) {
      _ensureSweep(core);
      // A destroyed renderer never finishes its run: cancel it (nothing is
      // lost — resume truth is the per-unit fill records).
      try {
        const sender = e && e.sender;
        if (sender && typeof sender.once === 'function') sender.once('destroyed', () => { try { core.cancelRun(res.runId, 'renderer destroyed'); } catch (_) {} });
      } catch (_) {}
    }
    return res;
  });

  handle('long-dwell-ai:unit-start', (_e, payload) => {
    requireObject(payload, 'payload');
    return _getCore().unitStart({ runId: _runId(payload.runId), key: _key(payload.key) });
  });

  handle('long-dwell-ai:commit', (_e, payload) => {
    requireObject(payload, 'payload');
    const a = {
      runId: _runId(payload.runId, true),
      table: _table(payload.table),
      key: _key(payload.key),
      fp: _fp(payload.fp),
      result: _result(payload.result),
      force: payload.force === true,
      failed: payload.failed === true,
    };
    if (payload.base != null) a.base = requireObject(payload.base, 'base');
    if (payload.equipmentId != null) a.equipmentId = requireStringMax(String(payload.equipmentId), 'equipmentId', 32);
    if (payload.woKey != null) a.woKey = requireStringMax(String(payload.woKey), 'woKey', 128);
    if (payload.isPrimary === true) a.isPrimary = true;
    return _getCore().commit(a);
  });

  handle('long-dwell-ai:finish', (_e, payload) => {
    requireObject(payload, 'payload');
    const error = payload.error != null ? String(payload.error).slice(0, 500) : undefined;
    return _getCore().finish({ runId: _runId(payload.runId), aborted: payload.aborted === true, error });
  });

  handle('long-dwell-ai:today', (_e, payload) => {
    requireObject(payload, 'payload');
    return _getCore().today({ table: _table(payload.table) });
  });
}

function _resetForTests(core) {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = null;
  _core = core || null;
}
function _sweepTimerForTests() { return _sweepTimer; }

module.exports = { registerLongDwellAiIPC, _resetForTests, _sweepTimerForTests };
