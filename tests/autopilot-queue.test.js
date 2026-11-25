// tests/autopilot-queue.test.js — Autopilot V2 bounded priority queue and worker pool (design §8.2-§8.4,
// §8.6, §8.7): AC-16 band order and aging, AC-17 maxConcurrent, AC-18 admission bound and overflow
// promotion, the anti-starvation bound, minStartRemainingMs, AC-19 pause and the deep-request jump.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 60000 });
const F = require('./helpers/autopilot-fakes.cjs');
const queue = require('../src/autopilot/queue');
const { scoreV2 } = require('../src/autopilot/priority');
const { LIMITS } = require('../src/autopilot/constants');

const { T0, H, MIN, DAY, cs } = F;
const AGING = { boost: 2, cap: 40 };

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('queue'); F.schema.ensureSchema(); });

function seedQ(unit, priority, now, opts) {
  return cs.upsertDetected({
    unitId: unit, domicile: 'ABE40', reasons: [{ code: 'OOS' }, { code: 'DWELL_EXCEEDED' }], openedBy: 'oos_rule', daysDown: 5, downSince: T0 - 5 * DAY, priority,
  }, Object.assign({ now: now == null ? T0 : now }, opts || {})).caseId;
}
function toMonitoring(id, now, fields) {
  cs.transition(id, 'INVESTIGATING', { now });
  cs.transition(id, 'MONITORING', { now });
  cs.persistRun(id, null, Object.assign({ next_review_at: now + 10 * DAY }, fields || {}), null, { now });
}
const stateCount = (st) => cs.listCases({ state: st, limit: 200 }).total;

describe('queue.js (pure)', () => {
  it('nextStart: stop below minStartRemainingMs, wait at maxConcurrent, else start; planStarts; promotionCount', () => {
    expect(queue.nextStart({ running: 0, maxConcurrent: 2, remainingMs: LIMITS.minStartRemainingMs })).toBe('start');
    expect(queue.nextStart({ running: 0, maxConcurrent: 2, remainingMs: LIMITS.minStartRemainingMs - 1 })).toBe('stop');
    expect(queue.nextStart({ running: 2, maxConcurrent: 2, remainingMs: 10 * MIN })).toBe('wait');
    expect(queue.nextStart({ running: 1, maxConcurrent: 2, remainingMs: 10 * MIN })).toBe('start');
    expect(queue.planStarts([{ case_id: 'a' }, 'b'], { maxConcurrent: 2, remainingMs: 10 * MIN })).toEqual({ start: ['a', 'b'], skipped: [], maxParallel: 2 });
    expect(queue.planStarts(['a', 'b'], { maxConcurrent: 2, remainingMs: 1000 })).toEqual({ start: [], skipped: ['a', 'b'], maxParallel: 2 });
    expect(queue.promotionCount(100, 40)).toBe(60);
    expect(queue.promotionCount(100, 140)).toBe(0);
  });
});

