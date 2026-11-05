'use strict';
/**
 * jobs/long-dwell-ai-fill.js — durable arbiter for the Long Dwell "AI Fill"
 * loop (Phase 7 follow-up; plan.md Decisions 1-9).
 *
 * The AI loop itself stays in the renderer (it needs the signed-in session,
 * live fleet rows and the Relay refresh). Main decides which units to fill,
 * commits each AI result atomically with provenance, and runs the job ledger,
 * so a fill is only "done" once main has committed it:
 *
 *   plan({ table, units, resume? })  -> which units to fill / skip (+ runId)
 *   unitStart({ runId, key })        -> checkpoint 'in_progress' (crash-loop guard)
 *   commit({ runId|null, table, key, fp, result, force?, base? })
 *                                    -> compare-and-write the annotation, then the
 *                                       fill record, then the unit checkpoint
 *   finish({ runId, aborted?, error? }) -> complete / fail the job, final counts
 *   today({ table })                 -> records still valid today (badges)
 *   status()                         -> durable flag, recovered runs, filled-today counts
 *   sweepIdle(now?) / cancelRun(runId, reason)
 *
 * Inert unless jobs.isEffective('longDwellAiFill') (jobs.durable.enabled AND
 * jobs.longDwellAiFill.durable, mode active): every method except status()
 * returns { ok:false, code:'off' } without touching any store or SQL.
 *
 * Tables: 'computed' (longDwellStore, key '<equipmentId>::<woKey>', mirrors
 * long-dwell:save-unit) and 'csv' (longDwellCsv.rows[rowKey].manual, mirrors
 * long-dwell-csv:save-row). Records live in the host-local longDwellAiFills
 * store: { version:1, entries: { '<table>|<key>': { table, key, day, filledAt,
 * fp, outHash, jobId, fields, assetId?, site? } } }.
 */

const crypto = require('crypto');
const { DELAY_REASONS, ESCALATION_LEVELS } = require('../ipc/long-dwell');

const TYPE = 'longDwellAiFill';
const TABLES = ['computed', 'csv'];
const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;
const IDLE_MS = 15 * MIN;
const PRUNE_MS = 14 * DAY_MS;
const MAX_UNITS = 5000;
const MAX_KEY = 256;
const MAX_FP = 64;
const MAX_CKPT = 16 * 1024;
const SUMMARY_MAX = { computed: 4000, csv: 8000 };
const MAX_EQ = 32;
const MAX_WO = 128;
const FILLS_KEY = 'longDwellAiFills';
const STORE_KEY = { computed: 'longDwellStore', csv: 'longDwellCsv' };
const FIELD_NAMES = ['delayReason', 'escalation', 'summary'];
const OFF = Object.freeze({ ok: false, code: 'off' });

class _Abort extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function _pad(n) { return String(n).padStart(2, '0'); }
// Local calendar day of the main process.
function localDay(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
}
function _t(v) { return String(v == null ? '' : v).trim(); }
// Hash of the three AI-owned values as stored (trimmed).
function valuesHash(vals) {
  return crypto.createHash('sha1').update(JSON.stringify((vals || []).slice(0, 3).map(_t))).digest('hex');
}
function _ldKey(equipmentId, woKey) {
  const eq = String(equipmentId || '').trim();
  const wo = String(woKey || 'primary').trim() || 'primary';
  return eq + '::' + wo;
}
function _splitKey(key) {
  const i = String(key).indexOf('::');
  return i < 0 ? { equipmentId: String(key), woKey: 'primary' } : { equipmentId: key.slice(0, i), woKey: key.slice(i + 2) };
}
function _bad(error) { return { ok: false, code: 'bad-input', error }; }
function _validTable(t) { return typeof t === 'string' && TABLES.includes(t); }
function _defaultAnn(table) { return table === 'csv' ? { importedAt: null, columns: [], rows: {} } : {}; }
function _normFills(f) {
  const o = f && typeof f === 'object' && !Array.isArray(f) ? f : {};
  if (!o.entries || typeof o.entries !== 'object' || Array.isArray(o.entries)) o.entries = {};
  o.version = 1;
  return o;
}
function _genRunId() { return 'ldr_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }

// Unit identity as the renderer sends it. Returns null when invalid.
function _normUnit(table, u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const key = u.key;
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY) return null;
  if (typeof u.fp !== 'string' || u.fp.length > MAX_FP) return null;
  if (table === 'csv') return { key, fp: u.fp };
  const sp = _splitKey(key);
  const equipmentId = u.equipmentId != null ? String(u.equipmentId).trim() : sp.equipmentId.trim();
  const woKey = u.woKey != null ? (String(u.woKey).trim() || 'primary') : (sp.woKey.trim() || 'primary');
  if (!equipmentId || equipmentId.length > MAX_EQ || woKey.length > MAX_WO) return null;
  if (_ldKey(equipmentId, woKey) !== key) return null;
  return { key, fp: u.fp, equipmentId, woKey, isPrimary: u.isPrimary === true };
}

