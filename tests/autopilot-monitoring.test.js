// tests/autopilot-monitoring.test.js — Autopilot V2 continuous monitoring (design §9, AC-24, AC-25):
// slice-named triggers, cosmetic-only rebuilds fire nothing, the null-baseline rule, source_restored
// with the DTNA usability rule, ai_capacity, the V1 automatic-run limits, controller/run slice
// agreement (review finding 7) and the reopened planner prompt (memory + changed slices).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 60000 });
const F = require('./helpers/autopilot-fakes.cjs');
const slices = require('../src/autopilot/slices');
const { dueTriggers } = require('../src/autopilot/triggers');
const { localDate } = require('../src/autopilot/constants');

const { T0, H, MIN, DAY, cs } = F;
const U = '322283';

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('mon'); });

// A resting case with no runs (so no automatic-run limit applies), observed through a stub pool.
function stubEnv(over) {
  const calls = [];
  const runInvestigation = async (caseId, deps) => { calls.push({ caseId, trigger: deps.trigger, changedSlices: deps.changedSlices }); return { ok: true, caseId }; };
  const env = F.mkEnv(Object.assign({ runInvestigation }, over || {}));
  env.calls = calls;
  F.schema.ensureSchema();
  return env;
}
function restingCase(env, fields) {
  const { caseId } = F.seedCase(U, { woIds: { primary: 'svc-1', secondary: [] } });
  const now = env.clock.now();
  cs.transition(caseId, 'INVESTIGATING', { now });
  cs.transition(caseId, 'MONITORING', { now });
  cs.persistRun(caseId, null, Object.assign({ next_review_at: now + 10 * DAY }, fields || {}), null, { now });
  return caseId;
}
const sliceNow = (env, row) => slices.forCase({ row: row || env.world.rows[0], unit: U, docs: env.world.docs, ports: env.ports, now: env.clock.now(), aperiaIssues: null });

describe('each slice -> its named trigger (AC-24)', () => {
  const MUTATIONS = [
    ['comments', 'new_comment', (w) => { w.rows[0].fullConversation = '11/20 - Vendor: waiting on turbo'; }],
    ['estimate', 'new_estimate', (w) => { w.rows[0].estimateStatus = 'pending_approval'; }],
    ['stage', 'stage_change', (w) => { w.rows[0].offsiteStage = 'ready'; }],
    ['parts', 'parts_status', (w) => { w.rows[0].partsStatus = 'arrived'; }],
    ['verified_eta', 'verified_eta_change', (w) => { w.rows[0].repairEtc = '2026-11-28'; }],
    ['comms', 'relevant_comm', (w) => { w.docs.fasCases = { ['unit-' + U]: { status: 'open', updatedAt: '2026-11-20T12:00:00Z' } }; }],
    ['conflict', 'conflict', (w) => { w.rows[0].canonicalConflictCount = 2; }],
    ['other', 'evidence_changed', (w) => { w.riEvents = [{ reported_at: '2026-11-19T10:00:00Z' }]; }],
  ];
  for (const [slice, trigger, mutate] of MUTATIONS) {
    it(slice + ' -> ' + trigger, () => {
      const w = F.mkWorld();
      const ports = F.fakePorts(w);
      const at = (x) => slices.forCase({ row: x.rows[0], unit: U, docs: x.docs, ports, now: T0, aperiaIssues: null });
      const base = at(w);
      mutate(w);
      const next = at(w);
      expect(slices.changedSlices(base, next)).toEqual([slice]);
      const k = { case_id: 'c1', state: 'MONITORING', slice_fps: base, next_review_at: T0 + DAY };
      expect(dueTriggers([k], T0, { sliceFps: new Map([['c1', next]]), authState: { midway: 'HEALTHY' } })).toEqual([{ caseId: 'c1', trigger, changedSlices: [slice] }]);
    });
  }

  it('cosmetic-only changes (workDuration, syncedAt, _convFetchedAt, retrieval / pull / scrape times) change no slice', () => {
    const w = F.mkWorld({ dtna: { [U]: [{ caseId: 'C1', offsiteStage: 'repair', pulledAt: '2026-11-20T10:00:00Z' }] } });
    w.docs.decisivCaseCache = { 21350186: { stage: 'repair', scrapedAt: '2026-11-20T10:00:00Z' } };
    w.rows[0].decisivCaseId = '21350186';
    const ports = F.fakePorts(w);
    const at = () => slices.forCase({ row: w.rows[0], unit: U, docs: w.docs, ports, now: T0, aperiaIssues: null });
    const base = at();
    Object.assign(w.rows[0], { workDuration: '9d 9h 0m', _convFetchedAt: '2026-11-20T14:00:00Z', _stageReadAt: 'x', scrapedAt: 'y', retrievedAt: 'z' });
    w.syncedAt = new Date(T0).toISOString();
    w.dtna[U][0].pulledAt = '2026-11-20T14:00:00Z';
    w.docs.decisivCaseCache[21350186].scrapedAt = '2026-11-20T14:00:00Z';
    expect(slices.changedSlices(base, at())).toEqual([]);
  });
});

