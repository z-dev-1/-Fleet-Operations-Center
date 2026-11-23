'use strict';
/**
 * src/aperia/sync-read.js — the sync cycle's Aperia issues read, scoped to the user's fleet-row units.
 *
 *   run({ rows, ctx }) -> Promise<{ ok:true, issues, critNoCase } | { skipped:'signed-out'|'fresh' } | { ok:false, code }>
 *     Single-flight. Makes no call unless the Aperia session is connected, and at most one call per
 *     SYNC_READ_MIN_MS (15 min) after a successful read. One client.listIssues (read only); the warm cache
 *     keeps the issues on fleet-row units (normUnit(fleetVehicleId) in the rows) and the in-fleet
 *     "critical tire, no open DTNA case" cross-link.
 *   cached() -> { pulledAt, issues, crossLink } (a copy) | null. Served by the issues IPC with { cached:true }.
 *
 * Called from src/sync/index.js after each sync (never awaited). Logs: counts, code, ms only.
 */
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const SYNC_READ_MIN_MS = 15 * 60e3;

// Test seam: { session, client, dtnaStore, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _session() { return _deps.session || require('./session'); }
function _client() { return _deps.client || require('./client'); }
function _dtnaStore() { return _deps.dtnaStore || require('../dtna/store'); }
function _scope() { return require('./fleet-scope'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }

let _cache = null;
let _lastOkAt = 0;
let _runP = null;

async function _doRun(o) {
  let st = null;
  try { st = _session().status(); } catch (_) { st = null; }
  if (!st || st.state !== 'connected') return { skipped: 'signed-out' };
  if (_lastOkAt && _now() - _lastOkAt < SYNC_READ_MIN_MS) return { skipped: 'fresh' };
  const t0 = Date.now();
  const ctx = o.ctx || null;
  let li;
  try { li = await _client().listIssues(ctx); } catch (e) { log.warn('[aperia] sync-read', { op: 'issues', code: 'APERIA_INTERNAL', err: safeErr(e) }); li = null; }
  if (!li || !li.ok) {
    const code = String((li && li.code) || 'APERIA_INTERNAL').slice(0, 40);
    log.info('[aperia] sync-read', { op: 'issues', code, ms: Date.now() - t0 });
    return { ok: false, code };
  }
  const all = Array.isArray(li.rows) ? li.rows : [];
  const rows = Array.isArray(o.rows) && o.rows.length ? o.rows : null;
  const S = _scope();
  const scope = rows ? S.fromRows(rows) : S.fleetUnitSet(ctx);
  const issues = all.filter((r) => r && S.inScope(scope, r.fleetVehicleId));
  let dtnaEntries = [];
  try { dtnaEntries = _dtnaStore().all() || []; } catch (e) { log.warn('[aperia] sync-read', { op: 'dtna', code: 'APERIA_INTERNAL', err: safeErr(e) }); }
  let fleetRows = rows;
  if (!fleetRows) fleetRows = Array.from(scope).map((k) => ({ equipmentId: k }));
  let crossLink = [];
  try {
    crossLink = (_client().crossLinkCriticalNoCase(all, { dtnaEntries, fleetRows }) || []).filter((r) => r && r.inFleet);
  } catch (e) { log.warn('[aperia] sync-read', { op: 'crosslink', code: 'APERIA_INTERNAL', err: safeErr(e) }); }
  _cache = { pulledAt: li.pulledAt || new Date(_now()).toISOString(), issues, crossLink };
  _lastOkAt = _now();
  log.info('[aperia] sync-read', { op: 'issues', issues: all.length, scoped: issues.length, critNoCase: crossLink.length, code: 'OK', ms: Date.now() - t0 });
  return { ok: true, issues: issues.length, critNoCase: crossLink.length };
}

function run(opts) {
  if (_runP) return _runP;
  _runP = _doRun(opts || {})
    .catch((e) => { log.warn('[aperia] sync-read', { op: 'issues', code: 'APERIA_INTERNAL', err: safeErr(e) }); return { ok: false, code: 'APERIA_INTERNAL' }; })
    .finally(() => { _runP = null; });
  return _runP;
}

function cached() {
  if (!_cache) return null;
  return { pulledAt: _cache.pulledAt, issues: _cache.issues.slice(), crossLink: _cache.crossLink.slice() };
}

function _resetForTests() { _deps = {}; _cache = null; _lastOkAt = 0; _runP = null; }

module.exports = { run, cached, SYNC_READ_MIN_MS, _setDeps, _resetForTests };
