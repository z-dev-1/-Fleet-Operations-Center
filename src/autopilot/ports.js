'use strict';
/**
 * autopilot/ports.js — the only external boundary of Fleet Autopilot (§B7.1, §B14).
 *
 * create(deps?) -> Object.freeze({...}) of whitelisted READ functions. This is
 * the only Autopilot file that requires modules with network or session
 * access. It reads module members only through pick(mod, 'name'), and only the
 * names in PICKS. No port can open a window or page, create a session or start
 * a sign-in: AAP and Decisiv live reads use the transports' warm-only functions,
 * which check warmth inside the transport lock; DTNA and Aperia are cache-only.
 *
 * Live-read gates are evaluated synchronously right before each call:
 *   aapGetServiceIfWarm:   liveReads && cluster.mayLivePull() && midway HEALTHY && !offline
 *   decisiv*IfWarm:        liveReads && cluster.mayLivePull() && !offline, and srUrl present
 *                          (else DECISIV_NO_ORIGIN without calling). Decisiv auth health is
 *                          the in-lock warm check (window present, not destroyed, token set).
 * Live ports never throw: they resolve { ok:true, value } | { ok:false, code, status? }.
 *
 * deps (tests): { <module key>: fakeModule, liveReads: bool | () => bool }.
 * A module key present in deps (even null) replaces the real module. liveReads
 * defaults to false (fail closed). A missing member yields a stub that returns
 * { ok:false, code:'PORT_MISSING' }.
 */

// Lazy loaders: a module is required only when create() runs without a fake for it.
const MODULES = Object.freeze({
  store: () => require('../store'),
  fleetFreshness: () => require('../health/fleet-freshness'),
  canonicalState: () => require('../orcha/canonical_state'),
  riStore: () => require('../repair-intel/store'),
  riTrends: () => require('../repair-intel/trends'),
  vendorNetwork: () => require('../repair-intel/vendor-network'),
  taxonomy: () => require('../carrier-intel/taxonomy'),
  slackSearch: () => require('../orcha/fas/slack-search'),
  dtnaStore: () => require('../dtna/store'),
  dtnaSession: () => require('../dtna/session'),
  aapApi: () => require('../scrapers/aap_api'),
  decisivApi: () => require('../scrapers/decisiv_api'),
  aperiaSyncRead: () => require('../aperia/sync-read'),
  aperiaSession: () => require('../aperia/session'),
  midway: () => require('../auth/midway-health-supervisor'),
  cluster: () => require('../cluster'),
  offline: () => require('../orcha/offline'),
  relay: () => require('../orcha/relay'),
  offsiteOwner: () => require('../utils/offsite-owner'),
});

// The only members read from each module (pinned by tests/autopilot-no-write.test.js).
const PICKS = Object.freeze({
  store: Object.freeze(['load', 'generation']),
  fleetFreshness: Object.freeze(['evaluate', 'getSnapshot', 'RED_AGE_FACTOR']),
  canonicalState: Object.freeze(['getCanonical', 'isDown']),
  riStore: Object.freeze(['eventsForUnit', 'getAiAnalysis']),
  riTrends: Object.freeze(['repeatOffenders']),
  vendorNetwork: Object.freeze(['vendorScorecards']),
  taxonomy: Object.freeze(['downCause']),
  slackSearch: Object.freeze(['searchSlack']),
  dtnaStore: Object.freeze(['findByUnit']),
  dtnaSession: Object.freeze(['status']),
  aapApi: Object.freeze(['isWarm', 'getServiceIfWarm']),
  decisivApi: Object.freeze(['isWarm', 'getCaseStatusSummaryIfWarm', 'getActivityLogsIfWarm', 'formatActivityLogs']),
  aperiaSyncRead: Object.freeze(['cached']),
  aperiaSession: Object.freeze(['status']),
  midway: Object.freeze(['getState']),
  cluster: Object.freeze(['mayLivePull']),
  offline: Object.freeze(['isOffline']),
  relay: Object.freeze(['queueStats', 'getStatus', 'isolatedLaneAvailable']),
  offsiteOwner: Object.freeze(['offsiteUrlOf']),
});

