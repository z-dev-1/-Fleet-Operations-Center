import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { buildScope, inScopeNew, inScopeExisting, unitsNotInFleet, matchesFilter, vendorOf } = require('../src/autopilot/scope');
const { resolveAutopilotConfig } = require('../src/autopilot/config');

const isDown = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');
const scope = buildScope(resolveAutopilotConfig({ autopilot: { scope: { mode: 'filter' } } }, {}));

describe('autopilot scope', () => {
  it('inScopeNew: ABE40 down, listed cross-domicile down, others excluded', () => {
    expect(inScopeNew({ equipmentId: 'X1', domicileSite: 'abe40', lifecycleState: 'Unavailable' }, scope, isDown)).toBe(true);
    expect(inScopeNew({ equipmentId: 'B13014', domicileSite: 'DFW7', lifecycleState: 'Unavailable' }, scope, isDown)).toBe(true);
    expect(inScopeNew({ equipmentId: 'X2', domicileSite: 'DFW7', lifecycleState: 'Unavailable' }, scope, isDown)).toBe(false);
    expect(inScopeNew({ equipmentId: 'X1', domicileSite: 'ABE40', lifecycleState: 'Active' }, scope, isDown)).toBe(false);
    expect(inScopeNew({ equipmentId: 42, domicileSite: 'ABE40', lifecycleState: 'Unavailable' }, scope, isDown)).toBe(false);
    expect(inScopeNew({ equipmentId: 'X1', domicileSite: 'ABE40', lifecycleState: 'Unavailable' }, scope, null)).toBe(false);
  });

  it('allowlist entries are trimmed and uppercased (" b13014 " matches B13014)', () => {
    const s = buildScope({ scope: { domicile: '', units: [' b13014 '], allUnits: false } });
    expect(inScopeNew({ equipmentId: 'B13014', domicileSite: 'X', lifecycleState: 'Unavailable' }, s, isDown)).toBe(true);
    expect(inScopeNew({ equipmentId: ' b13014', domicileSite: 'X', lifecycleState: 'Unavailable' }, s, isDown)).toBe(true);
    expect(inScopeNew({ equipmentId: 'X9', domicileSite: '', lifecycleState: 'Unavailable' }, s, isDown)).toBe(false);
  });

  it('All units ON includes every down unit', () => {
    const s = buildScope({ scope: { domicile: 'ABE40', units: [], allUnits: true } });
    expect(inScopeNew({ equipmentId: 'Z1', domicileSite: 'SEA1', lifecycleState: 'Unavailable' }, s, isDown)).toBe(true);
  });

  it('inScopeExisting ignores isDown: an ABE40 row that turns Active stays in scope', () => {
    const row = { equipmentId: 'X1', domicileSite: 'ABE40', lifecycleState: 'Active' };
    expect(inScopeNew(row, scope, isDown)).toBe(false);
    expect(inScopeExisting(row, scope)).toBe(true);
    expect(inScopeExisting({ equipmentId: 'X2', domicileSite: 'DFW7', lifecycleState: 'Active' }, scope)).toBe(false);
  });

  it('unitsNotInFleet lists allowlist entries without a fleet row (R14)', () => {
    const s = buildScope({ scope: { units: ['A1', 'B13014'] } });
    expect(unitsNotInFleet(s, [{ equipmentId: ' b13014 ' }])).toEqual(['A1']);
  });
});

