'use strict';
/**
 * src/aperia/share.js — toggle-gated underinflation share. Called fire-and-forget by watcher._notify for
 * each new or severity-escalated, non-muted, fleet-row alert.
 *
 *   onAlert(alert, { ctx }) -> Promise<{ ok, code?, skipped?, dm?, item? }>   (never throws)
 *     1. share pref OFF -> { ok:true, skipped:'off' } with no other call
 *     2. alert.state not UNDERINFLATION / UNDERINFLATION_AND_LEAK -> skipped 'not-shareable'
 *     3. no fleet row for the unit (ctx.lastData.rows, else stored fleetData) or out of fleet scope -> 'out-of-scope'
 *     4. the ledger already DM'd this id at this severity or higher -> 'already-sent'
 *     5. vehicle detail (getVehicle by vehicleId, else lookupUnit by unit); a failed read schedules ONE retry in 60 s
 *     6. the detail's issue type must be shareable too
 *     7. street address from the unit GPS (omitted when it cannot be resolved)
 *     8. AI-composed text (validated; deterministic fallback)
 *     9. Slack DM to the operator owner (Settings -> Operator Channels); the ledger is marked only after the send
 *    10. a 'pending' carrier-briefing item when the operator has a carrier channel; it never posts by itself
 *
 * One run per issue id at a time. Logs { op:'share', code, dm, item, ms } only.
 */
const log = require('../utils/logger')('aperia');

const RETRY_MS = 60e3;

// Test seam: { pref, store, client, fleetScope, geocode, compose, resolveOperatorEntry, slack, storeMod, now, setTimeout }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _d(k, load) { return k in _deps ? _deps[k] : load(); }
function _pref() { return _d('pref', () => require('./share-pref')); }
function _store() { return _d('store', () => require('./share-store')); }
function _client() { return _d('client', () => require('./client')); }
function _fleetScope() { return _d('fleetScope', () => require('./fleet-scope')); }
function _geocode() { return _d('geocode', () => require('./geocode')); }
function _compose() { return _d('compose', () => require('./share-compose')); }
function _resolveOperatorEntry() { return _d('resolveOperatorEntry', () => require('../scrapers/pm_alert_reply').resolveOperatorEntry); }
function _slack() { return _d('slack', () => require('../scrapers/slack_send')); }
function _storeMod() { return _d('storeMod', () => require('../store')); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _setTimeout() { return typeof _deps.setTimeout === 'function' ? _deps.setTimeout : (fn, ms) => globalThis.setTimeout(fn, ms); }

const _inFlight = new Map();
const _retried = new Set();

function _fleetRow(ctx, fleetVehicleId) {
  const { normUnit } = require('../dtna/join');
  const want = normUnit(fleetVehicleId);
  if (!want) return null;
  let rows = ctx && ctx.lastData && Array.isArray(ctx.lastData.rows) ? ctx.lastData.rows : [];
  if (!rows.length) {
    try {
      const fd = _storeMod().load('fleetData', {}) || {};
      rows = Array.isArray(fd.rows) ? fd.rows : [];
    } catch (_) { rows = []; }
  }
  return rows.find((r) => r && typeof r === 'object' && normUnit(r.equipmentId) === want) || null;
}

function _done(t0, r) {
  log.info('[aperia] share', { op: 'share', code: r.code || r.skipped || 'OK', dm: !!r.dm, item: !!r.item, ms: Date.now() - t0 });
  return r;
}

function _scheduleRetry(alert, ctx) {
  const id = String(alert.id);
  if (_retried.has(id)) return;
  _retried.add(id);
  try {
    const t = _setTimeout()(() => { onAlert(alert, { ctx, _retry: true }).catch(() => {}); }, RETRY_MS);
    if (t && typeof t.unref === 'function') t.unref();
  } catch (_) {}
}

async function _run(alert, opts) {
  const t0 = Date.now();
  const ctx = (opts && opts.ctx) || null;
  try {
    if (!_pref().load().enabled) return { ok: true, skipped: 'off' };
    const compose = _compose();
    if (!compose.isShareable(alert.state)) return _done(t0, { ok: true, skipped: 'not-shareable' });

    const row = _fleetRow(ctx, alert.fleetVehicleId);
    const fs = _fleetScope();
    if (!row || !fs.inScope(fs.fleetUnitSet(ctx), alert.fleetVehicleId)) return _done(t0, { ok: true, skipped: 'out-of-scope' });

    const store = _store();
    if (!store.shouldSend(alert.id, alert.severity)) return _done(t0, { ok: true, skipped: 'already-sent' });

    let r;
    try {
      r = alert.vehicleId ? await _client().getVehicle(alert.vehicleId, ctx) : await _client().lookupUnit(alert.fleetVehicleId, ctx);
    } catch (_) { r = { ok: false, code: 'APERIA_INTERNAL' }; }
    if (!r || !r.ok || !r.unit) {
      if (!(opts && opts._retry)) _scheduleRetry(alert, ctx);
      return _done(t0, { ok: false, code: (r && r.code) || 'APERIA_INTERNAL' });
    }
    const unit = r.unit;
    const facts = compose.alertFacts(unit, alert);
    // Re-check on the vehicle detail: the embedded issue's type must be shareable too.
    const hit = (Array.isArray(unit.tires) ? unit.tires : []).find((t) => t && t.issue && String(t.issue.id) === String(alert.id));
    const detailType = hit && hit.issue.type ? hit.issue.type : facts.state;
    if (!compose.isShareable(detailType) || !compose.isShareable(facts.state)) return _done(t0, { ok: true, skipped: 'not-shareable' });

    let address = null;
    if (unit.gps) {
      try { address = await _geocode().reverseGeocode(unit.gps.lat, unit.gps.lng); } catch (_) { address = null; }
    }
    const { text } = await compose.compose(facts, address);

    let entry = null;
    try { entry = _resolveOperatorEntry()(row.operator); } catch (_) { entry = null; }
    const out = { ok: true, code: 'OK', dm: false, item: false };
    if (entry && entry.ownerId) {
      try {
        const slack = _slack();
        const dm = await slack.openConversation({ id: entry.ownerId, type: 'user' });
        if (!dm) throw new Error('no dm channel');
        await slack.sendToChannel(dm, text, null, { unfurl: false });
        out.dm = true;
        store.markSent(alert.id, alert.severity);
      } catch (_) {
        out.ok = false;
        out.code = 'APERIA_SHARE_SEND_FAILED';
      }
    } else {
      out.code = 'no-owner';
    }
    if (entry && entry.channelId) {
      const it = store.addItem({
        issueId: alert.id, unit: facts.unit, operator: row.operator, severity: facts.severity || alert.severity,
        state: facts.state, text,
      }, _now());
      out.item = !!it;
    }
    return _done(t0, out);
  } catch (_) {
    return _done(t0, { ok: false, code: 'APERIA_INTERNAL' });
  }
}

function onAlert(alert, opts) {
  if (!alert || alert.id === null || alert.id === undefined || alert.id === '') return Promise.resolve({ ok: true, skipped: 'no-id' });
  const id = String(alert.id);
  if (_inFlight.has(id)) return _inFlight.get(id);
  const p = _run(alert, opts || {}).finally(() => { _inFlight.delete(id); });
  _inFlight.set(id, p);
  return p;
}

function _resetForTests() { _deps = {}; _inFlight.clear(); _retried.clear(); }

module.exports = { onAlert, RETRY_MS, _setDeps, _resetForTests };
