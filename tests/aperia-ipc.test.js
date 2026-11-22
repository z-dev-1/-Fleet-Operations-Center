// tests/aperia-ipc.test.js — src/ipc/aperia.js channels and validation, the pinned preload aperia block and the
// src/ipc/index.js registration. electron is a stub; client / session / watcher are fakes; the exporter is real.
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-ipc-'));
const DOWNLOADS = path.join(TMP, 'downloads');
fs.mkdirSync(DOWNLOADS, { recursive: true });

const handlers = {};
const appOnce = [];
const electronPath = require.resolve('electron');
const prevElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    BrowserWindow: function BrowserWindow() { throw new Error('no windows in this test'); },
    app: { getPath: (k) => (k === 'downloads' ? DOWNLOADS : TMP), once: (ev, fn) => { appOnce.push([ev, fn]); } },
  },
};
const exporter = require('../src/aperia/export');
const realClient = require('../src/aperia/client');

const unit = (fleetVehicleId, domicile) => ({
  id: 'v' + fleetVehicleId, fleetVehicleId, vin: 'VIN', domicile, group: 'G', gps: null,
  tires: [{ position: 'L1IC', positionName: 'Left Steer', pressure: 70, setPoint: 100, deltaPsi: -30, pct: 70, temperatureF: 71, readAtEt: '', flag: 'CRITICAL LOW', issue: null }],
});
const ISSUE_ROWS = [
  { issueId: '9001', vehicleId: '104', fleetVehicleId: 'NP6923', domicile: 'ATL2', group: 'G', severity: 'CRITICAL', state: 'UNDERINFLATION', position: 'R1IC', positionName: 'Right Steer', dateDetected: '2026-11-22T13:00:00Z', detectedEt: '', muted: false },
  { issueId: '9003', vehicleId: '101', fleetVehicleId: '122269', domicile: 'DFW5', group: 'G', severity: 'CRITICAL', state: 'LEAK', position: 'L1IC', positionName: 'Left Steer', dateDetected: '2026-11-22T12:00:00Z', detectedEt: '', muted: false },
  { issueId: '9004', vehicleId: '101', fleetVehicleId: '122269', domicile: 'DFW5', group: 'G', severity: 'MINOR', state: 'LEAK', position: 'R2OC', positionName: 'Right Drive Outer', dateDetected: '2026-11-21T12:00:00Z', detectedEt: '', muted: false },
];

let pullImpl = null;
const session = {
  status: vi.fn(() => ({ ok: true, state: 'connected', secondsLeft: 100, lastCode: null, lastPullAt: null })),
  openLoginWindow: vi.fn(async () => ({ ok: true, state: 'connected' })),
  logout: vi.fn(() => ({ ok: true, state: 'expired' })),
};
const watcher = {
  status: vi.fn(() => ({ alerts: 'off', minutes: 5, lastPollAt: null, lastNewCount: 0 })),
  start: vi.fn(async () => ({ ok: true, status: { alerts: 'polling', minutes: 5, lastPollAt: null, lastNewCount: 0 } })),
  stop: vi.fn(() => ({ ok: true, status: { alerts: 'off', minutes: 5, lastPollAt: null, lastNewCount: 0 } })),
  pollNow: vi.fn(async () => ({ ok: true, newCount: 2 })),
};
const client = {
  lookupUnit: vi.fn(async (id) => ({ ok: true, unit: unit(id, 'ATL2') })),
  bulkLookup: vi.fn((list, o) => pullImpl(list, o)),
  fleetTires: vi.fn((o) => pullImpl(null, o)),
  listIssues: vi.fn(async () => ({ ok: true, rows: ISSUE_ROWS.slice(), vehicles: 2, domiciles: ['ATL2', 'DFW5'], pulledAt: '2026-11-22T15:00:00.000Z' })),
  crossLinkCriticalNoCase: vi.fn(realClient.crossLinkCriticalNoCase),
};
const dtnaStore = { all: vi.fn(() => [{ unitId: '122269', caseStatus: 'Open' }]) };
const store = { load: vi.fn(() => ({ rows: [{ equipmentId: 'STORED1' }] })) };
const ctx = { lastData: { rows: [] }, sendToWindow: vi.fn(), mainWindow: null };
require('../src/ipc/aperia').registerAperiaIPC(ctx, { client, session, watcher, exporter, dtnaStore, store });

