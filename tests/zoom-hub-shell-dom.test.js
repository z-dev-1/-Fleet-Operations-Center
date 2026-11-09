// FEAT-A1 / design §13 (+ review F-6, F-12, F-16): hub shell with stub panels, view-change handling,
// connection card, stylesheet href, toolbar addTab wiring, data-logic helpers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createExtDom, createBus, ExtElement } from './fixtures/zoom/fake-dom-ext.js';

vi.mock('../renderer/src/js/zoom/studio-panel.js', () => ({
  mount: vi.fn((el) => { el.textContent = 'Not available yet.'; }),
  show: vi.fn(), hide: vi.fn(), stopAll: vi.fn(), destroy: vi.fn(),
}));

const require = createRequire(import.meta.url);
// bridge.js reads window.app.platform at import time (toolbar.js imports bridge.js).
if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
const studio = await import('../renderer/src/js/zoom/studio-panel.js');
const view = await import('../renderer/src/js/views/zoom-hub.js');
const logic = await import('../renderer/src/js/zoom/data-logic.js');

function fakeHub(statusResult = { ok: true, signedIn: false, checkedAt: 'x' }) {
  const unsub = vi.fn();
  return {
    unsub,
    status: vi.fn(async () => statusResult),
    connect: vi.fn(async () => ({ ok: true, signedIn: true })),
    onAuthChanged: vi.fn(() => unsub),
  };
}

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function mountHub(flags, hub = fakeHub()) {
  view._resetForTests();
  const { document, dom } = createExtDom();
  const bus = createBus();
  const addTab = vi.fn();
  const mount = new ExtElement('views-mount', 'div', dom);
  const h = view.init(mount, flags, { bus, addTab, zoomHub: hub, document });
  return { h, document, dom, bus, addTab, mount, hub };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('stub panels (F-6)', () => {
  it('every panel exposes mount/show/hide/stopAll/destroy; the real studio panel mounts with its honesty banner', async () => {
    // FEAT-A2 replaced the meetings / recordings stubs and FEAT-B1 the studio stub (same interface).
    for (const name of ['meetings-panel', 'recordings-panel', 'studio-panel']) {
      const m = await vi.importActual('../renderer/src/js/zoom/' + name + '.js');
      for (const fn of ['mount', 'show', 'hide', 'stopAll', 'destroy']) expect(typeof m[fn]).toBe('function');
    }
    const m = await vi.importActual('../renderer/src/js/zoom/studio-panel.js');
    const { document } = createExtDom();
    const el = document.createElement('div');
    m.mount(el, { zoomHub: {}, flags: {}, bus: createBus(), document, mediaDevices: {} });
    expect(el.textContent).toBe('');
    expect(el.querySelector('.zs-honesty')).not.toBe(null);
    m.destroy();
  });
});

describe('zoom-hub view shell', () => {
  it('appends #view-zoom hidden, adds the toolbar tab, injects the stylesheet once', () => {
    const { h, document, addTab, mount } = mountHub({ enabled: true, data: true, studio: true });
    expect(mount.children[0]).toBe(h.root);
    expect(h.root.id).toBe('view-zoom');
    expect(h.root.className).toBe('view');
    expect(h.root.style.display).toBe('none');
    expect(addTab).toHaveBeenCalledWith({ key: 'zoom', view: 'zoom', label: 'Zoom', icon: '🎥' });
    const links = document.head.children.filter((c) => c.tagName === 'LINK');
    expect(links.length).toBe(1);
    expect(links[0].rel).toBe('stylesheet');
    expect(links[0].href.endsWith('/renderer/src/css/zoom-hub.css')).toBe(true);
  });

  it('sub-tabs follow the flags (role=tablist/tab); the first is selected; panels mount', () => {
    const a = mountHub({ enabled: true, data: true, studio: false });
    let tabs = a.h.root.querySelectorAll('.zh-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Meetings', 'Recordings']);
    expect(a.h.root.querySelector('.zh-tabs').getAttribute('role')).toBe('tablist');
    expect(tabs.every((t) => t.getAttribute('role') === 'tab')).toBe(true);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(a.h.root.querySelector('#zh-panel-meetings').querySelector('.zh-panel-head').innerHTML).toContain('Upcoming');
    const b = mountHub({ enabled: true, data: false, studio: true });
    tabs = b.h.root.querySelectorAll('.zh-tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Studio']);
    expect(b.h.root.querySelector('.zh-conn')).toBe(null);
    expect(studio.mount).toHaveBeenCalledTimes(1);
  });

  it("to:'zoom' shows; to:'settings' keeps the view visible and stops the camera; to:'fleet' hides and stops", async () => {
    const { h, bus, hub } = mountHub({ enabled: true, data: true, studio: true });
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    expect(h.root.style.display).toBe('flex');
    expect(hub.onAuthChanged).toHaveBeenCalledTimes(1);
    bus.emit('ui:view-change', { to: 'settings' });
    expect(h.root.style.display).toBe('flex');
    expect(studio.stopAll).toHaveBeenCalledTimes(1);
    expect(hub.unsub).not.toHaveBeenCalled();
    bus.emit('ui:view-change', { to: 'fleet' });
    expect(h.root.style.display).toBe('none');
    expect(studio.stopAll).toHaveBeenCalledTimes(2);
    expect(hub.unsub).toHaveBeenCalledTimes(1);
  });

  it('connection card: status() on show -> Sign in + Connect; Connect calls connect() once', async () => {
    const { h, bus, hub } = mountHub({ enabled: true, data: true });
    const card = h.root.querySelector('.zh-conn');
    expect(card.innerHTML).toContain('Checking…');
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    expect(hub.status).toHaveBeenCalledWith({});
    expect(card.innerHTML).toContain('Sign in to Zoom');
    expect(card.innerHTML).toContain('data-action="connect"');
    card.dispatch('click', { target: { dataset: { action: 'connect' } } });
    expect(card.innerHTML).toContain('A Zoom window may open');
    await tick();
    expect(hub.connect).toHaveBeenCalledTimes(1);
    expect(card.innerHTML).toContain('Signed in to Zoom');
  });

  it('connection card: unreachable -> "Zoom unreachable (code)" + Retry (forces a status check)', async () => {
    const hub = fakeHub({ ok: true, signedIn: null, code: 'NETWORK', checkedAt: 'x' });
    const { h, bus } = mountHub({ enabled: true, data: true }, hub);
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    const card = h.root.querySelector('.zh-conn');
    expect(card.innerHTML).toContain('Zoom unreachable (NETWORK)');
    card.dispatch('click', { target: { dataset: { action: 'retry' } } });
    await tick();
    expect(hub.status).toHaveBeenLastCalledWith({ force: true });
  });

  it('onAuthChanged updates the card', async () => {
    let cb = null;
    const hub = fakeHub({ ok: true, signedIn: true, checkedAt: 'x' });
    hub.onAuthChanged = vi.fn((f) => { cb = f; return () => {}; });
    const { h, bus } = mountHub({ enabled: true, data: true }, hub);
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    cb({ signedIn: false, code: 'SIGN_IN_REQUIRED' });
    expect(h.root.querySelector('.zh-conn').innerHTML).toContain('Sign in to Zoom');
  });
});

