// tests/email-intel-flags.test.js — NFR-1 resolver table, dependency chain, env override,
// junk handling, NFR-3 REGISTRY keys, no files with flags OFF (design 1.1, 1.2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');
const pf = require('../src/config/perf-flags');
const flags = require('../src/email-intel/flags');
const stores = require('../src/email-intel/stores');
const store = require('../src/store');

const ALL_OFF = { capture: false, multiRecipient: false, timelineWrites: false, actionsView: false, threadReplies: false, attachments: false };
const ON = (o) => ({ email: { intel: o } });
const FULL = { enabled: true, capture: true, multiRecipient: true, timelineWrites: true, actionsView: true, threadReplies: true, attachments: true };

describe('R8.7 / NFR-1 resolveEmailIntelFlags', () => {
  it('R8.7 defaults OFF: everything false, no warnings', () => {
    const f = pf.resolveEmailIntelFlags({}, {});
    expect(f).toMatchObject({ enabled: false, capture: false, multiRecipient: false, timelineWrites: false, actionsView: false, threadReplies: false, attachments: false });
    expect(f.effective).toEqual(ALL_OFF);
    expect(f.warnings).toEqual([]);
  });

  it('env variable names are the documented ones', () => {
    expect(pf.EMAIL_INTEL_ENV).toEqual({
      enabled: 'FLEET_EMAIL_INTEL', capture: 'FLEET_EMAIL_INTEL_CAPTURE', multiRecipient: 'FLEET_EMAIL_INTEL_MULTI',
      timelineWrites: 'FLEET_EMAIL_INTEL_TIMELINE', actionsView: 'FLEET_EMAIL_INTEL_ACTIONS',
      threadReplies: 'FLEET_EMAIL_INTEL_REPLIES', attachments: 'FLEET_EMAIL_INTEL_ATTACH',
    });
  });

  it('only === true enables (strings, numbers, objects do not)', () => {
    for (const bad of ['true', 1, 'yes', {}, [], null]) {
      const f = pf.resolveEmailIntelFlags(ON({ enabled: bad, capture: bad }), {});
      expect(f.enabled).toBe(false);
      expect(f.effective.capture).toBe(false);
    }
    expect(pf.resolveEmailIntelFlags(ON({ enabled: true, capture: true }), {}).effective.capture).toBe(true);
  });

  it('master flag gates everything: sub-flags alone do nothing', () => {
    const f = pf.resolveEmailIntelFlags(ON({ ...FULL, enabled: false }), {});
    expect(f.effective).toEqual(ALL_OFF);
    expect(f.capture).toBe(true);   // raw value is kept, effective is what counts
  });

  it('dependency chain: capture -> multiRecipient -> actionsView -> timelineWrites; replies and attachments need capture and multiRecipient', () => {
    const e = (o) => pf.resolveEmailIntelFlags(ON(o), {}).effective;
    expect(e({ enabled: true, multiRecipient: true })).toEqual(ALL_OFF);                                   // no capture
    expect(e({ enabled: true, capture: true, multiRecipient: true }).multiRecipient).toBe(true);
    expect(e({ enabled: true, capture: true, actionsView: true }).actionsView).toBe(false);                // no multiRecipient
    expect(e({ enabled: true, capture: true, threadReplies: true }).threadReplies).toBe(false);
    expect(e({ enabled: true, capture: true, attachments: true }).attachments).toBe(false);
    expect(e({ enabled: true, capture: true, multiRecipient: true, threadReplies: true, attachments: true }))
      .toMatchObject({ threadReplies: true, attachments: true, actionsView: false, timelineWrites: false });
    expect(e(FULL)).toEqual({ capture: true, multiRecipient: true, timelineWrites: true, actionsView: true, threadReplies: true, attachments: true });
  });

  it('F-13 timelineWrites without actionsView is not effective and warns', () => {
    const f = pf.resolveEmailIntelFlags(ON({ enabled: true, capture: true, multiRecipient: true, timelineWrites: true }), {});
    expect(f.effective.timelineWrites).toBe(false);
    expect(f.effective.multiRecipient).toBe(true);
    expect(f.warnings).toEqual(['timelineWrites-needs-actionsView']);
    const ok = pf.resolveEmailIntelFlags(ON({ enabled: true, capture: true, multiRecipient: true, timelineWrites: true, actionsView: true }), {});
    expect(ok.effective.timelineWrites).toBe(true);
    expect(ok.warnings).toEqual([]);
  });

  it('F-13 timelineWrites set without actionsView: a scan stays in shadow mode (facts stage timeline-disabled, nothing written, status warns)', async () => {
    const { phaseCWorld, fact } = await import('./fixtures/email-intel/phase-c.js');
    const w = phaseCWorld({ enabled: true, capture: true, multiRecipient: true, timelineWrites: true });
    try {
      expect(flags.get().effective.timelineWrites).toBe(false);
      w.rules.push({ unit: '40123', fact: fact() });
      const res = await w.scan([w.cap({ subject: 'Turbo 40123', conversationId: 'conv-f13', body: 'Turbo ETA 11/12 for 40123.' })]);
      expect(w.timeline('40123')).toBe('');
      expect(w.ledger()).toEqual([]);
      expect(w.staged()).toEqual([expect.objectContaining({ unit: '40123', reason: 'timeline-disabled', detail: 'timeline writes are not enabled', state: 'open' })]);
      expect(res.emails[0].unitUpdateApplied).toBe(false);
      expect(w.idx.getStatus().warnings).toContain('timelineWrites-needs-actionsView');
    } finally { w.cleanup(); }
  });

  it("env '0'/'1' override settings both ways; junk env is ignored", () => {
    expect(pf.resolveEmailIntelFlags(ON(FULL), { FLEET_EMAIL_INTEL: '0' }).effective).toEqual(ALL_OFF);
    expect(pf.resolveEmailIntelFlags(ON(FULL), { FLEET_EMAIL_INTEL_ACTIONS: '0' }).effective).toMatchObject({ actionsView: false, timelineWrites: false });
    const viaEnv = pf.resolveEmailIntelFlags({}, { FLEET_EMAIL_INTEL: '1', FLEET_EMAIL_INTEL_CAPTURE: '1', FLEET_EMAIL_INTEL_MULTI: '1' });
    expect(viaEnv.effective).toMatchObject({ capture: true, multiRecipient: true, actionsView: false });
    const junk = pf.resolveEmailIntelFlags(ON(FULL), { FLEET_EMAIL_INTEL: 'yes', FLEET_EMAIL_INTEL_CAPTURE: 'true', FLEET_EMAIL_INTEL_MULTI: '2', FLEET_EMAIL_INTEL_REPLIES: '' });
    expect(junk.effective.capture).toBe(true);        // settings win when env is junk
    expect(pf.resolveEmailIntelFlags({}, { FLEET_EMAIL_INTEL: 'yes' }).enabled).toBe(false);
  });

  it('non-object settings are tolerated; loadEmailIntel survives a throwing load', () => {
    for (const bad of [null, undefined, 42, 'x', [], { email: 7 }, { email: { intel: [] } }, { email: { intel: 'on' } }]) {
      expect(pf.resolveEmailIntelFlags(bad, {}).effective).toEqual(ALL_OFF);
    }
    expect(pf.loadEmailIntel({ load: () => { throw new Error('io'); }, env: {} }).effective).toEqual(ALL_OFF);
    expect(pf.loadEmailIntel({ load: () => ON(FULL), env: {} }).effective.threadReplies).toBe(true);
  });

  it('existing resolvers are unchanged; JOB_TYPES only gains emailTriage (FEAT-008)', () => {
    expect(pf.JOB_TYPES).toEqual(['deepScan', 'repairIntel', 'longDwellAiFill', 'rcaAutofill', 'emailTriage']);
    expect(pf.resolveJobsFlags({}, {}).types).toEqual({ deepScan: false, repairIntel: false, longDwellAiFill: false, rcaAutofill: false, emailTriage: false });
    expect(pf.resolveWorkerFlags({}, {}).supervisorEnabled).toBe(false);
  });

  it('F-29 flag-OFF jobs status gains only an inert emailTriage entry', () => {
    const jobs = require('../src/jobs');
    const types = require('../src/jobs/types');
    try {
      jobs._resetForTests({ flags: { enabled: false, types: {} } });
      expect(jobs.init()).toEqual({ mode: 'off' });
      const sum = jobs.getSummary(Date.now());
      expect(Object.keys(sum.types)).toEqual(['deepScan', 'repairIntel', 'longDwellAiFill', 'rcaAutofill', 'emailTriage']);
      expect(sum.types.emailTriage).toEqual({ flag: false, effective: false, adopted: true, mode: 'off' });
      expect(jobs.begin({ type: 'emailTriage', scopeKey: 'mailbox' })).toBe(jobs.NOOP_HANDLE);
      expect(jobs.isEffective('emailTriage')).toBe(false);
      expect(types.get('emailTriage')).toEqual({ leaseMs: 600000, maxRunMs: 1800000, maxAttempts: 3, resumeMaxAgeMs: 7200000, sideEffects: 'none-external', recovery: 'retry', adopted: true });
      expect(types.ADOPTED.emailTriage).toBe(true);
      // the job flag alone (no master) and the env default never enable it
      expect(pf.resolveJobsFlags({ jobs: { emailTriage: { durable: true } } }, {})).toMatchObject({ enabled: false, types: { emailTriage: true } });
      expect(pf.resolveJobsFlags({ jobs: { durable: { enabled: true }, emailTriage: { durable: true } } }, { FLEET_JOBS_EMAIL_TRIAGE: '0' }).types.emailTriage).toBe(false);
    } finally { jobs._resetForTests(); }
  });

  it('the test setup forces every email-intel env var to 0', () => {
    for (const k of Object.values(pf.EMAIL_INTEL_ENV).concat(['FLEET_JOBS_EMAIL_TRIAGE'])) expect(process.env[k]).toBe('0');
  });
});

