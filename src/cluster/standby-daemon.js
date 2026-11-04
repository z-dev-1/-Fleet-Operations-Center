'use strict';
/**
 * cluster/standby-daemon.js — headless "run the app's background loops" daemon.
 *
 * WHY: On the laptop, the always-on background work (Slack DM + channel poll,
 * live fleet refresh) is driven by the Electron renderer's timers (see
 * renderer/.../orcha-fab.js _startSlackPoll / _dmAutoReplyTimer, and
 * window/index.js's 5-min API refresh). The headless DevSpace standby has NO
 * renderer and NO Electron app, so none of those loops run there — which is why
 * a standby could authenticate + reply in a one-shot test but never replied to
 * a NEW message on its own. This daemon is the headless equivalent of those
 * renderer timers.
 *
 * THE MODEL (active/standby, laptop-primary):
 *   - Laptop (ACTIVE) is leader whenever it's running → it does all the work.
 *     This daemon's loops see mayRunProduction()===false and DO NOTHING.
 *   - Laptop down → the lease expires → this STANDBY takes over leadership →
 *     mayRunProduction() flips true → the loops start actually polling/replying/
 *     refreshing, continuing from the SYNCED watermark (no catch-up, Stage 13).
 *   - Laptop back → it reclaims the lease → this daemon's loops go quiet again.
 *
 * SAFETY:
 *   - Every PRODUCTION loop (Slack polls — they read AND send) is gated on
 *     cluster.mayRunProduction() EACH tick, so a standby that isn't currently
 *     leader performs no reads-for-reply and no sends. This is the same gate
 *     the IPC poll handlers use (_mayPollSlack), applied here too.
 *   - The live fleet refresh is gated on cluster.mayLivePull() (a READ gate):
 *     a capable standby MAY refresh its own view even when not leader, but a
 *     non-capable one skips. Independent of the production/send gate.
 *   - Flag-gated: start() is a no-op unless opted in (FLEET_STANDBY_DAEMON=1 or
 *     settings.cluster.standbyDaemon). Default OFF — importing/wiring is safe.
 *   - The engines' own first-sight baseline + reply-log dedup still apply, so
 *     even at the moment of takeover nothing replies to history.
 *
 * This module schedules work; it performs no side-effect itself beyond calling
 * the existing, already-gated engine functions.
 */

