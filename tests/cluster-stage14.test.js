import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage14-'));
  paths.setDataDir(dir);
  return dir;
}

describe('Stage 14 — standby-daemon opt-in gating', () => {
  let daemon;
  beforeEach(() => { freshDataDir(); daemon = require('../src/cluster/standby-daemon'); daemon._reset(); });
  afterEach(() => { daemon._reset(); delete process.env.FLEET_STANDBY_DAEMON; });

  it('not opted in → start() is a no-op', () => {
    delete process.env.FLEET_STANDBY_DAEMON;
    const r = daemon.start({ setTimer: () => 0, clearTimer: () => {}, immediate: false });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('not-opted-in');
    expect(daemon.getState().running).toBe(false);
  });

  it('env opt-in → start() runs and schedules timers', () => {
    process.env.FLEET_STANDBY_DAEMON = '1';
    let scheduled = 0;
    const r = daemon.start({ setTimer: () => { scheduled++; return scheduled; }, clearTimer: () => {}, immediate: false });
    expect(r.ok).toBe(true);
    expect(daemon.getState().running).toBe(true);
    expect(scheduled).toBe(3);          // slack DM, slack channel, fleet
    daemon.stop();
    expect(daemon.getState().running).toBe(false);
  });

  it('env opt-out ("0") overrides settings → no-op', () => {
    process.env.FLEET_STANDBY_DAEMON = '0';
    const r = daemon.start({ setTimer: () => 0, clearTimer: () => {} });
    expect(r.ok).toBe(false);
  });
});

describe('Stage 14 — production loops are leader-gated (the core safety)', () => {
  let daemon, cluster;
  beforeEach(() => { freshDataDir(); daemon = require('../src/cluster/standby-daemon'); daemon._reset(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { daemon._reset(); try { await cluster.stop(); } catch (_) {} });

  it('a non-leader STANDBY: _mayProduce() is false → Slack loops would do nothing', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    expect(cluster.isLeader()).toBe(false);
    expect(daemon._mayProduce()).toBe(false);   // Slack poll/send gate CLOSED
    expect(daemon._mayLivePull()).toBe(true);   // but it MAY refresh its own reads
  });

  it('a leader: _mayProduce() is true → Slack loops run', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    expect(cluster.isLeader()).toBe(true);
    expect(daemon._mayProduce()).toBe(true);
  });

  it('cluster OFF (legacy single-host): both gates open (unchanged behavior)', () => {
    cluster.init({ enabled: false });
    expect(daemon._mayProduce()).toBe(true);
    expect(daemon._mayLivePull()).toBe(true);
  });

  it('non-capable STANDBY: live-pull gate closed → fleet loop would skip', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    expect(daemon._mayProduce()).toBe(false);
    expect(daemon._mayLivePull()).toBe(false);
  });
});

describe('Stage 14 — tick bodies respect the gate (no work when not leader)', () => {
  let daemon, cluster, store;
  beforeEach(() => { freshDataDir(); store = require('../src/store'); daemon = require('../src/cluster/standby-daemon'); daemon._reset(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { daemon._reset(); try { await cluster.stop(); } catch (_) {} });

  it('_tickSlackDm on a non-leader standby returns without touching Slack (no lastTick recorded)', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    // Not leader → _mayProduce false → the tick must bail BEFORE requiring slack engine.
    await daemon._tickSlackDm();
    expect(daemon.getState().lastTick.slackDm).toBeNull();   // never ran
  });

  it('_tickFleet on a non-capable standby returns without pulling (no lastTick)', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    await daemon._tickFleet();
    expect(daemon.getState().lastTick.fleet).toBeNull();     // live-pull gate closed → skipped
  });
});
