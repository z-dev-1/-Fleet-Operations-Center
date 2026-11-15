// tests/authority-extract.test.js — relay-extract FR14 / §8 / AC22: the five new
// FIELD_AUTHORITY keys; every pre-existing key unchanged.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveField, FIELD_AUTHORITY } = require('../src/ai/authority');

describe('authority — relay-extract keys (AC22)', () => {
  it('adds the five field orders', () => {
    expect(FIELD_AUTHORITY.dealerName).toEqual(['decisiv', 'paccar', 'offsiteevent', 'relaygarage', 'fleetdata']);
    expect(FIELD_AUTHORITY.repairEtc).toEqual(['decisiv', 'offsiteevent', 'relaygarage/vendor', 'relaygarage', 'notes']);
    expect(FIELD_AUTHORITY.partsEta).toEqual(['decisiv', 'relaygarage/vendor', 'relaygarage', 'notes']);
    expect(FIELD_AUTHORITY.estimateAmount).toEqual(['relaygarage/approver', 'decisiv', 'relaygarage/vendor']);
    expect(FIELD_AUTHORITY.salesforceCase).toEqual(['relaygarage', 'notes']);
  });
  it('dealerName: decisiv beats relaygarage and reports the conflict', () => {
    const r = resolveField('dealerName', [{ value: 'A', source: 'relaygarage' }, { value: 'B', source: 'decisiv' }]);
    expect(r.value).toBe('B');
    expect(r.conflict).toBe(true);
  });
  it('repairEtc: decisiv beats relaygarage/fas', () => {
    const r = resolveField('repairEtc', [{ value: '2026-11-08', source: 'relaygarage/fas' }, { value: '2026-11-11', source: 'decisiv' }]);
    expect(r.value).toBe('2026-11-11');
  });
  it('repairEtc: relaygarage/vendor beats relaygarage/fas', () => {
    const r = resolveField('repairEtc', [{ value: '2026-11-08', source: 'relaygarage/fas' }, { value: '2026-11-07', source: 'relaygarage/vendor' }]);
    expect(r.value).toBe('2026-11-07');
  });
  it('estimateAmount: relaygarage/approver beats relaygarage/vendor', () => {
    const r = resolveField('estimateAmount', [{ value: 28895.94, source: 'relaygarage/vendor' }, { value: 24804.13, source: 'relaygarage/approver' }]);
    expect(r.value).toBe(24804.13);
    expect(r.conflict).toBe(true);
  });
  it('every pre-existing key is unchanged', () => {
    expect(FIELD_AUTHORITY).toMatchObject({
      lifecycleState: ['aap', 'canonical', 'fleetdata'],
      lifecycleReason: ['aap', 'relaygarage', 'canonical', 'fleetdata'],
      serviceState: ['relaygarage', 'offsiteevent', 'decisiv', 'paccar', 'notes'],
      repairStatus: ['relaygarage', 'offsiteevent', 'notes', 'fleetdata'],
      workAccomplished: ['relaygarage/wo', 'relaygarage', 'offsiteevent', 'notes'],
      reasonForRepair: ['relaygarage/wo', 'relaygarage', 'offsiteevent', 'notes'],
      openUnplanned: ['aap', 'fleetdata', 'relaygarage'],
      openPlanned: ['aap', 'fleetdata', 'relaygarage'],
      workRequestId: ['aap', 'fleetdata', 'relaygarage'],
      hasOpenWR: ['aap', 'fleetdata', 'relaygarage'],
      pmB: ['aap', 'fleetdata', 'canonical'],
      pmX: ['aap', 'fleetdata', 'canonical'],
      dot: ['aap', 'fleetdata', 'canonical'],
      inspectionDueDate: ['fleetdata(dot)', 'aap', 'fleetdata'],
      inspectionStatus: ['fleetdata(dot)', 'aap', 'fleetdata'],
      location: ['aap', 'canonical', 'fleetdata'],
      domicile: ['fleetdata', 'aap', 'canonical'],
      riskScore: ['uptake'],
      insights: ['uptake'],
      vendor: ['fleetdata', 'relaygarage', 'aap'],
    });
    expect(Object.keys(FIELD_AUTHORITY)).toHaveLength(25);
  });
});
