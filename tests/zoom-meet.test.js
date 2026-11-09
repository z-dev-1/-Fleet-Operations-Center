// tests/zoom-meet.test.js — Meetings tab phase 1: flags, join-input normalization, host allow-list,
// session permission rules, the zoom.enabled IPC gate, and the single-view dock/detach/leave controller.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);

const handlers = {};
const electronStub = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, shell: { openExternal: vi.fn(async () => {}) } };
beforeAll(() => {
  const p = require.resolve('electron');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: electronStub };
});
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

// ── flags ────────────────────────────────────────────────────────────────────
describe('resolveZoomMeetFlags', () => {
  const pf = require('../src/config/perf-flags');
  it('defaults OFF with tenant/web-app hosts and corner mini player', () => {
    expect(pf.resolveZoomMeetFlags({}, {})).toEqual({ enabled: false, portalHost: 'amazon.zoom.us', webAppHost: 'app.zoom.us', miniPlayer: 'corner' });
  });
  it('settings enable it; env wins both ways; junk env ignored', () => {
    expect(pf.resolveZoomMeetFlags({ zoom: { enabled: true } }, {}).enabled).toBe(true);
    expect(pf.resolveZoomMeetFlags({ zoom: { enabled: true } }, { FLEET_ZOOM_ENABLED: '0' }).enabled).toBe(false);
    expect(pf.resolveZoomMeetFlags({}, { FLEET_ZOOM_ENABLED: '1' }).enabled).toBe(true);
    expect(pf.resolveZoomMeetFlags({ zoom: { enabled: true } }, { FLEET_ZOOM_ENABLED: 'yes' }).enabled).toBe(true);
    expect(pf.resolveZoomMeetFlags({ zoom: { enabled: 'true' } }, {}).enabled).toBe(false);
  });
  it('accepts only *.zoom.us hosts and the two mini-player styles', () => {
    const f = pf.resolveZoomMeetFlags({ zoom: { portalHost: 'evil.example.com', webAppHost: 'APP.zoom.us', miniPlayer: 'floating' } }, {});
    expect(f.portalHost).toBe('amazon.zoom.us');
    expect(f.webAppHost).toBe('app.zoom.us');
    expect(f.miniPlayer).toBe('floating');
    expect(pf.resolveZoomMeetFlags({ zoom: { webAppHost: 'zoom.us.evil.com', miniPlayer: 'x' } }, {})).toMatchObject({ webAppHost: 'app.zoom.us', miniPlayer: 'corner' });
  });
  it('the test setup forces the flag off', () => {
    expect(process.env.FLEET_ZOOM_ENABLED).toBe('0');
    expect(pf.loadZoomMeet({ load: () => ({ zoom: { enabled: true } }) }).enabled).toBe(false);
  });
});

