// 📊 DBR — Fleet Health data-as-of / trust stamp (src/dbr/fleet-dbr-freshness.js): data-as-of is
// the last real AAP build (fleet-freshness lastOkAt), never the re-stamped fleetData.syncedAt.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr-freshness');

const NOW = new Date(2026, 10, 24, 9, 0, 0);           // local 09:00
const at = (h, m, dayOffset = 0) => new Date(2026, 10, 24 + dayOffset, h, m, 0);
const rows = (n) => Array.from({ length: n }, (_, i) => ({ equipmentId: 'U' + i }));
const fleet = (over = {}) => Object.assign({ rows: rows(3), syncedAt: at(8, 55).toISOString() }, over);
const ff = (over = {}) => Object.assign({ lastOkAt: at(8, 30).getTime(), lastOkCount: 3, lastFailAt: null, lastFailCode: null, buildInFlight: false }, over);

describe('assess', () => {
  it('fresh: last AAP build today, within 120 min, rows match the build', () => {
    const d = F.assess({ fleet: fleet(), ffSnapshot: ff(), now: NOW });
    expect(d).toMatchObject({
      v: 1, status: 'fresh', reasons: [], dataAsOf: at(8, 30).toISOString(), dataAsOfSource: 'fleet-build',
      syncStampAt: at(8, 55).toISOString(), rowCount: 3, lastOkCount: 3, ageMin: 30, sameDay: true, buildInFlight: false,
      checkedAt: NOW.toISOString(),
    });
    expect(F.MAX_AGE_MIN).toBe(120);
  });

  it('syncedAt today but lastOkAt yesterday -> stale (not-today)', () => {
    const d = F.assess({ fleet: fleet({ syncedAt: at(8, 59).toISOString() }), ffSnapshot: ff({ lastOkAt: at(18, 3, -1).getTime() }), now: NOW });
    expect(d.status).toBe('stale');
    expect(d.reasons).toContain('not-today');
    expect(d.dataAsOf).toBe(at(18, 3, -1).toISOString());
    expect(d.sameDay).toBe(false);
  });

  it('same day but older than 120 min -> stale (age>120m); exactly 120 min is fresh', () => {
    expect(F.assess({ fleet: fleet(), ffSnapshot: ff({ lastOkAt: at(6, 59).getTime() }), now: NOW })).toMatchObject({ status: 'stale', reasons: ['age>120m'], ageMin: 121 });
    expect(F.assess({ fleet: fleet(), ffSnapshot: ff({ lastOkAt: at(7, 0).getTime() }), now: NOW }).status).toBe('fresh');
  });

  it('no build recorded: falls back to fleetData.syncedAt tagged sync-stamp', () => {
    const d = F.assess({ fleet: fleet(), ffSnapshot: ff({ lastOkAt: null, lastOkCount: null }), now: NOW });
    expect(d).toMatchObject({ status: 'fresh', dataAsOf: at(8, 55).toISOString(), dataAsOfSource: 'sync-stamp', lastOkCount: null });
    expect(d.reasons).toEqual(['build-time-unknown']);
    expect(F.assess({ fleet: fleet({ syncedAt: null, scrapedAt: at(8, 0).toISOString() }), ffSnapshot: null, now: NOW }).dataAsOf).toBe(at(8, 0).toISOString());
    expect(F.assess({ fleet: fleet({ syncedAt: at(17, 0, -1).toISOString() }), ffSnapshot: null, now: NOW }).status).toBe('stale');
  });

  it('unknown: no build and no sync stamp', () => {
    const d = F.assess({ fleet: fleet({ syncedAt: null }), ffSnapshot: null, now: NOW });
    expect(d).toMatchObject({ status: 'unknown', dataAsOf: null, dataAsOfSource: 'sync-stamp', ageMin: null, sameDay: false });
  });

  it('partial: rows differ from the last build count, or the payload is flagged stale / partial', () => {
    expect(F.assess({ fleet: fleet({ rows: rows(2) }), ffSnapshot: ff({ lastOkCount: 3 }), now: NOW }))
      .toMatchObject({ status: 'partial', reasons: ['rows-differ-from-last-build'], rowCount: 2, lastOkCount: 3 });
    expect(F.assess({ fleet: fleet({ stale: true }), ffSnapshot: ff(), now: NOW })).toMatchObject({ status: 'partial', reasons: ['payload-stale-flag'] });
    expect(F.assess({ fleet: fleet({ partial: 'aap' }), ffSnapshot: ff(), now: NOW })).toMatchObject({ status: 'partial', reasons: ['payload-partial'] });
  });

  it('stale wins over partial (first match), partial reasons are still listed', () => {
    const d = F.assess({ fleet: fleet({ rows: rows(2) }), ffSnapshot: ff({ lastOkAt: at(18, 0, -1).getTime() }), now: NOW });
    expect(d.status).toBe('stale');
    expect(d.reasons).toEqual(expect.arrayContaining(['not-today', 'rows-differ-from-last-build']));
  });

  it('refresh failed / in flight are reasons only; status stays fresh', () => {
    const d = F.assess({ fleet: fleet(), ffSnapshot: ff({ lastFailAt: at(8, 45).getTime(), lastFailCode: 'AUTH', buildInFlight: true }), now: NOW });
    expect(d.status).toBe('fresh');
    expect(d.reasons).toEqual(['last-refresh-failed', 'refresh-in-flight']);
    expect(d).toMatchObject({ lastFailAt: at(8, 45).toISOString(), lastFailCode: 'AUTH', buildInFlight: true });
    // A failure older than the last good build is not "failing".
    expect(F.assess({ fleet: fleet(), ffSnapshot: ff({ lastFailAt: at(8, 0).getTime() }), now: NOW }).reasons).toEqual([]);
  });
});

