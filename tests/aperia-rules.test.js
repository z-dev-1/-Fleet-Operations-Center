// tests/aperia-rules.test.js — pure tire-flag / GPS / ET rules (src/aperia/rules.js).
// TZ is forced to UTC to prove ET formatting is explicit, not the machine zone.
process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { NOW, GEO_PLACEHOLDER, GEO_US, GEO_OUTSIDE } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const R = require('../src/aperia/rules');
const C = require('../src/aperia/constants');

const DAY = 24 * 3600e3;
const fresh = new Date(NOW - 3600e3).toISOString();
const old = new Date(NOW - 8 * DAY).toISOString();
const flag = (s) => R.tireFlag(s, NOW);

describe('tireFlag', () => {
  it('thresholds with exact boundaries (80% LOW, 90% and 110% OK)', () => {
    expect(flag({ pressure: 79.9, setPoint: 100, updatedAt: fresh })).toBe('CRITICAL LOW');
    expect(flag({ pressure: 80, setPoint: 100, updatedAt: fresh })).toBe('LOW');
    expect(flag({ pressure: 88, setPoint: 110, updatedAt: fresh })).toBe('LOW');
    expect(flag({ pressure: 89.9, setPoint: 100, updatedAt: fresh })).toBe('LOW');
    expect(flag({ pressure: 90, setPoint: 100, updatedAt: fresh })).toBe('OK');
    expect(flag({ pressure: 100, setPoint: 100, updatedAt: fresh })).toBe('OK');
    expect(flag({ pressure: 110, setPoint: 100, updatedAt: fresh })).toBe('OK');
    expect(flag({ pressure: 110.1, setPoint: 100, updatedAt: fresh })).toBe('HIGH');
  });

  it('dead sensor (pressure 0, 8 days old) is STALE; fresh pressure 0 is NO READING; never CRITICAL LOW', () => {
    expect(flag({ pressure: 0, setPoint: 100, updatedAt: old })).toBe('STALE');
    expect(flag({ pressure: 0, setPoint: 100, updatedAt: fresh })).toBe('NO READING');
    expect(flag({ pressure: 0, setPoint: 100 })).toBe('NO READING');
    expect(flag({ pressure: -3, setPoint: 100, updatedAt: fresh })).toBe('NO READING');
  });

  it('absent / non-finite pressure -> NO READING; absent updatedAt is not stale', () => {
    expect(flag({ setPoint: 100, updatedAt: fresh })).toBe('NO READING');
    expect(flag({ pressure: null, setPoint: 100 })).toBe('NO READING');
    expect(flag({ pressure: 'abc', setPoint: 100 })).toBe('NO READING');
    expect(flag({ pressure: 70, setPoint: 100 })).toBe('CRITICAL LOW');
    expect(flag({ pressure: 70, setPoint: 100, updatedAt: 'not a date' })).toBe('CRITICAL LOW');
  });

  it('exactly 7 days is not stale; just over is', () => {
    expect(flag({ pressure: 100, setPoint: 100, updatedAt: new Date(NOW - C.STALE_MS).toISOString() })).toBe('OK');
    expect(flag({ pressure: 100, setPoint: 100, updatedAt: new Date(NOW - C.STALE_MS - 1000).toISOString() })).toBe('STALE');
  });

  it('no setPoint -> empty flag with null delta / pct', () => {
    expect(flag({ pressure: 100, updatedAt: fresh })).toBe('');
    expect(flag({ pressure: 100, setPoint: 0 })).toBe('');
    const row = R.tireRow({ position: 'L1IC', pressure: 100 }, NOW);
    expect(row).toMatchObject({ flag: '', deltaPsi: null, pct: null, pressure: 100, setPoint: null });
  });

  it('faulted wins over everything', () => {
    expect(flag({ faulted: true, pressure: 0, setPoint: 100, updatedAt: old })).toBe('SENSOR FAULT');
    expect(flag({ faulted: true, pressure: 50, setPoint: 100, updatedAt: fresh })).toBe('SENSOR FAULT');
    expect(flag({ faulted: true })).toBe('SENSOR FAULT');
  });

  it('tireRow computes delta / pct rounded to 1 dp and keeps only whitelisted fields', () => {
    const row = R.tireRow({ position: 'R1IC', shortPosition: 'R1I', positionName: 'Right Steer', pressure: 87.26, setPoint: 105, temperature: 71.26,
      updatedAt: fresh, faulted: false, serialNumber: 'S', uniqueId: 'U', tire: { x: 1 } }, NOW);
    expect(row.deltaPsi).toBe(-17.7);
    expect(row.pct).toBe(83.1);
    expect(row.temperatureF).toBe(71.3);
    expect(row.flag).toBe('LOW');
    expect(row.issue).toBeNull();
    expect(Object.keys(row).sort()).toEqual(['deltaPsi', 'faulted', 'flag', 'issue', 'pct', 'position', 'positionName', 'pressure', 'readAtEt',
      'setPoint', 'shortPosition', 'temperatureF', 'updatedAt'].sort());
  });

  it('FLAG_RANK orders CRITICAL LOW highest and OK lowest', () => {
    expect(R.FLAG_RANK['CRITICAL LOW']).toBeGreaterThan(R.FLAG_RANK.LOW);
    expect(R.FLAG_RANK.LOW).toBeGreaterThan(R.FLAG_RANK.OK);
    expect(Object.isFrozen(R.FLAG_RANK)).toBe(true);
  });
});