describe('V2 scope modes and filter (AC-6)', () => {
  const R = (scope) => buildScope(resolveAutopilotConfig({ autopilot: { scope } }, {}));
  const row = (extra) => Object.assign({ equipmentId: 'ZZ1', domicileSite: 'XYZ9', operator: 'ABCD', owner: 'Some Owner', lifecycleState: 'Unavailable' }, extra || {});

  it('fleet mode (the default) accepts any domicile, operator and unit prefix', () => {
    const s = buildScope(resolveAutopilotConfig({}, {}));
    expect(s.mode).toBe('fleet');
    expect(s.allUnits).toBe(true);
    for (const r of [row(), row({ equipmentId: 'TRK-9', domicileSite: '', operator: '' }), row({ equipmentId: '0001', domicileSite: 'SEA1' })]) {
      expect(inScopeNew(r, s, isDown)).toBe(true);
      expect(inScopeExisting(r, s)).toBe(true);
    }
    expect(inScopeNew(row({ lifecycleState: 'Active' }), s, isDown)).toBe(false);
    expect(inScopeExisting({ equipmentId: ' ' }, s)).toBe(false);
    expect(unitsNotInFleet(s, [])).toEqual([]);
  });

  it('unresolved input: explicit mode, else allUnits true -> fleet, else filter', () => {
    expect(buildScope({ scope: { mode: 'fleet' } }).mode).toBe('fleet');
    expect(buildScope({ scope: { allUnits: true } }).mode).toBe('fleet');
    expect(buildScope({ scope: { units: ['A1'] } }).mode).toBe('filter');
    expect(buildScope({}).mode).toBe('filter');
  });

  it('filter mode ANDs the non-empty dimensions; a listed unit always matches', () => {
    const s = R({ mode: 'filter', filter: { domiciles: ['ABE40'], scacs: ['TUZR'], units: ['LISTED1'] } });
    expect(matchesFilter(row({ domicileSite: 'abe40', operator: 'tuzr' }), s)).toBe(true);
    expect(matchesFilter(row({ domicileSite: 'ABE40', operator: 'KNXP' }), s)).toBe(false);
    expect(matchesFilter(row({ domicileSite: 'DFW7', operator: 'TUZR' }), s)).toBe(false);
    expect(matchesFilter(row({ equipmentId: 'listed1', domicileSite: 'DFW7', operator: 'KNXP' }), s)).toBe(true);
    const c = R({ mode: 'filter', filter: { carriers: ['penske logistics'], vendors: ['Ryder Newark'] } });
    expect(matchesFilter(row({ owner: 'Penske Logistics', dealerName: 'RYDER NEWARK' }), c)).toBe(true);
    expect(matchesFilter(row({ operator: 'Penske Logistics', vendor: 'ryder newark' }), c)).toBe(true);
    expect(matchesFilter(row({ owner: 'Penske Logistics', dealerName: 'Other' }), c)).toBe(false);
    const u = R({ mode: 'filter', filter: { units: ['ONLY1'] } });
    expect(matchesFilter(row(), u)).toBe(false);
    expect(matchesFilter(row({ equipmentId: 'ONLY1' }), u)).toBe(true);
  });

  it("filter { scacs: ['TUZR'] } means TUZR only (the legacy domicile / units are ignored)", () => {
    const s = R({ mode: 'filter', filter: { scacs: ['TUZR'] } });
    expect(inScopeNew(row({ domicileSite: 'DFW7', operator: 'TUZR' }), s, isDown)).toBe(true);
    expect(inScopeNew(row({ domicileSite: 'ABE40', operator: 'KNXP' }), s, isDown)).toBe(false);
    expect(inScopeNew(row({ equipmentId: 'B13014', domicileSite: 'DFW7', operator: 'KNXP' }), s, isDown)).toBe(false);
    expect(unitsNotInFleet(s, [])).toEqual([]);
  });

  it("filter { domiciles: ['ABE40'], units: ['B13014'] } equals the V1 pilot { domicile: 'ABE40', units: ['B13014'] }", () => {
    const v2 = R({ mode: 'filter', filter: { domiciles: ['ABE40'], units: ['B13014'] } });
    const v1 = R({ mode: 'filter', domicile: 'ABE40', units: ['B13014'] });
    const rows = [
      row({ equipmentId: 'X1', domicileSite: 'ABE40' }), row({ equipmentId: 'B13014', domicileSite: 'DFW7' }),
      row({ equipmentId: 'X2', domicileSite: 'DFW7' }), row({ equipmentId: 'X3', domicileSite: 'abe40', lifecycleState: 'Active' }),
      row({ equipmentId: ' b13014 ', domicileSite: '' }),
    ];
    for (const r of rows) {
      expect(inScopeNew(r, v2, isDown), r.equipmentId).toBe(inScopeNew(r, v1, isDown));
      expect(inScopeExisting(r, v2), r.equipmentId).toBe(inScopeExisting(r, v1));
    }
    expect(rows.map((r) => inScopeExisting(r, v2))).toEqual([true, true, false, true, true]);
    expect(unitsNotInFleet(v2, [])).toEqual(['B13014']);
    expect(unitsNotInFleet(v1, [])).toEqual(['B13014']);
  });

  it('vendorOf: dealerName, else vendor, trimmed to 60 chars', () => {
    expect(vendorOf({ dealerName: ' Penske ', vendor: 'Other' })).toBe('Penske');
    expect(vendorOf({ vendor: 'Ryder' })).toBe('Ryder');
    expect(vendorOf({})).toBe('');
    expect(vendorOf({ vendor: 'x'.repeat(80) }).length).toBe(60);
  });
});
