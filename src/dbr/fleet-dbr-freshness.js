'use strict';
/**
 * dbr/fleet-dbr-freshness.js — data-as-of + trust stamp for 📊 DBR — Fleet Health.
 *
 * fleetData.syncedAt is NOT a data age: deep-scan hydrate, PM fill and the Uptake re-merge
 * re-stamp it to "now" on unchanged AAP rows. The data-as-of time is the last real AAP build
 * (health/fleet-freshness lastOkAt, the same source Autopilot reads). Only when no build was
 * ever recorded (fresh install, cluster standby) does it fall back to fleetData.syncedAt,
 * tagged dataAsOfSource:'sync-stamp'.
 *
 * Used by ipc/fleet-dbr (stamp at build, re-assess on every read), scrapers/dbr_pull (scheduled
 * gate) and dbr/lookup (Just Me label), so the panel and the scheduler agree on "fresh".
 *
 * Status, first match wins:
 *   unknown  no data-as-of time at all
 *   stale    data-as-of is not today's local date ('not-today') or older than maxAgeMin ('age>120m')
 *   partial  row count differs from the last build ('rows-differ-from-last-build'), or the payload
 *            is flagged stale ('payload-stale-flag') / partial ('payload-partial')
 *   fresh    otherwise
 * 'last-refresh-failed', 'refresh-in-flight' and 'build-time-unknown' are reasons only; the data is
 * still the last good build. Pure (no store / clock access) except readFleetFreshness().
 */

const MAX_AGE_MIN = 120;
const PARTIAL_REASONS = Object.freeze(['rows-differ-from-last-build', 'payload-stale-flag', 'payload-partial']);

function _ms(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
function _iso(v) { const t = _ms(v); return t == null ? null : new Date(t).toISOString(); }
function _localDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function _fin(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function _obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

// Shared rule set. inp: { dataAsOf, source, syncStampAt, rowCount, lastOkCount, payloadStale,
// payloadPartial, ff (current fleet-freshness snapshot), now, maxAgeMin }.
function _evaluate(inp) {
  const now = _ms(inp.now) != null ? _ms(inp.now) : Date.now();
  const maxAgeMin = _fin(inp.maxAgeMin) != null && inp.maxAgeMin > 0 ? inp.maxAgeMin : MAX_AGE_MIN;
  const ff = _obj(inp.ff);
  const asOf = _ms(inp.dataAsOf);
  const reasons = [];
  let ageMin = null;
  let sameDay = false;
  let status;
  if (asOf == null) {
    status = 'unknown';
  } else {
    const ageMs = Math.max(0, now - asOf);
    ageMin = Math.floor(ageMs / 60000);
    sameDay = _localDay(asOf) === _localDay(now);
    if (!sameDay) reasons.push('not-today');
    if (ageMs > maxAgeMin * 60000) reasons.push('age>' + maxAgeMin + 'm');
    if (reasons.length) status = 'stale';
  }
  const rowCount = _fin(inp.rowCount) || 0;
  const lastOkCount = _fin(inp.lastOkCount);
  const partial = [];
  if (lastOkCount != null && rowCount !== lastOkCount) partial.push('rows-differ-from-last-build');
  if (inp.payloadStale) partial.push('payload-stale-flag');
  if (inp.payloadPartial) partial.push('payload-partial');
  reasons.push(...partial);
  if (!status) status = partial.length ? 'partial' : 'fresh';

  const lastFailAt = _fin(ff.lastFailAt);
  const lastOkAt = _fin(ff.lastOkAt) != null ? ff.lastOkAt : asOf;
  if (lastFailAt != null && lastFailAt > (lastOkAt || 0)) reasons.push('last-refresh-failed');
  if (ff.buildInFlight === true) reasons.push('refresh-in-flight');
  if (inp.source !== 'fleet-build') reasons.push('build-time-unknown');

  return {
    v: 1,
    status,
    reasons,
    dataAsOf: asOf == null ? null : new Date(asOf).toISOString(),
    dataAsOfSource: inp.source === 'fleet-build' ? 'fleet-build' : 'sync-stamp',
    syncStampAt: _iso(inp.syncStampAt),
    lastOkCount,
    rowCount,
    lastFailAt: lastFailAt == null ? null : new Date(lastFailAt).toISOString(),
    lastFailCode: typeof ff.lastFailCode === 'string' && ff.lastFailCode ? ff.lastFailCode.slice(0, 40) : null,
    buildInFlight: ff.buildInFlight === true,
    ageMin,
    sameDay,
    checkedAt: new Date(now).toISOString(),
  };
}

/**
 * assess({ fleet, ffSnapshot, now, maxAgeMin }) -> dataFreshness (build time).
 * fleet: the fleetData payload the DBR rows are built from; ffSnapshot: fleet-freshness getSnapshot()
 * (or null). dataAsOf = ffSnapshot.lastOkAt, else fleet.syncedAt || fleet.scrapedAt ('sync-stamp').
 */
function assess({ fleet, ffSnapshot, now, maxAgeMin } = {}) {
  const f = _obj(fleet);
  const ff = _obj(ffSnapshot);
  const stamp = f.syncedAt || f.scrapedAt || null;
  const okAt = _fin(ff.lastOkAt);
  return _evaluate({
    dataAsOf: okAt != null ? okAt : stamp,
    source: okAt != null ? 'fleet-build' : 'sync-stamp',
    syncStampAt: stamp,
    rowCount: Array.isArray(f.rows) ? f.rows.length : 0,
    lastOkCount: okAt != null ? ff.lastOkCount : null,
    payloadStale: f.stale === true,
    payloadPartial: !!f.partial,
    ff, now, maxAgeMin,
  });
}

/**
 * reassess(stamp, { ffSnapshot, now, maxAgeMin, fallbackAsOf }) -> dataFreshness (read time).
 * Keeps the data-as-of time and row checks the snapshot was BUILT from; recomputes the age rules
 * against `now` and the failure / in-flight reasons against the current fleet-freshness snapshot.
 * A snapshot without a stamp (built before this module) re-assesses from fallbackAsOf
 * (snapshot.fleetSyncedAt) as 'sync-stamp'.
 */
function reassess(stamp, { ffSnapshot, now, maxAgeMin, fallbackAsOf } = {}) {
  const s = _obj(stamp);
  const has = s.v === 1;
  const reasons = Array.isArray(s.reasons) ? s.reasons : [];
  return _evaluate({
    dataAsOf: has ? s.dataAsOf : (fallbackAsOf || null),
    source: has ? s.dataAsOfSource : 'sync-stamp',
    syncStampAt: has ? s.syncStampAt : (fallbackAsOf || null),
    rowCount: has ? s.rowCount : 0,
    lastOkCount: has ? s.lastOkCount : null,
    payloadStale: reasons.includes('payload-stale-flag'),
    payloadPartial: reasons.includes('payload-partial'),
    ff: ffSnapshot, now, maxAgeMin,
  });
}

// Current fleet-freshness snapshot, or null (module missing / not initialized / throws).
function readFleetFreshness() {
  try {
    const ff = require('../health/fleet-freshness');
    const s = ff && typeof ff.getSnapshot === 'function' ? ff.getSnapshot() : null;
    return s && typeof s === 'object' ? s : null;
  } catch (_) { return null; }
}

module.exports = { assess, reassess, readFleetFreshness, MAX_AGE_MIN, PARTIAL_REASONS };
