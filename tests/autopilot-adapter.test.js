// tests/autopilot-adapter.test.js — Autopilot V2 §6.3 multi-turn investigation adapter, unit level with a
// real temp SQLite (F.freshDb) and F.fakePlanner, w.isolated = true (AC-8, 9, 19, 21, 37, 38).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('./helpers/autopilot-fakes.cjs');
const cs = F.cs;
const adapter = require('../src/autopilot/agent-adapter');
const evidence = require('../src/autopilot/evidence');
const { analyze } = require('../src/autopilot/analyze');
const { createLimiter } = require('../src/autopilot/limiter');
const { aiBusy } = require('../src/autopilot/investigate');

const OWNER = 'own#ab12';
const U = '322283';
const SYNC = new Date(F.T0 - F.H).toISOString();

let caseId;
let runId;
let w;
let row;

beforeEach(() => {
  F.freshDb('adapter');
  expect(F.schema.ensureSchema()).toBe(true);
  caseId = F.seedCase(U).caseId;
  expect(cs.leaseRun(caseId, OWNER, F.T0 + F.H, { now: F.T0 })).toBe(true);
  runId = cs.openRun({ caseId, trigger: 'test', now: F.T0 });
  row = F.baseRow({ asistSrUrl: F.SR, decisivCaseId: '21350186', fullConversation: '10/01 - Vendor: old note' });
  w = F.mkWorld({
    rows: [row], isolated: true,
    dtna: { [U]: [{ caseId: 'C1', unitId: U, offsiteStage: 'repair', stageSince: '2026-11-18T00:00:00Z', repairEtc: '2026-11-25' }] },
    decisivStatus: () => ({ ok: true, value: { stage: 'ready', status: 'open' } }),
  });
  w.docs.decisivCaseCache = { 21350186: { estimateId: '21350186', stage: 'repair', scrapedAt: new Date(F.T0 - 24 * F.H).toISOString() } };
  w.docs.notesStore = { [U]: { timeline: '11/18 - Vendor: turbo on order\n11/19 - Typed note', manualEntries: ['11/19 - Typed note'] } };
});
afterEach(() => { vi.useRealTimers(); });

async function basePack() {
  return evidence.collect({ sources: [], bySource: {} }, F.fakePorts(w), null, null, { row, now: F.T0, syncedAt: SYNC, buildAtMs: F.T0 - F.H, staleDays: 3, isDown: true, docs: w.docs });
}
async function input(over) {
  const o = over || {};
  const rec = cs.getCase(caseId).case;
  const pack = o.basePack || await basePack();
  const cfg = o.cfg || F.cfgOf({ features: { liveReads: true, multiTurn: true } });
  return Object.assign({
    caseId, runId, rec, row, basePack: pack, analysis: analyze(pack, rec, { row, syncedAt: SYNC, now: F.T0 }), cfg,
    ports: F.fakePorts(w), limiter: createLimiter({}), signal: null, now: () => F.T0, leaseOwner: OWNER, leaseUntilFn: () => F.T0 + F.H,
    caseStore: cs, reason: o.reason, aiBusy, resume: null, deep: false, docs: w.docs, priorCases: [], syncedAt: SYNC, buildAtMs: F.T0 - F.H,
    staleDays: 3, isDown: true,
  }, o.extra || {});
}
const turn = (tools, memory) => ({ schemaVersion: 2, decision: 'request_tools', tools, memory: memory || {} });
const tool = (name, args) => ({ tool: name, args: Object.assign({ unit: U }, args || {}), why: 'check ' + name });
const finalFrom = (prompt) => ({ schemaVersion: 2, decision: 'final', result: F.aiReply(prompt) });
const ids = (p, re) => [...String(p).matchAll(re)].map((m) => m[1]);
const steps = () => cs.stepsForRun(runId);

