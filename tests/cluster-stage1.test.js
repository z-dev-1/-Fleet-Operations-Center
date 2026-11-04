import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
const gate = require('../src/cluster/mode-gate');

// Isolate every test run in its own temp data dir so the LocalCoordStore's
// SQLite/JSON files never collide with the real app data or each other.
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage1-'));
  paths.setDataDir(dir);
  return dir;
}

describe('cluster Stage 1 — mode gate', () => {
  beforeEach(() => { gate._reset(); });

  it('is a no-op when disabled (legacy single-host): everything permitted', () => {
    gate.setEnabled(false);
    for (const k of ['slack-send', 'fleet-mutate', 'email-send', 'sp-push', 'browser', 'schedule-fire']) {
      expect(gate.canSideEffect(k).ok).toBe(true);
    }
    expect(gate.getMode()).toBe('ACTIVE');
  });

  it('ACTIVE permits side-effects when the host is capable', () => {
    gate.setEnabled(true); gate.setMode('ACTIVE'); gate.setCapabilities({ browser: true });
    expect(gate.canSideEffect('slack-send').ok).toBe(true);
    expect(gate.canSideEffect('browser').ok).toBe(true);
    expect(gate.canSideEffect('sp-push').ok).toBe(true);
  });

  it('STANDBY blocks ALL production side-effects', () => {
    gate.setEnabled(true); gate.setMode('STANDBY');
    for (const k of ['slack-send', 'fleet-mutate', 'email-send', 'sp-push', 'browser', 'schedule-fire']) {
      expect(gate.canSideEffect(k).ok).toBe(false);
    }
  });

  it('DEVELOPMENT blocks production writes + message sends at the service layer', () => {
    gate.setEnabled(true); gate.setMode('DEVELOPMENT');
    expect(gate.canSideEffect('slack-send').ok).toBe(false);
    expect(gate.canSideEffect('fleet-mutate').ok).toBe(false);
    expect(gate.canSideEffect('schedule-fire').ok).toBe(false);
  });

  it('fails browser-bound classes CLOSED on a headless host (capability gate)', () => {
    gate.setEnabled(true); gate.setMode('ACTIVE'); gate.setCapabilities({ browser: false });
    // Browser-bound classes denied even though mode is ACTIVE.
    expect(gate.canSideEffect('browser').ok).toBe(false);
    expect(gate.canSideEffect('fleet-mutate').ok).toBe(false);
    expect(gate.canSideEffect('sp-push').ok).toBe(false);
    expect(gate.canSideEffect('email-send').ok).toBe(false);
    // Non-browser classes still allowed.
    expect(gate.canSideEffect('slack-send').ok).toBe(true);
    expect(gate.canSideEffect('schedule-fire').ok).toBe(true);
  });

  it('assertCanSideEffect throws a typed error when blocked', () => {
    gate.setEnabled(true); gate.setMode('STANDBY');
    expect(() => gate.assertCanSideEffect('slack-send')).toThrowError(/blocked side-effect/);
    try { gate.assertCanSideEffect('slack-send'); } catch (e) {
      expect(e.code).toBe('CLUSTER_SIDE_EFFECT_BLOCKED');
      expect(e.kind).toBe('slack-send');
    }
  });
});

describe('cluster Stage 1 — facade (flag OFF = unchanged legacy behavior)', () => {
  beforeEach(() => { freshDataDir(); const c = require('../src/cluster'); c._reset(); });

  it('disabled init: ACTIVE, isLeader true, all side-effects permitted', () => {
    const cluster = require('../src/cluster');
    const st = cluster.init({ enabled: false });
    expect(st.enabled).toBe(false);
    expect(st.role).toBe('ACTIVE');
    expect(cluster.isLeader()).toBe(true);
    expect(cluster.canSideEffect('slack-send').ok).toBe(true);
    expect(st.instanceId).toBeTruthy();
  });

  it('enabled+ACTIVE but no lease yet: NOT leader (fails writes closed until leased)', () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    expect(cluster.isLeader()).toBe(false); // no fencing token held yet
    cluster._setLease(1, Date.now() + 30000);
    expect(cluster.isLeader()).toBe(true);
  });
});

describe('cluster Stage 1 — coordination store (CAS lease + fencing + events)', () => {
  let coord;
  beforeEach(() => {
    freshDataDir();
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const store = require('../src/store');
    coord = new LocalCoordStore({ store });
  });

  it('first acquire wins; a second instance is refused while the lease holds', async () => {
    const a = await coord.tryAcquireLeadership('A', 'ACTIVE', 30000);
    expect(a.ok).toBe(true);
    expect(a.record.leader).toBe('A');
    expect(a.record.fencingToken).toBe(1);

    const b = await coord.tryAcquireLeadership('B', 'ACTIVE', 30000);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('held-by-other');
  });

  it('the holder can renew and heartbeat; a non-holder cannot', async () => {
    const a = await coord.tryAcquireLeadership('A', 'ACTIVE', 30000);
    const token = a.record.fencingToken;
    const r = await coord.renewLeadership('A', token, 30000);
    expect(r.ok).toBe(true);
    const hb = await coord.heartbeat('A', token);
    expect(hb.ok).toBe(true);
    const bad = await coord.renewLeadership('B', token, 30000);
    expect(bad.ok).toBe(false);
  });

  it('takeover requires lease EXPIRY (not heartbeat-miss) and bumps the fencing token', async () => {
    // A acquires a very short lease.
    const a = await coord.tryAcquireLeadership('A', 'ACTIVE', 1000);
    expect(a.record.fencingToken).toBe(1);
    // Force expiry by rewriting the record's expiresAt into the past.
    const store = require('../src/store');
    await store.updateAsync('clusterLeadership', (cur) => ({ ...cur, expiresAt: Date.now() - 1 }), null);
    // Now B can take over, and the token strictly increments (fencing).
    const b = await coord.tryAcquireLeadership('B', 'ACTIVE', 30000);
    expect(b.ok).toBe(true);
    expect(b.record.leader).toBe('B');
    expect(b.record.fencingToken).toBe(2);
    // A's old token is now stale — it can no longer renew.
    const stale = await coord.renewLeadership('A', 1, 30000);
    expect(stale.ok).toBe(false);
  });

  it('release expires the lease but preserves the monotonic token', async () => {
    const a = await coord.tryAcquireLeadership('A', 'ACTIVE', 30000);
    const rel = await coord.releaseLeadership('A', a.record.fencingToken);
    expect(rel.ok).toBe(true);
    // Next acquire increments the token (never reused).
    const b = await coord.tryAcquireLeadership('B', 'ACTIVE', 30000);
    expect(b.ok).toBe(true);
    expect(b.record.fencingToken).toBe(2);
  });

  it('event log appends with monotonic seq and reads incrementally', async () => {
    await coord.appendEvent({ key: 'fleetData', version: 1, instanceId: 'A', token: 1 });
    await coord.appendEvent({ key: 'canonicalState', version: 1, instanceId: 'A', token: 1 });
    const all = await coord.readEventsSince(0, 100);
    expect(all.events.length).toBe(2);
    expect(all.events[0].seq).toBe(1);
    expect(all.events[1].seq).toBe(2);
    const since1 = await coord.readEventsSince(1, 100);
    expect(since1.events.length).toBe(1);
    expect(since1.events[0].key).toBe('canonicalState');
  });
});
