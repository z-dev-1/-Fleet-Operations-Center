// Fleet DBR envelope gate (design §3 outBudget, §5.1-§5.5, §11; plan.md R-M2, R-N4, R-N5, R-N6):
// AC3-AC7, AC17, AC20, AC21, AC23-AC25, AC28, AC31, AC37-AC39, AC41-AC45, AC47, AC50, AC52-AC55,
// AC-M2 and the brief's planted tokens. Pure, synthetic data only.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const G = require('../src/dbr/fleet-dbr-gate');
const { AI_CELL_IDS, HARD_CELL_IDS } = require('../src/dbr/fleet-dbr');
const E = require('../src/dbr/fleet-dbr-evidence');
const { F, env, makeCtx } = require('./fixtures/fleet-dbr/envelope');
const X = require('./fixtures/fleet-dbr/contract-example-evidence');

const TODAY = '2026-11-12';
const STD_UNITS = {
  B61001: {
    vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor',
    repairTimeline: '11/09 - TA Rochester: no diesel tech available until 11/12\n11/10 - TA update: bay booked\n11/08 - RO 5566 opened',
    fullConversation: 'Conversation\n11/10 - TA Desk: called TA dispatch, tech assigned',
  },
  B61002: {
    vendor: 'Volvo', subVendor: 'MHC Kenworth', lifecycleReason: 'Offsite Shop Repair', savedRepairStatus: 'Under diagnosis',
    repairTimeline: '11/03 - dropped at MHC Kenworth\n11/07 - Volvo parts ETA 11/14\n11/08 - RO-4488 opened for brakes',
    asistNotes: 'ASIST: case 7712345 open; RO 448812 under diagnosis',
  },
  B61003: {
    vendor: 'Bruckners', savedRepairStatus: 'Parts ordered', estimatePendingCost: '$1,250',
    repairTimeline: '11/08 - dealer: Parts ETA 11/14 turbo, RO 448901\n11/11 - dealer: parts arriving Thursday',
  },
  B61004: { vendor: 'dealer', repairTimeline: '11/05 - dealer ETC 11/08\n11/10 - new ETC 11/14\n11/06 - RO-448830 opened' },
  B61005: { vendor: 'dealer', repairTimeline: '11/05 - dealer ETC 11/08\n11/10 - ETC cancelled, waiting on parts' },
  B61006: { vendor: 'dealer', repairTimeline: '11/05 - diagnosis completed 11/05' },
  B61007: { vendor: 'dealer', repairTimeline: '11/10 - ETC 11/13 per dealer' },
  B61010: { vendor: 'dealer', repairTimeline: '11/05 - ETC 11/15\n11/10 - new ETC 11/18' },
  B61011: { vendor: 'Volvo' },
};
const STD_ENRICH = {
  B61001: { manualEntries: ['11/10 - called TA re tech callout', '11/11 - TA update: tech assigned'] },
  B61002: { manualEntries: ['11/09 - Volvo update: estimate submitted [em:1a2b3c4d]', '11/10 - called dealer for status [em:3c4d5e6f]'] },
  B61003: {
    manualEntries: [
      '11/10 - checked alternate source with Bruckners Syracuse, none in stock',
      '11/10 - called dealer re parts',
      '11/09 - Bruckners: turbo still back-ordered [em:2b3c4d5e]',
    ],
  },
  B61011: { manualEntries: ['11/09 - escalated to Volvo regional for estimate approval'] },
};
const STD = makeCtx({ units: STD_UNITS, enrich: STD_ENRICH, today: TODAY, fleetIds: ['T0001', 'B61001'] });
const ctx = STD.ctx;
const gate = (text, src, scope, field = 'details', extraDates) => G.gateEntry(text, src, scope, ctx, { field, extraDates });
const res = (...a) => { const g = gate(...a); return g.ok ? 'kept' : g.code; };
const answer = (o) => JSON.stringify(o);
const N6 = () => ({ vendor1p: { yn: 'N', details: [] }, oem: { yn: 'N', details: [] }, estimate: { yn: 'N', details: [] },
  partner: { yn: 'N', details: [] }, parts: { yn: 'N', details: [] }, common: { yn: 'N', details: [] } });

describe('context (§5.1)', () => {
  it('downIds in builder order, idMap case-insensitive, own IDs never foreign', () => {
    expect(ctx.downIds).toEqual(Object.keys(STD_UNITS));
    expect(ctx.idMap.get('b61003')).toBe('B61003');
    expect(ctx.foreign.has('T0001')).toBe(true);
    expect(ctx.foreign.has('B61001')).toBe(false);
  });
  it('etcDates hold ETC dates only; dates hold every evidence date', () => {
    expect([...ctx.etcDates.B61004]).toEqual(expect.arrayContaining(['11/8', '11/14']));
    expect(ctx.etcDates.B61003.has('11/14')).toBe(false);
    expect(ctx.dates.B61003.has('11/14')).toBe(true);
  });
  it('AC21 accepted / excluded ETC phrasing', () => {
    const phr = {
      E10001: 'dealer says ready 11/12', E10002: 'expected to be complete 11/12', E10003: 'should be ready by 11/12',
      E10004: 'promised ready 11/12', E10005: 'Parts ETA 11/08 turbo', E10006: 'diagnosis completed 11/05',
      E10007: 'PM done 11/03', E10008: 'estimate completed 11/04', E10009: 'parts delivered and ready 11/12',
    };
    const units = {};
    for (const [id, t] of Object.entries(phr)) units[id] = { repairTimeline: '11/01 - ' + t };
    const c = makeCtx({ units, today: '2026-11-10' }).ctx;
    for (const id of ['E10001', 'E10002', 'E10003', 'E10004']) expect(c.etcDates[id].has('11/12')).toBe(true);
    expect(c.etcDates.E10005.size + c.etcDates.E10006.size + c.etcDates.E10007.size + c.etcDates.E10008.size + c.etcDates.E10009.size).toBe(0);
  });
});

