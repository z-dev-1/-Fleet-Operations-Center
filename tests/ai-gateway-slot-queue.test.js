// tests/ai-gateway-slot-queue.test.js — relay slot gate: 4 priorities, reservation,
// aging, lift timer, legacy parity, exactly-once release. Fake fleet-brain only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-slots-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, installFakeFleetBrain, baseRelaySetup, deferred } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let calls;
const pending = [];
function ask(prompt, opts) { const p = relay.ask(prompt, opts); p.catch(() => {}); pending.push(p); return p; }
async function releaseFirstOpen() {
  const d = calls.find((c) => !c.settled);
  d.ok('ok:' + d.prompt);
  await flush();
  return d.prompt;
}
async function fill(n, opts) { for (let i = 0; i < n; i++) ask('fill' + i, opts); await flush(); }
const granted = () => calls.map((c) => c.prompt);
async function drain() {
  for (let i = 0; i < 30; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
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

describe('gateway mode (ai.gateway.priorities on)', () => {
  it('orders critical > high > normal (FIFO) > low; low blocked by reservation', async () => {
    T.setGatewayFlags({ priorities: true, reserveSlots: 2 });
    await fill(5);
    expect(calls.length).toBe(5);
    ask('L', { priority: 'low' });
    ask('N1', { priority: 'normal' });
    ask('H', { priority: 'high' });
    ask('C', { priority: 'critical' });
    ask('N2', {});
    await flush();
    expect(relay.queueStats().waiting).toBe(5);
    for (let i = 0; i < 4; i++) await releaseFirstOpen();
    expect(granted().slice(5)).toEqual(['C', 'H', 'N1', 'N2']);
    // L still waiting: 5 active, reservation keeps low out of the last 2 slots.
    await releaseFirstOpen(); // active 4
    await releaseFirstOpen(); // active 3 -> still >= MAX - 2
    expect(granted()).not.toContain('L');
    await releaseFirstOpen(); // active 2 -> low may take a slot
    expect(granted()).toContain('L');
  });

  it('reservation: 3 active blocks low while normal is granted; N=0 lets low take all', async () => {
    T.setGatewayFlags({ priorities: true, reserveSlots: 2 });
    await fill(3);
    ask('L', { priority: 'low' });
    await flush();
    expect(granted()).not.toContain('L');
    ask('N', { priority: 'normal' });
    await flush();
    expect(granted()).toContain('N');
    expect(relay.queueStats().byPriority.low.waiting).toBe(1);
    await drain();
    T.reset();
    calls.length = 0;
    T.setGatewayFlags({ priorities: true, reserveSlots: 0 });
    for (let i = 0; i < 5; i++) ask('low' + i, { priority: 'low' });
    await flush();
    expect(calls.length).toBe(5);
  });

  it('source map assigns priority when no explicit priority is given', async () => {
    T.setGatewayFlags({ priorities: true, reserveSlots: 0 });
    await fill(5);
    ask('bg', { source: 'deep_scan' });
    ask('dm', { source: 'slack_dm_legacy' });
    ask('chat', { source: 'orcha_action:chat' });
    await flush();
    const q = relay.queueStats().byPriority;
    expect([q.low.waiting, q.high.waiting, q.normal.waiting]).toEqual([1, 1, 1]);
    for (let i = 0; i < 3; i++) await releaseFirstOpen();
    expect(granted().slice(5)).toEqual(['dm', 'chat', 'bg']);
  });

  it('aging: a low waiting 61 s beats a fresh normal (reservation off)', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true, reserveSlots: 0 });
    await fill(5);
    ask('L', { priority: 'low' });
    await flush();
    vi.advanceTimersByTime(61000);
    ask('N', { priority: 'normal' });
    await flush();
    await releaseFirstOpen();
    expect(granted()[5]).toBe('L');
  });

  it('lift timer grants a reservation-blocked low at 120 s with no release', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true, reserveSlots: 2 });
    await fill(3);
    ask('L', { priority: 'low' });
    await flush();
    expect(T.liftTimerArmed()).toBe(true);
    vi.advanceTimersByTime(119000);
    await flush();
    expect(granted()).not.toContain('L');
    vi.advanceTimersByTime(1100);
    await flush();
    expect(granted()).toContain('L');
  });

  it('lift timer after a flip to legacy grants via the legacy head-of-queue loop', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true, reserveSlots: 2 });
    await fill(3);
    ask('L', { priority: 'low' });
    await flush();
    T.setGatewayFlags({ priorities: false });
    vi.advanceTimersByTime(120100);
    await flush();
    expect(granted()).toContain('L'); // legacy grants the head while a slot is free
  });

  it('queueStats: byPriority / reserve / oldestWaitMs / flags', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true, reserveSlots: 1 });
    await fill(5, { priority: 'high' });
    ask('n', {});
    await flush();
    vi.advanceTimersByTime(1500);
    const q = relay.queueStats();
    expect(q.active).toBe(5);
    expect(q.waiting).toBe(1);
    expect(q.max).toBe(5);
    expect(q.reserve).toBe(1);
    expect(q.byPriority.high).toEqual({ active: 5, waiting: 0 });
    expect(q.byPriority.normal).toEqual({ active: 0, waiting: 1 });
    expect(q.oldestWaitMs).toBeGreaterThanOrEqual(1500);
    expect(q.flags.priorities).toBe(true);
    expect(q.claudePool).toMatchObject({ size: 1, queued: 0 });
  });

  it('flag flip with waiters strands nothing', async () => {
    T.setGatewayFlags({ priorities: true, reserveSlots: 0 });
    await fill(5);
    ask('a', { priority: 'low' }); ask('b', { priority: 'high' });
    await flush();
    T.setGatewayFlags({ priorities: false });
    await releaseFirstOpen();
    await releaseFirstOpen();
    expect(granted().slice(5).sort()).toEqual(['a', 'b']);
  });
});

