// tests/email-intel-analyze.test.js — analysis orchestration with a scripted isolated lane
// (design 3.9, 3.10; R2.6, R3.1, R4.1-R4.9, R7.6, R8.4, R8.8, NFR-9, F-16, F-26, AC-12).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { ME } from './fixtures/email-intel/fleet.js';
import { mk, scenarios, ZILA, COWORKER, DEALER } from './fixtures/email-intel/emails.js';
import { recordOf, docOf, analyzeDoc, scriptedRelay, aiFixture, NOW, refOf } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const an = require('../src/email-intel/understand/analyze');
const lane = require('../src/email-intel/understand/lane');
const C = require('../src/email-intel/constants');

beforeEach(() => lane._resetForTests());
afterEach(() => lane._resetForTests());

const okRelay = (name) => scriptedRelay(() => aiFixture(name));
const one = async (m, fixtureOrFn, over) => {
  const rec = recordOf(m);
  const doc = docOf([rec]);
  const relay = typeof fixtureOrFn === 'function' ? scriptedRelay(fixtureOrFn) : okRelay(fixtureOrFn);
  const stats = await analyzeDoc(doc, relay, over);
  return { a: doc.messages[rec.messageKey].analysis, rec: doc.messages[rec.messageKey], relay, stats, doc };
};
const out = (o) => Object.assign({ schemaVersion: 2, messageRef: '$REF', relevance: { level: 'medium', reason: 'x', confidence: 0.8 }, units: [], questions: [], requests: [], answers: [], commitments: [], classification: { category: 'question', intent: 'request_information', informationalOnly: false, confidence: 0.8 }, suggestDelete: { suggested: false, reason: '', confidence: 0.9 }, overallConfidence: 0.85 }, o);

describe('facts', () => {
  it('R3.1 extracts multiple facts per unit, each with its own effective confidence and caps', async () => {
    const { a } = await one(scenarios.multi20to(), 'multi20to');
    expect(a.status).toBe('ok');
    const u = a.result.units.find((x) => x.unit === '40123');
    expect(u.facts.map((f) => f.kind)).toEqual(['parts_availability', 'repair_stage']);
    expect(u.facts[0]).toMatchObject({ effectiveConfidence: 0.9, caps: [] });
    expect(u.facts[1].caps).toContain('not-stated');
    expect(u.facts[1].effectiveConfidence).toBe(0.6);
    expect(a.coverage).toMatchObject({ windowsTotal: 1, windowsSent: 1, windowsAnalyzed: 1 });
  });

  it('R2.6 facts independent of category and question', async () => {
    const { a } = await one(scenarios.coworkerQuestion(), 'coworker-question');
    expect(a.result.classification.category).toBe('question');
    expect(a.result.units[0].facts).toHaveLength(1);
    expect(a.determinations.replyRequirement.value).toBe('none');
    expect(a.determinations.informationRelevance.level).toBe('high');
  });

  it('reuse by contentHash: an identical message in the same conversation is not sent again', async () => {
    const r1 = recordOf(mk({ conversationId: 'conv-reuse', subject: 'Parts update 40123', body: 'Parts arrived for unit 40123, repair starts Monday.', receivedAt: '2026-11-04T10:00:00.000Z' }));
    const doc = docOf([r1]);
    const relay = okRelay('multi20to');
    await analyzeDoc(doc, relay);
    const r2 = recordOf(mk({ conversationId: 'conv-reuse', messageId: 'msg-fwd', from: COWORKER, subject: 'FW: Parts update 40123', body: 'Parts arrived for unit 40123, repair starts Monday.', receivedAt: '2026-11-04T11:00:00.000Z' }), { doc });
    await analyzeDoc(doc, relay);
    expect(relay.calls).toHaveLength(1);
    expect(doc.messages[r2.messageKey].analysis).toMatchObject({ status: 'ok', reusedFrom: r1.messageKey });
  });

  it('deterministicAnalysis classifies without attachments (filenames never feed classification)', () => {
    const rec = recordOf(mk({ subject: 'Hello', body: 'See you soon', attachments: [{ name: 'Estimate_approve_$5000.xlsx' }] }));
    const d = an.deterministicAnalysis(rec, { all: [], quotedOnly: [] });
    expect(d.classification.category).not.toBe('estimate_or_approval');
    expect(d.classification.category).not.toBe('data_report');
  });
});