describe('outBudget (AC31, R-N4)', () => {
  it('single n = 16 / 14 exact numbers', () => {
    const b = G.outBudget('single', 16, { idLen: 12 });
    expect([b.fasOut, b.fasEntryOut, b.fasTotal]).toEqual([246, 432, 6920]);
    expect([b.detailOut, b.detMax, b.detTotal, b.whyOut, b.whyTotal, b.supportMax, b.askOut]).toEqual([300, 16, 4000, 150, 1600, 8, 160]);
    expect([b.envItems, b.envQuote, b.total]).toEqual([2, 40, 16000]);
    expect(G.outBudget('single', 14, { idLen: 12 }).fasOut).toBe(280);
  });
  it('map k = 24 / 16 / 9 exact numbers (R-N4 factOut)', () => {
    const m24 = G.outBudget('map', 24, { idLen: 12 });
    expect([m24.fasOut, m24.factTotal, m24.factOut, m24.whyOut, m24.whyTotal, m24.supportMax, m24.total]).toEqual([150, 2056, 40, 120, 1800, 4, 16000]);
    const m16 = G.outBudget('map', 16, { idLen: 12 });
    // R-N4 formula: floor(4464 / 24) - 35 = 151 (the review's "160 at k = 16" is an arithmetic slip; the inequality needs <= 151).
    expect([m16.fasOut, m16.factTotal, m16.factOut]).toEqual([225, 4464, 151]);
    const m9 = G.outBudget('map', 9, { idLen: 12 });
    expect([m9.fasOut, m9.factTotal, m9.factOut]).toEqual([280, 7651, 300]);
  });
  it('reduce and review-mr exact numbers', () => {
    expect(G.outBudget('reduce', 96, { idLen: 12, hits: 40 }).detailOut).toBe(165);
    expect(G.outBudget('reduce', 96, { idLen: 12 }).detTotal).toBe(13640);
    // fasOutGap = min(lineCap, 200): 200 while the row's lineCap >= 200 (n <= 72 with 12-char IDs).
    expect(G.outBudget('review-mr', 40, { idLen: 12, g: 16 }).detTotal).toBe(7464);
    expect(G.outBudget('review-mr', 96, { idLen: 12, g: 16 }).fasOut).toBe(149);
    expect(G.outBudget('review-mr', 96, { idLen: 12, g: 0 }).detTotal).toBe(13640);
  });
  it('Σ totals + skeleton <= 16,000 and FAS entries fit, for every kind / n / idLen', () => {
    for (const idLen of [8, 12, 15]) {
      for (const kind of ['single', 'review']) {
        for (let n = 1; n <= 16; n++) {
          const b = G.outBudget(kind, n, { idLen });
          expect(b.total).toBeLessThanOrEqual(16000);
          expect(n * (b.kF + b.fasOut + G.ENV2)).toBeLessThanOrEqual(b.fasTotal);
        }
      }
      for (let k = 1; k <= 24; k++) {
        const b = G.outBudget('map', k, { idLen });
        expect(b.total).toBeLessThanOrEqual(16000);
        expect(k * (b.kF + b.fasOut + G.ENV2)).toBeLessThanOrEqual(b.fasTotal);
        if (idLen <= 12) expect(b.factTotal).toBeGreaterThanOrEqual(2000);
        if (b.factOut > 40) expect(1.5 * k * (b.factOut + 35)).toBeLessThanOrEqual(b.factTotal);
      }
      for (let n = 1; n <= 96; n++) {
        for (const hits of [0, 1, 40, 200]) expect(G.outBudget('reduce', n, { idLen, hits }).total).toBeLessThanOrEqual(16000);
        for (let g = 0; g <= 16; g++) {
          const b = G.outBudget('review-mr', n, { idLen, g });
          expect(b.total).toBeLessThanOrEqual(16000);
          expect(g * (b.kF + b.fasOut + G.ENV2)).toBeLessThanOrEqual(b.fasTotal);
        }
      }
    }
  });
  it('supportMax is the same number in outBudget and limits()', () => {
    for (const n of [1, 9, 10, 16, 17, 96]) {
      const lim = G.limits({ downIds: Array.from({ length: n }, (_, i) => 'B' + (60000 + i)) });
      expect(lim.supportMax).toBe(Math.min(8, Math.max(5, Math.ceil(n / 2))));
      expect(G.outBudget(n <= 16 ? 'single' : 'reduce', n).supportMax).toBe(lim.supportMax);
    }
  });
  it('lineCap math (§5.4)', () => {
    const lc = (n, len) => G.limits({ downIds: Array.from({ length: n }, (_, i) => String(i).padStart(len, 'A')) }).lineCap;
    expect(lc(14, 8)).toBe(320);
    expect(lc(96, 8)).toBe(153);
    expect(lc(120, 12)).toBe(116);
  });
});

describe('E0 envelope (AC41, tolerance)', () => {
  const fasText = '11/10 called TA re tech callout';
  it('missing src is fas = [] and counted envMissing', () => {
    const g = gate('No FAS action logged; unit waiting on TA', undefined, ['B61001'], 'fasActions');
    expect(g.ok).toBe(true);
    expect(g.envMissing).toBe(true);
  });
  it('3 items or a 60-char quote are accepted and counted envOver', () => {
    const q = 'called TA re tech callout';
    expect(gate(fasText, env({ fas: [F('11/10', q), F('11/10', q), F('11/10', q)] }), ['B61001'], 'fasActions').envOver).toBe(true);
    const c = makeCtx({ units: { B70001: { vendor: 'TA' } }, enrich: { B70001: { manualEntries: ['11/10 - called TA re tech callout for the second shift crew and road service'] } }, today: TODAY }).ctx;
    const long = 'called TA re tech callout for the second shift crew and road';
    expect(long.length).toBeGreaterThan(40);
    const g = G.gateEntry(fasText, env({ fas: [F('11/10', long)] }), ['B70001'], c, { field: 'fasActions' });
    expect(g.ok).toBe(true);
    expect(g.envOver).toBe(true);
  });
  it('shape faults are bad-envelope', () => {
    const q = 'called TA re tech callout';
    expect(res(fasText, env({ fas: [1, 2, 3, 4, 5].map(() => F('11/10', q)) }), ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, env({ fas: [F('11/10', 'x'.repeat(81))] }), ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, 'called TA', ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, { fas: 'called TA' }, ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, { fas: [{ date: '11/10' }] }, ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, env({ fas: [F('13/40', q)] }), ['B61001'], 'fasActions')).toBe('bad-envelope');
    expect(res(fasText, env({ fas: [F('11/10', 'call')] }), ['B61001'], 'fasActions')).toBe('bad-envelope');
  });
  it('revision-5 dates / refs keys are ignored (AC44)', () => {
    expect(res(fasText, { fas: [F('11/10', 'called TA re tech callout')], dates: ['11/30'], refs: ['RO 1'] }, ['B61001'], 'fasActions')).toBe('kept');
  });
});

