// tests/ai-gateway-timeout.test.js — askWithTimeout / runWithTimeout parity with
// the old Promise.race (flag off) and real cancellation + immediate slot release
// (ai.gateway.abortOnTimeout). Fake transports only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-timeout-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let calls;
const pending = [];
function track(p) { p.catch(() => {}); pending.push(p); return p; }
async function drain() {
  for (let i = 0; i < 30; i++) { (calls || []).filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
  await Promise.allSettled(pending);
}

beforeEach(() => {
  baseRelaySetup(relay);
  calls = installFakeFleetBrain(vi, fleetBrain);
  pending.length = 0;
});
afterEach(async () => {
  vi.useRealTimers();
  await drain();
  T.setGatewayFlags(null);
  expect(T.reset()).toBe(0);
  vi.restoreAllMocks();
});

describe('flag off: exact Promise.race parity', () => {
  beforeEach(() => { vi.useFakeTimers(); T.setGatewayFlags({}); });

  it('rejects with the exact message (plus code AI_TIMEOUT); the inner call is not aborted; slot held until it settles', async () => {
    const p = track(relay.askWithTimeout('q', { timeoutMs: 1000, timeoutMessage: 'briefing AI timeout', source: 'briefing' }));
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0].opts.signal).toBeUndefined();
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ message: 'briefing AI timeout', code: 'AI_TIMEOUT' });
    expect(calls[0].settled).toBe(false);
    expect(relay.queueStats().active).toBe(1); // documents old behavior: slot held
    calls[0].ok('late');
    await flush();
    expect(relay.queueStats().active).toBe(0);
  });
  it('default message is "AI timeout after Ns"', async () => {
    const p = track(relay.askWithTimeout('q', { timeoutMs: 20000 }));
    await flush();
    vi.advanceTimersByTime(20000);
    await expect(p).rejects.toThrow('AI timeout after 20s');
  });
  it("resolves timeoutResult ('' / null) when present", async () => {
    const a = track(relay.askWithTimeout('a', { timeoutMs: 50, timeoutResult: '' }));
    const b = track(relay.askWithTimeout('b', { timeoutMs: 50, timeoutResult: null }));
    await flush();
    vi.advanceTimersByTime(50);
    expect(await a).toBe('');
    expect(await b).toBeNull();
  });
  it('an inner rejection before the timer propagates unchanged; a result wins', async () => {
    const boom = new Error('Orcha AI failed: x');
    const spy = vi.spyOn(relay, 'ask').mockRejectedValueOnce(boom).mockResolvedValueOnce('hello');
    const p = relay.askWithTimeout('a', { timeoutMs: 5000 });
    const q = relay.askWithTimeout('b', { timeoutMs: 5000 });
    await expect(p).rejects.toBe(boom);
    expect(await q).toBe('hello');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0); // timers cleared on settle
  });
  it('passes the caller signal by identity and never forwards timeout options to ask', async () => {
    const spy = vi.spyOn(relay, 'ask').mockImplementation(() => new Promise(() => {}));
    const ac = new AbortController();
    const tr = { setGateway: vi.fn() };
    track(relay.askWithTimeout('q', { timeoutMs: 100, timeoutMessage: 'm', timeoutResult: 'x', signal: ac.signal, priority: 'high', source: 'volvo_ck82', requestId: 'r1', trace: tr }));
    const [, o] = spy.mock.calls[0];
    expect(o.signal).toBe(ac.signal);
    expect(o).not.toHaveProperty('timeoutMs');
    expect(o).not.toHaveProperty('timeoutMessage');
    expect(o).not.toHaveProperty('timeoutResult');
    expect(o).toMatchObject({ priority: 'high', source: 'volvo_ck82', requestId: 'r1', trace: tr });
    vi.advanceTimersByTime(100);
    await flush();
    expect(tr.setGateway).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'timeout', timeoutMs: 100 }));
  });
  it('relay.ask ignores opts.timeoutMs with the flag off', async () => {
    const p = track(relay.ask('q', { timeoutMs: 10 }));
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    calls[0].ok('done');
    expect(await p).toBe('done');
  });
  it('invalid timeoutMs is a TypeError (programming error)', async () => {
    await expect(relay.askWithTimeout('q', { timeoutMs: 0 })).rejects.toThrow(TypeError);
    await expect(relay.runWithTimeout(() => 1, { timeoutMs: NaN })).rejects.toThrow('askWithTimeout: timeoutMs must be a positive number');
  });
  it('runWithTimeout adopts sync throws and plain values like Promise.race did', async () => {
    await expect(relay.runWithTimeout(() => { throw new Error('sync'); }, { timeoutMs: 10 })).rejects.toThrow('sync');
    expect(await relay.runWithTimeout(() => ({ ok: true, text: 'x' }), { timeoutMs: 10 })).toEqual({ ok: true, text: 'x' });
  });
});

