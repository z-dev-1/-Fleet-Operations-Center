// tests/scheduler-pipeline.test.js
//
// Task #7 — central pipeline PURE logic (no Electron, no live email/SP):
//   - recipient resolution + STRONG dedup across op_emails + spConfig.emails,
//     with no To/Cc overlap
//   - per operator/domicile/slot scope key
//   - HH:MM -> AM/PM
//   - Test Mode transform: [TEST] subject, recipients replaced with test
//     recipient, intended-vs-actual recorded separately
//   - stale/test banner injection
//   - notification dedup by (jobId, state)
//   - transient vs permanent error classification
//
// The live sync -> gate -> push/send -> verify wiring is validated by the
// ledger/freshness/owa/sharepoint contract tests plus the acceptance checklist.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'sched-pipe-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const pipe = require('../src/scheduler/pipeline');

beforeEach(() => { store.save('settings', {}); pipe._resetNotifyDedup(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('resolveRecipients — strong dedup, no To/Cc overlap', () => {
  it('merges op_emails + spConfig.emails and normalizes/dedups addresses', () => {
    const op = { TUZR: { to: 'A@x.com; a@x.com', cc: 'boss@x.com' } };
    const sp = { 'TUZR__ABE40': { to: 'lead@x.com', cc: 'lead@x.com, extra@x.com' } };
    const out = pipe.resolveRecipients(op, sp);
    const tuzr = out.find(e => e.key === 'TUZR');
    expect(tuzr.to).toEqual(['a@x.com']);           // dedup + lowercase
    expect(tuzr.cc).toEqual(['boss@x.com']);
    const scoped = out.find(e => e.key === 'TUZR__ABE40');
    expect(scoped.operator).toBe('TUZR');
    expect(scoped.domicile).toBe('ABE40');
    expect(scoped.to).toEqual(['lead@x.com']);
    expect(scoped.cc).toEqual(['extra@x.com']);      // lead@ removed (To/Cc overlap)
  });
  it('skips entries with no addresses', () => {
    const out = pipe.resolveRecipients({ EMPTY: { to: '', cc: '' } }, {});
    expect(out.length).toBe(0);
  });
});

describe('scopeKey + slotToAmPm', () => {
  it('scope key is OP_DOM_SLOT uppercased', () => {
    expect(pipe.scopeKey('tuzr', 'abe40', '08:00')).toBe('TUZR_ABE40_08:00');
  });
  it('maps HH:MM to AM/PM', () => {
    expect(pipe.slotToAmPm('08:00')).toBe('AM');
    expect(pipe.slotToAmPm('15:15')).toBe('PM');
  });
});

describe('applyTestMode', () => {
  const base = { subject: 'Fleet Status TUZR — SOS AM', to: 'real@x.com', cc: 'boss@x.com' };
  it('production passes through unchanged', () => {
    const r = pipe.applyTestMode(base, { testMode: false });
    expect(r.subject).toBe(base.subject);
    expect(r.to).toEqual(['real@x.com']);
    expect(r.actualRecipients).toEqual(['real@x.com', 'boss@x.com']);
  });
  it('test mode prefixes [TEST], replaces recipients, records intended-vs-actual', () => {
    const r = pipe.applyTestMode(base, { testMode: true, testRecipients: 'tester@x.com' });
    expect(r.subject).toMatch(/^\[TEST\]/);
    expect(r.to).toEqual(['tester@x.com']);
    expect(r.cc).toEqual([]);
    expect(r.intendedRecipients).toEqual(['real@x.com', 'boss@x.com']);
    expect(r.actualRecipients).toEqual(['tester@x.com']);
  });
  it('does not double-prefix [TEST]', () => {
    const r = pipe.applyTestMode({ ...base, subject: '[TEST] already' }, { testMode: true, testRecipients: 't@x.com' });
    expect(r.subject).toBe('[TEST] already');
  });
});

describe('testRecipientsFor', () => {
  it('reads settings.emailTestRecipient', () => {
    store.save('settings', { emailTestRecipient: 'qa@x.com' });
    expect(pipe.testRecipientsFor()).toEqual(['qa@x.com']);
  });
  it('empty when unset (caller must block test send)', () => {
    store.save('settings', {});
    expect(pipe.testRecipientsFor()).toEqual([]);
  });
});

describe('injectBanner', () => {
  it('inserts a banner after <body>', () => {
    const html = pipe.injectBanner('<html><body><p>x</p></body></html>', 'STALE DATA');
    expect(html).toMatch(/<body[^>]*><div[^>]*>STALE DATA/);
  });
  it('no-op when banner empty', () => {
    expect(pipe.injectBanner('<p>x</p>', null)).toBe('<p>x</p>');
  });
});

describe('shouldNotify — dedup by (jobId,state)', () => {
  it('notifies once per jobId+state', () => {
    expect(pipe.shouldNotify('job1', 'completed')).toBe(true);
    expect(pipe.shouldNotify('job1', 'completed')).toBe(false);
    expect(pipe.shouldNotify('job1', 'failed')).toBe(true);
    expect(pipe.shouldNotify('job2', 'completed')).toBe(true);
  });
});

describe('classifyError', () => {
  it('network/timeout -> transient', () => {
    expect(pipe.classifyError('Request timeout after 30s')).toBe('transient');
    expect(pipe.classifyError('ECONNRESET')).toBe('transient');
  });
  it('auth -> permanent', () => {
    expect(pipe.classifyError('401 Unauthorized login required')).toBe('permanent');
  });
});
