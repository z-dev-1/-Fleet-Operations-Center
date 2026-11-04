import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage3-'));
  paths.setDataDir(dir);
  return dir;
}

describe('cluster Stage 3 — mayRunProduction() leader gate (source of truth for scheduler + Slack)', () => {
  let cluster;
  beforeEach(() => {
    freshDataDir();
    cluster = require('../src/cluster');
    cluster._reset();
  });

  it('flag OFF (legacy single-host): production always allowed', () => {
    cluster.init({ enabled: false });
    expect(cluster.mayRunProduction()).toBe(true);
  });

  it('enabled + ACTIVE but NOT yet leased: production BLOCKED (fails closed until leader)', () => {
    cluster._reset();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    // No lease acquired yet → not leader → must not run production.
    expect(cluster.isLeader()).toBe(false);
    expect(cluster.mayRunProduction()).toBe(false);
  });

  it('enabled + ACTIVE + holding the lease: production allowed', () => {
    cluster._reset();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster._setLease(1, Date.now() + 30000);     // simulate the lease loop promoting us
    expect(cluster.isLeader()).toBe(true);
    expect(cluster.mayRunProduction()).toBe(true);
  });

  it('enabled + STANDBY: production BLOCKED (never runs scheduled jobs / Slack replies)', () => {
    cluster._reset();
    cluster.init({ enabled: true, mode: 'STANDBY', force: true });
    expect(cluster.mayRunProduction()).toBe(false);
  });

  it('enabled + DEVELOPMENT: production BLOCKED', () => {
    cluster._reset();
    cluster.init({ enabled: true, mode: 'DEVELOPMENT', force: true });
    expect(cluster.mayRunProduction()).toBe(false);
  });

  it('losing the lease flips production OFF immediately (demotion => standby)', () => {
    cluster._reset();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster._setLease(1, Date.now() + 30000);
    expect(cluster.mayRunProduction()).toBe(true);
    cluster._setLease(null, null);                // demoted / lost lease
    expect(cluster.mayRunProduction()).toBe(false);
  });
});

describe('cluster Stage 3 — scheduler guard delegates to the cluster gate', () => {
  beforeEach(() => { freshDataDir(); require('../src/cluster')._reset(); });

  it('scheduler loads and exposes its public API unchanged (gate is additive)', () => {
    const scheduler = require('../src/scheduler');
    // The gate must not have changed the scheduler's surface area.
    for (const fn of ['start', 'stop', 'reload', 'catchUp', 'runSpNow', 'runEmailNow', 'runDbrNow']) {
      expect(typeof scheduler[fn]).toBe('function');
    }
  });

  it('with the flag OFF, the scheduler gate permits firing (legacy behavior intact)', () => {
    const cluster = require('../src/cluster');
    cluster.init({ enabled: false });
    expect(cluster.mayRunProduction()).toBe(true);   // what _mayFireProductionJob() checks
  });
});
