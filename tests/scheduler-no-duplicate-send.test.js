// tests/scheduler-no-duplicate-send.test.js
//
// Regression for duplicate SOS/EOS emails (2026-10-26). Evidence from the live
// ledger: every scope had TWO "build + owa send" runs ~15-30s apart, because
// the 30s slot timer fired twice inside the slot minute and the ledger lease
// is re-entrant for the same job. A colliding second send could also flip
// delivery-uncertain -> retry, which later re-sent the email again.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-nodup-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
_require('../src/config/paths').setDataDir(tmpDir);
const store = _require('../src/store');
const ledger = _require('../src/scheduler/ledger');
const pipeline = _require('../src/scheduler/pipeline');

let _sendDelayMs = 0;
let _status = 'sent';
const _sendViaOwa = vi.fn(async ({ to, cc, subject }) => {
  if (_sendDelayMs) await new Promise(r => setTimeout(r, _sendDelayMs));
  return { status: _status, to, cc, subject, sentItemsMatch: { found: _status === 'sent' }, composeClosed: true, errors: _status === 'sent' ? [] : [_status] };
});
pipeline._setDeps({
  sendViaOwa: _sendViaOwa,
  buildEmail: () => '<html><body>' + 'x'.repeat(300) + '</body></html>',
  summary: { buildSubjectSuffix: () => '', commitSnapshot: () => 'k' },
});
const FRESH = { ok: true, rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0, sourcesUpdated: ['aap'], sourcesFailed: [], usedCache: false, errors: [] };
function fakeCtx() {
  return {
    lastData: { rows: Array.from({ length: 120 }, (_, i) => ({ equipmentId: 'U' + i, operator: 'TUZR', lifecycleState: 'Available' })) },
    runFullSync: vi.fn(async () => FRESH),
    getMainWindow: () => null, send: vi.fn(), pushStatus: vi.fn(),
  };
}

beforeEach(() => {
  store.save('schedulerLedger', ledger._emptyLedger());
  store.save('settings', {});
  store.save('spConfig', { emails: {} });
  store.save('fleetData', { rows: [{ equipmentId: 'U1', operator: 'TUZR', lifecycleState: 'Unavailable' }], syncedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(tmpDir, 'op_emails.json'), JSON.stringify({ TUZR: { to: 'ops@x.com', cc: '' }, SAPB: { to: 'sapb@x.com', cc: '' } }));
  pipeline._resetNotifyDedup();
  _sendViaOwa.mockClear();
  _sendDelayMs = 0; _status = 'sent';
});

describe('concurrent triggers for the same slot', () => {
  it('two overlapping runEmailSlot calls send each scope exactly once', async () => {
    _sendDelayMs = 50; // keep the first run in flight while the second arrives
    const spec = { dateKey: '2026-08-14', slotLabel: '07:25', origin: 'scheduled', testMode: false };
    const [a, b] = await Promise.all([
      pipeline.runEmailSlot(fakeCtx(), spec),
      pipeline.runEmailSlot(fakeCtx(), { ...spec, origin: 'catchup' }),
    ]);
    expect(_sendViaOwa).toHaveBeenCalledTimes(2); // TUZR + SAPB, once each
    const subjects = _sendViaOwa.mock.calls.map(c => c[0].subject);
    expect(new Set(subjects).size).toBe(2);
    expect([a.skipped, b.skipped]).toContain('in-flight');
  });

  it('a later re-run of a completed slot sends nothing', async () => {
    const spec = { dateKey: '2026-08-14', slotLabel: '07:25', origin: 'scheduled', testMode: false };
    await pipeline.runEmailSlot(fakeCtx(), spec);
    _sendViaOwa.mockClear();
    await pipeline.runEmailSlot(fakeCtx(), spec);
    expect(_sendViaOwa).not.toHaveBeenCalled();
  });
});

describe('scheduleRetry never overrides a delivered/uncertain state', () => {
  it('delivery-uncertain stays delivery-uncertain', async () => {
    _status = 'delivery-uncertain';
    const r = await pipeline.runEmailSlot(fakeCtx(), { dateKey: '2026-08-14', slotLabel: '07:25', origin: 'scheduled', testMode: false });
    const job = ledger.getJob(ledger.listJobs({ channel: ledger.CHANNELS.EMAIL })[0].jobId);
    expect(job.state).toBe(ledger.STATES.DELIVERY_UNCERTAIN);
    const rt = await ledger.scheduleRetry(job.jobId, { class: 'transient', message: 'late collision' });
    expect(rt.ok).toBe(false);
    expect(rt.skipped).toBe(ledger.STATES.DELIVERY_UNCERTAIN);
    expect(ledger.getJob(job.jobId).state).toBe(ledger.STATES.DELIVERY_UNCERTAIN);
    expect(r.outcomes.length).toBe(2);
  });

  it('a genuinely failed send still schedules a retry', async () => {
    _status = 'failed';
    await pipeline.runEmailSlot(fakeCtx(), { dateKey: '2026-08-14', slotLabel: '07:25', origin: 'scheduled', testMode: false });
    const states = ledger.listJobs({ channel: ledger.CHANNELS.EMAIL }).map(j => j.state);
    expect(states.every(s => s === ledger.STATES.RETRY)).toBe(true);
  });
});
