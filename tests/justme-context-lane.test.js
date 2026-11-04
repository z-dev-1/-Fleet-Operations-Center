// T-LANE-TOOLS + relay half of T-LANE: the isolated, tool-less Claude lane used
// for Just Me context turns (relay.ask(prompt, { isolated: true })).
// Fake child processes only; the real-CLI proof is tests/smoke/claude-lane-probe.cjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-lane-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, makeFakeProc, baseRelaySetup, installFakeFleetBrain } = require('./helpers/ai-gateway-fakes.cjs');
const golden = require('./fixtures/justme-context/claude-pool-args.golden.json');

const T = relay.__test__;
const SENTINEL = 'SENTINEL-CONTENT-7f3a';
let procs, spawns, kill;

function setup() {
  baseRelaySetup(relay);
  procs = [];
  spawns = [];
  kill = vi.fn();
  T.setClaudeBinExists(() => true);
  T.setSpawn((bin, args, options) => {
    const p = makeFakeProc(vi);
    procs.push(p);
    spawns.push({ bin, args: JSON.parse(JSON.stringify(args)), options: JSON.parse(JSON.stringify(options)) });
    return p;
  });
  T.setKillTree(kill);
}
const iso = (prompt, o) => { const p = relay.ask(prompt, Object.assign({ isolated: true }, o)); p.catch(() => {}); return p; };
const errResult = (proc, text) => proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: true, result: text }) + '\n'));

beforeEach(() => { setup(); });
afterEach(() => {
  vi.useRealTimers();
  relay.setClaudeTimeout(60000);
  relay.setClaudeModel('');
  T.setGatewayFlags(null);
  T.reset();
  fleetBrain.__test__.reset();
  fleetBrain.setLocalAskFn((p, o) => T.localAskFn(p, o));
  vi.restoreAllMocks();
});

describe('T-LANE-TOOLS: isolated spawn args', () => {
  it('spawns with exactly ISOLATED_CLAUDE_ARGS and the fixed empty cwd', async () => {
    T.setGatewayFlags({});
    const p = iso('hello');
    await flush();
    expect(spawns).toHaveLength(1);
    const { args, options } = spawns[0];
    expect(args).toEqual(T.isolatedArgs(''));
    for (const f of ['--bare', '--strict-mcp-config', '--tools', '--disallowedTools', '--no-session-persistence']) expect(args).toContain(f);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    const dis = args[args.indexOf('--disallowedTools') + 1].split(',');
    for (const t of ['Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep', 'Task']) expect(dis).toContain(t);
    expect(options.cwd).toBe(path.join(os.tmpdir(), 'fleet-isolated-lane'));
    expect(options.cwd).toBe(T.isolatedCwd());
    expect(fs.existsSync(options.cwd)).toBe(true);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    procs[0].result('done');
    expect(await p).toBe('done');
  });

  it('adds --model before --system-prompt when a model is pinned', async () => {
    T.setGatewayFlags({});
    relay.setClaudeModel('m1');
    const p = iso('hello');
    await flush();
    const { args } = spawns[0];
    expect(args).toEqual(T.isolatedArgs('m1'));
    expect(args[args.indexOf('--model') + 1]).toBe('m1');
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('--system-prompt'));
    procs[0].result('ok');
    await p;
  });

  it('uses the same system prompt text as the unmodified pool (golden)', () => {
    const a = T.isolatedArgs('');
    expect(a[a.indexOf('--system-prompt') + 1]).toBe(golden.noModel.args[golden.noModel.args.indexOf('--system-prompt') + 1]);
  });
});

describe('flag-off parity: non-isolated spawns equal the pre-change golden', () => {
  it('no model: args and options deep-equal the golden', async () => {
    const p = T.tryClaudeCode('x'); p.catch(() => {});
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).toEqual(golden.noModel.args);
    expect(spawns[0].options).toEqual(golden.noModel.options);
    expect(/claude(\.exe)?$/i.test(String(spawns[0].bin))).toBe(golden.noModel.binIsClaude);
    procs[0].result('t'); await p;
  });
  it('model m1: args and options deep-equal the golden', async () => {
    relay.setClaudeModel('m1');
    const p = T.tryClaudeCode('x'); p.catch(() => {});
    expect(spawns[0].args).toEqual(golden.model_m1.args);
    expect(spawns[0].options).toEqual(golden.model_m1.options);
    procs[0].result('t'); await p;
  });
  it('an ask without isolated still goes through the cascade (spawn args unchanged)', async () => {
    T.setGatewayFlags({});
    fleetBrain.getStatus && vi.spyOn(fleetBrain, 'getStatus').mockReturnValue({ ready: false, connected: false });
    const p = relay.ask('plain'); p.catch(() => {});
    await flush(200);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).toEqual(golden.noModel.args);
    expect(spawns[0].options).toEqual(golden.noModel.options);
    procs[0].result('t'); await p;
  });
});

