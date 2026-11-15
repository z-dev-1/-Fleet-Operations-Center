// tests/extract-flags.test.js — relay-extract §16 / AC23: resolveExtractFlags, loadExtract,
// and a frozen snapshot of every perf-flags export name that existed before this feature
// (a merge that drops one of them must fail here).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flags = require('../src/config/perf-flags');

// Captured on 1eabe04 with `Object.keys(require('./src/config/perf-flags'))` before editing.
const PRE_EXISTING = [
  'resolveZoomMeetFlags', 'loadZoomMeet', 'ZOOM_MEET_ENV', 'resolveFlags', 'load', 'resolveAiGatewayFlags', 'loadAiGateway',
  'AI_GW_RESERVE_DEFAULT', 'resolveCommsFlags', 'loadComms', 'COMMS_POLLING_MODES', 'resolveWorkerFlags', 'loadWorkers',
  'WORKER_NAMES', 'WORKER_ENV', 'resolveSlackSpeedupFlags', 'loadSlackSpeedup', 'SPEEDUP_MODES', 'LANE_CONCURRENCY_MAX',
  'resolveAuthCoordFlags', 'loadAuthCoord', 'AUTH_COORD_ENV', 'resolveAuthPropagationFlags', 'loadAuthPropagation',
  'AUTH_PROPAGATION_ENV', 'resolveJobsFlags', 'loadJobs', 'JOB_TYPES', 'JOB_ENV', 'resolveWorkerIsolationFlags',
  'loadWorkerIsolation', 'ISOLATION_GROUPS', 'ISOLATION_ENV', 'resolveJustMeContextFlags', 'loadJustMeContext',
  'resolveDbrLookupFlags', 'loadDbrLookup', 'resolveFleetDbrFlags', 'loadFleetDbr', 'FLEET_DBR_ENV', 'resolveAiAkiFlags',
  'loadAiAki', 'AKI_DEFAULTS', 'resolveRepairIntelFlags', 'loadRepairIntel', 'REPAIR_INTEL_ENV', 'resolveLongDwellSpFlags',
  'loadLongDwellSp', 'LONGDWELL_SP_ENV', 'resolveEmailIntelFlags', 'loadEmailIntel', 'EMAIL_INTEL_ENV', 'EMAIL_INTEL_API_ENV',
  'resolveZoomFlags', 'loadZoom', 'ZOOM_ENV', 'ZOOM_ENV_ALIASES',
];

describe('perf-flags export snapshot', () => {
  it('still exports every pre-existing name, functions stay functions', () => {
    for (const k of PRE_EXISTING) {
      expect(Object.prototype.hasOwnProperty.call(flags, k), k).toBe(true);
      if (/^(resolve|load)/.test(k)) expect(typeof flags[k], k).toBe('function');
    }
    expect(PRE_EXISTING.length).toBeGreaterThanOrEqual(55);
  });
  it('adds resolveExtractFlags, loadExtract, EXTRACT_ENV', () => {
    expect(typeof flags.resolveExtractFlags).toBe('function');
    expect(typeof flags.loadExtract).toBe('function');
    expect(flags.EXTRACT_ENV.enabled).toBe('FLEET_EXTRACT');
    expect(flags.EXTRACT_ENV.aiOutput).toBe('FLEET_EXTRACT_AI_OUTPUT');
  });
  it('places the extract export line right after the Fleet DBR line', () => {
    const keys = Object.keys(flags);
    const i = keys.indexOf('FLEET_DBR_ENV');
    expect(keys.slice(i + 1, i + 4)).toEqual(['resolveExtractFlags', 'loadExtract', 'EXTRACT_ENV']);
    expect(keys[0]).toBe('resolveZoomMeetFlags');
    expect(keys[keys.length - 1]).toBe('ZOOM_ENV_ALIASES');
  });
});

describe('resolveExtractFlags (AC23)', () => {
  const r = flags.resolveExtractFlags;
  it('defaults ON', () => {
    expect(r({}, {})).toEqual({ enabled: true, aiOutput: true, reviewRounds: 1, reviewMaxPerRun: 200 });
    expect(r(null, null)).toEqual({ enabled: true, aiOutput: true, reviewRounds: 1, reviewMaxPerRun: 200 });
  });
  it('enabled:false forces aiOutput off', () => {
    expect(r({ extract: { enabled: false } }, {})).toMatchObject({ enabled: false, aiOutput: false });
    expect(r({ extract: { enabled: false, aiOutput: true } }, {}).aiOutput).toBe(false);
  });
  it('env overrides settings', () => {
    expect(r({}, { FLEET_EXTRACT_AI_OUTPUT: '0' }).aiOutput).toBe(false);
    expect(r({}, { FLEET_EXTRACT_AIOUTPUT: '0' }).aiOutput).toBe(false);
    expect(r({}, { FLEET_EXTRACT_AI_OUTPUT: '1', FLEET_EXTRACT_AIOUTPUT: '0' }).aiOutput).toBe(true);
    expect(r({}, { FLEET_EXTRACT: '0' })).toMatchObject({ enabled: false, aiOutput: false });
    expect(r({ extract: { enabled: false } }, { FLEET_EXTRACT: '1' }).enabled).toBe(true);
    expect(r({}, { FLEET_EXTRACT: 'yes' }).enabled).toBe(true);
  });
  it('reviewMaxPerRun is an integer 0..200, else 200', () => {
    for (const v of [500, 'x', -1]) expect(r({ extract: { reviewMaxPerRun: v } }, {}).reviewMaxPerRun).toBe(200);
    expect(r({ extract: { reviewMaxPerRun: 0 } }, {}).reviewMaxPerRun).toBe(0);
  });
  it('reviewRounds is an integer 0..2, else 1', () => {
    for (const v of [5, 'x', -1]) expect(r({ extract: { reviewRounds: v } }, {}).reviewRounds).toBe(1);
    expect(r({ extract: { reviewRounds: 0 } }, {}).reviewRounds).toBe(0);
    expect(r({ extract: { reviewRounds: 2 } }, {}).reviewRounds).toBe(2);
  });
});

describe('loadExtract', () => {
  it('reads settings through deps.load and env through deps.env', () => {
    const out = flags.loadExtract({ load: () => ({ extract: { aiOutput: false } }), env: {} });
    expect(out).toMatchObject({ enabled: true, aiOutput: false });
  });
  it('falls back to defaults when the store throws', () => {
    const out = flags.loadExtract({ load: () => { throw new Error('boom'); }, env: {} });
    expect(out).toEqual({ enabled: true, aiOutput: true, reviewRounds: 1, reviewMaxPerRun: 200 });
  });
});