describe('R4.1..R4.9 per-message determinations table', () => {
  const approve = out({ units: [{ unit: '40123', facts: [{ kind: 'approval_status', value: 'Estimate approval requested', state: 'requested', assertion: 'stated', evidence: 'please approve the $1,840 estimate for 40123', amount: { value: 1840, currency: 'USD' }, confidence: 0.9 }] }],
    questions: [{ ref: 'q1', text: 'Approve the $1,840 estimate for 40123?', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, please approve' }, isApprovalOrDecision: true, decisionKind: 'estimate', confidence: 0.9 }] });
  const promise = out({ units: [{ unit: '40456', facts: [{ kind: 'vendor_status', value: 'Vendor will call', state: 'waiting', assertion: 'stated', evidence: 'We will call you about 40456', confidence: 0.8 }] }],
    commitments: [{ by: 'sender', who: null, text: 'Call about 40456 by 11/01', dueDate: '2026-11-01', confidence: 0.8 }] });
  const rows = [
    ['R4.1 has relevant fleet information', scenarios.multi20to(), 'multi20to', (d) => expect(d.hasFleetInfo).toBe(true)],
    ['R4.2 contains questions (with stable ids)', scenarios.ccApproval(), approve, (d, a) => { expect(d.hasQuestions).toBe(true); expect(a.result.questions[0].id).toMatch(/^pq_[0-9a-f]{12}$/); }],
    ['R4.3 who each question is addressed to', scenarios.coworkerQuestion(), 'coworker-question', (d) => expect(d.actionOwnership.items[0]).toMatchObject({ addressee: 'named-other', owner: 'other-person' })],
    ['R4.5 whether I owe a response', scenarios.ccApproval(), approve, (d) => expect(d.replyRequirement.value).toBe('required')],
    ['R4.6 whether I owe an approval or decision', scenarios.ccApproval(), approve, (d) => expect(d.decisionRequirement).toMatchObject({ value: 'me', kind: 'estimate' })],
    ['R4.7 another team or vendor is responsible', mk({ from: DEALER, to: [ZILA, COWORKER], subject: '40456', body: 'We will call you about 40456 by 11/01.' }), promise, (d) => expect(d.otherResponsible).toMatchObject({ value: true, who: 'vendor' })],
    ['R4.8 a follow-up is overdue', mk({ from: DEALER, to: [ZILA, COWORKER], subject: '40456', body: 'We will call you about 40456 by 11/01.' }), promise, (d) => expect(d.followUpOverdue.value).toBe(true)],
    ['R4.9 informational only', scenarios.multi20to(), 'multi20to', (d) => expect(d.informationalOnly.value).toBe(true)],
  ];
  it.each(rows)('%s', async (_n, m, fx, check) => {
    const { a } = await one(m, typeof fx === 'string' ? fx : () => fx);
    expect(a.status).toBe('ok');
    check(a.determinations, a);
  });

  it('R4.4 a later answer closes the earlier question (and its reply requirement)', async () => {
    const m1 = recordOf(mk({ conversationId: 'conv-q', messageId: 'q-1', from: DEALER, to: [ZILA], cc: [COWORKER], subject: 'Pickup 40456', body: 'Zila, can you confirm pickup Friday for 40456?', receivedAt: '2026-11-04T09:00:00.000Z' }));
    const doc = docOf([m1]);
    const ask = out({ units: [{ unit: '40456', facts: [] }], questions: [{ ref: 'q1', text: 'Can you confirm pickup Friday for 40456?', about: ['40456'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup Friday' }, confidence: 0.9 }] });
    await analyzeDoc(doc, scriptedRelay(() => ask));
    expect(doc.messages[m1.messageKey].analysis.determinations.replyRequirement.value).toBe('required');
    const qid = doc.messages[m1.messageKey].analysis.result.questions[0].id;
    const m2 = recordOf(mk({ conversationId: 'conv-q', messageId: 'q-2', from: COWORKER, to: [DEALER], cc: [ZILA], subject: 'RE: Pickup 40456', body: 'Confirmed for Friday, pickup for 40456 is set.', receivedAt: '2026-11-04T10:00:00.000Z' }), { doc });
    let seen = null;
    await analyzeDoc(doc, scriptedRelay((prompt) => { seen = prompt; return out({ units: [{ unit: '40456', facts: [] }], answers: [{ pqid: qid, evidence: 'Confirmed for Friday', confidence: 0.9 }] }); }));
    expect(seen).toContain(qid);                                         // PRIOR OPEN QUESTIONS carried the id
    expect(doc.messages[m2.messageKey].analysis.result.answers[0].pqid).toBe(qid);
    const d1 = doc.messages[m1.messageKey].analysis.determinations;
    expect(d1.actionOwnership.items[0].state).toBe('answered');
    expect(d1.replyRequirement.value).toBe('none');
  });
});

describe('failure accounting (F-16, AC-12)', () => {
  const rec = () => recordOf(scenarios.multi20to());

  it('F-16 lane outage does not exhaust attempts', async () => {
    const r = rec();
    const doc = docOf([r]);
    const relay = scriptedRelay(() => { throw new Error('lane down'); });
    for (let i = 0; i < 4; i++) await analyzeDoc(doc, relay);              // 4 consecutive outage scans (AC-12)
    const a = doc.messages[r.messageKey].analysis;
    expect(a.status).toBe('ai-unavailable');
    expect(a.outputAttempts).toBe(0);
    expect(a.laneFailures).toBe(4);
    expect(a.deterministic.units.map((u) => u.unit)).toContain('40123');
    expect(a.result).toBeNull();
    // with the lane pre-check failing there is no call at all and nothing is counted
    const down = scriptedRelay(() => { throw new Error('x'); }, { available: false });
    await analyzeDoc(doc, down);
    expect(down.calls).toHaveLength(0);
    expect(doc.messages[r.messageKey].analysis).toMatchObject({ status: 'ai-unavailable', outputAttempts: 0 });
    expect(lane.state().state).toBe('unavailable');
  });

  it('F-16 lane recovery re-analyzes pending messages', async () => {
    const r = rec();
    const doc = docOf([r]);
    await analyzeDoc(doc, scriptedRelay(() => 'x', { available: false }));
    expect(doc.messages[r.messageKey].analysis.status).toBe('pending');
    await analyzeDoc(doc, scriptedRelay(() => { throw new Error('down'); }));
    expect(doc.messages[r.messageKey].analysis.status).toBe('ai-unavailable');
    const good = okRelay('multi20to');
    await analyzeDoc(doc, good);
    expect(good.calls).toHaveLength(1);
    expect(doc.messages[r.messageKey].analysis.status).toBe('ok');
    expect(lane.state().state).toBe('ok');
  });

  it('F-16 retry-analysis resets failed-permanent', async () => {
    const r = rec();
    const doc = docOf([r]);
    const bad = okRelay('invalid-schema');
    const seen = [];
    for (let i = 0; i < C.ANALYSIS_ATTEMPTS_MAX; i++) { await analyzeDoc(doc, bad); seen.push(doc.messages[r.messageKey].analysis.status); }
    expect(seen).toEqual(['invalid', 'invalid', 'failed-permanent']);
    expect(doc.messages[r.messageKey].analysis.outputAttempts).toBe(3);
    await analyzeDoc(doc, bad);
    expect(bad.calls).toHaveLength(3);                                    // failed-permanent is not retried automatically
    doc.messages[r.messageKey].analysis = an.retryAnalysis(doc.messages[r.messageKey].analysis);
    expect(doc.messages[r.messageKey].analysis).toMatchObject({ status: 'pending', outputAttempts: 0 });
    await analyzeDoc(doc, okRelay('multi20to'));
    expect(doc.messages[r.messageKey].analysis.status).toBe('ok');
  });

  it('timeout: counts as lane when nothing succeeds, as output when other calls in the scan succeeded', async () => {
    const a1 = recordOf(mk({ conversationId: 'conv-t1', subject: 'Parts update 40123', body: 'Parts arrived for unit 40123, repair starts Monday.' }));
    const a2 = recordOf(mk({ conversationId: 'conv-t2', subject: 'Parts update 40123 again', body: 'Parts arrived for unit 40123, repair starts Monday. Second.' }));
    const doc = docOf([a1, a2]);
    let n = 0;
    await analyzeDoc(doc, scriptedRelay(() => { n++; if (n === 2) throw Object.assign(new Error('t'), { code: 'AI_TIMEOUT' }); return aiFixture('multi20to'); }));
    const st = [a1, a2].map((r) => doc.messages[r.messageKey].analysis);
    const timedOut = st.find((x) => x.status !== 'ok');
    expect(timedOut).toMatchObject({ status: 'invalid', outputAttempts: 1 });
    const solo = docOf([recordOf(mk({ conversationId: 'conv-t3', subject: 'Parts 40123', body: 'Parts arrived for unit 40123.' }))]);
    await analyzeDoc(solo, scriptedRelay(() => { throw Object.assign(new Error('t'), { code: 'AI_TIMEOUT' }); }));
    expect(Object.values(solo.messages)[0].analysis).toMatchObject({ status: 'ai-unavailable', outputAttempts: 0 });
  });

  it('three consecutive lane failures stop AI for the rest of the scan; the rest stay pending', async () => {
    const recs = [0, 1, 2, 3, 4].map((i) => recordOf(mk({ conversationId: 'conv-l' + i, subject: 'Parts 40123 #' + i, body: 'Parts arrived for unit 40123 #' + i })));
    const doc = docOf(recs);
    const relay = scriptedRelay(() => { throw new Error('down'); });
    const stats = await analyzeDoc(doc, relay);
    expect(relay.calls).toHaveLength(C.LANE_FAILS_TRIP);
    expect(stats.laneState).toBe('degraded');
    const statuses = recs.map((r) => doc.messages[r.messageKey].analysis.status).sort();
    expect(statuses).toEqual(['ai-unavailable', 'ai-unavailable', 'ai-unavailable', 'pending', 'pending']);
  });
});

describe('bounds', () => {
  it('R8.4 AI budget and attempt cap', async () => {
    const recs = [0, 1, 2, 3].map((i) => recordOf(mk({ conversationId: 'conv-bud' + i, subject: 'Parts 40123 #' + i, body: 'Parts arrived for unit 40123, repair starts Monday. #' + i })));
    const doc = docOf(recs);
    const relay = okRelay('multi20to');
    const cfgMod = require('../src/email-intel/config');
    const stats = await analyzeDoc(doc, relay, { cfg: cfgMod.normalize({ caps: { aiCalls: 2 } }) });
    expect(relay.calls).toHaveLength(2);
    expect(stats).toMatchObject({ aiCalls: 2, ok: 2, pending: 2 });
    expect(recs.filter((r) => doc.messages[r.messageKey].analysis.status === 'pending')).toHaveLength(2);
    // the next scan finishes the rest
    await analyzeDoc(doc, relay, { cfg: cfgMod.normalize({ caps: { aiCalls: 2 } }) });
    expect(recs.every((r) => doc.messages[r.messageKey].analysis.status === 'ok')).toBe(true);
    expect(C.ANALYSIS_ATTEMPTS_MAX).toBe(3);
  });

  it('NFR-9 zero AI calls when nothing new', async () => {
    const doc = docOf([recordOf(scenarios.multi20to())]);
    const relay = okRelay('multi20to');
    await analyzeDoc(doc, relay);
    const before = relay.calls.length;
    const s = await analyzeDoc(doc, relay);
    expect(relay.calls.length).toBe(before);
    expect(s).toMatchObject({ eligible: 0, aiCalls: 0 });
    const empty = await analyzeDoc(docOf([]), relay);
    expect(empty.aiCalls).toBe(0);
  });

  it('F-26 old blocks skipped-old, no AI call (unknown time only for the latest block)', async () => {
    const undated = recordOf(mk({ conversationId: 'conv-old', messageId: 'o2', subject: 'Parts 40123', body: 'Undated update for 40123 parts' }), { over: { receivedAt: null, receivedAtQuality: 'unknown' } });
    undated.ingestedAt = '2026-11-04T08:00:00.000Z';                      // sorts before the dated latest block
    const doc = docOf([
      recordOf(mk({ conversationId: 'conv-old', messageId: 'o1', subject: 'Parts 40123', body: 'Old update for 40123 parts arrived', receivedAt: '2026-10-01T10:00:00.000Z' })),
      undated,
      recordOf(mk({ conversationId: 'conv-old', messageId: 'o3', subject: 'Parts 40123', body: 'Parts arrived for unit 40123, repair starts Monday.', receivedAt: '2026-11-04T12:00:00.000Z' })),
    ]);
    const relay = okRelay('multi20to');
    await analyzeDoc(doc, relay);
    const by = Object.values(doc.messages).map((r) => [r.itemId, r.analysis.status]);
    expect(Object.fromEntries(by)).toEqual({ o1: 'skipped-old', o2: 'skipped-old', o3: 'ok' });
    expect(relay.calls).toHaveLength(1);
    expect(Object.values(doc.messages).find((r) => r.itemId === 'o1').analysis.deterministic.units[0].unit).toBe('40123');
  });

  it('skipped-cheap: no trigger means no AI call and an informational deterministic result', async () => {
    const { a, relay } = await one(mk({ to: [COWORKER, ZILA], subject: 'Lunch', body: 'Pizza on Friday.' }), 'multi20to');
    expect(a.status).toBe('skipped-cheap');
    expect(relay.calls).toHaveLength(0);
    expect(a.determinations.informationalOnly.value).toBe(true);
  });
});

describe('R7.6 deleteSuggested conservative rule matrix', () => {
  const deletable = out({ relevance: { level: 'none', reason: 'newsletter', confidence: 0.9 }, classification: { category: 'noise', intent: 'fyi', informationalOnly: true, confidence: 0.9 }, suggestDelete: { suggested: true, reason: 'newsletter', confidence: 0.9 } });
  // A 1:1 newsletter (the direct-1to1 trigger sends it to the AI; it mentions no unit and asks nothing).
  const base = () => mk({ conversationId: 'conv-del', from: { name: 'News', address: 'news@example.test' }, to: [ZILA], subject: 'Weekly newsletter', body: 'Safety tip of the week from the newsletter team, keep the yard tidy and wear your vest.' });
  async function convWith(m, o = {}) {
    const rec = recordOf(m, { over: o.over });
    const doc = docOf([rec]);
    await analyzeDoc(doc, scriptedRelay(() => o.answer || deletable));
    return { doc, recs: Object.values(doc.messages) };
  }
  it.each([
    ['plain newsletter, AI suggests, real ids: suggested', {}, true, 'ai-suggested'],
    ['AI does not suggest', { answer: out({ suggestDelete: { suggested: false, confidence: 0.9 } }) }, false, 'not-suggested'],
    ['AI suggests with invalid confidence', { answer: out({ suggestDelete: { suggested: true, reason: 'x', confidence: '0.9' } }) }, false, 'not-suggested'],
    ['AI suggests below the threshold', { answer: out({ suggestDelete: { suggested: true, reason: 'x', confidence: 0.7499 } }) }, false, 'not-suggested'],
    ['derived conversation id', { over: { convIdSource: 'derived' } }, false, 'no-conversation-id'],
    ['open action', { openActions: 1 }, false, 'open-action'],
  ])('%s', async (_n, o, expected, reason) => {
    const { recs } = await convWith(base(), o);
    expect(recs[0].analysis.status).toBe('ok');
    expect(an.conservativeDelete(recs, { openActions: o.openActions || 0 })).toEqual({ suggested: expected, reason });
  });
  it('never for fleet-relevant mail, a question to me, or several messages without message-level ids', () => {
    const okA = (extra) => ({ status: 'ok', result: { units: [], suggestDelete: { suggested: true, confidence: 0.9, confidenceValid: true } }, deterministic: { units: [] }, determinations: { replyRequirement: { value: 'none' }, decisionRequirement: { value: 'none' }, actionOwnership: { items: [] } }, ...extra });
    const r = (o = {}) => Object.assign({ convIdRaw: 'conv/1=', convIdSource: 'owa', messageIdSource: 'owa-item', analysis: okA() }, o);
    expect(an.conservativeDelete([r()], {})).toEqual({ suggested: true, reason: 'ai-suggested' });
    expect(an.conservativeDelete([r({ analysis: okA({ deterministic: { units: [{ unit: '40123', scope: 'in' }] } }) })], {}).reason).toBe('fleet-relevant');
    expect(an.conservativeDelete([r({ analysis: okA({ deterministic: { units: [{ unit: '40123', scope: 'unknown' }] } }) })], {}).reason).toBe('fleet-relevant');
    expect(an.conservativeDelete([r({ analysis: okA({ determinations: { replyRequirement: { value: 'required' }, decisionRequirement: { value: 'none' }, actionOwnership: { items: [] } } }) })], {}).reason).toBe('question-to-me');
    expect(an.conservativeDelete([r({ messageIdSource: 'derived' }), r({ messageIdSource: 'derived' })], {}).reason).toBe('multi-message-without-ids');
    expect(an.conservativeDelete([r({ analysis: { status: 'skipped-cheap' } })], {}).reason).toBe('not-analyzed');
  });
});

describe('prompt reaches the lane with the message ref', () => {
  it('the scripted lane echoes the META messageRef; a mismatched ref is an output failure', async () => {
    const { a, relay } = await one(scenarios.multi20to(), () => Object.assign(aiFixture('multi20to'), { messageRef: 'r00000000w1' }));
    expect(refOf(relay.calls[0].prompt)).toMatch(/^r[0-9a-f]{8}w1$/);
    expect(a).toMatchObject({ status: 'invalid', outputAttempts: 1, error: 'invalid-output' });
  });
});
