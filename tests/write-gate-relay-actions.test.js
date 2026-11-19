// tests/write-gate-relay-actions.test.js — the write gate's updateEscalations and
// setLifecycle kinds (src/writes/write-gate.js): interactive approve sends once with
// the stored payload, deny / timeout send nothing, the non-interactive queue sends
// only on approve(id), the preview shows teams / comment / from → to, logs never
// carry the comment text, and a { success:false } lifecycle result is send-failed.
// All sends are recording fakes; nothing reaches the network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const gate = require('../src/writes/write-gate');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const COMMENT = 'SECRET REASON TEXT est $4,850 waiting on approval';

function memStore() {
  const data = {};
  return {
    data,
    load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

let escCalls, lcCalls, logs, win, sent, lcResult;
function setup(over = {}) {
  escCalls = [];
  lcCalls = [];
  logs = [];
  sent = [];
  lcResult = { success: true, message: 'ok' };
  win = { isDestroyed: () => false, webContents: { send: vi.fn((ch, data) => sent.push({ ch, data })) } };
  gate._setDepsForTest(Object.assign({
    store: memStore(),
    notify: () => {},
    log: (m) => logs.push(m),
    flags: { requireApproval: true },
    updateEscalations: async (p) => { escCalls.push(p); return { ok: true, add: p.add, remove: p.remove }; },
    setLifecycle: async (p) => { lcCalls.push(p); return lcResult; },
  }, over));
  gate.setWindowGetter(null);
}
const escSpec = (o = {}) => Object.assign({
  kind: 'updateEscalations', origin: 'unit-detail-escalate', unit: 'B62020', workRequestId: WR,
  payload: { workRequestId: WR, aaid: 'aaid_1', add: ['MCS_LEAD'], remove: [], comment: COMMENT, createdBy: 'zuser' },
  interactive: false,
}, o);
const lcSpec = (o = {}) => Object.assign({
  kind: 'setLifecycle', origin: 'unit-detail-lifecycle', unit: '322168',
  payload: { equipmentId: '322168', assetUrl: 'https://aap/asset/1', state: 'Active', reason: 'HEALTHY', fromState: 'Unavailable' },
  interactive: false,
}, o);
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => setup());
afterEach(() => { vi.useRealTimers(); gate._setDepsForTest({}); gate.setWindowGetter(null); });

describe('updateEscalations kind', () => {
  it('interactive approve -> exactly one send with the stored payload', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(escSpec({ interactive: true, aiDrafted: true }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(sent[0].data.kind).toBe('updateEscalations');
    gate.respond(sent[0].data.id, true);
    const r = await p;
    expect(r.outcome).toBe('sent');
    expect(r.ok).toBe(true);
    expect(escCalls).toEqual([{ workRequestId: WR, aaid: 'aaid_1', add: ['MCS_LEAD'], remove: [], comment: COMMENT, createdBy: 'zuser' }]);
  });

  it('deny -> zero sends', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(escSpec({ interactive: true }));
    await flush();
    gate.respond(sent[0].data.id, false);
    const r = await p;
    expect(r.outcome).toBe('skipped-not-approved');
    expect(escCalls).toHaveLength(0);
  });

  it('timeout -> zero sends', async () => {
    vi.useFakeTimers();
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(escSpec({ interactive: true }));
    await vi.advanceTimersByTimeAsync(gate.APPROVAL_WAIT_MS + 10);
    const r = await p;
    expect(r.outcome).toBe('skipped-not-approved');
    expect(escCalls).toHaveLength(0);
  });

  it('non-interactive -> pending-approval, then approve(id) sends once', async () => {
    const r = await gate.requestWrite(escSpec());
    expect(r.outcome).toBe('pending-approval');
    expect(escCalls).toHaveLength(0);
    const a = await gate.approve(r.id);
    expect(a.outcome).toBe('sent');
    expect(escCalls).toHaveLength(1);
    const again = await gate.approve(r.id);
    expect(again.ok).toBe(false);
    expect(escCalls).toHaveLength(1);
  });

  it('a failed update maps to send-failed', async () => {
    setup({ updateEscalations: async () => ({ ok: false, error: 'boom' }) });
    const r = await gate.requestWrite(escSpec());
    const a = await gate.approve(r.id);
    expect(a).toMatchObject({ ok: false, outcome: 'send-failed', error: 'boom' });
  });

  it('logs carry lengths only, never the comment text', async () => {
    const r = await gate.requestWrite(escSpec());
    await gate.approve(r.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain('SECRET REASON');
    expect(logs.some((l) => l.includes('len=' + COMMENT.length))).toBe(true);
  });
});

describe('previewOf for the new kinds', () => {
  it('escalate preview lists teams and the exact comment', () => {
    const t = gate.previewOf('updateEscalations', escSpec().payload, { unit: 'B62020', origin: 'unit-detail-escalate', aiDrafted: true });
    expect(t.split('\n')[0]).toBe('Relay write: escalate work request');
    expect(t).toContain('Unit: B62020');
    expect(t).toContain('Relay WR: ' + WR + '  https://aap-na.corp.amazon.com/v2/service/' + WR);
    expect(t).toContain('Add: MCS_LEAD');
    expect(t).toContain('Remove: (none)');
    expect(t).toContain('Visibility: internal-only');
    expect(t).toContain('AI-drafted: yes');
    expect(t).toContain('Comment text (exact, ' + COMMENT.length + ' chars):\n' + COMMENT);
  });

  it('remove preview', () => {
    const t = gate.previewOf('updateEscalations', { workRequestId: WR, add: [], remove: ['FAS'], comment: '' }, { unit: 'B1' });
    expect(t.split('\n')[0]).toBe('Relay write: remove escalation');
    expect(t).toContain('Add: (none)');
    expect(t).toContain('Remove: FAS');
  });

  it('lifecycle preview shows from → to and the reason', () => {
    const t = gate.previewOf('setLifecycle', lcSpec().payload, { unit: '322168', origin: 'unit-detail-lifecycle' });
    expect(t.split('\n')[0]).toBe('AAP write: change unit lifecycle');
    expect(t).toContain('Change: Unavailable → Active');
    expect(t).toContain('Reason: HEALTHY');
    const t2 = gate.previewOf('setLifecycle', { state: 'Ordered' }, {});
    expect(t2).toContain('Change: ? → Ordered');
    expect(t2).toContain('Reason: (none)');
  });
});

describe('setLifecycle kind', () => {
  it('interactive approve -> one changeLifecycle call with the stored payload', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(lcSpec({ interactive: true }));
    await flush();
    expect(sent[0].data.kind).toBe('setLifecycle');
    expect(sent[0].data.preview).toContain('Unavailable → Active');
    gate.respond(sent[0].data.id, true);
    const r = await p;
    expect(r.outcome).toBe('sent');
    expect(lcCalls).toEqual([lcSpec().payload]);
  });

  it('deny -> zero calls', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(lcSpec({ interactive: true }));
    await flush();
    gate.respond(sent[0].data.id, false);
    expect((await p).outcome).toBe('skipped-not-approved');
    expect(lcCalls).toHaveLength(0);
  });

  it('non-interactive -> pending-approval, approve(id) sends once', async () => {
    const r = await gate.requestWrite(lcSpec());
    expect(r.outcome).toBe('pending-approval');
    expect(lcCalls).toHaveLength(0);
    expect((await gate.approve(r.id)).outcome).toBe('sent');
    expect(lcCalls).toHaveLength(1);
  });

  it('{ success:false, message } -> send-failed with the message', async () => {
    const r = await gate.requestWrite(lcSpec());
    lcResult = { success: false, message: 'Apply Change button is disabled' };
    const a = await gate.approve(r.id);
    expect(a).toMatchObject({ ok: false, outcome: 'send-failed', error: 'Apply Change button is disabled' });
    expect(gate.list().items.find((i) => i.id === r.id).state).toBe('failed');
  });
});
