// tests/workers-isolation-host.test.js — WorkerHost state machine, protocol correlation,
// bounds, AI proxy and shutdown with an injectable fake spawner (design §5, §7, §8, §11.1).
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createHost } = require('../src/workers/isolation/host');
const spawnMod = require('../src/workers/isolation/spawn');
const groups = require('../src/workers/isolation/groups');

const MB = 1024 * 1024;

function fakeClock(start = 1000000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const h = { id: ++seq, at: t + Math.max(0, ms), ms, fn, unref() { return h; } }; timers.set(h.id, h); return h; },
      clearTimeout: (h) => { if (h) timers.delete(h.id); },
    },
    pending: () => Array.from(timers.values()),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const h of timers.values()) if (h.at <= end && (!next || h.at < next.at || (h.at === next.at && h.id < next.id))) next = h;
        if (!next) break;
        timers.delete(next.id);
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  c.posted = [];
  c.killed = 0;
  c.exitOnKill = true;
  c.throwOnPost = null;
  c.postMessage = (m) => { if (c.throwOnPost) throw c.throwOnPost; c.posted.push(m); };
  c.kill = () => { c.killed++; if (c.exitOnKill) c.emit('exit', null); return true; };
  c.reply = (m) => c.emit('message', m);
  c.sent = (t) => c.posted.filter((m) => m.t === t);
  return c;
}

function mk(specOver = {}, depsOver = {}) {
  const clock = fakeClock();
  const children = [];
  let nextPid = 1000;
  const logs = [];
  const wlogs = [];
  const notes = [];
  const lg = (arr) => ({ debug: (m) => arr.push(['debug', m]), info: (m) => arr.push(['info', m]), warn: (m) => arr.push(['warn', m]), error: (m) => arr.push(['error', m]) });
  const spec = Object.assign({}, groups.canonical, { validateResult: (op, r) => ({ ok: true, value: r }) }, specOver);
  const processKill = vi.fn();
  const deps = Object.assign({
    spawn: () => { const c = fakeChild(++nextPid); children.push(c); return c; },
    timers: clock.timers, now: clock.now, random: () => 0.5, getChildRss: () => 100 * MB,
    logger: lg(logs), workerLogger: () => lg(wlogs), notify: (n) => notes.push(n), processKill, prewarmMs: 0,
  }, depsOver);
  const host = createHost(spec, deps);
  const last = () => children[children.length - 1];
  const hello = (c, over = {}) => c.reply(Object.assign({ t: 'hello', v: 1, group: spec.group, pid: c.pid, ppid: 1, ops: spec.ops.slice() }, over));
  const spawnNow = () => { if (host.state === 'idle' && !clock.pending().length) host.start(); clock.advance(0); return last(); };
  const ready = () => { const c = spawnNow(); hello(c); return c; };
  const reqRes = (c, result) => { const r = c.sent('req').pop(); c.reply({ t: 'res', id: r.id, ok: true, result }); return r; };
  const warns = (re) => logs.filter((l) => l[0] === 'warn' && re.test(l[1]));
  return { host, clock, children, logs, wlogs, notes, spec, deps, processKill, last, hello, spawnNow, ready, reqRes, warns };
}

// Crash the current child (unexpected exit) and respawn after the backoff.
function crash(h, code = 1) { h.last().emit('exit', code); }
// From backoff: advance exactly to the restart and complete the handshake.
function respawn(h) {
  if (h.host.state !== 'backoff') return;
  h.clock.advance(h.host.getStatusRow().nextRunAt - h.clock.now());
  h.hello(h.last());
}

