// tests/email-intel-adapter.test.js — F-01 legacy results contract (Phase A subset), the R3.5 ready
// post-filter and F2-01 readyDmSuggested, plus the PG-4 legacy record shape.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { inboxRows, rowsScenarios, snapshot, block } from './fixtures/email-intel/emails.js';
import { AUTH_URL } from './fixtures/email-intel/fake-owa.js';
import { makeHarness, stubTriage } from './fixtures/email-intel/scan-harness.js';
import { fleetData } from './fixtures/email-intel/fleet.js';
import { scriptedRelay, refOf } from './fixtures/email-intel/records.js';
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

// ── Phase B derivation (multiRecipient): legacy fields by code from the v2 analysis ──────────────
describe('F-01 Phase B derivation (multiRecipient effective)', () => {
  const T0 = Date.parse('2026-11-04T20:00:00.000Z');
  const lane = require('../src/email-intel/understand/lane');
  // Lane answer built from the prompt: a fact for every in-scope candidate whose quote is in the text.
  function answerFor(over = {}) {
    return (prompt) => {
      const units = JSON.parse(/CANDIDATE UNITS[^\n]*\n(\[.*\])/.exec(prompt)[1]).filter((u) => u.scope === 'in');
      const ready = /ready for pickup/.test(prompt);
      return Object.assign({
        schemaVersion: 2, messageRef: refOf(prompt), relevance: { level: 'high', reason: 'unit update', confidence: 0.9 },
        units: units.map((u) => ({ unit: u.id, gist: 'update', facts: [ready
          ? { kind: 'pickup_readiness', value: 'Ready for pickup', state: 'ready', assertion: 'stated', evidence: 'unit ' + u.id + ' is ready for pickup', confidence: 0.9 }
          : { kind: 'vendor_status', value: 'Vendor update received', state: 'working', assertion: 'stated', evidence: 'about unit ' + u.id, confidence: 0.9 }] })),
        questions: [], requests: [], answers: [], commitments: [],
        classification: { category: 'fleet_status_update', intent: 'provide_update', informationalOnly: true, confidence: 0.9 },
        suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.88,
      }, over);
    };
  }
  function phaseB(foldersIn, worldOpts, answer) {
    h = makeHarness(foldersIn, worldOpts);
    h.flags._setForTests({ enabled: true, capture: true, multiRecipient: true });
    store.save('fleetData', fleetData('fresh', T0));
    lane._resetForTests();
    const relay = scriptedRelay(answer || answerFor());
    lane._setRelayForTests(relay);
    const legacy = stubTriage();
    return { relay, legacy, run: (opts, trigger) => h.run(Object.assign({ _now: T0, _triageEmails: legacy }, opts || {}), trigger) };
  }
  const readySnap = (row) => snapshot({ subject: 'Unit 40456', blocks: [block({ text: 'Good news, unit 40456 is ready for pickup at the dealer.', convId: row.convId, time: '2026-11-04T14:30:00-05:00' })] });
  afterEach(() => lane._resetForTests());

  it('F-01 runTriage returns legacy shape for complete/partial/auth-blocked/failed/coalesced (Phase B)', async () => {
    const t = phaseB({ Inbox: inboxRows('Inbox', 3) });
    const complete = await runTriage({ _now: T0, _triageEmails: t.legacy });
    expectLegacyShape(complete);
    expect(complete.intel.outcome).toBe('complete');
    expect(t.legacy.calls).toHaveLength(0);                                   // legacy triageEmails is never called
    expect(t.relay.calls.length).toBe(3);
    for (const e of complete.emails) {
      for (const k of LEGACY_FIELDS) expect(e, k).toHaveProperty(k);
      expect(e.intel.analysisStatus).toBe('ok');
      expect(e.summary).toBe('Vendor: Vendor update received (40123)');
      expect(e.scope).toBe('mine');
    }
    expect(store.load('emailTriageResults', null)).toEqual(complete);
    expect(require('../src/scrapers/email_triage').applyPendingUnitUpdates(complete)).toBe(0);   // hook 2: legacy apply is off
    h.world.folders.Inbox.rows = inboxRows('Inbox', 40);
    const partial = await runTriage({ _now: T0, _triageEmails: t.legacy, max: 5 });
    expectLegacyShape(partial);
    expect(partial.intel).toMatchObject({ outcome: 'partial', partial: true });
    h.world.onExec = async (kind, n, api) => { if (kind === 'open') api.navigate(AUTH_URL); };
    const blocked = await runTriage({ _now: T0, _triageEmails: t.legacy, max: 5 });
    expectLegacyShape(blocked);
    expect(blocked).toMatchObject({ authBlocked: true, readError: 'auth blocked' });
    h.world.onExec = null; h.world.url = 'https://outlook.office365.com/mail/inbox';
    const failed = await runTriage({ _now: T0, _readMailbox: async () => { throw new Error('x'); } });
    expectLegacyShape(failed);
    expect(failed.intel.outcome).toBe('failed');
    const realCapture = require('../src/email-intel/capture/owa_capture');
    const slow = async (o) => { await new Promise((r) => setTimeout(r, 20)); return realCapture.readMailbox(o); };
    const a = runTriage({ _now: T0, _readMailbox: slow });
    const b = runTriage({ _now: T0, _readMailbox: slow });
    const ra = await a; const rb = await b;
    expectLegacyShape(ra);
    expect(rb.intel.coalesced).toBe(true);
    expect(rb.emails).toBe(ra.emails);
  }, 30_000);

  it('F-01 ai.js digest fields present and typed (Phase B)', async () => {
    const t = phaseB({ Inbox: inboxRows('Inbox', 2) });
    const res = await t.run();
    for (const e of res.emails) {
      expect(['high', 'normal', 'low']).toContain(e.importance);
      for (const k of ['replySuggested', 'deleteSuggested', 'unitUpdateApplied']) expect(typeof e[k]).toBe('boolean');
      for (const k of ['summary', 'importanceWhy', 'replyState', 'fromName', 'from', 'subject', 'category', 'intent']) expect(typeof e[k], k).toBe('string');
      expect(e.unitUpdateApplied).toBe(false);                              // nothing is written in Phase B
      expect(e.decision).toMatchObject({ replyNeeded: false, scope: 'mine', decisionRequired: false });
      expect(e.confidence).toBe(0.88);                                       // overallConfidence, never a 0.7 / 0.4 fallback
      for (const u of e.unitRefs) { expect(typeof u.update).toBe('string'); expect(typeof u.ready).toBe('boolean'); expect(u.operator).toBe('ACME DSP'); }
    }
  });

  it('F-01 ready flag false unless verifiedBy canonical', async () => {
    const t = phaseB({ Inbox: inboxRows('Inbox', 1) }, { snapshotFor: readySnap });
    store.save('canonicalState', { units: { '40456': { status: 'in_repair' } } });
    const res = await t.run();
    expect(res.emails[0].unitRefs[0]).toMatchObject({ unit: '40456', ready: false, readyUnverified: true, update: 'Pickup: Ready for pickup' });
    expect(res.emails[0].importance).toBe('normal');
    // canonical confirms -> ready offered (still token + native dialog gated when sent)
    store.save('canonicalState', { units: { '40456': { status: 'ready_for_pickup' } } });
    h.world.folders.Inbox.rows = inboxRows('Inbox', 2);
    const res2 = await t.run();
    const e2 = res2.emails.find((e) => e.unitRefs.some((u) => u.ready));
    expect(e2).toBeTruthy();
    expect(e2.importance).toBe('high');
    // a wrong-confidence answer never yields a ready offer: invalid overall confidence keeps the fact but ready needs canonical anyway
  });

  it("F2-01 readyDmSuggested false hides ready (Phase B derivation)", async () => {
    const t = phaseB({ Inbox: inboxRows('Inbox', 1) }, { snapshotFor: readySnap });
    store.save('canonicalState', { units: { '40456': { status: 'ready_for_pickup' } } });
    store.save('emailTriageConfig', Object.assign({}, require('../src/scrapers/email_triage').DEFAULT_CONFIG, { readyDmSuggested: false }));
    const res = await t.run();
    expect(res.emails[0].unitRefs[0]).toMatchObject({ unit: '40456', ready: false, update: 'Pickup: Ready for pickup' });   // the fact stays, the DM offer goes
    expect(t.legacy.calls).toHaveLength(0);
  });

  it('pending analysis (lane unavailable) is shown honestly, scan partial: pending-analysis, lane warning in status (AC-12)', async () => {
    const t = phaseB({ Inbox: inboxRows('Inbox', 2) });
    t.relay.available = false;
    const res = await t.run();
    expect(t.relay.calls).toHaveLength(0);
    expect(res.readError).toBe('partial: pending-analysis');
    for (const e of res.emails) { expect(e.summary).toBe("Couldn't analyze yet"); expect(e.intel.analysisStatus).toBe('pending'); expect(e.confidence).toBe(0); }
    const st = h.idx.getStatus();
    expect(st.lane.state).toBe('unavailable');
    expect(st.warnings).toContain('isolated-lane-unavailable');
    expect(st.backlog.pendingAnalysis).toBe(2);
    t.relay.available = true;
    const res2 = await t.run();
    expect(res2.readError).toBeNull();
    expect(res2.emails.every((e) => e.intel.analysisStatus === 'ok')).toBe(true);
    expect(h.idx.getStatus().warnings).not.toContain('isolated-lane-unavailable');
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
