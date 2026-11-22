// Phase E step 9: src/aperia/auto-auth.js — the startup background sign-in (staggered after DTNA), the
// 'expired' re-login, the aperia:alert {type:'session'} pill push, and the watcher staying off.
// Real session + capture with the zoom fake Electron and a stubbed auto-login; nothing contacts Aperia.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeElectron, jwt, WT_ROOT } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const C = require('../src/aperia/constants');
const capture = require('../src/aperia/capture');
const session = require('../src/aperia/session');
const watcher = require('../src/aperia/watcher');
const auth = require('../src/aperia/auto-auth');
const DC = require('../src/dtna/constants');

const BEARER_HDR = jwt(3600, 'SENTINEL_BEARER');
const WS_URL = 'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + encodeURIComponent(jwt(3600, 'SENTINEL_WS').slice(7));
let fx; let ctx; let signedIn; let seq = 0;
function setup() {
  fx = createFakeElectron({
    onLoad(win, url) {
      if (!signedIn || url !== C.PORTAL_URL) return;
      const id = 'q' + (++seq);
      win.webContents.debugger.emitRequest({ requestId: id, url: 'https://amazon.aperiatech.com/api/v1/vehicles?page=0&size=25', method: 'GET', headers: { Authorization: BEARER_HDR } });
      win.webContents.debugger.emitResponse(id, '{}', { status: 200 });
      win.webContents.debugger.emit('message', {}, 'Network.webSocketCreated', { requestId: 'w' + id, url: WS_URL });
    },
  });
  session._setDeps({ electron: fx.electron, autoLogin: { attachAutoLogin: vi.fn(), isLoginPage: async () => false } });
  ctx = { mainWindow: null, sent: [], sendToWindow: (ch, p) => ctx.sent.push([ch, p]) };
}
const start = () => auth.start(ctx, { session, electron: fx.electron });

beforeEach(() => {
  vi.useFakeTimers();
  auth._resetForTests(); session._resetForTests(); capture._resetForTests(); watcher._resetForTests();
  signedIn = true;
  setup();
});
afterEach(() => { auth._resetForTests(); session._resetForTests(); capture._resetForTests(); watcher._resetForTests(); vi.useRealTimers(); });

describe('Aperia background sign-in triggers', () => {
  it('startup is staggered after DTNA; nothing before 25 s, then one hidden sign-in; status pushed as aperia:alert {type:session}', async () => {
    expect(C.BG_STARTUP_DELAY_MS).toBeGreaterThan(DC.BG_STARTUP_DELAY_MS);
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS - 1);
    expect(fx.windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0].options.show).toBe(false);
    expect(fx.windows[0].destroyed).toBe(true);
    expect(session.status().state).toBe('connected');
    const pushes = ctx.sent.filter((s) => s[0] === 'aperia:alert');
    expect(pushes.length).toBeGreaterThanOrEqual(2);              // connecting, connected
    expect(pushes.every((s) => JSON.stringify(s[1]) === '{"type":"session"}')).toBe(true);
    expect(watcher.status().alerts).toBe('off');                 // auth never turns the watcher on
    expect(fx.calls.appOnce.some(([ev]) => ev === 'before-quit')).toBe(true);
  });

  it('start is idempotent', async () => {
    start();
    expect(start()).toEqual({ ok: true, already: true });
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    expect(fx.windows).toHaveLength(1);
  });

  it('turning expired (a 401) -> one gated re-login after the debounce; another expiry inside the min gap opens none', async () => {
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    await vi.advanceTimersByTimeAsync(3 * 60e3);
    session.noteResult('APERIA_SESSION_EXPIRED');
    expect(session.status().state).toBe('expired');
    await vi.advanceTimersByTimeAsync(auth.EXPIRED_DEBOUNCE_MS + 10);
    expect(fx.windows).toHaveLength(2);
    expect(session.status().state).toBe('connected');
    session.noteResult('APERIA_SESSION_EXPIRED');
    await vi.advanceTimersByTimeAsync(auth.EXPIRED_DEBOUNCE_MS + 10);
    expect(fx.windows).toHaveLength(2);
    expect(fx.windows.every((w) => w.options.show === false)).toBe(true);
    expect(watcher.status().alerts).toBe('off');
  });

  it('after Sign out no trigger opens a window', async () => {
    start();
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    session.logout();
    await vi.advanceTimersByTimeAsync(60 * 60e3);
    expect(fx.windows).toHaveLength(1);
  });

  it('stop() leaves no timer', async () => {
    start();
    expect(vi.getTimerCount()).toBe(1);
    auth.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(C.BG_STARTUP_DELAY_MS + 10);
    expect(fx.windows).toHaveLength(0);
  });

  it('static: no repeating timer, no watcher start, no console listener; app.js starts it once, after the DTNA one', () => {
    const src = fs.readFileSync(path.join(WT_ROOT, 'src', 'aperia', 'auto-auth.js'), 'utf8');
    for (const bad of ['setInterval', 'console-message', 'openLoginWindow', 'watcher', 'BrowserWindow']) expect(src, bad).not.toContain(bad);
    const app = fs.readFileSync(path.join(WT_ROOT, 'src', 'app.js'), 'utf8');
    const call = "require('./aperia/auto-auth').start(_ctx)";
    expect(app.split(call).length - 1).toBe(1);
    expect(app.indexOf(call)).toBeGreaterThan(app.indexOf("require('./dtna/auto-auth').start(_ctx)"));
  });
});
