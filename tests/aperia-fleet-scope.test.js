// tests/aperia-fleet-scope.test.js — src/aperia/fleet-scope.js: the fleet-row unit Set (normUnit of
// equipmentId) from ctx.lastData.rows, else the stored fleetData rows; inScope; never throws.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/aperia/fleet-scope');

describe('aperia fleet-scope', () => {
  it('fromRows -> normUnit of equipmentId, blanks and junk skipped', () => {
    const set = S.fromRows([{ equipmentId: ' np 6923 ' }, { equipmentId: '#122269' }, { equipmentId: '' }, null, 5, {}]);
    expect([...set].sort()).toEqual(['122269', 'NP6923']);
    expect(S.fromRows(null).size).toBe(0);
  });

  it('fleetUnitSet uses ctx.lastData.rows when non-empty and does not read the store', () => {
    const store = { load: vi.fn(() => ({ rows: [{ equipmentId: 'STORED' }] })) };
    const set = S.fleetUnitSet({ lastData: { rows: [{ equipmentId: 'live1' }] } }, { store });
    expect([...set]).toEqual(['LIVE1']);
    expect(store.load).not.toHaveBeenCalled();
  });

  it('fleetUnitSet falls back to the stored fleetData rows', () => {
    const store = { load: vi.fn(() => ({ rows: [{ equipmentId: 'STORED' }] })) };
    expect([...S.fleetUnitSet({ lastData: { rows: [] } }, { store })]).toEqual(['STORED']);
    expect(store.load).toHaveBeenCalledWith('fleetData', {});
    expect([...S.fleetUnitSet(null, { store })]).toEqual(['STORED']);
  });

  it('never throws: a throwing store or odd input -> empty Set', () => {
    const store = { load: () => { throw new Error('boom'); } };
    expect(S.fleetUnitSet(null, { store }).size).toBe(0);
    expect(S.fleetUnitSet(null, { store: { load: () => null } }).size).toBe(0);
  });

  it('inScope compares normUnit(fleetVehicleId)', () => {
    const set = S.fromRows([{ equipmentId: 'NP6923' }]);
    expect(S.inScope(set, 'np6923')).toBe(true);
    expect(S.inScope(set, ' #NP 6923')).toBe(true);
    expect(S.inScope(set, 'NP6924')).toBe(false);
    expect(S.inScope(set, '')).toBe(false);
    expect(S.inScope(set, null)).toBe(false);
    expect(S.inScope(new Set(), 'NP6923')).toBe(false);
    expect(S.inScope(null, 'NP6923')).toBe(false);
  });
});
