// tests/workers-isolation-runtime.test.js — worker-runtime over a raw child_process.fork,
// the inert-under-require entry (review M1), worker-side watchdogs (M2) and N5 behaviors.
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { fork, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'workers-isolation-fixtures');
const SPIN = path.join(FIX, 'spin-worker.cjs');
const ENTRY = path.join(ROOT, 'src', 'workers', 'isolation', 'entries', 'canonical-worker.js');
const runtime = require('../src/workers/isolation/worker-runtime');
const canonical = require('../src/orcha/canonical_state');

const INIT = (group) => ({ t: 'init', v: 1, group, parentPid: process.pid, pingTimeoutMs: 30000, ppidPollMs: 2000, maxLogPerMin: 50, workerSilenceExitMs: 45000, diag: false });

function forkWorker(file, env) {
  const c = fork(file, [], { execPath: process.execPath, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    env: Object.assign({}, process.env, env || {}) });
  const msgs = [];
  let waiters = [];
  c.on('message', (m) => {
    msgs.push(m);
    const keep = [];
    for (const w of waiters) { if (w.pred(m)) w.resolve(m); else keep.push(w); }
    waiters = keep;
  });
  const exited = new Promise((resolve) => c.on('exit', (code) => resolve(code)));
  const next = (pred, ms = 20000) => {
    const hit = msgs.find(pred);
    if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); msgs.splice(msgs.indexOf(m), 1); resolve(m); } });
    });
  };
  const kill = () => { try { c.kill(); } catch (_) { /* ignore */ } };
  return { c, msgs, next, exited, kill };
}

async function ready(file, group) {
  const w = forkWorker(file);
  w.c.send(INIT(group));
  const hello = await w.next((m) => m.t === 'hello');
  return Object.assign(w, { hello });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 200)); }
  return !alive(pid);
}
function runOrphanParent(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(FIX, 'orphan-parent.cjs')].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => {
      const m = out.match(/PID (\d+)/);
      if (m) resolve(Number(m[1])); else reject(new Error('no pid from orphan-parent: ' + out));
    });
  });
}

