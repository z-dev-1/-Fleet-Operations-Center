// tests/aap-write-transport.test.js — the two Relay write transports that used to 403
// (cookie-only electron session fetch) now go through the working aap_api transport and
// the write-approval gate: addConversationNote -> apiPost('/api/v1/workOrder/addComment'),
// createWorkRequest -> aap_api.createWorkOrder({confirmVendor:true}); the createWorkOrder
// commit guard sends nothing to /createRepair unless the gate approves.
// The AAP backend is a fake browser_provider; electron is a stub whose session fetch is a
// spy that must never be called. No live calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── electron stub (session fetch spy) ───────────────────────────────────────
const sesFetch = vi.fn(async () => ({ ok: false, status: 403 }));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    session: { defaultSession: { fetch: sesFetch, cookies: { get: vi.fn(async () => []) } } },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle() {} },
  },
};

const tmpDir = path.join(os.tmpdir(), 'aap-write-transport-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const cwr = require('../src/scrapers/aap_create_wr');
const gate = require('../src/writes/write-gate');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';

// ── fake AAP backend ────────────────────────────────────────────────────────
const calls = [];
let BACKEND = () => ({ __fail: 404 });
const fakeProvider = {
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
      const json = BACKEND(m[1], url);
      if (json && json.__transport) return { ok: false, status: 0, transport: true, responseURL: '' };
      if (json && json.__fail != null) return { ok: false, status: json.__fail, text: 'err' };
      return { ok: true, status: 200, json };
    },
  }),
};
aap._setProviderForTest(fakeProvider);
aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });
aap._setVendorListForTest([{ vendorId: 'COX', vendorName: 'Cox' }]);

function okBackend(method, url) {
  if (method === 'GET' && /\/api\/v1\/assets\//.test(url)) return { aaid: 'aaid-1' };
  if (method === 'PUT' && /\/vre\/recommendation\//.test(url)) return { recommendation: { vendors: [{ vendor: 'COX' }], ruleName: 'r1', autoAssignable: true } };
  if (method === 'POST' && /\/api\/v1\/createRepair$/.test(url)) return { workRequestId: 'wr-new-1' };
  return { __fail: 404 };
}

let logs, win, sent;
beforeEach(() => {
  calls.length = 0;
  sesFetch.mockClear();
  BACKEND = okBackend;
  logs = [];
  sent = [];
  win = { isDestroyed: () => false, webContents: { send: (ch, data) => sent.push({ ch, data }) } };
  store.save('relayWritesPending', { items: [] });
  store.save('settings', {});
  gate._setDepsForTest({ log: (m) => logs.push(m) });
  gate.setWindowGetter(null);
});
afterEach(() => { vi.restoreAllMocks(); gate._setDepsForTest({}); gate.setWindowGetter(null); });

const baseOpts = (o = {}) => Object.assign({
  aaid: 'aaid-1', title: 'Check engine light', issue: 'CEL on', vendor: 'Cox', callType: 'YARD',
  locationLatest: { latitude: 40.1, longitude: -75.2 }, areaPairs: [{ area: 'ENG', subcategory: 'CEL' }],
  domicile: 'ABE40', origin: 'test',
}, o);

describe('addConversationNote', () => {
  it('approved -> one apiPost(/api/v1/workOrder/addComment) with the nested body; session fetch never used', async () => {
    const WO = '9f9f9f9f-aaaa-bbbb-cccc-ddddeeeeffff';
    const svc = vi.spyOn(aap, 'getService').mockResolvedValue({ id: WR, workOrders: [{ id: WO }] });
    vi.spyOn(aap, 'getUserDetails').mockResolvedValue({ userName: 'fakeuser' });
    const spy = vi.spyOn(aap, 'apiPost').mockResolvedValue({ ok: true });
    const r = await cwr.addConversationNote('https://aap-na.corp.amazon.com/v2/service/' + WR, 'Parts ETA 11/12', { origin: 'test', approvedBy: 'unit-test' });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('sent');
    expect(svc).toHaveBeenCalledWith(WR);
    expect(spy).toHaveBeenCalledTimes(1);
    const [p, body] = spy.mock.calls[0];
    expect(p).toBe('/api/v1/workOrder/addComment');
    expect(Object.keys(body).sort()).toEqual(['comment', 'id']);
    expect(body.id).toBe(WO);
    expect(body.comment).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      text: 'Parts ETA 11/12', createdBy: 'fakeuser', internalOnly: true, externalConsumers: [],
    });
    expect(sesFetch).not.toHaveBeenCalled();
  });

  it('without approval -> pending-approval, nothing sent', async () => {
    const spy = vi.spyOn(aap, 'apiPost').mockResolvedValue({ ok: true });
    const r = await cwr.addConversationNote(WR, 'Parts ETA 11/12', { origin: 'test', interactive: false });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('pending-approval');
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(sesFetch).not.toHaveBeenCalled();
  });
});

