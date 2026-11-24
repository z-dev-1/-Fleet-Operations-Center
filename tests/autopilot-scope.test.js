import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { buildScope, inScopeNew, inScopeExisting, unitsNotInFleet } = require('../src/autopilot/scope');
const { resolveAutopilotConfig } = require('../src/autopilot/config');

const isDown = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');
const scope = buildScope(resolveAutopilotConfig({}, {}));

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
