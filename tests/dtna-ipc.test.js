// DTNA Phase A steps 7-8: src/ipc/dtna.js channels, the preload dtna surface, the index.js
// registration and the warm-scheduler removal. electron is a stub; client / session are fakes.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_ID, NO_RO_CASE_ID, CASE_RECORD, NO_RO_RECORD, RO_LIST, COMMENTS, NO_RO_COMMENTS } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-ipc-'));
const DATA = path.join(TMP, 'data');
const DOWNLOADS = path.join(TMP, 'downloads');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const handlers = {};
const electronPath = require.resolve('electron');
const prevElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    BrowserWindow: function BrowserWindow() { throw new Error('no windows in this test'); },
    app: { getPath: (k) => (k === 'downloads' ? DOWNLOADS : TMP) },
  },
};
require('../src/config/paths').setDataDir(DATA);
const store = require('../src/store');
const realClient = require('../src/dtna/client');

const caseUrl = (id) => 'https://dtna.my.site.com/Servicetracker/s/case/' + id + '/detail';
const NOW = Date.now();
const ENTRY = realClient.normalizeCase(CASE_RECORD, RO_LIST[0], COMMENTS, { caseId: CASE_ID, now: NOW });
const ENTRY2 = realClient.normalizeCase(NO_RO_RECORD, null, NO_RO_COMMENTS, { caseId: NO_RO_CASE_ID, now: NOW });

let statusListener = null;
const session = {
  status: vi.fn(() => ({ ok: true, state: 'connected', contextAgeSec: 5, lastPullAt: null, lastCode: null })),
  openLoginWindow: vi.fn(async () => ({ ok: true, state: 'connected' })),
  onStatus: vi.fn((fn) => { statusListener = fn; return () => {}; }),
  setPulling: vi.fn(),
};
let bulkImpl = null;
const client = {
  resolveCaseForRow: vi.fn(async () => ({ ok: true, caseId: CASE_ID, via: 'cache' })),
  pullCase: vi.fn(async () => ({ ok: true, entry: ENTRY })),
  listCaseIds: vi.fn(async () => ({ ok: true, ids: [CASE_ID, NO_RO_CASE_ID] })),
  bulkPull: vi.fn((o) => bulkImpl(o)),
  toTSV: realClient.toTSV,
  exportRows: realClient.exportRows,
};
const deepScan = { rebuildUnitTimeline: vi.fn(async () => ({ ok: true })) };
const ctx = { lastData: { rows: [] }, sendToWindow: vi.fn(), pushData: vi.fn(), pushStatus: vi.fn() };
require('../src/ipc/dtna').registerDtnaIPC(ctx, { client, session, deepScan });

const call = (ch, p) => handlers[ch]({}, p);
const clientCalls = () => ['resolveCaseForRow', 'pullCase', 'listCaseIds', 'bulkPull'].reduce((n, k) => n + client[k].mock.calls.length, 0);
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const progressEvents = () => ctx.sendToWindow.mock.calls.filter((c) => c[0] === 'dtna:progress').map((c) => c[1]);

afterAll(() => {
  if (prevElectron) require.cache[electronPath] = prevElectron; else delete require.cache[electronPath];
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});
beforeEach(() => {
  vi.clearAllMocks();
  ctx.lastData = { rows: [] };
});

const CHANNELS = ['dtna:bulk-cancel', 'dtna:bulk-pull', 'dtna:draft-comment', 'dtna:export', 'dtna:list-cases', 'dtna:login', 'dtna:post-comment', 'dtna:pull-unit', 'dtna:status'];