let logger; try { logger = require('../utils/logger')('standby-daemon'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const DEFAULTS = {
  slackDmMs: 30000,      // DM auto-reply poll cadence (matches renderer)
  slackChannelMs: 30000, // partner channel watch cadence
  fleetMs: 5 * 60 * 1000,// live fleet refresh cadence (matches window timer)
};

let _running = false;
let _timers = [];
let _setTimer = (fn, ms) => setInterval(fn, ms);
let _clearTimer = (h) => clearInterval(h);
let _lastTick = { slackDm: null, slackChannel: null, fleet: null };

function _optedIn() {
  if (process.env.FLEET_STANDBY_DAEMON === '1') return true;
  if (process.env.FLEET_STANDBY_DAEMON === '0') return false;
  try {
    const store = require('../store');
    const c = (store.load('settings', {}) || {}).cluster || {};
    return !!c.standbyDaemon;
  } catch (_) { return false; }
}

function _cluster() {
  try { return require('./index'); } catch (_) { return null; }
}

// Production gate: may this instance run production work (poll + send) right
// now? True on a legacy single-host OR when we currently hold leadership.
function _mayProduce() {
  const c = _cluster();
  if (!c || typeof c.mayRunProduction !== 'function') return true;
  try { return c.mayRunProduction(); } catch (_) { return true; }
}

// Read gate: may this instance pull live fleet reads right now?
function _mayLivePull() {
  const c = _cluster();
  if (!c || typeof c.mayLivePull !== 'function') return true;
  try { return c.mayLivePull(); } catch (_) { return true; }
}

// ── Individual loop bodies (each a no-op unless the right gate passes) ───────

async function _tickSlackDm() {
  if (!_mayProduce()) return;                 // not leader → standby does nothing
  try {
    const { pollDMAutoReplyOnce } = require('../scrapers/slack_dm_autoreply');
    const r = await pollDMAutoReplyOnce((m) => logger.info(m));
    _lastTick.slackDm = { at: new Date().toISOString(), replied: r && r.repliedCount, escalated: r && r.escalatedCount };
  } catch (e) { logger.warn('[standby-daemon] slack DM poll error: ' + e.message); }
}

async function _tickSlackChannel() {
  if (!_mayProduce()) return;
  try {
    const { pollChannelsOnce } = require('../scrapers/slack_channel_watch');
    await pollChannelsOnce((m) => logger.info(m));
    _lastTick.slackChannel = { at: new Date().toISOString() };
  } catch (e) { logger.warn('[standby-daemon] slack channel poll error: ' + e.message); }
}

async function _tickFleet() {
  if (!_mayLivePull()) return;                // non-capable standby → keep snapshot
  try {
    const store = require('../store');
    const s = store.load('settings', {}) || {};
    // RETIRED SCRAPE (2026-10-28): legacy settings.dataSource='scrape' is ignored.
    if (!require('../config/data-source').isApiMode()) return;
    const api = require('../scrapers/aap_api');
    // Stage 16: use the SYNCED fleet filter (the leader/desktop app's domicile
    // list) so the standby pulls the SAME fleet scope as the desktop, not this
    // headless host's default. Falls back to local settings.domiciles if the
    // synced filter hasn't arrived yet.
    let domiciles;
    try {
      const f = store.load('clusterFleetFilter', null);
      if (f && Array.isArray(f.domiciles) && f.domiciles.length) domiciles = f.domiciles;
    } catch (_) {}
    const ds = await api.buildFleetDataset(domiciles ? { withComments: false, domiciles } : { withComments: false });
    let rows = ds.rows || [];
    try { const uu = (store.load('uptakeHash', {}).units) || []; if (uu.length) rows = require('../scrapers/uptake').mergeUptakeIntoRows(rows, uu); } catch (_) {}
    try { const ns = store.load('notesStore', {}); rows = require('../scrapers/relay').mergeRelayIntoRows(rows, {}, ns); } catch (_) {}
    const now = new Date().toISOString();
    const out = { rows, count: rows.length, unavailableCount: ds.unavailableCount, scrapedAt: now, syncedAt: now, stale: false, source: 'aap-api-standby' };
    store.save('fleetData', out);              // shared key → auto-published if leader (Stage 9)
    _lastTick.fleet = { at: now, units: rows.length };
    logger.info('[standby-daemon] fleet refresh: ' + rows.length + ' units');
  } catch (e) { logger.warn('[standby-daemon] fleet refresh error: ' + e.message); }
}

/**
 * start(opts) — begin the background loops. No-op unless opted in. Timers are
 * injectable for tests (setTimer/clearTimer). opts: { slackDmMs, slackChannelMs,
 * fleetMs, immediate }.
 */
function start(opts) {
  opts = opts || {};
  if (_running) return { ok: true, already: true };
  if (!opts.force && !_optedIn()) {
    logger.info('[standby-daemon] not opted in (FLEET_STANDBY_DAEMON / settings.cluster.standbyDaemon) — idle');
    return { ok: false, skipped: 'not-opted-in' };
  }
  if (opts.setTimer) _setTimer = opts.setTimer;
  if (opts.clearTimer) _clearTimer = opts.clearTimer;
  _running = true;

  const dmMs = opts.slackDmMs || DEFAULTS.slackDmMs;
  const chMs = opts.slackChannelMs || DEFAULTS.slackChannelMs;
  const flMs = opts.fleetMs || DEFAULTS.fleetMs;

  _timers.push(_setTimer(() => { _tickSlackDm(); }, dmMs));
  _timers.push(_setTimer(() => { _tickSlackChannel(); }, chMs));
  _timers.push(_setTimer(() => { _tickFleet(); }, flMs));

  // Optional immediate kick so takeover doesn't wait a full interval.
  if (opts.immediate !== false) {
    _tickSlackDm(); _tickSlackChannel(); _tickFleet();
  }
  logger.info('[standby-daemon] started (slackDM ' + Math.round(dmMs/1000) + 's, channel ' +
    Math.round(chMs/1000) + 's, fleet ' + Math.round(flMs/60000) + 'min) — loops gated on leadership');
  return { ok: true };
}

function stop() {
  _running = false;
  for (const t of _timers) { try { _clearTimer(t); } catch (_) {} }
  _timers = [];
}

function getState() {
  return { running: _running, optedIn: _optedIn(), mayProduce: _mayProduce(), mayLivePull: _mayLivePull(), lastTick: _lastTick };
}

// Test hooks.
function _reset() { stop(); _setTimer = (fn, ms) => setInterval(fn, ms); _clearTimer = (h) => clearInterval(h); _lastTick = { slackDm: null, slackChannel: null, fleet: null }; }

module.exports = {
  start, stop, getState,
  _tickSlackDm, _tickSlackChannel, _tickFleet, _optedIn, _mayProduce, _mayLivePull, _reset,
  DEFAULTS,
};
