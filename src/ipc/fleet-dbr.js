'use strict';
/**
 * ipc/fleet-dbr.js - Daily Call "DBR DATA": the 24-column Fleet Health DBR built from the
 * app's own fleet data (replaces the QuickSight panel).
 *
 *   fleet-dbr:status        ()                    -> { ok, enabled, aiDraft }
 *   fleet-dbr:get           ()                    -> { ok, model | null }   (null = no snapshot today)
 *   fleet-dbr:build         ()                    -> { ok, model, saved } | { ok:false, code:'no-fleet-data' }
 *   fleet-dbr:draft         ({ key })             -> { ok, key, fasActions, support, dropped, draftedAt, model?, saved } | { ok:false, code }
 *   fleet-dbr:save-edit     ({ key, col, value }) -> { ok } | { ok:false, code }
 *   fleet-dbr:reset-row     ({ key })             -> { ok } | { ok:false, code }
 *   fleet-dbr:set-fas-name  ({ name })            -> { ok, fasName } | { ok:false, code }
 *
 * Flags are read on EVERY call (loadFleetDbr). dbr.fleetData off: every channel except
 * status returns { ok:false, code:'off' } before any store access. AI sub-flag off: draft
 * returns ai-off. AI drafts are suggestions only: they are stored in the snapshot and shown
 * in the panel; nothing is sent anywhere.
 *
 * Edits are day-scoped (read side: edits.day !== today -> no per-cell edits; write side:
 * rows reset on the first write of a new day). The FAS name override persists across days.
 * There is no await between a snapshot load and its save (build / save-edit / reset-row /
 * set-fas-name), so main's event loop serializes concurrent writes without locks.
 *
 * Logs carry counts, codes, row keys (domicile|SCAC codes) and ms only - never unit text,
 * snippets, prompts, AI output or FAS names.
 */
const { handle } = require('./_safe');
const { FleetError, ConfigError } = require('../utils/errors');
const log = require('../utils/logger')('fleet-dbr');
const dbr = require('../dbr/fleet-dbr');

const MAX_KEY = 80;
const MAX_VALUE = 4000;
const MAX_NAME = 120;
const MAX_EDIT_ROWS = 300;
const MAX_IN_FLIGHT = 2;
const OFF = Object.freeze({ ok: false, code: 'off' });
const SNAP = 'fleetDbrSnapshot';
const EDITS = 'fleetDbrEdits';

let _o = {};
let _ctx = null;
let _inFlight = 0;

function _flags() {
  const load = _o.loadFlags || require('../config/perf-flags').loadFleetDbr;
  return load() || {};
}
function _store() { return _o.store || require('../store'); }
function _now() { return (_o.now || (() => new Date()))(); }
function _today() {
  const d = _now();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _ask() {
  if (_o.ask) return _o.ask;
  return (p, o) => require('../orcha/relay').askWithTimeout(p, { source: 'fleet_dbr', priority: 'normal', timeoutMs: 90000, ...o });
}
function _getFleet() {
  if (_o.getFleet) return _o.getFleet();
  const ld = _ctx && _ctx.lastData;
  if (ld && Array.isArray(ld.rows) && ld.rows.length) return ld;
  return _store().load('fleetData', {}) || {};
}
function _fasFor(scac, domicile) {
  try {
    const fn = _o.fasFor || require('../orcha/fas/roster-lookup').fasFor;
    const v = fn(scac, domicile);
    return typeof v === 'string' ? v : '';
  } catch (_) { return ''; }
}

function guarded(channel, fn) {
  return async (event, ...args) => {
    try { return await fn(event, ...args); }
    catch (e) {
      if (e instanceof FleetError) throw e;
      log.error('[fleet-dbr:' + channel + '] internal', { name: (e && e.name) || 'Error' });
      return { ok: false, code: 'internal' };
    }
  };
}

function _obj(v, name) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(name + ' must be an object', name);
  return v;
}
function _plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

function _key(payload) {
  const k = payload.key;
  if (typeof k !== 'string' || !k || k.length > MAX_KEY) throw new ConfigError('key must be a string of at most ' + MAX_KEY + ' characters', 'key');
  return k;
}

function _fleetRows(fleet) { return fleet && Array.isArray(fleet.rows) ? fleet.rows.filter((r) => r && typeof r === 'object') : []; }

// Today's snapshot or null.
function _snapshot(today) {
  const s = _store().load(SNAP, null);
  return s && typeof s === 'object' && s.day === today && Array.isArray(s.rows) ? s : null;
}

// Raw edits doc (any day).
function _editsDoc() {
  const e = _plain(_store().load(EDITS, {}));
  return { version: 1, fasName: typeof e.fasName === 'string' ? e.fasName : '', day: typeof e.day === 'string' ? e.day : '', rows: _plain(e.rows) };
}
// Write side: a new day starts with no per-cell edits; fasName is kept.
function _editsForWrite(today) {
  const e = _editsDoc();
  if (e.day !== today) { e.day = today; e.rows = {}; }
  return e;
}