describe('registration and preload', () => {
  it('registers exactly the nine dtna:* channels', () => {
    expect(Object.keys(handlers).filter((k) => k.startsWith('dtna:')).sort()).toEqual(CHANNELS);
    expect(Object.keys(handlers).sort()).toEqual(CHANNELS);
  });

  it('preload exposes dtna with exactly the eleven keys on their channels', () => {
    const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const m = pre.match(/expose\('dtna',\s*\{([\s\S]*?)\n\}\);/);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]);
    expect(keys).toEqual(['status', 'login', 'pullUnit', 'listCases', 'bulkPull', 'bulkCancel', 'exportBulk', 'draftComment', 'postComment', 'onStatus', 'onProgress']);
    const b = m[1];
    expect(b).toMatch(/status:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dtna:status'\)/);
    expect(b).toMatch(/login:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dtna:login'\)/);
    expect(b).toMatch(/pullUnit:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:pull-unit',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/listCases:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:list-cases',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/bulkPull:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:bulk-pull',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/bulkCancel:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:bulk-cancel',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/exportBulk:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:export',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/onStatus:\s*\(cb\)\s*=>\s*on\('dtna:status-changed',\s*cb\)/);
    expect(b).toMatch(/onProgress:\s*\(cb\)\s*=>\s*on\('dtna:progress',\s*cb\)/);
    expect(b).toMatch(/draftComment:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:draft-comment',\s*p \|\| \{\}\)/);
    expect(b).toMatch(/postComment:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('dtna:post-comment',\s*p \|\| \{\}\)/);
  });

  it('only src/ipc/dtna.js contains dtna:draft-comment / dtna:post-comment under src/', () => {
    const hits = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js') && /dtna:(draft|post)-comment/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(path.join(ROOT, 'src'), p).replace(/\\/g, '/'));
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(hits).toEqual(['ipc/dtna.js']);
  });

  it('src/ipc/index.js registers it exactly once and no longer starts the warm scheduler', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'index.js'), 'utf8');
    expect(idx.match(/^\s*registerDtnaIPC\(ctx\);/gm) || []).toHaveLength(1);
    expect(idx).toMatch(/const \{ registerDtnaIPC \}\s*= require\('\.\/dtna'\);/);
    expect(idx).not.toContain('startWarmScheduler');
    expect(idx.indexOf('registerDtnaIPC(ctx);')).toBeGreaterThan(idx.indexOf('registerPendingEstIPC(ctx);'));
  });

  it('vendor_session exports only warmVendorSession', () => {
    const vs = require('../src/scrapers/vendor_session');
    expect(Object.keys(vs)).toEqual(['warmVendorSession']);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'scrapers', 'vendor_session.js'), 'utf8');
    expect(src).not.toMatch(/setInterval|startWarmScheduler|MORNING_HOUR/);
  });

  it('src/ipc/dtna.js never references _callApexRaw', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'dtna.js'), 'utf8')).not.toContain('_callApexRaw');
  });
});

