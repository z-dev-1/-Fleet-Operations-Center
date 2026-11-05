'use strict';
/**
 * ipc/long-dwell-sp.js - Long Dwell "Preview, then write" into the weekly
 * SharePoint sheet.
 *
 *   long-dwell-sp:status      ()                                  -> {ok, enabled, commit?, weekKey?, weekLabel?, link?}
 *   long-dwell-sp:set-link    ({ url })                           -> {ok, weekKey, link} | {ok:false, code}
 *   long-dwell-sp:clear-link  ()                                  -> {ok}
 *   long-dwell-sp:preview     ({ units, tab? })                   -> preview payload | {ok:false, code}
 *   long-dwell-sp:write       ({ previewId, cells:[{cellId,text}], confirm:true }) -> report | {ok:false, code}
 *   long-dwell-sp:discard     ({ previewId })                     -> {ok}
 *
 * Flags are read on EVERY call (loadLongDwellSp). Master off: every channel
 * except status returns {ok:false, code:'off'} before any store, transport or
 * window access; status returns {ok:true, enabled:false} without reading the
 * link store or installing the pane guard. Master on + commit off: write
 * returns write-disabled before any I/O.
 *
 * Every body is wrapped by guarded(): FleetError goes through _safe unchanged
 * (fixed messages); anything else logs the class name only and returns
 * {ok:false, code:'internal'} (exception text can carry a link token or cell text).
 */
const { handle } = require('./_safe');
const { FleetError, ConfigError } = require('../utils/errors');
const log = require('../utils/logger')('long-dwell-sp');

const MAX_UNITS = 1000;
const MAX_CELLS = 3000;
const MAX_ID = 64;
const MAX_TAB = 255;
const MAX_URL = 2048;
const CELL_ID_RE = /^\d{1,7}:[A-Z]{1,3}$/;
const OFF = Object.freeze({ ok: false, code: 'off' });
const UNIT_FIELDS = { woKey: 128, woNumber: 64, woAmz: 64, domicile: 32, vendor: 128 };

let _o = {};
let _svc = null;

function _flags() {
  const load = _o.loadFlags || require('../config/perf-flags').loadLongDwellSp;
  return load() || {};
}
function _store() { return _o.store || require('../store'); }
function _links() { return require('../longdwell/sheet-links'); }
function _guard() { return _o.installPaneGuard || require('../longdwell/pane-guard').installPaneGuard; }
function _service() {
  if (_o.service) return _o.service;
  if (!_svc) {
    const { createSheetService } = require('../longdwell/sheet-service');
    _svc = createSheetService({
      transport: _o.transport || require('../scrapers/sp_sheet_transport'),
      store: _store(),
      lock: _o.lock || require('../scrapers/sharepoint_push')._withWriteLock,
      flags: _flags,
      logger: log,
      clock: _o.clock,
    });
  }
  return _svc;
}
function _linkDeps() { return { store: _store(), now: _o.now || (() => new Date()) }; }

function guarded(channel, fn) {
  return async (event, ...args) => {
    try { return await fn(event, ...args); }
    catch (e) {
      if (e instanceof FleetError) throw e;
      log.error('[long-dwell-sp:' + channel + '] internal', { name: (e && e.name) || 'Error' });
      return { ok: false, code: 'internal' };
    }
  };
}

function _obj(v, name) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(name + ' must be an object', name);
  return v;
}