// Current AI-owned values for a unit, read the way the renderer displays them.
function _readUnit(table, ann, unit) {
  if (table === 'csv') {
    const r = ann && ann.rows && ann.rows[unit.key];
    if (!r) return { found: false, vals: ['', '', ''] };
    const m = r.manual || {};
    return { found: true, vals: [m.delayReason || '', m.escalationAction || '', m.notes || ''], assetId: r.assetId, site: r.site };
  }
  const s = ann || {};
  const ex = s[unit.key] || (unit.isPrimary ? s[unit.equipmentId] : null) || {};
  return { found: true, vals: [ex.delayReason || '', ex.escalationLevel || '', ex.summary || ''] };
}
// Same test the legacy "AI Fill All (blank rows)" filter applies.
function _isBlank(vals) { return !vals[0] && !vals[1] && !String(vals[2] || '').trim(); }

function _recordFor(table, fills, unit, cur) {
  const rec = fills.entries[table + '|' + unit.key];
  if (!rec || typeof rec !== 'object') return null;
  // CSV rowKeys embed an import-order index: trust a record only while the
  // row still carries the same asset + site.
  if (table === 'csv' && (rec.assetId !== cur.assetId || rec.site !== cur.site)) return null;
  return rec;
}

// Re-validate an AI result: enums or '', summary clipped like the legacy writers.
function _cleanResult(table, res) {
  if (!res || typeof res !== 'object') return null;
  for (const f of FIELD_NAMES) if (res[f] != null && typeof res[f] !== 'string') return null;
  let dr = _t(res.delayReason);
  let esc = _t(res.escalation).toUpperCase();
  const sum = _t(res.summary).slice(0, SUMMARY_MAX[table]);
  if (!DELAY_REASONS.includes(dr)) dr = '';
  if (!ESCALATION_LEVELS.includes(esc)) esc = '';
  return [dr, esc, sum];
}

function _emptyCounts(units) {
  return { units, planned: 0, filledToday: 0, edited: 0, hasContent: 0, crashLoop: 0, duplicate: 0, notFound: 0,
    filled: 0, failed: 0, editedDuringRun: 0, notRun: 0 };
}
const SKIP_COUNT = { 'filled-today': 'filledToday', edited: 'edited', 'has-content': 'hasContent', 'crash-loop': 'crashLoop', duplicate: 'duplicate', 'not-found': 'notFound' };

