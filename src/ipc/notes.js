'use strict';
/**
 * ipc/notes.js - Unit notes CRUD IPC handlers
 * notes:get-unit, notes:get-all, notes:save-unit, notes:delete-unit
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #7 MED: notes:save-unit applies per-field length caps so an
 *                   unbounded notes blob cannot bloat the store indefinitely.
 *   - All handlers migrated to handle() wrapper.
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:notes');
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require('../utils/errors');

// ── Issue #7: field length caps ──────────────────────────────────────────────
const NOTES_MAX_LENGTHS = {
  equipmentId:         32,
  repairStatus:        128,
  primaryComponent:    128,
  salesforceCase:      64,
  salesforceCaseUrl:   512,
  offsiteShopEvent:    128,
  offsiteShopEventUrl: 512,
  asistSource:         32,
  asistLabel:          256,
  asistSrUrl:          512,
  asistScrapedAt:      32,
  dealerName:          128,
  subVendor:           128,
  notes:               4096,  // free-text field — generous but bounded
};

function _truncateField(val, field) {
  if (val === undefined || val === null) return undefined;
  const s   = String(val);
  const max = NOTES_MAX_LENGTHS[field];
  if (max && s.length > max) {
    logger.warn('notes:save-unit field truncated:', field, s.length, '->', max);
    return s.slice(0, max);
  }
  return s;
}

function registerNotesIPC() {
  handle('notes:get-unit', (_e, equipmentId) => {
    const s = store.load('notesStore', {});
    return s[equipmentId] || {};
  });

  handle('notes:get-all', () => store.load('notesStore', {}));

  // Issue #7: each field is length-capped before reaching the store
  handle('notes:save-unit', (_e, payload) => {
    const id = String((payload && payload.equipmentId) || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    if (id.length > NOTES_MAX_LENGTHS.equipmentId) {
      throw new ConfigError('equipmentId too long (max ' + NOTES_MAX_LENGTHS.equipmentId + ')', 'equipmentId');
    }

    store.update('notesStore', (s) => {
      const ex = s[id] || {};
      s[id] = {
        ...ex,
        equipmentId:         id,
        repairStatus:        _truncateField(payload.repairStatus        !== undefined ? payload.repairStatus        : ex.repairStatus        || '', 'repairStatus'),
        primaryComponent:    _truncateField(payload.primaryComponent    !== undefined ? payload.primaryComponent    : ex.primaryComponent    || '', 'primaryComponent'),
        salesforceCase:      _truncateField(payload.salesforceCase      !== undefined ? payload.salesforceCase      : ex.salesforceCase      || '', 'salesforceCase'),
        salesforceCaseUrl:   _truncateField(payload.salesforceCaseUrl   !== undefined ? payload.salesforceCaseUrl   : ex.salesforceCaseUrl   || '', 'salesforceCaseUrl'),
        offsiteShopEvent:    _truncateField(payload.offsiteShopEvent    !== undefined ? payload.offsiteShopEvent    : ex.offsiteShopEvent    || '', 'offsiteShopEvent'),
        offsiteShopEventUrl: _truncateField(payload.offsiteShopEventUrl !== undefined ? payload.offsiteShopEventUrl : ex.offsiteShopEventUrl || '', 'offsiteShopEventUrl'),
        asistSource:         _truncateField(payload.asistSource         !== undefined ? payload.asistSource         : ex.asistSource         || '', 'asistSource'),
        asistLabel:          _truncateField(payload.asistLabel          !== undefined ? payload.asistLabel          : ex.asistLabel          || '', 'asistLabel'),
        asistSrUrl:          _truncateField(payload.asistSrUrl          !== undefined ? payload.asistSrUrl          : ex.asistSrUrl          || '', 'asistSrUrl'),
        asistScrapedAt:      _truncateField(payload.asistScrapedAt      !== undefined ? payload.asistScrapedAt      : ex.asistScrapedAt      || '', 'asistScrapedAt'),
        dealerName:          _truncateField(payload.dealerName          !== undefined ? payload.dealerName          : ex.dealerName          || '', 'dealerName'),
        subVendor:           _truncateField(payload.subVendor           !== undefined ? payload.subVendor           : ex.subVendor           || '', 'subVendor'),
        notes:               _truncateField(payload.notes               !== undefined ? payload.notes               : ex.notes              || '', 'notes'),
        updatedAt:           new Date().toISOString(),
      };
      return s;
    });

    const note = (store.load('notesStore', {}))[id];
    logger.info('Notes saved for unit:', id);
    return { ok: true, note };
  });

  handle('notes:delete-unit', (_e, equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    store.update('notesStore', (s) => { delete s[id]; return s; });
    logger.info('Notes deleted for unit:', id);
    return { ok: true };
  });

  logger.info('Notes IPC handlers registered');
}

module.exports = { registerNotesIPC };
