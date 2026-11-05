// tests/workers-supervisor-wake.test.js
// auth.propagation FEAT-002: workers/supervisor.wakeDependents(key, { delayMs }).
// Same harness as tests/workers-supervisor.test.js: fake timers, injected
// now/random/logger, dependency readers faked through require.cache.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-03-02T12:00:00Z').getTime();
const MIN = 60 * 1000;
const DEP_MODS = ['../src/orcha/offline', '../src/auth/midway-health-supervisor', '../src/cluster', '../src/orcha/relay'];
const dep = { offline: false, auth: 'HEALTHY' };

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
function removeModule(relPath) { delete require.cache[require.resolve(relPath)]; }

const NAMES = ['wk', 'alpha', 'beta', 'gamma'];
function initSup() {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return sup.init({
    flags: { supervisorEnabled: true, supervised: Object.fromEntries(NAMES.map((n) => [n, true])) },
    timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
    now: () => Date.now(),
    random: () => 0.5,
    notify: vi.fn(),
    logger,
  });
}
function spec(over = {}) {
  return { name: 'wk', group: 'test', tick: vi.fn(), intervalMs: 20 * MIN, initialDelayMs: MIN, timeoutMs: 10000, idempotent: true, ...over };
}
const st = (n = 'wk') => sup.getStatus().workers.find((w) => w.name === n);
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  Object.assign(dep, { offline: false, auth: 'HEALTHY' });
  injectFakeModule('../src/orcha/offline', { isOffline: () => dep.offline });
  injectFakeModule('../src/auth/midway-health-supervisor', { getState: () => dep.auth, STATE: {} });
  injectFakeModule('../src/cluster', { mayRunProduction: () => true, mayLivePull: () => true });
  injectFakeModule('../src/orcha/relay', { getStatus: () => ({ backends: { orcha: true, claude: true } }) });
});
afterEach(() => {
  sup._resetForTests();
  for (const m of DEP_MODS) removeModule(m);
  vi.useRealTimers();
});

describe('wakeDependents', () => {
  it('returns 0 before init', () => {
    expect(sup.wakeDependents('auth')).toBe(0);
  });

  it('wakes only a dependent that skipped for auth, reschedules at now+delay, returns the count', async () => {
    initSup();
    const tick = vi.fn();
    const other = vi.fn();
    sup.register(spec({ name: 'wk', dependsOn: ['auth'], tick }));
    sup.register(spec({ name: 'alpha', dependsOn: [], tick: other }));
    dep.auth = 'COOLDOWN';
    await adv(MIN);
    expect(tick).not.toHaveBeenCalled();
    expect(st().waitingOn).toEqual(['auth']);
    expect(st().nextRunAt).toBe(T0 + 20 * MIN);
    expect(other).toHaveBeenCalledTimes(1);
    const alphaNext = st('alpha').nextRunAt;

    dep.auth = 'HEALTHY';
    const now = Date.now();
    expect(sup.wakeDependents('auth')).toBe(1);
    expect(st().nextRunAt).toBe(now + 2000);
    expect(st('alpha').nextRunAt).toBe(alphaNext); // dependsOn [] never woken
    await adv(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(st().waitingOn).toBeNull();
    // normal grid resumes from the anchor
    expect(st().nextRunAt).toBe(T0 + 20 * MIN);
    await adv(20 * MIN);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('honours a custom delayMs', async () => {
    initSup();
    sup.register(spec({ dependsOn: ['auth'] }));
    dep.auth = 'WAITING_FOR_USER';
    await adv(MIN);
    dep.auth = 'HEALTHY';
    expect(sup.wakeDependents('auth', { delayMs: 500 })).toBe(1);
    expect(st().nextRunAt).toBe(Date.now() + 500);
  });

  it('does not wake a worker that depends on auth but skipped for another key', async () => {
    initSup();
    sup.register(spec({ dependsOn: ['auth', 'offline'] }));
    dep.offline = true;
    await adv(MIN);
    expect(st().waitingOn).toEqual(['offline']);
    expect(sup.wakeDependents('auth')).toBe(0);
    expect(st().nextRunAt).toBe(T0 + 20 * MIN);
  });

  it('does not wake a worker that never skipped', async () => {
    initSup();
    const tick = vi.fn();
    sup.register(spec({ dependsOn: ['auth'], tick }));
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(sup.wakeDependents('auth')).toBe(0);
  });

  it('respects ownerStopped', async () => {
    initSup();
    sup.register(spec({ dependsOn: ['auth'] }));
    dep.auth = 'COOLDOWN';
    await adv(MIN);
    sup.stop('wk');
    dep.auth = 'HEALTHY';
    expect(sup.wakeDependents('auth')).toBe(0);
    expect(st().nextRunAt).toBeNull();
  });

  it('an isolated worker (breaker not ok) is not woken', async () => {
    initSup();
    let n = 0;
    sup.register(spec({ dependsOn: ['auth'], maxFailures: 1, tick: () => { n++; return Promise.reject(new Error('boom')); } }));
    await adv(MIN);
    expect(n).toBe(1);
    expect(st().breakerState).toBe('isolated');
    dep.auth = 'HEALTHY';
    expect(sup.wakeDependents('auth')).toBe(0);
    expect(st().breakerState).toBe('isolated');
  });

  it('respects an in-flight run', async () => {
    initSup();
    let release;
    const tick = vi.fn(() => new Promise((r) => { release = r; }));
    sup.register(spec({ dependsOn: ['auth'], tick, timeoutMs: 30 * MIN }));
    dep.auth = 'COOLDOWN';
    await adv(MIN);
    expect(st().waitingOn).toEqual(['auth']);
    dep.auth = 'HEALTHY';
    // let it start through a wake, then wake again while it runs
    expect(sup.wakeDependents('auth')).toBe(1);
    await adv(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(st().state).toBe('busy');
    expect(sup.wakeDependents('auth')).toBe(0);
    release();
    await adv(0);
  });

  it('returns 0 during shutdown', async () => {
    initSup();
    sup.register(spec({ dependsOn: ['auth'] }));
    dep.auth = 'COOLDOWN';
    await adv(MIN);
    dep.auth = 'HEALTHY';
    sup.shutdown({ graceMs: 1000 });
    expect(sup.wakeDependents('auth')).toBe(0);
  });
});
