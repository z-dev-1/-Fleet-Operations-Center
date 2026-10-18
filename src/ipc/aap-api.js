'use strict';
/**
 * ipc/aap-api.js — IPC surface for the direct Relay Garage / AAP JSON API.
 *
 * Thin wrappers over src/scrapers/aap_api.js so the renderer (and a quick
 * self-test) can exercise the 8 endpoints over the app's Midway session.
 */

const logger = require('../utils/logger')('ipc:aap-api');
const { handle, requireStringMax } = require('./_safe');

function registerAapApiIPC(ctx) {
  const api = () => require('../scrapers/aap_api');
  const store = require('../store');

  // Self-test / auth probe: the cheapest GET. Confirms the API path works end
  // to end (window auth + token capture not even needed for GET). Returns the
  // current user, or a structured error.
  handle('aap-api:selftest', async () => {
    try {
      const user = await api().getUserDetails();
      return { ok: true, endpoint: '/api/v1/user/details', user };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Bulk WORK-ORDER search (POST). Overrides shallow-merge onto the proven full
  // filter body (a bare body 500s). Pass { page, statuses, ... } to override.
  handle('aap-api:search', async (_e, payload) => {
    const req = (payload && typeof payload === 'object') ? payload : {};
    try {
      const res = await api().searchServices(req);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Bulk ASSET search (POST /api/v2/assets/search). Overrides shallow-merge onto
  // the proven asset filter body.
  handle('aap-api:search-assets', async (_e, payload) => {
    const req = (payload && typeof payload === 'object') ? payload : {};
    try {
      const res = await api().searchAssets(req);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Full service aggregate by serviceId (GET).
  handle('aap-api:service', async (_e, payload) => {
    const id = requireStringMax((payload && payload.serviceId) || '', 'serviceId', 128);
    try { return { ok: true, service: await api().getService(id) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // Full asset by aaid (GET).
  handle('aap-api:asset', async (_e, payload) => {
    const aaid = requireStringMax((payload && payload.aaid) || '', 'aaid', 128);
    try { return { ok: true, asset: await api().getAsset(aaid) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // All AVM codes (GET) — reference data.
  handle('aap-api:avm-codes', async () => {
    try { return { ok: true, codes: await api().getAvmCodes() }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // WR WIZARD LIVE LOOKUPS (auto-populate vendor + category dropdowns, always
  // current). Both read-only + cached in the API client.
  handle('aap-api:vendors', async (_e, payload) => {
    try { return { ok: true, vendors: await api().getVendorConfigs((payload && payload.opts) || {}) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });
  handle('aap-api:avm-tree', async (_e, payload) => {
    try {
      const type = (payload && (payload.equipmentType || payload.type)) || 'boxTruck';
      return { ok: true, equipmentType: type, tree: await api().getAvmTree(type, (payload && payload.opts) || {}) };
    } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // FULL PIPELINE — fetch all open work orders + index all assets, join by
  // aaid, return mapped tracker rows. opts: { searchRequest, maxPages }.
  handle('aap-api:build-tracker', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    try {
      const rows = await api().buildTrackerRows(opts);
      return { ok: true, count: rows.length, rows };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Build the full fleet dataset from the API in the app's fleet-row shape.
  // Additive / opt-in — does NOT replace the live scrape; returns the rows so
  // they can be previewed or (later) fed to the pipeline. opts passthrough:
  // { domiciles, withComments, withVin, maxPages, detailCap }.
  handle('aap-api:build-fleet', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    try {
      const ds = await api().buildFleetDataset(opts);
      return { ok: true, count: ds.count, unavailableCount: ds.unavailableCount, filter: ds.filter, rows: ds.rows };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Per-unit refresh — fresh single-unit data (open WO + asset + comment thread)
  // via the API. Feeds the detail-panel refresh. Returns the mapped fleet row.
  handle('aap-api:refresh-unit', async (_e, payload) => {
    const unit = String((payload && payload.unit) || '').trim();
    if (!unit) return { ok: false, error: 'no unit number' };
    try {
      const row = await api().refreshUnit(unit);
      return { ok: true, row };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Side-by-side VERIFY — build the API fleet dataset and compare its unit set +
  // key fields against the stored (scrape) fleetData, so the user can confirm
  // parity before switching the data source. Returns summary + mismatches.
  handle('aap-api:verify-vs-stored', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    try {
      const store = require('../store');
      const fd = store.load('fleetData', { rows: [] });
      const stored = (fd.rows || []);
      const storedByUnit = new Map(stored.map((r) => [String(r.equipmentId || '').toUpperCase(), r]));
      const storedUnavail = stored.filter((r) => /unavailable/i.test(String(r.lifecycleState || '')));

      // API dataset: skip the heavy comment/VIN enrichment for a fast parity check.
      const ds = await api().buildFleetDataset(Object.assign({ withComments: false, withVin: false }, opts));
      const apiByUnit = new Map(ds.rows.map((r) => [String(r.equipmentId || '').toUpperCase(), r]));
      const apiUnavail = ds.rows.filter((r) => /unavailable/i.test(String(r.lifecycleState || '')));

      const storedUnits = new Set(storedUnavail.map((r) => String(r.equipmentId || '').toUpperCase()));
      const apiUnits = new Set(apiUnavail.map((r) => String(r.equipmentId || '').toUpperCase()));
      const inBoth = [...storedUnits].filter((u) => apiUnits.has(u));
      const onlyStored = [...storedUnits].filter((u) => !apiUnits.has(u));
      const onlyApi = [...apiUnits].filter((u) => !storedUnits.has(u));

      // Field-value mismatches among overlapping units (after mapping).
      const mismatches = [];
      for (const u of inBoth) {
        const s = storedByUnit.get(u), a = apiByUnit.get(u);
        const diff = {};
        if ((s.lifecycleReason || '') !== (a.lifecycleReason || '')) diff.lifecycleReason = { stored: s.lifecycleReason, api: a.lifecycleReason };
        if ((s.vendor || '') !== (a.vendor || '')) diff.vendor = { stored: s.vendor, api: a.vendor };
        if ((s.domicileSite || '') !== (a.domicileSite || '')) diff.site = { stored: s.domicileSite, api: a.domicileSite };
        if (Object.keys(diff).length) mismatches.push({ unit: u, diff });
      }

      // WHY are onlyStored units missing from the API unavailable set? For each,
      // search the API UNFILTERED (any status, any site) and report what it finds
      // so we can see if it's a status filter, a site filter, or genuinely absent.
      const onlyStoredDiag = [];
      for (const u of onlyStored.slice(0, 20)) {
        try {
          const res = await api().searchServices({ page: 1, equipmentIds: [u], statuses: [] });
          const list = (res && res.serviceAggregates) || [];
          const s = storedByUnit.get(u) || {};
          onlyStoredDiag.push({
            unit: u,
            storedSite: s.domicileSite || '',
            storedReason: s.lifecycleReason || '',
            apiWoCount: list.length,
            apiStatuses: [...new Set(list.map((w) => (w.status && w.status.value) || '?'))].slice(0, 6),
            apiSites: [...new Set(list.map((w) => w.assetDomicileSite || '?'))].slice(0, 6),
            apiLifecycle: [...new Set(list.map((w) => w.lifecycleState || '?'))].slice(0, 4),
          });
        } catch (e) { onlyStoredDiag.push({ unit: u, error: e.message }); }
      }

      return {
        ok: true,
        counts: {
          storedUnavailable: storedUnavail.length,
          apiUnavailable: apiUnavail.length,
          apiTotalUnits: ds.rows.length,
        },
        overlap: { inBoth: inBoth.length, onlyStored, onlyApi: onlyApi.length, onlyApiSample: onlyApi.slice(0, 15) },
        onlyStoredDiag,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 20),
      };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // ── OPT-IN: load the live fleet FROM THE API (not the scrape) ──────────────
  // Builds the full filtered fleet via the API, layers the enrichment the API
  // does NOT provide (Uptake riskScore/insights + saved notes), persists to the
  // same `fleetData` store, and pushes on the same `fleet:data` channel the
  // scrape uses — so the table, filters, KPIs, and detail panel update
  // identically. Keyed by equipmentId (unit number) for every merge. The scrape
  // path is untouched and remains the fallback.
  handle('fleet:load-via-api', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    try {
      logger.info('[load-via-api] building fleet dataset from API…');
      const ds = await api().buildFleetDataset(opts);
      let rows = ds.rows || [];

      // 1) Uptake enrichment (riskScore/insights) by digit-normalized equipmentId.
      //    ATS is truth for make/model, so this won't clobber API values.
      try {
        const uptakeUnits = (store.load('uptakeHash', {}).units) || [];
        if (ctx && ctx.mergeUptakeIntoRows) rows = ctx.mergeUptakeIntoRows(rows, uptakeUnits);
      } catch (e) { logger.warn('[load-via-api] uptake merge skipped: ' + e.message); }

      // 2) Saved notes (timeline, repair status, etc.) by equipmentId. Pass an
      //    EMPTY relayData so the relay merge does NOT override the API's
      //    vendor/WO/offsite/comment fields — it only folds in notesStore and
      //    lets the row's own offsite/PM fields pass through.
      try {
        const notesStore = store.load('notesStore', {});
        if (ctx && ctx.mergeRelayIntoRows) rows = ctx.mergeRelayIntoRows(rows, {}, notesStore);
      } catch (e) { logger.warn('[load-via-api] notes merge skipped: ' + e.message); }

      const now = new Date().toISOString();
      const outPayload = {
        rows,
        count: rows.length,
        unavailableCount: ds.unavailableCount,
        syncedAt: now,
        scrapedAt: now,
        stale: false,
        source: 'aap-api',
      };
      // Persist + push through the SAME path the scrape uses.
      store.save('fleetData', outPayload);
      if (ctx) { ctx.lastData = outPayload; if (ctx.pushData) ctx.pushData(outPayload); }
      logger.info('[load-via-api] pushed ' + rows.length + ' units ('
        + ds.unavailableCount + ' unavailable) to the renderer');
      return { ok: true, count: rows.length, unavailableCount: ds.unavailableCount };
    } catch (e) {
      logger.warn('[load-via-api] failed: ' + e.message);
      if (ctx && ctx.pushError) ctx.pushError('API load failed: ' + e.message);
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // ── Data-source toggle (API default, scrape fallback) ─────────────────────
  // Returns the current source and flips it. 'api' (default) | 'scrape'.
  handle('fleet:get-data-source', () => {
    const s = store.load('settings', {});
    return { source: s.dataSource === 'scrape' ? 'scrape' : 'api' };
  });

  // Toggle (or set) the data source. When switched to 'api', immediately loads
  // the fleet via the API so the change is visible right away. When 'scrape',
  // triggers the existing rescan. Persisted to settings.dataSource.
  handle('fleet:set-data-source', async (_e, payload) => {
    const want = (payload && payload.source === 'scrape') ? 'scrape' : 'api';
    const s = store.load('settings', {});
    s.dataSource = want;
    store.save('settings', s);
    logger.info('[data-source] set to ' + want);
    if (want === 'api') {
      // Prefer the shared window-side loader (same build+merge+push the startup
      // and recurring API refresh use) so there's ONE code path. Fall back to an
      // inline build if it isn't wired yet.
      if (ctx && ctx._loadFleetViaApiStartup) {
        try { await ctx._loadFleetViaApiStartup('toggle'); }
        catch (e) {
          logger.warn('[data-source] API load failed, falling back to scrape: ' + e.message);
          if (ctx && ctx.triggerRescan) ctx.triggerRescan(true);
          return { ok: false, source: want, error: e.message, fellBack: true };
        }
      } else {
        // Fast load (no comments — table is instant; comments load lazily per unit).
        try {
          const ds = await api().buildFleetDataset({ withComments: false });
          let rows = ds.rows || [];
          try { const uu = (store.load('uptakeHash', {}).units) || []; if (ctx && ctx.mergeUptakeIntoRows) rows = ctx.mergeUptakeIntoRows(rows, uu); } catch (_) {}
          try { const ns = store.load('notesStore', {}); if (ctx && ctx.mergeRelayIntoRows) rows = ctx.mergeRelayIntoRows(rows, {}, ns); } catch (_) {}
          const now = new Date().toISOString();
          const out = { rows, count: rows.length, unavailableCount: ds.unavailableCount, syncedAt: now, scrapedAt: now, stale: false, source: 'aap-api' };
          store.save('fleetData', out);
          if (ctx) { ctx.lastData = out; if (ctx.pushData) ctx.pushData(out); }
        } catch (e) {
          logger.warn('[data-source] API load failed, falling back to scrape: ' + e.message);
          if (ctx && ctx.triggerRescan) ctx.triggerRescan(true);
          return { ok: false, source: want, error: e.message, fellBack: true };
        }
      }
    } else {
      // Scrape mode: kick the existing rescan.
      if (ctx && ctx.triggerRescan) ctx.triggerRescan(true);
    }
    return { ok: true, source: want };
  });

  // VRE RECOMMENDATION MATRIX (diagnostic, commits NOTHING). Runs the full
  // combination matrix (urgent/non-urgent, tires, tow, multi-area, bare) live
  // against the real VRE endpoint for a unit and returns one row per scenario.
  // Triggerable from the renderer (window.aapApi.vreMatrix(unit)) OR at startup
  // via env VRE_MATRIX_UNIT. Phase 1 only — no work order is ever created.
  async function _runVreMatrix(unit) {
    const u = String(unit || '').trim();
    if (!u) return { ok: false, error: 'unit required' };
    const fd = store.load('fleetData', { rows: [] });
    const rows = (fd && Array.isArray(fd.rows)) ? fd.rows : [];
    const row = rows.find((r) => String(r.equipmentId || r.assetId || r.id) === u);
    if (!row) return { ok: false, error: 'unit ' + u + ' not found in stored fleetData (' + rows.length + ' rows)' };
    if (!row.assetUrl) return { ok: false, error: 'unit ' + u + ' has no assetUrl — run a sync first' };
    logger.info('[vre-matrix] unit ' + u + ' — running recommendation matrix (nothing committed)');
    return api().vreRecommendMatrix({ assetUrl: row.assetUrl, domicile: row.domicileSite, assetType: row.assetType });
  }
  handle('aap-api:vre-matrix', async (_e, payload) => {
    try { return await _runVreMatrix(payload && payload.unit); }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });
  const _vreMatrixUnit = String(process.env.VRE_MATRIX_UNIT || '').trim();
  if (_vreMatrixUnit) {
    setTimeout(async () => {
      try {
        const res = await _runVreMatrix(_vreMatrixUnit);
        logger.info('[vre-matrix] (startup) SUMMARY ' + _vreMatrixUnit + ':\n' + JSON.stringify(res, null, 2));
      } catch (e) { logger.warn('[vre-matrix] (startup) FAILED ' + _vreMatrixUnit + ': ' + e.message); }
    }, 8000); // let auth + first sync settle
  }

  logger.info('AAP API IPC handlers registered');
}

module.exports = { registerAapApiIPC };