// ── url helpers ──────────────────────────────────────────────────────────────
describe('zoom-meet/url', () => {
  const u = require('../src/zoom-meet/url');
  const opts = { webAppHost: 'app.zoom.us' };
  it('bare meeting IDs (spaces/dashes ok) become a web-client join URL; passcode is encoded', () => {
    expect(u.normalizeJoinInput('123 4567 8901', opts)).toEqual({ ok: true, url: 'https://app.zoom.us/wc/join/12345678901', kind: 'meeting' });
    expect(u.normalizeJoinInput('123-456-789', Object.assign({ passcode: 'a b&c' }, opts)).url).toBe('https://app.zoom.us/wc/join/123456789?pwd=a+b%26c');
  });
  it('zoom links of every join shape are rewritten to the web client and keep pwd', () => {
    for (const link of ['https://amazon.zoom.us/j/98765432101?pwd=XyZ', 'amazon.zoom.us/j/98765432101?pwd=XyZ',
      'https://zoom.us/wc/join/98765432101?pwd=XyZ', 'https://us02web.zoom.us/wc/98765432101/join?pwd=XyZ']) {
      expect(u.normalizeJoinInput(link, opts)).toEqual({ ok: true, url: 'https://app.zoom.us/wc/join/98765432101?pwd=XyZ', kind: 'meeting' });
    }
    expect(u.normalizeJoinInput('https://amazon.zoom.us/j/98765432101?pwd=old', Object.assign({ passcode: 'new' }, opts)).url).toContain('pwd=new');
  });
  it('other zoom pages load as-is over https; non-zoom input is refused', () => {
    expect(u.normalizeJoinInput('http://amazon.zoom.us/my/someone', opts)).toEqual({ ok: true, url: 'https://amazon.zoom.us/my/someone', kind: 'page' });
    expect(u.normalizeJoinInput('https://zoom.us.evil.com/j/123456789', opts).ok).toBe(false);
    expect(u.normalizeJoinInput('https://example.com', opts).ok).toBe(false);
    expect(u.normalizeJoinInput('', opts).ok).toBe(false);
    expect(u.normalizeJoinInput('12345', opts).ok).toBe(false);
    expect(u.normalizeJoinInput('x'.repeat(3000), opts).ok).toBe(false);
  });
  it('navigation allow-list: zoom + SSO hops over https only', () => {
    expect(u.isAllowedNavUrl('https://app.zoom.us/wc/meetings')).toBe(true);
    expect(u.isAllowedNavUrl('https://idp.federate.amazon.com/api/v1/intermediate')).toBe(true);
    expect(u.isAllowedNavUrl('https://midway-auth.amazon.com/login')).toBe(true);
    expect(u.isAllowedNavUrl('http://app.zoom.us/')).toBe(false);
    expect(u.isAllowedNavUrl('https://zoom.us.evil.com/')).toBe(false);
    expect(u.isAllowedNavUrl('zoommtg://zoom.us/join?confno=1')).toBe(false);
    expect(u.isAllowedNavUrl('https://example.com/')).toBe(false);
  });
  it('deep link, in-meeting detection and log masking', () => {
    expect(u.toDeepLink('https://app.zoom.us/wc/join/98765432101?pwd=XyZ')).toBe('zoommtg://zoom.us/join?action=join&confno=98765432101&pwd=XyZ');
    expect(u.toDeepLink('https://app.zoom.us/wc/meetings')).toBe(null);
    expect(u.isInMeetingUrl('https://app.zoom.us/wc/98765432101/join')).toBe(true);
    expect(u.isInMeetingUrl('https://app.zoom.us/wc/join/98765432101')).toBe(true);
    expect(u.isInMeetingUrl('https://app.zoom.us/wc/meetings')).toBe(false);
    const masked = u.maskUrl('https://app.zoom.us/wc/join/98765432101?pwd=SECRET');
    expect(masked).toBe('app.zoom.us/wc/join/<n>');
  });
});

// ── session rules ────────────────────────────────────────────────────────────
describe('zoom-meet/session', () => {
  const s = require('../src/zoom-meet/session');
  it('permissions: meeting permissions for *.zoom.us only', () => {
    expect(s.permissionAllowed('media', 'https://app.zoom.us/wc/1')).toBe(true);
    expect(s.permissionAllowed('display-capture', 'https://app.zoom.us/')).toBe(true);
    expect(s.permissionAllowed('media', 'https://example.com/')).toBe(false);
    expect(s.permissionAllowed('geolocation', 'https://app.zoom.us/')).toBe(false);
    expect(s.permissionAllowed('media', '')).toBe(false);
  });
  it('strips Electron and app-name tokens from the user agent', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) fleet-ops-app/3.0.0 Chrome/140.0.0.0 Electron/42.4.1 Safari/537.36';
    expect(s.chromeUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  });
  it('uses its own partition, not the OAuth persist:zoom or defaultSession', () => {
    expect(s.PARTITION).toBe('persist:zoom-portal');
  });
});

