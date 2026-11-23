// DTNA Phase A step 5: partition, visible sign-in window, hidden refresh, status (fake Electron).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, emitAuraSuccess, flush, freshDtna } from './fixtures/dtna/fake-electron.js';
import { apexError } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);

let session;
let capture;
let C;
beforeAll(() => {
  freshDtna(require);
  session = require('../src/dtna/session.js');
  capture = require('../src/dtna/capture.js');
  C = require('../src/dtna/constants.js');
});
afterAll(() => { freshDtna(require); });

let fx;
let autoLogin;
let signedIn;
let responseBody;

// The Cases list page's own getItems POST (the hidden window loads LIST_URL).
const listMessage = () => ({ actions: [{ id: '1;a', descriptor: C.LIST_ACTION_DESCRIPTOR, params: Object.assign({}, C.LIST_ACTION_PARAMS) }] });

function setup(extra = {}) {
  fx = createFakeElectron(Object.assign({
    urlFor: (url) => (signedIn ? url : 'https://login.ciam.daimlertruck.com/authorize?client_id=x'),
    onLoad: (win) => { if (signedIn) emitAuraSuccess(win.webContents, { body: responseBody, message: responseBody === undefined ? listMessage() : undefined }); },
  }, extra));
  autoLogin = { attachAutoLogin: vi.fn() };
  session._setDeps({ electron: fx.electron, autoLogin });
}

beforeEach(() => {
  session._resetForTests();
  capture._resetForTests();
  signedIn = true;
  responseBody = undefined;
  setup();
});
afterEach(() => { vi.useRealTimers(); session._resetForTests(); });

const noConsoleListener = () => {
  for (const w of fx.windows) expect(w.webContents.listenerNames).not.toContain('console-message');
};

describe('partition', () => {
  it('getSession is memoized persist:vendor-dtna with no permission handlers', () => {
    const s1 = session.getSession();
    const s2 = session.getSession();
    expect(s1).toBe(s2);
    expect(fx.calls.fromPartition).toEqual(['persist:vendor-dtna']);
    expect(s1.permissionHandlersSet).toBe(0);
  });
});

