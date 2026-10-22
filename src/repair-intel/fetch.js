/**
 * repair-intel/fetch.js — Phase 1 data collection (NO AI).
 *
 * Pulls a unit's (or the fleet's) 365-day repair history from AAP using the
 * EXISTING authenticated API client, normalizes each work order into a
 * ri_repair_event row, and upserts idempotently. Deterministic only — dates,
 * counts, durations, and status come straight from source fields; interpretation
 * (root cause, effectiveness, recommendations) is a SEPARATE AI phase.
 *
 * Widened search body (per the repo audit): to capture completed/cancelled/PM
 * history across a year you must NULL OUT the restrictive dimensions of the
 * default long-dwell body (which is scoped to open/UNPLANNED/UNAVAILABLE). Use
 * `null` (NOT []) for category/statuses/lifecycleStates/assetPrograms, and set
 * `modifiedFromEpochMs` to the window start (full = now-365d; incremental = last
 * checkpoint).
 *
 * Reuses: aap_api.searchAllPages / getService / getAsset / getServiceMoves,
 * aap_api_mapper.isExcludedVendor (vendor exclusion chokepoint), and the
 * repair-intel/store normalize+upsert.
 */

let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }
const store = require('./store');
const { ensureSchema } = require('./schema');

const YEAR_MS = 365 * 24 * 3600 * 1000;

// Build the WIDENED search body for a rolling window. Nulling the restrictive
// dimensions is required (empty [] over-constrains and returns nothing).
function _historyBody(opts = {}) {
  const now = Date.now();
  const modifiedFrom = opts.sinceMs != null ? opts.sinceMs : (now - YEAR_MS);
  const body = {
    category: null,
    statuses: [],              // all statuses (open + completed + cancelled + ...)
    lifecycleStates: null,
    assetPrograms: null,
    fleetIds: null,
    urgencyFilter: 'ALL',
    modifiedFromEpochMs: modifiedFrom,
    modifiedToEpochMs: opts.toMs != null ? opts.toMs : now,
    sortConfig: { sortColumn: 'ModifiedDate', sortDirection: 'descending' },
    page: 1,
  };
  if (opts.equipmentIds) body.equipmentIds = opts.equipmentIds;
  if (opts.assetDomicileSites) body.assetDomicileSites = opts.assetDomicileSites;
  return body;
}

// Fetch the full/incremental repair history for ONE unit. Returns a structured
// result with counts + source coverage + any errors (partial failure never
// throws away prior valid history — we only upsert what we successfully got).
async function syncUnit(equipmentId, opts = {}) {
  const eq = String(equipmentId || '').trim();
  const result = { ok: false, equipmentId: eq, retrieved: 0, added: 0, updated: 0, unchanged: 0,
    excluded: 0, errors: [], coverage: { relay: 'unknown', offsite: 'unknown', asset: 'unknown' }, maxModified: 0 };
  if (!eq) { result.errors.push('no equipment id'); return result; }
  if (!ensureSchema()) { result.errors.push('sqlite unavailable'); return result; }

  const api = require('../scrapers/aap_api');
  const mapper = require('../scrapers/aap_api_mapper');

  // Incremental: start from the last checkpoint's modified cursor if present and
  // the caller asked for incremental (opts.incremental). Full build ignores it.
  let sinceMs = opts.sinceMs;
  const cp = store.getCheckpoint(eq);
  if (opts.incremental && cp && cp.last_modified_seen) sinceMs = cp.last_modified_seen;

  // 1) Bulk WO list for this unit over the window (deterministic, no AI).
  let aggregates = [];
  try {
    aggregates = await api.searchAllPages(_historyBody({ sinceMs, equipmentIds: [eq] }), { maxPages: opts.maxPages || 20 });
    result.coverage.relay = 'ok';
  } catch (e) {
    result.coverage.relay = 'failed';
    result.errors.push('relay search failed: ' + e.message);
    logger.warn('[' + eq + '] relay search failed: ' + e.message);
    return result; // can't proceed without the list; prior history preserved
  }
  result.retrieved = aggregates.length;

  // 2) Asset master fields (VIN/make/model/year/odometer) — one call, reused.
  let asset = {};
  try {
    const aaid = aggregates.find(a => a && a.aaid) ? aggregates.find(a => a.aaid).aaid : null;
    if (aaid && api.getAsset) {
      const full = await api.getAsset(aaid);
      asset = (mapper.assetDetailFields ? mapper.assetDetailFields(full) : {}) || {};
      result.coverage.asset = 'ok';
    } else { result.coverage.asset = 'no-aaid'; }
  } catch (e) { result.coverage.asset = 'failed'; result.errors.push('asset fetch: ' + e.message); }

  // 3) Normalize + upsert each WO. Detail hydration (getService) is bounded —
  //    we only need it for the comment thread the AI phase reads later, so we do
  //    NOT fetch detail for every WO here (keeps Phase 1 cheap). Structured
  //    fields come from the aggregate itself.
  for (const wo of aggregates) {
    try {
      const vendor = wo && wo.vendor;
      if (mapper.isExcludedVendor && mapper.isExcludedVendor(vendor)) { result.excluded++; continue; }
      const row = store.normalizeWorkOrder(wo, asset);
      if (!row) continue;
      if (row.modified_at && row.modified_at > result.maxModified) result.maxModified = row.modified_at;
      const r = store.upsertEvent(row);
      if (r === 'added') result.added++;
      else if (r === 'updated') result.updated++;
      else if (r === 'unchanged') result.unchanged++;
    } catch (e) { result.errors.push('normalize/upsert ' + (wo && (wo.id || wo.workRequestId)) + ': ' + e.message); }
  }

  // 4) Checkpoint (incremental cursor + coverage). Never truncates prior data.
  try {
    store.saveCheckpoint({
      equipmentId: eq,
      lastFullSyncAt: opts.incremental ? (cp && cp.last_full_sync_at) : Date.now(),
      lastIncrSyncAt: Date.now(),
      lastModifiedSeen: result.maxModified || (cp && cp.last_modified_seen) || null,
      windowStartAt: sinceMs != null ? sinceMs : (Date.now() - YEAR_MS),
      sourceCoverage: result.coverage,
      lastError: result.errors.length ? result.errors.slice(0, 5).join(' | ') : null,
      recordsTotal: (store.eventsForUnit(eq, { includeExcluded: true }) || []).length,
    });
  } catch (e) { result.errors.push('checkpoint: ' + e.message); }

  result.ok = result.coverage.relay === 'ok';
  logger.info('[' + eq + '] sync ' + (opts.incremental ? 'incr' : 'full') + ': retrieved=' + result.retrieved +
    ' added=' + result.added + ' updated=' + result.updated + ' unchanged=' + result.unchanged + ' excluded=' + result.excluded +
    (result.errors.length ? ' errors=' + result.errors.length : ''));
  return result;
}

// Hydrate ONE work order's detail (comment thread) on demand — used by the AI
// phase / the unit report, NOT by the bulk Phase-1 collector. Returns the
// mapper's detail object or null.
async function hydrateWoDetail(sourceId) {
  try {
    const api = require('../scrapers/aap_api');
    if (!api.getService) return null;
    return await api.getService(sourceId);
  } catch (e) { logger.warn('hydrateWoDetail ' + sourceId + ' failed: ' + e.message); return null; }
}

module.exports = { syncUnit, hydrateWoDetail, _historyBody, YEAR_MS };
