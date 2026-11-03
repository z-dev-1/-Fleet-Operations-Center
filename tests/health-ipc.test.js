// tests/health-ipc.test.js — health:snapshot (src/ipc/health.js, Phase 6).
// Same harness as tests/workers-ipc.test.js: fake electron.ipcMain in
// require.cache and an isolated data dir. The real supervisor is never
// initialized here, so workers.enabled is false.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'health-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
require('../src/ipc/health').registerHealthIPC({});
const sender = (url) => ({ sender: { getURL: () => url } });
const APP = sender('file:///C:/app/dist/renderer/index.html');
const AAP = sender('https://aap-na.corp.amazon.com/assets/123');

describe('health IPC', () => {
  it('registers exactly health:snapshot', () => {
    expect(Object.keys(handlers)).toEqual(['health:snapshot']);
  });

  it('non-app sender → NOT_APP_UI', async () => {
    expect(await handlers['health:snapshot'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
  });

  it('app sender → ok:true with the six sections, each with a status', async () => {
    const r = await handlers['health:snapshot'](APP);
    expect(r.ok).toBe(true);
    expect(typeof r.at).toBe('number');
    for (const k of ['workers', 'ai', 'auth', 'slack', 'scheduler', 'resources']) {
      expect(r[k]).toBeTruthy();
      expect(['ok', 'unavailable']).toContain(r[k].status);
    }
    expect(r.workers).toMatchObject({ status: 'ok', enabled: false, list: [] });
    // telemetry loaded but never sampled in this test
    expect(r.resources).toEqual({ status: 'unavailable', reason: 'telemetry not sampling' });
    expect(JSON.stringify(r).length).toBeLessThan(64 * 1024);
  });
});
