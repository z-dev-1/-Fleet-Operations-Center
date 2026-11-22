// Phase E step 8: src/aperia/session.js backgroundLogin — the HIDDEN portal sign-in (capture + stored-credential
// auto-login), reauth without a visible window, the action-needed latch, Sign out winning over background
// sign-in. Fakes only (zoom fake Electron, stubbed auto-login); nothing contacts Aperia.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, jwt, flush } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const C = require('../src/aperia/constants');
const capture = require('../src/aperia/capture');
const session = require('../src/aperia/session');
const watcher = require('../src/aperia/watcher');

const BEARER_HDR = jwt(3600, 'SENTINEL_BEARER');
const API = 'https://amazon.aperiatech.com/api/v1/vehicles?page=0&size=25';

let fx;
let autoLogin;
let signedIn;
let attachedAtLoad;
let seq = 0;
function traffic(win) {
  const id = 's' + (++seq);
  const dbg = win.webContents.debugger;
  dbg.emitRequest({ requestId: id, url: API, method: 'GET', headers: { Authorization: BEARER_HDR } });
  dbg.emitResponse(id, '{}', { status: 200 });
  if (socket) dbg.emit('message', {}, 'Network.webSocketCreated', { requestId: 'w' + id, url: WS_URL });
}
let socket = true;
const WS_URL = 'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + encodeURIComponent(jwt(3600, 'SENTINEL_WS').slice(7));
function setup(o = {}) {
  attachedAtLoad = [];
  fx = createFakeElectron({
    onLoad(win, url) {
      attachedAtLoad.push(win.webContents.debugger.attached);
      if (!win.webContents.reload) win.webContents.reload = () => { if (signedIn) traffic(win); };
      if (signedIn && url === C.PORTAL_URL) traffic(win);
    },
  });
  autoLogin = {
    attachAutoLogin: vi.fn(o.attach || (() => {})),
    isLoginPage: vi.fn(o.isLoginPage || (async () => false)),
  };
  session._setDeps({ electron: fx.electron, autoLogin });
}
const visible = () => fx.windows.filter((w) => w.options.show !== false);

beforeEach(() => { capture._resetForTests(); session._resetForTests(); watcher._resetForTests(); signedIn = true; socket = true; setup(); });
afterEach(() => { vi.useRealTimers(); session._resetForTests(); capture._resetForTests(); watcher._resetForTests(); });