describe('canonical-worker entry is inert under require (M1)', () => {
  it('requiring the entry sends nothing, adds no listeners and arms no timers', () => {
    const events = ['uncaughtException', 'unhandledRejection', 'message', 'exit', 'disconnect'];
    for (const file of [ENTRY, SPIN, path.join(FIX, 'mute-worker.cjs')]) {
      delete require.cache[file];
      const before = events.map((e) => process.listenerCount(e));
      const sendSpy = typeof process.send === 'function' ? vi.spyOn(process, 'send') : null;
      const toSpy = vi.spyOn(globalThis, 'setTimeout');
      const ivSpy = vi.spyOn(globalThis, 'setInterval');
      try {
        const mod = require(file);
        expect(mod).toBeTruthy();
        if (sendSpy) expect(sendSpy).not.toHaveBeenCalled();
        expect(toSpy).not.toHaveBeenCalled();
        expect(ivSpy).not.toHaveBeenCalled();
        expect(events.map((e) => process.listenerCount(e))).toEqual(before);
      } finally {
        if (sendSpy) sendSpy.mockRestore();
        toSpy.mockRestore();
        ivSpy.mockRestore();
      }
    }
  });

  it('OPS canonical.buildAll equals in-process buildAll', () => {
    const { OPS } = require(ENTRY);
    const rows = [
      { equipmentId: 'U1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: '2026-10-29T09:00:00Z' },
      { equipmentId: 'U2', lifecycleState: 'Available' },
    ];
    const prior = { U1: { equipmentId: 'U1', status: 'in_repair', updatedAt: '2026-10-29T08:00:00Z' } };
    vi.useFakeTimers({ now: new Date('2026-10-29T14:00:00Z'), toFake: ['Date'] });
    try {
      const got = OPS['canonical.buildAll'](structuredClone({ rows, prior }));
      const want = canonical.buildAll(rows, { decisions: {}, prior });
      expect(got).toEqual({ units: want.units, counts: want.counts });
      expect(Object.keys(got)).toEqual(['units', 'counts']);
    } finally { vi.useRealTimers(); }
  });
});

// Real child processes: allow for slow process start-up under a fully parallel suite.
describe('worker runtime over child_process.fork', { timeout: 30000 }, () => {
  it('valid init → hello', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      expect(w.hello).toMatchObject({ t: 'hello', v: 1, group: 'spin', pid: w.c.pid });
      expect(w.hello.ops).toEqual(expect.arrayContaining(['spin', 'echo']));
      expect(w.hello.diag).toBeUndefined();
    } finally { w.kill(); }
  });

  it('ping → pong same seq', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'ping', seq: 7 });
      const pong = await w.next((m) => m.t === 'pong');
      expect(pong.seq).toBe(7);
      expect(pong.rss).toBeGreaterThan(0);
      expect(pong.heapUsed).toBeGreaterThan(0);
    } finally { w.kill(); }
  });

  it('two reqs run serially', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'req', id: 1, op: 'order', payload: { tag: 'a', ms: 300 } });
      w.c.send({ t: 'req', id: 2, op: 'order', payload: { tag: 'b', ms: 0 } });
      const r1 = await w.next((m) => m.t === 'res');
      const r2 = await w.next((m) => m.t === 'res');
      expect([r1.id, r2.id]).toEqual([1, 2]);
      expect(r1.result.tag).toBe('a');
      expect(r2.result.at).toBeGreaterThanOrEqual(r1.result.at);
    } finally { w.kill(); }
  });

  it('unknown op → UNKNOWN_OP', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'req', id: 1, op: 'nope', payload: null });
      const r = await w.next((m) => m.t === 'res');
      expect(r).toMatchObject({ id: 1, ok: false, error: { code: 'UNKNOWN_OP' } });
    } finally { w.kill(); }
  });

  it('throwing op → OP_FAILED', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'req', id: 1, op: 'spin', payload: { ms: 'x' } });
      const r = await w.next((m) => m.t === 'res');
      expect(r).toMatchObject({ id: 1, ok: false, error: { code: 'OP_FAILED', message: 'bad spin payload' } });
    } finally { w.kill(); }
  });

  it('progress is sent between slices', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'req', id: 1, op: 'spin', payload: { ms: 5, n: 3 } });
      const r = await w.next((m) => m.t === 'res');
      expect(r.ok).toBe(true);
      expect(w.msgs.filter((m) => m.t === 'progress' && m.id === 1).map((m) => Math.round(m.pct))).toEqual([33, 67, 100]);
    } finally { w.kill(); }
  });

  it('invalid init exits 65', async () => {
    const w = forkWorker(SPIN);
    w.c.send(Object.assign(INIT('spin'), { v: 2 }));
    expect(await w.exited).toBe(65);
    const w2 = forkWorker(SPIN);
    w2.c.send({ t: 'ping', seq: 1 });
    expect(await w2.exited).toBe(65);
  });

  it('no init exits 4 within 16 s (M2)', async () => {
    expect(runtime.PRE_INIT_MS).toBe(15000);
    const w = forkWorker(SPIN, { SPIN_ANNOUNCE: '1' });
    await w.next((m) => m.t === 'booted', 20000);   // measured from the armed watchdog, not process boot
    const t0 = Date.now();
    const code = await w.exited;
    expect(code).toBe(4);
    expect(Date.now() - t0).toBeLessThan(16000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(14000);
  }, 40000);

  it('invalid host message after init is ignored, one rate-limited log warn (N5)', async () => {
    const w = await ready(SPIN, 'spin');
    try {
      w.c.send({ t: 'bogus' });
      w.c.send({ t: 'req', id: 0, op: 'echo' });
      w.c.send([1, 2, 3]);
      w.c.send({ t: 'ping', seq: 3 });
      const pong = await w.next((m) => m.t === 'pong');
      expect(pong.seq).toBe(3);
      const warns = w.msgs.filter((m) => m.t === 'log' && m.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toMatch(/ignored invalid host message/);
    } finally { w.kill(); }
  });

  it('_parentAlive treats EPERM as alive and ESRCH as gone (N5)', () => {
    const thrower = (code) => () => { throw Object.assign(new Error(code), { code }); };
    expect(runtime._parentAlive(123, thrower('EPERM'))).toBe(true);
    expect(runtime._parentAlive(123, thrower('ESRCH'))).toBe(false);
    expect(runtime._parentAlive(123, thrower('EINVAL'))).toBe(true);
    expect(runtime._parentAlive(123, () => true)).toBe(true);
    expect(runtime._parentAlive(process.pid)).toBe(true);
  });

  it('shutdown exits 0', async () => {
    const w = await ready(SPIN, 'spin');
    w.c.send({ t: 'shutdown' });
    expect(await w.exited).toBe(0);
  });

  it('orphan: parent exits after hello → worker gone within 10 s (M2)', async () => {
    const pid = await runOrphanParent([]);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await goneWithin(pid, 10000)).toBe(true);
  }, 30000);

  it('orphan --no-init: worker gone within 20 s (M2)', async () => {
    const pid = await runOrphanParent(['--no-init']);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await goneWithin(pid, 20000)).toBe(true);
  }, 40000);
});
