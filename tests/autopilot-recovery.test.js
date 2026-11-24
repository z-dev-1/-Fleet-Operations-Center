// tests/autopilot-recovery.test.js — fleet-autopilot §B8 checkpoints and §B10.2 step 3 boot
// recovery (AC-11, plan R10). A "crash" is simulated with a case-store wrapper whose writes all
// throw from a chosen point on, so the case stays leased in INVESTIGATING / ANALYZING with an
// open run, exactly as a killed process leaves it. "Restart" = recoverAbandoned with a new owner.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });   // multi-tick integration tests; the CI host can be loaded
const F = require('./helpers/autopilot-fakes.cjs');
const { runInvestigation } = require('../src/autopilot/investigate');
const { createLimiter } = require('../src/autopilot/limiter');
const { localDate } = require('../src/autopilot/constants');
const jobs = require('../src/jobs');

const { H, MIN } = F;
const WRITES = ['upsertDetected', 'transition', 'persistRun', 'reserveAiCallAndMarkPending', 'sweepResolution', 'pauseCases', 'requeueCases',
  'lease', 'openRun', 'writeCheckpoint', 'writeFindings', 'copyRunForResume', 'recoverAbandoned', 'prune', 'review', 'bumpCounter', 'setMeta', 'appendEvent'];

function crashable(base) {
  let crashed = false;
  let trap = null;
  const p = Object.assign({}, base);
  for (const k of WRITES) {
    p[k] = (...a) => {
      if (crashed) throw new Error('CRASHED');
      if (trap && trap(k, a)) { crashed = true; throw new Error('CRASHED'); }
      return base[k](...a);
    };
  }
  return { cs: p, at(fn) { trap = fn; }, crashNow() { crashed = true; } };
}

let s;
function setup() {
  F.freshDb('rec');
  F.schema.ensureSchema();
  const ck = F.clock();
  const world = F.mkWorld();
  s = { ck, world, ports: F.fakePorts(world), reason: F.okReason() };
}
const inv = (caseId, o) => runInvestigation(caseId, Object.assign({
  ports: s.ports, cfg: F.cfgOf((o && o.cfgOver) || {}), now: s.ck.now, rand: () => 0.5, owner: 'own-1', reason: s.reason,
  limiter: createLimiter({ now: s.ck.now, random: () => 0 }), trigger: 'new', caseStore: F.cs,
}, o || {}));
const restart = (owner) => F.cs.recoverAbandoned({ owner: owner || 'own-2', now: s.ck.now(), rand: () => 0.5 });
const caseOf = (id) => F.cs.getCase(id).case;
const runs = (id) => F.cs.getCase(id).runs;

beforeEach(() => setup());
afterEach(() => { jobs._resetForTests(); });

