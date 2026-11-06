// tests/email-intel-cases.test.js — acceptance cases (design 11, 12.2). FEAT-003 covers D, E and F at
// ANALYSIS level (facts and determinations only; nothing is written). FEAT-004 adds the runIntelScan-level
// versions with the timeline writer; FEAT-005 adds the My Email Actions side of C, D and I; the remaining
// cases arrive with their phases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { mk, scenarios, ZILA, DEALER, COWORKER, person } from './fixtures/email-intel/emails.js';
import { recordOf, docOf, analyzeDoc, scriptedRelay, aiFixture, refOf } from './fixtures/email-intel/records.js';
import { phaseCWorld, fact, localIso } from './fixtures/email-intel/phase-c.js';
const require = createRequire(import.meta.url);
const lane = require('../src/email-intel/understand/lane');
const C = require('../src/email-intel/constants');

beforeEach(() => lane._resetForTests());
afterEach(() => lane._resetForTests());

async function analyzed(m, answer, over) {
  const rec = recordOf(m);
  const doc = docOf([rec]);
  const relay = scriptedRelay(typeof answer === 'function' ? answer : () => aiFixture(answer));
  await analyzeDoc(doc, relay, over);
  return { a: doc.messages[rec.messageKey].analysis, rec: doc.messages[rec.messageKey], relay };
}

describe('acceptance cases at analysis level (FEAT-003)', () => {
  it('case D: coworker question about my unit captures fact, reply not assigned to me', async () => {
    const { a } = await analyzed(scenarios.coworkerQuestion(), 'coworker-question');
    expect(a.status).toBe('ok');
    const u = a.result.units.find((x) => x.unit === '40123');
    expect(u.facts).toHaveLength(1);
    expect(u.facts[0]).toMatchObject({ kind: 'parts_eta', date: '2026-11-14', assertion: 'reported-secondhand' });
    const d = a.determinations;
    expect(d.actionOwnership.items[0]).toMatchObject({ type: 'question', owner: 'other-person', addressee: 'named-other' });
    expect(d.replyRequirement.value).toBe('none');
    expect(d.otherResponsible).toMatchObject({ value: true, who: 'other-person' });
    expect(d.informationRelevance.level).toBe('high');                  // the fact is still relevant to me
  });

  it('case E: multi-unit email updates only my units; other FAS units counted out of scope', async () => {
    const { a, relay } = await analyzed(scenarios.multiUnit(), 'multi-unit');
    expect(a.status).toBe('ok');
    expect(a.result.units.map((u) => u.unit).sort()).toEqual(['40123', '40456']);
    expect(a.result.units.every((u) => u.scope === 'in')).toBe(true);
    expect(a.validation.otherUnits).toBe(2);
    expect(a.validation.dropped.outOfScopeFacts).toBe(2);
    // the prompt told the model which candidates are mine; the whole fleet list was not sent
    const cand = JSON.parse(/CANDIDATE UNITS[^\n]*\n(\[.*\])/.exec(relay.calls[0].prompt)[1]);
    expect(Object.fromEntries(cand.map((c) => [c.id, c.scope]))).toEqual({ 40123: 'in', 40456: 'in', 51888: 'out', 62100: 'out' });
    expect(relay.calls[0].prompt).not.toContain('40789');
    expect(a.deterministic.units.filter((u) => u.scope === 'out').map((u) => u.unit).sort()).toEqual(['51888', '62100']);
  });

  it('case F: unit after char 1500 extracted (window selection and unsent-window fallback)', async () => {
    // (1) the unit sits after character 1,500: it is found deterministically and the window that holds it is sent
    const { a, rec, relay } = await analyzed(scenarios.longBody1500(), 'long-body');
    const at = rec.body.newContent.indexOf('40789');
    expect(at).toBeGreaterThan(1500);
    expect(relay.calls[0].prompt).toContain('unit 40789 will be ready 11/15');
    expect(a.result.units[0]).toMatchObject({ unit: '40789', scope: 'in' });
    expect(a.result.units[0].facts[0]).toMatchObject({ kind: 'estimated_completion', date: '2026-11-15' });
    expect(a.unprocessedUnits).toEqual([]);
    expect(a.coverage).toMatchObject({ charsTotal: rec.body.newContent.length, charsSent: rec.body.newContent.length });

    // (2) more windows than MAX_WINDOWS (window size shrunk for the test; production windows are 6,000 chars):
    // at most MAX_WINDOWS calls, and a unit only in unsent windows gets the marker, never a fact
    const para = (s) => s + '\n\n';
    let body = '';
    for (let i = 0; i < 9; i++) body += para('Section ' + i + ' ' + 'routine fleet text '.repeat(40));
    body = body.replace('Section 3 ', 'Section 3 unit 40123 parts ETA 11/12 repair estimate ')
      .replace('Section 5 ', 'Section 5 unit 40456 ready for pickup parts ')
      .replace('Section 7 ', 'Section 7 unit 40999 approval estimate vendor ')
      .replace('Section 8 ', 'Section 8 note 40789 ');
    const sent = [];
    const out = await analyzed(mk({ to: [ZILA], subject: 'Big report', body }), (prompt) => {
      sent.push(prompt);
      const units = JSON.parse(/CANDIDATE UNITS[^\n]*\n(\[.*\])/.exec(prompt)[1]);
      return { schemaVersion: 2, messageRef: refOf(prompt), relevance: { level: 'medium', reason: 'report', confidence: 0.8 }, units: units.filter((u) => u.scope === 'in').map((u) => ({ unit: u.id, facts: [] })), questions: [], requests: [], answers: [], commitments: [], classification: { category: 'data_report', intent: 'provide_data', confidence: 0.8 }, overallConfidence: 0.8 };
    }, { windowOpts: { windowChars: 1000, overlap: 100 } });
    expect(out.relay.calls.length).toBeLessThanOrEqual(C.MAX_WINDOWS);
    expect(out.a.coverage.windowsTotal).toBeGreaterThan(C.MAX_WINDOWS);
    expect(out.a.coverage.windowsSent).toBe(C.MAX_WINDOWS);
    expect(out.a.coverage.charsSent).toBeLessThan(out.a.coverage.charsTotal);
    expect(out.a.unprocessedUnits.length).toBeGreaterThanOrEqual(1);
    for (const u of out.a.unprocessedUnits) {
      expect(u.reason).toBe('unprocessed-window');
      for (const p of sent) expect(p.split('<<<UNTRUSTED_EMAIL')[1]).not.toContain(u.unit);
      expect(out.a.result.units.some((x) => x.unit === u.unit && x.facts.length)).toBe(false);
    }
    // every in-scope unit is either in an analyzed window or carries the marker: none is lost
    const markers = new Set(out.a.unprocessedUnits.map((u) => u.unit));
    for (const id of ['40123', '40456', '40999', '40789']) {
      const inSent = sent.some((p) => p.split('<<<UNTRUSTED_EMAIL')[1].includes(id));
      expect(inSent || markers.has(id), id).toBe(true);
    }

    // (3) a unit that appears only past the stored body cap is reported as unprocessed, not lost
    const long = 'Routine weekly status text. '.repeat(Math.ceil((C.STORED_BODY_CAP + 400) / 28)) + ' unit 40999 will be ready 11/20';
    const capped = await analyzed(mk({ to: [ZILA], subject: 'Weekly status 40123', body: long }), () => aiFixture('multi20to'));
    expect(capped.rec.body.newContent.length).toBe(C.STORED_BODY_CAP);
    expect(capped.rec.body.unitsBeyondCap).toEqual(['40999']);
    expect(capped.a.unprocessedUnits).toContainEqual({ unit: '40999', scope: 'in', reason: 'unprocessed-window' });
    expect(capped.a.coverage.storedTruncated).toBe(true);
    expect(capped.a.coverage.charsTotal).toBeGreaterThan(capped.a.coverage.charsSent);
  });
});