describe('E2 quote checks', () => {
  it('AC20: a quote found only on a vendor-authored line is unfounded', () => {
    expect(res('11/10 called TA dispatch', env({ fas: [F('11/10', 'called TA dispatch')] }), ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
  });
  it('[logged] line, other date, normalized case/punctuation, trimmed-out line', () => {
    expect(res('11/11 TA update: tech assigned', env({ fas: [F('11/11', 'TA update: tech assigned')] }), ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('11/09 called TA re tech callout', env({ fas: [F('11/09', 'called TA re tech callout')] }), ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('11/10 called TA re tech callout', env({ fas: [F('11/10', 'CALLED TA, re tech callout')] }), ['B61001'], 'fasActions')).toBe('kept');
    const evs = STD.evidences.map((e) => (e.id === 'B61001' ? E.trimEvidence(e, 250) : e));
    const c2 = G.gateContext({ row: STD.row, evidences: evs, fleetIds: [], today: TODAY });
    expect(G.gateEntry('11/10 called TA re tech callout', env({ fas: [F('11/10', 'called TA re tech callout')] }), ['B61001'], c2, { field: 'fasActions' }).code)
      .toBe('unfounded-fas-action');
  });
});

describe('AC28 FAS entries with envelopes', () => {
  const ok = env({ fas: [F('11/10', 'called TA')] });
  it('vendor update: kept in Details / ETC why, FAS needs "No FAS action logged"', () => {
    const t = 'Volvo update 11/09: estimate submitted; next: push MCS for approval';
    expect(res(t, undefined, ['B61002'], 'details')).toBe('kept');
    expect(res(t, undefined, ['B61002'], 'etcWhy')).toBe('kept');
    expect(res(t, undefined, ['B61002'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('No FAS action logged; ' + t, undefined, ['B61002'], 'fasActions')).toBe('kept');
  });
  it('lead-verb claims without / with a vendor-only quote', () => {
    expect(res('11/09 submitted estimate', undefined, ['B61002'], 'details')).toBe('unfounded-fas-action');
    expect(res('11/09 submitted estimate', env({ fas: [F('11/09', 'submitted estimate')] }), ['B61002'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('TA update 11/10: bay booked; 11/10 called TA', undefined, ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
  });
  it('next: follow-up date kept; a fact date not in evidence dropped', () => {
    expect(res('11/10 called TA; next: confirm tech on site 11/21', ok, ['B61001'], 'fasActions')).toBe('kept');
    expect(res('11/10 called TA, bay confirmed for 11/21', ok, ['B61001'], 'fasActions')).toBe('unknown-date');
  });
  it('[em:] manual entry, undated claims, Escalated without a [FAS] line', () => {
    expect(res('11/10 called dealer', env({ fas: [F('11/10', 'called dealer')] }), ['B61002'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('Called TA and escalated to dealer service manager; next: confirm tech', {}, ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('Escalated ASIST case 7712345 to Volvo', undefined, ['B61002'], 'fasActions')).toBe('unfounded-fas-action');
  });
  it('"FAS update M/D:" needs a validated src.fas date; with one the prose is kept verbatim', () => {
    const t = 'FAS update 11/10: called dealer, confirmed parts ETA 11/14';
    expect(res(t, undefined, ['B61002'], 'fasActions')).toBe('unfounded-fas-action');
    const d = G.validateRowDraft(answer({ fasActions: [{ unit: 'B61003', text: t, src: env({ fas: [F('11/10', 'called dealer')] }) }] }), ctx);
    const r = G.renderCells(d, ctx);
    expect(r.cells.fasActions.split('\n')).toContain('\u2022 B61003: ' + t);
    for (const v of Object.values(r.cells)) expect(v).not.toMatch(/"quote"|"src"|"fas"\s*:/);
    expect(r.provenance.fasActions.B61003).toEqual([{ date: '11/10', quote: 'called dealer' }]);
  });
  it('No FAS action logged: kept without src, bad-envelope with one', () => {
    expect(res('No FAS action logged; unit at dealer awaiting parts; next: call dealer', undefined, ['B61003'], 'fasActions')).toBe('kept');
    expect(res('No FAS action logged; unit waiting on TA', env({ fas: [F('11/10', 'called TA re tech callout')] }), ['B61001'], 'fasActions')).toBe('bad-envelope');
  });
});

describe('AC-M2: one next: rule, never a FAS-claim bypass (R-M2)', () => {
  const ok = env({ fas: [F('11/10', 'called TA')] });
  it('a FAS claim wrapped in next: still needs src.fas', () => {
    expect(res('11/10 called TA; next: escalated to Volvo regional 11/09', ok, ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('11/10 called TA; next: escalated to Volvo regional 11/21', ok, ['B61001'], 'fasActions')).toBe('unfounded-fas-action');
    expect(res('TA has no diesel tech; next: FAS escalated to TA regional 11/09', undefined, ['B61001'], 'details')).toBe('unfounded-fas-action');
  });
  it('next: is ordinary text outside FAS Actions', () => {
    expect(res('TA has no diesel tech; next: TA to confirm Thursday', undefined, ['B61001'], 'details')).toBe('unknown-rel-date');
    expect(res('TA has no diesel tech; next: TA to confirm tech 11/21', undefined, ['B61001'], 'details')).toBe('unknown-date');
  });
  it('FAS next: proposals keep future and relative dates', () => {
    expect(res('11/10 called TA; next: confirm tech on site 11/21', ok, ['B61001'], 'fasActions')).toBe('kept');
    expect(res('11/10 called TA; next: call TA Thursday', ok, ['B61001'], 'fasActions')).toBe('kept');
    expect(res('11/10 called TA; next: we will call TA', ok, ['B61001'], 'fasActions')).toBe('kept');
  });
  it('a next: clause with a past date or an invented ETC date is checked in full', () => {
    expect(res('11/10 called TA; next: follow up on 11/02 quote', ok, ['B61001'], 'fasActions')).toBe('unknown-date');
    expect(res('11/10 called TA; next: confirm ETC 11/21', ok, ['B61001'], 'fasActions')).toBe('unknown-etc-date');
  });
  it('exactly one nextClause helper, used by every stage', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/dbr/fleet-dbr-gate.js'), 'utf8');
    expect(src.match(/function nextClause\(/g)).toHaveLength(1);
    const body = (name) => {
      const i = src.indexOf('function ' + name + '(');
      const j = src.indexOf('\nfunction ', i + 1);
      return src.slice(i, j < 0 ? undefined : j);
    };
    for (const fn of ['freeDateProblem', 'proseTokens', 'fasClaimProblem', 'dateBindingFlags']) expect(body(fn)).toContain('nextClause(');
    expect(src).not.toContain('Promise.race(');
  });
});

describe('E3\' prose tokens (AC4, AC24, AC39, AC44, AC45, scope)', () => {
  it('AC44 dates, refs and amounts read from the prose', () => {
    expect(res('Turbo actuator back-ordered, parts ETA 11/20', undefined, ['B61003'])).toBe('unknown-date');
    expect(res('RO 448812 under diagnosis', undefined, ['B61002'])).toBe('kept');
    expect(res('RO 448813 under diagnosis', undefined, ['B61002'])).toBe('unknown-ref');
    expect(res('Turbo quote is $4,800 at Bruckners', undefined, ['B61003'])).toBe('unknown-ref');
    expect(res('Estimate pending $1,250 at Bruckners', undefined, ['B61003'])).toBe('kept');
  });
  it('scope: a token valid for unit A is rejected on unit B', () => {
    expect(res('RO 448812 under diagnosis', undefined, ['B61001'])).toBe('unknown-ref');
  });
  it('AC24 / AC39 short and hyphen refs', () => {
    expect(res('Brakes on RO 4488 at the dealer', undefined, ['B61001'])).toBe('unknown-ref');
    expect(res('Brakes on RO 4488 at the dealer', undefined, ['B61002'])).toBe('kept');
    expect(res('Brakes on RO-5566 at TA', undefined, ['B61001'])).toBe('kept');
    expect(res('Repair on RO 448830 at the dealer', undefined, ['B61004'])).toBe('kept');
    expect(res('Repair on RO# 448830 at the dealer', undefined, ['B61004'])).toBe('kept');
    expect(res('Volvo ASIST case 7712345 open', undefined, ['B61002'])).toBe('kept');
    expect(res('Waiting on PO approval from the dealer', undefined, ['B61002'])).toBe('kept');
  });
  it('AC45 fractions are not dates', () => {
    expect(res('Needs a 3/4 ton jack for the turbo', undefined, ['B61003'])).toBe('kept');
    expect(res('Waiting on parts, 2/3 units affected', undefined, ['B61003'])).toBe('kept');
    expect(res('Torque spec 10/12 ft-lb on the turbo', undefined, ['B61003'])).toBe('kept');
  });
  it('AC21: "etc." in prose is not an ETC phrase', () => {
    expect(res('filters, belts, etc. 11/12 at TA', undefined, ['B61001'])).toBe('kept');
  });
});

describe('planted tokens (AC4) dropped from Details while siblings survive', () => {
  const planted = [
    ['B69999 also waiting on the turbo actuator', 'unknown-ref'],
    ['B61002 shares the turbo backorder', 'out-of-scope-id'],
    ['T0001 shares the turbo backorder', 'foreign-id'],
    ['Turbo quote is $4,800 at Bruckners', 'unknown-ref'],
    ['Turbo install ETC 11/14 per Bruckners', 'unknown-etc-date'],
    ['Turbo on RO 448999 at Bruckners', 'unknown-ref'],
    ['Tracking at https://fake.example/t/1 for the turbo', 'unknown-ref'],
    ['Turbo arrived at Bruckners 11/02', 'unknown-date'],
    ['Turbo actuator back-ordered, parts ETA 11/20', 'unknown-date'],
  ];
  const valid = 'Turbo actuator back-ordered, Parts ETA 11/14 (RO 448901)';
  const b = N6();
  b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: valid }].concat(planted.map(([text]) => ({ units: ['B61003'], text }))) };
  b.vendor1p = { yn: 'Y', details: [{ units: ['B61001'], text: 'TA bay booked for 11/13' }, { units: ['B61001'], text: 'TA Rochester: no diesel tech until 11/12' }] };
  const d = G.validateRowDraft(answer({ barriers: b, etc: [{ unit: 'B61005', state: 'missed', date: '11/08', why: 'Turbo parts ETA 11/20 from dealer' }] }), ctx);
  const r = G.renderCells(d, ctx);
  it('each planted entry is removed with its code', () => {
    const codes = r.removals.filter((x) => x.field === 'partsDetails').map((x) => x.code);
    expect(codes).toEqual(planted.map(([, c]) => c));
    expect(r.removals).toContainEqual({ unit: 'B61001', field: 'vendor1pDetails', code: 'unknown-date' });
  });
  it('valid siblings survive; no planted token reaches a cell', () => {
    expect(r.cells.partsDetails).toBe('\u2022 B61003: ' + valid);
    expect(r.cells.vendor1pDetails).toBe('\u2022 B61001: TA Rochester: no diesel tech until 11/12');
    // Details + Missed ETC (the FAS cell holds code coverage lines quoting real evidence dates).
    const all = G.BARRIERS.map((x) => r.cells[x.detailsCol]).concat(r.cells.missedEtc).join('\n');
    for (const tok of ['B69999', 'T0001', '$4,800', '448999', 'fake.example', '11/02', '11/20', '11/13']) expect(all).not.toContain(tok);
  });
  it('the same planted future date in an ETC why is blanked', () => {
    expect(r.cells.missedEtc).toContain('\u2022 B61005 (ETC 11/8): (no verified reason)');
  });
  it('the same planted future date in a map fact is blanked', () => {
    const m = G.validateMapFacts(answer({ units: [{ unit: 'B61003', barriers: { parts: { hit: true, fact: 'Turbo actuator back-ordered, parts ETA 11/20' } } }] }), ['B61003'], ctx);
    expect(m.units.B61003.barriers.parts).toMatchObject({ hit: true, fact: '' });
  });
});

describe('E4 FAS claims in every field (AC42, AC53, false-positive cost)', () => {
  it('AC42 Details / why / map fact', () => {
    for (const field of ['details', 'etcWhy', 'mapFact']) {
      expect(res('FAS escalated to Volvo regional 11/09', undefined, ['B61002'], field)).toBe('unfounded-fas-action');
      expect(res('FAS escalated to Volvo regional 11/09', env({ fas: [F('11/09', 'escalated to Volvo regional')] }), ['B61011'], field)).toBe('kept');
      expect(res('FAS checked alternate source with Bruckners', {}, ['B61003'], field)).toBe('unfounded-fas-action');
    }
  });
  it('AC53 "I" only as a word', () => {
    expect(res('Volvo I-Shift fault, at MHC Kenworth since 11/03', undefined, ['B61002'])).toBe('kept');
    expect(gate('Volvo I-Shift fault, at MHC Kenworth since 11/03', undefined, ['B61002']).names).toEqual([]);
    expect(res('Towed from I-81 to TA 11/07', undefined, ['B61002'])).toBe('kept');
    expect(res('I called TA 11/10', undefined, ['B61001'])).toBe('unfounded-fas-action');
  });
  it('a dealer-quoted "we" in Details without src is dropped (documented cost)', () => {
    expect(res('Dealer says we are waiting on parts', undefined, ['B61003'])).toBe('unfounded-fas-action');
  });
});

describe('relative dates (AC43)', () => {
  it('dropped outside next: / Support unless the evidence line states it with that date', () => {
    expect(res('Turbo actuator back-ordered, parts arriving Thursday', undefined, ['B61003'])).toBe('unknown-rel-date');
    expect(res('TA bay booked for tomorrow', undefined, ['B61001'])).toBe('unknown-rel-date');
    expect(res('dealer promised ready end of week', undefined, ['B61005'], 'etcWhy')).toBe('unknown-rel-date');
    expect(res('Dealer update 11/11: parts arriving Thursday', undefined, ['B61003'])).toBe('kept');
    expect(res('11/10 called TA; next: call TA Thursday', env({ fas: [F('11/10', 'called TA')] }), ['B61001'], 'fasActions')).toBe('kept');
    expect(res('need parts by Friday', undefined, [], 'support')).toBe('kept');
  });
});

describe('soft flags: names (AC47) and date binding (AC54)', () => {
  it('AC47 unknown name flags, does not drop', () => {
    const b = N6();
    b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo actuator back-ordered at Vanguard' }] };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), ctx), ctx);
    expect(r.cells.partsDetails).toContain('Vanguard');
    expect(r.flags.partsDetails).toBe('review');
    expect(r.unverifiedNames).toEqual([{ name: 'Vanguard', units: ['B61003'], cell: 'partsDetails' }]);
    expect(gate('Turbo actuator back-ordered at Bruckners', undefined, ['B61003']).names).toEqual([]);
  });
  it('AC54 unbound date flags; a bound one, a next: clause and an ETC-phrase date do not', () => {
    const b = N6();
    b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo back-ordered, parts ETA 11/09' }] };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), ctx), ctx);
    expect(r.cells.partsDetails).toContain('parts ETA 11/09');
    expect(r.flags.partsDetails).toBe('review');
    expect(r.unboundDates).toEqual([{ unit: 'B61003', cell: 'partsDetails', date: '11/09', kw: 'eta' }]);
    expect(gate('Turbo back-ordered, parts ETA 11/14', undefined, ['B61003']).unbound).toEqual([]);
    expect(gate('11/10 called dealer re parts; next: confirm parts ETA 11/20', env({ fas: [F('11/10', 'called dealer re parts')] }), ['B61003'], 'fasActions').unbound).toEqual([]);
    expect(gate('Dealer repair ETA 11/13', undefined, ['B61007']).unbound).toEqual([]);
  });
});

describe('validateRowDraft (AC3, AC5, AC7, AC37, AC41, R-N6)', () => {
  it('AC3 Y/N is the AI judgment', () => {
    const b = N6();
    b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo back-ordered, parts ETA 11/14' }] };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), ctx), ctx);
    expect(r.cells.partsYN).toBe('Y');
    expect(r.cells.partsDetails).not.toBe('');
    expect(r.cells.oemYN).toBe('N');
    expect(r.cells.oemDetails).toBe('');
    expect([r.sources.partsYN, r.sources.partsDetails, r.sources.oemYN, r.sources.oemDetails]).toEqual(['ai', 'ai', 'ai', 'ai']);
  });
  it('AC5 Yes with every entry dropped: computed Details when rules say Y, else the ⚠ placeholder', () => {
    const b = N6();
    b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo quote is $4,800 at Bruckners' }] };
    b.partner = { yn: 'Y', details: [{ units: ['B61002'], text: 'Carrier claim RO 999999 still open' }] };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), ctx), ctx);
    expect(ctx.rules.parts.yn).toBe('Y');
    expect(r.cells.partsYN).toBe('Y');
    expect(r.cells.partsDetails).toBe(STD.row.cells.partsDetails);
    expect(r.sources.partsDetails).toBe('computed');
    expect(r.cells.partnerYN).toBe('Y');
    expect(r.cells.partnerDetails).toBe(G.YES_DROPPED_TEXT + 'B61002');
    for (const c of ['partsYN', 'partsDetails', 'partnerYN', 'partnerDetails']) expect(r.flags[c]).toBe('review');
  });
  it('AC37 AI N vs rules Y keeps N and flags the YN cell', () => {
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: N6() }), ctx), ctx);
    expect(r.cells.partsYN).toBe('N');
    expect(r.cells.partsDetails).toBe('');
    expect(r.flags.partsYN).toBe('review');
    expect(r.disagreements).toContain('parts');
  });
  it('barrier-invalid uses the computed Y/N and Details, flagged', () => {
    const b = N6();
    b.oem = { yn: 'maybe', details: [] };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), ctx), ctx);
    expect(r.cells.oemYN).toBe(STD.row.cells.oemYN);
    expect(r.sources.oemYN).toBe('computed');
    expect(r.flags.oemYN).toBe('review');
  });
  it('AC7 hard-cell keys in the AI JSON are ignored', () => {
    const d = G.validateRowDraft(answer({ barriers: N6(), domicileDown: '99', scacUptime: '1%', fasName: 'X', domicile: 'Q', scac: 'Q', cells: { scacDown: '0' } }), ctx);
    const r = G.renderCells(d, ctx);
    expect(Object.keys(r.cells).sort()).toEqual(AI_CELL_IDS.slice().sort());
    for (const h of HARD_CELL_IDS) expect(r.cells).not.toHaveProperty(h);
  });
  it('AC41 string-form details / fasActions are bad-shape', () => {
    const b = N6();
    b.parts = { yn: 'Y', details: 'B61003: turbo back-ordered' };
    const d = G.validateRowDraft(answer({ barriers: b, fasActions: '• B61003: called dealer' }), ctx);
    const r = G.renderCells(d, ctx);
    expect(r.dropReasons['bad-shape']).toBe(2);
    expect(r.flags.partsDetails).toBe('review');
    expect(r.coverageFilled).toEqual(ctx.downIds);
    expect(r.flags.fasActions).toBe('review');
  });
  it('invalid / empty answers', () => {
    expect(G.validateRowDraft('no json here', ctx)).toEqual({ ok: false, code: 'ai-invalid' });
    expect(G.validateRowDraft('[1,2]', ctx).code).toBe('ai-invalid');
    expect(G.validateRowDraft(answer({ fasActions: [] }), ctx).code).toBe('ai-empty');
  });
  it('R-N6: 18 Details entries in single mode -> 16 kept, the losing cell flagged and listed', () => {
    const c = makeCtx({ units: { C10001: { vendor: 'Bruckners' }, C10002: { vendor: 'Bruckners' }, C10003: { vendor: 'Bruckners' } }, today: TODAY }).ctx;
    const b = {};
    for (const id of G.BARRIER_IDS) b[id] = { yn: 'Y', details: ['C10001', 'C10002', 'C10003'].map((u) => ({ units: [u], text: 'waiting on the turbo actuator part' })) };
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: b }), c), c);
    const kept = G.BARRIERS.reduce((s, x) => s + (r.cells[x.detailsCol] ? r.cells[x.detailsCol].split('\n').length : 0), 0);
    expect(kept).toBe(16);
    expect(r.flags.commonDetails).toBe('review');
    expect(r.flags.partsDetails).toBeUndefined();
    expect(r.removals.map(G.removalLine)).toEqual(['C10002 \u00b7 commonDetails \u00b7 over-limit', 'C10003 \u00b7 commonDetails \u00b7 over-limit']);
  });
});

