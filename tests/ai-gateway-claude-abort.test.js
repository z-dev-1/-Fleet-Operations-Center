// tests/ai-gateway-claude-abort.test.js — task item 4: the Claude Code pool
// (_tryClaudeCode) kills / dequeues the pooled job on abort so the single worker
// is freed; stale-process guards; local-mode signal + priority forwarding;
// priority ordering of the pool queue. Fake child processes only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-claude-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, makeFakeProc, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let procs, kill;
function setup() {
  baseRelaySetup(relay);
  procs = [];
  kill = vi.fn();
  T.setClaudeBinExists(() => true);
  T.setSpawn(() => { const p = makeFakeProc(vi); procs.push(p); return p; });
  T.setKillTree(kill);
}
const cc = (prompt, o) => { const p = T.tryClaudeCode(prompt, o); p.catch(() => {}); return p; };
const dispatched = () => procs.map((p) => p.written()[0]);

beforeEach(() => { setup(); });
afterEach(() => {
  vi.useRealTimers();
  relay.setClaudeTimeout(60000);
  T.setGatewayFlags(null);
  T.reset();
  fleetBrain.__test__.reset();
  fleetBrain.setLocalAskFn((p, o) => T.localAskFn(p, o));
  vi.restoreAllMocks();
});

describe('_tryClaudeCode abort (verified behavior)', () => {
  it('abort of the ACTIVE job kills its process, rejects, and dispatches the queued job', async () => {
    T.setGatewayFlags({});
    const ac = new AbortController();
    const a = cc('A', { signal: ac.signal });
    const b = cc('B');
    expect(dispatched()).toEqual(['A']);
    ac.abort();
    await expect(a).rejects.toThrow('Aborted by caller');
    expect(kill).toHaveBeenCalledWith(procs[0]);
    expect(dispatched()).toEqual(['A', 'B']);
    procs[1].result('B-text');
    expect(await b).toBe('B-text');
  });
  it('abort of a QUEUED job splices it out; nothing is killed', async () => {
    T.setGatewayFlags({});
    const a = cc('A');
    const ac = new AbortController();
    const b = cc('B', { signal: ac.signal });
    ac.abort();
    await expect(b).rejects.toThrow('Aborted by caller');
    expect(kill).not.toHaveBeenCalled();
    expect(T.claudePoolState().queue.length).toBe(0);
    procs[0].result('A-text');
    expect(await a).toBe('A-text');
  });
  it('a late exit from the killed process does not fail the next job', async () => {
    T.setGatewayFlags({});
    const ac = new AbortController();
    cc('A', { signal: ac.signal });
    const b = cc('B');
    ac.abort();
    procs[0].emit('exit', 1);
    procs[1].result('B-ok');
    expect(await b).toBe('B-ok');
  });
});

describe('stale-process stdout guard', () => {
  async function staleScenario(chunk) {
    const ac = new AbortController();
    const a = cc('A', { signal: ac.signal });
    const b = cc('B');
    let bResolved = null;
    b.then((v) => { bResolved = v; });
    ac.abort();
    await expect(a).rejects.toThrow('Aborted by caller');
    procs[0].stdout.emit('data', Buffer.from(chunk));
    await flush();
    return { b, get bResolved() { return bResolved; } };
  }
  it('flag on: old proc result / partial chunk never reaches job B', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const s = await staleScenario('{"type":"result","result":"A-text"}\n');
    expect(s.bResolved).toBeNull();
    expect(kill).not.toHaveBeenCalledWith(procs[1]);
    procs[1].result('B-text');
    expect(await s.b).toBe('B-text');
  });
  it('flag on: a partial chunk does not corrupt B\'s buffer', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const s = await staleScenario('{"type":"res');
    expect(T.claudePoolState().workers[0].stdoutBuf).toBe('');
    procs[1].result('B-text');
    expect(await s.b).toBe('B-text');
  });
  it('flag on: stderr from the old proc is ignored', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    await staleScenario('');
    expect(() => procs[0].stderr.emit('data', Buffer.from('noise'))).not.toThrow();
  });
  it('flag off (parity, documents the pre-existing race): B resolves with A\'s text', async () => {
    T.setGatewayFlags({});
    const s = await staleScenario('{"type":"result","result":"A-text"}\n');
    expect(s.bResolved).toBe('A-text');
  });
  it('in-loop guard: extra lines after a result in the same chunk never resolve the next job (flag on)', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const a = cc('A');
    const b = cc('B');
    let bv = null; b.then((v) => { bv = v; });
    procs[0].stdout.emit('data', Buffer.from('{"type":"result","result":"A"}\n{"type":"result","result":"X"}\n'));
    expect(await a).toBe('A');
    await flush();
    expect(bv).toBeNull();
    procs[1].result('B');
    expect(await b).toBe('B');
  });
  it('in-loop, flag off (documents today): B resolves with X', async () => {
    T.setGatewayFlags({});
    const a = cc('A');
    const b = cc('B');
    procs[0].stdout.emit('data', Buffer.from('{"type":"result","result":"A"}\n{"type":"result","result":"X"}\n'));
    expect(await a).toBe('A');
    expect(await b).toBe('X');
  });
});

