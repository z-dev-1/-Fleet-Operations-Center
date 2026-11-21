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

function setup(extra = {}) {
  fx = createFakeElectron(Object.assign({
    urlFor: (url) => (signedIn ? url : 'https://login.ciam.daimlertruck.com/authorize?client_id=x'),
    onLoad: (win) => { if (signedIn) emitAuraSuccess(win.webContents, { body: responseBody }); },
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

  it('teardownAll closes an open sign-in window', async () => {
    signedIn = false;
    const p = session.openLoginWindow({});
    session.teardownAll();
    expect((await p).code).toBe('DTNA_SIGNIN_CANCELLED');
    expect(fx.windows[0].destroyed).toBe(true);
  });
});
