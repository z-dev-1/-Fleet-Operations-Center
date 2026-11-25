// tests/autopilot-investigate-v2.test.js — Autopilot V2 investigation run wiring (design §7.1, §6.7,
// review findings 3-6): adapter on the isolated lane, V1 single-call fallback (AC-38), pause (AC-19),
// cap mid-loop and deferral timing (AC-20/21, findings 4/5), tool-only conflicts (AC-37), the
// equipment re-check and the scoreV2 band on the unchanged path (finding 6).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('./helpers/autopilot-fakes.cjs');
const { runInvestigation } = require('../src/autopilot/investigate');
const { createLimiter } = require('../src/autopilot/limiter');

const { H, MIN } = F;
const U = '322283';
const NEXT_MIDNIGHT = new Date(2026, 10, 21).getTime();   // T0 is 2026-11-20 10:00 local

let s;
function setup(over) {
  F.freshDb('invv2');
  F.schema.ensureSchema();
  const ck = F.clock();
  const row = F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186', fullConversation: '10/01 - Vendor: old note' });
  const world = F.mkWorld(Object.assign({
    rows: [row], isolated: true,
    dtna: { [U]: [{ caseId: 'C1', unitId: U, offsiteStage: 'repair', stageSince: '2026-11-18T00:00:00Z', repairEtc: '2026-11-25' }] },
    decisivStatus: () => ({ ok: true, value: { stage: 'ready', status: 'open' } }),
  }, over || {}));
  world.docs.decisivCaseCache = { 21350186: { estimateId: '21350186', stage: 'repair', scrapedAt: new Date(F.T0 - 24 * H).toISOString() } };
  world.docs.notesStore = { [U]: { timeline: '11/18 - Vendor: turbo on order' } };
  s = { ck, world, ports: F.fakePorts(world) };
}
function inv(caseId, o) {
  const opts = Object.assign({}, o || {});
  const cfg = F.cfgOf(Object.assign({ features: { liveReads: true, multiTurn: true } }, opts.cfgOver || {}));
  delete opts.cfgOver;
  return runInvestigation(caseId, Object.assign({
    ports: s.ports, cfg, now: s.ck.now, rand: () => 0.5, owner: 'own', limiter: createLimiter({ now: s.ck.now, random: () => 0 }), trigger: 'new',
  }, opts));
}
const caseOf = (id) => F.cs.getCase(id).case;
const lastRun = (id) => F.cs.getCase(id).runs[0];
const events = (id, kind) => F.cs.getCase(id).events.filter((e) => !kind || e.kind === kind);
const turn = (tools, memory) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: memory || {} });
const tool = (name, args) => ({ tool: name, args: Object.assign({ unit: U }, args || {}), why: 'check ' + name });
const finalFrom = (o) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(o.prompt) });
const steps = (id) => F.cs.stepsForRun(lastRun(id).run_id);

beforeEach(() => setup());

