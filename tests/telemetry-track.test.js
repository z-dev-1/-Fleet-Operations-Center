// tests/telemetry-track.test.js — track() is a transparent pass-through
// (src/telemetry/index.js): same value, sync stays sync, same error object.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const telemetry = require('../src/telemetry');

afterEach(() => { telemetry._resetForTests(); });

describe('track()', () => {
  it('sync fn: value returned synchronously (not a Promise) and recorded ok', () => {
    const v = telemetry.track('t.sync', () => 42);
    expect(v).toBe(42);
    const t = telemetry.snapshot().tracks['t.sync'];
    expect(t).toMatchObject({ count: 1, ok: 1, fail: 0 });
    expect(t.lastMs).toBeGreaterThanOrEqual(0);
  });
  it('async fn: resolves the same value', async () => {
    const obj = { a: 1 };
    const p = telemetry.track('t.async', async () => obj);
    expect(typeof p.then).toBe('function');
    expect(await p).toBe(obj);
    expect(telemetry.snapshot().tracks['t.async']).toMatchObject({ count: 1, ok: 1, fail: 0 });
  });
  it('sync throw re-throws the SAME error object and records fail', () => {
    const err = new Error('sync boom');
    let caught;
    try { telemetry.track('t.throw', () => { throw err; }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
    const t = telemetry.snapshot().tracks['t.throw'];
    expect(t).toMatchObject({ count: 1, ok: 0, fail: 1, lastError: 'sync boom' });
  });
  it('async reject re-throws the SAME error object and records fail', async () => {
    const err = new Error('async boom');
    await expect(telemetry.track('t.reject', async () => { throw err; })).rejects.toBe(err);
    expect(telemetry.snapshot().tracks['t.reject']).toMatchObject({ count: 1, ok: 0, fail: 1 });
  });
  it('non-Error throw values pass through untouched', () => {
    let caught;
    try { telemetry.track('t.str', () => { throw 'plain'; }); } catch (e) { caught = e; }
    expect(caught).toBe('plain');
  });
  it('records a duration with the name in recent', async () => {
    await telemetry.track('t.timed', () => new Promise((r) => setTimeout(() => r('x'), 15)));
    const rec = telemetry.snapshot().recent.filter((r) => r.name === 't.timed');
    expect(rec.length).toBe(1);
    expect(rec[0].ok).toBe(true);
    expect(rec[0].ms).toBeGreaterThanOrEqual(5);
  });
  it('skip predicate counts skipped and records no duration', async () => {
    const r = await telemetry.track('t.skip', async () => ({ _skipped: true }), { skip: (x) => !!(x && x._skipped) });
    expect(r).toEqual({ _skipped: true });
    const t = telemetry.snapshot().tracks['t.skip'];
    expect(t).toMatchObject({ count: 0, skipped: 1 });
    expect(telemetry.snapshot().recent.filter((x) => x.name === 't.skip')).toEqual([]);
  });
  it('a throwing skip predicate never affects the caller', () => {
    expect(telemetry.track('t.badskip', () => 7, { skip: () => { throw new Error('x'); } })).toBe(7);
  });
  it('disabled: records nothing and still returns / throws identically', async () => {
    telemetry._setEnabledForTests(false);
    expect(telemetry.track('t.off', () => 5)).toBe(5);
    expect(await telemetry.track('t.off', async () => 6)).toBe(6);
    const err = new Error('off');
    expect(() => telemetry.track('t.off', () => { throw err; })).toThrow(err);
    expect(telemetry.snapshot().tracks['t.off']).toBeUndefined();
  });
  it('recent durations are bounded at 500', () => {
    for (let i = 0; i < 600; i++) telemetry.track('t.many', () => i);
    const s = telemetry.snapshot({ recent: 1000 });
    expect(s.recent.length).toBe(500);
    expect(s.dropped).toBe(100);
    expect(s.tracks['t.many'].count).toBe(600);
  });
  it('per-name aggregates are capped (overflow folds into _other)', () => {
    for (let i = 0; i < 70; i++) telemetry.track('name.' + i, () => i);
    const keys = Object.keys(telemetry.snapshot().tracks);
    expect(keys.length).toBeLessThanOrEqual(65);
    expect(keys).toContain('_other');
    expect(telemetry.snapshot().tracks._other.count).toBe(6);
  });
  describe('snapshot().comms (Phase 4 poller section)', () => {
    const pollerPath = require.resolve('../src/slack/poller');
    let saved;
    const injectPoller = (exportsObj) => {
      require.cache[pollerPath] = { id: pollerPath, filename: pollerPath, loaded: true, exports: exportsObj };
    };
    afterEach(() => {
      if (saved) require.cache[pollerPath] = saved; else delete require.cache[pollerPath];
    });
    it('no comms key when the poller is not loaded (and telemetry does not load it)', () => {
      saved = require.cache[pollerPath];
      delete require.cache[pollerPath];
      const s = telemetry.snapshot();
      expect('comms' in s).toBe(false);
      expect(require.cache[pollerPath]).toBeUndefined();
    });
    it('no comms key when the poller is loaded in off', () => {
      saved = require.cache[pollerPath];
      const getStatus = vi.fn(() => ({ mode: 'off' }));
      injectPoller({ getMode: () => 'off', getStatus });
      expect('comms' in telemetry.snapshot()).toBe(false);
      expect(getStatus).not.toHaveBeenCalled();
    });
    it('no comms key when getMode/getStatus throws', () => {
      saved = require.cache[pollerPath];
      injectPoller({ getMode: () => 'on', getStatus: () => { throw new Error('x'); } });
      expect('comms' in telemetry.snapshot()).toBe(false);
    });
    for (const mode of ['shadow', 'on']) {
      it(`comms equals getStatus() in ${mode}`, () => {
        saved = require.cache[pollerPath];
        const status = { mode, polls: { channelWatch: { runs: 3 } } };
        injectPoller({ getMode: () => mode, getStatus: () => status });
        expect(telemetry.snapshot().comms).toEqual(status);
      });
    }
  });
  it('runCanonicalPass stays synchronous and is tracked as canonical.pass', () => {
    const data = { fleetData: { rows: [] }, canonicalState: { updatedAt: new Date().toISOString(), units: {} } };
    const store = { load: (k, d) => (k in data ? data[k] : d), save: (k, v) => { data[k] = v; } };
    const readyNotify = { _isFreshReady: () => false, enqueue: (fn) => Promise.resolve().then(fn), notifyReadyUnits: vi.fn(async () => ({})) };
    const runner = require('../src/orcha/canonical_runner');
    const res = runner.runCanonicalPass({ deps: { store, readyNotify, notifyDeps: {}, now: () => Date.now(), log: { info() {}, warn() {} } } });
    expect(res && typeof res.then).not.toBe('function');
    expect(res).toHaveProperty('ok');
    expect(telemetry.snapshot().tracks['canonical.pass'].count).toBe(1);
  });
});
