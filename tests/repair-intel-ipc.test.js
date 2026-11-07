// tests/repair-intel-ipc.test.js — Build / Fetch New pass the dealer backfill
// options; responses carry the woSummaries flag; refresh-ai unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function injectResolved(resolved, exportsObj) {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
const inject = (rel, exportsObj) => injectResolved(require.resolve('../' + rel), exportsObj);

const handlers = {};
const syncCalls = [];
const analyzeCalls = [];
injectResolved(require.resolve('electron'), { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
inject('src/repair-intel/fetch', { syncUnit: async (id, opts) => { syncCalls.push([id, opts]); return { ok: true }; } });
inject('src/repair-intel/analysis', { analyzeUnit: async (id, opts) => { analyzeCalls.push([id, opts]); return { ok: true }; } });
inject('src/store', { load: (k, d) => (k === 'fleetData' ? { rows: [{ equipmentId: 'U1', workRequestId: 'W1' }] } : d), save: () => {} });

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const { registerRepairIntelIPC } = require('../src/ipc/repair-intel');

const ENV = 'FLEET_REPAIR_INTEL_DEALER_BACKFILL';
const fakeEvent = {};
let tmpDir;
let savedEnv;

describe('repair-intel IPC', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-ipc-'));
    setDataDir(tmpDir);
    engine.close();
    savedEnv = { b: process.env[ENV], w: process.env.FLEET_REPAIR_INTEL_WO_SUMMARIES };
    delete process.env[ENV];
    delete process.env.FLEET_REPAIR_INTEL_WO_SUMMARIES;
    registerRepairIntelIPC({});
  });
  afterAll(() => {
    if (savedEnv.b === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv.b;
    if (savedEnv.w !== undefined) process.env.FLEET_REPAIR_INTEL_WO_SUMMARIES = savedEnv.w;
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
  beforeEach(() => { syncCalls.length = 0; analyzeCalls.length = 0; });

  it('build passes hydrateDetail:true + the fleet row by default', async () => {
    const res = await handlers['repair-history:build'](fakeEvent, 'U1');
    expect(syncCalls).toEqual([['U1', { incremental: false, hydrateDetail: true, unitRow: { equipmentId: 'U1', workRequestId: 'W1' } }]]);
    expect(res.woSummaries).toBe(false);
  });

  it('fetch-new passes incremental:true; unknown unit → unitRow null', async () => {
    const res = await handlers['repair-history:fetch-new'](fakeEvent, 'U9');
    expect(syncCalls).toEqual([['U9', { incremental: true, hydrateDetail: true, unitRow: null }]]);
    expect(res.woSummaries).toBe(false);
  });

  it('kill switch env → hydrateDetail false', async () => {
    process.env[ENV] = '0';
    try {
      await handlers['repair-history:build'](fakeEvent, 'U1');
      await handlers['repair-history:fetch-new'](fakeEvent, 'U1');
    } finally { delete process.env[ENV]; }
    expect(syncCalls.map((c) => c[1].hydrateDetail)).toEqual([false, false]);
  });

  it('get includes woSummaries:false', async () => {
    const res = await handlers['repair-history:get'](fakeEvent, 'U1');
    expect(res.ok).toBe(true);
    expect(res.woSummaries).toBe(false);
  });

  it('refresh-ai still calls analyzeUnit(id, { force: true })', async () => {
    const res = await handlers['repair-history:refresh-ai'](fakeEvent, 'U1');
    expect(analyzeCalls).toEqual([['U1', { force: true }]]);
    expect(res.ok).toBe(true);
    expect('woSummaries' in res).toBe(false);
    expect(syncCalls.length).toBe(0);
  });
});