describe('multi-turn run through runInvestigation', () => {
  it('runs the adapter and persists steps, memory, ap_record and timeline proposals in one commit', async () => {
    const { caseId } = F.seedCase();
    const persists = [];
    const cs = Object.assign({}, F.cs, { persistRun: (...a) => { persists.push(a[4]); return F.cs.persistRun(...a); } });
    const reason = F.fakePlanner([turn([tool('dtna_case')], { hypotheses: [{ statement: 'Waiting on the turbo', confidence: 0.5 }] }), finalFrom]);
    const r = await inv(caseId, { reason, caseStore: cs });
    expect(r).toMatchObject({ ok: true, outcome: 'recommendation', aiStatus: 'ok', aiCalled: true });
    expect(reason.calls.length).toBe(2);
    for (const c of reason.calls) expect(c).toMatchObject({ isolated: true, priority: 'low', source: 'autopilot' });
    expect(persists.length).toBe(1);
    expect(persists[0].record).toBeTruthy();
    expect(Array.isArray(persists[0].proposals) && persists[0].proposals.length > 0).toBe(true);
    const st = steps(caseId);
    expect(st.filter((x) => x.kind === 'model').length).toBe(2);
    expect(st.some((x) => x.kind === 'tool' && x.tool === 'dtna_case' && x.status === 'ok')).toBe(true);
    const c = caseOf(caseId);
    expect(c.memory.hypotheses.map((h) => h.statement)).toContain('Waiting on the turbo');
    expect(c).toMatchObject({ ai_pending_reason: null, ai_investigated_at: s.ck.now(), deep_requested_at: null, lease_owner: null });
    expect(c.ai_fp).toBe(c.evidence_fp);
    expect(c.slice_fps).toMatchObject({ comments: expect.any(String), stage: expect.any(String), other: expect.any(String) });
    expect(['simple', 'standard', 'complex']).toContain(c.complexity);
    expect(c.priority).toBeGreaterThanOrEqual(55);
    expect(c.priority).toBeLessThanOrEqual(79);
    const rec = F.cs.getRecord(caseId);
    expect(rec).toMatchObject({ case_id: caseId, ai_status: 'ok' });
    expect(F.cs.listProposals(caseId).length).toBe(persists[0].proposals.length);
    const run = lastRun(caseId);
    expect(run).toMatchObject({ ai_lane: 'isolated', ai_isolated: 1, ai_status: 'ok', outcome: 'recommendation' });
    expect(Number.isFinite(run.ai_latency_ms)).toBe(true);
    expect(run.checkpoint).toMatchObject({ step: 'analysis_done', agent: { status: 'concluded', turns: 2 } });
  });

  it('AC-38: lane unavailable -> exactly one reason() with isolated:false and the V1 prompt, ai_lane gateway, multiturn_lane_unavailable event', async () => {
    s.world.isolated = false;
    const { caseId } = F.seedCase();
    const reason = F.okReason();
    const r = await inv(caseId, { reason });
    expect(r.aiStatus).toBe('ok');
    expect(reason.calls.length).toBe(1);
    expect(reason.calls[0].isolated).toBe(false);
    expect(reason.calls[0].prompt).toContain('#### STRUCTURED EVIDENCE ####');
    expect(reason.calls[0].prompt).not.toContain('#### EVIDENCE INDEX ####');
    expect(reason.calls[0].prompt).not.toContain('#### TOOLS ####');
    expect(lastRun(caseId)).toMatchObject({ ai_lane: 'gateway', ai_isolated: 0 });
    expect(events(caseId, 'ai').map((e) => e.reason_code)).toContain('multiturn_lane_unavailable');
    expect(steps(caseId)).toEqual([]);
  });

  it('lane lost before turn 2 -> fallback, ai_pending_reason unavailable, ai_investigated_at set (turn 1 answered)', async () => {
    const { caseId } = F.seedCase();
    const reason = F.fakePlanner([() => { s.world.isolated = false; return turn([tool('dtna_case')]); }, finalFrom]);
    const r = await inv(caseId, { reason });
    expect(r.aiStatus).toBe('unavailable');
    expect(reason.calls.length).toBe(1);
    const c = caseOf(caseId);
    expect(c.ai_findings.generatedBy).toBe('deterministic');
    expect(c).toMatchObject({ ai_pending_reason: 'unavailable', ai_investigated_at: s.ck.now(), ai_fp: null });
    expect(c.ai_retry_at).toBe(s.ck.now() + H);
  });

  it('AC-19: pause while reason() is pending -> PAUSED master_pause, model step interrupted / ABORTED, no ai_pending_reason', async () => {
    const { caseId } = F.seedCase();
    const ac = new AbortController();
    const reason = F.fakePlanner([() => { ac.abort('master_pause'); return turn([tool('dtna_case')]); }]);
    const r = await inv(caseId, { reason, signal: ac.signal });
    expect(r).toMatchObject({ outcome: 'aborted', state: 'PAUSED', abortReason: 'master_pause' });
    const c = caseOf(caseId);
    expect(c).toMatchObject({ state: 'PAUSED', pause_reason: 'master_pause', ai_pending_reason: null });
    expect(steps(caseId).filter((x) => x.kind === 'model').map((x) => [x.status, x.code])).toEqual([['interrupted', 'ABORTED']]);
    expect(steps(caseId).filter((x) => x.kind === 'tool' && x.turn > 0)).toEqual([]);
  });
});

describe('AI budget: cap mid-loop and deferral timing', () => {
  it('AC-21 + finding 4: cap on turn 2 after turn 1 answered -> ai_investigated_at set, ai_pending_reason cap; hypotheses in memory and in the next run\'s first prompt', async () => {
    const { caseId } = F.seedCase();
    const reason = F.fakePlanner([turn([tool('dtna_case')], { hypotheses: [{ statement: 'Turbo backorder at the dealer', confidence: 0.5 }] }), (o) => finalFrom(o)]);
    const r = await inv(caseId, { reason, cfgOver: { ai: { dailyCap: 1 } } });
    expect(r.aiStatus).toBe('skipped_cap');
    expect(reason.calls.length).toBe(1);
    const c = caseOf(caseId);
    expect(c).toMatchObject({ ai_pending_reason: 'cap', ai_investigated_at: s.ck.now(), ai_fp: null });
    expect(c.ai_retry_at).toBeGreaterThanOrEqual(NEXT_MIDNIGHT);
    expect(['MONITORING', 'RECOMMENDATION_READY', 'NEEDS_REVIEW']).toContain(c.state);
    expect(JSON.stringify(c.memory.hypotheses)).toContain('Turbo backorder at the dealer');

    s.ck.t = NEXT_MIDNIGHT + H;
    F.cs.requeueCases({ caseIds: [caseId], trigger: 'ai_capacity', now: s.ck.now() });
    const r2 = await inv(caseId, { reason, cfgOver: { ai: { dailyCap: 1 } }, trigger: 'ai_capacity' });
    expect(r2.aiStatus).toBe('ok');
    expect(reason.prompts[1]).toContain('Turbo backorder at the dealer');
    expect(caseOf(caseId)).toMatchObject({ ai_pending_reason: null });
  });

  it('finding 5: a cap-deferred case gets ai_retry_at >= next local midnight with multiTurn on and off', async () => {
    for (const multiTurn of [true, false]) {
      setup();
      const { caseId } = F.seedCase();
      const reason = multiTurn ? F.fakePlanner([finalFrom]) : F.okReason();
      const r = await inv(caseId, { reason, cfgOver: { features: { liveReads: true, multiTurn }, dailyCap: 0, ai: { dailyCap: 0 } } });
      expect(r.aiStatus, String(multiTurn)).toBe('skipped_cap');
      expect(reason.calls.length).toBe(0);
      const c = caseOf(caseId);
      expect(c.ai_retry_at).toBeGreaterThanOrEqual(NEXT_MIDNIGHT);
      expect(c.ai_retry_at).toBeLessThanOrEqual(NEXT_MIDNIGHT + 30 * MIN);
      expect(c).toMatchObject({ ai_pending_reason: 'cap', ai_investigated_at: null });
      expect(c.recommendation).toBeTruthy();
    }
  });
});

