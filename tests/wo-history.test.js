// tests/wo-history.test.js — repair-intel/wo-history.historyTrend over the real
// serviceChangeLogs shape: ETC slip / pull-in revisions, estimate revisions and decisions,
// vendor changes, time-in-state, Decisiv create-only, no-ETC, malformed input, caps and
// provenance. Asserts ISO instants and counts (no local calendar days).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as H from './fixtures/extract/history-shapes.js';
const require = createRequire(import.meta.url);
const WH = require('../src/repair-intel/wo-history');
const X = require('../src/repair-intel/wo-extract');
const NOW = Date.parse('2026-11-11T15:00:00Z');
const classify = (r) => X.classifyRelayAuthor(r, {});
const trend = (logs) => WH.historyTrend(logs, { classify, now: NOW });

describe('B12195 COX: ETC revisions, vendor, states', () => {
  const t = trend(H.histB12195Full);
  it('repair-completion revisions: set, pull-in, slip; the no-op is dropped', () => {
    const rc = t.etc.revisions.filter((r) => r.kind === 'repairCompletion');
    expect(rc.map((r) => r.dir)).toEqual(['set', 'pull-in', 'slip']);
    expect(t.etc.slipCount).toBe(1);
    expect(t.etc.pullInCount).toBe(1);
    expect(t.etc.seq).toEqual(['2026-11-09T22:00:00.000Z', '2026-11-09T04:08:00.000Z', '2026-11-10T07:13:00.000Z']);
    expect(t.etc.firstIso).toBe('2026-11-09T22:00:00.000Z');
    expect(t.etc.currentIso).toBe('2026-11-10T07:13:00.000Z');
    expect(t.etc.totalSlipMs).toBe(Date.parse('2026-11-10T07:13:00Z') - Date.parse('2026-11-09T04:08:00Z'));
    expect(t.etc.available).toBe(true);
  });
  it('start and techOnsite revisions are separate kinds; Actual arrival is not an ETC revision', () => {
    expect(t.etc.revisions.map((r) => r.kind)).toEqual(['repairCompletion', 'start', 'repairCompletion', 'techOnsite', 'repairCompletion']);
    const start = t.etc.revisions.find((r) => r.kind === 'start');
    expect(start).toMatchObject({ fromIso: '2026-11-08T08:59:00.000Z', toIso: '2026-11-09T02:08:00.000Z', dir: 'slip' });
    expect(t.etc.revisions.find((r) => r.kind === 'techOnsite').dir).toBe('set');
  });
  it('vendor change UNASSIGNED -> COX via ASSIGN_VENDOR', () => {
    const v = t.vendor.changes.find((c) => c.field === 'Vendor' && c.op === 'ASSIGN_VENDOR');
    expect(v).toMatchObject({ from: 'UNASSIGNED', to: 'COX', at: '2026-11-07T20:58:12.112Z' });
    expect(t.vendor.changes.some((c) => c.field === 'Supplier' && c.to === 'ROC5')).toBe(true);
    expect(t.vendor.current).toBe('COX');
  });
  it('states per entity with ms; the last state is open', () => {
    expect(t.states.map((s) => [s.entity, s.state])).toEqual([['wr', 'CREATED'], ['wo', 'WORK_ORDER_ASSIGNED'], ['wo', 'WORK_IN_PROGRESS']]);
    const wo1 = t.states[1];
    expect(wo1.leftAt).toBe('2026-11-09T07:19:04.487Z');
    expect(wo1.ms).toBe(Date.parse('2026-11-09T07:19:04.487Z') - Date.parse('2026-11-07T21:02:05.443Z'));
    const last = t.states[t.states.length - 1];
    expect(last.leftAt).toBeNull();
    expect(last.ms).toBe(NOW - Date.parse('2026-11-09T07:19:04.487Z'));
    expect(t.states.every((s) => s.ms > 0)).toBe(true);
  });
  it('header: n, firstAt, lastAt, not createOnly', () => {
    expect(t.v).toBe(1);
    expect(t.n).toBe(H.histB12195Full.length);
    expect(t.firstAt).toBe('2026-11-07T20:54:59.851Z');
    expect(t.lastAt).toBe('2026-11-11T12:51:36.043Z');
    expect(t.createOnly).toBe(false);
  });
});

