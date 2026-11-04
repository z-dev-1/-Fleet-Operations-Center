// tests/workers-ipc.test.js — workers:status + workers:re-enable (Phase 6) (src/ipc/workers.js) plus the
// telemetry latestSample() export and snapshot `workers` section (Phase 5).
// Same harness as tests/telemetry-ipc.test.js: fake electron.ipcMain in
// require.cache and an isolated data dir. Fake timers for the supervisor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'workers-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
const telemetry = require('../src/telemetry');
const supPath = require.resolve('../src/workers/supervisor');
const sup = require('../src/workers/supervisor');
require('../src/ipc/workers').registerWorkersIPC({});
const sender = (url) => ({ sender: { getURL: () => url } });
const APP = sender('file:///C:/app/dist/renderer/index.html');
const AAP = sender('https://aap-na.corp.amazon.com/assets/123');

const WORKER_KEYS = [
  'name', 'group', 'label', 'state', 'waitingOn', 'disabledReason', 'breakerState',
  'lastHeartbeatAt', 'lastStartAt', 'lastEndAt', 'lastDurationMs', 'currentJob',
  'counts', 'skipReasons', 'consecutiveFailures', 'lastError',
  'restarts', 'maxRestarts', 'isolations', 'isolationReason', 'isolatedUntil', 'notified',
  'nextRunAt', 'intervalMs', 'timeoutMs', 'maxFailures', 'cooldownMs', 'dependsOn', 'idempotent', 'owner',
].sort();