describe('runAgentInvestigation', () => {
  it('scripted dtna -> decisiv -> final: 3 model + 2 preload + 2 tool steps, ids carried across prompts, tool-only conflict disclosed', async () => {
    const reason = F.fakePlanner([
      turn([tool('dtna_case')], { hypotheses: [{ statement: 'Waiting on the turbo', confidence: 0.5 }] }),
      turn([tool('decisiv_activity')]),
      (o) => finalFrom(o.prompt),
    ]);
    const res = await adapter.runAgentInvestigation(await input({ reason }));
    expect(res.status).toBe('concluded');
    expect(res.output.generatedBy).toBe('ai');
    const st = steps();
    expect(st.filter((s) => s.kind === 'model').length).toBe(3);
    expect(st.filter((s) => s.kind === 'tool' && s.turn === 0).map((s) => s.tool)).toEqual(['existing_timeline', 'previous_findings']);
    expect(st.filter((s) => s.kind === 'tool' && s.turn > 0).map((s) => [s.tool, s.status])).toEqual([['dtna_case', 'ok'], ['decisiv_activity', 'ok']]);
    expect(st.filter((s) => s.kind === 'final').map((s) => s.status)).toEqual(['final']);
    for (const s of st) { expect(s.run_id).toBe(runId); expect(s.case_id).toBe(caseId); }
    expect(st.map((s) => s.seq)).toEqual(st.map((_, k) => k + 1));
    // timeline ids in prompt 1; tool-1 (dtna) ids in prompt 2.
    const tlIds = ids(reason.prompts[0], /\[(ev_[a-f0-9_]+)\] timeline observed/g);
    expect(tlIds.length).toBe(2);
    const dtnaStep = st.find((s) => s.tool === 'dtna_case');
    const dtnaIds = cs.findingsForStep(dtnaStep.step_id).map((f) => f.evidenceId);
    expect(dtnaIds.length).toBeGreaterThan(0);
    for (const id of dtnaIds) { expect(reason.prompts[0]).not.toContain(id); expect(reason.prompts[1]).toContain(id); }
    for (const c of reason.calls) { expect(c).toMatchObject({ isolated: true, priority: 'low', source: 'autopilot' }); expect(c.requestId).toMatch(new RegExp('^ap-' + runId + '-\\d+$')); }
    // memory saved with the hypothesis; the cache 'repair' vs live 'ready' conflict exists only through the tool.
    expect(JSON.stringify(cs.getCase(caseId).case.memory)).toContain('Waiting on the turbo');
    expect(res.conflicts.groups.map((g) => g.group)).toContain('cf_repairStatus');
    expect(res.evidenceItems.some((it) => it.source === 'decisiv' && it.live)).toBe(true);
    expect(res).toMatchObject({ aiCalls: 3, turns: 3, lane: 'isolated', isolated: true });
    expect(w.calls.decisivStatus).toBe(1);
  });

  it('a model request for existing_timeline is deduplicated against the preload; a repeated request is SKIPPED DUPLICATE', async () => {
    const reason = F.fakePlanner([turn([tool('existing_timeline'), tool('dtna_case')]), turn([tool('dtna_case', { unit: '322283 ' })]), (o) => finalFrom(o.prompt)]);
    const res = await adapter.runAgentInvestigation(await input({ reason }));
    expect(res.status).toBe('concluded');
    const t = steps().filter((s) => s.kind === 'tool' && s.turn > 0).map((s) => [s.tool, s.status, s.code]);
    expect(t).toEqual([['existing_timeline', 'skipped', 'DUPLICATE'], ['dtna_case', 'ok', null], ['dtna_case', 'skipped', 'DUPLICATE']]);
  });

  it('no_progress: two turns without an executed tool', async () => {
    const reason = F.fakePlanner([turn([]), turn([])]);
    const res = await adapter.runAgentInvestigation(await input({ reason }));
    expect(res).toMatchObject({ status: 'stopped', stopCode: 'no_progress' });
    expect(steps().filter((s) => s.kind === 'stop').map((s) => s.code)).toEqual(['no_progress']);
  });

  it('planner_invalid: two invalid answers in a row; ai_timeout for two timeouts', async () => {
    let res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([{ schemaVersion: 3 }, { schemaVersion: 2, decision: 'maybe' }]) }));
    expect(res.stopCode).toBe('planner_invalid');
    expect(steps().filter((s) => s.kind === 'model').map((s) => [s.status, s.code])).toEqual([['invalid', 'invalid_schema'], ['invalid', 'invalid_decision']]);
    runId = cs.openRun({ caseId, trigger: 'test', now: F.T0 });
    res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([{ __error: 'reason-timeout' }, { __error: 'reason-timeout' }]) }));
    expect(res.stopCode).toBe('ai_timeout');
  });

  it('tier maxModelTurns: a simple case stops after 2 turns', async () => {
    const reason = F.fakePlanner([turn([tool('dtna_case')]), turn([tool('estimates')]), turn([tool('wo_history')])]);
    const inp = await input({ reason });
    inp.analysis = Object.assign({}, inp.analysis, { reasons: ['REPAIRED_UNVERIFIED'], conflictGroups: [], untrustedNewer: false });
    const res = await adapter.runAgentInvestigation(inp);
    expect(res).toMatchObject({ status: 'stopped', stopCode: 'maxModelTurns', tier: 'simple', aiCalls: 2 });
  });

  it('maxEvidenceBytes: rejected requests leave BUDGET_* skipped steps and the run stops', async () => {
    const cfg = F.cfgOf({ features: { liveReads: true, multiTurn: true } });
    cfg.complexityTiers = Object.assign({}, cfg.complexityTiers, { complex: Object.assign({}, cfg.complexityTiers.complex, { maxEvidenceBytes: 50 }) });
    const reason = F.fakePlanner([turn([tool('dtna_case'), tool('estimates')])]);
    const res = await adapter.runAgentInvestigation(await input({ reason, cfg }));
    expect(res).toMatchObject({ status: 'stopped', stopCode: 'maxEvidenceBytes' });
    expect(steps().filter((s) => s.kind === 'tool' && s.turn > 0).map((s) => [s.status, s.code])).toEqual([['skipped', 'BUDGET_maxEvidenceBytes'], ['skipped', 'BUDGET_maxEvidenceBytes']]);
    expect(w.calls.decisivStatus).toBe(0);
  });

  it('maxElapsedMs on a resume: the carried elapsed time plus the turn passes the tier limit (vi.setSystemTime)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(F.T0);
    const reason = F.fakePlanner([() => { vi.setSystemTime(F.T0 + 5000); return turn([tool('dtna_case')]); }, (o) => finalFrom(o.prompt)]);
    const res = await adapter.runAgentInvestigation(await input({ reason, extra: { resume: { steps: [], turnsUsed: 1, toolsUsed: 0, bytesUsed: 0, elapsedUsedMs: 420000 - 2000, liveDone: [] } } }));
    expect(res).toMatchObject({ status: 'stopped', stopCode: 'maxElapsedMs' });
    expect(reason.calls.length).toBe(1);
  });

  it('simple -> standard promotion once compare_conflicting_status finds a conflict', async () => {
    const pack = await basePack();
    const col = evidence.createCollector({ now: F.T0 }, { knownItems: pack.items });
    col.add('dtna', 'offsiteStage', 'repair', { entry: { stageSince: '2026-11-18T00:00:00Z' } }, { sourceRef: 'dtna/C1' });
    col.add('decisiv', 'stage', 'ready', { entry: { since: '2026-11-18T00:00:00Z' }, retrievedAt: F.T0 }, { sourceRef: 'decisiv/21350186' });
    pack.items = pack.items.concat(col.items);
    const reason = F.fakePlanner([turn([tool('compare_conflicting_status')]), turn([tool('dtna_case')]), (o) => finalFrom(o.prompt)]);
    const inp = await input({ reason, basePack: pack });
    inp.analysis = Object.assign({}, inp.analysis, { reasons: ['REPAIRED_UNVERIFIED'], conflictGroups: [], untrustedNewer: false });
    const res = await adapter.runAgentInvestigation(inp);
    expect(res.tier).toBe('standard');
    expect(res.status).toBe('concluded');
    expect(res.aiCalls).toBe(3);
  });

  it('ai_unavailable: backends down (no reason call, no reservation) or a relay failure', async () => {
    w.aiStatus = { model: 'm', backends: { claude: false } };
    const reason = F.fakePlanner([turn([])]);
    let res = await adapter.runAgentInvestigation(await input({ reason }));
    expect(res.stopCode).toBe('ai_unavailable');
    expect(reason.calls.length).toBe(0);
    expect(cs.getMeta('ai_calls:' + require('../src/autopilot/constants').localDate(F.T0))).toBe(null);
    w.aiStatus = { model: 'm', backends: { claude: true } };
    runId = cs.openRun({ caseId, trigger: 'test', now: F.T0 });
    res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([{ __error: 'relay-down' }]) }));
    expect(res.stopCode).toBe('ai_unavailable');
  });

  it('ai_busy; an own in-flight Autopilot call is not ai_busy (adjustQueueForOwn)', async () => {
    w.aiQueue = { active: 0, waiting: 1, max: 4, reserve: 1, byPriority: {}, flags: { priorities: false } };
    let res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([turn([])]) }));
    expect(res.stopCode).toBe('ai_busy');
    expect(steps().filter((s) => s.kind === 'model').length).toBe(0);
    let release;
    const own = adapter.trackAiCall(() => new Promise((r) => { release = r; }));
    expect(adapter.aiInFlight()).toBe(1);
    runId = cs.openRun({ caseId, trigger: 'test', now: F.T0 });
    res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([(o) => finalFrom(o.prompt)]) }));
    expect(res.status).toBe('concluded');
    release();
    await own;
    expect(adapter.aiInFlight()).toBe(0);
    expect(adapter.adjustQueueForOwn({ waiting: 1, active: 2, byPriority: { low: 1 } }, 2)).toEqual({ waiting: 0, active: 1, byPriority: { low: 1 } });
  });

  it('ai_cap mid-loop: the second reservation fails and the memory of turn 1 is saved', async () => {
    const cfg = F.cfgOf({ features: { liveReads: true, multiTurn: true }, ai: { dailyCap: 1 } });
    const reason = F.fakePlanner([turn([tool('dtna_case')], { openQuestions: [{ question: 'Is the turbo in?', likelySource: 'vendor' }] }), turn([])]);
    const res = await adapter.runAgentInvestigation(await input({ reason, cfg }));
    expect(res).toMatchObject({ status: 'stopped', stopCode: 'ai_cap', aiCalls: 1 });
    expect(JSON.stringify(cs.getCase(caseId).case.memory)).toContain('Is the turbo in?');
  });

  it('abort while reason is pending -> model step interrupted / ABORTED, stop aborted', async () => {
    const ac = new AbortController();
    const reason = F.fakePlanner([() => { ac.abort(); return turn([tool('dtna_case')]); }]);
    const res = await adapter.runAgentInvestigation(await input({ reason, extra: { signal: ac.signal } }));
    expect(res.stopCode).toBe('aborted');
    expect(steps().filter((s) => s.kind === 'model').map((s) => [s.status, s.code])).toEqual([['interrupted', 'ABORTED']]);
    expect(steps().filter((s) => s.kind === 'tool' && s.turn > 0)).toEqual([]);
  });

  it('lane lost before turn 2 -> lane_unavailable with one reason() call', async () => {
    const reason = F.fakePlanner([() => { w.isolated = false; return turn([tool('dtna_case')]); }, (o) => finalFrom(o.prompt)]);
    const res = await adapter.runAgentInvestigation(await input({ reason }));
    expect(res.stopCode).toBe('lane_unavailable');
    expect(reason.calls.length).toBe(1);
  });

  it('resume: an interrupted live step is not re-issued (INTERRUPTED_LIVE_NOT_REISSUED); an interrupted cache step runs again', async () => {
    const resume = { steps: [
      { kind: 'tool', seq: 3, tool: 'decisiv_activity', args: { unit: U }, status: 'interrupted', live: 1 },
      { kind: 'tool', seq: 4, tool: 'dtna_case', args: { unit: U }, status: 'interrupted', live: 0 },
      { kind: 'tool', seq: 1, tool: 'existing_timeline', args: { unit: U }, status: 'ok', live: 0 },
    ], turnsUsed: 1, toolsUsed: 0, bytesUsed: 0, elapsedUsedMs: 0, liveDone: [] };
    const reason = F.fakePlanner([turn([tool('decisiv_activity'), tool('dtna_case')]), (o) => finalFrom(o.prompt)]);
    const res = await adapter.runAgentInvestigation(await input({ reason, extra: { resume } }));
    expect(res.status).toBe('concluded');
    const t = steps().filter((s) => s.kind === 'tool');
    expect(t.map((s) => s.tool)).toEqual(['previous_findings', 'decisiv_activity', 'dtna_case']);   // the timeline preload is not repeated
    expect(t[1]).toMatchObject({ status: 'skipped', code: 'INTERRUPTED_LIVE_NOT_REISSUED' });
    expect(t[2].status).toBe('ok');
    expect(t[0].seq).toBe(5);
    expect(w.calls.decisivStatus).toBe(0);
  });

  it('circular-only and manual-entry-only finals are invalid', async () => {
    const cite = (re) => (o) => {
      const id = ids(o.prompt, re)[0];
      return { schemaVersion: 2, decision: 'final', result: F.aiReply('', { confirmedFacts: [{ statement: 'f', evidenceIds: [id] }], inferences: [{ statement: 'i', confidence: 0.7, evidenceIds: [id] }],
        responsibleParty: { party: 'vendor', evidenceIds: [id] }, recommendedActions: [{ action: 'Keep watching', rationale: 'r', owner: 'fleet', actionClass: 'monitor', evidenceIds: [id] }], actionsRequiringApproval: [] }) };
    };
    let res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([cite(/\[(ev_[a-f0-9_]+)\] timeline observed=\S+ \(prior AI/g)]) }));
    expect(res).toMatchObject({ status: 'invalid', stopCode: 'circular_only' });
    expect(steps().find((s) => s.kind === 'final')).toMatchObject({ status: 'invalid', code: 'circular_only' });
    runId = cs.openRun({ caseId, trigger: 'test', now: F.T0 });
    res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([cite(/\[(ev_[a-f0-9_]+)\] timeline observed=\S+ \(manual/g)]) }));
    expect(res).toMatchObject({ status: 'invalid', stopCode: 'circular_only' });
  });

  it('a V1-shaped answer is accepted as the final', async () => {
    const res = await adapter.runAgentInvestigation(await input({ reason: F.fakePlanner([(o) => F.aiReply(o.prompt)]) }));
    expect(res.status).toBe('concluded');
    expect(res.output.schemaVersion).toBe(1);
  });

  it('a lease lost mid-run throws LEASE_LOST', async () => {
    const reason = F.fakePlanner([() => { F.engine.prepare('UPDATE ap_case SET lease_owner = ? WHERE case_id = ?').run('other#1', caseId); return turn([tool('dtna_case')]); }]);
    await expect(adapter.runAgentInvestigation(await input({ reason }))).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});
