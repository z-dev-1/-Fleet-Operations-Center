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

  // WR ESCALATION context: feature gate + live teams for the unit's fleet +
  // the WR's live current escalations, in one round trip. payload:
  // { fleetId?, aaid, workRequestId? } (a bare string = fleetId).
  handle('aap-api:escalation-options', async (_e, payload) => {
    try {
      const p = (typeof payload === 'string') ? { fleetId: payload }
        : ((payload && typeof payload === 'object') ? payload : {});
      const aaid = p.fleetId ? '' : requireStringMax(p.aaid || '', 'aaid', 128);
      const workRequestId = p.workRequestId ? requireStringMax(String(p.workRequestId), 'workRequestId', 128) : '';
      const user = await api().getUserDetails();
      if (!api()._hasEscalateFeature(user)) return { ok: true, enabled: false, options: [], current: [] };
      const fleetId = p.fleetId ? String(p.fleetId)
        : ((a) => (a && (a.asset || a)).fleetId)(await api().getAsset(aaid));
      if (!fleetId) return { ok: false, error: 'Could not resolve fleetId', code: 'NO_FLEET_ID' };
      const options = await api().getEscalationOptions(fleetId);
      let current = [];
      let currentError;
      if (workRequestId) {
        try { current = api()._currentEscalations(await api().getService(workRequestId)); }
        catch (e) { current = []; currentError = e.message; }
      }
      const out = { ok: true, enabled: true, fleetId, options, current };
      if (currentError) out.currentError = currentError;
      return out;
    } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // Escalate / de-escalate a WR. createdBy is ALWAYS the signed-in AAP user's
  // alias from getUserDetails — any renderer-supplied createdBy is ignored.
  handle('aap-api:update-escalations', async (_e, payload) => {
    try {
      const p = (payload && typeof payload === 'object') ? payload : {};
      const workRequestId = requireStringMax(p.workRequestId || '', 'workRequestId', 128);
      const aaid = requireStringMax(p.aaid || '', 'aaid', 128);
      const list = (v, name) => {
        const arr = v == null ? [] : v;
        if (!Array.isArray(arr) || arr.length > 20 || arr.some((x) => typeof x !== 'string')) {
          return { error: name + ' must be an array of at most 20 strings' };
        }
        return { arr };
      };
      const a = list(p.add, 'add');
      if (a.error) return { ok: false, error: a.error, code: 'ESCALATION_INVALID' };
      const r = list(p.remove, 'remove');
      if (r.error) return { ok: false, error: r.error, code: 'ESCALATION_INVALID' };
      const comment = p.comment == null ? '' : String(p.comment);
      const user = await api().getUserDetails();
      if (!api()._hasEscalateFeature(user)) {
        return { ok: false, error: 'Escalation is not enabled for this AAP user', code: 'ESCALATE_NOT_ENABLED' };
      }
      const createdBy = api()._userAlias(user);
      if (!createdBy) return { ok: false, error: 'Could not resolve the AAP user alias', code: 'NO_USER_ALIAS' };
      const res = await api().updateEscalations({ workRequestId, aaid, add: a.arr, remove: r.arr, comment, createdBy });
      let current = null;
      try { current = api()._currentEscalations(await api().getService(workRequestId)); } catch (_) {}
      return { ok: true, current, response: res && res.response };
    } catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // AI (with deterministic fallback) suggestion for which team to escalate to.
  handle('aap-api:escalation-suggest', async (_e, payload) => {
    try {
      const p = (payload && typeof payload === 'object') ? payload : {};
      const unitId = requireStringMax(String(p.unit || ''), 'unit', 64);
      const options = (Array.isArray(p.options) ? p.options : []).slice(0, 100)
        .filter((o) => o && typeof o === 'object')
        .map((o) => ({ value: String(o.value == null ? '' : o.value), displayText: String(o.displayText == null ? '' : o.displayText) }));
      const current = (Array.isArray(p.current) ? p.current : []).filter((x) => typeof x === 'string');
      const suggestion = await require('../orcha/escalation-suggest').suggestEscalation({ unitId, options, current });
      return { ok: true, suggestion };
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
  // RETIRED SCRAPE (2026-10-28): the API is the only fleet source
  // (src/config/data-source.js). Reports the effective source, not the legacy
  // settings value.
  handle('fleet:get-data-source', () => {
    const ds = require('../config/data-source');
    return { source: ds.isApiMode() ? 'api' : 'scrape', scrapeRetired: true };
  });

  // Toggle (or set) the data source. When switched to 'api', immediately loads
  // the fleet via the API so the change is visible right away. When 'scrape',
  // triggers the existing rescan. Persisted to settings.dataSource.
  handle('fleet:set-data-source', async (_e, payload) => {
    // RETIRED SCRAPE (2026-10-28): 'scrape' can no longer be selected. Any
    // request is treated as 'api' (reload via API). settings.dataSource is NOT
    // rewritten, so no stored data changes.
    if (payload && payload.source === 'scrape') {
      logger.warn('[data-source] request to switch to scrape REFUSED — scraping is retired; staying on API');
    }
    const want = 'api';
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
  // VENDOR-CONFIG PROBE (diagnostic, read-only). Logs the RAW supplier/location
  // shape for a few named vendors so we can see whether suppliers[] carry a
  // location + distance (needed for 'preferred vendor location' auto-pick).
  // Gated by VENDOR_PROBE=1.
  if (String(process.env.VENDOR_PROBE || '').trim() === '1') {
    setTimeout(async () => {
      try {
        const vendors = await api().getVendorConfigs({ force: true });
        const want = /gabrielli|kwne|allegiance|cox/i;
        const hits = (vendors || []).filter((v) => want.test(String(v.vendorName || '')));
        logger.info('[vendor-probe] matched ' + hits.length + ' vendors; raw supplier shapes:\n' +
          JSON.stringify(hits.map((v) => ({ vendorName: v.vendorName, supplierRequired: v.supplierRequired, suppliers: v.suppliers })), null, 2));
      } catch (e) { logger.warn('[vendor-probe] failed: ' + e.message); }
    }, 9000);
  }
  // DOC-UPLOAD STEP-1 PROBE (diagnostic, uploads NOTHING). Requesting a
  // presigned uploadLink is read-only — it does NOT create a WR and does NOT
  // attach a file (we never do the S3 PUT here). Validates our uploadLink
  // request body + enum values against a REAL existing WR id and logs the
  // response shape. Set DOC_PROBE_UNIT to a unit that already has an open WR.
  const _docProbeUnit = String(process.env.DOC_PROBE_UNIT || '').trim();
  if (_docProbeUnit) {
    setTimeout(async () => {
      try {
        const fd = store.load('fleetData', { rows: [] });
        const rows = (fd && Array.isArray(fd.rows)) ? fd.rows : [];
        const row = rows.find((r) => String(r.equipmentId || r.assetId || r.id) === _docProbeUnit);
        if (!row) { logger.warn('[doc-probe] unit ' + _docProbeUnit + ' not found'); return; }
        if (!row.workRequestId) { logger.warn('[doc-probe] unit ' + _docProbeUnit + ' has no open workRequestId'); return; }
        logger.info('[doc-probe] requesting uploadLink for WR ' + row.workRequestId + ' (NO file uploaded, NO WR created)');
        const resp = await api().getDocumentUploadLink({
          serviceEntityId: row.workRequestId,
          vendor: (row.vendor || '').split(' (')[0] || null,
          filename: 'probe-test.png',
          mime: 'image/png',
        });
        logger.info('[doc-probe] uploadLink RESPONSE:\n' + JSON.stringify(resp, null, 2));
      } catch (e) {
        logger.warn('[doc-probe] FAILED: ' + e.message + (e.code ? ' (' + e.code + ')' : ''));
      }
    }, 9000);
  }

  // U/P-COUNT PROBE (diagnostic, read-only). Discovers the REAL AAP field names
  // for open Unplanned/Planned work-request counts. Fetches the FULL asset
  // (getAsset) and logs every top-level key + any key that looks WR/count
  // related, AND dumps the distinct wo.category values from the WO search for
  // that unit. Set UP_PROBE_UNIT to a unit that HAS open WRs (e.g. 320160).
  const _upProbeUnit = String(process.env.UP_PROBE_UNIT || '').trim();
  if (_upProbeUnit) {
    setTimeout(async () => {
      try {
        // Resolve aaid by asset search on displayName (stored rows don't keep aaid).
        let aaid = null;
        let searchSample = null;
        try {
          const sres = await api().searchAssets({ from: 0, fieldFilters: [{ key: 'displayName', values: [_upProbeUnit] }] });
          const list = (sres && sres.assets) || [];
          const hit = list.find((a) => String(a.asset && a.asset.displayName) === _upProbeUnit) || list[0];
          searchSample = hit;
          aaid = hit && hit.asset && hit.asset.aaid;
          if (hit) {
            logger.info('[up-probe] asset-SEARCH record top keys: ' + JSON.stringify(Object.keys(hit)));
            logger.info('[up-probe] asset-SEARCH record FULL:\n' + JSON.stringify(hit, null, 2).slice(0, 6000));
          }
        } catch (e) { logger.warn('[up-probe] asset search failed: ' + e.message); }
        if (!aaid) { logger.warn('[up-probe] could not resolve aaid for unit ' + _upProbeUnit); return; }
        logger.info('[up-probe] fetching full asset for unit ' + _upProbeUnit + ' aaid=' + aaid);
        const asset = await api().getAsset(aaid);
        const dumpKeys = (obj, prefix) => {
          const out = [];
          for (const k of Object.keys(obj || {})) {
            const v = obj[k];
            const path = prefix ? prefix + '.' + k : k;
            if (/work|wr|plan|request|count|unplan|open/i.test(k)) {
              out.push(path + ' = ' + JSON.stringify(Array.isArray(v) ? { __array_len: v.length, sample: v.slice(0, 2) } : v));
            }
            if (v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 2) {
              out.push(...dumpKeys(v, path));
            }
          }
          return out;
        };
        logger.info('[up-probe] asset TOP-LEVEL keys: ' + JSON.stringify(Object.keys(asset || {})));
        if (asset && asset.asset) logger.info('[up-probe] asset.asset keys: ' + JSON.stringify(Object.keys(asset.asset)));
        logger.info('[up-probe] WR/count-looking fields:\n' + (dumpKeys(asset, '').join('\n') || '(none matched work|wr|plan|request|count|open)'));
        // WO-category angle: category is NON-nullable — must search each value.
        const OPEN_WO_STATUSES = ['CREATED', 'PENDING', 'PENDING_REVIEW', 'SCHEDULED',
          'WORK_IN_PROGRESS', 'WORK_ORDER_ASSIGNED', 'ESTIMATE_APPROVED',
          'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED'];
        for (const cat of ['UNPLANNED', 'PLANNED']) {
          try {
            const wos = await api().searchAllPages({ equipmentIds: [_upProbeUnit], statuses: OPEN_WO_STATUSES, category: cat }, { maxPages: 5 });
            const sObj = (wos || [])[0] && (wos[0].status);
            logger.info('[up-probe] ' + cat + ' OPEN WOs for ' + _upProbeUnit + ' = ' + (wos || []).length +
              '; sample status obj=' + JSON.stringify(sObj));
          } catch (e) { logger.warn('[up-probe] ' + cat + ' WO search failed: ' + e.message); }
        }
      } catch (e) {
        logger.warn('[up-probe] FAILED: ' + e.message + (e.code ? ' (' + e.code + ')' : ''));
      }
    }, 9000);
  }

  const _vreMatrixUnits = String(process.env.VRE_MATRIX_UNIT || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (_vreMatrixUnits.length) {
    setTimeout(async () => {
      for (const u of _vreMatrixUnits) {
        try {
          const res = await _runVreMatrix(u);
          logger.info('[vre-matrix] (startup) SUMMARY ' + u + ':\n' + JSON.stringify(res, null, 2));
        } catch (e) { logger.warn('[vre-matrix] (startup) FAILED ' + u + ': ' + e.message); }
      }
    }, 8000); // let auth + first sync settle
  }

  logger.info('AAP API IPC handlers registered');
}

module.exports = { registerAapApiIPC };
