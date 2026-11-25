// tests/autopilot-complexity.test.js — Autopilot V2 §6.6 complexity tiers (FR-5.1).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { classify } = require('../src/autopilot/complexity');

const wo = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: 'svc-' + i, role: i ? 'secondary' : 'primary' })));
const A = (over) => Object.assign({ reasons: ['OOS', 'DWELL_EXCEEDED'], conflictGroups: [], needsReviewConflict: false, eta: { status: 'NOT_PROVIDED' }, untrustedNewer: false }, over || {});
const C = (i) => classify(Object.assign({ rec: {}, row: {}, analysis: A() }, i));

describe('complexity.classify', () => {
  it('each complex signal', () => {
    expect(C({ analysis: A({ reasons: ['OOS', 'STATUS_CONFLICT'] }) })).toEqual({ tier: 'complex', signals: ['status_conflict'] });
    expect(C({ analysis: A({ needsReviewConflict: true }) }).signals).toEqual(['authority_tie']);
    expect(C({ rec: { wo_set_json: wo(2) } }).signals).toEqual(['multi_wo']);
    expect(C({ row: { etcMissCount: 1 } }).signals).toEqual(['etc_miss']);
    expect(C({ row: { etcSlipCount: 2 } }).signals).toEqual(['etc_slip']);
    expect(C({ row: { etcSlipCount: 1 } }).tier).toBe('standard');
    expect(C({ analysis: A({ reasons: ['ETA_OVERDUE_VERIFIED'] }) }).signals).toEqual(['eta_overdue']);
    expect(C({ rec: { recurrence_of: 'c0' } }).signals).toEqual(['repeat_episode']);
    expect(C({ rec: { recurrence_count: 1 } }).signals).toEqual(['repeat_episode']);
  });

  it('RECURRING_DEFECT alone is not complex', () => {
    expect(C({ analysis: A({ reasons: ['OOS', 'RECURRING_DEFECT'] }) }).tier).toBe('standard');
  });

  it('simple: trivial, or one WO with an authoritative FUTURE ETC and no conflict group', () => {
    expect(C({ analysis: A({ reasons: ['REPAIRED_UNVERIFIED'] }) })).toEqual({ tier: 'simple', signals: ['trivial'] });
    const fut = A({ eta: { status: 'FUTURE', date: '2026-12-01', source: 'decisiv' } });
    expect(C({ rec: { wo_set_json: wo(1) }, analysis: fut })).toEqual({ tier: 'simple', signals: ['single_wo_future_eta'] });
    expect(C({ rec: { wo_set_json: wo(1) }, analysis: A({ eta: { status: 'FUTURE', source: 'notes' } }) }).tier).toBe('standard');
    expect(C({ rec: { wo_set_json: wo(1) }, analysis: Object.assign({}, fut, { conflictGroups: [{ group: 'cf_repairEtc' }] }) }).tier).toBe('standard');
  });

  it('standard otherwise; deep is decided by the caller', () => {
    expect(C({}).tier).toBe('standard');
    expect(classify({}).tier).toBe('standard');
  });
});
