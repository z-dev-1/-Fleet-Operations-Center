'use strict';
// tests/helpers/autopilot-fakes.cjs — shared fakes for the fleet-autopilot FEAT-003 tests:
// a tmp SQLite data dir, an in-memory settings store, a fake worker supervisor, a fake port
// object over a mutable "world", a fake clock and a fake reason(). No live calls.
const fs = require('fs');
const os = require('os');
const path = require('path');

const T0 = Date.parse('2026-11-20T15:00:00Z');
const MIN = 60000;
const H = 60 * MIN;
const DAY = 24 * H;
const SR = 'https://volvopg.asist.decisiv.net/fleet/estimates/21350186';

const { setDataDir } = require('../../src/config/paths');
setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-boot-')));   // before anything opens the store
const engine = require('../../src/store/sqlite_engine');
const schema = require('../../src/autopilot/schema');
const cs = require('../../src/autopilot/case-store');

function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-' + (label || 't') + '-'));
  setDataDir(dir);
  engine.close();
  schema._resetForTests();
  return dir;
}

function settingsStore(initial) {
  let doc = JSON.parse(JSON.stringify(initial || {}));
  const writes = [];
  return {
    load(k, fb) { return k === 'settings' ? JSON.parse(JSON.stringify(doc)) : fb; },
    update(k, fn) {
      if (k !== 'settings') throw new Error('unexpected key ' + k);
      doc = fn(JSON.parse(JSON.stringify(doc)));
      writes.push(k);
      return doc;
    },
    get doc() { return doc; },
    writes,
  };
}

function fakeSupervisor(opts) {
  const o = opts || {};
  const records = new Map();
  const sup = {
    enabled: o.enabled !== false,
    registerCalls: 0,
    stopCalls: 0,
    isEnabled() { return sup.enabled; },
    register(spec) {
      sup.registerCalls++;
      const ex = records.get(spec.name);
      if (ex && !ex.ownerStopped) throw Object.assign(new Error('worker already active'), { code: 'WORKER_ACTIVE' });
      records.set(spec.name, { spec, ownerStopped: false });
      return true;
    },
    stop(name) {
      sup.stopCalls++;
      const r = records.get(name);
      if (!r) return;
      if (r.spec.stop) r.spec.stop();
      r.ownerStopped = true;
    },
    record(name) { return records.get(name || 'autopilot') || null; },
    active(name) { const r = records.get(name || 'autopilot'); return !!(r && !r.ownerStopped); },
    async runTick(signal) {
      const r = records.get('autopilot');
      if (!r || r.ownerStopped) return { skipped: 'not_registered' };
      return r.spec.tick({ signal: signal || new AbortController().signal });
    },
    getStatus() {
      return { enabled: sup.enabled, workers: [...records.values()].map((r) => ({ name: r.spec.name, state: r.ownerStopped ? 'disabled' : 'healthy', breakerState: 'ok', lastHeartbeatAt: null })) };
    },
  };
  return sup;
}

function baseRow(extra) {
  return Object.assign({
    equipmentId: '322283', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair',
    _apiSourced: true, _serviceId: 'svc-1', workRequestId: 'wr-1', workDuration: '5d 2h 0m',
    vendor: 'Penske Truck Leasing', repairEtc: '2026-11-15', repairEtcSource: 'decisiv', offsiteStage: 'repair',
  }, extra || {});
}

function mkWorld(over) {
  const w = Object.assign({
    rows: [baseRow()],
    syncedAt: new Date(T0 - H).toISOString(),
    source: 'aap-api',
    lastOkAt: T0 - H,
    ffLevel: 'green',
    ffReasons: [],
    intervalMs: 600000,
    docs: { relayReconcileConfig: { staleDays: 3 }, decisivCaseCache: {}, emailEvidence: {}, fasCases: {}, longDwellStore: {}, longDwellCsv: null, canonicalState: null },
    gens: {},
    midway: 'HEALTHY',
    aperia: { state: 'ok', actionNeeded: false },
    aapWarm: false,
    decisivWarm: false,
    aiQueue: { active: 0, waiting: 0, max: 4, reserve: 1, byPriority: { critical: { waiting: 0 }, high: { waiting: 0 }, normal: { waiting: 0 }, low: { waiting: 0 } }, flags: { priorities: false } },
    aiStatus: { model: 'test-model', backends: { claude: true, orcha: false } },
    isolated: true,
    dtna: {},
    aperiaIssues: null,
    riEvents: [],
    riRepeat: [],
    slack: [],
    canonical: () => null,
    aapLive: null,
    decisivStatus: null,
    calls: { aapLive: 0, decisivStatus: 0, decisivActivity: 0, slack: 0, aperia: 0 },
  }, over || {});
  return w;
}

