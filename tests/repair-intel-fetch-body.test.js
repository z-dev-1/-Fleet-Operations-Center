import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fetch = require('../src/repair-intel/fetch');

describe('repair-intel fetch _historyBody', () => {
  it('always sets a non-null category (API rejects null category with a 500)', () => {
    const def = fetch._historyBody({ equipmentIds: ['U1'] });
    expect(def.category).toBeTruthy();
    expect(def.category).toBe('UNPLANNED');
    const planned = fetch._historyBody({ equipmentIds: ['U1'], category: 'PLANNED' });
    expect(planned.category).toBe('PLANNED');
  });

  it('keeps the required fleetIds from DEFAULT_SEARCH_REQUEST and widens statuses', () => {
    const body = fetch._historyBody({ equipmentIds: ['U1'] });
    // fleetIds must be present (endpoint requires them) — array with entries.
    expect(Array.isArray(body.fleetIds)).toBe(true);
    expect(body.fleetIds.length).toBeGreaterThan(0);
    // statuses must include completed/cancelled so history (not just open) returns.
    expect(body.statuses).toContain('COMPLETED');
    expect(body.statuses).toContain('CANCELLED');
    // scoped to the one unit
    expect(body.equipmentIds).toEqual(['U1']);
    // rolling window present
    expect(typeof body.modifiedFromEpochMs).toBe('number');
    // sortColumn must be a valid enum — never the rejected 'ModifiedDate'.
    expect(body.sortConfig.sortColumn).not.toBe('ModifiedDate');
    expect(body.sortConfig.sortColumn).toBeTruthy();
  });
});
