'use strict';
/**
 * orcha/stage_refresh.js -- quick Volvo / PACCAR case-stage refresh.
 *
 * WHY (2026-10-28): the stage (Arrival > Diagnosis > Approval > Repair > Ready)
 * was only read when deep-scan re-read a unit's dealer NOTES, which it skips
 * while cached notes are < 2h old. So the stage lagged up to 2h (or never
 * appeared right after an update). This reads JUST the stage -- one small
 * Decisiv API call per Volvo/PACCAR case -- on its own, at most every
 * REFRESH_MS, then saves it and runs the canonical pass.
 *
 * Read-only against Decisiv. Carrier notices still go through the hard gate
 * in ready_pickup_notify (Volvo/PACCAR offsite + API stage Ready only).
 */

const REFRESH_MS = 15 * 60 * 1000;
const NO_STATUS = 'No status set by the dealer yet';
const EST_RE = /https?:\/\/(?:volvopg\.asist|pssmfleet|paccarpg)\.decisiv\.net\/fleet\/estimates\/(\d+)/i;

let _running = false;
let _lastAt = 0;

/** The Volvo/PACCAR estimate (case) URL for a row, or '' if it has none. */
function caseUrlOf(row) {
  const r = row || {};
  for (const u of [r.offsiteShopEventUrl, r.savedOffsiteUrl, r.asistSrUrl]) {
    const m = String(u || '').match(EST_RE);
    if (m) return m[0];
  }
  return '';
}

/** Rows that have a Volvo/PACCAR case we can read the stage for. Pure. */
function stageTargets(rows) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.equipmentId) continue;
    const url = caseUrlOf(r);
    if (!url) continue;
    out.push({ equipmentId: r.equipmentId, url, estId: url.match(EST_RE)[1], wrId: r._offsiteWrId || '' });
  }
  return out;
}

/**
 * applyStages(rows, results) -> number of rows changed. Pure (mutates rows).
 * results: [{ equipmentId, wrId, stage, status, since }]. Only applied when the
 * row's offsite still belongs to the same WR it was read for.
 */
function applyStages(rows, results, readAtIso) {
  const byId = new Map((results || []).map((x) => [String(x.equipmentId), x]));
  const readAt = readAtIso || new Date().toISOString();
  let n = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const x = r && byId.get(String(r.equipmentId));
    if (!x || String(r._offsiteWrId || '') !== String(x.wrId || '')) continue;
    // Stamp the read time every time (so an older copy can't overwrite it).
    r._stageReadAt = readAt;
    if (r.offsiteStage !== x.stage || r.offsiteStageDetail !== (x.status || '') || r.offsiteStageSince !== (x.since || '')) {
      r.offsiteStage = x.stage;
      r.offsiteStageDetail = x.status || '';
      r.offsiteStageSince = x.since || '';
      n++;
    }
  }
  return n;
}

/**
 * refreshStages(opts) -> { ran, read, failed, changed } . Never throws.
 * opts: { pushData?, ctx?, force?, deps? }
 * deps (tests): { store, decisiv, readyNotify, runCanonicalPass, now, log }
 */
async function refreshStages(opts = {}) {
  const deps = opts.deps || {};
  const now = deps.now ? deps.now() : Date.now();
  if (_running) return { ran: false, reason: 'already running' };
  if (!opts.force && _lastAt && now - _lastAt < REFRESH_MS) return { ran: false, reason: 'throttled' };
  _running = true;
  _lastAt = now;
  const log = deps.log || (() => {
    try { const l = require('../utils/logger')('stage-refresh'); return { info: (m) => l.info(m), warn: (m) => l.warn(m) }; }
    catch (_) { return { info() {}, warn() {} }; }
  })();
  try {
    const store = deps.store || require('../store');
    const decisiv = deps.decisiv || require('../scrapers/decisiv_api');
    const readyNotify = deps.readyNotify || require('../scrapers/ready_pickup_notify');
    const runCanonical = deps.runCanonicalPass || require('./canonical_runner').runCanonicalPass;

    const startRows = ((store.load('fleetData', {}) || {}).rows) || [];
    const targets = stageTargets(startRows);
    if (!targets.length) return { ran: true, read: 0, failed: 0, changed: 0 };

    // Read one at a time (the Decisiv API window is shared + serialized).
    const results = [];
    let failed = 0;
    for (const t of targets) {
      const s = await decisiv.getCaseStatusSummary(t.estId, { srUrl: t.url });
      // s.empty = dealer never set a status: clears any old guessed stage.
      if (s && s.ok) results.push({ equipmentId: t.equipmentId, wrId: t.wrId, stage: s.stage || '', status: s.empty ? NO_STATUS : s.status, since: s.since || '' });
      else failed++;
    }

    // Apply onto the LIVE stored rows (re-read: other writers may have saved
    // meanwhile), save, then canonical pass (mirrors + pushes the fleet).
    const fd = store.load('fleetData', {}) || {};
    const rows = Array.isArray(fd.rows) ? fd.rows : [];
    const changed = applyStages(rows, results, new Date(deps.now ? deps.now() : Date.now()).toISOString());
    if (results.length) {           // save the read stamps even when nothing changed
      store.save('fleetData', fd);
      if (opts.ctx) opts.ctx.lastData = fd;
    }
    try { runCanonical({ pushData: opts.pushData, ctx: opts.ctx }); }
    catch (e) { log.warn('[stage-refresh] canonical pass failed (non-fatal): ' + e.message); }

    // A case that reached Ready -> the gated, deduped operator notice.
    for (const r of rows) {
      if (String(r.offsiteStage || '').toLowerCase() === 'ready' && r.offsiteStageSince && results.some((x) => String(x.equipmentId) === String(r.equipmentId))) {
        try { readyNotify.onStageUpdate(r); } catch (_) {}
      }
    }

    log.info('[stage-refresh] Volvo/PACCAR stages: ' + results.length + '/' + targets.length + ' read'
      + (failed ? ', ' + failed + ' failed' : '') + ', ' + changed + ' changed'
      + (results.length ? ' | ' + results.map((x) => x.equipmentId + '=' + (x.stage || 'no-status') + (x.stage && x.status ? '/' + x.status : '')).join(', ') : ''));
    return { ran: true, read: results.length, failed, changed };
  } catch (e) {
    log.warn('[stage-refresh] error (non-fatal): ' + e.message);
    return { ran: true, read: 0, failed: 0, changed: 0, error: e.message };
  } finally {
    _running = false;
  }
}

function _resetForTests() { _running = false; _lastAt = 0; }

module.exports = { refreshStages, stageTargets, applyStages, caseUrlOf, REFRESH_MS, NO_STATUS, _resetForTests };
