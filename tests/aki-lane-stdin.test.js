// tests/aki-lane-stdin.test.js
// Aki lane full-prompt delivery via stdin (FEAT-001). Injected fake spawner only:
// no real aki (or any other) process is ever started.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { EventEmitter } = require('events');
const { createAkiLane, buildStdinArgs, promptVia, AKI_TRUNC_MARKER } = require('../src/orcha/aki-lane');
const { flush } = require('./helpers/ai-gateway-fakes.cjs');

const BIN = 'C:\\Users\\u\\AppData\\Local\\Aki\\Aki.exe';
const HEAD = 'HEAD_SENTINEL';
const TAIL = 'TAIL_SENTINEL';
const UNI = '• Café — 9/13 ✓';

function bigPrompt(n) {
  const fillLen = n - HEAD.length - UNI.length - TAIL.length;
  return HEAD + 'f'.repeat(fillLen) + UNI + TAIL;
}

// Fake stdin: records end() calls; the end callback is held so tests decide when (if) it fires.
function makeStdin() {
  const s = new EventEmitter();
  s.chunks = [];
  s.endCalls = 0;
  s.endCb = null;
  s.write = vi.fn();
  s.end = vi.fn((chunk, enc, cb) => {
    s.endCalls++;
    if (chunk != null) s.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
    s.endCb = typeof cb === 'function' ? cb : null;
  });
  s.bytes = () => Buffer.concat(s.chunks);
  return s;
}

let _pid = 7000;
function makeProc(withStdin) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = withStdin ? makeStdin() : null;
  proc.pid = ++_pid;
  proc.kill = vi.fn();
  proc.ev = (o) => proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  proc.close = (code = 0) => proc.emit('close', code);
  proc.reply = (t) => { proc.ev({ type: 'text_delta', content: t }); proc.ev({ type: 'turn_complete' }); proc.close(0); };
  return proc;
}

function setup(over = {}) {
  const procs = [];
  const stdinPlan = over.stdinPlan || [];
  const spawn = vi.fn(() => {
    const has = stdinPlan.length > procs.length ? stdinPlan[procs.length] : true;
    const p = makeProc(has);
    procs.push(p);
    return p;
  });
  const killTree = vi.fn();
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const lane = createAkiLane({
    spawn, killTree, mkdirSync: vi.fn(), resolveBin: () => BIN, platform: 'win32',
    logger: { info: log, warn: log, error: log, debug: log },
    env: over.env || { PATH: 'C:\\Windows' }, ...over.deps,
  });
  return { lane, spawn, killTree, logs, procs };
}

afterEach(() => { vi.useRealTimers(); });

