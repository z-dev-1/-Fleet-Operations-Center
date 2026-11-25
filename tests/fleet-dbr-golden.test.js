// tests/fleet-dbr-golden.test.js — golden regression for the Fleet Health sheet (design §9, §10
// AC1/AC2/AC9/AC17, DR2-7). Builds the real builder + overlays (roster stub, no drafts, fixed
// today) and copies through the renderer logic, then compares with:
//   - the two golden sheets (fixtures/fleet-health/golden-2026-11-11.js / -11-12.js: synthetic rows
//     derived from the goldens, expected rows copied in; documented Q4 grain deviations only);
//   - the anonymized real rows of 2026-11-25 (fixtures/fleet-health/real-2026-11-25.json, built by
//     scripts/fleet-health-fixture.js) against the design §8 table and the §3.2 unit buckets.
// Any change to a golden hard cell, Y/N or count fails here.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
const L = await import('../renderer/src/js/views/fleet-dbr-logic.js');
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const G = require('../src/dbr/fleet-dbr-gate');
const G11 = require('./fixtures/fleet-health/golden-2026-11-11');
const G12 = require('./fixtures/fleet-health/golden-2026-11-12');
const REAL = require('./fixtures/fleet-health/real-2026-11-25.json');

const YN_IDS = F.COLUMNS.map((c) => c.id).filter((id) => /YN$/.test(id));
const COUNT_IDS = ['etcToday', 'noEtc', 'missedEtc'];
const DETAILS_IDS = F.COLUMNS.map((c) => c.id).filter((id) => /Details$/.test(id));
const PROSE_IDS = [...DETAILS_IDS, 'fasActions', 'support'];
const COMMON_LABELS = [...F.SYSTEM_GROUPS.map(([label]) => label), 'Repeat repair'];

function buildModel(fx) {
  const built = F.buildFleetDbr(fx.rows, { today: fx.today });
  return F.applyOverlays(built, {
    today: fx.today, fasNameOverride: fx.userName, rosterExact: fx.rosterExact, rosterLoaded: true,
    rosterFas: {}, edits: {}, drafts: {}, flags: { aiDraft: false },
  });
}
const keyOf = (g) => g.Domicile + '|' + g.SCAC;
const rowOf = (model, key) => model.rows.find((r) => r.key === key);
const copied = (row, id) => L.sheetValue(id, row.cells[id], row.source[id]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, id) => new RegExp('(?<![A-Za-z0-9])' + esc(id) + '(?![A-Za-z0-9])').test(String(text || ''));
const idsIn = (text, ids) => ids.filter((id) => mentions(text, id)).sort();
const downIdsOf = (fx) => fx.rows.filter((r) => F.isDown(r)).map((r) => String(r.equipmentId));
// The text of one "Label: …" group of a Common Repairs cell (up to the next group label).
function groupSegment(text, label) {
  const s = String(text || '');
  const at = s.indexOf(label);
  if (at < 0) return null;
  let end = s.length;
  for (const other of COMMON_LABELS) {
    if (other === label) continue;
    const k = s.indexOf(other, at + label.length);
    if (k >= 0 && k < end) end = k;
  }
  return s.slice(at, end);
}

beforeAll(() => { vi.stubEnv('TZ', 'America/New_York'); });
afterAll(() => { vi.unstubAllEnvs(); });