describe('handshake and start', () => {
  it('handshake ok', () => {
    const h = mk();
    h.host.start();
    expect(h.host.getStatusRow().state).toBe('healthy');   // idle
    h.clock.advance(0);
    const c = h.last();
    expect(h.host.state).toBe('starting');
    const init = c.posted[0];
    expect(init).toMatchObject({ t: 'init', v: 1, group: 'canonical', parentPid: process.pid, ppidPollMs: 2000, maxLogPerMin: 50, workerSilenceExitMs: 45000, diag: false });
    h.hello(c);
    expect(h.host.state).toBe('ready');
    expect(h.host.getStatusRow()).toMatchObject({ state: 'healthy', waitingOn: null, owner: 'host', name: 'isoCanonical' });
    expect(h.host.getStatusRow().host.pid).toBe(c.pid);
  });

  it('start timeout: a worker that never sends hello is killed (start-timeout, crash++, backoff) (M2)', () => {
    const h = mk();
    const c = h.spawnNow();
    expect(h.host.getStatusRow()).toMatchObject({ state: 'waiting', waitingOn: ['spawn'] });
    h.clock.advance(9999);
    expect(c.killed).toBe(0);
    h.clock.advance(1);
    expect(c.killed).toBe(1);
    const row = h.host.getStatusRow();
    expect(h.host.state).toBe('backoff');
    expect(row.state).toBe('degraded');
    expect(row.host.lastExit.reason).toBe('start-timeout');
    expect(row.host.crashes).toBe(1);
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastError.kind).toBe('start');
    expect(row.nextRunAt).toBe(h.clock.now() + 5000);
    h.clock.advance(5000);
    expect(h.children).toHaveLength(2);
    expect(h.host.state).toBe('starting');
  });

  it('wrong group or version in hello kills (protocol)', () => {
    for (const over of [{ group: 'other' }, { v: 2 }, { ops: [] }]) {
      const h = mk();
      const c = h.spawnNow();
      h.hello(c, over);
      expect(c.killed).toBe(1);
      expect(h.host.getStatusRow().host.lastExit.reason).toBe('protocol');
    }
  });

  it('exit codes 3 and 4 do not count as crashes (M2)', () => {
    const h = mk();
    h.ready();
    crash(h, 3);
    let row = h.host.getStatusRow();
    expect(row.host.lastExit).toMatchObject({ code: 3, reason: 'parent-silent' });
    expect(row.host.crashes).toBe(0);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextRunAt).toBe(h.clock.now() + 5000);   // straight to backoff[0]
    h.clock.advance(5000);
    h.hello(h.last());
    crash(h, 4);
    row = h.host.getStatusRow();
    expect(row.host.lastExit).toMatchObject({ code: 4, reason: 'no-init' });
    expect(row.host.crashes).toBe(0);
    expect(row.counts.fail).toBe(0);
    h.clock.advance(5000);
    h.hello(h.last());
    crash(h, 1);
    expect(h.host.getStatusRow().host.crashes).toBe(1);
  });

  it('spawn throws → disabled(spawn-unsupported), WARN once', () => {
    const h = mk({}, { spawn: () => { throw new Error('no utilityProcess'); } });
    h.host.start();
    h.clock.advance(0);
    expect(h.host.getStatusRow()).toMatchObject({ state: 'disabled', breakerState: 'ok', disabledReason: 'spawn-unsupported' });
    expect(h.warns(/spawn failed/)).toHaveLength(1);
  });

  it('spawn and exit INFO lines include pid', () => {
    const h = mk();
    const c = h.ready();
    crash(h, 7);
    expect(h.logs).toContainEqual(['info', '[workers:isolation] spawned group=canonical pid=' + c.pid]);
    expect(h.logs).toContainEqual(['info', '[workers:isolation] exited group=canonical pid=' + c.pid + ' code=7 reason=exit']);
  });
});