const fakes = [session, watcher, client, dtnaStore, store];
const fakeCalls = () => fakes.reduce((n, f) => n + Object.values(f).reduce((m, fn) => m + fn.mock.calls.length, 0), 0);
const REG_CALLS = fakeCalls();
const call = (ch, p) => handlers[ch]({}, p);
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const progress = () => ctx.sendToWindow.mock.calls.filter((c) => c[0] === 'aperia:progress').map((c) => c[1]);

function deferredPull(results) {
  let release;
  const gate = new Promise((r) => { release = r; });
  pullImpl = async (_list, o) => {
    o.onProgress({ done: 1, total: results.length, failed: 0 });
    await gate;
    if (o.signal.aborted) return { ok: true, results: results.slice(0, 1), total: results.length, failed: 0, cancelled: true };
    o.onProgress({ done: results.length, total: results.length, failed: 1 });
    return { ok: true, results, total: results.length, failed: 1, cancelled: false };
  };
  return () => release();
}
const BULK_RESULTS = [
  { assetId: 'NP6923', found: true, unit: unit('NP6923', 'ATL2') },
  { assetId: '122269', found: true, unit: unit('122269', 'DFW5') },
  { assetId: 'NOPE', found: false, code: 'APERIA_UNIT_NOT_FOUND' },
];
const etDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

afterAll(() => {
  if (prevElectron) require.cache[electronPath] = prevElectron; else delete require.cache[electronPath];
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});
beforeEach(async () => {
  await flush();
  vi.clearAllMocks();
  ctx.lastData = { rows: [] };
});

const CHANNELS = ['aperia:bulk', 'aperia:export', 'aperia:fleet-tires', 'aperia:issues', 'aperia:login', 'aperia:logout', 'aperia:poll-now', 'aperia:start-alerts', 'aperia:status', 'aperia:stop-alerts', 'aperia:unit'];

