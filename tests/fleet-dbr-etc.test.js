// Fleet DBR ETC parsing: best-effort, never fabricated. No parsed date => NO ETC (date null).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-10';
const etc = (fields) => F.parseEtc(makeUnit(fields), TODAY);

describe('parseEtc classification', () => {
  it('date == today -> today', () => {
    expect(etc({ canonicalNextStep: 'ETC 11/10 per shop' })).toMatchObject({ state: 'today', date: '2026-11-10', source: 'canonicalNextStep' });
    expect(etc({ savedNotes: 'estimated completion 11/10' }).state).toBe('today');
  });
  it('no mention -> none with date null (never fabricated)', () => {
    expect(etc({ savedNotes: 'waiting on carrier', repairTimeline: '11/09 - towed to shop' }))
      .toEqual({ state: 'none', date: null, source: null, snippet: '' });
  });
  it('past date -> missed; future -> future', () => {
    expect(etc({ savedNotes: 'ETC 11/05' })).toMatchObject({ state: 'missed', date: '2026-11-05' });
    expect(etc({ savedNotes: 'ETC 11/20' })).toMatchObject({ state: 'future', date: '2026-11-20' });
  });
  it('"etc." (et cetera) and bare ETA are ignored; ETR counts', () => {
    expect(etc({ savedNotes: 'brakes, tires etc. 11/12' }).state).toBe('none');
    expect(etc({ savedNotes: 'Parts ETA 11/11' }).state).toBe('none');
    expect(etc({ savedNotes: 'ETR 11/12' })).toMatchObject({ state: 'future', date: '2026-11-12' });
  });
  it('negated "no ETC yet" in savedNotes beats a dated timeline ETC', () => {
    expect(etc({ savedNotes: 'no ETC yet', repairTimeline: '11/09 - ETC 11/10' })).toMatchObject({ state: 'none', date: null, source: 'savedNotes' });
  });
  it('"no ETC until parts arrive 11/12" -> none (R8)', () => {
    expect(etc({ canonicalNextStep: 'no ETC until parts arrive 11/12' })).toMatchObject({ state: 'none', date: null });
    expect(etc({ savedNotes: 'ETC: TBD 11/12' }).state).toBe('none');
  });
  it('a higher-priority source decides even when a lower one has a date', () => {
    expect(etc({ canonicalNextStep: 'ETC 11/05', savedNotes: 'ETC 11/10' })).toMatchObject({ state: 'missed', source: 'canonicalNextStep' });
  });
  it('latest-dated timeline line wins regardless of order', () => {
    const a = etc({ repairTimeline: '11/08 - ETC 11/20\n11/01 - ETC 11/15' });
    const b = etc({ repairTimeline: '11/01 - ETC 11/15\n11/08 - ETC 11/20' });
    expect(a).toMatchObject({ date: '2026-11-20', source: 'repairTimeline' });
    expect(b.date).toBe('2026-11-20');
    expect(etc({ repairTimeline: '11/01 - ETC 11/15\n11/08 - no ETC from dealer' }).state).toBe('none');
  });
  it('invalid dates are ignored (not negated)', () => {
    expect(etc({ savedNotes: 'ETC 2/30' }).state).toBe('none');
    expect(etc({ savedNotes: 'ETC 13/02' }).date).toBeNull();
    expect(etc({ savedNotes: 'ETC 2/30', repairTimeline: '11/09 - ETC 11/10' })).toMatchObject({ state: 'today', source: 'repairTimeline' });
  });
});

describe('inferDate', () => {
  it('explicit years', () => {
    expect(F.inferDate('11', '12', '25', TODAY)).toBe('2025-11-12');
    expect(F.inferDate('1', '3', '2027', TODAY)).toBe('2027-01-03');
  });
  it('Dec -> Jan rollover and > 60 days ahead -> previous year', () => {
    expect(F.inferDate('1', '5', null, '2026-12-20')).toBe('2027-01-05');
    expect(F.inferDate('12', '20', null, '2026-01-05')).toBe('2025-12-20');
    expect(F.inferDate('12', '31', null, '2026-10-15')).toBe('2025-12-31');
    expect(F.inferDate('12', '1', null, TODAY)).toBe('2026-12-01');
    expect(F.inferDate('3', '1', null, TODAY)).toBe('2026-03-01');
  });
  it('invalid dates -> null', () => {
    expect(F.inferDate('2', '30', null, TODAY)).toBeNull();
    expect(F.inferDate('13', '02', null, TODAY)).toBeNull();
  });
});

describe('parseTimelineLines', () => {
  it('parses M/D - text lines and keeps undated lines', () => {
    const l = F.parseTimelineLines('11/09 - towed\nfree text\n10/18: arrived', TODAY);
    expect(l.map((x) => [x.date, x.text])).toEqual([['2026-11-09', 'towed'], [null, 'free text'], ['2026-10-18', 'arrived']]);
  });
});

describe('ETC cells', () => {
  const row = F.buildFleetDbr([
    makeUnit({ equipmentId: 'E1', canonicalNextStep: 'ETC 11/10', workDuration: '5d' }),
    makeUnit({ equipmentId: 'E2', savedNotes: 'ETC 11/05', workDuration: '20d' }),
    makeUnit({ equipmentId: 'E3', savedNotes: 'ETR 11/1', workDuration: '30d' }),
    makeUnit({ equipmentId: 'E4', savedNotes: 'ETC 11/25' }),
    makeUnit({ equipmentId: 'E5', savedNotes: 'nothing yet' }),
    makeUnit({ equipmentId: 'E6', savedNotes: 'ETC 11/05', lifecycleState: 'Active' }),
  ], { today: TODAY }).rows[0];

  it('formats today / NO ETC / Missed; future goes to no column; non-down units never listed', () => {
    expect(row.cells.etcToday).toBe('1 \u2014 E1');
    expect(row.cells.missedEtc).toBe('2 \u2014 E3 (ETC 11/1), E2 (ETC 11/5)');
    expect(row.cells.noEtc).toBe('1 \u2014 E5');
    expect(JSON.stringify(row.cells)).not.toMatch(/E4|E6/);
    expect(row.units.find((u) => u.id === 'E4').etc).toMatchObject({ state: 'future', date: '2026-11-25' });
    expect(row.units.find((u) => u.id === 'E5').etc.date).toBeNull();
  });
  it('empty buckets are "0"', () => {
    const r = F.buildFleetDbr([makeUnit({ equipmentId: 'Z1', lifecycleState: 'Active' })], { today: TODAY }).rows[0];
    expect([r.cells.etcToday, r.cells.noEtc, r.cells.missedEtc]).toEqual(['0', '0', '0']);
  });
});
