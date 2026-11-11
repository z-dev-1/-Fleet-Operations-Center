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
    expect(r.cells.fasActions).toBe('');
    expect(r.cells.support).toBe('');
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