describe('priority and aging (AC-16)', () => {
  it('maxStartsPerTick 1 starts priorities 70, 40, 10 in that order', async () => {
    const order = [];
    const runInvestigation = async (caseId) => { order.push(cs.getCase(caseId).case.priority); toMonitoring(caseId, T0); return { ok: true, caseId }; };
    const env = F.mkEnv({ world: F.mkWorld({ rows: [] }), autopilot: { queue: { maxStartsPerTick: 1 } }, runInvestigation });
    for (const [u, p] of [['P10', 10], ['P70', 70], ['P40', 40]]) seedQ(u, p, T0 - MIN);
    for (let i = 0; i < 3; i++) { await env.ctl.runOnce(); env.clock.advance(MIN); }
    expect(order).toEqual([70, 40, 10]);
  });

  it('a priority-10 case queued 20 h ago (+40) beats a fresh 45; at 60 h the boost is exactly +40', () => {
    const old = seedQ('OLD', 10, T0 - 20 * H);
    seedQ('F45', 45, T0);
    expect(cs.pickQueued(1, T0, AGING)[0].case_id).toBe(old);
    F.freshDb('queue2'); F.schema.ensureSchema();
    const old60 = seedQ('OLD', 10, T0 - 60 * H);
    seedQ('F49', 49, T0);
    expect(cs.pickQueued(1, T0, AGING)[0].case_id).toBe(old60);       // 10 + 40 = 50 > 49
    const f51 = seedQ('F51', 51, T0);
    expect(cs.pickQueued(1, T0, AGING)[0].case_id).toBe(f51);         // 51 > 50: the cap holds
  });

  it('queued_since is kept across a deferral (QUEUED -> INVESTIGATING -> QUEUED)', () => {
    const id = seedQ('DEF', 20, T0 - 5 * H);
    expect(cs.getCase(id).case.queued_since).toBe(T0 - 5 * H);
    cs.transition(id, 'INVESTIGATING', { now: T0 });
    cs.transition(id, 'QUEUED', { reason: 'ai_busy', now: T0 + MIN });
    expect(cs.getCase(id).case.queued_since).toBe(T0 - 5 * H);
  });

  it('scoreV2 band boundaries', () => {
    expect(scoreV2({ reasons: ['SAFETY_CRITICAL'] })).toBe(80);
    expect(scoreV2({ reasons: ['OOS'], safety: 1 })).toBe(80);
    const max = { daysDown: 400, neverInvestigated: true, recurrenceCount: 3, aiUrgency: 'high' };
    expect(scoreV2(Object.assign({ reasons: ['REPAIRED_UNVERIFIED', 'UPDATE_STALE', 'STATUS_CONFLICT'] }, max))).toBe(79);
    expect(scoreV2(Object.assign({ reasons: ['OOS', 'UPDATE_STALE', 'STATUS_CONFLICT'] }, max))).toBe(54);
    expect(scoreV2({ reasons: ['ETA_OVERDUE_VERIFIED'], aiUrgency: 'low', state: 'MONITORING', unchanged: true })).toBe(55);
    expect(scoreV2({ reasons: ['OOS'], deep: true })).toBeGreaterThanOrEqual(95);
  });

  it('SAFETY_CRITICAL on Damaged-Severe and Sensor Detected Damage, not on Parts Delay or Damaged', async () => {
    const reasons = { S1: 'Damaged-Severe', S2: 'Sensor Detected Damage', N1: 'Parts Delay', N2: 'Damaged' };
    const rows = Object.keys(reasons).map((u, i) => F.baseRow({ equipmentId: u, lifecycleReason: reasons[u], workDuration: '10d 0h 0m', _serviceId: 'svc-' + i, workRequestId: 'wr-' + i }));
    const env = F.mkEnv({ world: F.mkWorld({ rows }), autopilot: { scope: { mode: 'fleet' } }, runInvestigation: async (caseId) => ({ ok: true, caseId }) });
    await env.ctl.runOnce({ forceDetect: true });
    const by = new Map(cs.listOpen().map((c) => [c.unit_id, c]));
    expect(by.size).toBe(4);
    for (const u of ['S1', 'S2']) expect([by.get(u).safety, by.get(u).priority >= 80], u).toEqual([1, true]);
    for (const u of ['N1', 'N2']) expect([by.get(u).safety, by.get(u).priority < 80], u).toEqual([0, true]);
  });
});

describe('worker pool (AC-17)', () => {
  for (const maxConcurrent of [1, 2, 3]) {
    it('an instrumented runInvestigation never exceeds maxConcurrent = ' + maxConcurrent, async () => {
      let inFlight = 0;
      let maxSeen = 0;
      const started = [];
      const runInvestigation = async (caseId) => {
        inFlight++; maxSeen = Math.max(maxSeen, inFlight); started.push(caseId);
        await new Promise((r) => setTimeout(r, 5 + (started.length % 3) * 5));
        await Promise.resolve();
        inFlight--;
        return { ok: true, caseId };
      };
      const env = F.mkEnv({ world: F.mkWorld({ rows: [] }), autopilot: { queue: { maxStartsPerTick: 6, maxConcurrent } }, runInvestigation });
      for (let i = 0; i < 6; i++) seedQ('C' + i, 10 + i, T0 - MIN);
      const out = await env.ctl.runOnce();
      expect(started.length).toBe(6);
      expect(maxSeen).toBe(maxConcurrent);
      expect(out.investigated.length).toBe(6);
      expect(out.investigated.map((x) => x.caseId).sort()).toEqual(started.slice().sort());
    });
  }

  it('no run starts with less than minStartRemainingMs of tick time left; the rest stay QUEUED', async () => {
    let n = 0;
    const env = F.mkEnv({
      world: F.mkWorld({ rows: [] }), autopilot: { queue: { maxStartsPerTick: 3, maxConcurrent: 1 } },
      runInvestigation: async (caseId) => { n++; env.clock.advance(6 * MIN); toMonitoring(caseId, env.clock.now()); return { ok: true, caseId }; },
    });
    for (let i = 0; i < 3; i++) seedQ('M' + i, 30, T0 - MIN);
    const out = await env.ctl.runOnce();
    expect(n).toBe(1);                 // 8 min budget - 6 min = 2 min < 150 s
    expect(out.investigated.length).toBe(1);
    expect(stateCount('QUEUED')).toBe(2);
  });
});

