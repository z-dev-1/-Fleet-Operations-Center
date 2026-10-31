import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const sup = require('../src/orcha/orcha-supervisor');

function deps(over = {}) {
  const calls = { spawn: 0, args: null };
  const d = {
    portOpen: async () => false,
    orchaProcs: async () => [],
    findAgentExe: () => 'C:\\fake\\orcha-agent.exe',
    spawn: (exe, args) => { calls.spawn++; calls.args = [exe, ...args]; return { pid: 123, unref() {} }; },
    ...over,
  };
  return { d, calls };
}

describe('orcha-supervisor.ensureRunning', () => {
  beforeEach(() => sup._resetForTests());

  it('does nothing when Orcha already answers on the port', async () => {
    const { d, calls } = deps({ portOpen: async () => true });
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('running');
    expect(calls.spawn).toBe(0);
  });

  it('never spawns while any Orcha process is alive (no duplicate fight)', async () => {
    const { d, calls } = deps({ orchaProcs: async () => ['orcha-daemon.exe'] });
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('booting');
    expect(calls.spawn).toBe(0);
  });

  it('never spawns when the process list cannot be read', async () => {
    const { d, calls } = deps({ orchaProcs: async () => null });
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('unknown-procs');
    expect(calls.spawn).toBe(0);
  });

  it('starts exactly one agent when nothing is running', async () => {
    const { d, calls } = deps();
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('spawned');
    expect(calls.spawn).toBe(1);
    expect(calls.args).toEqual(['C:\\fake\\orcha-agent.exe', '--no-auth', '--port', '4799']);
  });

  it('throttles checks and enforces a spawn cooldown', async () => {
    const { d, calls } = deps();
    await sup.ensureRunning(4799, { deps: d });
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('throttled');
    expect(await sup.ensureRunning(4799, { deps: d, force: true })).toBe('cooldown');
    expect(calls.spawn).toBe(1);
  });

  it('is single-flight for concurrent callers', async () => {
    let n = 0;
    const { d } = deps({ portOpen: async () => { n++; await new Promise(r => setTimeout(r, 20)); return true; } });
    const [a, b] = await Promise.all([sup.ensureRunning(4799, { deps: d }), sup.ensureRunning(4799, { deps: d })]);
    expect(a).toBe('running'); expect(b).toBe('running'); expect(n).toBe(1);
  });

  it('reports not-installed instead of spawning', async () => {
    const { d, calls } = deps({ findAgentExe: () => null });
    expect(await sup.ensureRunning(4799, { deps: d })).toBe('not-installed');
    expect(calls.spawn).toBe(0);
  });
});

describe('orcha-supervisor.findAgentExe', () => {
  it('picks the newest installed version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orcha-tools-'));
    for (const v of ['3.3.9', '3.3.63', '3.10.0-bad']) {
      const p = path.join(dir, v, 'resources', 'agent');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'orcha-agent.exe'), '');
    }
    expect(sup.findAgentExe(dir)).toBe(path.join(dir, '3.3.63', 'resources', 'agent', 'orcha-agent.exe'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
