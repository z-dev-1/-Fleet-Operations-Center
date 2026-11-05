// tests/longdwell-sp-transport.test.js - hidden SharePoint window transport
// (src/scrapers/sp_sheet_transport.js): landing classification, SSO settle
// state machine (plan A4), once-only page function, window cleanup, timeouts,
// shared write lock, and no URL query / cell text in logs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }

// ── electron fake ───────────────────────────────────────────────────────────
const windows = [];
let pageHandlers = {};
class FakeWebContents extends EventEmitter {
  constructor() { super(); this.url = ''; this.scripts = []; }
  getURL() { return this.url; }
  executeJavaScript(script) {
    this.scripts.push(script);
    const m = /;(sp[A-Za-z]+)\((.*)\)$/s.exec(script);
    const fn = m && m[1];
    const cfg = m ? JSON.parse(m[2]) : null;
    const h = pageHandlers[fn];
    if (!h) return Promise.resolve({ ok: false, code: 'no-handler' });
    try { return Promise.resolve(h(cfg, this)); } catch (e) { return Promise.reject(e); }
  }
  land(url) { this.url = url; this.emit('did-finish-load'); }
}
class FakeBrowserWindow {
  constructor(opts) { this.opts = opts; this.webContents = new FakeWebContents(); this.destroyed = false; this.loaded = []; windows.push(this); }
  loadURL(u) { this.loaded.push(u); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  close() { this.destroyed = true; }
}
const defaultSession = { id: 'default' };
inject('electron', { BrowserWindow: FakeBrowserWindow, session: { defaultSession } });

// recording logger
const logCalls = [];
function fakeLogger() { const rec = (lvl) => (...a) => logCalls.push({ lvl, a }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);

// shared write lock (same chain semantics as sharepoint_push._withWriteLock)
let chain = Promise.resolve();
const withWriteLock = vi.fn((fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; });
inject('../src/scrapers/sharepoint_push', { _withWriteLock: withWriteLock });

const T = require('../src/scrapers/sp_sheet_transport');

const HOST = 'contoso.sharepoint.com';
const SITE = '/sites/Fleet';
const TARGET = { host: HOST, site: SITE, serverRelativeUrl: '/sites/Fleet/Shared Documents/SECRET_CELL_TEXT.xlsx' };
const TARGET_URL = 'https://' + HOST + SITE + '/_layouts/15/blank.htm';
const LOGIN_URL = 'https://login.microsoftonline.com/common/oauth2/authorize?client_id=x&e=TOKEN';
const ETAG = '"{AAAAAAAA-0000-0000-0000-000000000001},1"';
const PK_B64 = Buffer.from([0x50, 0x4b, 3, 4, 9, 9]).toString('base64');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const lastWin = () => windows[windows.length - 1];
const execCount = () => windows.reduce((n, w) => n + w.webContents.scripts.length, 0);
const logText = () => JSON.stringify(logCalls.map((c) => c.a));

beforeEach(() => {
  windows.length = 0; logCalls.length = 0; chain = Promise.resolve(); withWriteLock.mockClear();
  pageHandlers = {
    spSheetMeta: () => ({ ok: true, etag: ETAG, modified: '2026-11-05T10:00:00Z', length: 6 }),
    spSheetGet: () => ({ ok: true, b64: PK_B64, length: 6 }),
    spSheetPut: () => ({ ok: true, http: 200 }),
    spSheetResolve: () => ({ ok: true, strategy: 1, host: HOST, site: SITE, serverRelativeUrl: TARGET.serverRelativeUrl, uniqueId: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'SECRET_CELL_TEXT.xlsx', etag: ETAG, length: 6, failures: [] }),
  };
});
afterEach(() => { vi.useRealTimers(); });

describe('classifyLandingUrl', () => {
  it('sign-in landings are login', () => {
    expect(T.classifyLandingUrl('https://login.microsoftonline.com/common/oauth2/authorize?x=1', HOST, SITE)).toBe('login');
    expect(T.classifyLandingUrl('https://midway-auth.amazon.com/login?next=x', HOST, SITE)).toBe('login');
    expect(T.classifyLandingUrl('https://idp.example.com/oauth2/authorize?x', HOST, SITE)).toBe('login');
    expect(T.classifyLandingUrl('https://' + HOST + '/_forms/default.aspx?ReturnUrl=x', HOST, SITE)).toBe('login');
  });
  it('the real site is target; other hosts/paths are other', () => {
    expect(T.classifyLandingUrl(TARGET_URL, HOST, SITE)).toBe('target');
    expect(T.classifyLandingUrl('https://CONTOSO.sharepoint.com/sites/fleet/_layouts/15/blank.htm', HOST, SITE)).toBe('target');
    expect(T.classifyLandingUrl('https://' + HOST + '/sites/Other/_layouts/15/blank.htm', HOST, SITE)).toBe('other');
    expect(T.classifyLandingUrl('https://' + HOST + '/sites/FleetX/x', HOST, SITE)).toBe('other');
    expect(T.classifyLandingUrl('https://evil.example.com/sites/Fleet', HOST, SITE)).toBe('other');
    expect(T.classifyLandingUrl('http://' + HOST + SITE, HOST, SITE)).toBe('other');
    expect(T.classifyLandingUrl('not a url', HOST, SITE)).toBe('other');
  });
});

describe('window recipe', () => {
  it('hidden, off-screen, isolated, default session, loads blank.htm of the file\'s site', async () => {
    const p = T.fileMeta(TARGET);
    const w = lastWin();
    expect(w.opts).toMatchObject({ show: false, x: -3000, y: -3000, webPreferences: { nodeIntegration: false, contextIsolation: true, session: defaultSession } });
    expect(w.loaded).toEqual([TARGET_URL]);
    w.webContents.land(TARGET_URL);
    expect(await p).toMatchObject({ ok: true, etag: ETAG });
    expect(w.destroyed).toBe(true);
  });
  it('bad target never opens a window', async () => {
    expect(await T.fileMeta({ host: 'evil.example.com', site: SITE, serverRelativeUrl: '/x' })).toEqual({ ok: false, code: 'bad-target' });
    expect(windows).toHaveLength(0);
  });
});

describe('SSO settle', () => {
  it('login landing then target landing within 5 s runs the page function exactly once', async () => {
    vi.useFakeTimers();
    const p = T.fileMeta(TARGET);
    const w = lastWin();
    w.webContents.land(LOGIN_URL);
    await vi.advanceTimersByTimeAsync(4000);
    expect(execCount()).toBe(0);
    w.webContents.land(TARGET_URL);
    await vi.advanceTimersByTimeAsync(20000); // settle timer cleared: no late auth-required
    expect(await p).toMatchObject({ ok: true });
    expect(execCount()).toBe(1);
  });
  it('login only: auth-required after 15 s (fake timers)', async () => {
    vi.useFakeTimers();
    const p = T.fileMeta(TARGET);
    const w = lastWin();
    w.webContents.land(LOGIN_URL);
    let done = null; p.then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(14000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(1100);
    expect(done).toEqual({ ok: false, code: 'auth-required' });
    expect(execCount()).toBe(0);
    expect(w.destroyed).toBe(true);
  });
  it('two did-finish-load on target: executeJavaScript called once', async () => {
    const p = T.fileMeta(TARGET);
    const w = lastWin();
    w.webContents.land(TARGET_URL);
    w.webContents.land(TARGET_URL);
    await p;
    w.webContents.land(TARGET_URL);
    await flush();
    expect(execCount()).toBe(1);
  });
  it('off-site non-login landing: auth-required at once', async () => {
    const p = T.fileMeta(TARGET);
    lastWin().webContents.land('https://evil.example.com/x');
    expect(await p).toEqual({ ok: false, code: 'auth-required' });
    expect(execCount()).toBe(0);
    expect(lastWin().destroyed).toBe(true);
  });
  it('main-frame did-fail-load -> network; aborted (-3) and subframe failures are ignored', async () => {
    const p = T.fileMeta(TARGET);
    const wc = lastWin().webContents;
    let done = null; p.then((r) => { done = r; });
    wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', TARGET_URL, true);
    wc.emit('did-fail-load', {}, -105, 'x', 'https://sub', false);
    await flush();
    expect(done).toBeNull();
    wc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', TARGET_URL, true);
    expect(await p).toEqual({ ok: false, code: 'network' });
  });
});

describe('timeouts and cleanup', () => {
  it('op timeout destroys the window (meta 30 s)', async () => {
    vi.useFakeTimers();
    pageHandlers.spSheetMeta = () => new Promise(() => {});
    const p = T.fileMeta(TARGET);
    lastWin().webContents.land(TARGET_URL);
    await vi.advanceTimersByTimeAsync(30001);
    expect(await p).toEqual({ ok: false, code: 'timeout' });
    expect(lastWin().destroyed).toBe(true);
  });
  it('page error result closes the window too', async () => {
    pageHandlers.spSheetMeta = () => ({ ok: false, code: 'not-found', http: 404 });
    const p = T.fileMeta(TARGET);
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toMatchObject({ ok: false, code: 'not-found' });
    expect(lastWin().destroyed).toBe(true);
  });
  it('sentinel exception -> internal, class name only in the log', async () => {
    pageHandlers.spSheetMeta = () => { throw new Error('SECRET_CELL_TEXT https://x.sharepoint.com/f?e=TOKEN'); };
    const p = T.fileMeta(TARGET);
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: false, code: 'internal' });
    expect(lastWin().destroyed).toBe(true);
    expect(logText()).not.toMatch(/SECRET_CELL_TEXT|TOKEN|e=/);
    expect(logText()).toContain('Error');
  });
});

describe('downloadFile', () => {
  it('meta M0, GET, meta M0b in one window; bytes decoded', async () => {
    const p = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(Buffer.from(r.bytes)).toEqual(Buffer.from(PK_B64, 'base64'));
    expect(r.meta.etag).toBe(ETAG);
    expect(windows).toHaveLength(1);
    expect(lastWin().webContents.scripts.map((s) => /;(sp\w+)\(/.exec(s)[1])).toEqual(['spSheetMeta', 'spSheetGet', 'spSheetMeta']);
  });
  it('repeats once on M0/M0b mismatch, then aborts on a second mismatch', async () => {
    let n = 0;
    pageHandlers.spSheetMeta = () => ({ ok: true, etag: '"{A},' + (++n) + '"', modified: 't' });
    const p = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: false, code: 'changed-since-preview' });
    expect(lastWin().webContents.scripts).toHaveLength(6);
  });
  it('one mismatch then stable succeeds with the second M0', async () => {
    const seq = ['"{A},1"', '"{A},2"', '"{A},2"', '"{A},2"'];
    pageHandlers.spSheetMeta = () => ({ ok: true, etag: seq.shift(), modified: 't' });
    const p = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.meta.etag).toBe('"{A},2"');
  });
  it('throttled GET is retried once after Retry-After (capped)', async () => {
    vi.useFakeTimers();
    let g = 0;
    pageHandlers.spSheetGet = () => (++g === 1 ? { ok: false, code: 'throttled', retryAfterMs: 60000 } : { ok: true, b64: PK_B64 });
    const p = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    await vi.advanceTimersByTimeAsync(9000);
    expect(g).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect((await p).ok).toBe(true);
    expect(g).toBe(2);
  });
  it('metadata failure -> guard-unavailable', async () => {
    pageHandlers.spSheetMeta = () => ({ ok: false, code: 'http-500' });
    const p = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: false, code: 'guard-unavailable' });
  });
});

