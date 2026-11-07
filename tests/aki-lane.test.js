// tests/aki-lane.test.js
// Aki CLI lane (src/orcha/aki-lane.js). Every test uses an injected fake spawner:
// no real aki (or any other) process is ever started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { EventEmitter } = require('events');
const {
  createAkiLane, parseStreamJson, buildArgs, winQuotedLength, cmdLineLength, fitPrompt,
  akiChildEnv, resolveAkiBin, AKI_CMDLINE_MAX, AKI_SANDBOX_DIRNAME, AKI_TRUNC_MARKER,
} = require('../src/orcha/aki-lane');
const { flush } = require('./helpers/ai-gateway-fakes.cjs');

const BIN = 'C:\\Users\\u\\AppData\\Local\\Aki\\Aki.exe';
const SENTINEL = 'SENTINEL_7f3a_DO_NOT_LOG';

let _pid = 5000;
function makeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = ++_pid;
  proc.kill = vi.fn();
  proc.ev = (o) => proc.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  proc.raw = (s) => proc.stdout.emit('data', Buffer.from(s));
  proc.err = (s) => proc.stderr.emit('data', Buffer.from(s));
  proc.close = (code = 0) => proc.emit('close', code);
  return proc;
}

function setup(over = {}) {
  const procs = [];
  const spawn = vi.fn(() => { const p = makeProc(); procs.push(p); return p; });
  const killTree = vi.fn();
  const mkdirSync = vi.fn();
  const logs = [];
  const logger = {
    info: vi.fn((...a) => logs.push(a.join(' '))), warn: vi.fn((...a) => logs.push(a.join(' '))),
    error: vi.fn((...a) => logs.push(a.join(' '))), debug: vi.fn((...a) => logs.push(a.join(' '))),
  };
  const resolveBin = over.resolveBin || vi.fn(() => BIN);
  const lane = createAkiLane({
    spawn, killTree, mkdirSync, logger, resolveBin, platform: 'win32',
    env: over.env || { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' }, ...over.deps,
  });
  return { lane, spawn, killTree, mkdirSync, logs, procs, resolveBin };
}

describe('aki-lane pure helpers', () => {
  it('parseStreamJson: text_delta concatenated in order, thinking ignored, tools counted, bad lines ignored', () => {
    const lines = [
      { type: 'thinking_delta', content: 'hmm' },
      { type: 'text_delta', content: 'Hel' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'tool_result', content: 'x' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'bad name; rm' },
      { type: 'text_delta', content: 'lo' },
      { type: 'text_delta', content: 42 },
      { type: 'turn_complete' },
    ].map((o) => JSON.stringify(o));
    const r = parseStreamJson(lines.join('\n') + '\n{not json\n');
    expect(r.text).toBe('Hello');
    expect(r.toolCount).toBe(4);
    expect(r.tools).toEqual({ Bash: 2, Read: 1, other: 1 });
    expect(r.badLines).toBe(1);
    expect(r.done).toBe(true);
  });

  it('buildArgs: exact shape, no --thread, leading "-" gets a space', () => {
    expect(buildArgs('hi', {})).toEqual(['--cli', '--output-format', 'stream-json', 'hi']);
    expect(buildArgs('hi', { profile: 'fleet', model: 'm1' }))
      .toEqual(['--cli', '--profile', 'fleet', '--model', 'm1', '--output-format', 'stream-json', 'hi']);
    expect(buildArgs('--help me')).toEqual(['--cli', '--output-format', 'stream-json', ' --help me']);
    expect(buildArgs('x').includes('--thread')).toBe(false);
  });

  it('winQuotedLength matches libuv quote_cmd_arg', () => {
    expect(winQuotedLength('')).toBe(2);
    expect(winQuotedLength('abc')).toBe(3);
    expect(winQuotedLength('C:\\dir\\x')).toBe(8); // no space/quote: verbatim
    expect(winQuotedLength('a b')).toBe(5); // "a b"
    expect(winQuotedLength('a\\b c')).toBe(7); // "a\b c" (inner backslash not doubled)
    expect(winQuotedLength('a"b')).toBe(6); // "a\"b"
    expect(winQuotedLength('a b\\')).toBe(7); // "a b\\" (trailing backslash doubled)
    expect(winQuotedLength('a b\\\\')).toBe(9); // "a b\\\\"
    expect(winQuotedLength('x\\"y')).toBe(8); // "x\\\"y"
    expect(cmdLineLength('a', ['b c', ''])).toBe(1 + 5 + 2 + 2);
  });

  it('fitPrompt: reject throws AKI_PROMPT_TOO_LONG; truncate fits with marker and keeps surrogate pairs', () => {
    const argsFor = (p) => buildArgs(p, {});
    const long = 'x '.repeat(20000);
    expect(() => fitPrompt(BIN, argsFor, long, 'reject', { max: 32000 })).toThrow(expect.objectContaining({ code: 'AKI_PROMPT_TOO_LONG' }));
    const t = fitPrompt(BIN, argsFor, long, 'truncate', { max: 32000 });
    expect(t.truncated).toBe(true);
    expect(t.prompt.endsWith(AKI_TRUNC_MARKER)).toBe(true);
    expect(cmdLineLength(BIN, t.args)).toBeLessThanOrEqual(32000);
    expect(cmdLineLength(BIN, t.args)).toBeGreaterThan(31900);
    const emoji = '😀'.repeat(20000);
    const e = fitPrompt(BIN, argsFor, emoji, 'truncate', { max: 32000 });
    const body = e.prompt.slice(0, -AKI_TRUNC_MARKER.length);
    const last = body.charCodeAt(body.length - 1);
    expect(last >= 0xD800 && last <= 0xDBFF).toBe(false);
    expect(body.length % 2).toBe(0);
    const short = fitPrompt(BIN, argsFor, 'hi', 'reject');
    expect(short).toMatchObject({ prompt: 'hi', truncated: false });
    expect(AKI_CMDLINE_MAX).toBe(process.platform === 'win32' ? 32000 : 120000);
  });

  it('akiChildEnv drops Fleet/Electron/Slack/secret keys, keeps AWS and system keys, never adds', () => {
    const env = {
      FLEET_X: '1', fleet_lower: '1', SLACK_TOKEN: 'a', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x',
      MY_API_KEY: 'k', GITHUB_TOKEN: 't', DB_PASSWORD: 'p', SOME_COOKIE: 'c', WEIRD: 'xoxc-123',
      AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', PATH: 'p', USERPROFILE: 'u', LOCALAPPDATA: 'l', TEMP: 't',
    };
    const out = akiChildEnv(env);
    expect(Object.keys(out).sort()).toEqual(['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'LOCALAPPDATA', 'PATH', 'TEMP', 'USERPROFILE']);
    expect(out).not.toBe(env);
    expect(env.FLEET_X).toBe('1');
  });

  it('resolveAkiBin: win32 LOCALAPPDATA Aki.exe first, then PATH Aki.exe, never .cmd; posix ~/.aki/bin/aki', () => {
    const seen = [];
    const exists = (set) => (p) => { seen.push(p); return set.includes(p); };
    const env = { LOCALAPPDATA: 'C:\\L', Path: 'C:\\Users\\u\\.aki\\bin;C:\\Tools' };
    expect(resolveAkiBin({ platform: 'win32', env, existsSync: exists(['C:\\L\\Aki\\Aki.exe', 'C:\\Tools\\Aki.exe']) })).toBe('C:\\L\\Aki\\Aki.exe');
    expect(resolveAkiBin({ platform: 'win32', env, existsSync: exists(['C:\\Tools\\Aki.exe']) })).toBe('C:\\Tools\\Aki.exe');
    // A filesystem that claims every path exists still never yields a .cmd/.bat.
    const any = resolveAkiBin({ platform: 'win32', env, existsSync: () => true });
    expect(any).toMatch(/Aki\.exe$/);
    expect(seen.every((p) => !/\.(cmd|bat)$/i.test(p))).toBe(true);
    expect(resolveAkiBin({ platform: 'win32', env, existsSync: () => false })).toBe(null);
    expect(resolveAkiBin({ platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', existsSync: (p) => p === '/home/u/.aki/bin/aki' })).toBe('/home/u/.aki/bin/aki');
    expect(resolveAkiBin({ platform: 'linux', env: { PATH: '/usr/bin' }, homedir: () => '/home/u', existsSync: (p) => p === '/usr/bin/aki' })).toBe('/usr/bin/aki');
  });
});

describe('aki-lane ask()', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('spawns Aki.exe with the exact args array and options; resolves trimmed text', async () => {
    const { lane, spawn, procs, mkdirSync } = setup();
    lane.configure({ profile: 'fleet-specialist', model: 'opus' });
    const prompt = 'Classify "this" & | ^ % $() <x> repair';
    const p = lane.ask(prompt, { requestId: 'r1' });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe(BIN);
    expect(args).toEqual(['--cli', '--profile', 'fleet-specialist', '--model', 'opus', '--output-format', 'stream-json', prompt]);
    expect(opts.shell).toBe(false);
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.cwd).toBe(path.join(os.tmpdir(), AKI_SANDBOX_DIRNAME));
    expect(mkdirSync).toHaveBeenCalledWith(opts.cwd, { recursive: true });
    procs[0].ev({ type: 'text_delta', content: '  Cooling ' });
    procs[0].ev({ type: 'text_delta', content: 'system  ' });
    procs[0].close(0);
    await expect(p).resolves.toBe('Cooling system');
    expect(lane.stats()).toMatchObject({ state: 'up', calls: 1, ok: 1, failed: 0, active: 0 });
  });

  it('leading "-" prompt gets a space; env passed is stripped', async () => {
    const { lane, spawn, procs } = setup({ env: { PATH: 'p', FLEET_X: '1', SLACK_TOKEN: 'x', AWS_SESSION_TOKEN: 't' } });
    const p = lane.ask('-rf all');
    await flush();
    const [, args, opts] = spawn.mock.calls[0];
    expect(args[args.length - 1]).toBe(' -rf all');
    expect(opts.env).toEqual({ PATH: 'p', AWS_SESSION_TOKEN: 't' });
    procs[0].ev({ type: 'text_delta', content: 'ok' });
    procs[0].close(0);
    await p;
  });

  it('incremental parse across chunk boundaries (partial lines, split UTF-8, bad lines)', async () => {
    const { lane, procs } = setup();
    const p = lane.ask('x');
    await flush();
    const line1 = JSON.stringify({ type: 'text_delta', content: 'Héllo ' });
    const line2 = JSON.stringify({ type: 'tool_use', name: 'Read' });
    const line3 = JSON.stringify({ type: 'text_delta', content: 'wörld' });
    const all = Buffer.from(line1 + '\n{garbage\n' + line2 + '\n' + line3); // last line has no newline
    for (let i = 0; i < all.length; i += 3) procs[0].stdout.emit('data', all.subarray(i, i + 3));
    procs[0].close(0);
    await expect(p).resolves.toBe('Héllo wörld');
    expect(lane.stats()).toMatchObject({ toolsUsed: 1, lastTools: { Read: 1 } });
  });

  it('empty text on exit 0 -> AKI_EMPTY', async () => {
    const { lane, procs } = setup();
    const p = lane.ask('x');
    await flush();
    procs[0].ev({ type: 'thinking_delta', content: 'only thinking' });
    procs[0].close(0);
    await expect(p).rejects.toMatchObject({ code: 'AKI_EMPTY' });
    expect(lane.stats()).toMatchObject({ failed: 1, lastErrorCode: 'AKI_EMPTY' });
  });

  it('non-zero exit -> AKI_EXIT with stderr head; isolated -> code only', async () => {
    const { lane, procs } = setup();
    const p = lane.ask('x');
    await flush();
    procs[0].err('boom detail');
    procs[0].close(3);
    await expect(p).rejects.toMatchObject({ code: 'AKI_EXIT', message: 'aki exited with code 3: boom detail' });
    const p2 = lane.ask('x', { isolated: true });
    await flush();
    procs[1].err(SENTINEL);
    procs[1].close(1);
    const e = await p2.catch((x) => x);
    expect(e.code).toBe('AKI_EXIT');
    expect(e.message).toBe('aki exited with code 1');
  });

  it('missing binary -> AKI_NOT_FOUND without spawning, state not-found; bin cached 60 s', async () => {
    let t = 1000;
    const resolveBin = vi.fn(() => null);
    const { lane, spawn } = setup({ resolveBin, deps: { now: () => t } });
    await expect(lane.ask('x')).rejects.toMatchObject({ code: 'AKI_NOT_FOUND', message: 'aki not found' });
    expect(spawn).not.toHaveBeenCalled();
    expect(lane.stats().state).toBe('not-found');
    expect(lane.available()).toBe(false);
    expect(resolveBin).toHaveBeenCalledTimes(1);
    t += 61000;
    lane.available();
    expect(resolveBin).toHaveBeenCalledTimes(2);
  });

  it('spawn ENOENT -> AKI_NOT_FOUND, not-found state, cache invalidated', async () => {
    const { lane, procs, resolveBin } = setup();
    const p = lane.ask('x');
    await flush();
    procs[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(p).rejects.toMatchObject({ code: 'AKI_NOT_FOUND' });
    expect(lane.stats().state).toBe('not-found');
    procs[0].close(-2); // late close is ignored
    expect(resolveBin).toHaveBeenCalledTimes(1);
    lane.available();
    expect(resolveBin).toHaveBeenCalledTimes(2);
  });

  it('timeout -> killTree + AKI_TIMEOUT', async () => {
    vi.useFakeTimers();
    const { lane, procs, killTree } = setup();
    lane.configure({ timeoutMs: 10000 });
    const p = lane.ask('x');
    const caught = p.catch((e) => e);
    await flush();
    vi.advanceTimersByTime(9999);
    expect(killTree).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    const e = await caught;
    expect(e.code).toBe('AKI_TIMEOUT');
    expect(killTree).toHaveBeenCalledWith(procs[0]);
    expect(lane.stats()).toMatchObject({ timeouts: 1, failed: 1, active: 0 });
  });

  it('abort running -> killTree + ABORTED; abort queued -> removed, never spawned', async () => {
    const { lane, spawn, procs, killTree } = setup();
    lane.configure({ concurrency: 1 });
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = lane.ask('a', { signal: ac1.signal });
    const p2 = lane.ask('b', { signal: ac2.signal });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lane.load()).toBe(2);
    ac2.abort();
    await expect(p2).rejects.toMatchObject({ code: 'ABORTED', message: 'Aborted by caller' });
    expect(lane.stats().queued).toBe(0);
    ac1.abort();
    await expect(p1).rejects.toMatchObject({ code: 'ABORTED' });
    expect(killTree).toHaveBeenCalledWith(procs[0]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(lane.stats()).toMatchObject({ aborted: 2, active: 0, failed: 0 });
    await expect(lane.ask('c', { signal: ac1.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('concurrency cap 2: third waits until one closes; rank ordering (FIFO within rank)', async () => {
    const { lane, spawn, procs } = setup();
    lane.configure({ concurrency: 2 });
    const done = [];
    const mk = (name, rank) => lane.ask(name, { rank }).then(() => done.push(name));
    const all = [mk('a'), mk('b'), mk('c', 3), mk('d', 1), mk('e', 1), mk('f', 0)];
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(lane.stats()).toMatchObject({ active: 2, queued: 4, max: 2 });
    const order = () => spawn.mock.calls.map((c) => c[1][c[1].length - 1]);
    const finish = async (i) => { procs[i].ev({ type: 'text_delta', content: 'ok' }); procs[i].close(0); await flush(); };
    await finish(0);
    expect(spawn).toHaveBeenCalledTimes(3);
    await finish(1); await finish(2); await finish(3); await finish(4); await finish(5);
    await Promise.all(all);
    expect(order()).toEqual(['a', 'b', 'f', 'd', 'e', 'c']);
  });

  it('long prompt: reject -> AKI_PROMPT_TOO_LONG without spawning; truncate -> spawns with marker within budget', async () => {
    const { lane, spawn, procs } = setup();
    const long = 'word '.repeat(10000);
    await expect(lane.ask(long)).rejects.toMatchObject({ code: 'AKI_PROMPT_TOO_LONG' });
    expect(spawn).not.toHaveBeenCalled();
    expect(lane.stats().tooLong).toBe(1);
    const p = lane.ask(long, { onTooLong: 'truncate' });
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args] = spawn.mock.calls[0];
    expect(args[args.length - 1].endsWith(AKI_TRUNC_MARKER)).toBe(true);
    expect(cmdLineLength(bin, args)).toBeLessThanOrEqual(32000);
    procs[0].ev({ type: 'text_delta', content: 'ok' });
    procs[0].close(0);
    await p;
  });

  it('stdout cap -> killTree + AKI_STDOUT_CAP', async () => {
    const { lane, procs, killTree } = setup();
    lane.configure({ maxStdoutBytes: 100 });
    const p = lane.ask('x');
    await flush();
    procs[0].raw('x'.repeat(101));
    await expect(p).rejects.toMatchObject({ code: 'AKI_STDOUT_CAP' });
    expect(killTree).toHaveBeenCalledWith(procs[0]);
  });

  it('log lines carry exit/latency/tool counts but never prompt, response or stderr content', async () => {
    const { lane, procs, logs } = setup();
    lane.configure({ profile: `bad ${SENTINEL}` });
    const p = lane.ask(`please ${SENTINEL}`, { requestId: 'req-9' });
    await flush();
    procs[0].ev({ type: 'tool_use', name: 'Bash' });
    procs[0].ev({ type: 'tool_use', name: 'Bash' });
    procs[0].ev({ type: 'tool_use', name: 'Read' });
    procs[0].ev({ type: 'text_delta', content: `answer ${SENTINEL}` });
    procs[0].err(`stderr ${SENTINEL}`);
    procs[0].close(0);
    await p;
    const p2 = lane.ask(`iso ${SENTINEL}`, { requestId: 'req-10', isolated: true });
    await flush();
    procs[1].err(SENTINEL);
    procs[1].close(2);
    await p2.catch(() => {});
    const line = logs.find((l) => l.startsWith('[aki] req-9 '));
    expect(line).toMatch(/^\[aki\] req-9 exit=0 \d+ms text=\d+ch tools=3 \(Bash×2, Read×1\)/);
    expect(logs.find((l) => l.startsWith('[aki] req-10 '))).toMatch(/exit=2 .*\[isolated\]/);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toContain(SENTINEL);
  });

  it('configure clamps, stats shape, markState, reset', async () => {
    const { lane } = setup();
    expect(lane.configure({ concurrency: 9, timeoutMs: 5, profile: '-x' })).toMatchObject({ concurrency: 2, timeoutMs: 120000, profile: '' });
    expect(lane.stats()).toEqual({
      state: 'idle', active: 0, queued: 0, max: 2, calls: 0, ok: 0, failed: 0, timeouts: 0, aborted: 0,
      tooLong: 0, toolsUsed: 0, lastTools: {}, lastLatencyMs: null, lastErrorCode: null,
    });
    lane.markState('down');
    expect(lane.stats().state).toBe('down');
    expect(lane.available()).toBe(true);
    lane.reset();
    expect(lane.stats().state).toBe('idle');
  });
});
