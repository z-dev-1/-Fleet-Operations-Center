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

  // TEMP — locate operator / bodyType / domicileSite fields in BOTH the WO and
  // the full asset for a unit, so the mapper reads the right paths. Remove after.
  handle('aap-api:probe-fields', async (_e, payload) => {
    const unit = String((payload && payload.unit) || '').trim().toUpperCase();
    try {
      const search = await api().searchServices({ page: 1, equipmentIds: [unit], statuses: [] });
      const wo = ((search && search.serviceAggregates) || [])[0] || {};
      const woHits = {};
      for (const k of Object.keys(wo)) {
        if (/operator|owner|carrier|scac|body|domicile|site|type|program|make|manufactur/i.test(k)) {
          const v = wo[k];
          woHits[k] = (v == null || typeof v !== 'object') ? String(v).slice(0, 50) : '{obj ' + Object.keys(v).slice(0,6).join(',') + '}';
        }
      }
      let assetHits = [];
      if (wo.aaid) {
        const asset = await api().getAsset(wo.aaid);
        (function scan(obj, path, depth) {
          if (!obj || typeof obj !== 'object' || depth > 5) return;
          for (const k of Object.keys(obj)) {
            const p = path ? path + '.' + k : k;
            const v = obj[k];
            if (/operator|owner|carrier|scac|body|domicile|site|program|make|manufactur/i.test(k) && (v == null || typeof v !== 'object')) {
              assetHits.push({ path: p, value: String(v).slice(0, 50) });
            }
            if (v && typeof v === 'object') scan(v, p, depth + 1);
          }
        })(asset, '', 0);
      }
      return { ok: true, unit, woHits, assetHits };
    } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  logger.info('AAP API IPC handlers registered');
}

module.exports = { registerAapApiIPC };
