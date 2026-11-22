// tests/aperia-export.test.js — src/aperia/export.js: formula-injection guard, numbers stay numeric,
// tab/newline flattening, domicile filter, TSV header / CRLF, Excel file content, no map image URL.
process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOW, VEHICLE_DETAIL, ISSUES_PAGE } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const X = require('../src/aperia/export');
const P = require('../src/aperia/parsers');
const client = require('../src/aperia/client');

const unit = P.parseVehicleDetail(VEHICLE_DETAIL, { now: NOW }).unit;
const results = [
  { assetId: 'NP6923', found: true, unit },
  { assetId: 'NOPE1', found: false, code: 'APERIA_UNIT_NOT_FOUND' },
];

describe('cell()', () => {
  it('prefixes formula starters with an apostrophe', () => {
    expect(X.cell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(X.cell('+1')).toBe("'+1");
    expect(X.cell('-2+3')).toBe("'-2+3");
    expect(X.cell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(X.cell('NP6923')).toBe('NP6923');
  });

  it('finite numbers stay numeric (negative and 0 included); non-finite -> blank', () => {
    expect(X.cell(-12.5)).toBe(-12.5);
    expect(X.cell(0)).toBe(0);
    expect(X.cell(NaN)).toBe('');
    expect(X.cell(null)).toBe('');
    expect(X.cell(undefined)).toBe('');
  });

  it('tabs and newlines become spaces (then the guard applies)', () => {
    expect(X.cell('a\tb\r\nc\nd')).toBe('a b c d');
    expect(X.cell('\t=1')).toBe(" =1");
    expect(X.cell('=1\t2')).toBe("'=1 2");
  });
});

describe('row builders', () => {
  it('tireRows: one row per tire, NOT FOUND row for a missing unit, no map image URL', () => {
    const rows = X.tireRows(results);
    expect(rows).toHaveLength(11);
    const crit = rows.find((r) => r.position === 'R1IC');
    expect(crit).toMatchObject({ unit: 'NP6923', domicile: 'ATL2', group: 'Ops B', pressurePsi: 70, setPointPsi: 100, deltaPsi: -30, pctOfSetPoint: 70,
      flag: 'CRITICAL LOW', issueSeverity: 'CRITICAL', issueType: 'UNDERINFLATION', issueResolveBy: 'immediately', gpsLat: 32.89654,
      gpsLng: -97.03804, gpsOutsideUs: 'NO', lookup: 'OK' });
    expect(crit.issueAction).toContain('Inflate the tire to the set point.');
    expect(rows[10]).toMatchObject({ unit: 'NOPE1', lookup: 'NOT FOUND', domicile: '' });
    expect(Object.keys(rows[0]).sort()).toEqual(X.TIRE_COLUMNS.slice().sort());
    expect(JSON.stringify(rows)).not.toContain('googleapis');
    expect(X.TIRE_COLUMNS.join(',')).not.toMatch(/map/i);
  });

  it('domicile filter applies to tire, issue and cross-link rows', () => {
    expect(X.tireRows(results, { domicile: 'ATL2' })).toHaveLength(10);
    expect(X.tireRows(results, { domicile: 'DFW5' })).toHaveLength(0);
    const issues = P.flattenIssues(P.parseIssuesPage(ISSUES_PAGE).rows);
    expect(X.issueRows(issues)).toHaveLength(4);
    const dfw = X.issueRows(issues, { domicile: 'DFW5' });
    expect(dfw.map((r) => r.issueId)).toEqual(['9003', '9004']);
    expect(dfw[0]).toMatchObject({ severity: 'CRITICAL', unit: '122269', muted: 'YES' });
    expect(Object.keys(dfw[0]).sort()).toEqual(X.ISSUE_COLUMNS.slice().sort());
    const cl = client.crossLinkCriticalNoCase(issues, { dtnaEntries: [], fleetRows: [] });
    const clRows = X.crossLinkRows(cl);
    expect(clRows).toHaveLength(1);
    expect(clRows[0]).toMatchObject({ unit: 'NP6923', domicile: 'ATL2', criticalCount: 1, states: 'UNDERINFLATION', inFleet: 'NO', closedDtnaCases: 0 });
    expect(Object.keys(clRows[0]).sort()).toEqual(X.CROSSLINK_COLUMNS.slice().sort());
    expect(X.crossLinkRows(cl, { domicile: 'DFW5' })).toEqual([]);
  });
});

describe('TSV / Excel', () => {
  const evil = { unit: "=cmd|' /C calc'!A0", domicile: 'ATL2', group: '+1', vin: '-2+3', position: '@SUM(A1)', positionName: 'tab\there',
    pressurePsi: 0, setPointPsi: 100, deltaPsi: -12.5, pctOfSetPoint: 0, lookup: 'OK' };

  it('toTSV: header row, CRLF line ends, guarded strings, plain numbers', () => {
    const tsv = X.toTSV(X.TIRE_COLUMNS, [evil]);
    const lines = tsv.split('\r\n');
    expect(tsv.endsWith('\r\n')).toBe(true);
    expect(lines[0]).toBe(X.TIRE_COLUMNS.join('\t'));
    const cells = lines[1].split('\t');
    expect(cells).toHaveLength(X.TIRE_COLUMNS.length);
    const at = (c) => cells[X.TIRE_COLUMNS.indexOf(c)];
    expect(at('unit')).toBe("'=cmd|' /C calc'!A0");
    expect(at('group')).toBe("'+1");
    expect(at('vin')).toBe("'-2+3");
    expect(at('position')).toBe("'@SUM(A1)");
    expect(at('positionName')).toBe('tab here');
    expect(at('pressurePsi')).toBe('0');
    expect(at('deltaPsi')).toBe('-12.5');
    expect(at('pctOfSetPoint')).toBe('0');
  });

  it('writeExport writes .tsv and .xls named aperia-<kind>-<YYYY-MM-DD> with guarded text and 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-export-'));
    const t = X.writeExport({ kind: 'tires', columns: X.TIRE_COLUMNS, rows: [evil], format: 'tsv', dir, date: NOW });
    expect(t).toEqual({ filename: 'aperia-tires-2026-11-22.tsv' });
    const tsv = fs.readFileSync(path.join(dir, t.filename), 'utf8');
    expect(tsv).toContain("'=cmd|' /C calc'!A0");
    const x = X.writeExport({ kind: 'tires', columns: X.TIRE_COLUMNS, rows: [evil], format: 'xls', dir, date: NOW });
    expect(x).toEqual({ filename: 'aperia-tires-2026-11-22.xls' });
    const xml = fs.readFileSync(path.join(dir, x.filename), 'utf8');
    expect(xml).toContain("'=cmd|' /C calc'!A0");
    expect(xml).toContain("'+1");
    expect(xml).toContain("'@SUM(A1)");
    expect(xml).toContain('>0</Data>');
    expect(xml).toContain('>-12.5</Data>');
    expect(xml).not.toContain(">=cmd");
    expect(() => X.writeExport({ kind: '../x', columns: [], rows: [], format: 'tsv', dir })).toThrow();
  });

  it('a second same-day export of the same kind gets -2, -3 and leaves the earlier files intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-export-'));
    const a = X.writeExport({ kind: 'issues', columns: ['unit'], rows: [{ unit: 'FIRST' }], format: 'tsv', dir, date: NOW });
    const b = X.writeExport({ kind: 'issues', columns: ['unit'], rows: [{ unit: 'SECOND' }], format: 'tsv', dir, date: NOW });
    const c = X.writeExport({ kind: 'issues', columns: ['unit'], rows: [{ unit: 'THIRD' }], format: 'tsv', dir, date: NOW });
    expect([a.filename, b.filename, c.filename]).toEqual(['aperia-issues-2026-11-22.tsv', 'aperia-issues-2026-11-22-2.tsv', 'aperia-issues-2026-11-22-3.tsv']);
    expect(fs.readFileSync(path.join(dir, a.filename), 'utf8')).toContain('FIRST');
    expect(fs.readFileSync(path.join(dir, b.filename), 'utf8')).toContain('SECOND');
    expect(X.writeExport({ kind: 'issues', columns: ['unit'], rows: [], format: 'xls', dir, date: NOW }).filename).toBe('aperia-issues-2026-11-22.xls');
  });
});
