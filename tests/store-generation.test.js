// tests/store-generation.test.js — per-key write generation (design §2.1, §9.2).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-generation-'));
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const store = require('../src/store');
const engine = require('../src/store/sqlite_engine');
let sqliteOk = false;
try { sqliteOk = !!engine.isAvailable(); } catch (_) { sqliteOk = false; }

describe('store.generation', () => {
  it('increments on JSON save/update/updateAsync/delete', async () => {
    const g0 = store.generation('fleetData');
    store.save('fleetData', { rows: [] });
    expect(store.generation('fleetData')).toBe(g0 + 1);
    store.update('fleetData', (cur) => Object.assign({}, cur, { a: 1 }));
    expect(store.generation('fleetData')).toBe(g0 + 2);
    await store.updateAsync('fleetData', async (cur) => Object.assign({}, cur, { b: 2 }));
    expect(store.generation('fleetData')).toBe(g0 + 3);
    store.delete('fleetData');
    expect(store.generation('fleetData')).toBe(g0 + 4);
  });

  it.skipIf(!sqliteOk)('increments on SQLite save/update', () => {
    const g0 = store.generation('schedulerLedger');
    store.save('schedulerLedger', { jobs: {} });
    expect(store.generation('schedulerLedger')).toBe(g0 + 1);
    store.update('schedulerLedger', (cur) => Object.assign({}, cur, { x: 1 }));
    expect(store.generation('schedulerLedger')).toBe(g0 + 2);
  });

  it('unchanged when save throws', () => {
    const g0 = store.generation('canonicalState');
    const circ = {}; circ.self = circ;
    expect(() => store.save('canonicalState', circ)).toThrow();
    expect(store.generation('canonicalState')).toBe(g0);
  });

  it('per key; never-written is 0', () => {
    expect(store.generation('neverWritten')).toBe(0);
    const a = store.generation('pins');
    const b = store.generation('schedules');
    store.save('pins', { p: 1 });
    expect(store.generation('pins')).toBe(a + 1);
    expect(store.generation('schedules')).toBe(b);
  });
});
