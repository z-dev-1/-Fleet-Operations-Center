// Fleet DBR AI drafting (src/dbr/fleet-dbr-ai.js): contracts and their outBudget numbers, the
// R-M1 overhead matrix on the real strings, prompt ceilings, single / map / reduce / review
// orchestration with the envelope gate, deadlines, map retry, review embed (AC-M1), fallback
// codes, the back-compat result fields and the per-call log. Fake `ask` only - no relay.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const G = require('../src/dbr/fleet-dbr-gate');
const AI = require('../src/dbr/fleet-dbr-ai');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-12';
const KEY = 'TST1|TSCA';
const SRC = () => ({ fas: [{ date: '11/10', quote: 'called TA re tech callout' }] });
const N = () => ({ yn: 'N', details: [] });
const J = (o) => JSON.stringify(o);

function filler(chars) {
  const out = [];
  let len = 0;
  for (let k = 0; len < chars; k++) {
    const l = '10/' + (1 + (k % 28)) + ' - TA Rochester status check ' + k + ': unit in bay, waiting on diagnosis update';
    out.push(l);
    len += l.length + 1;
  }
  return out.join('\n');
}
// n down units in one pair. opts: { idOf, tlChars, extra:{[id]:fields}, enrich:{[id]:rec}, fleetIds }
function pair(n, opts = {}) {
  const idOf = opts.idOf || ((i) => 'B6' + String(1001 + i));
  const rows = [];
  const enrich = {};
  for (let i = 0; i < n; i++) {
    const id = idOf(i);
    const tl = (opts.tlChars ? filler(opts.tlChars) + '\n' : '') + '11/09 - TA Rochester: no diesel tech available, ETC 11/14';
    rows.push(makeUnit(Object.assign({ equipmentId: id, vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor', repairTimeline: tl }, (opts.extra || {})[id])));
    enrich[id] = (opts.enrich || {})[id] || { manualEntries: ['11/10 - called TA re tech callout'] };
  }
  const built = F.buildFleetDbr(rows, { today: TODAY });
  const row = built.rows.find((r) => r.key === KEY);
  const args = { row, unitRows: rows, built, enrich, fasNames: ['Z Santiago'], fasAlias: '', fleetIds: opts.fleetIds || [], today: TODAY };
  const ctx = AI.draftContext(args);
  return { args, ctx, ids: ctx.ids, rows, row };
}

const fasE = (u) => ({ unit: u, text: '11/10 called TA re tech callout; next: confirm tech on site', src: SRC() });
const etcE = (u) => ({ unit: u, state: 'future', date: '11/14', why: '' });
function rowAnswer(ids, over = {}) {
  return Object.assign({
    barriers: {
      vendor1p: { yn: 'Y', details: [{ units: [ids[0]], text: 'TA Rochester: no diesel tech available, ETC 11/14.' }] },
      oem: N(), estimate: N(), partner: N(), parts: N(), common: N(),
    },
    etc: ids.map(etcE), fasActions: ids.map(fasE), support: 'None',
  }, over);
}
function mapAnswer(ids) {
  return {
    units: ids.map((u) => ({
      unit: u, component: 'Engine', barriers: { vendor1p: { hit: true, fact: 'TA Rochester: no diesel tech available' } },
      etc: { state: 'future', date: '11/14', why: '' }, fasAction: { text: '11/10 called TA re tech callout; next: confirm tech on site', src: SRC() }, support: [],
    })),
  };
}
function reduceAnswer(ids) {
  return {
    barriers: { vendor1p: { yn: 'Y', details: [{ units: [ids[0]], text: 'TA Rochester: no diesel tech available for the unit.' }] }, oem: N(), estimate: N(), partner: N(), parts: N(), common: N() },
    support: 'None',
  };
}
function kindOf(p) {
  if (p.includes('REVIEW CHECKLIST')) return p.includes(AI.FACTS_OPEN) ? 'review-mr' : 'review';
  if (p.includes('MAP BATCH')) return 'map';
  if (p.includes('REDUCE CONTRACT')) return 'reduce';
  return 'single';
}
const idsIn = (p) => /DOWN UNITS \(\d+\): ([^\n]*)/.exec(p)[1].split(', ');
// handlers: { single, map, reduce, review, 'review-mr' } (ids, prompt, n) -> answer object | string | throws
function smartAsk(h = {}) {
  const seen = { prompts: [], kinds: [], opts: [], count: {} };
  const fn = vi.fn(async (p, o) => {
    const kind = kindOf(p);
    seen.prompts.push(p);
    seen.kinds.push(kind);
    seen.opts.push(o);
    seen.count[kind] = (seen.count[kind] || 0) + 1;
    const ids = idsIn(p);
    const def = { single: rowAnswer, review: rowAnswer, map: mapAnswer, reduce: reduceAnswer, 'review-mr': reduceAnswer }[kind];
    const ans = (h[kind] || def)(ids, p, seen.count[kind]);
    return typeof ans === 'string' ? ans : J(ans);
  });
  fn.seen = seen;
  return fn;
}
const fasLines = (r) => r.cells.fasActions.split('\n');

describe('constants and contracts', () => {
  it('exports the budget constants', () => {
    expect([AI.CALL_PROMPT_MAX, AI.OUTPUT_TARGET_CHARS, AI.OVERHEAD_MAX, AI.LISTS_MAX, AI.DRAFT_EMBED_MAX]).toEqual([56000, 16000, 10000, 2000, 11200]);
    expect([AI.CALL_TIMEOUT_MS, AI.MIN_CALL_MS, AI.REVIEW_MIN_MS, AI.DRAFT_REVIEW_ROUNDS]).toEqual([230000, 125000, 125000, 1]);
  });

  it('R-M2 contract sentence is in every contract; COLUMN GUIDANCE quotes the row-3 notes', () => {
    const s = "Only FAS Actions entries end with a `next:` clause, written as the step still to take (e.g. 'next: call TA'), never a past action. Details, ETC why, Support and map facts state facts only: no `next:`, no future or relative dates.";
    for (const c of [AI.OUTPUT_CONTRACT, AI.MAP_CONTRACT, AI.REDUCE_CONTRACT]) expect(c).toContain(s);
    expect(AI.COLUMN_GUIDANCE).toContain('What have you, the FAS, done (add dates with outcome) to get units back to A/H. FAS actions may not be MCS-owned actions.');
    expect(AI.COLUMN_GUIDANCE).toContain('Which part(s)? Add part SIM link. What have you done to help source the part(s)?');
    expect(AI.COLUMN_GUIDANCE).toContain('(whole number only)');
  });

  it('AC31: contract text states the outBudget numbers (12-char IDs)', () => {
    const id12 = (i) => 'B6' + String(1000000000 + i);
    const p16 = pair(16, { idOf: id12 });
    const t = AI.contractText('single', p16.ctx);
    for (const s of ['FAS text ≤ 246', 'each FAS entry (text + src) ≤ 432', 'FAS Actions total ≤ 6,920', 'Details entry ≤ 300',
      'at most 16 Details entries', 'Details total (src included) ≤ 4,000', 'ETC why ≤ 150', 'all whys ≤ 1,600',
      'at most 8 Support asks, each ≤ 160', '`src.fas` at most 2 items, each `quote` 8–40 chars', 'no `src` in ETC why, map facts or Support',
      'whole JSON, envelopes included, under 16,000 characters']) expect(t).toContain(s);
    expect(AI.contractText('single', pair(14, { idOf: id12 }).ctx)).toContain('FAS text ≤ 280');
    const p24 = pair(24, { idOf: id12 });
    const m = AI.contractText('map', p24.ctx, { ids: p24.ids });
    for (const s of ['fasAction ≤ 150', 'fact ≤ 40', 'facts total ≤ 2,056', 'the total wins', 'why ≤ 120', 'whys total ≤ 1,800', 'at most 4 support asks per batch']) expect(m).toContain(s);
  });

  it('R-M1: overhead(kind, n) <= OVERHEAD_MAX on the real strings (single/map/reduce/review/review-mr x n x idLen 12 / 15)', () => {
    for (const [n, idLen] of [1, 14, 16, 24, 96].flatMap((x) => [[x, 12], [x, 15]])) {
      const p = pair(n, { idOf: (i) => 'B6' + String(1000000000 + i).padStart(idLen - 2, '0') });
      expect(p.ctx.gate.limits.idLen).toBe(idLen);
      for (const u of p.ctx.row.units) u.barriers = G.BARRIER_IDS.slice();
      for (const b of G.BARRIERS) p.ctx.row.cells[b.ynCol] = 'Y';
      const kinds = n <= 16 ? ['single', 'review', 'map', 'reduce', 'review-mr'] : ['map', 'reduce', 'review-mr'];
      for (const kind of kinds) {
        const o = kind === 'map' ? { ids: p.ids.slice(0, Math.min(n, 24)) } : (kind === 'review-mr' ? { g: Math.min(16, n), hits: 6 * n } : (kind === 'reduce' ? { hits: 6 * n } : {}));
        const s = AI.overhead(kind, p.ctx, o);
        expect(s.length, kind + ' n=' + n + ' idLen=' + idLen).toBeLessThanOrEqual(AI.OVERHEAD_MAX);
        expect(s).toContain('COLUMN GUIDANCE');
        expect(s).toContain('VERIFIED COUNTS (exact — do not recount)');
        expect(s).toContain('RULE HINTS');
      }
    }
  });

  it('assertFits never slices', () => {
    expect(AI.assertFits('x'.repeat(56000))).toEqual({ fits: true, overflow: 0 });
    expect(AI.assertFits('x'.repeat(56001))).toEqual({ fits: false, overflow: 1 });
  });
});

describe('single mode', () => {
  it('AC1: 14-unit pair with a full answer -> exactly 14 FAS lines in builder order; draft + review = 2 calls', async () => {
    const p = pair(14);
    const ask = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('single');
    expect(typeof r.demand).toBe('number');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(r.calls).toBe(2);
    expect(ask.seen.kinds).toEqual(['single', 'review']);
    const lines = fasLines(r);
    expect(lines).toHaveLength(14);
    lines.forEach((l, i) => expect(l).toBe('• ' + p.ids[i] + ': 11/10 called TA re tech callout; next: confirm tech on site'));
    expect(r.flags.fasActions).toBeUndefined();
    expect(Object.keys(r.cells).sort()).toEqual([...F.AI_CELL_IDS].sort());
    // back-compat for the pre-FEAT-004 IPC
    expect(r.fasActions).toBe(r.cells.fasActions);
    expect(r.support).toBe('None');
    expect(r.dropped).toBe(0);
    for (const pr of ask.seen.prompts) expect(pr.length).toBeLessThanOrEqual(AI.CALL_PROMPT_MAX);
    for (const id of p.ids) expect(ask.seen.prompts[0]).toContain('[' + id + ']');
    expect(ask.seen.prompts[0]).toContain(AI.EVIDENCE_OPEN);
  });

  it('AC2: an answer that omits 3 of 14 units still yields 14 lines; the 3 are code ⚠ lines and flagged', async () => {
    const p = pair(14);
    const omit = [p.ids[2], p.ids[5], p.ids[9]];
    const ask = smartAsk({ single: (ids) => rowAnswer(ids, { fasActions: ids.filter((u) => !omit.includes(u)).map(fasE) }) });
    const r = await AI.draftRow(Object.assign({ ask, reviewRounds: 0 }, p.args));
    const lines = fasLines(r);
    expect(lines).toHaveLength(14);
    lines.forEach((l, i) => expect(l.startsWith('• ' + p.ids[i] + ': ' + (omit.includes(p.ids[i]) ? '⚠' : '11/10'))).toBe(true));
    expect(r.flags.fasActions).toBe('review');
    expect(r.coverageFilled).toEqual(omit);
  });

  it('AC3: Y/N reflects the AI evidence judgment (Parts Y with Details, OEM N blank), source ai', async () => {
    const p = pair(3, { extra: { B61002: { repairTimeline: '11/08 - Parts ETA 11/14 turbo' } } });
    const ask = smartAsk({ single: (ids) => rowAnswer(ids, { barriers: Object.assign(rowAnswer(ids).barriers, { parts: { yn: 'Y', details: [{ units: ['B61002'], text: 'Turbo back-ordered, parts ETA 11/14' }] }, oem: N() }) }) });
    const r = await AI.draftRow(Object.assign({ ask, reviewRounds: 0 }, p.args));
    expect(r.cells.partsYN).toBe('Y');
    expect(r.cells.partsDetails).toBe('• B61002: Turbo back-ordered, parts ETA 11/14');
    expect(r.cells.oemYN).toBe('N');
    expect(r.cells.oemDetails).toBe('');
    expect(r.sources.partsYN).toBe('ai');
    expect(r.sources.oemYN).toBe('ai');
  });

  it('AC4: planted unit ID, foreign ID, $, ETC date, RO, URL, past/future dates are dropped from Details; siblings survive', async () => {
    const p = pair(3, { fleetIds: ['B67777'] });
    const a = p.ids[0];
    const planted = [
      'TA Rochester tech shortage also hits B69999.', 'TA Rochester also holds B67777 for this repair.',
      'TA Rochester estimate is $4,800 for the repair.', 'TA Rochester promised ETC 11/20 for the unit.',
      'TA Rochester opened RO 448899 for this unit.', 'TA Rochester portal https://example.com/x has the details.',
      'TA Rochester saw the unit on 10/31 for a check.', 'TA Rochester bay booked for 11/13 per the shop.',
    ];
    const details = [{ units: [a], text: 'TA Rochester: no diesel tech available, ETC 11/14.' }].concat(planted.map((t) => ({ units: [a], text: t })));
    const ask = smartAsk({ single: (ids) => rowAnswer(ids, { barriers: Object.assign(rowAnswer(ids).barriers, { vendor1p: { yn: 'Y', details } }) }) });
    const r = await AI.draftRow(Object.assign({ ask, reviewRounds: 0 }, p.args));
    expect(r.cells.vendor1pDetails).toBe('• ' + a + ': TA Rochester: no diesel tech available, ETC 11/14.');
    for (const tok of ['B69999', 'B67777', '4,800', '11/20', '448899', 'example.com', '10/31', '11/13']) {
      for (const v of Object.values(r.cells)) expect(v).not.toContain(tok);
    }
    expect(r.dropped).toBe(8);
    expect(r.dropReasons['unknown-ref']).toBeGreaterThanOrEqual(4);
    expect(r.dropReasons['foreign-id']).toBe(1);
    expect(r.dropReasons['unknown-date']).toBeGreaterThanOrEqual(2);
  });

  it('AC7: hard-cell keys in the AI JSON are ignored; cells hold exactly the 17 AI cells', async () => {
    const p = pair(2);
    const ask = smartAsk({ single: (ids) => rowAnswer(ids, { domicileDown: '99', scacUptime: '1%', fasName: 'Fake Name', domicile: 'X', scac: 'Y' }) });
    const r = await AI.draftRow(Object.assign({ ask, reviewRounds: 0 }, p.args));
    expect(Object.keys(r.cells).sort()).toEqual([...F.AI_CELL_IDS].sort());
    for (const h of F.HARD_CELL_IDS) expect(r.cells[h]).toBeUndefined();
    expect(JSON.stringify(r.cells)).not.toContain('Fake Name');
  });

  it('AC9: the review final is used (2 calls); a hallucination only in the review is gated out; rounds 0 = the gated draft', async () => {
    const p = pair(3, { extra: { B61002: { repairTimeline: '11/08 - Parts ETA 11/14 turbo' } } });
    const review = (ids) => rowAnswer(ids, { barriers: Object.assign(rowAnswer(ids).barriers, {
      parts: { yn: 'Y', details: [{ units: ['B61002'], text: 'Turbo back-ordered, parts ETA 11/14' }] },
      oem: { yn: 'Y', details: [{ units: [ids[0]], text: 'Volvo dealer quoted $9,999 for the repair.' }] },
    }) });
    const ask = smartAsk({ review });
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(r.cells.partsYN).toBe('Y');
    expect(r.cells.partsDetails).toContain('Turbo back-ordered');
    for (const v of Object.values(r.cells)) expect(v).not.toContain('9,999');
    expect(r.flags.oemDetails).toBe('review');
    expect(r.reviewSkipped).toBeUndefined();

    const ask0 = smartAsk();
    const r0 = await AI.draftRow(Object.assign({ ask: ask0, reviewRounds: 0 }, p.args));
    expect(ask0).toHaveBeenCalledTimes(1);
    const ctx = AI.draftContext(p.args);
    const gated = G.renderCells(G.validateRowDraft(J(rowAnswer(ctx.ids)), ctx.gate, { kind: 'row' }), ctx.gate);
    expect(r0.cells).toEqual(gated.cells);
  });

  it('AC10: a failed or invalid review keeps the gated draft (ok, reviewSkipped)', async () => {
    const p = pair(3);
    const r1 = await AI.draftRow(Object.assign({ ask: smartAsk({ review: () => { throw new Error('lane down'); } }) }, p.args));
    expect(r1).toMatchObject({ ok: true, reviewSkipped: 'ai-failed' });
    expect(fasLines(r1)).toHaveLength(3);
    const r2 = await AI.draftRow(Object.assign({ ask: smartAsk({ review: () => 'no json here' }) }, p.args));
    expect(r2).toMatchObject({ ok: true, reviewSkipped: 'ai-invalid' });
  });

  it('AC29 + no envelopes: at n = 14 the review embed carries each Details text and never src/quote', async () => {
    const p = pair(14);
    const details = p.ids.map((u, i) => ({ units: [u], text: 'TA Rochester: no diesel tech available, unit number ' + (i + 1) + ' of fourteen waits.' }));
    const ask = smartAsk({ single: (ids) => rowAnswer(ids, { barriers: Object.assign(rowAnswer(ids).barriers, { vendor1p: { yn: 'Y', details } }) }) });
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    const rp = ask.seen.prompts[1];
    const embed = rp.slice(rp.indexOf(AI.DRAFT_OPEN), rp.indexOf(AI.DRAFT_CLOSE));
    for (const d of details) expect(embed).toContain(d.text);
    expect(embed).not.toMatch(/"src"|quote|called TA re tech callout"/);
    expect(r.log.find((e) => e.kind === 'review').embedD).toBeGreaterThanOrEqual(60);
  });

  it('AC-M1: n = 16, 36,000 chars of evidence, 30 Details entries -> review prompt <= 56,000, not skipped, D >= 60', async () => {
    const p = pair(16, { tlChars: 2100 });
    expect(p.ctx.mode).toBe('single');
    const evChars = p.ctx.blocks.reduce((s, b) => s + b.text().length, 0);
    expect(evChars).toBeGreaterThan(35000);
    expect(evChars).toBeLessThanOrEqual(36000);
    const ent = (u, k) => ({ units: [u], text: 'TA Rochester: no diesel tech available, unit in bay waiting on diagnosis update (entry ' + k + ').' });
    const ans = rowAnswer(p.ids, { barriers: Object.assign(rowAnswer(p.ids).barriers, {
      vendor1p: { yn: 'Y', details: p.ids.slice(0, 15).map((u, k) => ent(u, k)) },
      parts: { yn: 'Y', details: p.ids.slice(0, 15).map((u, k) => ent(u, k + 15)) },
    }) });
    const cur = G.validateRowDraft(J(ans), p.ctx.gate, { kind: 'row', detMax: 30 });
    expect(cur.barriers.vendor1p.entries.length + cur.barriers.parts.entries.length).toBe(30);
    const rp = AI.buildReviewPrompt('single', p.ctx, cur);
    expect(rp.tooLarge).toBeUndefined();
    expect(rp.prompt.length).toBeLessThanOrEqual(56000);
    expect(rp.embed.D).toBeGreaterThanOrEqual(60);
    expect(rp.embed.chars).toBeLessThanOrEqual(AI.DRAFT_EMBED_MAX);
    // and through draftRow the review runs, on a draft at the production Details cap (16 entries)
    const full = rowAnswer(p.ids, { barriers: Object.assign(rowAnswer(p.ids).barriers, {
      vendor1p: { yn: 'Y', details: p.ids.slice(0, 8).map((u, k) => ent(u, k)) },
      parts: { yn: 'Y', details: p.ids.slice(8, 16).map((u, k) => ent(u, k + 8)) },
    }) });
    expect(G.outBudget('single', 16).detMax).toBe(16);
    const ask = smartAsk({ single: () => full, review: () => full });
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(r.reviewSkipped).toBeUndefined();
    expect(r.calls).toBe(2);
    expect(r.cells.vendor1pDetails.split('\n').length + r.cells.partsDetails.split('\n').length).toBe(16);
    for (const e of r.log) expect(e.promptChars).toBeLessThanOrEqual(56000);
    expect(r.log[1].embedD).toBeGreaterThanOrEqual(60);
    for (const id of p.ids) expect(ask.seen.prompts[1]).toContain(id);
  });

  it('assertFits overflow: the draft batch is re-allocated, the review reuses the re-allocated blocks', async () => {
    const p = pair(16, { tlChars: 2100 });
    const evOf = (s) => s.slice(s.indexOf(AI.EVIDENCE_OPEN), s.indexOf('=== END EVIDENCE ==='));
    const before = evOf(AI.buildDraftPrompt(p.ctx)).length;
    const orig = AI.buildDraftPrompt;
    let builds = 0;
    AI.buildDraftPrompt = (ctx) => {
      const real = orig(ctx);
      builds += 1;
      return builds === 1 ? real + 'x'.repeat(AI.CALL_PROMPT_MAX - real.length + 3000) : real;
    };
    try {
      const ask = smartAsk();
      const r = await AI.draftRow(Object.assign({ ask }, p.args));
      expect(r.ok).toBe(true);
      expect(builds).toBe(2);
      expect(ask.seen.kinds).toEqual(['single', 'review']);
      const draftEv = evOf(ask.seen.prompts[0]);
      expect(draftEv.length).toBeLessThan(before - 2500);
      expect(evOf(ask.seen.prompts[1])).toBe(draftEv);
      for (const pr of ask.seen.prompts) expect(pr.length).toBeLessThanOrEqual(AI.CALL_PROMPT_MAX);
      for (const id of p.ids) expect(draftEv).toContain('[' + id + ']');
    } finally { AI.buildDraftPrompt = orig; }
  });

  it('assertFits overflow that the re-allocation cannot fix -> ai-too-large, 0 calls', async () => {
    const p = pair(3);
    const orig = AI.buildDraftPrompt;
    AI.buildDraftPrompt = () => 'x'.repeat(AI.CALL_PROMPT_MAX + 1);
    try {
      const ask = smartAsk();
      const r = await AI.draftRow(Object.assign({ ask }, p.args));
      expect(r).toMatchObject({ ok: false, code: 'ai-too-large', calls: 0 });
      expect(ask).not.toHaveBeenCalled();
    } finally { AI.buildDraftPrompt = orig; }
  });

  it('review that cannot fit -> reviewSkipped too-large, ok, no extra call', async () => {
    const p = pair(3);
    const orig = AI.buildReviewPrompt;
    AI.buildReviewPrompt = () => ({ tooLarge: true });
    try {
      const ask = smartAsk();
      const r = await AI.draftRow(Object.assign({ ask }, p.args));
      expect(r).toMatchObject({ ok: true, reviewSkipped: 'too-large', calls: 1 });
      expect(ask).toHaveBeenCalledTimes(1);
    } finally { AI.buildReviewPrompt = orig; }
  });
});

describe('map / reduce (AC11)', () => {
  it('40 units x ~2.5k: 3 batches (14, 13, 13), 3 + 1 + 1 calls, every prompt <= 56,000, all 40 in FAS Actions', async () => {
    const p = pair(40, { tlChars: 2150 });
    expect(p.ctx.mode).toBe('mapreduce');
    expect(p.ctx.batches.map((b) => b.length)).toEqual([14, 13, 13]);
    const ask = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(ask.seen.kinds).toEqual(['map', 'map', 'map', 'reduce', 'review-mr']);
    expect(r.calls).toBe(5);
    for (const pr of ask.seen.prompts) expect(pr.length).toBeLessThanOrEqual(56000);
    const lines = fasLines(r);
    expect(lines).toHaveLength(40);
    lines.forEach((l, i) => expect(l.startsWith('• ' + p.ids[i] + ': 11/10 called TA')).toBe(true));
  });

  it('9 x 14k -> batches 3, 2, 2, 2 each water-filled to <= 36,000; planned = 4 + 1 + rounds', async () => {
    const p = pair(9, { tlChars: 15000 });
    expect(p.ctx.batches.map((b) => b.length)).toEqual([3, 2, 2, 2]);
    for (const b of p.ctx.batches) expect(b.reduce((s, e) => s + e.text().length, 0)).toBeLessThanOrEqual(36000);
    const ask = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(r.planned).toBe(6);
    expect(r.calls).toBe(6);
    expect(fasLines(r)).toHaveLength(9);
    for (const pr of ask.seen.prompts) expect(pr.length).toBeLessThanOrEqual(56000);
  });

  it('10 x 13k -> 3, 3, 2, 2; 17 small -> 9, 8; 21 small -> 11, 10; 96 small -> 24 x 4', () => {
    expect(pair(10, { tlChars: 12600 }).ctx.batches.map((b) => b.length)).toEqual([3, 3, 2, 2]);
    expect(pair(17).ctx.batches.map((b) => b.length)).toEqual([9, 8]);
    expect(pair(21).ctx.batches.map((b) => b.length)).toEqual([11, 10]);
    const p96 = pair(96);
    expect(p96.ctx.mode).toBe('mapreduce');
    expect(p96.ctx.batches.map((b) => b.length)).toEqual([24, 24, 24, 24]);
  });

  it('97 units -> ai-too-large with 0 calls', async () => {
    const ask = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask }, pair(97).args));
    expect(r).toMatchObject({ ok: false, code: 'ai-too-large', calls: 0, mode: 'too-large' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('reduce fasActions / etc keys are ignored: final FAS / ETC equal the gated map values', async () => {
    const p = pair(17);
    const ask = smartAsk({ reduce: (ids) => Object.assign(reduceAnswer(ids), {
      fasActions: ids.map((u) => ({ unit: u, text: 'No FAS action logged; reduce rewrote this; next: call TA' })),
      etc: ids.map((u) => ({ unit: u, state: 'none', date: '', why: '' })),
    }) });
    const r = await AI.draftRow(Object.assign({ ask, reviewRounds: 0 }, p.args));
    expect(r.cells.fasActions).not.toContain('reduce rewrote');
    expect(fasLines(r).every((l) => l.includes('11/10 called TA re tech callout'))).toBe(true);
    expect(r.etcUnits.every((e) => e.state === 'future' && e.date === '11/14' && e.origin === 'ai')).toBe(true);
    expect(r.cells.noEtc).toBe('0');
  });

  it('AC18: n = 96 -> every prompt incl. the review <= 56,000, embed <= 11,200', async () => {
    const p = pair(96);
    const ask = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(ask.seen.kinds).toEqual(['map', 'map', 'map', 'map', 'reduce', 'review-mr']);
    for (const pr of ask.seen.prompts) expect(pr.length).toBeLessThanOrEqual(56000);
    const rev = r.log.find((e) => e.kind === 'review');
    expect(rev.embedChars).toBeLessThanOrEqual(AI.DRAFT_EMBED_MAX);
    expect(fasLines(r)).toHaveLength(96);
  });

  it('AC29: compactEmbed at n = 96 is <= 11,200 and IDs-only when D < 60; Details shown when D >= 60', () => {
    const ids = Array.from({ length: 96 }, (_, i) => 'B6' + String(1000000000 + i));
    const mk = (k) => ({
      barriers: Object.fromEntries(G.BARRIER_IDS.map((b) => [b, b === 'vendor1p'
        ? { valid: true, yn: 'Y', entries: ids.slice(0, k).map((u) => ({ units: [u], text: 'x'.repeat(300) })) }
        : { valid: true, yn: 'N', entries: [] }])),
      etc: {}, fas: {}, support: { mode: 'none', entries: [] },
    });
    const e96 = AI.compactEmbed(mk(96), 11200, 'mapreduce', { ids });
    expect(e96.D).toBeLessThan(60);
    expect(e96.text.length).toBeLessThanOrEqual(11200);
    expect(e96.text).toContain('units=');
    expect(e96.text).not.toContain('xxxxxxxxxx');
    const e40 = AI.compactEmbed(mk(40), 11200, 'mapreduce', { ids });
    expect(e40.D).toBe(134);
    expect(e40.text.length).toBeLessThanOrEqual(11200);
    expect(e40.text).toContain('  - ' + ids[0] + ': ' + 'x'.repeat(100));
  });

  it('AC34: a map batch omits B61007; the review carries its block and its grounded line is used', async () => {
    const p = pair(17);
    const ask = smartAsk({
      map: (ids) => mapAnswer(ids.filter((u) => u !== 'B61007')),
      'review-mr': (ids) => Object.assign(reduceAnswer(ids), { fasActions: [fasE('B61007')] }),
    });
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    const rp = ask.seen.prompts[ask.seen.kinds.indexOf('review-mr')];
    expect(rp.length).toBeLessThanOrEqual(56000);
    expect(rp.slice(rp.indexOf(AI.GAP_OPEN))).toContain('[B61007]');
    expect(fasLines(r).find((l) => l.startsWith('• B61007: '))).toBe('• B61007: 11/10 called TA re tech callout; next: confirm tech on site');
    expect(r.coverageFilled).not.toContain('B61007');
    expect(r.flags.fasActions).toBeUndefined();
  });

  it('AC36: the 2nd of 3 map batches throws once then succeeds -> ok, retry counted; too little deadline -> ai-failed, no reduce', async () => {
    const p = pair(40, { tlChars: 2150 });
    const flaky = () => { let n = 0; return (ids, _p, k) => { if (k === 2 && n++ === 0) throw new Error('lane down'); return mapAnswer(ids); }; };
    const ask = smartAsk({ map: flaky() });
    const r = await AI.draftRow(Object.assign({ ask }, p.args));
    expect(r.ok).toBe(true);
    expect(r.calls).toBe(6);
    expect(r.mapRetries).toBe(1);
    expect(r.log.some((e) => e.kind === 'map-retry' && e.batch === 1)).toBe(true);
    expect(fasLines(r).every((l) => !l.includes('⚠'))).toBe(true);

    const ask2 = smartAsk({ map: flaky() });
    const r2 = await AI.draftRow(Object.assign({ ask: ask2, now: () => 0, deadlineMs: 374000 }, p.args));
    expect(r2).toMatchObject({ ok: false, code: 'ai-failed' });
    expect(ask2.seen.kinds).toEqual(['map', 'map']);
  });

  it('AC51: reduce facts carry [f:M/D "quote"] (<= 40-char word-boundary cut); a reduce FAS mention re-declaring it is kept, else dropped', async () => {
    const enrich = { B61003: { manualEntries: ['11/10 - checked alternate source with Bruckners Syracuse, none in stock'] } };
    const extra = { B61003: { vendor: 'Bruckners' } };
    const run = async (quote, detailQuote) => {
      const p = pair(17, { enrich, extra });
      const reduce = (ids) => {
        const a = reduceAnswer(ids);
        a.barriers.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo actuator back-ordered at Bruckners; FAS checked alternate source with Bruckners Syracuse 11/10', src: { fas: [{ date: '11/10', quote: detailQuote }] } }] };
        return a;
      };
      const ask = smartAsk({
        reduce, 'review-mr': reduce,
        map: (ids) => {
          const a = mapAnswer(ids);
          const u = a.units.find((x) => x.unit === 'B61003');
          if (u) u.fasAction = { text: '11/10 checked alternate source with Bruckners; next: confirm stock with Bruckners', src: { fas: [{ date: '11/10', quote }] } };
          return a;
        },
      });
      const r = await AI.draftRow(Object.assign({ ask }, p.args));
      return { r, ask };
    };
    const tag = '[f:11/10 "checked alternate source with Bruckners"]';
    const a = await run('checked alternate source with Bruckners', 'checked alternate source with Bruckners');
    const red = a.ask.seen.prompts[a.ask.seen.kinds.indexOf('reduce')];
    expect(red.split('\n').find((l) => l.startsWith('B61003: '))).toContain(tag);
    expect(a.r.cells.partsDetails).toBe('• B61003: Turbo actuator back-ordered at Bruckners; FAS checked alternate source with Bruckners Syracuse 11/10');
    expect(a.ask.seen.prompts[a.ask.seen.kinds.indexOf('review-mr')]).toContain(tag);

    const b = await run('checked alternate source with Bruckners Syracuse', 'checked alternate source with Bruckners');
    expect(b.ask.seen.prompts[b.ask.seen.kinds.indexOf('reduce')]).toContain(tag);

    const c = await run('checked alternate source with Bruckners', 'checked alternate source at Bruckners');
    expect(c.r.cells.partsDetails).not.toContain('Turbo actuator');
    expect(c.r.dropReasons['unfounded-fas-action']).toBeGreaterThanOrEqual(1);
  });
});

describe('deadlines, timeouts and failures', () => {
  it('AC27: 100 s left before the reduce -> ai-timeout (deadline), maps made, reduce not called; timeoutMs >= 125000', async () => {
    let t = 0;
    const p = pair(17);
    const inner = smartAsk();
    const ask = vi.fn(async (pr, o) => { t += 200000; return inner(pr, o); });
    const r = await AI.draftRow(Object.assign({ ask, now: () => t, deadlineMs: 2 * 200000 + 100000 }, p.args));
    expect(r).toMatchObject({ ok: false, code: 'ai-timeout', reason: 'deadline' });
    expect(inner.seen.kinds).toEqual(['map', 'map']);
    for (const o of inner.seen.opts) { expect(o.timeoutMs).toBeGreaterThanOrEqual(125000); expect(o.timeoutMs).toBeLessThanOrEqual(230000); }
  });

  it('AC27: a review with 100 s left is skipped (deadline), ok', async () => {
    let t = 0;
    const p = pair(3);
    const inner = smartAsk();
    const ask = vi.fn(async (pr, o) => { t += 200000; return inner(pr, o); });
    const r = await AI.draftRow(Object.assign({ ask, now: () => t, deadlineMs: 200000 + 100000 }, p.args));
    expect(r).toMatchObject({ ok: true, reviewSkipped: 'deadline', calls: 1 });
  });

  it('default deadline: every ask gets timeoutMs in [125000, 230000] and the signal', async () => {
    const p = pair(3);
    const ac = new AbortController();
    const ask = smartAsk();
    await AI.draftRow(Object.assign({ ask, signal: ac.signal }, p.args));
    for (const o of ask.seen.opts) {
      expect(o.signal).toBe(ac.signal);
      expect(o.timeoutMs).toBe(230000);
    }
  });

  it('fallback codes: AI_TIMEOUT -> ai-timeout, rejection -> ai-failed, junk -> ai-invalid, empty -> ai-empty; never any text', async () => {
    const p = pair(3);
    const run = (ask) => AI.draftRow(Object.assign({ ask }, p.args));
    const t = await run(async () => { throw Object.assign(new Error('AI timeout after 90s'), { code: 'AI_TIMEOUT' }); });
    const f = await run(async () => { throw new Error('relay down'); });
    const n = await run(async () => 12345);
    const e = await run(async () => J({ barriers: {}, etc: 'x', fasActions: [], support: 'nope' }));
    expect([t.code, f.code, n.code, e.code]).toEqual(['ai-timeout', 'ai-failed', 'ai-invalid', 'ai-empty']);
    for (const r of [t, f, n, e]) { expect(r.ok).toBe(false); expect(r.cells).toBeUndefined(); expect(r.fasActions).toBeUndefined(); }
    expect(await AI.draftRow(Object.assign({}, p.args, { ask: null }))).toMatchObject({ ok: false, code: 'ai-failed' });
    expect(await AI.draftRow()).toMatchObject({ ok: false });
  });

  it('a { text } result is accepted; the per-call log holds counts only (no text), fieldOver omitted when 0', async () => {
    const p = pair(3);
    const inner = smartAsk();
    const r = await AI.draftRow(Object.assign({ ask: async (pr, o) => ({ text: await inner(pr, o) }) }, p.args));
    expect(r.ok).toBe(true);
    expect(r.log.map((e) => e.kind)).toEqual(['draft', 'review']);
    for (const e of r.log) {
      expect(typeof e.promptChars).toBe('number');
      expect(e.outChars).toBeGreaterThan(0);
      expect(typeof e.ms).toBe('number');
      expect(e.fieldOver).toBeUndefined();
    }
    expect(r.log[0].fasTagged).toBe(3);
    const s = JSON.stringify(r.log);
    for (const tok of ['Rochester', 'called TA', 'B61001', 'next:']) expect(s).not.toContain(tok);
  });
});

describe('static', () => {
  it('no Promise.race( in src/dbr/fleet-dbr*.js', () => {
    const dir = path.join(__dirname, '../src/dbr');
    const files = fs.readdirSync(dir).filter((f) => /^fleet-dbr.*\.js$/.test(f));
    expect(files).toEqual(expect.arrayContaining(['fleet-dbr.js', 'fleet-dbr-ai.js', 'fleet-dbr-evidence.js', 'fleet-dbr-gate.js']));
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('Promise.race(');
  });
});