describe('flag on: abortOnTimeout cancels and frees the slot', () => {
  beforeEach(() => { vi.useFakeTimers(); T.setGatewayFlags({ abortOnTimeout: true }); });

  it('askWithTimeout aborts the inner signal; active drops immediately; the next waiter is granted', async () => {
    for (let i = 0; i < 5; i++) track(relay.ask('fill' + i));
    await flush();
    const p = track(relay.askWithTimeout('t', { timeoutMs: 1000, timeoutMessage: 'ai-timeout' }));
    const next = track(relay.ask('next'));
    await flush();
    // 't' is queued behind 5 fills; free one so 't' runs.
    calls[0].ok('x');
    await flush();
    expect(calls.map((c) => c.prompt)).toContain('t');
    const tCall = calls.find((c) => c.prompt === 't');
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ message: 'ai-timeout', code: 'AI_TIMEOUT' });
    await flush();
    expect(tCall.opts.signal.aborted).toBe(true);
    expect(tCall.opts.detachActiveOnAbort).toBe(true);
    expect(calls.map((c) => c.prompt)).toContain('next');
    expect(relay.queueStats().active).toBe(5);
    calls.forEach((c) => c.ok('z'));
    await flush();
    await next;
  });
  it("no timeoutMs leak: timeoutResult '' resolves '' (not a rejection)", async () => {
    const p = relay.askWithTimeout('t', { timeoutMs: 50, timeoutResult: '' });
    await flush();
    vi.advanceTimersByTime(50);
    expect(await p).toBe('');
    await flush();
    expect(relay.queueStats().active).toBe(0);
  });
  it('relay.ask({ timeoutMs }) rejects AI_TIMEOUT and releases the slot', async () => {
    const p = track(relay.ask('t', { timeoutMs: 2000 }));
    await flush();
    expect(relay.queueStats().active).toBe(1);
    vi.advanceTimersByTime(2000);
    await expect(p).rejects.toMatchObject({ message: 'AI timeout after 2s', code: 'AI_TIMEOUT' });
    expect(relay.queueStats().active).toBe(0);
  });
  it('late settle after timeout never double-releases', async () => {
    // Fake that ignores aborts and settles late.
    fleetBrain.ask.mockImplementation(() => new Promise((res) => setTimeout(() => res('late'), 5000)));
    const p = track(relay.ask('t', { timeoutMs: 1000 }));
    await flush();
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(relay.queueStats().active).toBe(0);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(relay.queueStats().active).toBe(0);
    expect(T.underflows()).toBe(0);
    fleetBrain.ask.mockImplementation(() => new Promise((_, rej) => setTimeout(() => rej(new Error('late fail')), 5000)));
    const p2 = track(relay.ask('t2', { timeoutMs: 1000 }));
    await flush();
    vi.advanceTimersByTime(1000);
    await expect(p2).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    vi.advanceTimersByTime(10000);
    await flush(200);
    expect(relay.queueStats().active).toBe(0);
    expect(T.underflows()).toBe(0);
  });
  it('queued timeout maps to AI_TIMEOUT; queued caller abort is ABORTED; entry removed', async () => {
    for (let i = 0; i < 5; i++) track(relay.ask('fill' + i));
    await flush();
    const p = track(relay.ask('q1', { timeoutMs: 1000 }));
    const ac = new AbortController();
    const p2 = track(relay.ask('q2', { signal: ac.signal }));
    await flush();
    expect(relay.queueStats().waiting).toBe(2);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toMatchObject({ message: 'AI timeout after 1s', code: 'AI_TIMEOUT' });
    ac.abort();
    await expect(p2).rejects.toMatchObject({ message: 'Aborted while queued', code: 'ABORTED' });
    expect(relay.queueStats().waiting).toBe(0);
    expect(relay.queueStats().active).toBe(5);
  });
  it('invalid opts.timeoutMs values are ignored (no timer)', async () => {
    for (const bad of [0, -5, NaN, '100']) {
      const p = track(relay.ask('q', { timeoutMs: bad }));
      await flush();
      vi.advanceTimersByTime(10000);
      await flush();
      calls[calls.length - 1].ok('fine');
      expect(await p).toBe('fine');
    }
  });
  it('classification is independent of race order (transport rejects synchronously on abort)', async () => {
    const p = track(relay.ask('q', { timeoutMs: 50 }));
    await flush();
    vi.advanceTimersByTime(50);
    await expect(p).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
  it('same-tick caller abort on the fast path rejects ABORTED without hanging', async () => {
    const ac = new AbortController();
    const p = track(relay.ask('q', { signal: ac.signal }));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await flush();
    expect(relay.queueStats().active).toBe(0);
  });
  it('a caller abort mid-flight propagates and frees the slot', async () => {
    const ac = new AbortController();
    const p = track(relay.askWithTimeout('q', { timeoutMs: 60000, signal: ac.signal }));
    await flush();
    ac.abort();
    await expect(p).rejects.toThrow(/Abort/);
    await flush();
    expect(relay.queueStats().active).toBe(0);
  });
  it('timeout settles before the abort-driven rejection (ordering pinned)', async () => {
    const order = [];
    const p = relay.runWithTimeout((sig) => new Promise((_, rej) => sig.addEventListener('abort', () => { order.push('abort'); rej(new Error('Aborted by caller')); })),
      { timeoutMs: 10, timeoutMessage: 'site timeout' });
    p.catch(() => {});
    vi.advanceTimersByTime(10);
    await expect(p).rejects.toThrow('site timeout');
    expect(order).toEqual(['abort']);
  });
});