describe('legacy parity (all flags off)', () => {
  it("only 'high' jumps; critical/low/garbage are FIFO-normal; fleet-brain gets the raw priority", async () => {
    T.setGatewayFlags({});
    await fill(5);
    ask('N1', {}); ask('L', { priority: 'low' }); ask('C', { priority: 'critical' }); ask('H', { priority: 'high' }); ask('G', { priority: 'zzz' });
    await flush();
    for (let i = 0; i < 5; i++) await releaseFirstOpen();
    expect(granted().slice(5)).toEqual(['H', 'N1', 'L', 'C', 'G']);
    const c = calls.find((x) => x.prompt === 'C');
    expect(Object.keys(c.opts).sort()).toEqual(['priority', 'requestId', 'signal']);
    expect(c.opts.priority).toBe('critical');
    expect(relay.queueStats().byPriority.critical.active).toBe(0); // legacy labels: high | normal
  });
  it('a free slot is taken immediately even with a queue (old fast path)', async () => {
    T.setGatewayFlags({});
    await fill(4);
    ask('x', { priority: 'low' });
    await flush();
    expect(granted()).toContain('x');
  });
});

describe('exactly-once release', () => {
  it('runInSlot with a throwing fn releases once', async () => {
    T.setGatewayFlags({ priorities: true });
    await expect(relay.runInSlot(async () => { throw new Error('vision bug'); }, { source: 'vision_image' })).rejects.toThrow('vision bug');
    expect(relay.queueStats().active).toBe(0);
    expect(Object.values(T.activeBy()).every((n) => n === 0)).toBe(true);
    expect(T.underflows()).toBe(0);
  });
  it('runInSlot flag off calls fn directly (no slot accounting)', async () => {
    T.setGatewayFlags({});
    let seen = null;
    await relay.runInSlot(async () => { seen = relay.queueStats().active; return { ok: true }; });
    expect(seen).toBe(0);
  });
  it('abort while queued (abortOnTimeout) leaves active unchanged; next release grants once', async () => {
    T.setGatewayFlags({ priorities: true, abortOnTimeout: true, reserveSlots: 0 });
    await fill(5);
    const ac = new AbortController();
    const p = ask('W', { signal: ac.signal });
    ask('X', {});
    await flush();
    ac.abort();
    await expect(p).rejects.toMatchObject({ message: 'Aborted while queued', code: 'ABORTED' });
    expect(relay.queueStats().active).toBe(5);
    expect(relay.queueStats().waiting).toBe(1);
    await releaseFirstOpen();
    expect(granted().slice(5)).toEqual(['X']);
  });
  it('abort while queued with the flag off: the entry stays queued (today)', async () => {
    T.setGatewayFlags({});
    await fill(5);
    const ac = new AbortController();
    ask('W', { signal: ac.signal });
    await flush();
    ac.abort();
    await flush();
    expect(relay.queueStats().waiting).toBe(1);
  });
  it('same-tick grant + abort: the waiter runs and is released exactly once', async () => {
    T.setGatewayFlags({ priorities: true, abortOnTimeout: true });
    await fill(5);
    const ac = new AbortController();
    const p = ask('W', { signal: ac.signal });
    await flush();
    calls[0].ok('done'); // the release (and W's grant) happens a few microtasks later
    // Abort in the first microtask after W's grant (before W's own code runs on).
    for (let i = 0; i < 60; i++) { await Promise.resolve(); if (relay.queueStats().waiting === 0) { ac.abort(); break; } }
    expect(ac.signal.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await drain();
    expect(relay.queueStats().active).toBe(0);
    expect(T.underflows()).toBe(0);
  });
  it('randomized 200 ops (acquire/release/abort, flag flip at op 100) keep accounting exact', async () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const prios = ['critical', 'high', 'normal', 'low', undefined];
    const ctrls = [];
    T.setGatewayFlags({ priorities: true, abortOnTimeout: true, reserveSlots: 2 });
    for (let op = 0; op < 200; op++) {
      if (op === 100) T.setGatewayFlags({ priorities: false, abortOnTimeout: true });
      const r = rnd();
      if (r < 0.45) {
        const ac = new AbortController(); ctrls.push(ac);
        ask('r' + op, { priority: prios[Math.floor(rnd() * prios.length)], signal: ac.signal });
      } else if (r < 0.8) {
        const open = calls.filter((c) => !c.settled);
        if (open.length) open[Math.floor(rnd() * open.length)].ok('ok');
      } else if (ctrls.length) {
        ctrls[Math.floor(rnd() * ctrls.length)].abort();
      }
      await flush(8);
      const q = relay.queueStats();
      expect(q.active).toBeLessThanOrEqual(5);
      expect(Object.values(T.activeBy()).every((n) => n >= 0)).toBe(true);
    }
    // Lows may be reservation-blocked: lift reservation for the drain.
    T.setGatewayFlags({ priorities: false, abortOnTimeout: true });
    await drain();
    const q = relay.queueStats();
    expect(q.active).toBe(0);
    expect(q.waiting).toBe(0);
    expect(Object.values(T.activeBy()).every((n) => n === 0)).toBe(true);
    expect(T.underflows()).toBe(0);
  });
});

// Keep the deferred helper import used (shared module sanity).
it('helper deferred resolves', async () => { const d = deferred(); d.resolve(1); expect(await d.promise).toBe(1); });