const PORT_NAMES = Object.freeze([
  'readStore', 'generation', 'fleetFreshness', 'canonical', 'isDown',
  'riEvents', 'riAnalysis', 'riRepeat', 'vendorScorecards', 'downCause',
  'slackSearch', 'offsiteUrlOf', 'dtnaCasesForUnit', 'dtnaStatus',
  'aperiaCachedIssues', 'aperiaStatus', 'aapIsWarm', 'aapGetServiceIfWarm',
  'decisivIsWarm', 'decisivCaseStatusIfWarm', 'decisivActivityIfWarm', 'decisivFormatActivity',
  'authState', 'aiQueue', 'aiStatus', 'isolatedLaneAvailable',
]);

const READ_KEYS = Object.freeze([
  'fleetData', 'canonicalState', 'longDwellStore', 'longDwellCsv', 'relayReconcileConfig',
  'dtnaCaseCache', 'decisivCaseCache', 'emailEvidence', 'fasCases', 'contacts', 'vendorHistory',
]);

const AUTOPILOT_PROFILE = Object.freeze({ type: 'internal' });
const SLACK_OPTS = Object.freeze({ maxResults: 8, maxChars: 3000 });
const DECISIV_VENDORS = Object.freeze(['volvo', 'paccar']);

function portMissing() { return { ok: false, code: 'PORT_MISSING' }; }

/** pick(mod, name) -> the member (functions keep the module as `this`), or a PORT_MISSING stub / null. */
function pick(mod, name) {
  let v;
  try { v = mod ? mod[name] : undefined; } catch (_) { v = undefined; }
  if (typeof v === 'function') return (...args) => v.apply(mod, args);
  if (v === undefined) return /^[A-Z_]+$/.test(name) ? null : portMissing;
  return v;
}

function _code(e, fallback) { return (e && e.code) || fallback; }

