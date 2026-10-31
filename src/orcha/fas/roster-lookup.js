'use strict';
/**
 * roster-lookup.js — resolve the FAS person for a (SCAC + Site) combination.
 *
 * The FAS roster (store key `fasRoster`, scraped by src/scrapers/fas_roster.js)
 * has one row per FAS person with their Site Code + SCAC. A unit/row's FAS
 * owner is the roster person whose SCAC matches the unit's carrier AND whose
 * Site Code matches the unit's domicile.
 *
 * This is a small, require()-able MAIN-process helper used by:
 *   - the Long Dwell CSV merge (src/ipc/long-dwell-csv.js) to fill the FAS/UM columns,
 *   - the DBR pull (src/scrapers/dbr_pull.js) to stamp a FAS name on each row.
 *
 * Matching is normalized (trim + uppercase) on BOTH sides. Lookups degrade
 * gracefully: exact (scac+site) first, then site-only, then scac-only — because
 * some sources only carry one of the two (DBR domicile rows have no SCAC; DSP
 * rows have no site). Site-only / scac-only matches are ONLY returned when they
 * are UNAMBIGUOUS (a single FAS person covers that site, or that SCAC).
 */

const store = require('../../store');

const _norm = (v) => String(v == null ? '' : v).trim().toUpperCase();

// Case-insensitive field getter across the roster row's header-keyed object.
function _get(row, names) {
  if (!row) return '';
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((kk) => kk.toLowerCase() === n.toLowerCase());
    if (k && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

// Build (and cache) lookup maps from the stored roster. Cache is invalidated
// when the roster's fetchedAt changes (so a re-fetch is picked up).
let _cache = null;      // { stamp, byPair, bySite, byScac }
function _buildIndex() {
  const data = store.load('fasRoster', { fetchedAt: null, rows: [] });
  const stamp = (data && data.fetchedAt) || '';
  if (_cache && _cache.stamp === stamp) return _cache;

  const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
  const byPair = new Map();                 // "SCAC|SITE" -> fasName
  const bySite = new Map();                 // "SITE" -> Set(fasName)
  const byScac = new Map();                 // "SCAC" -> Set(fasName)
  const umByPair = new Map();               // "SCAC|SITE" -> uptimeManager

  for (const r of rows) {
    const fas  = _get(r, ['FAS Name', 'Name', 'FAS']);
    if (!fas) continue;
    const scac = _norm(_get(r, ['SCAC']));
    const site = _norm(_get(r, ['Site Code', 'Site', 'Domicile']));
    const um   = _get(r, ['Uptime Manager', 'Uptime Mgr', 'Manager']);

    if (scac && site) {
      byPair.set(scac + '|' + site, fas);
      if (um) umByPair.set(scac + '|' + site, um);
    }
    if (site) { if (!bySite.has(site)) bySite.set(site, new Set()); bySite.get(site).add(fas); }
    if (scac) { if (!byScac.has(scac)) byScac.set(scac, new Set()); byScac.get(scac).add(fas); }
  }

  _cache = { stamp, byPair, bySite, byScac, umByPair, count: rows.length };
  return _cache;
}

/**
 * fasFor(scac, site) — resolve the FAS person's name for a carrier+site.
 * Returns '' when there's no confident match.
 *   1. exact SCAC+Site pair,
 *   2. site-only if exactly one FAS covers that site,
 *   3. scac-only if exactly one FAS covers that SCAC.
 */
function fasFor(scac, site) {
  const idx = _buildIndex();
  const a = _norm(scac);
  const b = _norm(site);

  // Exact pair — ORDER-AGNOSTIC. Some sources (notably the DBR AFP SCAC table)
  // deliver the domicile and SCAC columns in the opposite order, so a caller
  // may pass them swapped. SCAC codes and site codes don't collide in format,
  // so trying both orders can only RESOLVE a swap, never create a wrong match.
  if (a && b) {
    const hit = idx.byPair.get(a + '|' + b) || idx.byPair.get(b + '|' + a);
    if (hit) return hit;
  }
  // Single-value fallbacks: a lone value could be either a site or a SCAC —
  // try both indexes, accept only an UNAMBIGUOUS (single-FAS) match.
  for (const v of [a, b]) {
    if (!v) continue;
    if (idx.bySite.has(v)) { const set = idx.bySite.get(v); if (set.size === 1) return [...set][0]; }
    if (idx.byScac.has(v)) { const set = idx.byScac.get(v); if (set.size === 1) return [...set][0]; }
  }
  return '';
}

/**
 * umFor(scac, site) — resolve the Uptime Manager for a carrier+site (exact
 * pair only, since UM is less likely to be unambiguous site-/scac-wide).
 */
function umFor(scac, site) {
  const idx = _buildIndex();
  const a = _norm(scac);
  const b = _norm(site);
  if (a && b) return idx.umByPair.get(a + '|' + b) || idx.umByPair.get(b + '|' + a) || '';
  return '';
}

// How many roster rows are indexed (0 = roster not fetched yet). Lets callers
// skip the lookup cleanly when there's no roster.
function rosterSize() {
  try { return _buildIndex().count || 0; } catch (_) { return 0; }
}

module.exports = { fasFor, umFor, rosterSize };
