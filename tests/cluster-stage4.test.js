import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage4-'));
  paths.setDataDir(dir);
  return dir;
}

// A per-instance in-memory store (models each machine's OWN local store). The
// coord-store's event log is the SHARED coordinator, passed in separately — so
// this accurately mirrors production: separate local state per host, one shared
// event log between them.
function memStore() {
  const m = new Map();
  return {
    load: (k, d) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : (d !== undefined ? d : null)),
    save: (k, v) => { m.set(k, v === null ? null : JSON.parse(JSON.stringify(v))); },
    update: (k, fn, def) => { const cur = m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : (def || {}); const next = fn(cur); m.set(k, next); return next; },
    exists: (k) => m.has(k),
    _dump: () => m,
  };
}

describe('cluster Stage 4 — event-log sync engine', () => {
  let coordStore, coord, SyncEngine, SHARED_KEYS, DEVICE_KEYS;
  let storeA, storeB;
  beforeEach(() => {
    freshDataDir();
    coordStore = require('../src/store');          // the SHARED coordinator (event log)
    const cs = require('../src/cluster/coord-store');
    const se = require('../src/cluster/sync-engine');
    SyncEngine = se.SyncEngine; SHARED_KEYS = se.SHARED_KEYS; DEVICE_KEYS = se.DEVICE_KEYS;
    coord = new cs.LocalCoordStore({ store: coordStore });
    storeA = memStore();   // instance A's own local store
    storeB = memStore();   // instance B's own local store
  });

  // leader A = produces + consumes (own store A); standby B = consumes (store B).
  function engineA(isLeader = true) { return new SyncEngine({ coord, store: storeA, instanceId: 'A', isLeader: () => isLeader, getToken: () => 7 }); }
  function engineB(isLeader = false) { return new SyncEngine({ coord, store: storeB, instanceId: 'B', isLeader: () => isLeader, getToken: () => 7 }); }

  it('leader publishes a shared key; a standby pulls and applies it locally', async () => {
    const leader = engineA();
    const standby = engineB();
    storeA.save('fleetData', { rows: [{ equipmentId: '59080' }], syncedAt: 't1' });
    const pub = await leader.publish('fleetData');
    expect(pub.ok).toBe(true);
    expect(pub.version).toBe(1);

    const got = await standby.pull();
    expect(got.applied).toBe(1);
    expect(storeB.load('fleetData', null).rows[0].equipmentId).toBe('59080');
  });

  it('a standby/non-leader does NOT publish (no echo loop)', async () => {
    const standby = engineB();
    storeB.save('canonicalState', { units: {} });
    const r = await standby.publish('canonicalState');
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('not-leader');
  });

  it('device-specific keys NEVER sync (not shared)', async () => {
    const leader = engineA();
    for (const k of ['credentialsStore', 'orchaConfig', 'clusterLeadership', 'bubbleConfig']) {
      storeA.save(k, { secret: true });
      const r = await leader.publish(k);
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe('not-shared');
    }
    const { events } = await coord.readEventsSince(0, 100);
    expect(events.length).toBe(0);
  });

  it('last-writer-wins by version: a newer publish overrides, a stale one is ignored', async () => {
    const leader = engineA();
    const standby = engineB();
    storeA.save('canonicalState', { units: { X: { status: 'down' } } });
    await leader.publish('canonicalState');              // v1
    storeA.save('canonicalState', { units: { X: { status: 'available' } } });
    await leader.publish('canonicalState');              // v2

    await standby.pull();
    expect(storeB.load('canonicalState', null).units.X.status).toBe('available');

    // Replay OLD events (rewind cursor): must NOT clobber the newer applied v2.
    standby.lastSyncSeq = 0;
    await standby.pull();
    expect(storeB.load('canonicalState', null).units.X.status).toBe('available');
  });

  it('an instance skips its OWN events (already has that state)', async () => {
    const leader = engineA();
    storeA.save('fasCases', { c1: {} });
    await leader.publish('fasCases');
    const r = await leader.pull();                       // leader pulls its own event
    expect(r.applied).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it('RECONNECT CATCH-UP: an offline instance pulls everything it missed on return', async () => {
    const leader = engineA();
    const standby = engineB();
    storeA.save('fleetData', { rows: [], syncedAt: 't1' });  await leader.publish('fleetData');
    storeA.save('wrQueue', { items: [1] });                  await leader.publish('wrQueue');
    storeA.save('reminders', [{ unit: '100' }]);             await leader.publish('reminders');

    const r = await standby.pull();                      // one pull catches up all 3
    expect(r.applied).toBe(3);
    expect(storeB.load('fleetData', null).syncedAt).toBe('t1');
    expect(storeB.load('wrQueue', null).items[0]).toBe(1);
    expect(storeB.load('reminders', null)[0].unit).toBe('100');
  });

  it('the shared allowlist and device denylist do not overlap', () => {
    const shared = new Set(SHARED_KEYS);
    for (const d of DEVICE_KEYS) expect(shared.has(d)).toBe(false);
  });
});

describe('cluster Stage 4 — facade sync wiring (flag OFF = no-op)', () => {
  beforeEach(() => { freshDataDir(); require('../src/cluster')._reset(); });

  it('disabled: publishSharedKey / pullSharedState are no-ops', async () => {
    const cluster = require('../src/cluster');
    cluster.init({ enabled: false });
    const p = await cluster.publishSharedKey('fleetData');
    expect(p.ok).toBe(false);
    const q = await cluster.pullSharedState();
    expect(q.ok).toBe(false);
    expect(cluster.getSyncState()).toBeNull();
  });

  it('isSharedKey classifies correctly', () => {
    const cluster = require('../src/cluster');
    expect(cluster.isSharedKey('fleetData')).toBe(true);
    expect(cluster.isSharedKey('canonicalState')).toBe(true);
    expect(cluster.isSharedKey('credentialsStore')).toBe(false);
    expect(cluster.isSharedKey('orchaConfig')).toBe(false);
  });
});
