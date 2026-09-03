'use strict';
/**
 * scheduler/freshness.js — Pre-job data freshness gate (Task #4).
 *
 * Given a structured fleet-sync result (see src/sync/index.js runFullSync) and
 * a channel ('sharepoint' | 'email'), decides whether a SCHEDULED PRODUCTION
 * delivery may proceed. Policies are separate per channel and configurable via
 * settings.schedulerFreshness. The approved default is a HARD BLOCK on
 * stale / incomplete / failed-sync data for production; Test Mode may proceed
 * with a visible "stale data" banner instead of blocking.
 *
 * This gate NEVER presents cached data as fresh: if the sync used cache
 * (result.usedCache), production is blocked (or, in test mode, flagged with a
 * banner) — the caller must surface the blocked job, it must not silently send.
 *
 * Pure function of its inputs + settings; performs no I/O beyond reading the
 * policy from the settings store. Returns a structured decision — no throwing.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger')('scheduler-freshness'); } catch (_) { logger = { info(){}, warn(){} }; }

// Conservative production defaults (minutes / counts). Chosen so a normal
// weekday slot with a recent successful sync passes, but stale or degraded
// data is refused for production.
const DEFAULT_POLICY = Object.freeze({
  sp:    { maxDataAgeMin: 60, minRows: 3, blockOnFailedSources: true, blockOnCache: true },
  email: { maxDataAgeMin: 45, minRows: 3, blockOnFailedSources: true, blockOnCache: true },
});

// Sources that are informational only and must NOT, on their own, block a
// delivery when they fail (e.g. uptake enrichment). AAP is the authoritative
// inventory; relay is important but the fleet payload is still usable from
// cache. The blockOnFailedSources policy applies to the *authoritative* source
// set below; other failed sources are reported as warnings.
const AUTHORITATIVE_SOURCES = Object.freeze(['aap']);

function _policyFor(channel) {
  const saved = (store.load('settings', {}) || {}).schedulerFreshness || {};
  const base = DEFAULT_POLICY[channel] || DEFAULT_POLICY.email;
  const over = saved[channel] || {};
  return {
    maxDataAgeMin: Number.isFinite(over.maxDataAgeMin) ? over.maxDataAgeMin : base.maxDataAgeMin,
    minRows: Number.isFinite(over.minRows) ? over.minRows : base.minRows,
    blockOnFailedSources: over.blockOnFailedSources !== undefined ? !!over.blockOnFailedSources : base.blockOnFailedSources,
    blockOnCache: over.blockOnCache !== undefined ? !!over.blockOnCache : base.blockOnCache,
  };
}

/**
 * evaluate(syncResult, opts) -> decision
 *   opts: { channel:'sharepoint'|'email', testMode:bool }
 *   decision: {
 *     allow: bool,              // may the delivery proceed at all?
 *     block: bool,              // production hard-blocked (surface as blocked job)?
 *     banner: string|null,      // stale-data banner text (test mode allow-with-banner)
 *     reasons: string[],        // human-readable reasons
 *     policy,                   // effective policy used
 *     dataAgeMin: number|null,
 *     rowCount: number,
 *     usedCache: bool,
 *     failedAuthoritative: string[],
 *     failedOther: string[],
 *   }
 *
 * Rules:
 *   - Sync did not complete ok / produced no usable payload -> block (prod) /
 *     allow-with-banner (test) IF a usable cached payload age is known;
 *     otherwise block regardless of mode (nothing safe to send).
 *   - usedCache && policy.blockOnCache -> block (prod) / banner (test). Cache is
 *     never presented as fresh.
 *   - dataAgeMin > maxDataAgeMin -> block (prod) / banner (test).
 *   - rowCount < minRows -> block (prod) / banner (test) — likely empty/partial.
 *   - authoritative source failed && blockOnFailedSources -> block (prod) /
 *     banner (test).
 */
function evaluate(syncResult, opts) {
  opts = opts || {};
  const channel = opts.channel === 'sharepoint' ? 'sharepoint' : 'email';
  const key = channel === 'sharepoint' ? 'sp' : 'email';
  const testMode = !!opts.testMode;
  const policy = _policyFor(key);
  const sr = syncResult || {};

  const rowCount = Number.isFinite(sr.rowCount) ? sr.rowCount : 0;
  const dataAgeMin = Number.isFinite(sr.dataAgeMs) ? Math.round(sr.dataAgeMs / 60000) : null;
  const usedCache = !!sr.usedCache;
  const failed = Array.isArray(sr.sourcesFailed) ? sr.sourcesFailed : [];
  const failedAuthoritative = failed.filter(s => AUTHORITATIVE_SOURCES.includes(s));
  const failedOther = failed.filter(s => !AUTHORITATIVE_SOURCES.includes(s));

  const reasons = [];
  let fail = false;              // a production-blocking condition was hit
  let nothingSafeToSend = false; // no usable data exists at all

  if (!sr.ok) {
    reasons.push('sync did not complete successfully');
    fail = true;
    if (dataAgeMin === null || rowCount < policy.minRows) nothingSafeToSend = true;
  }
  if (usedCache && policy.blockOnCache) { reasons.push('data came from cache (not a fresh live sync)'); fail = true; }
  if (dataAgeMin !== null && dataAgeMin > policy.maxDataAgeMin) { reasons.push(`data age ${dataAgeMin}min exceeds max ${policy.maxDataAgeMin}min`); fail = true; }
  if (dataAgeMin === null) { reasons.push('data age unknown'); fail = true; nothingSafeToSend = nothingSafeToSend || rowCount < policy.minRows; }
  if (rowCount < policy.minRows) { reasons.push(`only ${rowCount} rows (< min ${policy.minRows}) — likely empty/partial`); fail = true; nothingSafeToSend = true; }
  if (policy.blockOnFailedSources && failedAuthoritative.length) { reasons.push('authoritative source(s) failed: ' + failedAuthoritative.join(', ')); fail = true; }
  if (failedOther.length) reasons.push('non-authoritative source(s) degraded: ' + failedOther.join(', '));

  let allow, block, banner = null;
  if (!fail) {
    allow = true; block = false;
  } else if (testMode && !nothingSafeToSend) {
    // Test Mode: allow with a visible banner rather than hard-block, so the
    // operator can still exercise the pipeline against slightly-stale data.
    allow = true; block = false;
    banner = 'STALE / UNVERIFIED DATA — ' + reasons.join('; ');
  } else {
    // Production hard-block, or nothing safe to send even in test mode.
    allow = false; block = true;
  }

  const decision = {
    allow, block, banner, reasons,
    policy, dataAgeMin, rowCount, usedCache,
    failedAuthoritative, failedOther,
    channel, testMode,
  };
  logger.info(`Freshness [${channel}${testMode ? '/test' : ''}]: ${allow ? (banner ? 'ALLOW+banner' : 'ALLOW') : 'BLOCK'} — ${reasons.join('; ') || 'fresh'}`);
  return decision;
}

module.exports = { evaluate, DEFAULT_POLICY, AUTHORITATIVE_SOURCES, _policyFor };
