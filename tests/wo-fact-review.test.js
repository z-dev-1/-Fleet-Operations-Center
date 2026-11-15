// tests/wo-fact-review.test.js — AC16 (self-review loop) and AC43 (review parse bounds),
// relay-extract §14.4-§14.5. Mocked ask only; the gate is the shared fleet-dbr-gate.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { TODAY, row39582, sourceText } from './fixtures/extract/fact-39582.js';
import * as BP from './fixtures/extract/b62281-paccar.js';
const require = createRequire(import.meta.url);
const W = require('../src/repair-intel/wo-facts');
const O = require('../src/repair-intel/wo-fact-output');
const X = require('../src/repair-intel/wo-extract');

const row = row39582();
const fsx = W.buildFactSet(row, { today: TODAY });
const sheet = O.factSheet(fsx, { purpose: 'timeline', row });
const ctx = O.factContext(fsx, { promptText: sourceText, sheetText: sheet.text, rowDates: sheet.rowDates, today: TODAY });

// Timeline-shaped consumer: FINAL = timeline lines; gate = gateTimeline; merge = replace when kept.
const consumer = () => ({
  sheet, ctx, today: TODAY,
  buildPrompt: (s, cur, removals, asked) => 'REVIEW\n' + s.text + '\nDRAFT:\n' + cur.join('\n') + '\n' + O.buildReviewSection(asked) + '\n' + O.REVIEW_FORMAT,
  parse: (final) => (final.trim() ? final : null),
  gateEntries: (final, c) => O.gateTimeline(final, c, { today: TODAY }),
  merge: (cur, gf) => (gf.kept.length ? gf.kept : cur),
});
const qaLine = (id, best) => id + ' | candidates: a / b | best: ' + best;
const answer = (ids, final, extra = []) => 'QA:\n' + ids.map((id) => qaLine(id, 'covered by F1')).concat(extra).join('\n') + '\nFINAL:\n' + final;

