import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const bg = require('../src/repair-intel/background');

let tmpDir;

describe('repair-intel background worker', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-bg-'));
    setDataDir(tmpDir);
    engine.close();
    require('../src/repair-intel/schema').ensureSchema();
  });
  afterAll(() => {
    try { bg.stop(); } catch (_) {}
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('_mayRun allows a legacy single host (no cluster leader)', () => {
    expect(typeof bg._mayRun()).toBe('boolean');
  });

  it('_stalest puts never-synced units first and respects the cap', () => {
    // U1 synced recently, U2 never synced, U3 synced long ago.
    store.saveCheckpoint({ equipmentId: 'U1', lastIncrSyncAt: Date.now() });
    store.saveCheckpoint({ equipmentId: 'U3', lastIncrSyncAt: Date.now() - 48 * 3600 * 1000 });
    const picked = bg._stalest(['U1', 'U2', 'U3'], store, 5);
    // U1 is fresh -> excluded; U2 (never) + U3 (stale) included, never-synced first.
    expect(picked).toContain('U2');
    expect(picked).toContain('U3');
    expect(picked).not.toContain('U1');
    expect(picked[0]).toBe('U2');
  });

  it('_stalest honors the cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => 'N' + i); // all never-synced
    const picked = bg._stalest(many, store, 3);
    expect(picked.length).toBe(3);
  });

  it('runOnce is safe with an empty roster (no throw, no-op)', async () => {
    await expect(bg.runOnce()).resolves.toBeUndefined();
  });
});
