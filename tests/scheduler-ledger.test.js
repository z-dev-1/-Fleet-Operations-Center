// tests/scheduler-ledger.test.js
//
// Task #3 — durable job ledger for the production backend scheduler.
// Proves: deterministic idempotency (no duplicate jobs), atomic get-or-create,
// per-channel leases + overlap protection, completed-slot keys that survive a
// simulated restart, crash recovery of expired/orphaned leases, retry backoff
// + exhaustion, never-auto-repeat a verified send, never-resend a
// delivery-uncertain job, and versioned idempotent migration.
//
// Uses the real store with an isolated temp data dir (setDataDir) so no real
// app data is touched. No fleet sync / SharePoint / email is exercised here —
// the ledger is pure bookkeeping.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-ledger-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store  = require('../src/store');
const ledger = require('../src/scheduler/ledger');
const { STATES, CHANNELS, ORIGINS } = ledger;

const DATE = '2026-08-14';

function emailSpec(over = {}) {
  return {
    channel: CHANNELS.EMAIL, dateKey: DATE, slotLabel: '08:00',
    scope: { operator: 'TUZR', domicile: 'ABE40', series: 'SOS' },
    origin: ORIGINS.SCHEDULED, testMode: false, ...over,
  };
}
function spSpec(over = {}) {
  return { channel: CHANNELS.SHAREPOINT, dateKey: DATE, slotLabel: '07:30', origin: ORIGINS.SCHEDULED, testMode: false, ...over };
}

beforeEach(() => { store.save('schedulerLedger', ledger._emptyLedger()); store.delete('schedulerLedgerBackup_v1'); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('idempotency keys', () => {
  it('email key is deterministic and scope/mode sensitive', () => {
    const k1 = ledger.buildIdempotencyKey(emailSpec());
    const k2 = ledger.buildIdempotencyKey(emailSpec());
    expect(k1).toBe(k2);
    expect(k1).toBe('email|2026-08-14|08:00|TUZR|ABE40|SOS|P');
    expect(ledger.buildIdempotencyKey(emailSpec({ testMode: true }))).toContain('|T');
    expect(ledger.buildIdempotencyKey(emailSpec({ scope: { operator: 'TUZR', domicile: 'ABE40', series: 'EOS' } }))).toContain('EOS');
  });
  it('sharepoint key ignores scope', () => {
    expect(ledger.buildIdempotencyKey(spSpec())).toBe('sharepoint|2026-08-14|07:30|P');
  });
});

describe('get-or-create (no duplicates across scheduled/catch-up/manual)', () => {
  it('creates once, then returns the same job for the same idempotency key', async () => {
    const a = await ledger.getOrCreateJob(emailSpec({ origin: ORIGINS.SCHEDULED }));
    expect(a.created).toBe(true);
    const b = await ledger.getOrCreateJob(emailSpec({ origin: ORIGINS.CATCHUP }));
    expect(b.created).toBe(false);
    expect(b.job.jobId).toBe(a.job.jobId);
    const c = await ledger.getOrCreateJob(emailSpec({ origin: ORIGINS.MANUAL }));
    expect(c.created).toBe(false);
    expect(c.job.jobId).toBe(a.job.jobId);
    expect(ledger.listJobs({ channel: CHANNELS.EMAIL }).length).toBe(1);
  });
  it('test-mode job is a SEPARATE job from the production job', async () => {
    const prod = await ledger.getOrCreateJob(emailSpec({ testMode: false }));
    const test = await ledger.getOrCreateJob(emailSpec({ testMode: true }));
    expect(test.created).toBe(true);
    expect(test.job.jobId).not.toBe(prod.job.jobId);
  });
});

describe('state machine', () => {
  it('advances through the happy path and stamps completed-slot on COMPLETED', async () => {
    const { job } = await ledger.getOrCreateJob(spSpec());
    await ledger.transition(job.jobId, STATES.SYNCING);
    await ledger.transition(job.jobId, STATES.VALIDATING);
    await ledger.transition(job.jobId, STATES.RUNNING);
    await ledger.transition(job.jobId, STATES.VERIFYING);
    const r = await ledger.transition(job.jobId, STATES.COMPLETED);
    expect(r.ok).toBe(true);
    expect(ledger.getJob(job.jobId).state).toBe(STATES.COMPLETED);
    expect(ledger.isSlotCompleted(CHANNELS.SHAREPOINT, DATE, '07:30')).toBe(true);
  });
  it('rejects an illegal transition', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    const r = await ledger.transition(job.jobId, STATES.COMPLETED); // queued -> completed not allowed
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/illegal transition/);
  });
  it('a same-state transition applies a patch without moving (records recipients in running)', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(job.jobId, STATES.RUNNING);
    const r = await ledger.transition(job.jobId, STATES.RUNNING, { intendedRecipients: ['a@x.com'], actualRecipients: ['a@x.com'] });
    expect(r.ok).toBe(true);
    expect(ledger.getJob(job.jobId).state).toBe(STATES.RUNNING);
    expect(ledger.getJob(job.jobId).intendedRecipients).toEqual(['a@x.com']);
  });
  it('VERIFYING can transition to BLOCKED_AUTH (regression: orphaned-verifying bug)', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(job.jobId, STATES.RUNNING);
    await ledger.transition(job.jobId, STATES.VERIFYING);
    const r = await ledger.transition(job.jobId, STATES.BLOCKED_AUTH);
    expect(r.ok).toBe(true);
    expect(ledger.getJob(job.jobId).state).toBe(STATES.BLOCKED_AUTH);
  });
  it('RUNNING can transition directly to BLOCKED_AUTH (new send-from-running flow)', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(job.jobId, STATES.RUNNING);
    const r = await ledger.transition(job.jobId, STATES.BLOCKED_AUTH);
    expect(r.ok).toBe(true);
  });
});

