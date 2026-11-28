// tests/decisiv-reply-ipc.test.js — decisiv:reply-roster / decisiv:reply
// (src/ipc/relay-writes.js). The ref must be a PACCAR estimate URL matching the
// estimate id; the post re-reads the roster in main, refuses unknown ids and a
// changed case id, takes names from the roster, and stages through the real
// write gate (decisivReply, interactive). electron is a stub; the Decisiv
// transport is a mock. Synthetic ids and names only.
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

const tmpDir = path.join(os.tmpdir(), 'decisiv-reply-ipc-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const gate = require('../src/writes/write-gate');
const dr = require('../src/writes/decisiv-reply');

const sent = [];
const win = { isDestroyed: () => false, webContents: { send: vi.fn((ch, d) => sent.push({ ch, d })) } };
require('../src/ipc/relay-writes').registerRelayWritesIPC({ getMainWindow: () => win });

const EST = '1000001';
const CASE = '1000002';
const SR = 'https://paccarpg.decisiv.net/fleet/estimates/' + EST;
const cid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const GROUPS = [{ name: 'Dealer case', value: -1, options: { estimate_id: Number(CASE), filter: 'subcase_dealer' } }];
const ROSTER = [
  { id: cid(1), name: 'Dealer Writer A', email: 'a@example.test', job_role: 'Service Advisor', sub_group: 'Dealer Group A', filter_name: 'dealer' },
  { id: cid(2), name: 'Amazon Staff B', email: 'b@example.test', job_role: 'Fleet Support', sub_group: 'Amazon Staff Group', filter_name: 'fleet_dealer' },
];
const flush = () => new Promise((r) => setImmediate(r));
function memStore() {
  const data = {};
  return { data, load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d), save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); } };
}
function mockApi(over = {}) {
  const api = Object.assign({
    getEstimateContacts: vi.fn(async () => GROUPS),
    apiGetForCase: vi.fn(async () => ROSTER),
    getActivityLogs: vi.fn(async () => ({ notes: [{ id: 5000001, created_at: '11/10/26 10:28 am EST' }, { id: 5000002, created_at: '11/11/26 9:00 am EST' }] })),
    apiPostForCase: vi.fn(async () => ({ notes: [{ id: 5000050 }] })),
  }, over);
  dr._setDepsForTest({ api });
  return api;
}
const post = (o = {}) => Object.assign({ unit: 'U100', estimateId: EST, srUrl: SR, caseId: CASE, text: '  Any ETA?  ', recipients: [cid(1), cid(2)] }, o);

afterEach(() => { sent.length = 0; gate._setDepsForTest({}); gate.setWindowGetter(() => win); dr._setDepsForTest({}); vi.restoreAllMocks(); });