describe('requests, timeouts and correlation', () => {
  it('id correlation with two sequential requests and progress forwarding', async () => {
    const h = mk();
    const c = h.ready();
    const prog = [];
    const p1 = h.host.request('canonical.buildAll', { rows: [] }, { onProgress: (x) => prog.push(x) });
    expect(h.host.getStatusRow().currentJob).toMatchObject({ runId: 1, trigger: 'canonical.buildAll', timedOut: false });
    expect(h.host.getStatusRow().state).toBe('busy');
    c.reply({ t: 'progress', id: 1, pct: 50, note: 'half' });
    h.reqRes(c, { a: 1 });
    const r1 = await p1;
    expect(r1).toMatchObject({ ok: true, result: { a: 1 } });
    expect(prog).toEqual([{ pct: 50, note: 'half' }]);
    const p2 = h.host.request('canonical.buildAll', { rows: [] });
    expect(c.sent('req').map((m) => m.id)).toEqual([1, 2]);
    h.reqRes(c, { b: 2 });
    expect((await p2).result).toEqual({ b: 2 });
    expect(h.host.getStatusRow().counts).toMatchObject({ runs: 2, ok: 2, fail: 0 });
  });

  it('busy host → NOT_READY; postMessage throw → CLONE_ERROR', async () => {
    const h = mk();
    const c = h.ready();
    h.host.request('canonical.buildAll', {});
    expect(await h.host.request('canonical.buildAll', {})).toMatchObject({ ok: false, code: 'NOT_READY' });
    h.reqRes(c, {});
    c.throwOnPost = Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' });
    expect(await h.host.request('canonical.buildAll', { f() {} })).toMatchObject({ ok: false, code: 'CLONE_ERROR' });
    expect(h.host.state).toBe('ready');
    const h2 = mk();
    expect(await h2.host.request('canonical.buildAll', {})).toMatchObject({ ok: false, code: 'NOT_READY' });
  });

  it('timeout → TIMEOUT → cancel → grace kill → backoff', async () => {
    const h = mk();
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {}, { timeoutMs: 1000 });
    h.clock.advance(1000);
    expect(await p).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(c.sent('cancel')).toEqual([{ t: 'cancel', id: 1 }]);
    expect(h.host.getStatusRow().currentJob.timedOut).toBe(true);
    expect(await h.host.request('canonical.buildAll', {})).toMatchObject({ code: 'NOT_READY' });
    h.clock.advance(1999);
    expect(c.killed).toBe(0);
    h.clock.advance(1);
    expect(c.killed).toBe(1);
    const row = h.host.getStatusRow();
    expect(row.host.lastExit.reason).toBe('timeout');
    expect(row.host.crashes).toBe(1);
    expect(row.counts).toMatchObject({ timeout: 1, fail: 1 });
    expect(h.host.state).toBe('backoff');
  });

  it('late res inside cancel grace disarms kill', async () => {
    const h = mk();
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {}, { timeoutMs: 1000 });
    h.clock.advance(1000);
    await p;
    h.clock.advance(500);
    c.reply({ t: 'res', id: 1, ok: true, result: {} });
    expect(h.host.state).toBe('ready');
    h.clock.advance(10000);
    expect(c.killed).toBe(0);
    expect(h.logs.some((l) => l[0] === 'debug' && /late res/.test(l[1]))).toBe(true);
    // A res for an already-answered id is dropped, no kill.
    c.reply({ t: 'res', id: 1, ok: true, result: {} });
    expect(c.killed).toBe(0);
  });

  it('res for a timed-out id after the grace kill is a no-op', async () => {
    const h = mk();
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {}, { timeoutMs: 1000 });
    h.clock.advance(3000);
    await p;
    expect(c.killed).toBe(1);
    expect(() => c.reply({ t: 'res', id: 1, ok: true, result: {} })).not.toThrow();
    expect(h.host.state).toBe('backoff');
  });

  it('caller cancel → CANCELLED, no crash count', async () => {
    const h = mk();
    const c = h.ready();
    const ac = new AbortController();
    const p = h.host.request('canonical.buildAll', {}, { signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, code: 'CANCELLED' });
    // progress for the cancelled id is dropped
    c.reply({ t: 'progress', id: 1, pct: 10 });
    expect(c.killed).toBe(0);
    h.clock.advance(2000);
    expect(c.killed).toBe(1);
    const row = h.host.getStatusRow();
    expect(row.host.lastExit.reason).toBe('cancel-kill');
    expect(row.host.crashes).toBe(0);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.nextRunAt).toBe(h.clock.now() + 5000);
  });

  it('stale pong accepted then duplicate dropped', () => {
    const h = mk();
    const c = h.ready();
    h.clock.advance(10000);
    expect(c.sent('ping')).toEqual([{ t: 'ping', seq: 1 }]);
    h.clock.advance(10000);
    expect(c.sent('ping').map((m) => m.seq)).toEqual([1, 2]);
    c.reply({ t: 'pong', seq: 1, rss: 10 * MB, heapUsed: 1 });
    expect(c.killed).toBe(0);
    expect(h.host.getStatusRow().lastHeartbeatAt).toBe(h.clock.now());
    c.reply({ t: 'pong', seq: 1, rss: 10 * MB, heapUsed: 1 });
    expect(c.killed).toBe(0);
    c.reply({ t: 'pong', seq: 2, rss: 10 * MB, heapUsed: 1 });
    expect(c.killed).toBe(0);
    expect(h.host.getStatusRow().host.rssMb).toBe(10);
  });

  it('miss rule kills on 3rd missed ping', () => {
    const h = mk();
    const c = h.ready();
    h.clock.advance(10000);   // ping 1
    h.clock.advance(10000);   // miss 1, ping 2
    h.clock.advance(10000);   // miss 2, ping 3
    expect(c.killed).toBe(0);
    h.clock.advance(10000);   // miss 3 → kill
    expect(c.killed).toBe(1);
    expect(h.host.getStatusRow().host.lastExit.reason).toBe('hung');
    expect(h.host.getStatusRow().lastError.kind).toBe('hung');

    const h2 = mk();
    const c2 = h2.ready();
    h2.clock.advance(30000);  // ping 1..3, misses 1..2
    c2.reply({ t: 'pong', seq: 3, rss: 1, heapUsed: 1 });   // resets the count
    h2.clock.advance(20000);
    expect(c2.killed).toBe(0);
  });

  it('transport violations kill and count a crash', () => {
    const cases = [
      (c) => c.reply({ t: 'res', id: 0, ok: true }),
      (c) => c.reply({ t: 'res', id: -1, ok: true }),
      (c) => c.reply({ t: 'res', id: 1.5, ok: true }),
      (c) => c.reply({ t: 'res', id: 99, ok: true }),
      (c) => c.reply({ t: 'pong', seq: 5, rss: 1, heapUsed: 1 }),
      (c, h) => h.hello(c),
      (c) => c.reply({ t: 'whatever' }),
      (c) => c.reply('not an object'),
      (c) => c.reply({ t: 'res', id: 1, ok: false, error: { code: 'lower-case', message: 'x' } }),
    ];
    for (const act of cases) {
      const h = mk();
      const c = h.ready();
      act(c, h);
      expect(c.killed).toBe(1);
      const row = h.host.getStatusRow();
      expect(row.host.lastExit.reason).toBe('protocol');
      expect(row.host.crashes).toBe(1);
      expect(row.lastError.kind).toBe('protocol');
    }
    const h = mk();
    const c = h.spawnNow();
    c.reply({ t: 'log', level: 'info', msg: 'early' });   // non-hello before hello
    expect(c.killed).toBe(1);
  });

  it('a violation with a request in flight resolves PROTOCOL; exit mid-request → CRASHED', async () => {
    const h = mk();
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {});
    c.reply({ t: 'res', id: 42, ok: true });
    expect(await p).toMatchObject({ ok: false, code: 'PROTOCOL' });
    h.clock.advance(5000);
    const c2 = h.last();
    h.hello(c2);
    const p2 = h.host.request('canonical.buildAll', {});
    c2.emit('exit', 1);
    expect(await p2).toMatchObject({ ok: false, code: 'CRASHED' });
  });

  it('INVALID_RESULT: no kill, no crash count, fail++, WARN once', async () => {
    const h = mk({ validateResult: () => ({ ok: false, rule: 'foreign-key' }) });
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', { rows: [] });
    h.reqRes(c, { units: {} });
    expect(await p).toMatchObject({ ok: false, code: 'INVALID_RESULT' });
    const p2 = h.host.request('canonical.buildAll', { rows: [] });
    h.reqRes(c, { units: {} });
    await p2;
    const row = h.host.getStatusRow();
    expect(c.killed).toBe(0);
    expect(row.host.crashes).toBe(0);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.counts.fail).toBe(2);
    expect(row.lastError.kind).toBe('invalid-result');
    expect(h.warns(/invalid result \(foreign-key\)/)).toHaveLength(1);
    expect(h.host.state).toBe('ready');
  });

  it('RSS over cap via getChildRss and via pong kills with reason rss', async () => {
    let rss = 100 * MB;
    const h = mk({}, { getChildRss: () => rss });
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {});
    rss = 600 * MB;
    h.clock.advance(5000);   // busy poll interval
    expect(await p).toMatchObject({ ok: false, code: 'RSS_LIMIT' });
    expect(c.killed).toBe(1);
    expect(h.host.getStatusRow().host.lastExit.reason).toBe('rss');
    expect(h.host.getStatusRow().lastError.kind).toBe('rss');

    const h2 = mk();
    const c2 = h2.ready();
    h2.clock.advance(10000);
    c2.reply({ t: 'pong', seq: 1, rss: 513 * MB, heapUsed: 1 });
    expect(c2.killed).toBe(1);
    expect(h2.host.getStatusRow().host.lastExit.reason).toBe('rss');
  });
});

