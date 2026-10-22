'use strict';
/**
 * ipc/repair-intel.js — renderer bridge for the Fleet Repair Intelligence
 * engine (12-month unit repair history + deterministic report).
 *
 * Channels (all per-unit, all best-effort — never throw to the renderer):
 *   repair-history:get         read the cached deterministic report (fast; no network)
 *   repair-history:build       full 365-day sync from AAP, then build the report
 *   repair-history:fetch-new   incremental sync (since last checkpoint), then report
 *   repair-history:refresh-ai  (Phase 4) re-run AI narrative/classification — stub for now
 *
 * The report is 100% deterministic (counts/durations/repeat-failures/
 * effectiveness) built from stored ri_repair_event rows. The AI layer (Phase 4)
 * only adds narrative + advisory recommendations on top; it never changes the
 * numbers and never touches canonical readiness.
 */

let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

function registerRepairIntelIPC(ctx) {
  const { ipcMain } = require('electron');
  const report = require('../repair-intel/report');
  const fetch = require('../repair-intel/fetch');
  const store = require('../repair-intel/store');

  function handle(ch, fn) {
    ipcMain.handle(ch, async (e, ...args) => {
      try { return await fn(...args); }
      catch (err) {
        logger.warn(ch + ' failed: ' + err.message);
        return { ok: false, error: err.message };
      }
    });
  }

  // Read the cached deterministic report for a unit (no network). Also returns
  // the sync checkpoint so the UI can show coverage / last-sync status.
  handle('repair-history:get', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    return { ok: true, report: rep, checkpoint, synced: !!checkpoint };
  });

  // Full 365-day build: sync from AAP then return the fresh report. This hits
  // the network (authenticated AAP API) and can take a while for busy units.
  handle('repair-history:build', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const sync = await fetch.syncUnit(id, { incremental: false });
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    return { ok: sync.ok, sync, report: rep, checkpoint, synced: !!checkpoint };
  });

  // Incremental: only pull work orders modified since the last checkpoint.
  handle('repair-history:fetch-new', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const sync = await fetch.syncUnit(id, { incremental: true });
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    return { ok: sync.ok, sync, report: rep, checkpoint, synced: !!checkpoint };
  });

  // Phase 4 placeholder: AI narrative/classification refresh. Returns a clear
  // not-yet-available signal so the UI can disable/label the control honestly.
  handle('repair-history:refresh-ai', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    try {
      const analysis = require('../repair-intel/analysis');
      if (analysis && typeof analysis.analyzeUnit === 'function') {
        const res = await analysis.analyzeUnit(id, { force: true });
        const rep = report.buildUnitReport(id);
        return { ok: true, analysis: res, report: rep };
      }
    } catch (_) { /* analysis.js not built yet (Phase 4) */ }
    return { ok: false, pending: true, error: 'AI analysis not available yet' };
  });

  logger.info('repair-intel IPC registered');
}

module.exports = { registerRepairIntelIPC };
