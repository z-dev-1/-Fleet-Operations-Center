// tests/auth-coord-flags.test.js — Phase 9 flag resolver (AC-1), loadAuthCoord
// fallback, the setup-file guard, and the supervisor STATE contract that the
// Phase 5 worker supervisor's AUTH_DOWN set depends on (FR-9).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// Isolated data dir so loadAuthCoord() never reads the developer's real settings.json.
require('../src/config/paths').setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-coord-flags-')));
const { resolveAuthCoordFlags, loadAuthCoord, AUTH_COORD_ENV } = require('../src/config/perf-flags');

const OFF = { singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false };

describe('resolveAuthCoordFlags (AC-1)', () => {
  it('defaults all OFF', () => {
    expect(resolveAuthCoordFlags({}, {})).toEqual(OFF);
    expect(resolveAuthCoordFlags(undefined, {})).toEqual(OFF);
  });

  it('non-object / junk / string "true" settings → all false', () => {
    for (const s of [null, 42, 'x', [], { auth: 'yes' }, { auth: [] }, { auth: { singleFlight: 'true', singleOwner: 'true' } },
      { auth: { singleFlight: 1, singleOwner: { aea: 'true', reconnect: 1 } } }]) {
      expect(resolveAuthCoordFlags(s, {})).toEqual(OFF);
    }
  });

  it('only === true enables, per flag', () => {
    expect(resolveAuthCoordFlags({ auth: { singleFlight: true } }, {})).toEqual({ ...OFF, singleFlight: true });
    expect(resolveAuthCoordFlags({ auth: { singleOwner: { aea: true } } }, {})).toEqual({ ...OFF, singleOwnerAea: true });
    expect(resolveAuthCoordFlags({ auth: { singleOwner: { reconnect: true } } }, {})).toEqual({ ...OFF, singleOwnerReconnect: true });
  });

  it("env '1'/'0' wins over settings in both directions", () => {
    const allOn = { auth: { singleFlight: true, singleOwner: { aea: true, reconnect: true } } };
    expect(resolveAuthCoordFlags(allOn, { FLEET_AUTH_SINGLE_FLIGHT: '0', FLEET_AUTH_SINGLE_OWNER_AEA: '0', FLEET_AUTH_SINGLE_OWNER_RECONNECT: '0' })).toEqual(OFF);
    expect(resolveAuthCoordFlags({}, { FLEET_AUTH_SINGLE_FLIGHT: '1', FLEET_AUTH_SINGLE_OWNER_AEA: '1', FLEET_AUTH_SINGLE_OWNER_RECONNECT: '1' }))
      .toEqual({ singleFlight: true, singleOwnerAea: true, singleOwnerReconnect: true });
  });

  it("other env values ('yes', 'true', '') are ignored", () => {
    for (const v of ['yes', 'true', '', ' 1']) {
      expect(resolveAuthCoordFlags({}, { FLEET_AUTH_SINGLE_FLIGHT: v })).toEqual(OFF);
      expect(resolveAuthCoordFlags({ auth: { singleFlight: true } }, { FLEET_AUTH_SINGLE_FLIGHT: v }).singleFlight).toBe(true);
    }
  });

  it('AUTH_COORD_ENV names', () => {
    expect(AUTH_COORD_ENV).toEqual({
      singleFlight: 'FLEET_AUTH_SINGLE_FLIGHT',
      singleOwnerAea: 'FLEET_AUTH_SINGLE_OWNER_AEA',
      singleOwnerReconnect: 'FLEET_AUTH_SINGLE_OWNER_RECONNECT',
    });
  });
});

describe('loadAuthCoord', () => {
  it('never throws; load failure → all false', () => {
    expect(loadAuthCoord({ env: {}, load: () => { throw new Error('x'); } })).toEqual(OFF);
  });

  it('reads settings through deps.load', () => {
    expect(loadAuthCoord({ env: {}, load: () => ({ auth: { singleFlight: true } }) })).toEqual({ ...OFF, singleFlight: true });
  });

  it('no deps → all false (the vitest setup file forces FLEET_AUTH_* to "0")', () => {
    expect(loadAuthCoord()).toEqual(OFF);
  });
});

describe('supervisor STATE contract (FR-9)', () => {
  it('contains every state the worker supervisor AUTH_DOWN set and the run states rely on', () => {
    // Mirrors src/workers/supervisor.js:49 AUTH_DOWN = {OFFLINE, WAITING_FOR_USER,
    // COOLDOWN, RECOVERING, FAILED} (not exported) + the "runs" states. A rename
    // here would silently break AUTH_DOWN.
    const values = Object.values(require('../src/auth/midway-health-supervisor').STATE);
    for (const s of ['OFFLINE', 'WAITING_FOR_USER', 'COOLDOWN', 'RECOVERING', 'FAILED', 'HEALTHY', 'UNKNOWN', 'DEGRADED']) {
      expect(values).toContain(s);
    }
  });
});