describe('IND260261 TA: estimate revisions and decisions', () => {
  const t = trend(H.histIND260261);
  it('4 estimate revisions in order', () => {
    expect(t.estimate.revisions.map((r) => [r.from, r.to])).toEqual([[null, 28895.94], [28895.94, 28984.94], [28984.94, 24715.13], [24715.13, 24804.13]]);
  });
  it('3 rejected (reason + amount at the time) + 1 approved', () => {
    expect(t.estimate.decisions.map((d) => [d.outcome, d.amount, d.reason, d.at])).toEqual([
      ['rejected', 28984.94, 'Line item cost above expected', '2026-10-31T14:00:06.600Z'],
      ['rejected', 28984.94, 'Question/Concern', '2026-11-02T14:00:07.700Z'],
      ['rejected', 24804.13, 'Question/Concern', '2026-11-04T14:00:10.100Z'],
      ['approved', 24804.13, null, '2026-11-05T14:00:12.120Z'],
    ]);
    expect(t.estimate.rejectCount).toBe(3);
    expect(t.estimate.approveCount).toBe(1);
  });
  it('no ETC field -> etc.available false (Start date time is not an ETC)', () => {
    expect(t.etc.available).toBe(false);
    expect(t.etc.slipCount).toBe(0);
    expect(t.etc.seq).toEqual([]);
  });
});

describe('degrade', () => {
  it('39582 Decisiv CREATE-only: createOnly, no ETC, no throw', () => {
    const t = trend(H.hist39582CreateOnly);
    expect(t.createOnly).toBe(true);
    expect(t.etc.available).toBe(false);
    expect(t.etc.slipCount).toBe(0);
    expect(t.estimate.decisions).toEqual([]);
    expect(t.vendor.current).toBe('VOLVO');
  });
  it('TA without ETC fields: estimate present, etc unavailable', () => {
    const t = trend(H.histTaNoEtc);
    expect(t.etc.available).toBe(false);
    expect(t.estimate.revisions.map((r) => r.to)).toEqual([1250.5]);
    expect(t.states.map((s) => s.entity)).toEqual(['wr', 'wo', 'wo']);
  });
  it('malformed entries are skipped, never thrown', () => {
    let t;
    expect(() => { t = trend(H.histMalformed); }).not.toThrow();
    expect(t.n).toBe(2);
    expect(t.etc.revisions.map((r) => r.toIso)).toEqual(['2026-11-06T12:00:00.000Z']);
    expect(t.estimate.revisions).toEqual([]);
  });
  it('null / [] / all-invalid -> null; a throwing classify falls back', () => {
    expect(WH.historyTrend(null)).toBeNull();
    expect(WH.historyTrend([])).toBeNull();
    expect(WH.historyTrend([null, { eventDateTime: 'x' }])).toBeNull();
    const t = WH.historyTrend(H.histTaNoEtc, { classify: () => { throw new Error('x'); }, now: NOW });
    expect(t.states[0]).toBeTruthy();
    expect(t.estimate.revisions[0]).toMatchObject({ source: 'relay', side: 'unknown' });
  });
});

describe('caps and provenance', () => {
  it('100 synthetic ETC edits: <= 20 revisions kept (newest), counts over all', () => {
    const t = trend(H.histManyEtc(100));
    expect(t.etc.revisions).toHaveLength(20);
    expect(t.etc.revisions[19].toIso).toBe(new Date(Date.parse('2026-11-01T00:00:00Z') + 100 * 3600000).toISOString());
    expect(t.etc.slipCount).toBe(99);
    expect(t.etc.seq.length).toBeLessThanOrEqual(20);
    expect(t.etc.currentIso).toBe(t.etc.revisions[19].toIso);
  });
  it('every entry has at, source, side and a snippet <= 140; by <= 60', () => {
    for (const logs of [H.histB12195Full, H.histIND260261, H.hist39582CreateOnly]) {
      const t = trend(logs);
      const all = [].concat(t.etc.revisions, t.estimate.revisions, t.estimate.decisions, t.vendor.changes);
      expect(all.length).toBeGreaterThan(0);
      for (const e of all) {
        expect(typeof e.at).toBe('string');
        expect(e.source).toBeTruthy();
        expect(e.side).toBeTruthy();
        expect(typeof e.snippet).toBe('string');
        expect(e.snippet.length).toBeLessThanOrEqual(140);
        expect(e.by == null || e.by.length <= 60).toBe(true);
      }
    }
    const v = trend(H.histB12195Full).vendor.changes.find((c) => c.to === 'COX');
    expect(v).toMatchObject({ side: 'amazon', source: 'relaygarage/fas', snippet: 'Vendor: UNASSIGNED -> COX' });
  });
});
