import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage9-'));
  paths.setDataDir(dir);
  return dir;
}
const tick = () => new Promise((r) => setTimeout(r, 20));  // let fire-and-forget publish run

describe('cluster Stage 9 — auto-publish shared-key writes via store write hook', () => {
  let cluster, store;
  beforeEach(() => {
    freshDataDir();
    store = require('../src/store');
    cluster = require('../src/cluster');
    cluster._reset();
  });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} store.setWriteHook(null); });

  it('a LEADER auto-publishes when a shared-operational key is saved', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    expect(cluster.isLeader()).toBe(true);

    // A normal app write to a shared key — no cluster-aware call site.
    store.save('fleetData', { rows: [{ equipmentId: '42' }], syncedAt: 't' });
    await tick();

    const log = await coord.readEventsSince(0, 100);
    const ev = log.events.find(e => e.key === 'fleetData');
    expect(ev).toBeTruthy();
    expect(ev.doc.rows[0].equipmentId).toBe('42');
  });

  it('a NON-leader does NOT auto-publish', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    // Not leader (no lease held).
    expect(cluster.isLeader()).toBe(false);
    store.save('fleetData', { rows: [], syncedAt: 't' });
    await tick();
    const log = await cluster.getCoord().readEventsSince(0, 100);
    expect(log.events.length).toBe(0);
  });

  it('device-specific key writes are NEVER auto-published', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    store.save('orchaConfig', { modelId: 'x' });   // device-specific
    store.save('settings', { foo: 1 });            // device-specific
    await tick();
    const log = await coord.readEventsSince(0, 100);
    expect(log.events.length).toBe(0);
  });

  it('applying a pulled doc does NOT re-publish (no apply→publish loop)', async () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    // Seed an event from ANOTHER instance, then pull+apply it.
    await coord.appendEvent({ key: 'canonicalState', version: 1, doc: { units: { Z: {} } }, instanceId: 'OTHER', token: 9 });
    const before = (await coord.readEventsSince(0, 100)).events.length;
    await cluster.pullSharedState();               // applies OTHER's event → store.save fires hook
    await tick();
    const after = (await coord.readEventsSince(0, 100)).events.length;
    // No NEW event was published as a result of the apply (count unchanged).
    expect(after).toBe(before);
  });

  it('flag OFF: the write hook is never registered (legacy app untouched)', async () => {
    cluster.init({ enabled: false });
    cluster.start();                               // no-op when disabled
    store.save('fleetData', { rows: [], syncedAt: 't' });
    await tick();
    // No coordinator usage at all; getSyncState null.
    expect(cluster.getSyncState()).toBeNull();
  });
});

describe('cluster Stage 9 — app bootstrap wiring is inert when disabled', () => {
  beforeEach(() => { freshDataDir(); require('../src/cluster')._reset(); });

  it('init({mode:ACTIVE}) with no flag stays legacy leader, no timers', () => {
    const cluster = require('../src/cluster');
    const st = cluster.init({ mode: 'ACTIVE' });     // exactly what app.js 5k calls
    expect(st.enabled).toBe(false);
    expect(cluster.isLeader()).toBe(true);           // legacy single-host
    cluster.start();                                 // no-op
    expect(cluster.getLeaseState()).toBeNull();
  });
});