function createCore(deps) {
  const d = deps || {};
  const jobs = d.jobs;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const log = d.log || { debug() {}, info() {}, warn() {}, error() {} };
  const genRunId = typeof d.genRunId === 'function' ? d.genRunId : _genRunId;
  const runs = new Map();          // runId -> run
  const liveByTable = new Map();   // table -> runId

  function _durable() { try { return !!(jobs && jobs.isEffective(TYPE)); } catch (_) { return false; } }
  function _loadAnn(table) { return d.loadAnnotations(table) || _defaultAnn(table); }
  function _loadFills() { return _normFills(d.loadFills()); }

  // Plan-time decision for one unit (plan.md Decision 1 + 2).
  function _decide(table, unit, ann, fills, day) {
    const cur = _readUnit(table, ann, unit);
    if (!cur.found) return { skip: 'not-found', cur };
    if (_isBlank(cur.vals)) return { fill: 'blank', cur };
    const rec = _recordFor(table, fills, unit, cur);
    if (!rec) return { skip: 'has-content', cur };
    if (valuesHash(cur.vals) !== rec.outHash) return { skip: 'edited', cur };
    if (rec.day !== day) return { fill: 'refresh-day', cur };
    if (rec.fp !== unit.fp) return { fill: 'inputs-changed', cur };
    return { skip: 'filled-today', cur };
  }

  function _validToday(table, rec, ann, day) {
    if (!rec || rec.table !== table || rec.day !== day || typeof rec.key !== 'string') return false;
    const unit = table === 'csv' ? { key: rec.key } : Object.assign({ key: rec.key, isPrimary: false }, _splitKey(rec.key));
    const cur = _readUnit(table, ann, unit);
    if (!cur.found) return false;
    if (table === 'csv' && (rec.assetId !== cur.assetId || rec.site !== cur.site)) return false;
    return valuesHash(cur.vals) === rec.outHash;
  }

  function _drop(run) {
    runs.delete(run.id);
    if (liveByTable.get(run.table) === run.id) liveByTable.delete(run.table);
  }

  function plan(args) {
    if (!_durable()) return OFF;
    const a = args || {};
    if (!_validTable(a.table)) return _bad('invalid table');
    if (!Array.isArray(a.units) || a.units.length > MAX_UNITS) return _bad('units must be an array of at most ' + MAX_UNITS);
    const table = a.table;
    const units = [];
    for (const u of a.units) {
      const n = _normUnit(table, u);
      if (!n) return _bad('invalid unit');
      units.push(n);
    }
    const t = now();
    const day = localDay(t);
    const busy = { ok: true, busy: true, durable: true, resumed: false, runId: null, toFill: [], skipped: [], counts: _emptyCounts(units.length) };
    if (liveByTable.has(table)) return busy;
    const handle = jobs.begin({ type: TYPE, scopeKey: table + ':' + day });
    if (handle.busy) return busy;

    const ann = _loadAnn(table);
    const fills = _loadFills();
    const counts = _emptyCounts(units.length);
    const toFill = [];
    const skipped = [];
    const planned = new Map();
    const seen = new Set();
    for (const unit of units) {
      let skip = null;
      let dec = null;
      if (seen.has(unit.key)) skip = 'duplicate';
      else {
        seen.add(unit.key);
        if (handle.isUnitPoisoned(unit.key)) skip = 'crash-loop';
        else { dec = _decide(table, unit, ann, fills, day); skip = dec.skip || null; }
      }
      if (skip) { skipped.push({ key: unit.key, reason: skip }); counts[SKIP_COUNT[skip]]++; continue; }
      toFill.push({ key: unit.key, reason: dec.fill });
      planned.set(unit.key, { unit, baseHash: valuesHash(dec.cur.vals), reason: dec.fill });
    }
    counts.planned = toFill.length;

    const run = { id: genRunId(), table, day, handle, units: planned, started: new Set(), committed: new Set(), counts, lastAt: t };
    runs.set(run.id, run);
    liveByTable.set(table, run.id);
    handle.start();
    const keys = toFill.map((x) => x.key);
    let ck = { table, keys, total: keys.length };
    try { if (JSON.stringify(ck).length > MAX_CKPT) ck = { table, keys: null, total: keys.length }; } catch (_) { ck = { table, keys: null, total: keys.length }; }
    handle.setCheckpoint(ck);
    try {
      log.info('[long-dwell-ai] plan ' + table + ' ' + day + ': ' + toFill.length + ' to fill, ' + skipped.length + ' skipped' +
        (handle.resumed ? ' (resumed job ' + handle.jobId + ', attempt ' + handle.attempt + ')' : '') + (handle.durable ? '' : ' (records only)'));
    } catch (_) {}
    return { ok: true, runId: run.id, durable: !!handle.durable, resumed: !!handle.resumed, busy: false, toFill, skipped, counts: Object.assign({}, counts) };
  }

  function unitStart(args) {
    if (!_durable()) return OFF;
    const a = args || {};
    const run = runs.get(a.runId);
    if (!run) return { ok: false, code: 'unknown-run' };
    run.lastAt = now();
    if (!run.units.has(a.key)) return { ok: false, code: 'not-planned' };
    if (!run.started.has(a.key)) { run.started.add(a.key); run.handle.unitsStarted([a.key]); }
    return { ok: true };
  }

  function _apply(table, s, unit, vals, t) {
    const iso = new Date(t).toISOString();
    if (table === 'csv') {
      const r = s.rows[unit.key];
      if (!r.manual) r.manual = {};
      if (vals[0]) r.manual.delayReason = vals[0];
      if (vals[1]) r.manual.escalationAction = vals[1];
      if (vals[2]) r.manual.notes = vals[2];
      r.updatedAt = iso;
      return r;
    }
    const id = unit.equipmentId;
    const woKey = unit.woKey;
    const key = _ldKey(id, woKey);
    // Seed exactly like long-dwell:save-unit (legacy unit-only entry only for 'primary').
    const ex = s[key] || (woKey === 'primary' ? (s[id] || {}) : {});
    s[key] = {
      equipmentId: id,
      woKey,
      delayReason: vals[0] || ex.delayReason || '',
      escalationLevel: vals[1] || ex.escalationLevel || '',
      summary: vals[2] ? vals[2] : (ex.summary || ''),
      updatedAt: iso,
    };
    return s[key];
  }

  function commit(args) {
    if (!_durable()) return OFF;
    const a = args || {};
    if (!_validTable(a.table)) return _bad('invalid table');
    if (typeof a.key !== 'string' || !a.key.trim() || a.key.length > MAX_KEY) return _bad('invalid key');
    if (typeof a.fp !== 'string' || a.fp.length > MAX_FP) return _bad('invalid fp');
    const table = a.table;
    const t = now();
    let run = null;
    let unit;
    let baseHash;
    if (a.runId != null) {
      run = runs.get(a.runId);
      if (!run || run.table !== table) return { ok: false, code: 'unknown-run' };
      run.lastAt = t;
      const pu = run.units.get(a.key);
      if (!pu) return { ok: false, code: 'not-planned' };
      if (run.committed.has(a.key)) return { ok: false, code: 'duplicate' };
      run.committed.add(a.key);
      unit = Object.assign({}, pu.unit, { fp: a.fp });
      baseHash = pu.baseHash;
    } else {
      // Single-unit force path (per-row button): no run; the caller sends the
      // values it saw before the AI call so an edit made meanwhile is kept.
      if (a.force !== true) return _bad('runId required unless force');
      unit = _normUnit(table, { key: a.key, fp: a.fp, equipmentId: a.equipmentId, woKey: a.woKey, isPrimary: a.isPrimary });
      if (!unit) return _bad('invalid unit');
      const b = a.base;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return _bad('base required for a force commit');
      baseHash = valuesHash([b.delayReason, b.escalation, b.summary]);
    }

    const settle = (status, extra) => { if (run) run.handle.unitsSettled([Object.assign({ key: unit.key, status }, extra || {})]); };
    const vals = a.failed === true ? null : _cleanResult(table, a.result);
    if (!vals || (!vals[0] && !vals[1] && !vals[2])) {
      if (run) run.counts.failed++;
      settle('failed', { detail: { reason: a.failed === true ? 'ai-failed' : 'empty' } });
      return { ok: true, outcome: 'failed', reason: a.failed === true ? 'ai-failed' : 'empty' };
    }

    // 1. Compare-and-write the annotation inside ONE synchronous store.update.
    let written = null;
    let outVals = null;
    try {
      d.updateAnnotations(table, (s0) => {
        const s = s0 || _defaultAnn(table);
        const cur = _readUnit(table, s, unit);
        if (!cur.found) throw new _Abort('not-found');
        if (valuesHash(cur.vals) !== baseHash) throw new _Abort('edited-during-run');
        written = JSON.parse(JSON.stringify(_apply(table, s, unit, vals, t)));
        outVals = _readUnit(table, s, Object.assign({}, unit, { isPrimary: false })).vals;   // as stored after the write
        return s;
      });
    } catch (e) {
      if (e instanceof _Abort) {
        if (run) { if (e.reason === 'edited-during-run') run.counts.editedDuringRun++; else run.counts.notFound++; }
        settle('failed', { detail: { reason: e.reason } });
        return { ok: true, outcome: 'skipped', reason: e.reason };
      }
      if (run) run.committed.delete(unit.key);
      throw e;
    }

    // 2. Provenance record (prune > 14 days in the same update).
    const filledAt = new Date(t).toISOString();
    const rec = {
      table, key: unit.key, day: localDay(t), filledAt, fp: a.fp, outHash: valuesHash(outVals),
      jobId: run && run.handle.jobId ? run.handle.jobId : null,
      fields: FIELD_NAMES.filter((_, i) => !!vals[i]),
    };
    if (table === 'csv') { rec.assetId = written.assetId; rec.site = written.site; }
    d.updateFills((f0) => {
      const f = _normFills(f0);
      for (const k of Object.keys(f.entries)) {
        const ts = Date.parse((f.entries[k] || {}).filledAt);
        if (!(ts >= t - PRUNE_MS)) delete f.entries[k];
      }
      f.entries[table + '|' + unit.key] = rec;
      return f;
    });

    // 3. Unit checkpoint.
    if (run) run.counts.filled++;
    settle('done', { sig: a.fp.slice(0, 32) });
    const out = { ok: true, outcome: 'filled', filledAt };
    if (table === 'csv') out.row = written; else out.unit = written;
    return out;
  }

  // Every commit outcome (filled / failed / skipped) is in run.committed, so
  // the planned units never committed are the ones the run did not reach.
  function _final(run) {
    run.counts.notRun = Math.max(0, run.counts.planned - run.committed.size);
    return Object.assign({}, run.counts);
  }

  function finish(args) {
    if (!_durable()) return OFF;
    const a = args || {};
    const run = runs.get(a.runId);
    if (!run) return { ok: false, code: 'unknown-run' };
    const counts = _final(run);
    _drop(run);
    if (a.aborted === true) run.handle.fail(a.error ? String(a.error).slice(0, 500) : 'aborted');
    else run.handle.complete({ counts });
    try { log.info('[long-dwell-ai] finish ' + run.table + ': ' + JSON.stringify(counts)); } catch (_) {}
    return { ok: true, counts };
  }

  function cancelRun(runId, reason) {
    const run = runs.get(runId);
    if (!run) return false;
    _drop(run);
    run.handle.cancel(reason || 'cancelled');
    try { log.info('[long-dwell-ai] run ' + run.id + ' (' + run.table + ') cancelled: ' + (reason || 'cancelled')); } catch (_) {}
    return true;
  }

  function sweepIdle(at) {
    if (!_durable()) return OFF;
    const t = at != null ? at : now();
    let cancelled = 0;
    for (const run of Array.from(runs.values())) {
      if (t - run.lastAt > IDLE_MS && cancelRun(run.id, 'idle')) cancelled++;
    }
    return { ok: true, cancelled };
  }

  function today(args) {
    if (!_durable()) return OFF;
    const a = args || {};
    if (!_validTable(a.table)) return _bad('invalid table');
    const day = localDay(now());
    const ann = _loadAnn(a.table);
    const fills = _loadFills();
    const entries = {};
    for (const rec of Object.values(fills.entries)) {
      if (_validToday(a.table, rec, ann, day)) entries[rec.key] = { filledAt: rec.filledAt };
    }
    return { ok: true, day, entries };
  }

  function status() {
    const day = localDay(now());
    if (!_durable()) return { ok: true, durable: false, day };
    const pending = [];
    const filledToday = {};
    const fills = _loadFills();
    for (const table of TABLES) {
      if (!liveByTable.has(table)) {
        const p = jobs.peek({ type: TYPE, scopeKey: table + ':' + day });
        if (p && p.state === 'queued' && p.attempt > 0) {
          const ck = p.checkpoint || {};
          pending.push({ table, jobId: p.id, attempt: p.attempt, settled: p.settled, keys: Array.isArray(ck.keys) ? ck.keys : null });
        }
      }
      const ann = _loadAnn(table);
      let n = 0;
      for (const rec of Object.values(fills.entries)) if (_validToday(table, rec, ann, day)) n++;
      filledToday[table] = n;
    }
    return { ok: true, durable: true, day, pending, filledToday };
  }

  function _runsForTests() { return runs; }

  return { plan, unitStart, commit, finish, today, status, sweepIdle, cancelRun, _runsForTests };
}

let _default = null;
function _storeDeps() {
  const store = require('../store');
  let log;
  try { log = require('../utils/logger')('jobs:long-dwell-ai'); } catch (_) { log = undefined; }
  return {
    jobs: require('./index'),
    loadAnnotations: (table) => store.load(STORE_KEY[table], _defaultAnn(table)),
    updateAnnotations: (table, fn) => store.update(STORE_KEY[table], fn, _defaultAnn(table)),
    loadFills: () => store.load(FILLS_KEY, { version: 1, entries: {} }),
    updateFills: (fn) => store.update(FILLS_KEY, fn, { version: 1, entries: {} }),
    now: Date.now,
    log,
  };
}
// Lazily built store-backed core (nothing is required or read until first use).
function getDefaultCore() {
  if (!_default) _default = createCore(_storeDeps());
  return _default;
}
function _resetDefaultForTests() { _default = null; }

module.exports = {
  createCore, getDefaultCore, localDay, valuesHash,
  TYPE, TABLES, IDLE_MS, FILLS_KEY, STORE_KEY,
  _storeDeps, _resetDefaultForTests,
};