describe('ETC reconciliation (AC6, AC21, AC55, R-N5)', () => {
  const run = (etc) => G.renderCells(G.validateRowDraft(answer({ barriers: N6(), etc }), ctx), ctx);
  it('AC6 code reclassifies from the date; an unknown date falls back to parseEtc; counts are whole numbers', () => {
    const d = G.validateRowDraft(answer({ barriers: N6(), etc: [{ unit: 'B61007', state: 'today', date: '11/13' }, { unit: 'B61004', state: 'missed', date: '11/02' }] }), ctx);
    const r = G.renderCells(d, ctx);
    expect(r.etcUnits.find((u) => u.unit === 'B61007')).toMatchObject({ state: 'future', date: '11/13', origin: 'ai' });
    expect(r.etcUnits.find((u) => u.unit === 'B61004')).toMatchObject({ state: 'future', date: '11/14', origin: 'code' });
    expect(d.meta.etcReconciled).toMatchObject({ reclassified: 1, dateUnknown: 1 });
    const counts = { today: 0, missed: 0, none: 0 };
    for (const u of r.etcUnits) if (u.state in counts) counts[u.state] += 1;
    expect(r.cells.etcToday).toBe(String(counts.today));
    expect(r.cells.noEtc).toBe(String(counts.none));
    expect(r.cells.missedEtc.split('\n')[0]).toBe(String(counts.missed));
    expect(r.cells.etcToday).toMatch(/^\d+$/);
  });
  it('AC21 a past event or a parts ETA is never an ETC (code parseEtc wins)', () => {
    const d = G.validateRowDraft(answer({ barriers: N6(), etc: [{ unit: 'B61006', state: 'missed', date: '11/05' }, { unit: 'B61003', state: 'future', date: '11/14' }] }), ctx);
    const r = G.renderCells(d, ctx);
    expect(d.meta.etcReconciled.dateUnknown).toBe(2);
    expect(r.etcUnits.find((u) => u.unit === 'B61006').state).toBe('none');
    expect(r.etcUnits.find((u) => u.unit === 'B61003').state).toBe('none');
  });
  it('AC21 superseded: the AI date stands, etcDisagreements, and R-N5 flags the gaining cell', () => {
    const r = run([{ unit: 'B61004', state: 'missed', date: '11/08', why: 'Dealer moved the job; ETC 11/08 passed' }]);
    expect(r.etcUnits.find((u) => u.unit === 'B61004')).toMatchObject({ state: 'missed', date: '11/8', origin: 'ai' });
    expect(r.etcDisagreements).toEqual([{ unit: 'B61004', ai: '11/08', code: '11/14' }]);
    expect(r.flags.missedEtc).toBe('review');
  });
  it('R-N5 a same-bucket disagreement is not flagged', () => {
    const r = run([{ unit: 'B61010', state: 'future', date: '11/15' }]);
    expect(r.etcDisagreements).toEqual([{ unit: 'B61010', ai: '11/15', code: '11/18' }]);
    expect(r.flags.missedEtc).toBeUndefined();
    expect(r.flags.etcToday).toBeUndefined();
    expect(r.flags.noEtc).toBeUndefined();
  });
  it('AC21 / AC55 cancelled ETC: accepted with a gated why, recorded in etcOverrides, no flag', () => {
    const r = run([{ unit: 'B61005', state: 'none', date: '', why: 'ETC 11/08 cancelled, waiting on parts' }]);
    expect(r.etcUnits.find((u) => u.unit === 'B61005')).toMatchObject({ state: 'none', origin: 'ai', why: 'ETC 11/08 cancelled, waiting on parts' });
    expect(r.etcOverrides).toEqual([{ unit: 'B61005', code: '11/08' }]);
    expect(r.etcDisagreements).toEqual([]);
    expect(r.cells.missedEtc).not.toContain('B61005');
    expect(r.flags.noEtc).toBeUndefined();
    expect(r.flags.missedEtc).toBeUndefined();
  });
  it('AC21 cancelled siblings: code parseEtc wins (Missed with the builder snippet, no override)', () => {
    for (const why of ['', 'ETC 11/08 cancelled; FAS escalated to dealer 11/10', 'ETC 11/08 cancelled 11/09']) {
      const r = run([{ unit: 'B61005', state: 'none', date: '', why }]);
      expect(r.etcUnits.find((u) => u.unit === 'B61005')).toMatchObject({ state: 'missed', origin: 'code' });
      expect(r.etcOverrides).toEqual([]);
      expect(r.cells.missedEtc).toMatch(/\u2022 B61005 \(ETC 11\/8\): '.+'/);
    }
    const d = G.validateRowDraft(answer({ barriers: N6(), etc: [{ unit: 'B61005', state: 'none', why: 'ETC 11/08 cancelled; FAS escalated to dealer 11/10' }] }), ctx);
    expect(d.meta.dropReasons['unfounded-fas-action']).toBe(1);
  });
  it('AC21 code-origin missed unit renders the builder snippet; an AI why for another date is not used', () => {
    const r = run([{ unit: 'B61005', state: 'missed', date: '11/02', why: 'Dealer update 11/10: waiting on parts' }]);
    const line = r.cells.missedEtc.split('\n').find((l) => l.includes('B61005'));
    expect(line).toMatch(/^\u2022 B61005 \(ETC 11\/8\): '.*ETC 11\/08.*'$/);
    expect(line).not.toContain('waiting on parts');
  });
  it('etc not an array: the whole ETC block is computed and flagged', () => {
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: N6(), etc: 'none' }), ctx), ctx);
    expect([r.sources.etcToday, r.sources.noEtc, r.sources.missedEtc]).toEqual(['computed', 'computed', 'computed']);
    expect([r.flags.etcToday, r.flags.noEtc, r.flags.missedEtc]).toEqual(['review', 'review', 'review']);
  });
});

