// tests/pending-est-ipc.test.js — pending-est:get / pending-est:scan
// (src/ipc/pending-est.js), the preload pendingEst surface and the index.js
// registration line. electron is a stub; the scan itself is spied (no live calls).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);

const handlers = {};
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    BrowserWindow: { getAllWindows: () => [] },
    session: { defaultSession: { fetch: vi.fn(), cookies: { get: async () => [] } } },
    app: { getPath: () => os.tmpdir() },
  },
};

const tmpDir = path.join(os.tmpdir(), 'pending-est-ipc-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const sources = require('../src/scrapers/pending_est_sources');
const ctx = { lastData: { rows: [{ equipmentId: 'CTX1' }] } };
require('../src/ipc/pending-est').registerPendingEstIPC(ctx);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const call = (ch, ...a) => handlers[ch]({}, ...a);

afterEach(() => { vi.restoreAllMocks(); });

describe('pending-est IPC', () => {
  it('registers both channels', () => {
    expect(typeof handlers['pending-est:get']).toBe('function');
    expect(typeof handlers['pending-est:scan']).toBe('function');
  });

  it('get returns the empty shape when no scan is stored', async () => {
    store.save('pendingEstScan', {});
    const r = await call('pending-est:get');
    expect(r).toEqual({ ok: true, asOf: null, rows: [], excludedDtna: 0, counts: {}, cached: true });
  });

  it('get returns the stored scan with cached:true and without internal caches', async () => {
    store.save('pendingEstScan', { ok: true, asOf: '2026-11-20T17:00:00.000Z', rows: [{ key: 'wr:1' }], excludedDtna: 2, counts: { rg: 1 }, errors: [], wrEst: { 1: { mod: '1', url: '' } }, assetCache: {} });
    const r = await call('pending-est:get');
    expect(r).toMatchObject({ ok: true, asOf: '2026-11-20T17:00:00.000Z', rows: [{ key: 'wr:1' }], excludedDtna: 2, cached: true });
    expect(r.wrEst).toBeUndefined();
    expect(r.assetCache).toBeUndefined();
  });

  it('scan forwards force and uses ctx.lastData rows', async () => {
    const spy = vi.spyOn(sources, 'scanTeamPending').mockResolvedValue({ ok: true, rows: [], cached: false });
    await call('pending-est:scan', { force: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ force: true });
    expect(spy.mock.calls[0][1].fleetRows()).toEqual([{ equipmentId: 'CTX1' }]);
    await call('pending-est:scan');
    expect(spy.mock.calls[1][0]).toEqual({ force: false });
  });

  it('preload exposes pendingEst with exactly get + scan on those channels', () => {
    const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const m = pre.match(/expose\('pendingEst',\s*\{([\s\S]*?)\n\}\);/);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
    expect(keys).toEqual(['get', 'scan']);
    expect(m[1]).toMatch(/get:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pending-est:get'\)/);
    expect(m[1]).toMatch(/scan:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('pending-est:scan',\s*opts \|\| \{\}\)/);
  });

  it('src/ipc/index.js registers it exactly once', () => {
    const idx = fs.readFileSync(path.join(root, 'src', 'ipc', 'index.js'), 'utf8');
    expect(idx.match(/^\s*registerPendingEstIPC\(ctx\);/gm) || []).toHaveLength(1);
    expect(idx).toMatch(/const \{ registerPendingEstIPC \}\s*= require\('\.\/pending-est'\);/);
  });
});
