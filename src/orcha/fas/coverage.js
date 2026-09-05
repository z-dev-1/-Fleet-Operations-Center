'use strict';
/**
 * orcha/fas/coverage.js — Digital FAS automatic coverage profile.
 *
 * Zila's operational coverage is defined by the DOMICILES and OPERATORS
 * (operator == SCAC == carrier) that appear in the authoritative synced fleet
 * data. This module derives, caches, and refreshes a normalized coverage
 * profile from `fleetData.rows` — the newest authoritative connected source —
 * and exposes it to the FAS system so scope decisions and evidence gathering
 * can reason about "what Zila covers" without manual per-site entry.
 *
 * Design guarantees (from the product spec):
 *   - Derive coverage from the most authoritative connected source (fleetData).
 *   - Refresh at startup, after a sync, on a schedule, and on manual request.
 *   - If a refresh yields an EMPTY or FAILED result, PRESERVE the last verified
 *     profile and mark it stale. Never replace verified coverage with nothing.
 *   - When sources conflict, preserve the conflict for review and prefer the
 *     newest authoritative source.
 *   - Coverage only ever WIDENS what the AI understands about Zila's world; it
 *     never grants a permission (permissions live in Contact Book) and never
 *     overrides per-sender scope enforcement in sender-profiles.js.
 *
 * Normalized profile shape (stored under store key `fasCoverage`):
 *   {
 *     version: 1,
 *     verifiedAt: ISO | null,          // last SUCCESSFUL derivation
 *     lastAttemptAt: ISO | null,       // last refresh attempt (success or not)
 *     stale: boolean,                  // true when last attempt failed/empty
 *     source: 'fleetData' | ...,       // authoritative source used
 *     syncedAt: ISO | null,            // fleetData.syncedAt at derivation time
 *     unitCount: number,               // rows observed at derivation time
 *     operators: [                     // one per distinct operator (SCAC)
 *       { scac, operator, domiciles:[...], unitTypes:[...], unitCount }
 *     ],
 *     domiciles: [                     // one per distinct domicile
 *       { domicile, operators:[...], unitCount }
 *     ],
 *     conflicts: [ { at, note, ... } ],// preserved source conflicts for review
 *   }
 */

