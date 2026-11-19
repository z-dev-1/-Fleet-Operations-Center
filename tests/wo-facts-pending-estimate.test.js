// tests/wo-facts-pending-estimate.test.js — Pending Estimates: estimateModel pendingSubmittedAt /
// pendingAmount and the estimateSubmittedAt / estimateSubmittedAmount row mirrors.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/repair-intel/wo-facts');

const TODAY = '2026-11-19';
const est = (value, amountStatus, at) => ({ kind: 'estimate', value, amountStatus, at, source: 'relay' });

describe('estimateModel pending version', () => {
  it('single submit -> that time and amount', () => {
    const m = F.estimateModel([est(4200, 'submitted', '2026-11-18T10:00:00Z')]);
    expect(m.status).toBe('submitted');
    expect(m.pendingSubmittedAt).toBe('2026-11-18T10:00:00Z');
    expect(m.pendingAmount).toBe(4200);
  });

  it('two submits of the same amount -> earliest time (re-observation does not reset age)', () => {
    const m = F.estimateModel([est(4200, 'submitted', '2026-11-19T09:00:00Z'), est(4200, 'submitted', '2026-11-18T10:00:00Z')]);
    expect(m.pendingSubmittedAt).toBe('2026-11-18T10:00:00Z');
    expect(m.pendingSince).toBe('2026-11-19T09:00:00Z');
  });

  it('submit then approve -> not pending', () => {
    const m = F.estimateModel([est(4200, 'submitted', '2026-11-18T10:00:00Z'), est(4200, 'approved', '2026-11-18T12:00:00Z')]);
    expect(m.status).toBe('approved');
    expect(m.pendingSubmittedAt).toBe(null);
    expect(m.pendingAmount).toBe(null);
  });

  it('v1 rejected then v2 submitted -> v2 time and amount', () => {
    const m = F.estimateModel([
      est(1000, 'submitted', '2026-11-17T10:00:00Z'),
      est(1000, 'rejected', '2026-11-17T12:00:00Z'),
      est(1250.5, 'submitted', '2026-11-18T08:30:00Z'),
    ]);
    expect(m.status).toBe('submitted');
    expect(m.pendingSubmittedAt).toBe('2026-11-18T08:30:00Z');
    expect(m.pendingAmount).toBe(1250.5);
  });
});

describe('row mirrors', () => {
  it('refreshRowFacts sets then clears estimateSubmittedAt / estimateSubmittedAmount', () => {
    const facts = [est(87.18, 'submitted', '2026-11-19T17:10:33Z')];
    const row = { equipmentId: 'E1', relayFacts: { v: 2, at: '2026-11-19T17:59:51Z', facts } };
    F.refreshRowFacts(row, { enabled: true, aiOutput: true }, TODAY);
    expect(row.estimateStatus).toBe('submitted');
    expect(row.estimateSubmittedAt).toBe('2026-11-19T17:10:33Z');
    expect(row.estimateSubmittedAmount).toBe(87.18);
    row.relayFacts = { v: 2, at: '2026-11-19T19:00:00Z', facts: facts.concat([est(87.18, 'approved', '2026-11-19T18:30:00Z')]) };
    F.refreshRowFacts(row, { enabled: true, aiOutput: true }, TODAY);
    expect(row.estimateStatus).toBe('approved');
    expect(row.estimateSubmittedAt).toBe('');
    expect(row.estimateSubmittedAmount).toBe('');
  });
});
