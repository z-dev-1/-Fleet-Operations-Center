// tests/email-intel-lock.test.js — R8.2 / AC-3 single-flight: manual and chat calls join a running scan,
// scheduled calls skip, the lock is released on throw, and the runTriage entry point is covered.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { inboxRows } from './fixtures/email-intel/emails.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const lock = require('../src/email-intel/reliability/lock');

describe('lock.run', () => {
  beforeEach(() => lock._reset());
  it('R8.2 manual joins, scheduled skips, independent of comms mode', async () => {
    let release; let runs = 0;
    const work = () => new Promise((r) => { runs++; release = r; });
    const a = lock.run('manual', work);
    const b = lock.run('manual', work);
    const c = lock.run('chat', work);
    const s = await lock.run('scheduled', work);
    expect(s).toEqual({ skipped: 'busy' });
    expect(lock.isBusy()).toBe(true);
    expect(lock.current()).toMatchObject({ trigger: 'manual' });
    release({ v: 1 });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(runs).toBe(1);
    expect(ra).toEqual({ coalesced: false, value: { v: 1 } });
    expect(rb.coalesced).toBe(true); expect(rc.coalesced).toBe(true);
    expect(rb.value).toBe(ra.value);
    expect(lock.isBusy()).toBe(false);
    const src = fs.readFileSync(require.resolve('../src/email-intel/reliability/lock'), 'utf8');
    expect(src).not.toMatch(/require\([^)]*slack/);
  });

  it('the lock is released when the scan throws; joiners see the same failure', async () => {
    const p = lock.run('manual', async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('scan exploded'); });
    const j = lock.run('manual', async () => 'never');
    await expect(p).rejects.toThrow('scan exploded');
    await expect(j).rejects.toThrow('scan exploded');
    expect(lock.isBusy()).toBe(false);
    expect(await lock.run('scheduled', async () => 'next')).toEqual({ coalesced: false, value: 'next' });
  });
});

describe('scan-level single flight', () => {
  let h = null;
  afterEach(() => { if (h) h.cleanup(); h = null; });

  it('AC-3 a manual scan during a running scan joins it (one reader run); a scheduled tick is skipped', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 4) });
    let readerRuns = 0;
    const realCapture = require('../src/email-intel/capture/owa_capture');
    const slow = async (o) => { readerRuns++; await new Promise((r) => setTimeout(r, 30)); return realCapture.readMailbox(o); };
    const first = h.run({ _readMailbox: slow });
    const joined = h.run({ _readMailbox: slow }, 'manual');
    const chat = h.run({ _readMailbox: slow }, 'chat');
    const sched = await h.run({ _readMailbox: slow }, 'scheduled');
    expect(sched.skipped).toBe('busy');
    expect(sched.intel.outcome).toBe('skipped');
    expect(Array.isArray(sched.emails)).toBe(true);
    const [a, b, c] = await Promise.all([first, joined, chat]);
    expect(readerRuns).toBe(1);
    expect(a.intel.coalesced).toBe(false);
    expect(b.intel.coalesced).toBe(true); expect(c.intel.coalesced).toBe(true);
    expect(b.emails).toBe(a.emails);
    expect(b.intel.scanId).toBe(a.intel.scanId);
  });

  it('R8.2 runTriage entry single-flight: two concurrent runTriage calls (IPC and chat paths) share one scan', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    const triage = require('../src/scrapers/email_triage');
    let readerRuns = 0;
    const realCapture = require('../src/email-intel/capture/owa_capture');
    const opts = { folders: ['Inbox'], _electron: h.electron, _warm: async () => ({}), _sleep: async () => {}, authGraceMs: 20, _triageEmails: h.triage,
      _readMailbox: async (o) => { readerRuns++; await new Promise((r) => setTimeout(r, 20)); return realCapture.readMailbox(o); } };
    const [x, y] = await Promise.all([triage.runTriage(opts), triage.runTriage(Object.assign({}, opts))]);
    expect(readerRuns).toBe(1);
    expect(x.emails).toHaveLength(3);
    expect(y.intel.coalesced).toBe(true);
    expect(x.intel.coalesced).toBe(false);
  });
});