describe('controller slice evaluation', () => {
  it('a null baseline is written without a trigger; a later comment fires new_comment with changedSlices', async () => {
    const env = stubEnv();
    const id = restingCase(env);
    expect(cs.getCase(id).case.slice_fps).toBe(null);
    const r1 = await env.ctl.runOnce();
    expect(r1.triggers).toBe(0);
    expect(env.calls).toEqual([]);
    expect(cs.getCase(id).case.slice_fps).toEqual(sliceNow(env));
    env.world.rows[0].fullConversation = '11/20 - Vendor: turbo arrived';
    env.world.gens.fleetData = 2;
    env.clock.advance(MIN);
    const r2 = await env.ctl.runOnce();
    expect(r2.triggers).toBe(1);
    expect(env.calls).toEqual([{ caseId: id, trigger: 'new_comment', changedSlices: ['comments'] }]);
  });

  it('the V1 automatic-run limits still apply to slice triggers', async () => {
    const env = stubEnv();
    const id = restingCase(env);
    await env.ctl.runOnce();
    cs.openRun({ caseId: id, trigger: 'scheduled', now: env.clock.now() });
    env.world.rows[0].partsStatus = 'arrived';
    env.world.gens.fleetData = 2;
    env.clock.advance(10 * MIN);
    expect((await env.ctl.runOnce()).triggers).toBe(0);
    env.world.gens.fleetData = 3;
    env.clock.advance(21 * MIN);
    expect((await env.ctl.runOnce()).triggers).toBe(1);
    expect(env.calls.map((c) => c.trigger)).toEqual(['parts_status']);
  });

  const DTNA = [
    [{ state: 'connected' }, true], [{ state: 'pulling' }, true], [{ state: 'connecting' }, false],
    [{ state: 'expired' }, false], [{ state: 'signed-out' }, false], [{ state: 'connected', actionNeeded: true }, false],
  ];
  for (const [st, usable] of DTNA) {
    it('source_restored for awaiting dtna with DTNA ' + JSON.stringify(st) + ' -> ' + (usable ? 'fires' : 'none'), async () => {
      const env = stubEnv({ world: F.mkWorld({ dtnaState: st }) });
      const id = restingCase(env, { awaiting_sources: 'aap_live,dtna' });
      await env.ctl.runOnce();
      if (usable) expect(env.calls).toEqual([{ caseId: id, trigger: 'source_restored', changedSlices: undefined }]);
      else expect(env.calls).toEqual([]);
    });
  }

  it('source_restored for aap_live needs Midway HEALTHY and a warm AAP session', async () => {
    const env = stubEnv({ world: F.mkWorld({ aapWarm: false }) });
    const id = restingCase(env, { awaiting_sources: 'aap_live' });
    await env.ctl.runOnce();
    expect(env.calls).toEqual([]);
    env.world.aapWarm = true;
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.calls.map((c) => [c.caseId, c.trigger])).toEqual([[id, 'source_restored']]);
  });

  it('ai_capacity: ai_pending_reason set, ai_retry_at due and calls left today', async () => {
    const env = stubEnv({ autopilot: { dailyCap: 3, ai: { dailyCap: 3 } } });
    const id = restingCase(env, { ai_pending_reason: 'cap', ai_retry_at: env.clock.now() - 1 });
    cs.setMeta('ai_calls:' + localDate(env.clock.now()), 3);
    await env.ctl.runOnce();
    expect(env.calls).toEqual([]);                       // no calls left today
    cs.setMeta('ai_calls:' + localDate(env.clock.now()), 2);
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.calls.map((c) => [c.caseId, c.trigger])).toEqual([[id, 'ai_capacity']]);
  });

  it('ai_capacity also fires for a NEEDS_REVIEW case deferred by the cap, not for other NEEDS_REVIEW cases', () => {
    const k = (reason) => ({ case_id: 'c1', state: 'NEEDS_REVIEW', ai_pending_reason: reason, ai_retry_at: T0 - 1 });
    expect(dueTriggers([k('cap')], T0, { aiCapLeft: 1 })).toEqual([{ caseId: 'c1', trigger: 'ai_capacity' }]);
    expect(dueTriggers([k('cap')], T0, { aiCapLeft: 0 })).toEqual([]);
    expect(dueTriggers([k('unavailable')], T0, { aiCapLeft: 1 })).toEqual([]);
  });
});

