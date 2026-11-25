// AC8: a ROC5|AUVTE-shaped synthetic pair (14 down, timelines up to ~5k, conversations, ASIST
// notes, enrich docs) through draftRow with a realistic mocked answer carrying planted
// fabrications. Mode is asserted by the plan rule (R-N7), not hard-coded.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Fd = require('../src/dbr/fleet-dbr');
const EV = require('../src/dbr/fleet-dbr-evidence');
const AI = require('../src/dbr/fleet-dbr-ai');
const R = require('./fixtures/fleet-dbr/roc5-auvte-like');

function kindOf(p) {
  if (p.includes('REVIEW CHECKLIST')) return p.includes(AI.FACTS_OPEN) ? 'review-mr' : 'review';
  if (p.includes('MAP BATCH')) return 'map';
  if (p.includes('REDUCE CONTRACT')) return 'reduce';
  return 'single';
}
const idsIn = (p) => /DOWN UNITS \(\d+\): ([^\n]*)/.exec(p)[1].split(', ');

function setup() {
  const down = R.rows();
  const all = down.concat(R.upRows());
  const built = Fd.buildFleetDbr(all, { today: R.TODAY });
  const row = built.rows.find((r) => r.key === R.KEY);
  const args = { row, unitRows: down, built, enrich: R.enrich(), fasNames: R.FAS_NAMES, fasAlias: R.FAS_ALIAS, fleetIds: R.FLEET_IDS, today: R.TODAY };
  return { row, args };
}

describe('ROC5|AUVTE-shaped pair (AC8)', () => {
  it('drafts all 14 units with every prompt <= 56,000 and no planted token in any cell', async () => {
    const { row, args } = setup();
    expect(row.units).toHaveLength(14);
    const ctx = AI.draftContext(args);
    const demand = ctx.evidences.reduce((s, e) => s + e.demand, 0);
    const expected = ctx.n <= EV.SINGLE_MAX_UNITS && demand <= 41400 ? 'single' : 'mapreduce';
    expect(ctx.mode).toBe(expected);
    expect(ctx.demand).toBe(demand);

    const prompts = [];
    const kinds = [];
    const ask = async (p, o) => {
      prompts.push(p);
      kinds.push(kindOf(p));
      expect(o.timeoutMs).toBeGreaterThanOrEqual(AI.MIN_CALL_MS);
      return JSON.stringify(R.ANSWER(kindOf(p), idsIn(p)));
    };
    const r = await AI.draftRow(Object.assign({ ask }, args));
    expect(r.ok).toBe(true);
    expect(r.mode).toBe(expected);
    expect(r.demand).toBe(demand);
    for (const p of prompts) expect(p.length).toBeLessThanOrEqual(AI.CALL_PROMPT_MAX);

    // every unit ID with its newest timeline line and newest conversation entry is in the evidence prompt(s)
    const evPrompts = prompts.filter((p, i) => kinds[i] === 'single' || kinds[i] === 'map').join('\n');
    for (const u of row.units) {
      expect(evPrompts).toContain('[' + u.id + ']');
      expect(evPrompts).toContain(R.NEWEST[u.id].timeline);
      expect(evPrompts).toContain(R.NEWEST[u.id].conversation);
    }
    expect(evPrompts).toContain('[FAS] 11/11 - ' + R.FAS_ALIAS + ': called');
    expect(evPrompts).toContain('ASIST case 7712001 open');

    // 14 FAS lines in builder order; the 3 planted FAS claims became code ⚠ lines
    const lines = r.cells.fasActions.split('\n');
    expect(lines).toHaveLength(14);
    lines.forEach((l, i) => expect(l.startsWith('• ' + row.units[i].id + ': ')).toBe(true));
    for (const id of R.PLANTED_FAS_UNITS) expect(lines.find((l) => l.startsWith('• ' + id + ': '))).toContain('\u26a0');
    expect(r.flags.fasActions).toBe('review');
    expect(lines.filter((l) => l.includes('11/10 called'))).toHaveLength(11);

    // no planted token survives in any of the 17 cells
    expect(Object.keys(r.cells).sort()).toEqual([...Fd.AI_CELL_IDS].sort());
    for (const v of Object.values(r.cells)) for (const tok of R.PLANTED) expect(v).not.toContain(tok);
    // valid siblings survive
    expect(r.cells.oemDetails).toContain('ASIST case 7712001 open, RO 448101 under diagnosis');
    expect(r.cells.partsDetails).toContain('Turbo on order at COX');
    expect(r.cells.partnerDetails.split('\n')).toHaveLength(2);
    expect(r.cells.support).toBe('\u2022 MCS: MCS approval on the B90101 estimate (B90101)');
    // ETC: code owns the counts
    expect(r.cells.etcToday).toBe('1');
    expect(r.cells.missedEtc.split('\n')[0]).toBe('3');
    expect(r.cells.missedEtc).toContain('\u2022 B90105 (ETC 11/9): (no verified reason)');

    // the 7 hard cells equal the builder's through the real overlay, even when the stored draft
    // carries hard-cell keys (domicileDown / scacUptime / fasName are ignored by the whitelist)
    const d = {
      version: 2, unitsHash: row.unitsHash, evidenceHash: row.evidenceHash, draftedAt: 'X', flags: r.flags,
      cells: Object.assign({}, r.cells, { domicileDown: '999', scacUptime: '1%', fasName: 'Evil' }),
    };
    const ov = Fd.applyOverlays(args.built, { drafts: { [R.KEY]: d }, flags: { aiDraft: true } }).rows.find((x) => x.key === R.KEY);
    for (const h of Fd.HARD_CELL_IDS) expect(ov.cells[h], h).toBe(h === 'fasName' ? '' : row.cells[h]);
    for (const id of Fd.AI_CELL_IDS) expect(ov.cells[id], id).toBe(r.cells[id]);
    expect(ov.draft.state).toBe('ok');
    // Golden 1P rule: any COX unit is a 1P hit; "Cannot Complete — Parts Ordered" is not read as a rejection
    expect(row.units.find((u) => u.id === 'B90103').barriers).toContain('vendor1p');
    expect(row.units.find((u) => u.id === 'B90103').why.vendor1p).not.toMatch(/can't complete/);
  });
});
