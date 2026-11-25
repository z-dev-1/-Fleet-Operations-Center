// tests/autopilot-controller.test.js — fleet-autopilot §B10 controller and the index.js facade:
// tick order, resolution sweep (R1, R3), detection triggers (cfgFp), scope / feature sweep (R7, R8),
// mutex, controls and aborts (first reason wins), registration (R4), master OFF and supervisor-
// disabled paths with an engine SQL spy (AC-18, AC-19), and a full run over the real ports object
// with sign-in / window spies at zero (AC-21).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });   // multi-tick integration tests; the CI host can be loaded
const F = require('./helpers/autopilot-fakes.cjs');
const portsMod = require('../src/autopilot/ports');

const { H, MIN } = F;

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('ctl'); });

const openCases = () => F.cs.listCases({}).items;
const only = () => { const l = openCases(); expect(l.length).toBe(1); return l[0]; };
const transitions = (id) => F.cs.getCase(id).events.filter((e) => e.kind === 'transition');
function gate() { let open; const p = new Promise((r) => { open = r; }); return { p, open }; }
function apSql(spy) { return spy.mock.calls.map((c) => String(c[0])).filter((q) => /\bap_/.test(q)); }

describe('tick pipeline', () => {
  it('detects, queues and investigates in one tick; the resolution sweep runs before detection', async () => {
    const order = [];
    const wrap = Object.assign({}, F.cs, {
      sweepResolution: (...a) => { order.push('sweep'); return F.cs.sweepResolution(...a); },
      upsertDetected: (...a) => { order.push('detect'); return F.cs.upsertDetected(...a); },
      listOpen: (...a) => { order.push('listOpen'); return F.cs.listOpen(...a); },
    });
    const env = F.mkEnv({ caseStore: wrap });
    expect(env.ap.boot()).toEqual({ registered: true });
    expect(env.supervisor.record().spec).toMatchObject({ name: 'autopilot', group: 'autopilot', label: 'Fleet Autopilot (shadow)', intervalMs: 300000,
      initialDelayMs: 180000, timeoutMs: 600000, maxFailures: 3, cooldownMs: 1800000, backoff: true, dependsOn: ['cluster.production'], idempotent: true });
    const r = await env.supervisor.runTick();
    expect(order.slice(0, 2)).toEqual(['sweep', 'detect']);
    expect(order.indexOf('listOpen')).toBeGreaterThan(order.indexOf('detect'));
    expect(r.detected).toBe(1);
    expect(r.investigated[0]).toMatchObject({ ok: true, state: 'RECOMMENDATION_READY' });
    expect(only().reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['OOS', 'DWELL_EXCEEDED', 'ETA_OVERDUE_VERIFIED']));
    expect(env.pushes.some(([ch]) => ch === 'autopilot:changed')).toBe(true);
  });

  it('running detection twice on the same data creates no second open case (AC-12)', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce({ forceDetect: true });
    env.clock.advance(MIN);
    await env.ctl.runOnce({ forceDetect: true });
    expect(openCases().length).toBe(1);
  });

  it('a recovered ABE40 unit in a newer aap-api build goes straight to RESOLVED, never PAUSED (AC-10)', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const c = only();
    env.world.rows[0].lifecycleState = 'Active';
    env.world.lastOkAt = env.clock.now() + 10 * MIN;
    env.clock.advance(20 * MIN);
    await env.ctl.runOnce();
    const k = F.cs.getCase(c.case_id).case;
    expect(k.state).toBe('RESOLVED');
    expect(k.resolution).toMatchObject({ lifecycleState: 'Active', source: 'aap-api', buildAt: env.world.lastOkAt });
    expect(transitions(c.case_id).some((e) => e.to_state === 'PAUSED')).toBe(false);
  });

  it('R1: syncedAt re-stamps without a new build do not count as missing builds; two builds -> NEEDS_REVIEW unit_missing', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const id = only().case_id;
    const row = env.world.rows.pop();
    env.world.lastOkAt += 10 * MIN;
    for (let i = 0; i < 3; i++) {
      env.clock.advance(MIN);
      env.world.syncedAt = new Date(env.clock.now()).toISOString();   // hydrate / PM-fill re-stamp
      await env.ctl.runOnce();
    }
    expect(F.cs.getCase(id).case).toMatchObject({ missing_syncs: 1, state: 'RECOMMENDATION_READY' });
    env.world.lastOkAt += 10 * MIN;
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case).toMatchObject({ missing_syncs: 2, state: 'NEEDS_REVIEW' });
    expect(transitions(id).pop().reason_code).toBe('unit_missing');
    env.world.rows.push(row);
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case).toMatchObject({ missing_syncs: 0, last_missing_build_at: null });
  });

  it('R3: an accepted lifecycle_not_active review stays MONITORING over three ticks; a later Active build resolves it', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const id = only().case_id;
    env.world.rows[0].lifecycleState = 'Ordered';
    env.world.lastOkAt += 10 * MIN;
    env.clock.advance(15 * MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case.state).toBe('NEEDS_REVIEW');
    expect(env.ap.review(id, 'accept', 'known decommission').ok).toBe(true);
    const n = transitions(id).length;
    for (let i = 0; i < 3; i++) { env.clock.advance(MIN); await env.ctl.runOnce(); }
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'MONITORING', review_status: 'accepted', review_accepted_code: 'lifecycle_not_active' });
    expect(transitions(id).length).toBe(n);
    env.world.rows[0].lifecycleState = 'Active';
    env.world.lastOkAt += 10 * MIN;
    env.clock.advance(15 * MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case.state).toBe('RESOLVED');
  });

  it('changing oosDays (and separately scope.units) runs detection on the very next tick (AC-3)', async () => {
    const env = F.mkEnv({ autopilot: { oosDays: 10 } });
    env.world.rows[0] = F.baseRow({ repairEtc: '', repairEtcSource: '' });
    env.world.rows.push(F.baseRow({ equipmentId: '777777', domicileSite: 'XYZ1', repairEtc: '', repairEtcSource: '', workDuration: '9d' }));
    await env.supervisor.runTick().catch(() => {});
    env.ap.boot();
    await env.supervisor.runTick();
    expect(openCases().length).toBe(0);
    env.clock.advance(MIN);
    expect(env.ap.setConfig({ oosDays: 3 }).ok).toBe(true);
    await env.supervisor.runTick();
    expect(openCases().map((c) => c.unit_id)).toEqual(['322283']);
    env.clock.advance(MIN);
    expect(env.ap.setConfig({ scope: { units: ['777777'] } }).ok).toBe(true);
    await env.supervisor.runTick();
    expect(openCases().map((c) => c.unit_id).sort()).toEqual(['322283', '777777']);
  });

  it('set-config rejects runState (run-state changes go through control())', async () => {
    const env = F.mkEnv();
    env.ap.boot();
    for (const v of ['paused', 'stopped', 'running']) {
      expect(env.ap.setConfig({ runState: v })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'runState' });
    }
    expect(env.settings.doc.autopilot.runState).toBeUndefined();
    expect(env.deferred.length).toBe(0);
  });

  it('two consecutive AAP builds with identical evidence -> no evidence_changed trigger and no second AI call', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const id = only().case_id;
    expect(env.reason.calls.length).toBe(1);
    const fp0 = F.cs.getCase(id).case.evidence_fp;
    const cheap0 = F.cs.getCase(id).case.cheap_fp;
    expect(cheap0).toBeTruthy();
    // Next AAP build: new build time and syncedAt, workDuration recomputed, nothing else changed.
    env.clock.advance(H);
    env.world.lastOkAt = env.clock.now() - MIN;
    env.world.syncedAt = new Date(env.clock.now() - MIN).toISOString();
    env.world.rows[0] = F.baseRow({ workDuration: '5d 3h 0m' });
    env.world.gens.fleetData = (env.world.gens.fleetData || 0) + 1;
    const out = await env.ctl.runOnce();
    expect(out.triggers).toBe(0);
    expect(out.investigated.length).toBe(0);
    expect(env.reason.calls.length).toBe(1);
    expect(F.cs.getCase(id).case.evidence_fp).toBe(fp0);
    expect(F.cs.getCase(id).runs.filter((r) => r.trigger === 'evidence_changed').length).toBe(0);
  });

  it('a successful set-config that changes scope / oosDays / features schedules one runOnce; intervalMs alone does not', async () => {
    const env = F.mkEnv();
    env.ap.boot();
    env.ap.setConfig({ features: { slackEvidence: true } });   // invalid key -> rejected, nothing scheduled
    expect(env.deferred.length).toBe(0);
    env.ap.setConfig({ intervalMs: 600000 });
    expect(env.deferred.length).toBe(0);
    env.ap.setConfig({ features: { longDwellInvestigation: false } });
    expect(env.deferred.length).toBe(1);
    await env.flush();
    expect(env.ctl.status().lastTick).toBeTruthy();
  });
});

