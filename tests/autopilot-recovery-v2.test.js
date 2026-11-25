// tests/autopilot-recovery-v2.test.js — Autopilot V2 multi-turn recovery and leases through
// runInvestigation (AC-13, AC-14, AC-15; design §5.4, §6.3, §7.1 steps 1-2, review findings 10, 11).
// A "crash" is a case-store wrapper whose writes all throw from a chosen point on, so the case
// stays leased in ANALYZING with an open run and pending steps, as a killed process leaves it.
// "Restart" = recoverAbandoned with a new owner.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });
const F = require('./helpers/autopilot-fakes.cjs');
const { runInvestigation } = require('../src/autopilot/investigate');
const { createLimiter } = require('../src/autopilot/limiter');
const jobs = require('../src/jobs');

const { H, MIN } = F;
const U = '322283';
const WRITES = ['upsertDetected', 'transition', 'persistRun', 'reserveAiCallAndMarkPending', 'sweepResolution', 'pauseCases', 'requeueCases',
  'lease', 'openRun', 'closeRun', 'writeCheckpoint', 'writeFindings', 'copyRunForResume', 'recoverAbandoned', 'prune', 'review', 'bumpCounter',
  'setMeta', 'appendEvent', 'applyPass', 'promoteDetected', 'leaseRun', 'renewLease', 'beginStep', 'reserveAiTurn', 'completeStep', 'writeMemory',
  'requestDeep', 'setSliceBaseline', 'releaseAiDeferred'];

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
function setup(over) {
  F.freshDb('recv2');
  F.schema.ensureSchema();
  const ck = F.clock();
  const row = F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186', fullConversation: '10/01 - Vendor: old note' });
  const world = F.mkWorld(Object.assign({
    rows: [row], isolated: true,
    dtna: { [U]: [{ caseId: 'C1', unitId: U, offsiteStage: 'repair', stageSince: '2026-11-18T00:00:00Z', repairEtc: '2026-11-25' }] },
    decisivStatus: () => ({ ok: true, value: { stage: 'ready', status: 'open' } }),
  }, over || {}));
  world.docs.decisivCaseCache = { 21350186: { estimateId: '21350186', stage: 'repair', scrapedAt: new Date(F.T0 - 24 * H).toISOString() } };
  s = { ck, world, ports: F.fakePorts(world) };
}
const inv = (caseId, o) => runInvestigation(caseId, Object.assign({
  ports: s.ports, cfg: F.cfgOf({ features: { liveReads: true, multiTurn: true } }), now: s.ck.now, rand: () => 0.5, owner: 'own-1',
  limiter: createLimiter({ now: s.ck.now, random: () => 0 }), trigger: 'new', caseStore: F.cs,
}, o || {}));
const restart = (owner) => F.cs.recoverAbandoned({ owner: owner || 'own-2', now: s.ck.now(), rand: () => 0.5 });
const caseOf = (id) => F.cs.getCase(id).case;
const runs = (id) => F.cs.getCase(id).runs;
const turn = (tools, memory) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: memory || {} });
const tool = (name, args) => ({ tool: name, args: Object.assign({ unit: U }, args || {}), why: 'check ' + name });
const finalFrom = (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt) });
const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

beforeEach(() => setup());
afterEach(() => { jobs._resetForTests(); });

