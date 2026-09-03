// tests/scheduler-pipeline-flow.test.js
//
// Task #7 — email pipeline FLOW with mocked sync + OWA + email builder (NO live
// email, NO BrowserWindow). Proves the end-to-end state machine behavior:
//   - verified send -> SENT -> COMPLETED + snapshot committed
//   - delivery-uncertain -> DELIVERY_UNCERTAIN and NOT auto-resent on re-run
//   - blocked-auth -> BLOCKED_AUTH, snapshot NOT advanced
//   - stale data -> BLOCKED_STALE_DATA (production hard-block)
//   - one-shot note cleared ONLY after all production scopes verified sent
//   - test mode blocked without a test recipient
//
// Uses vi.mock (hoisted) for the Electron-touching collaborators and dynamic
// import() so the mocks apply. setDataDir runs first via a plain require.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-flow-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
_require('../src/config/paths').setDataDir(tmpDir);

// Collaborators are injected via pipeline._setDeps — no vi.mock / loader tricks.
const store = _require('../src/store');
const ledger = _require('../src/scheduler/ledger');
const pipeline = _require('../src/scheduler/pipeline');

let _owaStatusQueue = [];
let _snapshotCommits = [];
const _sendViaOwa = vi.fn(async ({ to, cc, subject }) => {
  const status = _owaStatusQueue.length ? _owaStatusQueue.shift() : 'sent';
  return { status, to, cc, subject, sentItemsMatch: status === 'sent' ? { found: true } : { found: false }, composeClosed: true, errors: status === 'sent' ? [] : [status] };
});
pipeline._setDeps({
  sendViaOwa: _sendViaOwa,
  buildEmail: () => '<html><body>' + 'x'.repeat(300) + '</body></html>',
  summary: { buildSubjectSuffix: () => '', commitSnapshot: (units, slot, scopeKey) => { _snapshotCommits.push(scopeKey); return scopeKey; } },
});

function fakeCtx(syncResult) {
  return {
    lastData: { rows: Array.from({ length: 120 }, (_, i) => ({ equipmentId: 'U' + i, operator: 'TUZR', lifecycleState: 'Available' })) },
    runFullSync: vi.fn(async () => syncResult),
    getMainWindow: () => null,
    send: vi.fn(),
    pushStatus: vi.fn(),
  };
}
const FRESH = { ok: true, rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0, sourcesUpdated: ['aap'], sourcesFailed: [], usedCache: false, errors: [] };
const STALE = { ok: false, rowCount: 0, syncedAt: null, dataAgeMs: null, sourcesUpdated: [], sourcesFailed: ['aap'], usedCache: true, errors: [] };

beforeEach(() => {
  store.save('schedulerLedger', ledger._emptyLedger());
  store.save('settings', {});
  store.save('spConfig', { emails: {} });
  store.save('fleetData', { rows: [{ equipmentId: 'U1', operator: 'TUZR', lifecycleState: 'Unavailable' }], syncedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(tmpDir, 'op_emails.json'), JSON.stringify({ TUZR: { to: 'ops@x.com', cc: '' } }));
  _owaStatusQueue = []; _snapshotCommits = [];
  pipeline._resetNotifyDedup();
  _sendViaOwa.mockClear();
});
afterEach(() => { vi.clearAllMocks(); });

describe('verified send -> COMPLETED + snapshot committed', () => {
  it('all scopes sent, snapshots committed', async () => {
    const ctx = fakeCtx(FRESH);
    const r = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(r.outcomes.length).toBe(2); // TUZR x SOS/EOS
    expect(r.outcomes.every(o => o.state === ledger.STATES.COMPLETED)).toBe(true);
    expect(_snapshotCommits.length).toBe(2);
  });
});

describe('delivery-uncertain is NOT auto-resent', () => {
  it('marks DELIVERY_UNCERTAIN and re-run does not resend', async () => {
    _owaStatusQueue = ['delivery-uncertain', 'delivery-uncertain'];
    const ctx = fakeCtx(FRESH);
    const r1 = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(r1.outcomes.every(o => o.state === ledger.STATES.DELIVERY_UNCERTAIN)).toBe(true);
    expect(_snapshotCommits.length).toBe(0);
    const callsAfterFirst = _sendViaOwa.mock.calls.length;
    const r2 = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'catchup', testMode: false });
    expect(r2.outcomes.every(o => o.skipped === ledger.STATES.DELIVERY_UNCERTAIN)).toBe(true);
    expect(_sendViaOwa.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('blocked-auth -> BLOCKED_AUTH, snapshot not advanced', () => {
  it('pauses on auth wall', async () => {
    _owaStatusQueue = ['blocked-auth', 'blocked-auth'];
    const ctx = fakeCtx(FRESH);
    const r = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(r.outcomes.every(o => o.state === ledger.STATES.BLOCKED_AUTH)).toBe(true);
    expect(_snapshotCommits.length).toBe(0);
  });
});

describe('stale data -> BLOCKED_STALE_DATA (production hard-block)', () => {
  it('does not build or send on stale sync', async () => {
    const ctx = fakeCtx(STALE);
    const r = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(r.outcomes.every(o => o.state === ledger.STATES.BLOCKED_STALE_DATA)).toBe(true);
    expect(_sendViaOwa).not.toHaveBeenCalled();
  });
});

describe('one-shot note cleared ONLY after all scopes verified sent', () => {
  it('retains note when a scope is not completed', async () => {
    _owaStatusQueue = ['sent', 'delivery-uncertain'];
    store.save('settings', { autoEmailNote: 'Heads up', autoEmailNoteOneShot: true });
    const ctx = fakeCtx(FRESH);
    await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(store.load('settings', {}).autoEmailNote).toBe('Heads up');
  });
  it('clears note when all scopes completed', async () => {
    store.save('settings', { autoEmailNote: 'Heads up', autoEmailNoteOneShot: true });
    const ctx = fakeCtx(FRESH);
    await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'scheduled', testMode: false });
    expect(store.load('settings', {}).autoEmailNote).toBeUndefined();
  });
});

describe('test mode blocked without a test recipient', () => {
  it('returns blocked no-test-recipient and never sends', async () => {
    store.save('settings', {});
    const ctx = fakeCtx(FRESH);
    const r = await pipeline.runEmailSlot(ctx, { dateKey: '2026-08-14', slotLabel: '08:00', origin: 'test', testMode: true });
    expect(r.blocked).toBe('no-test-recipient');
    expect(_sendViaOwa).not.toHaveBeenCalled();
  });
});