describe('AC-37: a conflict only a tool revealed is disclosed', () => {
  const conflictRecord = (caseId) => F.cs.getRecord(caseId).record.conflicts.map((g) => g.group);
  const liveDecisivId = (caseId) => F.cs.getCase(caseId).findings.find((f) => f.source === 'decisiv' && f.field === 'stage' && /ready/.test(f.value_text)).evidence_id;

  it('fallback (inconclusive stop): stored output conflicts and ap_record conflicts include the Decisiv-vs-DTNA group', async () => {
    const { caseId } = F.seedCase();
    const reason = F.fakePlanner([turn([tool('decisiv_activity')]), turn([]), turn([])]);
    const r = await inv(caseId, { reason });
    expect(r.aiStatus).toBe('inconclusive');
    const c = caseOf(caseId);
    expect(c.ai_findings.generatedBy).toBe('deterministic');
    const id = liveDecisivId(caseId);
    expect(c.ai_findings.conflicts.some((x) => x.evidenceIds.includes(id))).toBe(true);
    expect(conflictRecord(caseId)).toContain('cf_repairStatus');
    expect(c).toMatchObject({ ai_pending_reason: null, ai_investigated_at: s.ck.now() });
    expect(c.ai_fp).toBe(c.evidence_fp);
    expect(c.state).not.toBe('NEEDS_REVIEW');           // the state rule stays on the base pack
  });

  it('AI final: the stored output and ap_record conflicts include the group', async () => {
    const { caseId } = F.seedCase();
    const reason = F.fakePlanner([turn([tool('decisiv_activity')]), finalFrom]);
    const r = await inv(caseId, { reason });
    expect(r.aiStatus).toBe('ok');
    const c = caseOf(caseId);
    expect(c.ai_findings.generatedBy).toBe('ai');
    const id = liveDecisivId(caseId);
    expect(c.ai_findings.conflicts.some((x) => x.evidenceIds.includes(id))).toBe(true);
    expect(conflictRecord(caseId)).toContain('cf_repairStatus');
  });
});

describe('equipment re-check and unchanged-path priority', () => {
  it('a unit that became a trailer -> PAUSED not_power_unit; an unknown type -> PAUSED type_unverified; no evidence read', async () => {
    s.world.rows[0] = F.baseRow({ assetType: 'Trailer', bodyType: 'Dry Van' });
    const a = F.seedCase();
    const r = await inv(a.caseId, { reason: F.okReason() });
    expect(r).toMatchObject({ outcome: 'paused', state: 'PAUSED' });
    expect(caseOf(a.caseId).pause_reason).toBe('not_power_unit');
    expect(s.world.calls.slack).toBe(0);
    setup();
    s.world.rows[0] = F.baseRow({ assetType: '' });
    const b = F.seedCase();
    await inv(b.caseId, { reason: F.okReason() });
    expect(caseOf(b.caseId)).toMatchObject({ state: 'PAUSED', pause_reason: 'type_unverified' });
  });

  it('the unchanged path writes priority with scoreV2 (operational band 55..79, never 100)', async () => {
    const { caseId } = F.seedCase('322283', { daysDown: 40 });
    await inv(caseId, { reason: F.okReason(), cfgOver: { features: { liveReads: true, multiTurn: false } } });
    s.ck.advance(30 * MIN);
    F.cs.requeueCases({ caseIds: [caseId], trigger: 'manual', now: s.ck.now() });
    const r = await inv(caseId, { reason: F.okReason(), trigger: 'manual', cfgOver: { features: { liveReads: true, multiTurn: false } } });
    expect(r.outcome).toBe('unchanged');
    const p = caseOf(caseId).priority;
    expect(p).toBeGreaterThanOrEqual(55);
    expect(p).toBeLessThanOrEqual(79);
  });
});
