import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-phase1-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/ai/tools');
const { Budget } = require('../src/ai/budget');
const loop = require('../src/ai/agent-loop');
const profiles = require('../src/orcha/fas/sender-profiles');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', riskScore: 30, pmB: '2026-09-20' },
    { equipmentId: '59083', operator: 'AGNLI', domicileSite: 'AVP40', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', vendor: 'Kenworth', workDuration: '5d', riskScore: 82 },
  ] });
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Internal', org: 'Amazon', email: 'x@amazon.com' },
    { type: 'slack', slackId: 'U_TUZR', name: 'TTR Carrier', operators: ['TUZR'], domiciles: 'ABE40' },
  ]);
  store.save('slackSenderProfiles', {});
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Phase 1 — normalized tool platform (spec §2/§3)', () => {
  it('lists a catalog with the required metadata fields', () => {
    const list = tools.list();
    expect(list.length).toBeGreaterThan(5);
    const unit = list.find((t) => t.name === 'get_unit');
    expect(unit).toBeTruthy();
    ['description', 'inputSchema', 'outputSchema', 'risk', 'requiredPermission', 'freshnessPolicy'].forEach((k) => expect(unit).toHaveProperty(k));
    expect(unit.risk).toBe('read');
  });

  it('execute returns a normalized provenance envelope', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const env = await tools.execute('get_unit', { unit: '321060' }, ctx);
    expect(env.ok).toBe(true);
    expect(env.tool).toBe('get_unit');
    expect(env.entity).toBe('321060');
    expect(env.source).toBeTruthy();
    expect(env.retrievedAt).toBeTruthy();
    expect(['LIVE', 'RECENT', 'STALE', 'UNKNOWN']).toContain(env.freshness);
    expect(typeof env.confidence).toBe('number');
    expect(Array.isArray(env.data.facts)).toBe(true);
    const lc = env.data.facts.find((f) => f.field === 'lifecycleState');
    expect(lc.value).toBe('Unavailable');
    expect(lc.source).toBeTruthy();
  });

  it('PRESERVES FAS permission scoping — a carrier is denied an out-of-scope unit', async () => {
    const ctx = { profile: profiles.resolveSender('U_TUZR') }; // TUZR/ABE40 only
    const env = await tools.execute('get_unit', { unit: '59083' }, ctx); // AGNLI/AVP40
    expect(env.ok).toBe(false);
    expect(env.denied).toBe(true);
  });

  it('rejects an unknown tool name', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const env = await tools.execute('drop_table', {}, ctx);
    expect(env.ok).toBe(false);
  });

  it('requires a sender profile for scoping', async () => {
    const env = await tools.execute('get_unit', { unit: '321060' }, {});
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/profile/i);
  });
});

describe('Phase 1 — request budget (spec §1)', () => {
  it('enforces maxToolCalls', () => {
    const b = new Budget({ maxToolCalls: 2 });
    expect(b.canCallTool()).toBe(true); b.countToolCall();
    expect(b.canCallTool()).toBe(true); b.countToolCall();
    expect(b.canCallTool()).toBe(false);
    expect(b.summary().stops).toContain('maxToolCalls');
  });
  it('enforces maxModelTurns', () => {
    const b = new Budget({ maxModelTurns: 1 });
    expect(b.canModelTurn()).toBe(true); b.countModelTurn();
    expect(b.canModelTurn()).toBe(false);
  });
  it('enforces maxEvidenceBytes', () => {
    const b = new Budget({ maxEvidenceBytes: 100 });
    expect(b.addEvidenceBytes(80)).toBe(true);
    expect(b.addEvidenceBytes(40)).toBe(false);
    expect(b.canCallTool()).toBe(false);
  });
});

describe('Phase 1 — bounded multi-step tool loop (spec §1)', () => {
  const profile = () => profiles.resolveSender('U_INT');

  it('performs multi-round tool calling then returns a final decision', async () => {
    const calls = [];
    // Planner: turn 1 ask get_unit; turn 2 (after seeing it) ask WO + timeline;
    // turn 3 give final. Demonstrates request-as-needed, not pre-dumping.
    const planner = async (state) => {
      calls.push(state.turn);
      if (state.turn === 1) return { decision: 'request_tools', tools: [{ tool: 'get_unit', args: { unit: '321060' } }] };
      if (state.turn === 2) return { decision: 'request_tools', tools: [
        { tool: 'get_open_work_orders', args: { unit: '321060' } },
        { tool: 'get_repair_timeline', args: { unit: '321060' } },
      ] };
      return { decision: 'final', result: { answer: '321060 is in shop at Amerit with an open WR.' } };
    };
    const res = await loop.run({ request: { message: 'whats up with 321060?' }, profile: profile(), planner });
    expect(res.ok).toBe(true);
    expect(res.result.answer).toMatch(/321060/);
    expect(res.budget.toolCalls).toBe(3);   // 1 + 2
    expect(res.budget.modelTurns).toBe(3);
    // Evidence carries provenance for each tool.
    expect(res.evidence.every((e) => e.tool && e.freshness)).toBe(true);
  });

  it('bounds the loop — a planner that always asks for tools stops at maxToolCalls', async () => {
    const planner = async () => ({ decision: 'request_tools', tools: [{ tool: 'get_unit', args: { unit: '321060' } }] });
    const res = await loop.run({ request: {}, profile: profile(), planner, budget: { maxToolCalls: 3, maxModelTurns: 10 } });
    expect(res.budget.toolCalls).toBeLessThanOrEqual(3);
    expect(res.stopped).toBeTruthy();
    // Dedupe means the same tool+args only executes once; the loop still halts.
  });

  it('runs independent tools in one turn concurrently (bounded)', async () => {
    const planner = async (state) => {
      if (state.turn === 1) return { decision: 'request_tools', tools: [
        { tool: 'get_open_work_orders', args: { unit: '321060' } },
        { tool: 'get_pm_status', args: { unit: '321060' } },
        { tool: 'get_uptake_insights', args: { unit: '321060' } },
      ] };
      return { decision: 'final', result: { ok: true } };
    };
    const res = await loop.run({ request: {}, profile: profile(), planner, concurrency: 3 });
    expect(res.budget.toolCalls).toBe(3);
    expect(res.evidence.filter((e) => e.ok).length).toBe(3);
  });

  it('honors an abort signal and stops cleanly with evidence so far', async () => {
    const controller = new AbortController();
    const planner = async (state) => {
      if (state.turn === 1) return { decision: 'request_tools', tools: [{ tool: 'get_unit', args: { unit: '321060' } }] };
      controller.abort();
      return { decision: 'request_tools', tools: [{ tool: 'get_pm_status', args: { unit: '321060' } }] };
    };
    const res = await loop.run({ request: {}, profile: profile(), planner, signal: controller.signal });
    expect(res.stopped).toBe('aborted');
    expect(res.evidence.length).toBeGreaterThanOrEqual(1); // kept what it gathered
  });

  it('rejects an unknown tool requested by the planner (reported as data, not executed)', async () => {
    const planner = async (state) => {
      if (state.turn === 1) return { decision: 'request_tools', tools: [{ tool: 'rm_rf_fleet', args: {} }] };
      return { decision: 'final', result: { ok: true } };
    };
    const res = await loop.run({ request: {}, profile: profile(), planner });
    const bad = res.toolLog.find((t) => t.tool === 'rm_rf_fleet');
    expect(bad.ok).toBe(false);
  });

  it('requires a resolved profile (never runs tools without one)', async () => {
    const planner = async () => ({ decision: 'final', result: {} });
    const res = await loop.run({ request: {}, planner });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/profile/i);
  });
});
