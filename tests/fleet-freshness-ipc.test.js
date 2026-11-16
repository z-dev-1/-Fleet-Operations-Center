// tests/fleet-freshness-ipc.test.js — fleet:get-freshness (src/ipc/fleet-freshness.js).
// Same harness as tests/health-ipc.test.js: fake electron.ipcMain in
// require.cache and an isolated data dir.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fleet-freshness-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
require('../src/ipc/fleet-freshness').registerFleetFreshnessIPC({});
const ff = require('../src/health/fleet-freshness');
const sender = (url) => ({ sender: { getURL: () => url } });
const APP = sender('file:///C:/app/dist/renderer/index.html');
const AAP = sender('https://aap-na.corp.amazon.com/assets/123');

describe('fleet freshness IPC', () => {
  it('registers exactly fleet:get-freshness', () => {
    expect(Object.keys(handlers)).toEqual(['fleet:get-freshness']);
  });

  it('non-app sender -> NOT_APP_UI', async () => {
    expect(await handlers['fleet:get-freshness'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
  });

  it('app sender -> { ok:true, snapshot, evaluation }', async () => {
    ff._resetForTests();
    const r1 = await handlers['fleet:get-freshness'](APP);
    expect(r1.ok).toBe(true);
    expect(r1.snapshot).toMatchObject({ v: 1, lastOkAt: null, buildInFlight: false });
    expect(r1.evaluation).toMatchObject({ level: 'grey', health: 'unknown' });
    ff.recordBuildOk({ count: 7 });
    const r2 = await handlers['fleet:get-freshness'](APP);
    expect(r2.snapshot.lastOkCount).toBe(7);
    expect(r2.evaluation.level).toBe('green');
  });
});
