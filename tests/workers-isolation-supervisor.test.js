// tests/workers-isolation-supervisor.test.js — supervisor host table, registry singleton,
// snapshot host sub-object, app.js wiring (design §3.2, §7.1, §7.2, review N5).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Module, { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { workerStatus } from '../renderer/src/js/views/worker-health-logic.js';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUP_PATH = path.join(ROOT, 'src', 'workers', 'supervisor.js');
const sup = require('../src/workers/supervisor');
const iso = require('../src/workers/isolation');
const { createHost } = require('../src/workers/isolation/host');
const groups = require('../src/workers/isolation/groups');
const snapshot = require('../src/health/snapshot');

function fakeClock(start = 5000000) {
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
const quiet = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const SUP_FLAGS = { supervisorEnabled: true, supervised: {} };
const ISO_ON = { enabled: true, groups: { canonical: true } };
const ISO_OFF = { enabled: false, groups: { canonical: false } };

function initSup(s, clock, extra = {}) {
  return s.init(Object.assign({ flags: SUP_FLAGS, timers: clock.timers, now: clock.now, random: () => 0.5, logger: quiet() }, extra));
}
function timerSpec(over = {}) {
  let n = 0;
  return Object.assign({ name: 'synthA', group: 'test', label: 'Synthetic A', intervalMs: 60000, timeoutMs: 5000, idempotent: true,
    tick: async () => { n++; if (n === 2) throw new Error('second tick fails'); return { n }; } }, over);
}
function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid; c.posted = []; c.killed = 0;
  c.postMessage = (m) => c.posted.push(m);
  c.kill = () => { c.killed++; c.emit('exit', null); return true; };
  c.reply = (m) => c.emit('message', m);
  return c;
}
function fakeHostHandle(row) {
  return { name: row.name, getStatusRow: () => JSON.parse(JSON.stringify(row)), reEnable: vi.fn(() => true), shutdown: vi.fn(), resume: vi.fn(), killSync: vi.fn() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// The pre-change supervisor (base afe2a45), compiled as an independent module
// instance at the real path so its relative requires resolve.
function loadBaselineSupervisor() {
  let src;
  try { src = execFileSync('git', ['-C', ROOT, 'show', 'afe2a45:src/workers/supervisor.js'], { encoding: 'utf8', windowsHide: true }); } catch (_) { return null; }
  const m = new Module(SUP_PATH, null);
  m.filename = SUP_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(SUP_PATH));
  m._compile(src, SUP_PATH);
  return m.exports;
}

beforeEach(() => { sup._resetForTests(); iso._resetForTests(); });
afterEach(() => { sup._resetForTests(); iso._resetForTests(); vi.restoreAllMocks(); });

describe('supervisor host table', () => {
  it('no hosts: getStatus/getSummary deep-equal pre-change baseline', async () => {
    const base = loadBaselineSupervisor();
    expect(base, 'git show afe2a45:src/workers/supervisor.js').toBeTruthy();
    const drive = async (s) => {
      const clock = fakeClock();
      initSup(s, clock);
      s.register(timerSpec());
      s.register(timerSpec({ name: 'synthB', label: 'Synthetic B', dependsOn: ['offline'] }));
      const snaps = [JSON.stringify([s.getStatus(), s.getSummary()])];
      clock.advance(60000); await flush();
      clock.advance(60000); await flush();
      snaps.push(JSON.stringify([s.getStatus(), s.getSummary()]));
      expect(s.reEnable('synthA')).toBe(false);
      s.onBeforeQuit();
      snaps.push(JSON.stringify([s.getStatus(), s.getSummary()]));
      clock.advance(15000); await flush();
      snaps.push(JSON.stringify([s.getStatus(), s.getSummary()]));
      s.onWillQuit();
      s._resetForTests();
      return snaps;
    };
    const want = await drive(base);
    const got = await drive(sup);
    expect(got).toEqual(want);
    expect(JSON.parse(got[1])[1].fails).toBe(2);   // the synthetic failures are in the comparison
  });

  it('host row key set equals _workerStatus key set plus host', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    sup.register(timerSpec());
    const timerRow = sup.getStatus().workers[0];
    const host = createHost(groups.canonical, { spawn: () => fakeChild(77), timers: clock.timers, now: clock.now, logger: quiet() });
    expect(Object.keys(host.getStatusRow()).sort()).toEqual(Object.keys(timerRow).concat(['host']).sort());
    expect(Object.keys(host.getStatusRow().host).sort()).toEqual(['crashes', 'fallbacks', 'hostState', 'lastExit', 'mainMsAvg', 'pid', 'rssCapMb', 'rssMb', 'spawns', 'staleDiscards', 'workerMsAvg']);
  });

  it('host rows appear in getStatus; getSummary folds host rows', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    sup.register(timerSpec());
    const host = createHost(groups.canonical, { spawn: () => fakeChild(78), timers: clock.timers, now: clock.now, logger: quiet(), prewarmMs: 0 });
    expect(sup.registerHost(host)).toBe(true);
    expect(() => sup.registerHost(host)).toThrow(/already active/);
    expect(() => sup.registerHost({ name: 'synthA', getStatusRow() {}, reEnable() {} })).toThrow();
    expect(() => sup.registerHost({ name: 'Bad Name', getStatusRow() {}, reEnable() {} })).toThrow(/invalid host name/);
    host.start();
    clock.advance(0);   // starting
    const st = sup.getStatus();
    expect(st.workers.map((w) => w.name)).toEqual(['synthA', 'isoCanonical']);
    expect(st.workers[1]).toMatchObject({ owner: 'host', state: 'waiting', waitingOn: ['spawn'] });
    let sum = sup.getSummary();
    expect(sum.count).toBe(2);
    expect(sum.byState.waiting).toBe(1);
    expect(sum.waiting).toEqual([{ name: 'isoCanonical', on: ['spawn'] }]);
    // a host lastError newer than any record's is folded into lastErrorAt
    const fake = fakeHostHandle(Object.assign({}, host.getStatusRow(), { name: 'isoOther', state: 'isolated', counts: { runs: 0, ok: 0, fail: 4, skip: 0, timeout: 0 }, lastError: { message: 'x', at: clock.now() + 99, kind: 'crash' } }));
    sup.registerHost(fake);
    sum = sup.getSummary();
    expect(sum.count).toBe(3);
    expect(sum.isolated).toEqual(['isoOther']);
    expect(sum.fails).toBe(4);
    expect(sum.lastErrorAt).toBe(clock.now() + 99);
    expect(sup.unregisterHost('isoOther')).toBe(true);
    expect(sup.getSummary().count).toBe(2);
  });

  it('renderer workerStatus renders running Ns / N consecutive failures', () => {
    const clock = fakeClock();
    let child;
    const host = createHost(groups.canonical, { spawn: () => (child = fakeChild(79)), timers: clock.timers, now: clock.now, logger: quiet(), prewarmMs: 0 });
    host.start();
    clock.advance(0);
    child.reply({ t: 'hello', v: 1, group: 'canonical', pid: 79, ppid: 1, ops: ['canonical.buildAll'] });
    host.request('canonical.buildAll', { rows: [] });
    clock.advance(12000);
    child.reply({ t: 'pong', seq: 1, rss: 1, heapUsed: 1 });
    expect(workerStatus(host.getStatusRow(), clock.now())).toMatchObject({ key: 'busy', reason: 'running 12s' });
    child.emit('exit', 1);
    expect(workerStatus(host.getStatusRow(), clock.now())).toMatchObject({ key: 'degraded', reason: '1 consecutive failure' });
  });

  it('reEnable(isoCanonical) delegates', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const h = fakeHostHandle({ name: 'isoCanonical', state: 'isolated', counts: {} });
    sup.registerHost(h);
    expect(sup.reEnable('isoCanonical')).toBe(true);
    expect(h.reEnable).toHaveBeenCalledTimes(1);
  });

  it('reEnable(isoCanonical) returns false during shutdown; host lookup is after the _shuttingDown guard (N5)', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const h = fakeHostHandle({ name: 'isoCanonical', state: 'isolated', counts: {} });
    sup.registerHost(h);
    vi.spyOn(iso, 'onBeforeQuit').mockImplementation(() => {});
    sup.onBeforeQuit();
    expect(sup.reEnable('isoCanonical')).toBe(false);
    expect(h.reEnable).not.toHaveBeenCalled();
    const src = fs.readFileSync(SUP_PATH, 'utf8');
    const body = src.slice(src.indexOf('function reEnable('));
    expect(body.indexOf('if (!_initialized || _shuttingDown) return false;')).toBeLessThan(body.indexOf('_hosts.has(name)'));
  });

  it('before-quit/will-quit/cancelled-quit reach the registry', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const bq = vi.spyOn(iso, 'onBeforeQuit').mockImplementation(() => {});
    const wq = vi.spyOn(iso, 'onWillQuit').mockImplementation(() => {});
    const rs = vi.spyOn(iso, 'resume').mockImplementation(() => {});
    sup.onBeforeQuit();
    expect(bq).not.toHaveBeenCalled();   // no hosts → registry untouched
    sup._resetForTests();
    initSup(sup, clock);
    sup.registerHost(fakeHostHandle({ name: 'isoCanonical', state: 'healthy', counts: {} }));
    sup.onBeforeQuit();
    expect(bq).toHaveBeenCalledTimes(1);
    clock.advance(15000);                 // no will-quit → cancelled-quit resume
    expect(rs).toHaveBeenCalledTimes(1);
    sup.onBeforeQuit();
    sup.onWillQuit();
    expect(wq).toHaveBeenCalledTimes(1);
  });
});

