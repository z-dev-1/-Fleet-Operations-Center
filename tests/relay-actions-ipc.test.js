// tests/relay-actions-ipc.test.js — relay:escalate / relay:change-lifecycle /
// relay:lifecycle-options (src/ipc/relay-writes.js). The module-level writes
// (aap_api.updateEscalations, lifecycle_change.changeLifecycle) are spied to THROW,
// and the gate gets recording fakes, so any write outside the gate fails the test.
// electron is a stub; no live calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ── AI lane stub (relay.askWithTimeout) for relay:draft-action ──────────────
const askCalls = [];
const relayPath = require.resolve('../src/orcha/relay');
require.cache[relayPath] = {
  id: relayPath, filename: relayPath, loaded: true,
  exports: { askWithTimeout: async (p, o) => { askCalls.push({ p, o }); return '{"reason":"VENDOR NOT RESPONDING. PLEASE PUSH FOR ETA."}'; } },
};

const tmpDir = path.join(os.tmpdir(), 'relay-actions-ipc-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const gate = require('../src/writes/write-gate');
const aap = require('../src/scrapers/aap_api');
const lcChange = require('../src/scrapers/lifecycle_change');
const lcApi = require('../src/scrapers/aap_lifecycle_api');

const sent = [];
const win = { isDestroyed: () => false, webContents: { send: vi.fn((ch, d) => sent.push({ ch, d })) } };
require('../src/ipc/relay-writes').registerRelayWritesIPC({ getMainWindow: () => win });

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const flush = () => new Promise((r) => setImmediate(r));
const call = (ch, p) => handlers[ch]({}, p);
function memStore() {
  const data = {};
  return {
    data,
    load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

let fakeEsc, fakeLc, rawEsc, rawLc;
beforeEach(() => {
  sent.length = 0;
  fakeEsc = vi.fn(async (p) => ({ ok: true, add: p.add, remove: p.remove }));
  fakeLc = vi.fn(async () => ({ success: true, message: '322168 set to ACTIVE' }));
  gate._setDepsForTest({ store: memStore(), updateEscalations: fakeEsc, setLifecycle: fakeLc, flags: { requireApproval: true }, log: () => {}, notify: () => {} });
  gate.setWindowGetter(() => win);
  rawEsc = vi.spyOn(aap, 'updateEscalations').mockImplementation(() => { throw new Error('WRITE OUTSIDE GATE'); });
  rawLc = vi.spyOn(lcChange, 'changeLifecycle').mockImplementation(() => { throw new Error('WRITE OUTSIDE GATE'); });
  vi.spyOn(aap, 'getUserDetails').mockResolvedValue({ userName: 'zuser', activeFeatures: ['ESCALATE_SERVICE'] });
  vi.spyOn(aap, 'getService').mockResolvedValue({ escalations: ['MCS_LEAD'] });
});
afterEach(() => {
  expect(rawEsc).not.toHaveBeenCalled();
  expect(rawLc).not.toHaveBeenCalled();
  gate._setDepsForTest({});
  vi.restoreAllMocks();
});

const esc = (o = {}) => Object.assign({ workRequestId: WR, aaid: 'aaid_1', add: ['MCS_LEAD'], remove: [], comment: 'UNIT DOWN 3 DAYS', unit: 'B62020' }, o);
const lc = (o = {}) => Object.assign({ equipmentId: '322168', assetUrl: 'https://aap/asset/1', state: 'Active', reason: 'HEALTHY', fromState: 'Unavailable', confirmed: true }, o);

describe('relay:escalate', () => {
  it('prompts with kind updateEscalations; deny -> no write', async () => {
    const p = call('relay:escalate', esc());
    await flush(); await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(sent[0].d.kind).toBe('updateEscalations');
    expect(sent[0].d.preview).toContain('Add: MCS_LEAD');
    await handlers['relayWrites:respond']({}, sent[0].d.id, false);
    const r = await p;
    expect(r).toMatchObject({ ok: false, outcome: 'skipped-not-approved' });
    expect(fakeEsc).not.toHaveBeenCalled();
  });

  it('approve -> one write with createdBy from getUserDetails, current re-read', async () => {
    const p = call('relay:escalate', esc({ createdBy: 'spoofed' }));
    await flush(); await flush();
    await handlers['relayWrites:respond']({}, sent[0].d.id, true);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('sent');
    expect(r.current).toEqual(['MCS_LEAD']);
    expect(fakeEsc).toHaveBeenCalledTimes(1);
    expect(fakeEsc.mock.calls[0][0]).toEqual({ workRequestId: WR, aaid: 'aaid_1', add: ['MCS_LEAD'], remove: [], comment: 'UNIT DOWN 3 DAYS', createdBy: 'zuser' });
  });

  it('de-escalate sends remove:[team], add:[]', async () => {
    const p = call('relay:escalate', esc({ add: [], remove: ['FAS'], comment: '' }));
    await flush(); await flush();
    expect(sent[0].d.preview.split('\n')[0]).toBe('Relay write: remove escalation');
    await handlers['relayWrites:respond']({}, sent[0].d.id, true);
    await p;
    expect(fakeEsc).toHaveBeenCalledTimes(1);
    expect(fakeEsc.mock.calls[0][0]).toMatchObject({ add: [], remove: ['FAS'] });
  });

  it('an invalid change -> ESCALATION_INVALID, nothing staged', async () => {
    const r = await call('relay:escalate', esc({ comment: '' }));
    expect(r).toMatchObject({ ok: false, code: 'ESCALATION_INVALID' });
    const r2 = await call('relay:escalate', esc({ add: 'MCS_LEAD' }));
    expect(r2).toMatchObject({ ok: false, code: 'ESCALATION_INVALID' });
    expect(gate.list().items).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(fakeEsc).not.toHaveBeenCalled();
  });

  it('a non-UUID WR is refused', async () => {
    const r = await call('relay:escalate', esc({ workRequestId: 'WR-1' }));
    expect(r.ok).toBe(false);
    expect(gate.list().items).toHaveLength(0);
  });

  it('feature off -> ESCALATE_NOT_ENABLED', async () => {
    aap.getUserDetails.mockResolvedValue({ userName: 'zuser', activeFeatures: [] });
    const r = await call('relay:escalate', esc());
    expect(r).toMatchObject({ ok: false, code: 'ESCALATE_NOT_ENABLED' });
    expect(gate.list().items).toHaveLength(0);
  });
});

describe('relay:change-lifecycle', () => {
  it('without confirmed -> CONFIRM_REQUIRED, no prompt, no write', async () => {
    for (const p of [lc({ confirmed: undefined }), lc({ confirmed: 'true' }), lc({ confirmed: 1 })]) {
      const r = await call('relay:change-lifecycle', p);
      expect(r).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' });
    }
    expect(sent).toHaveLength(0);
    expect(gate.list().items).toHaveLength(0);
    expect(fakeLc).not.toHaveBeenCalled();
  });

  it('END_OF_LIFE -> STATE_NOT_ALLOWED', async () => {
    for (const state of ['END_OF_LIFE', 'End of Life', 'Bogus']) {
      const r = await call('relay:change-lifecycle', lc({ state }));
      expect(r).toMatchObject({ ok: false, code: 'STATE_NOT_ALLOWED' });
    }
    expect(gate.list().items).toHaveLength(0);
  });

  it('confirmed + deny -> no write', async () => {
    const p = call('relay:change-lifecycle', lc());
    await flush();
    expect(sent[0].d.kind).toBe('setLifecycle');
    expect(sent[0].d.preview).toContain('Change: Unavailable → Active');
    await handlers['relayWrites:respond']({}, sent[0].d.id, false);
    expect((await p).outcome).toBe('skipped-not-approved');
    expect(fakeLc).not.toHaveBeenCalled();
  });

  it('confirmed + approve -> one write with the label-form state', async () => {
    const p = call('relay:change-lifecycle', lc());
    await flush();
    await handlers['relayWrites:respond']({}, sent[0].d.id, true);
    const r = await p;
    expect(r).toMatchObject({ ok: true, outcome: 'sent', result: { success: true } });
    expect(fakeLc).toHaveBeenCalledTimes(1);
    expect(fakeLc.mock.calls[0][0]).toEqual({ equipmentId: '322168', assetUrl: 'https://aap/asset/1', state: 'Active', reason: 'HEALTHY', fromState: 'Unavailable' });
  });
});

describe('relay:lifecycle-options', () => {
  it('filters END_OF_LIFE and returns the supported reasons', async () => {
    vi.spyOn(lcApi, 'getValidStates').mockResolvedValue(['ACTIVE', 'UNAVAILABLE', 'END_OF_LIFE', 'ORDERED']);
    const r = await call('relay:lifecycle-options', { fleetId: 'F1' });
    expect(r.ok).toBe(true);
    expect(r.states).toEqual(['ACTIVE', 'UNAVAILABLE', 'ORDERED']);
    expect(r.reasons).toEqual(lcApi.getSupportedReasons());
  });

  it('falls back to ALLOWED_STATES when the live read fails', async () => {
    vi.spyOn(lcApi, 'getValidStates').mockRejectedValue(new Error('offline'));
    const r = await call('relay:lifecycle-options', {});
    expect(r.states).toEqual(lcApi.ALLOWED_STATES);
    expect(r.states).not.toContain('END_OF_LIFE');
  });
});

describe('relay:draft-action', () => {
  const actionDraft = require('../src/writes/relay-action-draft');
  const UNIT = { equipmentId: 'B62020', workRequestId: WR, vendor: 'Cox', created: '2026-11-17T12:00:00.000Z' };
  beforeEach(() => { askCalls.length = 0; actionDraft._setDepsForTest({ store: memStore(), now: () => new Date(2026, 10, 19, 12, 0, 0) }); });
  afterEach(() => actionDraft._setDepsForTest({}));

  it('returns a draft through the AI lane and stages nothing', async () => {
    const r = await call('relay:draft-action', { workRequestId: WR, kind: 'escalation', target: 'FAS', unit: UNIT, userInputs: { estAmount: 'x' } });
    expect(r).toMatchObject({ ok: true, aiUsed: true, draft: 'VENDOR NOT RESPONDING. PLEASE PUSH FOR ETA.' });
    expect(r.freshness.stale).toBe(true);
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0].o).toMatchObject({ source: 'relay_action_draft', isolated: true, preferAki: true, timeoutMs: 150000 });
    const c = await call('relay:draft-action', { workRequestId: WR, kind: 'comment', template: 'update-request', unit: UNIT });
    expect(c.ok).toBe(true);
    expect(c.draft.split('\n')[0]).toBe('UPDATE REQUEST - COX - B62020 - <FILL: component>');
    expect(gate.list().items).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(fakeEsc).not.toHaveBeenCalled();
  });

  it('a bad kind / target / template / WR / unit -> error, no AI call', async () => {
    for (const p of [
      { workRequestId: WR, kind: 'comment', template: 'free-form', unit: UNIT },
      { workRequestId: WR, kind: 'comment', template: 'bogus', unit: UNIT },
      { workRequestId: WR, kind: 'escalation', target: 'TOWING', unit: UNIT },
      { workRequestId: WR, kind: 'send', unit: UNIT },
      { workRequestId: 'WR-1', kind: 'escalation', target: 'FAS', unit: UNIT },
      { workRequestId: WR, kind: 'escalation', target: 'FAS' },
    ]) {
      const r = await call('relay:draft-action', p);
      expect(r.ok).toBe(false);
      expect(r.code).toBeTruthy();
    }
    expect(askCalls).toHaveLength(0);
    expect(gate.list().items).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
