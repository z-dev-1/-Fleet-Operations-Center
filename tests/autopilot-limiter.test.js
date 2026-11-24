// tests/autopilot-limiter.test.js — fleet-autopilot §B7.6: deadlines, orphan slots, retries,
// hourly buckets, per-tick and per-run caps. Fake timers; fake live calls in the ports.js
// result shape ({ ok:true, value } | { ok:false, code, status }).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createLimiter, withDeadline, classifyOutcome, HOURLY, DEADLINE_MS, RETRY_BASE_MS, RETRY_JITTER_MS } = require('../src/autopilot/limiter');

function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

afterEach(() => { vi.useRealTimers(); });

describe('withDeadline', () => {
  it('returns {timedOut:true} exactly at the deadline, {value} / {error} before it', async () => {
    vi.useFakeTimers();
    const d = deferred();
    let out = null;
    withDeadline(d.p, 1000).then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(999);
    expect(out).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual({ timedOut: true });
    d.resolve(5);   // a late settle is ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toEqual({ timedOut: true });
    expect(await withDeadline(Promise.resolve(7), 10)).toEqual({ value: 7 });
    const err = new Error('x');
    expect(await withDeadline(Promise.reject(err), 10)).toEqual({ error: err });
  });

  it('is not built on Promise.race', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/autopilot/limiter.js'), 'utf8');
    expect(src).not.toMatch(/Promise\.race/);
  });
});

describe('classifyOutcome', () => {
  it('maps codes to source statuses and retry rules', () => {
    expect(classifyOutcome({ value: { ok: true, value: 1 } })).toMatchObject({ status: 'ok', value: 1, retry: false });
    expect(classifyOutcome({ timedOut: true })).toMatchObject({ status: 'error:timeout', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'MIDWAY_SESSION_INVALID' } })).toMatchObject({ status: 'auth_unavailable', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'DECISIV_SESSION_INVALID' } })).toMatchObject({ status: 'auth_unavailable', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'DECISIV_API_ERROR', status: 403 } })).toMatchObject({ status: 'auth_unavailable', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'AAP_NOT_WARM' } })).toMatchObject({ status: 'not_warm', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'DECISIV_NOT_WARM' } })).toMatchObject({ status: 'not_warm', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'DECISIV_API_TIMEOUT' } })).toMatchObject({ status: 'error:timeout', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'AAP_API_ERROR', status: 503 } })).toMatchObject({ status: 'error:AAP_API_ERROR', retry: true });
    expect(classifyOutcome({ value: { ok: false, code: 'AAP_API_ERROR', status: 0 } })).toMatchObject({ retry: true });
    expect(classifyOutcome({ value: { ok: false, code: 'AAP_API_ERROR', status: 404 } })).toMatchObject({ status: 'error:AAP_API_ERROR', retry: false });
    expect(classifyOutcome({ value: { ok: false, code: 'LIVE_READS_OFF' } })).toMatchObject({ status: 'cache_only:live_reads_off', precall: true });
    expect(classifyOutcome({ value: { ok: false, code: 'DECISIV_NO_ORIGIN' } })).toMatchObject({ status: 'cache_only:no_origin' });
  });
});

