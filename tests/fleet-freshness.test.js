// tests/fleet-freshness.test.js — src/health/fleet-freshness.js (plan.md D1/D2).
// Fake clock, injected store / guard snapshot / AAP stats. The last two blocks
// integrate the real createApiLoadGuard({ now }) and the real aap_api counters
// (fake browser_provider + fake timers, the tests/aap-api-timeout.test.js pattern).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fleet-freshness-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const ff = require('../src/health/fleet-freshness');
const { createApiLoadGuard, API_LOAD_MAX_AGE_MS } = require('../src/window/api-load-guard');
const aap = require('../src/scrapers/aap_api');

const T = 1763000000000;
const MIN = 60 * 1000;
const HOUR_MS = 60 * MIN;

function mkStore(seed) {
  const data = Object.assign({}, seed || {});
  return {
    data,
    load: vi.fn((k, d) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d)),
    save: vi.fn((k, v) => { data[k] = JSON.parse(JSON.stringify(v)); }),
  };
}

let t;
let guard;
let stats;
let store;
function setup(over) {
  t = T;
  guard = { busy: false, startedAt: 0, token: 0, pending: null };
  stats = null;
  store = mkStore();
  ff.init(Object.assign({
    store,
    now: () => t,
    getIntervalMs: () => HOUR_MS,
    getGuardSnapshot: () => guard,
    getAapStats: () => stats,
  }, over || {}));
}

beforeEach(() => { ff._resetForTests(); });

describe('fleet-freshness constants', () => {
  it('exports the D1 constants', () => {
    expect(ff.INFLIGHT_AMBER_MS).toBe(5 * MIN);
    expect(ff.INFLIGHT_RED_MS).toBe(API_LOAD_MAX_AGE_MS);
    expect(ff.AMBER_AGE_FACTOR).toBe(2);
    expect(ff.RED_AGE_FACTOR).toBe(3);
    expect(ff.AAP_TIMEOUT_STREAK_RED).toBe(3);
    expect(ff.DEFAULT_INTERVAL_MS).toBe(5 * MIN);
    expect(ff.STORE_KEY).toBe('fleetFreshness');
  });
});

describe('evaluate() level rules', () => {
  beforeEach(() => setup());

  it('grey with no successful build', () => {
    const e = ff.evaluate();
    expect(e).toMatchObject({ level: 'grey', health: 'unknown', reasons: ['no-success-yet'], ageMs: null, intervalMs: HOUR_MS });
  });

  it('age thresholds with a 60-min interval: 30m green, 90m green+aging, 121m amber, 181m red', () => {
    ff.recordBuildOk({ count: 200, at: T });
    t = T + 30 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'green', health: 'healthy', reasons: [] });
    t = T + 90 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'green', reasons: ['aging'] });
    t = T + 121 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'amber', health: 'degraded', reasons: ['age>2x'] });
    t = T + 181 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'red', health: 'unhealthy', reasons: ['age>3x'], ageMs: 181 * MIN });
  });

  it('in flight 4m green, 6m amber, 10m red wedged', () => {
    ff.recordBuildOk({ count: 1, at: T });
    guard = { busy: true, startedAt: T, token: 1, pending: null };
    t = T + 4 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'green', inFlightMs: 4 * MIN });
    t = T + 6 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'amber', reasons: ['in-flight>5m'] });
    t = T + 10 * MIN;
    expect(ff.evaluate()).toMatchObject({ level: 'red', reasons: ['wedged'] });
  });

  it('superseded after the last ok is red; a later ok is green again', () => {
    ff.recordBuildOk({ count: 1, at: T });
    t = T + MIN;
    ff.recordSuperseded({ ageMs: 11 * MIN });
    expect(ff.evaluate()).toMatchObject({ level: 'red', reasons: ['superseded'] });
    t = T + 2 * MIN;
    ff.recordBuildOk({ count: 1 });
    expect(ff.evaluate()).toMatchObject({ level: 'green', reasons: [] });
    expect(ff.getSnapshot().supersededCount).toBe(1);
  });

  it('consecutiveTimeouts 2 is not red; 3 is red aap-timeouts / unhealthy', () => {
    ff.recordBuildOk({ count: 1, at: T });
    stats = { timeouts: 2, consecutiveTimeouts: 2, lastTimeoutAt: T, lastOkAt: null };
    expect(ff.evaluate().level).toBe('green');
    stats = { timeouts: 3, consecutiveTimeouts: 3, lastTimeoutAt: T, lastOkAt: null };
    expect(ff.evaluate()).toMatchObject({ level: 'red', health: 'unhealthy', reasons: ['aap-timeouts'] });
  });

  it('aap-timeouts is red even before the first successful build', () => {
    stats = { timeouts: 3, consecutiveTimeouts: 3 };
    expect(ff.evaluate()).toMatchObject({ level: 'red', reasons: ['aap-timeouts'] });
  });

  it('last-build-failed is informational only', () => {
    ff.recordBuildOk({ count: 1, at: T });
    t = T + MIN;
    ff.recordBuildFailed({ code: 'AAP_API_TIMEOUT', message: 'x' });
    expect(ff.evaluate()).toMatchObject({ level: 'green', reasons: ['last-build-failed'] });
  });
});

