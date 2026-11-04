import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage5-'));
  paths.setDataDir(dir);
  return dir;
}

describe('cluster Stage 5 — headless standby entry point', () => {
  beforeEach(() => { freshDataDir(); require('../src/cluster')._reset(); });

  it('standby module loads and exposes main()', () => {
    const standby = require('../src/cluster/standby');
    expect(typeof standby.main).toBe('function');
  });

  it('facade start() wires a periodic sync-pull timer when enabled', () => {
    const cluster = require('../src/cluster');
    let scheduled = 0;
    const setTimer = (fn, ms) => { scheduled++; return scheduled; };     // capture, don't fire
    const clearTimer = () => {};
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer, clearTimer, syncMs: 1000 });
    // Both the lease loop and the sync timer should have scheduled work.
    expect(scheduled).toBeGreaterThanOrEqual(2);
  });

  it('start({noSyncTimer}) skips the sync timer (for manual-drive tests)', () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    let scheduled = 0;
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => { scheduled++; return scheduled; }, clearTimer: () => {}, noSyncTimer: true });
    // Only the lease loop scheduled; the sync timer did not.
    // (Lease schedules exactly one initial tick.)
    expect(scheduled).toBe(1);
  });

  it('the sync timer actually pulls committed state from the event log', async () => {
    const cluster = require('../src/cluster');
    const store = require('../src/store');
    cluster._reset();

    // Pre-seed the shared event log with a committed change from "another"
    // instance (so this instance should apply it on its next sync pull).
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const coord = new LocalCoordStore({ store });
    await coord.appendEvent({ key: 'fleetData', version: 1, doc: { rows: [{ equipmentId: '777' }], syncedAt: 'tX' }, instanceId: 'OTHER', token: 1 });

    // Capture the scheduled sync callback so we can fire it on demand.
    let syncFn = null;
    const setTimer = (fn, ms) => {
      // The sync tick is the one scheduled with syncMs (1234); the lease tick uses other delays.
      if (ms === 1234) syncFn = fn;
      return 1;
    };
    cluster.init({ enabled: true, mode: 'STANDBY', force: true, coord });
    cluster.start({ setTimer, clearTimer: () => {}, syncMs: 1234 });

    expect(typeof syncFn).toBe('function');
    await syncFn();                                   // fire one sync pull
    const applied = store.load('fleetData', null);
    expect(applied).toBeTruthy();
    expect(applied.rows[0].equipmentId).toBe('777');
  });

  it('stop() clears both the lease and sync timers (clean shutdown)', async () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    const cleared = [];
    cluster.init({ enabled: true, mode: 'STANDBY', force: true });
    cluster.start({ setTimer: () => Math.random(), clearTimer: (h) => cleared.push(h), syncMs: 1000 });
    await cluster.stop();
    // At least the sync timer handle was cleared; lease stop clears its own.
    expect(cleared.length).toBeGreaterThanOrEqual(1);
    expect(cluster.getSyncState()).toBeNull();
  });
});
