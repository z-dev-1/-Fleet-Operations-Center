// tests/carrier-intel-fixture.test.js — carrier-intel AC-36 (plan D4): the committed
// auvte-scac-rows.json is exactly what build-auvte-fleet.cjs builds, and the built fleet has
// the per-unit values the later acceptance criteria rely on (D1 / D2 assertions).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const W = require('../src/repair-intel/wo-facts');
const F = require('../src/dbr/fleet-dbr');
const Fx = require('../src/carrier-intel/facts');
const Tx = require('../src/carrier-intel/taxonomy');
const builder = require('./fixtures/carrier-intel/build-auvte-fleet.cjs');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const committed = JSON.parse(fs.readFileSync(path.join(FIX, 'auvte-scac-rows.json'), 'utf8'));
const TODAY = '2026-11-17';
const SYN = { B12263: { later: 9, state: 'today' }, B12267: { later: 11, state: 'today' }, B62059: { later: 9, state: 'future' }, B12258: { later: 0, state: 'none' } };
const rowOf = (id) => committed.rows.find((r) => r.equipmentId === id);

describe('AC-36 fixture reproducibility', () => {
  beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-17T17:38:17Z')); });
  afterAll(() => { vi.useRealTimers(); });
  it('build() deep-equals the committed JSON', () => {
    expect(JSON.parse(JSON.stringify(builder.build()))).toEqual(committed);
  }, 30000);   // the full build replays 7 rows through extractRelay; > 5 s under full-suite load
});

describe('AUVTE fixture fleet', () => {
  it('29 AUVTE rows, 7 down units, syncedAt 17:38:17Z', () => {
    expect(committed.syncedAt).toBe('2026-11-17T17:38:17Z');
    expect(committed.rows.length).toBe(29);
    expect(committed.rows.every((r) => r.operator === 'AUVTE')).toBe(true);
    expect(committed.rows.filter(F.isDown).map((r) => r.equipmentId).sort())
      .toEqual(['B12195', 'B12258', 'B12263', 'B12267', 'B13014', 'B62059', 'B62064']);
    for (const id of ['B12271', 'B62053', 'B20038']) expect(F.isDown(rowOf(id))).toBe(false);
  });
  for (const id of Object.keys(SYN)) {
    it(id + ': history trend, day slips, counted state, _factsOn and _factEtc (D1 / D2)', () => {
      const row = rowOf(id);
      const fset = W.buildFactSet(row, { today: TODAY });
      expect(fset.history).not.toBeNull();
      expect(fset.history.etc.daySlipCount).toBe(SYN[id].later);
      expect(fset.etc.counted.state).toBe(SYN[id].state);
      expect(row._factsOn).toBe(true);
      expect(row._factEtc && typeof row._factEtc).toBe('object');
    });
  }
  it('only B62064 among the down units has no fact output (G-NOFACTS)', () => {
    expect(committed.rows.filter(F.isDown).filter((r) => r._factsOn !== true).map((r) => r.equipmentId)).toEqual(['B62064']);
  });
  it('day slips [5, 9, 11, 9] and arrival hours [34.3, 4.0, 3.8, 8.4] from the vendor assignment', () => {
    const ids = ['B12195', 'B12263', 'B12267', 'B62059'];
    expect(ids.map((id) => Fx.etcDayCounts(rowOf(id).relayFacts.historyTrend).daySlips)).toEqual([5, 9, 11, 9]);
    const arr = ids.map((id) => Fx.arrivalOf(rowOf(id)));
    expect(arr.map((a) => a.basis)).toEqual(['assign', 'assign', 'assign', 'assign']);
    expect(arr.map((a) => a.hours)).toEqual([34.3, 4.0, 3.8, 8.4]);
    for (const id of ['B12263', 'B12267']) {
      expect(rowOf(id).relayFacts.facts.some((f) => f.kind === 'etcMention' && f.etcKind === 'techOnsite' && f.marker === 'met' && f.via === 'history')).toBe(true);
    }
  });
  it('downCause per down unit; B12258 dealer-offsite with vendor-response-lag; COX units etc-rolling', () => {
    const dc = (id) => { const r = rowOf(id); return Tx.downCause(r, W.buildFactSet(r, { today: TODAY }), TODAY); };
    expect(dc('B12258')).toMatchObject({ cause: 'dealer-offsite', owner: 'dealer', offsite: true });
    expect(dc('B12258').flags).toContain('vendor-response-lag');
    for (const id of ['B12195', 'B12263', 'B12267', 'B62059']) {
      expect(dc(id).cause).toBe('parts-hold');
      expect(dc(id).flags).toContain('etc-rolling');
    }
    expect(dc('B12267').flags).toContain('parts-eta-passed');
    expect(dc('B12267').flags).not.toContain('parts-no-eta');
    expect(dc('B13014')).toMatchObject({ cause: 'accident', owner: 'DSP' });
    expect(dc('B62064')).toMatchObject({ cause: 'impound', owner: 'DSP' });
  });
  it('roll-up cause split, vendors line and compliance list computed from the fleet', () => {
    const recs = committed.rows.filter(F.isDown).map((r) => Fx.unitRecord(r, {}, W.buildFactSet(r, { today: TODAY }), TODAY));
    const comp = Fx.compliance(committed.rows, TODAY, F.isDown);
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: 29 }, compliance: comp, asOf: committed.syncedAt });
    expect(text).toContain('vendors: COX 4 · KWNE 1 · DSP-managed (no vendor) 2');
    expect([countBy.get('parts-hold'), countBy.get('accident'), countBy.get('impound'), countBy.get('dealer-offsite')]).toEqual([4, 1, 1, 1]);
    expect(text).toMatch(/^down-cause split: parts-hold 4 units [\d.]+ unit-days \(\d+%\) · accident 1 unit 65\.2 unit-days \(\d+%\) · dealer-offsite 1 unit 21\.1 unit-days \(\d+%\) · impound 1 unit \(days unknown\)$/m);
    expect(text).toContain('compliance (Active units): DOT expired 2 (B12259 due 11/10, B13127 due 11/11) · PM B overdue 2 (B12268 due 11/7, B12343 due 11/15)');
    expect(text).toContain('fleet: 29 units · 7 down (live fleet data as of 11/17 12:38 PM ET)');
  });
});