describe('records, persistence and listeners', () => {
  it('recordBuildOk persists { lastOkAt, lastOkCount } and init seeds from the store', () => {
    setup();
    ff.recordBuildOk({ count: 42, at: T + 5 });
    expect(store.save).toHaveBeenCalledWith('fleetFreshness', { lastOkAt: T + 5, lastOkCount: 42 });
    const saved = store.data.fleetFreshness;
    ff._resetForTests();
    const s2 = mkStore({ fleetFreshness: saved });
    ff.init({ store: s2, now: () => T + 10, getIntervalMs: () => HOUR_MS });
    expect(ff.getSnapshot()).toMatchObject({ lastOkAt: T + 5, lastOkCount: 42 });
  });

  it('init ignores a non-finite stored lastOkAt and is idempotent', () => {
    const s = mkStore({ fleetFreshness: { lastOkAt: 'yesterday', lastOkCount: 3 } });
    ff.init({ store: s, now: () => T });
    expect(ff.getSnapshot().lastOkAt).toBe(null);
    ff.init({ store: mkStore({ fleetFreshness: { lastOkAt: T } }), now: () => T });
    expect(ff.getSnapshot().lastOkAt).toBe(null);
  });

  it('a store that throws never breaks a record', () => {
    ff.init({ store: { load: () => { throw new Error('x'); }, save: () => { throw new Error('y'); } }, now: () => T });
    expect(() => ff.recordBuildOk({ count: 1 })).not.toThrow();
    expect(ff.getSnapshot().lastOkAt).toBe(T);
  });

  it('recordBuildFailed clips code/message and counts consecutiveFailures; ok resets it', () => {
    setup();
    ff.recordBuildFailed({ code: 'C'.repeat(60), message: 'm'.repeat(400) });
    ff.recordBuildFailed({ message: 'again' });
    const s = ff.getSnapshot();
    expect(s.lastFailCode).toBe('ERROR');
    expect(s.consecutiveFailures).toBe(2);
    ff._resetForTests(); setup();
    ff.recordBuildFailed({ code: 'C'.repeat(60), message: 'm'.repeat(400) });
    expect(ff.getSnapshot().lastFailCode.length).toBe(40);
    expect(ff.getSnapshot().lastFailMessage.length).toBe(160);
    ff.recordBuildOk({ count: 1 });
    expect(ff.getSnapshot().consecutiveFailures).toBe(0);
  });

  it('snapshot shape (D1)', () => {
    setup();
    stats = { timeouts: 1, consecutiveTimeouts: 1, lastTimeoutAt: T - 1, lastOkAt: T - 2, extra: 'drop' };
    const s = ff.getSnapshot();
    expect(Object.keys(s).sort()).toEqual(['aap', 'at', 'buildInFlight', 'buildStartedAt', 'consecutiveFailures', 'intervalMs',
      'lastFailAt', 'lastFailCode', 'lastFailMessage', 'lastOkAt', 'lastOkCount', 'lastSupersededAt', 'supersededCount', 'v'].sort());
    expect(s.aap).toEqual({ timeouts: 1, consecutiveTimeouts: 1, lastTimeoutAt: T - 1, lastOkAt: T - 2 });
    expect(s.v).toBe(1);
  });

  it('throwing getters degrade to not-in-flight / aap null', () => {
    setup({ getGuardSnapshot: () => { throw new Error('g'); }, getAapStats: () => { throw new Error('a'); } });
    const s = ff.getSnapshot();
    expect(s.buildInFlight).toBe(false);
    expect(s.aap).toBe(null);
  });

  it('listeners receive { snapshot, evaluation } after each record; a throwing listener is isolated', () => {
    setup();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    ff.subscribe(bad);
    const off = ff.subscribe(good);
    ff.recordBuildOk({ count: 5 });
    ff.recordBuildFailed({ code: 'X' });
    ff.recordSuperseded({ ageMs: 1 });
    expect(bad).toHaveBeenCalledTimes(3);
    expect(good).toHaveBeenCalledTimes(3);
    const p = good.mock.calls[0][0];
    expect(p.snapshot.lastOkCount).toBe(5);
    expect(p.evaluation.level).toBe('green');
    off();
    ff.recordBuildOk({ count: 6 });
    expect(good).toHaveBeenCalledTimes(3);
  });

  it('interval: default reads settings.syncIntervalMinutes (1..360), else 5 min', () => {
    const realStore = require('../src/store');
    ff.init({ store: mkStore(), now: () => T });
    realStore.save('settings', { syncIntervalMinutes: 60 });
    expect(ff.getSnapshot().intervalMs).toBe(HOUR_MS);
    realStore.save('settings', { syncIntervalMinutes: 'abc' });
    expect(ff.getSnapshot().intervalMs).toBe(5 * MIN);
    realStore.save('settings', { syncIntervalMinutes: 999 });
    expect(ff.getSnapshot().intervalMs).toBe(5 * MIN);
    realStore.save('settings', {});
  });

  it('interval: a throwing or invalid getIntervalMs falls back to 5 min', () => {
    ff.init({ store: mkStore(), now: () => T, getIntervalMs: () => { throw new Error('x'); } });
    expect(ff.evaluate().intervalMs).toBe(5 * MIN);
  });
});

