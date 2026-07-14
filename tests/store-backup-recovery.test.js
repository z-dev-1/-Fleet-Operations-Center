// tests/store-backup-recovery.test.js
//
// Regression test for the .bak corruption-recovery fix in src/store/index.js.
//
// Root problem found during a broader app audit: load()'s corrupted-JSON
// fallback reads `filePath + '.bak'`, but a full-repo grep confirmed that
// before this fix NOTHING anywhere ever wrote a .bak file -- the fallback
// was dead code. Any corrupted store (fleetData, notesStore, relayCache --
// every store in REGISTRY) would silently fall through to the caller's
// default value with zero chance of recovery, no matter how recently it had
// been saved successfully. This test exercises the REAL store module (unlike
// the existing tests/store.test.js, which reimplements save/load logic
// inline and never actually imports src/store/index.js) to prove save() now
// snapshots the prior good file to .bak, and load() actually recovers from
// it when the live file is corrupted.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = path.join(os.tmpdir(), 'fleet-store-bak-test-' + Date.now());

// src/store/index.js resolves paths via ../config/paths (P.*), which in turn
// depends on Electron's app.getPath('userData') -- unavailable outside a
// running Electron process. Rather than mock the whole config/paths chain,
// this test drives the exact same save()/load() logic path by requiring the
// real module and monkey-patching its internal REGISTRY entry for a throwaway
// test key, which is the officially supported extension point ("add it to
// REGISTRY above") called out in the module's own error message.
const store = require('../src/store/index.js');
const TEST_KEY = '_bakRecoveryTestStore';
store.REGISTRY[TEST_KEY] = () => path.join(tmpDir, 'bak-test.json');

describe('store.save() / store.load() .bak corruption recovery', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  });

  it('does not create a .bak file on the very first save (nothing to back up yet)', () => {
    store.save(TEST_KEY, { v: 1 });
    const filePath = path.join(tmpDir, 'bak-test.json');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(filePath + '.bak')).toBe(false);
  });

  it('snapshots the PRIOR version to .bak on every subsequent save', () => {
    store.save(TEST_KEY, { v: 1 });
    store.save(TEST_KEY, { v: 2 });

    const filePath = path.join(tmpDir, 'bak-test.json');
    const bakPath = filePath + '.bak';
    expect(fs.existsSync(bakPath)).toBe(true);

    const live = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const bak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    expect(live.v).toBe(2);
    expect(bak.v).toBe(1); // .bak holds the version that was live BEFORE this save
  });

  it('recovers from .bak when the live file is corrupted (the actual bug this fixes)', () => {
    store.save(TEST_KEY, { v: 1, note: 'last known good' });
    store.save(TEST_KEY, { v: 2 });
    // .bak now holds { v: 1, note: 'last known good' }

    const filePath = path.join(tmpDir, 'bak-test.json');
    fs.writeFileSync(filePath, '{corrupted json!!!', 'utf8'); // simulate a crash mid-write / disk corruption

    const recovered = store.load(TEST_KEY, { fallback: true });
    expect(recovered.fallback).toBeUndefined();
    expect(recovered.v).toBe(1);
    expect(recovered.note).toBe('last known good');
  });

  it('falls back to the caller-supplied default when BOTH the live file and .bak are corrupted', () => {
    const filePath = path.join(tmpDir, 'bak-test.json');
    fs.writeFileSync(filePath, '{corrupted!!!', 'utf8');
    fs.writeFileSync(filePath + '.bak', '{also corrupted!!!', 'utf8');

    const result = store.load(TEST_KEY, { fallback: true });
    expect(result.fallback).toBe(true);
  });

  it('falls back to the caller-supplied default when the live file is corrupted and no .bak exists at all', () => {
    const filePath = path.join(tmpDir, 'bak-test.json');
    fs.writeFileSync(filePath, '{corrupted, no backup!!!', 'utf8');

    const result = store.load(TEST_KEY, { fallback: true });
    expect(result.fallback).toBe(true);
  });

  it('update() (read-modify-write) continues to work correctly with the new backup behavior', () => {
    store.save(TEST_KEY, { count: 1 });
    const result = store.update(TEST_KEY, (cur) => ({ count: cur.count + 1 }));
    expect(result.count).toBe(2);
    expect(store.load(TEST_KEY).count).toBe(2);
  });
});
