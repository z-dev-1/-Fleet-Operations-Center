// tests/ai-agent-loop-core.test.js — Autopilot V2 §6.1: the agent-loop core with an injected registry
// (AC-9, AC-12, AC-34). The old loop's scenarios run through both the wrapper and the core.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const core = require('../src/ai/agent-loop-core');
const { Budget } = require('../src/ai/budget');

function fakeRegistry(over) {
  const calls = [];
  const ctxs = [];
  const reg = {
    list: () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'slow' }],
    has: (n) => ['a', 'b', 'c', 'slow'].includes(n),
    async execute(name, args, ctx) {
      calls.push({ name, args });
      ctxs.push(ctx);
      if (over && over[name]) return over[name](args, ctx);
      return { ok: true, tool: name, source: 's', freshness: 'RECENT', data: { facts: [{ field: 'f', value: name, source: name }] } };
    },
  };
  reg.calls = calls;
  reg.ctxs = ctxs;
  return reg;
}
const script = (turns) => { let k = 0; return async () => turns[Math.min(k++, turns.length - 1)]; };
const req = (tool, args) => ({ tool, args: args || {} });

afterEach(() => { vi.useRealTimers(); });

describe('agent-loop-core', () => {
  it('requires a registry and runs tools through it', async () => {
    expect((await core.run({ planner: async () => ({ decision: 'final' }) })).error).toMatch(/registry/);
    const reg = fakeRegistry();
    const res = await core.run({ registry: reg, planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'final', result: { x: 1 } }]) });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ x: 1 });
    expect(reg.calls.map((c) => c.name)).toEqual(['a']);
  });

  it('seen and keyOf: a seeded key is a duplicate; keyOf normalizes', async () => {
    const reg = fakeRegistry();
    const seen = new Set(['a:x']);
    const keyOf = (n, a) => n + ':' + String(a.u || '').toLowerCase();
    const res = await core.run({ registry: reg, seen, keyOf, planner: script([
      { decision: 'request_tools', tools: [req('a', { u: 'X' }), req('b', { u: 'Y' }), req('b', { u: 'y' })] }, { decision: 'final', result: {} }]) });
    expect(reg.calls.map((c) => c.name)).toEqual(['b']);
    expect(res.toolLog.filter((l) => /already retrieved/.test(l.error || '')).length).toBe(2);
  });

  it('toolTimeoutMs and timeoutFor race execute (fake timers) and abort toolSignal', async () => {
    vi.useFakeTimers();
    let seenSignal = null;
    const reg = fakeRegistry({ slow: (a, ctx) => { seenSignal = ctx.toolSignal; return new Promise(() => {}); } });
    const p = core.run({ registry: reg, toolTimeoutMs: 1000, timeoutFor: (n) => (n === 'slow' ? 5000 : null),
      planner: script([{ decision: 'request_tools', tools: [req('slow')] }, { decision: 'final', result: {} }]) });
    await vi.advanceTimersByTimeAsync(1500);
    expect(seenSignal.aborted).toBe(false);          // timeoutFor replaced the 1000 ms default
    await vi.advanceTimersByTimeAsync(4000);
    const res = await p;
    expect(seenSignal.aborted).toBe(true);
    expect(res.evidence[0]).toMatchObject({ ok: false, error: 'TOOL_TIMEOUT', code: 'TOOL_TIMEOUT', freshness: 'UNKNOWN', confidence: 0 });
  });

  it('runToolWithTimeout is exported and never rejects', async () => {
    const reg = fakeRegistry({ a: () => { throw new Error('boom'); } });
    const env = await core.runToolWithTimeout(reg, 'a', {}, { k: 1 }, 1000, null);
    expect(env).toMatchObject({ ok: false, tool: 'a', error: 'boom' });
  });

  it('maxToolsPerTurn slices the batch; with stopOnBudget the rest reach afterTool as TOO_MANY_PER_TURN', async () => {
    const reg = fakeRegistry();
    const after = [];
    const res = await core.run({ registry: reg, maxToolsPerTurn: 2, stopOnBudget: true, hooks: { afterTool: (r, env) => after.push([r.tool, env.status, env.code || null]) },
      planner: script([{ decision: 'request_tools', tools: [req('a'), req('b'), req('c')] }, { decision: 'final', result: {} }]) });
    expect(reg.calls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(after).toEqual([['a', undefined, null], ['b', undefined, null], ['c', 'SKIPPED', 'TOO_MANY_PER_TURN']]);
    expect(res.ok).toBe(true);
  });

  it('stopOnNoProgress: empty and duplicate-only turns stop with no_progress', async () => {
    const reg = fakeRegistry();
    const res = await core.run({ registry: reg, stopOnNoProgress: 2, planner: script([
      { decision: 'request_tools', tools: [req('a')] }, { decision: 'request_tools', tools: [] }, { decision: 'request_tools', tools: [req('a')] }]) });
    expect(res.stopped).toBe('no_progress');
    expect(reg.calls.length).toBe(1);
  });

  it('stopOnBudget: budget-rejected requests are SKIPPED BUDGET_<reason> and a 0-executed batch stops', async () => {
    const reg = fakeRegistry();
    const after = [];
    const budget = new Budget({ maxToolCalls: 10, maxEvidenceBytes: 10, maxModelTurns: 5 });
    const res = await core.run({ registry: reg, budget, stopOnBudget: true, hooks: { afterTool: (r, env) => after.push([r.tool, env.code || null]) },
      planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'request_tools', tools: [req('b'), req('c')] }, { decision: 'final', result: {} }]) });
    expect(reg.calls.map((c) => c.name)).toEqual(['a']);
    expect(after).toEqual([['a', null], ['b', 'BUDGET_maxEvidenceBytes'], ['c', 'BUDGET_maxEvidenceBytes']]);
    expect(res.stopped).toBe('maxEvidenceBytes');
  });

  it('stopOnBudget with no tool calls left: every request is SKIPPED BUDGET_maxToolCalls and the loop stops', async () => {
    const reg = fakeRegistry();
    const after = [];
    const res = await core.run({ registry: reg, budget: { maxToolCalls: 1, maxModelTurns: 5 }, stopOnBudget: true, hooks: { afterTool: (r, env) => after.push(env.code || null) },
      planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'request_tools', tools: [req('b'), req('c')] }]) });
    expect(after).toEqual([null, 'BUDGET_maxToolCalls', 'BUDGET_maxToolCalls']);
    expect(res.stopped).toBe('maxToolCalls');
  });

  it("a planner 'stop' decision ends with its code (or planner-stop)", async () => {
    const reg = fakeRegistry();
    expect((await core.run({ registry: reg, planner: async () => ({ decision: 'stop', code: 'ai_cap' }) })).stopped).toBe('ai_cap');
    expect((await core.run({ registry: reg, planner: async () => ({ decision: 'stop' }) })).stopped).toBe('planner-stop');
  });

  it('hooks: afterPlan per turn, beforeTool before execute, afterTool after; a hook throw -> hook-error with code', async () => {
    const order = [];
    const reg = fakeRegistry({ a: () => { order.push('execute'); return { ok: true, tool: 'a' }; } });
    await core.run({ registry: reg, hooks: {
      afterPlan: (p, n) => order.push('afterPlan' + n), beforeTool: () => { order.push('beforeTool'); return null; }, afterTool: () => order.push('afterTool'),
    }, planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'final', result: {} }]) });
    expect(order).toEqual(['afterPlan1', 'beforeTool', 'execute', 'afterTool', 'afterPlan2']);
    const bad = await core.run({ registry: reg, hooks: { beforeTool: () => { throw Object.assign(new Error('x'), { code: 'LEASE_LOST' }); } },
      planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'final', result: {} }]) });
    expect(bad.stopped).toBe('hook-error');
    expect(bad.hookError).toEqual({ code: 'LEASE_LOST' });
    const bad2 = await core.run({ registry: reg, hooks: { afterPlan: () => { throw new Error('y'); } }, planner: script([{ decision: 'final', result: {} }]) });
    expect(bad2.hookError).toEqual({ code: 'HOOK_ERROR' });
  });

  it('a reused env from beforeTool skips execute and is not counted against maxToolCalls (bytes are)', async () => {
    const reg = fakeRegistry();
    const res = await core.run({ registry: reg, budget: { maxToolCalls: 1, maxModelTurns: 5 },
      hooks: { beforeTool: (r) => (r.tool === 'a' ? { env: { ok: true, tool: 'a', status: 'REUSED', reused: true, data: { facts: [] } } } : null) },
      planner: script([{ decision: 'request_tools', tools: [req('a')] }, { decision: 'request_tools', tools: [req('b')] }, { decision: 'final', result: {} }]) });
    expect(reg.calls.map((c) => c.name)).toEqual(['b']);
    expect(res.budget.toolCalls).toBe(1);
    expect(res.budget.evidenceBytes).toBeGreaterThan(0);
  });

  it('each execute gets its own ctx copy with a toolSignal; the shared ctx is never mutated', async () => {
    const reg = fakeRegistry();
    const ctx = { profile: 'p' };
    await core.run({ registry: reg, ctx, concurrency: 2, planner: script([{ decision: 'request_tools', tools: [req('a'), req('b')] }, { decision: 'final', result: {} }]) });
    expect(ctx).toEqual({ profile: 'p' });
    expect(reg.ctxs[0]).not.toBe(reg.ctxs[1]);
    expect(reg.ctxs[0].profile).toBe('p');
    expect(reg.ctxs[0].toolSignal).not.toBe(reg.ctxs[1].toolSignal);
  });

  it('parity with the old loop: stopOnBudget false drops budget-rejected requests silently and continues', async () => {
    const reg = fakeRegistry();
    const after = [];
    const res = await core.run({ registry: reg, budget: { maxToolCalls: 2, maxModelTurns: 10 }, hooks: { afterTool: (r) => after.push(r.tool) },
      planner: script([{ decision: 'request_tools', tools: [req('a'), req('b'), req('c')] }, { decision: 'request_tools', tools: [req('c')] }]) });
    expect(reg.calls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(after).toEqual(['a', 'b']);       // 'c' sliced off silently, then the empty budget stops
    expect(res.stopped).toBe('maxToolCalls');
    expect(res.toolLog.length).toBe(2);
    // An empty request_tools turn without stopOnNoProgress is still a final (old behavior).
    const res2 = await core.run({ registry: reg, planner: async () => ({ decision: 'request_tools', tools: [] }) });
    expect(res2.stopped).toBe(null);
    expect(res2.ok).toBe(true);
  });

  it('parity: the wrapper result shape equals the core result for the same planner and registry', async () => {
    const loop = require('../src/ai/agent-loop');
    const tools = require('../src/ai/tools');
    const planner = async (s) => (s.turn === 1 ? { decision: 'request_tools', tools: [req('rm_rf_fleet')] } : { decision: 'final', result: { ok: true } });
    const a = await loop.run({ planner, profile: { type: 'internal' } });
    const b = await core.run({ planner, registry: tools, ctx: { profile: { type: 'internal' } } });
    const strip = (r) => ({ ok: r.ok, result: r.result, stopped: r.stopped, toolLog: r.toolLog, turns: r.budget.modelTurns, calls: r.budget.toolCalls });
    expect(strip(a)).toEqual(strip(b));
    expect(a.toolLog[0]).toMatchObject({ tool: 'rm_rf_fleet', ok: false });
  });

  it("parity: through the wrapper a 'stop' decision is still treated as final (pre-split contract)", async () => {
    const loop = require('../src/ai/agent-loop');
    const res = await loop.run({ planner: async () => ({ decision: 'stop', code: 'ai_cap', result: { x: 1 } }), profile: { type: 'internal' } });
    expect(res).toMatchObject({ ok: true, stopped: null, result: { x: 1 } });
    const res2 = await loop.run({ planner: async () => ({ decision: 'stop' }), profile: { type: 'internal' } });
    expect(res2).toMatchObject({ ok: true, stopped: null, result: null });
  });
});
