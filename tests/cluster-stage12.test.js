import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);

const paths = require('../src/config/paths');
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-stage12-'));
  paths.setDataDir(dir);
  return dir;
}

// The keep-alive module's real work is spawning `mwinit --refresh-aea` and
// reading the cookie file. We stub those two seams (_readExpiry, _spawnRefresh)
// so the DECISION logic is tested deterministically with no real mwinit/box.

describe('Stage 12 — AEA keep-alive tick decision logic', () => {
  let ka;
  beforeEach(() => { freshDataDir(); ka = require('../src/cluster/aea-keepalive'); ka._reset(); });
  afterEach(() => { ka._reset(); });

  it('session EXPIRED → does NOT spawn refresh, surfaces session-expired (needs mwinit -o)', async () => {
    let spawned = 0;
    ka._setDeps({
      readExpiry: () => ({ sessionOk: false, sessionMin: -5, aeaMin: 0 }),
      spawnRefresh: async () => { spawned++; return { ok: true, aeaMin: 120 }; },
    });
    const r = await ka.tick();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('session-expired');
    expect(spawned).toBe(0);                          // AEA refresh can't help
  });

  it('AEA fresh (above floor) → no refresh spawned', async () => {
    let spawned = 0;
    ka._setDeps({
      readExpiry: () => ({ sessionOk: true, sessionMin: 900, aeaMin: 90 }),
      spawnRefresh: async () => { spawned++; return { ok: true, aeaMin: 120 }; },
    });
    const r = await ka.tick({ minAeaMin: 45 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('aea-fresh');
    expect(spawned).toBe(0);
  });

  it('AEA low (below floor), session alive → spawns refresh and reports new expiry', async () => {
    let spawned = 0;
    ka._setDeps({
      readExpiry: () => ({ sessionOk: true, sessionMin: 900, aeaMin: 20 }),
      spawnRefresh: async () => { spawned++; return { ok: true, aeaMin: 120, code: 0 }; },
    });
    const r = await ka.tick({ minAeaMin: 45 });
    expect(spawned).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('refreshed');
    expect(r.aeaMin).toBe(120);
  });

  it('force=true refreshes even when AEA is above the floor', async () => {
    let spawned = 0;
    ka._setDeps({
      readExpiry: () => ({ sessionOk: true, sessionMin: 900, aeaMin: 100 }),
      spawnRefresh: async () => { spawned++; return { ok: true, aeaMin: 120, code: 0 }; },
    });
    const r = await ka.tick({ minAeaMin: 45, force: true });
    expect(spawned).toBe(1);
    expect(r.ok).toBe(true);
  });

  it('refresh fails → reports failure but keeps the old AEA value', async () => {
    ka._setDeps({
      readExpiry: () => ({ sessionOk: true, sessionMin: 900, aeaMin: 10 }),
      spawnRefresh: async () => ({ ok: false, error: 'timeout', aeaMin: 10 }),
    });
    const r = await ka.tick({ minAeaMin: 45 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(r.aeaMin).toBe(10);
  });
});

describe('Stage 12 — opt-in gating', () => {
  let ka;
  beforeEach(() => { freshDataDir(); ka = require('../src/cluster/aea-keepalive'); ka._reset(); });
  afterEach(() => {
    ka._reset();
    delete process.env.FLEET_AEA_KEEPALIVE;
  });

  it('not opted in → start() is a no-op', () => {
    delete process.env.FLEET_AEA_KEEPALIVE;
    const r = ka.start({ setTimer: () => 0, clearTimer: () => {} });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('not-opted-in');
    expect(ka.getState().running).toBe(false);
  });

  it('env opt-in → start() runs (timers injected, immediate tick suppressed)', () => {
    process.env.FLEET_AEA_KEEPALIVE = '1';
    const r = ka.start({ setTimer: () => 42, clearTimer: () => {}, immediate: false });
    expect(r.ok).toBe(true);
    expect(ka.getState().running).toBe(true);
    expect(ka.getState().optedIn).toBe(true);
    ka.stop();
    expect(ka.getState().running).toBe(false);
  });

  it('env opt-out ("0") overrides → no-op', () => {
    process.env.FLEET_AEA_KEEPALIVE = '0';
    const r = ka.start({ setTimer: () => 0, clearTimer: () => {} });
    expect(r.ok).toBe(false);
  });
});

describe('Stage 12 — cluster facade wiring', () => {
  let cluster;
  beforeEach(() => { freshDataDir(); cluster = require('../src/cluster'); cluster._reset(); });
  afterEach(async () => { try { await cluster.stop(); } catch (_) {} delete process.env.FLEET_AEA_KEEPALIVE; });

  it('dashboard exposes aeaKeepalive state (null when not running)', async () => {
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: true }, force: true });
    const d = await cluster.getDashboard();
    expect('aeaKeepalive' in d).toBe(true);
    expect(d.aeaKeepalive).toBeNull();              // not started (start() not called / not opted in)
  });

  it('a non-live-pull host never starts keep-alive even if opted in', () => {
    process.env.FLEET_AEA_KEEPALIVE = '1';
    cluster.init({ enabled: true, mode: 'STANDBY', capabilities: { browser: false, aapLivePull: false }, force: true });
    cluster.start({ setTimer: () => 0, clearTimer: () => {}, noSyncTimer: true });
    // mayLivePull() is false → keep-alive gated off regardless of opt-in.
    expect(cluster.mayLivePull()).toBe(false);
  });
});
