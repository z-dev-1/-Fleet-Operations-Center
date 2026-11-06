// tests/email-intel-adapter.test.js — F-01 legacy results contract (Phase A subset), the R3.5 ready
// post-filter and F2-01 readyDmSuggested, plus the PG-4 legacy record shape.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { inboxRows, rowsScenarios } from './fixtures/email-intel/emails.js';
import { AUTH_URL } from './fixtures/email-intel/fake-owa.js';
import { makeHarness, stubTriage } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const adapter = require('../src/email-intel/ingest/legacy-adapter');
const store = require('../src/store');

let h = null;
afterEach(() => { if (h) h.cleanup(); h = null; });

const LEGACY_FIELDS = ['id', 'convId', 'from', 'fromName', 'subject', 'receivedText', 'bodyText', 'attachments', 'folder', 'triagedAt', 'firstSeenAt', 'replyDraft', 'replyState', 'kept', 'deleted', 'readyDmSent'];
function expectLegacyShape(res) {
  expect(Object.keys(res)).toEqual(expect.arrayContaining(['emails', 'ranAt', 'authBlocked', 'readError', 'intel']));
  expect(Array.isArray(res.emails)).toBe(true);
  expect(typeof res.authBlocked).toBe('boolean');
  expect(res.readError === null || typeof res.readError === 'string').toBe(true);
  expect(res.intel).toEqual(expect.objectContaining({ outcome: expect.any(String), partial: expect.any(Boolean), coalesced: expect.any(Boolean) }));
  expect(res.emails.length).toBeLessThanOrEqual(100);
}
const runTriage = (opts) => require('../src/scrapers/email_triage').runTriage(Object.assign({
  folders: Object.keys(h.world.folders), _electron: h.electron, _warm: async () => ({}), _sleep: async () => {}, authGraceMs: 20, _triageEmails: h.triage,
}, opts || {}));

describe('F-01 runTriage with capture on returns the legacy results shape', () => {
  it('F-01 runTriage returns legacy shape for complete/partial/auth-blocked/failed/coalesced', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    const complete = await runTriage({ max: 25 });
    expectLegacyShape(complete);
    expect(complete.intel.outcome).toBe('complete');
    expect(complete.readError).toBeNull();
    for (const e of complete.emails) for (const k of LEGACY_FIELDS) expect(e, k).toHaveProperty(k);
    expect(complete.emails[0].intel).toEqual(expect.objectContaining({ conversationKey: expect.stringMatching(/^cv_/), latestMessageKey: expect.stringMatching(/^m[di]_/), messageCount: 1, bodyStatus: 'complete', recipientsKnown: true }));
    expect(store.load('emailTriageResults', null)).toEqual(complete);    // runTriage resolves to the persisted object

    h.world.folders.Inbox.rows = inboxRows('Inbox', 40);
    const partial = await runTriage({ max: 5 });
    expectLegacyShape(partial);
    expect(partial.intel).toMatchObject({ outcome: 'partial', partial: true });
    expect(partial.readError).toBe('partial: budget');

    h.world.onExec = async (kind, n, api, world) => { if (kind === 'open') api.navigate(AUTH_URL); };
    const blocked = await runTriage({ max: 5 });
    expectLegacyShape(blocked);
    expect(blocked).toMatchObject({ authBlocked: true, readError: 'auth blocked' });
    expect(blocked.intel.outcome).toBe('auth-blocked');
    h.world.onExec = null; h.world.url = 'https://outlook.office365.com/mail/inbox';

    const failed = await runTriage({ _readMailbox: async () => { throw new Error('x'); } });
    expectLegacyShape(failed);
    expect(failed).toMatchObject({ authBlocked: false, readError: 'read failed' });
    expect(failed.intel.outcome).toBe('failed');

    const realCapture = require('../src/email-intel/capture/owa_capture');
    const slow = async (o) => { await new Promise((r) => setTimeout(r, 20)); return realCapture.readMailbox(o); };
    const [a, b] = await Promise.all([runTriage({ _readMailbox: slow }), runTriage({ _readMailbox: slow })]);
    expectLegacyShape(a); expectLegacyShape(b);
    expect(b.intel.coalesced).toBe(true);
    expect(b.emails).toBe(a.emails);
  }, 30_000);

  it('F-01 ai.js digest fields present and typed', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    h.triage = stubTriage(() => ({ importance: 'high', summary: 'Parts in', replySuggested: true, deleteSuggested: false, unitRefs: [{ unit: '40123', operator: 'ACME', update: '11/04 - parts in', ready: false }] }));
    const res = await runTriage({ _triageEmails: h.triage });
    expect(typeof res.authBlocked).toBe('boolean');
    for (const e of res.emails) {
      expect(['high', 'normal', 'low']).toContain(e.importance);
      expect(typeof e.replySuggested).toBe('boolean');
      expect(typeof e.replyState).toBe('string');
      expect(typeof e.deleteSuggested).toBe('boolean');
      expect(typeof e.unitUpdateApplied).toBe('boolean');
      expect(typeof e.summary).toBe('string');
      expect(typeof e.fromName).toBe('string'); expect(typeof e.from).toBe('string'); expect(typeof e.subject).toBe('string');
      expect(Array.isArray(e.unitRefs)).toBe(true);
      for (const u of e.unitRefs) { expect(typeof u.update).toBe('string'); expect(typeof u.ready).toBe('boolean'); }
    }
  });

  it('F-01 Phase A ready post-filter on conflicting canonical: a ready claim is hidden while canonical says the unit is in repair', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    store.save('canonicalState', { units: { '40123': { status: 'in_repair' }, '40456': { status: 'ready_for_pickup' } } });
    const tri = stubTriage(() => ({ unitRefs: [{ unit: '40123', operator: 'ACME', update: 'ready', ready: true }, { unit: '40456', operator: 'BETA', update: 'ready', ready: true }] }));
    const res = await runTriage({ _triageEmails: tri });
    const refs = res.emails[0].unitRefs;
    expect(refs.find((u) => u.unit === '40123')).toMatchObject({ ready: false, readyConflict: true });
    expect(refs.find((u) => u.unit === '40456')).toMatchObject({ ready: true });
    for (const s of adapter.CONFLICTING_CANONICAL) expect(['in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor', 'down']).toContain(s);
  });

  it('F2-01 readyDmSuggested false hides ready (Phase A adapter)', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    store.save('emailTriageConfig', Object.assign({}, require('../src/scrapers/email_triage').DEFAULT_CONFIG, { readyDmSuggested: false }));
    const tri = stubTriage(() => ({ unitRefs: [{ unit: '40456', operator: 'BETA', update: 'ready for pickup', ready: true }] }));
    const res = await runTriage({ _triageEmails: tri });
    expect(res.emails[0].unitRefs[0]).toMatchObject({ unit: '40456', ready: false, update: 'ready for pickup' });   // the fact stays, only the DM offer goes
    // and with the default (true) the verified ready offer is kept
    store.save('emailTriageConfig', Object.assign({}, require('../src/scrapers/email_triage').DEFAULT_CONFIG, { readyDmSuggested: true }));
    h.world.folders.Inbox.rows = inboxRows('Inbox', 2);
    const res2 = await runTriage({ _triageEmails: tri });
    expect(res2.emails.find((e) => e.unitRefs.length && e.unitRefs[0].ready === true)).toBeTruthy();
  });

  it('F-01 skipped scheduled result keeps isSkip semantics', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    const realCapture = require('../src/email-intel/capture/owa_capture');
    const slow = async (o) => { await new Promise((r) => setTimeout(r, 20)); return realCapture.readMailbox(o); };
    const running = h.run({ _readMailbox: slow });
    const skipped = await h.run({}, 'scheduled');
    const isSkip = (r) => !!(r && r.skipped);               // the supervisor's isSkip for emailTriage
    expect(isSkip(skipped)).toBe(true);
    expect(skipped.skipped).toBe('busy');
    expect(Array.isArray(skipped.emails)).toBe(true);
    const done = await running;
    expect(isSkip(done)).toBe(false);
    // scheduledTick: the skip is passed through untouched and counted as skipped
    const auto = { runs: 0, lastOutcome: null, lastError: null, skipped: { busy: 0, standby: 0 } };
    const r2 = h.run({ _readMailbox: slow });
    const tick = await h.idx.scheduledTick({}, { autoApplyUnitUpdates: true }, { autoStatus: auto, notify: () => {}, loadResults: () => ({}) });
    expect(isSkip(tick)).toBe(true);
    expect(auto.lastOutcome).toBe('skipped');
    await r2;
  });
});

