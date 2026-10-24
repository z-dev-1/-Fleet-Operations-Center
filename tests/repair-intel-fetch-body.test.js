import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fetch = require('../src/repair-intel/fetch');

describe('repair-intel fetch _historyBody', () => {
  it('fast path mirrors the proven unit query: equipmentIds + empty statuses, uppercased', () => {
    const body = fetch._historyBody({ equipmentIds: ['b12343'] });
    expect(body.equipmentIds).toEqual(['B12343']);   // uppercased
    expect(body.statuses).toEqual([]);                // empty = all statuses (full history)
    expect(body.page).toBe(1);
    // must NOT send a specific status list (that returned 0 live) or a bad sortColumn
    expect(body.sortConfig).toBeUndefined();          // let searchServices use the default
    // must NOT force category null on the fast path (the default category stays valid)
    expect('category' in body).toBe(false);
  });

  it('widened variant clears only NULLABLE dimensions, never non-nullable fleetIds/category', () => {
    const body = fetch._historyBody({ equipmentIds: ['U1'], widened: true });
    expect(body.equipmentIds).toEqual(['U1']);
    expect(body.statuses).toEqual([]);
    expect(body.lifecycleStates).toBeNull();
    expect(body.assetPrograms).toBeNull();
    // The API 500s on null fleetIds/category — the widened body must NOT send them.
    expect('fleetIds' in body).toBe(false);
    expect('category' in body).toBe(false);
  });
});
