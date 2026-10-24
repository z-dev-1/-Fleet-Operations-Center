import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');

// Each test gets its own coordinator data dir + a live HTTP server on an
// ephemeral port, with two HttpCoordStore clients talking to it over real TCP —
// the genuine cross-process shape (stands in for laptop + DevSpace).
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage8-'));
  paths.setDataDir(dir);
  return dir;
}

describe('cluster Stage 8 — shared HTTP coordinator (real cross-process failover)', () => {
  let server, baseUrl, HttpCoordStore;
  beforeEach(async () => {
    freshDataDir();
    const store = require('../src/store');
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const { createServer } = require('../src/cluster/coord-server');
    HttpCoordStore = require('../src/cluster/http-coord-store').HttpCoordStore;
    // Back the server with an explicit LocalCoordStore on this test's data dir.
    const backing = new LocalCoordStore({ store });
    ({ server } = createServer({ coord: backing, token: 'test-token' }));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });
  afterEach(async () => { if (server) await new Promise((r) => server.close(r)); });

  function client(id) { return new HttpCoordStore({ baseUrl, token: 'test-token' }); }

  it('health check responds over HTTP', async () => {
    const c = new HttpCoordStore({ baseUrl, token: 'test-token' });
    const h = await c.ping();
    expect(h.ok).toBe(true);
  });

  it('rejects requests without the shared token', async () => {
    const bad = new HttpCoordStore({ baseUrl, token: 'wrong' });
    const r = await bad.tryAcquireLeadership('A', 'ACTIVE', 30000);
    expect(r.ok).toBe(false);  // 401 → fail closed
  });

  it('first client acquires over HTTP; a second is refused while the lease holds', async () => {
    const A = client('A'), B = client('B');
    const a = await A.tryAcquireLeadership('A', 'ACTIVE', 30000);
    expect(a.ok).toBe(true);
    expect(a.record.leader).toBe('A');
    expect(a.record.fencingToken).toBe(1);
    const b = await B.tryAcquireLeadership('B', 'ACTIVE', 30000);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('held-by-other');
  });

  it('both clients see the SAME shared leadership record (cross-process truth)', async () => {
    const A = client('A'), B = client('B');
    await A.tryAcquireLeadership('A', 'ACTIVE', 30000);
    const seenByB = await B.getLeadership();
    expect(seenByB.leader).toBe('A');       // B sees A's lease — one shared record
    expect(seenByB.fencingToken).toBe(1);
  });

  it('renew + heartbeat work over HTTP; a non-holder cannot renew', async () => {
    const A = client('A'), B = client('B');
    const a = await A.tryAcquireLeadership('A', 'ACTIVE', 30000);
    const r = await A.renewLeadership('A', a.record.fencingToken, 30000);
    expect(r.ok).toBe(true);
    const hb = await A.heartbeat('A', a.record.fencingToken);
    expect(hb.ok).toBe(true);
    const bad = await B.renewLeadership('B', a.record.fencingToken, 30000);
    expect(bad.ok).toBe(false);
  });

  it('release lets the next client take over with a bumped fencing token', async () => {
    const A = client('A'), B = client('B');
    const a = await A.tryAcquireLeadership('A', 'ACTIVE', 30000);
    await A.releaseLeadership('A', a.record.fencingToken);
    const b = await B.tryAcquireLeadership('B', 'ACTIVE', 30000);
    expect(b.ok).toBe(true);
    expect(b.record.leader).toBe('B');
    expect(b.record.fencingToken).toBe(2);  // monotonic across the shared store
  });

  it('event log is shared: one client publishes, the other reads it incrementally', async () => {
    const A = client('A'), B = client('B');
    // A must be the valid leader before it can append — the coordinator now
    // fences event writes to the current fencing-token holder (hardening item 3).
    const acq = await A.tryAcquireLeadership('A', 'ACTIVE', 30000);
    const tok = acq.record.fencingToken;
    await A.appendEvent({ key: 'fleetData', version: 1, doc: { rows: [{ equipmentId: '999' }] }, instanceId: 'A', token: tok });
    await A.appendEvent({ key: 'canonicalState', version: 1, doc: { units: {} }, instanceId: 'A', token: tok });
    const got = await B.readEventsSince(0, 100);
    expect(got.events.length).toBe(2);
    expect(got.events[0].doc.rows[0].equipmentId).toBe('999');
    const since1 = await B.readEventsSince(1, 100);
    expect(since1.events.length).toBe(1);
    expect(since1.events[0].key).toBe('canonicalState');
  });

  it('FAIL CLOSED: a client pointed at a dead coordinator cannot acquire', async () => {
    const dead = new HttpCoordStore({ baseUrl: 'http://127.0.0.1:1', token: 'test-token', timeoutMs: 800 });
    const r = await dead.tryAcquireLeadership('X', 'ACTIVE', 30000);
    expect(r.ok).toBe(false);               // unreachable → never believes it leads
    expect(r.reason).toBe('coordinator-unreachable');
  });
});

describe('cluster Stage 8 — facade selects the HTTP backend when a coordUrl is set', () => {
  let server, baseUrl;
  beforeEach(async () => {
    freshDataDir();
    const store = require('../src/store');
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const { createServer } = require('../src/cluster/coord-server');
    ({ server } = createServer({ coord: new LocalCoordStore({ store }) }));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    require('../src/cluster')._reset();
  });
  afterEach(async () => { if (server) await new Promise((r) => server.close(r)); });

  it('init({coordUrl}) uses the HTTP coordinator (coordKind=http) and can reach it', async () => {
    const cluster = require('../src/cluster');
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true, coordUrl: baseUrl });
    const st = cluster.getStatus();
    expect(st.coordKind).toBe('http');
    const coord = cluster.getCoord();
    const a = await coord.tryAcquireLeadership('facade', 'ACTIVE', 30000);
    expect(a.ok).toBe(true);
    cluster._reset();
  });

  it('with no coordUrl, falls back to the local coordinator (coordKind=local)', () => {
    const cluster = require('../src/cluster');
    cluster._reset();
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    expect(cluster.getStatus().coordKind).toBe('local');
    cluster._reset();
  });
});
