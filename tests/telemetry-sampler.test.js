// tests/telemetry-sampler.test.js — sampler / rollup / dump in
// src/telemetry/index.js with fake electron + fake timers (no real Electron).
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'telemetry-sampler-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const telemetry = require('../src/telemetry');
const store = require('../src/store');

function win(visible, destroyed = false) {
  return { isDestroyed: () => destroyed, isVisible: () => visible };
}
const fakeElectron = {
  app: {
    getAppMetrics: () => ([
      { type: 'Browser', pid: 10, cpu: { percentCPUUsage: 2.5 }, memory: { workingSetSize: 102400, privateBytes: 51200 } },
      { type: 'Tab', pid: 11, name: 'renderer', cpu: { percentCPUUsage: 1.5 }, memory: { workingSetSize: 204800, privateBytes: 102400 } },
    ]),
  },
  BrowserWindow: { getAllWindows: () => [win(true), win(true), win(false), win(true, true)] },
};
const noSettings = () => ({});

afterEach(() => { telemetry._resetForTests(); });

describe('telemetry sampler', () => {
  it('flag off: no sampling timer, no histogram, track records nothing', () => {
    const si = vi.fn();
    const r = telemetry.start({ enabled: false, setInterval: si, loadSettings: noSettings, env: {} });
    expect(r).toEqual({ started: false });
    expect(si).not.toHaveBeenCalled();
    expect(telemetry._hasHistogramForTests()).toBe(false);
    const s = telemetry.snapshot();
    expect(s.enabled).toBe(false);
    expect(s.sampling).toBe(false);
    expect(s.samples).toEqual([]);
    expect(telemetry.track('x', () => 1)).toBe(1);
    expect(telemetry.snapshot().tracks.x).toBeUndefined();
  });
  it('settings.telemetry.enabled=false (via loader) also starts no timer', () => {
    const si = vi.fn();
    const r = telemetry.start({ setInterval: si, loadSettings: () => ({ telemetry: { enabled: false } }), env: {} });
    expect(r.started).toBe(false);
    expect(si).not.toHaveBeenCalled();
  });
  it('flag on: exactly one timer, interval clamped to >= 5 s, idempotent', () => {
    const handle = { unref: vi.fn() };
    const si = vi.fn(() => handle);
    expect(telemetry.start({ enabled: true, setInterval: si, clearInterval: () => {}, sampleMs: 10, electron: fakeElectron, loadSettings: noSettings, env: {} })).toEqual({ started: true });
    telemetry.start({ enabled: true, setInterval: si });
    expect(si).toHaveBeenCalledTimes(1);
    expect(si.mock.calls[0][1]).toBeGreaterThanOrEqual(5000);
    expect(handle.unref).toHaveBeenCalled();
    expect(telemetry._hasHistogramForTests()).toBe(true);
    expect(telemetry.snapshot().flags).toMatchObject({ telemetryEnabled: true, trayAnimateOnlyWhenBusy: false, deepScanMatchPool: false });
  });
  it('_sampleNow: processes, totals, windows (destroyed excluded), memory, event loop', () => {
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, loadSettings: noSettings, env: {} });
    const s = telemetry._sampleNow();
    expect(s.processes.length).toBe(2);
    expect(s.processes[0]).toMatchObject({ type: 'Browser', pid: 10, cpuPct: 2.5, workingSetMb: 100, privateMb: 50 });
    expect(s.totals).toEqual({ count: 2, workingSetMb: 300, privateMb: 150, cpuPct: 4 });
    expect(s.windows).toEqual({ total: 3, visible: 2, hidden: 1 });
    expect(s.memory.rssMb).toBeGreaterThan(0);
    expect(s.eventLoop).toHaveProperty('p99Ms');
    expect(telemetry.snapshot().latest).toBe(s);
  });
  it('_sampleNow without electron degrades to null sections', () => {
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: { }, loadSettings: noSettings, env: {} });
    const s = telemetry._sampleNow();
    expect(s.processes).toBeNull();
    expect(s.windows).toBeNull();
    expect(s.memory).not.toBeNull();
  });
  it('_rollupNow writes telemetryRollup and caps at 96', () => {
    store.save('telemetryRollup', { version: 1, rollups: [] });
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, loadSettings: noSettings, env: {} });
    telemetry._sampleNow();
    telemetry.track('job', () => 1);
    const r = telemetry._rollupNow();
    expect(r.tracks.job).toMatchObject({ count: 1, ok: 1, fail: 0 });
    expect(r.windows.maxTotal).toBe(3);
    let doc = store.load('telemetryRollup', null);
    expect(doc.version).toBe(1);
    expect(doc.rollups.length).toBe(1);
    for (let i = 0; i < 100; i++) telemetry._rollupNow();
    doc = store.load('telemetryRollup', null);
    expect(doc.rollups.length).toBe(96);
    // window aggregates reset after a rollup
    expect(doc.rollups[doc.rollups.length - 1].tracks).toEqual({});
  });
  it('_dumpNow writes a parseable telemetry-snapshot.json into logsDir', () => {
    const logsDir = path.join(tmpDir, 'logs-a');
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, logsDir, loadSettings: noSettings, env: {} });
    const f = telemetry._dumpNow();
    expect(f).toBe(path.join(logsDir, 'telemetry-snapshot.json'));
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(parsed.enabled).toBe(true);
    expect(fs.existsSync(f + '.tmp')).toBe(false);
  });
  it('_tick dumps only when FLEET_TELEMETRY_DUMP=1', () => {
    const offDir = path.join(tmpDir, 'logs-off');
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, logsDir: offDir, loadSettings: noSettings, env: {} });
    telemetry._tick();
    expect(fs.existsSync(path.join(offDir, 'telemetry-snapshot.json'))).toBe(false);
    telemetry._resetForTests();
    const onDir = path.join(tmpDir, 'logs-on');
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, logsDir: onDir, loadSettings: noSettings, env: { FLEET_TELEMETRY_DUMP: '1' } });
    telemetry._tick();
    expect(fs.existsSync(path.join(onDir, 'telemetry-snapshot.json'))).toBe(true);
  });
  it('samples ring is bounded at 120', () => {
    telemetry.start({ enabled: true, setInterval: () => ({}), clearInterval: () => {}, electron: fakeElectron, loadSettings: noSettings, env: {} });
    for (let i = 0; i < 130; i++) telemetry._sampleNow();
    expect(telemetry.snapshot().samples.length).toBe(20);
    expect(telemetry.snapshot().sampleCount).toBe(120);
  });
});