// ── IPC gate ─────────────────────────────────────────────────────────────────
describe('ipc/zoom-meet', () => {
  const ipc = require('../src/ipc/zoom-meet');
  const zoomMeetDir = path.dirname(require.resolve('../src/zoom-meet/url.js')) + path.sep;
  const call = (ch, sender, ...a) => handlers[ch]({ sender }, ...a);
  beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k]; });

  it('flag OFF: every channel is registered and inert; view/session modules are never loaded', async () => {
    for (const k of Object.keys(require.cache)) if (k.startsWith(zoomMeetDir) && /view\.js$|session\.js$/.test(k)) delete require.cache[k];
    ipc.registerZoomMeetIPC({}, { flags: { enabled: false } });
    expect(Object.keys(handlers).sort()).toEqual([...ipc.CHANNELS].sort());
    expect(await call('zoomMeet:status', {})).toEqual({ ok: true, enabled: false });
    expect(await call('zoomMeet:join', {}, { input: '123456789' })).toMatchObject({ ok: false, code: 'DISABLED' });
    expect(Object.keys(require.cache).filter((k) => k.startsWith(zoomMeetDir) && /view\.js$|session\.js$/.test(k))).toEqual([]);
  });

  function onSetup() {
    const mainWc = {};
    const win = { isDestroyed: () => false, webContents: Object.assign(mainWc, { send: vi.fn() }) };
    const controller = {
      open: vi.fn(async (url) => ({ ok: true, open: true, url })), setBounds: vi.fn((r) => ({ ok: true, r })),
      detach: vi.fn(() => ({ ok: true })), dock: vi.fn(() => ({ ok: true })), leave: vi.fn(() => ({ ok: true })),
      state: () => ({ ok: true, open: false }), currentUrl: () => 'https://app.zoom.us/wc/join/123456789?pwd=p',
    };
    const shell = { openExternal: vi.fn(async () => {}) };
    ipc.registerZoomMeetIPC({ getMainWindow: () => win }, { flags: { enabled: true, webAppHost: 'app.zoom.us', miniPlayer: 'corner' }, controller, shell });
    return { mainWc, controller, shell };
  }

  it('flag ON: only the Fleet main window may call', async () => {
    const { controller } = onSetup();
    expect(await call('zoomMeet:join', { other: true }, { input: '123456789' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(controller.open).not.toHaveBeenCalled();
  });

  it('flag ON: join normalizes input before opening; bad input never reaches the view', async () => {
    const { mainWc, controller } = onSetup();
    expect(await call('zoomMeet:status', mainWc)).toMatchObject({ ok: true, enabled: true, miniPlayer: 'corner' });
    await call('zoomMeet:join', mainWc, { input: 'https://amazon.zoom.us/j/123456789?pwd=abc' });
    expect(controller.open).toHaveBeenCalledWith('https://app.zoom.us/wc/join/123456789?pwd=abc');
    expect(await call('zoomMeet:join', mainWc, { input: 'https://example.com/x' })).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    expect(await call('zoomMeet:join', mainWc, { input: '' })).toMatchObject({ ok: false });
    expect(controller.open).toHaveBeenCalledTimes(1);
    await call('zoomMeet:open-home', mainWc);
    expect(controller.open).toHaveBeenLastCalledWith('https://app.zoom.us/wc/meetings');
  });

  it('flag ON: bounds are validated; null hides; deep link opens only with a meeting ID', async () => {
    const { mainWc, controller, shell } = onSetup();
    expect(await call('zoomMeet:set-bounds', mainWc, { x: 0, y: 0, width: 'a', height: 1 })).toMatchObject({ code: 'BAD_INPUT' });
    await call('zoomMeet:set-bounds', mainWc, null);
    expect(controller.setBounds).toHaveBeenCalledWith(null);
    await call('zoomMeet:set-bounds', mainWc, { x: 10, y: 20, width: 300, height: 200 });
    expect(controller.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    await call('zoomMeet:detach', mainWc, { floating: true });
    expect(controller.detach).toHaveBeenCalledWith({ floating: true });
    expect(await call('zoomMeet:open-in-zoom-app', mainWc)).toEqual({ ok: true });
    expect(shell.openExternal).toHaveBeenCalledWith('zoommtg://zoom.us/join?action=join&confno=123456789&pwd=p');
  });
});

// ── view controller ──────────────────────────────────────────────────────────
function fakeElectron() {
  const created = { views: [], windows: [] };
  function emitter() {
    const h = {};
    return {
      on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return this; },
      emit(ev, ...a) { (h[ev] || []).slice().forEach((fn) => fn(...a)); },
      removeAllListeners(ev) { delete h[ev]; },
      _h: h,
    };
  }
  class WebContentsView {
    constructor(opts) {
      this.opts = opts; this.bounds = null; this.visible = null;
      const wc = Object.assign(emitter(), {
        loadURL: vi.fn(async () => {}), closed: false, openHandler: null,
        close() { this.closed = true; }, isDestroyed() { return this.closed; },
        setWindowOpenHandler(fn) { this.openHandler = fn; },
      });
      this.webContents = wc;
      created.views.push(this);
    }
    setBounds(b) { this.bounds = b; }
    setVisible(v) { this.visible = v; }
  }
  function makeWin(opts) {
    const w = Object.assign(emitter(), {
      opts: opts || {}, destroyed: false, fullScreen: false, size: [(opts && opts.width) || 900, (opts && opts.height) || 700], onTop: !!(opts && opts.alwaysOnTop),
      contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter((c) => c !== v); } },
      webContents: { getZoomFactor: () => 1.25, send: vi.fn() },
      isDestroyed() { return this.destroyed; },
      getContentSize() { return this.size; },
      setSize(wd, ht) { this.size = [wd, ht]; },
      setAlwaysOnTop(v) { this.onTop = v; },
      isFullScreen() { return this.fullScreen; }, setFullScreen(v) { this.fullScreen = v; },
      close() { this.emit('close'); this.destroyed = true; this.emit('closed'); },
    });
    return w;
  }
  function BrowserWindow(opts) { const w = makeWin(opts); created.windows.push(w); return w; }
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const shell = { openExternal: vi.fn(async () => {}) };
  return { electron: { WebContentsView, BrowserWindow, dialog, shell }, created, main: makeWin({ width: 1200, height: 800 }) };
}