describe('email-intel/flags.js memoized wrapper', () => {
  afterEach(() => flags._setForTests(null));

  it('engaged() is effective.capture; the real environment is OFF', () => {
    flags._setForTests(null);
    expect(flags.engaged()).toBe(false);
    expect(flags.get().effective).toEqual(ALL_OFF);
  });

  it('_setForTests resolves raw flags through the chain, or takes an effective block as given', () => {
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true });
    expect(flags.engaged()).toBe(true);
    expect(flags.get().effective.multiRecipient).toBe(true);
    flags._setForTests({ enabled: true, multiRecipient: true });
    expect(flags.engaged()).toBe(false);
    flags._setForTests({ effective: { capture: true, attachments: true } });
    expect(flags.get().effective).toEqual({ ...ALL_OFF, capture: true, attachments: true });
    flags._setForTests(null);
    expect(flags.engaged()).toBe(false);
  });

  it('the value is read once per process', () => {
    flags._setForTests(null);
    const a = flags.get();
    expect(flags.get()).toBe(a);
  });
});

describe('NFR-3 store keys and no files with flags OFF', () => {
  let tmp;
  const NEW_KEYS = ['emailIntelConfig', 'emailIntelCheckpoints', 'emailIntelMessages', 'emailIntelActions', 'emailIntelTimelineLedger', 'emailIntelStaged', 'emailIntelSends'];
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ei-flags-')); setDataDir(tmp); });
  afterEach(() => { flags._setForTests(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* tmp cleanup */ } });

  it('NFR-3 REGISTRY has the 7 keys, none SQLite-backed', () => {
    const found = Object.keys(store.REGISTRY).filter((k) => k.startsWith('emailIntel'));
    expect(found).toEqual(NEW_KEYS);
    for (const k of NEW_KEYS) {
      expect(path.basename(store.REGISTRY[k]())).toMatch(/^email_intel_[a-z_]+\.json$/);
      expect(store.SQLITE_KEYS.has(k)).toBe(false);
    }
    expect(stores.KEYS).toEqual({ config: 'emailIntelConfig', checkpoints: 'emailIntelCheckpoints', messages: 'emailIntelMessages', actions: 'emailIntelActions', ledger: 'emailIntelTimelineLedger', staged: 'emailIntelStaged', sends: 'emailIntelSends' });
  });

  it('flags OFF: accessors return versioned defaults, writes are refused, and the data dir stays empty', () => {
    flags._setForTests(null);
    for (const name of Object.keys(stores.KEYS)) {
      expect(stores.load(name)).toEqual(stores.defaults(name));
      expect(stores.load(name).version).toBe(1);
      expect(stores.update(name, (d) => d)).toEqual({ ok: false, code: 'FLAGS_OFF' });
      expect(stores.save(name, stores.defaults(name))).toEqual({ ok: false, code: 'FLAGS_OFF' });
    }
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('flags ON: update writes the file; a newer version is read-only', () => {
    flags._setForTests({ enabled: true, capture: true });
    const r = stores.update('staged', (d) => ({ ...d, items: { st_1: { reason: 'low-confidence' } } }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'email_intel_staged.json'))).toBe(true);
    expect(stores.load('staged').items.st_1.reason).toBe('low-confidence');
    store.save('emailIntelSends', { version: 2, attempts: { a: 1 } });
    expect(stores.isReadOnly('sends')).toBe(true);
    expect(stores.update('sends', (d) => ({ ...d, attempts: {} }))).toEqual({ ok: false, code: 'STORE_NEWER_VERSION' });
    expect(stores.load('sends').attempts).toEqual({ a: 1 });   // reads still work
    expect(() => stores.load('nope')).toThrow();
  });
});
