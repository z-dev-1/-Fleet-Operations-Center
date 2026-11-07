// tests/repair-intel-flags.test.js — settings.repairIntel flag group.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { resolveRepairIntelFlags, loadRepairIntel, REPAIR_INTEL_ENV } = require('../src/config/perf-flags');

describe('resolveRepairIntelFlags', () => {
  it('defaults: woSummaries off, dealerBackfill on', () => {
    expect(resolveRepairIntelFlags({}, {})).toEqual({ woSummaries: false, dealerBackfill: true });
    expect(resolveRepairIntelFlags(null, null)).toEqual({ woSummaries: false, dealerBackfill: true });
    expect(resolveRepairIntelFlags({ repairIntel: 'junk' }, {})).toEqual({ woSummaries: false, dealerBackfill: true });
  });

  it('settings on/off', () => {
    expect(resolveRepairIntelFlags({ repairIntel: { woSummaries: true, dealerBackfill: false } }, {}))
      .toEqual({ woSummaries: true, dealerBackfill: false });
    // only === true enables woSummaries; only === false disables dealerBackfill
    expect(resolveRepairIntelFlags({ repairIntel: { woSummaries: 'yes', dealerBackfill: 0 } }, {}))
      .toEqual({ woSummaries: false, dealerBackfill: true });
  });

  it("env '0'/'1' overrides settings", () => {
    const env = { [REPAIR_INTEL_ENV.woSummaries]: '1', [REPAIR_INTEL_ENV.dealerBackfill]: '0' };
    expect(resolveRepairIntelFlags({}, env)).toEqual({ woSummaries: true, dealerBackfill: false });
    const env2 = { FLEET_REPAIR_INTEL_WO_SUMMARIES: '0', FLEET_REPAIR_INTEL_DEALER_BACKFILL: '1' };
    expect(resolveRepairIntelFlags({ repairIntel: { woSummaries: true, dealerBackfill: false } }, env2))
      .toEqual({ woSummaries: false, dealerBackfill: true });
  });

  it('junk env ignored', () => {
    const env = { FLEET_REPAIR_INTEL_WO_SUMMARIES: 'true', FLEET_REPAIR_INTEL_DEALER_BACKFILL: 'no' };
    expect(resolveRepairIntelFlags({ repairIntel: { woSummaries: true } }, env)).toEqual({ woSummaries: true, dealerBackfill: true });
  });
});

describe('loadRepairIntel', () => {
  it('reads settings through deps.load', () => {
    const load = (k, d) => (k === 'settings' ? { repairIntel: { woSummaries: true } } : d);
    expect(loadRepairIntel({ load, env: {} })).toEqual({ woSummaries: true, dealerBackfill: true });
  });
  it('deps.load throwing → defaults', () => {
    const load = () => { throw new Error('boom'); };
    expect(loadRepairIntel({ load, env: {} })).toEqual({ woSummaries: false, dealerBackfill: true });
  });
});
