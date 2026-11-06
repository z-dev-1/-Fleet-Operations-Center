// tests/email-intel-validate.test.js — v2 output validator, one `it` per design 3.6 row
// (R2.4, R3.1, R6.4, R7.1, R7.2, R7.7, F-25).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { ME } from './fixtures/email-intel/fleet.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateAnalysis } = require('../src/email-intel/understand/validate');
const { PHASE_ORDER } = require('../src/email-intel/facts/phase-order');
const schema = require('../src/email-intel/understand/schema');

const TEXT = 'Subject: Status 40123\n\nHi Zila, parts arrived for unit 40123 and the repair starts 2026-11-10. The estimate is $1,840.00 for 40123. '
  + 'Unit 51888 is waiting on approval. Mike, can you confirm pickup for 40456 on Friday? ' + 'Filler sentence. '.repeat(40) + 'Unit 40999 brakes done.';
const SCOPE = { 40123: 'in', 40456: 'in', 40999: 'in', 51888: 'out', 40789: 'unknown' };
const ctx = (o = {}) => Object.assign({
  expectedRef: 'rREF', candidateUnits: ['40123', '40456', '40999', '51888', '40789'], scopeOf: (u) => SCOPE[u] || 'out',
  priorQuestionIds: ['pq_1'], text: TEXT, receivedAt: '2026-11-04T14:30:00.000Z', now: Date.parse('2026-11-04T16:00:00Z'), me: ME, oneToOne: false,
}, o);
const fact = (o = {}) => Object.assign({ kind: 'parts_availability', item: 'parts', value: 'Parts arrived', state: 'arrived', date: null, amount: null, assertion: 'stated', evidence: 'parts arrived for unit 40123', noteConflictHint: false, confidence: 0.9 }, o);
const base = (o = {}) => Object.assign({
  schemaVersion: 2, messageRef: 'rREF', relevance: { level: 'high', reason: 'unit update', confidence: 0.9 },
  units: [{ unit: '40123', gist: 'parts in', facts: [fact()] }], questions: [], requests: [], answers: [], commitments: [],
  classification: { category: 'fleet_status_update', intent: 'provide_update', informationalOnly: false, confidence: 0.9 },
  suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.9,
}, o);
const facts = (r) => (r.analysis ? r.analysis.units.flatMap((u) => u.facts) : []);
const oneFact = (f, o) => validateAnalysis(base({ units: [{ unit: '40123', facts: [fact(f)] }] }), ctx(o));

describe('structural rejection', () => {
  it.each([
    ['not an object', 'x'], ['array', []], ['schemaVersion 1', base({ schemaVersion: 1 })], ['messageRef mismatch', base({ messageRef: 'other' })],
    ['units missing', base({ units: undefined })], ['questions not array', base({ questions: {} })], ['answers missing', base({ answers: undefined })],
    ['classification missing', base({ classification: null })],
  ])('%s is rejected whole', (_n, raw) => {
    const r = validateAnalysis(raw, ctx());
    expect(r.ok).toBe(false);
    expect(r.analysis).toBeNull();
    expect(r.errors.length).toBe(1);
  });
  it('a valid object passes and unknown keys are not stored', () => {
    const r = validateAnalysis(base({ send: true, recipients: ['attacker@example.test'], approve: true }), ctx());
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.analysis)).not.toMatch(/attacker|"send"|"approve"|recipients/);
  });
});