describe('aki-lane stdin delivery', () => {
  it('helpers: buildStdinArgs has no prompt element; promptVia defaults to stdin', () => {
    expect(buildStdinArgs({})).toEqual(['--cli', '--output-format', 'stream-json']);
    expect(buildStdinArgs({ profile: 'p', model: 'm' })).toEqual(['--cli', '--profile', 'p', '--model', 'm', '--output-format', 'stream-json']);
    expect(promptVia({})).toBe('stdin');
    expect(promptVia({ FLEET_AKI_PROMPT_VIA: 'argv' })).toBe('argv');
    expect(promptVia({ fleet_aki_prompt_via: 'ARGV' })).toBe('argv');
    expect(promptVia({ FLEET_AKI_PROMPT_VIA: 'stdin' })).toBe('stdin');
    expect(promptVia({ FLEET_AKI_PROMPT_VIA: 'bogus' })).toBe('stdin');
  });

  for (const n of [40000, 150000]) {
    it(`${n}-char prompt arrives byte-exact via stdin, ended once, never truncated`, async () => {
      const { lane, spawn, procs } = setup();
      const prompt = bigPrompt(n);
      expect(prompt).toHaveLength(n);
      const p = lane.ask(prompt, { requestId: 'big' });
      await flush();
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, args, opts] = spawn.mock.calls[0];
      expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      const stdin = procs[0].stdin;
      expect(stdin.endCalls).toBe(1);
      expect(stdin.write).not.toHaveBeenCalled();
      expect(stdin.bytes().equals(Buffer.from(prompt, 'utf8'))).toBe(true);
      expect(stdin.bytes().toString('utf8')).not.toContain(AKI_TRUNC_MARKER);
      for (const a of args) {
        expect(a).not.toContain(HEAD);
        expect(a).not.toContain(TAIL);
        expect(a).not.toContain(AKI_TRUNC_MARKER);
      }
      stdin.endCb && stdin.endCb();
      procs[0].ev({ type: 'text_delta', content: '  answer ' });
      procs[0].ev({ type: 'text_delta', content: 'text  ' });
      procs[0].ev({ type: 'turn_complete' });
      procs[0].close(0);
      await expect(p).resolves.toBe('answer text');
      expect(lane.stats()).toMatchObject({ tooLong: 0, ok: 1, lastVia: 'stdin', stdinFallbacks: 0, stdinFailed: 0 });
    });
  }

  it('empty / whitespace prompt -> AKI_EMPTY_PROMPT, never spawned', async () => {
    const { lane, spawn } = setup();
    await expect(lane.ask('')).rejects.toMatchObject({ code: 'AKI_EMPTY_PROMPT' });
    await expect(lane.ask('   ')).rejects.toMatchObject({ code: 'AKI_EMPTY_PROMPT' });
    await expect(lane.ask(null)).rejects.toMatchObject({ code: 'AKI_EMPTY_PROMPT' });
    expect(spawn).not.toHaveBeenCalled();
    expect(lane.stats()).toMatchObject({ failed: 3, lastErrorCode: 'AKI_EMPTY_PROMPT' });
  });

  it('no stdin + short prompt -> one argv fallback re-spawn, resolves', async () => {
    const { lane, spawn, procs, killTree, logs } = setup({ stdinPlan: [false, true] });
    const prompt = 'q'.repeat(200);
    const p = lane.ask(prompt, { requestId: 'fb1' });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(killTree).toHaveBeenCalledWith(procs[0]);
    const [, args2, opts2] = spawn.mock.calls[1];
    expect(args2[args2.length - 1]).toBe(prompt);
    expect(opts2.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(procs[1].stdin.endCalls).toBe(0);
    expect(lane.stats().active).toBe(1);
    procs[1].reply('ok');
    await expect(p).resolves.toBe('ok');
    expect(lane.stats()).toMatchObject({ calls: 1, ok: 1, failed: 0, active: 0, stdinFallbacks: 1, stdinFailed: 0, lastVia: 'argv-fallback' });
    expect(logs.some((l) => l.includes('fb1 stdin failed (NO_STDIN) -> argv fallback in=200ch'))).toBe(true);
    expect(logs.some((l) => /fb1 exit=0 .*via=argv-fallback in=200ch \[stdin-failed:NO_STDIN\]/.test(l))).toBe(true);
  });

  it('stdin EPIPE before end + over-limit prompt -> AKI_PROMPT_TOO_LONG, 1 spawn, queue continues', async () => {
    const { lane, spawn, procs, killTree } = setup();
    lane.configure({ concurrency: 1 });
    const p1 = lane.ask(bigPrompt(40000));
    const p2 = lane.ask('next job');
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    procs[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const e = await p1.catch((x) => x);
    expect(e.code).toBe('AKI_PROMPT_TOO_LONG');
    expect(e.message).toMatch(/stdin delivery failed \(EPIPE\); prompt 40000 chars exceeds the 32000-char command line/);
    expect(killTree).toHaveBeenCalledWith(procs[0]);
    expect(lane.stats()).toMatchObject({ stdinFailed: 1, stdinFallbacks: 0, tooLong: 1, failed: 1 });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(procs[1].stdin.bytes().toString('utf8')).toBe('next job');
    expect(lane.stats().active).toBe(1);
    procs[1].reply('ok2');
    await expect(p2).resolves.toBe('ok2');
    expect(lane.stats().active).toBe(0);
  });

  it('stdin error after the end callback or after settle is ignored, never throws', async () => {
    const { lane, procs } = setup();
    const p = lane.ask('hello');
    await flush();
    procs[0].stdin.endCb();
    expect(() => procs[0].stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    procs[0].reply('fine');
    await expect(p).resolves.toBe('fine');
    expect(() => procs[0].stdin.emit('error', Object.assign(new Error('late'), { code: 'EPIPE' }))).not.toThrow();
    expect(lane.stats()).toMatchObject({ stdinFailed: 0, stdinFallbacks: 0, ok: 1 });
  });

  it('timeout still kills and rejects AKI_TIMEOUT in stdin mode', async () => {
    vi.useFakeTimers();
    const { lane, procs, killTree } = setup();
    lane.configure({ timeoutMs: 10000 });
    const caught = lane.ask(bigPrompt(40000)).catch((e) => e);
    await flush();
    vi.advanceTimersByTime(10001);
    const e = await caught;
    expect(e.code).toBe('AKI_TIMEOUT');
    expect(killTree).toHaveBeenCalledWith(procs[0]);
    expect(lane.stats()).toMatchObject({ timeouts: 1, active: 0 });
  });

  it('log lines carry via and input length, never prompt content', async () => {
    const { lane, procs, logs } = setup();
    const p = lane.ask(bigPrompt(40000), { requestId: 'lg' });
    await flush();
    procs[0].reply('done ' + 'x');
    await p;
    const line = logs.find((l) => l.startsWith('[aki] lg '));
    expect(line).toContain('via=stdin');
    expect(line).toContain('in=40000ch');
    for (const l of logs) { expect(l).not.toContain(HEAD); expect(l).not.toContain(TAIL); }
  });
});
