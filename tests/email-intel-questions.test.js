// tests/email-intel-questions.test.js — durable question state (design 5.2; R4.4, R4.8, R4.12): transitions,
// own-reply answers, duplicate merge (Jaccard >= 0.8), overdue commitments, and the bounded resolution pass.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { rec, q, T, NOW, CONV } from './fixtures/email-intel/actions.js';
const require = createRequire(import.meta.url);
const Q = require('../src/email-intel/actions/questions');

const only = (m) => Object.values(m);

describe('question ids and initial state', () => {
  it('ids are stable q_<16 hex> from conversation, origin message and question ref; partial origin starts unknown', () => {
    const r = rec({ questions: [q('pq_aaaaaaaaaaaa', 'Can you confirm pickup Friday?')] });
    const a = Q.buildQuestions([r], {}, { now: NOW });
    const b = Q.buildQuestions([r], {}, { now: NOW + 1000 });
    expect(Object.keys(a)).toEqual(Object.keys(b));
    const id = Object.keys(a)[0];
    expect(id).toMatch(/^q_[0-9a-f]{16}$/);
    expect(id).toBe(Q.questionIdOf(CONV, r.messageKey, 'pq_aaaaaaaaaaaa'));
    expect(a[id]).toMatchObject({ status: 'open', owner: 'me', askerName: 'Dealer Parts Desk', units: ['40123'], type: 'question' });
    const partial = Q.buildQuestions([rec({ bodyStatus: 'truncated', questions: [q('pq_aaaaaaaaaaaa', 'x?')] })], {}, { now: NOW });
    expect(only(partial)[0].status).toBe('unknown');
    const incomplete = Q.buildQuestions([rec({ incomplete: true, questions: [q('pq_aaaaaaaaaaaa', 'x?')] })], {}, { now: NOW });
    expect(only(incomplete)[0].status).toBe('unknown');
  });

  it('createdAt and resolution data survive a rebuild; updatedAt moves only when the status changes', () => {
    const m1 = rec({ key: 'mi_1', questions: [q('pq_1', 'Can you confirm pickup Friday?')] });
    const first = Q.buildQuestions([m1], {}, { now: NOW });
    const again = Q.buildQuestions([m1], first, { now: NOW + 60_000 });
    expect(only(again)[0].createdAt).toBe(only(first)[0].createdAt);
    expect(only(again)[0].updatedAt).toBe(only(first)[0].updatedAt);
    const m2 = rec({ key: 'mi_2', at: T(4, 16), answers: [{ pqid: 'pq_1', evidence: 'Confirmed for Friday', confidence: 0.9 }] });
    const closed = Q.buildQuestions([m1, m2], first, { now: NOW + 120_000 });
    expect(only(closed)[0].status).toBe('answered');
    expect(only(closed)[0].updatedAt).toBe(new Date(NOW + 120_000).toISOString());
  });
});

describe('R4.4 answered later', () => {
  const m1 = rec({ key: 'mi_1', questions: [q('pq_1', 'Can you confirm pickup Friday?')] });
  const later = (o) => rec(Object.assign({ key: 'mi_2', at: T(4, 16), from: { name: 'Mike Rivera', address: 'mike@example.test' } }, o));
  it.each([
    ['a validated answer >= 0.6 answers it', { answers: [{ pqid: 'pq_1', evidence: 'Confirmed for Friday', confidence: 0.6 }] }, 'answered', 'later-answer'],
    ['0.3-0.59 is probably answered', { answers: [{ pqid: 'pq_1', evidence: 'Confirmed for Friday', confidence: 0.45 }] }, 'probably-answered', 'later-answer'],
    ['below 0.3 stays open', { answers: [{ pqid: 'pq_1', evidence: 'Confirmed for Friday', confidence: 0.2 }] }, 'open', null],
    ['an answer to another question changes nothing', { answers: [{ pqid: 'pq_9', evidence: 'Confirmed', confidence: 0.9 }] }, 'open', null],
    ['my own later reply (visible block) answers it', { fromMe: true, from: { name: 'Zila Santiago', address: 'zila@example.test' }, text: 'Yes, Friday works.' }, 'answered', 'own-reply'],
    ['a withdrawal withdraws it', { answers: [{ pqid: 'pq_1', evidence: 'never mind', confidence: 0.9, withdrawn: true }] }, 'withdrawn', 'withdrawn'],
  ])('%s', (_n, o, status, basis) => {
    const s = only(Q.buildQuestions([m1, later(o)], {}, { now: NOW })).find((x) => x.pqid === 'pq_1');
    expect(s.status).toBe(status);
    expect(s.answeredBy ? s.answeredBy.basis : null).toBe(basis);
  });
  it('an earlier message never answers a later question', () => {
    const early = rec({ key: 'mi_0', at: T(4, 10), answers: [{ pqid: 'pq_1', evidence: 'x', confidence: 0.9 }] });
    expect(only(Q.buildQuestions([early, m1], {}, { now: NOW })).find((x) => x.pqid === 'pq_1').status).toBe('open');
  });
});

