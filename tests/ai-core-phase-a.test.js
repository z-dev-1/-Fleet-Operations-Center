import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Isolate the data dir so we never touch real app data.
const tmpDir = path.join(os.tmpdir(), 'ai-core-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const schemas = require('../src/ai/schemas');
const trace = require('../src/ai/trace');
const aiCore = require('../src/ai/core');
const profiles = require('../src/orcha/fas/sender-profiles');
const fasConfig = require('../src/orcha/fas/config');

// Same fleet/contacts fixture shape used by the FAS stage tests.
function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', riskScore: 30, assetType: 'tractor' },
    { equipmentId: '59083', operator: 'AGNLI', domicileSite: 'AVP40', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', vendor: 'Kenworth', workDuration: '5d', riskScore: 82, assetType: 'tractor' },
  ] });
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Internal Person', org: 'Amazon', email: 'x@amazon.com' },
    { type: 'slack', slackId: 'U_TUZR', name: 'TTR Carrier', operators: ['TUZR'], domiciles: 'ABE40' },
  ]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('aiTraceLog', []);
  // Keep FAS disabled by default (its real config) so handleInbound tests are
  // deterministic without a live AI relay.
  fasConfig.save({ enabled: false, mode: 'shadow' });
}

beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// ── schemas.js (spec #7) ─────────────────────────────────────────────────────
describe('AI Core — structured output schema', () => {
  it('validates a well-formed FAS-shaped decision', () => {
    const d = { decision: 'answer', confidence: 0.9, reason: 'ok', reply: '320160 is in shop.', actions: [], followUp: { required: false } };
    const v = schemas.validateDecision(d);
    expect(v.ok).toBe(true);
  });

  it('rejects an invalid decision type and missing reply', () => {
    const v = schemas.validateDecision({ decision: 'frobnicate' });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('repairs a recoverable output ONCE (coerces/clamps/drops garbage)', () => {
    const r = schemas.repairDecision({ decision: 'answer', confidence: 5, reply: 'hello', actions: [{}, { tool: 'ADD_TIMELINE', args: { unit: '320160', entry: 'x' } }] });
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.decision.confidence).toBe(1);             // clamped
    expect(r.decision.actions).toHaveLength(1);         // malformed {} dropped
    expect(r.decision.actions[0].tool).toBe('ADD_TIMELINE');
  });

  it('fails SAFE when output cannot be repaired into a usable reply', () => {
    const out = schemas.validateOrRepair({ decision: 'answer', reply: '' });
    expect(out.ok).toBe(false);
    expect(out.failSafe).toBe(true);
    expect(out.decision._failSafe).toBe(true);
    expect(out.decision.actions).toEqual([]);           // never executes from invalid output
  });
});

// ── trace.js (spec #9) ───────────────────────────────────────────────────────
describe('AI Core — structured trace', () => {
  it('records an operational trace with tools/evidence/latency and no chain-of-thought', () => {
    const tr = trace.start({ source: 'slack_dm', actor: { slackId: 'U_INT', name: 'Internal', type: 'internal' }, taskType: 'unit_status' });
    tr.addTools(['GET_UNIT', 'GET_OPEN_WORK_ORDERS'])
      .addEvidenceSource('fleetData', 'RECENT')
      .setValidation(true, false)
      .setOutcome('answer')
      .finish();
    const recent = trace.recent(5);
    expect(recent.length).toBe(1);
    const rec = recent[0];
    expect(rec.source).toBe('slack_dm');
    expect(rec.tools).toContain('GET_UNIT');
    expect(rec.evidenceSources).toContain('fleetData');
    expect(typeof rec.latencyMs).toBe('number');
    // Trace must NOT carry prompts/reasoning fields.
    expect(rec).not.toHaveProperty('prompt');
    expect(rec).not.toHaveProperty('reasoning');
    expect(rec).not.toHaveProperty('chainOfThought');
  });

  it('folds FAS decision telemetry (tools, evidence sources, action proposals)', () => {
    const tr = trace.start({ source: 'slack_dm', actor: { slackId: 'U_INT' } });
    tr.foldDecision({
      decision: 'act',
      reply: 'Proposing a flip.',
      actions: [{ tool: 'MOVE_UNIT', args: { unit: '320160', state: 'Active' } }],
      _loop: { research: [{ tool: 'GET_UNIT' }] },
      _evidence: { sources: ['fleetData'], verifiedFacts: [{ field: 'lifecycleState', source: 'AAP', stale: false }] },
    });
    tr.finish();
    const rec = trace.recent(1)[0];
    expect(rec.tools).toContain('GET_UNIT');
    expect(rec.actionProposals).toContain('MOVE_UNIT');
    expect(rec.evidenceSources).toContain('fleetData');
  });

  it('attaches an operator correction to an existing trace', () => {
    const tr = trace.start({ source: 'ui', actor: { slackId: 'U_INT' } });
    tr.finish();
    const id = tr.requestId;
    expect(trace.attachCorrection(id, { verdict: 'incorrect', note: 'wrong unit' })).toBe(true);
    const rec = trace.recent(1)[0];
    expect(rec.correction.verdict).toBe('incorrect');
  });
});

// ── core.js (spec #1, #8 parity) ─────────────────────────────────────────────
describe('AI Core — unified run() facade', () => {
  // A deterministic fake agent so we exercise AiCore WITHOUT a live AI relay.
  // We monkeypatch the loaded FAS agent module's runAgent for the duration.
  const fasAgent = require('../src/orcha/fas/agent');
  let origRunAgent;
  beforeEach(() => { origRunAgent = fasAgent.runAgent; });
  afterEach(() => { fasAgent.runAgent = origRunAgent; });

  it('routes a request through the FAS agent and returns a standardized decision', async () => {
    let captured = null;
    fasAgent.runAgent = async (input) => {
      captured = input;
      return {
        decision: 'answer', confidence: 0.88, reason: 'sourced', reply: '320160 is in the shop at Amerit.',
        actions: [], followUp: { required: false },
        _evidence: { entities: { units: ['320160'] }, sources: ['fleetData'], verifiedFacts: [{ field: 'lifecycleState', value: 'Unavailable', source: 'AAP', retrievedAt: new Date().toISOString(), stale: false }], missingFacts: [], conflicts: [] },
        _loop: { research: [{ tool: 'GET_UNIT' }] },
      };
    };
    const res = await aiCore.run({
      actor: { slackId: 'U_INT', name: 'Internal Person', type: 'internal' },
      source: 'slack_dm',
      message: 'any update on 320160?',
    });
    expect(res.ok).toBe(true);
    expect(res.decision.decision).toBe('answer');
    expect(res.decision.answer).toMatch(/320160/);
    expect(res.decision.entities.units).toContain('320160');
    expect(res.decision.proposedActions).toEqual([]);   // AiCore proposes only; nothing executed
    // The agent received the sender identity for FAS to resolve permissions.
    expect(captured.slackId).toBe('U_INT');
    // A trace was recorded.
    const rec = trace.recent(1)[0];
    expect(rec.source).toBe('slack_dm');
    expect(rec.requestId).toBe(res.requestId);
  });

  it('surfaces proposed actions WITHOUT executing them (AI proposes, FAS executes)', async () => {
    fasAgent.runAgent = async () => ({
      decision: 'act', confidence: 0.8, reason: 'healthy', reply: 'I can flip 320160.',
      actions: [{ tool: 'MOVE_UNIT', args: { unit: '320160', state: 'Active', reason: 'Healthy' } }],
      _evidence: { entities: { units: ['320160'] }, sources: ['fleetData'], verifiedFacts: [], missingFacts: [], conflicts: [] },
      _loop: { research: [] },
    });
    const before = store.load('fleetData', {}).rows.find(r => r.equipmentId === '320160').lifecycleState;
    const res = await aiCore.run({ actor: { slackId: 'U_INT', type: 'internal' }, source: 'slack_dm', message: 'flip 320160' });
    expect(res.decision.proposedActions[0].type).toBe('MOVE_UNIT');
    expect(res.decision.requiresApproval).toBe(true);
    // Nothing was mutated by AiCore.
    const after = store.load('fleetData', {}).rows.find(r => r.equipmentId === '320160').lifecycleState;
    expect(after).toBe(before);
  });

  it('fails SAFE on an empty/invalid agent reply (no actions executed)', async () => {
    fasAgent.runAgent = async () => ({ decision: 'answer', reply: '', actions: [{ tool: 'MOVE_UNIT', args: { unit: '320160', state: 'Active' } }], _evidence: {}, _loop: {} });
    const res = await aiCore.run({ actor: { slackId: 'U_INT', type: 'internal' }, source: 'slack_dm', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.failSafe).toBe(true);
    expect(res.decision.proposedActions).toEqual([]);   // fail-safe drops proposals
  });

  it('PERMISSION PARITY (spec #8): AiCore passes the SAME resolved profile the app uses and never widens it', async () => {
    // The authoritative profile resolved by the app for an unknown sender.
    const appProfile = profiles.resolveSender('U_NOBODY', 'Nobody');
    let seenInput = null;
    fasAgent.runAgent = async (input) => {
      seenInput = input;
      // Re-resolve inside the agent exactly as production does.
      const resolved = profiles.resolveSender(input.slackId, input.senderName);
      // Parity invariant: AiCore did not change identity or widen permissions.
      expect(resolved.type).toBe(appProfile.type);
      expect(resolved.lifecyclePermission).toBe(appProfile.lifecyclePermission);
      expect(resolved.createWrPermission).toBe(appProfile.createWrPermission);
      expect(profiles.canRequest(resolved, 'lifecycle_change')).toBe(profiles.canRequest(appProfile, 'lifecycle_change'));
      return { decision: 'clarify', confidence: 0.3, reason: 'who', reply: 'Which unit?', actions: [], _evidence: {}, _loop: {} };
    };
    await aiCore.run({
      actor: { slackId: 'U_NOBODY', name: 'Nobody' },
      source: 'slack_dm',
      message: 'flip something',
      // A hostile caller tries to inject elevated permissions — must be ignored.
      permissions: { lifecyclePermission: 'trusted_autonomous', type: 'internal' },
    });
    expect(seenInput.slackId).toBe('U_NOBODY');
    // AiCore does NOT forward the injected permissions object to the agent.
    expect(seenInput).not.toHaveProperty('permissions');
  });
});

// ── handleInbound() delegates to the real runner (spec migration seam) ───────
describe('AI Core — handleInbound delegates to FAS runner', () => {
  it('when FAS is disabled, returns letLegacyReply:true (behavior parity) and records a trace', async () => {
    const res = await aiCore.handleInbound({
      actor: { slackId: 'U_INT', name: 'Internal Person' },
      source: 'slack_dm',
      message: 'any update on 320160?',
      metadata: { channelId: 'D1', ts: '100.1' },
    });
    expect(res.letLegacyReply).toBe(true);     // same as runner.handleInbound when disabled
    expect(res.mode).toBe('disabled');
    expect(res.requestId).toBeTruthy();
    const rec = trace.recent(1)[0];
    expect(rec.requestId).toBe(res.requestId);
  });
});
