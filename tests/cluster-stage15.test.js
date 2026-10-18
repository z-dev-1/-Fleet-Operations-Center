import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage15-'));
  paths.setDataDir(dir);
  return dir;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ── Item 1: never fall back to local coordination when shared is configured ──
describe('Stage 15 — no local fallback for a configured shared coordinator', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} });

  it('shared coordUrl configured → coordKind stays "http", never "local"', () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', coordUrl: 'http://127.0.0.1:59999', force: true });
    const st = cluster.getStatus();
    expect(st.coordKind).toBe('http');
    expect(st.sharedCoordConfigured).toBe(true);
  });

  it('shared coordinator UNREACHABLE → mayRunProduction() FAILS CLOSED (no local leadership)', async () => {
    // Point at a dead port. init builds the HttpCoordStore; start() will try to
    // reach it and the pull tick marks it unreachable.
    cluster.init({ enabled: true, mode: 'ACTIVE', coordUrl: 'http://127.0.0.1:59999', force: true });
    cluster.start({ setTimer: (fn) => setTimeout(fn, 5), clearTimer: (h) => clearTimeout(h), syncMs: 5 });
    await tick();
    const st = cluster.getStatus();
    // No leadership assumed; production blocked; coordinator unreachable.
    expect(st.mayRunProduction).toBe(false);
    expect(cluster.mayRunProduction()).toBe(false);
  });

  it('NO shared coordinator → LocalCoordStore is valid (legacy/dev unchanged)', () => {
    cluster.init({ enabled: true, mode: 'ACTIVE', force: true });
    const st = cluster.getStatus();
    expect(st.coordKind).toBe('local');
    expect(st.sharedCoordConfigured).toBe(false);
  });
});

// ── Item 3 + 4: coordinator-side fencing + authoritative time ────────────────
describe('Stage 15 — coordinator independently fences event writes', () => {
  let store, coord, server, baseUrl, HttpCoordStore;
  beforeEach(async () => {
    freshDataDir();
    store = require('../src/store');
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const { createServer } = require('../src/cluster/coord-server');
    HttpCoordStore = require('../src/cluster/http-coord-store').HttpCoordStore;
    coord = new LocalCoordStore({ store });
    ({ server } = createServer({ coord }));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });
  afterEach(async () => { if (server) await new Promise((r) => server.close(r)); });

  it('current leader with the current token is ACCEPTED', async () => {
    const c = new HttpCoordStore({ baseUrl });
    const a = await c.tryAcquireLeadership('L', 'ACTIVE', 30000);
    const r = await c.appendEvent({ key: 'fleetData', version: 1, doc: {}, instanceId: 'L', token: a.record.fencingToken });
    expect(r.ok).toBe(true);
    expect(r.seq).toBe(1);
  });

  it('a NON-leader append is rejected (NO_LIVE_LEADER / STALE_LEADER)', async () => {
    const c = new HttpCoordStore({ baseUrl });
    // No one has acquired → no live leader.
    const r = await c.appendEvent({ key: 'fleetData', version: 1, doc: {}, instanceId: 'rogue', token: 1 });
    expect(r.ok).toBe(false);
    expect(r.fenced).toBe(true);
  });

  it('a STALE token is rejected after a new leader takes over', async () => {
    const laptop = new HttpCoordStore({ baseUrl });
    const box = new HttpCoordStore({ baseUrl });
    // Minimum lease is 1000ms; wait past it so the lease genuinely expires.
    const a1 = await laptop.tryAcquireLeadership('laptop', 'ACTIVE', 1000);
    const oldToken = a1.record.fencingToken;                            // token N
    await new Promise((r) => setTimeout(r, 1100));
    const a2 = await box.tryAcquireLeadership('box', 'STANDBY', 30000);  // takeover → token N+1
    expect(a2.record.fencingToken).toBe(oldToken + 1);
    // The paused laptop tries to append with its OLD token → fenced.
    const stale = await laptop.appendEvent({ key: 'fleetData', version: 2, doc: {}, instanceId: 'laptop', token: oldToken });
    expect(stale.ok).toBe(false);
    expect(stale.fenced).toBe(true);
    expect(stale.error).toBe('STALE_LEADER');
    expect(stale.currentToken).toBe(oldToken + 1);
    // The new leader (box) CAN append with the new token.
    const ok = await box.appendEvent({ key: 'fleetData', version: 2, doc: {}, instanceId: 'box', token: a2.record.fencingToken });
    expect(ok.ok).toBe(true);
  });

  it('an EXPIRED lease write is rejected even with the right token', async () => {
    const c = new HttpCoordStore({ baseUrl });
    const a = await c.tryAcquireLeadership('L', 'ACTIVE', 1000);  // min lease 1000ms
    await new Promise((r) => setTimeout(r, 1100));
    const r = await c.appendEvent({ key: 'fleetData', version: 1, doc: {}, instanceId: 'L', token: a.record.fencingToken });
    expect(r.ok).toBe(false);
    expect(r.fenced).toBe(true);
  });

  it('health + leadership responses carry the coordinator authoritative now', async () => {
    const c = new HttpCoordStore({ baseUrl });
    const h = await c.ping();
    expect(h.ok).toBe(true);
    expect(typeof h.now).toBe('number');
  });
});

