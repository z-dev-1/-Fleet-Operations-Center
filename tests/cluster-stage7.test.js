import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage7-'));
  paths.setDataDir(dir);
  return dir;
}
function makeClock(start = 2_000_000) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

describe('cluster Stage 7 — Instance Management dashboard', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });

  it('getDashboard(): disabled instance reports enabled:false but never throws', async () => {
    cluster.init({ enabled: false });
    const d = await cluster.getDashboard();
    expect(d.enabled).toBe(false);
    expect(d.self).toBeTruthy();
    expect(d.self.instanceId).toBeTruthy();
  });

  it('getDashboard(): enabled instance reports self + (once leased) leader + sync + history', async () => {
    cluster._reset();
    const clock = makeClock();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true, now: clock.now });
    cluster.start({ now: clock.now, setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    // Simulate the lease loop promoting us.
    cluster._setLease(1, clock.now() + 30000);
    const d = await cluster.getDashboard();
    expect(d.enabled).toBe(true);
    expect(d.self.isLeader).toBe(true);
    expect(typeof d.autoFailover).toBe('boolean');
    expect(Array.isArray(d.failoverHistory)).toBe(true);
    expect(d.sync).toBeTruthy();
    await cluster.stop();
  });
});

describe('cluster Stage 7 — controls (backend-enforced, no UI bypass)', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });

  it('handoffLeadership(): refuses when we are NOT the leader (no force-steal)', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    // No lease held → not leader → handoff must refuse.
    expect(cluster.isLeader()).toBe(false);
    const r = await cluster.handoffLeadership();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not the current leader/);
    await cluster.stop();
  });

  it('handoffLeadership(): the leader can release its lease', async () => {
    const clock = makeClock();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true, now: clock.now });
    const coord = cluster.getCoord();
    // Make us the leader via the real coord-store, then mirror onto the facade.
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster.start({ now: clock.now, setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    expect(cluster.isLeader()).toBe(true);
    const r = await cluster.handoffLeadership();
    expect(r.ok).toBe(true);
    // Lease is now released (expired) in the shared record.
    const lead = await coord.getLeadership();
    expect(lead.expiresAt).toBeLessThanOrEqual(clock.now());
    await cluster.stop();
  });

  it('setAutoFailover(false): a follower will NOT take over even when the lease expires', async () => {
    const clock = makeClock();
    const { LeaseManager } = require('../src/cluster/lease-manager');
    const store = require('../src/store');
    const cs = require('../src/cluster/coord-store');
    const coord = new cs.LocalCoordStore({ store, now: clock.now });
    // A leader exists then dies.
    await coord.tryAcquireLeadership('OLD', 'ACTIVE', 10000);
    const B = new LeaseManager({ coord, instanceId: 'B', mode: 'STANDBY', leaseMs: 30000, now: clock.now, setTimer: () => 0, clearTimer: () => {} });
    B.setAutoFailover(false);                    // operator disabled failover
    clock.advance(20000);                        // OLD's lease expired
    await B._tickOnce();
    expect(B.isLeader()).toBe(false);            // did NOT take over (manual control)
    // Re-enable and it takes over on the next tick.
    B.setAutoFailover(true);
    await B._tickOnce();
    expect(B.isLeader()).toBe(true);
  });

  it('setModeRuntime(): switches mode; DEVELOPMENT abdicates leadership', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    expect(cluster.isLeader()).toBe(true);
    const r = cluster.setModeRuntime('DEVELOPMENT');
    expect(r.ok).toBe(true);
    expect(cluster.getRole()).toBe('DEVELOPMENT');
    await cluster.stop();
  });

  it('setModeRuntime(): rejects an invalid mode', () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    const r = cluster.setModeRuntime('BOGUS');
    expect(r.ok).toBe(false);
  });

  it('requestReconcile(): applies missed events (force full pull)', async () => {
    const clock = makeClock();
    cluster.init({ enabled: true, mode: 'STANDBY', force: true, now: clock.now });
    const coord = cluster.getCoord();
    // Seed a committed change from another instance.
    await coord.appendEvent({ key: 'fleetData', version: 1, doc: { rows: [{ equipmentId: '888' }] }, instanceId: 'OTHER', token: 1 });
    cluster.start({ now: clock.now, setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const r = await cluster.requestReconcile();
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(1);
    await cluster.stop();
  });

  it('failover history records promote/demote transitions', async () => {
    const clock = makeClock();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true, now: clock.now });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster.start({ now: clock.now, setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    await cluster.handoffLeadership();           // triggers a 'demoted' history entry
    const d = await cluster.getDashboard();
    expect(d.failoverHistory.length).toBeGreaterThanOrEqual(1);
    expect(d.failoverHistory[0].type).toBe('demoted');
    await cluster.stop();
  });
});