describe('GPS', () => {
  it('placeholder [-11.11111, 11.11111] is excluded, exactly and within 1e-4', () => {
    expect(R.gpsOf(GEO_PLACEHOLDER)).toBeNull();
    expect(R.gpsReason(GEO_PLACEHOLDER)).toBe('PLACEHOLDER');
    expect(R.gpsOf({ latitude: -11.11115, longitude: 11.11105 })).toBeNull();
    expect(R.isPlaceholderGps(-11.1112, 11.1111)).toBe(true);
    expect(R.isPlaceholderGps(-11.1113, 11.1111)).toBe(false);
  });

  it('missing tag or coordinates -> null / MISSING', () => {
    for (const t of [null, undefined, {}, { latitude: null, longitude: null }, { latitude: 'x', longitude: 1 }, { latitude: 30 }]) {
      expect(R.gpsOf(t)).toBeNull();
      expect(R.gpsReason(t)).toBe('MISSING');
    }
  });

  it('inside US not flagged; 51,-100 and 30,-60 flagged outsideUs', () => {
    const g = R.gpsOf(GEO_US);
    expect(g).toMatchObject({ lat: 32.89654, lng: -97.03804, altitude: 180.2, outsideUs: false });
    expect(g.mapsUrl).toBe('https://www.google.com/maps?q=32.89654,-97.03804');
    expect(g.mapImageUrl).toMatch(/^https:\/\/maps\.googleapis\.com\//);
    expect(R.gpsReason(GEO_US)).toBe('OK');
    expect(R.gpsOf(GEO_OUTSIDE).outsideUs).toBe(true);
    expect(R.gpsOf({ latitude: 30, longitude: -60 }).outsideUs).toBe(true);
    expect(R.outsideUs(24, -125)).toBe(false);
    expect(R.outsideUs(50, -66)).toBe(false);
  });

  it('non-https or non-google map image URL is dropped', () => {
    expect(R.gpsOf(GEO_OUTSIDE).mapImageUrl).toBe('');
    expect(R.gpsOf({ latitude: 30, longitude: -90, locationPictureUrl: 'https://google.com.evil.example/x' }).mapImageUrl).toBe('');
    expect(R.gpsOf({ latitude: 30, longitude: -90, locationPictureUrl: 'javascript:alert(1)' }).mapImageUrl).toBe('');
    expect(R.gpsOf({ latitude: 30, longitude: -90, locationPictureUrl: 'https://www.google.com/maps/x.png' }).mapImageUrl).toBe('https://www.google.com/maps/x.png');
    expect(R.gpsOf({ latitude: 30, longitude: -90 }).mapImageUrl).toBe('');
  });
});

describe('fmtEt', () => {
  it('renders New York time while the process TZ is UTC', () => {
    expect(new Date('2026-11-22T14:05:00Z').getHours()).toBe(14);
    expect(R.fmtEt('2026-11-22T14:05:00Z')).toBe('11/22/2026, 9:05 AM EST');
    expect(R.fmtEt('2026-07-01T16:30:00Z')).toBe('7/1/2026, 12:30 PM EDT');
  });

  it("returns '' for invalid or absent times", () => {
    expect(R.fmtEt('')).toBe('');
    expect(R.fmtEt(null)).toBe('');
    expect(R.fmtEt('garbage')).toBe('');
  });
});
