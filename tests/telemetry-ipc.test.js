// tests/telemetry-ipc.test.js — telemetry:snapshot (src/ipc/telemetry.js).
// Same harness as tests/awareness-assistant-ipc.test.js: fake electron.ipcMain
// in require.cache and an isolated data dir.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'telemetry-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });

const telemetry = require('../src/telemetry');
require('../src/ipc/telemetry').registerTelemetryIPC({});

const sender = (url) => ({ sender: { getURL: () => url } });
const APP = sender('file:///C:/app/dist/renderer/index.html');
const AAP = sender('https://aap-na.corp.amazon.com/assets/123');

describe('telemetry IPC', () => {
  it('registers exactly telemetry:snapshot', () => {
    expect(Object.keys(handlers)).toEqual(['telemetry:snapshot']);
  });
  it('non-app sender -> NOT_APP_UI', async () => {
    expect(await handlers['telemetry:snapshot'](AAP)).toEqual({ ok: false, code: 'NOT_APP_UI' });
  });
  it('app sender -> ok with the live snapshot (tracks + recent)', async () => {
    telemetry.track('x', () => 1);
    const r = await handlers['telemetry:snapshot'](APP);
    expect(r.ok).toBe(true);
    expect(r.snapshot.tracks.x).toMatchObject({ count: 1, ok: 1 });
    expect(Array.isArray(r.snapshot.recent)).toBe(true);
    telemetry._resetForTests();
  });
});
