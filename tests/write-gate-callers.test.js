// tests/write-gate-callers.test.js — every non-interactive Relay write caller queues
// (pending-approval) and sends nothing: daily-tasks create_wr, FAS SUBMIT_WORK_REQUEST,
// relay-step dealer tracking WO, PACCAR/Volvo SR notes, relay reconcile MODE A.
// The reconcile overlay confirm sends exactly the staged text once.
// AAP is a fake browser_provider + spies; electron is a stub. No live calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

// ── electron stub (captures ipcMain handlers; no windows) ───────────────────
const handlers = {};
const sesFetch = vi.fn();
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    BrowserWindow: { getAllWindows: () => [] },
    session: { defaultSession: { fetch: sesFetch, cookies: { get: async () => [] } } },
    app: { getPath: () => os.tmpdir() },
  },
};

const tmpDir = path.join(os.tmpdir(), 'write-gate-callers-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const gate = require('../src/writes/write-gate');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const ROW = { equipmentId: 'B62020', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aaid-1', domicileSite: 'ABE40',
  vendor: 'Cox', issueSummary: 'Check engine light', make: 'Kenworth' };

// ── fake AAP backend: reads succeed, any write is recorded ──────────────────
const calls = [];
aap._setProviderForTest({
  kind: () => 'electron',
  shutdown() {},
  openPage: async () => ({
    url: () => 'https://aap-na.corp.amazon.com/v2/page/x',
    close() {},
    evaluate: async (script) => {
      if (script.includes('__aapHookInstalled')) return null;
      if (script.includes('var deadline')) return 'tok';
      const m = /xhr\.open\("(\w+)", "([^"]+)"/.exec(script);
      if (!m) return { ok: false, status: -1, error: 'unparsed' };
      const url = m[2].replace('https://aap-na.corp.amazon.com', '');
      calls.push(m[1] + ' ' + url);
      if (m[1] === 'GET' && /\/api\/v1\/assets\//.test(url)) return { ok: true, status: 200, json: { aaid: 'aaid-1' } };
      if (m[1] === 'PUT' && /\/vre\/recommendation\//.test(url)) return { ok: true, status: 200, json: { recommendation: { vendors: [{ vendor: 'COX' }] } } };
      if (m[1] === 'POST' && /createRepair$/.test(url)) return { ok: true, status: 200, json: { workRequestId: 'wr-new' } };
      return { ok: false, status: 404, text: 'nf' };
    },
  }),
});
aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });
aap._setVendorListForTest([{ vendorId: 'COX', vendorName: 'Cox' }]);

const writes = () => calls.filter((c) => !c.startsWith('GET '));
const pendingWrites = () => gate.list().items.filter((i) => i.state === 'pending');
let logs;

beforeEach(() => {
  calls.length = 0;
  logs = [];
  store.save('settings', {});
  store.save('relayWritesPending', { items: [] });
  store.save('relayReconcilePending', { items: [] });
  store.save('relayReconcileLog', {});
  store.save('fleetData', { rows: [ROW] });
  gate._setDepsForTest({ log: (m) => logs.push(m) });
  gate.setWindowGetter(null);
});
afterEach(() => { vi.restoreAllMocks(); gate._setDepsForTest({}); });

describe('daily-tasks create_wr executor', () => {
  it('queues the WR (pending), sends nothing, and does not mark the task done', async () => {
    vi.useFakeTimers();
    const dt = require('../src/ipc/daily-tasks');
    dt.registerDailyTasksIPC({});
    dt.__test__.resetForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    store.save('dailyTasks', { ai: [{ id: 't1', action: 'create_wr', unitId: 'B62020', done: false }], manual: [] });
    const r = await handlers['tasks:execute-action']({}, 't1');
    expect(r).toEqual({ ok: false, pending: true, message: 'Queued for your approval (Relay writes)' });
    expect(writes()).toEqual([]);
    const q = pendingWrites();
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe('createWorkOrder');
    expect(q[0].origin).toBe('daily-tasks');
    expect(store.load('dailyTasks').ai[0].done).toBe(false);
  });
});