describe.each([['2026-11-11', G11], ['2026-11-12', G12]])('golden %s', (day, fx) => {
  const model = buildModel(fx);
  const allDown = downIdsOf(fx);

  it('(1) hard cells, 6 Y/N and 3 counts equal the golden row (documented AGNLI NO ETC grain deviation only)', () => {
    expect(fx.expected).toHaveLength(4);
    for (const g of fx.expected) {
      const row = rowOf(model, keyOf(g));
      expect(row, keyOf(g)).toBeTruthy();
      const dev = fx.deviations[keyOf(g)] || {};
      for (const id of [...F.HARD_CELL_IDS, ...YN_IDS, ...COUNT_IDS]) {
        const col = F.COLUMNS.find((c) => c.id === id);
        let want = String(g[col.header]);
        if (id === 'noEtc' && dev.noEtc !== undefined) {
          // Q4: the golden counts AGNLI SCAC-wide (39339 at ABE40); the builder keeps Domicile x SCAC.
          expect(want).toBe('4');
          want = dev.noEtc;
        }
        expect(copied(row, id), keyOf(g) + ' ' + col.header).toBe(want);
      }
    }
  });

  it('(2) format and order (roster stub; row-set rule depends on Q1)', () => {
    const rows = L.copyRows(model, 'mine', false, []);
    const tsv = L.sheetTsv(model.columns, rows, undefined, { header: true });
    const lines = tsv.split('\n');
    expect(lines[0]).toBe(fx.headers.join('\t'));
    expect(model.columns.map((c) => c.header)).toEqual(fx.headers);
    expect(lines).toHaveLength(5);
    expect(rows.map((r) => r.key)).toEqual(fx.expected.map(keyOf));
    expect(tsv).not.toMatch(/[\r\u2022]/);
    for (const line of lines.slice(1)) {
      const cells = line.split('\t');
      expect(cells).toHaveLength(24);
      const by = Object.fromEntries(model.columns.map((c, i) => [c.id, cells[i]]));
      for (const id of YN_IDS) expect(['Yes', 'No']).toContain(by[id]);
      for (const id of ['domicileUptime', 'scacUptime']) expect(by[id]).toMatch(/^\d+(\.\d)?$/);
      for (const id of COUNT_IDS) expect(by[id]).toMatch(/^\d+$/);
      expect(by.fasName).toBe('Z Santiago');
    }
  });

  it('(3) composer Details per column: golden units of the cell within the pair, golden vendor lead, single-line and clean', () => {
    for (const g of fx.expected) {
      const key = keyOf(g);
      const row = rowOf(model, key);
      const pairDown = row.units.map((u) => u.id);
      const dev = fx.deviations[key] || {};
      for (const id of PROSE_IDS) {
        const text = row.cells[id];
        expect(text, key + ' ' + id).not.toMatch(/[\n\r]/);
        const max = id === 'fasActions' ? G.SHEET_FAS_MAX : (id === 'support' ? G.SHEET_SUPPORT_MAX : G.SHEET_DETAILS_MAX);
        expect(text.length, key + ' ' + id).toBeLessThanOrEqual(max);
        expect(G.sheetForbidden(text, pairDown), key + ' ' + id).toBeNull();
      }
      for (const id of DETAILS_IDS) {
        const col = F.COLUMNS.find((c) => c.id === id);
        const golden = String(g[col.header] || '');
        const text = row.cells[id];
        if (!golden) { expect(text, key + ' ' + id).toBe(''); continue; }
        if (id === 'commonDetails') {
          for (const label of COMMON_LABELS) {
            const gs = groupSegment(golden, label);
            if (gs === null) continue;
            const cs = groupSegment(text, label);
            expect(cs, key + ' Common label ' + label).not.toBeNull();
            const want = idsIn(gs, allDown).filter((u) => pairDown.includes(u));
            for (const u of want) expect(idsIn(cs, allDown), key + ' ' + label).toContain(u);
          }
          continue;
        }
        const goldenUnits = idsIn(golden, allDown);
        for (const u of dev.notInPair || []) {
          // Q4: the golden names 39339 (domicile ABE40); it is outside this Domicile x SCAC pair.
          if (goldenUnits.includes(u)) expect(mentions(text, u), key + ' ' + id + ' ' + u).toBe(false);
        }
        expect(idsIn(text, allDown), key + ' ' + id).toEqual(goldenUnits.filter((u) => pairDown.includes(u)));
        const lead = (fx.leads[key] || {})[id];
        if (lead) expect(text.startsWith(lead), key + ' ' + id + ': ' + text).toBe(true);
      }
    }
  });

  it('(6) I1: ETC Today + NO ETC + Missed = pair units down on every row', () => {
    for (const r of model.rows) {
      expect(Number(r.cells.etcToday) + Number(r.cells.noEtc) + Number(r.cells.missedEtc), r.key).toBe(r.pair.down);
      expect(r.etcInvariant, r.key).toBe(true);
    }
  });
});

// Design §8 "after" values for the user's 9 pairs with units down (frozen data 2026-11-25),
// in the default copy order. Y/N order: 1P, OEM, Estimate, Partner, Parts, Common.
const SECTION_8 = [
  ['ROC5|AUVTE', 'YYNYYY', '0/9/0', ['69', '9', '69', '9']],
  ['ABE40|TUZR', 'YYNNYN', '1/7/0', ['84', '13', '84.5', '11']],
  ['ABE40|SAPB', 'YNNNYY', '2/3/0', ['84', '13', '82.9', '7']],
  ['EOFE01|EOFE', 'YYNNYN', '0/2/0', ['83.3', '2', '84.6', '2']],
  ['HBD1|AKJJI', 'YNNNYN', '0/2/0', ['80', '2', '80', '2']],
  ['MIMY01|MIMY', 'NNNNNN', '0/2/0', ['86.7', '2', '84.6', '2']],
  ['AVP40|AGNLI', 'NYNNNN', '0/1/0', ['91.5', '4', '90', '1']],
  ['AVP40|YTSC', 'YNYNNN', '0/1/0', ['91.5', '4', '93.3', '1']],
  ['UNNE01|UNNE', 'NNNNNN', '0/1/0', ['91.7', '1', '92.3', '1']],
];
// Design §3.2 example table: unit -> [bucket, reason].
const UNIT_BUCKETS = {
  B12195: ['none', 'newer-negation'], B12261: ['none', 'not-started'], B62020: ['none', 'newer-negation'],
  B62049: ['none', 'newer-negation'], 320170: ['today', 'etc-today'], 521008: ['today', 'etc-today'],
  321549: ['today', 'etc-today'], 321938: ['none', 'future'], 322468: ['none', 'future'],
};