describe('zoom-meet/view controller', () => {
  const { createController } = require('../src/zoom-meet/view');
  let fx; let ctl; let sent;
  beforeEach(() => {
    fx = fakeElectron();
    sent = [];
    ctl = createController({
      electron: fx.electron, log: silentLog, getMainWindow: () => fx.main,
      send: (ch, p) => sent.push([ch, p]), getSession: () => ({}), seedMidway: async () => true,
    });
  });

  it('open() creates ONE hidden view on the zoom partition, attached to the main window', async () => {
    const st = await ctl.open('https://app.zoom.us/wc/join/123456789');
    expect(fx.created.views).toHaveLength(1);
    const v = fx.created.views[0];
    expect(v.opts.webPreferences).toMatchObject({ partition: 'persist:zoom-portal', contextIsolation: true, sandbox: true, nodeIntegration: false });
    expect(v.opts.webPreferences.preload).toBeUndefined();
    expect(fx.main.contentView.children).toEqual([v]);
    expect(v.visible).toBe(false);
    expect(st).toMatchObject({ open: true, mode: 'main', visible: false });
    await ctl.open('https://app.zoom.us/wc/meetings');
    expect(fx.created.views).toHaveLength(1);
    expect(await ctl.open('https://example.com/')).toMatchObject({ ok: false });
  });

  it('setBounds() positions in DIP using the main zoom factor; null hides without hanging up', async () => {
    await ctl.open('https://app.zoom.us/wc/join/123456789');
    const v = fx.created.views[0];
    ctl.setBounds({ x: 10, y: 20, width: 400, height: 300 });
    expect(v.bounds).toEqual({ x: 13, y: 25, width: 500, height: 375 });
    expect(v.visible).toBe(true);
    ctl.setBounds(null);
    expect(v.visible).toBe(false);
    expect(v.webContents.closed).toBe(false);
    expect(ctl.state()).toMatchObject({ open: true, visible: false, inMeeting: true });
  });

  it('detach() moves the SAME view into its own window (no reload); closing that window re-docks, not hangs up', async () => {
    await ctl.open('https://app.zoom.us/wc/join/123456789');
    const v = fx.created.views[0];
    ctl.detach({ floating: false });
    const w = fx.created.windows[0];
    expect(fx.main.contentView.children).toEqual([]);
    expect(w.contentView.children).toEqual([v]);
    expect(v.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(v.webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(ctl.state()).toMatchObject({ mode: 'detached', floating: false });
    w.close();
    expect(fx.main.contentView.children).toEqual([v]);
    expect(v.webContents.closed).toBe(false);
    expect(ctl.state()).toMatchObject({ open: true, mode: 'main', visible: false });
    expect(sent[sent.length - 1][0]).toBe('zoomMeet:state');
  });

  it('floating mini is a small always-on-top window and can switch to a normal window in place', async () => {
    await ctl.open('https://app.zoom.us/wc/join/123456789');
    ctl.detach({ floating: true });
    const w = fx.created.windows[0];
    expect(w.onTop).toBe(true);
    expect(w.getContentSize()).toEqual([420, 260]);
    ctl.detach({ floating: false });
    expect(fx.created.windows).toHaveLength(1);
    expect(w.onTop).toBe(false);
    expect(w.getContentSize()).toEqual([1280, 800]);
    ctl.dock();
    expect(w.destroyed).toBe(true);
    expect(ctl.state()).toMatchObject({ mode: 'main', open: true });
  });

  it('leave() closes the meeting webContents and any meeting window', async () => {
    await ctl.open('https://app.zoom.us/wc/join/123456789');
    const v = fx.created.views[0];
    ctl.detach({ floating: true });
    const w = fx.created.windows[0];
    expect(ctl.leave()).toMatchObject({ open: false, mode: 'main' });
    expect(v.webContents.closed).toBe(true);
    expect(w.destroyed).toBe(true);
    expect(fx.main.contentView.children).toEqual([]);
  });

  it('navigation guard: blocks non-zoom and zoommtg navigations; popups only for zoom', async () => {
    await ctl.open('https://app.zoom.us/wc/meetings');
    const wc = fx.created.views[0].webContents;
    const ev = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const e1 = ev(); wc.emit('will-navigate', e1, 'https://idp.federate.amazon.com/x'); expect(e1.prevented).toBe(false);
    const e2 = ev(); wc.emit('will-navigate', e2, 'zoommtg://zoom.us/join?confno=1'); expect(e2.prevented).toBe(true);
    const e3 = ev(); wc.emit('will-navigate', e3, 'https://example.com/'); expect(e3.prevented).toBe(true);
    expect(fx.electron.dialog.showMessageBox).toHaveBeenCalled();
    expect(fx.electron.shell.openExternal).not.toHaveBeenCalled();   // user cancelled the confirm
    expect(wc.openHandler({ url: 'https://app.zoom.us/popup' }).action).toBe('allow');
    expect(wc.openHandler({ url: 'https://example.com/' }).action).toBe('deny');
  });

  it('a crashed meeting view is cleaned up', async () => {
    await ctl.open('https://app.zoom.us/wc/join/123456789');
    fx.created.views[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(ctl.state().open).toBe(false);
  });
});