describe('feature and scope sweep (R7, R8)', () => {
  it('oosInvestigation OFF -> the next tick pauses oos cases (feature_off); back ON -> QUEUED feature_on', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const id = only().case_id;
    env.ap.setConfig({ features: { oosInvestigation: false } });
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'PAUSED', pause_reason: 'feature_off' });
    env.ap.setConfig({ features: { oosInvestigation: true } });
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    const k = F.cs.getCase(id).case;
    expect(k.state).not.toBe('PAUSED');
    expect(transitions(id).some((e) => e.reason_code === 'feature_on')).toBe(true);
  });

  it('longDwellInvestigation OFF pauses a long-dwell-only case but not one that also has DWELL_EXCEEDED; ON re-queues it', async () => {
    const env = F.mkEnv();
    env.world.rows[0] = F.baseRow({ workDuration: '1d', repairEtc: '2026-12-30', repairEtcSource: 'decisiv' });
    env.world.rows.push(F.baseRow({ equipmentId: '321185', _serviceId: 'svc-2', workRequestId: 'wr-2', workDuration: '9d', repairEtc: '2026-12-30' }));
    env.world.docs.longDwellStore = { 322283: { updatedAt: new Date(env.clock.now() - H).toISOString() }, 321185: { updatedAt: new Date(env.clock.now() - H).toISOString() } };
    env.ap.setConfig({ maxCasesPerTick: 2 });
    await env.ctl.runOnce();
    const byUnit = () => Object.fromEntries(openCases().map((c) => [c.unit_id, c]));
    expect(byUnit()['322283'].opened_by).toBe('long_dwell');
    env.ap.setConfig({ features: { longDwellInvestigation: false } });
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(byUnit()['322283']).toMatchObject({ state: 'PAUSED', pause_reason: 'feature_off' });
    expect(byUnit()['321185'].state).not.toBe('PAUSED');
    env.ap.setConfig({ features: { longDwellInvestigation: true } });
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(byUnit()['322283'].state).not.toBe('PAUSED');
  });

  it('an open case whose unit left scope is PAUSED out_of_scope and re-queued when it returns', async () => {
    const env = F.mkEnv();
    await env.ctl.runOnce();
    const id = only().case_id;
    env.world.rows[0].domicileSite = 'XYZ1';
    env.ap.setConfig({ scope: { units: [] } });
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'PAUSED', pause_reason: 'out_of_scope' });
    env.world.rows[0].domicileSite = 'ABE40';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case.state).not.toBe('PAUSED');
  });
});

