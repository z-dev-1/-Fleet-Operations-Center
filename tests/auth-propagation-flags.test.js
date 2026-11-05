// tests/auth-propagation-flags.test.js — auth.propagation flag resolver (default OFF).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

describe('resolveAuthPropagationFlags', () => {
  it('defaults OFF with no settings and no env', () => {
    expect(pf.resolveAuthPropagationFlags({}, {})).toEqual({ enabled: false });
    expect(pf.resolveAuthPropagationFlags(null, null)).toEqual({ enabled: false });
    expect(pf.resolveAuthPropagationFlags(undefined, undefined)).toEqual({ enabled: false });
  });

  it('only settings.auth.propagation.enabled === true enables', () => {
    expect(pf.resolveAuthPropagationFlags({ auth: { propagation: { enabled: true } } }, {})).toEqual({ enabled: true });
    for (const junk of ['true', 1, 'yes', {}, [], null, false]) {
      expect(pf.resolveAuthPropagationFlags({ auth: { propagation: { enabled: junk } } }, {})).toEqual({ enabled: false });
    }
    expect(pf.resolveAuthPropagationFlags({ auth: { propagation: true } }, {})).toEqual({ enabled: false });
    expect(pf.resolveAuthPropagationFlags({ auth: 'x' }, {})).toEqual({ enabled: false });
  });

  it('env wins both ways; junk env is ignored', () => {
    const on = { auth: { propagation: { enabled: true } } };
    expect(pf.resolveAuthPropagationFlags(on, { FLEET_AUTH_PROPAGATION: '0' })).toEqual({ enabled: false });
    expect(pf.resolveAuthPropagationFlags({}, { FLEET_AUTH_PROPAGATION: '1' })).toEqual({ enabled: true });
    expect(pf.resolveAuthPropagationFlags(on, { FLEET_AUTH_PROPAGATION: 'true' })).toEqual({ enabled: true });
    expect(pf.resolveAuthPropagationFlags({}, { FLEET_AUTH_PROPAGATION: 'yes' })).toEqual({ enabled: false });
  });

  it('AUTH_PROPAGATION_ENV names the env var', () => {
    expect(pf.AUTH_PROPAGATION_ENV).toEqual({ enabled: 'FLEET_AUTH_PROPAGATION' });
  });

  it('Phase 9 resolver is untouched: still the 3-key OFF object and ignores propagation', () => {
    expect(pf.resolveAuthCoordFlags({}, {})).toEqual({ singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false });
    expect(pf.resolveAuthCoordFlags({ auth: { propagation: { enabled: true } } }, {}))
      .toEqual({ singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false });
  });

  it('propagation flag ignores the Phase 9 keys', () => {
    const s = { auth: { singleFlight: true, singleOwner: { aea: true, reconnect: true } } };
    expect(pf.resolveAuthPropagationFlags(s, {})).toEqual({ enabled: false });
  });
});

describe('loadAuthPropagation', () => {
  it('reads settings through deps.load', () => {
    const load = (k) => (k === 'settings' ? { auth: { propagation: { enabled: true } } } : null);
    expect(pf.loadAuthPropagation({ load, env: {} })).toEqual({ enabled: true });
  });

  it('a throwing store means OFF', () => {
    const load = () => { throw new Error('boom'); };
    expect(pf.loadAuthPropagation({ load, env: {} })).toEqual({ enabled: false });
  });

  it('env override applies through load', () => {
    const load = () => ({ auth: { propagation: { enabled: true } } });
    expect(pf.loadAuthPropagation({ load, env: { FLEET_AUTH_PROPAGATION: '0' } })).toEqual({ enabled: false });
  });

  it('the test setup forces the flag OFF via env', () => {
    expect(process.env.FLEET_AUTH_PROPAGATION).toBe('0');
    expect(pf.loadAuthPropagation({ load: () => ({ auth: { propagation: { enabled: true } } }) })).toEqual({ enabled: false });
  });
});