const store  = require('../../store');
let logger; try { logger = require('../../utils/logger')('fas-coverage'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const KEY = 'fasCoverage';
// Only powered units are in Zila's asset scope. We still observe body types for
// context, but coverage is about operators+domiciles, not asset gatekeeping.
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // periodic safety refresh (6h)

function _emptyProfile() {
  return {
    version: 1,
    verifiedAt: null,
    lastAttemptAt: null,
    stale: true,
    source: null,
    syncedAt: null,
    unitCount: 0,
    operators: [],
    domiciles: [],
    conflicts: [],
  };
}

function _norm(v) { return String(v == null ? '' : v).trim(); }
function _normUpper(v) { return _norm(v).toUpperCase(); }

/** Load the persisted profile (never throws; returns an empty stale profile). */
function get() {
  try {
    const p = store.load(KEY, null);
    if (p && typeof p === 'object' && Array.isArray(p.operators)) return p;
  } catch (e) { logger.warn('coverage load failed:', e.message); }
  return _emptyProfile();
}

/**
 * Derive a fresh profile from fleetData rows WITHOUT persisting.
 * Returns { ok, profile? , reason? }. ok:false means the derivation produced
 * nothing usable (empty/failed) — the caller must then PRESERVE prior verified
 * coverage rather than overwrite it.
 */
function derive(opts) {
  opts = opts || {};
  let fd;
  try { fd = store.load('fleetData', {}) || {}; }
  catch (e) { return { ok: false, reason: 'fleetData load failed: ' + e.message }; }

  const rows = Array.isArray(fd.rows) ? fd.rows : [];
  if (!rows.length) return { ok: false, reason: 'no fleet rows (empty/failed sync)' };

  const opMap  = new Map();  // scac -> { scac, operator, domiciles:Set, unitTypes:Set, unitCount }
  const domMap = new Map();  // domicile -> { domicile, operators:Set, unitCount }

  for (const r of rows) {
    const operator = _normUpper(r.operator || r.scac || r.carrier);
    // fleetData rows expose domicile under a few historical field names.
    const domicile = _normUpper(r.domicileSite || r.domicile || r.site || r.station);
    const unitType = _norm(r.bodyType || r.assetType || r.type);
    if (!operator && !domicile) continue;

    if (operator) {
      let o = opMap.get(operator);
      if (!o) { o = { scac: operator, operator, domiciles: new Set(), unitTypes: new Set(), unitCount: 0 }; opMap.set(operator, o); }
      o.unitCount++;
      if (domicile) o.domiciles.add(domicile);
      if (unitType) o.unitTypes.add(unitType);
    }
    if (domicile) {
      let d = domMap.get(domicile);
      if (!d) { d = { domicile, operators: new Set(), unitCount: 0 }; domMap.set(domicile, d); }
      d.unitCount++;
      if (operator) d.operators.add(operator);
    }
  }

  if (opMap.size === 0 && domMap.size === 0) {
    return { ok: false, reason: 'rows present but no operator/domicile fields resolved' };
  }

  const operators = [...opMap.values()]
    .map(o => ({ scac: o.scac, operator: o.operator, domiciles: [...o.domiciles].sort(), unitTypes: [...o.unitTypes].sort(), unitCount: o.unitCount }))
    .sort((a, b) => a.scac.localeCompare(b.scac));
  const domiciles = [...domMap.values()]
    .map(d => ({ domicile: d.domicile, operators: [...d.operators].sort(), unitCount: d.unitCount }))
    .sort((a, b) => a.domicile.localeCompare(b.domicile));

  const now = new Date().toISOString();
  return {
    ok: true,
    profile: {
      version: 1,
      verifiedAt: now,
      lastAttemptAt: now,
      stale: false,
      source: 'fleetData',
      syncedAt: (fd.syncedAt || fd.updatedAt) || null,
      unitCount: rows.length,
      operators,
      domiciles,
      conflicts: [],
    },
  };
}

/**
 * refresh({ reason }) -> profile
 * Attempts a derivation and persists it. On empty/failed derivation, PRESERVES
 * the prior verified profile and only flips `stale` + records the attempt.
 * Conflicts between the new derivation and the prior verified profile are
 * preserved on the profile for review (they do not block the newer source).
 */
function refresh(opts) {
  opts = opts || {};
  const reason = opts.reason || 'manual';
  const prior = get();
  const d = derive(opts);
  const nowIso = new Date().toISOString();

  if (!d.ok) {
    // PRESERVE last verified coverage; mark stale; record the failed attempt.
    const preserved = Object.assign({}, prior, {
      lastAttemptAt: nowIso,
      stale: true,
    });
    // Never wipe verified operators/domiciles with an empty result.
    try { store.save(KEY, preserved); } catch (e) { logger.warn('coverage save (preserve) failed:', e.message); }
    logger.warn('coverage refresh (' + reason + ') kept prior verified profile — ' + d.reason);
    return preserved;
  }

  const next = d.profile;
  // Preserve any prior conflicts + detect a coarse shrink conflict (a verified
  // operator disappearing entirely) so a bad/partial sync is visible for review
  // rather than silently narrowing coverage.
  const conflicts = Array.isArray(prior.conflicts) ? prior.conflicts.slice(-20) : [];
  if (prior.verifiedAt && Array.isArray(prior.operators) && prior.operators.length) {
    const nextScacs = new Set(next.operators.map(o => o.scac));
    const vanished = prior.operators.filter(o => !nextScacs.has(o.scac)).map(o => o.scac);
    if (vanished.length) {
      conflicts.push({ at: nowIso, note: 'operators present in prior verified coverage are absent in newest source', operators: vanished, priorVerifiedAt: prior.verifiedAt });
    }
  }
  next.conflicts = conflicts;
  try { store.save(KEY, next); } catch (e) { logger.warn('coverage save failed:', e.message); }
  logger.info('coverage refresh (' + reason + '): ' + next.operators.length + ' operators, ' + next.domiciles.length + ' domiciles from ' + next.unitCount + ' units');
  return next;
}

// ── Scheduling ────────────────────────────────────────────────────────────────
let _timer = null;
/** Start the periodic safety refresh + do an initial startup refresh. */
function start() {
  refresh({ reason: 'startup' });
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => { try { refresh({ reason: 'schedule' }); } catch (_) {} }, REFRESH_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
/** Call from the sync-complete hook. */
function onSyncComplete() { return refresh({ reason: 'sync' }); }

// ── Queries used by the FAS system ─────────────────────────────────────────────
function isOperatorCovered(operator) {
  const op = _normUpper(operator);
  if (!op) return false;
  return get().operators.some(o => o.scac === op);
}
function isDomicileCovered(domicile) {
  const dom = _normUpper(domicile);
  if (!dom) return false;
  return get().domiciles.some(d => d.domicile === dom);
}
function listOperators() { return get().operators.map(o => o.scac); }
function listDomiciles() { return get().domiciles.map(d => d.domicile); }

/**
 * summary() -> a compact, human/AI-readable snapshot for prompts + Settings.
 * Never dumps unit-level data — just the coverage shape.
 */
function summary() {
  const p = get();
  return {
    verifiedAt: p.verifiedAt,
    lastAttemptAt: p.lastAttemptAt,
    stale: !!p.stale,
    source: p.source,
    operatorCount: p.operators.length,
    domicileCount: p.domiciles.length,
    operators: p.operators.map(o => o.scac),
    domiciles: p.domiciles.map(d => d.domicile),
    conflictCount: (p.conflicts || []).length,
  };
}

module.exports = {
  KEY,
  get, derive, refresh, summary,
  start, stop, onSyncComplete,
  isOperatorCovered, isDomicileCovered, listOperators, listDomiciles,
  _emptyProfile,
};