describe('crash counters, isolation and bubbles', () => {
  it('crash counters and backoff index', async () => {
    const h = mk();
    h.ready();
    crash(h);                                        // crash 1 → backoff[0]
    expect(h.host.getStatusRow().nextRunAt).toBe(h.clock.now() + 5000);
    h.clock.advance(5000);
    let c = h.last();
    h.hello(c);
    const p = h.host.request('canonical.buildAll', {});
    h.reqRes(c, {});
    await p;                                          // success resets consecutiveCrashes
    expect(h.host.getStatusRow().consecutiveFailures).toBe(0);
    crash(h);                                        // crash 2 → backoff[0] again
    expect(h.host.getStatusRow().consecutiveFailures).toBe(1);
    expect(h.host.getStatusRow().nextRunAt).toBe(h.clock.now() + 5000);
    h.clock.advance(5000);
    h.hello(h.last());
    crash(h);                                        // crash 3 within 10 min → isolated (success did not clear crashTimes)
    expect(h.host.state).toBe('isolated');

    const g = mk({ maxCrashes: 10 });
    g.ready();
    crash(g);
    g.clock.advance(5000);
    g.hello(g.last());
    crash(g);
    expect(g.host.getStatusRow().consecutiveFailures).toBe(2);
    expect(g.host.getStatusRow().nextRunAt).toBe(g.clock.now() + 30000);   // backoff[1]
  });

  it('crash loop → isolated + one bubble → cooldown → disabled + one bubble', () => {
    const h = mk({ maxRestarts: 1, cooldownMs: 60000 });
    const loop = () => {
      h.hello(h.last());
      for (let i = 0; i < 3; i++) {
        crash(h);
        respawn(h);
      }
    };
    h.spawnNow();
    loop();
    expect(h.host.state).toBe('isolated');
    expect(h.notes).toHaveLength(1);
    let row = h.host.getStatusRow();
    expect(row).toMatchObject({ state: 'isolated', breakerState: 'isolated', isolations: 1, nextRunAt: row.isolatedUntil });
    h.clock.advance(60000);                         // cool-down end → restart 1/1
    expect(h.host.state).toBe('starting');
    expect(h.host.getStatusRow().restarts).toBe(1);
    loop();
    expect(h.host.state).toBe('isolated');
    expect(h.notes).toHaveLength(1);                // still one "paused" bubble this episode
    h.clock.advance(60000);
    row = h.host.getStatusRow();
    expect(row).toMatchObject({ state: 'disabled', breakerState: 'budget-exhausted', disabledReason: 'restart-budget-exhausted' });
    expect(h.notes).toHaveLength(2);
    expect(h.notes[1].title).toBe('Background worker disabled');
  });

  it('bubble payloads deep-equal supervisor shape', () => {
    const h = mk({ maxRestarts: 0, cooldownMs: 60000 });
    h.ready();
    for (let i = 0; i < 3; i++) { crash(h); respawn(h); }
    h.clock.advance(60000);
    const [paused, disabled] = h.notes;
    expect(Object.keys(paused).sort()).toEqual(['body', 'icon', 'message', 'title', 'type', 'worker']);
    expect(paused).toEqual({ title: 'Background worker paused', message: paused.message, body: paused.message, icon: '⚠️', type: 'worker', worker: 'isoCanonical' });
    expect(paused.message).toMatch(/^Canonical pass \(isolated\) stopped after 3 failures/);
    expect(disabled).toEqual({ title: 'Background worker disabled', message: disabled.message, body: disabled.message, icon: '⛔', type: 'worker', worker: 'isoCanonical' });
  });

  it('reEnable resets counters', () => {
    const h = mk();
    h.ready();
    for (let i = 0; i < 3; i++) { crash(h); respawn(h); }
    expect(h.host.state).toBe('isolated');
    expect(h.host.reEnable()).toBe(true);
    const row = h.host.getStatusRow();
    expect(row).toMatchObject({ consecutiveFailures: 0, restarts: 0, isolatedUntil: null, isolationReason: null, notified: false, state: 'waiting' });
    expect(h.host.reEnable()).toBe(false);          // only from isolated / budget-exhausted
  });
});

