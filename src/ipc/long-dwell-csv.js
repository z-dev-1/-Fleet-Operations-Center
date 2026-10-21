'use strict';
/**
 * ipc/long-dwell-csv.js — Imported Long Dwell tracker CSV + team annotations.
 *
 * Backs the Analytics -> Long Dwell "Imported CSV" table. The team downloads
 * the AAP long-dwell tracker CSV, imports it here, and fills the manual columns
 * (Delay Reason, Escalation Level Action, Support Team POC, Asana Link,
 * Required Notes) in-app so everyone shares one working copy (and it can later
 * be pushed to the SharePoint tracker).
 *
 * Storage model (longDwellCsv store):
 *   {
 *     importedAt: ISO,
 *     columns:    [ ...header strings as imported... ],
 *     rows: {
 *       <rowKey>: {
 *         csv:    { ...columns A-M, verbatim from the import... },
 *         manual: { delayReason, escalationAction, supportPOC, asanaLink, notes },
 *         assetId, site, updatedAt
 *       }
 *     }
 *   }
 *
 * rowKey = assetId::site::index — the same Asset ID can appear multiple times
 * (multiple WOs / sites), so we key on asset+site+import-order to keep each
 * tracker line distinct. Manual edits are matched back by this stable key.
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:long-dwell-csv');
const { handle, requireObject, requireStringMax } = require('./_safe');
const { ConfigError } = require('../utils/errors');
const _roster = require('../orcha/fas/roster-lookup'); // FAS/UM auto-fill by (SCAC + Site)

// Column labels that are team-filled in-app (N–R). When fetching/importing the
// AAP CSV we DROP these columns' values so the team's in-app edits always win.
const MANUAL_LABELS = [
  'Delay Reason', 'Escalation Level Action', 'Support Team POC',
  'Asana Link (If at SEV2)', 'Required Notes for ALL Units',
].map((s) => s.toLowerCase());

// RFC-4180-ish CSV parser (mirrors the renderer's parseCsv): handles quoted
// fields, escaped quotes (""), and newlines inside quoted cells. Returns a
// matrix of string rows.
function _parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Turn parsed CSV text into the { columns, rows[] } import payload (A–M only;
// manual N–R columns are owned by the app and dropped here). Mirrors the
// renderer's _findHeaderIndex + _buildImportPayload so a fetched CSV flows
// through the exact same storage path as a file import.
function _csvToImportPayload(text) {
  const matrix = _parseCsv(text);
  if (!matrix.length) return null;

  // Find the header row (first row within the top 15 that has an "Asset ID").
  let hIdx = 0;
  for (let r = 0; r < Math.min(matrix.length, 15); r++) {
    const cells = matrix[r].map((c) => String(c || '').trim().toLowerCase());
    if (cells.some((c) => c === 'asset id' || c === 'assetid')) { hIdx = r; break; }
  }
  const headers = matrix[hIdx].map((h) => String(h || '').trim());
  if (!headers.length) return null;

  const lc = (h) => String(h || '').trim().toLowerCase();
  const manualSet = new Set(MANUAL_LABELS);
  const csvHeaders = headers.filter((h) => h && !manualSet.has(lc(h)));
  const assetIdx = headers.findIndex((h) => lc(h) === 'asset id' || lc(h) === 'assetid');
  const siteIdx  = headers.findIndex((h) => lc(h) === 'site');

  const rows = [];
  for (let r = hIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells.some((c) => String(c || '').trim() !== '')) continue;
    const assetId = assetIdx >= 0 ? String(cells[assetIdx] || '').trim() : '';
    const site    = siteIdx  >= 0 ? String(cells[siteIdx]  || '').trim() : '';
    if (!assetId) continue;
    const csv = {};
    headers.forEach((h, ci) => {
      if (!h || manualSet.has(lc(h))) return;
      csv[h] = String(cells[ci] == null ? '' : cells[ci]);
    });
    rows.push({ assetId, site, csv });
  }
  return { columns: csvHeaders, rows };
}

// ── Two-source merge (WR export + Asset export) ──────────────────────────────
// The AAP long-dwell tracker is a reshaped view of two raw exports joined on
// the unit number. This maps both exports' native column names into the
// tracker's A–M column names and merges per unit.

// Long Dwell shows only units down at least this many days. Units down fewer
// than this are excluded from the imported tracker (not "long dwell" yet).
const MIN_DAYS_DOWN = 5;

// The tracker's A–M (CSV/read-only) columns, in display order.
const TRACKER_COLUMNS = [
  'FAS', 'UM', 'Asset ID', 'Asset Type', 'Site', 'SCAC',
  'Lifecycle State Reason', 'Days Down', 'RG Vendor Assigned',
  'Vendor Delay Reason', 'Expected ETC', 'Level 1', 'Level 2',
];

// Parse a CSV into { headers:[], rows:[{header:value}] } with case-insensitive
// header lookup support. Finds the real header row (first non-empty row).
function _parseToObjects(text) {
  const matrix = _parseCsv(text);
  if (!matrix.length) return { headers: [], rows: [] };
  let hIdx = 0;
  for (let r = 0; r < Math.min(matrix.length, 5); r++) {
    if (matrix[r].some((c) => String(c || '').trim() !== '')) { hIdx = r; break; }
  }
  const headers = matrix[hIdx].map((h) => String(h || '').trim());
  const rows = [];
  for (let r = hIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells.some((c) => String(c || '').trim() !== '')) continue;
    const obj = {};
    headers.forEach((h, ci) => { if (h) obj[h] = String(cells[ci] == null ? '' : cells[ci]); });
    rows.push(obj);
  }
  return { headers, rows };
}

// Case-insensitive field getter: returns the first non-empty value among the
// candidate header names.
function _field(obj, candidates) {
  const keys = Object.keys(obj);
  for (const cand of candidates) {
    const target = cand.toLowerCase();
    const k = keys.find((kk) => kk.toLowerCase() === target);
    if (k && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

// Normalize a unit number for joining (strip the aaid_ prefix, trim, upper).
function _unitKey(v) {
  return String(v || '').replace(/^aaid_/i, '').trim().toUpperCase();
}

// Compute "Days Down" from a start date/timestamp, if present. Returns '' when
// no usable date is found.
function _daysSince(dateStr) {
  if (!dateStr) return '';
  const t = Date.parse(String(dateStr).replace(' ', 'T'));
  if (isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  return days >= 0 ? String(days) : '';
}

// Merge the WR export (open work orders) with the Asset export (fleet master
// data), joined on unit number, into the tracker's A–M columns. The WR export
// is the row driver (one tracker line per open WO); the asset export enriches
// each line with fleet/site/lifecycle data.
function _mergeToImportPayload(wrCsv, assetCsv) {
  const wr    = _parseToObjects(wrCsv);
  const asset = _parseToObjects(assetCsv);
  return _mergeRowObjects(wr.rows, asset.rows);
}

// Core merge over pre-parsed ROW OBJECTS (header-name keyed). Shared by the CSV
// path (_mergeToImportPayload) and the API path (buildLongDwellSources), so the
// exclusions (FleetNet-tow, VELOCITI), ≥MIN_DAYS_DOWN filter, A–M mapping, and
// roster FAS/UM lookup are defined ONCE.
function _mergeRowObjects(wrRows, assetRows) {
  const wr    = { rows: Array.isArray(wrRows) ? wrRows : [] };
  const asset = { rows: Array.isArray(assetRows) ? assetRows : [] };

  // Build an asset lookup keyed by the UNIT NUMBER. BOTH exports carry an
  // "Equipment ID" column (the human unit number, e.g. 520024) — that's the
  // join key. (The asset export's "Asset ID" is the aaid_ UUID, NOT the join
  // key — matching on that was why the join found 0 rows before.)
  const assetByUnit = new Map();
  for (const a of asset.rows) {
    const unit = _unitKey(_field(a, ['Equipment ID', 'equipmentId', 'Equipment Id']));
    if (unit && !assetByUnit.has(unit)) assetByUnit.set(unit, a);
  }

  let _skippedFleetnetTow = 0;
  let _skippedVelociti = 0;
  let _skippedShortDwell = 0;
  const rows = [];
  for (const w of wr.rows) {
    const unitRaw = _field(w, ['Equipment ID', 'equipmentId', 'Equipment Id']);
    const unit = _unitKey(unitRaw);
    if (!unit) continue;

    // Exclude FleetNet towing WRs — those are handled by FleetNet and don't
    // belong in the long-dwell tracker. Match: Vendor == FLEETNET AND
    // L1 Area of Concern == Tow (case-insensitive). Other FleetNet repairs and
    // other tows are kept.
    const vendorVal = _field(w, ['Vendor']).toUpperCase();
    const suppVal   = _field(w, ['Suppliers']).toUpperCase();
    const l1Val     = _field(w, ['L1 Area of Concern']).toUpperCase();
    if (/FLEET\s*NET/.test(vendorVal) && l1Val === 'TOW') {
      _skippedFleetnetTow++;
      continue;
    }
    // Exclude VELOCITI orders entirely — they don't belong in the long-dwell
    // tracker. Matches the vendor or supplier being VELOCITI.
    if (/VELOCITI/.test(vendorVal) || /VELOCITI/.test(suppVal)) {
      _skippedVelociti++;
      continue;
    }

    const a = assetByUnit.get(unit) || {};

    // Site = the unit's HOME domicile. The asset export's "Domicile site" is
    // the authoritative home; fall back to the WR export's "Asset Domicile
    // Site" (the WO's site) when the asset row is missing.
    const site = _field(a, ['Domicile site', 'Domicile Site'])
      || _field(w, ['Asset Domicile Site', 'Reported location']);

    // SCAC = the carrier/operator code (asset export "Operator", e.g. JLIT).
    const scac = _field(a, ['Operator', 'SCAC', 'Carrier']);

    const expectedEtc = _field(w, ['Expected completed date time', 'Scheduled date time']);
    // Days Down counts from when the unit went down. Best available signal is
    // the actual/expected start of the open WO; fall back to scheduled/modified.
    const downStart = _field(w, ['Actual start date time', 'Expected start date time', 'Scheduled date time', 'Last modified time']);

    // Long Dwell = extended-down units only. Drop anything down fewer than
    // MIN_DAYS_DOWN days. If the days can't be computed (no usable date), keep
    // the row rather than silently dropping it.
    const daysDown = _daysSince(downStart);
    if (daysDown !== '' && Number(daysDown) < MIN_DAYS_DOWN) { _skippedShortDwell++; continue; }

    // FAS / UM: auto-filled from the scraped FAS roster by (SCAC + Site).
    // Blank when the roster has no confident match (or hasn't been fetched).
    const fasName = _roster.fasFor(scac, site);
    const umName  = _roster.umFor(scac, site);

    const mapped = {
      'FAS': fasName,                                                        // roster lookup (SCAC + Site); '' if no match
      'UM': umName,                                                          // roster Uptime Manager (SCAC + Site); '' if no match
      'Asset ID': unitRaw,                                                   // human unit number (join key)
      'Asset Type': _field(w, ['Asset Type']) || _field(a, ['Asset type', 'Asset Type']),
      'Site': site,
      'SCAC': scac,
      'Lifecycle State Reason': _field(w, ['Lifecycle State Reason']) || _field(a, ['Lifecycle state reason']),
      'Days Down': daysDown,
      'RG Vendor Assigned': _field(w, ['Vendor', 'Suppliers']),
      'Vendor Delay Reason': _field(w, ['Delay reason codes']),
      'Expected ETC': expectedEtc,
      'Level 1': _field(w, ['L1 Area of Concern']),
      'Level 2': _field(w, ['L2 Area of Concern']),
    };

    rows.push({ assetId: unitRaw, site, csv: { ...mapped } });
  }

  // Diagnostics: how well did the join + mapping do? Logs the asset headers
  // (so we can confirm the real column names) and per-column fill rates.
  try {
    const matched = rows.filter((r) => assetByUnit.has(_unitKey(r.assetId))).length;
    logger.info('[merge] WR rows=' + wr.rows.length + ' asset rows=' + asset.rows.length
      + ' tracker rows=' + rows.length + ' joined-to-asset=' + matched
      + ' skipped-fleetnet-tow=' + _skippedFleetnetTow + ' skipped-velociti=' + _skippedVelociti
      + ' skipped-under-' + MIN_DAYS_DOWN + 'd=' + _skippedShortDwell);
  } catch (_) {}

  return { columns: TRACKER_COLUMNS.slice(), rows };
}

const MAX = {
  key:        256,
  field:      8000,   // Required Notes bullet blocks can be long
  shortField: 512,
  rows:       5000,   // hard cap on an imported dataset
};

// The manual (team-filled) columns. Everything else comes from the CSV import
// verbatim and is read-only in the UI.
const MANUAL_FIELDS = ['delayReason', 'escalationAction', 'supportPOC', 'asanaLink', 'notes'];

function _clip(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Shared import: writes a { columns, rows[] } payload into the store, carrying
// forward any existing manual (N–R) edits whose rowKey survives the re-import.
// Used by both the file-import handler and the AAP-fetch handler.
function _applyImport(payload) {
  const columns = Array.isArray(payload.columns) ? payload.columns.map((c) => _clip(c, MAX.shortField)) : [];
  const incoming = Array.isArray(payload.rows) ? payload.rows : [];
  if (incoming.length > MAX.rows) throw new ConfigError('CSV too large (' + incoming.length + ' rows, max ' + MAX.rows + ')', 'rows');

  const prev = store.load('longDwellCsv', { rows: {} });
  const prevRows = (prev && prev.rows) || {};

  const rows = {};
  incoming.forEach((r, idx) => {
    const assetId = _clip((r && r.assetId) || '', MAX.shortField).trim();
    const site    = _clip((r && r.site) || '', MAX.shortField).trim();
    const key     = (assetId || 'row') + '::' + (site || '-') + '::' + idx;
    const csv     = {};
    if (r && r.csv && typeof r.csv === 'object') {
      for (const [k, v] of Object.entries(r.csv)) csv[_clip(k, MAX.shortField)] = _clip(v, MAX.field);
    }
    const priorManual = (prevRows[key] && prevRows[key].manual) || {};
    const manual = {};
    for (const f of MANUAL_FIELDS) manual[f] = priorManual[f] || '';
    rows[key] = { assetId, site, csv, manual, updatedAt: new Date().toISOString() };
  });

  const data = { importedAt: new Date().toISOString(), columns, rows };
  store.save('longDwellCsv', data);
  logger.info('Imported long-dwell CSV: ' + incoming.length + ' rows, ' + columns.length + ' columns');
  return { count: incoming.length, columns: columns.length };
}

// Shared AAP fetch+import used by BOTH the manual "Fetch from AAP" button and
// the scheduler. Tries the fast JSON API path first, falls back to the legacy
// CSV export. Returns { ok, count, columns, source } or { ok:false, error }.
async function _fetchAapAndImport(opts = {}) {
  // ── PRIMARY: JSON API path (fast, no CSV, no extra window, reuses the
  //    already-authenticated AAP API client).
  try {
    const api = require('../scrapers/aap_api');
    const ld  = require('../scrapers/aap_longdwell');
    const src = await api.buildLongDwellSources({
      searchRequest: opts.searchRequest || ld.DEFAULT_SEARCH_REQUEST,
    });
    if (src && Array.isArray(src.wrRows) && src.wrRows.length) {
      const importPayload = _mergeRowObjects(src.wrRows, src.assetRows);
      if (importPayload && importPayload.rows.length) {
        const applied = _applyImport(importPayload);
        logger.info('Long Dwell via API: imported ' + applied.count + ' rows');
        return { ok: true, count: applied.count, columns: applied.columns, source: 'aap-api' };
      }
      logger.warn('Long Dwell API: WR rows present but 0 merged — falling back to CSV export');
    } else {
      logger.warn('Long Dwell API: no WR rows — falling back to CSV export');
    }
  } catch (e) {
    logger.warn('Long Dwell API path failed (' + e.message + ') — falling back to CSV export');
  }

  // ── FALLBACK: the legacy CSV /download export (BrowserWindow + CSRF token).
  const { fetchBothSources } = require('../scrapers/aap_longdwell');
  const res = await fetchBothSources(opts);
  if (!res || !res.ok) {
    logger.warn('AAP fetch failed: ' + (res && res.error));
    return { ok: false, error: (res && res.error) || 'AAP fetch failed' };
  }
  const importPayload = _mergeToImportPayload(res.wrCsv, res.assetCsv);
  if (!importPayload || !importPayload.rows.length) {
    const wrFirst    = String(res.wrCsv || '').split(/\r?\n/).slice(0, 2).join(' || ');
    const assetFirst = String(res.assetCsv || '').split(/\r?\n/).slice(0, 2).join(' || ');
    logger.warn('AAP merge produced no rows. WR first lines: ' + wrFirst.slice(0, 600));
    logger.warn('AAP merge produced no rows. Asset first lines: ' + assetFirst.slice(0, 600));
    return { ok: false, error: 'AAP returned data from both sources but no rows could be merged (unit-number join found no matches).' };
  }
  const applied = _applyImport(importPayload);
  logger.info('AAP two-source merge (CSV fallback) imported ' + applied.count + ' rows');
  return { ok: true, count: applied.count, columns: applied.columns, source: 'aap-csv' };
}

// ── Auto-fetch scheduler ─────────────────────────────────────────────────────
// Default schedule (disabled until the user turns it on in the gear panel).
// days: 0=Sun..6=Sat. time: "HH:MM" 24h local. aiFill: run AI-fill-all (blank
// rows) in the renderer right after a successful fetch.
const DEFAULT_SCHEDULE = { enabled: false, days: [1, 2, 3, 4, 5], time: '07:00', aiFill: true };

function _loadSchedule() {
  const s = store.load('longDwellSchedule', DEFAULT_SCHEDULE) || DEFAULT_SCHEDULE;
  return {
    enabled: !!s.enabled,
    days: Array.isArray(s.days) ? s.days.filter((d) => d >= 0 && d <= 6) : DEFAULT_SCHEDULE.days,
    time: /^\d{2}:\d{2}$/.test(s.time || '') ? s.time : DEFAULT_SCHEDULE.time,
    aiFill: s.aiFill !== false,
  };
}

let _schedTimer = null;
let _lastRunMinuteKey = null;   // guards against double-firing within the same minute

// Fire the scheduled run: fetch from AAP, then (if enabled + a window is open)
// tell the renderer to AI-fill the blank rows.
async function _runScheduledFetch(sched) {
  logger.info('[ld-schedule] scheduled run starting (aiFill=' + sched.aiFill + ')');
  let fetchRes;
  try { fetchRes = await _fetchAapAndImport({}); }
  catch (e) { logger.warn('[ld-schedule] fetch threw: ' + e.message); return; }
  if (!fetchRes || !fetchRes.ok) { logger.warn('[ld-schedule] fetch failed: ' + (fetchRes && fetchRes.error)); return; }
  logger.info('[ld-schedule] fetched ' + fetchRes.count + ' rows (' + fetchRes.source + ')');
  // Notify the renderer so the open table refreshes, and — if configured —
  // kick off AI-fill-all for blank rows (AI-fill lives in the renderer because
  // it needs the signed-in session + live fleet state).
  try {
    const win = require('electron').BrowserWindow.getAllWindows()[0];
    if (win && win.webContents) {
      win.webContents.send('long-dwell-csv:scheduled-fetched', { count: fetchRes.count, aiFill: !!sched.aiFill });
    } else {
      logger.warn('[ld-schedule] no window open — fetched data saved; AI-fill will run next time the tab is opened');
    }
  } catch (e) { logger.warn('[ld-schedule] renderer notify failed: ' + e.message); }
}

// Check once a minute whether NOW matches the schedule. Fully guarded: this
// runs on a timer, so an unhandled throw here becomes an UNCAUGHT EXCEPTION
// that can take down the whole main process (and with it the Orcha WS server).
// Never let a tick throw.
function _scheduleTick() {
  try {
    const sched = _loadSchedule();
    if (!sched.enabled) return;
    const now = new Date();
    const dow = now.getDay();
    if (!sched.days.includes(dow)) return;
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (hhmm !== sched.time) return;
    const minuteKey = now.toDateString() + ' ' + hhmm;
    if (_lastRunMinuteKey === minuteKey) return;   // already ran this minute
    _lastRunMinuteKey = minuteKey;
    _runScheduledFetch(sched);
  } catch (e) {
    try { logger.warn('[ld-schedule] tick error (non-fatal): ' + e.message); } catch (_) {}
  }
}

function _startScheduler() {
  if (_schedTimer) return;
  // Align to the top of each minute-ish; a 30s tick guarantees we never miss
  // the matching minute even with timer drift.
  _schedTimer = setInterval(_scheduleTick, 30 * 1000);
  logger.info('[ld-schedule] scheduler started (30s tick)');
}

function registerLongDwellCsvIPC() {
  // Return the whole imported dataset (CSV rows + saved manual annotations).
  handle('long-dwell-csv:get', () => store.load('longDwellCsv', { importedAt: null, columns: [], rows: {} }));

  // Schedule get/save for the auto-fetch gear panel.
  handle('long-dwell-csv:get-schedule', () => _loadSchedule());
  handle('long-dwell-csv:save-schedule', (_e, payload) => {
    const p = (payload && typeof payload === 'object') ? payload : {};
    const next = {
      enabled: !!p.enabled,
      days: Array.isArray(p.days) ? [...new Set(p.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_SCHEDULE.days,
      time: /^\d{2}:\d{2}$/.test(p.time || '') ? p.time : DEFAULT_SCHEDULE.time,
      aiFill: p.aiFill !== false,
    };
    store.save('longDwellSchedule', next);
    logger.info('[ld-schedule] saved: ' + JSON.stringify(next));
    return { ok: true, schedule: next };
  });

  // Replace the dataset with a freshly imported CSV. Preserves any existing
  // manual annotations whose rowKey still exists in the new import, so a
  // re-import of an updated CSV does NOT wipe the team's filled-in columns.
  handle('long-dwell-csv:import', (_e, payload) => {
    requireObject(payload, 'payload');
    return _applyImport(payload);
  });

  // Fetch BOTH AAP exports (no manual download) and import the merged result.
  // Opens authenticated off-screen AAP windows for the WR page and the asset
  // page, captures the live CSRF token on each, hits both export endpoints,
  // merges them on unit number into the tracker's A–M columns, and runs the
  // result through the SAME import path as a file import (so manual N–R edits
  // are carried forward).
  handle('long-dwell-csv:fetch-aap', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    return _fetchAapAndImport(opts);
  });

  // Save one manual field edit for one row.
  handle('long-dwell-csv:save-row', (_e, payload) => {
    requireObject(payload, 'payload');
    const key = requireStringMax(payload.rowKey, 'rowKey', MAX.key);
    const field = String(payload.field || '').trim();
    if (!MANUAL_FIELDS.includes(field)) throw new ConfigError('Invalid field: ' + field, 'field');
    const value = _clip(payload.value, MAX.field);

    let updated = null;
    store.update('longDwellCsv', (s) => {
      if (!s || !s.rows || !s.rows[key]) {
        throw new ConfigError('Row not found: ' + key, 'rowKey');
      }
      if (!s.rows[key].manual) s.rows[key].manual = {};
      s.rows[key].manual[field] = value;
      s.rows[key].updatedAt = new Date().toISOString();
      updated = s.rows[key];
      return s;
    }, { importedAt: null, columns: [], rows: {} });

    return { ok: true, row: updated };
  });

  // Clear the whole imported dataset (and its annotations).
  handle('long-dwell-csv:clear', () => {
    store.save('longDwellCsv', { importedAt: null, columns: [], rows: {} });
    logger.info('Cleared imported long-dwell CSV');
    return { ok: true };
  });

  _startScheduler();
  logger.info('Long-dwell CSV IPC handlers registered');
}

module.exports = {
  registerLongDwellCsvIPC,
  MANUAL_FIELDS,
  // ── test seams (pure functions; no electron/store side effects) ──────────
  // Exported so the merge/join/exclusion logic the API + CSV paths share can be
  // unit-tested directly. Not part of the IPC surface.
  _mergeRowObjects,
  _mergeToImportPayload,
  _parseToObjects,
  _unitKey,
  _daysSince,
  MIN_DAYS_DOWN,
  TRACKER_COLUMNS,
};