describe('limiter.call', () => {
  it('deadlines are AAP 20 s and Decisiv 30 s; hourly buckets 30 / 12', () => {
    expect(DEADLINE_MS).toEqual({ aap_live: 20000, decisiv: 30000 });
    expect(HOURLY).toEqual({ aap_live: 30, decisiv: 12 });
  });

  it('a timeout keeps the source slot until the orphan settles (busy_orphan), with no retry', async () => {
    vi.useFakeTimers();
    const lim = createLimiter();
    const run = lim.run();
    const d = deferred();
    const fn = vi.fn(() => d.p);
    const pr = run.call('aap_live', fn);
    await vi.advanceTimersByTimeAsync(20000);
    const r = await pr;
    expect(r).toMatchObject({ source: 'aap_live', status: 'error:timeout', attempts: 1, live: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(lim.isOrphaned('aap_live')).toBe(true);
    const other = vi.fn(async () => ({ ok: true, value: 1 }));
    expect(await run.call('aap_live', other)).toMatchObject({ status: 'busy_orphan' });
    expect(other).not.toHaveBeenCalled();
    // A different source is not blocked.
    expect(await run.call('decisiv', other)).toMatchObject({ status: 'ok', value: 1 });
    d.resolve({ ok: true, value: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lim.isOrphaned('aap_live')).toBe(false);
    expect(await run.call('aap_live', other)).toMatchObject({ status: 'ok' });
  });

  it('one retry after a settled 5xx, after 2 s + 0-1 s jitter', async () => {
    vi.useFakeTimers();
    for (const rnd of [0, 0.999]) {
      const lim = createLimiter({ random: () => rnd });
      const fn = vi.fn()
        .mockResolvedValueOnce({ ok: false, code: 'AAP_API_ERROR', status: 502 })
        .mockResolvedValueOnce({ ok: true, value: 'second' });
      const pr = lim.run().call('aap_live', fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      const wait = RETRY_BASE_MS + Math.floor(rnd * RETRY_JITTER_MS);
      expect(wait).toBeGreaterThanOrEqual(2000);
      expect(wait).toBeLessThan(3000);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pr).toMatchObject({ status: 'ok', value: 'second', attempts: 2 });
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it('at most one retry; no retry for auth, not-warm or a 4xx', async () => {
    vi.useFakeTimers();
    const lim = createLimiter({ random: () => 0 });
    const run = lim.run();
    const five = vi.fn(async () => ({ ok: false, code: 'AAP_API_ERROR', status: 500 }));
    const p = run.call('aap_live', five);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toMatchObject({ status: 'error:AAP_API_ERROR', attempts: 2 });
    expect(five).toHaveBeenCalledTimes(2);
    for (const res of [{ ok: false, code: 'MIDWAY_SESSION_INVALID' }, { ok: false, code: 'AAP_NOT_WARM' }, { ok: false, code: 'AAP_API_ERROR', status: 404 }]) {
      const fn = vi.fn(async () => res);
      const q = run.call('aap_live', fn);
      await vi.advanceTimersByTimeAsync(5000);
      await q;
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('an empty hourly bucket -> rate_limited without calling; refills after an hour', async () => {
    let t = 1_000_000;
    const lim = createLimiter({ now: () => t, hourly: { decisiv: 2 }, maxPerTick: 100 });
    const run = lim.run();
    const fn = vi.fn(async () => ({ ok: true, value: 1 }));
    await run.call('decisiv', fn);
    await run.call('decisiv', fn);
    expect(await run.call('decisiv', fn)).toMatchObject({ status: 'rate_limited' });
    expect(fn).toHaveBeenCalledTimes(2);
    t += 60 * 60 * 1000;
    expect(await run.call('decisiv', fn)).toMatchObject({ status: 'ok' });
  });

  it('pre-call answers (gate closed) refund the token', async () => {
    const lim = createLimiter({ hourly: { aap_live: 1 } });
    const run = lim.run();
    expect(await run.call('aap_live', async () => ({ ok: false, code: 'GATE_CLOSED' }))).toMatchObject({ status: 'cache_only:gate_closed' });
    expect(lim.tokensLeft('aap_live')).toBe(1);
  });

  it('at most 6 live calls per tick; beginTick resets', async () => {
    const lim = createLimiter();
    const run = lim.run();
    const fn = vi.fn(async () => ({ ok: true, value: 1 }));
    const out = [];
    for (let i = 0; i < 7; i++) out.push(await run.call(i % 2 ? 'aap_live' : 'decisiv', fn));
    expect(out.filter((r) => r.status === 'ok')).toHaveLength(6);
    expect(out[6]).toMatchObject({ status: 'cache_only:budget' });
    expect(fn).toHaveBeenCalledTimes(6);
    lim.beginTick();
    expect(await run.call('aap_live', fn)).toMatchObject({ status: 'ok' });
  });

  it('one in-flight call per source and at most 2 in parallel per run', async () => {
    const lim = createLimiter({ hourly: { x: 100 } });
    const run = lim.run();
    let active = 0;
    let maxActive = 0;
    let maxPerSource = 0;
    const per = {};
    const mk = (src) => async () => {
      active++; per[src] = (per[src] || 0) + 1;
      maxActive = Math.max(maxActive, active); maxPerSource = Math.max(maxPerSource, per[src]);
      await new Promise((r) => setTimeout(r, 5));
      active--; per[src]--;
      return { ok: true, value: src };
    };
    const res = await Promise.all([
      run.call('aap_live', mk('aap_live')), run.call('aap_live', mk('aap_live')),
      run.call('decisiv', mk('decisiv')), run.call('x', mk('x')),
    ]);
    expect(res.every((r) => r.status === 'ok')).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxPerSource).toBe(1);
  });

  it('an aborted signal skips the call', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    expect(await createLimiter().run({ signal: ac.signal }).call('aap_live', fn)).toMatchObject({ status: 'skipped:aborted' });
    expect(fn).not.toHaveBeenCalled();
  });
});