describe('Support (AC24, AC52)', () => {
  const sup = (support) => G.renderCells(G.validateRowDraft(answer({ barriers: N6(), support }), ctx), ctx);
  it('AC52 kept asks', () => {
    const r = sup([
      { team: 'MCS', ask: 'We need MCS approval on B61002 estimate', units: ['B61002'] },
      { team: 'Uptime Manager', ask: 'I need UM help escalating Volvo on B61002', units: ['B61002'] },
      { team: 'OEM/dealer', ask: 'Our dealer has no bay until 11/21', units: [] },
    ]);
    expect(r.cells.support.split('\n')).toHaveLength(3);
    expect(r.flags.support).toBeUndefined();
    expect(r.cells.support.split('\n')[0]).toBe('\u2022 MCS: We need MCS approval on B61002 estimate (B61002)');
  });
  it('AC52 all asks gated -> ⚠ text and flag; "None" / [] -> None', () => {
    const r = sup([{ team: 'MCS', ask: 'We escalated to Volvo 11/09' }, { team: 'MCS', ask: 'Escalated to Volvo 11/09' }]);
    expect(r.cells.support).toBe(G.SUPPORT_FAILED_TEXT);
    expect(r.flags.support).toBe('review');
    expect(r.dropReasons['unfounded-fas-action']).toBe(2);
    for (const v of ['None', []]) {
      const n = sup(v);
      expect(n.cells.support).toBe('None');
      expect(n.flags.support).toBeUndefined();
    }
  });
  it('AC24 a free-text team renders as Other', () => {
    expect(sup([{ team: 'B61003 dealer', ask: 'Need the turbo sourced from another dealer', units: ['B61003'] }]).cells.support)
      .toBe('\u2022 Other: Need the turbo sourced from another dealer (B61003)');
  });
});

