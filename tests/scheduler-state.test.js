// tests/scheduler-state.test.js
//
// Task #8 — authoritative Scheduler state aggregator + config setters.
// Proves getState() surfaces STRUCTURED ledger data (jobs, states, last
// verified/failure, recipients intended-vs-actual, enabled flags, freshness,
// next slots) with no secrets/bodies, and that setEnabled/setFreshness persist
// to settings. No Electron, no live side effects.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-state-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

const store = require('../src/store');
const ledger = require('../src/scheduler/ledger');
const scheduler = require('../src/scheduler');

const DATE = (() => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); })();

beforeEach(() => {
  store.save('schedulerLedger', ledger._emptyLedger());
  store.save('settings', {});
  store.save('fleetData', { rows: [{ equipmentId: 'U1' }, { equipmentId: 'U2' }, { equipmentId: 'U3' }], syncedAt: new Date().toISOString() });
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('getState shape', () => {
  it('returns enabled flags, slots, next slots, data age, freshness', () => {
    const s = scheduler.getState();
    expect(s.enabled).toHaveProperty('sp');
    expect(s.enabled).toHaveProperty('email');
    expect(Array.isArray(s.slots.sp)).toBe(true);
    expect(Array.isArray(s.slots.email)).toBe(true);
    expect(s.data.rowCount).toBe(3);
    expect(s.freshness).toBeTruthy();
    expect(s.timezone).toBeTruthy();
  });

  it('surfaces a completed email job with recipients (intended vs actual, no bodies)', async () => {
    const { job } = await ledger.getOrCreateJob({
      channel: ledger.CHANNELS.EMAIL, dateKey: DATE, slotLabel: '08:00',
      scope: { operator: 'TUZR', domicile: 'ABE40', series: 'SOS' }, origin: ledger.ORIGINS.SCHEDULED, testMode: false,
      intendedRecipients: ['ops@x.com'], actualRecipients: ['ops@x.com'],
    });
    await ledger.transition(job.jobId, ledger.STATES.RUNNING);
    await ledger.transition(job.jobId, ledger.STATES.VERIFYING);
    await ledger.transition(job.jobId, ledger.STATES.SENT);
    await ledger.transition(job.jobId, ledger.STATES.COMPLETED);

    const s = scheduler.getState();
    expect(s.email.lastVerified).toBeTruthy();
    expect(s.email.lastVerified.intendedRecipients).toEqual(['ops@x.com']);
    // Job summary must not leak an email body field.
    expect(s.email.lastVerified).not.toHaveProperty('html');
    const todays = s.jobsToday.find(j => j.jobId === job.jobId);
    expect(todays.state).toBe('completed');
    expect(Array.isArray(todays.history)).toBe(true);
  });

  it('surfaces blocked-auth and delivery-uncertain jobs under attention buckets', async () => {
    const a = await ledger.getOrCreateJob({ channel: ledger.CHANNELS.EMAIL, dateKey: DATE, slotLabel: '08:00', scope: { operator: 'A', domicile: 'ALL', series: 'SOS' }, origin: 'scheduled', testMode: false });
    await ledger.transition(a.job.jobId, ledger.STATES.RUNNING);
    await ledger.transition(a.job.jobId, ledger.STATES.BLOCKED_AUTH);
    const b = await ledger.getOrCreateJob({ channel: ledger.CHANNELS.EMAIL, dateKey: DATE, slotLabel: '08:00', scope: { operator: 'B', domicile: 'ALL', series: 'SOS' }, origin: 'scheduled', testMode: false });
    await ledger.transition(b.job.jobId, ledger.STATES.RUNNING);
    await ledger.transition(b.job.jobId, ledger.STATES.DELIVERY_UNCERTAIN);

    const s = scheduler.getState();
    expect(s.email.blockedAuth.length).toBe(1);
    expect(s.email.uncertain.length).toBe(1);
  });
});

describe('config setters persist to settings', () => {
  it('setEnabled toggles per channel', () => {
    scheduler.setEnabled({ sp: false });
    expect(store.load('settings', {}).schedulerEnabled.sp).toBe(false);
    expect(scheduler.getState().enabled.sp).toBe(false);
  });
  it('setFreshness merges policy', () => {
    scheduler.setFreshness({ email: { maxDataAgeMin: 10 } });
    expect(store.load('settings', {}).schedulerFreshness.email.maxDataAgeMin).toBe(10);
  });
});
