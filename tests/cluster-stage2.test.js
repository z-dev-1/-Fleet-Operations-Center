import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

// Shared, isolated data dir so two LeaseManagers contend on the SAME
// coordination record (the real failover scenario, on one machine).
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage2-'));
  paths.setDataDir(dir);
  return dir;
}

// A controllable clock so "time passes" and "lease expires" are deterministic.
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// A no-op scheduler: the LeaseManager won't self-fire; tests drive _tickOnce().
const noopTimers = { setTimer: () => 0, clearTimer: () => {} };

describe('cluster Stage 2 — lease manager (deterministic failover harness)', () => {
  let coord, clock, LeaseManager;
  beforeEach(() => {
    freshDataDir();
    const store = require('../src/store');
    const cs = require('../src/cluster/coord-store');
    LeaseManager = require('../src/cluster/lease-manager').LeaseManager;
    clock = makeClock();
    // Share the SAME clock with the coord-store so lease expiry is deterministic.
    coord = new cs.LocalCoordStore({ store, now: clock.now });
  });

  function mgr(id, mode = 'ACTIVE') {
    return new LeaseManager({
      coord, instanceId: id, mode,
      leaseMs: 30000, heartbeatMs: 10000, pollMs: 5000,
      now: clock.now, ...noopTimers,
    });
  }

  it('leader acquires on first tick and renews on subsequent ticks (token stable)', async () => {
    const A = mgr('A');
    await A._tickOnce();                   // follower → acquires
    expect(A.isLeader()).toBe(true);
    expect(A.fencingToken).toBe(1);
    const exp1 = A.leaseExpiresAt;
    clock.advance(10000);
    await A._tickOnce();                   // leader → renews
    expect(A.isLeader()).toBe(true);
    expect(A.fencingToken).toBe(1);        // SAME token — not a takeover
    expect(A.leaseExpiresAt).toBeGreaterThan(exp1);
  });

  it('a second instance stays STANDBY while the leader lease is live', async () => {
    const A = mgr('A'); const B = mgr('B');
    await A._tickOnce();                   // A leads (token 1)
    await B._tickOnce();                   // B sees live lease → stays follower
    expect(A.isLeader()).toBe(true);
    expect(B.isLeader()).toBe(false);
    expect(B.role).toBe('follower');
  });

  it('FAILOVER: when the leader dies and the lease EXPIRES, the standby takes over with a bumped token', async () => {
    const A = mgr('A'); const B = mgr('B');
    await A._tickOnce();                   // A leads, token 1, lease +30s
    await B._tickOnce();                   // B standby
    expect(A.fencingToken).toBe(1);

    // A "dies" — it simply stops ticking/renewing. Time advances past the TTL.
    clock.advance(31000);                  // now > A's leaseExpiresAt

    // B polls: sees the lease expired → CAS acquire → promoted with token 2.
    await B._tickOnce();
    expect(B.isLeader()).toBe(true);
    expect(B.fencingToken).toBe(2);        // fencing token strictly increments

    // A comes back and ticks as (stale) leader: its renew is fenced out → demote.
    await A._tickOnce();
    expect(A.isLeader()).toBe(false);
    expect(A.role).toBe('follower');
  });

  it('does NOT take over on a missed heartbeat alone (only on genuine expiry)', async () => {
    const A = mgr('A'); const B = mgr('B');
    await A._tickOnce();                   // A leads, lease +30s
    await B._tickOnce();                   // B standby

    // Time advances but STILL within the lease TTL (a missed heartbeat window,
    // not an expiry). B must NOT take over.
    clock.advance(15000);                  // < 30s TTL
    await B._tickOnce();
    expect(B.isLeader()).toBe(false);
    expect(A.fencingToken).toBe(1);
  });

  it('STANDBY-mode instance NEVER acquires leadership, even when no leader exists', async () => {
    const S = mgr('S', 'STANDBY');
    await S._tickOnce();                   // no leader present, but S is standby-only
    expect(S.isLeader()).toBe(false);
    const cur = await coord.getLeadership();
    expect(cur).toBeNull();               // nothing acquired
  });

  it('two eligible followers racing for an empty lease: exactly one wins (CAS)', async () => {
    const A = mgr('A'); const B = mgr('B');
    // Both see no leader and attempt acquire "simultaneously" (sequential CAS).
    await A._tickOnce();
    await B._tickOnce();
    const leaders = [A, B].filter(m => m.isLeader());
    expect(leaders.length).toBe(1);       // never two leaders
  });

  it('clean stop() releases the lease so a standby takes over immediately (no TTL wait)', async () => {
    const A = mgr('A'); const B = mgr('B');
    await A._tickOnce();                   // A leads
    await A.stop();                        // graceful handoff — releases lease
    expect(A.isLeader()).toBe(false);
    // B takes over WITHOUT advancing the clock past TTL (lease was released).
    await B._tickOnce();
    expect(B.isLeader()).toBe(true);
    expect(B.fencingToken).toBe(2);
  });
});

describe('cluster Stage 2 — facade start/stop (flag OFF = no timers, unchanged)', () => {
  beforeEach(() => { freshDataDir(); require('../src/cluster')._reset(); });

  it('disabled: start() runs nothing, stays legacy leader', () => {
    const cluster = require('../src/cluster');
    cluster.init({ enabled: false });
    cluster.start();
    expect(cluster.getLeaseState()).toBeNull();   // no lease manager created
    expect(cluster.isLeader()).toBe(true);         // legacy
  });

  it('enabled: start() creates a lease manager; isLeader reflects it', async () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    const clock = makeClock();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ now: clock.now, setTimer: () => 0, clearTimer: () => {} });
    const st = cluster.getLeaseState();
    expect(st).not.toBeNull();
    // Not leader until the first tick acquires.
    expect(cluster.isLeader()).toBe(false);
    await cluster.getLeaseState && null; // (state object; tick is driven internally in prod)
    await cluster.stop();
  });
});
