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

function registerLongDwellCsvIPC() {
  // Return the whole imported dataset (CSV rows + saved manual annotations).
  handle('long-dwell-csv:get', () => store.load('longDwellCsv', { importedAt: null, columns: [], rows: {} }));

  // Replace the dataset with a freshly imported CSV. Preserves any existing
  // manual annotations whose rowKey still exists in the new import, so a
  // re-import of an updated CSV does NOT wipe the team's filled-in columns.
  handle('long-dwell-csv:import', (_e, payload) => {
    requireObject(payload, 'payload');
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
      // Carry forward prior manual edits for this exact key if present.
      const priorManual = (prevRows[key] && prevRows[key].manual) || {};
      const manual = {};
      for (const f of MANUAL_FIELDS) manual[f] = priorManual[f] || '';
      rows[key] = { assetId, site, csv, manual, updatedAt: new Date().toISOString() };
    });

    const data = { importedAt: new Date().toISOString(), columns, rows };
    store.save('longDwellCsv', data);
    logger.info('Imported long-dwell CSV: ' + incoming.length + ' rows, ' + columns.length + ' columns');
    return { ok: true, count: incoming.length, columns: columns.length };
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

  logger.info('Long-dwell CSV IPC handlers registered');
}

module.exports = { registerLongDwellCsvIPC, MANUAL_FIELDS };