describe('mutex, controls and aborts', () => {
  it('a second tick and run-now during a tick are refused (one run, mutex)', async () => {
    const g = gate();
    const env = F.mkEnv({ reason: async (o) => { await g.p; return { ok: true, data: F.aiReply(o.prompt) }; } });
    env.ap.boot();
    const t1 = env.supervisor.runTick();
    await new Promise((r) => setTimeout(r, 20));
    expect(await env.supervisor.runTick()).toEqual({ skipped: 'busy' });
    expect(await env.ap.control('run-now')).toEqual({ ok: false, code: 'BUSY' });
    expect(await env.ap.runOnce()).toEqual({ ok: false, code: 'BUSY' });
    g.open();
    const r = await t1;
    expect(r.investigated.length).toBe(1);
    expect(F.cs.getCase(only().case_id).runs.length).toBe(1);
  });

  it('PAUSE mid-run parks the case PAUSED master_pause with no further AI calls; RESUME re-queues and runs', async () => {
    let calls = 0;
    let env;
    env = F.mkEnv({ reason: async () => { calls++; await env.ap.control('pause'); return { ok: false, error: 'aborted' }; } });
    env.ap.boot();
    await env.supervisor.runTick();
    const id = only().case_id;
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'PAUSED', pause_reason: 'master_pause' });
    expect(env.settings.doc.autopilot.runState).toBe('paused');
    expect(await env.supervisor.runTick()).toEqual({ skipped: 'paused' });
    expect(calls).toBe(1);
    expect(await env.ap.control('resume')).toEqual({ ok: true, runState: 'running' });
    await env.flush();
    expect(F.cs.getCase(id).case.state).not.toBe('PAUSED');
    expect(calls).toBe(1);   // resumed from ai_pending: interrupted, no second AI call
  });

  it('STOP then the supervisor stop hook -> PAUSED master_stop (first reason wins); STOP survives a restart', async () => {
    let env;
    env = F.mkEnv({ reason: async () => { await env.ap.control('stop'); return { ok: false, error: 'aborted' }; } });
    env.ap.boot();
    await env.supervisor.runTick();
    const id = only().case_id;
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'PAUSED', pause_reason: 'master_stop' });
    expect(env.supervisor.active()).toBe(false);
    const env2 = F.mkEnv({ settings: env.settings, owner: 'owner-b' });
    expect(env2.ap.boot()).toEqual({ registered: false });
    expect(env2.supervisor.registerCalls).toBe(0);
  });

  it('R4: STOP -> resume in the same process registers again and runs a tick', async () => {
    const env = F.mkEnv();
    env.ap.boot();
    await env.ap.control('stop');
    expect(env.supervisor.active()).toBe(false);
    await env.ap.control('resume');
    expect(env.supervisor.active()).toBe(true);
    await env.flush();
    expect(only().state).toBe('RECOMMENDATION_READY');
  });

  it('R4: master OFF stops the worker without touching runState; ON registers again and the next tick runs', async () => {
    const env = F.mkEnv();
    env.ap.boot();
    expect(env.ap.setConfig({ enabled: false }).ok).toBe(true);
    expect(env.supervisor.active()).toBe(false);
    expect(env.settings.doc.autopilot.runState).toBeUndefined();
    expect(env.ap.setConfig({ enabled: true }).ok).toBe(true);
    expect(env.supervisor.active()).toBe(true);
    const r = await env.supervisor.runTick();
    expect(r.ok).toBe(true);
    expect(openCases().length).toBe(1);
  });

  it('R4: ensureRegistered over an active record is a no-op', () => {
    const env = F.mkEnv();
    expect(env.ctl.ensureRegistered()).toBe(true);
    const rec = env.supervisor.record();
    expect(env.ctl.ensureRegistered()).toBe(true);
    expect(env.supervisor.record()).toBe(rec);
  });

  it('intervalMs change mid-run -> abort reconfigure, case QUEUED with no attempt penalty, new spec registered', async () => {
    let env;
    env = F.mkEnv({ reason: async () => { env.ap.setConfig({ intervalMs: 600000 }); return { ok: false, error: 'aborted' }; } });
    env.ap.boot();
    await env.supervisor.runTick();
    expect(only()).toMatchObject({ state: 'QUEUED', attempts: 0 });
    expect(env.supervisor.record().spec.intervalMs).toBe(600000);
    expect(env.supervisor.active()).toBe(true);
  });

  it('the supervisor aborting ctx.signal mid-run -> shutdown, QUEUED; the 8-min budget -> budget, QUEUED', async () => {
    const ac = new AbortController();
    const env = F.mkEnv({ reason: async () => { ac.abort(); return { ok: false, error: 'aborted' }; } });
    env.ap.boot();
    await env.supervisor.runTick(ac.signal);
    expect(only().state).toBe('QUEUED');
    expect(F.cs.getCase(only().case_id).events.some((e) => e.reason_code === 'aborted:shutdown')).toBe(true);
    F.freshDb('ctl2');
    let env2;
    env2 = F.mkEnv({ reason: async () => { env2.ctl.abortInFlight('budget'); env2.ctl.abortInFlight('master_stop'); return { ok: false, error: 'aborted' }; } });
    await env2.ctl.runOnce();
    expect(only()).toMatchObject({ state: 'QUEUED', attempts: 0 });
    expect(F.cs.getCase(only().case_id).events.some((e) => e.reason_code === 'aborted:budget')).toBe(true);
  });

  it('the worker stop hook (supervisor shutdown) aborts the in-flight run as shutdown', async () => {
    let env;
    env = F.mkEnv({ reason: async () => { env.supervisor.stop('autopilot'); return { ok: false, error: 'aborted' }; } });
    env.ap.boot();
    await env.supervisor.runTick();
    expect(only().state).toBe('QUEUED');
  });
});

