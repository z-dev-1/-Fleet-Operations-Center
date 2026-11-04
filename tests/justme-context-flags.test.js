// T-FLAGS: Just Me context reader flag resolver (default OFF, strict boolean,
// env '0'/'1' wins, anything else ignored, never throws).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveJustMeContextFlags, loadJustMeContext } = require('../src/config/perf-flags');

describe('resolveJustMeContextFlags', () => {
  it('defaults to false', () => {
    expect(resolveJustMeContextFlags({}, {})).toEqual({ readContext: false });
    expect(resolveJustMeContextFlags(undefined, undefined)).toEqual({ readContext: false });
    expect(resolveJustMeContextFlags({ comms: {} }, {})).toEqual({ readContext: false });
  });
  it('comms.justMeReadContext === true turns it on', () => {
    expect(resolveJustMeContextFlags({ comms: { justMeReadContext: true } }, {}).readContext).toBe(true);
  });
  it("non-boolean values ('yes', 1, 'true') stay off", () => {
    for (const v of ['yes', 1, 'true']) {
      expect(resolveJustMeContextFlags({ comms: { justMeReadContext: v } }, {}).readContext).toBe(false);
    }
  });
  it("env '1' overrides false settings", () => {
    expect(resolveJustMeContextFlags({ comms: { justMeReadContext: false } }, { FLEET_JUSTME_READ_CONTEXT: '1' }).readContext).toBe(true);
    expect(resolveJustMeContextFlags({}, { FLEET_JUSTME_READ_CONTEXT: '1' }).readContext).toBe(true);
  });
  it("env '0' overrides true settings", () => {
    expect(resolveJustMeContextFlags({ comms: { justMeReadContext: true } }, { FLEET_JUSTME_READ_CONTEXT: '0' }).readContext).toBe(false);
  });
  it("env '2' (or any other value) is ignored", () => {
    expect(resolveJustMeContextFlags({ comms: { justMeReadContext: true } }, { FLEET_JUSTME_READ_CONTEXT: '2' }).readContext).toBe(true);
    expect(resolveJustMeContextFlags({}, { FLEET_JUSTME_READ_CONTEXT: 'true' }).readContext).toBe(false);
  });
});

describe('loadJustMeContext', () => {
  it('reads the settings store through deps.load', () => {
    const load = (k) => (k === 'settings' ? { comms: { justMeReadContext: true } } : {});
    expect(loadJustMeContext({ load, env: {} }).readContext).toBe(true);
  });
  it('a throwing deps.load yields false', () => {
    expect(loadJustMeContext({ load: () => { throw new Error('boom'); }, env: {} })).toEqual({ readContext: false });
  });
  it('env override applies through load', () => {
    expect(loadJustMeContext({ load: () => ({}), env: { FLEET_JUSTME_READ_CONTEXT: '1' } }).readContext).toBe(true);
  });
  it('the test setup forces the real env off', () => {
    expect(process.env.FLEET_JUSTME_READ_CONTEXT).toBe('0');
  });
});