describe('snapshot._worker host sub-object', () => {
  it('snapshot._worker: no host unchanged; host sanitized', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    sup.register(timerSpec());
    const legacy = sup.getStatus().workers[0];
    const out = snapshot._worker(legacy);
    expect(out).not.toHaveProperty('host');
    expect(Object.keys(out)).toEqual(['name', 'group', 'label', 'state', 'waitingOn', 'disabledReason', 'breakerState', 'lastHeartbeatAt', 'lastStartAt',
      'lastEndAt', 'lastDurationMs', 'currentJob', 'counts', 'skipReasons', 'consecutiveFailures', 'lastError', 'restarts', 'maxRestarts', 'isolations',
      'isolationReason', 'isolatedUntil', 'notified', 'nextRunAt', 'intervalMs', 'timeoutMs', 'maxFailures', 'cooldownMs', 'dependsOn', 'idempotent', 'owner']);
    const row = Object.assign({}, legacy, { host: { pid: 9, hostState: 'x'.repeat(100), rssMb: 'big', rssCapMb: 512, spawns: 2, crashes: 1,
      lastExit: { code: 3, reason: 'parent-silent', at: 123, extra: 'drop' }, fallbacks: { stale: 2, bad: 'str' }, staleDiscards: 2,
      mainMsAvg: { dispatch: 1.5, commit: null }, workerMsAvg: 40, secret: 'TOKEN' } });
    const h = snapshot._worker(row).host;
    expect(h).toEqual({ pid: 9, hostState: h.hostState, rssMb: null, rssCapMb: 512, spawns: 2, crashes: 1, lastExit: { code: 3, reason: 'parent-silent', at: 123 },
      fallbacks: { stale: 2 }, staleDiscards: 2, mainMsAvg: { dispatch: 1.5, commit: null }, workerMsAvg: 40 });
    expect(h.hostState.length).toBeLessThanOrEqual(40);
  });
});

