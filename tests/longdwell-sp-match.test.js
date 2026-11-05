// tests/longdwell-sp-match.test.js - matchUnits (src/longdwell/sheet-match.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { matchUnits } = require('../src/longdwell/sheet-match');

const row = (sheetRow, unitKey, vendor = 'Amerit', wo = '') => ({ sheetRow, unitKey, vendor, wo, site: 'DXX1' });
const wo = (equipmentId, woKey, extra = {}) => ({ equipmentId, woKey, isPrimary: false, woNumber: '', woAmz: '', vendor: 'Amerit', ...extra });

describe('basic matching', () => {
  it('unique unit/unit (via unit) with a match key', () => {
    const [m] = matchUnits([row(5, 'AB100'), row(6, 'AB101')], [wo('AB100', 'k1')]);
    expect(m).toMatchObject({ equipmentId: 'AB100', woKey: 'k1', match: 'matched', sheetRow: 5, via: 'unit', needsConfirm: false });
    expect(m.matchKey).toEqual({ via: 'unit', sheetRow: 5, vendorKey: 'AMERIT', woKey: '', candidateCount: 1 });
  });
  it('unit absent -> not-in-sheet (nothing added)', () => {
    expect(matchUnits([row(5, 'AB100')], [wo('ZZ1', 'k')])[0]).toMatchObject({ match: 'not-in-sheet', sheetRow: null, matchKey: null });
  });
  it('1 row and N WOs: primary matched with needsConfirm, others extra-wo', () => {
    const r = matchUnits([row(5, 'AB100')], [wo('AB100', 'a'), wo('AB100', 'b', { isPrimary: true })]);
    expect(r[0]).toMatchObject({ woKey: 'a', match: 'extra-wo', sheetRow: null });
    expect(r[1]).toMatchObject({ woKey: 'b', match: 'matched', sheetRow: 5, needsConfirm: true, via: 'unit' });
  });
  it('id normalization: aaid_ prefix, case, NBSP, numeric .0; leading zeros preserved', () => {
    const rows = [row(2, 'aaid_ab100'), row(3, 'AB\u00a0101'), row(4, '520024'), row(5, '0123')];
    const r = matchUnits(rows, [wo('AB100', 'a'), wo('ab101', 'b'), wo('520024.0', 'c'), wo('123', 'd'), wo('0123', 'e')]);
    expect(r.map((x) => [x.match, x.sheetRow])).toEqual([['matched', 2], ['matched', 3], ['matched', 4], ['not-in-sheet', null], ['matched', 5]]);
  });
  it('blank Asset ID rows are ignored', () => {
    const r = matchUnits([row(2, ''), row(3, '  '), row(4, 'AB100')], [wo('AB100', 'a'), wo('', 'b')]);
    expect(r[0]).toMatchObject({ match: 'matched', sheetRow: 4 });
    expect(r[1].match).toBe('not-in-sheet');
  });
});