describe('reassess (read time)', () => {
  it('keeps the stamped data-as-of and recomputes the age rules against now', () => {
    const stamp = F.assess({ fleet: fleet(), ffSnapshot: ff(), now: NOW });
    const later = F.reassess(stamp, { ffSnapshot: ff({ lastOkAt: at(10, 50).getTime() }), now: at(10, 31) });
    expect(later).toMatchObject({ status: 'stale', reasons: ['age>120m'], dataAsOf: at(8, 30).toISOString(), dataAsOfSource: 'fleet-build', ageMin: 121 });
    expect(F.reassess(stamp, { ffSnapshot: ff(), now: at(9, 30) }).status).toBe('fresh');
  });

  it('keeps the build-time partial reasons and picks up a new refresh failure', () => {
    const stamp = F.assess({ fleet: fleet({ rows: rows(2), stale: true }), ffSnapshot: ff(), now: NOW });
    const r = F.reassess(stamp, { ffSnapshot: ff({ lastFailAt: at(9, 5).getTime(), lastFailCode: 'TIMEOUT' }), now: at(9, 10) });
    expect(r.status).toBe('partial');
    expect(r.reasons).toEqual(['rows-differ-from-last-build', 'payload-stale-flag', 'last-refresh-failed']);
    expect(r.lastFailCode).toBe('TIMEOUT');
  });

  it('a snapshot without a stamp re-assesses from fleetSyncedAt as sync-stamp', () => {
    expect(F.reassess(undefined, { ffSnapshot: null, now: NOW, fallbackAsOf: at(8, 0).toISOString() }))
      .toMatchObject({ status: 'fresh', dataAsOfSource: 'sync-stamp', dataAsOf: at(8, 0).toISOString() });
    expect(F.reassess(undefined, { ffSnapshot: null, now: NOW }).status).toBe('unknown');
  });
});

describe('buildFleetDbr evidenceGaps (D5: marker only, counts unchanged)', () => {
  const D = require('../src/dbr/fleet-dbr');
  const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');
  it('counts down units with no ETC-source text and no fullConversation', () => {
    const rows = [
      makeUnit({ equipmentId: 'A1' }),
      makeUnit({ equipmentId: 'A2', repairTimeline: '11/10 08:00 waiting on parts' }),
      makeUnit({ equipmentId: 'A3', fullConversation: 'vendor: ETR 11/12' }),
      makeUnit({ equipmentId: 'A4', savedNotes: '   ' }),
      makeUnit({ equipmentId: 'A5', lifecycleState: 'Active' }),
    ];
    const built = D.buildFleetDbr(rows, { today: '2026-11-10' });
    expect(built.rows).toHaveLength(1);
    const r = built.rows[0];
    expect(r.evidenceGaps).toBe(2);
    expect(r.pair).toEqual({ total: 5, down: 4 });
    const n = (id) => Number(r.cells[id]);
    expect(n('etcToday') + n('noEtc') + n('missedEtc')).toBe(4);
  });
});

describe('readFleetFreshness', () => {
  it('returns the fleet-freshness snapshot (lastOkAt null before any build)', () => {
    const s = F.readFleetFreshness();
    expect(s).toBeTruthy();
    expect(s).toHaveProperty('lastOkAt');
  });
});
