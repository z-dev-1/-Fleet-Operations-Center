// tests/wo-facts-estimate.test.js — relay-extract §7 estimateModel (AC8): IND260261 TA
// version chain, approvedTotal, KWNE short rejection, Approved V1, row mirrors.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as V from './fixtures/extract/relay-vendors.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const F = require('../src/repair-intel/wo-facts');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';

describe('AC8 IND260261 estimate chain', () => {
  const rf = X.extractRelay(V.relayIND260261, { vendor: 'TA', now: NOW });
  const est = F.buildFactSet({ relayFacts: rf }, { today: TODAY }).estimate;
  const byAmt = (a) => est.versions.find((v) => v.amount === a);

  it('versions v1..v4 keyed by amount', () => {
    expect(est.versions.map((v) => [v.v, v.amount])).toEqual([[1, 28895.94], [2, 28984.94], [3, 24715.13], [4, 24804.13]]);
    expect(byAmt(28895.94).status).toBe('submitted');
    expect(byAmt(28984.94).history.map((h) => h.status)).toEqual(['rejected', 'temp-reject']);
    expect(byAmt(28984.94).history[0].reason).toBe('Line item cost above expected');
    expect(byAmt(24715.13).status).toBe('submitted');
    const v4 = byAmt(24804.13).history.map((h) => h.status);
    expect(v4).toEqual(expect.arrayContaining(['submitted', 'temp-reject', 'approved']));
    expect(byAmt(24804.13).status).toBe('approved');
  });

  it('approvedTotal 24804.13; mirrors and totalCost string', () => {
    expect(est.approvedTotal).toBe(24804.13);
    expect(est.status).toBe('approved');
    const row = { equipmentId: 'IND260261', relayFacts: rf };
    F.refreshRowFacts(row, { enabled: true, aiOutput: true }, TODAY);
    expect(row.totalCost).toBe('$24,804.13');
    expect(row.estimateApprovedAmount).toBe(24804.13);
    expect(row.estimateStatus).toBe('approved');
    expect(row.estimateVersion).toBe(4);
    expect(row._factEstimateWhy).toBe('');   // approved after the last rejection
  });
});

describe('KWNE short forms (B12258)', () => {
  const rf = X.extractRelay(V.relayB12258, { now: NOW });
  const est = F.buildFactSet({ relayFacts: rf }, { today: TODAY }).estimate;
  it('reject $ 1,720.52 -> a rejected version 1720.52', () => {
    const v = est.versions.find((x) => x.amount === 1720.52);
    expect(v).toBeTruthy();
    expect(v.status).toBe('rejected');
  });
  it('Approved V1 $509.65 -> v1 approved 509.65', () => {
    const v = est.versions.find((x) => x.amount === 509.65);
    expect(v).toMatchObject({ v: 1, status: 'approved' });
    expect(est.approvedTotal).toBe(509.65);
  });
});

describe('estimate why', () => {
  it('rejection without a later approval -> V<n> <status>: <reason>', () => {
    const rf = X.extractRelay({
      id: 's', workOrders: [],
      workRequest: { id: 'w', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-11-01T12:00:00Z'), comments: [
        { timestamp: '2026-11-02T14:00:00Z', createdBy: 'fasuser3', text: 'Estimate rejection reason: Line item cost above expected\n\nDetails: $1,200.00 Rejected, labor hours high' },
      ] },
    }, { now: NOW });
    const row = { equipmentId: 'E1', relayFacts: rf };
    F.refreshRowFacts(row, { enabled: true, aiOutput: true }, TODAY);
    expect(row._factEstimateWhy).toBe('V1 rejected: Line item cost above expected');
    expect(row.estimateRejectReason).toBe('Line item cost above expected');
  });
});