describe('AC-13: crash after a completed tool step', () => {
  it('the port sees its ap_step pending; boot recovery + the next run resumes the loop, the port is called once, counts continue', async () => {
    const { caseId } = F.seedCase();
    const seenStatus = [];
    s.world.decisivStatus = () => {
      seenStatus.push(F.engine.prepare("SELECT status FROM ap_step WHERE tool = 'decisiv_activity' ORDER BY started_at DESC, seq DESC LIMIT 1").get().status);
      return { ok: true, value: { stage: 'ready', status: 'open' } };
    };
    const c = crashable(F.cs);
    let reserves = 0;
    c.at((k) => k === 'reserveAiTurn' && ++reserves === 2);   // dies before turn 2
    const reason = F.fakePlanner([turn([tool('decisiv_activity')]), finalFrom]);
    const r1 = await inv(caseId, { caseStore: c.cs, reason });
    expect(r1.ok).toBe(false);
    expect(caseOf(caseId).state).toBe('ANALYZING');
    const run1 = runs(caseId)[0];
    expect(run1.checkpoint).toMatchObject({ step: 'loop' });
    const steps1 = F.cs.stepsForRun(run1.run_id);
    expect(steps1.filter((x) => x.kind === 'model').map((x) => x.status)).toEqual(['ok']);
    expect(steps1.filter((x) => x.kind === 'tool').map((x) => [x.tool, x.status])).toEqual([['existing_timeline', 'empty'], ['previous_findings', 'empty'], ['decisiv_activity', 'ok']]);
    expect(seenStatus).toEqual(['pending']);

    expect(restart().requeued).toEqual([caseId]);
    s.ck.advance(6 * MIN);
    const r2 = await inv(caseId, { owner: 'own-2', trigger: 'recovered', reason });
    expect(r2).toMatchObject({ ok: true, outcome: 'recommendation', aiStatus: 'ok' });
    expect(seenStatus.length).toBe(1);                       // the completed live step is not repeated
    expect(reason.calls.length).toBe(2);
    const run2 = runs(caseId)[0];
    expect(run2.resumed_from).toBe(run1.run_id);
    const steps2 = F.cs.stepsForRun(run2.run_id);
    const copied = steps2.filter((x) => x.copied_from);
    expect(copied.length).toBe(steps1.length);
    const seqs = steps2.map((x) => x.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    const newModel = steps2.filter((x) => x.kind === 'model' && !x.copied_from);
    expect(newModel.length).toBe(1);
    expect(newModel[0].seq).toBeGreaterThan(Math.max(...steps1.map((x) => x.seq)));
    expect(steps2.filter((x) => x.kind === 'model').length).toBe(2);
    // copied idem_key uses the new run id; call_key is kept.
    for (const cst of copied) {
      const orig = steps1.find((x) => x.step_id === cst.copied_from);
      expect(cst.idem_key).not.toBe(orig.idem_key);
      expect(cst.idem_key).toBe(sha1([caseId, run2.run_id, cst.seq, cst.kind, cst.tool || '', cst.args_hash || ''].join('|')));
      expect(cst.call_key).toBe(orig.call_key);
    }
    expect(caseOf(caseId)).toMatchObject({ state: 'RECOMMENDATION_READY', lease_owner: null, attempts: 0 });
  });

  it('the loop checkpoint restores sourceStatus, flags and liveDone: aapGetServiceIfWarm is not called again', async () => {
    setup({ rows: [F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186' })], aapWarm: true,
      aapLive: () => ({ ok: true, value: { workRequest: { id: 'svc-1', assetDisplayName: U, lifecycleState: 'Unavailable', comments: [{ timestamp: '2026-11-19T10:00:00Z', text: 'parts ordered' }] } } }) });
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    let reserves = 0;
    c.at((k) => k === 'reserveAiTurn' && ++reserves === 2);
    const reason = F.fakePlanner([turn([tool('aap_comments')]), turn([tool('aap_comments', { woId: 'svc-1' })]), finalFrom]);
    await inv(caseId, { caseStore: c.cs, reason });
    expect(s.world.calls.aapLive).toBe(1);                   // the evidence pass; the tool saw LIVE_DONE_THIS_RUN
    const cp = runs(caseId)[0].checkpoint;
    expect(cp.step).toBe('loop');
    expect(cp.liveDone).toContain('aap_live');
    expect(cp.sourceStatus).toMatchObject({ aap_live: 'ok' });
    expect(Array.isArray(cp.flags)).toBe(true);
    restart();
    s.ck.advance(6 * MIN);
    const r2 = await inv(caseId, { owner: 'own-2', trigger: 'recovered', reason });
    expect(r2.ok).toBe(true);
    expect(s.world.calls.aapLive).toBe(1);
    const st = F.cs.stepsForRun(runs(caseId)[0].run_id).filter((x) => x.tool === 'aap_comments' && !x.copied_from);
    expect(st.map((x) => x.code)).toEqual(['LIVE_DONE_THIS_RUN']);
    // the resumed base pack carries the checkpoint's sourceStatus (no evidence pass ran in run 2).
    expect(caseOf(caseId).memory.sourceFreshness.aap_live.status).toBe('ok');
  });
});

describe('AC-14: interrupted live calls, cross-run reuse', () => {
  it('a crash during a live call -> interrupted; the resumed run does not re-issue it (INTERRUPTED_LIVE_NOT_REISSUED)', async () => {
    const { caseId } = F.seedCase();
    const c = crashable(F.cs);
    s.world.decisivStatus = () => { c.crashNow(); return { ok: true, value: { stage: 'ready', status: 'open' } }; };
    const reason = F.fakePlanner([turn([tool('decisiv_activity')]), turn([tool('decisiv_activity')]), finalFrom]);
    await inv(caseId, { caseStore: c.cs, reason });
    const run1 = runs(caseId)[0];
    expect(F.cs.stepsForRun(run1.run_id).find((x) => x.tool === 'decisiv_activity').status).toBe('pending');
    const rec = restart();
    expect(rec.interruptedSteps).toBe(1);
    s.ck.advance(6 * MIN);
    const r2 = await inv(caseId, { owner: 'own-2', trigger: 'recovered', reason });
    expect(r2.ok).toBe(true);
    expect(s.world.calls.decisivStatus).toBe(1);
    const st = F.cs.stepsForRun(runs(caseId)[0].run_id).filter((x) => x.tool === 'decisiv_activity');
    expect(st.map((x) => [!!x.copied_from, x.status, x.code])).toEqual([[true, 'interrupted', null], [false, 'skipped', 'INTERRUPTED_LIVE_NOT_REISSUED']]);
  });

  it('a later run within 6 h with an unchanged comments fingerprint -> the live tool is reused by call_key, no port call', async () => {
    s.world.aapLive = () => ({ ok: true, value: { workRequest: { id: 'svc-1', assetDisplayName: U, lifecycleState: 'Unavailable', comments: [{ timestamp: '2026-11-19T10:00:00Z', text: 'parts ordered' }] } } });
    const { caseId } = F.seedCase();
    const reason = F.fakePlanner([turn([tool('aap_comments')]), finalFrom, turn([tool('aap_comments')]), finalFrom]);
    expect((await inv(caseId, { reason })).ok).toBe(true);
    expect(s.world.calls.aapLive).toBe(1);
    const first = F.cs.stepsForRun(runs(caseId)[0].run_id).find((x) => x.tool === 'aap_comments');
    expect(first.status).toBe('ok');
    s.ck.advance(2 * H);
    expect(F.cs.requestDeep(caseId, { now: s.ck.now() }).ok).toBe(true);
    expect((await inv(caseId, { reason, trigger: 'manual' })).ok).toBe(true);
    expect(s.world.calls.aapLive).toBe(1);
    const second = F.cs.stepsForRun(runs(caseId)[0].run_id).find((x) => x.tool === 'aap_comments');
    expect(second).toMatchObject({ status: 'reused', reused_step_id: first.step_id, call_key: first.call_key });
  });
});

describe('AC-15: per-run leases', () => {
  it('a second lease attempt fails while a run of the same process holds the case', async () => {
    const { caseId } = F.seedCase();
    expect(F.cs.leaseRun(caseId, 'own-1#aaaaaaaa', s.ck.now() + 10 * MIN, { now: s.ck.now() })).toBe(true);
    const r = await inv(caseId, { reason: F.fakePlanner([]) });
    expect(r).toMatchObject({ ok: false, code: 'LEASED' });
    expect(F.cs.leaseRun(caseId, 'own-1#bbbbbbbb', s.ck.now() + 10 * MIN, { now: s.ck.now() })).toBe(false);
    expect(caseOf(caseId)).toMatchObject({ state: 'QUEUED', lease_owner: 'own-1#aaaaaaaa' });
  });

  it('a takeover during evidence collection -> LEASE_LOST; the case state and columns are unchanged, the own run is closed lease_lost', async () => {
    const { caseId } = F.seedCase();
    let snapshot = null;
    const base = s.ports;
    s.ports = Object.freeze(Object.assign({}, base, {
      slackSearch(q) {
        F.engine.prepare('UPDATE ap_case SET lease_owner = ?, lease_until = ? WHERE case_id = ?').run('other#1', s.ck.now() + H, caseId);
        snapshot = F.engine.prepare('SELECT * FROM ap_case WHERE case_id = ?').get(caseId);
        return base.slackSearch(q);
      },
    }));
    const reason = F.fakePlanner([finalFrom]);
    const r = await inv(caseId, { reason });
    expect(r).toMatchObject({ ok: false, code: 'LEASE_LOST', outcome: 'lease_lost' });
    expect(snapshot).toBeTruthy();
    expect(F.engine.prepare('SELECT * FROM ap_case WHERE case_id = ?').get(caseId)).toEqual(snapshot);
    expect(caseOf(caseId).state).toBe('INVESTIGATING');
    const run = runs(caseId)[0];
    expect(run).toMatchObject({ outcome: 'lease_lost', error_code: 'LEASE_LOST' });
    expect(run.ended_at).not.toBe(null);
    expect(F.cs.findingsForRun(run.run_id)).toEqual([]);
    expect(reason.calls.length).toBe(0);
  });
});
