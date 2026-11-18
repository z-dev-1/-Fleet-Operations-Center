// tests/carrier-intel-flags.test.js — carrier-intel design B13: the Carrier Intel flag. AC-33.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../src/config/perf-flags');

describe('AC-33 resolveCarrierIntelFlags / loadCarrierIntel', () => {
  it('default ON', () => {
    expect(P.resolveCarrierIntelFlags({}, {})).toEqual({ enabled: true });
    expect(P.resolveCarrierIntelFlags(undefined, undefined)).toEqual({ enabled: true });
    expect(P.resolveCarrierIntelFlags({ ai: {} }, {})).toEqual({ enabled: true });
  });
  it('only settings.ai.carrierIntel === false disables', () => {
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: false } }, {})).toEqual({ enabled: false });
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: true } }, {})).toEqual({ enabled: true });
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: 'no' } }, {})).toEqual({ enabled: true });
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: 0 } }, {})).toEqual({ enabled: true });
  });
  it("env '0' / '1' override settings; other values are ignored", () => {
    expect(P.resolveCarrierIntelFlags({}, { FLEET_AI_CARRIER_INTEL: '0' })).toEqual({ enabled: false });
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: false } }, { FLEET_AI_CARRIER_INTEL: '1' })).toEqual({ enabled: true });
    expect(P.resolveCarrierIntelFlags({ ai: { carrierIntel: false } }, { FLEET_AI_CARRIER_INTEL: 'maybe' })).toEqual({ enabled: false });
  });
  it('loadCarrierIntel reads settings through the injected loader and env', () => {
    const load = (k, fb) => (k === 'settings' ? { ai: { carrierIntel: false } } : fb);
    expect(P.loadCarrierIntel({ load, env: {} })).toEqual({ enabled: false });
    expect(P.loadCarrierIntel({ load, env: { FLEET_AI_CARRIER_INTEL: '1' } })).toEqual({ enabled: true });
  });
  it('loadCarrierIntel with a throwing loader -> { enabled:true }', () => {
    const load = () => { throw new Error('store down'); };
    expect(P.loadCarrierIntel({ load, env: {} })).toEqual({ enabled: true });
  });
  it('the test setup forces the flag off for legacy suites', () => {
    expect(process.env.FLEET_AI_CARRIER_INTEL).toBe('0');
    expect(P.loadCarrierIntel({ load: () => ({}) })).toEqual({ enabled: false });
  });
  it('export sits right after the DBR lookup pair', () => {
    const keys = Object.keys(P);
    const i = keys.indexOf('loadDbrLookup');
    expect(keys.slice(i + 1, i + 3)).toEqual(['resolveCarrierIntelFlags', 'loadCarrierIntel']);
  });
});
