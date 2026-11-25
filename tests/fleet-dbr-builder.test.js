// Fleet DBR builder: pinned reference figures on the synthetic 21-pair fixture, columns,
// sort order, down predicate, conflicts, unitsHash and applyOverlays precedence.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const engine = require('../src/dbr/review-engine');
const { makeFleetRows, makeUnit, downIdsOf } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-10';
const USER_HEADERS = [
  'FAS Name', 'Domicile', 'Domicile Uptime', 'Domicile Units Down', 'SCAC', 'SCAC Uptime', 'SCAC Units Down',
  '1P Vendor Barrier Y/N?', '1P Vendor Barrier \u2014 Details', 'OEM Barrier Y/N?', 'OEM Barrier \u2014 Details',
  'Estimate Barrier Y/N?', 'Estimate Barrier \u2014 Details', 'Partner Barrier Y/N?', 'Partner Barrier \u2014 Details',
  'Parts Delay Y/N?', 'Parts Delay \u2014 Details', 'Common Repairs Y/N?', 'Common Repairs \u2014 Details',
  'Expected units with ETC for Today', 'NO ETC', 'Missed ETC', 'FAS Actions', 'Where Do You Need Support?',
];

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
const rowOf = (built, key) => built.rows.find((r) => r.key === key);

describe('COLUMNS', () => {
  it("headers equal the user's 24-column list in order", () => {
    expect(F.COLUMNS.map((c) => c.header)).toEqual(USER_HEADERS);
    expect(F.COLUMNS).toHaveLength(24);
    expect(Object.isFrozen(F.COLUMNS)).toBe(true);
  });
  it('editable ids are FAS name, the 6 Details, the 3 ETC columns, Actions and Support', () => {
    expect(F.EDITABLE_IDS).toEqual([
      'fasName', 'vendor1pDetails', 'oemDetails', 'estimateDetails', 'partnerDetails', 'partsDetails',
      'commonDetails', 'etcToday', 'noEtc', 'missedEtc', 'fasActions', 'support',
    ]);
  });
  it('HARD_CELL_IDS are the 7 code-only cells; AI_CELL_IDS are the other 17 in column order', () => {
    expect(F.HARD_CELL_IDS).toEqual(['fasName', 'domicile', 'domicileUptime', 'domicileDown', 'scac', 'scacUptime', 'scacDown']);
    expect(F.AI_CELL_IDS).toHaveLength(17);
    expect(F.AI_CELL_IDS).toEqual(F.COLUMNS.map((c) => c.id).slice(7));
    for (const b of ['vendor1p', 'oem', 'estimate', 'partner', 'parts', 'common']) {
      expect(F.AI_CELL_IDS).toContain(b + 'YN');
      expect(F.AI_CELL_IDS).toContain(b + 'Details');
    }
    for (const id of F.HARD_CELL_IDS) expect(F.AI_CELL_IDS).not.toContain(id);
    expect(Object.isFrozen(F.AI_CELL_IDS) && Object.isFrozen(F.HARD_CELL_IDS)).toBe(true);
  });
  it('exports EMAIL_RE for evidence redaction', () => {
    expect('mail a.b@c.com now'.replace(F.EMAIL_RE, '[redacted]')).toBe('mail [redacted] now');
  });
});