describe('decisiv:reply-roster', () => {
  it('a bad URL, a mismatched id or a non-Decisiv host is refused with no network', async () => {
    const api = mockApi();
    for (const p of [
      { estimateId: EST, srUrl: 'https://evil.example/fleet/estimates/' + EST },
      { estimateId: '999', srUrl: SR },
      { estimateId: EST, srUrl: 'https://dtna.my.site.com/fleet/estimates/' + EST },
      { estimateId: EST, srUrl: 'http://volvopg.asist.decisiv.net/fleet/estimates/' + EST },
      { estimateId: EST },
    ]) {
      expect(await handlers['decisiv:reply-roster']({}, p)).toEqual({ ok: false, code: 'DECISIV_BAD_REF' });
    }
    expect(api.getEstimateContacts).not.toHaveBeenCalled();
    expect(api.apiGetForCase).not.toHaveBeenCalled();
  });

  it('returns the case id and contacts without emails', async () => {
    const api = mockApi();
    const r = await handlers['decisiv:reply-roster']({}, { estimateId: EST, srUrl: SR });
    expect(r.ok).toBe(true);
    expect(r.caseId).toBe(CASE);
    expect(r.contacts).toEqual([
      { id: cid(1), name: 'Dealer Writer A', jobRole: 'Service Advisor', subGroup: 'Dealer Group A', filterName: 'dealer' },
      { id: cid(2), name: 'Amazon Staff B', jobRole: 'Fleet Support', subGroup: 'Amazon Staff Group', filterName: 'fleet_dealer' },
    ]);
    expect(JSON.stringify(r)).not.toContain('@');
    expect(api.apiGetForCase.mock.calls[0][1]).toContain('estimate_id=' + CASE + '&group_id=-1&filter=subcase_dealer');
  });

  it('a Volvo (volvopg.asist) estimate URL is accepted like PACCAR', async () => {
    const api = mockApi();
    const r = await handlers['decisiv:reply-roster']({}, { estimateId: EST, srUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/' + EST });
    expect(r.ok).toBe(true);
    expect(r.caseId).toBe(CASE);
    expect(r.contacts.length).toBe(2);
    expect(api.apiGetForCase).toHaveBeenCalledTimes(1);
  });

  it('no subcase group -> DECISIV_NO_SUBCASE', async () => {
    mockApi({ getEstimateContacts: vi.fn(async () => []) });
    expect(await handlers['decisiv:reply-roster']({}, { estimateId: EST, srUrl: SR })).toEqual({ ok: false, code: 'DECISIV_NO_SUBCASE' });
  });
});

describe('decisiv:reply', () => {
  it('an unknown recipient id is refused and nothing is staged', async () => {
    mockApi();
    const spy = vi.spyOn(gate, 'requestWrite');
    const r = await handlers['decisiv:reply']({}, post({ recipients: [cid(1), cid(9)] }));
    expect(r).toEqual({ ok: false, code: 'DECISIV_RECIPIENT_UNKNOWN' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a case id mismatch is refused', async () => {
    mockApi();
    const spy = vi.spyOn(gate, 'requestWrite');
    expect(await handlers['decisiv:reply']({}, post({ caseId: '1000003' }))).toEqual({ ok: false, code: 'DECISIV_CASE_CHANGED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('no recipients, a non-UUID id or a bad ref is refused', async () => {
    const api = mockApi();
    expect((await handlers['decisiv:reply']({}, post({ recipients: [] }))).code).toBe('DECISIV_NO_RECIPIENTS');
    expect((await handlers['decisiv:reply']({}, post({ recipients: ['x'] }))).code).toBe('DECISIV_NO_RECIPIENTS');
    expect((await handlers['decisiv:reply']({}, post({ srUrl: 'https://dtna.my.site.com/fleet/estimates/' + EST }))).code).toBe('DECISIV_BAD_REF');
    expect((await handlers['decisiv:reply']({}, post({ text: '   ' }))).ok).toBe(false);
    expect(api.apiPostForCase).not.toHaveBeenCalled();
  });

  it('a valid post calls requestWrite once (decisivReply, interactive) with names from the roster', async () => {
    mockApi();
    const spy = vi.spyOn(gate, 'requestWrite').mockResolvedValue({ ok: true, outcome: 'sent', id: 'rw_1' });
    const r = await handlers['decisiv:reply']({}, post({ recipients: [{ id: cid(2), name: 'Injected Name' }, cid(1)] }));
    expect(r).toEqual({ ok: true, outcome: 'sent', id: 'rw_1' });
    expect(spy).toHaveBeenCalledTimes(1);
    const s = spy.mock.calls[0][0];
    expect(s.kind).toBe('decisivReply');
    expect(s.interactive).toBe(true);
    expect(s.origin).toBe('unit-detail-decisiv');
    expect(s.payload).toEqual({ unitId: 'U100', caseId: CASE, estimateId: EST, srUrl: SR, text: 'Any ETA?',
      recipients: [{ id: cid(2), name: 'Amazon Staff B' }, { id: cid(1), name: 'Dealer Writer A' }] });
  });

  function setupGate() {
    gate._setDepsForTest({ store: memStore(), flags: { requireApproval: true }, log: () => {}, notify: () => {} });
    gate.setWindowGetter(() => win);
  }

  it('approval deny through the real gate sends nothing', async () => {
    const api = mockApi();
    setupGate();
    const p = handlers['decisiv:reply']({}, post());
    for (let i = 0; i < 5 && !sent.length; i++) await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(sent[0].d.preview).toContain('  - Dealer Writer A');
    expect(sent[0].d.preview).toContain('  - Amazon Staff B');
    await handlers['relayWrites:respond']({}, sent[0].d.id, false);
    const r = await p;
    expect(r.outcome).toBe('skipped-not-approved');
    expect(api.apiPostForCase).not.toHaveBeenCalled();
    expect(api.getActivityLogs).not.toHaveBeenCalled();
  });

  it('approval grant through the real gate posts once to the newest note', async () => {
    const api = mockApi();
    setupGate();
    const p = handlers['decisiv:reply']({}, post());
    for (let i = 0; i < 5 && !sent.length; i++) await flush();
    await handlers['relayWrites:respond']({}, sent[0].d.id, true);
    const r = await p;
    expect(r).toEqual({ ok: true, outcome: 'sent', id: sent[0].d.id });
    expect(api.apiPostForCase).toHaveBeenCalledTimes(1);
    const [u, pth, body] = api.apiPostForCase.mock.calls[0];
    expect(u).toBe(SR);
    expect(pth).toBe('/mobilecomm/api/estimates/' + EST + '/notes/5000002/reply.json');
    expect(body.reply_to_id).toBe('5000002');
    expect(body.subject_id).toBe(1000002);
    expect(body.note.recipients).toHaveLength(2);
  });
});
