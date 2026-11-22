// Phase E step 2: src/orcha/auto-login.js runs unattended now (background sign-in), so its listeners must
// detach when it finishes and its log lines must never carry a URL query string.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { installFakeLogger, WT_ROOT } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
let logger;
let AL;
beforeAll(() => {
  logger = installFakeLogger(require);
  delete require.cache[require.resolve('../src/orcha/auto-login.js')];
  AL = require('../src/orcha/auto-login.js');
});
afterAll(() => { logger.restore(); delete require.cache[require.resolve('../src/orcha/auto-login.js')]; });
afterEach(() => { vi.useRealTimers(); logger.clear(); });

function fakeWin(url, onLoginPage) {
  const wc = new EventEmitter();
  wc.getURL = () => url;
  wc.executeJavaScript = async () => onLoginPage;
  return { webContents: wc, isDestroyed: () => false, loadURL: () => Promise.resolve() };
}
const EVENTS = ['did-finish-load', 'did-navigate', 'did-stop-loading'];

describe('attachAutoLogin cleanup', () => {
  it('after onDone (max retries on a login page) every listener is removed', async () => {
    const win = fakeWin('https://login.ciam.daimlertruck.com/authorize?code=SENTINEL_CODE', true);
    const done = vi.fn();
    AL.attachAutoLogin(win, 'https://dtna.my.site.com/Servicetracker/s/case/Case/Default', { maxRetries: 0, onDone: done });
    for (const e of EVENTS) expect(win.webContents.listenerCount(e)).toBe(1);
    win.webContents.emit('did-finish-load');
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done.mock.calls[0][0]).toMatchObject({ success: false, error: 'max_retries' });
    for (const e of EVENTS) expect(win.webContents.listenerCount(e)).toBe(0);
    expect(logger.text()).not.toContain('SENTINEL_CODE');
  });

  it('reaching the target logs origin + path only (no query) and detaches', async () => {
    vi.useFakeTimers();
    const target = 'https://dtna.my.site.com/Servicetracker/s/case/Case/Default?code=SENTINEL_CODE#state=SENTINEL_STATE';
    const win = fakeWin(target, false);
    const done = vi.fn();
    AL.attachAutoLogin(win, target, { maxRetries: 2, onDone: done });
    win.webContents.emit('did-stop-loading');
    await vi.advanceTimersByTimeAsync(3500);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0].success).toBe(true);
    for (const e of EVENTS) expect(win.webContents.listenerCount(e)).toBe(0);
    const t = logger.text();
    expect(t).toContain('https://dtna.my.site.com/Servicetracker/s/case/Case/Default');
    expect(t).not.toContain('SENTINEL_CODE');
    expect(t).not.toContain('SENTINEL_STATE');
  });

  it('static: no logged page-body snippet, no password length, _cleanup does not call itself', () => {
    const src = fs.readFileSync(path.join(WT_ROOT, 'src', 'orcha', 'auto-login.js'), 'utf8');
    expect(src).not.toContain('"ok:"+el.value.length');
    expect(src).not.toContain('body="');
    expect(src).not.toContain('url:location.href');
    const m = /function _cleanup\(\) \{([\s\S]*?)\n  \}/.exec(src);
    expect(m).toBeTruthy();
    expect(m[1]).not.toContain('_cleanup()');
  });
});
