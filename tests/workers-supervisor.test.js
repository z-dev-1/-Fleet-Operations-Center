// tests/workers-supervisor.test.js
// Phase 5 worker supervisor core (src/workers/supervisor.js), design §13
// "workers-supervisor" bullets. Fake timers only; injected timers pass through
// the faked globals; injected now/random/notify/logger spy. Dependency fakes go
// into require.cache. No Electron, no AAP/Slack/OWA/AI.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-03-02T12:00:00Z').getTime();
const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000, 900000];
const MIN = 60 * 1000;

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return resolved;
}
function removeModule(relPath) { delete require.cache[require.resolve(relPath)]; }

function mkLogger() {
  const calls = [];
  const l = { calls };
  for (const k of ['debug', 'info', 'warn', 'error']) l[k] = vi.fn((m) => calls.push({ level: k, msg: String(m) }));
  return l;
}

const NAMES = ['wk', 'alpha', 'beta', 'gamma', 'hang', 'quick'];
let logger, notify;
function initSup({ random = () => 0.5, supervised } = {}) {
  logger = mkLogger();
  notify = vi.fn();
  const sv = supervised || Object.fromEntries(NAMES.map((n) => [n, true]));
  return sup.init({
    flags: { supervisorEnabled: true, supervised: sv },
    timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
    now: () => Date.now(),
    random,
    notify,
    logger,
  });
}
function spec(over = {}) {
  return { name: 'wk', group: 'test', tick: vi.fn(), intervalMs: MIN, timeoutMs: 10000, idempotent: true, ...over };
}
const st = (n = 'wk') => sup.getStatus().workers.find((w) => w.name === n);
function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const failing = () => vi.fn(() => Promise.reject(new Error('boom')));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  sup._resetForTests();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('register/start/stop/resume', () => {
  it('start hook is called once', () => {
    initSup();
    const start = vi.fn();
    sup.register(spec({ start }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('first run at initialDelayMs, then on the anchored grid (5m/20m and 8s/60s)', async () => {
    initSup();
    const at1 = [];
    const at2 = [];
    sup.register(spec({ name: 'alpha', intervalMs: 20 * MIN, initialDelayMs: 5 * MIN, timeoutMs: 15 * MIN, tick: () => { at1.push(Date.now() - T0); } }));
    sup.register(spec({ name: 'beta', intervalMs: MIN, initialDelayMs: 8000, timeoutMs: 30 * MIN, tick: () => { at2.push(Date.now() - T0); } }));
    await adv(3 * MIN);
    expect(at2).toEqual([8000, MIN, 2 * MIN, 3 * MIN]);
    await adv(42 * MIN);
    expect(at1).toEqual([5 * MIN, 20 * MIN, 40 * MIN]);
  });

  it('stop clears timers, calls the stop hook and shows disabled/stopped', async () => {
    initSup();
    const stopHook = vi.fn();
    const s = spec({ stop: stopHook });
    const base = vi.getTimerCount();
    sup.register(s);
    expect(vi.getTimerCount()).toBe(base + 1);
    sup.stop('wk');
    expect(vi.getTimerCount()).toBe(base);
    expect(stopHook).toHaveBeenCalledTimes(1);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'stopped', nextRunAt: null });
    await adv(10 * MIN);
    expect(s.tick).not.toHaveBeenCalled();
  });

  it('invalid specs throw TypeError for every validation row; duplicate active register throws', () => {
    initSup();
    const bad = [
      { name: 'W' }, { name: 'a' }, { name: 'supervisor' }, { name: 'has-dash' }, { name: 5 },
      { group: '' }, { group: 'x'.repeat(41) }, { group: 3 },
      { tick: null }, { tick: 'fn' },
      { start: 1 }, { stop: 'x' },
      { intervalMs: 999 }, { intervalMs: () => 60000 }, { intervalMs: Infinity }, { intervalMs: '60000' },
      { initialDelayMs: -1 }, { initialDelayMs: NaN },
      { timeoutMs: 999 }, { timeoutMs: 1500.5 }, { timeoutMs: 86400001 },
      { maxFailures: 0 }, { maxFailures: 51 }, { maxFailures: 1.5 },
      { cooldownMs: 59999 }, { cooldownMs: 86400001 },
      { maxRestarts: -1 }, { maxRestarts: 11 },
      { backoff: 'yes' },
      { dependsOn: ['nope'] }, { dependsOn: 'auth' },
      { idempotent: undefined }, { idempotent: 'true' },
      { isSkip: true },
    ];
    for (const b of bad) {
      expect(() => sup.register(spec(b)), JSON.stringify(b)).toThrow(TypeError);
    }
    expect(sup.getStatus().workers).toEqual([]);
    expect(() => sup.register(null)).toThrow(TypeError);
    sup.register(spec());
    expect(() => sup.register(spec())).toThrow(/already active/);
    // label is truncated, not rejected
    sup.register(spec({ name: 'alpha', label: 'L'.repeat(80) }));
    expect(st('alpha').label).toHaveLength(60);
  });

  it('resume with a new intervalMs runs on the new interval and keeps counters', async () => {
    initSup();
    const s = spec();
    sup.register(s);
    await adv(2 * MIN);
    expect(st().counts.runs).toBe(2);
    sup.stop('wk');
    const s2 = spec({ intervalMs: 30000, tick: s.tick });
    sup.register(s2);
    expect(st().intervalMs).toBe(30000);
    await adv(MIN);
    expect(st().counts.runs).toBe(4);
    expect(st().counts.ok).toBe(4);
  });

  it('stop + register of an isolated worker keeps it isolated with only the remaining cool-down', async () => {
    initSup();
    sup.register(spec({ tick: failing(), maxFailures: 1, cooldownMs: 5 * MIN }));
    await adv(MIN);
    const s1 = st();
    expect(s1.breakerState).toBe('isolated');
    expect(s1.isolatedUntil).toBe(T0 + MIN + 5 * MIN);
    await adv(2 * MIN);
    sup.stop('wk');
    const base = vi.getTimerCount();
    sup.register(spec({ tick: failing(), maxFailures: 1, cooldownMs: 5 * MIN }));
    const s2 = st();
    expect(vi.getTimerCount()).toBe(base + 1);
    expect(s2.state).toBe('isolated');
    expect(s2.isolatedUntil).toBe(s1.isolatedUntil);
    expect(s2.nextRunAt).toBe(s1.isolatedUntil);
    expect(s2.restarts).toBe(0);
    expect(s2.isolations).toBe(1);
  });

  it('stop + register of a budget-exhausted worker stays disabled/restart-budget-exhausted', async () => {
    initSup();
    const mk = () => spec({ tick: failing(), maxFailures: 1, cooldownMs: MIN, maxRestarts: 0 });
    sup.register(mk());
    await adv(3 * MIN);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted' });
    sup.stop('wk');
    sup.register(mk());
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', nextRunAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a tick that settles after stop + resume leaves exactly one next handle', async () => {
    initSup();
    const d = deferred();
    const tick = vi.fn(() => d.p);
    sup.register(spec({ tick }));
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    sup.stop('wk');
    sup.register(spec({ tick }));
    const resumedAt = Date.now();
    expect(vi.getTimerCount()).toBe(2); // next + timeout guard
    d.resolve();
    await adv(0);
    expect(vi.getTimerCount()).toBe(1); // only next
    expect(st().nextRunAt).toBe(resumedAt + MIN);
    tick.mockImplementation(() => undefined);
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('single in-flight', () => {
  it('a tick longer than 3 intervals runs once; overlaps count as busy', async () => {
    initSup();
    const d = deferred();
    const tick = vi.fn(() => d.p);
    sup.register(spec({ tick, timeoutMs: 10 * MIN }));
    await adv(MIN);
    await adv(3 * MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(st().skipReasons.busy).toBe(3);
    expect(st().counts.runs).toBe(1);
    expect(st().state).toBe('busy');
    d.resolve();
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('never runs concurrently (max-active probe = 1)', async () => {
    initSup();
    let active = 0;
    let maxActive = 0;
    const tick = vi.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 150000));
      active--;
    });
    sup.register(spec({ tick, timeoutMs: 10 * MIN }));
    await adv(20 * MIN);
    expect(maxActive).toBe(1);
    expect(tick.mock.calls.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('timeout', () => {
  it('aborts the signal at timeoutMs, counts fail+timeout, stays in flight with busy skips', async () => {
    initSup();
    const d = deferred();
    let signal;
    sup.register(spec({ timeoutMs: 90000, tick: ({ signal: s }) => { signal = s; return d.p; } }));
    await adv(MIN);
    await adv(90000);
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason && signal.reason.message)).toMatch(/timeout after 90000ms/);
    expect(st().counts).toMatchObject({ runs: 1, fail: 1, timeout: 1 });
    expect(st().currentJob).toMatchObject({ timedOut: true });
    expect(st().state).toBe('degraded');
    expect(st().skipReasons.busy).toBe(1);
    await adv(MIN);
    expect(st().counts.runs).toBe(1);
    expect(st().skipReasons.busy).toBe(2);
    d.resolve();
    await adv(0);
    expect(st().currentJob).toBeNull();
  });

  it('backoff next is measured from the timeout instant', async () => {
    initSup({ random: () => 0.5 });
    sup.register(spec({ intervalMs: 1000, timeoutMs: 5000, tick: () => new Promise(() => {}) }));
    await adv(1000);
    await adv(5000);
    expect(st().counts.timeout).toBe(1);
    expect(st().nextRunAt).toBe(T0 + 6000 + 30000);
  });

  it('a late success leaves counts/consecutiveFailures/lastError unchanged and clears the hung handle', async () => {
    initSup();
    const d = deferred();
    sup.register(spec({ timeoutMs: 20000, tick: () => d.p }));
    await adv(MIN + 20000);
    const before = st();
    d.resolve('late');
    await adv(0);
    const after = st();
    expect(after.counts).toEqual(before.counts);
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
    expect(after.lastError).toEqual(before.lastError);
    expect(vi.getTimerCount()).toBe(1); // next only, no hung guard
    await adv(20000);
    expect(st().breakerState).toBe('ok');
    expect(st().isolations).toBe(0);
    expect(logger.calls.some((c) => /late completion after timeout \(ok\)/.test(c.msg))).toBe(true);
  });

  it('still unsettled at 2 × timeout → isolated (hung) with one notify', async () => {
    initSup();
    sup.register(spec({ timeoutMs: 20000, tick: () => new Promise(() => {}) }));
    await adv(MIN + 40000);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'hung', isolations: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('3rd consecutive timeout with maxFailures 3 → one isolation (max-failures), nothing more at 2 × timeout', async () => {
    initSup();
    const tick = vi.fn(() => new Promise((r) => setTimeout(r, 20500)));
    sup.register(spec({ timeoutMs: 20000, maxFailures: 3, tick }));
    for (let i = 0; i < 60 && st().breakerState === 'ok'; i++) await adv(10000);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'max-failures', isolations: 1 });
    expect(st().counts.timeout).toBe(3);
    expect(notify).toHaveBeenCalledTimes(1);
    await adv(45000);
    expect(st().isolations).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('idempotent:false → a timeout isolates immediately (timeout-non-idempotent)', async () => {
    initSup();
    sup.register(spec({ timeoutMs: 20000, idempotent: false, tick: () => new Promise(() => {}) }));
    await adv(MIN + 20000);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'timeout-non-idempotent', maxRestarts: 0 });
    expect(vi.getTimerCount()).toBe(1); // only the cool-down; no hung guard
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('breaker, backoff and jitter bounds', () => {
  for (const r of [0, 0.5, 0.999]) {
    it(`random=${r}: delay after failure n = max(gridNext − t, jitter(BACKOFF_MS[n-1]))`, async () => {
      initSup({ random: () => r });
      sup.register(spec({ intervalMs: 1000, maxFailures: 10, tick: failing() }));
      await adv(1000);
      for (let n = 1; n <= 7; n++) {
        const t = Date.now();
        const s = st();
        expect(s.consecutiveFailures).toBe(n);
        const entry = BACKOFF_MS[Math.min(n - 1, 5)];
        const want = Math.max(1000, Math.round(entry * (0.85 + r * 0.3)));
        const delay = s.nextRunAt - t;
        expect(delay).toBe(want);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(entry * 0.85));
        expect(delay).toBeLessThanOrEqual(Math.ceil(entry * 1.15));
        await adv(delay);
      }
    });
  }

  it('backoff never schedules earlier than the next grid slot', async () => {
    initSup({ random: () => 0 });
    sup.register(spec({ intervalMs: 2 * MIN, tick: failing() }));
    await adv(2 * MIN);
    expect(st().consecutiveFailures).toBe(1);
    expect(st().nextRunAt).toBe(T0 + 4 * MIN);
  });

  it('backoff:false keeps the cadence', async () => {
    initSup({ random: () => 0.999 });
    const tick = failing();
    sup.register(spec({ intervalMs: 1000, maxFailures: 10, backoff: false, tick }));
    await adv(5000);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(st().nextRunAt).toBe(T0 + 6000);
  });

  it('a success resets the streak and returns to the grid', async () => {
    initSup({ random: () => 0.5 });
    let n = 0;
    const tick = vi.fn(() => (++n <= 2 ? Promise.reject(new Error('x')) : undefined));
    sup.register(spec({ intervalMs: 1000, maxFailures: 10, tick }));
    await adv(1000); // fail 1 → +30 s
    await adv(30000); // fail 2 → +60 s
    expect(st().consecutiveFailures).toBe(2);
    await adv(60000); // success
    const s = st();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.nextRunAt).toBe(Date.now() + 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('isolation, cool-down and re-enable', () => {
  it('after maxFailures: isolated, notify exactly once, no ticks during the cool-down', async () => {
    initSup();
    const tick = failing();
    sup.register(spec({ intervalMs: 1000, maxFailures: 3, backoff: false, cooldownMs: 10 * MIN, tick }));
    await adv(3000);
    expect(st().state).toBe('isolated');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Background worker paused', type: 'worker', worker: 'wk' });
    expect(typeof notify.mock.calls[0][0].message).toBe('string');
    expect(notify.mock.calls[0][0].body).toBe(notify.mock.calls[0][0].message);
    await adv(9 * MIN);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('cool-down end lands on the grid (60 min interval, 1 min cool-down)', async () => {
    initSup();
    const triggers = [];
    let n = 0;
    const tick = vi.fn(({ trigger }) => { triggers.push([Date.now() - T0, trigger]); if (++n === 1) throw new Error('first'); });
    sup.register(spec({ intervalMs: 60 * MIN, timeoutMs: 30 * MIN, maxFailures: 1, cooldownMs: MIN, tick }));
    await adv(60 * MIN);
    expect(st().state).toBe('isolated');
    await adv(MIN);
    expect(st().restarts).toBe(1);
    expect(st().nextRunAt).toBe(T0 + 120 * MIN);
    await adv(59 * MIN);
    expect(triggers).toEqual([[60 * MIN, 'schedule'], [120 * MIN, 'restart']]);
  });

  it('a repeat isolation does not re-notify', async () => {
    initSup();
    sup.register(spec({ intervalMs: MIN, maxFailures: 1, cooldownMs: MIN, tick: failing() }));
    await adv(MIN); // isolate 1
    await adv(2 * MIN); // restart run fails → isolate 2
    expect(st().isolations).toBe(2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('after maxRestarts: disabled/restart-budget-exhausted, nextRunAt null, failing ticks ≤ (maxRestarts+1)×maxFailures', async () => {
    initSup();
    sup.register(spec({ intervalMs: MIN, maxFailures: 2, cooldownMs: MIN, maxRestarts: 3, backoff: false, tick: failing() }));
    await adv(24 * 60 * MIN);
    const s = st();
    expect(s).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', nextRunAt: null, restarts: 3, isolations: 4 });
    expect(s.counts.fail).toBeLessThanOrEqual((3 + 1) * 2);
    expect(s.counts.fail).toBe(8);
  });

  it('a cool-down that ends while still hung re-isolates (hung), consumes a restart, never re-notifies; ends disabled', async () => {
    initSup();
    sup.register(spec({ intervalMs: MIN, timeoutMs: 10000, cooldownMs: MIN, tick: () => new Promise(() => {}) }));
    await adv(MIN + 20000);
    expect(st()).toMatchObject({ isolationReason: 'hung', isolations: 1 });
    await adv(MIN);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'hung', isolations: 2, restarts: 1 });
    await adv(3 * MIN);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', isolations: 4, restarts: 3 });
    expect(notify.mock.calls.filter((c) => c[0].title === 'Background worker paused')).toHaveLength(1);
    expect(st().counts.runs).toBe(1);
  });

  it('non-idempotent: isolation → cool-down end → disabled, no auto-restart run', async () => {
    initSup();
    const tick = failing();
    sup.register(spec({ intervalMs: MIN, maxFailures: 1, cooldownMs: MIN, idempotent: false, tick }));
    await adv(MIN);
    expect(st().state).toBe('isolated');
    await adv(10 * MIN);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', maxRestarts: 0 });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('reEnable re-arms on the grid by default, or at now() with runNow, and re-arms notify', async () => {
    initSup();
    const triggers = [];
    const tick = vi.fn(({ trigger }) => { triggers.push(trigger); throw new Error('x'); });
    sup.register(spec({ intervalMs: MIN, maxFailures: 1, cooldownMs: 30 * MIN, tick }));
    await adv(MIN);
    await adv(15000);
    expect(sup.reEnable('wk')).toBe(true);
    expect(st()).toMatchObject({ state: 'healthy', breakerState: 'ok', restarts: 0, notified: false, nextRunAt: T0 + 2 * MIN });
    await adv(45000);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(sup.reEnable('wk', { runNow: true })).toBe(true);
    expect(st().nextRunAt).toBe(Date.now());
    await adv(0);
    expect(triggers).toEqual(['schedule', 'schedule', 'manual']);
  });

  it('reEnable returns false for owner-stopped, healthy, unknown, and during shutdown', async () => {
    initSup();
    sup.register(spec({ maxFailures: 1, cooldownMs: 30 * MIN, tick: failing() }));
    sup.register(spec({ name: 'alpha' }));
    await adv(MIN);
    expect(st().state).toBe('isolated');
    expect(sup.reEnable('alpha')).toBe(false);
    expect(sup.reEnable('nope')).toBe(false);
    sup.stop('wk');
    expect(sup.reEnable('wk')).toBe(false);
    sup.register(spec({ maxFailures: 1, cooldownMs: 30 * MIN, tick: failing() }));
    sup.shutdown();
    expect(sup.reEnable('wk')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('dependency skip', () => {
  const DEP_MODS = ['../src/orcha/offline', '../src/auth/midway-health-supervisor', '../src/cluster', '../src/orcha/relay'];
  const dep = { offline: false, auth: 'HEALTHY', prod: true, live: true, backends: { orcha: true, claude: true } };
  beforeEach(() => {
    Object.assign(dep, { offline: false, auth: 'HEALTHY', prod: true, live: true, backends: { orcha: true, claude: true } });
    injectFakeModule('../src/orcha/offline', { isOffline: () => dep.offline });
    injectFakeModule('../src/auth/midway-health-supervisor', { getState: () => dep.auth, STATE: {} });
    injectFakeModule('../src/cluster', { mayRunProduction: () => dep.prod, mayLivePull: () => dep.live });
    injectFakeModule('../src/orcha/relay', { getStatus: () => ({ backends: dep.backends }) });
  });
  afterEach(() => { for (const m of DEP_MODS) removeModule(m); });

  const CASES = [
    ['offline', () => { dep.offline = true; }, () => { dep.offline = false; }],
    ['auth', () => { dep.auth = 'WAITING_FOR_USER'; }, () => { dep.auth = 'HEALTHY'; }],
    ['cluster.production', () => { dep.prod = false; }, () => { dep.prod = true; }],
    ['cluster.livePull', () => { dep.live = false; }, () => { dep.live = true; }],
    ['ai', () => { dep.backends = { orcha: false, claude: false }; }, () => { dep.backends = { orcha: false, claude: true }; }],
  ];
  for (const [key, down, up] of CASES) {
    it(`${key} down → skip (waiting), not a failure; up again → runs`, async () => {
      initSup();
      const tick = vi.fn();
      sup.register(spec({ dependsOn: [key], tick }));
      down();
      await adv(MIN);
      const s = st();
      expect(tick).not.toHaveBeenCalled();
      expect(s.skipReasons.dependency[key]).toBe(1);
      expect(s.state).toBe('waiting');
      expect(s.waitingOn).toContain(key);
      expect(s.counts.fail).toBe(0);
      expect(s.consecutiveFailures).toBe(0);
      expect(s.nextRunAt).toBe(T0 + 2 * MIN);
      up();
      await adv(MIN);
      expect(tick).toHaveBeenCalledTimes(1);
      expect(st().state).toBe('healthy');
      expect(st().waitingOn).toBeNull();
    });
  }

  it('each auth STATE maps as in §6', async () => {
    const DOWN = ['OFFLINE', 'WAITING_FOR_USER', 'COOLDOWN', 'RECOVERING', 'FAILED'];
    const UP = ['UNKNOWN', 'HEALTHY', 'DEGRADED'];
    for (const state of [...DOWN, ...UP]) {
      sup._resetForTests();
      initSup();
      const tick = vi.fn();
      dep.auth = state;
      sup.register(spec({ dependsOn: ['auth'], tick }));
      await adv(MIN);
      expect(tick.mock.calls.length, state).toBe(DOWN.includes(state) ? 0 : 1);
    }
  });

  it('a throwing reader counts as up', async () => {
    injectFakeModule('../src/orcha/offline', { isOffline: () => { throw new Error('reader'); } });
    injectFakeModule('../src/auth/midway-health-supervisor', { getState: () => { throw new Error('reader'); } });
    initSup();
    const tick = vi.fn();
    sup.register(spec({ dependsOn: ['offline', 'auth'], tick }));
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('relay not in the require cache → ai is up and relay is not required', async () => {
    removeModule('../src/orcha/relay');
    const relayPath = require.resolve('../src/orcha/relay');
    initSup();
    const tick = vi.fn();
    sup.register(spec({ dependsOn: ['ai'], tick }));
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(require.cache[relayPath]).toBeUndefined();
  });

  it('transition logging happens once per change', async () => {
    initSup();
    sup.register(spec({ dependsOn: ['offline'], tick: vi.fn() }));
    dep.offline = true;
    await adv(3 * MIN);
    const downLogs = () => logger.calls.filter((c) => /dependency offline down/.test(c.msg)).length;
    const upLogs = () => logger.calls.filter((c) => /dependency offline up again/.test(c.msg)).length;
    expect(st().skipReasons.dependency.offline).toBe(3);
    expect(downLogs()).toBe(1);
    dep.offline = false;
    await adv(3 * MIN);
    expect(upLogs()).toBe(1);
    expect(downLogs()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('graceful shutdown', () => {
  it('aborts every in-flight signal synchronously, clears timers, resolves {drained:false,pending:[hang]} at graceMs', async () => {
    initSup();
    const quick = deferred();
    const sig = {};
    sup.register(spec({ name: 'hang', tick: ({ signal }) => { sig.hang = signal; return new Promise(() => {}); } }));
    sup.register(spec({ name: 'quick', tick: ({ signal }) => { sig.quick = signal; return quick.p; } }));
    await adv(MIN);
    let result = null;
    const p = sup.shutdown({ graceMs: 3000 });
    p.then((r) => { result = r; });
    expect(sig.hang.aborted).toBe(true);
    expect(sig.quick.aborted).toBe(true);
    expect(sig.hang.reason.message).toBe('shutdown');
    expect(vi.getTimerCount()).toBe(1); // the grace delay only
    expect(sup.getStatus().workers.every((w) => w.state === 'disabled' && w.disabledReason === 'shutdown' && w.nextRunAt === null)).toBe(true);
    quick.resolve();
    await adv(2999);
    expect(result).toBeNull();
    await adv(1);
    expect(result).toEqual({ drained: false, pending: ['hang'] });
  });

  it('with nothing in flight, resolves {drained:true} immediately', async () => {
    initSup();
    sup.register(spec());
    let result = null;
    sup.shutdown().then((r) => { result = r; });
    await Promise.resolve(); await Promise.resolve();
    expect(result).toEqual({ drained: true, pending: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never rejects and a second call returns the same promise', async () => {
    initSup();
    sup.register(spec({ tick: () => Promise.reject(new Error('x')), stop: () => { throw new Error('stop hook'); } }));
    await adv(MIN - 1);
    const p1 = sup.shutdown();
    const p2 = sup.shutdown();
    expect(p1).toBe(p2);
    await expect(p1).resolves.toEqual({ drained: true, pending: [] });
  });

  it('onBeforeQuit() returns synchronously and never uses preventDefault', () => {
    initSup();
    sup.register(spec());
    const evt = { preventDefault: vi.fn() };
    expect(sup.onBeforeQuit(evt)).toBeUndefined();
    expect(evt.preventDefault).not.toHaveBeenCalled();
    const src = fs.readFileSync(require.resolve('../src/workers/supervisor'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(/preventDefault/.test(code)).toBe(false);
  });

  it('uninitialized: onBeforeQuit/onWillQuit/shutdown make no logger calls and leave state unchanged', async () => {
    const spy = mkLogger();
    expect(sup.init({ flags: { supervisorEnabled: false, supervised: { wk: true } }, logger: spy })).toEqual({ enabled: false });
    const before = sup.getStatus();
    expect(sup.onBeforeQuit()).toBeUndefined();
    expect(sup.onWillQuit()).toBeUndefined();
    await expect(sup.shutdown()).resolves.toEqual({ drained: true, pending: [] });
    expect(sup.getStatus()).toEqual(before);
    expect(spy.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelled quit: healthy workers resume on their original grid, owner-stopped stays stopped, isolated keeps its remaining cool-down', async () => {
    initSup();
    sup.register(spec({ name: 'alpha' }));
    sup.register(spec({ name: 'beta' }));
    sup.register(spec({ name: 'gamma', maxFailures: 1, cooldownMs: 10 * MIN, tick: failing() }));
    await adv(MIN);
    const gUntil = st('gamma').isolatedUntil;
    sup.stop('beta');
    sup.onBeforeQuit();
    await adv(15000);
    expect(st('alpha')).toMatchObject({ state: 'healthy', nextRunAt: T0 + 2 * MIN });
    expect(st('beta')).toMatchObject({ state: 'disabled', disabledReason: 'stopped', nextRunAt: null });
    expect(st('gamma')).toMatchObject({ state: 'isolated', nextRunAt: gUntil, isolatedUntil: gUntil });
    expect(logger.calls.some((c) => /quit was cancelled — resumed 2 workers/.test(c.msg))).toBe(true);
  });

  it('onWillQuit() before 15 s → nothing resumes', async () => {
    initSup();
    const tick = vi.fn();
    sup.register(spec({ tick }));
    sup.onBeforeQuit();
    await adv(5000);
    sup.onWillQuit();
    await adv(10 * MIN);
    expect(tick).not.toHaveBeenCalled();
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'shutdown' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('claim', () => {
  it('not initialized → false', () => {
    expect(sup.claim(spec())).toBe(false);
  });
  it('supervisor flag on but worker flag off → false', () => {
    initSup({ supervised: { wk: false } });
    expect(sup.claim(spec())).toBe(false);
    expect(sup.getStatus().workers).toEqual([]);
  });
  it('on → true', () => {
    initSup();
    expect(sup.claim(spec())).toBe(true);
    expect(st().owner).toBe('supervisor');
  });
  it('a throwing start hook → false, no record left', () => {
    initSup();
    expect(sup.claim(spec({ start: () => { throw new Error('nope'); } }))).toBe(false);
    expect(sup.getStatus().workers).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('init disabled → false', () => {
    sup.init({ flags: { supervisorEnabled: false, supervised: { wk: true } } });
    expect(sup.isEnabled()).toBe(false);
    expect(sup.claim(spec())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('backoff (FIX 5)', () => {
  // design §9 tuples: { intervalMs, maxFailures, backoff }
  const SPECS = [
    ['repairIntel', 1200000, 3, false],
    ['emailTriage', 900000, 3, false],
    ['fasCoverage', 21600000, 3, false],
    ['apiFleetRefresh', 300000, 3, false],
    ['carrierBriefing', 60000, 10, false],
    ['longDwell', 30000, 10, false],
    ['dailyTasks', 60000, 5, false],
  ];
  it('backoff inert for Phase 5 specs', async () => {
    for (const [name, intervalMs, maxFailures, backoff] of SPECS) {
      sup._resetForTests();
      vi.setSystemTime(T0);
      initSup({ random: () => 0.999, supervised: { [name]: true } });
      sup.register({ name, group: 'g', intervalMs, timeoutMs: 1000, maxFailures, backoff, idempotent: true, tick: failing() });
      await adv(intervalMs);
      for (let n = 1; n < maxFailures; n++) {
        const s = sup.getStatus().workers[0];
        expect(s.consecutiveFailures, name).toBe(n);
        expect(s.breakerState, name).toBe('ok');
        expect(s.nextRunAt - Date.now(), `${name} n=${n}`).toBe(intervalMs); // == gridNext(t)
        await adv(intervalMs);
      }
    }
  });

  it('backoff:false: a tick that fails LATE (10 s before its next slot) keeps the next run on-grid', async () => {
    const lateFail = () => new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 5 * MIN - 10000));
    for (const backoff of [false, true]) {
      sup._resetForTests();
      vi.setSystemTime(T0);
      initSup({ random: () => 0.999, supervised: { apiFleetRefresh: true } });
      sup.register({ name: 'apiFleetRefresh', group: 'g', intervalMs: 5 * MIN, timeoutMs: 15 * MIN, maxFailures: 3, backoff, idempotent: true, tick: vi.fn(lateFail) });
      await adv(5 * MIN);              // tick starts at T0+5 min
      await adv(5 * MIN - 10000);      // fails at T0+9 min 50 s
      const s = sup.getStatus().workers[0];
      expect(s.consecutiveFailures).toBe(1);
      if (backoff) expect(s.nextRunAt).toBeGreaterThan(T0 + 10 * MIN); // the off-grid push backoff:false avoids
      else expect(s.nextRunAt).toBe(T0 + 10 * MIN);
    }
  });
});