describe('validateMapFacts (§5.3a, AC24)', () => {
  const m = G.validateMapFacts(answer({ units: [
    { unit: 'B61003', component: 'Engine/turbo', barriers: { parts: { hit: true, fact: 'Turbo back-ordered, Parts ETA 11/14' }, estimate: { hit: 'Y', fact: 'Quote of $4,800 pending' } },
      etc: { state: 'future', date: '11/14', why: '' },
      fasAction: { text: '11/10 checked alternate source with Bruckners Syracuse; next: call Bruckners', src: env({ fas: [F('11/10', 'checked alternate source with Bruckners')] }) },
      support: [{ team: 'Parts', ask: 'Need the turbo sourced from another dealer' }] },
    { unit: 'B61001', component: 'Engine', fasAction: { text: 'No FAS action logged; waiting on TA' } },
    { unit: 'B61007', component: 'RO 448901 brakes 11/10', fasAction: '11/10 called dealer' },
  ] }), ['B61003', 'B61002', 'B61007'], ctx);
  it('gates facts, keeps hit, blanks a fake $', () => {
    expect(m.ok).toBe(true);
    expect(m.units.B61003.component).toBe('Engine/turbo');
    expect(m.units.B61003.barriers.parts).toMatchObject({ hit: true, fact: 'Turbo back-ordered, Parts ETA 11/14' });
    expect(m.units.B61003.barriers.estimate).toMatchObject({ hit: true, fact: '' });
    expect(m.units.B61003.fasAction.text).toContain('checked alternate source');
    expect(m.units.B61003.fasItems).toEqual([{ date: '11/10', quote: 'checked alternate source with Bruckners' }]);
    expect(m.units.B61003.support).toHaveLength(1);
  });
  it('batch scope, missing units, string fasAction, token-bearing component', () => {
    expect(m.units.B61001).toBeUndefined();
    expect(m.meta.dropReasons['no-unit']).toBe(1);
    expect(m.units.B61002.missing).toBe(true);
    expect(m.units.B61007.fasAction).toBeNull();
    expect(m.meta.dropReasons['bad-shape']).toBe(1);
    expect(m.units.B61007.component).toBe('');
  });
  it('etc reconciled per unit (a parts ETA is not an ETC)', () => {
    expect(m.units.B61003.etc).toMatchObject({ state: 'none', origin: 'code' });
    expect(m.units.B61007.etc).toMatchObject({ state: 'future', origin: 'code' });
  });
  it('not an object / units not an array -> ai-invalid', () => {
    expect(G.validateMapFacts('nope', ['B61003'], ctx).code).toBe('ai-invalid');
    expect(G.validateMapFacts(answer({ units: {} }), ['B61003'], ctx).code).toBe('ai-invalid');
  });
});

