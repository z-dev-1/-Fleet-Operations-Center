/**
 * repair-intel/background.js — self-maintaining background worker (Phase 8).
 *
 * Keeps the 12-month engine fresh WITHOUT the user clicking anything:
 *   1. Leader-gated (cluster.mayRunProduction) so only one host runs it.
 *   2. Each cycle picks a SMALL batch of the stalest units, does an incremental
 *      sync (API only, no AI), then optionally runs AI analysis on ONE unit.
 *   3. Self-yields: AI analysis only runs when the relay reports a backend up,
 *      and only one unit per cycle with a long gap between cycles, so it never
 *      competes with interactive AI the user is waiting on.
 *   4. Fully guarded + idempotent: no-ops when SQLite/API/roster is unavailable;
 *      the evidence-hash cache means re-analysis is skipped for unchanged units.
 *
 * It NEVER changes canonical readiness and NEVER fabricates data — it only
 * drives the same deterministic sync + advisory AI the manual controls use.
 */

let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){} }; }

const CYCLE_MS = 20 * 60 * 1000;     // one small batch every 20 minutes
const FIRST_DELAY_MS = 5 * 60 * 1000; // let the app settle before the first cycle
const SYNC_BATCH = 5;                 // units to incrementally sync per cycle
const STALE_MS = 12 * 60 * 60 * 1000; // consider a unit stale after 12h

let _timer = null;
let _running = false;   // re-entrancy guard (a slow cycle must not overlap)
let _enabled = true;

// Leader gate — mirrors the scheduler's _mayFireProductionJob. Absent cluster
// (legacy single host) => always allowed.
function _mayRun() {
  try {
    const cluster = require('../cluster');
    if (typeof cluster.mayRunProduction !== 'function') return true;
    return !!cluster.mayRunProduction();
  } catch (_) { return true; }
}

// Is an AI backend reachable right now? Used to decide whether to attempt the
// (optional) analysis step — we skip it rather than queue behind a busy lane.
function _aiAvailable() {
  try {
    const relay = require('../orcha/relay');
    const st = relay.getStatus && relay.getStatus();
    const be = st && st.backends;
    return !!(be && (be.orcha || be.claude));
  } catch (_) { return false; }
}

// Pick the roster of unit ids to maintain, newest-fleet-data first. We only
// know the fleet from the live fleetData store (the same source the UI uses).
function _roster() {
  try {
    const store = require('../store');
    const data = store.load('fleetData', null);
    if (!data || !Array.isArray(data.rows)) return [];
    return data.rows.map(r => String(r.equipmentId || r.id || '').trim()).filter(Boolean);
  } catch (_) { return []; }
}

// Choose the stalest units (never synced, or synced longest ago) up to a cap.
function _stalest(ids, store, cap) {
  const scored = ids.map(id => {
    let ts = 0;
    try { const cp = store.getCheckpoint(id); ts = cp ? (cp.last_incr_sync_at || cp.last_full_sync_at || 0) : 0; } catch (_) {}
    return { id, ts };
  });
  // never-synced (ts=0) first, then oldest sync first
  scored.sort((a, b) => a.ts - b.ts);
  return scored.filter(s => s.ts === 0 || (Date.now() - s.ts) > STALE_MS).slice(0, cap).map(s => s.id);
}

async function _cycle() {
  if (_running || !_enabled) return;
  _running = true;
  try {
    if (!_mayRun()) { return; } // standby host — do nothing
    const schema = require('./schema');
    if (!schema.ensureSchema()) return; // SQLite unavailable

    const store = require('./store');
    const fetch = require('./fetch');
    const ids = _roster();
    if (!ids.length) return;

    const batch = _stalest(ids, store, SYNC_BATCH);
    if (!batch.length) return; // everything is fresh

    let synced = 0, failed = 0, aiRan = 0;
    let aiCandidate = null;
    for (const id of batch) {
      try {
        const res = await fetch.syncUnit(id, { incremental: true });
        if (res && res.ok) {
          synced++;
          // Remember a unit that actually changed as the AI candidate.
          if (!aiCandidate && ((res.added || 0) + (res.updated || 0)) > 0) aiCandidate = id;
        } else { failed++; }
      } catch (e) { failed++; logger.warn('[bg] sync ' + id + ' failed: ' + e.message); }
    }

    // Optional single AI analysis — only when a lane is up and a unit changed.
    // The evidence-hash cache skips unchanged units internally anyway.
    if (aiCandidate && _aiAvailable()) {
      try {
        const analysis = require('./analysis');
        const r = await analysis.analyzeUnit(aiCandidate, {});
        if (r && r.ok) aiRan = 1;
      } catch (e) { logger.warn('[bg] analysis ' + aiCandidate + ' failed: ' + e.message); }
    }

    if (synced || failed || aiRan) {
      logger.info('[bg] cycle: synced=' + synced + ' failed=' + failed + ' aiRan=' + aiRan + ' (batch=' + batch.length + '/' + ids.length + ' units)');
    }
  } catch (e) {
    logger.warn('[bg] cycle error: ' + e.message);
  } finally {
    _running = false;
  }
}

// Start the worker. Safe to call once at app bootstrap. No-op if already started.
function start() {
  if (_timer) return;
  _enabled = true;
  _timer = setInterval(() => { _cycle().catch(() => {}); }, CYCLE_MS);
  if (_timer.unref) _timer.unref(); // never keep the process alive just for this
  setTimeout(() => { _cycle().catch(() => {}); }, FIRST_DELAY_MS);
  logger.info('repair-intel background worker started (cycle ' + Math.round(CYCLE_MS / 60000) + 'm)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _enabled = false;
}

// Exposed for tests / manual trigger.
async function runOnce() { return _cycle(); }

module.exports = { start, stop, runOnce, _stalest, _mayRun, _aiAvailable };
