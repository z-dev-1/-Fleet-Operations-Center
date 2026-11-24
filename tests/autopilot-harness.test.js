// tests/autopilot-harness.test.js — fleet-autopilot §B17 in-app harness (src/autopilot/harness.js,
// plan R5, R14): once per local day, BUSY under the shared mutex, SUPERVISOR_DISABLED / DISABLED /
// NOT_RUNNING before any ap_* SQL, round-robin over the real open cases with trigger 'harness'
// (not limited by the 6/day automatic cap), dailyCap accounting through
// reserveAiCallAndMarkPending, per-tick live cap and per-source buckets, outbound snapshots, and a
// report written only as autopilot-harness-*.json directly under the tmp data dir.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 60000 });
const F = require('./helpers/autopilot-fakes.cjs');
const harness = require('../src/autopilot/harness');
const { getDataDir } = require('../src/config/paths');

const { H, DAY } = F;
const UNITS = ['322283', '321185', 'B13014'];
const apSql = (spy) => spy.mock.calls.map((c) => String(c[0])).filter((q) => /\bap_/.test(q));

let dir;
beforeEach(() => { vi.restoreAllMocks(); dir = F.freshDb('harness'); });

function world(over) {
  return F.mkWorld(Object.assign({
    rows: UNITS.map((u, i) => F.baseRow({ equipmentId: u, domicileSite: u === 'B13014' ? 'ROC5' : 'ABE40', _serviceId: 'svc-' + i, workRequestId: 'wr-' + i })),
  }, over || {}));
}
function seedOutbound() {
  const files = harness.OUTBOUND_FILES;
  fs.writeFileSync(path.join(dir, files.relayWritesPending), JSON.stringify({ items: [{ id: 'w1' }] }));
  fs.writeFileSync(path.join(dir, files.fasApprovalQueue), JSON.stringify({ items: [] }));
  fs.writeFileSync(path.join(dir, files.emailIntelSends), JSON.stringify({ sent: [1] }));
  fs.writeFileSync(path.join(dir, files.slackDMReplies), JSON.stringify({ replies: [] }));
}
const runsOf = (caseId) => F.cs.getCase(caseId).runs;
const harnessRuns = () => F.engine.prepare("SELECT case_id, trigger FROM ap_run WHERE trigger = 'harness'").all();

