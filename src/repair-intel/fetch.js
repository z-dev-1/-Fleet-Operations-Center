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
// Per-unit history query. This MIRRORS the proven findOpenWO/refreshUnit path
// in aap_api.js, which is the ONLY query shape confirmed to return a unit's full
// work-order history live. Key facts learned the hard way from the live API:
//   - searchServices() shallow-merges the given fields OVER DEFAULT_SEARCH_REQUEST,
//     so we pass ONLY the few fields we want to change — NOT the whole default body.
//   - `statuses: []` (empty) means "all statuses" and returns the unit's ENTIRE
//     history (open + completed + cancelled). A specific status LIST returned 0.
//   - `category` is non-nullable in the DEFAULT body shape, so ATTEMPT 1 leaves
//     the default category in place; ATTEMPT 2 (widened) nulls category + the
//     other dimensions to catch WOs outside the default program/fleet/lifecycle.
//   - the unit number must be UPPERCASE.
// We do NOT send a modified-date window here: `statuses:[]` already returns the
// full history, and the default body has no date filter — adding one risks the
// same over-constraint that returned 0. The 365-day scoping is applied when we
// read back for the report (eventsForUnit's window), not at fetch time.
function _historyBody(opts = {}) {
  const u = String((opts.equipmentIds && opts.equipmentIds[0]) || '').trim().toUpperCase();
  if (opts.widened) {
    // ATTEMPT 2 — clear the restrictive dimensions (null = no filter on them).
    return { equipmentIds: [u], statuses: [], category: null,
      lifecycleStates: null, assetPrograms: null, fleetIds: null, page: 1 };
  }
  // ATTEMPT 1 — fast path: just scope to the unit + all statuses.
  return { equipmentIds: [u], statuses: [], page: 1 };
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

  // 1) Unit's full WO history. Two-tier, mirroring the proven refreshUnit path:
  //    ATTEMPT 1 (fast): { equipmentIds:[u], statuses:[] } — returns the unit's
  //    entire history when its WOs fall inside the default program/fleet.
  //    ATTEMPT 2 (widened): nulls category/lifecycle/program/fleet to catch WOs
  //    outside the default set. Each call is hard-timeout'd so a stalled session
  //    can never hang the operation.
  logger.info('[' + eq + '] sync ' + (opts.incremental ? 'incr' : 'full') + ' start');
  const timeoutMs = opts.timeoutMs || 90000;
  const _timed = (p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('AAP search timed out after ' + Math.round(timeoutMs / 1000) + 's'), { code: 'AAP_TIMEOUT' })), timeoutMs)),
  ]);

  let aggregates = [];
  try {
    aggregates = await _timed(api.searchAllPages(_historyBody({ equipmentIds: [eq] }), { maxPages: opts.maxPages || 20 }));
    // Fall back to the widened query if the fast path found nothing (the unit's
    // WOs may be in a program/fleet/category outside the default body).
    if (!aggregates.length) {
      logger.info('[' + eq + '] fast path 0 WOs — trying widened query');
      aggregates = await _timed(api.searchAllPages(_historyBody({ equipmentIds: [eq], widened: true }), { maxPages: opts.maxPages || 20 }));
    }
    result.coverage.relay = 'ok';
  } catch (e) {
    result.coverage.relay = 'failed';
    result.errors.push('relay search failed: ' + e.message);
    logger.warn('[' + eq + '] relay search failed: ' + e.message);
    return result; // prior history preserved
  }
  result.retrieved = aggregates.length;
  logger.info('[' + eq + '] retrieved ' + aggregates.length + ' work orders');

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
