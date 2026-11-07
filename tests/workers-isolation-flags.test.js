// tests/workers-isolation-flags.test.js — Phase 8 isolation flag resolver (design §4, review N1).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

const OFF = { enabled: false, groups: { canonical: false } };

describe('resolveWorkerIsolationFlags', () => {
  it('defaults OFF', () => {
    expect(pf.resolveWorkerIsolationFlags({}, {})).toEqual(OFF);
    expect(pf.resolveWorkerIsolationFlags(null, {})).toEqual(OFF);
    expect(pf.resolveWorkerIsolationFlags('nope', undefined)).toEqual(OFF);
    expect(pf.resolveWorkerIsolationFlags({ workers: { isolation: 'yes' } }, {})).toEqual(OFF);
    expect(pf.ISOLATION_GROUPS).toEqual(['canonical']);
    expect(pf.ISOLATION_ENV).toEqual({ enabled: 'FLEET_WORKERS_ISOLATION', canonical: 'FLEET_WORKERS_ISOLATION_CANONICAL' });
  });

  it('settings true enables; truthy non-booleans do not', () => {
    expect(pf.resolveWorkerIsolationFlags({ workers: { isolation: { enabled: true, canonical: true } } }, {}))
      .toEqual({ enabled: true, groups: { canonical: true } });
    expect(pf.resolveWorkerIsolationFlags({ workers: { isolation: { enabled: 'true', canonical: 1 } } }, {})).toEqual(OFF);
  });

  it('env overrides settings both ways; junk ignored', () => {
    const on = { workers: { isolation: { enabled: true, canonical: true } } };
    expect(pf.resolveWorkerIsolationFlags(on, { FLEET_WORKERS_ISOLATION: '0', FLEET_WORKERS_ISOLATION_CANONICAL: '0' })).toEqual(OFF);
    expect(pf.resolveWorkerIsolationFlags({}, { FLEET_WORKERS_ISOLATION: '1', FLEET_WORKERS_ISOLATION_CANONICAL: '1' }))
      .toEqual({ enabled: true, groups: { canonical: true } });
    expect(pf.resolveWorkerIsolationFlags(on, { FLEET_WORKERS_ISOLATION: 'yes', FLEET_WORKERS_ISOLATION_CANONICAL: 'true' }))
      .toEqual({ enabled: true, groups: { canonical: true } });
  });

  it('loadWorkerIsolation returns all OFF on load error', () => {
    expect(pf.loadWorkerIsolation({ load: () => { throw new Error('boom'); }, env: {} })).toEqual(OFF);
    expect(pf.loadWorkerIsolation({ load: () => ({ workers: { isolation: { enabled: true, canonical: true } } }), env: {} }))
      .toEqual({ enabled: true, groups: { canonical: true } });
  });

  it('resolveWorkerFlags ignores workers.isolation', () => {
    expect(pf.resolveWorkerFlags({ workers: { isolation: { enabled: true, canonical: true } } }, {})).toEqual(pf.resolveWorkerFlags({}, {}));
  });
});