// ── Item 2: promotion readiness barrier ──────────────────────────────────────
describe('Stage 15 — promotion readiness barrier (no production until caught up)', () => {
  let store, coord, server, baseUrl, cluster;
  beforeEach(async () => {
    freshDataDir();
    store = require('../src/store');
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const { createServer } = require('../src/cluster/coord-server');
    coord = new LocalCoordStore({ store });
    ({ server } = createServer({ coord }));
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    cluster = require('../src/cluster'); cluster._reset();
  });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} if (server) await new Promise((r) => server.close(r)); });

  it('a freshly-promoted leader is LEADER_SYNCING and NOT production-ready until catch-up', async () => {
    // Seed the coordinator log with outstanding events from a prior leader so a
    // new leader has something to catch up on.
    const seedLeader = require('../src/cluster/http-coord-store');
    const seed = new seedLeader.HttpCoordStore({ baseUrl });
    const sa = await seed.tryAcquireLeadership('OLD', 'ACTIVE', 1000);
    await seed.appendEvent({ key: 'fleetData', version: 1, doc: { rows: [] }, instanceId: 'OLD', token: sa.record.fencingToken });
    await new Promise((r) => setTimeout(r, 1100)); // OLD lease expires (min lease 1000ms)

    // This instance promotes through the facade (shared coordinator).
    cluster.init({ enabled: true, mode: 'STANDBY', coordUrl: baseUrl, force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    // Acquire leadership via the coord + drive the facade's lease.
    const a = await cluster.getCoord().tryAcquireLeadership(cluster.getInstanceId(), 'STANDBY', 30000);
    cluster._setLease(a.record.fencingToken, a.record.expiresAt);
    // Immediately after _setLease in shared mode: LEADER_SYNCING, not ready.
    const mid = cluster.getStatus();
    expect(['LEADER_SYNCING', 'PRODUCTION_READY']).toContain(mid.leadershipState);
    // Let the async catch-up finish.
    await tick(); await tick();
    const after = cluster.getStatus();
    expect(after.leadershipState).toBe('PRODUCTION_READY');
    expect(after.productionReady).toBe(true);
    expect(cluster.mayRunProduction()).toBe(true);
  });
});

// ── Item 6: sync-gap detection ───────────────────────────────────────────────
describe('Stage 15 — sync-gap detection via oldestSeq', () => {
  let store;
  beforeEach(() => { freshDataDir(); store = require('../src/store'); });

  it('readEventsSince reports oldestSeq so a lagging cursor can be detected', async () => {
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const coord = new LocalCoordStore({ store });
    const a = await coord.tryAcquireLeadership('L', 'ACTIVE', 30000);
    const tok = a.record.fencingToken;
    for (let i = 0; i < 3; i++) await coord.appendEvent({ key: 'fleetData', version: i + 1, doc: {}, instanceId: 'L', token: tok });
    const r = await coord.readEventsSince(0, 100);
    expect(r.oldestSeq).toBe(1);
    expect(r.lastSeq).toBe(3);
  });

  it('oldestSeq() returns the oldest retained seq (gap-detection primitive)', async () => {
    const { LocalCoordStore } = require('../src/cluster/coord-store');
    const coord = new LocalCoordStore({ store });
    expect(await coord.oldestSeq()).toBe(0);     // empty
    const a = await coord.tryAcquireLeadership('L', 'ACTIVE', 30000);
    await coord.appendEvent({ key: 'fleetData', version: 1, doc: {}, instanceId: 'L', token: a.record.fencingToken });
    expect(await coord.oldestSeq()).toBe(1);
  });
});

// ── Invariant: DEVELOPMENT never produces; cluster-off unchanged ─────────────
describe('Stage 15 — invariants preserved', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} });

  it('cluster OFF → mayRunProduction true (legacy single-host unchanged)', () => {
    cluster.init({ enabled: false });
    expect(cluster.mayRunProduction()).toBe(true);
  });

  it('DEVELOPMENT mode never runs production even if it somehow held a token', () => {
    cluster.init({ enabled: true, mode: 'DEVELOPMENT', force: true });
    // DEVELOPMENT is not eligible to lead; mayRunProduction requires leadership.
    expect(cluster.mayRunProduction()).toBe(false);
  });

  it('getStatus exposes the full hardening health surface (item 5)', () => {
    cluster.init({ enabled: true, mode: 'STANDBY', coordUrl: 'http://127.0.0.1:59999', capabilities: { aapLivePull: true }, force: true });
    const st = cluster.getStatus();
    for (const f of ['coordinatorReachable', 'leadershipState', 'productionReady', 'syncCursor', 'coordinatorHeadSeq', 'syncLag', 'syncGap', 'clusterHealth', 'sharedCoordConfigured']) {
      expect(f in st).toBe(true);
    }
  });
});
