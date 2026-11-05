// tests/longdwell-sp-flags.test.js - Long Dwell SharePoint preview/write flags
// (resolveLongDwellSpFlags / loadLongDwellSp in src/config/perf-flags.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveLongDwellSpFlags, loadLongDwellSp, LONGDWELL_SP_ENV } = require('../src/config/perf-flags');

const OFF = { sharepointWrite: false, sharepointWriteCommit: false, sharepointGuard: 'modified-recheck' };

describe('resolveLongDwellSpFlags', () => {
  it('defaults are all off with the modified-recheck guard', () => {
    expect(resolveLongDwellSpFlags({}, {})).toEqual(OFF);
    expect(resolveLongDwellSpFlags(undefined, undefined)).toEqual(OFF);
  });
  it('env names', () => {
    expect(LONGDWELL_SP_ENV).toEqual({ sharepointWrite: 'FLEET_LONGDWELL_SP_WRITE', sharepointWriteCommit: 'FLEET_LONGDWELL_SP_COMMIT' });
  });
  it('only === true enables', () => {
    for (const v of ['true', 1, 'yes', {}, [], null]) {
      expect(resolveLongDwellSpFlags({ longDwell: { sharepointWrite: v, sharepointWriteCommit: v } }, {})).toEqual(OFF);
    }
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointWrite: true } }, {}).sharepointWrite).toBe(true);
  });
  it('non-object settings and longDwell values are tolerated', () => {
    for (const s of [null, 'x', 42, [], { longDwell: 'on' }, { longDwell: [true] }, { longDwell: null }]) {
      expect(resolveLongDwellSpFlags(s, {})).toEqual(OFF);
    }
  });
  it('settings.longDwell is distinct from settings.workers.longDwell', () => {
    expect(resolveLongDwellSpFlags({ workers: { longDwell: { sharepointWrite: true, sharepointWriteCommit: true } } }, {})).toEqual(OFF);
  });
  it('commit-only stays off, master-only gives a dry run, both enable commit', () => {
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointWriteCommit: true } }, {})).toEqual(OFF);
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointWrite: true } }, {})).toEqual({ ...OFF, sharepointWrite: true });
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointWrite: true, sharepointWriteCommit: true } }, {}))
      .toEqual({ ...OFF, sharepointWrite: true, sharepointWriteCommit: true });
  });
  it('env overrides both ways', () => {
    const on = { longDwell: { sharepointWrite: true, sharepointWriteCommit: true } };
    expect(resolveLongDwellSpFlags(on, { FLEET_LONGDWELL_SP_WRITE: '0' })).toEqual(OFF);
    expect(resolveLongDwellSpFlags(on, { FLEET_LONGDWELL_SP_COMMIT: '0' })).toEqual({ ...OFF, sharepointWrite: true });
    expect(resolveLongDwellSpFlags({}, { FLEET_LONGDWELL_SP_WRITE: '1' })).toEqual({ ...OFF, sharepointWrite: true });
    expect(resolveLongDwellSpFlags({}, { FLEET_LONGDWELL_SP_WRITE: '1', FLEET_LONGDWELL_SP_COMMIT: '1' }))
      .toEqual({ ...OFF, sharepointWrite: true, sharepointWriteCommit: true });
  });
  it('commit env without master is forced off', () => {
    expect(resolveLongDwellSpFlags({}, { FLEET_LONGDWELL_SP_COMMIT: '1' })).toEqual(OFF);
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointWriteCommit: true } }, { FLEET_LONGDWELL_SP_COMMIT: '1' })).toEqual(OFF);
  });
  it('garbage env values are ignored', () => {
    for (const v of ['true', 'yes', '2', '', ' 1', 'on']) {
      expect(resolveLongDwellSpFlags({}, { FLEET_LONGDWELL_SP_WRITE: v, FLEET_LONGDWELL_SP_COMMIT: v })).toEqual(OFF);
      expect(resolveLongDwellSpFlags({ longDwell: { sharepointWrite: true } }, { FLEET_LONGDWELL_SP_WRITE: v }).sharepointWrite).toBe(true);
    }
  });
  it('sharepointGuard accepts only if-match, anything else is the default', () => {
    expect(resolveLongDwellSpFlags({ longDwell: { sharepointGuard: 'if-match' } }, {}).sharepointGuard).toBe('if-match');
    for (const g of ['IF-MATCH', 'none', true, 1, null, 'modified-recheck']) {
      expect(resolveLongDwellSpFlags({ longDwell: { sharepointGuard: g } }, {}).sharepointGuard).toBe('modified-recheck');
    }
  });
});

describe('loadLongDwellSp', () => {
  it('reads settings through deps.load on every call (not memoized)', () => {
    let s = { longDwell: { sharepointWrite: true } };
    const deps = { env: {}, load: (key, def) => (key === 'settings' ? s : def) };
    expect(loadLongDwellSp(deps).sharepointWrite).toBe(true);
    s = {};
    expect(loadLongDwellSp(deps).sharepointWrite).toBe(false);
  });
  it('survives a throwing load (defaults)', () => {
    expect(loadLongDwellSp({ env: {}, load: () => { throw new Error('boom'); } })).toEqual(OFF);
  });
  it('a null settings document gives defaults; env still applies', () => {
    expect(loadLongDwellSp({ env: { FLEET_LONGDWELL_SP_WRITE: '1' }, load: () => null })).toEqual({ ...OFF, sharepointWrite: true });
  });
});
