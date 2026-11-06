// tests/email-intel-scope.test.js — scope index and the deterministic full-body unit pass
// (design 3.2; R1.3, R2.3, AC-7, F-25, F2-10).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { IN_SCOPE, fleetData } from './fixtures/email-intel/fleet.js';
import { scenarios } from './fixtures/email-intel/emails.js';
import { NOW, recordOf, scopeIndex } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const scope = require('../src/email-intel/understand/scope');
const C = require('../src/email-intel/constants');

describe('scope index', () => {
  it('R2.3 matches fleet without naming me: in for fleet units, out for other ids', () => {
    const idx = scopeIndex('fresh');
    expect(idx).toMatchObject({ ready: true, stale: false, reason: 'ok' });
    for (const r of IN_SCOPE) expect(idx.scopeOf(r.equipmentId)).toBe('in');
    expect(idx.scopeOf('51888')).toBe('out');
    expect(idx.detail('40123')).toMatchObject({ scope: 'in', unit: '40123', operator: 'ACME DSP', domicileSite: 'ABE1', rosterMismatch: false });
  });

  it('R2.3 empty or stale fleet is unknown not out', () => {
    for (const v of ['empty', 'stale']) {
      const idx = scopeIndex(v);
      expect(idx.scopeOf('40123')).toBe('unknown');
      expect(idx.scopeOf('51888')).toBe('unknown');
      expect(idx.reason).toBe(v === 'empty' ? 'fleet-empty' : 'fleet-stale');
    }
    // missing / unparseable sync time is stale; scrapedAt is the fallback (F-25)
    const rows = fleetData('fresh', NOW).rows;
    expect(scope.buildScopeIndex({ now: NOW, fleetData: { rows } }).scopeOf('40123')).toBe('unknown');
    expect(scope.buildScopeIndex({ now: NOW, fleetData: { rows, syncedAt: 'yesterday' } }).scopeOf('40123')).toBe('unknown');
    expect(scope.buildScopeIndex({ now: NOW, fleetData: { rows, scrapedAt: new Date(NOW - 3_600_000).toISOString() } }).scopeOf('40123')).toBe('in');
    const edge = new Date(NOW - C.FLEET_STALE_HOURS * 3_600_000).toISOString();
    expect(scope.buildScopeIndex({ now: NOW, fleetData: { rows, syncedAt: edge } }).stale).toBe(false);
    expect(scope.buildScopeIndex({ now: NOW + 1, fleetData: { rows, syncedAt: edge } }).stale).toBe(true);
    expect(scope.buildScopeIndex({ now: NOW, fleetData: null }).ready).toBe(false);
  });

  it('exact normalized match only: a prefix variant is not guessed', () => {
    const idx = scopeIndex('fresh');
    expect(idx.scopeOf('A40123')).toBe('out');
    expect(idx.scopeOf(' 40123 ')).toBe('in');
  });

  it('roster cross-check only downgrades (rosterMismatch) and never upgrades an out unit', () => {
    const fasFor = (op, site) => (site === 'ABE1' ? 'Other Person' : 'Zila Santiago');
    const idx = scopeIndex('fresh', { fasName: 'Zila Santiago', fasFor });
    expect(idx.detail('40123')).toMatchObject({ scope: 'in', rosterMismatch: true });
    expect(idx.detail('40456')).toMatchObject({ scope: 'in', rosterMismatch: false });
    expect(idx.detail('51888')).toMatchObject({ scope: 'out', rosterMismatch: false });
    const noName = scopeIndex('fresh', { fasName: 'Zila Santiago', fasFor: () => '' });
    expect(noName.detail('40123').rosterMismatch).toBe(false);
  });

  it('F2-10 an empty fasName changes no scope result (cross-check skipped)', () => {
    let calls = 0;
    const fasFor = () => { calls++; return 'Other Person'; };
    const ids = IN_SCOPE.map((r) => r.equipmentId).concat(['51888', 'A40123', '99999']);
    const base = scopeIndex('fresh');
    for (const fasName of ['', '   ', undefined]) {
      const idx = scopeIndex('fresh', { fasName, fasFor });
      for (const id of ids) expect(idx.detail(id)).toEqual(base.detail(id));
    }
    expect(calls).toBe(0);
    const stale = scopeIndex('stale', { fasName: '', fasFor });
    for (const id of ids) expect(stale.detail(id)).toEqual(scopeIndex('stale').detail(id));
  });
});

describe('deterministic unit pass', () => {
  it('R1.3 deterministic full-body unit pass finds units anywhere with offsets', () => {
    const rec = recordOf(scenarios.longBody1500());
    const scan = scope.scanMessage(rec, scopeIndex('fresh'));
    const u = scan.all.find((x) => x.id === '40789');
    expect(u).toBeTruthy();
    expect(u.scope).toBe('in');
    expect(u.offsets[0]).toBeGreaterThan(1500);
    expect(rec.body.newContent.slice(u.offsets[0], u.offsets[0] + 5)).toBe('40789');
  });

  it('E: multi-unit text yields every id with its own scope', () => {
    const scan = scope.scanMessage(recordOf(scenarios.multiUnit()), scopeIndex('fresh'));
    const by = Object.fromEntries(scan.all.map((u) => [u.id, u.scope]));
    expect(by).toMatchObject({ 40123: 'in', 40456: 'in', 51888: 'out', 62100: 'out' });
  });

  it('dates, phone numbers and $ amounts are not unit ids; subject units are reported', () => {
    const units = scope.extractUnits('On Nov 4, 2026 call 555-123-4567 about $12500 for 40123 by 2026-11-12 or 11/12/2026', scopeIndex('fresh'));
    expect(units.map((u) => u.id)).toEqual(['40123']);
    const rec = recordOf(scenarios.multi20to());
    const scan = scope.scanMessage(rec, scopeIndex('fresh'));
    expect(scan.all.find((x) => x.id === '40123')).toMatchObject({ inSubject: true, inBody: true });
  });

  it('units only in quoted text are reported separately, never as body mentions', () => {
    const rec = recordOf(scenarios.multi20to());
    rec.body.unitsOnlyInQuoted = ['40999'];
    const scan = scope.scanMessage(rec, scopeIndex('fresh'));
    expect(scan.quotedOnly).toEqual([{ id: '40999', key: '40999', scope: 'in' }]);
    expect(scan.all.some((u) => u.id === '40999')).toBe(false);
  });
});
