import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-core-phase-e-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const trace = require('../src/ai/trace');
const evalMod = require('../src/ai/eval');
const status = require('../src/ai/status');

// Seed a set of traces directly into the aiTraceLog so metrics are deterministic
// (no live AI relay needed). We build them via the trace handle so the shape
// matches production exactly.
function seedTraces() {
  store.save('aiTraceLog', []);
  // 1) a clean answer, no fallback, one verified tool
  trace.start({ source: 'slack_dm', actor: { slackId: 'U1' }, taskType: 'unit_status' })
    .setModel('claude-sonnet', 'claude').addTools(['GET_UNIT'])
    .setActionOutcomes([{ tool: 'ADD_TIMELINE', status: 'done' }])
    .setValidation(true, false).setOutcome('answer').finish();
  // 2) an answer that needed a schema repair (fallback)
  trace.start({ source: 'slack_dm', actor: { slackId: 'U2' }, taskType: 'unit_status' })
    .setModel('claude-sonnet', 'claude').addFallback('schema-repair')
    .setValidation(true, true).setOutcome('answer').finish();
  // 3) an escalation
  trace.start({ source: 'ui', actor: { slackId: 'U3' }, taskType: 'report' })
    .setModel('orcha', 'orcha').setValidation(true, false).setOutcome('escalate').finish();
  // 4) a fail-safe (invalid output)
  trace.start({ source: 'slack_channel', actor: { slackId: 'U4' } })
    .setValidation(false, true).setOutcome('failsafe').setError('invalid output').finish();
  // 5) an answer backed by STALE evidence + a failed action tool
  trace.start({ source: 'dbr', actor: { slackId: 'U5' }, taskType: 'report' })
    .setModel('claude-sonnet', 'claude').addEvidenceSource('relayCache', 'STALE')
    .setActionOutcomes([{ tool: 'MOVE_UNIT', status: 'failed' }])
    .setValidation(true, false).setOutcome('answer').finish();
}

beforeEach(() => { seedTraces(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('AI Core Phase E — evaluation metrics (spec #10)', () => {
  it('aggregates answer success / fallback / tool success / latency / usage', () => {
    const m = evalMod.metrics({ limit: 100 });
    expect(m.sampleSize).toBe(5);
    // Successful terminal answers: traces 1, 2, 3 (escalate), 5 = 4 of 5 (failsafe excluded)
    expect(m.answerSuccessRate).toBeCloseTo(0.8, 3);
    // Fallback used on trace 2 (schema-repair) only.
    expect(m.fallbackRate).toBeCloseTo(0.2, 3);
    // Tool outcomes: 1 done (trace 1) + 1 failed (trace 5) -> 0.5.
    expect(m.toolSuccessRate).toBeCloseTo(0.5, 3);
    expect(m.modelUsage['claude-sonnet']).toBe(3);
    expect(m.modelUsage['orcha']).toBe(1);
    expect(m.sourceUsage['slack_dm']).toBe(2);
    // Stale answer: trace 5 is an answer with STALE evidence -> 1 of 4 answers.
    expect(m.staleAnswerRate).toBeCloseTo(0.25, 3);
    expect(m.escalationRate).toBeCloseTo(0.2, 3);
    expect(m.errorRate).toBeCloseTo(0.2, 3);
  });

  it('records operator feedback WITHOUT changing any app behavior', () => {
    const latest = trace.recent(5);
    const id = latest[0].requestId; // trace 5 (newest-first)
    const cfgBefore = JSON.stringify(store.load('fasConfig', {}));
    const res = evalMod.recordFeedback(id, { verdict: 'incorrect', note: 'wrong vendor' });
    expect(res.ok).toBe(true);
    // Correction is attached as learning data.
    const fb = evalMod.recentFeedback(10);
    expect(fb.some((f) => f.requestId === id && f.correction.verdict === 'incorrect')).toBe(true);
    // One isolated correction must NOT mutate config/behavior (spec #10).
    expect(JSON.stringify(store.load('fasConfig', {}))).toBe(cfgBefore);
    // correctionRate now reflects 1 of 5.
    expect(evalMod.metrics({ limit: 100 }).correctionRate).toBeCloseTo(0.2, 3);
  });

  it('returns a safe empty metrics object when there are no traces', () => {
    store.save('aiTraceLog', []);
    const m = evalMod.metrics({ limit: 100 });
    expect(m.sampleSize).toBe(0);
    expect(m.answerSuccessRate).toBeNull();
    expect(m.modelUsage).toEqual({});
  });
});

describe('AI Core Phase E — AI health status (spec #18)', () => {
  it('builds a composed snapshot with lanes, models, cluster, attachments and metrics', () => {
    const s = status.snapshot({ metricsLimit: 100 });
    expect(s).toHaveProperty('lanes');
    expect(s.lanes).toHaveProperty('fleetBrain');
    expect(s.lanes).toHaveProperty('orcha');
    expect(s.lanes).toHaveProperty('claude');
    expect(s.lanes).toHaveProperty('bedrock');
    expect(s).toHaveProperty('models');
    expect(s).toHaveProperty('reliability');
    expect(s).toHaveProperty('cluster');
    expect(s.cluster).toHaveProperty('productionActionsAllowed');
    expect(s).toHaveProperty('attachments');
    expect(s.metrics.sampleSize).toBe(5);
    expect(s.overall).toHaveProperty('status');
    expect(['up', 'degraded', 'down']).toContain(s.overall.status);
  });

  it('never throws even if underlying modules are unavailable (guarded probes)', () => {
    // Snapshot must be robust; calling it repeatedly is side-effect free.
    expect(() => status.snapshot()).not.toThrow();
    const a = status.snapshot();
    const b = status.snapshot();
    expect(a.cluster.enabled).toBe(b.cluster.enabled);
  });

  it('cluster reports standalone + production allowed when cluster is disabled', () => {
    const s = status.snapshot();
    // In the test runtime the cluster is not started -> standalone, mutations allowed.
    expect(['standalone']).toContain(s.cluster.role);
    expect(s.cluster.productionActionsAllowed).toBe(true);
  });
});