describe('uploadFile and the shared write lock', () => {
  it('goes through sharepoint_push._withWriteLock; If-Match only when passed', async () => {
    const seen = [];
    pageHandlers.spSheetPut = (cfg) => { seen.push(cfg); return { ok: true, http: 200 }; };
    const p = T.uploadFile(TARGET, new Uint8Array([0x50, 0x4b, 1]));
    await flush();
    expect(withWriteLock).toHaveBeenCalledTimes(1);
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: true, http: 200 });
    const p2 = T.uploadFile(TARGET, new Uint8Array([0x50, 0x4b, 2]), { ifMatch: ETAG });
    await flush();
    lastWin().webContents.land(TARGET_URL);
    await p2;
    expect(seen[0].ifMatch).toBeUndefined();
    expect(seen[1].ifMatch).toBe(ETAG);
    expect(Buffer.from(seen[0].b64, 'base64')).toEqual(Buffer.from([0x50, 0x4b, 1]));
  });
  it('a held lock delays the upload; waiting > 90 s -> busy and the queued task never opens a window', async () => {
    vi.useFakeTimers();
    let release;
    withWriteLock(() => new Promise((r) => { release = r; }));
    const p = T.uploadFile(TARGET, new Uint8Array([0x50, 0x4b]));
    await vi.advanceTimersByTimeAsync(60000);
    expect(windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(31000);
    expect(await p).toEqual({ ok: false, code: 'busy' });
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(windows).toHaveLength(0);
  });
  it('a released lock lets the queued upload run', async () => {
    let release;
    withWriteLock(() => new Promise((r) => { release = r; }));
    const p = T.uploadFile(TARGET, new Uint8Array([0x50, 0x4b]));
    await flush();
    expect(windows).toHaveLength(0);
    release();
    await flush();
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: true, http: 200 });
  });
  it('a PUT whose executeJavaScript throws is an unknown outcome (sent:true), never retried', async () => {
    let n = 0;
    pageHandlers.spSheetPut = () => { n++; throw new Error('gone'); };
    const p = T.uploadFile(TARGET, new Uint8Array([0x50, 0x4b]));
    await flush();
    lastWin().webContents.land(TARGET_URL);
    expect(await p).toEqual({ ok: false, code: 'network', sent: true });
    expect(n).toBe(1);
  });
});