describe('resume from checkpoints (FR-5.3, AC-11)', () => {
  it('crash after evidence_done -> QUEUED attempt+1, resume copies findings, plan and source calls, no re-collection', async () => {
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    c.at((k, a) => k === 'transition' && a[1] === 'ANALYZING');
    const r1 = await inv(caseId, { caseStore: c.cs });
    expect(r1.ok).toBe(false);
    expect(caseOf(caseId).state).toBe('INVESTIGATING');
    const first = runs(caseId)[0];
    expect(first.checkpoint.step).toBe('evidence_done');
    const nFindings = F.cs.findingsForRun(first.run_id).length;

    const rec = restart();
    expect(rec.requeued).toEqual([caseId]);
    expect(caseOf(caseId)).toMatchObject({ state: 'QUEUED', attempts: 1, next_attempt_at: s.ck.now() + 5 * MIN });
    expect(F.cs.getRun(first.run_id).outcome).toBe('abandoned');

    s.ck.advance(6 * MIN);
    const slack = s.world.calls.slack;
    const r2 = await inv(caseId, { owner: 'own-2', trigger: 'recovered' });
    expect(r2).toMatchObject({ ok: true, state: 'RECOMMENDATION_READY', aiStatus: 'ok' });
    expect(s.world.calls.slack).toBe(slack);
    const second = runs(caseId)[0];
    expect(second.resumed_from).toBe(first.run_id);
    expect(F.cs.findingsForRun(second.run_id).length).toBe(nFindings);
    expect(Array.isArray(second.plan) && second.plan.length > 0).toBe(true);           // R10
    expect(second.source_calls && typeof second.source_calls).toBe('object');           // R10
    expect(F.cs.getCase(caseId).events.some((e) => e.kind === 'resumed')).toBe(true);
    expect(caseOf(caseId).attempts).toBe(0);
  });

  it('crash after ai_pending -> resumed run makes no AI call (interrupted), ai_fp unchanged; the next scheduled run calls the AI once', async () => {
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    s.reason = async () => { c.crashNow(); return { ok: true, data: { schemaVersion: 1 } }; };
    await inv(caseId, { caseStore: c.cs });
    expect(caseOf(caseId).state).toBe('ANALYZING');
    expect(runs(caseId)[0].checkpoint.step).toBe('ai_pending');
    expect(F.cs.getMeta('ai_calls:' + localDate(s.ck.now()))).toBe('1');

    restart();
    s.ck.advance(6 * MIN);
    s.reason = F.okReason();
    const r = await inv(caseId, { owner: 'own-2', trigger: 'recovered' });
    expect(r.aiStatus).toBe('interrupted');
    expect(s.reason.calls.length).toBe(0);
    const k = caseOf(caseId);
    expect(k.ai_fp).toBe(null);
    expect(k.ai_retry_at).toBeGreaterThan(s.ck.now());
    expect(k.ai_findings.generatedBy).toBe('deterministic');

    s.ck.advance(2 * H);
    F.cs.requeueCases({ caseIds: [caseId], trigger: 'scheduled', now: s.ck.now() });
    const r2 = await inv(caseId, { owner: 'own-2', trigger: 'scheduled' });
    expect(r2.aiStatus).toBe('ok');
    expect(s.reason.calls.length).toBe(1);
  });

  it('crash after analysis_done -> resumed run persists the stored output without an AI call', async () => {
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    c.at((k) => k === 'persistRun');
    await inv(caseId, { caseStore: c.cs });
    expect(runs(caseId)[0].checkpoint.step).toBe('analysis_done');
    expect(s.reason.calls.length).toBe(1);
    restart();
    s.ck.advance(6 * MIN);
    const r = await inv(caseId, { owner: 'own-2', trigger: 'recovered' });
    expect(r).toMatchObject({ ok: true, state: 'RECOMMENDATION_READY', aiStatus: 'ok' });
    expect(s.reason.calls.length).toBe(1);
    expect(caseOf(caseId).ai_findings.generatedBy).toBe('ai');
  });

  it('a checkpoint older than 30 min is not resumed: evidence is collected again', async () => {
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    c.at((k, a) => k === 'transition' && a[1] === 'ANALYZING');
    await inv(caseId, { caseStore: c.cs });
    restart();
    s.ck.advance(31 * MIN);
    const slack = s.world.calls.slack;
    await inv(caseId, { owner: 'own-2' });
    expect(s.world.calls.slack).toBe(slack + 1);
    expect(runs(caseId)[0].resumed_from).toBe(null);
  });
});

describe('durable jobs', () => {
  it('jobs off -> NOOP handle, ap_run still checkpoints; jobs on -> one completed autopilotInvestigate job', async () => {
    const a = F.seedCase();
    await inv(a.caseId);
    expect(runs(a.caseId)[0].job_id).toBe(null);

    setup();
    jobs._resetForTests({ flags: { enabled: true, types: { autopilotInvestigate: true } } });
    expect(jobs.init().mode).toBe('active');
    const b = F.seedCase();
    await inv(b.caseId);
    const rows = F.engine.getDb().prepare("SELECT type, scope_key, state FROM jobs WHERE type = 'autopilotInvestigate'").all();
    expect(rows).toEqual([{ type: 'autopilotInvestigate', scope_key: 'case:' + b.caseId, state: 'completed' }]);
    expect(runs(b.caseId)[0].job_id).toBeTruthy();
  });
});