describe('FAS SUBMIT_WORK_REQUEST', () => {
  it('run -> pending, verify not created, nothing sent', async () => {
    const { getAction } = require('../src/orcha/fas/action-registry');
    const a = getAction('SUBMIT_WORK_REQUEST');
    const res = await a.run({ unit: 'B62020', payload: { title: 'CEL', vendor: 'Cox' } });
    expect(res.ok).toBe(false);
    expect(res.pending).toBe(true);
    expect(res.error).toBe('pending-approval');
    expect(a.verify({}, {}, res).verified).toBe(false);
    expect(writes()).toEqual([]);
    expect(pendingWrites()[0].origin).toBe('fas-action');
  });
});

describe('relay-step dealer tracking WO', () => {
  it('createDealerTrackingWO -> pendingApproval; runRelayStep does not throw', async () => {
    const rs = require('../src/vendors/base/relay-step');
    const r = await rs.createDealerTrackingWO(ROW, 'paccar');
    expect(r).toEqual({ ok: false, pendingApproval: true, error: 'pending-approval', isDuplicate: false });
    const s = await rs.runRelayStep(ROW);
    expect(s).toEqual({ vendor: 'paccar', altId: '', workRequestId: '', serviceUrl: '', isDuplicate: false, pendingApproval: true });
    expect(writes()).toEqual([]);
    expect(pendingWrites().every((i) => i.origin === 'relay-step')).toBe(true);
  });
});

describe('PACCAR / Volvo SR notes', () => {
  it('_writeToRelay queues the note; 0 apiPost', async () => {
    const spy = vi.spyOn(aap, 'apiPost');
    const P = require('../src/vendors/paccar/index.js');
    const V = require('../src/vendors/volvo/index.js');
    const unit = { equipmentId: 'B62020', workRequestId: WR };
    await P.prototype._writeToRelay.call({}, unit, 'AMZ-1', 'SR-1', 'https://portal/x');
    await V.prototype._writeToRelay.call({}, unit, 'AMZ-1', 'SR-2', '');
    expect(spy).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    const q = pendingWrites();
    expect(q.map((i) => i.origin).sort()).toEqual(['paccar-sr-note', 'volvo-sr-note']);
    expect(q.every((i) => i.kind === 'addComment')).toBe(true);
  });
});

