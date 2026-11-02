'use strict';
// armApiRefresh: the single ownership decision for the recurring API fleet refresh.
// Returns { owned, timer }. Exactly one is truthy unless alreadyArmed.
//
// Phase 5 worker supervisor (2026-10-30, design §4.7). Called only from
// src/window/index.js _showApp() in API mode. Flag off
// (workers.supervised.apiFleetRefresh, default OFF): the same two log lines
// and the same setInterval(() => { load(); }, intervalMs) as before (not
// unref'd). Flag on: the supervisor runs load() on the same 5 min grid.
// Backoff is inert for this worker (maxFailures 3 → at most 138 s, below the
// 5 min interval); the coalesce guard, live-pull gate and auth handling stay
// inside _loadFleetViaApiStartupImpl.
function armApiRefresh({ alreadyArmed, claim, setIntervalFn, load, intervalMs, logger }) {
  if (alreadyArmed) {
    logger.info('[data-source] API refresh already scheduled \u2014 not double-scheduling');
    return { owned: false, timer: null };
  }
  let owned = false;
  try {
    owned = claim({
      name: 'apiFleetRefresh', group: 'fleet', label: 'Fleet API refresh',
      tick: () => load(), intervalMs, timeoutMs: 15 * 60 * 1000,
      maxFailures: 3, cooldownMs: 30 * 60 * 1000,
      dependsOn: [],   // live-pull gate + auth handling stay inside _loadFleetViaApiStartupImpl
      idempotent: true,
    }) === true;
  } catch (_) { owned = false; }
  if (owned) {
    logger.info('[data-source] API mode \u2014 recurring API refresh supervised');
    return { owned: true, timer: null };
  }
  logger.info('[data-source] API mode \u2014 scheduling recurring API refresh (no scrape rescan)');
  return { owned: false, timer: setIntervalFn(() => { load(); }, intervalMs) };
}
module.exports = { armApiRefresh };
