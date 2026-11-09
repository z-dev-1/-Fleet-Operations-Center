// FEAT-B1 (design §14.1 steps 1-2): Windows media permission status and the fixed privacy deep links.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { containsSentinel, SENTINEL_URL } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

let restoreE = () => {}; let logger = { restore() {} };
afterEach(() => { restoreE(); logger.restore(); freshZoom(require); });

function load(electron) {
  freshZoom(require);
  logger = installFakeLogger(require);
  const fx = electron ? { electron } : createFakeElectron();
  restoreE = installFakeElectron(require, fx.electron);
  const ms = require('../src/zoom/studio/media-status');
  return { ms, fx };
}

describe('media-status.status()', () => {
  it('maps every getMediaAccessStatus value; anything else -> unknown', async () => {
    for (const v of ['granted', 'denied', 'restricted', 'not-determined', 'unknown']) {
      const { ms } = load({ systemPreferences: { getMediaAccessStatus: (w) => (w === 'camera' ? v : 'granted') } });
      expect(await ms.status()).toEqual({ ok: true, camera: v, microphone: 'granted' });
    }
    const { ms } = load({ systemPreferences: { getMediaAccessStatus: () => 'weird' } });
    expect(await ms.status()).toEqual({ ok: true, camera: 'unknown', microphone: 'unknown' });
  });

  it('a throwing call -> unknown, logged with name/code only', async () => {
    const { ms } = load({ systemPreferences: { getMediaAccessStatus: () => { throw new Error(SENTINEL_URL); } } });
    expect(await ms.status()).toEqual({ ok: true, camera: 'unknown', microphone: 'unknown' });
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('missing systemPreferences -> unknown', async () => {
    const { ms } = load({});
    expect(await ms.status()).toEqual({ ok: true, camera: 'unknown', microphone: 'unknown' });
  });

  it('asks for exactly camera and microphone', async () => {
    const seen = [];
    const { ms } = load({ systemPreferences: { getMediaAccessStatus: (w) => { seen.push(w); return 'granted'; } } });
    await ms.status();
    expect(seen).toEqual(['camera', 'microphone']);
  });
});

describe('media-status.openPrivacy()', () => {
  it('uses only the two fixed URIs', async () => {
    const { ms, fx } = load();
    expect(await ms.openPrivacy({ which: 'camera' })).toEqual({ ok: true });
    expect(await ms.openPrivacy({ which: 'microphone' })).toEqual({ ok: true });
    expect(fx.calls.openExternal).toEqual([['ms-settings:privacy-webcam'], ['ms-settings:privacy-microphone']]);
  });

  it('unknown which throws INVALID_INPUT and never calls openExternal', async () => {
    const { ms, fx } = load();
    await expect(ms.openPrivacy({ which: 'https://evil.test/' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fx.calls.openExternal).toEqual([]);
  });

  it('openExternal failure -> UNAVAILABLE, no message leaks', async () => {
    const fx = createFakeElectron({ openExternalReject: new Error(SENTINEL_URL) });
    const { ms } = load(fx.electron);
    expect(await ms.openPrivacy({ which: 'camera' })).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(containsSentinel(logger.text())).toBe(null);
  });
});

describe('through the hub', () => {
  function hubSetup(electron) {
    freshZoom(require);
    logger = installFakeLogger(require);
    const fx = electron ? { electron, calls: null } : createFakeElectron();
    restoreE = installFakeElectron(require, fx.electron);
    const hub = require('../src/ipc/zoom-hub');
    const handlers = new Map();
    const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
    const ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn() };
    hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, studio: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
    const ev = { sender: wc, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } };
    return { call: (ch, p) => handlers.get(ch)(ev, p), fx, hub };
  }

  it('zoomStudio:media-status and open-privacy are REAL; unknown which -> INVALID_INPUT via the hub', async () => {
    const { call, fx } = hubSetup();
    expect(await call('zoomStudio:media-status')).toEqual({ ok: true, camera: 'granted', microphone: 'granted' });
    expect(await call('zoomStudio:open-privacy', { which: 'camera' })).toEqual({ ok: true });
    expect(await call('zoomStudio:open-privacy', { which: 'screen' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'which' });
    expect(await call('zoomStudio:open-privacy', { which: 'camera', uri: 'ms-settings:x' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(await call('zoomStudio:open-privacy', 'ms-settings:privacy-webcam')).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(fx.calls.openExternal).toEqual([['ms-settings:privacy-webcam']]);
    expect(logger.lines.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('installs no permission handler on defaultSession', async () => {
    const { call, fx } = hubSetup();
    await call('zoomStudio:media-status');
    await call('zoomStudio:open-privacy', { which: 'microphone' });
    expect(fx.calls.throwsHit).toEqual([]);
    expect(fx.calls.fromPartition).toEqual([]);
  });
});
