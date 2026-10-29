'use strict';
/**
 * orcha/canonical_runner.js -- run the canonical-state pass in API mode.
 *
 * WHY (2026-10-28): the canonical pass (per-unit status / owner / flags, the
 * ready-for-pickup carrier notice) only ran at the end of the legacy SCRAPE
 * sync (src/sync/index.js _runCanonicalPass). When the AAP API became the
 * default fleet source on 10-16 that code path stopped running, so canonical
 * state froze at 2026-10-16T22:43 and the notes-based ready notice went silent.
 * This runs the same pass after each API fleet load + deep-scan.
 *
 * Also persists what deep-scan learned (Decisiv case stage + offsite notes):
 * in API mode deep-scan only pushData()s its rows, it never saves them, so the
 * stored fleetData never had the stage the canonical pass needs.
 *
 * QUIET BASELINE: when the last canonical run is older than GAP_MS (e.g. the
 * first run after the 10-16 gap, or after the app was off), every unit would
 * look like a fresh transition vs the old snapshot and the ready notice could
 * message a batch of carriers at once. That run records today as the baseline
 * and sends NOTHING; normal transitions resume from the next run.
 */

const GAP_MS = 6 * 3600 * 1000;

// Fields deep-scan updates on its in-memory rows (offsite enrich + case stage).
const DS_FIELDS = ['offsiteStage', 'offsiteStageDetail', 'offsiteStageSince',
  'asistNotes', 'asistScrapedAt', 'asistSource', 'asistLabel', 'asistSrUrl'];

/**
 * overlayDeepScanFields(liveRows, scannedRows) -> number of rows updated.
 * Pure (mutates liveRows in place). Copies DS_FIELDS by equipmentId, only when
 * the scanned value is non-empty AND the offsite still belongs to the same WR
 * (_offsiteWrId), so a cleared/stale offsite is never resurrected.
 */
// Copy a field GROUP only when the scanned copy was read MORE RECENTLY than
// what's already stored. FIX (2026-10-28): deep-scan works on rows loaded
// before it started; a stage refresh that saved "322504 = no status" was then
// overwritten by the deep-scan's stale in-memory "ready". Newer read wins.
const NOTE_FIELDS  = ['asistNotes', 'asistScrapedAt', 'asistSource', 'asistLabel', 'asistSrUrl'];
const STAGE_FIELDS = ['offsiteStage', 'offsiteStageDetail', 'offsiteStageSince', '_stageReadAt'];
const _t = (v) => { const n = v ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : 0; };

function overlayDeepScanFields(liveRows, scannedRows) {
  if (!Array.isArray(liveRows) || !Array.isArray(scannedRows) || !scannedRows.length) return 0;
  const byId = new Map();
  for (const s of scannedRows) if (s && s.equipmentId) byId.set(String(s.equipmentId), s);
  let n = 0;
  for (const r of liveRows) {
    const s = r && byId.get(String(r.equipmentId));
    if (!s || s === r) continue;
    if (String(s._offsiteWrId || '') !== String(r._offsiteWrId || '')) continue;
    let touched = false;
    // Notes: newer asistScrapedAt wins.
    if (_t(s.asistScrapedAt) > _t(r.asistScrapedAt)) {
      for (const k of NOTE_FIELDS) if (s[k] != null && s[k] !== r[k]) { r[k] = s[k]; touched = true; }
    }
    // Stage trio (incl. an API "no status" answer = empty stage): newer
    // _stageReadAt wins, copied together so stage/detail/since never mix.
    if (_t(s._stageReadAt) > _t(r._stageReadAt)) {
      for (const k of STAGE_FIELDS) if ((s[k] == null ? '' : s[k]) !== (r[k] == null ? '' : r[k])) { r[k] = s[k] == null ? '' : s[k]; touched = true; }
    }
    if (touched) n++;
  }
  return n;
}

function _defaultNotifyDeps() {
  const slack = require('../scrapers/slack_send');
  const { resolveOperatorEntry } = require('../scrapers/pm_alert_reply');
  return {
    sendToChannel: slack.sendToChannel,
    askOrcha: (p) => require('./relay').ask(p, {}),
    resolveOperatorEntry,
  };
}