describe('backgroundLogin', () => {
  it('a saved session resumes: hidden window, capture before the first load, Bearer captured, window destroyed', async () => {
    const seen = [];
    session.onStatus((s) => seen.push(s.state));
    expect(await session.backgroundLogin({ reason: 'startup' })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    const w = fx.windows[0];
    expect(w.options).toMatchObject({ show: false, skipTaskbar: true, x: -4000, y: -4000, paintWhenInitiallyHidden: true });
    expect(w.options.webPreferences).toEqual({ partition: 'persist:aperia', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false });
    expect(attachedAtLoad).toEqual([true]);
    expect(w.destroyed).toBe(true);
    expect(w.webContents.debugger.attached).toBe(false);
    expect(w.webContents.windowOpenHandler({ url: 'https://amazon.aperiatech.com/x' })).toEqual({ action: 'deny' });
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledWith(w, C.PORTAL_URL, { maxRetries: 2, onDone: expect.any(Function) });
    expect(capture.current()).toBeTruthy();
    expect(session.status().state).toBe('connected');
    expect(seen).toEqual(['connecting', 'connected']);
    // A Bearer is held: no window.
    expect(await session.backgroundLogin({ reason: 'expired' })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    expect(w.webContents.listenerCount('console-message')).toBe(0);
  });

  it('Bearer captured before the portal opens its alert socket: resolves ok at once, the hidden window waits up to BG_WS_GRACE_MS for the socket token, then closes', async () => {
    vi.useFakeTimers();
    socket = false;
    let r = null;
    session.backgroundLogin({ reason: 'startup' }).then((x) => { r = x; });
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toEqual({ ok: true });
    const w = fx.windows[0];
    expect(w.destroyed).toBe(false);
    expect(capture.wsToken()).toBeNull();
    w.webContents.debugger.emit('message', {}, 'Network.webSocketCreated', { requestId: 'late', url: WS_URL });
    expect(capture.wsToken()).toBeTruthy();
    expect(w.destroyed).toBe(true);
    // No socket at all: closed after the grace.
    session._resetForTests(); capture._resetForTests(); setup();
    session.backgroundLogin({ reason: 'startup' });
    await vi.advanceTimersByTimeAsync(C.BG_WS_GRACE_MS - 100);
    expect(fx.windows[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(fx.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('concurrent calls share one hidden window', async () => {
    const p1 = session.backgroundLogin({ reason: 'startup' });
    const p2 = session.backgroundLogin({ reason: 'expired' });
    expect(p2).toBe(p1);
    expect(await p1).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
  });

  it('the visible sign-in open -> APERIA_SIGNIN_IN_PROGRESS, no hidden window', async () => {
    signedIn = false;
    const p = session.openLoginWindow({});
    await flush();
    expect(await session.backgroundLogin({ reason: 'startup' })).toEqual({ ok: false, code: 'APERIA_SIGNIN_IN_PROGRESS' });
    expect(fx.windows).toHaveLength(1);
    fx.windows[0].close();
    await p;
  });

  it('an interactive challenge (auto-login gives up) -> action needed pushed exactly once across two attempts, never visible', async () => {
    vi.useFakeTimers();
    signedIn = false;
    setup({ attach: (_w, _u, o) => { if (o && o.onDone) o.onDone({ success: false, error: 'no_credentials' }); } });
    const pushes = [];
    session.onStatus((s) => pushes.push(s));
    let r1 = null;
    session.backgroundLogin({ reason: 'startup' }).then((r) => { r1 = r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r1).toEqual({ ok: false, code: 'APERIA_SIGNIN_ACTION_NEEDED' });
    expect(session.status()).toMatchObject({ state: 'signed-out', actionNeeded: true });
    expect(await session.backgroundLogin({ reason: 'expired' })).toEqual({ ok: false, code: 'AUTH_COOLDOWN' });
    await vi.advanceTimersByTimeAsync(C.BG_ACTION_COOLDOWN_MS + 1000);
    let r2 = null;
    session.backgroundLogin({ reason: 'expired' }).then((r) => { r2 = r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r2).toEqual({ ok: false, code: 'APERIA_SIGNIN_ACTION_NEEDED' });
    expect(fx.windows).toHaveLength(2);
    expect(visible()).toHaveLength(0);
    let transitions = 0;
    let prev = false;
    for (const s of pushes) { const a = s.actionNeeded === true; if (a && !prev) transitions++; prev = a; }
    expect(transitions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('out of time on the sign-in form -> action needed; off it -> APERIA_TIMEOUT', async () => {
    vi.useFakeTimers();
    signedIn = false;
    setup({ isLoginPage: async () => true });
    let r = null;
    session.backgroundLogin({ reason: 'startup' }).then((x) => { r = x; });
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS + 10);
    expect(r).toEqual({ ok: false, code: 'APERIA_SIGNIN_ACTION_NEEDED' });
    session._resetForTests();
    setup();
    session.backgroundLogin({ reason: 'startup' }).then((x) => { r = x; });
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS + 10);
    expect(r).toEqual({ ok: false, code: 'APERIA_TIMEOUT' });
    expect(session.status().actionNeeded).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('after Sign out -> APERIA_SIGNED_OUT with no window; a manual sign-in clears it', async () => {
    await session.backgroundLogin({ reason: 'startup' });
    session.logout();
    expect(capture.current()).toBeNull();
    expect(await session.backgroundLogin({ reason: 'expired' })).toEqual({ ok: false, code: 'APERIA_SIGNED_OUT' });
    expect(await session.reauth({})).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(fx.windows).toHaveLength(1);
    const p = session.openLoginWindow({});
    await flush();
    expect(await p).toEqual({ ok: true, state: 'connected' });
    fx.windows[1].close();
    capture.clear();
    session.noteResult('APERIA_SESSION_EXPIRED');
    expect((await session.backgroundLogin({ reason: 'expired' })).code).not.toBe('APERIA_SIGNED_OUT');
  });

  it('Sign out during a hidden sign-in cancels it: the window closes and nothing is captured', async () => {
    signedIn = false;
    const p = session.backgroundLogin({ reason: 'startup' });
    await flush();
    session.logout();
    expect(await p).toEqual({ ok: false, code: 'APERIA_SIGNIN_CANCELLED' });
    expect(fx.windows[0].destroyed).toBe(true);
    expect(capture.current()).toBeNull();
  });

  it('a successful background sign-in never turns the alert watcher on', async () => {
    expect(await session.backgroundLogin({ reason: 'startup' })).toEqual({ ok: true });
    expect(watcher.status().alerts).toBe('off');
  });
});

describe('reauth (a 401 / lost Bearer)', () => {
  it('no visible window -> ONE hidden window, no visible window, ok on capture; concurrent callers share it', async () => {
    const p1 = session.reauth({});
    const p2 = session.reauth({});
    expect(p2).toBe(p1);
    expect(await p1).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    expect(visible()).toHaveLength(0);
  });

  it('the visible window open -> reload, no hidden window', async () => {
    const login = session.openLoginWindow({});
    await flush();
    await login;
    session.noteResult('APERIA_SESSION_EXPIRED');
    let reloaded = 0;
    fx.windows[0].webContents.reload = () => { reloaded++; traffic(fx.windows[0]); };
    expect(await session.reauth({})).toEqual({ ok: true });
    expect(reloaded).toBe(1);
    expect(fx.windows).toHaveLength(1);
  });
});