describe('R4.12 duplicate questions merge into the oldest one', () => {
  it('Jaccard >= 0.8, same addressee kind: merged, superseded; an answer to the duplicate closes the root', () => {
    expect(Q.jaccard('can you confirm pickup for 40123 on friday', 'can you confirm pickup for 40123 on friday please')).toBeGreaterThanOrEqual(0.8);
    const m1 = rec({ key: 'mi_1', questions: [q('pq_1', 'Can you confirm pickup for 40123 on Friday?')] });
    const m2 = rec({ key: 'mi_2', at: T(4, 16), questions: [q('pq_2', 'Can you confirm pickup for 40123 on Friday please?')] });
    const m3 = rec({ key: 'mi_3', at: T(4, 18), questions: [q('pq_3', 'What is the turbo ETA for 40456?')] });
    const s = Q.buildQuestions([m1, m2, m3], {}, { now: NOW });
    const byPq = Object.fromEntries(only(s).map((x) => [x.pqid, x]));
    expect(byPq.pq_2).toMatchObject({ status: 'superseded', mergedInto: byPq.pq_1.questionId });
    expect(byPq.pq_1).toMatchObject({ status: 'open', mergedInto: null });
    expect(byPq.pq_3.mergedInto).toBeNull();
    // different addressee kind: not merged
    const other = rec({ key: 'mi_4', at: T(4, 19), questions: [q('pq_4', 'Can you confirm pickup for 40123 on Friday?', { addressee: 'named-other' })] });
    expect(only(Q.buildQuestions([m1, other], {}, { now: NOW })).find((x) => x.pqid === 'pq_4').mergedInto).toBeNull();
    // the duplicate answered later: the root closes too
    const ans = rec({ key: 'mi_5', at: T(4, 20), answers: [{ pqid: 'pq_2', evidence: 'Friday confirmed', confidence: 0.9 }] });
    const s2 = Object.fromEntries(only(Q.buildQuestions([m1, m2, ans], {}, { now: NOW })).map((x) => [x.pqid, x]));
    expect(s2.pq_1.status).toBe('answered');
  });
});

describe('R4.8 overdue', () => {
  const promise = (o) => rec(Object.assign({ key: 'mi_c', at: T(1), commitments: [{ by: 'sender', who: null, text: 'We will update you by Monday', dueDate: '2026-11-02' }] }, o));
  it('a dated commitment by someone else is overdue after its due date with no later activity', () => {
    const [c] = Q.commitmentStates([promise()], { now: NOW });
    expect(c).toMatchObject({ overdue: true, dueDate: '2026-11-02', owner: 'vendor', by: 'sender', senderName: 'Dealer Parts Desk' });
    expect(c.commitId).toMatch(/^cm_[0-9a-f]{12}$/);
    expect(Q.commitmentStates([promise()], { now: Date.parse('2026-11-02T12:00:00') })[0].overdue).toBe(false);      // due today: not yet
    expect(Q.commitmentStates([promise(), rec({ key: 'mi_d', at: T(3) })], { now: NOW })[0].overdue).toBe(false);    // later message
    expect(Q.commitmentStates([promise()], { now: NOW, appliedAt: [T(3)] })[0].overdue).toBe(false);               // later applied fact
    expect(Q.commitmentStates([promise({ commitments: [{ by: 'sender', text: 'x', dueDate: null }] })], { now: NOW })).toEqual([]);
    expect(Q.commitmentStates([promise({ fromMe: true })], { now: NOW })).toEqual([]);                             // my own promise
  });
});