describe('abortable retry sleep and pre-Bedrock guard', () => {
  it('_sleep(ms, signal): every listener added is removed; aborted-at-entry arms no timer; abort clears the timer', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const rem = vi.spyOn(ac.signal, 'removeEventListener');
    for (let i = 0; i < 3; i++) { const s = T.sleep(2000, ac.signal); vi.advanceTimersByTime(2000); await s; }
    expect(add.mock.calls.length).toBe(3);
    expect(rem.mock.calls.length).toBe(3);
    const n = vi.getTimerCount();
    const dead = new AbortController(); dead.abort();
    await T.sleep(2000, dead.signal);
    expect(vi.getTimerCount()).toBe(n);
    const ac2 = new AbortController();
    const s2 = T.sleep(2000, ac2.signal);
    expect(vi.getTimerCount()).toBe(n + 1);
    ac2.abort();
    await s2;
    expect(vi.getTimerCount()).toBe(n);
  });
  it('flag on: an aborted cascade never starts Bedrock; flag off: Bedrock is still tried (parity)', async () => {
    const bedrock = require('../src/scrapers/bedrock');
    const br = vi.spyOn(bedrock, 'askBedrock').mockResolvedValue('');
    T.setBedrockEnabled(true);
    try {
      // Fleet-brain unavailable; WS and Claude fail. Abort arrives during the Claude attempt.
      fleetBrain.getStatus.mockReturnValue({ ready: false, connected: false, localMode: false });
      T.setGatewayFlags({ abortOnTimeout: true });
      const ac = new AbortController();
      T.setClaudeBinExists(() => true);
      const { makeFakeProc } = require('./helpers/ai-gateway-fakes.cjs');
      T.setSpawn(() => { const p = makeFakeProc(vi); setTimeout(() => ac.abort(), 0); return p; });
      const p = relay.ask('q', { signal: ac.signal });
      await expect(p).rejects.toThrow(/Abort/);
      await new Promise((r) => setTimeout(r, 30)); // let the cascade unwind past the Bedrock point
      expect(br).not.toHaveBeenCalled();
      // Flag off: the same failing cascade reaches Bedrock.
      T.setGatewayFlags({});
      T.setClaudeBinExists(() => false);
      vi.useFakeTimers();
      const p2 = relay.ask('q2');
      p2.catch(() => {});
      await flush();
      vi.advanceTimersByTime(2000);
      await flush(100);
      await expect(p2).rejects.toThrow('Orcha AI failed');
      expect(br).toHaveBeenCalled();
    } finally { T.setBedrockEnabled(false); }
  });
});