describe('local-mode signal / priority forwarding', () => {
  it('relay local fn: flag on, abort kills the job; flag off, no signal reaches the pool', async () => {
    T.setGatewayFlags({ abortOnTimeout: true });
    const ac = new AbortController();
    const p = T.localAskFn('L', { signal: ac.signal });
    p.catch(() => {});
    ac.abort();
    await expect(p).rejects.toThrow('Aborted by caller');
    expect(kill).toHaveBeenCalledTimes(1);
    T.reset(); setup();
    T.setGatewayFlags({});
    const ac2 = new AbortController();
    const p2 = T.localAskFn('L2', { signal: ac2.signal, priority: 'high' });
    ac2.abort();
    expect(kill).not.toHaveBeenCalled();
    expect(T.claudePoolState().workers[0].currentPrompt).toBe('L2');
    procs[0].result('done');
    expect(await p2).toBe('done');
  });
  it('fleet-brain _localAsk forwards { signal, priority }; with neither, a single argument (today)', async () => {
    const spy = vi.fn(() => Promise.resolve('r'));
    fleetBrain.setLocalAskFn(spy);
    const ac = new AbortController();
    await fleetBrain.__test__.localAsk('p', ac.signal, 'low');
    expect(spy.mock.calls[0][1]).toEqual({ signal: ac.signal, priority: 'low' });
    await fleetBrain.__test__.localAsk('p');
    expect(spy.mock.calls[1].length).toBe(1);
  });
  it('fleet-brain ask local branch passes the signal and priority', async () => {
    let got = null;
    fleetBrain.setLocalAskFn((p, o) => { got = o; return new Promise(() => {}); });
    fleetBrain.__test__.setWsGaveUp(true);
    const ac = new AbortController();
    const p = fleetBrain.ask('x', { signal: ac.signal, priority: 'high' });
    await flush();
    ac.abort();
    await expect(p).rejects.toThrow('Aborted by caller');
    expect(got.signal.aborted).toBe(true);
    expect(got.priority).toBe('high');
  });
  it('_handoffLocal forwards the request signal and priority after HANDOFF_MS', async () => {
    vi.useFakeTimers();
    const WebSocket = require('ws');
    fleetBrain.__test__.setSocket({ readyState: WebSocket.CONNECTING, send: vi.fn(), terminate: vi.fn() });
    let got = null;
    const spy = vi.fn((p, o) => { got = o; return new Promise(() => {}); });
    fleetBrain.setLocalAskFn(spy);
    const ac = new AbortController();
    const p = fleetBrain.ask('x', { signal: ac.signal, priority: 'low' });
    p.catch(() => {});
    vi.advanceTimersByTime(20001);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(got.signal).toBe(ac.signal);
    expect(got.priority).toBe('low');
    ac.abort();
    expect(got.signal.aborted).toBe(true);
  });
});

