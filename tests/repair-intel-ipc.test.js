// tests/repair-intel-ipc.test.js — Build / Fetch New pass the dealer backfill
// options; responses carry the woSummaries flag; refresh-ai unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
const sumCalls = [];
let sumGate = null;
inject('src/repair-intel/wo-summary', {
  defaultDeps: () => ({}),
  createWoSummarizer: () => ({
    summarize: async (events, o) => {
      sumCalls.push({ events, o });
      if (sumGate) await sumGate;
      return { results: { W1: { status: 'cached' } }, counts: { cached: 1, fresh: 0, structured: 0, no_evidence: 0, timeout: 0, error: 0 } };
    },
  }),
});

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

  describe('repair-history:wo-3c', () => {
    beforeEach(() => { sumCalls.length = 0; sumGate = null; });

    it('disabled by default → { ok:false, disabled:true }, no summarize', async () => {
      const res = await handlers['repair-history:wo-3c'](fakeEvent, 'U1', {});
      expect(res).toEqual({ ok: false, disabled: true });
      expect(sumCalls.length).toBe(0);
    });

    describe('flag on', () => {
      beforeEach(() => { process.env.FLEET_REPAIR_INTEL_WO_SUMMARIES = '1'; });
      afterEach(() => { delete process.env.FLEET_REPAIR_INTEL_WO_SUMMARIES; });

      it('returns results/counts/report; lazy = low, force = normal', async () => {
        const res = await handlers['repair-history:wo-3c'](fakeEvent, 'U1', {});
        expect(res.ok).toBe(true);
        expect(res.results).toEqual({ W1: { status: 'cached' } });
        expect(res.counts.cached).toBe(1);
        expect(res.report.equipmentId).toBe('U1');
        expect(sumCalls[0].o).toMatchObject({ force: false, priority: 'low' });
        expect(typeof sumCalls[0].o.offsiteFor).toBe('function');
        expect(sumCalls[0].o.offsiteFor({ work_order_id: 'W9' })).toBe('');
        await handlers['repair-history:wo-3c'](fakeEvent, 'U1', { force: true });
        expect(sumCalls[1].o).toMatchObject({ force: true, priority: 'normal' });
        const res2 = await handlers['repair-history:get'](fakeEvent, 'U1');
        expect(res2.woSummaries).toBe(true);
      });

      it('two concurrent calls → summarize once', async () => {
        let release; sumGate = new Promise((r) => { release = r; });
        const a = handlers['repair-history:wo-3c'](fakeEvent, 'U1', {});
        const b = handlers['repair-history:wo-3c'](fakeEvent, 'U1', {});
        await new Promise((r) => setTimeout(r, 10));
        release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(sumCalls.length).toBe(1);
        expect(ra).toEqual(rb);
      });

      it('force during a lazy run waits for it, then runs forced', async () => {
        let release; sumGate = new Promise((r) => { release = r; });
        const a = handlers['repair-history:wo-3c'](fakeEvent, 'U1', {});
        await new Promise((r) => setTimeout(r, 5));
        const b = handlers['repair-history:wo-3c'](fakeEvent, 'U1', { force: true });
        await new Promise((r) => setTimeout(r, 5));
        expect(sumCalls.length).toBe(1);
        release();
        await Promise.all([a, b]);
        expect(sumCalls.map((c) => c.o.priority)).toEqual(['low', 'normal']);
      });
    });
  });
});
