import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-phase6-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const memory = require('../src/ai/memory');
const performance = require('../src/ai/performance');
const trace = require('../src/ai/trace');
const tools = require('../src/ai/tools');
const actions = require('../src/ai/actions');
const profiles = require('../src/orcha/fas/sender-profiles');
const { WORLDS, SCENARIOS, CLASS } = require('../src/ai/golden/scenarios');

function resetStores() {
  store.save('aiMemory', []);
  store.save('aiTraceLog', []);
}
beforeEach(() => { resetStores(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

// ── Memory governance (spec §12) ──────────────────────────────────────────────
describe('Phase 6 — durable memory governance (spec §12)', () => {
  it('four-tier precedence: operator > verified-source > repeated-AI > single-AI', () => {
    memory.remember({ type: 'vendor', entity: 'V', fact: 'single ai guess', origin: 'ai_inferred' });
    memory.remember({ type: 'vendor', entity: 'V', fact: 'repeated ai', origin: 'ai_inferred' });
    memory.remember({ type: 'vendor', entity: 'V', fact: 'repeated ai', origin: 'ai_inferred' }); // supportCount=2
    memory.remember({ type: 'vendor', entity: 'V', fact: 'from fas case', origin: 'ai_inferred', source: 'fas_case' });
    memory.remember({ type: 'vendor', entity: 'V', fact: 'operator says', origin: 'operator_confirmed' });
    const mems = memory.retrieve({ vendors: ['V'] }, { limit: 10 });
    expect(mems[0].fact).toBe('operator says');                 // tier 1
    expect(mems[1].fact).toBe('from fas case');                 // tier 2 (verified source)
    expect(mems[2].fact).toBe('repeated ai');                   // tier 3 (supportCount>=2)
    expect(mems[3].fact).toBe('single ai guess');               // tier 4
  });

  it('supersede() replaces an outdated memory and hides the old one', () => {
    const r1 = memory.remember({ type: 'unit', entity: '321060', fact: 'at the dealer', origin: 'ai_inferred', expiresAt: 60000 });
    memory.supersede(r1.id, { type: 'unit', entity: '321060', fact: 'recurring DEF faults', origin: 'operator_confirmed' });
    const mems = memory.retrieve({ units: ['321060'] }, { limit: 10 });
    expect(mems.some((m) => /recurring DEF/.test(m.fact))).toBe(true);
    expect(mems.some((m) => /at the dealer/.test(m.fact))).toBe(false); // superseded, hidden
  });

  it('TTL: an expired volatile memory is pruned and not retrieved', () => {
    memory.remember({ type: 'unit', entity: '321060', fact: 'is at the dealer', origin: 'ai_inferred', expiresAt: -1000 }); // already expired
    expect(memory.retrieve({ units: ['321060'] }, { limit: 10 }).some((m) => /at the dealer/.test(m.fact))).toBe(false);
    expect(memory.pruneExpired().removed).toBeGreaterThanOrEqual(1);
  });

  it('decay lowers stale AI-inferred confidence but never operator/verified memory', () => {
    const ai = memory.remember({ type: 'site', entity: 'ABE40', fact: 'ai hunch', origin: 'ai_inferred' });
    const op = memory.remember({ type: 'site', entity: 'ABE40', fact: 'operator rule', origin: 'operator_confirmed' });
    // Backdate the AI memory so decay applies.
    const arr = store.load('aiMemory', []);
    arr.find((m) => m.id === ai.id).createdAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    arr.find((m) => m.id === ai.id).lastConfirmedAt = null;
    store.save('aiMemory', arr);
    memory.decay({ halfLifeMs: 30 * 24 * 3600 * 1000 });
    const after = store.load('aiMemory', []);
    expect(after.find((m) => m.id === ai.id).confidence).toBeLessThan(0.6);
    expect(after.find((m) => m.id === op.id).confidence).toBe(1); // operator untouched
  });

  it('records correction history without changing behavior', () => {
    const r = memory.remember({ type: 'vendor', entity: 'Amerit', fact: 'slow fridays', origin: 'ai_inferred' });
    expect(memory.recordCorrection(r.id, { note: 'actually fast', by: 'operator' })).toBe(true);
    const m = store.load('aiMemory', []).find((x) => x.id === r.id);
    expect(m.corrections.length).toBe(1);
  });
});

// ── Model performance learning (spec §8) ──────────────────────────────────────
describe('Phase 6 — model performance learning (spec §8)', () => {
  function seedTraces(model, task, n, opts) {
    opts = opts || {};
    for (let i = 0; i < n; i++) {
      const tr = trace.start({ source: 'slack_dm', actor: { slackId: 'U' }, taskType: task });
      tr.setModel(model, opts.lane || model);
      tr.setValidation(opts.invalid ? false : true, false);
      if (opts.fallback) tr.addFallback('schema-repair');
      tr.setOutcome(opts.outcome || 'answer').finish({ outcome: opts.outcome || 'answer' });
      if (opts.correctionIncorrect) trace.attachCorrection(tr.requestId, { verdict: 'incorrect' });
    }
  }

  it('aggregates per model+task metrics', () => {
    seedTraces('claude-sonnet', 'slack_reply', 10);
    seedTraces('orcha', 'slack_reply', 5, { correctionIncorrect: true });
    const agg = performance.byModelTask({ limit: 500 });
    expect(agg['claude-sonnet::slack_reply'].samples).toBe(10);
    expect(agg['claude-sonnet::slack_reply'].successRate).toBe(1);
    expect(agg['orcha::slack_reply'].incorrectRate).toBeGreaterThan(0);
  });

  it('laneScore returns null below the minimum sample threshold (no noise influence)', () => {
    seedTraces('claude-sonnet', 'unit_reasoning', 5, { lane: 'claude' }); // below default 20
    expect(performance.laneScore('claude', 'unit_reasoning', { minSamples: 20 })).toBeNull();
  });

  it('laneScore rewards success and penalizes corrections once enough samples exist', () => {
    // Start from a clean trace store so aggregation isn't affected by traces
    // seeded in earlier cases (makes the comparison deterministic).
    store.save('aiTraceLog', []);
    seedTraces('claude-sonnet', 'multi_source_reasoning', 25, { lane: 'claude' });            // clean
    seedTraces('orcha', 'multi_source_reasoning', 25, { lane: 'orcha', correctionIncorrect: true }); // corrected
    // Explicit high limit so all 50 traces are aggregated regardless of defaults.
    const claude = performance.laneScore('claude', 'multi_source_reasoning', { minSamples: 20, limit: 1000 });
    const orcha = performance.laneScore('orcha', 'multi_source_reasoning', { minSamples: 20, limit: 1000 });
    expect(claude).toBeGreaterThan(orcha);
  });

  it('routerHook returns a function usable by router.decide', () => {
    seedTraces('claude-sonnet', 'slack_reply', 25, { lane: 'claude' });
    const hook = performance.routerHook({ minSamples: 20 });
    expect(typeof hook).toBe('function');
    expect(hook('claude', 'slack_reply')).toBeGreaterThan(0);
  });
});

// ── Golden evaluation suite (spec §21) ────────────────────────────────────────
describe('Phase 6 — golden evaluation suite (spec §21)', () => {
  function loadWorld(name) {
    const w = WORLDS[name];
    store.save('fleetData', { syncedAt: new Date().toISOString(), rows: w.fleet.map((r) => ({ ...r })) });
    store.save('contacts', w.contacts.map((c) => ({ ...c })));
    store.save('slackSenderProfiles', {});
  }

  for (const sc of SCENARIOS) {
    it('golden: ' + sc.id, async () => {
      loadWorld(sc.world);
      const profile = profiles.resolveSender(sc.sender);
      const ctx = { profile };

      // Permission parity assertions (spec §21/§31): the resolved profile is
      // consumed as-is; the AI can never widen it.
      if (sc.expect.permission) {
        expect(profiles.canRequest(profile, 'lifecycle_change')).toBe(sc.expect.permission.canLifecycle);
        expect(profiles.canRequest(profile, 'create_wr')).toBe(sc.expect.permission.canCreateWr);
      }

      // Tool authorization + grounding.
      if (sc.expect.toolAllowed) {
        const env = await tools.execute(sc.expect.toolAllowed.tool, { unit: sc.expect.entity }, ctx);
        expect(env.ok).toBe(sc.expect.toolAllowed.ok);
        if (sc.expect.toolAllowed.denied) expect(env.denied).toBe(true);
        if (sc.expect.grounded && env.ok) {
          const f = env.data.facts.find((x) => x.field === sc.expect.grounded.field);
          expect(f.value).toBe(sc.expect.grounded.value); // grounded in source, not invented
        }
      }

      // Action simulation (no side effects) — blockers / allowed / idempotency.
      if (sc.expect.simulate) {
        const s = actions.simulate({ type: sc.expect.simulate.type, args: sc.expect.simulate.args }, ctx);
        if (sc.expect.simulate.allowed != null) expect(s.allowed).toBe(sc.expect.simulate.allowed);
        if (sc.expect.simulate.idempotent != null) expect(s.idempotent).toBe(sc.expect.simulate.idempotent);
        if (sc.expect.simulate.wouldChange != null) expect(s.wouldChange).toBe(sc.expect.simulate.wouldChange);
        if (sc.expect.simulate.blockerMatch) expect(s.blockers.some((b) => sc.expect.simulate.blockerMatch.test(b))).toBe(true);
      }

      // Every scenario declares a model-agnostic decision class.
      expect(Object.values(CLASS)).toContain(sc.expect.decisionClass);
    });
  }
});
