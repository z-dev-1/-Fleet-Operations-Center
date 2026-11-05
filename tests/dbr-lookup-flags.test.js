// DBR lookup flag resolver (default OFF, strict boolean, env '0'/'1' wins,
// anything else ignored, never throws).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveDbrLookupFlags, loadDbrLookup } = require('../src/config/perf-flags');

describe('resolveDbrLookupFlags', () => {
  it('defaults to false', () => {
    expect(resolveDbrLookupFlags({}, {})).toEqual({ enabled: false });
    expect(resolveDbrLookupFlags(undefined, undefined)).toEqual({ enabled: false });
    expect(resolveDbrLookupFlags({ ai: {} }, {})).toEqual({ enabled: false });
  });
  it('ai.dbrLookup === true turns it on', () => {
    expect(resolveDbrLookupFlags({ ai: { dbrLookup: true } }, {}).enabled).toBe(true);
  });
  it("non-boolean values ('yes', 1, 'true') stay off", () => {
    for (const v of ['yes', 1, 'true']) {
      expect(resolveDbrLookupFlags({ ai: { dbrLookup: v } }, {}).enabled).toBe(false);
    }
  });
  it("env '1' overrides false settings", () => {
    expect(resolveDbrLookupFlags({ ai: { dbrLookup: false } }, { FLEET_AI_DBR_LOOKUP: '1' }).enabled).toBe(true);
    expect(resolveDbrLookupFlags({}, { FLEET_AI_DBR_LOOKUP: '1' }).enabled).toBe(true);
  });
  it("env '0' overrides true settings", () => {
    expect(resolveDbrLookupFlags({ ai: { dbrLookup: true } }, { FLEET_AI_DBR_LOOKUP: '0' }).enabled).toBe(false);
  });
  it("env '2' (or any other value) is ignored", () => {
    expect(resolveDbrLookupFlags({ ai: { dbrLookup: true } }, { FLEET_AI_DBR_LOOKUP: '2' }).enabled).toBe(true);
    expect(resolveDbrLookupFlags({}, { FLEET_AI_DBR_LOOKUP: 'true' }).enabled).toBe(false);
  });
  it('ai.gateway siblings do not interfere', () => {
    const s = { ai: { gateway: { priorities: true, dedupe: true }, dbrLookup: true } };
    expect(resolveDbrLookupFlags(s, {}).enabled).toBe(true);
    expect(resolveDbrLookupFlags({ ai: { gateway: { priorities: true } } }, {}).enabled).toBe(false);
  });
});

describe('loadDbrLookup', () => {
  it('reads the settings store through deps.load', () => {
    const load = (k) => (k === 'settings' ? { ai: { dbrLookup: true } } : {});
    expect(loadDbrLookup({ load, env: {} }).enabled).toBe(true);
  });
  it('a throwing deps.load yields false', () => {
    expect(loadDbrLookup({ load: () => { throw new Error('boom'); }, env: {} })).toEqual({ enabled: false });
  });
  it('env override applies through load', () => {
    expect(loadDbrLookup({ load: () => ({}), env: { FLEET_AI_DBR_LOOKUP: '1' } }).enabled).toBe(true);
  });
  it('the test setup forces the real env off', () => {
    expect(process.env.FLEET_AI_DBR_LOOKUP).toBe('0');
  });
});
