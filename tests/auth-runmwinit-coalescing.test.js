// tests/auth-runmwinit-coalescing.test.js — Phase 9 FR-8 / AC-5: runMwinit's
// existing _mwinitInFlight coalescing is unchanged under every flag combination.
//
// REQUIRED FIX 2: the lock release is proven through the SUCCESS path only
// (touch the cookie fixture's mtime so the poll sees a rewritten, valid file).
// The reject-path release (the `.finally` in runMwinit) is verified by code
// inspection only: its derived promise is unhandled on reject in the existing
// code, which must stay byte-for-byte unchanged (FR-8), so a timeout case would
// raise an unhandled rejection. No timeout case here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const auth = require('../src/scrapers/auth');

async function touchAndSettle(p, plusMs) {
  const t = new Date(fs.statSync(h.cookieFixturePath).mtimeMs + plusMs);
  fs.utimesSync(h.cookieFixturePath, t, t);
  await vi.advanceTimersByTimeAsync(1500);
  await expect(p).resolves.toBeUndefined();
}

beforeEach(() => {
  vi.useFakeTimers();
  h.offline._offline = false;
  h.spawnSpy.mockImplementation(h.spawnRecorder);
});
afterEach(() => {
  h.spawnSpy.mockClear();
  auth._resetCoord();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('runMwinit coalescing (unchanged)', () => {
  it('sanity: the spawn spy is what auth.js captured; the batch lives under the harness tmp dir', async () => {
    const p = auth.runMwinit();
    expect(h.spawnSpy).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = h.spawnSpy.mock.calls[0];
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 4)).toEqual(['/c', 'start', 'cmd.exe', '/c']);
    expect(args[4].startsWith(path.join(h.tmpDir, 'tmp'))).toBe(true);
    expect(args[4].endsWith('fleet_mwinit.bat')).toBe(true);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', shell: false });
    await touchAndSettle(p, 60_000);
  });

  const combos = [];
  for (const a of [false, true]) for (const b of [false, true]) for (const c of [false, true]) combos.push([a, b, c]);
  for (const [singleFlight, singleOwnerAea, singleOwnerReconnect] of combos) {
    it(`flags sf=${singleFlight} aea=${singleOwnerAea} rc=${singleOwnerReconnect}: two concurrent calls → same promise, 1 spawn; after success the next call spawns again`, async () => {
      auth._setCoordDeps({ flags: { singleFlight, singleOwnerAea, singleOwnerReconnect } });
      const p1 = auth.runMwinit();
      const p2 = auth.runMwinit();
      expect(p2).toBe(p1);
      expect(h.spawnSpy).toHaveBeenCalledTimes(1);
      await touchAndSettle(p1, 60_000);
      const p3 = auth.runMwinit();
      expect(p3).not.toBe(p1);
      expect(h.spawnSpy).toHaveBeenCalledTimes(2);
      // p3 snapshotted the touched mtime as its baseline: touch again to settle it.
      await touchAndSettle(p3, 120_000);
    });
  }

  it('offline → { ok:false, skipped:"offline" } and no spawn', async () => {
    h.offline._offline = true;
    await expect(auth.runMwinit()).resolves.toEqual({ ok: false, skipped: 'offline' });
    expect(h.spawnSpy).toHaveBeenCalledTimes(0);
  });
});