describe('isolation registry', () => {
  it('init with flags off spawns nothing, requires no electron, adds no exit listener, logs nothing at INFO+ (N5)', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const statusBefore = JSON.stringify(sup.getStatus());
    const electronLoaded = () => Object.keys(require.cache).filter((k) => /[\\/]node_modules[\\/]electron[\\/]/.test(k)).length;
    const eBefore = electronLoaded();
    const exitBefore = process.listenerCount('exit');
    const spawn = vi.fn();
    const createHostSpy = vi.fn();
    const logger = quiet();
    for (const flags of [ISO_OFF, { enabled: true, groups: { canonical: false } }, { enabled: false, groups: { canonical: true } }]) {
      iso._resetForTests();
      expect(iso.init({ flags, logger, supervisor: sup, deps: { spawn, createHost: createHostSpy } })).toEqual({ enabled: false, groups: [] });
      expect(iso.isActive('canonical')).toBe(false);
      expect(iso.getHost('canonical')).toBeNull();
    }
    expect(clock.pending()).toHaveLength(0);   // no timers armed
    expect(spawn).not.toHaveBeenCalled();
    expect(createHostSpy).not.toHaveBeenCalled();
    expect(electronLoaded()).toBe(eBefore);
    expect(process.listenerCount('exit')).toBe(exitBefore);
    expect(JSON.stringify(sup.getStatus())).toBe(statusBefore);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    // onBeforeQuit / onWillQuit / resume are silent no-ops
    expect(() => { iso.onBeforeQuit(); iso.onWillQuit(); iso.resume(); iso.killAllSync(); }).not.toThrow();
  });

  it('supervisor off with isolation on: one INFO, isActive false', () => {
    const logger = quiet();
    const spawn = vi.fn();
    const r = iso.init({ flags: ISO_ON, logger, supervisor: { isEnabled: () => false, registerHost: vi.fn() }, deps: { spawn } });
    expect(r).toMatchObject({ enabled: false, reason: 'supervisor-off' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatch(/supervisor is off/);
    expect(iso.isActive('canonical')).toBe(false);
    expect(iso.init({ flags: ISO_ON, logger })).toBe(r);   // memoized
    expect(spawn).not.toHaveBeenCalled();
  });

  it('flags on + supervisor on: registers the host, prewarms, tracks pids, one exit listener', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const kids = [];
    const exitBefore = process.listenerCount('exit');
    const r = iso.init({ flags: ISO_ON, supervisor: sup, logger: quiet(), deps: { spawn: () => { const c = fakeChild(4000 + kids.length); kids.push(c); return c; }, timers: clock.timers, now: clock.now } });
    expect(r).toEqual({ enabled: true, groups: ['canonical'] });
    expect(iso.isActive('canonical')).toBe(true);
    expect(sup.getStatus().workers.map((w) => w.name)).toEqual(['isoCanonical']);
    expect(kids).toHaveLength(0);
    clock.advance(30000);                  // t+30 s prewarm
    expect(kids).toHaveLength(1);
    expect(iso._spawnedPids()).toEqual(new Set([4000]));
    expect(process.listenerCount('exit')).toBe(exitBefore + 1);
    kids[0].emit('exit', 1);
    expect(iso._spawnedPids()).toEqual(new Set());
    clock.advance(5000);
    expect(process.listenerCount('exit')).toBe(exitBefore + 1);   // still one listener after a respawn
  });

  it('repeated onBeforeQuit is a no-op: one shutdown post, one kill timer (N5)', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    let child;
    iso.init({ flags: ISO_ON, supervisor: sup, logger: quiet(), deps: { spawn: () => (child = fakeChild(4100)), timers: clock.timers, now: clock.now, prewarmMs: 0 } });
    clock.advance(0);
    child.reply({ t: 'hello', v: 1, group: 'canonical', pid: 4100, ppid: 1, ops: ['canonical.buildAll'] });
    expect(iso.getHost('canonical').state).toBe('ready');
    iso.onBeforeQuit();
    iso.onBeforeQuit();
    sup.onBeforeQuit();                    // supervisor fan-out: still a no-op for the host
    expect(child.posted.filter((m) => m.t === 'shutdown')).toHaveLength(1);
    expect(clock.pending().filter((t) => t.ms === 1500)).toHaveLength(1);
    clock.advance(1500);
    expect(child.killed).toBe(1);
    expect(iso.getHost('canonical').state).toBe('stopped');
  });

  it('killAllSync covers hosts and leftover spawned pids, never throws', () => {
    const clock = fakeClock();
    initSup(sup, clock);
    const processKill = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    let child;
    iso.init({ flags: ISO_ON, supervisor: sup, logger: quiet(), deps: { spawn: () => (child = fakeChild(4200)), timers: clock.timers, now: clock.now, prewarmMs: 0, processKill } });
    clock.advance(0);
    child.kill = () => { child.killed++; return true; };   // exit never observed
    expect(() => iso.killAllSync()).not.toThrow();
    expect(child.killed).toBe(1);
    expect(processKill).toHaveBeenCalledWith(4200, 0);
  });
});

describe('app.js wiring', () => {
  it('app.js isolation init sits after supervisor init inside try/catch', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const supAt = src.indexOf("require('./workers/supervisor').init(");
    const line = src.split('\n').find((l) => l.includes("require('./workers/isolation').init("));
    expect(supAt).toBeGreaterThan(0);
    expect(line).toBeTruthy();
    expect(src.indexOf(line)).toBeGreaterThan(supAt);
    expect(line.trim()).toMatch(/^try \{ require\('\.\/workers\/isolation'\)\.init\(\{ notify: \(n\) => _ctx\.pushBubbleNotification\(n\) \}\); \} catch \(e\) \{ log\.warn\('\[workers:isolation\] init failed \(non-fatal, in-process\): ' \+ e\.message\); \}$/);
  });
});
