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
 *   repair-history:wo-3c       per-WO AI 3C summaries (flag repairIntel.woSummaries, default OFF)
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
  const trends = require('../repair-intel/trends');
  const vendorNetwork = require('../repair-intel/vendor-network');

  function handle(ch, fn) {
    ipcMain.handle(ch, async (e, ...args) => {
      try { return await fn(...args); }
      catch (err) {
        logger.warn(ch + ' failed: ' + err.message);
        return { ok: false, error: err.message };
      }
    });
  }

  // Shape the cached AI narrative + recommendations for the renderer (null when
  // not yet analyzed). Deterministic report is always present regardless.
  function _cachedAi(id) {
    try {
      const rec = store.getAiAnalysis(id);
      const recs = store.getRecommendations('unit', id) || [];
      let payload = null;
      if (rec && rec.report_json) { try { payload = JSON.parse(rec.report_json); } catch (_) {} }
      if (!payload && !recs.length) return null;
      return {
        summary: payload ? payload.summary : '',
        recommendations: recs.map(r => ({
          kind: r.kind, finding: r.finding, reason: r.reason, recommendedAction: r.recommended_action,
          priority: r.priority, confidence: r.confidence,
          supportingWos: (() => { try { return JSON.parse(r.supporting_wos || '[]'); } catch (_) { return []; } })(),
        })),
        analyzedAt: rec ? rec.analyzed_at : null,
        modelId: rec ? rec.model_id : null,
      };
    } catch (_) { return null; }
  }

  // repairIntel flag group (read per call; defaults on failure).
  function _flags() {
    try { return require('../config/perf-flags').loadRepairIntel(); }
    catch (_) { return { woSummaries: false, dealerBackfill: true }; }
  }

  // The unit's fleet row (for the owned-offsite dealer fallback), or null.
  function _unitRow(id) {
    try {
      const data = require('../store').load('fleetData', { rows: [] }) || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      return rows.find(r => String(r && r.equipmentId) === id) || null;
    } catch (_) { return null; }
  }

  // Read the cached deterministic report for a unit (no network). Also returns
  // the sync checkpoint so the UI can show coverage / last-sync status.
  handle('repair-history:get', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    const ai = _cachedAi(id);
    return { ok: true, report: rep, checkpoint, synced: !!checkpoint, ai, woSummaries: _flags().woSummaries };
  });

  // Full 365-day build: sync from AAP then return the fresh report. This hits
  // the network (authenticated AAP API) and can take a while for busy units.
  handle('repair-history:build', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const f = _flags();
    const sync = await fetch.syncUnit(id, { incremental: false, hydrateDetail: f.dealerBackfill, unitRow: _unitRow(id) });
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    return { ok: sync.ok, sync, report: rep, checkpoint, synced: !!checkpoint, ai: _cachedAi(id), woSummaries: f.woSummaries };
  });

  // Incremental: only pull work orders modified since the last checkpoint.
  handle('repair-history:fetch-new', async (equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    const f = _flags();
    const sync = await fetch.syncUnit(id, { incremental: true, hydrateDetail: f.dealerBackfill, unitRow: _unitRow(id) });
    const rep = report.buildUnitReport(id);
    const checkpoint = store.getCheckpoint(id) || null;
    return { ok: sync.ok, sync, report: rep, checkpoint, synced: !!checkpoint, ai: _cachedAi(id), woSummaries: f.woSummaries };
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
        if (res && res.ok === false) return { ok: false, pending: !!res.pending, error: res.error, report: rep, ai: _cachedAi(id) };
        return { ok: true, analysis: res, report: rep, ai: _cachedAi(id) };
      }
    } catch (err) { logger.warn('analysis load/run failed: ' + err.message); }
    return { ok: false, pending: true, error: 'AI analysis not available yet' };
  });

  // Per-WO AI 3C summaries (flag repairIntel.woSummaries, default OFF). Lazy
  // fill = low priority; force (Refresh AI) = normal priority. One run per unit
  // at a time: a concurrent call shares the running promise; a force call that
  // arrives during a non-forced run waits for it, then runs forced.
  const _wo3cInflight = new Map();
  handle('repair-history:wo-3c', async (equipmentId, opts) => {
    const id = String(equipmentId || '').trim();
    if (!id) return { ok: false, error: 'no equipment id' };
    if (!_flags().woSummaries) return { ok: false, disabled: true };
    const o = opts || {};
    const force = !!o.force;
    const cur = _wo3cInflight.get(id);
    if (cur) {
      if (!force || cur.force) return cur.promise;
      try { await cur.promise; } catch (_) {}
      const again = _wo3cInflight.get(id);
      if (again) return again.promise;
    }
    const run = (async () => {
      const ts = (e) => e.reported_at || e.created_at || 0;
      let events = store.eventsForUnit(id).slice().sort((a, b) => ts(b) - ts(a)).slice(0, 40);
      if (Array.isArray(o.ids)) { const want = new Set(o.ids.map(String)); events = events.filter(e => want.has(String(e.work_order_id)) || want.has(String(e.source_id))); }
      const ws = require('../repair-intel/wo-summary');
      const dealerLink = require('../repair-intel/dealer-link');
      const row = _unitRow(id);
      const res = await ws.createWoSummarizer(ws.defaultDeps()).summarize(events, {
        force, priority: force ? 'normal' : 'low',
        offsiteFor: e => dealerLink.offsiteNotesFor(row, e.work_order_id),
      });
      return { ok: true, results: res.results, counts: res.counts, report: report.buildUnitReport(id) };
    })();
    const entry = { promise: run, force };
    _wo3cInflight.set(id, entry);
    try { return await run; }
    finally { if (_wo3cInflight.get(id) === entry) _wo3cInflight.delete(id); }
  });

  // ── Trends dashboard (fleet-wide deterministic aggregation) ───────────────
  // opts is a plain filter spec from the renderer; trends.js only interpolates
  // whitelisted columns and binds everything else, so there is no SQL-injection
  // surface. Returns totals + top-N groupings + monthly volume + outcomes.
  handle('repair-trends:get', async (opts) => {
    return trends.buildTrends(opts || {});
  });

  // Distinct filter values to populate the Trends dropdowns.
  handle('repair-trends:filters', async () => {
    return { ok: true, options: trends.filterOptions() };
  });

  // Drill into a trend: the units + events behind a clicked dimension/value,
  // with each event's failure complaint + "why" (delay/cancellation/scope/root
  // cause) and a work-order URL. This is the investigate-the-trend path.
  handle('repair-trends:drill', async (dimension, value, opts) => {
    return trends.drillEvents(String(dimension || ''), value, opts || {});
  });

  // Deep slice: per-component (L1/L2)/vendor/make repetitive-fault analysis —
  // events vs distinct units vs repeat ratio, the repeating units, and the
  // make/vendor cross-tab. The "is it 10 units once or 1 unit 10x" engine.
  handle('repair-trends:deep-slice', async (groupBy, opts) => {
    return trends.deepSlice(String(groupBy || 'subcomponent'), opts || {});
  });

  // Repeat offenders: units with the same component 2+ times (fleet-wide).
  handle('repair-trends:repeat-offenders', async (opts) => {
    return trends.repeatOffenders(opts || {});
  });

  // Unit Health Scoreboard: composite maintenance score per unit, worst->best.
  handle('repair-trends:unit-health', async (opts) => {
    return trends.unitHealth(opts || {});
  });

  // ── Vendor scope / network intelligence (deterministic) ───────────────────
  // Per-vendor scorecards + repeat-failure rates + multi-vendor-per-component
  // signals. Excluded vendors filtered at the query layer. Advisory only.
  handle('repair-network:get', async (opts) => {
    return vendorNetwork.buildNetwork(opts || {});
  });

  logger.info('repair-intel IPC registered');
}

module.exports = { registerRepairIntelIPC };