describe('design 3.6 rows', () => {
  it('units[].unit must be a candidate (case-insensitive); unknown units dropped', () => {
    const r = validateAnalysis(base({ units: [{ unit: '99999', facts: [fact()] }, { unit: '40123', facts: [fact()] }] }), ctx({ candidateUnits: ['40123'] }));
    expect(r.analysis.units.map((u) => u.unit)).toEqual(['40123']);
    expect(r.counts.dropped.unknownUnit).toBe(1);
  });
  it('unit scope: out keeps no facts (counted), unknown keeps facts flagged scopeUnknown', () => {
    const r = validateAnalysis(base({ units: [{ unit: '51888', facts: [fact({ evidence: 'Unit 51888 is waiting on approval' })] }, { unit: '40789', facts: [fact({ evidence: 'parts arrived for unit 40123' })] }] }), ctx());
    expect(r.analysis.units.map((u) => u.unit)).toEqual(['40789']);
    expect(r.analysis.units[0].scopeUnknown).toBe(true);
    expect(r.counts.otherUnits).toBe(1);
    expect(r.counts.dropped.outOfScopeFacts).toBe(1);
  });
  it('facts capped at 10 per unit and 30 per message', () => {
    const many = Array.from({ length: 14 }, () => fact());
    const r = validateAnalysis(base({ units: [{ unit: '40123', facts: many }] }), ctx());
    expect(facts(r)).toHaveLength(10);
    expect(r.counts.dropped.overCap).toBe(4);
    const r2 = validateAnalysis(base({ units: ['40123', '40456', '40999', '40789'].map((u) => ({ unit: u, facts: Array.from({ length: 10 }, () => fact()) })) }), ctx());
    expect(facts(r2)).toHaveLength(30);
  });
  it('R3.1 nine fact kinds accepted with typed fields', () => {
    const states = { repair_stage: 'repair_in_progress', parts_availability: 'arrived', parts_eta: 'eta_given', estimated_completion: 'eta_given', approval_status: 'pending', vendor_status: 'working', pickup_readiness: 'not_ready', transportation: 'needed', blocker: 'parts' };
    const list = schema.FACT_KINDS.map((k) => fact({ kind: k, state: states[k] }));
    const r = validateAnalysis(base({ units: [{ unit: '40123', facts: list }] }), ctx());
    expect(facts(r).map((f) => f.kind)).toEqual(schema.FACT_KINDS);
    for (const f of facts(r)) expect(f).toMatchObject({ value: expect.any(String), state: expect.any(String), assertion: 'stated', evidence: expect.any(String), confidence: 0.9, confidenceValid: true });
  });
  it('kind, state and assertion must be in their enums', () => {
    for (const bad of [{ kind: 'gossip' }, { state: 'teleported' }, { assertion: 'certain' }, { kind: 'parts_eta', state: 'arrived_maybe' }]) {
      const r = oneFact(bad);
      expect(facts(r)).toHaveLength(0);
      expect(r.counts.dropped.invalidFact).toBe(1);
    }
  });
  it('value 1..160 chars after control strip; whitespace collapsed', () => {
    expect(facts(oneFact({ value: '' }))).toHaveLength(0);
    expect(facts(oneFact({ value: 'x'.repeat(161) }))).toHaveLength(0);
    expect(facts(oneFact({ value: ' Parts\u0007   arrived\n now ' }))[0].value).toBe('Parts arrived now');
  });
  it('item is optional, <= 40 chars, otherwise blank', () => {
    expect(facts(oneFact({ item: 'y'.repeat(41) }))[0].item).toBeNull();
    expect(facts(oneFact({ item: 'turbo' }))[0].item).toBe('turbo');
  });
  it('date must be a real calendar date within receivedAt-60d..+400d, else null with dateInvalid', () => {
    expect(facts(oneFact({ date: '2026-11-10' }))[0]).toMatchObject({ date: '2026-11-10', dateInvalid: false });
    for (const d of ['2026-02-30', '11/10/2026', '2026-08-01', '2028-06-01', 20261110]) expect(facts(oneFact({ date: d }))[0]).toMatchObject({ date: null, dateInvalid: true });
    // receivedAt unknown -> now-based window
    expect(facts(oneFact({ date: '2026-11-10' }, { receivedAt: null }))[0].date).toBe('2026-11-10');
  });
  it('R6.4 amount must appear in text', () => {
    expect(facts(oneFact({ amount: { value: 1840, currency: 'USD' } }))[0]).toMatchObject({ amount: { value: 1840, currency: 'USD' }, amountUnverified: false });
    expect(facts(oneFact({ amount: { value: 1840.0, currency: null } }))[0].amount.value).toBe(1840);
    for (const a of [{ value: 2500, currency: 'USD' }, { value: -1, currency: 'USD' }, { value: 1840, currency: 'EUR' }, { value: '1840' }, { value: 2e7 }]) {
      const f = facts(oneFact({ amount: a }))[0];
      expect(f).toMatchObject({ amount: null, amountUnverified: true });
    }
  });
  it('evidence 8..200 chars and a normalized substring of the text, else the fact is dropped', () => {
    expect(facts(oneFact({ evidence: 'PARTS   arrived for UNIT 40123' }))).toHaveLength(1);
    for (const ev of ['short', 'parts arrived for unit 40999 yesterday', 'x'.repeat(201), null]) {
      const r = oneFact({ evidence: ev });
      expect(facts(r)).toHaveLength(0);
      expect(r.counts.dropped.unverifiedEvidence).toBe(1);
    }
  });
  it('R2.4 evidence proximity attribution: id in or near the quote is strong, far away is weak', () => {
    expect(facts(oneFact({ evidence: 'parts arrived for unit 40123' }))[0].unitAttribution).toBe('strong');
    const far = validateAnalysis(base({ units: [{ unit: '40999', facts: [fact({ evidence: 'Hi Zila, parts arrived for unit' })] }] }), ctx());
    expect(facts(far)[0].unitAttribution).toBe('weak');
    expect(far.counts.weakAttribution).toBe(1);
    const near = validateAnalysis(base({ units: [{ unit: '40999', facts: [fact({ evidence: 'brakes done.', kind: 'repair_stage', state: 'repair_complete' })] }] }), ctx());
    expect(facts(near)[0].unitAttribution).toBe('strong');    // the id sits right before the quote
  });
  it('R7.1 confidence required number 0..1; anything else is null + confidenceValid false (never clamped)', () => {
    for (const c of [undefined, null, '0.9', NaN, -0.1, 1.01, 95, Infinity, true]) {
      const f = facts(oneFact({ confidence: c }))[0];
      expect(f).toMatchObject({ confidence: null, confidenceValid: false });
    }
    for (const c of [0, 0.75, 1]) expect(facts(oneFact({ confidence: c }))[0]).toMatchObject({ confidence: c, confidenceValid: true });
  });
  it('questions: max 12, text 1..200, addressee enum, name <= 60', () => {
    const q = (o = {}) => Object.assign({ ref: 'q1', text: 'Can you confirm pickup?', about: ['40456'], addressee: { kind: 'group', name: null, evidence: null }, isApprovalOrDecision: false, decisionKind: null, confidence: 0.8 }, o);
    const r = validateAnalysis(base({ questions: Array.from({ length: 14 }, () => q()).concat([q({ text: '' }), q({ addressee: { kind: 'boss' } })]) }), ctx());
    expect(r.analysis.questions).toHaveLength(12);
    expect(r.analysis.questions[0].about).toEqual(['40456']);
    const one = validateAnalysis(base({ questions: [q({ addressee: { kind: 'group', name: 'n'.repeat(61), evidence: null } })] }), ctx());
    expect(one.analysis.questions[0].addressee.name).toBeNull();
  });
  it('R2.5 me requires evidence: me without my name (and no 1:1) is downgraded to unclear; named-other needs evidence', () => {
    const q = (addressee) => base({ questions: [{ ref: 'q1', text: 'Can you confirm pickup?', about: [], addressee, confidence: 0.8 }] });
    const ok = validateAnalysis(q({ kind: 'me', name: 'Zila', evidence: 'Hi Zila, parts arrived' }), ctx());
    expect(ok.analysis.questions[0].addressee).toMatchObject({ kind: 'me', basis: 'named' });
    const noName = validateAnalysis(q({ kind: 'me', name: null, evidence: 'Mike, can you confirm pickup' }), ctx());
    expect(noName.analysis.questions[0].addressee.kind).toBe('unclear');
    expect(noName.counts.downgradedAddressee).toBe(1);
    const oneToOne = validateAnalysis(q({ kind: 'me', name: null, evidence: null }), ctx({ oneToOne: true }));
    expect(oneToOne.analysis.questions[0].addressee).toMatchObject({ kind: 'me', basis: 'direct-1to1' });
    const other = validateAnalysis(q({ kind: 'named-other', name: 'Mike', evidence: 'Mike, can you confirm pickup' }), ctx());
    expect(other.analysis.questions[0].addressee.kind).toBe('named-other');
    const otherNoEv = validateAnalysis(q({ kind: 'named-other', name: 'Mike', evidence: 'not in the text at all' }), ctx());
    expect(otherNoEv.analysis.questions[0].addressee.kind).toBe('unclear');
  });
  it('answers: pqid must be a prior question id, evidence in text, confidence valid', () => {
    const a = (o) => Object.assign({ pqid: 'pq_1', evidence: 'parts arrived for unit 40123', confidence: 0.9 }, o);
    const r = validateAnalysis(base({ answers: [a(), a({ pqid: 'pq_9' }), a({ evidence: 'nope not here' }), a({ confidence: 'high' })] }), ctx());
    expect(r.analysis.answers).toEqual([{ pqid: 'pq_1', evidence: 'parts arrived for unit 40123', confidence: 0.9, confidenceValid: true }]);
    expect(r.counts.dropped.invalidAnswer).toBe(3);
  });
  it('commitments: max 5, dueDate by the date rule (invalid -> null)', () => {
    const c = (o) => Object.assign({ by: 'other', who: 'Dealer', text: 'Will call Friday', dueDate: '2026-11-07', confidence: 0.8 }, o);
    const r = validateAnalysis(base({ commitments: [c(), c({ dueDate: '2030-01-01' }), c({ by: 'nobody' }), c(), c(), c(), c()] }), ctx());
    expect(r.analysis.commitments).toHaveLength(5);
    expect(r.analysis.commitments[1].dueDate).toBeNull();
  });
  it('classification category / intent in the email_intel vocabulary, else unknown / none', () => {
    const r = validateAnalysis(base({ classification: { category: 'hacking', intent: 'pwn', confidence: 0.5 } }), ctx());
    expect(r.analysis.classification).toMatchObject({ category: 'unknown', intent: 'none', informationalOnly: false });
  });
  it('suggestDelete defaults to false unless explicitly true', () => {
    expect(validateAnalysis(base({ suggestDelete: { suggested: 'yes' } }), ctx()).analysis.suggestDelete.suggested).toBe(false);
    expect(validateAnalysis(base({ suggestDelete: undefined }), ctx()).analysis.suggestDelete.suggested).toBe(false);
    expect(validateAnalysis(base({ suggestDelete: { suggested: true, reason: 'newsletter', confidence: 0.9 } }), ctx()).analysis.suggestDelete.suggested).toBe(true);
  });
  it('overallConfidence invalid sets overallValid false', () => {
    for (const v of [undefined, '0.9', 2, NaN]) expect(validateAnalysis(base({ overallConfidence: v }), ctx()).analysis).toMatchObject({ overallConfidence: null, overallValid: false });
  });
  it('R7.7 secret-like output dropped (findSecret on every accepted string)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P';
    const r = validateAnalysis(base({
      relevance: { level: 'high', reason: 'token ' + jwt, confidence: 0.9 },
      units: [{ unit: '40123', gist: 'AKIAABCDEFGHIJKLMNOP', facts: [fact({ value: 'key AKIAABCDEFGHIJKLMNOP' }), fact()] }],
      questions: [{ ref: 'q1', text: 'xoxb-1234567890-abcdef', addressee: { kind: 'group' }, confidence: 0.8 }],
    }), ctx());
    expect(JSON.stringify(r.analysis)).not.toMatch(/AKIA|xoxb|eyJhbGci/);
    expect(facts(r)).toHaveLength(1);
    expect(r.analysis.questions).toHaveLength(0);
    expect(r.counts.dropped.secret).toBeGreaterThanOrEqual(3);
  });
});

describe('F-25 phase order drift guard', () => {
  it('F-25 PHASE_ORDER matches email_intel.js source', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/scrapers/email_intel.js'), 'utf8');
    const fn = src.slice(src.indexOf('function deriveInformationType'));
    const lit = /const ORDER = (\[[\s\S]*?\]);/.exec(fn)[1];
    const arr = JSON.parse(lit.replace(/'/g, '"').replace(/,\s*\]/, ']'));
    expect(arr).toEqual([...PHASE_ORDER]);
    expect(Object.isFrozen(PHASE_ORDER)).toBe(true);
    expect(schema.STATE_ENUMS.repair_stage).toBe(PHASE_ORDER);
  });
});
