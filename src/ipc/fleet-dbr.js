'use strict';
/**
 * ipc/fleet-dbr.js - Daily Call "DBR DATA": the 24-column Fleet Health DBR built from the
 * app's own fleet data (replaces the QuickSight panel).
 *
 *   fleet-dbr:status        ()                    -> { ok, enabled, aiDraft }
 *   fleet-dbr:get           ()                    -> { ok, model | null }   (null = no snapshot today)
 *   fleet-dbr:build         ({ scacs? })          -> { ok, model, saved, serverCoverage? } | { ok:false, code:'no-fleet-data' }
 *                                                    serverCoverage only with settings.dbr.serverScacFilter on AND scacs given:
 *                                                    { ok, sites, serverOpenWos, missingFromFleet (<=20 ids), missingCount } | { ok:false, code, sites }
 *   fleet-dbr:draft         ({ key })             -> { ok, key, cells, sources, flags, disagreements, etcUnits, etcDisagreements,
 *                                                      etcOverrides, provenance, unverifiedNames, unboundDates, coverageFilled,
 *                                                      dropped, rounds, reviewSkipped, mode, draftedAt, saved, model?,
 *                                                      fasActions, support } | { ok:false, code }
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
const MAX_VALUE = 16000;
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
// Isolated lane, Aki first when ai.aki.allowUntrusted consent is on (relay preferAki). The
// per-call timeoutMs (and signal) come from draftRow; the lane options cannot be overridden.
function _ask() {
  if (_o.ask) return _o.ask;
  return (p, o) => require('../orcha/relay').askWithTimeout(p, {
    ...o, source: 'fleet_dbr', priority: 'normal', isolated: true, preferAki: true,
  });
}

// ── FAS alias (AAP user alias) ──────────────────────────────────────────────
// Memoized per process. _primeAlias() starts the fetch without awaiting (status / get / draft);
// _aapAlias() never awaits; _awaitAlias() is the draft handler's bounded wait (polling, never
// a promise race). Injectable for tests: _o.userAlias (fn -> alias | Promise), _o.aliasNow
// (clock fn, ms) and _o.aliasSleep (ms -> Promise).
const ALIAS_RE = /^[A-Za-z0-9._-]{2,64}$/;
const ALIAS_WAIT_MS = 15000;
const ALIAS_POLL_MS = 250;
const ALIAS_RETRY_MS = 30 * 60 * 1000;
let _aliasCache = '';
let _aliasPending = false;
let _aliasTriedAt = 0;

function _aliasNow() { return (_o.aliasNow || Date.now)(); }
function _aapAlias() { return _aliasCache; }
function _primeAlias() {
  if (_aliasCache || _aliasPending) return;
  if (_aliasTriedAt && _aliasNow() - _aliasTriedAt < ALIAS_RETRY_MS) return;
  _aliasPending = true;
  const fetch = _o.userAlias || (() => {
    const api = require('../scrapers/aap_api');
    return Promise.resolve(api.getUserDetails()).then((u) => api._userAlias(u));
  });
  Promise.resolve()
    .then(() => fetch())
    .then((a) => { if (typeof a === 'string' && ALIAS_RE.test(a)) _aliasCache = a; })
    .catch(() => { log.debug('[fleet-dbr] alias', { code: 'alias-unavailable' }); })
    .finally(() => { _aliasPending = false; _aliasTriedAt = _aliasNow(); });
}
async function _awaitAlias() {
  const sleep = _o.aliasSleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = _aliasNow();
  while (_aliasPending && _aliasNow() - t0 < ALIAS_WAIT_MS) await sleep(ALIAS_POLL_MS);
}

// ── Enrich (canonicalState / notesStore / emailEvidence) ───────────────────
// Each source loads in its own try; a load or shape failure makes that source empty for every
// unit (warn, code only) and the draft continues. -> { [downId]: { canonical, manualEntries, email } }
const MAX_MANUAL = 50;
const MAX_MANUAL_CHARS = 400;
const MAX_EMAIL = 15;
function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _enrichSource(key, name, pick) {
  try {
    const doc = _store().load(name, {});
    const v = pick(doc == null ? {} : doc);
    if (v === null) throw new Error('shape');
    return v;
  } catch (_) {
    log.warn('[fleet-dbr] enrich', { key, source: name, code: 'enrich-unavailable' });
    return {};
  }
}
function _enrich(key, ids) {
  const canon = _enrichSource(key, 'canonicalState', (d) => {
    if (!_isObj(d)) return null;
    if (d.units === undefined) return {};
    return _isObj(d.units) ? d.units : null;
  });
  const notes = _enrichSource(key, 'notesStore', (d) => (_isObj(d) ? d : null));
  const mail = _enrichSource(key, 'emailEvidence', (d) => (_isObj(d) ? d : null));
  const out = {};
  for (const id of ids) {
    const rec = {};
    if (_isObj(canon[id])) rec.canonical = canon[id];
    const ns = notes[id];
    if (_isObj(ns) && Array.isArray(ns.manualEntries)) {
      rec.manualEntries = ns.manualEntries.filter((x) => typeof x === 'string').slice(-MAX_MANUAL).map((x) => x.slice(0, MAX_MANUAL_CHARS));
    }
    if (Array.isArray(mail[id])) {
      const t = (x) => { const v = Date.parse(x && x.observedAt); return Number.isFinite(v) ? v : 0; };
      rec.email = mail[id].filter(_isObj).slice().sort((a, b) => t(b) - t(a)).slice(0, MAX_EMAIL);
    }
    if (Object.keys(rec).length) out[id] = rec;
  }
  return out;
}
// FAS identity names: roster, panel override, email-intel name (unique, trimmed, 1..120).
function _fasNames(snapRow) {
  const out = [];
  let list = [];
  try { list = [_fasFor(snapRow.scac, snapRow.domicile), _editsDoc().fasName, _emailFasName()]; } catch (_) { list = []; }
  for (const n of list) {
    const s = typeof n === 'string' ? n.trim() : '';
    if (s && s.length <= MAX_NAME && !out.includes(s)) out.push(s);
  }
  return out;
}
// Draft info log: counts, codes, the row key and ms only (never prompt, evidence or AI text).
function _draftLog(key, res, view, calls, extra) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const fieldOver = {};
  let maxPromptChars = 0;
  let maxOutChars = 0;
  let envOver = 0;
  let envMissing = 0;
  for (const c of calls) {
    if (!c) continue;
    maxPromptChars = Math.max(maxPromptChars, num(c.promptChars));
    maxOutChars = Math.max(maxOutChars, num(c.outChars));
    envOver += num(c.envOver);
    envMissing += num(c.envMissing);
    for (const [k, v] of Object.entries(_plain(c.fieldOver))) fieldOver[k] = Math.max(fieldOver[k] || 0, num(v));
  }
  const dropReasons = {};
  for (const [k, v] of Object.entries(_plain(res.dropReasons))) dropReasons[k] = num(v);
  const er = _plain(res.etcReconciled);
  const provenanceItems = Object.values(view.provenance)
    .reduce((s, byUnit) => s + Object.values(_plain(byUnit)).reduce((t, list) => t + (Array.isArray(list) ? list.length : 0), 0), 0);
  return {
    key, outcome: 'ok', units: (res.etcUnits || []).length, mode: res.mode, demand: num(res.demand),
    calls: num(res.calls), mapRetries: num(res.mapRetries), rounds: num(res.rounds), reviewSkipped: res.reviewSkipped || null,
    dropped: num(res.dropped), dropReasons, unverifiedNames: view.unverifiedNames.length, unboundDates: view.unboundDates.length,
    etcOverrides: view.etcOverrides.length, envOver, envMissing, fieldOver, provenanceItems,
    coverageFilled: view.coverageFilled.length, fasTagged: extra.fasTagged, alias: extra.alias,
    etcFilled: num(er.filled), etcReclassified: num(er.reclassified), etcDateUnknown: num(er.dateUnknown),
    etcDisagreements: view.etcDisagreements.length, disagreements: view.disagreements.length,
    maxPromptChars, maxOutChars, ms: extra.ms,
  };
}
function _pick(obj, ids) {
  const src = _plain(obj);
  const out = {};
  for (const id of ids) if (typeof src[id] === 'string') out[id] = src[id];
  return out;
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
    fasAliasKnown: !!_aapAlias(),
  });
}

function _save(name, data) {
  try { _store().save(name, data); return true; }
  catch (e) { log.warn('[fleet-dbr] save failed', { name: (e && e.name) || 'Error', key: name }); return false; }
}

const CTRL_VALUE_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g; // keeps \t (09) and \n (0A); strips \r
const CTRL_NAME_RE = /[\u0000-\u001F\u007F]/;

// Synchronous build from stored fleet data (the only source of DBR rows) -> { res, rows }.
function _buildLocal(f) {
  const t0 = Date.now();
  const today = _today();
  const fleet = _getFleet();
  const rows = _fleetRows(fleet);
  if (!rows.length) { log.info('[fleet-dbr] build', { code: 'no-fleet-data' }); return { res: { ok: false, code: 'no-fleet-data' }, rows }; }
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
  return { res: { ok: true, model, saved }, rows };
}

// ── Server SCAC coverage (settings.dbr.serverScacFilter, default OFF) ───────
// build payload { scacs?: string[] } (the panel's selected SCACs). With the flag on and SCACs
// selected, ONE bounded open-WO search filtered by the selected SCACs' domiciles reports units
// Relay has open WOs for but fleet data lacks. Attached to the RESPONSE only: the snapshot and
// the rows never change.
const MAX_SCACS = 100;
const MAX_SCAC_CHARS = 40;
const MAX_MISSING = 20;
const SERVER_MAX_PAGES = 10;
function _scacsOf(payload) {
  const list = payload && typeof payload === 'object' && Array.isArray(payload.scacs) ? payload.scacs : [];
  const out = new Set();
  for (const s of list.slice(0, MAX_SCACS)) {
    if (typeof s === 'string' && s && s.length <= MAX_SCAC_CHARS && !CTRL_NAME_RE.test(s)) out.add(dbr.normCode(s));
  }
  return [...out];
}
function _serverFlags() {
  try {
    const load = _o.loadServerFlags || require('../config/perf-flags').loadDbrServerFilter;
    return load() || {};
  } catch (_) { return {}; }
}
function _search() {
  return _o.search || ((req, o) => require('../scrapers/aap_api').searchAllPages(req, o));
}
async function _withServerCoverage(res, rows, scacs) {
  const t0 = Date.now();
  const sel = new Set(scacs);
  const sites = new Set();
  const fleetIds = new Set();
  for (const r of rows) {
    const id = String(r.equipmentId == null ? '' : r.equipmentId).trim().toUpperCase();
    if (id) fleetIds.add(id);
    if (!sel.has(dbr.normCode(r.operator))) continue;
    const d = dbr.normCode(r.domicileSite || r.domicile || '');
    if (d && d !== '(BLANK)') sites.add(d);
  }
  const assetDomicileSites = [...sites].sort();
  if (!assetDomicileSites.length) return Object.assign({}, res, { serverCoverage: { ok: false, code: 'no-sites', sites: [] } });
  let list;
  try {
    list = await _search()({}, { maxPages: SERVER_MAX_PAGES, filters: { assetDomicileSites } });
  } catch (e) {
    const code = String((e && e.code) || 'search-failed').slice(0, 40);
    log.warn('[fleet-dbr] server-scac', { sites: assetDomicileSites.length, code, ms: Date.now() - t0 });
    return Object.assign({}, res, { serverCoverage: { ok: false, code, sites: assetDomicileSites } });
  }
  const wos = Array.isArray(list) ? list.filter((w) => w && typeof w === 'object') : [];
  const missing = new Set();
  for (const w of wos) {
    const id = String(w.assetDisplayName || w.equipmentId || '').trim().toUpperCase();
    if (id && !fleetIds.has(id)) missing.add(id);
  }
  const missingAll = [...missing].sort();
  log.info('[fleet-dbr] server-scac', { sites: assetDomicileSites.length, serverOpenWos: wos.length, missing: missingAll.length, ms: Date.now() - t0 });
  return Object.assign({}, res, {
    serverCoverage: {
      ok: true, sites: assetDomicileSites, serverOpenWos: wos.length,
      missingFromFleet: missingAll.slice(0, MAX_MISSING), missingCount: missingAll.length,
    },
  });
}

const handlers = {
  status: guarded('status', () => {
    const f = _flags();
    const enabled = f.enabled === true;
    if (enabled) _primeAlias();
    return { ok: true, enabled, aiDraft: enabled && f.aiDraft === true };
  }),

  get: guarded('get', () => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    _primeAlias();
    const today = _today();
    const snap = _snapshot(today);
    return { ok: true, model: snap ? _model(snap, today, f) : null };
  }),

  build: guarded('build', (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    const scacs = _scacsOf(payload);
    if (!scacs.length || _serverFlags().serverScac !== true) return _buildLocal(f).res;
    const { res, rows } = _buildLocal(f);
    if (!res.ok) return res;
    return _withServerCoverage(res, rows, scacs);
  }),

  draft: guarded('draft', async (_e, payload) => {
    const f = _flags();
    if (f.enabled !== true) return OFF;
    if (f.aiDraft !== true) return { ok: false, code: 'ai-off' };
    _obj(payload, 'payload');
    const key = _key(payload);
    _primeAlias();
    // FIRST await. Everything from the busy check to `_inFlight += 1` below is synchronous, so
    // MAX_IN_FLIGHT holds however many calls waited here, and the snapshot is read after the wait.
    await _awaitAlias();
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

    const downIds = (freshRow.units || []).map((u) => u && u.id).filter((id) => typeof id === 'string' && id && id !== '(no id)');
    const enrich = _enrich(key, downIds);
    const fasNames = _fasNames(snapRow);
    const fasAlias = _aapAlias();

    const t0 = Date.now();
    _inFlight += 1;
    let res;
    try {
      const { draftRow } = require('../dbr/fleet-dbr-ai');
      res = await draftRow({ row: freshRow, unitRows, built: fresh, ask: _ask(), enrich, fasNames, fasAlias, fleetIds, today });
    } finally {
      _inFlight -= 1;
    }
    const ms = Date.now() - t0;
    const calls = Array.isArray(res && res.log) ? res.log : [];
    for (const c of calls) {
      if (c && c.kind !== 'map-retry') log.debug('[fleet-dbr] call', { key, kind: c.kind, promptChars: c.promptChars, outChars: c.outChars, ms: c.ms });
    }
    if (!res || !res.ok) {
      const code = (res && res.code) || 'ai-failed';
      const meta = { key, code, mode: res && res.mode, demand: res && res.demand, calls: (res && res.calls) || 0, ms };
      if (res && res.reason) meta.reason = res.reason;
      if (code === 'ai-timeout' || code === 'ai-failed') log.warn('[fleet-dbr] draft', meta);
      else log.info('[fleet-dbr] draft', meta);
      return { ok: false, code };
    }

    const draftedAt = _now().toISOString();
    const fasTagged = calls.reduce((m, c) => Math.max(m, (c && c.fasTagged) || 0), 0);
    const arr = (v) => (Array.isArray(v) ? v : []);
    const view = {
      cells: _pick(res.cells, dbr.AI_CELL_IDS), sources: _plain(res.sources), flags: _plain(res.flags),
      disagreements: arr(res.disagreements), etcUnits: arr(res.etcUnits), etcDisagreements: arr(res.etcDisagreements),
      etcOverrides: arr(res.etcOverrides), provenance: _plain(res.provenance), unverifiedNames: arr(res.unverifiedNames),
      unboundDates: arr(res.unboundDates), coverageFilled: arr(res.coverageFilled),
    };
    const out = Object.assign({ ok: true, key }, view, {
      dropped: res.dropped || 0, rounds: res.rounds || 0, reviewSkipped: res.reviewSkipped || null, mode: res.mode,
      draftedAt, saved: false, fasActions: view.cells.fasActions, support: view.cells.support,
    });
    const cur = _snapshot(today);
    const i = cur ? cur.rows.findIndex((r) => r && r.key === key) : -1;
    if (i >= 0 && cur.rows[i].unitsHash !== freshRow.unitsHash) {
      // A rebuild with a different down set landed while drafting: do not store a mismatched draft.
      log.info('[fleet-dbr] draft', { key, outcome: 'stale-build', ms });
      return { ok: false, code: 'stale-build' };
    }
    if (i >= 0) {
      // The drill-down units and computed fallback cells follow the drafted evidence; hard cells stay.
      cur.rows[i] = Object.assign({}, cur.rows[i], {
        units: freshRow.units,
        evidenceHash: freshRow.evidenceHash,
        cells: Object.assign({}, cur.rows[i].cells, _pick(freshRow.cells, dbr.AI_CELL_IDS)),
      });
      cur.drafts = _plain(cur.drafts);
      cur.drafts[key] = Object.assign({ version: 2 }, view, {
        dropped: res.dropped || 0, dropReasons: _plain(res.dropReasons), mode: res.mode, calls: res.calls || 0,
        mapRetries: res.mapRetries || 0, rounds: res.rounds || 0, reviewSkipped: res.reviewSkipped || null,
        identity: { alias: !!fasAlias, names: fasNames.length, fasTagged },
        draftedAt, unitsHash: freshRow.unitsHash, evidenceHash: freshRow.evidenceHash,
      });
      out.saved = _save(SNAP, cur);
      out.model = _model(cur, today, f);
    }
    log.info('[fleet-dbr] draft', _draftLog(key, res, view, calls, { fasTagged, alias: !!fasAlias, ms }));
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
  _aliasCache = '';
  _aliasPending = false;
  _aliasTriedAt = 0;
}

module.exports = { registerFleetDbrIPC, guarded, _resetForTests, CHANNELS, __test__: { handlers } };