describe('openLoginWindow', () => {
  it('visible window, capture attached before the first loadURL, auto-login attached, resolves connected', async () => {
    const p = session.openLoginWindow({ mainWindow: null });
    expect(session.status().state).toBe('connecting');
    const r = await p;
    expect(r).toEqual({ ok: true, state: 'connected' });
    expect(fx.windows).toHaveLength(1);
    const w = fx.windows[0];
    expect(w.options).toMatchObject({ title: 'Sign in: DTNA Service Tracker', width: 1100, height: 850, show: true, autoHideMenuBar: true });
    expect(w.options.webPreferences).toEqual({ partition: 'persist:vendor-dtna', contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(w.options.webPreferences.preload).toBeUndefined();
    const id = w.webContents.id;
    expect(fx.calls.events.indexOf('attach:' + id)).toBeGreaterThan(-1);
    expect(fx.calls.events.indexOf('attach:' + id)).toBeLessThan(fx.calls.events.indexOf('loadURL:' + id));
    expect(w.loads[0]).toBe(C.LIST_URL);
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledWith(w, C.LIST_URL, { maxRetries: 2 });
    expect(w.destroyed).toBe(false); // stays open for the user
    expect(session.status().state).toBe('connected');
    expect(fx.calls.appOnce.some(([ev]) => ev === 'before-quit')).toBe(true);
    noConsoleListener();
  });

  it('popups are denied; DTNA and login URLs load in the same window', async () => {
    await session.openLoginWindow({});
    const w = fx.windows[0];
    expect(w.webContents.windowOpenHandler({ url: 'https://dtna.my.site.com/Servicetracker/s/x' })).toEqual({ action: 'deny' });
    expect(w.webContents.windowOpenHandler({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
    await flush();
    expect(w.loads).toEqual([C.LIST_URL, 'https://dtna.my.site.com/Servicetracker/s/x']);
  });

  it('single-flight while pending; a second call while the window is open focuses it', async () => {
    signedIn = false;
    const p1 = session.openLoginWindow({});
    const p2 = session.openLoginWindow({});
    expect(p1).toBe(p2);
    expect(fx.windows).toHaveLength(1);
    fx.windows[0].close();
    expect(await p1).toEqual({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' });
  });

  it('closed before a captured success -> DTNA_SIGNIN_CANCELLED, capture detached', async () => {
    signedIn = false;
    const p = session.openLoginWindow({});
    await flush();
    const w = fx.windows[0];
    expect(w.webContents.debugger.attached).toBe(true);
    w.close();
    expect(await p).toEqual({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' });
    expect(w.webContents.debugger.attached).toBe(false);
    expect(session.status().state).toBe('signed-out');
  });

  it('an ERROR aura response does not connect', async () => {
    responseBody = apexError();
    const p = session.openLoginWindow({});
    await flush(30);
    expect(capture.current()).toBeNull();
    fx.windows[0].close();
    expect((await p).code).toBe('DTNA_SIGNIN_CANCELLED');
  });

  it('times out after SIGNIN_WINDOW_MS, closes the window, leaves no timer', async () => {
    vi.useFakeTimers();
    signedIn = false;
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(C.SIGNIN_WINDOW_MS);
    expect(await p).toEqual({ ok: false, code: 'DTNA_SIGNIN_TIMEOUT' });
    expect(fx.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no timer keeps running after a successful sign-in', async () => {
    vi.useFakeTimers();
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('debugger attach failure -> DTNA_CAPTURE_FAILED and no loadURL', async () => {
    setup({ attachThrows: true });
    const r = await session.openLoginWindow({});
    expect(r).toEqual({ ok: false, code: 'DTNA_CAPTURE_FAILED' });
    expect(fx.windows[0].loads).toEqual([]);
    expect(fx.windows[0].destroyed).toBe(true);
  });
});

describe('ensureContext', () => {
  it('fresh capture -> ok without a window', async () => {
    await session.openLoginWindow({});
    const n = fx.windows.length;
    expect(await session.ensureContext()).toEqual({ ok: true });
    expect(fx.windows.length).toBe(n);
  });

  it('no capture -> single-flight hidden window, capture before load, destroyed after use', async () => {
    const p1 = session.ensureContext();
    const p2 = session.ensureContext();
    expect(p1).toBe(p2);
    expect(session.status().state).toBe('connecting');
    expect(await p1).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    const w = fx.windows[0];
    expect(w.options).toMatchObject({ show: false, x: -4000, y: -4000, width: 1400, height: 950, paintWhenInitiallyHidden: true });
    expect(w.options.webPreferences).toMatchObject({ partition: 'persist:vendor-dtna', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false });
    const id = w.webContents.id;
    expect(fx.calls.events.indexOf('attach:' + id)).toBeLessThan(fx.calls.events.indexOf('loadURL:' + id));
    expect(w.destroyed).toBe(true);
    expect(w.webContents.windowOpenHandler({ url: 'https://dtna.my.site.com/' })).toEqual({ action: 'deny' });
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledWith(w, C.LIST_URL, { maxRetries: 2 });
    expect(session.status().state).toBe('connected');
    noConsoleListener();
  });

  it('connected with no list template yet -> resolves at once; the hidden window waits on the Cases list for getItems, then closes', async () => {
    vi.useFakeTimers();
    responseBody = { actions: [{ id: '1;a', state: 'SUCCESS', returnValue: {} }] }; // a bootstrap POST, no getItems
    const p = session.ensureContext();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toEqual({ ok: true });
    expect(session.status().state).toBe('connected');
    const w = fx.windows[0];
    expect(w.destroyed).toBe(false);
    expect(capture.getItemsTemplate()).toBeNull();
    // The page's own list POST lands: the template commits and the window closes.
    emitAuraSuccess(w.webContents, { message: listMessage() });
    await vi.advanceTimersByTimeAsync(10);
    expect(capture.getItemsTemplate()).not.toBeNull();
    expect(capture.listInfo()).toEqual({ entity: 'Case', filter: 'default' });
    expect(w.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no getItems ever -> the hidden window closes after the list wait (20 s), no timer left', async () => {
    vi.useFakeTimers();
    responseBody = { actions: [{ id: '1;a', state: 'SUCCESS', returnValue: {} }] };
    const p = session.ensureContext();
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toEqual({ ok: true });
    expect(fx.windows[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(20e3);
    expect(fx.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('force opens a hidden window even with a fresh capture', async () => {
    await session.ensureContext();
    await session.ensureContext({ force: true });
    expect(fx.windows).toHaveLength(2);
    expect(fx.windows.every((w) => w.destroyed)).toBe(true);
  });

  it('lands on a login host -> DTNA_SIGNIN_REQUIRED after HIDDEN_WAIT_MS, window destroyed, no timer left', async () => {
    vi.useFakeTimers();
    signedIn = false;
    const p = session.ensureContext();
    await vi.advanceTimersByTimeAsync(C.HIDDEN_WAIT_MS);
    expect(await p).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(fx.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    noConsoleListener();
  });

  it('stays on DTNA without a successful aura POST -> DTNA_TIMEOUT', async () => {
    vi.useFakeTimers();
    setup({ onLoad: () => {} });
    const p = session.ensureContext();
    await vi.advanceTimersByTimeAsync(C.HIDDEN_WAIT_MS);
    expect(await p).toEqual({ ok: false, code: 'DTNA_TIMEOUT' });
  });
});

describe('Phase D: canAutoSync and silent ensureContext (sync pass)', () => {
  const hiddenAutoLogins = (win) => autoLogin.attachAutoLogin.mock.calls.filter((c) => c[0] === win).length;

  it('never signed in this run -> silent runs one HIDDEN background sign-in (auto-login with onDone) and connects', async () => {
    expect(session.canAutoSync()).toBe(false);
    expect(await session.ensureContext({ silent: true })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    const w = fx.windows[0];
    expect(w.options.show).toBe(false);
    expect(w.options).toMatchObject({ skipTaskbar: true, x: -4000, y: -4000 });
    expect(w.destroyed).toBe(true);
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledWith(w, C.LIST_URL, { maxRetries: 2, onDone: expect.any(Function) });
    expect(session.status().state).toBe('connected');
    expect(session.canAutoSync()).toBe(true);
    // Connected with a fresh capture: a second silent call opens nothing.
    expect(await session.ensureContext({ silent: true })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    noConsoleListener();
  });

  it('never signed in and the hidden sign-in needs the user -> DTNA_SIGNIN_REQUIRED + actionNeeded; a second silent call inside the cooldown opens no window', async () => {
    vi.useFakeTimers();
    signedIn = false;
    let done = null;
    session.ensureContext({ silent: true }).then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS);
    expect(done).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(session.status()).toMatchObject({ state: 'signed-out', actionNeeded: true });
    expect(await session.ensureContext({ silent: true })).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows.every((w) => w.options.show === false && w.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('signed in -> canAutoSync true; marked expired -> false and silent re-signs in through one hidden window', async () => {
    await session.openLoginWindow({});
    expect(session.canAutoSync()).toBe(true);
    session.noteResult('DTNA_SESSION_EXPIRED');
    expect(session.canAutoSync()).toBe(false);
    capture.clear();
    expect(await session.ensureContext({ silent: true })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(2);
    expect(fx.windows[1].options.show).toBe(false);
    expect(fx.windows[1].destroyed).toBe(true);
    expect(session.canAutoSync()).toBe(true);
  });

  it('a session-time reading at 0 s left -> canAutoSync false', async () => {
    await session.openLoginWindow({});
    session.noteSessionTime({ remainingSec: 0, periodSec: 28800 });
    expect(session.canAutoSync()).toBe(false);
    session.noteSessionTime({ remainingSec: 600, periodSec: 28800 });
    expect(session.canAutoSync()).toBe(true);
  });

  it('while the sign-in window is in progress, silent opens no window', async () => {
    await session.openLoginWindow({});
    session.noteResult('OK');
    signedIn = false;
    capture.clear();
    fx.windows[0].close();
    const p = session.openLoginWindow({});
    expect(session.canAutoSync()).toBe(false);
    expect(await session.ensureContext({ silent: true })).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(fx.windows).toHaveLength(2);
    fx.windows[1].close();
    await p;
  });

  it('signed in with a capture older than 30 min -> one hidden window, no auto-login on it', async () => {
    vi.useFakeTimers();
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    vi.setSystemTime(Date.now() + C.CONTEXT_MAX_AGE_MS + 1000);
    const q = session.ensureContext({ silent: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(await q).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(2);
    const hidden = fx.windows[1];
    expect(hidden.options.show).toBe(false);
    expect(hidden.destroyed).toBe(true);
    expect(hiddenAutoLogins(hidden)).toBe(0);
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledTimes(1); // the visible sign-in window only
  });

  it('silent refresh resting on a login host gives up well before HIDDEN_WAIT_MS, then ONE hidden background sign-in -> DTNA_SIGNIN_REQUIRED + actionNeeded', async () => {
    vi.useFakeTimers();
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    signedIn = false;
    vi.setSystemTime(Date.now() + C.CONTEXT_MAX_AGE_MS + 1000);
    let done = null;
    session.ensureContext({ silent: true }).then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(6000);
    const hidden = fx.windows[1];
    expect(hidden.destroyed).toBe(true);
    expect(hiddenAutoLogins(hidden)).toBe(0);
    expect(fx.windows).toHaveLength(3);
    const bg = fx.windows[2];
    expect(bg.options.show).toBe(false);
    expect(hiddenAutoLogins(bg)).toBe(1);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS);
    expect(done).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(bg.destroyed).toBe(true);
    expect(session.status().actionNeeded).toBe(true);
    fx.windows[0].close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a non-silent hidden refresh on a login host still waits HIDDEN_WAIT_MS and keeps auto-login', async () => {
    vi.useFakeTimers();
    signedIn = false;
    let done = null;
    session.ensureContext().then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(6000);
    expect(done).toBeNull();
    expect(hiddenAutoLogins(fx.windows[0])).toBe(1);
    await vi.advanceTimersByTimeAsync(C.HIDDEN_WAIT_MS);
    expect(done).toEqual({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
  });
});

describe('Phase E: backgroundLogin (startup / expiry / sync re-login)', () => {
  const visible = () => fx.windows.filter((w) => w.options.show !== false);
  const challengeLogin = () => {
    autoLogin = { attachAutoLogin: vi.fn((_w, _u, o) => { if (o && o.onDone) o.onDone({ success: false, error: 'bad_credentials' }); }) };
    session._setDeps({ electron: fx.electron, autoLogin });
  };

  it('a saved session resumes: one hidden window captures, status connected, no visible window', async () => {
    const seen = [];
    session.onStatus((s) => seen.push(s.state));
    expect(await session.backgroundLogin({ reason: 'startup' })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    expect(visible()).toHaveLength(0);
    expect(fx.windows[0].destroyed).toBe(true);
    const id = fx.windows[0].webContents.id;
    expect(fx.calls.events.indexOf('attach:' + id)).toBeLessThan(fx.calls.events.indexOf('loadURL:' + id));
    expect(session.status().state).toBe('connected');
    expect(session.status().actionNeeded).toBeUndefined();
    expect(seen).toEqual(['connecting', 'connected']);
    // Already connected with a fresh capture: no window at all.
    expect(await session.backgroundLogin({ reason: 'expiry' })).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
    noConsoleListener();
  });

  it('concurrent calls share one hidden window', async () => {
    const p1 = session.backgroundLogin({ reason: 'startup' });
    const p2 = session.backgroundLogin({ reason: 'sync' });
    const p3 = session.ensureContext({ silent: true });
    expect(p2).toBe(p1);
    expect(await p1).toEqual({ ok: true });
    expect(await p3).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(1);
  });

  it('the visible sign-in in progress -> DTNA_SIGNIN_IN_PROGRESS, no hidden window', async () => {
    signedIn = false;
    const p = session.openLoginWindow({});
    expect(await session.backgroundLogin({ reason: 'startup' })).toEqual({ ok: false, code: 'DTNA_SIGNIN_IN_PROGRESS' });
    expect(fx.windows).toHaveLength(1);
    fx.windows[0].close();
    await p;
  });

  it('an interactive challenge (auto-login gives up) -> action needed pushed exactly once across two attempts, never a visible window', async () => {
    vi.useFakeTimers();
    signedIn = false;
    challengeLogin();
    const seen = [];
    session.onStatus((s) => seen.push(s));
    let r1 = null;
    session.backgroundLogin({ reason: 'startup' }).then((r) => { r1 = r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r1).toEqual({ ok: false, code: 'DTNA_SIGNIN_ACTION_NEEDED' });
    expect(session.status()).toMatchObject({ state: 'signed-out', actionNeeded: true });
    // Inside the 30 min cooldown: gated, no window.
    await vi.advanceTimersByTimeAsync(10 * 60e3);
    expect(await session.backgroundLogin({ reason: 'sync' })).toEqual({ ok: false, code: 'AUTH_COOLDOWN' });
    expect(fx.windows).toHaveLength(1);
    // After the cooldown: one quiet retry, still latched, no second "action needed" transition.
    await vi.advanceTimersByTimeAsync(C.BG_ACTION_COOLDOWN_MS);
    let r2 = null;
    session.backgroundLogin({ reason: 'expiry' }).then((r) => { r2 = r; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r2).toEqual({ ok: false, code: 'DTNA_SIGNIN_ACTION_NEEDED' });
    expect(fx.windows).toHaveLength(2);
    expect(visible()).toHaveLength(0);
    let transitions = 0;
    let prev = false;
    for (const s of seen) { const a = s.actionNeeded === true; if (a && !prev) transitions++; prev = a; }
    expect(transitions).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    noConsoleListener();
  });

  it('timeout off a login host -> DTNA_TIMEOUT (no action needed) and a 5 min cooldown', async () => {
    vi.useFakeTimers();
    setup({ onLoad: () => {} });
    let r = null;
    session.backgroundLogin({ reason: 'startup' }).then((x) => { r = x; });
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS);
    expect(r).toEqual({ ok: false, code: 'DTNA_TIMEOUT' });
    expect(session.status().actionNeeded).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3 * 60e3);
    expect(await session.backgroundLogin({ reason: 'sync' })).toEqual({ ok: false, code: 'AUTH_COOLDOWN' });
    expect(fx.windows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * 60e3 + 1000);
    session.backgroundLogin({ reason: 'sync' });
    await vi.advanceTimersByTimeAsync(10);
    expect(fx.windows).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(C.BG_LOGIN_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a manual Sign in clears actionNeeded', async () => {
    vi.useFakeTimers();
    signedIn = false;
    challengeLogin();
    session.backgroundLogin({ reason: 'startup' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.status().actionNeeded).toBe(true);
    signedIn = true;
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toEqual({ ok: true, state: 'connected' });
    expect(session.status().actionNeeded).toBeUndefined();
    expect(Object.keys(session.status()).sort()).toEqual(['contextAgeSec', 'lastCode', 'lastPullAt', 'ok', 'state']);
  });
});

describe('status', () => {
  it('signed-out -> connecting -> connected -> expired -> pulling, emitted on every change', async () => {
    const seen = [];
    const off = session.onStatus((s) => seen.push(s.state));
    expect(session.status()).toEqual({ ok: true, state: 'signed-out', contextAgeSec: null, lastPullAt: null, lastCode: null });
    await session.openLoginWindow({});
    expect(session.status().state).toBe('connected');
    expect(typeof session.status().contextAgeSec).toBe('number');
    session.noteResult('DTNA_SIGNIN_REQUIRED');
    expect(session.status()).toMatchObject({ state: 'expired', lastCode: 'DTNA_SIGNIN_REQUIRED' });
    session.noteResult('OK');
    expect(session.status().state).toBe('connected');
    session.setPulling(true);
    expect(session.status().state).toBe('pulling');
    session.notePulled('2026-09-24T12:00:00.000Z');
    session.setPulling(false);
    expect(session.status()).toMatchObject({ state: 'connected', lastPullAt: '2026-09-24T12:00:00.000Z' });
    expect(seen).toEqual(['connecting', 'connected', 'expired', 'connected', 'pulling', 'connected']);
    off();
    session.setPulling(true);
    expect(seen).toHaveLength(6);
  });

  it('a capture older than 30 min reads as expired; a cleared capture after sign-in reads as expired', async () => {
    vi.useFakeTimers();
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(session.status().state).toBe('connected');
    vi.setSystemTime(Date.now() + C.CONTEXT_MAX_AGE_MS + 1000);
    expect(session.status().state).toBe('expired');
    capture.clear();
    expect(session.status().state).toBe('expired');
  });

  it('status never contains captured values', async () => {
    await session.openLoginWindow({});
    expect(JSON.stringify(session.status())).not.toMatch(/TOKEN|CTX/);
  });

  it('session-time reading (Phase C): drives expiry instead of the capture age; a new capture clears it', async () => {
    vi.useFakeTimers();
    const seen = [];
    session.onStatus((s) => seen.push(s));
    const p = session.openLoginWindow({});
    await vi.advanceTimersByTimeAsync(10);
    await p;
    // Without a reading the status shape is exactly the old one.
    expect(Object.keys(session.status()).sort()).toEqual(['contextAgeSec', 'lastCode', 'lastPullAt', 'ok', 'state']);
    vi.setSystemTime(Date.now() + 31 * 60e3);
    expect(session.status().state).toBe('expired');
    const n = seen.length;
    session.noteSessionTime({ remainingSec: 600.7, periodSec: 28800 });
    expect(seen.length).toBe(n + 1);                         // pushed even when the state is unchanged
    expect(session.status()).toMatchObject({ state: 'connected', expiresInSec: 600 });
    expect(session.status().sessionCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    vi.setSystemTime(Date.now() + 300e3);
    expect(session.status().expiresInSec).toBe(300);
    vi.setSystemTime(Date.now() + 301e3);
    expect(session.status()).toMatchObject({ state: 'expired', expiresInSec: 0 });
    session.noteSessionTime({ remainingSec: 900, periodSec: 28800 });
    expect(session.status().state).toBe('connected');
    session.noteResult('DTNA_SESSION_EXPIRED');
    expect(session.status().state).toBe('expired');
    session.noteResult('OK');
    expect(session.status().state).toBe('connected');
    expect(JSON.stringify(session.status())).not.toMatch(/TOKEN|CTX/);
    // A new sign-in capture starts a new session: the reading is dropped.
    capture.clear();
    session.ensureContext();
    await vi.advanceTimersByTimeAsync(10);
    expect(session.status().expiresInSec).toBeUndefined();
    expect(Object.keys(session.status()).sort()).toEqual(['contextAgeSec', 'lastCode', 'lastPullAt', 'ok', 'state']);
  });

  it('a zero reading before any sign-in reads as signed-out', () => {
    session.noteSessionTime({ remainingSec: 0, periodSec: null });
    expect(session.status()).toMatchObject({ state: 'signed-out', expiresInSec: 0 });
    session.noteSessionTime({ remainingSec: 'x' });
    expect(session.status().expiresInSec).toBe(0);
  });

  it('teardownAll closes an open sign-in window', async () => {
    signedIn = false;
    const p = session.openLoginWindow({});
    session.teardownAll();
    expect((await p).code).toBe('DTNA_SIGNIN_CANCELLED');
    expect(fx.windows[0].destroyed).toBe(true);
  });
});