describe('isEmptyBuildOverGood', () => {
  it('truth table', () => {
    expect(ff.isEmptyBuildOverGood([], [{ a: 1 }])).toBe(true);
    expect(ff.isEmptyBuildOverGood(undefined, [{ a: 1 }])).toBe(true);
    expect(ff.isEmptyBuildOverGood(null, [{ a: 1 }])).toBe(true);
    expect(ff.isEmptyBuildOverGood([], [])).toBe(false);
    expect(ff.isEmptyBuildOverGood([], undefined)).toBe(false);
    expect(ff.isEmptyBuildOverGood([{ a: 1 }], [{ a: 1 }])).toBe(false);
    expect(ff.isEmptyBuildOverGood([{ a: 1 }], [])).toBe(false);
  });
});

describe('integration: real api-load-guard', () => {
  it('a stuck build goes red wedged, then a supersede goes red superseded until the next ok', () => {
    let now = T;
    const g = createApiLoadGuard({ now: () => now });
    ff.init({ store: mkStore(), now: () => now, getIntervalMs: () => HOUR_MS, getGuardSnapshot: () => g.snapshot() });
    ff.recordBuildOk({ count: 10 });
    const s1 = g.tryStart('timer');
    expect(s1.started).toBe(true);
    now = T + 6 * MIN;
    expect(ff.evaluate().level).toBe('amber');
    now = T + API_LOAD_MAX_AGE_MS;
    expect(ff.evaluate()).toMatchObject({ level: 'red', reasons: ['wedged'] });
    const s2 = g.tryStart('timer');
    expect(s2.superseded).toBe(true);
    ff.recordSuperseded({ ageMs: s2.ageMs });
    expect(ff.evaluate()).toMatchObject({ level: 'red', reasons: ['superseded'] });
    now += MIN;
    ff.recordBuildOk({ count: 10 });
    g.release(s2.token);
    expect(ff.evaluate()).toMatchObject({ level: 'green', inFlightMs: 0 });
    expect(ff.getSnapshot().buildInFlight).toBe(false);
  });
});