// ── FEAT-004: the same acceptance cases at runIntelScan level (capture -> analysis -> reconcile -> writer) ──────
// Flags: master + capture + multiRecipient + actionsView + timelineWrites. The reader is injected, the isolated
// lane is scripted from a rule table, the store is a temp data dir, the timeline writer and cleaner are real.
describe('acceptance cases at runIntelScan level (FEAT-004)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const marker = (f, unit) => require('../src/email-intel/facts/fact-key').keysOf(f, unit).marker;

  it('case A: one email to 20 recipients applies one validated timeline fact, no reply item', async () => {
    w = phaseCWorld();
    const m = { to: Array.from({ length: 20 }, (_, i) => (i === 7 ? ZILA : person(i + 1))), subject: 'Parts update 40123', conversationId: 'conv-a', body: 'Parts arrived for unit 40123, repair starts Monday.' };
    const f = fact({ kind: 'parts_availability', item: null, value: 'Parts arrived', state: 'arrived', date: null, evidence: 'Parts arrived for unit 40123' });
    w.rules.push({ unit: '40123', fact: f });
    const res = await w.scan([w.cap(m)]);
    expect(w.lines('40123')).toHaveLength(1);
    expect(w.lines('40123')[0]).toMatch(/Parts: Parts arrived \(per Dealer Parts Desk email \d\d\/\d\d\) \[em:[0-9a-f]{8}\]$/);
    expect(w.lines('40123')[0]).toContain(marker(f, '40123'));
    const e = res.emails[0];
    expect(e.unitUpdateApplied).toBe(true);
    expect(e.replySuggested).toBe(false);
    expect(e.decision).toMatchObject({ replyNeeded: false, replyRequirement: 'none' });
    expect(res.intel.facts).toMatchObject({ applied: 1, staged: 0 });
    const ent = w.ledger();
    expect(ent).toHaveLength(1);
    expect(ent[0]).toMatchObject({ state: 'applied', source: 'email', senderName: 'Dealer Parts Desk', conversationKey: e.intel.conversationKey, messageKey: e.intel.latestMessageKey, confidence: 0.9 });
  });

  it("case B: CC'd dealer ETA captured, no reply", async () => {
    w = phaseCWorld();
    const m = { from: DEALER, to: [COWORKER], cc: [ZILA], subject: 'Turbo ETA 40456', conversationId: 'conv-b', body: 'Turbo ETA 11/12 for 40456.' };
    w.rules.push({ unit: '40456', fact: fact({ evidence: 'Turbo ETA 11/12 for 40456' }) });
    const res = await w.scan([w.cap(m)]);
    expect(w.lines('40456')).toHaveLength(1);
    expect(w.lines('40456')[0]).toContain('Parts ETA: Turbo ETA 11/12');
    const rec = Object.values(w.messages())[0];
    expect(rec.analysis.determinations.recipientRole).toBe('cc');
    expect(rec.analysis.determinations.replyRequirement.value).toBe('none');
    expect(res.emails[0]).toMatchObject({ unitUpdateApplied: true, replySuggested: false });
  });

  it("case C: CC'd approval request notifies once, does not approve, stages spend fact", async () => {
    w = phaseCWorld();
    const confirm = require('../src/email-intel/confirm');
    confirm._resetForTests();
    const m = { from: DEALER, to: [COWORKER], cc: [ZILA], subject: 'Estimate 40123', conversationId: 'conv-c', body: 'Zila, please approve the $1,840 estimate for 40123.' };
    w.rules.push({ unit: '40123', fact: fact({ kind: 'approval_status', item: 'estimate', value: 'Estimate received for $1,840', state: 'estimate_received', date: null, amount: { value: 1840, currency: 'USD' }, evidence: 'please approve the $1,840 estimate for 40123' }) });
    w.questions.push({ when: 'please approve', q: { ref: 'q1', text: 'Please approve the $1,840 estimate for 40123', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, please approve' }, isApprovalOrDecision: true, decisionKind: 'estimate', confidence: 0.9 } });
    const res = await w.scan([w.cap(m)]);
    expect(w.timeline('40123')).toBe('');                                       // nothing applied
    const st = w.staged();
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ unit: '40123', reason: 'spend-related', state: 'open', fact: { kind: 'approval_status', state: 'estimate_received', amount: { value: 1840 } } });
    expect(st[0].proposedLine).toContain('(user-approved)');
    expect(confirm._liveCount()).toBe(0);                                       // no approve path was even prepared
    const d = Object.values(w.messages())[0].analysis.determinations;
    expect(d.decisionRequirement.value).toBe('me');                            // the decision item itself is FEAT-005
    expect(res.emails[0].decision.decisionRequired).toBe(true);
    expect(res.emails[0].unitUpdateApplied).toBe(false);
  });

  it('case D: coworker question about my unit captures fact, reply not assigned to me', async () => {
    w = phaseCWorld();
    const m = { from: DEALER, to: [COWORKER, person(3)], subject: 'DPF on 40123', conversationId: 'conv-d', body: 'Mike, can you check the DPF on 40123? The DPF ETA is 11/14.' };
    w.rules.push({ unit: '40123', fact: fact({ item: 'DPF', value: 'DPF ETA 11/14', date: '2026-11-14', evidence: 'The DPF ETA is 11/14' }) });
    w.questions.push({ when: 'Mike, can you check', q: { ref: 'q1', text: 'Can you check the DPF on 40123?', about: ['40123'], addressee: { kind: 'named-other', name: 'Mike', evidence: 'Mike, can you check the DPF on 40123?' }, isApprovalOrDecision: false, confidence: 0.9 } });
    const res = await w.scan([w.cap(m)]);
    expect(w.lines('40123')).toHaveLength(1);
    expect(w.lines('40123')[0]).toContain('Parts ETA: DPF ETA 11/14');
    const d = Object.values(w.messages())[0].analysis.determinations;
    expect(d.actionOwnership.items[0]).toMatchObject({ type: 'question', owner: 'other-person' });
    expect(d.replyRequirement.value).toBe('none');
    expect(res.emails[0]).toMatchObject({ replySuggested: false, unitUpdateApplied: true });
  });

  it('case E: multi-unit email updates only my units; other FAS units counted out of scope', async () => {
    w = phaseCWorld();
    w.store.save('canonicalState', { units: { '40456': { status: 'ready_for_pickup', repairPhase: 'complete' } } });
    const body = ['40123 - awaiting parts, ETA 11/12', '40456 - ready for pickup', '51888 - in repair', '62100 - waiting on approval'].join('\n');
    w.rules.push({ unit: '40123', fact: fact({ item: null, value: 'Awaiting parts, ETA 11/12', evidence: '40123 - awaiting parts, ETA 11/12' }) });
    w.rules.push({ unit: '40456', fact: fact({ kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null, evidence: '40456 - ready for pickup' }) });
    w.rules.push({ unit: '51888', fact: fact({ kind: 'repair_stage', item: null, value: 'In repair', state: 'repair_in_progress', date: null, evidence: '51888 - in repair' }) });
    w.rules.push({ unit: '62100', fact: fact({ kind: 'approval_status', item: null, value: 'Waiting on approval', state: 'pending', date: null, evidence: '62100 - waiting on approval' }) });
    const res = await w.scan([w.cap({ subject: 'Status roundup', conversationId: 'conv-e', body })]);
    expect(w.lines('40123')).toHaveLength(1);
    expect(w.lines('40456')).toHaveLength(1);
    expect(w.lines('40456')[0]).not.toContain('not confirmed');                 // verified by canonical
    const ns = w.store.load('notesStore', {});
    expect(Object.keys(ns).sort()).toEqual(['40123', '40456']);                 // nothing for the other FAS units
    const rec = Object.values(w.messages())[0];
    expect(rec.analysis.validation.otherUnits).toBe(2);
    expect(rec.analysis.validation.dropped.outOfScopeFacts).toBe(2);
    expect(w.ledger().map((e) => e.unit).sort()).toEqual(['40123', '40456']);
    expect(res.emails[0].unitRefs.find((u) => u.unit === '40456')).toMatchObject({ ready: true });
    expect(res.emails[0].unitRefs.map((u) => u.unit)).not.toContain('51888');
  });

  it('case F: unit after char 1500 extracted (window selection and unsent-window fallback)', async () => {
    w = phaseCWorld();
    const body = 'Routine weekly status text. '.repeat(115) + ' ... unit 40789 will be ready 11/15';
    expect(body.indexOf('40789')).toBeGreaterThan(1500);
    w.rules.push({ unit: '40789', fact: fact({ kind: 'estimated_completion', item: null, value: 'Ready 11/15', state: 'eta_given', date: '2026-11-15', evidence: 'unit 40789 will be ready 11/15' }) });
    await w.scan([w.cap({ subject: 'Weekly status', conversationId: 'conv-f', body })]);
    expect(w.lines('40789')).toHaveLength(1);
    expect(w.lines('40789')[0]).toContain('Est. completion: Ready 11/15');
    // the unsent-window fallback: a unit only past the stored body cap is staged for review, never lost or guessed
    const long = 'Routine weekly status text. '.repeat(Math.ceil((C.STORED_BODY_CAP + 400) / 28)) + ' unit 40999 will be ready 11/20';
    await w.scan([w.cap({ subject: 'Weekly status 40123', conversationId: 'conv-f2', body: long })]);
    expect(w.timeline('40999')).toBe('');
    expect(w.staged()).toContainEqual(expect.objectContaining({ unit: '40999', reason: 'unprocessed-window', fact: null, state: 'open' }));
  });

  it('case G: updated ETA in same conversation is a new event and supersedes', async () => {
    w = phaseCWorld();
    const m1 = { subject: 'Turbo 40123', conversationId: 'conv-g', messageId: 'g-1', body: 'Turbo ETA 11/12 for 40123.', receivedAt: '2026-11-03T15:00:00.000Z' };
    const m2 = { subject: 'RE: Turbo 40123', conversationId: 'conv-g', messageId: 'g-2', body: 'Update: the turbocharger ETA moved to 11/15 for 40123.', receivedAt: '2026-11-04T15:00:00.000Z' };
    w.rules.push({ unit: '40123', fact: fact() });
    w.rules.push({ unit: '40123', fact: fact({ item: 'turbocharger', value: 'Turbocharger ETA 11/15', state: 'eta_changed', date: '2026-11-15', evidence: 'the turbocharger ETA moved to 11/15 for 40123' }) });
    await w.scan([w.cap(m1)]);
    expect(w.lines('40123')).toHaveLength(1);
    const res = await w.scan([w.cap(m1), w.cap(m2)]);
    const msgs = Object.values(w.messages());
    expect(msgs).toHaveLength(2);                                               // the reply is its own event...
    expect(new Set(msgs.map((x) => x.conversationKey)).size).toBe(1);          // ...in the same conversation
    const lines = w.lines('40123');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Turbocharger ETA 11/15 (was 11/12)');
    const ent = w.ledger().sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
    expect(ent[0]).toMatchObject({ state: 'superseded', supersededBy: ent[1].ledgerKey });
    expect(ent[1]).toMatchObject({ state: 'applied', supersedes: ent[0].ledgerKey });
    expect(res.emails[0].unitUpdateApplied).toBe(true);
  });

  it('case H: repeated ETA (reply, forward, rescan) writes no duplicate', async () => {
    w = phaseCWorld();
    const m1 = { subject: 'Turbo 40123', conversationId: 'conv-h', messageId: 'h-1', body: 'Turbo ETA 11/12 for 40123.', receivedAt: '2026-11-03T15:00:00.000Z' };
    const m2 = { subject: 'RE: Turbo 40123', conversationId: 'conv-h', messageId: 'h-2', body: 'Turbocharger ETA is still 11/12 for 40123.', receivedAt: '2026-11-04T12:00:00.000Z' };
    const fwd = { from: COWORKER, subject: 'FW: Turbo 40123', conversationId: 'conv-h-fwd', messageId: 'h-3', receivedAt: '2026-11-04T13:00:00.000Z',
      body: ['FYI see below.', '', '---------- Forwarded message ---------', 'From: Dealer Parts Desk', 'Date: Nov 4, 2026 9:12 AM', 'Subject: Turbo 40123', 'To: Mike', '', 'Turbo ETA 11/12 for 40123.'].join('\n') };
    w.rules.push({ unit: '40123', fact: fact() });
    w.rules.push({ unit: '40123', fact: fact({ item: 'turbocharger', value: 'Turbocharger ETA 11/12', evidence: 'Turbocharger ETA is still 11/12 for 40123' }) });
    await w.scan([w.cap(m1)]);
    await w.scan([w.cap(m1), w.cap(m2)]);
    await w.scan([w.cap(fwd)]);
    await w.scan([w.cap(m1), w.cap(m2), w.cap(fwd)]);                          // rescan of everything
    expect(w.lines('40123')).toHaveLength(1);
    const ent = w.ledger();
    expect(ent).toHaveLength(1);
    expect(ent[0].seenCount).toBe(3);
    expect(ent[0].corroboratedBy).toHaveLength(2);
    expect(w.staged()).toEqual([]);
  });

  it('case J: fresher canonical conflict staged and flagged, canonical unchanged, no regress', async () => {
    w = phaseCWorld();
    const canon = { units: { '40123': { equipmentId: '40123', status: 'in_repair', repairPhase: 'in_repair', dimensions: {}, lastMeaningfulUpdate: { source: 'relay', text: 'Turbo installed, repair in progress', at: 'Nov 4, 2026 02:00 PM' } } }, updatedAt: '2026-11-04T19:00:00.000Z' };
    w.store.save('canonicalState', canon);
    w.rules.push({ unit: '40123', fact: fact({ kind: 'repair_stage', item: null, value: 'Waiting on parts', state: 'awaiting_parts', date: null, evidence: 'Unit 40123 is waiting on parts' }) });
    const res = await w.scan([w.cap({ subject: 'Status 40123', conversationId: 'conv-j', body: 'Unit 40123 is waiting on parts.', receivedAt: localIso(2026, 10, 3, 9, 0) })]);
    expect(w.timeline('40123')).toBe('');                                       // no regress
    expect(w.store.load('canonicalState')).toEqual(canon);                     // canonical untouched
    const st = w.staged();
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ reason: 'conflict-canonical', state: 'open', canonicalSnapshot: { status: 'in_repair', repairPhase: 'in_repair', lastUpdateSource: 'relay', changeTimePrecision: 'minute' } });
    const ev = w.store.load('emailEvidence')['40123'];
    expect(ev[0]).toMatchObject({ isConflict: true, usedInConclusion: false, stagedReason: 'conflict-canonical' });
    expect(res.emails[0].unitUpdateApplied).toBe(false);
    expect(w.idx.getStatus().backlog.openStaged).toBe(1);
  });
});