describe('PG-4 legacy record shape and carry rules (pure)', () => {
  const rec = (key, o = {}) => Object.assign({ messageKey: key, conversationKey: 'cv_1', legacyId: 'em_x', convIdRaw: 'conv/1=', from: { name: 'Dealer', address: 'd@example.test' }, subject: 'S', receivedAtRaw: '18:09', body: { newContent: 'x'.repeat(9000), status: 'complete' }, attachments: [{ name: null, ext: '', kind: 'file', placeholder: true }, { name: 'a.pdf', ext: 'pdf', kind: 'document' }], recipientsKnown: true, folder: 'Inbox', flags: {} }, o);
  it('the legacy email handed to triageEmails is the latest message, capped at 8,000 chars, placeholders shown as "attachment"', () => {
    const e = adapter.toLegacyEmail({ conversationKey: 'cv_1', records: [rec('md_1', { body: { newContent: 'old' } }), rec('md_2')] });
    expect(e).toMatchObject({ id: 'em_x', convId: 'conv/1=', from: 'd@example.test', fromName: 'Dealer', receivedText: '18:09', folder: 'Inbox' });
    expect(e.bodyText).toHaveLength(8000);
    expect(e.attachments).toEqual([{ name: 'attachment', ext: '', type: 'file' }, { name: 'a.pdf', ext: 'pdf', type: 'document' }]);
  });
  it('records outside this scan are carried, the list is capped at 100 newest first', () => {
    const prev = { emails: Array.from({ length: 120 }, (_, i) => ({ id: 'em_' + i, triagedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })) };
    const out = adapter.buildResults({ prev, views: [], triaged: {}, meta: { readError: null } });
    expect(out.emails).toHaveLength(100);
    expect(out.emails[0].id).toBe('em_119');
    expect(out).toMatchObject({ authBlocked: false, readError: null, intel: { outcome: 'complete' } });
  });
  it('a record created by the legacy path (no intel field) keeps its reply state when the intel path first sees it', () => {
    const prev = { emails: [{ id: 'em_x', replyState: 'drafted', replyDraft: 'd', kept: true, triagedAt: '2026-01-01T00:00:00.000Z' }] };
    const out = adapter.buildResults({ prev, views: [{ conversationKey: 'cv_1', records: [rec('md_1')] }], triaged: { em_x: { id: 'em_x', unitRefs: [], triagedAt: '2026-01-02T00:00:00.000Z' } } });
    expect(out.emails[0]).toMatchObject({ replyState: 'drafted', replyDraft: 'd', kept: true });
    expect(out.emails[0].intel.latestMessageKey).toBe('md_1');
  });
});
