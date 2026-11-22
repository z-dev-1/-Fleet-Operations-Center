'use strict';
/**
 * src/aperia/client.js — READ-ONLY Aperia client on top of transport.getJson (GET, allow-listed paths).
 *
 * - _get: one session.reauth + one retry on APERIA_SESSION_EXPIRED / APERIA_SIGNIN_REQUIRED; concurrent
 *   callers share the reauth.
 * - Unit index (memory only): unitKey -> vehicle id, built from /vehicles pages on the first lookup,
 *   reused for C.INDEX_TTL_MS, rebuilt once on a miss when older than C.INDEX_MISS_REBUILD_MS.
 * - Bulk / full-fleet tire pulls run a worker pool of C.CONCURRENCY.
 * - DTNA cross-link reads the dtna case cache (src/dtna/store) only; never the DTNA client or session.
 * Logs carry op names, counts, codes and ms only.
 */
const C = require('./constants');
const P = require('./parsers');
const { normUnit } = require('../dtna/join');
const { fmtEt } = require('./rules');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

// Test seam: { transport, session, dtnaStore, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _transport() { return _deps.transport || require('./transport'); }
function _session() { return _deps.session || require('./session'); }
function _dtnaStore() { return _deps.dtnaStore || require('../dtna/store'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }

const FATAL = new Set(['APERIA_SIGNIN_REQUIRED', 'APERIA_SESSION_EXPIRED']);

// ── GET with one reauth + one retry ────────────────────────────────────────
let _reauthP = null;
let _authGen = 0;

function _reauth(ctx) {
  if (!_reauthP) {
    _reauthP = Promise.resolve()
      .then(() => _session().reauth(ctx))
      .then((r) => { if (r && r.ok) _authGen++; return r; })
      .catch((e) => { log.warn('[aperia] reauth', safeErr(e)); return { ok: false, code: 'APERIA_SESSION_EXPIRED' }; })
      .finally(() => { _reauthP = null; });
  }
  return _reauthP;
}

/**
 * _get(path, ctx) -> transport result; on APERIA_SESSION_EXPIRED (a 401) or APERIA_SIGNIN_REQUIRED (no
 * Bearer held, e.g. it expired in memory): reauth once (a hidden background sign-in), retry once.
 */
async function _get(apiPath, ctx) {
  const gen = _authGen;
  const r = await _transport().getJson(apiPath);
  if (r && !r.ok && FATAL.has(r.code)) {
    if (_authGen === gen) {
      const a = await _reauth(ctx);
      if (!a || !a.ok) return { ok: false, code: r.code };
    }
    return _transport().getJson(apiPath);
  }
  return r;
}

function _aborted(signal) { return !!(signal && signal.aborted); }

/** _allPages(pathFn, parse, {ctx, signal}) -> { ok:true, rows, totalPages, totalElements } | { ok:false, code } */
async function _allPages(pathFn, parse, opts) {
  const o = opts || {};
  const rows = [];
  let totalPages = 1;
  let totalElements = 0;
  for (let page = 0; page < Math.min(totalPages, C.MAX_PAGES); page++) {
    if (_aborted(o.signal)) return { ok: false, code: 'APERIA_CANCELLED', cancelled: true };
    const r = await _get(pathFn(page), o.ctx);
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'APERIA_INTERNAL' };
    const p = parse(r.value);
    if (!p.ok) return { ok: false, code: p.code };
    if (page === 0) { totalPages = Math.max(1, p.totalPages); totalElements = p.totalElements; }
    rows.push(...p.rows);
  }
  return { ok: true, rows, totalPages, totalElements };
}

// ── Unit index ─────────────────────────────────────────────────────────────
let _index = null;   // { map: Map(unitKey -> id), rows, builtAt }
let _indexP = null;

/** buildIndex(ctx, {force, signal}) -> { ok:true, size } | { ok:false, code } (single-flight). */
function buildIndex(ctx, opts) {
  const o = opts || {};
  if (_indexP) return _indexP;
  if (!o.force && _index && _now() - _index.builtAt < C.INDEX_TTL_MS) return Promise.resolve({ ok: true, size: _index.map.size });
  const t0 = Date.now();
  _indexP = (async () => {
    const r = await _allPages(C.vehiclesPath, P.parseVehiclesPage, { ctx, signal: o.signal });
    if (!r.ok) {
      log.warn('[aperia] index', { op: 'index', code: r.code, ms: Date.now() - t0 });
      return { ok: false, code: r.code };
    }
    const map = new Map();
    for (const row of r.rows) if (row.unitKey && !map.has(row.unitKey)) map.set(row.unitKey, row.id);
    _index = { map, rows: r.rows, builtAt: _now() };
    log.info('[aperia] index', { op: 'index', size: map.size, pages: r.totalPages, ms: Date.now() - t0 });
    return { ok: true, size: map.size };
  })().finally(() => { _indexP = null; });
  return _indexP;
}