describe('buildFleetDbr on the fixture', () => {
  const rows = makeFleetRows();
  const built = F.buildFleetDbr(rows, { today: TODAY });

  it('yields 21 rows, 252 units, 53 down', () => {
    expect(built.rows).toHaveLength(21);
    expect(built.fleetCount).toBe(252);
    expect(built.downCount).toBe(53);
    expect(built.day).toBe(TODAY);
  });

  it('pins the reference domicile and SCAC figures', () => {
    const abe = rowOf(built, 'ABE40|TUZR').cells;
    expect([abe.domicileUptime, abe.domicileDown]).toEqual(['80.8%', '15']);
    expect([abe.scacUptime, abe.scacDown]).toEqual(['90.1%', '7']);
    const roc = rowOf(built, 'ROC5|AUVTE').cells;
    expect([roc.domicileUptime, roc.domicileDown]).toEqual(['48.3%', '15']);
    expect([roc.scacUptime, roc.scacDown]).toEqual(['48.3%', '15']);
    const avp = rowOf(built, 'AVP40|YTSC').cells;
    expect([avp.domicileUptime, avp.domicileDown]).toEqual(['81%', '8']);
    const sapb = rowOf(built, 'EWR45|SAPB').cells;
    expect([sapb.scacUptime, sapb.scacDown]).toEqual(['70.7%', '12']);
    expect(rowOf(built, 'PHL40|TUZR').cells.scacUptime).toBe('90.1%');
    expect(rowOf(built, 'ABE40|SAPB').pair).toEqual({ total: 32, down: 9 });
  });

  it('repeats domicile metrics across that domicile and emits 0-down pairs', () => {
    const abe = built.rows.filter((r) => r.domicile === 'ABE40');
    expect(abe.map((r) => r.cells.domicileUptime)).toEqual(['80.8%', '80.8%', '80.8%', '80.8%']);
    const zero = rowOf(built, 'UNNE01|UNNE');
    expect(zero.pair).toEqual({ total: 11, down: 0 });
    expect(zero.cells.domicileUptime).toBe('100%');
    expect(zero.cells.noEtc).toBe('0');
    expect(zero.cells.vendor1pYN).toBe('N');
  });

  it('sorts by domicile uptime asc, domicile A-Z, pair down desc, SCAC A-Z', () => {
    expect(built.rows.map((r) => r.key)).toEqual([
      'ROC5|AUVTE', 'EWR45|SAPB', 'HBD1|AKJJI', 'MIMY01|MIMY', 'MIMY01|YTSC',
      'ABE40|SAPB', 'ABE40|TUZR', 'ABE40|AGNLI', 'ABE40|AZNG',
      'AVP40|AGNLI', 'AVP40|YTSC', 'AVP40|AZNG',
      'EOFE01|EOFE', 'EOFE01|AZNG',
      'SHIL01|AZNG', 'SHIL01|SHIL', 'SHIL01|UNNE',
      'PHL40|TUZR', 'BUF|AZNG', 'EWR40|TUZR', 'UNNE01|UNNE',
    ]);
  });

  it('lists every down unit of a pair with no ETC under NO ETC', () => {
    const r = rowOf(built, 'HBD1|AKJJI');
    const ids = downIdsOf(rows, 'HBD1', 'AKJJI');
    expect(r.cells.noEtc).toBe('3');
    expect(r.units.filter((u) => u.etc.state === 'none').map((u) => u.id).sort()).toEqual(ids.slice().sort());
    expect(r.cells.etcToday).toBe('0');
    expect(r.cells.missedEtc).toBe('0');
    expect(r.units.map((u) => u.id).sort()).toEqual(ids.slice().sort());
    // Composer text (FEAT-003): no barrier -> 'tracking', no support rule -> 'None.'.
    expect(r.cells.fasActions).toBe('Tracking ' + r.units.map((u) => u.id).join('/') + '.');
    expect(r.cells.support).toBe('None.');
  });

  it('I1: ETC Today + NO ETC + Missed = pair down on every row; the three cells are bare whole numbers', () => {
    const b = F.buildFleetDbr(makeFleetRows({
      T0001: { canonicalNextStep: 'ETC 11/10' },
      T0002: { repairTimeline: '11/09 - Dealer missed the ETC of 11/05, new date pending' },
      T0003: { savedNotes: 'ETC 11/05' },
      T0004: { savedNotes: 'ETC 11/20' },
    }), { today: TODAY });
    for (const r of b.rows) {
      for (const id of ['etcToday', 'noEtc', 'missedEtc']) expect(r.cells[id], r.key + ' ' + id).toMatch(/^\d+$/);
      expect(+r.cells.etcToday + +r.cells.noEtc + +r.cells.missedEtc, r.key).toBe(r.pair.down);
      expect(r.etcInvariant).toBe(true);
      expect(r.missedWhy).toHaveLength(+r.cells.missedEtc);
      for (const u of r.units) expect(['today', 'none', 'missed']).toContain(u.etc.bucket);
    }
    const tuzr = rowOf(b, 'ABE40|TUZR');
    expect([tuzr.cells.etcToday, tuzr.cells.noEtc, tuzr.cells.missedEtc]).toEqual(['1', '3', '1']);
    expect(tuzr.missedWhy).toEqual([{ unit: 'T0002', date: '2026-11-05', why: "'11/09 - Dealer missed the ETC of 11/05, new date pending'", overrode: null }]);
    expect(tuzr.userEtcOverrides).toEqual([]);
    expect(tuzr.units.find((u) => u.id === 'T0004').etc).toMatchObject({ state: 'future', bucket: 'none', bucketReason: 'future', undercut: null });
    expect(tuzr.units.find((u) => u.id === 'T0001').etc).toMatchObject({ bucket: 'today', bucketReason: 'etc-today' });
  });

  it('userEtcOverrides lists Missed units whose extracted miss overrode a saved note', () => {
    const r = F.buildFleetDbr([
      makeUnit({ equipmentId: 'O1', _factsOn: true, savedNotes: '11/08 - No ETC',
        _factEtc: { state: 'missed', date: '2026-11-05', explicitMissDate: '2026-11-05', source: 'relay', statedAt: null, snippet: 'missed the ETC of 11/05', negated: false } }),
      makeUnit({ equipmentId: 'O2', savedNotes: 'No ETC' }),
    ], { today: TODAY }).rows[0];
    expect([r.cells.etcToday, r.cells.noEtc, r.cells.missedEtc]).toEqual(['0', '1', '1']);
    expect(r.userEtcOverrides).toEqual([{ unit: 'O1', date: '2026-11-05', userSnippet: '11/08 - No ETC', extractedSnippet: 'missed the ETC of 11/05' }]);
    expect(r.missedWhy[0]).toMatchObject({ unit: 'O1', overrode: { field: 'savedNotes', was: 'none' } });
    expect(r.missedWhy[0].why).not.toMatch(/\n/);
  });

  it('every row has row.common = { groups, repeat }; every unit has why / barrierKinds / systems', () => {
    for (const r of built.rows) {
      expect(Object.keys(r.common).sort()).toEqual(['groups', 'repeat']);
      expect(Array.isArray(r.common.groups) && Array.isArray(r.common.repeat)).toBe(true);
      for (const u of r.units) {
        expect(u.why && typeof u.why === 'object').toBe(true);
        expect(Object.keys(u.why).sort()).toEqual(u.barriers.slice().sort());
        expect(Object.keys(u.barrierKinds).sort()).toEqual(u.barriers.slice().sort());
        expect(Array.isArray(u.systems)).toBe(true);
        expect(Array.isArray(u.categories)).toBe(true);
      }
    }
  });

  it('Common Repairs: threshold 2, repeat rule, no lifecycle groups, row.common mirrors the cell', () => {
    expect(F.COMMON_REPAIR_MIN).toBe(2);
    expect(engine.TREND_MIN_UNITS).toBe(3); // Daily Call engine unchanged
    const b = F.buildFleetDbr(makeFleetRows({
      T0001: { issueSummary: 'Alternator not charging' },
      T0002: { issueDetails: 'battery dead, parasitic draw' },
      T0003: { lifecycleReason: 'Damaged' },
      T0004: { lifecycleReason: 'Damaged' },
      T0045: { issueSummary: 'Liftgate repair did not resolve the fault' },
    }), { today: TODAY });
    const tuzr = rowOf(b, 'ABE40|TUZR');
    expect(tuzr.cells.commonYN).toBe('Y');
    expect(tuzr.common).toEqual({ groups: [{ label: 'Battery/electrical', ids: ['T0001', 'T0002'] }], repeat: [] });
    expect(tuzr.cells.commonDetails).toBe('Battery/electrical: T0001 (alternator not charging) and T0002.');
    const sapb = rowOf(b, 'ABE40|SAPB');
    expect(sapb.cells.commonYN).toBe('Y');
    expect(sapb.common).toEqual({ groups: [], repeat: ['T0045'] });
    expect(rowOf(b, 'ROC5|AUVTE').cells.commonYN).toBe('N');
    expect(tuzr.units.find((u) => u.id === 'T0001').systems).toEqual(['Battery/electrical']);
    expect(tuzr.units.find((u) => u.id === 'T0003').systems).toEqual([]);
  });

  it('does not count Ordered as down but keeps it in the total', () => {
    const r = F.buildFleetDbr([
      makeUnit({ equipmentId: 'A1', lifecycleState: 'Ordered' }),
      makeUnit({ equipmentId: 'A2', lifecycleState: 'Unavailable' }),
      makeUnit({ equipmentId: 'A3', lifecycleState: 'Active' }),
    ], { today: TODAY });
    expect(r.rows[0].pair).toEqual({ total: 3, down: 1 });
    expect(r.rows[0].cells.domicileUptime).toBe('66.7%');
  });

  it('counts blank domicile / SCAC in a (BLANK) bucket', () => {
    const r = F.buildFleetDbr([
      makeUnit({ equipmentId: 'B1', operator: '' }),
      makeUnit({ equipmentId: 'B2', operator: '  ', lifecycleState: 'Active' }),
      makeUnit({ equipmentId: 'B3', domicileSite: '', domicile: '', operator: 'tsca' }),
    ], { today: TODAY });
    expect(r.fleetCount).toBe(3);
    const blank = r.rows.find((x) => x.key === 'TST1|(BLANK)');
    expect(blank.pair).toEqual({ total: 2, down: 1 });
    expect(r.rows.find((x) => x.key === '(BLANK)|TSCA').pair).toEqual({ total: 1, down: 1 });
    expect(F.normCode(null)).toBe('(BLANK)');
    expect(F.groupKey({ domicileSite: ' roc5 ', operator: 'auvte' })).toBe('ROC5|AUVTE');
  });

  it('does not mutate a deep-frozen input', () => {
    const frozen = deepFreeze(makeFleetRows({ T0001: { vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor' } }));
    expect(() => F.buildFleetDbr(frozen, { today: TODAY })).not.toThrow();
    const b = deepFreeze(F.buildFleetDbr(frozen, { today: TODAY }));
    expect(() => F.applyOverlays(b, { edits: { 'ROC5|AUVTE': { noEtc: 'x' } }, rosterFas: { 'ROC5|AUVTE': 'R' } })).not.toThrow();
  });
});

describe('isDown / uptime helpers', () => {
  it('agrees with review-engine.isUnavail', () => {
    for (const s of ['Unavailable', 'unavailable - shop', 'Active', 'Ordered', '', undefined]) {
      expect(F.isDown({ lifecycleState: s })).toBe(engine.isUnavail({ lifecycleState: s }));
    }
  });
  it('uptimePct / fmtPct', () => {
    expect(F.uptimePct(0, 0)).toBe(100);
    expect(F.fmtPct(F.uptimePct(42, 8))).toBe('81%');
    expect(F.fmtPct(F.uptimePct(78, 15))).toBe('80.8%');
  });
});

describe('statusConflicts', () => {
  it('lists non-down units with conflicting signals only', () => {
    const c = F.statusConflicts([
      makeUnit({ equipmentId: 'C1', lifecycleState: 'Active', canonicalAvailability: 'Unavailable' }),
      makeUnit({ equipmentId: 'C2', lifecycleState: 'Active', serviceState: 'In Repair' }),
      makeUnit({ equipmentId: 'C3', lifecycleState: 'Unavailable', canonicalAvailability: 'Unavailable' }),
      makeUnit({ equipmentId: 'C4', lifecycleState: 'Active' }),
    ]);
    expect(c).toEqual([
      { id: 'C1', signals: ['canonicalAvailability=Unavailable'] },
      { id: 'C2', signals: ['serviceState=In Repair'] },
    ]);
  });
});

describe('unitsHash', () => {
  const a = makeUnit({ equipmentId: 'H1', vendor: 'Amerit' });
  const b = makeUnit({ equipmentId: 'H2', lifecycleReason: 'Accident' });
  it('is stable and order-independent', () => {
    expect(F.unitsHash([a, b])).toBe(F.unitsHash([b, a]));
    expect(F.unitsHash([a, b])).toMatch(/^[0-9a-f]{40}$/);
  });
  it('changes when a hashed field changes', () => {
    expect(F.unitsHash([a, b])).not.toBe(F.unitsHash([a, Object.assign({}, b, { savedRepairStatus: 'Parts ordered' })]));
  });
  it('built rows carry both unitsHash and evidenceHash', () => {
    const r = F.buildFleetDbr([a, b], { today: TODAY }).rows[0];
    expect(r.unitsHash).toBe(F.unitsHash([a, b]));
    expect(r.evidenceHash).toBe(F.evidenceHash([a, b]));
    const changed = F.buildFleetDbr([Object.assign({}, a, { repairTimeline: '11/10 - parts arrived' }), b], { today: TODAY }).rows[0];
    expect(changed.unitsHash).toBe(r.unitsHash);
    expect(changed.evidenceHash).not.toBe(r.evidenceHash);
  });
});

describe('applyOverlays', () => {
  const built = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
  const key = 'ROC5|AUVTE';
  const hash = rowOf(built, key).unitsHash;

  it('edit > AI draft > computed, with source and draft state', () => {
    const m = F.applyOverlays(built, {
      drafts: { [key]: { fasActions: '\u2022 T0001: call carrier', support: 'None', unitsHash: hash, draftedAt: 'X' } },
      edits: { [key]: { support: 'my text', noEtc: 'edited', domicileUptime: '1%' } },
      flags: { aiDraft: true },
    });
    const r = m.rows.find((x) => x.key === key);
    expect(r.cells.fasActions).toBe('\u2022 T0001: call carrier');
    expect(r.source.fasActions).toBe('ai');
    expect(r.cells.support).toBe('my text');
    expect(r.source.support).toBe('edit');
    expect(r.base.support).toBe('None');
    expect(r.cells.noEtc).toBe('edited');
    expect(r.cells.domicileUptime).toBe('48.3%'); // read-only column ignores edits
    expect(r.source.domicileUptime).toBe('computed');
    expect(r.draft).toEqual({ state: 'ok', draftedAt: 'X' });
    expect(m.columns).toBe(F.COLUMNS);
    expect(m.flags).toEqual({ aiDraft: true });
    expect(m.rows.find((x) => x.key === 'BUF|AZNG').draft.state).toBe('none');
  });

  it('tags a draft with a different unitsHash as stale (still shown)', () => {
    const m = F.applyOverlays(built, { drafts: { [key]: { fasActions: 'a', support: 'b', unitsHash: 'old' } }, flags: { aiDraft: true } });
    const r = m.rows.find((x) => x.key === key);
    expect(r.draft).toMatchObject({ state: 'stale', staleReason: 'units' });
    expect(r.cells.fasActions).toBe('a');
    // AI flag off: no overlay, state none, even with the stored draft.
    const off = F.applyOverlays(built, { drafts: { [key]: { fasActions: 'a', support: 'b', unitsHash: hash } } });
    const o = off.rows.find((x) => x.key === key);
    expect(o.draft).toEqual({ state: 'none', draftedAt: null });
    expect(o.source.fasActions).toBe('computed');
  });

  it('v2 overlay: AI_CELL_IDS whitelist only, sources/flags, staleReason units > identity > evidence', () => {
    const row = rowOf(built, key);
    const d = {
      version: 2, unitsHash: hash, evidenceHash: row.evidenceHash, draftedAt: 'X',
      cells: { oemYN: 'Y', oemDetails: '• AI', partsYN: 'N', domicileDown: '999', scacUptime: '1%', fasName: 'Evil' },
      sources: { oemYN: 'ai', oemDetails: 'ai', partsYN: 'computed' }, flags: { oemDetails: 'review', domicileDown: 'review' },
      etcUnits: [{ unit: 'T0001', state: 'none' }], provenance: { fasActions: { T0001: [{ date: '11/10', quote: 'called TA' }] } },
      identity: { alias: false, names: 0, fasTagged: 0 },
    };
    const ov = (extra) => F.applyOverlays(built, Object.assign({ drafts: { [key]: d }, flags: { aiDraft: true } }, extra)).rows.find((x) => x.key === key);
    let r = ov({});
    expect(r.cells.oemYN).toBe('Y');
    expect(r.source.oemYN).toBe('ai');
    expect(r.source.partsYN).toBe('computed');
    for (const id of F.HARD_CELL_IDS) expect(r.cells[id]).toBe(id === 'fasName' ? '' : row.cells[id]);
    expect(r.flags).toEqual({ oemDetails: 'review' });
    expect(r.etcUnits).toEqual(d.etcUnits);
    expect(r.provenance).toEqual(d.provenance);
    expect(r.draft).toEqual({ state: 'ok', draftedAt: 'X' });
    r = ov({ fasAliasKnown: true });
    expect(r.draft).toMatchObject({ state: 'stale', staleReason: 'identity' });
    d.evidenceHash = 'other';
    r = ov({});
    expect(r.draft).toMatchObject({ state: 'stale', staleReason: 'evidence' });
    r = ov({ fasAliasKnown: true });
    expect(r.draft.staleReason).toBe('identity');
    d.unitsHash = 'old';
    expect(ov({ fasAliasKnown: true }).draft.staleReason).toBe('units');
    const m = F.applyOverlays(built, { flags: { aiDraft: true }, fasAliasKnown: true });
    expect(m.aiCellIds).toEqual(F.AI_CELL_IDS);
    expect(m.fasAliasKnown).toBe(true);
  });

  it('FAS name: roster wins, then the user name, then empty; per-row edit overrides', () => {
    const m = F.applyOverlays(built, {
      rosterFas: { [key]: 'Roster Person' },
      emailFasName: 'Email Me',
      edits: { 'BUF|AZNG': { fasName: 'Row Edit' } },
    });
    const roc = m.rows.find((x) => x.key === key);
    expect([roc.cells.fasName, roc.fasSource]).toEqual(['Roster Person', 'roster']);
    const hbd = m.rows.find((x) => x.key === 'HBD1|AKJJI');
    expect([hbd.cells.fasName, hbd.fasSource]).toEqual(['Email Me', 'you']);
    const buf = m.rows.find((x) => x.key === 'BUF|AZNG');
    expect([buf.cells.fasName, buf.source.fasName]).toEqual(['Row Edit', 'edit']);
    expect([m.fasName, m.fasNameSource]).toEqual(['Email Me', 'email-intel']);

    const p = F.applyOverlays(built, { fasNameOverride: ' Panel Me ', emailFasName: 'Email Me' });
    expect([p.fasName, p.fasNameSource]).toEqual(['Panel Me', 'panel']);
    expect(p.rows[0].cells.fasName).toBe('Panel Me');

    const n = F.applyOverlays(built, {});
    expect([n.fasName, n.fasNameSource]).toEqual(['', 'none']);
    expect([n.rows[0].cells.fasName, n.rows[0].fasSource]).toEqual(['', 'none']);
  });
});

describe('sheet composer (design §3.8, FEAT-003)', () => {
  const G = require('../src/dbr/fleet-dbr-gate');
  const one = (units) => F.buildFleetDbr(units.map((u) => makeUnit(u)), { today: TODAY }).rows.find((r) => r.key === 'TST1|TSCA');
  const SHEET_IDS = ['vendor1pDetails', 'oemDetails', 'estimateDetails', 'partnerDetails', 'partsDetails', 'commonDetails', 'fasActions', 'support'];

  it('vendorLabel: the golden label table, raw fallback, no vendor', () => {
    const cases = [['COX', 'COX'], ['Amerit', 'Amerit'], ['TA Rochester', 'TA'], ['Travel Centers of America', 'TA'],
      ['Volvo (ASIST)', 'Volvo/ASIST'], ['Freightliner (DAIMLER)', 'Freightliner'], ['Kenworth (PACCAR)', 'Kenworth/PACCAR'],
      ['KWNE', 'KWNE'], ['Peterbilt', 'Peterbilt'], ['Navistar', 'International'], ['Mack', 'Mack'], ['DSP_ENTERED', 'DSP'],
      ['FLEETNET', 'FleetNet'], ['CEI (CEI)', 'CEI'], ['ALLEGIANCE_AND_ASCENDANCE', 'Ascendance'],
      ['FIRST_ADVANTAGE', 'FIRST ADVANTAGE'], ['Bruckners (Syracuse)', 'Bruckners'], ['', 'no vendor'], [null, 'no vendor']];
    for (const [v, label] of cases) expect(F.vendorLabel(v), String(v)).toBe(label);
  });

  it('shortIssue: the frozen 11/25 issueSummary texts and the step rules', () => {
    const si = (s) => F.shortIssue({ issueSummary: s });
    expect(si('Hood shocks broken from damage and air tank drain lines worn through; replacement hood shocks have no parts ETA.')).toBe('hood shocks broken from damage');
    expect(si('Engine oil level reported low and engine reported as not running correctly.')).toBe('engine oil level reported low');
    expect(si('Liftgate assembly leaking hydraulic oil at the piston seal; air suspension dump not functioning.')).toBe('liftgate assembly leaking hydraulic oil');
    expect(si('Unit needs oil dropped and a new gasket installed (engine/motor systems).')).toBe('oil dropped and a new gasket installed');
    expect(si('Brake light out (see note. dealer) on trailer. Second sentence here.')).toBe('brake light out (see note. dealer) on trailer');
    expect(si('TRUCK REQUIRES A new starter motor')).toBe('new starter motor');
    expect(si('Reported coolant leak')).toBe('coolant leak');
    expect(si('Work order created (RO 206910652) for engine no-start')).toBe('work order created for engine no-start');
    expect(si('RO 206910652 opened for brakes')).toBe('opened for brakes');
    expect(si('CNG valves leaking')).toBe('CNG valves leaking');
    expect(si('APU/cab outlets not working')).toBe('APU/cab outlets not working');
    expect(si('')).toBe('');
  });

  it('status phrases: table, lowercase code text fallback, open, status not set', () => {
    const r = one([
      { equipmentId: 'X1', vendor: 'COX', savedRepairStatus: 'Work_in_progress' },
    ]);
    expect(r.cells.vendor1pDetails).toBe('COX: X1 \u2014 work in progress.');
    expect(one([{ equipmentId: 'X1', vendor: 'COX', savedRepairStatus: 'Cannot Complete \u2014 Parts Pending' }]).cells.vendor1pDetails).toBe('COX: X1 \u2014 open.');
    expect(one([{ equipmentId: 'X1', vendor: 'COX' }]).cells.vendor1pDetails).toBe('COX: X1 \u2014 status not set.');
    expect(one([{ equipmentId: 'X1', vendor: 'COX', savedRepairStatus: 'Vehicle arrived' }]).cells.vendor1pDetails).toBe('COX: X1 \u2014 awaiting diagnosis.');
  });

  it('group order (count desc, max days desc, label asc), unit order and the , / and joins', () => {
    const r = one([
      { equipmentId: 'A1', vendor: 'Amerit', savedRepairStatus: 'Repair in progress', workDuration: '30d' },
      { equipmentId: 'C1', vendor: 'COX', savedRepairStatus: 'Repair in progress', workDuration: '5d' },
      { equipmentId: 'C2', vendor: 'COX', savedRepairStatus: 'Repair in progress', workDuration: '9d' },
      { equipmentId: 'C3', vendor: 'COX', savedRepairStatus: 'Repair in progress', workDuration: '1d' },
      { equipmentId: 'T1', vendor: 'TA', savedRepairStatus: 'Under diagnosis', workDuration: '30d' },
    ]);
    expect(r.cells.vendor1pDetails).toBe('COX has 3 units: C2 (9d), C1 (5d) and C3 (1d) \u2014 all repair in progress; Amerit: A1 (30d) \u2014 repair in progress; TA: T1 (30d) \u2014 under diagnosis.');
    expect(r.cells.fasActions).toBe('Following up COX on C2/C1/C3 diag/repair progress; following up Amerit on A1 diag/repair progress; following up TA on T1 diag/repair progress.');
    expect(r.cells.support).toBe('Vendor performance \u2014 Amerit and TA turnaround on A1/T1.');
  });

  it('ROC5|AUVTE-shaped row: 1P falls to T2, FAS Actions and Support reproduce the §3.8 example', () => {
    const spec = [
      ['B13014', 'DSP_ENTERED', 'Awaiting estimate', 'Accident', '73d 3h', '', 'Accident front-end damage; driver-side front hood came off the box truck.'],
      ['B62059', 'COX', 'Parts backordered', 'Damaged-Moderate', '21d 12h', 'ordered', 'Hood shocks broken from damage and air tank drain lines worn through; replacement hood shocks have no parts ETA.'],
      ['B12195', 'COX', 'Parts ordered', 'Damaged-Moderate', '16d 9h', 'ordered', 'Engine no-start confirmed due to severe corrosion on positive battery terminals; batteries and battery cable require replacement.'],
      ['B62064', 'FLEETNET', 'Waiting for vendor', 'Impounded Tow', '7d 21h', 'arrived', 'Unit broke down at a gas station and was impounded; it needs release and a tow back to ROC5.'],
      ['B12263', 'Freightliner (DAIMLER)', 'Vehicle arrived', 'Damaged-Moderate', '4d 22h', '', 'Unit needs oil dropped and a new gasket installed (engine/motor systems).'],
      ['B12343', 'COX', 'Parts ordered', 'Damaged-Moderate', '1d 7h', 'ordered', 'Engine oil level reported low and engine reported as not running correctly.'],
      ['B62020', 'COX', 'Parts ordered', 'Damaged-Moderate', '1d 8h', 'ordered', 'Oil pressure warning light on; no oil found on dipstick.'],
      ['B12261', 'COX', 'Waiting for vendor', 'Damaged-Moderate', '0d 0h', '', 'Check indicator on (chassis).'],
      ['B62049', 'COX', 'Parts ordered', 'Damaged-Moderate', '0d 7h', 'ordered', 'Liftgate assembly leaking hydraulic oil at the piston seal; air suspension dump not functioning.'],
    ];
    const r = one(spec.map(([equipmentId, vendor, savedRepairStatus, lifecycleReason, workDuration, partsStatus, issueSummary]) =>
      ({ equipmentId, vendor, savedRepairStatus, lifecycleReason, workDuration, partsStatus, issueSummary })));
    // §3.8 lists B62049 before B12261; its own ordering rule (days desc, then id asc) puts B12261 first.
    expect(r.cells.vendor1pDetails).toBe('COX has 6 units (B62059 21d, B12195 16d, B12343 1d, B62020 1d, B12261 0d, B62049 0d): parts on order (5), waiting for vendor (1).');
    expect(r.cells.fasActions).toBe('Following up COX on parts ETAs (B62059/B12195/B12343/B62020/B62049); following up COX on B12261 diag/repair progress; pushing Freightliner on B12263 diagnosis/ETC; escalating B13014 (carrier/DSP accident) and B62064 (impound release).');
    expect(r.cells.support).toBe('Support on B62064 (impound release) and B13014 (73d carrier/DSP accident).');
    expect(r.cells.oemDetails).toBe('Freightliner offsite: B12263 (4d, oil dropped and a new gasket installed) \u2014 awaiting diagnosis.');
    expect(r.cells.estimateYN).toBe('N');
    expect(r.cells.estimateDetails).toBe('');
    expect(r.units.find((u) => u.id === 'B62059')).toMatchObject({ label: 'hood shocks broken from damage', vendorLabel: 'COX' });
    expect(r.units.find((u) => u.id === 'B62059').why.vendor1p).toBe('1P vendor COX');   // drill-down source unchanged
  });

  it('self-check: a unit whose label trips the forbidden check drops to T3 (id only); the others keep theirs', () => {
    const r = one([
      { equipmentId: 'B71001', vendor: 'Volvo', savedRepairStatus: 'Under diagnosis', workDuration: '5d', issueSummary: 'Hood \u2022 latch broken' },
      { equipmentId: 'B71002', vendor: 'Volvo', savedRepairStatus: 'Under diagnosis', workDuration: '3d', issueSummary: 'Turbo whistle at idle' },
    ]);
    expect(r.units.find((u) => u.id === 'B71001').label).toBe('hood \u2022 latch broken');
    expect(r.cells.oemDetails).toBe('Volvo/ASIST offsite: B71001 and B71002 (3d, turbo whistle at idle) \u2014 all under diagnosis.');
    for (const id of SHEET_IDS) expect(G.sheetForbidden(r.cells[id], ['B71001', 'B71002']), id).toBeNull();
  });

  it('a 96-unit row stays within 230 / 240 / 140, single-line, no forbidden pattern', () => {
    const vendors = ['COX', 'Amerit', 'TA', 'Volvo', 'Freightliner', 'KWNE', 'DSP_ENTERED', 'FLEETNET'];
    const units = Array.from({ length: 96 }, (_, i) => ({
      equipmentId: 'B8' + String(1000 + i), vendor: vendors[i % vendors.length], workDuration: (i % 40) + 'd',
      savedRepairStatus: ['Parts ordered', 'Waiting for vendor', 'Under diagnosis', 'Awaiting estimate'][i % 4],
      lifecycleReason: i % 8 === 7 ? 'Impounded Tow' : (i % 8 === 6 ? 'Accident' : 'Damaged'),
      partsStatus: i % 4 === 0 ? 'ordered' : '', serviceState: i % 5 === 0 ? 'Estimate rejected' : '',
      issueSummary: 'Turbo and air leak with a very long description of the repair needed for unit ' + i + ' and more words after it',
    }));
    const r = one(units);
    expect(r.pair.down).toBe(96);
    const caps = { fasActions: 240, support: 140 };
    for (const id of SHEET_IDS) {
      const v = r.cells[id];
      expect(v.length, id).toBeLessThanOrEqual(caps[id] || 230);
      expect(v, id).not.toMatch(/\n/);
      expect(G.sheetForbidden(v, r.units.map((u) => u.id)), id).toBeNull();
      if (id !== 'support' && r.cells[id.replace('Details', 'YN')] !== 'N') expect(v.length, id).toBeGreaterThan(0);
    }
  });

  it('Details are empty whenever the computed Y/N is N; a zero-down row -> "" and Support None.', () => {
    const built = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
    for (const r of built.rows) {
      for (const b of ['vendor1p', 'oem', 'estimate', 'partner', 'parts', 'common']) {
        if (r.cells[b + 'YN'] === 'N') expect(r.cells[b + 'Details'], r.key + ' ' + b).toBe('');
      }
    }
    const zero = rowOf(built, 'ABE40|AZNG');
    expect(zero.pair.down).toBe(0);
    for (const id of SHEET_IDS.slice(0, 7)) expect(zero.cells[id]).toBe('');
    expect(zero.cells.support).toBe('None.');
    const c = F.composeSheet([{ id: 'Z1', barriers: ['oem'], kinds: { oem: 'dealer' }, vendorLabel: 'Volvo/ASIST', label: 'x', status: '' }], { oem: 'N' }, null);
    expect(c.oemDetails).toBe('');
    expect(F.composeSheet([], {}, null)).toEqual({ vendor1pDetails: '', oemDetails: '', estimateDetails: '', partnerDetails: '', partsDetails: '', commonDetails: '', fasActions: '', support: 'None.' });
  });
});