function initEnabled() {
  return sup.init({
    flags: { supervisorEnabled: true, supervised: { alpha: true, beta: true } },
    timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
    now: () => Date.now(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
function registerTwo() {
  const base = { group: 'test', intervalMs: 60000, timeoutMs: 10000, idempotent: true, tick: () => {} };
  sup.register({ ...base, name: 'alpha' });
  sup.register({ ...base, name: 'beta', dependsOn: [] });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));
  telemetry._resetForTests();
});
afterEach(() => {
  sup._resetForTests();
  telemetry._resetForTests();
  vi.useRealTimers();
});

describe('workers IPC', () => {
  it('registers exactly workers:status and workers:re-enable', () => {
    expect(Object.keys(handlers)).toEqual(['workers:status', 'workers:re-enable']);
  });

  it('non-app sender → NOT_APP_UI', async () => {
    expect(await handlers['workers:status'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
  });

  it('disabled → {ok:true,status:{enabled:false,workers:[]}}', async () => {
    expect(await handlers['workers:status'](APP)).toEqual({ ok: true, status: { enabled: false, workers: [] } });
    sup.init({ flags: { supervisorEnabled: false, supervised: {} } });
    expect(await handlers['workers:status'](APP)).toEqual({ ok: true, status: { enabled: false, workers: [] } });
  });

  it('enabled with two fake workers → full §8 per-worker key set', async () => {
    initEnabled();
    registerTwo();
    await vi.advanceTimersByTimeAsync(60000);
    telemetry._sampleNow();
    const r = await handlers['workers:status'](APP);
    expect(r.ok).toBe(true);
    const s = r.status;
    expect(s).toMatchObject({ enabled: true, shuttingDown: false });
    expect(typeof s.initializedAt).toBe('number');
    expect(typeof s.at).toBe('number');
    expect(s.process).not.toBeNull();
    expect(Object.keys(s.process).sort()).toEqual(['at', 'cpuPct', 'heapUsedMb', 'rssMb', 'workingSetMb']);
    expect(s.workers.map((w) => w.name)).toEqual(['alpha', 'beta']);
    for (const w of s.workers) {
      expect(Object.keys(w).sort()).toEqual(WORKER_KEYS);
      expect(w.counts).toEqual({ runs: 1, ok: 1, fail: 0, skip: 0, timeout: 0 });
      expect(w.state).toBe('healthy');
      expect(w.breakerState).toBe('ok');
      expect(w.nextRunAt).toBe(Date.now() + 60000);
      expect(w.owner).toBe('supervisor');
    }
  });

  it('process null without a sample', async () => {
    initEnabled();
    registerTwo();
    const r = await handlers['workers:status'](APP);
    expect(r.status.process).toBeNull();
  });

  it('sample with memory:null,totals:null → four null fields, no throw', async () => {
    initEnabled();
    const telPath = require.resolve('../src/telemetry');
    const real = require.cache[telPath].exports;
    require.cache[telPath].exports = { latestSample: () => ({ seq: 1, at: 1234, memory: null, totals: null }) };
    try {
      const r = await handlers['workers:status'](APP);
      expect(r.status.process).toEqual({ rssMb: null, heapUsedMb: null, cpuPct: null, workingSetMb: null, at: 1234 });
    } finally {
      require.cache[telPath].exports = real;
    }
  });

  it('snapshot has no workers key when disabled or not loaded', () => {
    // loaded but disabled (never initialized)
    expect('workers' in telemetry.snapshot()).toBe(false);
    sup.init({ flags: { supervisorEnabled: false, supervised: {} } });
    expect('workers' in telemetry.snapshot()).toBe(false);
    // not loaded at all
    const entry = require.cache[supPath];
    delete require.cache[supPath];
    try {
      expect('workers' in telemetry.snapshot()).toBe(false);
      expect(require.cache[supPath]).toBeUndefined();
    } finally {
      require.cache[supPath] = entry;
    }
  });

  it('snapshot.workers equals getSummary() when enabled', async () => {
    initEnabled();
    registerTwo();
    await vi.advanceTimersByTimeAsync(60000);
    const snap = telemetry.snapshot();
    expect(snap.workers).toEqual(sup.getSummary());
    expect(snap.workers).toMatchObject({
      enabled: true, count: 2,
      byState: { healthy: 2, busy: 0, waiting: 0, degraded: 0, isolated: 0, disabled: 0 },
      isolated: [], waiting: [], fails: 0, lastErrorAt: null,
    });
  });

  it('re-enable from a non-app sender → NOT_APP_UI, supervisor not called', async () => {
    const spy = vi.spyOn(sup, 'reEnable');
    try {
      expect(await handlers['workers:re-enable'](AAP, 'alpha')).toEqual({ ok: false, code: 'NOT_APP_UI' });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('re-enable with an invalid name → INVALID_NAME, supervisor not called', async () => {
    const spy = vi.spyOn(sup, 'reEnable');
    try {
      for (const bad of ['', 123, null, undefined, {}, '../x', 'A1', 'a', 'a' + 'b'.repeat(40), 'al pha', 'alpha;']) {
        expect(await handlers['workers:re-enable'](APP, bad)).toEqual({ ok: false, code: 'INVALID_NAME' });
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('re-enable an isolated worker → reEnabled:true via supervisor.reEnable(name,{runNow:false}) only', async () => {
    initEnabled();
    sup.register({ name: 'alpha', group: 'test', intervalMs: 60000, timeoutMs: 10000, idempotent: true, maxFailures: 1, backoff: false, tick: () => { throw new Error('fail'); } });
    await vi.advanceTimersByTimeAsync(60000);
    const before = (await handlers['workers:status'](APP)).status.workers[0];
    expect(before.state).toBe('isolated');
    const spy = vi.spyOn(sup, 'reEnable');
    try {
      expect(await handlers['workers:re-enable'](APP, 'alpha', { runNow: true })).toEqual({ ok: true, reEnabled: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('alpha', { runNow: false });
    } finally { spy.mockRestore(); }
    const after = (await handlers['workers:status'](APP)).status.workers[0];
    expect(after.state).not.toBe('isolated');
    expect(after.breakerState).toBe('ok');
  });

  it('re-enable a healthy worker → reEnabled:false, reason not-eligible', async () => {
    initEnabled();
    registerTwo();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await handlers['workers:re-enable'](APP, 'alpha')).toEqual({ ok: true, reEnabled: false, reason: 'not-eligible' });
    expect(await handlers['workers:re-enable'](APP, 'nosuchWorker')).toEqual({ ok: true, reEnabled: false, reason: 'not-eligible' });
  });

  it('latestSample() null before any sample', () => {
    expect(telemetry.latestSample()).toBeNull();
    const s = telemetry._sampleNow();
    expect(telemetry.latestSample()).toBe(s);
  });
});