describe('relay reconcile', () => {
  const apply = require('../src/scrapers/relay_reconcile_apply');
  const WO = '9f9f9f9f-aaaa-bbbb-cccc-ddddeeeeffff';
  const mockReads = () => {
    vi.spyOn(aap, 'getService').mockResolvedValue({ id: WR, workOrders: [{ id: WO }] });
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue({ userName: 'fakeuser' });
  };
  const CFG_AUTO = { enabled: true, autoPostToRelay: true, staleDays: 3, minConfidence: 0.5, maxUnitsPerSync: 8 };
  const decision = () => ({
    equipmentId: 'B62020', _workRequestId: WR, relayHasLatest: false,
    relayNote: 'Dealer advised parts on order, ETA 11/12.', currentStatus: 'Awaiting parts',
    nextActionType: 'post_to_relay', threadOfRecord: 'offsite', confidence: 0.9, reasoning: 'r',
  });

  it('MODE A with defaults -> staged approval-required, 0 sends', async () => {
    const spy = vi.spyOn(aap, 'apiPost');
    const res = await apply.applyReconcile(decision(), { cfg: CFG_AUTO });
    const gap = res.posts.find((p) => p.kind === 'gap-fill');
    expect(gap.action).toBe('staged');
    expect(gap.reason).toBe('approval-required');
    expect(spy).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('MODE A with settings.writes.requireApproval false -> posted via apiPost', async () => {
    store.save('settings', { writes: { requireApproval: false } });
    mockReads();
    const spy = vi.spyOn(aap, 'apiPost').mockResolvedValue({ ok: true });
    const res = await apply.applyReconcile(decision(), { cfg: CFG_AUTO });
    expect(res.posts.find((p) => p.kind === 'gap-fill').action).toBe('posted');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('/api/v1/workOrder/addComment');
    // Reconcile never chooses a visibility: its posts stay internal only, never CARRIER.
    expect(spy.mock.calls[0][1].comment).toMatchObject({ internalOnly: true, externalConsumers: [] });
    expect(JSON.stringify(spy.mock.calls[0][1])).not.toContain('CARRIER');
  });

  it('confirmPending -> exactly one send with the staged text unchanged', async () => {
    mockReads();
    const spy = vi.spyOn(aap, 'apiPost').mockResolvedValue({ ok: true });
    await apply.applyReconcile(decision(), { cfg: CFG_AUTO });
    const item = apply.loadPending().items.find((i) => i.kind === 'gap-fill' && i.state === 'pending');
    const r = await apply.confirmPending(item.id);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ id: WO, comment: {
      timestamp: expect.any(String), text: item.text, createdBy: 'fakeuser', internalOnly: true, externalConsumers: [],
    } });
    expect(logs.some((l) => /approved kind=addComment origin=relay-reconcile .*by=relay-reconcile-overlay/.test(l))).toBe(true);
    expect(sesFetch).not.toHaveBeenCalled();
  });
});
describe('review fixes: caller-level approval only', () => {
  it('a FAS payload carrying userConfirmed:true still queues (pending-approval), 0 writes, preview says AI-drafted: yes', async () => {
    const { getAction } = require('../src/orcha/fas/action-registry');
    const res = await getAction('SUBMIT_WORK_REQUEST').run({ unit: 'B62020', payload: { title: 'CEL', vendor: 'Cox', userConfirmed: true, issue: 'AI issue text' } });
    expect(res.pending).toBe(true);
    expect(writes()).toEqual([]);
    const q = pendingWrites();
    expect(q).toHaveLength(1);
    expect(q[0].preview).toContain('AI-drafted: yes');
    expect(q[0].preview).toContain('AI issue text');
    expect(logs.some((l) => /by=wr-modal-confirm/.test(l))).toBe(false);
  });
  it('createWorkRequest ignores payload.userConfirmed with interactive:false; unknown aiDrafted without gateOpts', async () => {
    const { createWorkRequest } = require('../src/scrapers/aap_create_wr');
    const r = await createWorkRequest({ unit: 'B62020', title: 'T', vendor: 'Cox', userConfirmed: true }, 'B62020', () => {}, { origin: 'daily-tasks', interactive: false });
    expect(r.outcome).toBe('pending-approval');
    expect(writes()).toEqual([]);
    expect(pendingWrites()[0].preview).toContain('AI-drafted: unknown');
  });
  it('daily-tasks: re-running the task reuses the queued WR; approving it from the list sends once and marks the task done', async () => {
    vi.useFakeTimers();
    const dt = require('../src/ipc/daily-tasks');
    dt.registerDailyTasksIPC({});
    dt.__test__.resetForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
    store.save('dailyTasks', { ai: [{ id: 't2', action: 'create_wr', unitId: 'B62020', done: false }], manual: [] });
    await handlers['tasks:execute-action']({}, 't2');
    await handlers['tasks:execute-action']({}, 't2');
    const q = pendingWrites();
    expect(q).toHaveLength(1);
    expect(q[0].ref).toEqual({ taskId: 't2' });
    expect(q[0].preview).toContain('AI-drafted: no');
    const a = await gate.approve(q[0].id);
    expect(a.outcome).toBe('sent');
    expect(writes().filter((c) => /createRepair$/.test(c))).toHaveLength(1);
    expect(store.load('dailyTasks').ai[0].done).toBe(true);
  });
});
