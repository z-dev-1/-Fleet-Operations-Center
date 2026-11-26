// tests/dbr-view.test.js — first-class DBR tab: pure helpers (fleet-dbr-logic.js),
// the controller's view mode (fleet-dbr-panel.js: mounts in a container, auto-builds
// when fleet data is newer, falls back to the cached build on failure), the tab host
// (views/dbr-view.js) and static nav / Daily Call wiring. Node env + fake DOM, synthetic data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const B = vi.hoisted(() => ({ fleetDbr: {} }));
vi.mock('../renderer/src/js/bridge.js', () => B);
const BUS = vi.hoisted(() => ({ handlers: {}, emits: [] }));
vi.mock('../renderer/src/js/bus.js', () => ({
  default: {
    on: (ev, fn) => { (BUS.handlers[ev] = BUS.handlers[ev] || []).push(fn); return () => {}; },
    emit: (ev, p) => { BUS.emits.push([ev, p]); },
  },
}));
const STATE = vi.hoisted(() => ({ fleet: { syncedAt: '2026-11-10T16:05:00Z', lastSuccessfulSyncAt: '2026-11-10T16:00:00Z' } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { slice: (n) => ({ ...(STATE[n] || {}) }) } }));

const L = await import('../renderer/src/js/views/fleet-dbr-logic.js');
const P = await import('../renderer/src/js/views/fleet-dbr-panel.js');
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'renderer', 'src', 'js');

// ── fake DOM (same shape as tests/fleet-dbr-panel-dom.test.js) ───────────────
class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this.id = ''; this.className = ''; this._html = ''; this.textContent = '';
    this.style = {}; this.stubs = {};
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); this.children.push(n); n.parentNode = this; return n; }
  removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  async emit(t, ev) { for (const fn of this.listeners[t] || []) await fn(ev); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  _walk(fn) { for (const c of this.children) { const r = fn(c) || c._walk(fn); if (r) return r; } return null; }
  querySelector(sel) {
    if (sel[0] !== '#') return null;
    const hit = this._walk((c) => (c.id === sel.slice(1) ? c : null));
    if (hit) return hit;
    // innerHTML-created ids (dbr-view header/host): hand back a stable stub element.
    if (this._html.includes('id="' + sel.slice(1) + '"')) {
      if (!this.stubs[sel]) { this.stubs[sel] = new FakeEl('div', this.ownerDocument); this.stubs[sel].id = sel.slice(1); }
      return this.stubs[sel];
    }
    return null;
  }
}
function makeDoc() {
  const doc = { activeElement: null };
  doc.createElement = (t) => new FakeEl(t, doc);
  doc.body = new FakeEl('body', doc);
  return doc;
}
const flush = async (n = 200) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── fixture model + fake bridge ─────────────────────────────────────────────
const TODAY = '2026-11-10';
const BUILT = F.buildFleetDbr(makeFleetRows(), { today: TODAY });
BUILT.builtAt = '2026-11-10T15:31:00Z';
BUILT.fleetSyncedAt = '2026-11-10T15:30:00Z';
const cached = () => F.applyOverlays(BUILT, { today: TODAY, drafts: {}, flags: { aiDraft: false } });

let calls;
function makeApi({ build } = {}) {
  calls = [];
  const rec = (name, fn) => vi.fn(async (p) => { calls.push(name); return fn(p); });
  return {
    status: rec('status', () => ({ ok: true, enabled: true, aiDraft: false })),
    get: rec('get', () => ({ ok: true, model: cached() })),
    build: vi.fn((p) => { calls.push('build'); return build ? build(p) : Promise.resolve({ ok: true, model: Object.assign(cached(), { fleetSyncedAt: '2026-11-10T16:00:00Z', builtAt: '2026-11-10T16:01:00Z' }), saved: true }); }),
    saveEdit: rec('saveEdit', () => ({ ok: true })),
    resetRow: rec('resetRow', () => ({ ok: true })),
    setFasName: rec('setFasName', () => ({ ok: true, fasName: '' })),
    draft: rec('draft', () => ({ ok: false, code: 'off' })),
  };
}
function setupView({ fleetSyncedAt, build, buildTimeoutMs } = {}) {
  const api = makeApi({ build });
  const doc = makeDoc();
  const container = new FakeEl('div', doc);
  const bus = { on: vi.fn(() => () => {}) };
  const storage = { getItem: () => null, setItem: () => {} };
  const ctl = P.__test__.createController({
    api, doc, clipboard: { writeText: vi.fn(async () => true) }, storage, bus,
    mode: 'view', container, getFleetSyncedAt: () => fleetSyncedAt, buildTimeoutMs,
    now: () => Date.parse('2026-11-10T16:10:00Z'), // fleet data < 2 h old: no stale-data alert
  });
  return { ctl, doc, container, api };
}
const part = (t, id) => t.container.children[0].querySelector('#' + id);

afterEach(() => { vi.useRealTimers(); });

