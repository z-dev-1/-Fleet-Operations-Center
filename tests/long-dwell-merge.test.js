import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ld = require('../src/ipc/long-dwell-csv');

// ISO timestamp N days before now — used to drive the Days-Down filter.
function daysAgoIso(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// A WR export row (header-name keyed, the same shape buildLongDwellSources and
// _parseToObjects produce). `downDays` controls Actual-start-date-time so the
// MIN_DAYS_DOWN filter can be exercised deterministically.
function wrRow({ unit, vendor = 'Amerit', supplier = '', l1 = 'Engine', downDays = 10, reason = 'Offsite Shop Repair', site = 'EOFE01' }) {
  return {
    'Equipment ID': unit,
    'Asset Type': 'tractor',
    'Lifecycle State Reason': reason,
    'Vendor': vendor,
    'Suppliers': supplier,
    'Delay reason codes': 'PARTS_DELAY',
    'L1 Area of Concern': l1,
    'L2 Area of Concern': 'Engine Assembly',
    'Asset Domicile Site': site,
    'Reported location': site,
    'Status': 'WORK_IN_PROGRESS',
    'Expected completed date time': daysAgoIso(-3),
    'Actual start date time': daysAgoIso(downDays),
  };
}

function assetRow({ unit, site = 'EOFE01', operator = 'JLIT' }) {
  return {
    'Equipment ID': unit,
    'Domicile site': site,
    'Operator': operator,
    'Asset type': 'tractor',
    'Lifecycle state reason': 'Offsite Shop Repair',
  };
}

describe('Long Dwell merge — shared join/exclusion/filter logic', () => {
  it('joins a WR row to its asset row by unit number and maps the A–M columns', () => {
    const out = ld._mergeRowObjects([wrRow({ unit: '520024' })], [assetRow({ unit: '520024', operator: 'JLIT' })]);
    expect(out.columns).toEqual(ld.TRACKER_COLUMNS);
    expect(out.rows.length).toBe(1);
    const row = out.rows[0].csv;
    expect(row['Asset ID']).toBe('520024');
    expect(row['Site']).toBe('EOFE01');
    expect(row['SCAC']).toBe('JLIT');          // from the asset export's Operator
    expect(row['RG Vendor Assigned']).toBe('Amerit');
    expect(row['Level 1']).toBe('Engine');
    expect(Number(row['Days Down'])).toBeGreaterThanOrEqual(5);
  });

  it('excludes FleetNet TOW work requests but keeps other FleetNet repairs', () => {
    const out = ld._mergeRowObjects([
      wrRow({ unit: '111', vendor: 'FLEETNET', l1: 'Tow' }),     // dropped
      wrRow({ unit: '222', vendor: 'FleetNet', l1: 'Engine' }),  // kept (not a tow)
    ], []);
    const units = out.rows.map((r) => r.csv['Asset ID']);
    expect(units).toContain('222');
    expect(units).not.toContain('111');
  });

  it('excludes VELOCITI orders by vendor OR supplier', () => {
    const out = ld._mergeRowObjects([
      wrRow({ unit: '333', vendor: 'VELOCITI' }),                  // dropped (vendor)
      wrRow({ unit: '444', vendor: 'Amerit', supplier: 'Velociti' }), // dropped (supplier)
      wrRow({ unit: '555', vendor: 'Amerit' }),                    // kept
    ], []);
    const units = out.rows.map((r) => r.csv['Asset ID']);
    expect(units).toEqual(['555']);
  });

  it('drops units down fewer than MIN_DAYS_DOWN days', () => {
    expect(ld.MIN_DAYS_DOWN).toBe(5);
    const out = ld._mergeRowObjects([
      wrRow({ unit: '601', downDays: 1 }),   // too fresh — dropped
      wrRow({ unit: '602', downDays: 4 }),   // still under 5 — dropped
      wrRow({ unit: '603', downDays: 5 }),   // exactly 5 — kept
      wrRow({ unit: '604', downDays: 30 }),  // kept
    ], []);
    const units = out.rows.map((r) => r.csv['Asset ID']).sort();
    expect(units).toEqual(['603', '604']);
  });

  it('keeps a row whose down date cannot be computed (never silently drop)', () => {
    const r = wrRow({ unit: '700' });
    // Blank out every date field so _daysSince returns '' (unknown).
    r['Actual start date time'] = '';
    r['Expected start date time'] = '';
    r['Scheduled date time'] = '';
    r['Last modified time'] = '';
    const out = ld._mergeRowObjects([r], []);
    expect(out.rows.map((x) => x.csv['Asset ID'])).toEqual(['700']);
    expect(out.rows[0].csv['Days Down']).toBe(''); // unknown, but kept
  });

  it('falls back to the WR site when no asset row matches the unit', () => {
    const out = ld._mergeRowObjects([wrRow({ unit: '810', site: 'DNJ5' })], []);
    expect(out.rows[0].csv['Site']).toBe('DNJ5');
  });
});

describe('Long Dwell merge helpers', () => {
  it('_unitKey strips an aaid_ prefix and uppercases', () => {
    expect(ld._unitKey('aaid_abc123')).toBe('ABC123');
    expect(ld._unitKey('  520024 ')).toBe('520024');
  });

  it('_daysSince returns whole days for a valid date and "" for junk', () => {
    expect(ld._daysSince(daysAgoIso(7))).toBe('7');
    expect(ld._daysSince('not-a-date')).toBe('');
    expect(ld._daysSince('')).toBe('');
  });

  it('_parseToObjects reads header-keyed rows from CSV text', () => {
    const csv = 'Equipment ID,Vendor\n520024,Amerit\n520025,Ryder\n';
    const { headers, rows } = ld._parseToObjects(csv);
    expect(headers).toEqual(['Equipment ID', 'Vendor']);
    expect(rows.length).toBe(2);
    expect(rows[0]['Equipment ID']).toBe('520024');
    expect(rows[1]['Vendor']).toBe('Ryder');
  });

  it('_mergeToImportPayload parses + merges CSV text end-to-end', () => {
    const wrCsv = 'Equipment ID,Vendor,L1 Area of Concern,Actual start date time\n'
      + '520024,Amerit,Engine,' + daysAgoIso(12) + '\n';
    const assetCsv = 'Equipment ID,Domicile site,Operator\n520024,EOFE01,JLIT\n';
    const out = ld._mergeToImportPayload(wrCsv, assetCsv);
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].csv['SCAC']).toBe('JLIT');
    expect(out.rows[0].csv['Asset ID']).toBe('520024');
  });
});