describe('registration, preload and index.js', () => {
  it('registers exactly the eleven aperia:* channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(CHANNELS);
  });

  it('registration calls no client / session / watcher function and hooks before-quit -> watcher.stop', () => {
    expect(REG_CALLS).toBe(0);
    const q = appOnce.filter((x) => x[0] === 'before-quit');
    expect(q).toHaveLength(1);
    q[0][1]();
    expect(watcher.stop).toHaveBeenCalledTimes(1);
  });

  it('preload exposes aperia with exactly the 13 pinned keys in order, each on its channel', () => {
    const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
    const m = pre.match(/expose\('aperia',\s*\{([\s\S]*?)\n\}\);/);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
    expect(keys).toEqual(['login', 'logout', 'status', 'unit', 'bulk', 'fleetTires', 'issues', 'startAlerts', 'stopAlerts', 'pollNow', 'exportBulk', 'onProgress', 'onAlert']);
    const b = m[1];
    expect(b).toMatch(/login:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('aperia:login'\)/);
    expect(b).toMatch(/logout:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('aperia:logout'\)/);
    expect(b).toMatch(/status:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('aperia:status'\)/);
    expect(b).toMatch(/unit:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:unit',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/bulk:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:bulk',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/fleetTires:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:fleet-tires',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/issues:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:issues',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/startAlerts:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:start-alerts',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/stopAlerts:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('aperia:stop-alerts'\)/);
    expect(b).toMatch(/pollNow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('aperia:poll-now'\)/);
    expect(b).toMatch(/exportBulk:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('aperia:export',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/onProgress:\s*\(cb\)\s*=>\s*on\('aperia:progress',\s*cb\)/);
    expect(b).toMatch(/onAlert:\s*\(cb\)\s*=>\s*on\('aperia:alert',\s*cb\)/);
    // Appended at the END of preload.js, after the zoomHub block.
    expect(pre.indexOf("expose('aperia'")).toBeGreaterThan(pre.indexOf("expose('zoomHub'"));
    expect(pre.trimEnd().endsWith('});')).toBe(true);
    expect(pre.slice(pre.indexOf("expose('aperia'")).match(/expose\(/g)).toHaveLength(1);
  });

  it('src/ipc/index.js has exactly one registerAperiaIPC(ctx); and one require, right after the fleet-freshness lines', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(idx.match(/^\s*registerAperiaIPC\(ctx\);/gm) || []).toHaveLength(1);
    expect(idx.match(/require\('\.\/aperia'\)/g) || []).toHaveLength(1);
    expect(idx).toMatch(/const \{ registerFleetFreshnessIPC \} = require\('\.\/fleet-freshness'\);\nconst \{ registerAperiaIPC \}\s*= require\('\.\/aperia'\);/);
    expect(idx).toMatch(/registerFleetFreshnessIPC\(ctx\);\n\s*registerAperiaIPC\(ctx\);/);
  });

  it("aperia:* channel strings under src/ live only in src/ipc/aperia.js (the watcher sends 'aperia:alert')", () => {
    const hits = {};
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js')) {
          const text = fs.readFileSync(p, 'utf8');
          if (!text.includes('aperia:')) continue;
          const found = [...text.matchAll(/aperia:[a-z][a-z-]*/g)].map((x) => x[0]);
          if (found.length) hits[path.relative(path.join(ROOT, 'src'), p).replace(/\\/g, '/')] = Array.from(new Set(found)).sort();
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    // Phase E: the background sign-in pushes its status changes on the same aperia:alert event.
    expect(Object.keys(hits).sort()).toEqual(['aperia/auto-auth.js', 'aperia/watcher.js', 'ipc/aperia.js']);
    expect(hits['aperia/watcher.js']).toEqual(['aperia:alert']);
    expect(hits['aperia/auto-auth.js']).toEqual(['aperia:alert']);
    for (const ch of CHANNELS.concat(['aperia:progress'])) expect(hits['ipc/aperia.js']).toContain(ch);
  }, 60000);
});

describe('status / login / logout', () => {
  it('status merges session.status() and watcher.status() with no client call', async () => {
    expect(await call('aperia:status')).toEqual({ ok: true, state: 'connected', secondsLeft: 100, lastCode: null, lastPullAt: null, alerts: 'off', minutes: 5, lastPollAt: null, lastNewCount: 0 });
    expect(client.lookupUnit).not.toHaveBeenCalled();
    expect(client.listIssues).not.toHaveBeenCalled();
  });

  it('login opens the sign-in window with ctx; failure codes pass through', async () => {
    expect(await call('aperia:login')).toEqual({ ok: true, state: 'connected' });
    expect(session.openLoginWindow).toHaveBeenCalledWith(ctx);
    session.openLoginWindow.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_TIMEOUT' });
    expect(await call('aperia:login')).toEqual({ ok: false, code: 'APERIA_SIGNIN_TIMEOUT' });
  });

  it('a throwing handler -> APERIA_INTERNAL with no message', async () => {
    session.status.mockImplementationOnce(() => { throw new Error('boom secret'); });
    expect(await call('aperia:status')).toEqual({ ok: false, code: 'APERIA_INTERNAL' });
  });
});

describe('aperia:unit', () => {
  it('trims the id, passes ctx, returns { ok, unit }', async () => {
    const r = await call('aperia:unit', { assetId: '  NP6923 ' });
    expect(r).toEqual({ ok: true, unit: unit('NP6923', 'ATL2') });
    expect(client.lookupUnit).toHaveBeenCalledWith('NP6923', ctx);
    client.lookupUnit.mockResolvedValueOnce({ ok: false, code: 'APERIA_UNIT_NOT_FOUND' });
    expect(await call('aperia:unit', { assetId: 'X1' })).toEqual({ ok: false, code: 'APERIA_UNIT_NOT_FOUND' });
  });
});

describe('aperia:bulk / aperia:fleet-tires / aperia:export', () => {
  it('bulk: de-duplicated list, busy, progress, final event with rows + domiciles, then TSV / xls export with the domicile filter', async () => {
    const release = deferredPull(BULK_RESULTS);
    const a = await call('aperia:bulk', { list: [' NP6923', 'np6923', '122269', 'NOPE'] });
    expect(a).toEqual({ ok: true, jobId: expect.stringMatching(/^a[a-z0-9]{1,15}$/) });
    await flush();
    expect(client.bulkLookup).toHaveBeenCalledTimes(1);
    expect(client.bulkLookup.mock.calls[0][0]).toEqual(['NP6923', '122269', 'NOPE']);
    expect(client.bulkLookup.mock.calls[0][1].ctx).toBe(ctx);
    expect(await call('aperia:bulk', { list: ['X'] })).toEqual({ ok: false, code: 'APERIA_BUSY', jobId: a.jobId });
    expect(await call('aperia:fleet-tires', {})).toEqual({ ok: false, code: 'APERIA_BUSY', jobId: a.jobId });
    expect(await call('aperia:issues', {})).toEqual({ ok: false, code: 'APERIA_BUSY', jobId: a.jobId });
    expect(await call('aperia:export', { jobId: a.jobId, format: 'tsv' })).toEqual({ ok: false, code: 'APERIA_BUSY' });
    release();
    await flush();
    const ev = progress();
    expect(ev.slice(0, 2)).toEqual([
      { jobId: a.jobId, kind: 'bulk', done: 1, total: 3, failed: 0, finished: false },
      { jobId: a.jobId, kind: 'bulk', done: 3, total: 3, failed: 1, finished: false },
    ]);
    const fin = ev[2];
    expect(fin).toMatchObject({ jobId: a.jobId, kind: 'bulk', done: 3, total: 3, failed: 1, finished: true, cancelled: false, domiciles: ['ATL2', 'DFW5'] });
    expect(fin.rows).toEqual(exporter.tireRows(BULK_RESULTS));
    expect(fin.rows.map((r) => r.lookup)).toEqual(['OK', 'OK', 'NOT FOUND']);

    const t = await call('aperia:export', { jobId: a.jobId, format: 'tsv', domicile: 'DFW5' });
    expect(t).toEqual({ ok: true, filename: 'aperia-tires-' + etDay() + '.tsv' });
    const lines = fs.readFileSync(path.join(DOWNLOADS, t.filename), 'utf8').trim().split('\r\n');
    expect(lines[0].split('\t')).toEqual(exporter.TIRE_COLUMNS);
    expect(lines).toHaveLength(2);
    expect(lines[1].split('\t').slice(0, 2)).toEqual(['122269', 'DFW5']);
    expect(lines[1]).toContain('-30');

    const x = await call('aperia:export', { jobId: a.jobId, format: 'xls' });
    expect(x).toEqual({ ok: true, filename: 'aperia-tires-' + etDay() + '.xls' });
    const xls = fs.readFileSync(path.join(DOWNLOADS, x.filename), 'utf8');
    expect(xls).toContain('<Workbook');
    expect(xls).toContain('NP6923');
    expect(xls).toContain('122269');
    expect(await call('aperia:export', { jobId: 'anotthere', format: 'tsv' })).toEqual({ ok: false, code: 'APERIA_JOB_NOT_FOUND' });
  });

  it('fleet-tires: final event carries domiciles only; export file is aperia-fleet-tires-*', async () => {
    const release = deferredPull(BULK_RESULTS);
    const a = await call('aperia:fleet-tires', {});
    expect(a.ok).toBe(true);
    await flush();
    expect(client.fleetTires).toHaveBeenCalledTimes(1);
    expect(client.fleetTires.mock.calls[0][0].ctx).toBe(ctx);
    release();
    await flush();
    const fin = progress().pop();
    expect(fin).toEqual({ jobId: a.jobId, kind: 'fleet', done: 3, total: 3, failed: 1, finished: true, cancelled: false, domiciles: ['ATL2', 'DFW5'] });
    expect(await call('aperia:export', { jobId: a.jobId, format: 'tsv', domicile: 'ATL2' })).toEqual({ ok: true, filename: 'aperia-fleet-tires-' + etDay() + '.tsv' });
  });

  it('a failed pull reports its code on the final event and frees the slot', async () => {
    pullImpl = async () => ({ ok: false, code: 'APERIA_SESSION_EXPIRED', results: [], total: 2, failed: 2, cancelled: false });
    const a = await call('aperia:bulk', { list: ['A1', 'A2'] });
    await flush();
    expect(progress().pop()).toMatchObject({ jobId: a.jobId, finished: true, code: 'APERIA_SESSION_EXPIRED', rows: [], domiciles: [] });
    pullImpl = async () => { throw new Error('boom'); };
    const b = await call('aperia:fleet-tires', {});
    expect(b.ok).toBe(true);
    await flush();
    expect(progress().pop()).toMatchObject({ jobId: b.jobId, finished: true, code: 'APERIA_INTERNAL' });
  });

  it('logout stops the watcher, aborts the running job and signs out', async () => {
    const release = deferredPull(BULK_RESULTS);
    const a = await call('aperia:bulk', { list: ['NP6923', '122269'] });
    await flush();
    const r = await call('aperia:logout');
    expect(r).toEqual({ ok: true, state: 'expired' });
    expect(watcher.stop).toHaveBeenCalledTimes(1);
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(client.bulkLookup.mock.calls[0][1].signal.aborted).toBe(true);
    release();
    await flush();
    expect(progress().pop()).toMatchObject({ jobId: a.jobId, finished: true, cancelled: true });
  });
});

describe('aperia:issues', () => {
  it('active: returns rows / domiciles / pulledAt / count and keeps an issues job for export', async () => {
    const r = await call('aperia:issues', {});
    expect(r).toEqual({ ok: true, jobId: expect.stringMatching(/^a[a-z0-9]+$/), rows: ISSUE_ROWS, domiciles: ['ATL2', 'DFW5'], pulledAt: '2026-11-22T15:00:00.000Z', count: 3 });
    expect(client.listIssues.mock.calls[0][0]).toBe(ctx);
    expect(client.crossLinkCriticalNoCase).not.toHaveBeenCalled();
    expect(dtnaStore.all).not.toHaveBeenCalled();
    const t = await call('aperia:export', { jobId: r.jobId, format: 'tsv', domicile: 'DFW5' });
    expect(t).toEqual({ ok: true, filename: 'aperia-issues-' + etDay() + '.tsv' });
    const lines = fs.readFileSync(path.join(DOWNLOADS, t.filename), 'utf8').trim().split('\r\n');
    expect(lines[0].split('\t')).toEqual(exporter.ISSUE_COLUMNS);
    expect(lines.slice(1).map((l) => l.split('\t')[9])).toEqual(['9003', '9004']);
    client.listIssues.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    expect(await call('aperia:issues', { type: 'active' })).toEqual({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
  });

  it('critical-no-case: cross-links with ctx.lastData rows and the dtna cache (open case hides the unit)', async () => {
    ctx.lastData = { rows: [{ equipmentId: 'NP6923' }] };
    const r = await call('aperia:issues', { type: 'critical-no-case' });
    expect(r.ok).toBe(true);
    expect(dtnaStore.all).toHaveBeenCalledTimes(1);
    expect(client.crossLinkCriticalNoCase.mock.calls[0][1]).toEqual({ dtnaEntries: [{ unitId: '122269', caseStatus: 'Open' }], fleetRows: [{ equipmentId: 'NP6923' }] });
    expect(store.load).not.toHaveBeenCalled();
    expect(r.count).toBe(1);
    expect(r.rows[0]).toMatchObject({ fleetVehicleId: 'NP6923', domicile: 'ATL2', criticalCount: 1, inFleet: true, closedDtnaCases: 0 });
    expect(r.domiciles).toEqual(['ATL2']);
    const t = await call('aperia:export', { jobId: r.jobId, format: 'tsv' });
    expect(t).toEqual({ ok: true, filename: 'aperia-critical-no-case-' + etDay() + '.tsv' });
    const lines = fs.readFileSync(path.join(DOWNLOADS, t.filename), 'utf8').trim().split('\r\n');
    expect(lines[0].split('\t')).toEqual(exporter.CROSSLINK_COLUMNS);
    expect(lines[1].split('\t').slice(0, 3)).toEqual(['NP6923', 'ATL2', '1']);
  });

  it('critical-no-case falls back to the stored fleetData rows', async () => {
    dtnaStore.all.mockReturnValueOnce([{ unitId: '122269', caseStatus: 'Closed' }]);
    const r = await call('aperia:issues', { type: 'critical-no-case' });
    expect(store.load).toHaveBeenCalledWith('fleetData', {});
    expect(client.crossLinkCriticalNoCase.mock.calls[0][1].fleetRows).toEqual([{ equipmentId: 'STORED1' }]);
    expect(r.rows.map((x) => x.fleetVehicleId)).toEqual(['NP6923', '122269']);
    expect(r.rows[1]).toMatchObject({ closedDtnaCases: 1, inFleet: false });
  });
});

describe('alerts', () => {
  it('start-alerts passes minutes and ctx; stop-alerts / poll-now forward', async () => {
    expect(await call('aperia:start-alerts', { minutes: 10 })).toEqual({ ok: true, status: { alerts: 'polling', minutes: 5, lastPollAt: null, lastNewCount: 0 } });
    expect(watcher.start).toHaveBeenCalledWith({ minutes: 10, ctx });
    await call('aperia:start-alerts', {});
    expect(watcher.start.mock.calls[1][0]).toEqual({ minutes: undefined, ctx });
    watcher.start.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    expect(await call('aperia:start-alerts')).toEqual({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    expect((await call('aperia:stop-alerts')).ok).toBe(true);
    expect(watcher.stop).toHaveBeenCalledTimes(1);
    expect(await call('aperia:poll-now')).toEqual({ ok: true, newCount: 2 });
    expect(watcher.pollNow).toHaveBeenCalledWith(ctx);
    watcher.pollNow.mockResolvedValueOnce({ ok: false, code: 'APERIA_ALERTS_OFF' });
    expect(await call('aperia:poll-now')).toEqual({ ok: false, code: 'APERIA_ALERTS_OFF' });
  });
});

describe('invalid inputs', () => {
  it('-> APERIA_INVALID_INPUT with the field and zero client / watcher calls', async () => {
    const cases = [
      ['aperia:unit', 'x', 'payload'],
      ['aperia:unit', [1], 'payload'],
      ['aperia:unit', {}, 'assetId'],
      ['aperia:unit', { assetId: 5 }, 'assetId'],
      ['aperia:unit', { assetId: '   ' }, 'assetId'],
      ['aperia:unit', { assetId: 'x'.repeat(41) }, 'assetId'],
      ['aperia:unit', { assetId: 'NP<script>' }, 'assetId'],
      ['aperia:unit', { assetId: '../x/y' }, 'assetId'],
      ['aperia:bulk', 'x', 'payload'],
      ['aperia:bulk', {}, 'list'],
      ['aperia:bulk', { list: [] }, 'list'],
      ['aperia:bulk', { list: 'NP6923' }, 'list'],
      ['aperia:bulk', { list: Array.from({ length: 501 }, (_, i) => 'U' + i) }, 'list'],
      ['aperia:bulk', { list: ['NP6923', 7] }, 'list'],
      ['aperia:bulk', { list: ['NP6923', ' '] }, 'list'],
      ['aperia:bulk', { list: ['NP6923', 'bad!'] }, 'list'],
      ['aperia:fleet-tires', 'x', 'payload'],
      ['aperia:issues', { type: 'all' }, 'type'],
      ['aperia:issues', 5, 'payload'],
      ['aperia:start-alerts', { minutes: 0 }, 'minutes'],
      ['aperia:start-alerts', { minutes: 61 }, 'minutes'],
      ['aperia:start-alerts', { minutes: 2.5 }, 'minutes'],
      ['aperia:start-alerts', { minutes: '5' }, 'minutes'],
      ['aperia:start-alerts', [], 'payload'],
      ['aperia:export', { jobId: 'j1', format: 'tsv' }, 'jobId'],
      ['aperia:export', { jobId: '../x', format: 'tsv' }, 'jobId'],
      ['aperia:export', { jobId: 'a1', format: 'csv' }, 'format'],
      ['aperia:export', { jobId: 'a1', format: 'tsv', domicile: 5 }, 'domicile'],
      ['aperia:export', { jobId: 'a1', format: 'tsv', domicile: 'x'.repeat(81) }, 'domicile'],
      ['aperia:export', 'x', 'payload'],
    ];
    for (const [ch, p, field] of cases) {
      expect(await call(ch, p), ch + ' ' + JSON.stringify(p).slice(0, 40)).toEqual({ ok: false, code: 'APERIA_INVALID_INPUT', field });
    }
    expect(fakeCalls()).toBe(0);
  });

  it('a 500-entry list is accepted', async () => {
    pullImpl = async () => ({ ok: true, results: [], total: 500, failed: 0, cancelled: false });
    const r = await call('aperia:bulk', { list: Array.from({ length: 500 }, (_, i) => 'U' + i) });
    expect(r.ok).toBe(true);
    await flush();
    expect(client.bulkLookup.mock.calls[0][0]).toHaveLength(500);
  });
});