describe('real fixture 2026-11-25 (anonymized frozen data)', () => {
  const fx = { today: REAL.meta.today, userName: REAL.roster.userName, rosterExact: REAL.roster.rosterExact, rows: REAL.rows };
  const model = buildModel(fx);

  it('the fixture is anonymized and trimmed', () => {
    const s = JSON.stringify(REAL.rows);
    expect(s).not.toMatch(/\S+@\S+\.\S+/);
    expect(s).not.toMatch(/(?<![\w-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/);
    expect(s).not.toMatch(/fullConversation/);
    for (const r of REAL.rows) if (r.repairTimeline) expect(r.repairTimeline.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('(4) reproduces the §8 table cell for cell and the §3.2 unit buckets', () => {
    for (const [key, yn, counts, hard] of SECTION_8) {
      const row = rowOf(model, key);
      expect(row, key).toBeTruthy();
      expect(row.mine, key).toBe(true);
      expect(YN_IDS.map((id) => copied(row, id)[0]).join(''), key).toBe(yn);
      expect(COUNT_IDS.map((id) => copied(row, id)).join('/'), key).toBe(counts);
      expect(['domicileUptime', 'domicileDown', 'scacUptime', 'scacDown'].map((id) => copied(row, id)), key).toEqual(hard);
      expect(copied(row, 'fasName'), key).toBe('Z Santiago');
    }
    const units = new Map(model.rows.flatMap((r) => r.units).map((u) => [u.id, u]));
    for (const [id, [bucket, reason]] of Object.entries(UNIT_BUCKETS)) {
      const u = units.get(id);
      expect(u, id).toBeTruthy();
      expect([u.etc.bucket, u.etc.bucketReason], id).toEqual([bucket, reason]);
    }
  });

  it('(5) default copy = header + the 9 rows in §8 order; visible scope = all rows, mine first', () => {
    const mine = L.copyRows(model, 'mine', false, []);
    expect(mine.map((r) => r.key)).toEqual(SECTION_8.map((x) => x[0]));
    const tsv = L.sheetTsv(model.columns, mine, undefined, { header: true });
    const lines = tsv.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(F.COLUMNS.map((c) => c.header).join('\t'));
    expect(tsv).not.toMatch(/[\r\u2022]/);
    for (const line of lines.slice(1)) expect(line.split('\t')).toHaveLength(24);
    const visible = L.copyRows(model, 'visible', false, []);
    expect(visible).toHaveLength(model.rows.length);
    expect(model.rows).toHaveLength(22);
    const nMine = model.rows.filter((r) => r.mine).length;
    expect(nMine).toBe(10);
    expect(visible.slice(0, nMine).every((r) => r.mine)).toBe(true);
    expect(visible.slice(nMine).some((r) => r.mine)).toBe(false);
  });

  it('(3) copied prose cells of the user rows are single-line, within the caps and clean', () => {
    for (const [key] of SECTION_8) {
      const row = rowOf(model, key);
      const ids = row.units.map((u) => u.id);
      for (const id of PROSE_IDS) {
        const text = row.cells[id];
        expect(text, key + ' ' + id).not.toMatch(/[\n\r\u2022]/);
        const max = id === 'fasActions' ? G.SHEET_FAS_MAX : (id === 'support' ? G.SHEET_SUPPORT_MAX : G.SHEET_DETAILS_MAX);
        expect(text.length, key + ' ' + id).toBeLessThanOrEqual(max);
        expect(G.sheetForbidden(text, ids), key + ' ' + id).toBeNull();
        if (/Details$/.test(id) && !/^y/i.test(row.cells[id.replace(/Details$/, 'YN')])) expect(text, key + ' ' + id).toBe('');
      }
    }
  });

  it('(6) I1: ETC Today + NO ETC + Missed = pair units down on every row', () => {
    for (const r of model.rows) {
      expect(Number(r.cells.etcToday) + Number(r.cells.noEtc) + Number(r.cells.missedEtc), r.key).toBe(r.pair.down);
      expect(r.etcInvariant, r.key).toBe(true);
    }
  });
});
