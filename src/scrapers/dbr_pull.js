'use strict';
/**
 * dbr_pull.js — Main-process DBR DATA pull for 📊 DBR — Fleet Health (from fleet data).
 *
 * The scheduler's DBR slot and "Pull DBR now" call pullFleetHealth(), which:
 *   1. rebuilds today's Fleet Health snapshot from stored fleet data
 *      (ipc/fleet-dbr buildNow — the same build as the DBR tab's Build button)
 *   2. gates on freshness: the fleet data must have synced TODAY (local day),
 *      else the caller blocks and the recovery sweep retries
 *   3. AI-drafts the rows with units down that have no current draft
 *      (ipc/fleet-dbr draftPending — the DBR tab's draft handler, one row at a time)
 *
 * Drafts are stored suggestions shown in the DBR tab; nothing is sent anywhere.
 * The QuickSight AFP/DSP scrape that used to live here was removed (2026-11-24).
 *
 * Also exports the "mine" helpers Pending Estimates uses (_loadMySitesAndCarriers, _rowIsMine).
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('dbr-pull'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

// ═══════════════════════════════════════════════════════════════════════════
// "MINE" matching (store-backed; used by src/scrapers/pending_est_sources.js)
// ═══════════════════════════════════════════════════════════════════════════

// Union of the user's managed domiciles + carriers: fleetData rows + contacts.json type:'domicile'.
function _loadMySitesAndCarriers() {
  const mySites = new Set();
  const myCarriers = new Set();
  try {
    const fd = store.load('fleetData', {}) || {};
    (Array.isArray(fd.rows) ? fd.rows : []).forEach(r => {
      const d = (r.domicileSite || r.domicile || '').trim().toUpperCase();
      if (d) mySites.add(d);
      const op = (r.operator || '').trim().toUpperCase();
      if (op) myCarriers.add(op);
    });
  } catch (_) {}
  try {
    const contacts = store.load('contacts', {}) || {};
    const all = Array.isArray(contacts) ? contacts : (Array.isArray(contacts.contacts) ? contacts.contacts : []);
    all.filter(c => c && c.type === 'domicile').forEach(c => {
      const n = (c.name || '').trim().toUpperCase();
      if (n) mySites.add(n);
    });
  } catch (_) {}
  return { mySites, myCarriers };
}

// Decide if a row is "mine" (same rule as the renderer FAS='Z' auto-fill).
function _rowIsMine(sectionKind, row, mySites, myCarriers) {
  const idVal = sectionKind === 'domicile' ? row.domicile : row.scac;
  const idKey = (idVal || '').trim().toUpperCase();
  const domicileKey = (row.domicile || '').trim().toUpperCase();
  return sectionKind === 'domicile'
    ? mySites.has(idKey)
    : (myCarriers.has(idKey) || (domicileKey && mySites.has(domicileKey)));
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: DBR DATA pull = build + freshness gate + AI drafts
// ═══════════════════════════════════════════════════════════════════════════

function _localDay(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * pullFleetHealth({ fleetDbr?, now? }) ->
 *   { ok:true, fresh:true, rowCount, downRows, drafts, data:{ dataAsOf, builtAt } }  -> done
 *   { ok:false, stale:true, dataAsOf }   -> fleet data not synced today (or none yet) -> caller retries
 *   { ok:false, error }                  -> Fleet Health off / build failed
 */
async function pullFleetHealth(deps = {}) {
  const fdbr = deps.fleetDbr || require('../ipc/fleet-dbr');
  const now = deps.now ? new Date(deps.now) : new Date();
  const res = fdbr.buildNow();
  if (!res || !res.ok) {
    const code = (res && res.code) || 'build-failed';
    if (code === 'no-fleet-data') {
      logger.info('[DBR] Fleet Health pull: no fleet data yet -> stale, will retry');
      return { ok: false, stale: true, dataAsOf: null };
    }
    return { ok: false, error: code === 'off' ? 'Fleet Health is off (settings dbr.fleetData)' : 'Fleet Health build failed (' + code + ')' };
  }
  const model = res.model || {};
  const syncedAt = model.fleetSyncedAt || null;
  const day = syncedAt ? _localDay(syncedAt) : null;
  if (!day || day !== _localDay(now)) {
    logger.info('[DBR] Fleet Health pull: fleet data last synced ' + (day || 'unknown') + ', not today -> stale, will retry');
    return { ok: false, stale: true, dataAsOf: day };
  }
  let drafts;
  try { drafts = await fdbr.draftPending(); }
  catch (e) { drafts = { ok: false, code: 'draft-error' }; logger.warn('[DBR] Fleet Health drafts failed: ' + e.message); }
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const downRows = rows.filter((r) => r && r.pair && r.pair.down > 0).length;
  logger.info('[DBR] Fleet Health pull complete — ' + rows.length + ' rows, ' + downRows + ' with units down, drafts '
    + (drafts && drafts.ok ? drafts.drafted + '/' + drafts.eligible : (drafts && drafts.code) || 'skipped'));
  return { ok: true, fresh: true, rowCount: rows.length, downRows, drafts, data: { dataAsOf: day, builtAt: model.builtAt || null } };
}

module.exports = {
  pullFleetHealth,
  // exported for reuse (Pending Estimates)
  _loadMySitesAndCarriers, _rowIsMine,
};
