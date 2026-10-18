import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage16-'));
  paths.setDataDir(dir);
  return dir;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('Stage 16 — fleet filter syncs so the standby mirrors desktop scope', () => {
  const { isShared } = require('../src/cluster/sync-engine');

  it('clusterFleetFilter is a SHARED key', () => {
    expect(isShared('clusterFleetFilter')).toBe(true);
  });

  it('clusterFleetFilter is a registered store key', () => {
    const store = require('../src/store');
    expect('clusterFleetFilter' in store.REGISTRY).toBe(true);
  });

  it('the raw settings blob is NEVER shared (device-specific, keeps passwords local)', () => {
    expect(isShared('settings')).toBe(false);
  });
});

describe('Stage 16 — leader seeds + publishes its domicile filter; standby applies it', () => {
  let cluster, store;
  beforeEach(() => { freshDataDir(); store = require('../src/store'); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} store.setWriteHook(null); });

  it('a LEADER with settings.domiciles publishes clusterFleetFilter to the event log', async () => {
    // Seed this host's desktop-style filter.
    store.save('settings', { domiciles: ['SAPB', 'TUZR', 'ABE40'] });
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership(cluster.getInstanceId(), 'ACTIVE', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    await tick();

    // start() seeded clusterFleetFilter from settings.domiciles; the write hook
    // auto-published it. Confirm the event carries the full desktop filter.
    const log = await coord.readEventsSince(0, 100);
    const ev = log.events.find((e) => e.key === 'clusterFleetFilter');
    expect(ev).toBeTruthy();
    expect(ev.doc.domiciles).toEqual(['SAPB', 'TUZR', 'ABE40']);
  });

  it('a STANDBY applies the synced filter so it holds the desktop scope', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    const coord = cluster.getCoord();
    // Leader (laptop) published its 17-domicile filter.
    await coord.appendEvent({
      key: 'clusterFleetFilter', version: 1,
      doc: { domiciles: ['SAPB', 'TUZR', 'AUVTE', 'AVP40', 'ABE40', 'EOFE'], from: 'LAPTOP' },
      instanceId: 'LAPTOP', token: 5,
    });
    await cluster.pullSharedState();
    const applied = store.load('clusterFleetFilter', null);
    expect(applied).toBeTruthy();
    expect(applied.domiciles).toContain('EOFE');
    expect(applied.domiciles.length).toBe(6);
  });
});
