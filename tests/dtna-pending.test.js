// DTNA Phase B: src/dtna/pending.js — pure Pending Estimates helpers over dtnaCaseCache entries.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { CASE_ID, NO_RO_CASE_ID, CASE_RECORD, NO_RO_RECORD, RO_LIST, COMMENTS, NO_RO_COMMENTS } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
const client = require('../src/dtna/client');
const P = require('../src/dtna/pending');

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ENTRY = client.normalizeCase(CASE_RECORD, RO_LIST[0], COMMENTS, { caseId: CASE_ID, now: NOW });
const CLOSED = client.normalizeCase(NO_RO_RECORD, null, NO_RO_COMMENTS, { caseId: NO_RO_CASE_ID, now: NOW - 3600e3 });
const wo = (id, unit, vendor, sched) => ({ workRequestId: id, assetDisplayName: unit, vendor, scheduledDateTime: sched || 0 });

describe('case predicates', () => {
  it('closed / done / awaiting approval', () => {
    expect(P.isCaseClosed(ENTRY)).toBe(false);
    expect(P.isCaseClosed(CLOSED)).toBe(true);
    expect(P.isCaseClosed({ caseStatus: 'Cancelled' })).toBe(true);
    expect(P.isCaseDone(CLOSED)).toBe(true);
    expect(P.isCaseDone({ caseStatus: 'Ready for Pickup' })).toBe(true);
    expect(P.isCaseDone({ caseStatus: 'Arrived', offsiteStage: 'ready' })).toBe(true);
    expect(P.isCaseDone(ENTRY)).toBe(false);
    expect(P.isAwaitingApproval(ENTRY)).toBe(true);
    expect(P.isAwaitingApproval(CLOSED)).toBe(false);
    expect(P.isAwaitingApproval(Object.assign({}, ENTRY, { caseStatus: 'Complete' }))).toBe(false);
    expect(P.isAwaitingApproval({ caseId: 'bad' })).toBe(false);
  });

  it('mismatch: done at the dealer while the RG WR is open', () => {
    expect(P.mismatch(CLOSED, true)).toEqual({ offsiteDone: true, statusMismatch: true });
    expect(P.mismatch(CLOSED, false)).toEqual({ offsiteDone: true, statusMismatch: false });
    expect(P.mismatch(ENTRY, true)).toEqual({ offsiteDone: false, statusMismatch: false });
  });
});

describe('offsiteRecord', () => {
  it('Total null, status from the case, no estimate amount anywhere', () => {
    const r = P.offsiteRecord(ENTRY);
    expect(r).toEqual({
      source: 'dtna', caseId: CASE_ID, url: 'https://dtna.my.site.com/Servicetracker/s/case/' + CASE_ID + '/detail',
      dealerName: 'HORWITH FREIGHTLINER', fleetStatus: '', repairStatus: 'In Repair', stage: 'repair', stageStatus: '',
      stageSince: ENTRY.stageSince, total: null, totalSource: 'none', updatedAt: ENTRY.lastCommentAt, scrapedAt: ENTRY.pulledAt,
      roNumber: 'R101048154', ok: true,
    });
  });
});

describe('latestPulledAt', () => {
  it('newest pulledAt or null', () => {
    expect(P.latestPulledAt([CLOSED, ENTRY])).toBe(ENTRY.pulledAt);
    expect(P.latestPulledAt([])).toBeNull();
    expect(P.latestPulledAt(null)).toBeNull();
  });
});

describe('joinCasesToWrs (findings §2.2)', () => {
  it('unit match; unjoined when no open WR', () => {
    const r = P.joinCasesToWrs({ entries: [ENTRY, CLOSED], openWos: [wo('W1', '#122269', 'FREIGHTLINER')] });
    expect(r.byWr.get('W1')).toBe(ENTRY);
    expect(r.unjoined).toEqual([CLOSED]);
  });

  it('VIN last-6 fallback through the fleet row', () => {
    const e = Object.assign({}, ENTRY, { unitId: '' });
    const r = P.joinCasesToWrs({ entries: [e], openWos: [wo('W2', 'TRK7', 'TA')], fleetRows: [{ equipmentId: 'TRK7', vin: '3AKJHHDR1NSNP6923' }] });
    expect(r.byWr.get('W2')).toBe(e);
  });

  it('tie-break: WR naming the case, then DTNA vendor, then newest', () => {
    const wos = [wo('A', '122269', 'TA', 3), wo('B', '122269', 'FREIGHTLINER', 1), wo('C', '122269', 'DAIMLER', 2)];
    expect([...P.joinCasesToWrs({ entries: [ENTRY], openWos: wos }).byWr.keys()]).toEqual(['C']);
    expect([...P.joinCasesToWrs({ entries: [ENTRY], openWos: wos, wrDtnaCase: new Map([['A', CASE_ID]]) }).byWr.keys()]).toEqual(['A']);
    expect([...P.joinCasesToWrs({ entries: [ENTRY], openWos: [wo('A', '122269', 'TA', 3), wo('D', '122269', 'TA', 9)] }).byWr.keys()]).toEqual(['D']);
  });

  it('blocked (Decisiv) WRs are never used', () => {
    const r = P.joinCasesToWrs({ entries: [ENTRY], openWos: [wo('W1', '122269', 'VOLVO')], blockedWrIds: new Set(['W1']) });
    expect(r.byWr.size).toBe(0);
    expect(r.unjoined).toEqual([ENTRY]);
  });

  it('a WR takes one case: the named one, else the non-closed one', () => {
    const closedSameUnit = Object.assign({}, CLOSED, { unitId: '122269' });
    const r = P.joinCasesToWrs({ entries: [closedSameUnit, ENTRY], openWos: [wo('W1', '122269', 'FREIGHTLINER')] });
    expect(r.byWr.get('W1')).toBe(ENTRY);
    expect(r.unjoined).toEqual([closedSameUnit]);
    const r2 = P.joinCasesToWrs({ entries: [ENTRY, closedSameUnit], openWos: [wo('W1', '122269', 'FREIGHTLINER')], wrDtnaCase: new Map([['W1', NO_RO_CASE_ID]]) });
    expect(r2.byWr.get('W1')).toBe(closedSameUnit);
    expect(r2.unjoined).toEqual([ENTRY]);
  });
});