describe('in-app harness', () => {
  it('3 open cases, runs = 24 -> 24 runs (not limited by 6/day), per-case counts, outbound unchanged, one report file under the data dir', async () => {
    const env = F.mkEnv({ world: world(), autopilot: { maxCasesPerTick: 5 } });
    env.ap.boot();
    await env.supervisor.runTick();
    expect(F.cs.listOpen().length).toBe(3);
    seedOutbound();
    const filesBefore = new Set(fs.readdirSync(dir));
    const aiBefore = env.reason.calls.length;

    const r = await env.ap.harnessRun({ runs: 24 });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ runsDone: 24, cases: 3, outboundUnchanged: true });
    expect(harnessRuns().length).toBe(24);
    const per = {};
    for (const x of harnessRuns()) per[x.case_id] = (per[x.case_id] || 0) + 1;
    expect(Object.values(per)).toEqual([8, 8, 8]);   // > 6 per case per day: the harness is exempt

    const added = fs.readdirSync(dir).filter((f) => !filesBefore.has(f) && !/\.sqlite(-wal|-shm|-journal)?$/.test(f));
    expect(added.length).toBe(1);
    expect(added[0]).toMatch(/^autopilot-harness-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    expect(path.dirname(r.reportPath)).toBe(getDataDir());
    expect(path.basename(r.reportPath)).toBe(added[0]);

    const rep = JSON.parse(fs.readFileSync(r.reportPath, 'utf8'));
    expect(rep).toMatchObject({ kind: 'autopilot-harness', mode: 'in-app', runsRequested: 24, runsDone: 24, outboundUnchanged: true });
    expect(rep.cases.map((c) => c.runs)).toEqual([8, 8, 8]);
    for (const k of Object.keys(harness.OUTBOUND_FILES)) expect(rep.outboundBefore[k]).toBeTruthy();
    expect(rep.outboundAfter).toEqual(rep.outboundBefore);
    for (const k of ['heapUsedMbBefore', 'heapUsedMbAfter', 'rssMbBefore', 'rssMbAfter', 'heapDeltaMb']) expect(Number.isFinite(rep[k]), k).toBe(true);
    expect(rep.runs.length).toBe(24);
    for (const e of rep.runs) {
      for (const k of ['unit', 'reasons', 'plan', 'sourceStatus', 'state', 'aiStatus', 'isolated', 'validationWarnings', 'latencyMs', 'cpuMs']) expect(e, k).toHaveProperty(k);
      expect(UNITS).toContain(e.unit);
    }
    // Unchanged evidence that the AI already saw: repeats cost no AI call.
    expect(env.reason.calls.length).toBe(aiBefore);
    expect(rep.aiCallsUsed).toBe(0);
    // R14: the default allowlist entries that have no fleet row.
    expect(rep.unitsNotInFleet).toEqual(expect.arrayContaining(['FLD260703', 'IND260261', '9010424']));
    expect(rep.unitsNotInFleet).not.toContain('322283');
    expect(env.ap.status().harnessRanToday).toBe(true);
  });

  it('a second run on the same local day -> HARNESS_ALREADY_RAN; the next local day is allowed', async () => {
    const env = F.mkEnv({ world: world() });
    await env.ctl.runOnce();
    expect((await env.ap.harnessRun({ runs: 20 })).ok).toBe(true);
    const n = harnessRuns().length;
    expect(await env.ap.harnessRun({ runs: 20 })).toEqual({ ok: false, code: 'HARNESS_ALREADY_RAN' });
    expect(harnessRuns().length).toBe(n);
    env.clock.advance(DAY);
    expect((await env.ap.harnessRun({ runs: 20 })).ok).toBe(true);
  });

  it('a run during a tick -> BUSY', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const base = F.okReason();
    const env = F.mkEnv({ world: world(), reason: async (o) => { await gate; return base(o); } });
    const tick = env.ctl.runOnce();
    await new Promise((r) => setTimeout(r, 20));
    expect(env.ctl.isRunning()).toBe(true);
    expect(await env.ap.harnessRun({ runs: 24 })).toEqual({ ok: false, code: 'BUSY' });
    release();
    await tick;
    expect(harnessRuns().length).toBe(0);
  });

  it('AI calls count against dailyCap via reserveAiCallAndMarkPending; the remaining runs use the fallback', async () => {
    const env = F.mkEnv({ world: world(), autopilot: { dailyCap: 2 } });
    F.schema.ensureSchema();
    const reserve = vi.spyOn(F.cs, 'reserveAiCallAndMarkPending');
    for (const u of UNITS) F.seedCase(u, { domicile: u === 'B13014' ? 'ROC5' : 'ABE40' });
    const r = await env.ap.harnessRun({ runs: 20 });
    expect(r.ok).toBe(true);
    expect(env.reason.calls.length).toBe(2);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(reserve.mock.calls.every((c) => c[2] === 2)).toBe(true);
    const rep = JSON.parse(fs.readFileSync(r.reportPath, 'utf8'));
    expect(rep).toMatchObject({ aiCallsUsed: 2, aiCap: 2, capReached: true });
    expect(rep.runs.filter((e) => e.aiStatus === 'skipped_cap').length).toBe(1);
    expect(r.summary.capReached).toBe(true);
    expect(F.cs.getMeta('ai_calls:' + require('../src/autopilot/constants').localDate(env.clock.now()))).toBe('2');
  });

  it('per-source buckets and the per-tick live cap apply (the harness counts as one tick)', async () => {
    const w = world({ aapWarm: true, aapLive: (id) => ({ ok: true, value: { workRequest: { id, assetDisplayName: '322283', lifecycleState: 'Unavailable' } } }) });
    const env = F.mkEnv({ world: w, autopilot: { maxCasesPerTick: 5 } });
    await env.ctl.runOnce();
    w.calls.aapLive = 0;
    const r = await env.ap.harnessRun({ runs: 24 });
    expect(r.ok).toBe(true);
    expect(w.calls.aapLive).toBeGreaterThan(0);
    expect(w.calls.aapLive).toBeLessThanOrEqual(6);
    const snap = env.ctl.limiter.snapshot();
    expect(snap).toBeTruthy();
    const rep = JSON.parse(fs.readFileSync(r.reportPath, 'utf8'));
    expect(rep.runs.some((e) => e.plan && e.plan.some((p) => p.source === 'aap_live' && /budget/.test(String(p.status) + String(p.why))))).toBe(true);
  });

  it('SUPERVISOR_DISABLED, DISABLED, NOT_RUNNING and INVALID_INPUT are answered before any ap_* SQL', async () => {
    const prep = vi.spyOn(F.engine, 'prepare');
    const exec = vi.spyOn(F.engine, 'exec');
    const cfg = F.cfgOf();
    const stub = { withMutex: vi.fn(), ensureSchema: vi.fn() };
    const base = { runInvestigation: vi.fn(), controller: stub, caseStore: F.cs, now: () => F.T0 };
    expect(await harness.run(Object.assign({}, base, { config: cfg, supervisorEnabled: () => false }))).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    expect(await harness.run(Object.assign({}, base, { config: Object.assign({}, cfg, { enabled: false }), supervisorEnabled: () => true }))).toEqual({ ok: false, code: 'DISABLED' });
    expect(await harness.run(Object.assign({}, base, { config: Object.assign({}, cfg, { runState: 'paused' }), supervisorEnabled: () => true }))).toEqual({ ok: false, code: 'NOT_RUNNING' });
    for (const runs of [19, 31, 2.5]) {
      expect(await harness.run(Object.assign({}, base, { config: cfg, supervisorEnabled: () => true, runs }))).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'runs' });
    }
    expect(stub.withMutex).not.toHaveBeenCalled();
    expect(base.runInvestigation).not.toHaveBeenCalled();
    expect(apSql(prep)).toEqual([]);
    expect(apSql(exec)).toEqual([]);
  });

  it('PAUSED cases are not re-run; with no eligible case the harness writes an empty report', async () => {
    const env = F.mkEnv({ world: world() });
    await env.ctl.runOnce();
    expect((await env.ap.control('pause')).ok).toBe(true);
    expect(await env.ap.harnessRun({ runs: 24 })).toEqual({ ok: false, code: 'NOT_RUNNING' });
    expect((await env.ap.control('resume')).ok).toBe(true);
    const ids = F.cs.listOpen().map((c) => c.case_id);
    F.cs.pauseCases(ids, 'out_of_scope', { now: env.clock.now() });
    const r = await env.ap.harnessRun({ runs: 24 });
    expect(r.ok).toBe(true);
    expect(r.summary.runsDone).toBe(0);
    for (const id of ids) expect(F.cs.getCase(id).case.state).toBe('PAUSED');
  });
});