describe('stylesheet href (F-12)', () => {
  it('cssHref(file:///…/renderer/src/js/views/zoom-hub.js) ends with /renderer/src/css/zoom-hub.css', () => {
    expect(view.cssHref('file:///C:/Fleet/renderer/src/js/views/zoom-hub.js').endsWith('/renderer/src/css/zoom-hub.css')).toBe(true);
    expect(view.cssHref('http://localhost:5173/js/views/zoom-hub.js')).toBe('http://localhost:5173/css/zoom-hub.css');
  });
  it('zoom-hub.js contains the literal Vite-safe expression', () => {
    const src = fs.readFileSync(require.resolve('../renderer/src/js/views/zoom-hub.js'), 'utf8');
    expect(src).toContain("new URL('../../css/zoom-hub.css', import.meta.url)");
    expect(fs.existsSync(require.resolve('../renderer/src/css/zoom-hub.css'))).toBe(true);
  });
});

describe('toolbar addTab wiring (FR-1.5)', () => {
  it('static tabs and addTab share _onTabClick; TAB_VIEW is extended; addTab is exported', () => {
    const src = fs.readFileSync(require.resolve('../renderer/src/js/components/toolbar.js'), 'utf8');
    expect(src).toMatch(/let _topbarEl = null;/);
    expect(src).toMatch(/function _onTabClick\(btn\)/);
    expect(src).toMatch(/btn\.addEventListener\('click', \(\) => _onTabClick\(btn\)\);[\s\S]*btn\.addEventListener\('click', \(\) => _onTabClick\(btn\)\);/);
    expect(src).toMatch(/export function addTab\(\{ key, view, label, icon \} = \{\}\)/);
    expect(src).toMatch(/TAB_VIEW\[key\] = view \|\| key;/);
    expect(src).toMatch(/bus\.emit\('ui:view-change', \{ from: 'fleet', to: view, tab: btn\.dataset\.view \}\);/);
  });
});

describe('data-logic', () => {
  it('esc() escapes & < > " \'', () => {
    expect(logic.esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(logic.esc(null)).toBe('');
  });
  it('codeMessage() has one fixed sentence per errors.js code; unknown -> Something went wrong (code)', () => {
    const { CODES } = require('../src/zoom/errors');
    for (const c of CODES) {
      const m = logic.codeMessage(c);
      expect(typeof m).toBe('string');
      expect(m.startsWith('Something went wrong (')).toBe(false);
    }
    expect(logic.codeMessage('WAT')).toBe('Something went wrong (WAT)');
    expect(logic.codeMessage('<x>')).toBe('Something went wrong (x)');
  });
  it('renderConnection covers every phase with buttons and a live status region', () => {
    for (const phase of ['checking', 'signed-in', 'signed-out', 'connecting', 'error']) {
      const html = logic.renderConnection({ phase, code: '<b>' });
      expect(html).toContain('role="status"');
      expect(html).not.toContain('<b>');
      for (const bad of ['Go live', 'Send to Zoom', 'Virtual camera: on']) expect(html).not.toContain(bad);
      if (phase !== 'checking') expect(html).toMatch(/<button type="button"[^>]*aria-label=/);
    }
  });
});