describe('logic helpers', () => {
  it('isFleetNewer compares parsed timestamps', () => {
    expect(L.isFleetNewer('2026-11-10T15:30:00Z', '2026-11-10T16:00:00Z')).toBe(true);
    expect(L.isFleetNewer('2026-11-10T15:30:00Z', '2026-11-10T15:30:00Z')).toBe(false);
    expect(L.isFleetNewer('2026-11-10T16:00:00Z', '2026-11-10T15:30:00Z')).toBe(false);
    expect(L.isFleetNewer('2026-11-10T15:30:00Z', null)).toBe(false);
    expect(L.isFleetNewer(null, '2026-11-10T15:30:00Z')).toBe(true);
    expect(L.isFleetNewer('x', 'y')).toBe(true);
    expect(L.isFleetNewer('x', 'x')).toBe(false);
  });
  it('fmtClock is local HH:MM or empty', () => {
    const d = new Date('2026-11-10T15:31:00Z');
    expect(L.fmtClock('2026-11-10T15:31:00Z')).toBe(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
    expect(L.fmtClock('nope')).toBe('');
    expect(L.fmtClock(null)).toBe('');
  });
  it('banners: loading copy and cached-fallback with a Rebuild button', () => {
    expect(L.refreshingBannerHtml()).toContain('Building DBR\u2026');
    const fb = L.fallbackBannerHtml('2026-11-10T15:31:00Z');
    expect(fb).toContain("Couldn't refresh \u2014 showing data from " + L.fmtClock('2026-11-10T15:31:00Z'));
    expect(fb).toContain('data-fdbr-action="build"');
    expect(fb).toContain('Rebuild');
    expect(L.fallbackBannerHtml(null)).toContain('the last build');
  });
  it('VIEW_CSS scopes every panel rule under #view-dbr', () => {
    expect(L.VIEW_CSS).not.toContain('#dbr-overlay');
    expect(L.VIEW_CSS).toContain('#view-dbr .dc-table');
    expect(L.VIEW_CSS).toContain('#view-dbr .fdbr-banner');
    expect(L.VIEW_CSS).toContain('#view-dbr .fdbr-scroll');
  });
  it('panelHtml view mode: VIEW_CSS, no close button, Rebuild label; default mode unchanged', () => {
    const v = L.panelHtml({ status: 'ready', mode: 'view' });
    expect(v).toContain('#view-dbr');
    expect(v).not.toContain('data-fdbr-action="close"');
    expect(v).toContain('\u21ba Rebuild');
    const o = L.panelHtml({ status: 'ready' });
    expect(o).toContain('#dbr-overlay');
    expect(o).toContain('data-fdbr-action="close"');
    expect(o).toContain('\u21ba Build from fleet data');
  });
});

describe('view controller', () => {
  it('mounts inside the container, not document.body, with no dialog role', async () => {
    const t = setupView({ fleetSyncedAt: BUILT.fleetSyncedAt });
    await t.ctl.open();
    expect(t.doc.body.children.length).toBe(0);
    expect(t.container.children.length).toBe(1);
    const root = t.container.children[0];
    expect(root.id).toBe('fdbr-view-root');
    expect(root.attrs.role).toBeUndefined();
    expect(part(t, 'fdbr-frame').innerHTML).not.toContain('data-fdbr-action="close"');
  });

  it('fleet data newer than the cached build -> auto fleet-dbr:build with a Building banner', async () => {
    let resolveBuild;
    const t = setupView({
      fleetSyncedAt: '2026-11-10T16:00:00Z',
      build: () => new Promise((r) => { resolveBuild = r; }),
    });
    const p = t.ctl.open();
    await flush();
    expect(calls).toEqual(['status', 'get', 'build']);
    expect(part(t, 'fdbr-banner').innerHTML).toContain('Building DBR\u2026');
    expect(part(t, 'fdbr-table').innerHTML).toContain('<table'); // cached rows stay visible
    resolveBuild({ ok: true, model: Object.assign(cached(), { fleetSyncedAt: '2026-11-10T16:00:00Z' }), saved: true });
    await p;
    expect(part(t, 'fdbr-banner').innerHTML).toBe('');
    expect(t.ctl.state.model.fleetSyncedAt).toBe('2026-11-10T16:00:00Z');
  });

  it('not stale -> shows the cached build, no build call', async () => {
    const t = setupView({ fleetSyncedAt: BUILT.fleetSyncedAt });
    await t.ctl.open();
    expect(calls).toEqual(['status', 'get']);
    expect(t.api.build).not.toHaveBeenCalled();
    expect(part(t, 'fdbr-table').innerHTML).toContain('<table');
  });

  const failing = {
    'resolves ok:false': () => Promise.resolve({ ok: false, code: 'internal' }),
    rejects: () => Promise.reject(new Error('session expired')),
  };
  for (const [name, build] of Object.entries(failing)) {
    it('build ' + name + ' -> cached table + "Couldn\'t refresh" banner', async () => {
      const t = setupView({ fleetSyncedAt: '2026-11-10T16:00:00Z', build });
      await t.ctl.open();
      expect(calls).toContain('build');
      expect(t.ctl.state.status).toBe('ready');
      expect(part(t, 'fdbr-table').innerHTML).toContain('<table');
      const banner = part(t, 'fdbr-banner').innerHTML;
      expect(banner).toContain("Couldn't refresh \u2014 showing data from " + L.fmtClock(BUILT.builtAt));
      expect(banner).toContain('data-fdbr-action="build"');
    });
  }

  it('build that never answers times out into the fallback banner (no hang)', async () => {
    vi.useFakeTimers();
    const t = setupView({ fleetSyncedAt: '2026-11-10T16:00:00Z', build: () => new Promise(() => {}), buildTimeoutMs: 5000 });
    const p = t.ctl.open();
    await flush();
    expect(part(t, 'fdbr-banner').innerHTML).toContain('Building DBR\u2026');
    await vi.advanceTimersByTimeAsync(5001);
    await p;
    expect(t.ctl.state.status).toBe('ready');
    expect(part(t, 'fdbr-table').innerHTML).toContain('<table');
    expect(part(t, 'fdbr-banner').innerHTML).toContain("Couldn't refresh");
  });

  it('manual Rebuild calls fleet-dbr:build and clears the fallback on success', async () => {
    let n = 0;
    const t = setupView({
      fleetSyncedAt: '2026-11-10T16:00:00Z',
      build: () => (++n === 1 ? Promise.resolve({ ok: false, code: 'timeout' }) : Promise.resolve({ ok: true, model: cached(), saved: true })),
    });
    await t.ctl.open();
    expect(part(t, 'fdbr-banner').innerHTML).toContain("Couldn't refresh");
    const el = { dataset: { fdbrAction: 'build' } };
    await t.container.children[0].emit('click', { target: { closest: () => el } });
    await flush();
    expect(n).toBe(2);
    expect(part(t, 'fdbr-banner').innerHTML).toBe('');
  });

  it('Escape and a root click do not close the view', async () => {
    const t = setupView({ fleetSyncedAt: BUILT.fleetSyncedAt });
    await t.ctl.open();
    const root = t.container.children[0];
    await root.emit('keydown', { key: 'Escape', preventDefault() {} });
    await root.emit('click', { target: root });
    expect(t.ctl.state.closed).toBe(false);
    expect(t.container.children.length).toBe(1);
  });
});

describe('dbr view host (views/dbr-view.js)', () => {
  it('mounts #view-dbr in the views container, opens on ui:view-change dbr, closes when leaving', async () => {
    const doc = makeDoc();
    globalThis.document = doc;
    const V = await import('../renderer/src/js/views/dbr-view.js');
    const container = new FakeEl('div', doc);
    const ctl = { close: vi.fn() };
    const openView = vi.fn(() => ctl);
    V.init(container, { openView });
    const el = container.children[0];
    expect(el.id).toBe('view-dbr');
    expect(el.className).toContain('view--dbr');
    expect(doc.body.children.length).toBe(0);
    expect(el.style.display).toBe('none');

    const fire = async (p) => { for (const fn of BUS.handlers['ui:view-change'] || []) await fn(p); };
    await fire({ to: 'dbr' });
    expect(el.style.display).toBe('flex');
    expect(openView).toHaveBeenCalledTimes(1);
    const [host, opts] = openView.mock.calls[0];
    expect(host.id).toBe('dbr-view-host');
    expect(opts.getFleetSyncedAt()).toBe('2026-11-10T16:00:00Z'); // lastSuccessfulSyncAt first
    await fire({ to: 'settings' });
    expect(el.style.display).toBe('flex');
    expect(ctl.close).not.toHaveBeenCalled();

    await fire({ to: 'fleet' });
    expect(el.style.display).toBe('none');
    expect(ctl.close).toHaveBeenCalledTimes(1);

    await fire({ to: 'dbr' });
    expect(openView).toHaveBeenCalledTimes(2); // re-checks staleness on every open
    delete globalThis.document;
  });
});

describe('static wiring', () => {
  const read = (...p) => fs.readFileSync(path.join(JS, ...p), 'utf8');
  it('toolbar has a DBR tab and programmatic tab selection', () => {
    const tb = read('components', 'toolbar.js');
    expect(tb).toContain("dbr:        'dbr'");
    expect(tb).toContain('data-view="dbr"');
    expect(tb).toContain("bus.on('ui:select-tab'");
  });
  it('app.js inits and routes the DBR view', () => {
    const app = read('app.js');
    expect(app).toContain("from './views/dbr-view.js'");
    expect(app).toContain('initDbrView(viewsMount)');
    expect(app).toContain("to === 'dbr'");
  });
  it('Daily Call DBR DATA routes to the DBR tab; WBR is still on Daily Call', () => {
    const dc = read('views', 'daily-call.js');
    expect(dc).toContain("bus.emit('ui:select-tab', { key: 'dbr' })");
    expect(dc).not.toContain('openFleetDbrPanel');
    expect(dc).toContain('\ud83d\udcca DBR DATA</button>');
    for (const s of ['id="dc-wbr-generate"', 'id="dc-wbr-copy"', 'id="dc-wbr-table"', 'WBR \u2014 Weekly Bridge Report']) expect(dc, s).toContain(s);
  });
  it('dbr-view.js has no quicksight reference', () => {
    expect(read('views', 'dbr-view.js')).not.toMatch(/quicksight/i);
  });
});