describe('real runs (review finding 7, AC-24, AC-25)', () => {
  const MT = { scope: { mode: 'fleet' }, features: { liveReads: true, multiTurn: true } };
  const turn = (tools, memory) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: memory || {} });
  const finalFrom = (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt, { summary: 'Turbo backorder at the dealer.' }) });

  it('a case run to rest, then one controller evaluation with no source change, fires no trigger', async () => {
    const env = F.mkEnv({ autopilot: { scope: { mode: 'fleet' } }, world: F.mkWorld({ dtna: { [U]: [{ caseId: 'C1', offsiteStage: 'repair', pulledAt: '2026-11-20T10:00:00Z' }] } }) });
    await env.ctl.runOnce({ forceDetect: true });
    const c0 = cs.listOpen()[0];
    expect(c0.slice_fps).toBeTruthy();
    const runs0 = cs.getCase(c0.case_id).runs.length;
    env.world.gens.fleetData = 2;
    env.clock.advance(31 * MIN);
    const r = await env.ctl.runOnce();
    expect(r.triggers).toBe(0);
    expect(cs.getCase(c0.case_id).runs.length).toBe(runs0);
  });

  it('a cosmetic-only rebuild after a run fires no trigger and no AI call', async () => {
    const env = F.mkEnv({ autopilot: { scope: { mode: 'fleet' } }, world: F.mkWorld({ dtna: { [U]: [{ caseId: 'C1', offsiteStage: 'repair', pulledAt: '2026-11-20T10:00:00Z' }] } }) });
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    const ai0 = env.reason.calls.length;
    Object.assign(env.world.rows[0], { workDuration: '5d 9h 0m', _convFetchedAt: '2026-11-20T15:30:00Z' });
    env.world.syncedAt = new Date(env.clock.now()).toISOString();
    env.world.lastOkAt = env.clock.now();
    env.world.dtna[U][0].pulledAt = '2026-11-20T15:30:00Z';
    env.world.gens.fleetData = 2;
    env.clock.advance(31 * MIN);
    const r = await env.ctl.runOnce();
    expect(r.triggers).toBe(0);
    expect(r.investigated).toEqual([]);
    expect(env.reason.calls.length).toBe(ai0);
    expect(cs.getCase(id).runs.length).toBe(1);
  });

  it('the reopened planner prompt holds the memory conclusion, open questions and the changed slices', async () => {
    const reason = F.fakePlanner([
      turn([{ tool: 'dtna_case', args: { unit: U }, why: 'check dtna' }], { openQuestions: [{ question: 'Is the turbo in stock at the dealer?', likelySource: 'vendor' }] }),
      finalFrom,
      finalFrom,
    ]);
    const env = F.mkEnv({ autopilot: MT, reason });
    await env.ctl.runOnce({ forceDetect: true });
    expect(reason.calls.length).toBe(2);
    const id = cs.listOpen()[0].case_id;
    expect(cs.getCase(id).case.memory.openQuestions.map((q) => q.question)).toContain('Is the turbo in stock at the dealer?');
    env.world.rows[0].fullConversation = '11/20 - Vendor: turbo ships Monday';
    env.world.gens.fleetData = 2;
    env.clock.advance(31 * MIN);
    const r = await env.ctl.runOnce();
    expect(r.triggers).toBe(1);
    expect(cs.getCase(id).runs[0].trigger).toBe('new_comment');
    const p = reason.prompts[2];
    expect(p).toContain('changedSlices=comments');
    expect(p).toContain('Is the turbo in stock at the dealer?');
    expect(p).toContain('Turbo backorder at the dealer.');
  });
});

describe('sliceFp: live tool pre-call fingerprint (§6.2.5)', () => {
  const row = { equipmentId: U, fullConversation: 'Waiting on turbo', asistNotes: null, decisivCaseId: '21350186' };
  it('comments fp follows the comments slice and ignores cosmetic fields', () => {
    const a = slices.sliceFp('comments', row, {});
    expect(a).toBe(slices.computeSlices({ row, docs: {} }).comments);
    expect(slices.sliceFp('comments', Object.assign({}, row, { syncedAt: 1, workDuration: 9 }), {})).toBe(a);
    expect(slices.sliceFp('comments', Object.assign({}, row, { fullConversation: 'Turbo arrived' }), {})).not.toBe(a);
  });
  it('decisiv fp hashes the cache entry slice values, not fetch times; null without an entry', () => {
    const r = Object.assign({}, row);
    const id = '21350186';
    const docs = (e) => ({ decisivCaseCache: { [id]: e } });
    const base = slices.sliceFp('decisiv', r, docs({ stage: 'Repair', notesCount: 2, fetchedAt: 1 }));
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(slices.sliceFp('decisiv', r, docs({ stage: 'Repair', notesCount: 2, fetchedAt: 2 }))).toBe(base);
    expect(slices.sliceFp('decisiv', r, docs({ stage: 'Repair', notesCount: 3, fetchedAt: 2 }))).not.toBe(base);
    expect(slices.sliceFp('decisiv', r, {})).toBeNull();
  });
});