describe('getStatusRow and env', () => {
  it('getStatusRow per state matches §7', async () => {
    const h = mk();
    expect(h.host.getStatusRow()).toMatchObject({ state: 'healthy', breakerState: 'ok', disabledReason: null, waitingOn: null, nextRunAt: null, intervalMs: null, group: 'isolation' });
    const c = h.spawnNow();
    expect(h.host.getStatusRow()).toMatchObject({ state: 'waiting', waitingOn: ['spawn'] });
    h.hello(c);
    h.host.request('canonical.buildAll', {});
    const busy = h.host.getStatusRow();
    expect(busy.state).toBe('busy');
    expect(busy.currentJob).toEqual({ runId: 1, startedAt: h.clock.now(), trigger: 'canonical.buildAll', timedOut: false });
    crash(h);
    expect(h.host.getStatusRow()).toMatchObject({ state: 'degraded', breakerState: 'ok', currentJob: null });
    h.host.shutdown();
    expect(h.host.getStatusRow()).toMatchObject({ state: 'disabled', disabledReason: 'shutdown', breakerState: 'ok' });
    expect(h.host.getStatusRow()).toMatchObject({ timeoutMs: 30000, maxFailures: 3, cooldownMs: 1800000, maxRestarts: 3, idempotent: true, dependsOn: [], owner: 'host' });
  });

  it('workerEnv keeps only the 5 keys and drops undefined', () => {
    const env = spawnMod.workerEnv({ NODE_ENV: 'test', SystemRoot: 'C:\\Windows', SLACK_TOKEN: 'x', FLEET_WORKERS: '1', AWS_SECRET: 'y' });
    expect(Object.keys(env).sort()).toEqual(['NODE_ENV', 'SystemRoot', 'TEMP', 'TMP']);
    expect(env.NODE_ENV).toBe('test');
    const env2 = spawnMod.workerEnv({ windir: 'C:\\W' });
    expect(Object.keys(env2).sort()).toEqual(['NODE_ENV', 'TEMP', 'TMP', 'windir']);
    expect(env2.NODE_ENV).toBe('production');
  });

  it('defaultSpawner uses deps.electron and passes exactly the §11.4 fork options (N2)', () => {
    const child = { pid: 5 };
    const fork = vi.fn(() => child);
    const out = spawnMod.defaultSpawner(groups.canonical, { electron: { utilityProcess: { fork } } });
    expect(out).toBe(child);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith(groups.canonical.file, [], {
      serviceName: 'fleet-worker-canonical',
      execArgv: ['--max-old-space-size=384'],
      stdio: 'ignore',
      partition: 'fleet-worker-canonical',
      env: spawnMod.workerEnv(),
    });
  });
});

