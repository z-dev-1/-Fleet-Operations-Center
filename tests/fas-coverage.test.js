// tests/fas-coverage.test.js
//
// Digital FAS coverage profile: coverage == Zila's domiciles + operators
// (operator == SCAC == carrier), derived from the authoritative synced
// fleetData. Verifies derivation, refresh triggers, stale-preserve (never wipe
// verified coverage on an empty/failed sync), and conflict preservation.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');

let store, coverage;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fas-cov-'));
  setDataDir(tmp);
  // fresh module instances against the new data dir
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/orcha/fas/coverage')];
  store = require('../src/store');
  coverage = require('../src/orcha/fas/coverage');
});

function seedFleet(rows) {
  store.save('fleetData', { rows, syncedAt: new Date().toISOString() });
}

describe('coverage.derive/refresh — from fleetData operators + domiciles', () => {
  it('derives distinct operators (SCAC) and domiciles from fleet rows', () => {
    seedFleet([
      { equipmentId: '122269', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab' },
      { equipmentId: '39461', operator: 'YTSC', domicileSite: 'AVP40', bodyType: 'Sleeper' },
      { equipmentId: 'B12008', operator: 'tuzr', domicileSite: 'abe40' }, // case-normalized
    ]);
    const p = coverage.refresh({ reason: 'test' });
    expect(p.stale).toBe(false);
    expect(p.source).toBe('fleetData');
    expect(coverage.listOperators().sort()).toEqual(['TUZR', 'YTSC']);
    expect(coverage.listDomiciles().sort()).toEqual(['ABE40', 'AVP40']);
    expect(coverage.isOperatorCovered('tuzr')).toBe(true);
    expect(coverage.isDomicileCovered('AVP40')).toBe(true);
    expect(coverage.isOperatorCovered('NOPE')).toBe(false);
  });

  it('records operator->domiciles and domicile->operators relationships', () => {
    seedFleet([
      { equipmentId: 'A', operator: 'TUZR', domicileSite: 'ABE40' },
      { equipmentId: 'B', operator: 'TUZR', domicileSite: 'AVP40' },
    ]);
    coverage.refresh({ reason: 'test' });
    const prof = coverage.get();
    const tuzr = prof.operators.find(o => o.scac === 'TUZR');
    expect(tuzr.domiciles.sort()).toEqual(['ABE40', 'AVP40']);
  });
});

describe('coverage stale-preserve — never wipe verified coverage', () => {
  it('preserves the last verified profile when a refresh sees no rows', () => {
    seedFleet([{ equipmentId: 'A', operator: 'TUZR', domicileSite: 'ABE40' }]);
    coverage.refresh({ reason: 'good' });
    expect(coverage.listOperators()).toEqual(['TUZR']);

    // Empty/failed sync
    store.save('fleetData', { rows: [] });
    const p = coverage.refresh({ reason: 'empty' });
    expect(p.stale).toBe(true);
    // Verified operators/domiciles are STILL there.
    expect(coverage.listOperators()).toEqual(['TUZR']);
    expect(coverage.listDomiciles()).toEqual(['ABE40']);
  });

  it('marks derive() ok:false on empty rows (caller must preserve)', () => {
    store.save('fleetData', { rows: [] });
    const d = coverage.derive();
    expect(d.ok).toBe(false);
  });
});

describe('coverage conflict preservation', () => {
  it('records a conflict when a previously-verified operator vanishes from the newest source', () => {
    seedFleet([
      { equipmentId: 'A', operator: 'TUZR', domicileSite: 'ABE40' },
      { equipmentId: 'B', operator: 'YTSC', domicileSite: 'AVP40' },
    ]);
    coverage.refresh({ reason: 'v1' });
    // Next sync only has TUZR (YTSC vanished) — newest source wins but conflict recorded.
    seedFleet([{ equipmentId: 'A', operator: 'TUZR', domicileSite: 'ABE40' }]);
    const p = coverage.refresh({ reason: 'v2' });
    expect(coverage.listOperators()).toEqual(['TUZR']); // prefers newest authoritative source
    expect(p.conflicts.length).toBeGreaterThan(0);
    expect(p.conflicts[p.conflicts.length - 1].operators).toContain('YTSC');
  });
});

describe('coverage.summary — compact, no unit-level data', () => {
  it('returns operator/domicile counts + lists + stale flag, no rows', () => {
    seedFleet([{ equipmentId: 'A', operator: 'TUZR', domicileSite: 'ABE40' }]);
    coverage.refresh({ reason: 'test' });
    const s = coverage.summary();
    expect(s.operatorCount).toBe(1);
    expect(s.domicileCount).toBe(1);
    expect(s.operators).toEqual(['TUZR']);
    expect(s.stale).toBe(false);
    expect(s).not.toHaveProperty('rows');
  });
});