/**
 * runCanonicalPass(opts) -> { ok, baseline, counts, overlaid, notifyQueued }
 * opts: { scannedRows?, pushData?, ctx?, deps? }
 * deps (tests): { store, canonical, readyNotify, notifyDeps, now, log }
 * Synchronous load -> compute -> save (no await in between, so no other
 * writer's fleetData save can interleave). The carrier notice is queued.
 */
function runCanonicalPass(opts = {}) {
  const deps = opts.deps || {};
  const store = deps.store || require('../store');
  const canonical = deps.canonical || require('./canonical_state');
  const readyNotify = deps.readyNotify || require('../scrapers/ready_pickup_notify');
  const log = deps.log || (() => {
    try { const l = require('../utils/logger')('canonical'); return { info: (m) => l.info(m), warn: (m) => l.warn(m) }; }
    catch (_) { return { info() {}, warn() {} }; }
  })();
  const now = deps.now ? deps.now() : Date.now();

  const fd = store.load('fleetData', {}) || {};
  const rows = Array.isArray(fd.rows) ? fd.rows : [];
  if (!rows.length) return { ok: false, reason: 'no fleet rows' };

  const overlaid = overlayDeepScanFields(rows, opts.scannedRows);

  const prevCanon = store.load('canonicalState', {}) || {};
  const priorUnits = prevCanon.units || {};
  const lastMs = prevCanon.updatedAt ? Date.parse(prevCanon.updatedAt) : NaN;
  const baseline = !Number.isFinite(lastMs) || (now - lastMs) > GAP_MS;
  // PER-UNIT baseline (FIX 2026-10-28): the file-level updatedAt is NOT enough
  // -- the single-unit refresh (ipc/scrapers.js) saves one unit and stamps the
  // whole file fresh, so a file full of 10-16 records looked current and B12343
  // got a catch-up notice. A unit only counts as a real transition when ITS OWN
  // prior record is recent; otherwise it's baselined quietly.
  const _priorFresh = (id) => {
    const p = priorUnits[id];
    const t = p && p.updatedAt ? Date.parse(p.updatedAt) : NaN;
    return Number.isFinite(t) && (now - t) <= GAP_MS;
  };

  const { units, counts } = canonical.buildAll(rows, { decisions: {}, prior: priorUnits });

  let baselinedUnits = 0;
  for (const id of Object.keys(units)) {
    if (!units[id]) continue;
    if (baseline || !_priorFresh(id)) {
      // Record today's state as this unit's starting point; no "transition".
      if (units[id].previousStatus) baselinedUnits++;
      units[id].previousStatus = null;
    }
  }

  store.save('canonicalState', {
    units,
    updatedAt: new Date(now).toISOString(),
    lastReconcileAt: prevCanon.lastReconcileAt || null,
    ...(baseline ? { baselineAt: new Date(now).toISOString() } : {}),
  });

  // Mirror canonical fields + the deep-scan fields onto the stored rows.
  fd.rows = rows.map((r) => {
    const rec = r && units[r.equipmentId];
    return rec ? Object.assign({}, r, canonical.mirrorFields(rec)) : r;
  });
  store.save('fleetData', fd);
  if (opts.ctx) opts.ctx.lastData = fd;
  if (typeof opts.pushData === 'function') { try { opts.pushData(fd); } catch (_) {} }

  let notifyQueued = false;
  if (!baseline && Object.values(units).some(readyNotify._isFreshReady)) {
    notifyQueued = true;
    const nd = deps.notifyDeps || _defaultNotifyDeps();
    readyNotify.enqueue(() => readyNotify.notifyReadyUnits(units, nd))
      .catch((e) => log.warn('[canonical] ready-pickup notify error (non-fatal): ' + e.message));
  }

  log.info('[canonical] ' + counts.total + ' unit(s) — API mode, ' + (counts.changed || 0) + ' changed'
    + (baseline ? ' — QUIET BASELINE (last run ' + (prevCanon.updatedAt || 'never') + '; no carrier notices this run)' : '')
    + (!baseline && baselinedUnits ? ' — ' + baselinedUnits + ' unit(s) with an old prior record baselined quietly' : '')
    + (overlaid ? ' | saved deep-scan stage/notes on ' + overlaid + ' row(s)' : ''));
  return { ok: true, baseline, baselinedUnits, counts, overlaid, notifyQueued };
}

module.exports = { runCanonicalPass, overlayDeepScanFields, GAP_MS, DS_FIELDS };