function _str(v, name, max, required) {
  if (v === undefined || v === null) {
    if (required) throw new ConfigError(name + ' is required', name);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new ConfigError(name + ' must be a string of at most ' + max + ' characters', name);
  return v;
}

function _units(v) {
  if (!Array.isArray(v)) throw new ConfigError('units must be an array', 'units');
  if (v.length > MAX_UNITS) return null; // too-many-units
  const seen = new Set();
  const out = [];
  for (const u of v) {
    _obj(u, 'unit');
    const equipmentId = _str(u.equipmentId, 'equipmentId', 32, true).trim();
    const x = { equipmentId, woKey: 'primary', isPrimary: u.isPrimary === true };
    for (const [k, max] of Object.entries(UNIT_FIELDS)) {
      const s = _str(u[k], k, max, false);
      if (s !== undefined) x[k] = s;
    }
    if (u.isPrimary !== undefined && typeof u.isPrimary !== 'boolean') throw new ConfigError('isPrimary must be a boolean', 'isPrimary');
    if (!x.woKey) x.woKey = 'primary';
    const key = equipmentId + '::' + x.woKey;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

// A13: wrong shape / empty -> ConfigError; > 3000 -> too-many-cells;
// bad or duplicate id -> invalid-cell; non-string text -> invalid-text.
// Unknown / non-selectable ids and text content are checked by the service.
function _cells(v) {
  if (!Array.isArray(v) || v.length === 0) throw new ConfigError('cells must be a non-empty array', 'cells');
  if (v.length > MAX_CELLS) return { ok: false, code: 'too-many-cells' };
  const seen = new Set();
  const out = [];
  for (const c of v) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new ConfigError('cells entries must be objects', 'cells');
    if (typeof c.cellId !== 'string' || !CELL_ID_RE.test(c.cellId) || seen.has(c.cellId)) return { ok: false, code: 'invalid-cell' };
    seen.add(c.cellId);
    if (typeof c.text !== 'string') return { ok: false, code: 'invalid-text' };
    out.push({ cellId: c.cellId, text: c.text });
  }
  return { ok: true, cells: out };
}

function _weekKey() { return _links().isoWeekKey(_linkDeps().now()); }

function _linkView(rec) {
  if (!rec) return null;
  const r = _links().resolvedFor(rec);
  const out = { url: rec.url, source: 'manual', confidence: 'user', setAt: rec.setAt || null };
  if (r && r.name) out.fileName = r.name;
  if (r && r.tab) out.tab = r.tab;
  if (rec.lastWrite) out.lastWrite = rec.lastWrite;
  return out;
}

function registerLongDwellSpIPC() {
  handle('long-dwell-sp:status', guarded('status', (event) => {
    const f = _flags();
    if (f.sharepointWrite !== true) return { ok: true, enabled: false };
    const weekKey = _weekKey();
    const rec = _links().getLink(weekKey, _linkDeps());
    try { _guard()(event && event.sender); } catch (e) { log.warn('[long-dwell-sp:status] pane guard not installed', { name: (e && e.name) || 'Error' }); }
    const { weekLabel } = require('../longdwell/sheet-service');
    return { ok: true, enabled: true, commit: f.sharepointWriteCommit === true, weekKey, weekLabel: weekLabel(weekKey), link: _linkView(rec) };
  }));

  handle('long-dwell-sp:set-link', guarded('set-link', (_e, payload) => {
    if (_flags().sharepointWrite !== true) return OFF;
    _obj(payload, 'payload');
    if (typeof payload.url !== 'string') return { ok: false, code: 'bad-link' };
    if (payload.url.length > MAX_URL) return { ok: false, code: 'link-too-long' };
    const { parseSheetLink } = require('../longdwell/link-parse');
    const p = parseSheetLink(payload.url);
    if (!p.ok) { log.info('[long-dwell-sp:set-link] rejected', { code: p.code }); return { ok: false, code: p.code }; }
    const weekKey = _weekKey();
    let saved;
    try { saved = _links().setLink(weekKey, { url: p.canonicalUrl, kind: p.kind }, _linkDeps()); }
    catch (e) { log.error('[long-dwell-sp:set-link] store failed', { name: (e && e.name) || 'Error' }); return { ok: false, code: 'internal' }; }
    return { ok: true, weekKey: saved.weekKey, link: _linkView(saved.record) };
  }));

  handle('long-dwell-sp:clear-link', guarded('clear-link', () => {
    if (_flags().sharepointWrite !== true) return OFF;
    _links().clearLink(_weekKey(), _linkDeps());
    return { ok: true };
  }));

  handle('long-dwell-sp:preview', guarded('preview', (_e, payload) => {
    if (_flags().sharepointWrite !== true) return OFF;
    _obj(payload, 'payload');
    const units = _units(payload.units);
    if (!units) return { ok: false, code: 'too-many-units' };
    const tab = _str(payload.tab, 'tab', MAX_TAB, false);
    return _service().preview({ units, tab: tab || undefined });
  }));

  handle('long-dwell-sp:write', guarded('write', (_e, payload) => {
    const f = _flags();
    if (f.sharepointWrite !== true) return OFF;
    if (f.sharepointWriteCommit !== true) {
      return { ok: false, code: 'write-disabled', error: 'Write is turned off. Set longDwell.sharepointWriteCommit to enable.' };
    }
    _obj(payload, 'payload');
    const previewId = _str(payload.previewId, 'previewId', MAX_ID, true);
    const c = _cells(payload.cells);
    if (!c.ok) return c;
    if (payload.confirm !== true) return { ok: false, code: 'confirm-required' };
    return _service().write({ previewId, cells: c.cells, confirm: true });
  }));

  handle('long-dwell-sp:discard', guarded('discard', (_e, payload) => {
    if (_flags().sharepointWrite !== true) return OFF;
    _obj(payload, 'payload');
    const previewId = _str(payload.previewId, 'previewId', MAX_ID, true);
    return _service().discard(previewId);
  }));
}

function _resetForTests(overrides) {
  _o = overrides || {};
  _svc = null;
}

module.exports = { registerLongDwellSpIPC, guarded, _resetForTests };
