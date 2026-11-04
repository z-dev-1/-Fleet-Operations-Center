// tests/slack-change-detect.test.js
//
// Phase 4b T2: pure change-detection predicates (src/slack/change-detect.js).
// These own "a conversation with a newer message is never skipped": every
// malformed / unknown / throwing input must fail OPEN (fetch).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cd = require('../src/slack/change-detect');

describe('compareTs / maxTs', () => {
  it('exact ordering, padding and invalid inputs', () => {
    expect(cd.compareTs('5.1', '5.100000')).toBe(0);
    expect(cd.compareTs('5', '5.000000')).toBe(0);
    expect(cd.compareTs('5', '5.000001')).toBe(-1);
    expect(cd.compareTs('6', '5.999999')).toBe(1);
    expect(cd.compareTs('100.000001', '100.000000')).toBe(1);
    expect(cd.compareTs('1.1234567', '1')).toBeNull();          // 7-digit fraction
    for (const bad of [5, null, undefined, {}, 'abc', '', '1.', '-1', '1e5']) expect(cd.compareTs(bad, '1')).toBeNull();
  });
  it('orders values that differ only past double precision', () => {
    // parseFloat cannot tell these apart; the exact compare can.
    expect(parseFloat('999999999999.000001') === parseFloat('999999999999.000002')).toBe(true);
    expect(cd.compareTs('999999999999.000001', '999999999999.000002')).toBe(-1);
  });
  it('maxTs ignores invalid values', () => {
    expect(cd.maxTs('1.5', 'x', null, '3.000001', 3, '2')).toBe('3.000001');
    expect(cd.maxTs('x', null)).toBeNull();
    expect(cd.maxTs()).toBeNull();
  });
});

describe('skipAgeMs', () => {
  it('is deterministic and within [5, 10) min', () => {
    for (const id of ['D1', 'D2', 'DABCDEF', '', 'x'.repeat(50)]) {
      const v = cd.skipAgeMs(id);
      expect(v).toBe(cd.skipAgeMs(id));
      expect(v).toBeGreaterThanOrEqual(300000);
      expect(v).toBeLessThan(600000);
    }
  });
  it('forced refresh ≈ 1 in 15 runs at the 30 s DM cadence (design §1.6 N/15), spread across DMs', () => {
    const ages = Array.from({ length: 2000 }, (_, i) => cd.skipAgeMs('D' + i.toString(36).toUpperCase()));
    const meanRuns = ages.reduce((a, v) => a + v / 30000, 0) / ages.length;  // runs between forced refreshes
    expect(meanRuns).toBeGreaterThan(14);
    expect(meanRuns).toBeLessThan(16);
    for (const v of ages) expect(Math.ceil(v / 30000)).toBeLessThanOrEqual(20); // never longer than 10 min
    expect(new Set(ages.map(v => Math.ceil(v / 30000))).size).toBeGreaterThan(5); // not all on one run
  });
});

describe('dmSkipDecision (S2)', () => {
  const W = '1000.000000';
  const NOW = 10_000_000;
  const base = (over = {}) => ({ dm: { channelId: 'D1', isSelf: false, unread: false, latestTs: '999.000000', ...(over.dm || {}) },
    lastSeenTs: 'lastSeenTs' in over ? over.lastSeenTs : W, lastFetchedAt: 'lastFetchedAt' in over ? over.lastFetchedAt : NOW - 1000, now: NOW });
  it('skips only when every condition holds', () => {
    expect(cd.dmSkipDecision(base())).toEqual({ skip: true, reason: 'unchanged' });
    expect(cd.dmSkipDecision(base({ dm: { latestTs: W } }))).toEqual({ skip: true, reason: 'unchanged' }); // latest == W
  });
  it('one fail-open reason per condition', () => {
    expect(cd.dmSkipDecision(base({ dm: { isSelf: true } }))).toEqual({ skip: false, reason: 'self' });
    expect(cd.dmSkipDecision(base({ lastSeenTs: undefined }))).toEqual({ skip: false, reason: 'noWatermark' });
    expect(cd.dmSkipDecision(base({ lastSeenTs: 'abc' })).reason).toBe('noWatermark');
    expect(cd.dmSkipDecision(base({ dm: { unread: true } }))).toEqual({ skip: false, reason: 'unread' });
    expect(cd.dmSkipDecision(base({ dm: { unread: undefined } })).reason).toBe('unread');
    for (const bad of [undefined, 999, {}, 'abc', null]) {
      expect(cd.dmSkipDecision(base({ dm: { latestTs: bad } }))).toEqual({ skip: false, reason: 'unknownLatest' });
    }
    expect(cd.dmSkipDecision(base({ dm: { latestTs: '1000.000001' } }))).toEqual({ skip: false, reason: 'newer' }); // 1 µs newer
    expect(cd.dmSkipDecision(base({ lastFetchedAt: undefined }))).toEqual({ skip: false, reason: 'coldStart' });
    expect(cd.dmSkipDecision(base({ lastFetchedAt: NOW - cd.skipAgeMs('D1') }))).toEqual({ skip: false, reason: 'stale' });
    expect(cd.dmSkipDecision(base({ lastFetchedAt: NOW - cd.skipAgeMs('D1') + 1 })).skip).toBe(true);
    expect(cd.dmSkipDecision(undefined).skip).toBe(false);
    const throwing = { get isSelf() { throw new Error('boom'); } };
    expect(cd.dmSkipDecision({ dm: throwing, lastSeenTs: W, lastFetchedAt: NOW, now: NOW })).toEqual({ skip: false, reason: 'error' });
  });
  it('a D_mine DM (my own reply is newest, above W) is fetched with reason newer', () => {
    expect(cd.dmSkipDecision(base({ dm: { latestTs: '1500.000000' } }))).toEqual({ skip: false, reason: 'newer' });
  });
  it('a retry-capped watermark (just below an unanswered message) is fetched', () => {
    // _retryFromTs caps W at msg.ts - 0.000001, so latest (= msg.ts) > W.
    expect(cd.dmSkipDecision(base({ lastSeenTs: '1199.999999', dm: { latestTs: '1200.000000' } })).reason).toBe('newer');
  });
});


describe('snapshotCutoff (S4 mixed-snapshot guard)', () => {
  it('snapshotCutoff is the max over ts, latestReply and the prior value', () => {
    expect(cd.snapshotCutoff([{ ts: '5.0' }, { ts: '3.0', latestReply: '9.000000' }], '7.0')).toBe('9.000000');
    expect(cd.snapshotCutoff([{ ts: '5.0' }], '8.0')).toBe('8.0');
    expect(cd.snapshotCutoff([], null)).toBe('0');
    expect(cd.snapshotCutoff(null, undefined)).toBe('0');
  });
});