describe('retries and aborts', () => {
  it('3 unexpected failures -> QUEUED with 5 / 15 min backoff, then FAILED', async () => {
    const { caseId } = F.seedCase();
    const bad = Object.assign({}, F.cs, { writeFindings: () => { throw Object.assign(new Error('boom'), { code: 'BOOM' }); } });
    let r = await inv(caseId, { caseStore: bad });
    expect(r.state).toBe('QUEUED');
    expect(caseOf(caseId)).toMatchObject({ attempts: 1, last_error_code: 'BOOM', next_attempt_at: s.ck.now() + 5 * MIN });
    s.ck.advance(5 * MIN);
    r = await inv(caseId, { caseStore: bad });
    expect(caseOf(caseId)).toMatchObject({ attempts: 2, next_attempt_at: s.ck.now() + 15 * MIN });
    s.ck.advance(15 * MIN);
    r = await inv(caseId, { caseStore: bad });
    expect(r.state).toBe('FAILED');
    expect(F.cs.getCase(caseId).events.some((e) => e.kind === 'error' && e.reason_code === 'BOOM')).toBe(true);
  });

  it('shutdown abort -> QUEUED (never PAUSED); master_pause -> PAUSED master_pause', async () => {
    for (const [why, state] of [['shutdown', 'QUEUED'], ['budget', 'QUEUED'], ['master_pause', 'PAUSED'], ['master_stop', 'PAUSED']]) {
      setup();
      const ac = new AbortController();
      s.reason = async () => { ac.abort(why); return { ok: false, error: 'aborted' }; };
      const { caseId } = F.seedCase();
      const r = await inv(caseId, { signal: ac.signal });
      expect(r.state, why).toBe(state);
      const k = caseOf(caseId);
      expect(k.attempts).toBe(0);
      expect(k.pause_reason).toBe(state === 'PAUSED' ? why : null);
    }
  });

  it('three crashes on one case -> 5 then 15 min backoff, then FAILED crash_loop, while another case still runs', async () => {
    s.world.rows.push(F.baseRow({ equipmentId: '321185', _serviceId: 'svc-2', workRequestId: 'wr-2' }));
    const a = F.seedCase('322283');
    const b = F.seedCase('321185');
    const crashA = () => { const c = crashable(F.cs); c.at((k, args) => k === 'transition' && args[0] === a.caseId && args[1] === 'ANALYZING'); return c.cs; };

    await inv(a.caseId, { caseStore: crashA() });
    restart('own-2');
    expect(caseOf(a.caseId)).toMatchObject({ state: 'QUEUED', attempts: 1, next_attempt_at: s.ck.now() + 5 * MIN });
    const due = F.cs.pickQueued(1, s.ck.now());
    expect(due.map((x) => x.case_id)).toEqual([b.caseId]);
    expect((await inv(b.caseId, { owner: 'own-2' })).ok).toBe(true);

    s.ck.advance(5 * MIN);
    await inv(a.caseId, { caseStore: crashA(), owner: 'own-2' });
    restart('own-3');
    expect(caseOf(a.caseId)).toMatchObject({ state: 'QUEUED', attempts: 2, next_attempt_at: s.ck.now() + 15 * MIN });

    s.ck.advance(15 * MIN);
    await inv(a.caseId, { caseStore: crashA(), owner: 'own-3' });
    const rec = restart('own-4');
    expect(rec.failed).toEqual([a.caseId]);
    expect(caseOf(a.caseId)).toMatchObject({ state: 'FAILED', last_error_code: 'crash_loop' });
    expect(caseOf(b.caseId).state).toBe('RECOMMENDATION_READY');
  });

  it('daily cap reached -> skipped_cap; after local midnight the scheduled review calls the AI exactly once on unchanged evidence', async () => {
    const { caseId } = F.seedCase();
    F.cs.setMeta('ai_calls:' + localDate(s.ck.now()), 1);
    const r = await inv(caseId, { cfgOver: { dailyCap: 1 } });
    expect(r.aiStatus).toBe('skipped_cap');
    const fp = caseOf(caseId).evidence_fp;
    s.ck.t = new Date(2026, 10, 21, 0, 30).getTime();   // 00:30 local, next day
    expect(localDate(s.ck.now())).toBe('2026-11-21');
    F.cs.requeueCases({ caseIds: [caseId], trigger: 'scheduled', now: s.ck.now() });
    const r2 = await inv(caseId, { cfgOver: { dailyCap: 1 }, trigger: 'scheduled' });
    expect(r2.aiStatus).toBe('ok');
    expect(s.reason.calls.length).toBe(1);
    expect(caseOf(caseId).evidence_fp).toBe(fp);
    expect(F.cs.getMeta('ai_calls:2026-11-21')).toBe('1');
  });
});