describe('fleet-brain: detach instead of terminate (abortOnTimeout)', () => {
  const WebSocket = require('ws');
  let ws;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks(); // real fleet-brain.ask / getStatus
    calls = [];
    baseRelaySetup(relay);
    ws = { readyState: WebSocket.OPEN, send: vi.fn(), terminate: vi.fn() };
    fleetBrain.__test__.setSocket(ws);
  });
  afterEach(() => { fleetBrain.__test__.reset(); });
  const sent = () => ws.send.mock.calls.map((c) => JSON.parse(c[0]).message);

  it('timeout of the active request detaches: no terminate, slot released, late reply discarded, B sent next', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const a = track(relay.ask('A-prompt', { requestId: 'A', timeoutMs: 1000 }));
    const b = track(relay.ask('B-prompt', { requestId: 'B' }));
    await flush();
    expect(sent()).toEqual(['A-prompt']);
    vi.advanceTimersByTime(1000);
    await expect(a).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(fleetBrain.__test__.state().activeId).toBe('A');
    expect(relay.queueStats().active).toBe(1); // only B holds a relay slot
    fleetBrain.__test__.handleMessage({ type: 'text_delta', delta: 'A-text' });
    fleetBrain.__test__.handleMessage({ type: 'message_complete' });
    expect(sent()).toEqual(['A-prompt', 'B-prompt']);
    fleetBrain.__test__.handleMessage({ type: 'text_delta', delta: 'B-text' });
    fleetBrain.__test__.handleMessage({ type: 'message_complete' });
    expect(await b).toBe('B-text');
  });
  it('a detached request still hits the 200 s response timeout (terminate once, as today)', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const a = track(relay.ask('A-prompt', { requestId: 'A', timeoutMs: 1000 }));
    await flush();
    vi.advanceTimersByTime(1000);
    await expect(a).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    vi.advanceTimersByTime(200000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
  it('a detached request is never handed to local AI on an Orcha error', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const local = vi.fn(() => Promise.resolve('local'));
    fleetBrain.setLocalAskFn(local);
    const a = track(relay.ask('A-prompt', { requestId: 'A', timeoutMs: 1000 }));
    await flush();
    vi.advanceTimersByTime(1000);
    await expect(a).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    fleetBrain.__test__.handleMessage({ type: 'error', error: 'orcha broke' });
    await flush();
    expect(local).not.toHaveBeenCalled();
    fleetBrain.setLocalAskFn((p, o) => T.localAskFn(p, o));
  });
  it('flag off: caller abort of the active request terminates the socket (today)', async () => {
    T.setGatewayFlags({});
    const ac = new AbortController();
    const a = track(relay.ask('A-prompt', { requestId: 'A', signal: ac.signal }));
    await flush();
    ac.abort();
    await expect(a).rejects.toThrow('Aborted by caller');
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
  it('a queued (non-active) request aborted with detach is spliced; no terminate', async () => {
    const p1 = track(fleetBrain.ask('one', { requestId: 'one' }));
    const ac = new AbortController();
    const p2 = track(fleetBrain.ask('two', { requestId: 'two', signal: ac.signal, detachActiveOnAbort: true }));
    expect(fleetBrain.__test__.state().queueLength).toBe(1);
    ac.abort();
    await expect(p2).rejects.toThrow('Aborted by caller');
    expect(fleetBrain.__test__.state().queueLength).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();
    fleetBrain.__test__.handleMessage({ type: 'message_complete' });
    await p1;
  });
});