describe('HTTP 0 error message', () => {
  it('the in-page script marks status 0 at readyState 4 as a transport failure', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/scrapers/aap_api.js'), 'utf8');
    expect(src).toContain("if (xhr.status === 0) { resolve({ ok: false, status: 0, transport: true, responseURL: xhr.responseURL || '' }); return; }");
  });

  it('a transport marker -> clear message, code stays AAP_API_ERROR, status 0', async () => {
    BACKEND = () => ({ __transport: true });
    const err = await aap.apiPost('/api/v1/workOrder/addComment', { id: 'x' }).catch((e) => e);
    expect(err.code).toBe('AAP_API_ERROR');
    expect(err.status).toBe(0);
    expect(err.message).toBe('AAP returned no response for POST /api/v1/workOrder/addComment (blocked or redirected) - reads are working, so this is not a VPN or sign-in problem.');
  });

  it('a plain status-0 result without the marker keeps the old message', async () => {
    BACKEND = () => ({ __fail: 0 });
    const err = await aap.apiPost('/api/v1/x', {}).catch((e) => e);
    expect(err.code).toBe('AAP_API_ERROR');
    expect(err.message).toBe('AAP API 0: err');
  });
});

describe('createWorkRequest (legacy callers)', () => {
  const payload = {
    unit: 'B62020', title: 'T'.repeat(100), issue: 'CEL', vendor: 'Cox', urgent: 'Yes', urgencyReason: 'DEA - Asset Shortage',
    areaPairs: [{ area: 'ENG', subcategory: 'CEL', subSubcategory: '' }], comments: 'note', shareWith: 'internal',
    towDirection: 'return-to-yard', towFromStreet: '1 Dealer Way', towFromCity: 'Allentown', towFromState: 'PA', towFromZip: '18101',
    towStreet: '2 Yard Rd', towCity: 'Bethlehem', towState: 'PA', towZip: '18015', attachments: ['data:image/png;base64,AA'],
  };

  it('routes to aap_api.createWorkOrder once with confirmVendor:true and the mapped opts', async () => {
    const spy = vi.spyOn(aap, 'createWorkOrder').mockResolvedValue({ ok: true, phase: 'commit', workRequestId: 'wr-new' });
    const unit = { equipmentId: 'B62020', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aaid-1', site: 'ABE40' };
    const r = await cwr.createWorkRequest(payload, unit, () => {}, { origin: 'daily-tasks', interactive: false });
    expect(r).toEqual({ ok: true, workRequestId: 'wr-new', title: 'T'.repeat(90), copiedFromWorkRequestId: null });
    expect(spy).toHaveBeenCalledTimes(1);
    const o = spy.mock.calls[0][0];
    expect(o.confirmVendor).toBe(true);
    expect(o.origin).toBe('daily-tasks');
    expect(o.interactive).toBe(false);
    expect(o.assetUrl).toBe(unit.assetUrl);
    expect(o.title).toBe(payload.title);
    expect(o.vendor).toBe('Cox');
    expect(o.areaPairs).toEqual(payload.areaPairs);
    expect(o.domicile).toBe('ABE40');
    expect(o.towToStreet).toBe('2 Yard Rd');
    expect(o.towToZip).toBe('18015');
    expect(o.offSite).toBe(true);
    expect(o.locStreet).toBe('1 Dealer Way');
    expect(o.attachments).toEqual([{ name: 'attachment-1', dataUrl: 'data:image/png;base64,AA' }]);
    expect(sesFetch).not.toHaveBeenCalled();
  });

  it('a string unit resolves assetUrl from stored fleetData', async () => {
    store.save('fleetData', { rows: [{ equipmentId: 'B62020', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aaid-9', domicileSite: 'ROC5' }] });
    const spy = vi.spyOn(aap, 'createWorkOrder').mockResolvedValue({ ok: true, phase: 'commit', workRequestId: 'wr-9' });
    const r = await cwr.createWorkRequest({ title: 'x', vendor: 'Cox' }, 'B62020', () => {}, { origin: 'fas-action', interactive: false });
    expect(r.ok).toBe(true);
    expect(spy.mock.calls[0][0].assetUrl).toBe('https://aap-na.corp.amazon.com/v2/asset/aaid-9');
    expect(spy.mock.calls[0][0].domicile).toBe('ROC5');
    expect(spy.mock.calls[0][0].interactive).toBe(false);
  });

  it('a gated result is returned as not sent', async () => {
    vi.spyOn(aap, 'createWorkOrder').mockResolvedValue({ ok: false, phase: 'gated', outcome: 'pending-approval', id: 'rw_1', error: 'pending-approval' });
    const r = await cwr.createWorkRequest({ title: 'x' }, { assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aaid-1' }, () => {}, { interactive: false });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('pending-approval');
  });

  it('defaults to interactive (ipc/ai.js approve-wr passes no gate opts)', async () => {
    const spy = vi.spyOn(aap, 'createWorkOrder').mockResolvedValue({ ok: false, phase: 'gated', outcome: 'skipped-not-approved' });
    await cwr.createWorkRequest({ title: 'x' }, { assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/aaid-1' }, () => {});
    expect(spy.mock.calls[0][0].interactive).toBe(true);
    expect(spy.mock.calls[0][0].confirmVendor).toBe(true);
  });
});

describe('aap_api.createWorkOrder commit guard', () => {
  it('approval denied at the prompt -> no /createRepair (no write request at all), phase gated', async () => {
    gate.setWindowGetter(() => win);
    const p = aap.createWorkOrder(baseOpts({ confirmVendor: true }));
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(sent[0].data.kind).toBe('createWorkOrder');
    expect(sent[0].data.preview).toContain('Vendor: Cox -> COX');
    gate.respond(sent[0].data.id, false);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('gated');
    expect(r.outcome).toBe('skipped-not-approved');
    expect(calls.some((c) => /createRepair/.test(c))).toBe(false);
    expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  });

  it('non-interactive -> pending-approval, then approve() commits exactly once', async () => {
    const r = await aap.createWorkOrder(baseOpts({ confirmVendor: true, interactive: false }));
    expect(r.phase).toBe('gated');
    expect(r.outcome).toBe('pending-approval');
    expect(calls.some((c) => /createRepair/.test(c))).toBe(false);
    const a = await gate.approve(r.id);
    expect(a.outcome).toBe('sent');
    expect(a.result.workRequestId).toBe('wr-new-1');
    expect(calls.filter((c) => /createRepair/.test(c))).toHaveLength(1);
    expect((await gate.approve(r.id)).ok).toBe(false);
    expect(calls.filter((c) => /createRepair/.test(c))).toHaveLength(1);
  });

  it('confirmVendor false (Phase 1 recommend) is not gated and commits nothing', async () => {
    const spy = vi.spyOn(gate, 'requestWrite');
    const r = await aap.createWorkOrder(baseOpts({ confirmVendor: false }));
    expect(r.phase).toBe('recommend');
    expect(spy).not.toHaveBeenCalled();
    expect(calls.some((c) => /createRepair/.test(c))).toBe(false);
  });

  it('userConfirmed true -> no prompt, one commit, logged approved by=wr-modal-confirm', async () => {
    gate.setWindowGetter(() => win);
    const r = await aap.createWorkOrder(baseOpts({ confirmVendor: true, userConfirmed: true, origin: 'wr-modal' }));
    expect(r.ok).toBe(true);
    expect(r.phase).toBe('commit');
    expect(r.workRequestId).toBe('wr-new-1');
    expect(sent).toHaveLength(0);
    expect(calls.filter((c) => /createRepair/.test(c))).toHaveLength(1);
    expect(logs.some((l) => /\[write\] approved kind=createWorkOrder origin=wr-modal .*by=wr-modal-confirm/.test(l))).toBe(true);
    expect(logs.some((l) => /\[write\] sent kind=createWorkOrder/.test(l))).toBe(true);
  });

  it('_commitApprovedWorkOrder refuses without a gate token (no network)', async () => {
    const r = await aap._commitApprovedWorkOrder(baseOpts({ vendorCode: 'COX' }), {});
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('static write-path scan', () => {
  function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  const files = walk(path.join(ROOT, 'src'), []);
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

  it("the literal '/addComment' appears only in src/writes/write-gate.js", () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('/addComment')).map(rel);
    expect(hits).toEqual(['src/writes/write-gate.js']);
  });

  it("write-gate posts to '/api/v1/workOrder/addComment' and never the unserved '/api/v1/addComment'", () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/writes/write-gate.js'), 'utf8');
    expect(src).toContain("'/api/v1/workOrder/addComment'");
    expect(src).not.toContain("'/api/v1/addComment'");
  });

  it('aap_create_wr.js has no session fetch and no aapFetch', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/scrapers/aap_create_wr.js'), 'utf8');
    expect(src).not.toContain('ses.fetch');
    expect(src).not.toContain('aapFetch');
    expect(src).not.toContain('defaultSession');
  });

  it('/createRepair is only POSTed from aap_api (CREATE_REPAIR_PATH inside the gated commit)', () => {
    const hits = files.filter((f) => /['"`]\/(api\/v1\/)?createRepair['"`]/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(hits).toEqual(['src/scrapers/aap_api.js']);
  });
});