describe('integration: real aap_api call counters', () => {
  const never = () => new Promise(() => {});
  function mkPage({ hang = false, respond = null } = {}) {
    return {
      evaluate: vi.fn((script) => {
        if (script.includes('xhr.open(')) return hang ? never() : Promise.resolve(respond);
        if (script.includes('__aapHookInstalled')) return Promise.resolve(null);
        return Promise.resolve('csrf-token');
      }),
      close: vi.fn(),
    };
  }
  function mkProvider(pages) {
    const q = pages.slice();
    return { openPage: vi.fn(async () => q.shift()), kind: () => 'electron', shutdown: vi.fn() };
  }
  const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

  beforeEach(() => {
    vi.useFakeTimers();
    aap._resetCallStatsForTest();
    aap._setAuthReporterForTest({ isEnabled: () => false, report: () => {} });
  });
  afterEach(() => {
    aap.dispose();
    aap._setProviderForTest(null);
    aap._setAuthReporterForTest(null);
    aap._resetCallStatsForTest();
    vi.useRealTimers();
  });

  it('three hung requests -> consecutiveTimeouts 3 -> unhealthy; a later success resets it', async () => {
    const ok = { ok: true, status: 200, json: { a: 1 } };
    aap._setProviderForTest(mkProvider([mkPage({ hang: true }), mkPage({ hang: true }), mkPage({ hang: true }), mkPage({ respond: ok })]));
    ff.init({ store: mkStore(), getIntervalMs: () => HOUR_MS, getAapStats: () => aap.getCallStats() });
    ff.recordBuildOk({ count: 100 });
    const calls = [errOf(aap.apiGet('/a')), errOf(aap.apiGet('/b')), errOf(aap.apiGet('/c'))];
    await vi.advanceTimersByTimeAsync(3 * 60000 + 100);
    for (const e of await Promise.all(calls)) expect(e && e.code).toBe('AAP_API_TIMEOUT');
    expect(aap.getCallStats()).toMatchObject({ timeouts: 3, consecutiveTimeouts: 3 });
    expect(ff.evaluate()).toMatchObject({ level: 'red', health: 'unhealthy', reasons: ['aap-timeouts'] });
    expect(await aap.apiGet('/d')).toEqual({ a: 1 });
    const st = aap.getCallStats();
    expect(st.consecutiveTimeouts).toBe(0);
    expect(st.timeouts).toBe(3);
    expect(typeof st.lastOkAt).toBe('number');
    expect(ff.evaluate().level).toBe('green');
  });

  it('an in-page xhr timeout counts as a timeout (still AAP_API_ERROR); a 500 does not', async () => {
    aap._setProviderForTest(mkProvider([mkPage({ respond: { ok: false, status: 0, timeout: true } })]));
    const e = await errOf(aap.apiGet('/x'));
    expect(e.code).toBe('AAP_API_ERROR');
    expect(aap.getCallStats()).toMatchObject({ timeouts: 1, consecutiveTimeouts: 1 });
    aap.dispose();
    aap._setProviderForTest(mkProvider([mkPage({ respond: { ok: false, status: 500, text: 'err' } })]));
    await errOf(aap.apiGet('/y'));
    expect(aap.getCallStats()).toMatchObject({ timeouts: 1, consecutiveTimeouts: 1 });
  });

  it('evaluateInPage timeouts count; getCallStats returns a copy', async () => {
    const page = mkPage();
    page.evaluate.mockImplementation((s) => (s === 'HANG' ? never() : Promise.resolve(s.includes('__aapHookInstalled') ? null : 'csrf-token')));
    aap._setProviderForTest(mkProvider([page]));
    const p = errOf(aap.evaluateInPage('HANG'));
    await vi.advanceTimersByTimeAsync(60000);
    expect((await p).code).toBe('AAP_API_TIMEOUT');
    const s = aap.getCallStats();
    expect(s.timeouts).toBe(1);
    s.timeouts = 99;
    expect(aap.getCallStats().timeouts).toBe(1);
  });
});
