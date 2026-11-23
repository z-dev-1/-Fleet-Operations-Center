// Phase E step 6: src/dtna/auto-auth.js — background DTNA sign-in at startup, on 'expired' and from the
// SessionTimeServlet expiry timer. Real session + capture with the fake Electron; the auto-login engine
// and the servlet read are stubbed. Nothing here contacts DTNA.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeElectron, emitAuraSuccess, freshDtna, WT_ROOT } from './fixtures/dtna/fake-electron.js';

const require = createRequire(import.meta.url);

let session;
let capture;
let auth;
let C;
beforeAll(() => {
  freshDtna(require);
  session = require('../src/dtna/session.js');
  capture = require('../src/dtna/capture.js');
  auth = require('../src/dtna/auto-auth.js');
  C = require('../src/dtna/constants.js');
});
afterAll(() => { freshDtna(require); });

let fx;
let autoLogin;
let signedIn;
let reads;      // queue of servlet readings ({remainingSec} | 'expired'); default 28000 s
let st;
let ctx;

function setup(o = {}) {
  fx = createFakeElectron({
    urlFor: (url) => (signedIn ? url : 'https://login.ciam.daimlertruck.com/authorize?client_id=x'),
    // The Cases list page's own getItems POST (the hidden window loads LIST_URL).
    onLoad: (win) => { if (signedIn) emitAuraSuccess(win.webContents, { message: { actions: [{ id: '1;a', descriptor: C.LIST_ACTION_DESCRIPTOR, params: Object.assign({}, C.LIST_ACTION_PARAMS) }] } }); },
  });
  autoLogin = { attachAutoLogin: vi.fn(o.attach || (() => {})) };
  session._setDeps({ electron: fx.electron, autoLogin });
  st = {
    read: vi.fn(async () => {
      const next = reads.length ? reads.shift() : { remainingSec: 28000 };
      if (next === 'expired') { session.noteSessionTime({ remainingSec: 0, periodSec: 28800 }); return { ok: true, remainingSec: 0, periodSec: 28800, expired: true }; }
      session.noteSessionTime({ remainingSec: next.remainingSec, periodSec: 28800 });
      return { ok: true, remainingSec: next.remainingSec, periodSec: 28800, expired: false };
    }),
  };
  ctx = { mainWindow: null, sendToWindow: vi.fn() };
}
const start = () => auth.start(ctx, { session, sessionTime: st, electron: fx.electron });
const visible = () => fx.windows.filter((w) => w.options.show !== false);

beforeEach(() => {
  vi.useFakeTimers();
  auth._resetForTests();
  session._resetForTests();
  capture._resetForTests();
  signedIn = true;
  reads = [];
  setup();
});
afterEach(() => { auth._resetForTests(); session._resetForTests(); vi.useRealTimers(); });

