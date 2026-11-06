// tests/email-intel-job.test.js — durable job type emailTriage (design 8.3, 8.4; NFR-12). Real jobs module on a
// temp data dir (pattern tests/jobs-adopt-repair-intel.test.js); fake OWA world, no Outlook, no model.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { inboxRows } from './fixtures/email-intel/emails.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30_000 });                 // scan-level tests: many store writes on slow Windows temp dirs
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');
const ON = { enabled: true, types: { emailTriage: true } };
let h = null;
function harness(n) {
  engine.close();
  h = makeHarness({ Inbox: inboxRows('Inbox', n) });
  return h;
}
const rows = () => engine.getDb().prepare("SELECT type, scope_key, state, attempt, checkpoint_json, last_error FROM jobs WHERE type = 'emailTriage' ORDER BY created_at").all();
afterEach(() => {
  try { require('../src/email-intel/reliability/job')._setJobsForTests(null); } catch (_) { /* module */ }
  jobs._resetForTests(); engine.close();
  if (h) h.cleanup(); h = null;
});

describe('NFR-12 jobs flag OFF', () => {
  it('NFR-12 with jobs.emailTriage.durable off the scan uses the NOOP handle: no transactional.sqlite, same outcome', async () => {
    harness(3);
    jobs._resetForTests({ flags: { enabled: false, types: {} } });
    expect(jobs.init()).toEqual({ mode: 'off' });
    const res = await h.run({ max: 25 });
    expect(res.intel.outcome).toBe('complete');
    expect(res.emails).toHaveLength(3);
    expect(fs.existsSync(path.join(h.tmp, 'transactional.sqlite'))).toBe(false);
    expect(h.idx.getStatus().jobs).toMatchObject({ type: 'emailTriage', mode: 'off', effective: false, open: null });
  });

  it('NFR-12 the master jobs switch alone (type flag off) keeps emailTriage non-durable', async () => {
    harness(2);
    jobs._resetForTests({ flags: { enabled: true, types: { repairIntel: true } } });
    expect(jobs.init()).toEqual({ mode: 'active' });
    await h.run({ max: 25 });
    expect(rows()).toEqual([]);
    expect(jobs.isEffective('emailTriage')).toBe(false);
  });
});

describe('durable emailTriage job (flag ON)', () => {
  it('a scan runs as one emailTriage job (scope mailbox) that completes with a small progress checkpoint', async () => {
    harness(7);
    jobs._resetForTests({ flags: ON });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const res = await h.run({ max: 25 });
    expect(res.intel.outcome).toBe('complete');
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: 'emailTriage', scope_key: 'mailbox', state: 'completed', attempt: 1 });
    const ck = JSON.parse(r[0].checkpoint_json);
    expect(ck).toMatchObject({ scanId: res.intel.scanId, folderIdx: 0, rows: 7, newMessages: 7, outcome: 'complete', partial: false });
    expect(r[0].checkpoint_json.length).toBeLessThan(16 * 1024);
    // no message content in the job row
    for (const e of res.emails) { expect(r[0].checkpoint_json).not.toContain(e.subject); expect(r[0].checkpoint_json).not.toContain(e.from); }
    expect(h.idx.getStatus().jobs).toMatchObject({ mode: 'active', effective: true, open: null });
  });

  it('an auth-blocked scan fails its job with an enum error; the next scan is a new job and completes', async () => {
    harness(3);
    jobs._resetForTests({ flags: ON });
    jobs.init();
    const blocked = await h.run({ _warm: async () => ({ authWall: true, url: 'https://login.microsoftonline.com/x' }) });
    expect(blocked.intel.outcome).toBe('auth-blocked');
    let r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ state: 'failed', last_error: 'auth-blocked' });
    const ok = await h.run({ max: 25 });
    expect(ok.intel.outcome).toBe('complete');
    r = rows();
    expect(r.map((x) => x.state)).toEqual(['failed', 'completed']);
  });

  it('a failed read fails its job (never left running) and clears scan.current', async () => {
    harness(2);
    jobs._resetForTests({ flags: ON });
    jobs.init();
    const res = await h.run({ _readMailbox: async () => { throw new Error('reader exploded'); } });
    expect(res.intel.outcome).toBe('failed');
    expect(h.ck().scan.current).toBeNull();
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ state: 'failed', last_error: 'failed' });
  });

  it('busy: another live run owning the mailbox scope makes the scan skip with busy-other-run (no read)', async () => {
    harness(3);
    jobs._resetForTests({ flags: ON });
    jobs.init();
    const other = jobs.begin({ type: 'emailTriage', scopeKey: 'mailbox' });   // a live run (e.g. another window of the app)
    expect(other.durable).toBe(true);
    other.start();
    const res = await h.run({ max: 25 });
    expect(res.skipped).toBe('busy-other-run');
    expect(res.intel.outcome).toBe('skipped');
    expect(h.world.openLog).toHaveLength(0);
    expect(h.ck().scan.current).toBeNull();
    // the scheduled tick treats it as a skip, not a failure
    const auto = { runs: 0, lastOutcome: null, lastError: null, skipped: { busy: 0, standby: 0 } };
    const tick = await h.idx.scheduledTick({}, { autoApplyUnitUpdates: true }, { autoStatus: auto, notify: () => {}, loadResults: () => ({}), _scanOpts: { folders: ['Inbox'], _electron: h.electron, _warm: async () => ({}), _sleep: async () => {}, authGraceMs: 20, _triageEmails: h.triage } });
    expect(tick.skipped).toBe('busy-other-run');
    expect(auto.lastOutcome).toBe('skipped');
    other.complete({});
    const after = await h.run({ max: 25 });
    expect(after.intel.outcome).toBe('complete');
  });

  it('job wrapper: busy handle -> skipped; checkpoint over 16 KB dropped; finish maps outcomes; fail takes enum codes only', () => {
    const job = require('../src/email-intel/reliability/job');
    harness(1);
    job._setJobsForTests({ begin: () => ({ busy: true }) });
    expect(job.begin()).toEqual({ skipped: 'busy-other-run' });
    const calls = [];
    const fake = { durable: true, start: () => calls.push('start'), setCheckpoint: (o) => calls.push(['ck', Object.keys(o)]), complete: (s) => calls.push(['complete', s]), fail: (e) => calls.push(['fail', e.message]) };
    job._setJobsForTests({ begin: () => fake });
    const j = job.begin();
    expect(j.durable).toBe(true);
    expect(j.checkpoint({ scanId: 'sc_1', rows: 1 })).toBe(true);
    expect(j.checkpoint({ big: 'x'.repeat(17 * 1024) })).toBe(false);
    j.finish('partial', { scanId: 'sc_1' });
    j.finish('complete');                                                       // only once
    expect(calls).toEqual(['start', ['ck', ['scanId', 'rows']], ['complete', { outcome: 'partial', scanId: 'sc_1' }]]);
    const j2 = job.begin(); calls.length = 0;
    j2.fail('Subject: secret text');
    expect(calls).toEqual([['fail', 'exception']]);
    const j3 = job.begin(); calls.length = 0;
    j3.finish('aborted');
    expect(calls).toEqual([['fail', 'aborted']]);
  });
});