describe('shutdown and killSync', () => {
  it('shutdown() posts shutdown then kills at 1500 ms', async () => {
    const h = mk();
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {});
    expect(h.host.shutdown()).toBe(true);
    expect(await p).toMatchObject({ ok: false, code: 'SHUTDOWN' });
    expect(c.sent('shutdown')).toHaveLength(1);
    expect(h.host.state).toBe('stopping');
    h.clock.advance(1499);
    expect(c.killed).toBe(0);
    h.clock.advance(1);
    expect(c.killed).toBe(1);
    expect(h.host.state).toBe('stopped');
    expect(h.host.getStatusRow().host.crashes).toBe(0);
    expect(await h.host.request('canonical.buildAll', {})).toMatchObject({ code: 'NOT_READY' });
  });

  it('repeated shutdown() while stopping/stopped is a no-op (N5)', () => {
    const h = mk();
    const c = h.ready();
    h.host.shutdown();
    const timersAfterFirst = h.clock.pending().filter((t) => t.ms === 1500).length;
    expect(h.host.shutdown()).toBe(false);
    expect(c.sent('shutdown')).toHaveLength(1);
    expect(h.clock.pending().filter((t) => t.ms === 1500).length).toBe(timersAfterFirst);
    expect(timersAfterFirst).toBe(1);
    c.emit('exit', 0);
    expect(h.host.state).toBe('stopped');
    expect(h.host.shutdown()).toBe(false);
    expect(c.sent('shutdown')).toHaveLength(1);
  });

  it('resume() after a cancelled quit respawns after 2 s', () => {
    const h = mk();
    const c = h.ready();
    h.host.shutdown();
    c.emit('exit', 0);
    expect(h.host.resume()).toBe(true);
    expect(h.host.state).toBe('idle');
    h.clock.advance(1999);
    expect(h.children).toHaveLength(1);
    h.clock.advance(1);
    expect(h.children).toHaveLength(2);
    expect(h.host.state).toBe('starting');
  });

  it('killSync always follows child.kill() with processKill(pid,0) and processKill(pid)', () => {
    const h = mk();
    const c = h.ready();
    c.exitOnKill = false;   // kill() returns true but never exits
    expect(h.host.killSync()).toBe(true);
    expect(c.killed).toBe(1);
    expect(h.processKill.mock.calls).toEqual([[c.pid, 0], [c.pid]]);
    // ESRCH is swallowed and killSync never throws
    const h2 = mk({}, { processKill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
    const c2 = h2.ready();
    c2.exitOnKill = false;
    expect(() => h2.host.killSync()).not.toThrow();
    expect(h2.logs.filter((l) => l[0] === 'error')).toHaveLength(0);
    // a pid whose exit was observed is not touched
    const h3 = mk();
    const c3 = h3.ready();
    c3.emit('exit', 0);
    h3.host.killSync();
    expect(h3.processKill).not.toHaveBeenCalled();
  });
});

describe('log routing', () => {
  it('log routing, level mapping, rate limit with dropped-count line', () => {
    const h = mk({ pingIntervalMs: 1e9 });
    const c = h.ready();
    c.reply({ t: 'log', level: 'error', msg: 'bad\nthing' });
    expect(h.wlogs[0]).toEqual(['error', 'badthing']);
    for (let i = 0; i < 60; i++) c.reply({ t: 'log', level: 'info', msg: 'line ' + i });
    expect(h.wlogs).toHaveLength(50);
    h.clock.advance(60000);
    c.reply({ t: 'log', level: 'debug', msg: 'after' });
    expect(h.wlogs[50]).toEqual(['warn', '[worker:canonical] dropped 11 log lines']);
    expect(h.wlogs[51]).toEqual(['debug', 'after']);
  });
});

describe('AI proxy', () => {
  const AI = { maxPerRequest: 2, maxConcurrent: 1, maxPriority: 'normal', isolatedOnly: false, maxTimeoutMs: 5000, maxPromptChars: 100 };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('AI budget 0 → AI_NOT_ALLOWED before any clamp', async () => {
    const relay = { ask: vi.fn() };
    const h = mk({}, { relay });
    const c = h.ready();
    const p = h.host.request('canonical.buildAll', {});
    h.reqRes(c, {});
    await p;   // id 1 issued, no longer outstanding
    c.reply({ t: 'ai', aiId: 1, id: 1, prompt: 'x'.repeat(100000), opts: { priority: 'critical', timeoutMs: -5 } });
    expect(c.sent('ai.res')).toEqual([{ t: 'ai.res', aiId: 1, ok: false, code: 'AI_NOT_ALLOWED' }]);
    expect(c.killed).toBe(0);
    expect(relay.ask).not.toHaveBeenCalled();
    c.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'y' });
    expect(h.warns(/AI_NOT_ALLOWED/)).toHaveLength(1);   // one WARN per host lifetime
  });

  it('AI proxy calls relay.ask with clamped opts and aborts on crash/cancel', async () => {
    let release;
    const relay = { ask: vi.fn(() => new Promise((r) => { release = r; })) };
    const h = mk({ ai: AI }, { relay });
    const c = h.ready();
    h.host.request('canonical.buildAll', {});
    c.reply({ t: 'ai', aiId: 1, id: 1, prompt: 'hello', opts: { priority: 'critical', timeoutMs: 999999, dedupeKey: 'k1' } });
    expect(relay.ask).toHaveBeenCalledTimes(1);
    const [prompt, o] = relay.ask.mock.calls[0];
    expect(prompt).toBe('hello');
    expect(o).toMatchObject({ priority: 'normal', source: 'worker_canonical', timeoutMs: 5000, isolated: false, dedupeKey: 'worker:canonical:k1' });
    expect(o.signal).toBeInstanceOf(AbortSignal);
    release('answer');
    await flush();
    expect(c.sent('ai.res')).toEqual([{ t: 'ai.res', aiId: 1, ok: true, text: 'answer' }]);
    c.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'again', opts: { timeoutMs: 10 } });
    const o2 = relay.ask.mock.calls[1][1];
    expect(o2.timeoutMs).toBe(1000);
    expect(o2.priority).toBe('low');
    c.emit('exit', 1);                                  // crash aborts the signal
    expect(o2.signal.aborted).toBe(true);

    const h2 = mk({ ai: Object.assign({}, AI, { isolatedOnly: true }) }, { relay: { ask: vi.fn(() => new Promise(() => {})) } });
    const c2 = h2.ready();
    const ac = new AbortController();
    h2.host.request('canonical.buildAll', {}, { signal: ac.signal });
    c2.reply({ t: 'ai', aiId: 1, id: 1, prompt: 'p', opts: { dedupeKey: 'k' } });
    const o3 = h2.deps.relay.ask.mock.calls[0][1];
    expect(o3.isolated).toBe(true);
    expect(o3.dedupeKey).toBeUndefined();
    ac.abort();
    expect(o3.signal.aborted).toBe(true);
    // ai for the cancelled request: no reply, relay not called again
    c2.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'late' });
    expect(h2.deps.relay.ask).toHaveBeenCalledTimes(1);
    expect(c2.sent('ai.res')).toHaveLength(0);
  });

  it('AI per-request and concurrent limits', async () => {
    const resolvers = [];
    const relay = { ask: vi.fn(() => new Promise((r) => resolvers.push(r))) };
    const h = mk({ ai: AI }, { relay });
    const c = h.ready();
    h.host.request('canonical.buildAll', {});
    c.reply({ t: 'ai', aiId: 1, id: 1, prompt: 'a' });
    c.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'b' });   // concurrent limit 1
    expect(c.sent('ai.res')).toEqual([{ t: 'ai.res', aiId: 2, ok: false, code: 'AI_LIMIT' }]);
    resolvers[0]('one');
    await flush();
    c.reply({ t: 'ai', aiId: 3, id: 1, prompt: 'c' });   // 2nd of 2 per request
    resolvers[1]('two');
    await flush();
    c.reply({ t: 'ai', aiId: 4, id: 1, prompt: 'd' });   // over maxPerRequest
    expect(c.sent('ai.res').pop()).toEqual({ t: 'ai.res', aiId: 4, ok: false, code: 'AI_LIMIT' });
    expect(relay.ask).toHaveBeenCalledTimes(2);
    const h2 = mk({ ai: AI }, { relay });
    const c2 = h2.ready();
    h2.host.request('canonical.buildAll', {});
    c2.reply({ t: 'ai', aiId: 1, id: 1, prompt: '' });
    c2.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'z'.repeat(101) });
    expect(c2.sent('ai.res').map((m) => m.code)).toEqual(['AI_NOT_ALLOWED', 'AI_NOT_ALLOWED']);
    c2.reply({ t: 'ai', aiId: 3, id: 7, prompt: 'never issued' });
    expect(c2.killed).toBe(1);
  });

  it('relay failure → AI_FAILED / AI_TIMEOUT, error text not forwarded', async () => {
    const relay = { ask: vi.fn().mockRejectedValueOnce(new Error('secret backend detail')).mockRejectedValueOnce(new Error('request timed out')) };
    const h = mk({ ai: Object.assign({}, AI, { maxConcurrent: 2 }) }, { relay });
    const c = h.ready();
    h.host.request('canonical.buildAll', {});
    c.reply({ t: 'ai', aiId: 1, id: 1, prompt: 'a' });
    c.reply({ t: 'ai', aiId: 2, id: 1, prompt: 'b' });
    await flush();
    expect(c.sent('ai.res')).toEqual([{ t: 'ai.res', aiId: 1, ok: false, code: 'AI_FAILED' }, { t: 'ai.res', aiId: 2, ok: false, code: 'AI_TIMEOUT' }]);
    expect(JSON.stringify(c.posted)).not.toMatch(/secret/);
  });
});
