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
//
// CRITICAL: the AAP /serviceaggregates/search endpoint REQUIRES fleetIds (the
// 9 fleet UUIDs) and a NON-EMPTY statuses list — a bare/over-cleared body
// returns nothing (or 500s). So we START from the proven DEFAULT_SEARCH_REQUEST
// (which carries the fleetIds the whole app uses) and only WIDEN it for history:
//   - category: null         -> include PM/planned/unplanned (not just UNPLANNED)
//   - statuses: FULL set      -> include COMPLETED/CANCELLED (the bulk of history),
//                                not just the 8 open statuses the default uses
//   - equipmentIds: [unit]    -> scope to one unit
//   - modified window         -> rolling 365d (full) or since-checkpoint (incr)
const HISTORY_STATUSES = [
  'CREATED', 'ESTIMATE_APPROVED', 'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED',
  'PENDING', 'PENDING_REVIEW', 'SCHEDULED', 'WORK_IN_PROGRESS', 'WORK_ORDER_ASSIGNED',
  'COMPLETED', 'CLOSED', 'CANCELLED', 'REOPENED', 'TRANSFERRED', 'DONE',
];

// `category` is a NON-NULLABLE field on the API (null => 500
// "KotlinInvalidNullException ... category"). The valid values are the
// work-request categories UNPLANNED and PLANNED, so to capture the FULL repair
// history we run one search per category and merge (syncUnit loops HISTORY_CATEGORIES).
const HISTORY_CATEGORIES = ['UNPLANNED', 'PLANNED'];

function _historyBody(opts = {}) {
  const now = Date.now();
  const modifiedFrom = opts.sinceMs != null ? opts.sinceMs : (now - YEAR_MS);
  let base = {};
  try { base = require('../scrapers/aap_longdwell').DEFAULT_SEARCH_REQUEST || {}; } catch (_) { base = {}; }
  // Clone so we never mutate the shared default.
  const body = JSON.parse(JSON.stringify(base));
  body.category = opts.category || 'UNPLANNED'; // REQUIRED non-null; one per call
  body.statuses = HISTORY_STATUSES;     // include completed/cancelled history
  body.subStatuses = [];
  body.urgencyFilter = 'ALL';
  body.modifiedFromEpochMs = modifiedFrom;
  body.modifiedToEpochMs = opts.toMs != null ? opts.toMs : now;
  body.sortConfig = { sortColumn: 'ModifiedDate', sortDirection: 'descending' };
  body.page = 1;
  // Scope to one unit. equipmentIds on the body narrows the (fleetId-scoped)
  // search to this unit only.
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
  // The API requires a non-null `category`, so we query each HISTORY_CATEGORY
  // (UNPLANNED + PLANNED) and merge. Each call is hard-timeout'd so a stalled
  // session (VPN/token) can never hang the whole operation.
  logger.info('[' + eq + '] sync ' + (opts.incremental ? 'incr' : 'full') + ' start (since=' + (sinceMs || 'default') + ')');
  const timeoutMs = opts.timeoutMs || 90000;
  const byId = new Map();
  let anyOk = false;
  for (const category of HISTORY_CATEGORIES) {
    try {
      const search = api.searchAllPages(_historyBody({ sinceMs, equipmentIds: [eq], category }), { maxPages: opts.maxPages || 20 });
      const list = await Promise.race([
        search,
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('AAP search timed out after ' + Math.round(timeoutMs / 1000) + 's (session/VPN?)'), { code: 'AAP_TIMEOUT' })), timeoutMs)),
      ]);
      anyOk = true;
      for (const wo of (list || [])) {
        const sid = String((wo && (wo.workRequestId || wo.id)) || '').trim();
        if (sid && !byId.has(sid)) byId.set(sid, wo);
      }
      logger.info('[' + eq + '] category ' + category + ': ' + (list ? list.length : 0) + ' work orders');
    } catch (e) {
      result.errors.push(category + ' search failed: ' + e.message);
      logger.warn('[' + eq + '] ' + category + ' search failed: ' + e.message);
    }
  }
  if (!anyOk) {
    result.coverage.relay = 'failed';
    return result; // every category call failed; prior history preserved
  }
  result.coverage.relay = 'ok';
  const aggregates = Array.from(byId.values());
  result.retrieved = aggregates.length;
  logger.info('[' + eq + '] retrieved ' + aggregates.length + ' work orders (merged across categories)');

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
