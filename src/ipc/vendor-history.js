'use strict';
/**
 * ipc/vendor-history.js -- Persist/load vendor workflow history [V-C]
 * S25-4 (2026-06-29)
 *
 * Handles two channels:
 *   vendor:history-load  ()           -> { history: Object }  (_equipmentId -> [...])
 *   vendor:history-save  { history }  -> { ok: true }
 *
 * Data stored in P.vendorHistory (vendor_history.json, max 10 entries per unit).
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:vendor-history');
const { handle } = require('./_safe');

const HISTORY_MAX = 10;

function registerVendorHistoryIPC() {
  // Load full history object from disk
  handle('vendor:history-load', async () => {
    const history = store.load('vendorHistory', {});
    return { history };
  });

  // Save full history object to disk (renderer sends trimmed copy)
  handle('vendor:history-save', async (_e, payload) => {
    if (!payload || typeof payload.history !== 'object') {
      throw new Error('vendor:history-save: payload.history must be an object');
    }
    // Trim each unit's array to HISTORY_MAX for belt-and-suspenders safety
    const trimmed = {};
    for (const [unitId, arr] of Object.entries(payload.history)) {
      if (!Array.isArray(arr)) continue;
      trimmed[unitId] = arr.slice(0, HISTORY_MAX);
    }
    store.save('vendorHistory', trimmed);
    logger.info('vendor history saved —', Object.keys(trimmed).length, 'units');
    return { ok: true };
  });
}

module.exports = { registerVendorHistoryIPC };