describe('multi-row units', () => {
  it('multi-WO resolved by the WO column (via wo-column, deterministic)', () => {
    const rows = [row(5, 'AB100', 'Amerit', 'WO-111'), row(6, 'AB100', 'Amerit', '222')];
    const r = matchUnits(rows, [wo('AB100', 'a', { woNumber: '222' }), wo('AB100', 'b', { woAmz: 'wo 111' })], { hasWoCol: true });
    expect(r[0]).toMatchObject({ match: 'matched', sheetRow: 6, via: 'wo-column', needsConfirm: false });
    expect(r[1]).toMatchObject({ match: 'matched', sheetRow: 5, via: 'wo-column' });
    expect(r[1].matchKey).toEqual({ via: 'wo-column', sheetRow: 5, vendorKey: 'AMERIT', woKey: 'WO 111', candidateCount: 1 });
  });
  it('M rows and 1 WO resolved only by vendor equality (via vendor)', () => {
    const rows = [row(5, 'AB100', 'Amerit'), row(6, 'AB100', 'Rush Truck')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { vendor: 'RUSH-TRUCK' })]);
    expect(m).toMatchObject({ match: 'matched', sheetRow: 6, via: 'vendor' });
  });
  it('vendor strings that differ in spelling stay ambiguous', () => {
    const rows = [row(5, 'AB100', 'AMERIT FLEET SOLUTIONS'), row(6, 'AB100', 'Rush')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { vendor: 'Amerit' })]);
    expect(m).toMatchObject({ match: 'ambiguous', candidates: [5, 6], sheetRow: null });
  });
  it('Site is not a filter: same unit, same vendor, no other discriminator -> ambiguous', () => {
    const [m] = matchUnits([row(5, 'AB100'), row(6, 'AB100')], [wo('AB100', 'a')]);
    expect(m.match).toBe('ambiguous');
  });
  it('M rows and N WOs: bijection by vendor resolves', () => {
    const rows = [row(5, 'AB100', 'Amerit'), row(6, 'AB100', 'Rush')];
    const r = matchUnits(rows, [wo('AB100', 'a', { vendor: 'Rush' }), wo('AB100', 'b', { vendor: 'amerit' })]);
    expect(r.map((x) => [x.match, x.sheetRow, x.via])).toEqual([['matched', 6, 'vendor'], ['matched', 5, 'vendor']]);
  });
  it('M rows and N WOs unresolved -> ambiguous with candidates', () => {
    const rows = [row(5, 'AB100', 'Amerit'), row(6, 'AB100', 'Amerit'), row(7, 'AB100', 'Rush')];
    const r = matchUnits(rows, [wo('AB100', 'a', { vendor: 'Amerit' }), wo('AB100', 'b', { vendor: 'Amerit' })]);
    expect(r[0]).toMatchObject({ match: 'ambiguous', candidates: [5, 6] });
    expect(r[1]).toMatchObject({ match: 'ambiguous', candidates: [5, 6] });
  });
  it('two WOs with the same sole candidate are both ambiguous (bijection)', () => {
    const rows = [row(5, 'AB100', 'Amerit'), row(6, 'AB100', 'Rush')];
    const r = matchUnits(rows, [wo('AB100', 'a', { vendor: 'Rush' }), wo('AB100', 'b', { vendor: 'Rush' })]);
    expect(r.map((x) => x.match)).toEqual(['ambiguous', 'ambiguous']);
  });
  it('exact duplicate rows are ambiguous', () => {
    const rows = [row(5, 'AB100', 'Amerit', '111'), row(6, 'AB100', 'Amerit', '111')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { woNumber: '111' })], { hasWoCol: true });
    expect(m).toMatchObject({ match: 'ambiguous', candidates: [5, 6] });
  });
});

describe('WO precedence (A7)', () => {
  it('rows [WO=111,vendor X],[WO=222,vendor X] vs computed WO 333 vendor X is ambiguous, not a vendor match', () => {
    const rows = [row(5, 'AB100', 'X', '111'), row(6, 'AB100', 'X', '222')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { woNumber: '333', vendor: 'X' })], { hasWoCol: true });
    expect(m.match).toBe('ambiguous');
    expect(m.candidates).toEqual([]);
  });
  it('blank-WO rows are candidates only when no row matches the WO', () => {
    const rows = [row(5, 'AB100', 'X', '111'), row(6, 'AB100', 'X', '')];
    const r = matchUnits(rows, [wo('AB100', 'a', { woNumber: '333', vendor: 'X' })], { hasWoCol: true });
    expect(r[0]).toMatchObject({ match: 'matched', sheetRow: 6, needsConfirm: true });
    const r2 = matchUnits(rows, [wo('AB100', 'b', { woNumber: '111', vendor: 'X' })], { hasWoCol: true });
    expect(r2[0]).toMatchObject({ match: 'matched', sheetRow: 5, via: 'wo-column', needsConfirm: false });
  });
  it('vendor filter applies after the WO filter only when more than one candidate is left', () => {
    const rows = [row(5, 'AB100', 'X', ''), row(6, 'AB100', 'Y', ''), row(7, 'AB100', 'X', '999')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { woNumber: '333', vendor: 'y' })], { hasWoCol: true });
    expect(m).toMatchObject({ match: 'matched', sheetRow: 6, via: 'vendor' });
  });
  it('no WO column: WO filter skipped', () => {
    const rows = [row(5, 'AB100', 'X', '111'), row(6, 'AB100', 'Y', '222')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { woNumber: '222', vendor: 'X' })], { hasWoCol: false });
    expect(m).toMatchObject({ match: 'matched', sheetRow: 5, via: 'vendor' });
  });
  it('WO and vendor comparison use normKey (case and punctuation insensitive, equality only)', () => {
    const rows = [row(5, 'AB100', 'Amerit Fleet', 'wo#111'), row(6, 'AB100', 'Amerit', 'WO 1111')];
    const [m] = matchUnits(rows, [wo('AB100', 'a', { woNumber: 'WO-111' })], { hasWoCol: true });
    expect(m).toMatchObject({ match: 'matched', sheetRow: 5, via: 'wo-column' });
    const [v] = matchUnits([row(5, 'AB100', 'Amerit Fleet'), row(6, 'AB100', 'Amerit')], [wo('AB100', 'a', { vendor: 'AMERIT' })]);
    expect(v).toMatchObject({ match: 'matched', sheetRow: 6, via: 'vendor' });
  });
});
