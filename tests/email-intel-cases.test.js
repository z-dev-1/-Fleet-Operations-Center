// tests/email-intel-cases.test.js — acceptance cases (design 11, 12.2). FEAT-003 covers D, E and F at
// ANALYSIS level (facts and determinations only; nothing is written). FEAT-004 adds the runIntelScan-level
// versions with the timeline writer, and the remaining cases arrive with their phases.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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