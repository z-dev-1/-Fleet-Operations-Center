// tests/email-intel-bootstrap.test.js — legacy-write coverage per phase transition (design 4.6, F-22).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mk } from './fixtures/email-intel/emails.js';
import { recordOf, docOf } from './fixtures/email-intel/records.js';
import { factsWorld, PHASE_C } from './fixtures/email-intel/facts-harness.js';
const require = createRequire(import.meta.url);
const bootstrap = require('../src/email-intel/facts/bootstrap');

let w = null;
afterEach(() => { if (w) w.cleanup(); w = null; });

function seed() {
  const m1 = recordOf(mk({ subject: 'Parts 40123', conversationId: 'conv-a', body: 'Parts arrived for 40123', receivedAt: '2026-11-03T10:00:00.000Z' }));
  const m2 = recordOf(mk({ subject: 'Parts 40123', conversationId: 'conv-a', body: 'Repair started on 40123', receivedAt: '2026-11-03T12:00:00.000Z' }));
  const m3 = recordOf(mk({ subject: 'Parts 40123', conversationId: 'conv-a', body: 'Turbo ETA 11/12 for 40123', receivedAt: '2026-11-04T12:00:00.000Z' }));   // after the legacy triage
  const other = recordOf(mk({ subject: 'Other', conversationId: 'conv-b', body: 'Unit 40456 ready', receivedAt: '2026-11-03T10:00:00.000Z' }));
  w.stores.save('messages', docOf([m1, m2, m3, other]));
  return { m1, m2, m3, other };
}

describe('bootstrap', () => {
  it('F-22 legacy writes during Phase A are covered when timelineWrites turns on', () => {
    w = factsWorld({ enabled: true, capture: true });
    const { m1, m2, m3, other } = seed();
    const T_A = '2026-11-02T00:00:00.000Z';
    // Phase A ran first (capture bootstrapped), then the legacy apply wrote a line for conversation a while Phase A was on
    w.stores.update('checkpoints', (ck) => Object.assign(ck, { bootstrapped: { capture: T_A } }));
    const results = { emails: [
      { id: m1.legacyId, unitUpdateApplied: true, triagedAt: '2026-11-03T13:00:00.000Z', unitRefs: [{ unit: '40123' }], intel: { analysisStatus: 'legacy-triage', latestMessageKey: m2.messageKey } },
      { id: other.legacyId, unitUpdateApplied: false, triagedAt: '2026-11-03T13:00:00.000Z', unitRefs: [{ unit: '40456' }] },
    ] };
    // capture only: the capture key is behind the legacy write -> the pass runs for capture
    const a = bootstrap.run({ effective: { capture: true }, results, now: Date.parse('2026-11-04T00:00:00.000Z') });
    expect(a).toMatchObject({ ran: true, phases: ['capture'], covered: 2 });
    let msgs = w.stores.load('messages').messages;
    expect(msgs[m1.messageKey].legacyCovered).toMatchObject({ triagedAt: '2026-11-03T13:00:00.000Z', units: ['40123'] });
    expect(msgs[m2.messageKey].legacyCovered).toBeTruthy();
    expect(msgs[m3.messageKey].legacyCovered).toBeUndefined();               // received after the legacy triage: not covered
    expect(msgs[other.messageKey].legacyCovered).toBeUndefined();            // nothing applied there
    // nothing new: no rerun
    expect(bootstrap.run({ effective: { capture: true }, results, now: Date.parse('2026-11-04T01:00:00.000Z') }).ran).toBe(false);
    // timelineWrites turns on later (with multiRecipient): the missing keys run, coverage is kept
    w.flags._setForTests(PHASE_C);
    const b = bootstrap.run({ effective: { capture: true, multiRecipient: true, actionsView: true, timelineWrites: true }, results, now: Date.parse('2026-11-05T00:00:00.000Z') });
    expect(b.phases).toEqual(['multiRecipient', 'timelineWrites']);
    expect(w.stores.load('checkpoints').bootstrapped).toEqual({ capture: '2026-11-04T00:00:00.000Z', multiRecipient: '2026-11-05T00:00:00.000Z', timelineWrites: '2026-11-05T00:00:00.000Z' });
    msgs = w.stores.load('messages').messages;
    // the pre-write check blocks the covered messages and lets the later one through
    expect(bootstrap.legacyCovers(msgs[m1.messageKey], '40123', results)).toBe('bootstrap');
    expect(bootstrap.legacyCovers(msgs[m3.messageKey], '40123', results)).toBeNull();
    // a legacy write made while a phase was rolled back (triagedAt later than the stored ISO) re-runs the pass
    const later = { emails: [{ id: m1.legacyId, unitUpdateApplied: true, triagedAt: '2026-11-06T00:00:00.000Z', unitRefs: [{ unit: '40123' }] }] };
    const c = bootstrap.run({ effective: { capture: true, multiRecipient: true, timelineWrites: true }, results: later, now: Date.parse('2026-11-06T01:00:00.000Z') });
    expect(c).toMatchObject({ ran: true, phases: ['capture', 'multiRecipient', 'timelineWrites'], covered: 1 });
    expect(w.stores.load('messages').messages[m3.messageKey].legacyCovered).toBeTruthy();
  });

  it('pre-write legacy check: a legacy record that applied the same unit after the message stages possible-duplicate; intel records never count', () => {
    w = factsWorld();
    const msg = recordOf(mk({ subject: 'Parts 40123', conversationId: 'conv-z', receivedAt: '2026-11-03T10:00:00.000Z' }));
    const rec = (o) => ({ emails: [Object.assign({ id: msg.legacyId, unitUpdateApplied: true, triagedAt: '2026-11-03T11:00:00.000Z', unitRefs: [{ unit: '40123' }] }, o)] });
    expect(bootstrap.legacyCovers(msg, '40123', rec({}))).toBe('legacy-record');
    expect(bootstrap.legacyCovers(msg, '40456', rec({}))).toBeNull();                                         // other unit
    expect(bootstrap.legacyCovers(msg, '40123', rec({ triagedAt: '2026-11-03T09:00:00.000Z' }))).toBeNull();   // triaged before this message
    expect(bootstrap.legacyCovers(msg, '40123', rec({ unitUpdateApplied: false }))).toBeNull();
    expect(bootstrap.legacyCovers(msg, '40123', rec({ intel: { analysisStatus: 'ok' } }))).toBeNull();       // the intel path's own flag
    expect(bootstrap.legacyCovers(msg, '40123', { emails: [] })).toBeNull();
  });
});