// ── FEAT-005: the My Email Actions side of cases C, D and I at runIntelScan level (stage 9: question states,
// action items, notify once). Flags: master + capture + multiRecipient + actionsView + timelineWrites.
describe('acceptance cases C, D, I with My Email Actions (FEAT-005)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const TPL = require('../src/email-intel/actions/templates');
  const approvalCase = (world) => {
    world.rules.push({ unit: '40123', fact: fact({ kind: 'approval_status', item: 'estimate', value: 'Estimate received for $1,840', state: 'estimate_received', date: null, amount: { value: 1840, currency: 'USD' }, evidence: 'please approve the $1,840 estimate for 40123' }) });
    world.questions.push({ when: 'please approve', q: { ref: 'q1', text: 'Please approve the $1,840 estimate for 40123', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, please approve' }, isApprovalOrDecision: true, decisionKind: 'estimate', confidence: 0.9 } });
    return world.cap({ from: DEALER, to: [COWORKER], cc: [ZILA], subject: 'Estimate 40123', conversationId: 'conv-c', messageId: 'c-1', body: 'Zila, please approve the $1,840 estimate for 40123.' });
  };
  const noConsequential = () => {
    const actions = require('../src/scrapers/email_actions');
    const ow = require('../src/scrapers/owa_reader');
    const spies = { sendReply: vi.spyOn(actions, 'sendReply'), sendReadyDm: vi.spyOn(actions, 'sendReadyDm'), deleteMessage: vi.spyOn(ow, 'deleteMessage') };
    return { spies, assert: () => { for (const s of Object.values(spies)) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); } } };
  };

  it("case C: CC'd approval request yields one decision item with the exact action text, notified once, no approve / send / spend call", async () => {
    w = phaseCWorld();
    const confirm = require('../src/email-intel/confirm');
    confirm._resetForTests();
    const guard = noConsequential();
    const notify = vi.fn(() => true);
    const c = approvalCase(w);
    await w.scan([c], { _notify: notify });
    const dec = w.open('decision');
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({
      category: 'decision', tier: 'required', reasonCode: 'decision-me', units: ['40123'],
      reasonText: 'Dealer Parts Desk asked you to approve the estimate for unit 40123 ($1,840)',
      actionText: 'Review in the approval system, then reply. The app will not approve for you.',
    });
    expect(dec[0].actionText).toBe(TPL.DECISION_ACTION);
    expect(w.open('reply')).toEqual([]);                                         // the approval is a decision item, not also a reply item
    expect(w.open('review')).toHaveLength(1);                                    // the staged spend fact is reviewable (not notified)
    expect(w.open('review')[0]).toMatchObject({ reasonCode: 'spend-related', tier: 'suggested' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toEqual({ title: 'My Email Actions', body: '1 item needs your decision (40123)' });
    // rescans: same item id, no second notification, still nothing approved
    await w.scan([c], { _notify: notify });
    await w.scan([c], { _notify: notify });
    expect(w.open('decision').map((x) => x.actionId)).toEqual([dec[0].actionId]);
    expect(w.actions().filter((x) => x.category === 'decision')).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(w.timeline('40123')).toBe('');
    expect(w.staged()[0]).toMatchObject({ reason: 'spend-related', state: 'open' });
    expect(confirm._liveCount()).toBe(0);
    guard.assert();
    expect(w.idx.getStatus().backlog.openActions).toBe(2);
  });

  it('case C with identity unset: the item is a suggested decision and still nothing is approved', async () => {
    w = phaseCWorld(undefined, { me: { names: [], addresses: [], distributionLists: [] } });
    const guard = noConsequential();
    const notify = vi.fn(() => true);
    await w.scan([approvalCase(w)], { _notify: notify });
    const dec = w.open('decision');
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ tier: 'suggested', reasonCode: 'decision-possible', actionText: TPL.DECISION_ACTION });
    expect(dec[0].reasonText).toMatch(/^An estimate decision about unit 40123 may need you \(addressee unclear\)/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(w.timeline('40123')).toBe('');
    guard.assert();
  });

  it('case D: coworker question about my unit gives owner other-person and no Reply Needed item for me', async () => {
    w = phaseCWorld();
    const notify = vi.fn(() => true);
    w.rules.push({ unit: '40123', fact: fact({ item: 'DPF', value: 'DPF ETA 11/14', date: '2026-11-14', evidence: 'The DPF ETA is 11/14' }) });
    w.questions.push({ when: 'Mike, can you check', q: { ref: 'q1', text: 'Can you check the DPF on 40123?', about: ['40123'], addressee: { kind: 'named-other', name: 'Mike', evidence: 'Mike, can you check the DPF on 40123?' }, isApprovalOrDecision: false, confidence: 0.9 } });
    await w.scan([w.cap({ from: DEALER, to: [COWORKER, person(3)], subject: 'DPF on 40123', conversationId: 'conv-d', body: 'Mike, can you check the DPF on 40123? The DPF ETA is 11/14.' })], { _notify: notify });
    const qs = Object.values(w.stores.load('actions').questions);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ owner: 'other-person', status: 'open', addressee: { kind: 'named-other' } });
    expect(w.open('reply')).toEqual([]);
    expect(w.open('decision')).toEqual([]);
    expect(w.open('recorded')).toHaveLength(1);                                  // the unit fact is captured and shown as recorded
    expect(w.open('recorded')[0].reasonText).toBe('Recorded 1 update for unit 40123: Parts ETA');
    expect(w.lines('40123')).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();                                       // recorded items never notify
  });

  const iCase = (world, o = {}) => {
    world.questions.push({ when: 'can you confirm pickup Friday', q: { ref: 'q1', text: 'Can you confirm pickup Friday for 40123?', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup Friday' }, isApprovalOrDecision: false, confidence: 0.9 } });
    world.answers.push({ when: 'Confirmed for Friday', evidence: 'Confirmed for Friday', confidence: 0.9 });
    const m1 = world.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40123', conversationId: 'conv-i', messageId: 'i-1', receivedAt: '2026-11-04T14:00:00.000Z', body: 'Zila, can you confirm pickup Friday for 40123?' });
    const m2 = world.cap({ from: o.from || COWORKER, to: [DEALER], cc: [ZILA], subject: 'RE: Pickup 40123', conversationId: 'conv-i', messageId: 'i-2', receivedAt: '2026-11-04T15:00:00.000Z', body: 'Confirmed for Friday, the truck is booked for 40123.' });
    return { m1, m2 };
  };

  it('case I: later answer closes the question, no item, no notification', async () => {
    w = phaseCWorld();
    const notify = vi.fn(() => true);
    const { m1, m2 } = iCase(w);
    await w.scan([m1, m2], { _notify: notify });
    const qs = Object.values(w.stores.load('actions').questions);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ status: 'answered', owner: 'me', answeredBy: { basis: 'later-answer', confidence: 0.9 } });
    for (const cat of ['reply', 'decision', 'followup', 'review']) expect(w.open(cat), cat).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    const res = await w.scan([m1, m2], { _notify: notify });                      // a rescan does not resurrect it
    expect(w.open('reply')).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(res.emails[0].replySuggested).toBe(false);
  });

  it('case I across scans: the open Reply Needed item closes automatically when the answer arrives; notified once in total', async () => {
    w = phaseCWorld();
    const notify = vi.fn(() => true);
    const { m1, m2 } = iCase(w);
    await w.scan([m1], { _notify: notify });
    const open = w.open('reply');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ tier: 'required', reasonText: 'Dealer Parts Desk asked you a question about unit 40123', actionText: 'Reply to Dealer Parts Desk (Reply or Reply All)' });
    expect(notify).toHaveBeenCalledTimes(1);
    await w.scan([m1, m2], { _notify: notify });
    expect(w.open('reply')).toEqual([]);
    expect(w.actions().find((x) => x.actionId === open[0].actionId).state).toBe('done-auto');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('case I own reply: my later message in the thread answers the question (R4.4)', async () => {
    w = phaseCWorld();
    const notify = vi.fn(() => true);
    const { m1, m2 } = iCase(w, { from: ZILA });
    await w.scan([m1, m2], { _notify: notify });
    expect(Object.values(w.stores.load('actions').questions)[0]).toMatchObject({ status: 'answered', answeredBy: { basis: 'own-reply' } });
    expect(w.open('reply')).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});
// ── FEAT-006: thread-aware replies. Case I's draft side and case L at the executor / store level (temp data dir,
// scripted lane, the Outlook reply mechanism stubbed: no Outlook, no send).
describe('acceptance cases I and L with thread replies (FEAT-006)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const REPLIES = { enabled: true, capture: true, multiRecipient: true, actionsView: true, timelineWrites: true, threadReplies: true };
  const identity = require('../src/email-intel/ingest/identity');
  const iThread = (world) => {
    world.questions.push({ when: 'can you confirm pickup Friday', q: { ref: 'q1', text: 'Can you confirm pickup Friday for 40123?', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup Friday' }, isApprovalOrDecision: false, confidence: 0.9 } });
    world.answers.push({ when: 'Confirmed for Friday', evidence: 'Confirmed for Friday', confidence: 0.9 });
    return [
      world.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40123', conversationId: 'conv-i6', messageId: 'i6-1', receivedAt: '2026-11-04T14:00:00.000Z', body: 'Zila, can you confirm pickup Friday for 40123?' }),
      world.cap({ from: COWORKER, to: [DEALER], cc: [ZILA], subject: 'RE: Pickup 40123', conversationId: 'conv-i6', messageId: 'i6-2', receivedAt: '2026-11-04T15:00:00.000Z', body: 'Confirmed for Friday, the truck is booked for 40123.' }),
    ];
  };

  it('case I: later answer closes the question, no item, no notification, draft refused', async () => {
    w = phaseCWorld(REPLIES);
    const notify = vi.fn(() => true);
    await w.scan(iThread(w), { _notify: notify });
    expect(w.open('reply')).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    const draft = require('../src/email-intel/reply/draft');
    const ask = vi.fn(async () => ({ ok: true, text: 'Confirming Friday.' }));
    const ck = identity.conversationKey('conv-i6');
    for (const mode of ['reply', 'reply-all']) {
      const r = await draft.draftThreadReply({ conversationKey: ck, mode }, { _ask: ask });
      expect(r).toMatchObject({ ok: false, code: 'ALREADY_RESOLVED', resolvedBy: { senderName: 'Mike Rivera', basis: 'later-answer' } });
    }
    expect(ask).not.toHaveBeenCalled();                                            // no AI call, nothing to send
    const legacy = w.store.load('emailTriageResults').emails.find((e) => e.intel && e.intel.conversationKey === ck);
    expect(legacy.replyState).not.toBe('drafted');
  });

  it('case L: uncertain send blocks resend until reconciled', async () => {
    w = phaseCWorld(REPLIES);
    const caps = iThread(w).slice(0, 1);                                             // an open question to me
    await w.scan(caps);
    const ck = identity.conversationKey('conv-i6');
    const confirm = require('../src/email-intel/confirm');
    const executors = require('../src/email-intel/executors');
    const guard = require('../src/email-intel/reply/send-guard');
    const owaReply = require('../src/email-intel/reply/owa_reply');
    const actions = require('../src/scrapers/email_actions');
    confirm._resetForTests(); guard._resetForTests();
    executors.registerAll();
    const real = owaReply.sendThreadReply;
    const legacySpy = vi.spyOn(actions, 'sendReply');
    const accept = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
    let clicks = 0;
    owaReply.sendThreadReply = vi.fn(async (o) => { if (!o.attemptHooks.beforeSendClick()) return { status: 'failed-before-send', detail: {} }; clicks++; return { status: 'delivery-uncertain', mechanism: 'owa-thread', detail: { code: 'NOT_IN_SENT_ITEMS' } }; });
    try {
      const p = confirm.prepare('send-reply', { conversationKey: ck, mode: 'reply', bodyText: 'Friday works for 40123.' });
      expect(p.ok).toBe(true);
      const r = await confirm.confirm(p.token, { _dialog: accept });
      expect(r).toMatchObject({ ok: false, status: 'delivery-uncertain' });
      expect(r.message).toContain('reconcile before retrying');
      // a second click, a retry from another view, or a re-prepare: all refused, nothing sent again
      expect(await confirm.confirm(p.token, { _dialog: accept })).toEqual({ ok: false, code: 'TOKEN_USED' });
      expect(executors.validateSendReply({ conversationKey: ck, mode: 'reply', bodyText: 'again' })).toMatchObject({ ok: false, code: 'UNRECONCILED_ATTEMPT', attemptId: r.attemptId });
      expect(executors.validateSendReply({ conversationKey: ck, mode: 'new-message', bodyText: 'again' }).code).toBe('UNRECONCILED_ATTEMPT');
      expect(confirm.prepare('send-reply', { conversationKey: ck, mode: 'reply-all', bodyText: 'again' })).toMatchObject({ ok: false, code: 'BAD_ARG' });
      expect(clicks).toBe(1);
      expect(legacySpy).not.toHaveBeenCalled();
      const legacy = () => w.store.load('emailTriageResults').emails.find((e) => e.intel && e.intel.conversationKey === ck);
      expect(legacy().replyState).toBe('uncertain');                                 // the overlay renders it non-actionable (F-09)
      expect(w.idx.getStatus().backlog.unreconciledSends).toBe(1);
      // boot recovery leaves it uncertain; a rescan keeps the uncertain state on the legacy record
      guard.bootRecover();
      await w.scan(caps);
      expect(legacy().replyState).toBe('uncertain');
      expect(guard.canSend(ck).ok).toBe(false);
      // read-only reconcile: not found keeps it blocked; found unblocks and marks the reply sent
      const { reconcileSend } = require('../src/email-intel/reply/reconcile-send');
      const session = async (_o, driver) => { const ctx = { state: {}, win: {} }; await driver(ctx); return { state: ctx.state, settled: {} }; };
      expect(await reconcileSend(r.attemptId, { _session: session, _verify: async () => ({ found: false }) })).toMatchObject({ state: 'unconfirmed-not-found' });
      expect(guard.canSend(ck).ok).toBe(false);
      expect(await reconcileSend(r.attemptId, { _session: session, _verify: async () => ({ found: true }) })).toMatchObject({ state: 'sent' });
      expect(guard.canSend(ck)).toEqual({ ok: true });
      expect(legacy().replyState).toBe('sent');
      expect(w.open('reply')).toEqual([]);                                           // the Reply Needed item is done
      expect(clicks).toBe(1);                                                        // reconcile never sends
    } finally { owaReply.sendThreadReply = real; legacySpy.mockRestore(); confirm._resetForTests(); }
  });
});

// FEAT-007 (Phase F): case M at runIntelScan level. The reader stand-in does what owa_capture does with the
// `attachments` flag effective (policy -> fetch -> extract on the newest message); the extractor is stubbed to
// report a scanned PDF it cannot read, and the scripted lane tries to invent a $4,200 estimate.
describe('acceptance case M with attachments (FEAT-007)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });

  it('case M: estimate-named attachment, unreadable content, no invented amount, labeled filename only', async () => {
    const { PHASE_F, att, attReader, stubExtract, REASONS } = await import('./fixtures/email-intel/attach.js');
    const panels = await import('../renderer/src/js/components/email-intel-panels.js');
    w = phaseCWorld(PHASE_F);
    const confirm = require('../src/email-intel/confirm');
    confirm._resetForTests();
    const extract = stubExtract({ 'Estimate_40123.pdf': { kind: 'pdf', status: 'failed', reason: REASONS.SCANNED_PDF_UNAVAILABLE, text: '' } });
    const m = { from: DEALER, to: [ZILA], subject: 'Unit 40123', conversationId: 'conv-m', body: 'Hi Zila, attached for unit 40123. Thanks.', attachments: [att('Estimate_40123.pdf')] };
    // the scripted model invents an estimate amount from the file name, once quoting the body and once the name
    w.answer = (prompt) => ({
      schemaVersion: 2, messageRef: '$REF', relevance: { level: 'high', reason: 'estimate', confidence: 0.95 },
      units: [{ unit: '40123', gist: 'estimate', facts: [
        { kind: 'approval_status', item: 'estimate', value: 'Estimate received for $4,200', state: 'estimate_received', date: null, amount: { value: 4200, currency: 'USD' }, assertion: 'stated', evidence: 'attached for unit 40123', noteConflictHint: false, confidence: 0.95 },
        { kind: 'approval_status', item: 'estimate', value: 'Estimate received', state: 'estimate_received', date: null, amount: { value: 4200, currency: 'USD' }, assertion: 'stated', evidence: 'Estimate_40123.pdf', evidenceSource: 'attachment:0', noteConflictHint: false, confidence: 0.95 },
      ] }],
      questions: [], requests: [], answers: [], commitments: [],
      classification: { category: 'fleet_status_update', intent: 'provide_update', informationalOnly: true, confidence: 0.9 },
      suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.9,
    });
    const writer = require('../src/email-intel/facts/timeline-writer');
    const cap = w.cap(m);
    const reader = attReader([cap], { extract });
    const res = await w.scan([cap], { _readMailbox: reader });
    expect(reader.calls.fetch).toBe(1);                                              // fetched once, through the policy
    const rec = Object.values(w.messages())[0];
    // status: unreadable (scanned PDF, vision unavailable); the stored record has no file content
    expect(rec.attachments[0].analysis).toMatchObject({ status: 'unreadable', reason: 'scanned-pdf-unavailable', reasonText: REASONS.SCANNED_PDF_UNAVAILABLE });
    // the prompt carried the name only, never as content
    const prompt = w.relay.calls[0].prompt;
    expect(prompt).toContain('name: "Estimate_40123.pdf" - NAME ONLY, carries no facts');
    expect(prompt).not.toContain('<<<UNTRUSTED_ATTACHMENT id=');
    // no amount and no approval fact survives: the invented amount is dropped, the filename quote is not evidence
    expect(rec.analysis.status).toBe('ok');
    const facts = (rec.analysis.result.units || []).flatMap((u) => u.facts);
    expect(facts).toEqual([]);
    expect(rec.analysis.validation.dropped.amount).toBeGreaterThanOrEqual(1);
    expect(rec.analysis.validation.dropped.unverifiedEvidence).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rec.analysis.result)).not.toMatch(/4,?200/);
    expect(w.staged().filter((s) => s.fact && (s.fact.amount || s.fact.kind === 'approval_status'))).toEqual([]);
    expect(w.ledger()).toEqual([]);
    expect(w.lines('40123')).toEqual([]);
    expect(writer.appliedMessageKeys().size).toBe(0);
    // the overlay record and its label: "Filename only", never "Analyzed"
    const legacyAtt = res.emails[0].attachments[0];
    expect(legacyAtt).toMatchObject({ name: 'Estimate_40123.pdf', analysisStatus: 'unreadable' });
    const label = panels.renderAttachmentStatusHtml(legacyAtt);
    expect(label).toContain('Filename only');
    expect(label).not.toContain('Analyzed');
    // no approve / spend path ran
    expect(confirm._liveCount()).toBe(0);
  });

  it('case M with the attachments flag OFF: no fetch, filename-only everywhere, the same invented amount is dropped', async () => {
    const { att, attReader, stubExtract } = await import('./fixtures/email-intel/attach.js');
    w = phaseCWorld();                                                               // PHASE_C: attachments not effective
    const extract = stubExtract({});
    w.answer = () => ({
      schemaVersion: 2, messageRef: '$REF', relevance: { level: 'high', reason: 'estimate', confidence: 0.95 },
      units: [{ unit: '40123', gist: 'estimate', facts: [{ kind: 'approval_status', item: 'estimate', value: 'Estimate received for $4,200', state: 'estimate_received', date: null, amount: { value: 4200, currency: 'USD' }, assertion: 'stated', evidence: 'attached for unit 40123', noteConflictHint: false, confidence: 0.95 }] }],
      questions: [], requests: [], answers: [], commitments: [], classification: { category: 'fleet_status_update', intent: 'provide_update', informationalOnly: true, confidence: 0.9 },
      suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.9,
    });
    const cap = w.cap({ from: DEALER, to: [ZILA], subject: 'Unit 40123', conversationId: 'conv-m-off', body: 'Hi Zila, attached for unit 40123. Thanks.', attachments: [att('Estimate_40123.pdf')] });
    const reader = attReader([cap], { extract });
    const res = await w.scan([cap], { _readMailbox: reader });
    expect(reader.calls.fetch).toBe(0);
    expect(extract.calls.n).toBe(0);
    const rec = Object.values(w.messages())[0];
    expect(rec.attachments[0].analysis).toEqual({ status: 'filename-only' });
    expect((rec.analysis.result.units || []).flatMap((u) => u.facts)).toEqual([]);
    expect(res.emails[0].attachments[0]).toEqual({ name: 'Estimate_40123.pdf', ext: 'pdf', type: 'document' });     // legacy shape unchanged
  });
});