describe('master OFF and supervisor disabled (AC-18, AC-19)', () => {
  for (const [name, opts] of [['settings enabled:false', { autopilot: { enabled: false } }], ['FLEET_AUTOPILOT=0', { env: { FLEET_AUTOPILOT: '0' } }]]) {
    it(name + ' -> no worker registered and zero ap_* SQL at boot, status and list', async () => {
      const prep = vi.spyOn(F.engine, 'prepare');
      const exec = vi.spyOn(F.engine, 'exec');
      const env = F.mkEnv(opts);
      expect(env.ap.boot()).toEqual({ registered: false });
      const st = env.ap.status();
      expect(st).toMatchObject({ ok: true, enabled: false });
      expect(env.ap.listCases({})).toEqual({ ok: true, enabled: false, total: 0, items: [] });
      expect(await env.ap.control('run-now')).toEqual({ ok: false, code: 'DISABLED' });
      expect(await env.ap.control('resume')).toEqual({ ok: false, code: 'DISABLED' });
      expect(env.supervisor.registerCalls).toBe(0);
      expect(apSql(prep)).toEqual([]);
      expect(apSql(exec)).toEqual([]);
    });
  }

  it('supervisor disabled -> status supervisor_disabled, run-now / harness-run SUPERVISOR_DISABLED with zero ap_* SQL', async () => {
    const prep = vi.spyOn(F.engine, 'prepare');
    const exec = vi.spyOn(F.engine, 'exec');
    const env = F.mkEnv({ supervisorEnabled: false, env: { FLEET_WORKERS: '0' } });
    expect(env.ap.boot()).toEqual({ registered: false });
    const st = env.ap.status();
    expect(st).toMatchObject({ enabled: true, worker: 'supervisor_disabled', supervisorEnabled: false, supervisorEnvOverride: '0' });
    expect(st.scope.unitsNotInFleet).toContain('321185');   // R14
    expect(await env.ap.control('run-now')).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    expect(await env.ap.harnessRun({ runs: 24 })).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    expect(await env.ap.control('resume')).toEqual({ ok: true, runState: 'running', worker: 'supervisor_disabled' });
    expect(apSql(prep)).toEqual([]);
    expect(apSql(exec)).toEqual([]);
  });

  it('enable-supervisor sets only workers.supervisor.enabled and reports restartRequired', async () => {
    const settings = F.settingsStore({ autopilot: { oosDays: 4 }, workers: { supervisor: { maxRestarts: 2 }, repairIntel: { supervised: false } }, theme: 'dark', jobs: { durable: { enabled: false } } });
    const before = JSON.parse(JSON.stringify(settings.doc));
    const env = F.mkEnv({ supervisorEnabled: false, settings });
    expect(await env.ap.control('enable-supervisor')).toEqual({ ok: true, restartRequired: true });
    const after = JSON.parse(JSON.stringify(settings.doc));
    expect(after.workers.supervisor).toEqual({ maxRestarts: 2, enabled: true });
    delete after.workers.supervisor.enabled;
    expect(after).toEqual(before);
  });

  it('harnessRun with the supervisor on returns UNAVAILABLE until harness.js exists (R5)', async () => {
    const env = F.mkEnv();
    const fs = require('fs');
    const path = require('path');
    if (fs.existsSync(path.join(__dirname, '..', 'src', 'autopilot', 'harness.js'))) return;
    expect(await env.ap.harnessRun({ runs: 24 })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('status with the supervisor on reports counts, AI usage and the worker row', async () => {
    const env = F.mkEnv();
    env.ap.boot();
    await env.supervisor.runTick();
    const st = env.ap.status();
    expect(st.worker).toMatchObject({ name: 'autopilot' });
    expect(st.counts.open).toBe(1);
    expect(st.ai).toMatchObject({ today: 1, cap: 48, outcomes: { ok: 1 }, lanes: { isolated: 1 }, isolatedAvailable: true, cost: 'not reported by AI lanes' });
    expect(st.supervisorEnvOverride).toBe(null);
    expect(st.lastTick.outcome).toBe('ok');
  });

  it('status surfaces the schema degraded code (migration_backup_failed) when ensureSchema fails', () => {
    const schemaMod = require('../src/autopilot/schema');
    const env = F.mkEnv();
    vi.spyOn(schemaMod, 'isEnsured').mockReturnValue(false);
    vi.spyOn(schemaMod, 'ensureSchema').mockReturnValue(false);
    const ss = vi.spyOn(schemaMod, 'status').mockReturnValue({ version: 1, degradedCode: 'migration_backup_failed', backup: { ms: 1, ok: false } });
    expect(env.ap.status().degraded).toBe('migration_backup_failed');
    ss.mockReturnValue({ version: null, degradedCode: null, backup: null });
    expect(env.ap.status().degraded).toBe('storage_unavailable');
  });
});

describe('AC-21: full controller run over the real ports object', () => {
  it('expired Aperia token, old DTNA context, cold AAP page and cold Decisiv window -> zero sign-in / window calls', async () => {
    const spies = {
      dtnaBackgroundLogin: vi.fn(), dtnaEnsureContext: vi.fn(), aperiaReauth: vi.fn(), aperiaBackgroundLogin: vi.fn(),
      aapGetService: vi.fn(), openPage: vi.fn(), decisivGetCaseStatus: vi.fn(), BrowserWindow: vi.fn(),
    };
    const world = F.mkWorld();
    world.rows[0] = F.baseRow({ decisivCaseId: '21350186', asistSrUrl: F.SR, issueSummary: 'tire damage' });
    const fakeStore = { load: (k, fb) => (k === 'fleetData' ? { rows: world.rows, syncedAt: world.syncedAt, source: 'aap-api' } : (world.docs[k] ?? fb)), generation: () => 0 };
    const ports = portsMod.create({
      liveReads: true,
      store: fakeStore,
      fleetFreshness: { evaluate: () => ({ level: 'green', reasons: [], intervalMs: 600000 }), getSnapshot: () => ({ lastOkAt: world.lastOkAt }), RED_AGE_FACTOR: 3 },
      canonicalState: { getCanonical: () => null, isDown: (r) => /unavail/i.test(r.lifecycleState) },
      riStore: { eventsForUnit: () => [], getAiAnalysis: () => null },
      riTrends: { repeatOffenders: () => ({ offenders: [] }) },
      vendorNetwork: { vendorScorecards: () => [] },
      taxonomy: { downCause: () => null },
      slackSearch: { searchSlack: () => ({ ok: true, results: [] }) },
      dtnaStore: { findByUnit: () => [{ caseId: 'c1', unitId: '322283', offsiteStage: 'repair', pulledAt: new Date(F.T0 - 2 * H).toISOString() }] },
      dtnaSession: { status: () => ({ state: 'stale', capturedAt: F.T0 - 2 * H }), backgroundLogin: spies.dtnaBackgroundLogin, ensureContext: spies.dtnaEnsureContext },
      aapApi: { isWarm: () => false, getServiceIfWarm: async () => { throw Object.assign(new Error('cold'), { code: 'AAP_NOT_WARM' }); }, getService: spies.aapGetService, _ensureWindow: spies.openPage },
      decisivApi: { isWarm: () => false, getCaseStatusSummaryIfWarm: async () => ({ ok: false, code: 'DECISIV_NOT_WARM' }), getActivityLogsIfWarm: async () => { throw Object.assign(new Error('cold'), { code: 'DECISIV_NOT_WARM' }); }, formatActivityLogs: () => ({ text: '' }), getCaseStatusSummary: spies.decisivGetCaseStatus, BrowserWindow: spies.BrowserWindow },
      aperiaSyncRead: { cached: () => ({ pulledAt: new Date(F.T0 - H).toISOString(), issues: [] }) },
      aperiaSession: { status: () => ({ state: 'expired', actionNeeded: true }), reauth: spies.aperiaReauth, backgroundLogin: spies.aperiaBackgroundLogin },
      midway: { getState: () => 'HEALTHY' },
      cluster: { mayLivePull: () => true },
      offline: { isOffline: () => false },
      relay: { queueStats: () => world.aiQueue, getStatus: () => world.aiStatus, isolatedLaneAvailable: () => true },
      offsiteOwner: { offsiteUrlOf: () => null },
    });
    const env = F.mkEnv({ world, ports });
    env.ap.boot();
    const r = await env.supervisor.runTick();
    expect(r.investigated[0]).toMatchObject({ ok: true });
    for (const [k, fn] of Object.entries(spies)) expect(fn, k).not.toHaveBeenCalled();
    const plan = Object.fromEntries(F.cs.getCase(only().case_id).runs[0].plan.map((p) => [p.source, p.status]));
    expect(plan).toMatchObject({ aap_live: 'cache_only:not_warm', decisiv: 'cache_only:not_warm', dtna: 'cache_only:live_disabled_v1', aperia_cache: 'cache_only:live_disabled_v1' });
    expect(env.notifications.length).toBe(1);   // Aperia actionNeeded -> one local notification
  });
});