describe('master controls during a harness run (AC-14)', () => {
  const waitFor = async (cond) => {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };
  const ACTIONS = [
    ['PAUSE', (env) => env.ap.control('pause'), 'master_pause'],
    ['STOP', (env) => env.ap.control('stop'), 'master_stop'],
    ['master OFF', (env) => env.ap.setConfig({ enabled: false }), 'master_stop'],
  ];
  for (const [name, act, why] of ACTIONS) {
    it(name + ' mid-harness -> the in-flight case ends PAUSED; no further runs, live reads or AI calls', async () => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const base = F.okReason();
      let aiCalls = 0;
      const w = world({ aapWarm: true, aapLive: (id) => ({ ok: true, value: { workRequest: { id, assetDisplayName: '322283', lifecycleState: 'Unavailable' } } }) });
      const env = F.mkEnv({ world: w, reason: async (o) => { aiCalls++; if (aiCalls === 1) await gate; return base(o); } });
      F.schema.ensureSchema();
      for (const u of UNITS) F.seedCase(u, { domicile: u === 'B13014' ? 'ROC5' : 'ABE40' });
      const p = env.ap.harnessRun({ runs: 20 });
      await waitFor(() => aiCalls === 1);
      const live0 = w.calls.aapLive;
      const res = await act(env);
      expect(res.ok).toBe(true);
      release();
      const r = await p;
      expect(r.ok).toBe(true);
      expect(r.summary.runsDone).toBe(1);
      expect(r.summary.stoppedBy).toBe('aborted:' + why);
      expect(aiCalls).toBe(1);
      expect(w.calls.aapLive).toBe(live0);
      expect(harnessRuns().length).toBe(1);
      const paused = F.cs.listOpen().filter((c) => c.state === 'PAUSED');
      expect(paused.length).toBe(1);
      expect(paused[0].pause_reason).toBe(why);
      expect(env.ctl.isRunning()).toBe(false);
      // The controller's in-flight slot is released: a later abort finds nothing to abort.
      expect(env.ctl.abortInFlight('shutdown')).toBe(false);
    });
  }

  it('settings are re-read before every run: a run-state change between runs stops the loop', async () => {
    const env = F.mkEnv({ world: world() });
    F.schema.ensureSchema();
    for (const u of UNITS) F.seedCase(u, { domicile: u === 'B13014' ? 'ROC5' : 'ABE40' });
    let n = 0;
    const r = await harness.run({
      runs: 20, config: F.cfgOf(), supervisorEnabled: () => true, caseStore: F.cs, now: env.clock.now, reason: env.reason,
      controller: { withMutex: env.ctl.withMutex, ensureSchema: env.ctl.ensureSchema, ports: env.ctl.ports, limiter: env.ctl.limiter, owner: env.ctl.owner },
      loadConfig: () => F.cfgOf(n >= 2 ? { runState: 'paused' } : {}),
      runInvestigation: async (caseId, deps) => { n++; return env.ctl.runInvestigation(caseId, deps); },
    });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(r.summary).toMatchObject({ runsDone: 2, stoppedBy: 'run_state:paused' });
  });

  it('NEEDS_REVIEW cases are not re-run by the harness', async () => {
    const env = F.mkEnv({ world: world(), autopilot: { maxCasesPerTick: 5 } });
    await env.ctl.runOnce();
    const open = F.cs.listOpen();
    expect(open.length).toBe(3);
    const target = open[0].case_id;
    F.cs.transition(target, 'NEEDS_REVIEW', { reason: 'authority_tie', now: env.clock.now() });
    const r = await env.ap.harnessRun({ runs: 20 });
    expect(r.ok).toBe(true);
    expect(harnessRuns().filter((x) => x.case_id === target).length).toBe(0);
    expect(harnessRuns().length).toBe(20);
    expect(F.cs.getCase(target).case.state).toBe('NEEDS_REVIEW');
  });
});

describe('R5 boundary', () => {
  it('harness.js requires neither ./investigate nor ./controller; index.js injects them', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'harness.js'), 'utf8');
    expect(src).not.toMatch(/require\(\s*['"]\.\/(investigate|controller|ports)['"]\s*\)/);
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'autopilot', 'index.js'), 'utf8');
    expect(idx).toMatch(/harness\.run\(/);
    expect(idx).toMatch(/runInvestigation,/);
  });

  it('snapshotOutbound reads null for missing files and hashes present ones (read only)', () => {
    const s0 = harness.snapshotOutbound(dir);
    expect(Object.values(s0).every((v) => v === null)).toBe(true);
    seedOutbound();
    const s1 = harness.snapshotOutbound(dir);
    for (const v of Object.values(s1)) expect(v).toMatchObject({ bytes: expect.any(Number), sha1: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(harness.snapshotOutbound(dir)).toEqual(s1);
  });
});
