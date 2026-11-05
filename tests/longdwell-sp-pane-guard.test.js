// tests/longdwell-sp-pane-guard.test.js - main-process guard for the sheet
// side panel <webview> (src/longdwell/pane-guard.js), plan A3.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const logCalls = [];
function fakeLogger() { const rec = (lvl) => (...a) => logCalls.push({ lvl, a }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; }
fakeLogger.createLogger = fakeLogger;
inject('../src/utils/logger', fakeLogger);
const G = require('../src/longdwell/pane-guard');

const SP = 'https://amazon.sharepoint.com/:x:/r/sites/Fleet/Shared%20Documents/T.xlsx?d=wabc&e=TOKEN';

function host() { return new EventEmitter(); }
function guest(prefs, throws) {
  const g = new EventEmitter();
  g.windowOpenHandler = null;
  g.setWindowOpenHandler = vi.fn((fn) => { g.windowOpenHandler = fn; });
  g.getLastWebPreferences = throws ? () => { throw new Error('x'); } : () => prefs;
  return g;
}
function attach(h, src, extra = {}) {
  const wp = { preload: 'file:///app/preload.js', preloadURL: 'file:///p.js', nodeIntegration: true, contextIsolation: false, webSecurity: false, ...extra.wp };
  const params = { src, partition: 'persist:aap', allowpopups: 'true', ...extra.params };
  h.emit('will-attach-webview', {}, wp, params);
  return { wp, params };
}
function nav(g, ev, url, isMainFrame) {
  const e = { preventDefault: vi.fn(), url };
  g.emit(ev, e, url, false, isMainFrame);
  return e;
}

let shell, t;
beforeEach(() => { logCalls.length = 0; shell = { openExternal: vi.fn(() => Promise.resolve()) }; t = 0; });
const deps = () => ({ shell, now: () => t });

describe('isAllowedPaneUrl', () => {
  it('allows SharePoint and the sign-in hosts', () => {
    for (const u of ['https://amazon.sharepoint.com/sites/x', 'https://x-my.sharepoint.com/personal/a', 'https://login.microsoftonline.com/common', 'https://aadcdn.msauth.net/x', 'https://midway-auth.amazon.com/login'])
      expect(G.isAllowedPaneUrl(u)).toBe(true);
  });
  it('denies other hosts, look-alikes, http, userinfo and javascript:', () => {
    for (const u of ['https://evil.example.com/', 'https://sharepoint.com.evil.com/', 'http://amazon.sharepoint.com/', 'https://user:pw@amazon.sharepoint.com/', 'javascript:alert(1)', '', null, 'not a url', 'https://amazon.sharepoint.com.evil.com/'])
      expect(G.isAllowedPaneUrl(u)).toBe(false);
  });
  it('classifyPaneNavigation', () => {
    expect(G.classifyPaneNavigation('https://amazon.sharepoint.com/x')).toBe('allow');
    expect(G.classifyPaneNavigation('https://evil.example.com/x')).toBe('external');
    expect(G.classifyPaneNavigation('http://evil.example.com/x')).toBe('deny');
    expect(G.classifyPaneNavigation('javascript:alert(1)')).toBe('deny');
  });
});

describe('marker correlation', () => {
  it('will-attach for SharePoint src: no partition, no preload, no preloadURL, no allowpopups, nodeIntegration false, contextIsolation true, marker added', () => {
    const h = host();
    G.installPaneGuard(h, deps());
    const { wp, params } = attach(h, SP, { wp: { additionalArguments: ['--keep'] } });
    expect('partition' in params).toBe(false);
    expect(params.allowpopups).toBeFalsy();
    expect('preload' in wp).toBe(false);
    expect('preloadURL' in wp).toBe(false);
    expect(wp).toMatchObject({ nodeIntegration: false, contextIsolation: true, webSecurity: true, sandbox: true });
    expect(wp.additionalArguments).toEqual(['--keep', G.MARKER]);
    expect(JSON.stringify(logCalls)).not.toMatch(/TOKEN|\?|Shared/);
  });
  it('empty / malformed src does not throw and is untouched', () => {
    const h = host();
    G.installPaneGuard(h, deps());
    for (const src of ['', 'not a url', undefined, 'https://']) {
      const wp0 = { preload: 'p', nodeIntegration: true };
      const p0 = { src, partition: 'persist:x', allowpopups: 'true' };
      expect(() => h.emit('will-attach-webview', {}, wp0, p0)).not.toThrow();
      expect(wp0).toEqual({ preload: 'p', nodeIntegration: true });
      expect(p0).toEqual({ src, partition: 'persist:x', allowpopups: 'true' });
    }
    expect(() => h.emit('will-attach-webview', {}, null, null)).not.toThrow();
  });
  it('a non-SharePoint webview attached before and after a SharePoint one is never hooked', () => {
    const h = host();
    G.installPaneGuard(h, deps());
    const a = attach(h, 'https://portal.vendor.example.com/unit/1');
    const ga = guest(a.wp);
    h.emit('did-attach-webview', {}, ga);
    const b = attach(h, SP);
    const gb = guest(b.wp);
    const c = attach(h, 'https://portal.vendor.example.com/unit/2');
    const gc = guest(c.wp);
    h.emit('did-attach-webview', {}, gc);
    h.emit('did-attach-webview', {}, gb);
    expect(a.params.partition).toBe('persist:aap');
    expect(a.wp.preload).toBe('file:///app/preload.js');
    expect(ga.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(gc.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(ga.listenerCount('will-navigate')).toBe(0);
    expect(gc.listenerCount('will-navigate')).toBe(0);
    expect(gb.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(gb.listenerCount('will-navigate')).toBe(1);
    expect(gb.listenerCount('will-redirect')).toBe(1);
  });
  it('did-attach hooks only marked guests', () => {
    const h = host();
    G.installPaneGuard(h, deps());
    const marked = guest({ additionalArguments: [G.MARKER] });
    const plain = guest({ additionalArguments: ['--other'] });
    h.emit('did-attach-webview', {}, plain);
    h.emit('did-attach-webview', {}, marked);
    expect(plain.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(marked.setWindowOpenHandler).toHaveBeenCalled();
  });
  it('unmarked/throwing getLastWebPreferences is not hooked', () => {
    const h = host();
    G.installPaneGuard(h, deps());
    const g1 = guest(null, true);
    const g2 = guest(undefined);
    const g3 = new EventEmitter();
    expect(() => { h.emit('did-attach-webview', {}, g1); h.emit('did-attach-webview', {}, g2); h.emit('did-attach-webview', {}, g3); h.emit('did-attach-webview', {}, null); }).not.toThrow();
    expect(g1.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(g2.setWindowOpenHandler).not.toHaveBeenCalled();
  });
  it('install is idempotent', () => {
    const h = host();
    expect(G.installPaneGuard(h, deps())).toBe(true);
    expect(G.installPaneGuard(h, deps())).toBe(false);
    expect(h.listenerCount('will-attach-webview')).toBe(1);
    expect(h.listenerCount('did-attach-webview')).toBe(1);
    expect(G.installPaneGuard(null)).toBe(false);
  });
});

describe('guest navigation', () => {
  function hooked() {
    const h = host();
    G.installPaneGuard(h, deps());
    const g = guest({ additionalArguments: [G.MARKER] });
    h.emit('did-attach-webview', {}, g);
    return g;
  }
  it('allowed navigations pass; disallowed are denied and https opened externally once per 2 s', () => {
    const g = hooked();
    expect(nav(g, 'will-navigate', 'https://amazon.sharepoint.com/sites/x').preventDefault).not.toHaveBeenCalled();
    expect(nav(g, 'will-redirect', 'https://login.microsoftonline.com/x', true).preventDefault).not.toHaveBeenCalled();
    expect(nav(g, 'will-navigate', 'https://evil.example.com/a?e=TOKEN').preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    t += 500;
    expect(nav(g, 'will-redirect', 'https://evil.example.com/b', true).preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    t += 2000;
    nav(g, 'will-navigate', 'https://evil.example.com/c');
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    t += 5000;
    expect(nav(g, 'will-navigate', 'http://evil.example.com/').preventDefault).toHaveBeenCalled();
    expect(nav(g, 'will-navigate', 'javascript:alert(1)').preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(logCalls.map((c) => c.a));
    expect(logged).toContain('evil.example.com');
    expect(logged).not.toMatch(/TOKEN|\/a\?/);
  });
  it('subframe redirects are not subject to the top-level check', () => {
    const g = hooked();
    expect(nav(g, 'will-redirect', 'https://evil.example.com/frame', false).preventDefault).not.toHaveBeenCalled();
  });
  it('window-open is denied; an https target opens externally', () => {
    const g = hooked();
    expect(g.windowOpenHandler({ url: 'https://evil.example.com/x' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example.com/x');
    t += 3000;
    expect(g.windowOpenHandler({ url: 'https://amazon.sharepoint.com/x' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    t += 3000;
    expect(g.windowOpenHandler({ url: 'file:///c:/x' })).toEqual({ action: 'deny' });
    expect(g.windowOpenHandler({ url: 'http://evil.example.com/' })).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
  });
});
