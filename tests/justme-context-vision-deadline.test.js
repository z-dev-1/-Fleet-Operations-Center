// T-BEDROCK-DEADLINE (bedrock half): readFileWithVision opt-ins `deadline` (fix 10)
// and `redactLog` (fix 16). Callers that pass neither behave exactly as before.
// `confineRead` (fix 2) is NOT implemented: lane probe P2 failed (see
// .agents/.../lane-probe.json), so the default spawn args must stay unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-vdl-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const bedrock = require('../src/scrapers/bedrock');
const { makeFakeProc } = require('./helpers/ai-gateway-fakes.cjs');

const relayPath = require.resolve('../src/orcha/relay');
const realRelayEntry = require.cache[relayPath];
const SENTINEL = 'SENTINEL-CONTENT-7f3a';
const PNG = { name: 'shot.png', mimetype: 'image/png', buffer: Buffer.from([1, 2, 3]) };

let spawns, procs;
function installRelayFake(runInSlot) {
  require.cache[relayPath] = { id: relayPath, filename: relayPath, loaded: true, exports: { runInSlot, getClaudeModel: () => '' } };
}
function fakeSpawn() {
  spawns = []; procs = [];
  bedrock.__test__.setBinExists(() => true);
  bedrock.__test__.setSpawn((bin, args, options) => {
    const p = makeFakeProc(vi);
    procs.push(p);
    spawns.push({ bin, args: JSON.parse(JSON.stringify(args)), options: JSON.parse(JSON.stringify(options)) });
    return p;
  });
}
const fasDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fas-attach-'));

beforeEach(() => { fakeSpawn(); installRelayFake(async (fn) => fn()); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  bedrock.__test__.setSpawn(null);
  bedrock.__test__.setBinExists(null);
  if (realRelayEntry) require.cache[relayPath] = realRelayEntry; else delete require.cache[relayPath];
});

describe('deadline', () => {
  it('late slot grant: nothing is spawned or written, error is "vision deadline passed"', async () => {
    vi.useFakeTimers();
    const mk = vi.spyOn(fs, 'mkdtempSync');
    const before = fasDirs().length;
    installRelayFake(async (fn) => { await new Promise((r) => setTimeout(r, 6000)); return fn(); });
    const p = bedrock.readFileWithVision(PNG, { deadline: Date.now() + 5000, timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    expect(res).toMatchObject({ ok: false, kind: 'image', error: 'vision deadline passed' });
    expect(spawns).toHaveLength(0);
    expect(mk).not.toHaveBeenCalled();
    expect(fasDirs().length).toBe(before);
  });

  it('grant inside the last second also returns early', async () => {
    const res = await bedrock.readFileWithVision(PNG, { deadline: Date.now() + 500 });
    expect(res).toMatchObject({ ok: false, error: 'vision deadline passed' });
    expect(spawns).toHaveLength(0);
  });

  it('early grant: the read is killed at the deadline, not at timeoutMs', async () => {
    vi.useFakeTimers();
    const p = bedrock.readFileWithVision(PNG, { deadline: Date.now() + 5000, timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4900);
    expect(procs[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    const res = await p;
    expect(res).toMatchObject({ ok: false, error: 'claude-code read timed out' });
    expect(procs[0].kill).toHaveBeenCalled();
  });

  it('a smaller timeoutMs still wins over a far deadline', async () => {
    vi.useFakeTimers();
    const p = bedrock.readFileWithVision(PNG, { deadline: Date.now() + 600000, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3100);
    expect(await p).toMatchObject({ ok: false, error: 'claude-code read timed out' });
  });

  it('no deadline: timer is timeoutMs || 90000 as before', async () => {
    vi.useFakeTimers();
    const p = bedrock.readFileWithVision(PNG, {});
    await vi.advanceTimersByTimeAsync(89000);
    expect(procs[0].kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await p).toMatchObject({ ok: false, error: 'claude-code read timed out' });
    const q = bedrock.readFileWithVision(PNG, { timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2100);
    expect(await q).toMatchObject({ ok: false, error: 'claude-code read timed out' });
  });
});

describe('redactLog', () => {
  function capture() {
    const lines = [];
    const sink = (c) => { lines.push(String(c)); return true; };
    vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    return lines;
  }
  async function readWithStderr(opts, stderrText) {
    const p = bedrock.readFileWithVision(PNG, opts);
    await new Promise((r) => setTimeout(r, 0));
    procs[0].stderr.emit('data', Buffer.from(stderrText));
    procs[0].result('text');
    return p;
  }

  it('redactLog: stderr containing the sentinel logs only the length', async () => {
    const lines = capture();
    const text = 'trace ' + SENTINEL + ' end';
    await readWithStderr({ redactLog: true }, text);
    const all = lines.join('');
    expect(all).not.toContain(SENTINEL);
    expect(all).toContain('[Bedrock] vision stderr: (' + text.length + ' chars)');
  });

  it('without redactLog the 200-char line is unchanged', async () => {
    const lines = capture();
    const text = 'a'.repeat(190) + SENTINEL + 'b'.repeat(100);
    await readWithStderr({}, text);
    const all = lines.join('');
    expect(all).toContain('[Bedrock] vision stderr: ' + text.slice(0, 200));
    expect(all).not.toContain(text.slice(0, 201));
  });
});

describe('default spawn args are unchanged (no confineRead)', () => {
  it('uses the original --allowedTools Read / skip-permissions set and the temp cwd', async () => {
    const p = bedrock.readFileWithVision(PNG, { deadline: Date.now() + 60000, redactLog: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawns[0].args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--bare', '--allowedTools', 'Read', '--dangerously-skip-permissions']);
    expect(path.basename(spawns[0].options.cwd)).toMatch(/^fas-attach-/);
    procs[0].result('ok');
    await p;
  });
  it('confineRead is ignored (not implemented)', async () => {
    const p = bedrock.readFileWithVision(PNG, { confineRead: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawns[0].args).toContain('--dangerously-skip-permissions');
    expect(spawns[0].args).not.toContain('--restricted');
    procs[0].result('ok');
    await p;
  });
});
