// FEAT-A1 / AC-1 (design §3.4 harness, review F-3, F-12): with no Zoom area effective, nothing under src/zoom/
// loads, no electron entry point is touched, every channel is a fixed stub, and the renderer boot appends nothing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { createExtDom, ExtElement } from './fixtures/zoom/fake-dom-ext.js';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

const zoomInCache = () => Object.keys(require.cache).filter((k) => k.replace(/\\/g, '/').includes('/src/zoom/'));

const CASES = [
  ['a: no settings, no env', pf.resolveZoomFlags({}, {}), false],
  ['b: settings.zoom.enabled:true only (the real machine state)', pf.resolveZoomFlags({ zoom: { enabled: true } }, {}), true],
];

let restoreE = () => {}; let logger = { restore() {} };
afterEach(() => { restoreE(); logger.restore(); freshZoom(require); });

describe('main: registerZoomHubIPC with no area effective', () => {
  for (const [name, flags, enabled] of CASES) {
    it(name, async () => {
      freshZoom(require);
      logger = installFakeLogger(require);
      const fx = createFakeElectron({ throwing: true });
      restoreE = installFakeElectron(require, fx.electron);
      const handlers = new Map();
      const wc = { id: 1, mainFrame: { processId: 2, routingId: 1 } };
      const fakeCtx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => { throw new Error('no events when OFF'); } };
      const hub = require('../src/ipc/zoom-hub');
      hub.registerZoomHubIPC(fakeCtx, { flags, handle: (ch, fn) => handlers.set(ch, fn) });
      const all = [].concat(hub.CHANNELS.hub, hub.CHANNELS.data, hub.CHANNELS.studio);
      expect([...handlers.keys()].sort()).toEqual(all.slice().sort());
      const event = { sender: wc, senderFrame: { processId: 2, routingId: 1, url: 'file:///C:/Fleet/renderer/src/index.html' } };
      for (const ch of all) {
        const r = await handlers.get(ch)(event, { key: 'abc', kind: 'upcoming' });
        if (ch === 'zoomHub:flags') expect(r).toEqual({ ok: true, enabled, data: false, studio: false, write: false });
        else expect([ch, r]).toEqual([ch, { ok: false, code: 'DISABLED' }]);
      }
      expect(zoomInCache()).toEqual([]);
      expect(fx.calls.throwsHit).toEqual([]);
      expect(fx.calls.fromPartition.length + fx.calls.windows.length + fx.calls.net.length).toBe(0);
      const infos = logger.lines.filter((l) => l.level === 'info');
      if (enabled) {
        expect(infos.length).toBe(1);
        expect(infos[0].args).toEqual(['[zoom-hub] enabled-without-area']);
      } else {
        expect(infos.length).toBe(0);
      }
      expect(logger.lines.filter((l) => l.level !== 'info')).toEqual([]);
    });
  }

  it('src/ipc/index.js has exactly one registerZoomHubIPC(ctx) line', () => {
    const src = fs.readFileSync(require.resolve('../src/ipc/index.js'), 'utf8');
    const hits = src.split(/\r?\n/).filter((l) => l.includes("require('./zoom-hub').registerZoomHubIPC(ctx)"));
    expect(hits).toEqual(["  try { require('./zoom-hub').registerZoomHubIPC(ctx); } catch (e) { logger.warn('Zoom hub IPC registration failed: ' + (e && e.name)); }"]);
    expect((src.match(/registerZoomHubIPC/g) || []).length).toBe(1);
  });
});

describe('renderer: zoom-hub-boot with no area effective', () => {
  for (const [name, flags, enabled] of CASES) {
    it(name, async () => {
      const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
      const touched = [];
      const nav = {};
      Object.defineProperty(nav, 'mediaDevices', { get() { touched.push('mediaDevices'); throw new Error('mediaDevices must not be touched'); } });
      Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
      const { document, dom } = createExtDom();
      Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
      try {
        const { boot } = await import('../renderer/src/js/views/zoom-hub-boot.js');
        const load = vi.fn(async () => { throw new Error('zoom-hub.js must not be imported'); });
        const eff = flags.effective;
        const zoomHub = { flags: vi.fn(async () => ({ ok: true, enabled: eff.enabled, data: eff.data, studio: eff.studio, write: eff.write })) };
        const mount = new ExtElement('views-mount', 'div', dom);
        const r = await boot(mount, { zoomHub, load });
        expect(r).toBe(false);
        expect(zoomHub.flags).toHaveBeenCalledTimes(1);
        expect(load).not.toHaveBeenCalled();
        expect(dom.appended).toEqual([]);
        expect(mount.children).toEqual([]);
        expect(document.head.children).toEqual([]);
        expect(touched).toEqual([]);
        expect(enabled).toBe(eff.enabled);
        // Missing bridge / failing flags are equally inert.
        expect(await boot(mount, { zoomHub: undefined, load })).toBe(false);
        expect(await boot(mount, { zoomHub: { flags: async () => ({ ok: false, code: 'FORBIDDEN' }) }, load })).toBe(false);
        expect(await boot(mount, { zoomHub: { flags: async () => { throw new Error('x'); } }, load })).toBe(false);
        expect(load).not.toHaveBeenCalled();
      } finally {
        if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete globalThis.navigator;
        if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc); else delete globalThis.document;
      }
    });
  }

  it('the boot module source never references navigator.mediaDevices', () => {
    const src = fs.readFileSync(require.resolve('../renderer/src/js/views/zoom-hub-boot.js'), 'utf8');
    expect(src.includes('mediaDevices')).toBe(false);
  });

  it('with an area effective, boot imports the view through deps.load and calls init(mount, flags)', async () => {
    const { boot } = await import('../renderer/src/js/views/zoom-hub-boot.js');
    const init = vi.fn();
    const load = vi.fn(async () => ({ init }));
    const mount = {};
    const r = await boot(mount, { zoomHub: { flags: async () => ({ ok: true, enabled: true, data: true, studio: false, write: false }) }, load });
    expect(r).toBe(true);
    expect(init).toHaveBeenCalledWith(mount, { enabled: true, data: true, studio: false, write: false });
  });
});