describe('leases + overlap protection', () => {
  it('a second job cannot claim a channel already leased', async () => {
    const a = await ledger.getOrCreateJob(spSpec());
    const b = await ledger.getOrCreateJob(spSpec({ dateKey: '2026-08-15' })); // different slot key, same channel
    const la = await ledger.acquireLease(CHANNELS.SHAREPOINT, a.job.jobId);
    expect(la.ok).toBe(true);
    const lb = await ledger.acquireLease(CHANNELS.SHAREPOINT, b.job.jobId);
    expect(lb.ok).toBe(false);
    expect(lb.heldBy).toBe(a.job.jobId);
  });
  it('isChannelBusy reflects active states', async () => {
    const { job } = await ledger.getOrCreateJob(spSpec());
    expect(ledger.isChannelBusy(CHANNELS.SHAREPOINT)).toBe(false);
    await ledger.transition(job.jobId, STATES.RUNNING);
    expect(ledger.isChannelBusy(CHANNELS.SHAREPOINT)).toBe(true);
    expect(ledger.isChannelBusy(CHANNELS.SHAREPOINT, job.jobId)).toBe(false); // except self
  });
  it('lease released on terminal/paused transition', async () => {
    const { job } = await ledger.getOrCreateJob(spSpec());
    await ledger.acquireLease(CHANNELS.SHAREPOINT, job.jobId);
    await ledger.transition(job.jobId, STATES.RUNNING);
    await ledger.transition(job.jobId, STATES.BLOCKED_AUTH);
    // lease should be gone -> another job can claim
    const other = await ledger.getOrCreateJob(spSpec({ dateKey: '2026-08-16' }));
    const l = await ledger.acquireLease(CHANNELS.SHAREPOINT, other.job.jobId);
    expect(l.ok).toBe(true);
  });
});

describe('completed-slot survives restart', () => {
  it('isSlotCompleted reads persisted store (simulated fresh module state)', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(job.jobId, STATES.RUNNING);
    await ledger.transition(job.jobId, STATES.VERIFYING);
    await ledger.transition(job.jobId, STATES.COMPLETED);
    // Re-read purely from persisted store (ledger keeps no in-memory slot cache)
    const persisted = store.load('schedulerLedger', {});
    expect(persisted.completedSlots['2026-08-14-08:00']).toBeTruthy();
    expect(ledger.isSlotCompleted(CHANNELS.EMAIL, DATE, '08:00')).toBe(true);
  });
});

