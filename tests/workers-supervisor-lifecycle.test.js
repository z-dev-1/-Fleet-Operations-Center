// tests/workers-supervisor-lifecycle.test.js
// Phase 5 worker supervisor — design-review round-2 required fixes:
//   [FIX 1] lifecycle during shutdown / owner-stop (R1–R4, single _arm helper)
//   [FIX 2] notification policy (notified reset after full recovery; one
//           "Background worker disabled" notice on budget exhaustion)
//   [FIX 7] repeated before-quit (one re-armed watchdog, one drain log/promise)
//   [FIX 8] duplicate detection by err.code === 'WORKER_ACTIVE'
// Fake timers only; injected timers pass through the faked globals.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-03-02T12:00:00Z').getTime();
const MIN = 60 * 1000;

function mkLogger() {
  const calls = [];
  const l = { calls };
  for (const k of ['debug', 'info', 'warn', 'error']) l[k] = vi.fn((m) => calls.push({ level: k, msg: String(m) }));
  return l;
}
let logger, notify;
function initSup({ random = () => 0.5 } = {}) {
  logger = mkLogger();
  notify = vi.fn();
  return sup.init({
    flags: { supervisorEnabled: true, supervised: { wk: true, alpha: true } },
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
const titles = () => notify.mock.calls.map((c) => c[0].title);
const count = (title) => titles().filter((t) => t === title).length;
const shutdownLogs = () => logger.calls.filter((c) => c.msg.startsWith('[workers] shutdown:')).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  sup._resetForTests();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[FIX 1] lifecycle during shutdown / owner-stop', () => {
  it('R1: stop + claim inside the quit window registers without arming; cancelled quit resumes it on its grid', async () => {
    initSup();
    const runs = [];
    const tick = vi.fn(() => { runs.push(Date.now()); });
    expect(sup.claim(spec({ tick }))).toBe(true);
    sup.onBeforeQuit();
    const base = vi.getTimerCount(); // the quit watchdog only
    expect(base).toBe(1);
    sup.stop('wk');
    expect(sup.claim(spec({ tick }))).toBe(true);
    expect(vi.getTimerCount()).toBe(base);
    expect(st().nextRunAt).toBeNull();
    await adv(15000);
    const resumeAt = Date.now();
    expect(sup.getStatus().workers).toHaveLength(1);
    expect(st()).toMatchObject({ state: 'healthy', disabledReason: null, nextRunAt: resumeAt + MIN });
    await adv(MIN);
    expect(runs).toEqual([resumeAt + MIN]);
  });

  it('R1: brand-new claim during shutdown arms nothing, resumes after the watchdog, and nothing resumes if onWillQuit() fires first', async () => {
    initSup();
    const tick = vi.fn();
    sup.onBeforeQuit();
    expect(sup.claim(spec({ name: 'alpha', tick }))).toBe(true);
    expect(vi.getTimerCount()).toBe(1); // watchdog only
    expect(st('alpha')).toMatchObject({ state: 'disabled', disabledReason: 'shutdown', nextRunAt: null });
    await adv(15000);
    expect(st('alpha').nextRunAt).toBe(Date.now() + MIN);
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);

    sup._resetForTests();
    initSup();
    const tick2 = vi.fn();
    sup.onBeforeQuit();
    expect(sup.claim(spec({ name: 'alpha', tick: tick2 }))).toBe(true);
    sup.onWillQuit();
    expect(vi.getTimerCount()).toBe(0);
    await adv(10 * MIN);
    expect(tick2).not.toHaveBeenCalled();
    expect(st('alpha')).toMatchObject({ state: 'disabled', disabledReason: 'shutdown', nextRunAt: null });
  });

  it('R2: owner-stopped worker that isolates arms no cool-down; resume arms exactly one; expiry increments restarts by 1, not 2', async () => {
    initSup();
    const d = deferred();
    let n = 0;
    const mk = () => spec({
      maxFailures: 2, cooldownMs: 5 * MIN, timeoutMs: 10 * MIN, backoff: false,
      tick: () => (++n === 1 ? Promise.reject(new Error('first')) : d.p),
    });
    sup.register(mk());
    await adv(MIN); // failure 1
    await adv(MIN); // tick 2 in flight
    expect(st().currentJob).not.toBeNull();
    sup.stop('wk');
    d.reject(new Error('second'));
    await adv(0);
    const s = st();
    expect(s.breakerState).toBe('isolated');
    expect(s).toMatchObject({ state: 'disabled', disabledReason: 'stopped', nextRunAt: null });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    sup.register(mk());
    expect(vi.getTimerCount()).toBe(1);
    expect(st().nextRunAt).toBe(s.isolatedUntil);
    sup.stop('wk');
    sup.register(mk());
    expect(vi.getTimerCount()).toBe(1);
    await adv(s.isolatedUntil - Date.now());
    expect(st()).toMatchObject({ breakerState: 'ok', restarts: 1, isolations: 1 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('R2: stop during cool-down clears the cool-down; resume re-arms only the remaining time', async () => {
    initSup();
    const mk = () => spec({ maxFailures: 1, cooldownMs: 10 * MIN, tick: failing() });
    sup.register(mk());
    await adv(MIN);
    const until = st().isolatedUntil;
    expect(until).toBe(T0 + MIN + 10 * MIN);
    await adv(3 * MIN);
    sup.stop('wk');
    expect(vi.getTimerCount()).toBe(0);
    expect(st().isolatedUntil).toBe(until);
    sup.register(mk());
    expect(st()).toMatchObject({ isolatedUntil: until, nextRunAt: until, state: 'isolated' });
    expect(vi.getTimerCount()).toBe(1);
    sup.stop('wk');
    sup.register(mk());
    expect(vi.getTimerCount()).toBe(1);
    await adv(until - Date.now());
    expect(st()).toMatchObject({ breakerState: 'ok', restarts: 1 });
  });

  it('R2: no timers on stopped workers', async () => {
    initSup();
    const d = deferred();
    const tick = vi.fn(() => d.p);
    sup.register(spec({ tick, timeoutMs: 30000 }));
    await adv(MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    sup.stop('wk');
    d.reject(new Error('after stop')); // a settle after stop runs the breaker but arms nothing
    await adv(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(sup.reEnable('wk')).toBe(false);
    await vi.runAllTimersAsync();
    await adv(60 * MIN);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'stopped', nextRunAt: null });
  });

  it('R3: rejection settled during shutdown does not notify, isolate or arm', async () => {
    initSup();
    const d = deferred();
    sup.register(spec({ maxFailures: 1, tick: () => d.p }));
    await adv(MIN);
    sup.onBeforeQuit();
    d.reject(new Error('late'));
    await adv(0);
    const s = st();
    expect(s.counts.fail).toBe(1);
    expect(s.lastError).toMatchObject({ message: 'late', kind: 'throw' });
    expect(s.breakerState).toBe('ok');
    expect(s.isolations).toBe(0);
    expect(s.nextRunAt).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // watchdog only (grace delay cleared on drain)
  });

  it('R3: isolation during quit is suppressed', async () => {
    initSup();
    const d = deferred();
    let n = 0;
    sup.register(spec({ maxFailures: 3, backoff: false, tick: () => (++n <= 2 ? Promise.reject(new Error('x')) : d.p) }));
    await adv(3 * MIN);
    expect(st().consecutiveFailures).toBe(2);
    expect(st().currentJob).not.toBeNull();
    sup.shutdown();
    d.reject(new Error('third'));
    await adv(0);
    expect(st()).toMatchObject({ breakerState: 'ok', isolations: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('R4: in-flight tick at onBeforeQuit that never settles → after resume, times out at startedAt+timeoutMs and isolates hung at startedAt+2*timeoutMs', async () => {
    initSup();
    let signal;
    sup.register(spec({ intervalMs: 10 * MIN, timeoutMs: MIN, tick: ({ signal: s }) => { signal = s; return new Promise(() => {}); } }));
    await adv(10 * MIN);
    const startedAt = st().currentJob.startedAt;
    await adv(5000);
    sup.onBeforeQuit();
    expect(signal.aborted).toBe(true);
    await adv(15000); // resume at startedAt + 20 s
    expect(sup.getStatus().shuttingDown).toBe(false);
    await adv(startedAt + MIN - Date.now() - 1);
    expect(st().counts.timeout).toBe(0);
    await adv(1);
    expect(st().counts.timeout).toBe(1);
    expect(signal.reason.message).toBe('shutdown'); // already aborted: not re-aborted
    await adv(startedAt + 2 * MIN - Date.now() - 1);
    expect(st().isolations).toBe(0);
    await adv(1);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'hung', isolations: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('R4: tick already timed out at onBeforeQuit → hung re-armed at startedAt+2*timeoutMs after resume', async () => {
    initSup();
    sup.register(spec({ intervalMs: 10 * MIN, timeoutMs: MIN, tick: () => new Promise(() => {}) }));
    await adv(10 * MIN);
    const startedAt = st().currentJob.startedAt;
    await adv(65000);
    expect(st().currentJob.timedOut).toBe(true);
    sup.onBeforeQuit();
    await adv(15000); // resume at startedAt + 80 s
    expect(sup.getStatus().shuttingDown).toBe(false);
    await adv(startedAt + 2 * MIN - Date.now() - 1);
    expect(st().isolations).toBe(0);
    await adv(1);
    expect(st()).toMatchObject({ state: 'isolated', isolationReason: 'hung', isolations: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[FIX 2] notification policy', () => {
  it('two isolation episodes separated by a full recovery → two "Background worker paused" notices', async () => {
    initSup();
    const plan = ['fail', 'ok', 'fail'];
    let i = 0;
    sup.register(spec({ maxFailures: 1, cooldownMs: MIN, tick: () => { if (plan[i++] === 'fail') throw new Error('x'); } }));
    await adv(MIN); // isolate #1
    await adv(MIN); // cool-down expiry → restart on next slot
    await adv(MIN); // on-time success (full recovery)
    expect(st()).toMatchObject({ breakerState: 'ok', restarts: 1, notified: false });
    await adv(MIN); // isolate #2
    expect(st().isolations).toBe(2);
    expect(count('Background worker paused')).toBe(2);
  });

  it('restart budget exhausted → exactly one "Background worker disabled" notice', async () => {
    initSup();
    const mk = () => spec({ maxFailures: 1, cooldownMs: MIN, maxRestarts: 1, label: 'Test worker', tick: failing() });
    sup.register(mk());
    await adv(4 * MIN);
    expect(st()).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', isolations: 2 });
    expect(count('Background worker disabled')).toBe(1);
    const payload = notify.mock.calls.find((c) => c[0].title === 'Background worker disabled')[0];
    const message = 'Test worker was disabled after 2 failed recoveries. Restart the app to re-enable it. Last error: boom';
    expect(payload).toEqual({ title: 'Background worker disabled', message, body: message, icon: '⛔', type: 'worker', worker: 'wk' });
    sup.stop('wk');
    sup.register(mk());
    await adv(60 * MIN);
    expect(count('Background worker disabled')).toBe(1);
    expect(count('Background worker paused')).toBe(1);
  });

  it('re-isolation on hung cool-down does not notify again', async () => {
    initSup();
    sup.register(spec({ timeoutMs: 10000, cooldownMs: MIN, tick: () => new Promise(() => {}) }));
    await adv(MIN + 20000);
    expect(st().isolations).toBe(1);
    await adv(MIN);
    expect(st()).toMatchObject({ isolations: 2, restarts: 1, isolationReason: 'hung' });
    await adv(MIN);
    expect(st().isolations).toBe(3);
    expect(count('Background worker paused')).toBe(1);
    expect(count('Background worker disabled')).toBe(0);
  });

  it('idempotent:false → paused notice then one disabled notice', async () => {
    initSup();
    sup.register(spec({ maxFailures: 1, cooldownMs: MIN, idempotent: false, tick: failing() }));
    await adv(MIN);
    expect(titles()).toEqual(['Background worker paused']);
    expect(notify.mock.calls[0][0].message).toMatch(/will stay paused until the app restarts/);
    await adv(30 * MIN);
    expect(titles()).toEqual(['Background worker paused', 'Background worker disabled']);
  });

  it('reEnable re-arms both notices', async () => {
    initSup();
    sup.register(spec({ maxFailures: 1, cooldownMs: MIN, maxRestarts: 0, tick: failing() }));
    await adv(2 * MIN);
    expect(titles()).toEqual(['Background worker paused', 'Background worker disabled']);
    expect(sup.reEnable('wk')).toBe(true);
    await adv(3 * MIN);
    expect(titles()).toEqual(['Background worker paused', 'Background worker disabled', 'Background worker paused', 'Background worker disabled']);
  });

  it('total notices ≤ isolations + 1 and ≤ effMaxRestarts + 2', async () => {
    // Worst case: every restart fully recovers once, then fails again.
    initSup();
    let i = 0;
    sup.register(spec({ maxFailures: 1, cooldownMs: MIN, tick: () => { if (i++ % 2 === 0) throw new Error('x'); } }));
    await adv(24 * 60 * MIN);
    const s = st();
    expect(s).toMatchObject({ state: 'disabled', disabledReason: 'restart-budget-exhausted', restarts: 3, maxRestarts: 3 });
    const total = notify.mock.calls.length;
    expect(total).toBeLessThanOrEqual(s.isolations + 1);
    expect(total).toBeLessThanOrEqual(s.maxRestarts + 2);
    expect(total).toBe(5);
    // Always-failing: far fewer notices, same bound.
    sup._resetForTests();
    initSup();
    sup.register(spec({ maxFailures: 1, cooldownMs: MIN, tick: failing() }));
    await adv(24 * 60 * MIN);
    const s2 = st();
    expect(notify.mock.calls.length).toBeLessThanOrEqual(s2.isolations + 1);
    expect(notify.mock.calls.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[FIX 7] repeated before-quit', () => {
  it('second onBeforeQuit inside the 15 s window keeps one watchdog and restarts the window', async () => {
    initSup();
    sup.register(spec());
    sup.onBeforeQuit();
    const base = vi.getTimerCount();
    await adv(10000);
    sup.onBeforeQuit();
    expect(vi.getTimerCount()).toBe(base);
    await adv(5000); // +15 s: the first window would have ended here
    expect(sup.getStatus().shuttingDown).toBe(true);
    await adv(9999);
    expect(sup.getStatus().shuttingDown).toBe(true);
    await adv(1); // +25 s
    expect(sup.getStatus().shuttingDown).toBe(false);
    expect(st().nextRunAt).toBe(T0 + 25000 + MIN);
  });

  it('drain log attached once per shutdown promise', async () => {
    initSup();
    sup.register(spec());
    expect(sup.onBeforeQuit()).toBeUndefined();
    expect(sup.onBeforeQuit()).toBeUndefined();
    await adv(0);
    expect(shutdownLogs()).toBe(1);
    sup._resetForTests();
    initSup();
    sup.register(spec({ tick: () => new Promise(() => {}) }));
    await adv(MIN);
    sup.onBeforeQuit();
    sup.onBeforeQuit();
    await adv(3000);
    expect(shutdownLogs()).toBe(1);
    expect(logger.calls.find((c) => c.msg.startsWith('[workers] shutdown:')).msg).toBe('[workers] shutdown: wk still running after 3000ms');
  });

  it('after a cancelled-quit resume, the next quit creates a fresh promise and logs again', async () => {
    initSup();
    sup.register(spec());
    sup.onBeforeQuit();
    const p1 = sup.shutdown();
    await adv(0);
    expect(shutdownLogs()).toBe(1);
    await adv(15000);
    expect(sup.getStatus().shuttingDown).toBe(false);
    sup.onBeforeQuit();
    const p2 = sup.shutdown();
    expect(p2).not.toBe(p1);
    await adv(0);
    expect(shutdownLogs()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('[FIX 8] duplicate detection by code', () => {
  it('register on an active name throws err.code === "WORKER_ACTIVE"', () => {
    initSup();
    sup.register(spec());
    let err;
    try { sup.register(spec()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('WORKER_ACTIVE');
  });

  it('claim on an active name returns true without a warn', () => {
    initSup();
    expect(sup.claim(spec())).toBe(true);
    expect(sup.claim(spec())).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sup.getStatus().workers).toHaveLength(1);
  });

  it('claim with an invalid spec (TypeError) returns false with one warn and leaves no record', () => {
    initSup();
    expect(sup.claim(spec({ intervalMs: 'often' }))).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/wk claim failed, legacy timer keeps ownership/);
    expect(sup.getStatus().workers).toEqual([]);
  });

  it('claim whose start hook throws an Error with message "worker already active" but no code returns false', () => {
    initSup();
    expect(sup.claim(spec({ start: () => { throw new Error('worker already active: wk'); } }))).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sup.getStatus().workers).toEqual([]);
  });
});