function fakePorts(w) {
  return Object.freeze({
    readStore(k) {
      if (k === 'fleetData') return { rows: w.rows, syncedAt: w.syncedAt, source: w.source };
      return Object.prototype.hasOwnProperty.call(w.docs, k) ? w.docs[k] : null;
    },
    generation(k) { return w.gens[k] || 0; },
    fleetFreshness() { return { level: w.ffLevel, reasons: w.ffReasons.slice(), intervalMs: w.intervalMs, redAgeFactor: 3, lastOkAt: w.lastOkAt }; },
    canonical(row) { return w.canonical(row); },
    isDown(row) { return /unavail/i.test(String((row && row.lifecycleState) || '')); },
    riEvents() { return w.riEvents; },
    riAnalysis() { return null; },
    riRepeat() { return w.riRepeat; },
    vendorScorecards() { return []; },
    downCause() { return null; },
    slackSearch() { w.calls.slack++; return { ok: true, results: w.slack }; },
    offsiteUrlOf() { return null; },
    dtnaCasesForUnit(u) { return w.dtna[u] || []; },
    dtnaStatus() { return { state: 'ok' }; },
    aperiaCachedIssues() { w.calls.aperia++; return w.aperiaIssues; },
    aperiaStatus() { return w.aperia; },
    aapIsWarm() { return w.aapWarm; },
    async aapGetServiceIfWarm(id) { w.calls.aapLive++; return w.aapLive ? w.aapLive(id) : { ok: false, code: 'AAP_NOT_WARM' }; },
    decisivIsWarm() { return w.decisivWarm; },
    async decisivCaseStatusIfWarm(id, o) {
      if (!o || !o.srUrl) return { ok: false, code: 'DECISIV_NO_ORIGIN' };
      w.calls.decisivStatus++;
      return w.decisivStatus ? w.decisivStatus(id) : { ok: false, code: 'DECISIV_NOT_WARM' };
    },
    async decisivActivityIfWarm() { w.calls.decisivActivity++; return { ok: true, value: { notes: [] } }; },
    decisivFormatActivity() { return { text: '', count: 0 }; },
    authState() { return { midway: w.midway, dtna: 'ok', aperia: w.aperia, aapWarm: w.aapWarm, decisivWarm: {} }; },
    aiQueue() { return w.aiQueue; },
    aiStatus() { return w.aiStatus; },
    isolatedLaneAvailable() { return w.isolated; },
  });
}

/** A schema-valid AI reply citing the evidence ids found in the prompt. */
function aiReply(prompt, over) {
  const ids = [...String(prompt).matchAll(/\[(ev_[a-f0-9_]+)\] aap_cache lifecycleState/g)].map((m) => m[1]);
  const any = [...String(prompt).matchAll(/\[(ev_[a-f0-9_]+)\]/g)].map((m) => m[1]);
  const id = ids[0] || any[0] || 'ev_missing';
  return Object.assign({
    schemaVersion: 1,
    summary: 'Unit is down at the vendor.',
    confirmedFacts: [{ statement: 'AAP lifecycle is Unavailable.', evidenceIds: [id] }],
    inferences: [{ statement: 'Repair may be stalled.', reasoning: 'No update.', confidence: 0.6, evidenceIds: [id] }],
    stageStall: { stalled: false, stage: 'repair', reasoning: 'n/a', confidence: 0.3, evidenceIds: [] },
    missingInfo: [],
    conflicts: [],
    responsibleParty: { party: 'vendor', evidenceIds: [id] },
    recommendedActions: [{ action: 'Keep watching', rationale: 'r', owner: 'fleet', actionClass: 'monitor', evidenceIds: [id] }],
    actionsRequiringApproval: [{ action: 'Ask the vendor for an ETC', rationale: 'r', owner: 'fleet', actionClass: 'vendor_follow_up', evidenceIds: [id] }],
    urgency: 'normal',
    nextReviewInHours: 12,
  }, over || {});
}

function okReason(over) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return { ok: true, data: aiReply(opts.prompt, typeof over === 'function' ? over(opts) : over), raw: '', aiUsed: true, error: null }; };
  fn.calls = calls;
  return fn;
}

function clock(t) {
  const c = { t: t == null ? T0 : t };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; return c.t; };
  return c;
}

/** A controller + facade wired to the fakes and the real case store. */
function mkEnv(opts) {
  const o = opts || {};
  const { createAutopilot } = require('../../src/autopilot');
  const ck = o.clock || clock();
  const world = o.world || mkWorld();
  const settings = o.settings || settingsStore({ autopilot: Object.assign({ features: { liveReads: true } }, o.autopilot || {}) });
  const supervisor = o.supervisor || fakeSupervisor({ enabled: o.supervisorEnabled !== false });
  const ports = o.ports || fakePorts(world);
  const reason = o.reason || okReason();
  const deferred = [];
  const notifications = [];
  const pushes = [];
  const ap = createAutopilot({
    supervisor, ports, reason, settingsStore: settings, env: o.env || {}, now: ck.now, rand: () => 0.5,
    owner: o.owner || 'owner-a', caseStore: o.caseStore || cs, telemetry: null,
    defer: (fn) => deferred.push(fn),
    ctx: { pushBubbleNotification: (n) => notifications.push(n), sendToWindow: (ch, p) => pushes.push([ch, p]) },
  });
  return {
    ap, ctl: ap.controller, clock: ck, world, settings, supervisor, ports, reason, deferred, notifications, pushes, cs,
    async flush() { while (deferred.length) { deferred.shift()(); await ap.controller.whenIdle(); } },
  };
}

function cfgOf(over) {
  const { resolveAutopilotConfig } = require('../../src/autopilot/config');
  return resolveAutopilotConfig({ autopilot: Object.assign({ features: { liveReads: true } }, over || {}) }, {});
}

/** Create a QUEUED case for the world's first row through detection-shaped input. */
function seedCase(unit, extra) {
  return cs.upsertDetected(Object.assign({
    unitId: unit || '322283', domicile: 'ABE40', reasons: [{ code: 'OOS' }, { code: 'DWELL_EXCEEDED' }, { code: 'ETA_OVERDUE_VERIFIED' }],
    openedBy: 'oos_rule', daysDown: 5, downSince: T0 - 5 * DAY, eta: { status: 'VERIFIED_OVERDUE', date: '2026-11-15', source: 'decisiv' },
    buildAtMs: T0 - 2 * H,
  }, extra || {}), { now: T0 - 2 * H });
}

module.exports = {
  T0, MIN, H, DAY, SR, engine, schema, cs, freshDb, settingsStore, fakeSupervisor, baseRow, mkWorld, fakePorts,
  aiReply, okReason, clock, mkEnv, cfgOf, seedCase,
};
