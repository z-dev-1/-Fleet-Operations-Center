// FEAT-A1 / AC-9 + design §6, §20 row: partition, seeding (incl. propagation ON, review F-7), hidden window,
// sign-in window, navigation guard, idle teardown, no scripting of Zoom pages.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, flush, settle, portalScript, fakeMainWindow,
} from './fixtures/zoom/fake-electron.js';
import { SENTINEL_URL, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
let fx; let logger; let restoreE; let S; let C; let seeder; let auth;

function setup(opts = {}) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron(opts);
  restoreE = installFakeElectron(require, fx.electron);
  S = require('../src/zoom/data/session');
  C = require('../src/zoom/constants');
  seeder = { calls: [], seedOrLegacy: vi.fn(async (ses, o, legacy) => { seeder.calls.push(o); await legacy(); return { ok: true }; }) };
  auth = { injectCookies: vi.fn(async () => {}) };
  S._setDeps({ seeder, auth });
}

afterEach(() => {
  vi.useRealTimers();
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

async function advanceUntil(cond, max = 400000, step = 250) {
  let t = 0;
  while (!cond() && t < max) { await vi.advanceTimersByTimeAsync(step); t += step; }
  if (!cond()) throw new Error('condition not met');
}

describe('isNavAllowed (strict hostname list + https:)', () => {
  it('matrix', () => {
    setup();
    const cases = [
      ['https://oauth.evil.test/', false],
      ['http://amazon.zoom.us', false],
      ['https://midway-auth.amazon.com', true],
      ['https://x.a2z.com', true],
      ['https://amazon.zoom.us/meeting', true],
      ['https://us02web.zoom.us/j/1', true],
      ['https://idp.amazon.dev/x', true],
      ['https://zoom.us.evil.test/', false],
      ['https://evilzoom.us/', false],
      ['javascript:alert(1)', false],
      ['not a url', false],
      [null, false],
    ];
    for (const [u, want] of cases) expect([u, C.isNavAllowed(u)]).toEqual([u, want]);
    expect(C.parseUrl('::bad::')).toBe(null);
  });
});

describe('partition + seeding', () => {
  it('requiring the module creates nothing; getSession() is lazy and memoized', () => {
    setup();
    expect(fx.calls.fromPartition.length).toBe(0);
    const a = S.getSession();
    const b = S.getSession();
    expect(a).toBe(b);
    expect(fx.calls.fromPartition).toEqual(['persist:fleet-zoom']);
  });

  it('denies every permission on the Zoom partition only (never defaultSession)', () => {
    setup();
    const ses = S.getSession();
    const cb = vi.fn();
    ses.permissionRequestHandler({}, 'media', cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(ses.permissionCheckHandler({}, 'media')).toBe(false);
    expect(fx.calls.throwsHit.filter((x) => x.startsWith('defaultSession'))).toEqual([]);
  });

  it('seedOrLegacy is called once per process with the injectCookies lambda (single-flight)', async () => {
    setup();
    await Promise.all([S.ensureSeeded('status'), S.ensureSeeded('connect')]);
    await S.ensureSeeded('capture');
    expect(seeder.seedOrLegacy).toHaveBeenCalledTimes(1);
    const [ses, o, legacy] = seeder.seedOrLegacy.mock.calls[0];
    expect(ses.partition).toBe('persist:fleet-zoom');
    expect(o).toEqual({ reason: 'zoom-status', partition: 'persist:fleet-zoom' });
    expect(typeof legacy).toBe('function');
    expect(auth.injectCookies).toHaveBeenCalledWith(ses);
    S.allowReseed();
    await S.ensureSeeded('rewarm');
    expect(seeder.seedOrLegacy).toHaveBeenCalledTimes(2);
  });

  it('a seeding failure is recoverable and logged as safeErr only', async () => {
    setup();
    seeder.seedOrLegacy.mockImplementationOnce(async () => { throw new Error('cookie file at ' + SENTINEL_URL); });
    await expect(S.ensureSeeded('status')).resolves.toBe(true);
    expect(containsSentinel(logger.text())).toBe(null);
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('propagation ON (real seeder): seedSession seeds the partition through the Amazon guard; the legacy lambda is not used', async () => {
    setup();
    const realSeeder = require('../src/auth/session-seeder');
    const set = [];
    const ses = S.getSession();
    ses.cookies.set = async (c) => { set.push(c.domain || c.url); };
    const fakeAuth = {
      injectCookies: vi.fn(async (g) => { await g.cookies.set({ url: 'https://midway-auth.amazon.com', domain: '.amazon.com', name: 'a', value: 'v' }); await g.cookies.set({ url: 'https://amazon.zoom.us', domain: '.zoom.us', name: 'z', value: 'v' }); }),
      postureTokenExpiryMin: () => null,
    };
    const legacy = vi.fn(async () => {});
    S._setDeps({ seeder: realSeeder, auth: { injectCookies: legacy }, seederDeps: { enabled: true, auth: fakeAuth, electron: fx.electron } });
    await S.ensureSeeded('connect');
    expect(legacy).not.toHaveBeenCalled();
    expect(fakeAuth.injectCookies).toHaveBeenCalledTimes(1);
    expect(set).toEqual(['.amazon.com']);   // the non-Amazon cookie is blocked by the guard
  });
});

describe('hidden window', () => {
  it('uses the design window options, mutes audio, denies window.open, hides on show; CDP before loadURL', async () => {
    vi.useFakeTimers();
    setup();
    let attachedAtLoad = null;
    fx = null;
    restoreE(); freshZoom(require);
    fx = createFakeElectron({ onLoad: (w) => { attachedAtLoad = w.webContents.debugger.isAttached(); } });
    restoreE = installFakeElectron(require, fx.electron);
    S = require('../src/zoom/data/session');
    S._setDeps({ seeder, auth });
    await settle(vi, S.withHiddenWindow(async (h) => { await S.load(h.win, 'https://amazon.zoom.us/profile'); }));
    const w = fx.windows[0];
    expect(w.options).toMatchObject({
      show: false, skipTaskbar: true, x: -32000, y: -32000, width: 1280, height: 800, focusable: false,
      webPreferences: { partition: 'persist:fleet-zoom', nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    expect(w.options.webPreferences.preload).toBeUndefined();
    expect(w.webContents.audioMuted).toBe(true);
    expect(w.webContents.windowOpenHandler({ url: 'https://amazon.zoom.us/x' })).toEqual({ action: 'deny' });
    expect(attachedAtLoad).toBe(true);
    w.show();
    expect(w.visible).toBe(false);
    expect(fx.calls.appOnce.some(([ev]) => ev === 'before-quit')).toBe(true);
  });

  it('blocks will-navigate / will-frame-navigate (main frame) / will-redirect outside NAV_HOST_ALLOW', async () => {
    vi.useFakeTimers();
    setup();
    await settle(vi, S.withHiddenWindow(async () => {}));
    const wc = fx.windows[0].webContents;
    expect(wc.navigateAttempt('will-navigate', 'https://oauth.evil.test/?' + SENTINEL_URL)).toBe(true);
    expect(wc.navigateAttempt('will-redirect', 'http://amazon.zoom.us/')).toBe(true);
    expect(wc.navigateAttempt('will-frame-navigate', 'https://oauth.evil.test/')).toBe(true);
    expect(wc.navigateAttempt('will-frame-navigate', 'https://oauth.evil.test/', { isMainFrame: false })).toBe(false);
    expect(wc.navigateAttempt('will-navigate', 'https://midway-auth.amazon.com/login')).toBe(false);
    expect(wc.navigateAttempt('will-redirect', 'https://amazon.zoom.us/profile')).toBe(false);
    const blocked = logger.lines.filter((l) => l.args[1] && l.args[1].op === 'nav-blocked');
    expect(blocked.length).toBe(3);
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('idle teardown after IDLE_TEARDOWN_MS detaches the debugger and destroys the window; next use re-creates', async () => {
    vi.useFakeTimers();
    setup();
    await settle(vi, S.withHiddenWindow(async () => {}));
    const w = fx.windows[0];
    expect(S.getCapture()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(299_000);
    expect(w.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(w.destroyed).toBe(true);
    expect(w.webContents.debugger.isAttached()).toBe(false);
    expect(S.getCapture()).toBe(null);
    await settle(vi, S.withHiddenWindow(async () => {}));
    expect(fx.windows.length).toBe(2);
    expect(vi.getTimerCount()).toBe(1);   // only the new idle timer
    S.teardownAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no timer exists before the first Zoom action', () => {
    vi.useFakeTimers();
    setup();
    S.getSession();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withHiddenWindow is serialized', async () => {
    vi.useFakeTimers();
    setup();
    const order = [];
    const a = S.withHiddenWindow(async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 1000)); order.push('a2'); });
    const b = S.withHiddenWindow(async () => { order.push('b'); });
    await settle(vi, Promise.all([a, b]));
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});

describe('connect()', () => {
  function signInScript() {
    const state = { signedIn: false };
    const script = portalScript({ signedIn: () => state.signedIn, pages: {} });
    return { state, script };
  }

  it('silent success on the hidden window -> {ok:true, signedIn:true} without a visible window', async () => {
    vi.useFakeTimers();
    setup(portalScript({ signedIn: true, pages: {} }));
    const r = await settle(vi, S.connect({ mainWindow: fakeMainWindow() }));
    expect(r).toEqual({ ok: true, signedIn: true });
    expect(fx.windows.length).toBe(1);
    expect(fx.windows[0].options.show).toBe(false);
    expect(fx.calls.executeJavaScript + fx.calls.insertText + fx.calls.sendInputEvent).toBe(0);
  });

  it('visible sign-in window: user signs in -> OK after the settle delay, window closed', async () => {
    vi.useFakeTimers();
    const { state, script } = signInScript();
    setup(script);
    const p = S.connect({ mainWindow: null });
    const second = S.connect({ mainWindow: null });
    expect(second).toBe(p);
    await advanceUntil(() => fx.windows.length === 2);
    const vis = fx.windows[1];
    expect(vis.options).toMatchObject({ width: 1000, height: 800, title: 'Sign in to Zoom (Fleet)', webPreferences: { partition: 'persist:fleet-zoom', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    expect(vis.webContents.getURL()).toMatch(/^https:\/\/midway-auth\.amazon\.com\//);
    // window.open is denied; an allowed URL loads in the same window, a disallowed one is ignored.
    expect(vis.webContents.windowOpenHandler({ url: 'https://oauth.evil.test/' })).toEqual({ action: 'deny' });
    expect(vis.webContents.windowOpenHandler({ url: 'https://midway-auth.amazon.com/sso' })).toEqual({ action: 'deny' });
    expect(vis.webContents.navigateAttempt('will-navigate', 'https://oauth.evil.test/')).toBe(true);
    await flush();
    expect(vis.webContents.getURL()).toBe('https://midway-auth.amazon.com/sso');
    S.connect({});
    expect(vis.focused).toBeGreaterThan(0);
    state.signedIn = true;
    vis.webContents._setURL('https://amazon.zoom.us/profile');
    const r = await settle(vi, p);
    expect(r).toEqual({ ok: true, signedIn: true });
    expect(vis.destroyed).toBe(true);
    expect(fx.calls.executeJavaScript + fx.calls.insertText + fx.calls.sendInputEvent).toBe(0);
  });

  it('user closes the sign-in window -> CANCELLED', async () => {
    vi.useFakeTimers();
    const { script } = signInScript();
    setup(script);
    const p = S.connect({});
    await advanceUntil(() => fx.windows.length === 2);
    fx.windows[1].close();
    expect(await settle(vi, p)).toEqual({ ok: false, code: 'CANCELLED' });
  });

  it('sign-in window timeout -> SIGN_IN_TIMEOUT and the window is closed', async () => {
    vi.useFakeTimers();
    const { script } = signInScript();
    setup(script);
    const p = S.connect({});
    await advanceUntil(() => fx.windows.length === 2);
    const r = await settle(vi, p, { step: 5000 });
    expect(r).toEqual({ ok: false, code: 'SIGN_IN_TIMEOUT' });
    expect(fx.windows[1].destroyed).toBe(true);
    expect(fx.calls.executeJavaScript).toBe(0);
  });

  it('waitForAuthed treats a portal sign-in path as not authed', () => {
    setup();
    expect(S.isAuthedUrl('https://amazon.zoom.us/profile')).toBe(true);
    expect(S.isAuthedUrl('https://amazon.zoom.us/signin?x=1')).toBe(false);
    expect(S.isAuthedUrl('https://amazon.zoom.us/saml/login')).toBe(false);
    expect(S.isAuthedUrl('https://midway-auth.amazon.com/')).toBe(false);
    expect(S.isAuthedUrl('http://amazon.zoom.us/profile')).toBe(false);
  });
});