describe('resolution pass (backfill, bounded)', () => {
  // m1 (the question) was analyzed AFTER m2 (a later reply that already answers it): m2's analysis never saw the question.
  const m1 = rec({ key: 'mi_1', at: T(4, 10), analyzedAt: T(4, 19), questions: [q('pq_1', 'Can you confirm pickup Friday?')] });
  const m2 = rec({ key: 'mi_2', at: T(4, 12), analyzedAt: T(4, 13), text: 'Pickup is confirmed for Friday at 9.', from: { name: 'Mike Rivera', address: 'mike@example.test' } });

  it('needsResolution finds the question; one fenced isolated call settles it; checked questions are not asked again', async () => {
    const qs = Q.buildQuestions([m1, m2], {}, { now: NOW });
    expect(Q.needsResolution([m1, m2], qs)).toHaveLength(1);
    const ask = vi.fn(async () => ({ ok: true, text: JSON.stringify({ answers: [{ pqid: 'pq_1', message: 1, evidence: 'Pickup is confirmed for Friday', confidence: 0.85 }] }) }));
    const r = await Q.resolutionPass([m1, m2], qs, { ask, now: NOW });
    expect(r).toEqual({ called: true, answered: 1, ok: true });
    expect(ask).toHaveBeenCalledTimes(1);
    const prompt = ask.mock.calls[0][0];
    expect(prompt).toMatch(/<<<UNTRUSTED_LATER_MESSAGE_1 id=[0-9a-f]{16}>>>/);
    expect(prompt).toContain('"pqid":"pq_1"');
    const after = only(Q.buildQuestions([m1, m2], qs, { now: NOW }))[0];
    expect(after).toMatchObject({ status: 'answered', resolutionChecked: true, answeredBy: { messageKey: 'mi_2', basis: 'resolution-pass' } });
    expect(Q.needsResolution([m1, m2], Q.buildQuestions([m1, m2], qs, { now: NOW }))).toEqual([]);
    expect(await Q.resolutionPass([m1, m2], Q.buildQuestions([m1, m2], qs, { now: NOW }), { ask, now: NOW })).toMatchObject({ called: false });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('invalid output is ignored (unquoted evidence, bad id, bad confidence, secrets); a lane failure leaves it unchecked', async () => {
    const qs = Q.buildQuestions([m1, m2], {}, { now: NOW });
    const bad = { answers: [
      { pqid: 'pq_1', message: 1, evidence: 'not in the text at all', confidence: 0.9 },
      { pqid: 'pq_9', message: 1, evidence: 'Pickup is confirmed for Friday', confidence: 0.9 },
      { pqid: 'pq_1', message: 1, evidence: 'Pickup is confirmed for Friday', confidence: 1.5 },
      { pqid: 'pq_1', message: 4, evidence: 'Pickup is confirmed for Friday', confidence: 0.9 },
    ] };
    expect(await Q.resolutionPass([m1, m2], qs, { ask: async () => ({ ok: true, text: JSON.stringify(bad) }), now: NOW })).toEqual({ called: true, answered: 0, ok: true });
    expect(only(Q.buildQuestions([m1, m2], qs, { now: NOW }))[0].status).toBe('open');
    const qs2 = Q.buildQuestions([m1, m2], {}, { now: NOW });
    expect(await Q.resolutionPass([m1, m2], qs2, { ask: async () => ({ ok: false, kind: 'lane', error: 'timeout' }), now: NOW })).toEqual({ called: true, answered: 0, ok: false });
    expect(Q.needsResolution([m1, m2], qs2)).toHaveLength(1);
    // nothing to settle: no call
    const fresh = rec({ key: 'mi_3', at: T(4, 10), analyzedAt: T(4, 10), questions: [q('pq_1', 'x?')] });
    const ask = vi.fn();
    expect(await Q.resolutionPass([fresh, rec({ key: 'mi_4', at: T(4, 12), analyzedAt: T(4, 13) })], Q.buildQuestions([fresh], {}, { now: NOW }), { ask, now: NOW })).toMatchObject({ called: false });
    expect(ask).not.toHaveBeenCalled();
  });
});