/** indexRows() -> the vehicle rows of the current index (copy) | []. */
function indexRows() { return _index ? _index.rows.slice() : []; }

/** getVehicle(id, ctx) -> { ok:true, unit } | { ok:false, code }. */
async function getVehicle(id, ctx) {
  const p = C.vehiclePath(id);
  if (!p) return { ok: false, code: 'APERIA_INVALID_INPUT' };
  const r = await _get(p, ctx);
  if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'APERIA_INTERNAL' };
  const d = P.parseVehicleDetail(r.value, { now: _now() });
  return d.ok ? { ok: true, unit: d.unit } : { ok: false, code: d.code };
}

/** lookupUnit(assetId, ctx, {signal}) -> { ok:true, unit } | { ok:false, code } (APERIA_UNIT_NOT_FOUND on a miss). */
async function lookupUnit(assetId, ctx, opts) {
  const key = P.unitKey(assetId);
  if (!key) return { ok: false, code: 'APERIA_INVALID_INPUT' };
  const signal = opts && opts.signal;
  const b = await buildIndex(ctx, { signal });
  if (!b.ok) return b;
  let id = _index.map.get(key);
  if (!id && _now() - _index.builtAt > C.INDEX_MISS_REBUILD_MS) {
    const r = await buildIndex(ctx, { force: true, signal });
    if (!r.ok) return r;
    id = _index.map.get(key);
  }
  if (!id) return { ok: false, code: 'APERIA_UNIT_NOT_FOUND' };
  return getVehicle(id, ctx);
}

// ── Issues feed ────────────────────────────────────────────────────────────
/** listIssues(ctx, {signal}) -> { ok:true, rows (flattened), vehicles, domiciles, pulledAt } | { ok:false, code }. */
async function listIssues(ctx, opts) {
  const t0 = Date.now();
  const r = await _allPages(C.issuesByVehiclePath, P.parseIssuesPage, { ctx, signal: opts && opts.signal });
  if (!r.ok) {
    log.warn('[aperia] issues', { op: 'issues', code: r.code, ms: Date.now() - t0 });
    return { ok: false, code: r.code };
  }
  const rows = P.flattenIssues(r.rows);
  const pulledAt = new Date(_now()).toISOString();
  try { _session().notePull(pulledAt); } catch (_) {}
  log.info('[aperia] issues', { op: 'issues', vehicles: r.rows.length, issues: rows.length, ms: Date.now() - t0 });
  return { ok: true, rows, vehicles: r.rows.length, domiciles: P.domicilesOf(r.rows), pulledAt };
}

// ── Worker pool ────────────────────────────────────────────────────────────
/**
 * _pool(items, job, {onProgress, signal, op}) -> { ok, results, total, failed, cancelled, code? }
 * job(item) -> { assetId, found, unit?, code? }. A fatal code stops scheduling; abort -> cancelled.
 */
async function _pool(items, job, opts) {
  const o = opts || {};
  const total = items.length;
  const results = new Array(total);
  let next = 0;
  let done = 0;
  let failed = 0;
  let fatal = null;
  const t0 = Date.now();
  const progress = () => {
    if (typeof o.onProgress !== 'function') return;
    try { o.onProgress({ done, total, failed }); } catch (e) { log.warn('[aperia] progress', safeErr(e)); }
  };
  async function worker() {
    while (!fatal && !_aborted(o.signal) && next < total) {
      const i = next++;
      let r;
      try { r = await job(items[i]); } catch (e) { log.warn('[aperia] ' + o.op, safeErr(e)); r = { found: false, code: 'APERIA_INTERNAL' }; }
      results[i] = r;
      done++;
      if (!r.found) {
        failed++;
        if (FATAL.has(r.code) && !fatal) fatal = r.code;
      }
      progress();
    }
  }
  const n = Math.min(C.CONCURRENCY, total);
  await Promise.all(Array.from({ length: n }, worker));
  const cancelled = !fatal && _aborted(o.signal) && done < total;
  const out = { ok: !fatal, results: results.filter(Boolean), total, failed, cancelled };
  if (fatal) out.code = fatal;
  log.info('[aperia] ' + o.op, { op: o.op, total, done, failed, cancelled, code: fatal || 'OK', ms: Date.now() - t0 });
  return out;
}

function _result(assetId, r) {
  return r.ok ? { assetId, found: true, unit: r.unit } : { assetId, found: false, code: r.code };
}

