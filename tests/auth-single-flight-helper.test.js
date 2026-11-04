// tests/auth-single-flight-helper.test.js — Phase 9 generic single-flight helper
// (src/auth/single-flight.js). Pure: injected clock + vitest fake timers, so
// nothing waits on real time. Covers REQUIRED FIX 4 (slot before fn, counted
// once) and FIX 5 (the owner of a wedged attempt is not released).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createSingleFlight } = require('../src/auth/single-flight');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let log;
function make(extra) {
  return createSingleFlight(Object.assign({
    name: 'test', staleMs: 60_000, log,
    now: () => Date.now(),                       // faked by vi.useFakeTimers → monotonic fake time
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
  }, extra || {}));
}

beforeEach(() => { vi.useFakeTimers(); log = { error: vi.fn() }; });
afterEach(() => { vi.useRealTimers(); });

describe('single-flight — sharing and release', () => {
  it('N=5 concurrent callers → fn ×1, identical settled value, joined=4, no live timers after settle', async () => {
    const sf = make();
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const ps = Array.from({ length: 5 }, () => sf.run(fn));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sf.inFlight()).toBe(true);
    const val = { ok: true };
    d.resolve(val);
    const out = await Promise.all(ps);
    for (const v of out) expect(v).toBe(val);
    expect(sf.stats()).toMatchObject({ started: 1, joined: 4, waited: 0, staleBroken: 0 });
    expect(sf.inFlight()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolve → the next run starts a new attempt', async () => {
    const sf = make();
    const fn = vi.fn(async () => 1);
    await sf.run(fn);
    await sf.run(fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sf.stats().started).toBe(2);
  });

  it('reject → all 5 reject with the same error, slot clears, next starts', async () => {
    const sf = make();
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const ps = Array.from({ length: 5 }, () => sf.run(fn));
    const err = new Error('boom');
    d.reject(err);
    const res = await Promise.allSettled(ps);
    for (const r of res) { expect(r.status).toBe('rejected'); expect(r.reason).toBe(err); }
    expect(sf.inFlight()).toBe(false);
    expect(sf.stats().rejected).toBe(1);
    await sf.run(async () => 2);
    expect(sf.stats().started).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('synchronous throw in fn → rejection and the slot is cleared', async () => {
    const sf = make();
    await expect(sf.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(sf.inFlight()).toBe(false);
    expect(sf.stats().rejected).toBe(1);
  });

  it('FIX 4b: synchronous re-entry from inside fn joins the slot (no second start)', async () => {
    const sf = make();
    const otherFn = vi.fn(async () => 'other');
    let inner;
    const fn = () => { inner = sf.run(otherFn); return Promise.resolve('outer'); };
    const outer = await sf.run(fn);
    expect(outer).toBe('outer');
    expect(await inner).toBe('outer');
    expect(otherFn).toHaveBeenCalledTimes(0);
    expect(sf.stats().started).toBe(1);
    expect(sf.stats().joined).toBe(1);
  });
});

describe('single-flight — generation and fresh', () => {
  it('gen change mid-flight → late caller waits, exactly one new start, a third late caller joins it; max concurrent 1', async () => {
    const sf = make();
    let gen = 0;
    let live = 0, maxLive = 0;
    const ds = [];
    const fn = vi.fn(() => { live++; maxLive = Math.max(maxLive, live); const d = deferred(); ds.push(d); return d.promise.finally(() => { live--; }); });
    const p1 = sf.run(fn, { gen: () => gen });
    gen++;
    const p2 = sf.run(fn, { gen: () => gen });
    const p3 = sf.run(fn, { gen: () => gen });
    expect(fn).toHaveBeenCalledTimes(1);
    ds[0].resolve('a');
    expect(await p1).toBe('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    ds[1].resolve('b');
    expect(await p2).toBe('b');
    expect(await p3).toBe('b');
    expect(maxLive).toBe(1);
    expect(sf.stats()).toMatchObject({ started: 2, waited: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fresh waits for the in-flight attempt; two fresh waiters share one new attempt', async () => {
    const sf = make();
    const ds = [];
    const fn = vi.fn(() => { const d = deferred(); ds.push(d); return d.promise; });
    const p0 = sf.run(fn);
    await vi.advanceTimersByTimeAsync(5);
    const f1 = sf.run(fn, { fresh: true });
    const f2 = sf.run(fn, { fresh: true });
    ds[0].resolve('old');
    expect(await p0).toBe('old');
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    ds[1].resolve('new');
    expect(await f1).toBe('new');
    expect(await f2).toBe('new');
    expect(sf.stats().started).toBe(2);
  });
});

describe('single-flight — stale deadline', () => {
  it('arriving caller at staleMs breaks the slot (error ×1, new start); the old slot\'s late settle does not clear the new one', async () => {
    const sf = make();
    const old = deferred();
    const p0 = sf.run(() => old.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    const fresh = deferred();
    const p1 = sf.run(() => fresh.promise);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/single-flight test slot stale/);
    expect(sf.stats()).toMatchObject({ started: 2, staleBroken: 1 });
    old.resolve('late');
    expect(await p0).toBe('late');
    expect(sf.inFlight()).toBe(true);        // identity check: still the replacement slot
    fresh.resolve('new');
    expect(await p1).toBe('new');
    expect(sf.inFlight()).toBe(false);
  });

  it('AC-11b + FIX 5: 3 joiners + 1 fresh waiter are served by ONE replacement at staleMs; the owner stays pending', async () => {
    const sf = make();
    let calls = 0;
    const second = deferred();                 // the replacement takes a while, like a real probe/refresh
    const fn = vi.fn(() => { calls++; return calls === 1 ? new Promise(() => {}) : second.promise; });
    let ownerSettled = false;
    const owner = sf.run(fn);
    owner.then(() => { ownerSettled = true; }, () => { ownerSettled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    const js = [sf.run(fn), sf.run(fn), sf.run(fn)];
    const fw = sf.run(fn, { fresh: true });
    await vi.advanceTimersByTimeAsync(59_000);
    second.resolve('second');
    const out = await Promise.all([...js, fw]);
    expect(out).toEqual(['second', 'second', 'second', 'second']);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sf.stats()).toMatchObject({ started: 2, staleBroken: 1, joined: 3, waited: 1 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(ownerSettled).toBe(false);          // FIX 5: owner awaits its own (wedged) attempt
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a gen-mismatch waiter on a never-settling slot is released at the deadline and served by the replacement', async () => {
    const sf = make();
    let gen = 0, calls = 0;
    const fn = () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve('r' + calls); };
    sf.run(fn, { gen: () => gen });
    gen++;
    const w = sf.run(fn, { gen: () => gen });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await w).toBe('r2');
    expect(sf.stats()).toMatchObject({ started: 2, waited: 1, staleBroken: 1 });
  });

  it('FIX 4c: a deadline timer that fires 1 ms early does not double-count joined', async () => {
    // fires 1 ms before the deadline (a real Node timer can), then on time for the re-armed 1 ms remainder
    const sf = make({ setTimer: (fn, ms) => setTimeout(fn, ms >= 2 ? ms - 1 : ms) });
    let calls = 0;
    const fn = () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve('ok'); };
    sf.run(fn);
    const j = sf.run(fn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await j).toBe('ok');
    expect(sf.stats().joined).toBe(1);
    expect(sf.stats().staleBroken).toBe(1);
  });

  it('a joiner whose slot settles early clears its deadline timer', async () => {
    const clearTimer = vi.fn((h) => clearTimeout(h));
    const sf = make({ clearTimer });
    const d = deferred();
    sf.run(() => d.promise);
    const j = sf.run(() => d.promise);
    expect(vi.getTimerCount()).toBe(1);
    d.resolve(1);
    await j;
    expect(clearTimer).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