function create(deps) {
  const d = deps || {};
  const p = {};
  for (const key of Object.keys(PICKS)) {
    let mod = null;
    if (Object.prototype.hasOwnProperty.call(d, key)) mod = d[key];
    else { try { mod = MODULES[key](); } catch (_) { mod = null; } }
    const members = {};
    for (const name of PICKS[key]) members[name] = pick(mod, name);
    p[key] = members;
  }
  const liveReadsOn = () => {
    try { return typeof d.liveReads === 'function' ? d.liveReads() === true : d.liveReads === true; }
    catch (_) { return false; }
  };
  const safeBool = (fn) => { try { return fn() === true; } catch (_) { return false; } };
  const gateCommon = () => {
    if (!liveReadsOn()) return 'LIVE_READS_OFF';
    if (!safeBool(p.cluster.mayLivePull)) return 'GATE_CLOSED';
    if (safeBool(p.offline.isOffline)) return 'GATE_CLOSED';
    return null;
  };
  const midwayState = () => { try { return p.midway.getState(); } catch (_) { return null; } };

  const ports = {
    readStore(key) {
      if (!READ_KEYS.includes(key)) return null;
      return p.store.load(key, null);
    },
    generation(key) { return p.store.generation(key); },
    fleetFreshness(now) {
      const ff = p.fleetFreshness;
      let e = null;
      let s = null;
      try { e = ff.evaluate(now); } catch (_) { e = null; }
      try { s = ff.getSnapshot(now); } catch (_) { s = null; }
      const lastOkAt = s && Number.isFinite(s.lastOkAt) ? s.lastOkAt : null;
      return {
        level: e && e.level != null ? e.level : 'grey',
        reasons: e && Array.isArray(e.reasons) ? e.reasons.slice() : [],
        intervalMs: e && Number.isFinite(e.intervalMs) ? e.intervalMs : null,
        redAgeFactor: Number.isFinite(ff.RED_AGE_FACTOR) ? ff.RED_AGE_FACTOR : 3,
        lastOkAt,
      };
    },
    canonical(row) { return p.canonicalState.getCanonical(row); },
    isDown(row) { return p.canonicalState.isDown(row); },
    riEvents(unit, sinceMs) { return p.riStore.eventsForUnit(unit, sinceMs != null ? { sinceMs } : {}); },
    riAnalysis(unit) { return p.riStore.getAiAnalysis(unit); },
    riRepeat(unit) {
      const r = p.riTrends.repeatOffenders({ equipmentId: unit });
      return (r && Array.isArray(r.offenders)) ? r.offenders : [];
    },
    vendorScorecards() { return p.vendorNetwork.vendorScorecards(); },
    downCause(row) { return p.taxonomy.downCause(row); },
    slackSearch(q) { return p.slackSearch.searchSlack(q, AUTOPILOT_PROFILE, SLACK_OPTS); },
    offsiteUrlOf(row) { return p.offsiteOwner.offsiteUrlOf(row); },
    dtnaCasesForUnit(unit) { return p.dtnaStore.findByUnit(unit); },
    dtnaStatus() { return p.dtnaSession.status(); },
    aperiaCachedIssues() { return p.aperiaSyncRead.cached(); },
    aperiaStatus() { return p.aperiaSession.status(); },
    aapIsWarm() { return safeBool(p.aapApi.isWarm); },
    async aapGetServiceIfWarm(serviceId) {
      const id = String(serviceId == null ? '' : serviceId).trim();
      if (!id) return { ok: false, code: 'INVALID_INPUT' };
      const g = gateCommon();
      if (g) return { ok: false, code: g };
      if (midwayState() !== 'HEALTHY') return { ok: false, code: 'GATE_CLOSED' };
      try {
        const v = await p.aapApi.getServiceIfWarm(id);
        if (v && v.ok === false && v.code) return { ok: false, code: v.code };
        return { ok: true, value: v };
      } catch (e) { return { ok: false, code: _code(e, 'AAP_API_ERROR'), status: e && e.status }; }
    },
    decisivIsWarm(srUrl) { return srUrl ? safeBool(() => p.decisivApi.isWarm(srUrl)) : false; },
    async decisivCaseStatusIfWarm(id, opts) {
      const srUrl = opts && opts.srUrl;
      if (!srUrl) return { ok: false, code: 'DECISIV_NO_ORIGIN' };
      const g = gateCommon();
      if (g) return { ok: false, code: g };
      try {
        const r = await p.decisivApi.getCaseStatusSummaryIfWarm(id, { srUrl });
        if (!r || r.ok !== true) return { ok: false, code: (r && r.code) || 'DECISIV_API_ERROR', status: r && r.status };
        const value = Object.assign({}, r);
        delete value.ok;
        return { ok: true, value };
      } catch (e) { return { ok: false, code: _code(e, 'DECISIV_API_ERROR') }; }
    },
    async decisivActivityIfWarm(id, opts) {
      const srUrl = opts && opts.srUrl;
      if (!srUrl) return { ok: false, code: 'DECISIV_NO_ORIGIN' };
      const g = gateCommon();
      if (g) return { ok: false, code: g };
      try {
        const v = await p.decisivApi.getActivityLogsIfWarm(id, { srUrl });
        if (v && v.ok === false && v.code) return { ok: false, code: v.code };
        return { ok: true, value: v };
      } catch (e) { return { ok: false, code: _code(e, 'DECISIV_API_ERROR'), status: e && e.status }; }
    },
    decisivFormatActivity(json) { return p.decisivApi.formatActivityLogs(json); },
    authState(srUrls) {
      let dtna = null;
      let aperia = null;
      try { const s = p.dtnaSession.status(); dtna = s && s.state != null ? s.state : null; } catch (_) {}
      try {
        const s = p.aperiaSession.status();
        aperia = s ? { state: s.state != null ? s.state : null, actionNeeded: !!s.actionNeeded } : null;
      } catch (_) {}
      const decisivWarm = {};
      const list = Array.isArray(srUrls) && srUrls.length ? srUrls : DECISIV_VENDORS;
      for (const u of list) decisivWarm[u] = safeBool(() => p.decisivApi.isWarm(u));
      return {
        midway: midwayState(),
        dtna,
        aperia,
        aapWarm: safeBool(p.aapApi.isWarm),
        decisivWarm,
      };
    },
    aiQueue() { return p.relay.queueStats(); },
    aiStatus() { return p.relay.getStatus(); },
    isolatedLaneAvailable() { return safeBool(p.relay.isolatedLaneAvailable); },
  };
  return Object.freeze(ports);
}

module.exports = { create, pick, PICKS, PORT_NAMES, READ_KEYS, AUTOPILOT_PROFILE };
