// tests/workers-flags.test.js
// Phase 5 worker supervisor flags (src/config/perf-flags.js resolveWorkerFlags /
// loadWorkers). Everything defaults OFF; only `=== true` enables; env '0'/'1' wins.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'workers-flags-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const { resolveWorkerFlags, loadWorkers, WORKER_NAMES, WORKER_ENV } = require('../src/config/perf-flags');

const ALL_OFF = {
  supervisorEnabled: false,
  supervised: {
    repairIntel: false, emailTriage: false, carrierBriefing: false, longDwell: false,
    dailyTasks: false, fasCoverage: false, apiFleetRefresh: false,
  },
};

describe('worker flags', () => {
  it('defaults: everything off for all 7 names', () => {
    expect(WORKER_NAMES).toEqual(['repairIntel', 'emailTriage', 'carrierBriefing', 'longDwell', 'dailyTasks', 'fasCoverage', 'apiFleetRefresh']);
    expect(resolveWorkerFlags({}, {})).toEqual(ALL_OFF);
    expect(resolveWorkerFlags(undefined, undefined)).toEqual(ALL_OFF);
    expect(resolveWorkerFlags({ workers: 'yes' }, {})).toEqual(ALL_OFF);
    expect(resolveWorkerFlags({ workers: [] }, {})).toEqual(ALL_OFF);
  });

  it('only === true enables', () => {
    const on = { workers: { supervisor: { enabled: true } } };
    for (const n of WORKER_NAMES) on.workers[n] = { supervised: true };
    const f = resolveWorkerFlags(on, {});
    expect(f.supervisorEnabled).toBe(true);
    for (const n of WORKER_NAMES) expect(f.supervised[n]).toBe(true);
    for (const bad of ['true', 1, 'on', {}, null]) {
      const s = { workers: { supervisor: { enabled: bad } } };
      for (const n of WORKER_NAMES) s.workers[n] = { supervised: bad };
      expect(resolveWorkerFlags(s, {})).toEqual(ALL_OFF);
    }
  });

  it('FLEET_WORKERS / FLEET_WORKER_<NAME> override both ways', () => {
    expect(WORKER_ENV.apiFleetRefresh).toBe('FLEET_WORKER_API_FLEET_REFRESH');
    const allOn = { workers: { supervisor: { enabled: true } } };
    for (const n of WORKER_NAMES) allOn.workers[n] = { supervised: true };
    const envOff = { FLEET_WORKERS: '0' };
    const envOn = { FLEET_WORKERS: '1' };
    for (const n of WORKER_NAMES) { envOff[WORKER_ENV[n]] = '0'; envOn[WORKER_ENV[n]] = '1'; }
    expect(resolveWorkerFlags(allOn, envOff)).toEqual(ALL_OFF);
    const f = resolveWorkerFlags({}, envOn);
    expect(f.supervisorEnabled).toBe(true);
    for (const n of WORKER_NAMES) expect(f.supervised[n]).toBe(true);
    // single per-worker override, incl. the API refresh name
    const g = resolveWorkerFlags({}, { FLEET_WORKER_API_FLEET_REFRESH: '1' });
    expect(g.supervised.apiFleetRefresh).toBe(true);
    expect(g.supervised.repairIntel).toBe(false);
    // other env values are ignored
    const envJunk = { FLEET_WORKERS: 'true' };
    for (const n of WORKER_NAMES) envJunk[WORKER_ENV[n]] = 'yes';
    expect(resolveWorkerFlags({}, envJunk)).toEqual(ALL_OFF);
    expect(resolveWorkerFlags(allOn, envJunk).supervisorEnabled).toBe(true);
  });

  it('per-worker flag independent of supervisor flag', () => {
    const f = resolveWorkerFlags({ workers: { emailTriage: { supervised: true } } }, {});
    expect(f.supervisorEnabled).toBe(false);
    expect(f.supervised.emailTriage).toBe(true);
    const g = resolveWorkerFlags({ workers: { supervisor: { enabled: true } } }, {});
    expect(g.supervisorEnabled).toBe(true);
    expect(Object.values(g.supervised).every(v => v === false)).toBe(true);
  });

  it('loadWorkers with injected load / throwing load → defaults', () => {
    const f = loadWorkers({ env: {}, load: (k) => (k === 'settings' ? { workers: { supervisor: { enabled: true }, longDwell: { supervised: true } } } : null) });
    expect(f.supervisorEnabled).toBe(true);
    expect(f.supervised.longDwell).toBe(true);
    expect(loadWorkers({ env: {}, load: () => { throw new Error('boom'); } })).toEqual(ALL_OFF);
    expect(loadWorkers({ env: {}, load: () => null })).toEqual(ALL_OFF);
    expect(loadWorkers({ env: { FLEET_WORKERS: '1' }, load: () => ({}) }).supervisorEnabled).toBe(true);
  });

  it('settings store is already registered', () => {
    const store = require('../src/store');
    expect(typeof store.REGISTRY.settings).toBe('function');
  });
});
