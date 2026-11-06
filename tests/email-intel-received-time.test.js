// tests/email-intel-received-time.test.js — AC-5: the received-time parser (design 2.6, F-27).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseReceived, rank, isGood } = require('../src/email-intel/capture/received-time');

// Wednesday 2026-11-04 15:04:05 UTC; tzMinutes 0 keeps the matrix independent of the machine zone.
const NOW = Date.UTC(2026, 10, 4, 15, 4, 5);
const P = (raw, extra) => parseReceived(raw, Object.assign({ now: NOW, tzMinutes: 0 }, extra));

describe('AC-5 received-time token matrix', () => {
  it.each([
    ['2026-11-04T14:30:00Z', '2026-11-04T14:30:00.000Z', 'exact', 'second', true],
    ['2026-11-04T14:30:00-05:00', '2026-11-04T19:30:00.000Z', 'exact', 'second', true],
    ['2026-11-04T14:30', '2026-11-04T14:30:00.000Z', 'exact', 'minute', false],
    ['Wed 11/4/2026 2:14 PM', '2026-11-04T14:14:00.000Z', 'parsed-header', 'minute', false],
    ['11/4/2026 2:14 PM', '2026-11-04T14:14:00.000Z', 'parsed-header', 'minute', false],
    ['Wednesday, November 4, 2026 2:14 PM', '2026-11-04T14:14:00.000Z', 'parsed-header', 'minute', false],
    ['Sent: Nov 4, 2026 14:14', '2026-11-04T14:14:00.000Z', 'parsed-header', 'minute', false],
    ['14:00', '2026-11-04T14:00:00.000Z', 'inferred-today', 'minute', false],
    ['2:00 PM', '2026-11-04T14:00:00.000Z', 'inferred-today', 'minute', false],
    ['18:09', '2026-11-03T18:09:00.000Z', 'inferred-today', 'minute', false],         // would be in the future: yesterday
    ['6:09 PM', '2026-11-03T18:09:00.000Z', 'inferred-today', 'minute', false],
    ['Wed 18:09', '2026-10-28T18:09:00.000Z', 'inferred-date', 'minute', false],      // most recent PAST Wednesday at 18:09
    ['Wed 10:00', '2026-11-04T10:00:00.000Z', 'inferred-date', 'minute', false],
    ['Mon 11/2', '2026-11-02T00:00:00.000Z', 'inferred-date', 'day', false],
    ['Mon 10/6', '2025-10-06T00:00:00.000Z', 'inferred-date', 'day', false],          // 2026-10-06 is a Tuesday: roll back to the Monday
    ['Oct 9', '2026-10-09T00:00:00.000Z', 'inferred-date', 'day', false],
    ['12/25', '2025-12-25T00:00:00.000Z', 'inferred-date', 'day', false],              // future this year: previous year
    ['2026-11-01', '2026-11-01T00:00:00.000Z', 'inferred-date', 'day', false],
  ])('%s', (raw, iso, quality, precision, zoneExplicit) => {
    const r = P(raw);
    expect(r.iso).toBe(iso);
    expect(r.quality).toBe(quality);
    expect(r.precision).toBe(precision);
    expect(r.zoneExplicit).toBe(zoneExplicit);
    expect(r.raw.length).toBeGreaterThan(0);
  });

  it.each(['Yesterday', 'Yesterday 6:09 PM', 'Last week', 'soon', 'just now', '', '   ', null, undefined, '25:99', '13/45/2026 1:00 PM', 'Feb 31'])('unknown, never guessed: %s', (raw) => {
    const r = P(raw);
    expect(r.iso).toBeNull();
    expect(r.quality).toBe('unknown');
    expect(r.precision).toBeNull();
  });

  it('never produces the year-2001 Date.parse defect for partial tokens', () => {
    for (const raw of ['Oct 9', '10/6', 'Mon 10/6', '18:09', 'Wed 18:09']) {
      const r = P(raw);
      expect(new Date(r.iso).getUTCFullYear()).toBeGreaterThanOrEqual(2025);
    }
  });

  it('quality ranking and GOOD set', () => {
    expect(rank('exact')).toBeGreaterThan(rank('parsed-header'));
    expect(rank('parsed-header')).toBeGreaterThan(rank('inferred-today'));
    expect(rank('inferred-today')).toBeGreaterThan(rank('inferred-date'));
    expect(rank('inferred-date')).toBeGreaterThan(rank('unknown'));
    expect(rank('nonsense')).toBe(0);
    expect(['exact', 'parsed-header'].every(isGood)).toBe(true);
    expect(['inferred-today', 'inferred-date', 'unknown'].some(isGood)).toBe(false);
  });

  it('without tzMinutes the local machine zone is assumed (A-4)', () => {
    const local = parseReceived('Wed 11/4/2026 2:14 PM', { now: NOW });
    expect(local.iso).toBe(new Date(2026, 10, 4, 14, 14, 0, 0).toISOString());
    expect(local.zoneExplicit).toBe(false);
  });
});