describe('startup', () => {
  it('nothing before the delay; then ONE hidden sign-in with no click and no visible window; connected; servlet read once', async () => {
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS - 1);
    expect(fx.windows).toHaveLength(0);
    expect(autoLogin.attachAutoLogin).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(fx.windows).toHaveLength(1);
    expect(visible()).toHaveLength(0);
    expect(fx.windows[0].destroyed).toBe(true);
    expect(autoLogin.attachAutoLogin).toHaveBeenCalledWith(fx.windows[0], C.LIST_URL, { maxRetries: 2, onDone: expect.any(Function) });
    expect(session.status()).toMatchObject({ state: 'connected', expiresInSec: 28000 });
    expect(st.read).toHaveBeenCalledTimes(1);
    expect(ctx.sendToWindow).not.toHaveBeenCalled();     // no renderer round-trip involved
    expect(fx.calls.appOnce.some(([ev]) => ev === 'before-quit')).toBe(true);
    for (const w of fx.windows) expect(w.webContents.listenerNames).not.toContain('console-message');
  });

  it('start is idempotent (one startup timer)', async () => {
    start();
    expect(start()).toEqual({ ok: true, already: true });
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    expect(fx.windows).toHaveLength(1);
  });

  it('a sign-in step the auto-login cannot finish: action needed, never a visible window, no retry loop', async () => {
    signedIn = false;
    setup({ attach: (_w, _u, o) => { if (o && o.onDone) o.onDone({ success: false, error: 'bad_credentials' }); } });
    const pushes = [];
    session.onStatus((s) => pushes.push(s));
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 6000);
    expect(session.status()).toMatchObject({ state: 'signed-out', actionNeeded: true });
    await vi.advanceTimersByTimeAsync(60 * 60e3);
    expect(fx.windows).toHaveLength(1);
    expect(visible()).toHaveLength(0);
    expect(pushes.filter((s) => s.actionNeeded === true && s.state === 'signed-out')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('expiry timer (SessionTimeServlet)', () => {
  it('a reading arms one timer, a new reading replaces it; at expiry a re-read that is still out signs in once', async () => {
    reads = [{ remainingSec: 600 }];
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    expect(fx.windows).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    session.noteSessionTime({ remainingSec: 1200, periodSec: 28800 });
    expect(vi.getTimerCount()).toBe(1);
    reads = ['expired', { remainingSec: 28000 }];
    await vi.advanceTimersByTimeAsync(1200e3 + C.BG_EXPIRY_SLACK_MS - 1000);
    expect(fx.windows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(EXPIRED_WAIT);
    expect(fx.windows).toHaveLength(2);
    expect(visible()).toHaveLength(0);
    expect(session.status().state).toBe('connected');
    expect(vi.getTimerCount()).toBe(1);   // re-armed from the new reading
  });

  it('at expiry a re-read that shows the session was extended does not sign in', async () => {
    reads = [{ remainingSec: 600 }];
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    reads = [{ remainingSec: 20000 }];
    await vi.advanceTimersByTimeAsync(600e3 + C.BG_EXPIRY_SLACK_MS + 10);
    expect(st.read).toHaveBeenCalledTimes(2);
    expect(fx.windows).toHaveLength(1);
    expect(session.status()).toMatchObject({ state: 'connected', expiresInSec: 20000 });
  });
});

const EXPIRED_WAIT = 3100;

describe('expired status', () => {
  it('turning expired -> one re-login after the debounce; another expiry inside the min gap opens no window', async () => {
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    await vi.advanceTimersByTimeAsync(3 * 60e3);
    session.noteResult('DTNA_SESSION_EXPIRED');
    capture.clear();
    expect(session.status().state).toBe('expired');
    await vi.advanceTimersByTimeAsync(EXPIRED_WAIT);
    expect(fx.windows).toHaveLength(2);
    expect(session.status().state).toBe('connected');
    session.noteResult('DTNA_SESSION_EXPIRED');
    capture.clear();
    await vi.advanceTimersByTimeAsync(EXPIRED_WAIT);
    expect(fx.windows).toHaveLength(2);
    expect(visible()).toHaveLength(0);
  });

  it('stop() clears every timer and unsubscribes', async () => {
    reads = [{ remainingSec: 600 }];
    start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    expect(vi.getTimerCount()).toBe(1);
    auth.stop();
    expect(vi.getTimerCount()).toBe(0);
    session.noteResult('DTNA_SESSION_EXPIRED');
    await vi.advanceTimersByTimeAsync(10 * 60e3);
    expect(fx.windows).toHaveLength(1);
  });
});

describe('static guards', () => {
  it('auto-auth.js: no repeating timer, no visible sign-in, no console listener; app.js starts it once after the main window', () => {
    const src = fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'auto-auth.js'), 'utf8');
    for (const bad of ['setInterval', 'openLoginWindow', 'console-message', 'BrowserWindow']) expect(src, bad).not.toContain(bad);
    const app = fs.readFileSync(path.join(WT_ROOT, 'src', 'app.js'), 'utf8');
    expect(app.split("require('./dtna/auto-auth').start(_ctx)").length - 1).toBe(1);
    expect(app.indexOf("require('./dtna/auto-auth').start(_ctx)")).toBeGreaterThan(app.indexOf('_windowApi.createMainWindow();'));
  });
});
