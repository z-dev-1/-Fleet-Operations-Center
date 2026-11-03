// tests/auth-single-flight-wiring.test.js — Phase 9 auth.singleFlight wiring in
// src/scrapers/auth.js (AC-2, AC-6..AC-11c): probeSession / refreshAeaSilently
// share one in-flight attempt with the flag on; flags-off parity otherwise.
// Fakes only (harness): no Electron, network, child process or credential file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const auth = require('../src/scrapers/auth');

const AAP = 'https://aap-na.corp.amazon.com/v2/page/fake';
const ON = { singleFlight: true, singleOwnerAea: false, singleOwnerReconnect: false };
const OFF = { singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function until(cond, max = 100) {
  for (let i = 0; i < max && !cond(); i++) await vi.advanceTimersByTimeAsync(0);
  expect(cond()).toBe(true);
}
// Strictly increasing monotonic clock (1 ms per read) so `fresh` comparisons are deterministic.
function tickingClock() { let t = 0; return () => ++t; }
const aeaSets = () => h.electron.session.defaultSession.setLog.filter((c) => c.name === 'amazon_enterprise_access').length;

let maxAliveAcrossFile = 0;
beforeEach(() => {
  vi.useFakeTimers();
  h.electron.resetCounters();
  h.logs.length = 0;
  h.offline._offline = false;
  auth._setCoordDeps({ flags: ON, now: tickingClock() });
});
afterEach(() => {
  maxAliveAcrossFile = Math.max(maxAliveAcrossFile, h.electron.bw.maxAlive);
  auth._resetCoord();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('singleFlight ON — probeSession', () => {
  it('AC-6: 5 concurrent probes → exactly 1 BrowserWindow, all resolve to the same boolean', async () => {
    const ps = Array.from({ length: 5 }, () => auth.probeSession());
    expect(h.electron.bw.constructed).toBe(1);
    h.electron.navAll(AAP);
    expect(await Promise.all(ps)).toEqual([true, true, true, true, true]);
    expect(h.electron.bw.alive).toBe(0);
    expect(auth._coordStats().probe).toMatchObject({ started: 1, joined: 4 });
  });

  it('AC-8: the 25 s probe timeout releases the slot (all false); the next call opens a new window', async () => {
    const ps = Array.from({ length: 5 }, () => auth.probeSession());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await Promise.all(ps)).toEqual([false, false, false, false, false]);
    expect(h.electron.bw.alive).toBe(0);
    const p = auth.probeSession();
    expect(h.electron.bw.constructed).toBe(2);
    h.electron.navAll(AAP);
    expect(await p).toBe(true);
  });

  it('AC-8: a BrowserWindow constructor throw rejects all callers and releases the slot', async () => {
    h.electron.bw.throwNext = true;
    const ps = Array.from({ length: 5 }, () => auth.probeSession());
    const res = await Promise.allSettled(ps);
    expect(res.every((r) => r.status === 'rejected')).toBe(true);
    const p = auth.probeSession();
    expect(h.electron.bw.constructed).toBe(1);
    h.electron.navAll(AAP);
    expect(await p).toBe(true);
  });

  it('AC-9: a caller arriving after injectCookies() (defaultSession) waits; the first window closes before the second opens', async () => {
    const p1 = auth.probeSession();
    const gen0 = auth._coordStats().cookieGen;
    await auth.injectCookies();
    expect(auth._coordStats().cookieGen).toBe(gen0 + 2);
    const p2 = auth.probeSession();
    expect(h.electron.bw.constructed).toBe(1);
    h.electron.navAll(AAP);
    expect(await p1).toBe(true);
    await until(() => h.electron.bw.constructed === 2);
    h.electron.navAll(AAP);
    expect(await p2).toBe(true);
    expect(h.electron.bw.maxAlive).toBe(1);
  });

  it('AC-9: injectCookies(vendor partition) does not bump the cookie generation', async () => {
    const gen0 = auth._coordStats().cookieGen;
    await auth.injectCookies(h.electron.fakeVendorSession);
    expect(h.electron.fakeVendorSession.sets).toBeGreaterThan(0);
    expect(auth._coordStats().cookieGen).toBe(gen0);
  });
});

describe('singleFlight ON — refreshAeaSilently', () => {
  it('AC-7: 5 concurrent refreshes through the real impl → exactly 1 probe window and 1 AEA inject (4 cookie writes)', async () => {
    const ps = Array.from({ length: 5 }, () => auth.refreshAeaSilently());
    await until(() => h.electron.aliveWindows().length === 1);
    h.electron.navAll(AAP);
    const out = await Promise.all(ps);
    expect(h.electron.bw.constructed).toBe(1);
    expect(aeaSets()).toBe(4);
    expect(out[0]).toMatchObject({ ok: true, via: 'posture-token-direct' });
    expect('coalesced' in out[0]).toBe(false);
    for (const r of out.slice(1)) expect(r).toMatchObject({ ok: true, via: 'posture-token-direct', coalesced: true });
    expect(auth._coordStats().refresh).toMatchObject({ started: 1, joined: 4 });
    expect(h.logs.filter((l) => /joined in-flight silent refresh/.test(l.msg))).toHaveLength(4);
  });

  it('AC-7: with a fake impl → impl ×1 for 5 callers', async () => {
    const d = deferred();
    const impl = vi.fn(() => d.promise);
    auth._setTestImpl({ refreshAeaSilently: impl });
    const ps = Array.from({ length: 5 }, () => auth.refreshAeaSilently());
    d.resolve({ ok: true, refreshed: true });
    const out = await Promise.all(ps);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(out.filter((r) => r.coalesced === true)).toHaveLength(4);
  });

  it('AC-10: a fresh waiter becomes the owner of a new attempt (no coalesced key, no joined log)', async () => {
    const ds = [];
    const impl = vi.fn(() => { const d = deferred(); ds.push(d); return d.promise; });
    auth._setTestImpl({ refreshAeaSilently: impl });
    const p1 = auth.refreshAeaSilently();
    const p2 = auth.refreshAeaSilently({ fresh: true });
    ds[0].resolve({ ok: true, n: 1 });
    expect(await p1).toEqual({ ok: true, n: 1 });
    await until(() => impl.mock.calls.length === 2);
    ds[1].resolve({ ok: true, n: 2 });
    expect(await p2).toEqual({ ok: true, n: 2 });
    expect(h.logs.filter((l) => /joined in-flight silent refresh/.test(l.msg))).toHaveLength(0);
  });

  it('AC-11c + FIX 5: joiner and fresh waiter are served by impl call #2 after 300 s; the owner (#1) remains pending', async () => {
    auth._setCoordDeps({ now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (x) => clearTimeout(x) });
    const second = deferred();
    let calls = 0;
    const impl = vi.fn(() => { calls++; return calls === 1 ? new Promise(() => {}) : second.promise; });
    auth._setTestImpl({ refreshAeaSilently: impl });
    let ownerSettled = false;
    auth.refreshAeaSilently().then(() => { ownerSettled = true; }, () => { ownerSettled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    const joiner = auth.refreshAeaSilently();            // recoverAuth rung-3 shape
    const waiter = auth.refreshAeaSilently({ fresh: true }); // r2 shape
    await vi.advanceTimersByTimeAsync(299_000);
    expect(impl).toHaveBeenCalledTimes(2);
    second.resolve({ ok: true, n: 2 });
    const [j, w] = await Promise.all([joiner, waiter]);
    expect(j.n).toBe(2);
    expect(w.n).toBe(2);
    expect(auth._coordStats().refresh).toMatchObject({ started: 2, staleBroken: 1 });
    expect(h.logs.filter((l) => l.level === 'error' && /single-flight refreshAeaSilently slot stale/.test(l.msg))).toHaveLength(1);
    expect(ownerSettled).toBe(false);
  });

  it('AC-6: across this file no more than one probe window was ever alive at once', () => {
    expect(maxAliveAcrossFile).toBeLessThanOrEqual(1);
  });
});

describe('flags OFF — parity (AC-2)', () => {
  beforeEach(() => { auth._setCoordDeps({ flags: OFF }); });

  it('5 concurrent probeSession() → 5 BrowserWindows', async () => {
    const ps = Array.from({ length: 5 }, () => auth.probeSession());
    expect(h.electron.bw.constructed).toBe(5);
    h.electron.navAll(AAP);
    expect(await Promise.all(ps)).toEqual([true, true, true, true, true]);
    expect(auth._coordStats().probe.started).toBe(0);
  });

  it('5 concurrent refreshAeaSilently() → 5 impl runs, no coalesced keys, wrappers pass no args', async () => {
    const impl = vi.fn(async () => ({ ok: true }));
    const probeImpl = vi.fn(async () => true);
    auth._setTestImpl({ refreshAeaSilently: impl, probeSession: probeImpl });
    const out = await Promise.all(Array.from({ length: 5 }, () => auth.refreshAeaSilently({ fresh: true })));
    expect(impl).toHaveBeenCalledTimes(5);
    expect(impl.mock.calls.every((c) => c.length === 0)).toBe(true);
    expect(out.every((r) => !('coalesced' in r))).toBe(true);
    await auth.probeSession({ fresh: true });
    expect(probeImpl).toHaveBeenCalledTimes(1);
    expect(probeImpl.mock.calls[0]).toHaveLength(0);
    expect(auth._coordStats().refresh.started).toBe(0);
  });
});