describe('AC16 self-review', () => {
  it('planted fix: draft order # dropped, review fixes it, a new $9,999 line is dropped from the FINAL', async () => {
    const draft = O.gateTimeline('10/14 - Harness on backorder, revised ship 10/26.\n10/28 - Dealer placed Order #3010289999.', ctx, { today: TODAY });
    expect(draft.dropped.map((d) => d.code)).toEqual(['unknown-ref']);
    const qs = O.buildQuestions(fsx, { consumer: 'timeline', today: TODAY, removals: draft.dropped, row });
    const ask = vi.fn(async () => answer(qs.map((q) => q.id),
      '10/14 - Harness on backorder, revised ship 10/26.\n10/28 - Dealer placed Order #3010287243.\n11/04 - Dealer quoted $9,999 for labor.'));
    const r = await O.reviewLoop(Object.assign(consumer(), { ask, draft: draft.kept, removals: draft.dropped, questions: qs, rounds: 1 }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(r.cur).toEqual(['10/14 - Harness on backorder, revised ship 10/26.', '10/28 - Dealer placed Order #3010287243.']);
    expect(r.cur.join('\n')).not.toContain('9,999');
  });

  it('call counts: rounds 1 -> 1 review call (2 with the draft) even with nothing to fix; 0 -> none; 2 -> at most 2', async () => {
    const clean = ['10/14 - Harness on backorder, revised ship 10/26.'];
    const okAsk = vi.fn(async (p) => answer([...p.matchAll(/^(Q-[A-Z0-9-]+):/gm)].map((m) => m[1]), clean[0]));
    let r = await O.reviewLoop(Object.assign(consumer(), { ask: okAsk, draft: clean, removals: [], questions: [], rounds: 1 }));
    expect(okAsk).toHaveBeenCalledTimes(1);
    expect(r.rounds).toBe(1);
    expect(r.reviewSkipped).toBeUndefined();
    const none = vi.fn();
    r = await O.reviewLoop(Object.assign(consumer(), { ask: none, draft: clean, rounds: 0 }));
    expect(none).not.toHaveBeenCalled();
    expect(r.reviewSkipped).toBe('rounds-0');
    r = await O.reviewLoop(Object.assign(consumer(), { ask: okAsk, draft: clean, questions: [], rounds: 2 }));
    expect(okAsk).toHaveBeenCalledTimes(2);           // converged after round 1: no third call
    const dirty = vi.fn(async () => answer([], clean[0] + '\n11/04 - Part #85152799 arrived.'));
    r = await O.reviewLoop(Object.assign(consumer(), { ask: dirty, draft: clean, questions: [], rounds: 2 }));
    expect(dirty).toHaveBeenCalledTimes(2);           // round 1 left a drop -> round 2
    expect(r.rounds).toBe(2);
  });

  it('Q-SELF-1..5 parsed (6th ignored); an invented token in a best is counted in qaDrops, never rendered', async () => {
    const self = [1, 2, 3, 4, 5, 6].map((i) => 'Q-SELF-' + i + ': Is item ' + i + ' right? | candidates: yes / no | best: yes ' + (i === 2 ? 'Part #85152799' : 'F1'));
    const ask = vi.fn(async () => answer(['Q-GEN-1'], '10/14 - Harness on backorder, revised ship 10/26.', self));
    const r = await O.reviewLoop(Object.assign(consumer(), { ask, draft: ['10/14 - Harness on backorder, revised ship 10/26.'], questions: [], rounds: 1 }));
    expect(r.selfQuestions).toBe(5);
    expect(r.qa.qaDrops).toBe(1);
    expect(r.cur.join('\n')).not.toContain('85152799');
  });

  it('coverage: every asked id is answered or listed unanswered', async () => {
    const qs = O.buildQuestions(fsx, { consumer: 'timeline', today: TODAY, row });
    const half = qs.slice(0, 2).map((q) => q.id);
    const ask = vi.fn(async () => answer(half, '10/14 - Harness on backorder, revised ship 10/26.'));
    const r = await O.reviewLoop(Object.assign(consumer(), { ask, draft: ['10/14 - x'], questions: qs, rounds: 1 }));
    const all = new Set(r.qa.answered.concat(r.qa.unanswered));
    for (const q of qs) expect(all.has(q.id)).toBe(true);
    expect(r.qa.answered).toEqual(half);
  });

  it('skips are only rounds-0 | deadline | budget | ai-failed | ai-invalid', async () => {
    const base = Object.assign(consumer(), { draft: ['10/14 - x'], questions: [], rounds: 1 });
    const seen = [];
    seen.push((await O.reviewLoop(Object.assign({}, base, { ask: vi.fn(), rounds: 0 }))).reviewSkipped);
    seen.push((await O.reviewLoop(Object.assign({}, base, { ask: vi.fn(), deadline: 1000, minMs: 500, now: () => 900 }))).reviewSkipped);
    const budget = { left: 0 };
    seen.push((await O.reviewLoop(Object.assign({}, base, { ask: vi.fn(), budget }))).reviewSkipped);
    seen.push((await O.reviewLoop(Object.assign({}, base, { ask: async () => { throw new Error('x'); } }))).reviewSkipped);
    seen.push((await O.reviewLoop(Object.assign({}, base, { ask: async () => 'QA:\nno final here' }))).reviewSkipped);
    expect(seen).toEqual(['rounds-0', 'deadline', 'budget', 'ai-failed', 'ai-invalid']);
    for (const s of seen) expect(O.REVIEW_SKIPS).toContain(s);
    const b = { left: 1 };
    await O.reviewLoop(Object.assign({}, base, { ask: async () => answer([], '10/14 - x'), budget: b }));
    expect(b.left).toBe(0);
  });
});

describe('questions (§14.4)', () => {
  it('39582 yields Q-ETC-KIND, two Q-ETC-MISS, Q-PART-ORDER, Q-PM, Q-FAS (dbr), Q-GEN-1; <= 12', () => {
    const ids = O.buildQuestions(fsx, { consumer: 'dbr', today: TODAY, row }).map((q) => q.id);
    for (const id of ['Q-ETC-KIND', 'Q-ETC-MISS-1', 'Q-ETC-MISS-2', 'Q-PART-ORDER', 'Q-PM', 'Q-FAS', 'Q-GEN-1']) expect(ids).toContain(id);
    expect(ids.length).toBeLessThanOrEqual(12);
    expect(ids.indexOf('Q-PM')).toBeGreaterThan(ids.indexOf('Q-CALLS'));
    expect(O.buildQuestions(fsx, { consumer: 'timeline', today: TODAY, row }).map((q) => q.id)).not.toContain('Q-FAS');
  });
  it('B62281 yields Q-CONFLICT-warranty', () => {
    const rf = X.extractRelay(BP.relayB62281, { now: Date.parse('2026-11-11T15:00:00Z') });
    const of = X.extractDecisivNotes(BP.notesB62281, { estimateId: '21520684', estimateDetail: BP.estimateDetailB62281, now: Date.parse('2026-11-11T15:00:00Z') });
    const f = W.buildFactSet({ relayFacts: rf, offsiteFacts: of }, { today: TODAY });
    expect(O.buildQuestions(f, { consumer: 'dbr', today: TODAY }).map((q) => q.id)).toContain('Q-CONFLICT-warranty');
  });
  it('the cap keeps Q-GEN-1 and trims the lowest-priority questions first', () => {
    const removals = Array.from({ length: 3 }, (_, i) => ({ text: 'line ' + i, code: 'unknown-ref' }));
    const qs = O.buildQuestions(fsx, { consumer: 'dbr', today: TODAY, row, removals, names: ['Bob'] });
    expect(qs).toHaveLength(12);
    expect(qs[qs.length - 1].id).toBe('Q-GEN-1');
    expect(qs[0].id).toBe('Q-ETC-KIND');
  });
});

describe('AC43 review parse bounds', () => {
  it('12 code items + 5 Q-SELF items with ~250-char bests all parse; best cut at 300; answered from the uncapped text', () => {
    const long = 'x'.repeat(250);
    const ids = Array.from({ length: 12 }, (_, i) => 'Q-C-' + (i + 1)).concat([1, 2, 3, 4, 5].map((i) => 'Q-SELF-' + i));
    const raw = 'QA:\n' + ids.map((id) => id + ' | candidates: a / b | best: ' + long).join('\n') + '\nFINAL:\n{"ok":1}';
    expect(raw.length).toBeGreaterThan(4000);
    const p = O.parseReview(raw);
    expect(p.ok).toBe(true);
    expect(p.qa).toHaveLength(17);
    for (const id of ids) expect(p.answered.has(id)).toBe(true);
    const huge = 'QA:\n' + ids.map((id) => id + ' | candidates: a | best: ' + 'y'.repeat(390)).join('\n') + '\nFINAL:\nok';
    const h = O.parseReview(huge);
    expect(h.qa.length).toBeLessThan(17);                  // only the first 6,000 chars are itemized
    for (const id of ids) expect(h.answered.has(id)).toBe(true);
    for (const it of h.qa) expect(it.best.length).toBeLessThanOrEqual(300);
  });
  it('missing FINAL or empty FINAL -> ai-invalid', () => {
    expect(O.parseReview('QA:\nQ-GEN-1 | candidates: a | best: b')).toEqual({ ok: false, code: 'ai-invalid' });
    expect(O.parseReview('FINAL:\n   ')).toEqual({ ok: false, code: 'ai-invalid' });
  });
});
