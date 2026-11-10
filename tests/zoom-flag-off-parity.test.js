// FEAT-A1 / AC-1 (design §3.4 harness, review F-3, F-12): with no Zoom area effective, nothing under src/zoom/
// loads, no electron entry point is touched, every channel is a fixed stub, and the renderer boot appends nothing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
      const all = [].concat(hub.CHANNELS.hub, hub.CHANNELS.data, hub.CHANNELS.studio, hub.CHANNELS.obs);
      expect([...handlers.keys()].sort()).toEqual(all.slice().sort());
      const event = { sender: wc, senderFrame: { processId: 2, routingId: 1, url: 'file:///C:/Fleet/renderer/src/index.html' } };
      for (const ch of all) {
        const r = await handlers.get(ch)(event, { key: 'abc', kind: 'upcoming' });
        if (ch === 'zoomHub:flags') expect(r).toEqual({ ok: true, enabled, data: false, studio: false, write: false, obs: false });
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

  it('FEAT-B1: data ON / studio OFF -> every zoomStudio:* is DISABLED and media-status.js is never loaded', async () => {
    freshZoom(require);
    logger = installFakeLogger(require);
    const fx = createFakeElectron();
    restoreE = installFakeElectron(require, fx.electron);
    const handlers = new Map();
    const wc = { id: 1, mainFrame: { processId: 2, routingId: 1 } };
    const fakeCtx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => {} };
    const hub = require('../src/ipc/zoom-hub');
    hub.registerZoomHubIPC(fakeCtx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, data: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
    const event = { sender: wc, senderFrame: { processId: 2, routingId: 1, url: 'file:///C:/Fleet/renderer/src/index.html' } };
    for (const ch of hub.CHANNELS.studio) {
      expect([ch, await handlers.get(ch)(event, { which: 'camera' })]).toEqual([ch, { ok: false, code: 'DISABLED' }]);
    }
    expect(Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').includes('/src/zoom/studio/'))).toBe(false);
  });

  it('OBS flag OFF with studio ON: obs channels are DISABLED and obs-auth, obs-client, obs-feed-server, obs-launch and obs are never required', async () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-obs-off-'));
    require('../src/config/paths').setDataDir(TMP);
    try {
      freshZoom(require);
      logger = installFakeLogger(require);
      const fx = createFakeElectron();
      restoreE = installFakeElectron(require, fx.electron);
      const handlers = new Map();
      const wc = { id: 1, mainFrame: { processId: 2, routingId: 1 } };
      const fakeCtx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => {} };
      const hub = require('../src/ipc/zoom-hub');
      const flags = pf.resolveZoomFlags({ zoom: { enabled: true, studio: true } }, {});
      const reg = hub.registerZoomHubIPC(fakeCtx, { flags, handle: (ch, fn) => handlers.set(ch, fn) });
      expect(reg.flags).toEqual({ ok: true, enabled: true, data: false, studio: true, write: false, obs: false });
      const event = { sender: wc, senderFrame: { processId: 2, routingId: 1, url: 'file:///C:/Fleet/renderer/src/index.html' } };
      const P = 'p_000000000000';
      const L = 'l_000000000000';
      const studioPayloads = {
        'zoomStudio:media-status': undefined,
        'zoomStudio:open-privacy': { which: 'camera' },
        'zoomStudio:presets-list': undefined,
        'zoomStudio:preset-save': { preset: {} },
        'zoomStudio:preset-rename': { id: P, name: 'x' },
        'zoomStudio:preset-delete': { id: P },
        'zoomStudio:preset-select': { id: null },
        'zoomStudio:library-list': undefined,
        'zoomStudio:library-import': { kind: 'background' },
        'zoomStudio:library-read': { id: L },
        'zoomStudio:library-rename': { id: L, name: 'x' },
        'zoomStudio:library-delete': { id: L },
        'zoomStudio:launcher-get': undefined,
        'zoomStudio:launcher-pick': undefined,
        'zoomStudio:launcher-run': undefined,
      };
      expect(Object.keys(studioPayloads).sort()).toEqual(hub.CHANNELS.studio.slice().sort());
      for (const ch of hub.CHANNELS.studio) {
        const r = await handlers.get(ch)(event, studioPayloads[ch]);
        expect([ch, r && r.code]).not.toEqual([ch, 'DISABLED']);
      }
      const obsPayloads = { 'zoomStudio:obs-config-set': { host: '127.0.0.1', port: 4455, exePath: null, password: 'x' } };
      for (const ch of hub.CHANNELS.obs) {
        expect([ch, await handlers.get(ch)(event, obsPayloads[ch])]).toEqual([ch, { ok: false, code: 'DISABLED' }]);
      }
      const OBS_FILES = ['obs-auth', 'obs-client', 'obs-feed-server', 'obs-launch', 'obs'].map((n) => '/src/zoom/studio/' + n + '.js');
      const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
      for (const f of OBS_FILES) expect([f, loaded.some((k) => k.endsWith(f))]).toEqual([f, false]);
      // Sanity: the studio area really ran (its modules are in the cache).
      expect(loaded.some((k) => k.endsWith('/src/zoom/studio/presets.js'))).toBe(true);
      expect(loaded.some((k) => k.endsWith('/src/zoom/validate.js'))).toBe(true);
    } finally {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    }
  });

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
        const zoomHub = { flags: vi.fn(async () => ({ ok: true, enabled: eff.enabled, data: eff.data, studio: eff.studio, write: eff.write, obs: eff.obs })) };
        expect(eff.obs).toBe(false);
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

  it('FEAT-B1: data ON / studio OFF -> the hub view never touches navigator.mediaDevices (studio panel not mounted)', async () => {
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const touched = [];
    const nav = {};
    Object.defineProperty(nav, 'mediaDevices', { get() { touched.push('mediaDevices'); throw new Error('mediaDevices must not be touched'); } });
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
    const view = await import('../renderer/src/js/views/zoom-hub.js');
    try {
      view._resetForTests();
      const { document, dom } = createExtDom();
      const subs = new Map();
      const bus = { on: (ev, fn) => { subs.set(ev, fn); }, emit: (ev, p) => { const fn = subs.get(ev); if (fn) fn(p); } };
      const r = async () => ({ ok: false, code: 'DISABLED' });
      const zoomHub = new Proxy({}, { get: (_t, k) => (k === 'onAuthChanged' || k === 'onSummaryProgress' ? () => () => {} : r) });
      const h = view.init(new ExtElement('views-mount', 'div', dom), { enabled: true, data: true, studio: false, write: false }, { bus, addTab: () => {}, zoomHub, document });
      expect(h.root.querySelector('#zh-panel-studio')).toBe(null);
      for (const to of ['zoom', 'settings', 'fleet', 'zoom']) bus.emit('ui:view-change', { to });
      await new Promise((res) => setTimeout(res, 0));
      expect(touched).toEqual([]);
    } finally {
      view._resetForTests();
      if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete globalThis.navigator;
    }
  });

  it('the boot module source never references navigator.mediaDevices', () => {
    const src = fs.readFileSync(require.resolve('../renderer/src/js/views/zoom-hub-boot.js'), 'utf8');
    expect(src.includes('mediaDevices')).toBe(false);
  });

  it('with an area effective, boot imports the view through deps.load and calls init(mount, flags)', async () => {
    const { boot } = await import('../renderer/src/js/views/zoom-hub-boot.js');
    const init = vi.fn();
    const load = vi.fn(async () => ({ init }));
    const mount = {};
    const r = await boot(mount, { zoomHub: { flags: async () => ({ ok: true, enabled: true, data: true, studio: false, write: false, obs: false }) }, load });
    expect(r).toBe(true);
    expect(init).toHaveBeenCalledWith(mount, { enabled: true, data: true, studio: false, write: false, obs: false });
  });
});