function _emailFasName() {
  try {
    const cfg = _plain(_store().load('emailIntelConfig', {}));
    const me = _plain(cfg.me);
    return typeof me.fasName === 'string' ? me.fasName : '';
  } catch (_) { return ''; }
}

function _model(snap, today, flags) {
  const edits = _editsDoc();
  const rowsEdits = edits.day === today ? edits.rows : {};
  const rosterFas = {};
  for (const r of snap.rows) rosterFas[r.key] = _fasFor(r.scac, r.domicile);
  const built = {
    day: snap.day, fleetCount: snap.fleetCount || 0, downCount: snap.downCount || 0,
    rows: snap.rows, conflicts: snap.conflicts || [], builtAt: snap.builtAt || null, fleetSyncedAt: snap.fleetSyncedAt || null,
  };
  return dbr.applyOverlays(built, {
    edits: rowsEdits, drafts: _plain(snap.drafts), fasNameOverride: edits.fasName,
    emailFasName: _emailFasName(), rosterFas, today, flags: { aiDraft: !!flags.aiDraft },
  });
}

function _save(name, data) {
  try { _store().save(name, data); return true; }
  catch (e) { log.warn('[fleet-dbr] save failed', { name: (e && e.name) || 'Error', key: name }); return false; }
}

const CTRL_VALUE_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g; // keeps \t (09) and \n (0A); strips \r
const CTRL_NAME_RE = /[\u0000-\u001F\u007F]/;