/** bulkLookup(list, {ctx, onProgress, signal}) -> pool result over unit ids. */
async function bulkLookup(list, opts) {
  const o = opts || {};
  const items = (Array.isArray(list) ? list : []).map((s) => String(s ?? ''));
  return _pool(items, async (assetId) => _result(assetId, await lookupUnit(assetId, o.ctx, { signal: o.signal })),
    { onProgress: o.onProgress, signal: o.signal, op: 'bulk' });
}

/** fleetTires({ctx, onProgress, signal}) -> pool result over every vehicle of a fresh index. */
async function fleetTires(opts) {
  const o = opts || {};
  const b = await buildIndex(o.ctx, { force: true, signal: o.signal });
  if (!b.ok) {
    const cancelled = b.code === 'APERIA_CANCELLED';
    return cancelled
      ? { ok: true, results: [], total: 0, failed: 0, cancelled: true }
      : { ok: false, results: [], total: 0, failed: 0, cancelled: false, code: b.code };
  }
  const rows = indexRows();
  return _pool(rows, async (row) => _result(row.fleetVehicleId, await getVehicle(row.id, o.ctx)),
    { onProgress: o.onProgress, signal: o.signal, op: 'fleet' });
}

// ── DTNA cross-link ────────────────────────────────────────────────────────
function _isClosed(e) { return /closed/i.test(String((e && e.caseStatus) ?? '')); }
function _ms(v) { const ms = Date.parse(String(v || '')); return Number.isFinite(ms) ? ms : 0; }

/**
 * crossLinkCriticalNoCase(issueRows, {dtnaEntries, fleetRows}) -> rows, newest first.
 * A unit is listed when it has >= 1 non-muted CRITICAL issue and no DTNA case for the same normUnit whose
 * caseStatus is not /closed/i (closed-only counts as no case).
 */
function crossLinkCriticalNoCase(issueRows, opts) {
  const o = opts || {};
  const entries = (Array.isArray(o.dtnaEntries) ? o.dtnaEntries : []).filter((e) => e && typeof e === 'object');
  const fleet = new Set((Array.isArray(o.fleetRows) ? o.fleetRows : [])
    .filter((r) => r && typeof r === 'object').map((r) => normUnit(r.equipmentId)).filter(Boolean));
  const byUnit = new Map();
  for (const x of Array.isArray(issueRows) ? issueRows : []) {
    if (!x || x.severity !== 'CRITICAL' || x.muted === true) continue;
    const k = normUnit(x.fleetVehicleId);
    if (!k) continue;
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(x);
  }
  const out = [];
  for (const [k, list] of byUnit) {
    const cases = entries.filter((e) => normUnit(e.unitId) === k);
    if (cases.some((e) => !_isClosed(e))) continue;
    const latest = list.reduce((a, x) => (_ms(x.dateDetected) > _ms(a) ? x.dateDetected : a), '');
    out.push({
      fleetVehicleId: list[0].fleetVehicleId,
      domicile: list[0].domicile || '',
      criticalCount: list.length,
      states: Array.from(new Set(list.map((x) => x.state).filter(Boolean))),
      positions: Array.from(new Set(list.map((x) => x.positionName || x.position).filter(Boolean))),
      latestDetected: latest,
      latestDetectedEt: fmtEt(latest),
      inFleet: fleet.has(k),
      closedDtnaCases: cases.length,
    });
  }
  return out.sort((a, b) => _ms(b.latestDetected) - _ms(a.latestDetected));
}

/** criticalNoCase(ctx, {fleetRows, signal}) -> { ok:true, rows, domiciles, pulledAt, count } | { ok:false, code }. */
async function criticalNoCase(ctx, opts) {
  const o = opts || {};
  const li = await listIssues(ctx, { signal: o.signal });
  if (!li.ok) return li;
  let dtnaEntries = [];
  try { dtnaEntries = _dtnaStore().all() || []; } catch (e) { log.warn('[aperia] crosslink', safeErr(e)); }
  const rows = crossLinkCriticalNoCase(li.rows, { dtnaEntries, fleetRows: o.fleetRows });
  log.info('[aperia] crosslink', { op: 'crosslink', issues: li.rows.length, cases: dtnaEntries.length, rows: rows.length });
  return { ok: true, rows, domiciles: P.domicilesOf(rows), pulledAt: li.pulledAt, count: rows.length };
}

function _resetForTests() { _deps = {}; _index = null; _indexP = null; _reauthP = null; _authGen = 0; }

module.exports = {
  _get, _allPages, buildIndex, indexRows, getVehicle, lookupUnit, listIssues, bulkLookup, fleetTires,
  crossLinkCriticalNoCase, criticalNoCase, _setDeps, _resetForTests,
};
