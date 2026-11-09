// FEAT-A2 / AC-22, design §12 + review F-15: write hand-off (shipped OFF). Validate -> Confirm -> Cancel -> Open;
// exactly one visible window on the partition; a second call focuses it; no net request; WRITE_DISABLED when off.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, flush } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

let fx; let logger; let restoreE; let handlers; let ctx; let S;
const loaded = (name) => Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/data/' + name + '.js'));

function setup(zoom, response = 0) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron();
  fx.electron.dialog.showMessageBox = vi.fn(async (...a) => { fx.calls.dialogs.push(a); return { response }; });
  restoreE = installFakeElectron(require, fx.electron);
  const hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn() };
  hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
  S = require('../src/zoom/data/session');
  S._setDeps({ seeder: { seedOrLegacy: async () => ({}) }, auth: { injectCookies: async () => {} } });
}

const call = (payload) => handlers.get('zoomData:write-open')({ sender: ctx.mainWindow.webContents, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, payload);

afterEach(() => {
  try { require('../src/zoom/data/write')._resetForTests(); } catch (_) {}
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

describe('write-open (AC-22)', () => {
  it('data on + write off -> WRITE_DISABLED, write.js not in require.cache, no dialog', async () => {
    setup({ enabled: true, data: true });
    expect(await call({ action: 'schedule' })).toEqual({ ok: false, code: 'WRITE_DISABLED' });
    expect(loaded('write')).toBe(false);
    expect(fx.calls.dialogs.length).toBe(0);
  });

  it('Cancel -> CANCELLED and no BrowserWindow', async () => {
    setup({ enabled: true, data: true, write: true }, 1);
    expect(await call({ action: 'schedule' })).toEqual({ ok: false, code: 'CANCELLED' });
    expect(fx.calls.dialogs.length).toBe(1);
    expect(fx.calls.dialogs[0][1].message).toBe('Open the Zoom portal to schedule a meeting? Fleet will not create anything itself.');
    expect(fx.calls.windows.length).toBe(0);
  });

  it('delete-recording with an unknown key -> NOT_FOUND before any dialog', async () => {
    setup({ enabled: true, data: true, write: true });
    expect(await call({ action: 'delete-recording', key: 'nope' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await call({ action: 'delete-recording' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.dialogs.length).toBe(0);
  });

  it('Confirm schedule -> exactly one visible window on the partition at SCHEDULE_URL; a second call focuses it', async () => {
    setup({ enabled: true, data: true, write: true });
    expect(await call({ action: 'schedule' })).toEqual({ ok: true });
    await flush();
    expect(fx.calls.windows.length).toBe(1);
    const w = fx.calls.windows[0];
    expect(w.options.show).toBe(true);
    expect(w.options.webPreferences).toEqual({ partition: 'persist:fleet-zoom', nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(w.options.parent).toBe(ctx.mainWindow);
    expect(w.webContents.getURL()).toBe('https://amazon.zoom.us/meeting/schedule');
    // popups denied; navigation guard installed
    expect(w.webContents.windowOpenHandler({ url: 'https://evil.test/' })).toEqual({ action: 'deny' });
    expect(w.webContents.navigateAttempt('will-navigate', 'https://oauth.evil.test/')).toBe(true);
    expect(w.webContents.navigateAttempt('will-navigate', 'https://amazon.zoom.us/meeting')).toBe(false);
    expect(await call({ action: 'schedule' })).toEqual({ ok: true, focused: true });
    expect(fx.calls.windows.length).toBe(1);
    expect(w.focused).toBe(1);
    expect(fx.calls.dialogs.length).toBe(1);
    // closing the window allows a new one
    w.close();
    expect(await call({ action: 'schedule' })).toEqual({ ok: true });
    expect(fx.calls.windows.length).toBe(2);
    expect(fx.calls.net.length).toBe(0);
    expect(loaded('transport')).toBe(false);
    expect(fx.calls.windows.every((x) => x.webContents.executeJavaScriptCalls === 0)).toBe(true);
  });

  it('Confirm delete-recording for a listed recording -> RECORDINGS_URL (no detail URL), no net request', async () => {
    setup({ enabled: true, data: true, write: true });
    require('../src/zoom/data/client').recordingByKey.set('r1', { key: 'r1', idHash: 'h', topic: 'T' });
    expect(await call({ action: 'delete-recording', key: 'r1' })).toEqual({ ok: true });
    await flush();
    expect(fx.calls.dialogs[0][1].message).toBe("Open this recording in the Zoom portal? You delete it there; Fleet won't.");
    expect(fx.calls.windows.length).toBe(1);
    expect(fx.calls.windows[0].webContents.getURL()).toBe('https://amazon.zoom.us/recording');
    expect(fx.calls.net.length).toBe(0);
    expect(loaded('transport')).toBe(false);
  });

  it('static: write.js never requires transport.js or electron.net', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/zoom/data/write.js'), 'utf8');
    expect(src).not.toMatch(/require\(['"]\.\/transport['"]\)/);
    expect(src).not.toContain('net.request');
    expect(src).not.toMatch(/const \{[^}]*\bnet\b[^}]*\}\s*=/);
  });
});
