// tests/autopilot-deep.test.js — Autopilot V2 deep investigate (design §8.7, AC-19, AC-26, AC-40):
// same case_id, complex tier, memory in the prompt, exempt from the automatic-run limits, the AI
// daily cap still applies; a trivial unchanged MONITORING case still gets the AI; the facade codes.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 60000 });
const F = require('./helpers/autopilot-fakes.cjs');

const { MIN, cs } = F;
const U = '322283';
const MT = { scope: { mode: 'fleet' }, features: { liveReads: true, multiTurn: true } };
const finalFrom = (summary) => (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt, { summary }) });

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('deep'); });

describe('deep investigate (AC-26)', () => {
  it('from rest -> QUEUED with the same case_id; complex tier; memory in the prompt; exempt from the automatic limits', async () => {
    const reason = F.fakePlanner([finalFrom('Turbo backorder at the dealer.'), finalFrom('Second look.')]);
    const env = F.mkEnv({ autopilot: MT, reason });
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    const rest = cs.getCase(id).case.state;
    expect(['MONITORING', 'RECOMMENDATION_READY']).toContain(rest);
    env.clock.advance(MIN);                         // well inside the 30-min automatic spacing
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: true, state: 'QUEUED' });
    expect(cs.getCase(id).case).toMatchObject({ state: 'QUEUED', case_id: id });
    await env.flush();
    expect(reason.calls.length).toBe(2);
    const got = env.ap.getCase(id);
    expect(got.runs[0].trigger).toBe('manual');
    expect(got.case.complexity).toBe('complex');
    expect(got.case.deep_requested_at).toBe(null);
    expect(cs.listOpen().filter((c) => c.unit_id === U).length).toBe(1);
    const p = reason.prompts[1];
    expect(p).toContain('deep=yes');
    expect(p).toContain('Turbo backorder at the dealer.');
    // getCase V2 extras: steps (listed columns only), proposals, record, memory.
    expect(got.steps.length).toBeGreaterThan(0);
    for (const s of got.steps) expect(Object.keys(s).sort()).toEqual(['ai_lane', 'ai_latency_ms', 'args_json', 'code', 'kind', 'live', 'ms', 'reused_step_id', 'run_id', 'seq', 'started_at', 'status', 'step_id', 'summary_json', 'tool', 'turn', 'why'].sort());
    expect(Array.isArray(got.proposals)).toBe(true);
    expect(got.record).toBeTruthy();
    expect(got.memory.priorConclusions.length).toBeGreaterThan(0);
  });

  it('the AI daily cap still applies to a deep run', async () => {
    const reason = F.fakePlanner([finalFrom('First.'), finalFrom('Never used.')]);
    const env = F.mkEnv({ autopilot: Object.assign({ dailyCap: 1, ai: { dailyCap: 1 } }, MT), reason });
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    env.clock.advance(MIN);
    expect(env.ap.deepInvestigate(id).ok).toBe(true);
    await env.flush();
    expect(reason.calls.length).toBe(1);
    const c = cs.getCase(id);
    expect(c.runs[0]).toMatchObject({ trigger: 'manual', ai_status: 'skipped_cap' });
    expect(c.case.ai_pending_reason).toBe('cap');
  });

  it('a trivial MONITORING case with unchanged evidence still runs the AI on a deep request (AC-40)', async () => {
    const env = F.mkEnv({ autopilot: { scope: { mode: 'fleet' } } });
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    expect(env.reason.calls.length).toBe(1);
    // An unchanged rerun skips the AI.
    env.clock.advance(MIN);
    expect(env.ap.review(id, 'rerun').ok).toBe(true);
    await env.ctl.runOnce();
    expect(cs.getCase(id).runs[0].outcome).toBe('unchanged');
    expect(env.reason.calls.length).toBe(1);
    env.clock.advance(MIN);
    if (cs.getCase(id).case.state !== 'MONITORING') cs.transition(id, 'MONITORING', { now: env.clock.now() });
    expect(cs.getCase(id).case.state).toBe('MONITORING');
    expect(env.ap.deepInvestigate(id).ok).toBe(true);
    await env.flush();
    expect(env.reason.calls.length).toBe(2);
    expect(cs.getCase(id).runs[0]).toMatchObject({ trigger: 'manual', outcome: 'recommendation' });
  });
});

describe('facade codes (AC-19)', () => {
  it('NOT_RUNNING when paused, DISABLED, SUPERVISOR_DISABLED, CASE_BUSY, INVALID_STATE on RESOLVED / PAUSED, NOT_FOUND', async () => {
    const env = F.mkEnv({ autopilot: { scope: { mode: 'fleet' } } });
    await env.ctl.runOnce({ forceDetect: true });
    const id = cs.listOpen()[0].case_id;
    expect((await env.ap.control('pause')).ok).toBe(true);
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'NOT_RUNNING' });
    expect((await env.ap.control('resume')).ok).toBe(true);
    env.deferred.length = 0;
    const now = env.clock.now();
    const st = cs.getCase(id).case.state;
    if (st === 'PAUSED') cs.requeueCases({ caseIds: [id], trigger: 'test', now });
    if (cs.getCase(id).case.state !== 'QUEUED') cs.requeueCases({ caseIds: [id], trigger: 'test', now });
    cs.transition(id, 'INVESTIGATING', { now });
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'CASE_BUSY' });
    cs.transition(id, 'PAUSED', { pauseReason: 'user', now });
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'INVALID_STATE' });
    const tok = require('../src/autopilot/resolution').verifyResolution(cs.getCase(id).case, { equipmentId: U, lifecycleState: 'Active' }, { source: 'aap-api', buildAtMs: now + 1 }, now + 1);
    cs.transition(id, 'RESOLVED', { resolution: tok.token, now: now + 1 });
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(env.ap.deepInvestigate('ap_0000000000000000')).toEqual({ ok: false, code: 'NOT_FOUND' });
    env.supervisor.enabled = false;
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    env.supervisor.enabled = true;
    expect(env.ap.setConfig({ enabled: false }).ok).toBe(true);
    expect(env.ap.deepInvestigate(id)).toEqual({ ok: false, code: 'DISABLED' });
  });
});