describe('resolveFile and logging', () => {
  it('passes the parsed link to the page and returns the resolution', async () => {
    let cfg = null;
    pageHandlers.spSheetResolve = (c) => { cfg = c; return { ok: true, strategy: 3, host: HOST, site: SITE, serverRelativeUrl: TARGET.serverRelativeUrl, uniqueId: null, name: 'SECRET_CELL_TEXT.xlsx', failures: [{ strategy: 1, code: 'not-found', http: 404 }] }; };
    const parsed = { ok: true, host: HOST, site: SITE, kind: 'sharing-token', serverRelativeUrl: null, fileGuid: null, canonicalUrl: 'https://' + HOST + '/:x:/s/Fleet/abc?e=TOKEN' };
    const p = T.resolveFile(parsed, parsed.canonicalUrl);
    lastWin().webContents.land(TARGET_URL);
    const r = await p;
    expect(r).toMatchObject({ ok: true, host: HOST, site: SITE, name: 'SECRET_CELL_TEXT.xlsx' });
    expect(cfg).toMatchObject({ origin: 'https://' + HOST, site: SITE, linkUrl: parsed.canonicalUrl });
    expect(lastWin().destroyed).toBe(true);
  });
  it('no URL query, file name or cell text in any log call', async () => {
    pageHandlers.spSheetResolve = () => ({ ok: false, code: 'unresolvable-link', failures: [{ strategy: 1, code: 'not-found', http: 404 }] });
    const parsed = { ok: true, host: HOST, site: SITE, serverRelativeUrl: null, fileGuid: null, canonicalUrl: 'https://' + HOST + '/:x:/s/Fleet/abc?e=TOKEN' };
    const p1 = T.resolveFile(parsed, parsed.canonicalUrl);
    lastWin().webContents.land(TARGET_URL);
    expect(await p1).toEqual({ ok: false, code: 'unresolvable-link' });
    const p2 = T.downloadFile(TARGET);
    lastWin().webContents.land(TARGET_URL);
    await p2;
    const p3 = T.fileMeta(TARGET);
    lastWin().webContents.land(LOGIN_URL);
    lastWin().webContents.land('https://evil.example.com/?q=SECRET');
    await p3;
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logText()).not.toMatch(/SECRET|TOKEN|\?|Shared Documents|\.xlsx/);
  });
});