describe('bounded queue and overflow (AC-18)', () => {
  it('maxQueued 100 with 150 candidates -> 100 QUEUED, 50 DETECTED, all 150 in coverage; promotion by effective priority; a trigger requeue at the bound is allowed', async () => {
    const rows = [];
    for (let i = 0; i < 150; i++) rows.push(F.baseRow({ equipmentId: 'Q' + i, _serviceId: 'svc-q' + i, workRequestId: 'wr-q' + i, workDuration: (4 + (i * 7) % 30) + 'd 0h 0m', repairEtc: null, repairEtcSource: null }));
    const env = F.mkEnv({ world: F.mkWorld({ rows }), autopilot: { scope: { mode: 'fleet' }, queue: { maxQueued: 100 } }, runInvestigation: async (caseId) => ({ ok: true, caseId }) });
    const r = await env.ctl.runOnce({ forceDetect: true });
    expect(r.detected).toBe(150);
    expect(stateCount('QUEUED')).toBe(100);
    expect(stateCount('DETECTED')).toBe(50);
    expect(r.coverage).toMatchObject({ reconcileOk: true, held: 50 });
    const pass = cs.coverage(env.clock.now()).pass;
    expect(pass).toMatchObject({ fleet_rows: 150, down_eligible: 150, case_open: 150, opened: 150, held: 50 });
    expect(cs.listUnits({ coverage: 'case_open', limit: 200 }).total).toBe(150);
    expect(cs.listOpen().length).toBe(150);   // DETECTED cases are open and never dropped

    // Free 10 slots; one of the freed cases is due for its scheduled review.
    const freed = cs.pickQueued(10, env.clock.now(), AGING).map((c) => c.case_id);
    for (const id of freed) toMonitoring(id, env.clock.now());
    cs.persistRun(freed[0], null, { next_review_at: env.clock.now() - 1 }, null, { now: env.clock.now() });
    const detectedBefore = cs.listCases({ state: 'DETECTED', limit: 200 }).items;
    env.clock.advance(MIN);
    const r2 = await env.ctl.runOnce();
    expect(r2.detected).toBe(0);
    const promoted = detectedBefore.filter((c) => cs.getCase(c.case_id).case.state === 'QUEUED');
    const still = detectedBefore.filter((c) => cs.getCase(c.case_id).case.state === 'DETECTED');
    expect(promoted.length).toBe(10);
    expect(still.length).toBe(40);
    expect(Math.min(...promoted.map((c) => c.priority))).toBeGreaterThanOrEqual(Math.max(...still.map((c) => c.priority)));
    for (const c of promoted) expect(cs.getCase(c.case_id).events.filter((e) => e.kind === 'transition').pop().reason_code).toBe('promoted');
    // The scheduled requeue of an existing case is allowed at the bound.
    expect(r2.triggers).toBe(1);
    expect(cs.getCase(freed[0]).case.state).toBe('QUEUED');
    expect(stateCount('QUEUED')).toBe(101);
  });

  it('anti-starvation: with a steady inflow of priority-45 cases a priority-10 case starts within 20 h', () => {
    const low = seedQ('LOW', 10, T0);
    const TICK = 5 * MIN;
    let startedAt = null;
    for (let t = T0, i = 0; t <= T0 + 48 * H; t += TICK, i++) {
      seedQ('N' + i, 45, t);
      const [c] = cs.pickQueued(1, t, AGING);
      toMonitoring(c.case_id, t);
      if (c.case_id === low) { startedAt = t; break; }
    }
    expect(startedAt).not.toBe(null);
    expect(startedAt - T0).toBeLessThanOrEqual(20 * H);
    expect(startedAt - T0).toBeGreaterThanOrEqual(18 * H);   // 10 + 2 x 18 = 46 > 45
  });
});

describe('pause and deep requests (AC-19, §8.7)', () => {
  it('pause -> no starts, no promotion, no AI call', async () => {
    const started = [];
    const env = F.mkEnv({ world: F.mkWorld({ rows: [] }), runInvestigation: async (caseId) => { started.push(caseId); return { ok: true, caseId }; } });
    seedQ('A1', 30, T0 - MIN);
    const held = seedQ('A2', 30, T0 - MIN, { hold: true });
    expect((await env.ap.control('pause')).ok).toBe(true);
    const out = await env.ctl.runOnce();
    expect(out).toEqual({ skipped: 'paused' });
    expect(started).toEqual([]);
    expect(cs.getCase(held).case.state).toBe('DETECTED');
    expect(env.reason.calls.length).toBe(0);
  });

  it('a deep request on a priority-20 case is picked before queued priority-60 cases', async () => {
    const order = [];
    const env = F.mkEnv({
      world: F.mkWorld({ rows: [] }), autopilot: { queue: { maxStartsPerTick: 1 } },
      runInvestigation: async (caseId, deps) => { order.push([caseId, deps.trigger]); toMonitoring(caseId, env.clock.now()); return { ok: true, caseId }; },
    });
    const deep = seedQ('D20', 20, T0 - 2 * H);
    toMonitoring(deep, T0 - H);
    for (let i = 0; i < 3; i++) seedQ('S' + i, 60, T0 - H);
    expect(env.ap.deepInvestigate(deep)).toEqual({ ok: true, state: 'QUEUED' });
    expect(cs.getCase(deep).case.priority).toBeGreaterThanOrEqual(95);
    await env.flush();
    expect(order[0]).toEqual([deep, 'manual']);
  });
});
