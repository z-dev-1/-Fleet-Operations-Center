// tests/ai-gateway-trace-stats.test.js — gateway records on ai/trace, queue
// stats per priority through ai/status and the telemetry snapshot.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-trace-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const trace = require('../src/ai/trace');
const { flush, installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let calls;
beforeEach(() => {
  baseRelaySetup(relay);
  calls = installFakeFleetBrain(vi, fleetBrain);
  trace._resetGatewayForTests();
});
afterEach(async () => {
  vi.useRealTimers();
  for (let i = 0; i < 10; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
  T.setGatewayFlags(null);
  expect(T.reset()).toBe(0);
  vi.restoreAllMocks();
});

describe('gateway records', () => {
  it('ok / timeout / aborted / error carry source, priority, queue wait, latency, via', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true, abortOnTimeout: true });
    const ok = relay.ask('a', { source: 'slack_dm_legacy' });
    await flush(); calls[0].ok('x'); await ok;
    const to = relay.ask('b', { source: 'briefing', timeoutMs: 1000 }); to.catch(() => {});
    await flush(); vi.advanceTimersByTime(1000); await to.catch(() => {});
    const ac = new AbortController();
    const ab = relay.ask('c', { source: 'deep_scan', signal: ac.signal }); ab.catch(() => {});
    await flush(); ac.abort(); await ab.catch(() => {});
    T.setGatewayFlags({ priorities: true, abortOnTimeout: true, routerDecides: true });
    await relay.ask('d', { task: { requiresVision: true } }).catch(() => {});
    const recs = trace.gatewayRecent(10);
    const by = Object.fromEntries(recs.map((r) => [r.outcome, r]));
    expect(by.ok).toMatchObject({ source: 'slack_dm_legacy', priority: 'high', via: 'fleet-brain/ws', legacy: false });
    expect(typeof by.ok.queueWaitMs).toBe('number');
    expect(typeof by.ok.latencyMs).toBe('number');
    expect(by.timeout).toMatchObject({ source: 'briefing', priority: 'normal', timeoutMs: 1000 });
    expect(by.aborted).toMatchObject({ source: 'deep_scan', priority: 'low' });
    expect(by.error).toMatchObject({ source: 'unknown' });
  });
  it('a late flag-off completion after an askWithTimeout timeout is recorded as timeout + late', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({});
    const p = relay.askWithTimeout('a', { timeoutMs: 100, source: 'carrier_briefing' }); p.catch(() => {});
    await flush();
    vi.advanceTimersByTime(100);
    await p.catch(() => {});
    calls[0].ok('late'); await flush();
    expect(trace.gatewayRecent(1)[0]).toMatchObject({ outcome: 'timeout', late: true, legacy: true, source: 'carrier_briefing' });
  });
  it('opts.trace.setGateway is called and the AiCore trace persists gateway; setGateway after finish is a no-op', async () => {
    const tr = trace.start({ source: 'ui' });
    const p = relay.ask('a', { trace: tr, source: 'ui_ai_ask' });
    await flush(); calls[0].ok('x'); await p;
    const rec = tr.finish({ outcome: 'answer' });
    expect(rec.gateway).toMatchObject({ source: 'ui_ai_ask', outcome: 'ok' });
    tr.setGateway({ source: 'other', outcome: 'error' });
    expect(rec.gateway.source).toBe('ui_ai_ask');
    expect(trace.recent(1)[0].gateway.source).toBe('ui_ai_ask');
    expect(trace.start({}).setGateway).toBeTypeOf('function');
    expect(trace.start({})._rec.gateway).toBeNull();
  });
  it('gatewaySummary percentiles and ring cap', () => {
    for (let i = 1; i <= 600; i++) trace.recordGateway({ source: 's' + (i % 3), priority: i % 2 ? 'high' : 'low', outcome: i % 10 ? 'ok' : 'timeout', latencyMs: i, queueWaitMs: i % 7 });
    expect(trace.gatewayRecent(1000).length).toBe(trace.GW_CAP);
    const s = trace.gatewaySummary();
    expect(s.sampleSize).toBe(500);
    expect(s.byPriority.high.count + s.byPriority.low.count).toBe(500);
    expect(s.byPriority.high.p95LatencyMs).toBeGreaterThanOrEqual(s.byPriority.high.p50LatencyMs);
    expect(s.byPriority.high.timeout + s.byPriority.low.timeout).toBe(50);
    expect(Object.keys(s.bySource).length).toBe(3);
  });
});

describe('status + telemetry surfaces', () => {
  it('ai/status snapshot has throughput.byPriority, gateway and a priority board row; _queueFromRelay shape unchanged', async () => {
    T.setGatewayFlags({ priorities: true });
    const status = require('../src/ai/status');
    const s = status.snapshot();
    expect(s.throughput.byPriority).toMatchObject({ critical: { active: 0, waiting: 0 }, low: { active: 0, waiting: 0 } });
    expect(s.throughput.reserve).toBe(2);
    expect(s.throughput.gatewayFlags.priorities).toBe(true);
    expect(s.gateway).toHaveProperty('byPriority');
    expect(s.board['Queue by priority']).toBe('C0 H0 N0 L0');
    expect(status._queueFromRelay({ queueStats: () => ({ active: 2, waiting: 3, max: 5 }) })).toEqual({ activeRequests: 2, queueDepth: 3, maxConcurrent: 5 });
  });
  it('telemetry snapshot().ai via injected aiStats, and from the loaded relay', () => {
    const tel = require('../src/telemetry');
    tel._resetForTests();
    tel.start({ enabled: false, aiStats: () => ({ queue: { x: 1 }, gateway: null }) });
    expect(tel.snapshot().ai).toEqual({ queue: { x: 1 }, gateway: null });
    tel._resetForTests();
    tel.start({ enabled: false });
    const ai = tel.snapshot().ai; // relay is already in the require cache here
    expect(ai.queue).toHaveProperty('byPriority');
    expect(ai.gateway).toHaveProperty('sampleSize');
    tel._resetForTests();
  });
  it('telemetry snapshot().ai is null when relay is not loaded and no aiStats dep is given', () => {
    const tel = require('../src/telemetry');
    const relayPath = require.resolve('../src/orcha/relay');
    const cached = require.cache[relayPath];
    expect(cached).toBeTruthy();
    try {
      delete require.cache[relayPath];
      tel._resetForTests();
      tel.start({ enabled: false });
      expect(tel.snapshot().ai).toBeNull();
    } finally {
      require.cache[relayPath] = cached;
      tel._resetForTests();
    }
    expect(require('../src/orcha/relay')).toBe(relay);
  });
});
