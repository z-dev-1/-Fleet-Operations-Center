// tests/relay-add-comment-ipc.test.js — relay:add-comment (src/ipc/relay-writes.js):
// forwards to aap_create_wr.addConversationNote with origin 'unit-detail' and
// interactive:true, validates text (non-empty, <= COMMENT_MAX) and the WR id, and
// goes THROUGH the write gate: a denied approval sends nothing, an approval sends once.
// electron is a stub; every send is a mock. No live calls.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

// ── electron stub (captures ipcMain handlers; no windows) ───────────────────
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

const tmpDir = path.join(os.tmpdir(), 'relay-add-comment-ipc-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const gate = require('../src/writes/write-gate');
const createWr = require('../src/scrapers/aap_create_wr');
const aap = require('../src/scrapers/aap_api');

const sent = [];
const win = { isDestroyed: () => false, webContents: { send: vi.fn((ch, d) => sent.push({ ch, d })) } };
require('../src/ipc/relay-writes').registerRelayWritesIPC({ getMainWindow: () => win });

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const WO = '9f9f9f9f-aaaa-bbbb-cccc-ddddeeeeffff';
const flush = () => new Promise((r) => setImmediate(r));
function memStore() {
  const data = {};
  return {
    data,
    load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

afterEach(() => { sent.length = 0; gate._setDepsForTest({}); vi.restoreAllMocks(); });

describe('relay:add-comment forwards to addConversationNote', () => {
  it('passes the trimmed text with origin unit-detail, interactive:true, aiDrafted:false', async () => {
    const spy = vi.spyOn(createWr, 'addConversationNote').mockResolvedValue({ ok: true, outcome: 'sent' });
    const r = await handlers['relay:add-comment']({}, { workRequestId: WR, text: '  hi  ', unit: 'B62020' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(WR, 'hi', { origin: 'unit-detail', unit: 'B62020', interactive: true, aiDrafted: false, visibility: 'vendor' });
    expect(r).toEqual({ ok: true, outcome: 'sent' });
  });

  it('visibility: known values pass through; missing or unknown -> vendor, never carrier', async () => {
    const spy = vi.spyOn(createWr, 'addConversationNote').mockResolvedValue({ ok: true, outcome: 'sent' });
    const cases = [['internal', 'internal'], ['vendor', 'vendor'], ['vendor_carrier', 'vendor_carrier'],
      [undefined, 'vendor'], ['', 'vendor'], ['CARRIER', 'vendor'], ['carrier', 'vendor'], [['CARRIER'], 'vendor'], [{ carrier: true }, 'vendor']];
    for (const [i, [input, want]] of cases.entries()) {
      await handlers['relay:add-comment']({}, { workRequestId: WR, text: 'x', unit: 'B1', visibility: input });
      expect(spy.mock.calls[i][2].visibility).toBe(want);
    }
  });

  it('resolves the WR id from serviceUrl when workRequestId is absent', async () => {
    const spy = vi.spyOn(createWr, 'addConversationNote').mockResolvedValue({ ok: true, outcome: 'sent' });
    await handlers['relay:add-comment']({}, { serviceUrl: 'https://aap-na.corp.amazon.com/v2/service/' + WR, text: 'x', unit: 'B1' });
    expect(spy.mock.calls[0][0]).toBe(WR);
  });

  it('rejects empty, over-limit text and a missing or non-UUID WR without calling addConversationNote', async () => {
    const spy = vi.spyOn(createWr, 'addConversationNote').mockResolvedValue({ ok: true, outcome: 'sent' });
    const bad = [
      { workRequestId: WR, text: '' },
      { workRequestId: WR, text: '   ' },
      { workRequestId: WR, text: 'a'.repeat(2001) },
      { text: 'hello' },
      { workRequestId: '12345', text: 'hello' },
      null,
    ];
    for (const p of bad) {
      const r = await handlers['relay:add-comment']({}, p);
      expect(r.ok).toBe(false);
      expect(r.code).toBeTruthy();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(gate.COMMENT_MAX).toBe(2000);
    const ok = await handlers['relay:add-comment']({}, { workRequestId: WR, text: 'a'.repeat(2000), unit: 'B1' });
    expect(ok.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('relay:add-comment goes through the write gate', () => {
  function setupGate() {
    const apiPost = vi.fn(async () => ({ ok: true }));
    const directPost = vi.spyOn(aap, 'apiPost').mockResolvedValue({ ok: true });
    gate._setDepsForTest({ apiPost, store: memStore(), flags: { requireApproval: true }, log: () => {}, notify: () => {},
      getService: async (id) => ({ id, workOrders: [{ id: WO }] }), getUserDetails: async () => ({ userName: 'fakeuser' }) });
    gate.setWindowGetter(() => win);
    return { apiPost, directPost };
  }

  it('denied approval -> skipped-not-approved, nothing sent', async () => {
    const { apiPost, directPost } = setupGate();
    const p = handlers['relay:add-comment']({}, { workRequestId: WR, text: 'Parts ETA 11/12', unit: 'B62020' });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(sent[0].d.preview).toContain('Parts ETA 11/12');
    expect(sent[0].d.preview).toContain('Visible to: Vendor');
    expect((await handlers['relayWrites:respond']({}, sent[0].d.id, false)).ok).toBe(true);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('skipped-not-approved');
    expect(apiPost).not.toHaveBeenCalled();
    expect(directPost).not.toHaveBeenCalled();
  });

  it('approved, no visibility chosen -> exactly one Vendor addComment send', async () => {
    const { apiPost, directPost } = setupGate();
    const p = handlers['relay:add-comment']({}, { workRequestId: WR, text: 'Parts ETA 11/12', unit: 'B62020' });
    await flush();
    await handlers['relayWrites:respond']({}, sent[0].d.id, true);
    const r = await p;
    expect(r.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith('/api/v1/workOrder/addComment', { id: WO, comment: {
      timestamp: expect.any(String), text: 'Parts ETA 11/12', createdBy: 'fakeuser', internalOnly: false, externalConsumers: ['VENDOR'],
    } });
    expect(directPost).not.toHaveBeenCalled();
  });

  it('the chosen visibility flows request -> preview -> on-send body', async () => {
    const want = {
      internal: ['Visible to: Internal only', true, []],
      vendor: ['Visible to: Vendor', false, ['VENDOR']],
      vendor_carrier: ['Visible to: Vendor + Carrier', false, ['CARRIER', 'VENDOR']],
      bogus: ['Visible to: Vendor', false, ['VENDOR']],
    };
    for (const [vis, [line, internalOnly, ext]] of Object.entries(want)) {
      sent.length = 0;
      const { apiPost } = setupGate();
      const p = handlers['relay:add-comment']({}, { workRequestId: WR, text: 'Parts ETA ' + vis, unit: 'B62020', visibility: vis });
      await flush();
      expect(sent[0].d.preview).toContain(line);
      if (vis !== 'vendor_carrier') expect(sent[0].d.preview).not.toContain('Carrier');
      await handlers['relayWrites:respond']({}, sent[0].d.id, true);
      expect((await p).outcome).toBe('sent');
      const body = apiPost.mock.calls[0][1];
      expect(body.comment.internalOnly).toBe(internalOnly);
      expect(body.comment.externalConsumers).toEqual(ext);
      expect(body.comment.createdBy).toBe('fakeuser');
    }
  });

  it('the IPC module never calls the AAP transport directly', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'relay-writes.js'), 'utf8');
    expect(src).not.toMatch(/apiPost|aap_api/);
  });
});
