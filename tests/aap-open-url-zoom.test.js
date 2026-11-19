// tests/aap-open-url-zoom.test.js — opt-in zoom for the in-app link window:
// src/window/zoom-controls.js (keyboard / Ctrl+wheel / overlay ipc), the
// aap:open-url handler in src/ipc/misc.js ({ zoom: true } only), and the
// overlay preload src/window/zoom-overlay-preload.js. Fakes only, no Electron.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'aap-open-url-zoom-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);

// ── electron stub (installed before misc.js / zoom-controls.js load) ─────────
const handlers = {};
const ipcOn = {};
const windows = [];
class FakeWC extends EventEmitter {
  constructor() { super(); this.id = FakeWC.next++; this.zoom = 1; this.sent = []; }
  getZoomFactor() { return this.zoom; }
  setZoomFactor(f) { this.zoom = f; }
  send(ch, v) { this.sent.push([ch, v]); }
  executeJavaScript() { return Promise.resolve(); }
  isDestroyed() { return false; }
}
FakeWC.next = 1;
class FakeBW {
  constructor(opts) { this.opts = opts; this.webContents = new FakeWC(); windows.push(this); }
  setMenuBarVisibility() {}
  loadURL(u) { this.url = u; }
  show() {}
  isDestroyed() { return false; }
}
const electronStub = {
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { ipcOn[ch] = fn; } },
  BrowserWindow: FakeBW,
  session: { defaultSession: { id: 'default' }, fromPartition: (p) => ({ id: p }) },
  Notification: { isSupported: () => false },
  app: { getPath: () => tmpDir, getVersion: () => '0.0.0' },
  shell: { openExternal: () => Promise.resolve() },
};
const resolved = require.resolve('electron');
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: electronStub };

const Z = require('../src/window/zoom-controls');

describe('zoom-controls', () => {
  let wc; let ipc; let on;
  beforeEach(() => {
    Z.__test__.reset();
    on = {};
    ipc = { on: (ch, fn) => { on[ch] = fn; } };
    wc = new FakeWC();
    Z.attachZoom(wc, { ipcMain: ipc });
  });
  const key = (k, mods = { control: true }) => {
    const ev = { preventDefault: vi.fn() };
    wc.emit('before-input-event', ev, Object.assign({ type: 'keyDown', key: k }, mods));
    return ev;
  };

  it('Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 step the factor and swallow the key', () => {
    let ev = key('=');
    expect(wc.zoom).toBe(1.1); expect(ev.preventDefault).toHaveBeenCalled();
    key('+'); expect(wc.zoom).toBe(1.2);
    key('-'); expect(wc.zoom).toBe(1.1);
    ev = key('0'); expect(wc.zoom).toBe(1); expect(ev.preventDefault).toHaveBeenCalled();
    key('=', { meta: true }); expect(wc.zoom).toBe(1.1);
    expect(wc.sent.at(-1)).toEqual(['fleet-zoom:changed', 1.1]);
  });
  it('ignores keys without Ctrl/Cmd, other keys and keyUp', () => {
    const ev = key('=', {});
    expect(ev.preventDefault).not.toHaveBeenCalled();
    key('a');
    wc.emit('before-input-event', { preventDefault() {} }, { type: 'keyUp', key: '=', control: true });
    expect(wc.zoom).toBe(1);
  });
  it('clamps at 0.5 and 3', () => {
    for (let i = 0; i < 40; i++) key('-');
    expect(wc.zoom).toBe(Z.ZOOM.MIN);
    for (let i = 0; i < 60; i++) key('=');
    expect(wc.zoom).toBe(Z.ZOOM.MAX);
  });
  it('Ctrl+wheel (zoom-changed) zooms in and out', () => {
    wc.emit('zoom-changed', {}, 'in'); expect(wc.zoom).toBe(1.1);
    wc.emit('zoom-changed', {}, 'out'); wc.emit('zoom-changed', {}, 'out'); expect(wc.zoom).toBe(0.9);
  });
  it('overlay ipc applies only for the attached sender, and not after destroyed', () => {
    on['fleet-zoom:step']({ sender: { id: wc.id } }, 'in');
    expect(wc.zoom).toBe(1.1);
    on['fleet-zoom:step']({ sender: { id: 9999 } }, 'in');
    expect(wc.zoom).toBe(1.1);
    on['fleet-zoom:step']({ sender: { id: wc.id } }, 'bogus');
    expect(wc.zoom).toBe(1.1);
    wc.emit('destroyed');
    on['fleet-zoom:step']({ sender: { id: wc.id } }, 'in');
    expect(wc.zoom).toBe(1.1);
  });
  it('stepZoom / clampZoom', () => {
    expect(Z.stepZoom(1, 'reset')).toBe(1);
    expect(Z.clampZoom(NaN)).toBe(1);
    expect(Z.clampZoom(10)).toBe(3);
  });
});