describe('mergeFinal (AC23) and review-mr', () => {
  const draftAns = () => {
    const b = N6();
    b.parts = { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo back-ordered, Parts ETA 11/14' }] };
    b.vendor1p = { yn: 'Y', details: [{ units: ['B61001'], text: 'TA Rochester: no diesel tech until 11/12' }] };
    return {
      barriers: b,
      etc: [{ unit: 'B61001', state: 'none', why: '' }, { unit: 'B61007', state: 'future', date: '11/13' }],
      fasActions: [
        { unit: 'B61001', text: '11/10 called TA re tech callout; next: confirm tech', src: env({ fas: [F('11/10', 'called TA re tech callout')] }) },
        { unit: 'B61003', text: 'No FAS action logged; turbo back-ordered at Bruckners; next: call Bruckners' },
      ],
      support: 'None',
    };
  };
  const cur = G.validateRowDraft(answer(draftAns()), ctx);
  it('a review that omits unit X keeps X\'s FAS line and ETC entry with no ⚠', () => {
    const a = draftAns();
    a.fasActions = a.fasActions.filter((f) => f.unit !== 'B61001');
    a.etc = a.etc.filter((e) => e.unit !== 'B61001');
    const next = G.validateRowDraft(answer(a), ctx);
    const r = G.renderCells(G.mergeFinal(cur, next, 'single'), ctx);
    expect(r.cells.fasActions).toContain('\u2022 B61001: 11/10 called TA re tech callout');
    expect(r.coverageFilled).not.toContain('B61001');
    expect(r.etcUnits.find((u) => u.unit === 'B61001').origin).toBe('ai');
  });
  it('a review N flips the barrier; a review Y with every entry dropped keeps cur\'s entries', () => {
    const a = draftAns();
    a.barriers.parts = { yn: 'N', details: [] };
    a.barriers.vendor1p = { yn: 'Y', details: [{ units: ['B61001'], text: 'TA Rochester bay booked for 11/30' }] };
    const r = G.renderCells(G.mergeFinal(cur, G.validateRowDraft(answer(a), ctx), 'single'), ctx);
    expect(r.cells.partsYN).toBe('N');
    expect(r.cells.partsDetails).toBe('');
    expect(r.cells.vendor1pDetails).toBe('\u2022 B61001: TA Rochester: no diesel tech until 11/12');
    expect(r.flags.vendor1pDetails).toBeUndefined();
  });
  it('review-mr: fasActions only for gap units (others counted not-gap); map entries kept', () => {
    const next = G.validateRowDraft(answer({ barriers: N6(), fasActions: [
      { unit: 'B61002', text: 'No FAS action logged; at MHC Kenworth since 11/03; next: call dealer' },
      { unit: 'B61001', text: 'No FAS action logged; rewritten line' },
    ] }), ctx, { kind: 'review-mr', gapUnits: ['B61002'] });
    expect(next.meta.notGap).toBe(1);
    const merged = G.mergeFinal(cur, next, 'mapreduce');
    expect(merged.fas.B61002.text).toContain('MHC Kenworth');
    expect(merged.fas.B61001.text).toContain('called TA re tech callout');
  });
});

describe('coverage (AC2 basis, AC25, AC38, AC50)', () => {
  it('AC38 / AC50 coverage line is redacted and has no [em:] marker', () => {
    const c = makeCtx({ units: { D10001: { vendor: 'TA', savedRepairStatus: 'Waiting for vendor', repairTimeline: '11/09 - old line\n11/11 - emailed a.b@c.com, call 555-123-4567 [em:1a2b3c4d]' } }, today: TODAY }).ctx;
    const r = G.renderCells(G.validateRowDraft(answer({ barriers: N6() }), c), c);
    expect(r.cells.fasActions).toMatch(/^\u2022 D10001: \u26a0 no verified AI line \u2014 /);
    expect(r.cells.fasActions).toContain('[redacted]');
    expect(r.cells.fasActions).not.toContain('a.b@c.com');
    expect(r.cells.fasActions).not.toContain('555-123-4567');
    expect(r.cells.fasActions).not.toContain('[em:');
    expect(r.cells.fasActions).toContain('latest: 11/11 - emailed');
    expect(r.flags.fasActions).toBe('review');
    expect(r.coverageFilled).toEqual(['D10001']);
  });
  it('AC25 two (no id) units get two lines', () => {
    const s = makeCtx({ units: [{ equipmentId: '', vendor: 'TA' }, { equipmentId: '', vendor: 'COX' }], today: TODAY });
    expect(s.ctx.downIds).toEqual(['(no id #1)', '(no id #2)']);
    const d = G.validateRowDraft(answer({ barriers: N6(), fasActions: [{ unit: '(no id #2)', text: 'No FAS action logged; unit waiting at the yard' }] }), s.ctx);
    const lines = G.renderCells(d, s.ctx).cells.fasActions.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\u2022 \(no id #1\): \u26a0/);
    expect(lines[1]).toBe('\u2022 (no id #2): No FAS action logged; unit waiting at the yard');
  });
});

describe('renderCells length bounds (AC17, AC48)', () => {
  const big = (n) => {
    const ids = Array.from({ length: n }, (_, i) => 'TRK' + String(i).padStart(9, '0'));
    const units = ids.map((id) => ({ id, daysDown: 30, status: 'S'.repeat(200), vendor: 'V'.repeat(200), etc: { state: 'missed', date: '2026-11-01', snippet: 'x' } }));
    const c = G.gateContext({ row: { units, cells: {} }, evidences: [], fleetIds: [], today: TODAY });
    const entries = ids.map((id) => ({ units: [id], text: 'w'.repeat(400), fas: [], names: [], unbound: [] }));
    const barriers = {};
    for (const b of G.BARRIER_IDS) barriers[b] = { valid: true, yn: 'Y', entries, cited: [], overLimit: false };
    const etc = {};
    const fas = {};
    ids.forEach((id, i) => {
      etc[id] = { state: 'missed', date: '2026-11-01', why: 'y'.repeat(300), origin: 'ai' };
      if (i >= 30) fas[id] = { text: 'f'.repeat(320), fas: [{ date: '11/10', quote: 'secret quote text' }], names: [], unbound: [] };
    });
    const support = { mode: 'list', entries: Array.from({ length: 8 }, () => ({ team: 'Other', ask: 'a'.repeat(200), units: ids.slice(0, 2), names: [], unbound: [] })) };
    return { c, ids, r: G.renderCells({ barriers, etc, fas, support, fasDropped: {} }, c) };
  };
  for (const n of [96, 120]) {
    it('n = ' + n + ': every unit line kept, every cell <= 16,000', () => {
      const { ids, r } = big(n);
      const fl = r.cells.fasActions.split('\n');
      expect(fl).toHaveLength(n);
      ids.forEach((id, i) => expect(fl[i].startsWith('\u2022 ' + id + ': ')).toBe(true));
      expect(r.coverageFilled).toHaveLength(30);
      expect(r.cells.partsDetails.split('\n')).toHaveLength(n);
      expect(r.cells.missedEtc.split('\n')).toHaveLength(n + 1);
      for (const v of Object.values(r.cells)) expect(v.length).toBeLessThanOrEqual(16000);
      expect(Object.values(r.cells).join('\n')).not.toContain('secret quote text');
    });
  }
});

describe('§3 example evidence fixture (AC46 basis)', () => {
  const s = makeCtx({ units: X.UNITS, enrich: X.ENRICH, today: X.TODAY, fasNames: X.FAS_NAMES });
  it('the row example passes with 0 drops, 0 name flags, 0 unbound dates, 0 envOver; comma form too', () => {
    const ans = {
      barriers: {
        vendor1p: { yn: 'Y', details: [{ units: ['B61001'], text: 'TA Rochester: no diesel tech until 11/12, bay confirmed for 11/12. FAS called TA 11/10 for a callout tech.', src: env({ fas: [F('11/10', 'called TA re tech callout')] }) }] },
        oem: { yn: 'Y', details: [{ units: ['B61002'], text: 'Volvo (ASIST) / MHC Kenworth: no dealer status since drop-off 11/03; ASIST case 7712345 open, RO 448812 under diagnosis.' }] },
        estimate: { yn: 'N', details: [] },
        partner: { yn: 'Y', details: [{ units: ['B61009'], text: 'Accident unit: CEI claim opened 11/07; carrier has not released the unit for repair.' }] },
        parts: { yn: 'Y', details: [{ units: ['B61003'], text: 'Turbo actuator back-ordered at Bruckners, parts ETA 11/14 (RO 448901). FAS checked alternate source with Bruckners Syracuse 11/10, none in stock.', src: env({ fas: [F('11/10', 'checked alternate source with Bruckners')] }) }] },
        common: { yn: 'N', details: [] },
      },
      etc: [
        { unit: 'B61001', state: 'future', date: '11/12', why: '' },
        { unit: 'B61004', state: 'missed', date: '11/08', why: 'Dealer update 11/11: still waiting on EGR cooler; ETC 11/08 passed.' },
        { unit: 'B61002', state: 'none', date: '', why: '' },
      ],
      fasActions: [
        { unit: 'B61001', text: '11/10 called TA for a callout tech; TA update 11/10: bay confirmed for 11/12; next: confirm tech on site 11/12 AM.', src: env({ fas: [F('11/10', 'called TA re tech callout')] }) },
        { unit: 'B61002', text: '11/09 escalated ASIST case 7712345 (no dealer status since 11/03); next: follow up with the MHC Kenworth service writer for the diag result.', src: env({ fas: [F('11/09', 'escalated ASIST case 7712345')] }) },
        { unit: 'B61004', text: 'No FAS action logged; Dealer update 11/11: waiting on EGR cooler, ETC 11/08 missed; next: call dealer for a new ETC.' },
      ],
      support: [{ team: 'OEM/dealer', ask: 'Dealer escalation for diag status on B61002 (no status since 11/03)', units: ['B61002'] }],
    };
    const d = G.validateRowDraft(answer(ans), s.ctx);
    const r = G.renderCells(d, s.ctx);
    expect(r.removals).toEqual([]);
    expect(r.unverifiedNames).toEqual([]);
    expect(r.unboundDates).toEqual([]);
    expect(r.envOver).toBe(0);
    expect(r.etcDisagreements).toEqual([]);
    const comma = G.gateEntry('11/10 called TA, bay confirmed for 11/12', env({ fas: [F('11/10', 'called TA re tech callout')] }), ['B61001'], s.ctx, { field: 'fasActions' });
    expect(comma).toMatchObject({ ok: true, names: [], unbound: [] });
  });
});
