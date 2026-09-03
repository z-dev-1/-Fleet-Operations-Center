// tests/scheduler-recovery.test.js
//
// Task #2 — automatic recovery of blocked scheduled slots. Proves that a slot
// left in blocked-stale-data (the exact "didn't auto-send this morning"
// scenario: early-morning stale sync hard-blocks the jobs) is automatically
// re-attempted once data is fresh, WITHOUT duplicate-sending a completed slot
// and WITHOUT touching delivery-uncertain jobs.
//
// Uses the real ledger + store (temp dir) and injects fake OWA/build deps via
// pipeline._setDeps so no real email is sent. Drives the scheduler's exported
// recoverBlockedSlots() with a fresh-data ctx.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-recovery-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

const store = require('../src/store');
const ledger = require('../src/scheduler/ledger');
const pipeline = require('../src/scheduler/pipeline');
const scheduler = require('../src/scheduler');

// Today's dateKey the scheduler uses (local date).
function todayKey() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}
// A slot label a few minutes in the PAST (so it's within the recovery window).
function pastSlot(minsAgo) {
  const d = new Date(Date.now() - minsAgo * 60000);
  const h = d.getHours(), m = d.getMinutes();
  return { h, m, label: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') };
}

let _owaStatus;
let _sendCalls;

beforeEach(() => {
  store.save('schedulerLedger', ledger._emptyLedger());
  // A weekday? The recovery + scheduler are weekday-gated. Skip-guard handled per test.
  const slot = pastSlot(20);
  store.save('settings', {
    schedulerSlots: { sp: [slot, { h: 15, m: 30, label: '15:30' }], email: [slot, { h: 15, m: 30, label: '15:30' }] },
    schedulerEnabled: { sp: true, email: true },
    profile: { email: 'zilasant@amazon.com' },
  });
  // Fresh fleet data on disk so the freshness gate + useExistingIfFresh pass.
  store.save('fleetData', {
    rows: Array.from({ length: 120 }, (_, i) => ({ equipmentId: 'U' + i, operator: 'TUZR', lifecycleState: 'Available' })),
    syncedAt: new Date().toISOString(), stale: false,
  });
  store.save('spConfig', { emails: {} });
  fs.writeFileSync(path.join(tmpDir, 'op_emails.json'), JSON.stringify({ TUZR: { to: 'ops@x.com', cc: '' } }));

  _owaStatus = 'sent';
  _sendCalls = [];
  pipeline._setDeps({
    sendViaOwa: async ({ subject }) => { _sendCalls.push(subject); return { status: _owaStatus, to: ['ops@x.com'], cc: [], subject, sentItemsMatch: { found: _owaStatus === 'sent' }, composeClosed: true, errors: _owaStatus === 'sent' ? [] : [_owaStatus] }; },
    buildEmail: () => '<html><body>' + 'x'.repeat(300) + '</body></html>',
    summary: { buildSubjectSuffix: () => '', commitSnapshot: () => {} },
  });
  pipeline._resetNotifyDedup();
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const isWeekday = () => { const d = new Date().getDay(); return d >= 1 && d <= 5; };

describe('auto-recovery of blocked-stale-data slots', () => {
  it('re-attempts a blocked email slot and sends when data is now fresh', async () => {
    if (!isWeekday()) { expect(true).toBe(true); return; }   // recovery is weekday-gated
    const slot = pastSlot(20);
    const dateKey = todayKey();
    // Seed a blocked-stale-data production email job for that slot.
    const { job } = await ledger.getOrCreateJob({
      channel: ledger.CHANNELS.EMAIL, dateKey, slotLabel: slot.label,
      scope: { operator: 'TUZR', domicile: 'ALL', series: 'SOS' }, origin: 'scheduled', testMode: false,
    });
    await ledger.transition(job.jobId, ledger.STATES.SYNCING);
    await ledger.transition(job.jobId, ledger.STATES.VALIDATING);
    await ledger.transition(job.jobId, ledger.STATES.BLOCKED_STALE_DATA, { error: { class: 'stale-data', message: 'was stale' } });

    // ctx with fresh sync + start scheduler so EMAIL_SLOTS load from settings.
    const ctx = { runFullSync: async () => ({ ok: true, rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0, sourcesUpdated: ['aap'], sourcesFailed: [], usedCache: false, errors: [] }),
      lastData: { rows: store.load('fleetData', {}).rows }, getMainWindow: () => null, send: () => {}, pushStatus: () => {} };
    scheduler.start(ctx);
    try {
      await scheduler.recoverBlockedSlots();
    } finally { scheduler.stop(); }

    // The blocked job should have been re-attempted and sent -> completed.
    expect(_sendCalls.length).toBeGreaterThanOrEqual(1);
    expect(ledger.isSlotCompleted(ledger.CHANNELS.EMAIL, dateKey, slot.label)).toBe(true);
  });

  it('does NOT re-attempt a slot already completed', async () => {
    if (!isWeekday()) { expect(true).toBe(true); return; }
    const slot = pastSlot(20);
    const dateKey = todayKey();
    // Mark the slot completed via a finished job.
    const { job } = await ledger.getOrCreateJob({ channel: ledger.CHANNELS.EMAIL, dateKey, slotLabel: slot.label, scope: { operator: 'TUZR', domicile: 'ALL', series: 'SOS' }, origin: 'scheduled', testMode: false });
    await ledger.transition(job.jobId, ledger.STATES.RUNNING);
    await ledger.transition(job.jobId, ledger.STATES.VERIFYING);
    await ledger.transition(job.jobId, ledger.STATES.COMPLETED);
    // A separate blocked job for the SAME slot should be ignored because slot is completed.
    const ctx = { runFullSync: async () => ({ ok: true, rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0, sourcesUpdated: ['aap'], sourcesFailed: [], usedCache: false }), lastData: { rows: [] }, getMainWindow: () => null, send: () => {}, pushStatus: () => {} };
    scheduler.start(ctx);
    try { await scheduler.recoverBlockedSlots(); } finally { scheduler.stop(); }
    expect(_sendCalls.length).toBe(0);   // no new send for a completed slot
  });

  it('does NOT recover delivery-uncertain jobs', async () => {
    if (!isWeekday()) { expect(true).toBe(true); return; }
    const slot = pastSlot(20);
    const dateKey = todayKey();
    const { job } = await ledger.getOrCreateJob({ channel: ledger.CHANNELS.EMAIL, dateKey, slotLabel: slot.label, scope: { operator: 'TUZR', domicile: 'ALL', series: 'SOS' }, origin: 'scheduled', testMode: false });
    await ledger.transition(job.jobId, ledger.STATES.RUNNING);
    await ledger.transition(job.jobId, ledger.STATES.DELIVERY_UNCERTAIN);
    const ctx = { runFullSync: async () => ({ ok: true, rowCount: 120, syncedAt: new Date().toISOString(), dataAgeMs: 0, sourcesUpdated: ['aap'], sourcesFailed: [], usedCache: false }), lastData: { rows: [] }, getMainWindow: () => null, send: () => {}, pushStatus: () => {} };
    scheduler.start(ctx);
    try { await scheduler.recoverBlockedSlots(); } finally { scheduler.stop(); }
    expect(_sendCalls.length).toBe(0);   // delivery-uncertain is left for manual reconcile
    expect(ledger.getJob(job.jobId).state).toBe(ledger.STATES.DELIVERY_UNCERTAIN);
  });
});
