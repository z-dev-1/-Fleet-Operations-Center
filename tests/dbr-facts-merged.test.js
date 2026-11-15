// tests/dbr-facts-merged.test.js — AC18 (relay-extract D2-D5 in the merged DBR pipeline):
// verified-facts evidence segment, strict typed gate, self-questioning review prompt with the
// QUESTIONS fit rule (cases A-D), tolerated QA, and flag-off prompts equal to the 1eabe04 goldens.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { TODAY, row39582 } from './fixtures/extract/fact-39582.js';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const AI = require('../src/dbr/fleet-dbr-ai');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');
const GI = require('./fixtures/extract/dbr-golden-input');
const GOLD = require('./fixtures/extract/dbr-golden-prompts');

const N = { yn: 'N', details: [] };
const J = (o) => JSON.stringify(o);
const pairOf = (rows) => { const built = F.buildFleetDbr(rows, { today: TODAY }); return { built, row: built.rows.find((r) => r.key === 'TST1|TSCA') }; };
const idsIn = (p) => /DOWN UNITS \(\d+\): ([^\n]*)/.exec(p)[1].split(', ');
afterEach(() => vi.restoreAllMocks());

describe('AC18 single mode, 39582 with facts', () => {
  const r39 = row39582({ domicileSite: 'TST1', operator: 'TSCA' });
  const other = makeUnit({ equipmentId: 'B61001', vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor', repairTimeline: '11/10 - TA Rochester: no diesel tech available, ETC 11/14' });
  const rows = [r39, other];
  const { built, row } = pairOf(rows);
  const draftAns = {
    barriers: { vendor1p: N, oem: N, estimate: N, partner: N, common: N,
      parts: { yn: 'Y', details: [{ units: ['39582'], text: 'Part #3010287243 on backorder at M & K Truck Centers.' }, { units: ['B61001'], text: 'TA Rochester: no diesel tech available, waiting.' }] } },
    etc: [{ unit: '39582', state: 'today', date: '11/11', why: 'Dealer ETC 10/26 slipped to 11/11' }, { unit: 'B61001', state: 'future', date: '11/14', why: '' }],
    fasActions: [{ unit: '39582', text: 'Waiting on install; Uptime update 11/10: ETR 11/11; next: confirm repair complete.' },
      { unit: 'B61001', text: 'TA update 11/10: no diesel tech; next: call TA.' }],
    support: 'None',
  };
  const reviewAns = 'QA:\nQ-GEN-1 | candidates: none / $9,999 labor | best: labor quoted $9,999\nQ-SELF-1: Is the order labelled? | candidates: yes | best: yes\nFINAL:\n'
    + J(Object.assign({}, draftAns, { barriers: Object.assign({}, draftAns.barriers, { parts: { yn: 'Y', details: [{ units: ['39582'], text: 'Harness Part #85152780 (Order #3010287243) arrived 11/4; install pending.' }] } }) }));
  const run = async () => {
    const prompts = [];
    const ask = vi.fn(async (p) => { prompts.push(p); return prompts.length === 1 ? J(draftAns) : reviewAns; });
    const r = await AI.draftRow({ row, unitRows: rows, built, ask, enrich: {}, fasNames: [], fleetIds: [], today: TODAY });
    return { r, prompts, ask };
  };

  it('the draft prompt carries the verified facts segment inside EVIDENCE', async () => {
    const { prompts } = await run();
    const ev = prompts[0].slice(prompts[0].indexOf(AI.EVIDENCE_OPEN), prompts[0].indexOf('=== END EVIDENCE ==='));
    expect(ev).toContain('verified facts (extracted):');
    expect(ev).toMatch(/F2 parts: harness Part #85152780 .*Order #3010287243/);
    expect(ev).toContain('repair ETR 11/11/2026');
  });
  it('strict drop: misclassified-ref and parts-date-as-etc; neither string reaches a cell', async () => {
    const { r } = await run();
    expect(r.ok).toBe(true);
    // The draft's drops are in the merged meta (the review FINAL rewrote the parts entry).
    const { prompts } = await run();
    expect(prompts[1]).toContain('39582 \u00b7 partsDetails \u00b7 misclassified-ref');
    expect(prompts[1]).toContain('39582 \u00b7 etcToday \u00b7 parts-date-as-etc');
    expect(r.dropReasons['misclassified-ref']).toBeGreaterThanOrEqual(1);
    expect(r.dropReasons['parts-date-as-etc']).toBeGreaterThanOrEqual(1);
    expect(r.cells.partsDetails).not.toContain('3010287243 on backorder');
    expect(r.cells.missedEtc).not.toContain('10/26');
    expect(r.cells.etcToday).toBe('1');
  });
  it('self-review prompt: checklist item 8 with Q-SELF + brainstorm, QUESTIONS block, fits; QA tolerated', async () => {
    const { r, prompts, ask } = await run();
    expect(ask).toHaveBeenCalledTimes(2);
    const p = prompts[1];
    expect(p).toContain('REVIEW CHECKLIST');
    expect(p).toMatch(/\n8\. First add up to 5 questions of your own \(Q-SELF-1\.\.Q-SELF-5\)/);
    expect(p).toContain('brainstorm 2-3 candidate answers');
    expect(p).toContain('\nQUESTIONS:\n');
    expect(p).toContain('39582 Q-PART-ORDER:');
    expect(p).toContain('39582 Q-ETC-KIND:');
    expect(p).toContain('You may start with a QA: block');
    expect(AI.assertFits(p).fits).toBe(true);
    expect(r.ok).toBe(true);
    for (const v of Object.values(r.cells)) expect(v).not.toContain('9,999');
    expect(r.cells.partsDetails).toContain('Part #85152780');
    expect(r.log.find((e) => e.kind === 'review').reviewQuestionsTrimmed).toBeNull();
  });
  it('evidenceHash changes with _factsSig', () => {
    expect(F.evidenceHash([r39])).not.toBe(F.evidenceHash([Object.assign({}, r39, { _factsSig: 'other' })]));
  });
});

describe('AC18 flag off: prompts equal the 1eabe04 goldens (D7 text substituted)', () => {
  it('draft + review prompts byte-identical apart from the two D7 strings; dropReasons equal', async () => {
    const inp = GI.goldenInput(F, makeUnit);
    const prompts = [];
    const r = await AI.draftRow(Object.assign({}, inp.args, { ask: async (p) => { prompts.push(p); return J(GI.goldenAnswer(inp.ids)); }, now: () => 0 }));
    const d7 = (s) => s.split(GI.D7_OLD.fasRule).join(AI.FAS_RULE).split(GI.D7_OLD.b61004).join(AI.ROW_EXAMPLE.fasActions[2].text);
    expect(GOLD.draft).toContain(GI.D7_OLD.fasRule);
    expect(prompts[0]).toBe(d7(GOLD.draft));
    expect(prompts[1]).toBe(d7(GOLD.review));
    expect(prompts[1]).not.toContain('QUESTIONS:');
    expect(prompts[1]).not.toContain('Q-SELF');
    expect(r.dropReasons).toEqual(GOLD.dropReasons);
    expect(r.calls).toBe(GOLD.calls);
  });
});

describe('AC18 24-unit map/reduce fit (cases A-D)', () => {
  const base = row39582({ domicileSite: 'TST1', operator: 'TSCA' });
  const rows = Array.from({ length: 24 }, (_, i) => Object.assign({}, base, { equipmentId: 'M' + String(30001 + i) }));
  const { built, row } = pairOf(rows);
  const mapAns = (ids) => ({ units: ids.map((u) => ({ unit: u, component: 'Harness', barriers: { parts: { hit: true, fact: 'Harness Part #85152780 arrived 11/4' } },
    etc: { state: 'today', date: '11/11', why: '' }, fasAction: { text: 'Uptime update 11/10: ETR 11/11; next: confirm repair complete' }, support: [] })) });
  const reduceAns = (ids, det) => ({ barriers: { vendor1p: N, oem: N, estimate: N, partner: N, common: N,
    parts: { yn: 'Y', details: ids.slice(0, 16).map((u) => ({ units: [u], text: det })) } }, support: 'None' });
  const drive = async (det, tweak) => {
    const real = AI.buildReviewPrompt;
    const built3 = [];
    vi.spyOn(AI, 'buildReviewPrompt').mockImplementation((mode, ctx, cur, opts) => {
      const rp = real(mode, ctx, cur, opts);
      const q = opts && opts.questions ? opts.questions : '';
      // Call order at the review site: rp0 (no questions), rp1 (full), then rp2 (short) if needed.
      const kind = !q ? 'rp0' : (built3.some((b) => b.kind === 'rp1') ? 'rp2' : 'rp1');
      const out = tweak ? tweak(kind, rp) : rp;
      built3.push({ kind, rp: out, q });
      return out;
    });
    const prompts = [];
    const ask = vi.fn(async (p) => {
      prompts.push(p);
      const ids = idsIn(p);
      if (p.includes('MAP BATCH')) return J(mapAns(ids));
      return J(reduceAns(ids, det));
    });
    const r = await AI.draftRow({ row, unitRows: rows, built, ask, enrich: {}, fasNames: [], fleetIds: [], today: TODAY });
    const review = r.log ? r.log.find((e) => e.kind === 'review') : null;
    return { r, prompts, built3, review, sent: prompts.filter((p) => p.includes('REVIEW CHECKLIST')) };
  };

  it('Case A: short draft -> rp1 chosen, QUESTIONS <= 1500 chars, Q-SELF, trimmed null', async () => {
    const { r, built3, review, sent } = await drive('Harness arrived 11/4.');
    expect(r.mode).toBe('mapreduce');
    const rp0 = built3.find((b) => b.kind === 'rp0').rp;
    const rp1 = built3.find((b) => b.kind === 'rp1');
    expect(rp1.rp.embed.D).toBe(rp0.embed.D);
    expect(rp1.q.length).toBeLessThanOrEqual(1500);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(rp1.rp.prompt);
    expect(sent[0]).toContain('QUESTIONS:');
    expect(sent[0]).toContain('Q-SELF');
    expect(review.reviewQuestionsTrimmed).toBeNull();
    expect(review.embedChars).toBe(rp1.rp.embed.chars);
    expect(review.embedD).toBe(rp1.rp.embed.D);
  });
  it('Case B: the full block costs embed entries, the short one does not -> rp2, trimmed short', async () => {
    const { built3, review, sent } = await drive('Harness arrived 11/4.', (k, rp) => (k === 'rp1' ? Object.assign({}, rp, { embed: Object.assign({}, rp.embed, { D: rp.embed.D - 1 }) }) : rp));
    const rp2 = built3.find((b) => b.kind === 'rp2');
    expect(sent[0]).toBe(rp2.rp.prompt);
    expect(rp2.q).toMatch(/Q-ETC-KIND/);
    expect(rp2.q).toMatch(/Q-GEN-1/);
    expect(rp2.q.split('\n').every((l) => /^\S+ Q-ETC-KIND:|^Q-GEN-1:/.test(l))).toBe(true);
    expect(review.reviewQuestionsTrimmed).toBe('short');
  });
  it('Case C: both blocks cost embed entries -> rp0 byte-for-byte (item 8 still there), trimmed none', async () => {
    const { built3, review, sent } = await drive('Harness arrived 11/4.', (k, rp) => (k !== 'rp0' ? Object.assign({}, rp, { embed: Object.assign({}, rp.embed, { D: rp.embed.D - 1 }) }) : rp));
    const rp0 = built3.find((b) => b.kind === 'rp0').rp;
    expect(sent[0]).toBe(rp0.prompt);
    expect(sent[0]).not.toContain('QUESTIONS:');
    expect(sent[0]).toMatch(/\n8\. First add up to 5 questions of your own \(Q-SELF/);
    expect(review.reviewQuestionsTrimmed).toBe('none');
  });
  it('Case D: rp0 too large -> reviewSkipped too-large, no review call', async () => {
    const { r, sent } = await drive('Harness arrived 11/4.', (k, rp) => (k === 'rp0' ? { tooLarge: true, base: 99999 } : rp));
    expect(sent).toHaveLength(0);
    expect(r.reviewSkipped).toBe('too-large');
  });
});