describe('crash recovery', () => {
  it('reclaims expired leases and classifies jobs for resumption', async () => {
    // SENT job -> resumeCommit
    const sent = await ledger.getOrCreateJob(emailSpec({ slotLabel: '08:00' }));
    await ledger.transition(sent.job.jobId, STATES.RUNNING);
    await ledger.transition(sent.job.jobId, STATES.SENT);
    // RUNNING orphaned -> reevaluate (with a stale lease)
    const running = await ledger.getOrCreateJob(spSpec());
    await ledger.acquireLease(CHANNELS.SHAREPOINT, running.job.jobId, 1); // 1ms lease -> expires immediately
    await ledger.transition(running.job.jobId, STATES.RUNNING);
    await new Promise(r => setTimeout(r, 5));
    const rec = await ledger.recoverOnStartup();
    expect(rec.resumeCommit).toContain(sent.job.jobId);
    expect(rec.reevaluate).toContain(running.job.jobId);
    expect(rec.reclaimedLeases).toBeGreaterThanOrEqual(1);
  });
  it('never returns a delivery-uncertain job for auto resumption', async () => {
    const j = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(j.job.jobId, STATES.RUNNING);
    await ledger.transition(j.job.jobId, STATES.DELIVERY_UNCERTAIN);
    const rec = await ledger.recoverOnStartup();
    expect(rec.resumeCommit).not.toContain(j.job.jobId);
    expect(rec.resumeVerify).not.toContain(j.job.jobId);
    expect(rec.reevaluate).not.toContain(j.job.jobId);
  });
});

describe('retries', () => {
  it('backoff increases then exhausts to FAILED', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec({ maxAttempts: 2 }));
    await ledger.transition(job.jobId, STATES.RUNNING);
    const r1 = await ledger.scheduleRetry(job.jobId, { class: 'transient', message: 'net' });
    expect(r1.exhausted).toBe(false);
    expect(r1.nextRetryAt).toBeGreaterThan(Date.now());
    const r2 = await ledger.scheduleRetry(job.jobId, { class: 'transient', message: 'net' });
    expect(r2.exhausted).toBe(true);
    expect(ledger.getJob(job.jobId).state).toBe(STATES.FAILED);
  });
});

describe('never auto-repeat a verified send', () => {
  it('re-creating a completed job returns the completed job untouched', async () => {
    const { job } = await ledger.getOrCreateJob(emailSpec());
    await ledger.transition(job.jobId, STATES.RUNNING);
    await ledger.transition(job.jobId, STATES.VERIFYING);
    await ledger.transition(job.jobId, STATES.COMPLETED);
    const again = await ledger.getOrCreateJob(emailSpec({ origin: ORIGINS.CATCHUP }));
    expect(again.created).toBe(false);
    expect(again.job.state).toBe(STATES.COMPLETED);
    expect(again.reason).toMatch(/completed/);
  });
});

describe('migration (versioned, idempotent)', () => {
  it('creates ledger + backup once, is a no-op on re-run', () => {
    store.delete('schedulerLedger');
    store.delete('schedulerLedgerBackup_v1');
    const r1 = ledger.migrate();
    expect(r1.created).toBe(true);
    expect(r1.noop).toBe(false);
    expect(store.load('schedulerLedgerBackup_v1', null)).toBeTruthy();
    const r2 = ledger.migrate();
    expect(r2.noop).toBe(true);
    expect(r2.created).toBe(false);
  });
  it('dryRun writes nothing', () => {
    store.save('schedulerLedger', ledger._emptyLedger());
    store.delete('schedulerLedgerBackup_v1');
    const r = ledger.migrate({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(store.load('schedulerLedgerBackup_v1', null)).toBeNull();
  });
});
