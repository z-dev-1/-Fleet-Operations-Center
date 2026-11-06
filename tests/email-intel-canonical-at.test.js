// tests/email-intel-canonical-at.test.js — the canonical change-time parser and freshness comparison
// (design 4.3, F-02, F-27). Real lastMeaningfulUpdate shapes from tests/fixtures/email-intel/canonical.js.
// Local-time expectations are built with the Date constructor so the test is zone-independent.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { LMU } from './fixtures/email-intel/canonical.js';
const require = createRequire(import.meta.url);
const ca = require('../src/email-intel/facts/canonical-at');

const local = (...a) => new Date(...a).getTime();

describe('parseCanonicalAt', () => {
  it('F-02 canonical at parsing matrix', () => {
    const p = (lmu, row) => ca.parseCanonicalAt(lmu, row);
    expect(p({ source: 'relay', text: 't', at: 'Oct 9, 2026 06:07 PM' })).toEqual({ ms: local(2026, 9, 9, 18, 7), precision: 'minute', authoritative: true, zoneExplicit: false });
    expect(p({ source: 'relay', text: 't', at: 'Oct 9, 2026 12:05 AM' }).ms).toBe(local(2026, 9, 9, 0, 5));
    expect(p({ source: 'offsite', text: 't', at: 'Oct 9, 2026' })).toEqual({ ms: local(2026, 9, 9), precision: 'day', authoritative: true, zoneExplicit: false });
    expect(p({ source: 'relay', text: 't', at: '10/12/26' })).toEqual({ ms: local(2026, 9, 12), precision: 'day', authoritative: true, zoneExplicit: false });
    expect(p({ source: 'relay', text: 't', at: '10/12/2026' })).toEqual({ ms: local(2026, 9, 12), precision: 'day', authoritative: true, zoneExplicit: false });
    // timeline source with '' at: no time, never authoritative
    expect(p(LMU.timelineOnly)).toEqual({ ms: null, precision: 'none', authoritative: false, zoneExplicit: false });
    // at equal to the row's asistScrapedAt is a scrape time, not a change time
    expect(p(LMU.scrapeTime, { asistScrapedAt: '2026-11-04T12:00:00.000Z' })).toEqual({ ms: null, precision: 'none', authoritative: true, zoneExplicit: false });
    // free text is never Date.parse'd
    expect(p(LMU.freeText)).toEqual({ ms: null, precision: 'none', authoritative: true, zoneExplicit: false });
    expect(p({ source: 'relay', text: 't', at: 'Tuesday afternoon' }).precision).toBe('none');
    expect(p({ source: 'relay', text: 't', at: '13/45/26' }).precision).toBe('none');
    expect(p({ source: 'relay', text: 't', at: 'Feb 30, 2026' }).precision).toBe('none');
    // ISO with and without an offset
    expect(p({ source: 'relay', text: 't', at: '2026-11-04T14:00:00Z' })).toEqual({ ms: Date.parse('2026-11-04T14:00:00Z'), precision: 'minute', authoritative: true, zoneExplicit: true });
    expect(p({ source: 'relay', text: 't', at: '2026-11-04T14:00:00-05:00' }).zoneExplicit).toBe(true);
    expect(p({ source: 'relay', text: 't', at: '2026-11-04T14:00' })).toEqual({ ms: local(2026, 10, 4, 14, 0), precision: 'minute', authoritative: true, zoneExplicit: false });
    expect(p({ source: 'relay', text: 't', at: '2026-11-04' }).precision).toBe('none');                 // ISO date only is not a change time
    // a non-relay/offsite source is never authoritative, even with a good time
    expect(p({ source: 'email', text: 't', at: 'Oct 9, 2026 06:07 PM' }).authoritative).toBe(false);
    expect(p(null)).toEqual({ ms: null, precision: 'none', authoritative: false, zoneExplicit: false });
  });
});

describe('compareFreshness', () => {
  const at = (s, src = 'relay') => ca.parseCanonicalAt({ source: src, text: 't', at: s });
  const mail = (ms, precision = 'minute') => ({ receivedAt: new Date(ms).toISOString(), receivedAtPrecision: precision });
  it('minute vs minute compares instants outside the zone window; inside it is unprovable until P-TZ is verified (F-27)', () => {
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM'), mail(local(2026, 10, 3, 9, 0)))).toBe('canonical-newer');
    expect(ca.compareFreshness(at('Nov 2, 2026 02:00 PM'), mail(local(2026, 10, 3, 9, 0)))).toBe('email-newer');
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM'), mail(local(2026, 10, 4, 9, 0)))).toBe('unprovable');
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM'), mail(local(2026, 10, 4, 9, 0)), { tzVerified: true })).toBe('canonical-newer');
    // both zones explicit: the window does not apply
    expect(ca.compareFreshness(at('2026-11-04T14:00:00Z'), { receivedAt: '2026-11-04T13:00:00Z', receivedAtPrecision: 'minute', zoneExplicit: true })).toBe('canonical-newer');
  });
  it('day precision on either side compares calendar days; the same day is unprovable', () => {
    expect(ca.compareFreshness(at('11/04/26'), mail(local(2026, 10, 4, 9, 0)))).toBe('unprovable');
    expect(ca.compareFreshness(at('11/04/26'), mail(local(2026, 10, 3, 9, 0)))).toBe('canonical-newer');
    expect(ca.compareFreshness(at('11/04/26'), mail(local(2026, 10, 5, 9, 0)))).toBe('email-newer');
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM'), mail(local(2026, 10, 4, 0, 0), 'day'))).toBe('unprovable');
  });
  it('no time, scrape time or unparseable is unprovable; non-authoritative is not comparable', () => {
    expect(ca.compareFreshness(at(''), mail(local(2026, 10, 3)))).toBe('unprovable');
    expect(ca.compareFreshness(at('yesterday'), mail(local(2026, 10, 3)))).toBe('unprovable');
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM', 'timeline'), mail(local(2026, 10, 3)))).toBe('not-comparable');
    expect(ca.compareFreshness(null, mail(local(2026, 10, 3)))).toBe('not-comparable');
    expect(ca.compareFreshness(at('Nov 4, 2026 02:00 PM'), { receivedAt: null })).toBe('unprovable');
  });
});