describe('aap:open-url handler', () => {
  require('../src/ipc/misc').registerMiscIPC({ sendToWindow() {}, mainWindow: null });
  const URL = 'https://aap-na.corp.amazon.com/v2/service/abc';
  it('{ zoom: true }: zoom preload + key/wheel listeners, same 1280x860 window', async () => {
    Z.__test__.reset();
    const r = await handlers['aap:open-url']({}, URL, { zoom: true });
    expect(r).toEqual({ ok: true });
    const w = windows.at(-1);
    expect(w.opts.width).toBe(1280);
    expect(w.opts.height).toBe(860);
    expect(w.opts.webPreferences.preload).toBe(Z.ZOOM_PRELOAD);
    expect(w.opts.webPreferences.contextIsolation).toBe(true);
    expect(w.webContents.listenerCount('before-input-event')).toBe(1);
    expect(w.webContents.listenerCount('zoom-changed')).toBe(1);
    expect(typeof ipcOn['fleet-zoom:step']).toBe('function');
    expect(w.url).toBe(URL);
  });
  it('without opts (every existing caller): no preload, no zoom listeners', async () => {
    await handlers['aap:open-url']({}, URL);
    const w = windows.at(-1);
    expect('preload' in w.opts.webPreferences).toBe(false);
    expect(w.webContents.listenerCount('before-input-event')).toBe(0);
    await handlers['aap:open-url']({}, URL, { zoom: 'yes' });
    expect('preload' in windows.at(-1).opts.webPreferences).toBe(false);
  });
});

describe('zoom overlay preload', () => {
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.textContent = ''; this.id = ''; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(t, fn) { this.listeners[t] = fn; }
  }
  it('adds #fleet-zoom-overlay with –/100%/+ buttons that send fleet-zoom:step', () => {
    const body = new El('body');
    const document = {
      readyState: 'complete', body, documentElement: body,
      createElement: (t) => new El(t),
      getElementById: (id) => body.children.find((c) => c.id === id) || null,
      addEventListener() {},
    };
    const sent = []; const onIpc = {};
    const ipcRenderer = { send: (ch, d) => sent.push([ch, d]), on: (ch, fn) => { onIpc[ch] = fn; } };
    const src = fs.readFileSync(path.join(path.dirname(Z.ZOOM_PRELOAD), 'zoom-overlay-preload.js'), 'utf8');
    vm.runInNewContext(src, { require: (m) => (m === 'electron' ? { ipcRenderer } : undefined), document, Number, Math });
    const box = document.getElementById('fleet-zoom-overlay');
    expect(box).toBeTruthy();
    expect(box.attrs.style).toContain('position:fixed');
    const btns = box.children.map((b) => b.attrs['data-zoom']);
    expect(btns).toEqual(['out', 'reset', 'in']);
    for (const b of box.children) b.listeners.click({ preventDefault() {} });
    expect(sent).toEqual([['fleet-zoom:step', 'out'], ['fleet-zoom:step', 'reset'], ['fleet-zoom:step', 'in']]);
    onIpc['fleet-zoom:changed']({}, 1.25);
    expect(box.children[1].textContent).toBe('125%');
  });
});