describe('T-LANE: isolated asks never touch fleet-brain or WS', () => {
  for (const pref of ['auto', 'orcha', 'balanced']) {
    it('preference ' + pref + ': 0 fleetBrain.ask, 0 _tryWS, isolated spawn used', async () => {
      T.setGatewayFlags({});
      relay.setPreference(pref);
      const fbCalls = installFakeFleetBrain(vi, fleetBrain);
      const ws = vi.fn(() => Promise.resolve('ws-text'));
      T.setTryWS(ws);
      const p = iso('P-' + pref);
      await flush();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].args).toEqual(T.isolatedArgs(''));
      procs[0].result('isolated-answer');
      expect(await p).toBe('isolated-answer');
      expect(fbCalls).toHaveLength(0);
      expect(fleetBrain.ask).not.toHaveBeenCalled();
      expect(ws).not.toHaveBeenCalled();
    });
  }

  it('an isolated failure does not fall back to fleet-brain, WS, or another spawn', async () => {
    T.setGatewayFlags({});
    installFakeFleetBrain(vi, fleetBrain);
    const ws = vi.fn(() => Promise.resolve('ws-text'));
    T.setTryWS(ws);
    const p = iso('P');
    await flush();
    errResult(procs[0], 'boom');
    await expect(p).rejects.toThrow('claude-code error (isolated)');
    await flush();
    expect(fleetBrain.ask).not.toHaveBeenCalled();
    expect(ws).not.toHaveBeenCalled();
    expect(spawns).toHaveLength(1);
  });

  it('skips dedupe: two isolated asks with the same dedupeKey are separate jobs', async () => {
    T.setGatewayFlags({ dedupe: true });
    const a = iso('same', { dedupeKey: 'k1' });
    const b = iso('same', { dedupeKey: 'k1' });
    await flush();
    expect(T.inflight().size).toBe(0);
    procs[0].result('A');
    await flush();
    expect(spawns).toHaveLength(2);
    procs[1].result('B');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });
});

describe('isolated errors and logs never carry content', () => {
  function captureOutput() {
    const lines = [];
    const sink = (chunk) => { lines.push(String(chunk)); return true; };
    vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    return lines;
  }

  it('is_error result text is not in the rejection message or any log line', async () => {
    T.setGatewayFlags({});
    const lines = captureOutput();
    const p = iso('prompt with ' + SENTINEL);
    await flush();
    errResult(procs[0], 'cannot do ' + SENTINEL);
    let msg = '';
    try { await p; } catch (e) { msg = e.message; }
    expect(msg).toBe('claude-code error (isolated)');
    expect(msg).not.toContain(SENTINEL);
    expect(lines.join('')).not.toContain(SENTINEL);
  });

  it('stderr containing the sentinel logs only the length', async () => {
    T.setGatewayFlags({});
    const lines = captureOutput();
    const p = iso('q');
    await flush();
    const text = 'oops ' + SENTINEL;
    procs[0].stderr.emit('data', Buffer.from(text));
    procs[0].result('fine');
    await p;
    const all = lines.join('');
    expect(all).not.toContain(SENTINEL);
    expect(all).toContain('stderr: (' + text.length + ' chars)');
  });

  it('non-isolated errors keep today\'s message form', async () => {
    const p = T.tryClaudeCode('x'); p.catch(() => {});
    errResult(procs[0], 'plain failure');
    await expect(p).rejects.toThrow('claude-code error: plain failure');
  });
});

describe('availability and lifecycle', () => {
  it('bin missing: isolatedLaneAvailable() is false and the ask rejects as not installed', async () => {
    T.setClaudeBinExists(() => false);
    expect(relay.isolatedLaneAvailable()).toBe(false);
    await expect(relay.ask('x', { isolated: true })).rejects.toThrow(/not installed/);
    expect(spawns).toHaveLength(0);
  });
  it('bin present: isolatedLaneAvailable() is true', () => {
    expect(relay.isolatedLaneAvailable()).toBe(true);
  });

  it('an isolated job after a non-isolated one respawns with isolated args', async () => {
    const a = T.tryClaudeCode('normal'); a.catch(() => {});
    expect(spawns[0].args).toEqual(golden.noModel.args);
    procs[0].result('n');
    await a;
    const b = iso('secret-ish');
    await flush();
    expect(spawns).toHaveLength(2);
    expect(spawns[1].args).toEqual(T.isolatedArgs(''));
    expect(spawns[1].options.cwd).toBe(T.isolatedCwd());
    procs[1].result('i');
    await b;
  });

  it('a non-isolated job after an isolated one spawns the normal args again', async () => {
    const a = iso('first');
    await flush();
    procs[0].result('i');
    await a;
    const b = T.tryClaudeCode('normal'); b.catch(() => {});
    expect(spawns).toHaveLength(2);
    expect(spawns[1].args).toEqual(golden.noModel.args);
    expect(spawns[1].options).toEqual(golden.noModel.options);
    procs[1].result('n');
    await b;
  });

  it('abort kills the isolated process and rejects', async () => {
    T.setGatewayFlags({});
    const ac = new AbortController();
    const p = iso('long', { signal: ac.signal });
    await flush();
    expect(spawns).toHaveLength(1);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(kill).toHaveBeenCalledWith(procs[0]);
  });
});