const handlers = {
  status: guarded('status', () => {
    const f = _flags();
    const enabled = f.enabled === true;
    return { ok: true, enabled, aiDraft: enabled && f.aiDraft === true };
  }),

  get: guarded('get', () => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    const today = _today();
    const snap = _snapshot(today);
    return { ok: true, model: snap ? _model(snap, today, f) : null };
  }),

  build: guarded('build', () => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    const t0 = Date.now();
    const today = _today();
    const fleet = _getFleet();
    const rows = _fleetRows(fleet);
    if (!rows.length) { log.info('[fleet-dbr] build', { code: 'no-fleet-data' }); return { ok: false, code: 'no-fleet-data' }; }
    const built = dbr.buildFleetDbr(rows, { today });
    const prev = _store().load(SNAP, null);
    const keys = new Set(built.rows.map((r) => r.key));
    const drafts = {};
    if (prev && prev.day === today) {
      for (const [k, d] of Object.entries(_plain(prev.drafts))) if (keys.has(k)) drafts[k] = d; // stale tagged by hash in applyOverlays
    }
    const snap = {
      version: 1, day: today, builtAt: _now().toISOString(),
      fleetSyncedAt: (fleet && (fleet.syncedAt || fleet.scrapedAt)) || null,
      fleetCount: built.fleetCount, downCount: built.downCount,
      rows: built.rows, conflicts: built.conflicts, drafts,
    };
    const saved = _save(SNAP, snap);
    const model = _model(snap, today, f);
    log.info('[fleet-dbr] build', { rows: built.rows.length, down: built.downCount, conflicts: built.conflicts.length, ms: Date.now() - t0 });
    return { ok: true, model, saved };
  }),

  draft: guarded('draft', async (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    if (f.aiDraft !== true) return { ok: false, code: 'ai-off' };
    _obj(payload, 'payload');
    const key = _key(payload);
    if (_inFlight >= MAX_IN_FLIGHT) return { ok: false, code: 'busy' };
    const today = _today();
    const snap = _snapshot(today);
    if (!snap) return { ok: false, code: 'not-built' };
    const snapRow = snap.rows.find((r) => r && r.key === key);
    if (!snapRow) return { ok: false, code: 'unknown-row' };
    if (!snapRow.pair || !(snapRow.pair.down > 0)) return { ok: false, code: 'no-down-units' };

    // Draft from CURRENT fleet data, but only when it still matches what the user sees.
    const fleetRows = _fleetRows(_getFleet());
    const fresh = dbr.buildFleetDbr(fleetRows, { today });
    const freshRow = fresh.rows.find((r) => r.key === key);
    if (!freshRow || freshRow.unitsHash !== snapRow.unitsHash) {
      log.info('[fleet-dbr] draft', { key, outcome: 'stale-build' });
      return { ok: false, code: 'stale-build' };
    }
    const unitRows = [];
    const fleetIds = [];
    for (const r of fleetRows) {
      if (dbr.groupKey(r) === key) { if (dbr.isDown(r)) unitRows.push(r); }
      else if (r.equipmentId) fleetIds.push(String(r.equipmentId).trim());
    }

    const t0 = Date.now();
    _inFlight += 1;
    let res;
    try {
      const { draftRow } = require('../dbr/fleet-dbr-ai');
      res = await draftRow({ row: freshRow, unitRows, built: fresh, ask: _ask(), fleetIds, today });
    } finally {
      _inFlight -= 1;
    }
    const ms = Date.now() - t0;
    if (!res || !res.ok) {
      const code = (res && res.code) || 'ai-failed';
      if (code === 'ai-timeout' || code === 'ai-failed') log.warn('[fleet-dbr] draft', { key, code, ms });
      else log.info('[fleet-dbr] draft', { key, code, dropped: (res && res.dropped) || 0, ms });
      return { ok: false, code };
    }

    const draftedAt = _now().toISOString();
    const out = { ok: true, key, fasActions: res.fasActions, support: res.support, dropped: res.dropped, draftedAt, saved: false };
    const cur = _snapshot(today);
    if (cur && cur.rows.some((r) => r && r.key === key)) {
      cur.drafts = _plain(cur.drafts);
      cur.drafts[key] = { fasActions: res.fasActions, support: res.support, draftedAt, unitsHash: snapRow.unitsHash, dropped: res.dropped };
      out.saved = _save(SNAP, cur);
      out.model = _model(cur, today, f);
    }
    log.info('[fleet-dbr] draft', { key, outcome: 'ok', dropped: res.dropped, ms });
    return out;
  }),

  saveEdit: guarded('save-edit', (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    _obj(payload, 'payload');
    const key = _key(payload);
    const today = _today();
    const snap = _snapshot(today);
    if (!snap) return { ok: false, code: 'not-built' };
    if (!snap.rows.some((r) => r && r.key === key)) return { ok: false, code: 'unknown-row' };
    const col = payload.col;
    if (typeof col !== 'string' || !dbr.EDITABLE_IDS.includes(col)) return { ok: false, code: 'bad-column' };
    if (typeof payload.value !== 'string') return { ok: false, code: 'invalid-value' };
    const value = payload.value.replace(CTRL_VALUE_RE, '');
    if (value.length > MAX_VALUE) return { ok: false, code: 'too-long' };
    const edits = _editsForWrite(today);
    const row = _plain(edits.rows[key]);
    row[col] = value;
    edits.rows[key] = row;
    if (Object.keys(edits.rows).length > MAX_EDIT_ROWS) return { ok: false, code: 'too-many-rows' };
    if (!_save(EDITS, edits)) { log.warn('[fleet-dbr] save-edit failed', { key, col }); return { ok: false, code: 'save-failed' }; }
    return { ok: true };
  }),

  resetRow: guarded('reset-row', (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    _obj(payload, 'payload');
    const key = _key(payload);
    const today = _today();
    const snap = _snapshot(today);
    if (!snap) return { ok: false, code: 'not-built' };
    if (!snap.rows.some((r) => r && r.key === key)) return { ok: false, code: 'unknown-row' };
    const edits = _editsForWrite(today);
    delete edits.rows[key];
    if (!_save(EDITS, edits)) { log.warn('[fleet-dbr] reset-row failed', { key }); return { ok: false, code: 'save-failed' }; }
    return { ok: true };
  }),

  setFasName: guarded('set-fas-name', (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    _obj(payload, 'payload');
    if (typeof payload.name !== 'string') return { ok: false, code: 'invalid-name' };
    const name = payload.name.trim();
    if (CTRL_NAME_RE.test(name)) return { ok: false, code: 'invalid-name' };
    if (name.length > MAX_NAME) return { ok: false, code: 'too-long' };
    const edits = _editsForWrite(_today());
    edits.fasName = name;
    if (!_save(EDITS, edits)) { log.warn('[fleet-dbr] set-fas-name failed', {}); return { ok: false, code: 'save-failed' }; }
    return { ok: true, fasName: name };
  }),
};

const CHANNELS = Object.freeze({
  'fleet-dbr:status': 'status',
  'fleet-dbr:get': 'get',
  'fleet-dbr:build': 'build',
  'fleet-dbr:draft': 'draft',
  'fleet-dbr:save-edit': 'saveEdit',
  'fleet-dbr:reset-row': 'resetRow',
  'fleet-dbr:set-fas-name': 'setFasName',
});

function registerFleetDbrIPC(ctx) {
  _ctx = ctx || null;
  for (const [channel, name] of Object.entries(CHANNELS)) handle(channel, handlers[name]);
}

function _resetForTests(overrides) {
  _o = overrides || {};
  _ctx = (overrides && overrides.ctx) || null;
  _inFlight = 0;
}

module.exports = { registerFleetDbrIPC, guarded, _resetForTests, CHANNELS, __test__: { handlers } };
