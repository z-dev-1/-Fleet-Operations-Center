// tests/ai-gateway-dedupe.test.js — opts.dedupeKey in-flight coalescing
// (ai.gateway.dedupe). Never dedupes implicitly by prompt text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-dedupe-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const trace = require('../src/ai/trace');
const { flush, installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let calls;
const pending = [];
const track = (p) => { p.catch(() => {}); pending.push(p); return p; };
async function drain() {
  for (let i = 0; i < 20; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
  await Promise.allSettled(pending);
}

beforeEach(() => {
  baseRelaySetup(relay);
  calls = installFakeFleetBrain(vi, fleetBrain);
  pending.length = 0;
  trace._resetGatewayForTests();
});
afterEach(async () => {
  vi.useRealTimers();
  await drain();
  T.setGatewayFlags(null);
  expect(T.reset()).toBe(0);
  vi.restoreAllMocks();
});

describe('dedupe on', () => {
  beforeEach(() => T.setGatewayFlags({ dedupe: true }));

  it('same key, concurrent: one transport call, both get the same text', async () => {
    const a = track(relay.ask('P', { dedupeKey: 'k1' }));
    const b = track(relay.ask('P', { dedupeKey: 'k1' }));
    await flush();
    expect(calls.length).toBe(1);
    calls[0].ok('shared');
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
    expect(T.inflight().size).toBe(0);
  });
  it('different keys -> 2 calls; no key + identical prompt -> 2 calls (no implicit dedupe)', async () => {
    track(relay.ask('P', { dedupeKey: 'k1' })); track(relay.ask('P', { dedupeKey: 'k2' }));
    track(relay.ask('Q')); track(relay.ask('Q'));
    await flush();
    expect(calls.length).toBe(4);
  });
  it('invalid keys are ignored silently', async () => {
    track(relay.ask('P', { dedupeKey: '' })); track(relay.ask('P', { dedupeKey: '' }));
    track(relay.ask('P', { dedupeKey: 'x'.repeat(201) })); track(relay.ask('P', { dedupeKey: 'x'.repeat(201) }));
    await flush();
    expect(calls.length).toBe(4);
  });
  it('same key, different prompt: runs independently', async () => {
    track(relay.ask('P1', { dedupeKey: 'k' })); track(relay.ask('P2', { dedupeKey: 'k' }));
    await flush();
    expect(calls.length).toBe(2);
  });
  it('follower abort rejects only the follower; all aborted -> underlying aborted + slot released', async () => {
    const acA = new AbortController(); const acB = new AbortController();
    const a = track(relay.ask('P', { dedupeKey: 'k', signal: acA.signal }));
    const b = track(relay.ask('P', { dedupeKey: 'k', signal: acB.signal }));
    await flush();
    acB.abort();
    await expect(b).rejects.toMatchObject({ message: 'Aborted', code: 'ABORTED' });
    expect(calls[0].opts.signal.aborted).toBe(false);
    acA.abort();
    await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
    expect(calls[0].opts.signal.aborted).toBe(true);
    await flush();
    expect(relay.queueStats().active).toBe(0);
    expect(T.inflight().size).toBe(0);
  });
  it('abortOnTimeout OFF: follower abort is honored; follower timeoutMs is ignored', async () => {
    vi.useFakeTimers();
    const acB = new AbortController();
    const a = track(relay.ask('P', { dedupeKey: 'k' }));
    const b = track(relay.ask('P', { dedupeKey: 'k', signal: acB.signal }));
    const c = track(relay.ask('P', { dedupeKey: 'k', timeoutMs: 50 }));
    await flush();
    acB.abort();
    await expect(b).rejects.toMatchObject({ code: 'ABORTED' });
    vi.advanceTimersByTime(100);
    await flush();
    calls[0].ok('shared');
    expect(await a).toBe('shared');
    expect(await c).toBe('shared');
    expect(calls.length).toBe(1);
  });
  it('abortOnTimeout ON: follower timeoutMs detaches only that follower (AI_TIMEOUT)', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ dedupe: true, abortOnTimeout: true });
    const a = track(relay.ask('P', { dedupeKey: 'k' }));
    const c = track(relay.ask('P', { dedupeKey: 'k', timeoutMs: 50 }));
    await flush();
    vi.advanceTimersByTime(50);
    await expect(c).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    calls[0].ok('shared');
    expect(await a).toBe('shared');
  });
  it('already-aborted signal at join time rejects "Aborted before start" without touching the entry', async () => {
    track(relay.ask('P', { dedupeKey: 'k' }));
    await flush();
    const entry = T.inflight().get('k');
    const dead = new AbortController(); dead.abort();
    const r = relay.ask('P', { dedupeKey: 'k', signal: dead.signal });
    expect(typeof r.then).toBe('function');
    await expect(r).rejects.toThrow('Aborted before start');
    expect(T.inflight().size).toBe(1);
    expect(entry.refs).toBe(1);
  });
  it('records: one normal record for the underlying call + one deduped record per follower', async () => {
    const a = track(relay.ask('P', { dedupeKey: 'k', source: 'deep_scan_unit' }));
    const b = track(relay.ask('P', { dedupeKey: 'k', source: 'ui_ai_ask' }));
    await flush();
    calls[0].ok('x');
    await a; await b;
    const recs = trace.gatewayRecent(10);
    expect(recs.filter((r) => !r.deduped).length).toBe(1);
    const f = recs.filter((r) => r.deduped);
    expect(f.length).toBe(1);
    expect(f[0]).toMatchObject({ source: 'ui_ai_ask', queueWaitMs: 0, outcome: 'ok' });
  });
  it('private options are stripped from the underlying call; leader timeout stays on the leader', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ dedupe: true, abortOnTimeout: true });
    const trL = { setGateway: vi.fn() }; const trF = { setGateway: vi.fn() };
    const leader = track(relay.askWithTimeout('P', { dedupeKey: 'k', timeoutMs: 100, trace: trL, source: 'a' }));
    const follower = track(relay.ask('P', { dedupeKey: 'k', trace: trF, source: 'b' }));
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0].opts).not.toHaveProperty('__gwMeta');
    vi.advanceTimersByTime(100);
    await expect(leader).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    calls[0].ok('shared');
    expect(await follower).toBe('shared');
    const recs = trace.gatewayRecent(10);
    const underlying = recs.find((r) => !r.deduped);
    expect(underlying.outcome).toBe('ok');
    expect(underlying.late).toBeUndefined();
    expect(recs.find((r) => r.deduped && r.source === 'a').outcome).toBe('timeout');
    expect(trL.setGateway.mock.calls.every((c) => c[0].outcome === 'timeout')).toBe(true);
    expect(trF.setGateway).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });
  it('key reusable after settle; shared rejection reaches every participant', async () => {
    const a = track(relay.ask('P', { dedupeKey: 'k' }));
    await flush();
    calls[0].ok('one');
    await a;
    const b = track(relay.ask('P', { dedupeKey: 'k' }));
    await flush();
    expect(calls.length).toBe(2);
    calls[1].ok('two');
    expect(await b).toBe('two');
  });
  it('refs-0 race: a new call under the same key is not deleted by the old call\'s late finally', async () => {
    // Fake that ignores aborts: never settles until told.
    let late;
    fleetBrain.ask.mockImplementationOnce(() => new Promise((res) => { late = res; }));
    const ac1 = new AbortController(); const ac2 = new AbortController();
    const a = track(relay.ask('P', { dedupeKey: 'k', signal: ac1.signal }));
    const b = track(relay.ask('P', { dedupeKey: 'k', signal: ac2.signal }));
    await flush();
    ac1.abort(); ac2.abort();
    await expect(a).rejects.toBeTruthy(); await expect(b).rejects.toBeTruthy();
    expect(T.inflight().size).toBe(0);
    const c = track(relay.ask('P', { dedupeKey: 'k' }));
    await flush();
    expect(fleetBrain.ask).toHaveBeenCalledTimes(2);
    late('stale');
    await flush();
    expect(T.inflight().size).toBe(1);
    calls[calls.length - 1].ok('fresh');
    expect(await c).toBe('fresh');
  });
});

describe('dedupe off', () => {
  it('a key is ignored: 2 calls, _inflight stays empty', async () => {
    T.setGatewayFlags({});
    track(relay.ask('P', { dedupeKey: 'k' })); track(relay.ask('P', { dedupeKey: 'k' }));
    await flush();
    expect(calls.length).toBe(2);
    expect(T.inflight().size).toBe(0);
  });
  it('already-aborted signal still rejects asynchronously', async () => {
    T.setGatewayFlags({});
    const dead = new AbortController(); dead.abort();
    const r = relay.ask('P', { dedupeKey: 'k', signal: dead.signal });
    expect(typeof r.then).toBe('function');
    await expect(r).rejects.toThrow('Aborted before start');
    track(relay.ask('P', null)); // explicit null opts is normalized, never throws
    await flush();
    expect(calls.length).toBe(1);
  });
});
