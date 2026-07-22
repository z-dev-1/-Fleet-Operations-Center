'use strict';
/**
 * ipc/long-dwell.js — Long Dwell Units CRUD IPC handlers
 * long-dwell:get-all, long-dwell:save-unit, long-dwell:delete-unit
 *
 * Backs the Analytics -> "Long Dwell Units" tab (2026-07-20). Stores the
 * user-entered delay reason / escalation level / summary per unit, keyed by
 * equipmentId, in its own store (longDwellStore) so it survives restarts and
 * fleet-data re-syncs (fleetData rows are wholly replaced on every sync —
 * annotating them directly would be lost the next time relay/AAP data loads).
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:long-dwell');
const { handle } = require('./_safe');
const { ConfigError } = require('../utils/errors');

// Fixed enums — kept in sync with the dropdown options rendered in
// analytics.js. Server-side validation here is defense-in-depth: a stale
// renderer bundle or a hand-crafted IPC call should not be able to write an
// arbitrary/unbounded string into these two fields.
const DELAY_REASONS = [
  'Primary Vendor', 'Parts Delay', 'Offsite Shop', 'Estimate Process',
  'Payment', 'Speciality Vendor', 'Out of Scope for FAS',
  'End of Life Review', 'PMR', 'MCS SW Miss', 'Weather', 'Towing',
  'Reconditioning', 'Repaired',
];
const ESCALATION_LEVELS = ['SEV5', 'SEV4', 'SEV3', 'SEV2']; // SEV2 = highest

const MAX_LENGTHS = {
  equipmentId: 32,
  summary:     2048,
};

function _truncate(val, field) {
  if (val === undefined || val === null) return '';
  const s   = String(val);
  const max = MAX_LENGTHS[field];
  if (max && s.length > max) {
    logger.warn('long-dwell:save-unit field truncated:', field, s.length, '->', max);
    return s.slice(0, max);
  }
  return s;
}

function registerLongDwellIPC() {
  handle('long-dwell:get-all', () => store.load('longDwellStore', {}));

  handle('long-dwell:get-unit', (_e, equipmentId) => {
    const s = store.load('longDwellStore', {});
    return s[String(equipmentId || '').trim()] || {};
  });

  handle('long-dwell:save-unit', (_e, payload) => {
    const id = String((payload && payload.equipmentId) || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    if (id.length > MAX_LENGTHS.equipmentId) {
      throw new ConfigError('equipmentId too long (max ' + MAX_LENGTHS.equipmentId + ')', 'equipmentId');
    }

    let delayReason = payload && payload.delayReason !== undefined ? String(payload.delayReason).trim() : undefined;
    if (delayReason !== undefined && delayReason !== '' && !DELAY_REASONS.includes(delayReason)) {
      throw new ConfigError('Invalid delayReason: ' + delayReason, 'delayReason');
    }

    let escalationLevel = payload && payload.escalationLevel !== undefined ? String(payload.escalationLevel).trim() : undefined;
    if (escalationLevel !== undefined && escalationLevel !== '' && !ESCALATION_LEVELS.includes(escalationLevel)) {
      throw new ConfigError('Invalid escalationLevel: ' + escalationLevel, 'escalationLevel');
    }

    let updated;
    store.update('longDwellStore', (s) => {
      const ex = s[id] || {};
      s[id] = {
        equipmentId:     id,
        delayReason:     delayReason     !== undefined ? delayReason     : (ex.delayReason     || ''),
        escalationLevel: escalationLevel !== undefined ? escalationLevel : (ex.escalationLevel || ''),
        summary:         payload && payload.summary !== undefined ? _truncate(payload.summary, 'summary') : (ex.summary || ''),
        updatedAt:       new Date().toISOString(),
      };
      updated = s[id];
      return s;
    }, {});

    return { ok: true, unit: updated };
  });

  handle('long-dwell:delete-unit', (_e, equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    store.update('longDwellStore', (s) => { delete s[id]; return s; }, {});
    logger.info('Long-dwell entry deleted for unit:', id);
    return { ok: true };
  });

  logger.info('Long-dwell IPC handlers registered');
}

module.exports = { registerLongDwellIPC, DELAY_REASONS, ESCALATION_LEVELS };