describe('Claude pool priority ordering (ai.gateway.priorities)', () => {
  it('rank order across, FIFO within a rank', async () => {
    T.setGatewayFlags({ priorities: true });
    const a = cc('A');
    cc('L1', { prio: 'low' }); cc('L2', { prio: 'low' }); cc('H', { prio: 'high' }); cc('N', { prio: 'normal' });
    expect(T.claudePoolState().stats.queuedByPriority).toMatchObject({ high: 1, normal: 1, low: 2 });
    for (let i = 0; i < 5; i++) { procs[i].result('r' + i); await flush(); }
    await a;
    expect(dispatched()).toEqual(['A', 'H', 'N', 'L1', 'L2']);
  });
  it('flag off: FIFO, prio ignored (parity)', async () => {
    T.setGatewayFlags({});
    cc('A'); cc('L1', { prio: 'low' }); cc('L2', { prio: 'low' }); cc('H', { prio: 'high' });
    for (let i = 0; i < 4; i++) { procs[i].result('r' + i); await flush(); }
    expect(dispatched()).toEqual(['A', 'L1', 'L2', 'H']);
  });
  it('aging bound: a job waiting >= 60 s is never jumped (L1 t0, N t10s, H t65s -> N, L1, H)', async () => {
    vi.useFakeTimers();
    relay.setClaudeTimeout(300000); // keep the active job from hitting its 60 s timeout
    T.setGatewayFlags({ priorities: true });
    cc('A');
    cc('L1', { prio: 'low' });
    vi.advanceTimersByTime(10000);
    cc('N', { prio: 'normal' });
    vi.advanceTimersByTime(55000);
    cc('H', { prio: 'high' });
    expect(T.claudePoolState().queue.map((j) => j.prompt)).toEqual(['N', 'L1', 'H']);
    relay.setClaudeTimeout(60000);
  });
  it('randomized: no job that has waited >= 60 s ever gets a job inserted ahead of it', async () => {
    vi.useFakeTimers();
    T.setGatewayFlags({ priorities: true });
    cc('ACTIVE'); // holds the single worker for the whole run
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const prios = ['critical', 'high', 'normal', 'low', undefined];
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(Math.floor(rnd() * 8000));
      const before = T.claudePoolState().queue;
      const now = Date.now();
      cc('j' + i, { prio: prios[Math.floor(rnd() * prios.length)] });
      const after = T.claudePoolState().queue;
      const at = after.findIndex((j) => j.prompt === 'j' + i);
      before.forEach((j, idx) => { if (now - j.enqAt >= 60000) expect(idx).toBeLessThan(at); });
    }
  });
  it('relay wiring: the cascade passes prio only with priorities on', async () => {
    const fbAsk = vi.spyOn(fleetBrain, 'getStatus').mockReturnValue({ ready: false, connected: false, localMode: false });
    void fbAsk;
    T.setGatewayFlags({ priorities: true });
    const p = relay.ask('x', { source: 'slack_dm_legacy' });
    p.catch(() => {});
    await flush();
    expect(T.claudePoolState().workers[0].currentPrompt).toBe('x');
    // Active job's rank is not in the queue; enqueue a probe to inspect ranks.
    const p2 = relay.ask('y', { source: 'slack_dm_legacy' }); p2.catch(() => {});
    await flush();
    expect(T.claudePoolState().queue[0].rank).toBe(1);
    procs[0].result('ok-x'); await flush();
    procs[1].result('ok-y'); await flush();
    expect(await p).toBe('ok-x');
    expect(await p2).toBe('ok-y');
    T.setGatewayFlags({});
    cc('busy');
    const p3 = relay.ask('z', { source: 'slack_dm_legacy' }); p3.catch(() => {});
    await flush();
    expect(T.claudePoolState().queue[0].rank).toBeNull();
    procs[2].result('b'); await flush();
    procs[3].result('ok-z'); await flush();
    expect(await p3).toBe('ok-z');
  });
});