describe('dtna:status / dtna:login / status pushes', () => {
  it('status returns the session status with no network', async () => {
    expect(await call('dtna:status')).toEqual({ ok: true, state: 'connected', contextAgeSec: 5, lastPullAt: null, lastCode: null });
    expect(clientCalls()).toBe(0);
  });
  it('login opens the sign-in window with ctx', async () => {
    expect(await call('dtna:login')).toEqual({ ok: true, state: 'connected' });
    expect(session.openLoginWindow).toHaveBeenCalledWith(ctx);
    session.openLoginWindow.mockResolvedValueOnce({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' });
    expect(await call('dtna:login')).toEqual({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' });
  });
  it('session status changes go to dtna:status-changed', () => {
    expect(typeof statusListener).toBe('function');
    const s = { ok: true, state: 'expired', contextAgeSec: 2000, lastPullAt: null, lastCode: 'DTNA_SIGNIN_REQUIRED' };
    statusListener(s);
    expect(ctx.sendToWindow).toHaveBeenCalledWith('dtna:status-changed', s);
  });
});

describe('dtna:pull-unit', () => {
  const ROW = () => ({ equipmentId: '122269', workRequestId: 'WR1', vendor: 'HORWITH FREIGHTLINER', created: '2026-09-20T12:00:00Z' });

  it('happy path: row fields set, fleetData saved, one partial push, one rebuild', async () => {
    store.save('fleetData', { rows: [ROW(), { equipmentId: 'OTHER' }] });
    ctx.lastData = { rows: [{ equipmentId: 'OTHER' }] };   // smaller: the stored rows are the base
    const r = await call('dtna:pull-unit', { equipmentId: ' 122269 ' });
    expect(r).toEqual({ ok: true, caseId: CASE_ID, commentCount: ENTRY.commentCount, updatedAt: ENTRY.pulledAt, joinedWr: 'WR1' });
    const saved = store.load('fleetData', {}).rows.find((x) => x.equipmentId === '122269');
    expect(saved).toMatchObject({ offsiteShopEventUrl: caseUrl(CASE_ID), savedOffsiteUrl: caseUrl(CASE_ID), asistSource: 'dtna', asistLabel: 'DTNA Case', asistNotes: ENTRY.offsiteText, _offsiteWrId: 'WR1' });
    expect(store.load('fleetData', {}).rows).toHaveLength(2);
    expect(ctx.pushData).toHaveBeenCalledTimes(1);
    const push = ctx.pushData.mock.calls[0][0];
    expect(push).toMatchObject({ partialMerge: true, _partial: 'dtna-pull-unit' });
    expect(push.rows).toHaveLength(1);
    expect(push.rows[0].equipmentId).toBe('122269');
    await flush();
    expect(deepScan.rebuildUnitTimeline).toHaveBeenCalledTimes(1);
    expect(deepScan.rebuildUnitTimeline.mock.calls[0][1]).toEqual({ pushData: ctx.pushData, pushStatus: ctx.pushStatus });
    expect(session.setPulling.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(ctx.lastData.rows).toEqual([{ equipmentId: 'OTHER' }]);
  });

  it('uses ctx.lastData rows when they are the larger set', async () => {
    store.save('fleetData', { rows: [] });
    ctx.lastData = { rows: [ROW()] };
    const r = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(r.ok).toBe(true);
    expect(ctx.lastData.rows[0].asistSource).toBe('dtna');
    expect(store.load('fleetData', {}).rows[0].asistSource).toBe('dtna');
  });

  it('a non-DTNA offsite is refused with no client call', async () => {
    store.save('fleetData', { rows: [Object.assign(ROW(), { offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/123' })] });
    expect(await call('dtna:pull-unit', { equipmentId: '122269' })).toEqual({ ok: false, code: 'DTNA_NON_DTNA_OFFSITE' });
    expect(clientCalls()).toBe(0);
    expect(session.setPulling).not.toHaveBeenCalled();
  });

  it('unknown unit -> DTNA_UNIT_NOT_FOUND', async () => {
    store.save('fleetData', { rows: [ROW()] });
    expect(await call('dtna:pull-unit', { equipmentId: '999999' })).toEqual({ ok: false, code: 'DTNA_UNIT_NOT_FOUND' });
    expect(clientCalls()).toBe(0);
  });

  it('client codes pass through and pulling is cleared', async () => {
    store.save('fleetData', { rows: [ROW()] });
    client.resolveCaseForRow.mockResolvedValueOnce({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(await call('dtna:pull-unit', { equipmentId: '122269' })).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    client.pullCase.mockResolvedValueOnce({ ok: false, code: 'DTNA_APEX_ERROR' });
    expect(await call('dtna:pull-unit', { equipmentId: '122269' })).toEqual({ ok: false, code: 'DTNA_APEX_ERROR' });
    client.pullCase.mockRejectedValueOnce(new Error('boom'));
    expect(await call('dtna:pull-unit', { equipmentId: '122269' })).toEqual({ ok: false, code: 'DTNA_INTERNAL' });
    expect(session.setPulling.mock.calls.map((c) => c[0])).toEqual([true, false, true, false, true, false]);
    expect(ctx.pushData).not.toHaveBeenCalled();
  });
});

describe('dtna:list-cases', () => {
  it('returns the count only (ids stay in main)', async () => {
    expect(await call('dtna:list-cases', {})).toEqual({ ok: true, count: 2 });
    expect(await call('dtna:list-cases', { filterId: '00B6T000007X74uUAC' })).toEqual({ ok: true, count: 2 });
    expect(client.listCaseIds.mock.calls[1][0]).toEqual({ filterId: '00B6T000007X74uUAC' });
  });
});

describe('dtna:bulk-pull / dtna:bulk-cancel / dtna:export', () => {
  function deferredBulk() {
    let release;
    const gate = new Promise((r) => { release = r; });
    bulkImpl = async (o) => {
      o.onProgress({ done: 1, total: 2, failed: 0 });
      await gate;
      if (o.signal.aborted) return { ok: true, results: [ENTRY], total: 2, failed: 0, cancelled: true };
      o.onProgress({ done: 2, total: 2, failed: 0 });
      return { ok: true, results: [ENTRY, ENTRY2], total: 2, failed: 0, cancelled: false };
    };
    return () => release();
  }

  it('single-flight, progress events, final event, then export tsv / xls', async () => {
    const release = deferredBulk();
    const a = await call('dtna:bulk-pull', { includeComments: true });
    expect(a).toEqual({ ok: true, jobId: expect.stringMatching(/^j[a-z0-9]+$/) });
    const b = await call('dtna:bulk-pull', { includeComments: false });
    expect(b).toEqual({ ok: false, code: 'DTNA_BUSY', jobId: a.jobId });
    await flush();
    expect(client.bulkPull).toHaveBeenCalledTimes(1);
    expect(client.bulkPull.mock.calls[0][0].includeComments).toBe(true);
    expect(await call('dtna:export', { jobId: a.jobId, format: 'tsv' })).toEqual({ ok: false, code: 'DTNA_BUSY' });
    release();
    await flush(40);
    expect(progressEvents()).toEqual([
      { jobId: a.jobId, done: 1, total: 2, failed: 0, finished: false },
      { jobId: a.jobId, done: 2, total: 2, failed: 0, finished: false },
      { jobId: a.jobId, done: 2, total: 2, failed: 0, finished: true, cancelled: false },
    ]);
    expect(session.setPulling.mock.calls.map((c) => c[0])).toEqual([true, false]);

    const t = await call('dtna:export', { jobId: a.jobId, format: 'tsv' });
    const date = new Date().toISOString().slice(0, 10);
    expect(t).toEqual({ ok: true, filename: 'dtna-cases-' + date + '.tsv' });
    const tsv = fs.readFileSync(path.join(DOWNLOADS, t.filename), 'utf8');
    expect(tsv.split('\r\n')[0].split('\t')).toEqual(realClient.CASE_COLUMNS);
    expect(tsv).toContain(CASE_ID);
    expect(tsv).toContain(NO_RO_CASE_ID);

    const c = await call('dtna:export', { jobId: a.jobId, format: 'tsv', mode: 'comments' });
    expect(c).toEqual({ ok: true, filename: 'dtna-comments-' + date + '.tsv' });
    expect(fs.readFileSync(path.join(DOWNLOADS, c.filename), 'utf8').split('\r\n')[0].split('\t')).toEqual(realClient.COMMENT_COLUMNS);

    const x = await call('dtna:export', { jobId: a.jobId, format: 'xls' });
    expect(x).toEqual({ ok: true, filename: 'dtna-cases-' + date + '.xls' });
    const xls = fs.readFileSync(path.join(DOWNLOADS, x.filename), 'utf8');
    expect(xls).toContain('<Workbook');
    expect(xls).toContain(CASE_ID);

    expect(await call('dtna:export', { jobId: 'jnotthere', format: 'tsv' })).toEqual({ ok: false, code: 'DTNA_JOB_NOT_FOUND' });
  });

  it('cancel aborts the running job; the final event says cancelled', async () => {
    const release = deferredBulk();
    const a = await call('dtna:bulk-pull', {});
    await flush();
    expect(await call('dtna:bulk-cancel', { jobId: a.jobId })).toEqual({ ok: true });
    expect(client.bulkPull.mock.calls[0][0].signal.aborted).toBe(true);
    release();
    await flush(40);
    const ev = progressEvents();
    expect(ev[ev.length - 1]).toEqual({ jobId: a.jobId, done: 1, total: 2, failed: 0, finished: true, cancelled: true });
    // A new job can start after the cancelled one finished.
    bulkImpl = async () => ({ ok: false, code: 'DTNA_SIGNIN_REQUIRED', results: [], total: 0, failed: 0, cancelled: false });
    const b = await call('dtna:bulk-pull', {});
    expect(b.ok).toBe(true);
    await flush(40);
    const last = progressEvents().pop();
    expect(last).toMatchObject({ jobId: b.jobId, finished: true, cancelled: false, code: 'DTNA_SIGNIN_REQUIRED' });
  });
});

describe('invalid inputs', () => {
  it('-> DTNA_INVALID_INPUT with the field and zero client calls', async () => {
    const cases = [
      ['dtna:pull-unit', 'x', 'payload'],
      ['dtna:pull-unit', {}, 'equipmentId'],
      ['dtna:pull-unit', { equipmentId: 5 }, 'equipmentId'],
      ['dtna:pull-unit', { equipmentId: '   ' }, 'equipmentId'],
      ['dtna:pull-unit', { equipmentId: 'x'.repeat(41) }, 'equipmentId'],
      ['dtna:list-cases', { filterId: 'bad!' }, 'filterId'],
      ['dtna:list-cases', [1], 'payload'],
      ['dtna:bulk-pull', { includeComments: 'yes' }, 'includeComments'],
      ['dtna:bulk-cancel', { jobId: '../x' }, 'jobId'],
      ['dtna:bulk-cancel', {}, 'jobId'],
      ['dtna:export', { jobId: 'j1', format: 'csv' }, 'format'],
      ['dtna:export', { jobId: 'j1', format: 'tsv', mode: 'all' }, 'mode'],
      ['dtna:export', { jobId: 'C:\\x', format: 'tsv' }, 'jobId'],
    ];
    for (const [ch, p, field] of cases) {
      expect(await call(ch, p)).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT', field });
    }
    expect(clientCalls()).toBe(0);
    expect(session.setPulling).not.toHaveBeenCalled();
  });
});

describe('dtna:pull-unit carry-over (Phase A review #1)', () => {
  it('passes commentsStale / commentsCode through; the row keeps the kept thread', async () => {
    store.save('fleetData', { rows: [{ equipmentId: '122269', workRequestId: 'WR1', vendor: 'HORWITH FREIGHTLINER' }] });
    client.pullCase.mockResolvedValueOnce({ ok: true, entry: ENTRY, commentsStale: true, commentsCode: 'DTNA_APEX_ERROR' });
    const r = await call('dtna:pull-unit', { equipmentId: '122269' });
    expect(r).toMatchObject({ ok: true, commentsStale: true, commentsCode: 'DTNA_APEX_ERROR', commentCount: ENTRY.commentCount });
    expect(store.load('fleetData', {}).rows[0].asistNotes).toBe(ENTRY.offsiteText);
  });
});

describe('dtna:draft-comment / dtna:post-comment', () => {
  const h2 = {};
  const writeGate = { requestWrite: vi.fn(async () => ({ ok: true, outcome: 'sent', id: 'rw_1', result: { commentId: 'a1Agx0000000099AAA' } })) };
  const commentDraft = { draftForCase: vi.fn(async () => ({ ok: true, aiDrafted: true, draft: 'Hello', noUpdate: false, droppedCount: 1 })) };
  const cache = { [CASE_ID]: ENTRY, [NO_RO_CASE_ID]: ENTRY2 };
  const dtnaStore = { get: vi.fn((id) => cache[id] || null) };
  let configured = true;
  const fakeWrites = { isPostConfigured: vi.fn(() => configured) };
  const ctx2 = { lastData: { rows: [{ equipmentId: '122269' }] }, sendToWindow: vi.fn() };
  // Own session stub so the top-level status listener is not replaced.
  const session2 = Object.assign({}, session, { onStatus: () => () => {} });
  require('../src/ipc/dtna').registerDtnaIPC(ctx2, { handle: (ch, fn) => { h2[ch] = fn; }, client, session: session2, deepScan, writeGate, writes: fakeWrites, commentDraft, dtnaStore });
  const h3 = {};
  require('../src/ipc/dtna').registerDtnaIPC(ctx2, { handle: (ch, fn) => { h3[ch] = fn; }, client, session: session2, deepScan, writeGate, commentDraft, dtnaStore });
  const c2 = (ch, p) => h2[ch]({}, p);
  const OK = { equipmentId: '122269', caseId: CASE_ID, text: 'Please send an ETA', aiDrafted: true };
  beforeEach(() => { configured = true; });

  it('real writes (shipped POST_COMMENT_PARAMS) -> one interactive dtnaComment approval request; no direct client call', async () => {
    writeGate.requestWrite.mockClear();
    const r = await h3['dtna:post-comment']({}, OK);
    expect(r).toMatchObject({ ok: true, outcome: 'sent' });
    expect(writeGate.requestWrite).toHaveBeenCalledTimes(1);
    expect(writeGate.requestWrite.mock.calls[0][0]).toMatchObject({ kind: 'dtnaComment', interactive: true, payload: { caseId: CASE_ID } });
    expect(clientCalls()).toBe(0);
    writeGate.requestWrite.mockClear();
  });

  it('unconfigured writes -> DTNA_POST_NOT_CONFIGURED, no approval request, no cache read', async () => {
    configured = false;
    dtnaStore.get.mockClear();
    expect(await c2('dtna:post-comment', OK)).toEqual({ ok: false, code: 'DTNA_POST_NOT_CONFIGURED' });
    expect(writeGate.requestWrite).not.toHaveBeenCalled();
    expect(dtnaStore.get).not.toHaveBeenCalled();
    expect(clientCalls()).toBe(0);
  });

  it('configured: not pulled -> DTNA_NOT_PULLED; no RO -> DTNA_NO_REPAIR_ORDER; nothing requested', async () => {
    expect(await c2('dtna:post-comment', Object.assign({}, OK, { caseId: '500gx0000000000ZZZ' }))).toEqual({ ok: false, code: 'DTNA_NOT_PULLED' });
    expect(await c2('dtna:post-comment', Object.assign({}, OK, { caseId: NO_RO_CASE_ID }))).toEqual({ ok: false, code: 'DTNA_NO_REPAIR_ORDER' });
    expect(writeGate.requestWrite).not.toHaveBeenCalled();
  });

  it('configured + pulled: one interactive dtnaComment request with the RO from the cache', async () => {
    const r = await c2('dtna:post-comment', Object.assign({}, OK, { repairOrderId: 'a0Xgx0000099999ZZZ' }));
    expect(r).toEqual({ ok: true, outcome: 'sent', id: 'rw_1', commentId: 'a1Agx0000000099AAA' });
    expect(writeGate.requestWrite).toHaveBeenCalledTimes(1);
    expect(writeGate.requestWrite.mock.calls[0][0]).toEqual({
      kind: 'dtnaComment', origin: 'unit-detail-dtna', unit: '122269', interactive: true, aiDrafted: true,
      payload: { caseId: CASE_ID, repairOrderId: ENTRY.repairOrderId, repairOrderNo: ENTRY.repairOrderNo, text: 'Please send an ETA' },
    });
    expect(JSON.stringify(r)).not.toContain('Please send an ETA');
  });

  it('gate outcomes pass through; a DTNA_* gate error becomes code', async () => {
    writeGate.requestWrite.mockResolvedValueOnce({ ok: false, outcome: 'pending-approval', id: 'rw_2', error: 'pending-approval: queued for your approval; nothing was sent to DTNA' });
    expect(await c2('dtna:post-comment', OK)).toEqual({ ok: false, outcome: 'pending-approval', id: 'rw_2' });
    writeGate.requestWrite.mockResolvedValueOnce({ ok: false, outcome: 'send-failed', id: 'rw_3', result: null, error: 'DTNA_APEX_ERROR' });
    expect(await c2('dtna:post-comment', OK)).toEqual({ ok: false, outcome: 'send-failed', id: 'rw_3', code: 'DTNA_APEX_ERROR' });
  });

  it('invalid inputs -> DTNA_INVALID_INPUT with the field, nothing requested', async () => {
    const cases = [
      [{ caseId: CASE_ID, text: 'x' }, 'equipmentId'],
      [Object.assign({}, OK, { caseId: 'bad' }), 'caseId'],
      [Object.assign({}, OK, { text: '   ' }), 'text'],
      [Object.assign({}, OK, { text: 'x'.repeat(2001) }), 'text'],
      [Object.assign({}, OK, { text: 5 }), 'text'],
      [Object.assign({}, OK, { aiDrafted: 'yes' }), 'aiDrafted'],
    ];
    for (const [p, field] of cases) expect(await c2('dtna:post-comment', p)).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT', field });
    expect(await c2('dtna:post-comment', 'x')).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT', field: 'payload' });
    expect(await c2('dtna:draft-comment', { equipmentId: '122269', caseId: 'bad' })).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT', field: 'caseId' });
    expect(await c2('dtna:draft-comment', { caseId: CASE_ID })).toEqual({ ok: false, code: 'DTNA_INVALID_INPUT', field: 'equipmentId' });
    expect(writeGate.requestWrite).not.toHaveBeenCalled();
    expect(commentDraft.draftForCase).not.toHaveBeenCalled();
  });

  it('draft-comment forwards to draftForCase with ctx.lastData and returns text only', async () => {
    const r = await c2('dtna:draft-comment', { equipmentId: ' 122269 ', caseId: CASE_ID });
    expect(r).toEqual({ ok: true, aiDrafted: true, draft: 'Hello', noUpdate: false, droppedCount: 1 });
    expect(commentDraft.draftForCase).toHaveBeenCalledWith({ equipmentId: '122269', caseId: CASE_ID, lastData: ctx2.lastData });
    commentDraft.draftForCase.mockResolvedValueOnce({ ok: false, code: 'DTNA_NOT_PULLED' });
    expect(await c2('dtna:draft-comment', { equipmentId: '122269', caseId: CASE_ID })).toEqual({ ok: false, code: 'DTNA_NOT_PULLED' });
    expect(writeGate.requestWrite).not.toHaveBeenCalled();
  });
});
