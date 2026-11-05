// fetch-internal.js: T-INT-*, T-INT-SUBRESOURCE (design §9.3, §19) plus round-3
// fix 5 (static CDN hosts, SharePoint direct download, THIN_PAGE) and fix 15
// (loopback/link-local pre-lookup on every hop). Fake electron throughout.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const { fetchInternal, sharepointDownloadUrl } = require('../src/justme-context/fetch-internal');
const { classifyUrl } = require('../src/justme-context/url-policy');
const { REASONS } = require('../src/justme-context/constants');
const autoLogin = require('../src/orcha/auto-login');

const LONG = 'Real internal page text. '.repeat(40);   // > 500 chars

function makeSession(name) {
  const s = new EventEmitter();
  s.name = name;
  s.listener = null;
  s.webRequest = { onBeforeRequest: vi.fn((filter, fn) => { s.listener = fn === undefined ? null : (typeof filter === 'function' ? filter : fn); }) };
  vi.spyOn(s, 'on');
  vi.spyOn(s, 'removeListener');
  return s;
}

// routes: url -> { status, headers, body } | { redirect } | { error } | { hang }
// render: { onLoad(wc, ses, win), title, text, finalUrl, loadError, loadHang }
function makeElectron(routes, render) {
  const requests = [];
  const sessions = { default: makeSession('default') };
  const windows = [];
  const net = {
    request: vi.fn((opts) => {
      const req = new EventEmitter();
      req.abort = vi.fn();
      requests.push(opts);
      req.end = () => setImmediate(() => {
        const r = routes[opts.url];
        if (!r) return req.emit('error', Object.assign(new Error('net::ERR_NAME_NOT_RESOLVED ' + opts.url), { code: 'ERR_NAME_NOT_RESOLVED' }));
        if (r.hang) return;
        if (r.error) return req.emit('error', new Error(r.error));
        if (r.redirect) return req.emit('redirect', 302, 'GET', r.redirect, {});
        const res = new EventEmitter();
        res.statusCode = r.status || 200;
        res.headers = r.headers || {};
        req.emit('response', res);
        setImmediate(() => { res.emit('data', Buffer.from(r.body || '')); res.emit('end'); });
      });
      return req;
    }),
  };
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroy = vi.fn();
      const wc = new EventEmitter();
      wc.id = 77;
      wc.setWindowOpenHandler = vi.fn();
      wc.loadURL = vi.fn(async (u) => {
        this.loadedUrl = u;
        if (render && render.onLoad) await render.onLoad(wc, opts.webPreferences.session, this);
        if (render && render.loadHang) return new Promise(() => {});
        if (render && render.loadError) throw new Error('ERR_FAILED ' + u);
      });
      wc.executeJavaScript = vi.fn(async (js) => {
        if (js.includes('innerText.length')) return ((render && render.text) || '').length;
        return { title: (render && render.title) || '', text: (render && render.text) || '' };
      });
      wc.getURL = () => (render && render.finalUrl) || this.loadedUrl;
      vi.spyOn(wc, 'on');
      this.webContents = wc;
      windows.push(this);
    }
  }
  const electron = {
    net,
    BrowserWindow,
    session: {
      defaultSession: sessions.default,
      fromPartition: vi.fn((p) => (sessions[p] = sessions[p] || makeSession(p))),
    },
  };
  return { electron, requests, sessions, windows };
}
function makeDns(map) {
  return {
    lookup: vi.fn((host, opts, cb) => {
      const v = map[host];
      if (v instanceof Error) return setImmediate(() => cb(v));
      setImmediate(() => cb(null, (v || ['10.20.30.40']).map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }))));
    }),
  };
}

let logger, extractItem, fetchExternal, ctx;
beforeEach(() => {
  logger = H.makeLogger(vi);
  extractItem = vi.fn(async (file) => {
    const html = /html/.test(file.mimetype);
    const text = html ? file.buffer.toString().replace(/<[^>]+>/g, '') : 'DOC ' + file.buffer.toString();
    return { kind: html ? 'html' : 'docx', status: 'read', text, chars: text.length, truncated: false, reason: '', meta: {} };
  });
  fetchExternal = vi.fn(async () => ({ kind: 'page', status: 'read', text: 'external', chars: 8, truncated: false, reason: '', meta: {} }));
  ctx = { deadline: Date.now() + 60000, jobId: 'jm7' };
});
const run = (url, env, extra) => {
  const deps = Object.assign({ electron: env.electron, dns: env.dns || makeDns({}), logger, extractItem, fetchExternal,
    checkMwinit: () => ({ ok: true }), renderTiming: { pollMs: 1, settleMs: 50 } }, extra || {});
  return fetchInternal(url, classifyUrl(url), ctx, deps);
};
const html = (body, title) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><title>' + (title || 'Wiki') + '</title><body>' + body + '</body></html>' });

describe('T-INT: sessions, network step, hand-off', () => {
  it('internal uses defaultSession with credentials include and manual redirects; long page needs no render', async () => {
    const env = makeElectron({ 'https://w.amazon.com/page': html(LONG) });
    const r = await run('https://w.amazon.com/page', env);
    expect(r).toMatchObject({ kind: 'page', status: 'read' });
    expect(env.requests[0]).toMatchObject({ url: 'https://w.amazon.com/page', session: env.sessions.default, credentials: 'include', redirect: 'manual' });
    expect(Object.keys(env.requests[0]).sort()).toEqual(['credentials', 'redirect', 'session', 'url']);   // no headers added
    expect(env.electron.session.fromPartition).not.toHaveBeenCalled();
    expect(env.windows).toHaveLength(0);
  });
  it('vendor uses its partition session', async () => {
    const env = makeElectron({ 'https://fleet.uptake.com/u/1': html(LONG) });
    await run('https://fleet.uptake.com/u/1', env);
    expect(env.electron.session.fromPartition).toHaveBeenCalledWith('persist:vendor-uptake');
    expect(env.requests[0].session).toBe(env.sessions['persist:vendor-uptake']);
  });
  it('a non-HTML body takes the file path (AC-19)', async () => {
    const env = makeElectron({ 'https://w.amazon.com/f/report.docx': { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: 'DOCX' } });
    const r = await run('https://w.amazon.com/f/report.docx', env);
    expect(r).toMatchObject({ kind: 'docx', status: 'read', text: 'DOC DOCX' });
    expect(extractItem.mock.calls[0][0].name).toBe('report.docx');
    expect(extractItem.mock.calls[0][1]).toBe(ctx);
  });
  it('internal -> internal redirect is followed as a new request (T-INT-REDIRECT)', async () => {
    const env = makeElectron({ 'https://w.amazon.com/a': { redirect: 'https://wiki.a2z.com/b' }, 'https://wiki.a2z.com/b': html(LONG) });
    const r = await run('https://w.amazon.com/a', env);
    expect(r.status).toBe('read');
    expect(env.requests.map((q) => q.url)).toEqual(['https://w.amazon.com/a', 'https://wiki.a2z.com/b']);
  });
  it('internal -> external hands off to fetchExternal with the hop count, no cookie session', async () => {
    const env = makeElectron({ 'https://w.amazon.com/out': { redirect: 'https://example.com/x' } });
    const r = await run('https://w.amazon.com/out', env);
    expect(r.text).toBe('external');
    expect(fetchExternal).toHaveBeenCalledTimes(1);
    expect(fetchExternal.mock.calls[0][0]).toBe('https://example.com/x');
    expect(fetchExternal.mock.calls[0][1]).toBe(ctx);
    expect(fetchExternal.mock.calls[0][3]).toBe(1);
    expect(env.requests.map((q) => q.url)).toEqual(['https://w.amazon.com/out']);
  });
  for (const target of ['http://127.0.0.1/', 'https://x.slack.com/files/U1/F1/a', 'https://pssmfleet.decisiv.net/']) {
    it('redirect to a disallowed host ' + target + ' stops', async () => {
      const env = makeElectron({ 'https://w.amazon.com/r': { redirect: target } });
      const r = await run('https://w.amazon.com/r', env);
      expect(r).toMatchObject({ status: 'blocked', reason: REASONS.REDIRECT_DISALLOWED });
      expect(env.requests).toHaveLength(1);
      expect(fetchExternal).not.toHaveBeenCalled();
    });
  }
  it('vendor -> internal redirect is refused (different trust class)', async () => {
    const env = makeElectron({ 'https://fleet.uptake.com/r': { redirect: 'https://w.amazon.com/x' } });
    expect((await run('https://fleet.uptake.com/r', env)).reason).toBe(REASONS.REDIRECT_DISALLOWED);
  });
  it('HTTP 404 -> fixed reason, no render', async () => {
    const env = makeElectron({ 'https://w.amazon.com/missing': { status: 404 } });
    expect(await run('https://w.amazon.com/missing', env)).toMatchObject({ status: 'failed', reason: REASONS.HTTP_ERROR });
    expect(env.windows).toHaveLength(0);
  });
});

describe('T-INT: render fallback', () => {
  it('login shell -> offscreen render with hardened options; success destroys window and clears filter', async () => {
    const env = makeElectron({ 'https://w.amazon.com/shell': html('<div id=app></div>', 'Loading') }, { text: LONG, title: 'Wiki page' });
    const spyAuto = vi.spyOn(autoLogin, 'attachAutoLogin');
    const r = await run('https://w.amazon.com/shell', env);
    expect(r).toMatchObject({ kind: 'page', status: 'read', meta: { via: 'render' } });
    expect(r.text).toBe(LONG);
    const w = env.windows[0];
    expect(w.opts).toMatchObject({ show: false, x: -4000, y: -4000, skipTaskbar: true });
    expect(w.opts.webPreferences).toMatchObject({ session: env.sessions.default, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
    expect(w.opts.webPreferences.preload).toBeUndefined();
    expect(w.destroy).toHaveBeenCalledTimes(1);
    expect(env.sessions.default.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(env.sessions.default.listener).toBe(null);
    // download-cancel listener added and removed
    const added = env.sessions.default.on.mock.calls.find((c) => c[0] === 'will-download');
    expect(added).toBeTruthy();
    expect(env.sessions.default.removeListener).toHaveBeenCalledWith('will-download', added[1]);
    // no certificate-error handler, no auto-login
    expect(w.webContents.on.mock.calls.map((c) => c[0])).not.toContain('certificate-error');
    expect(w.webContents.listenerCount('certificate-error')).toBe(0);
    expect(spyAuto).not.toHaveBeenCalled();
    expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    spyAuto.mockRestore();
  });
  it('navigation to external or other-class hosts is prevented; internal and SSO allowed', async () => {
    let wcRef;
    const env = makeElectron({ 'https://w.amazon.com/shell': html('x', 'Sign in') }, { text: LONG, title: 'ok', onLoad: (wc) => { wcRef = wc; } });
    await run('https://w.amazon.com/shell', env);
    const nav = (ev, url) => { const e = { url, preventDefault: vi.fn() }; wcRef.emit(ev, e, url); return e.preventDefault.mock.calls.length > 0; };
    expect(nav('will-navigate', 'https://evil.example/')).toBe(true);
    expect(nav('will-frame-navigate', 'https://evil.example/frame')).toBe(true);
    expect(nav('will-redirect', 'http://169.254.169.254/')).toBe(true);
    expect(nav('will-navigate', 'https://w.amazon.com/other')).toBe(false);
    expect(nav('will-navigate', 'https://login.microsoftonline.com/x')).toBe(false);
  });
  it('download from the window is cancelled; other windows untouched; listener removed after', async () => {
    let mine, other;
    const env = makeElectron({ 'https://w.amazon.com/s': html('x', 'Sign in') }, {
      text: LONG,
      onLoad: (wc, ses) => {
        const i1 = { cancel: vi.fn() };
        ses.emit('will-download', { preventDefault: vi.fn() }, i1, wc);
        mine = i1.cancel.mock.calls.length > 0;
        const i2 = { cancel: vi.fn() };
        ses.emit('will-download', { preventDefault: vi.fn() }, i2, { id: 5 });
        other = i2.cancel.mock.calls.length > 0;
      },
    });
    await run('https://w.amazon.com/s', env);
    expect(mine).toBe(true);
    expect(other).toBe(false);
    expect(env.sessions.default.listenerCount('will-download')).toBe(0);
  });
  it('render timeout destroys the window and clears the filter', async () => {
    const env = makeElectron({ 'https://w.amazon.com/slow': html('x', 'Sign in') }, { loadHang: true });
    ctx.deadline = Date.now() + 300;
    const r = await run('https://w.amazon.com/slow', env);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.TIMEOUT });
    expect(env.windows[0].destroy).toHaveBeenCalled();
    expect(env.sessions.default.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });
  it('render error destroys the window and clears the filter, no error text leaks', async () => {
    const env = makeElectron({ 'https://w.amazon.com/err': html('x', 'Sign in') }, { loadError: true });
    const r = await run('https://w.amazon.com/err', env);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.RENDER_FAILED });
    expect(env.windows[0].destroy).toHaveBeenCalled();
    expect(env.sessions.default.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(H.allLogged(logger)).not.toContain('ERR_FAILED https');
  });
  it('login wall still present -> needs sign-in with a fixed Midway hint (never the raw reason)', async () => {
    const env = makeElectron({ 'https://w.amazon.com/p': html('x', 'Midway') }, { text: 'Sign in', title: 'Midway Sign In', finalUrl: 'https://midway-auth.amazon.com/login' });
    const r = await run('https://w.amazon.com/p', env, { checkMwinit: () => ({ ok: false, reason: 'Cannot read cookie file: C:\\Users\\me\\.midway\\cookie EACCES' }) });
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.MIDWAY_UNREADABLE });
    const r2 = await run('https://w.amazon.com/p', env, { checkMwinit: () => ({ ok: false, reason: 'Midway session expired' }) });
    expect(r2.reason).toBe(REASONS.MIDWAY_EXPIRED);
    const env3 = makeElectron({ 'https://fleet.uptake.com/p': html('x', 'Login') }, { text: 'x', title: 'Login' });
    expect((await run('https://fleet.uptake.com/p', env3)).reason).toBe(REASONS.VENDOR_SIGNIN);
  });
});

describe('T-INT-SUBRESOURCE (AC-18 + fix 5)', () => {
  // Fire filter requests during load and record the decision for each.
  async function decisions(target, reqs) {
    const out = [];
    const env = makeElectron({ [target]: html('x', 'Sign in') }, {
      text: LONG,
      onLoad: (wc, ses) => {
        for (const d of reqs) ses.listener(Object.assign({ method: 'GET', resourceType: 'image' }, d), (res) => out.push(res && res.cancel ? 'cancel' : 'allow'));
      },
    });
    const r = await run(target, env);
    return { out, r, env };
  }
  it('design §19 rows from the window, other windows and service workers', async () => {
    const { out, env } = await decisions('https://w.amazon.com/p', [
      { url: 'https://evil.example/x.png', webContentsId: 77 },
      { url: 'http://169.254.169.254/', webContentsId: 77 },
      { url: 'https://w.amazon.com/a.css', webContentsId: 77, resourceType: 'stylesheet' },
      { url: 'https://login.microsoftonline.com/x', webContentsId: 77, resourceType: 'mainFrame' },
      { url: 'data:image/png;base64,AAAA', webContentsId: 77 },
      { url: 'https://evil.example/', webContentsId: 12 },
      { url: 'http://127.0.0.1/', webContentsId: undefined },
      { url: 'https://evil.example/', webContentsId: undefined },
    ]);
    expect(out).toEqual(['cancel', 'cancel', 'allow', 'allow', 'allow', 'allow', 'cancel', 'allow']);
    expect(env.sessions.default.listener).toBe(null);
  });
  it('fix 5: static CDN hosts are GET + static types only; CloudFront stays cancelled', async () => {
    const { out } = await decisions('https://w.amazon.com/p', [
      { url: 'https://res.cdn.office.net/x.js', webContentsId: 77, method: 'GET', resourceType: 'script' },
      { url: 'https://res.cdn.office.net/x.js', webContentsId: 77, method: 'POST', resourceType: 'script' },
      { url: 'https://res.cdn.office.net/x.js', webContentsId: 77, method: 'GET', resourceType: 'xhr' },
      { url: 'https://x.cloudfront.net/a.js', webContentsId: 77, method: 'GET', resourceType: 'script' },
      { url: 'https://m.media-amazon.com/i.png', webContentsId: 77, method: 'GET', resourceType: 'image' },
      { url: 'https://word-view.officeapps.live.com/f', webContentsId: 77, method: 'GET', resourceType: 'subFrame' },
      { url: 'https://spoprod-a.akamaihd.net/a.js', webContentsId: 77, method: 'GET', resourceType: 'script' },
    ]);
    expect(out).toEqual(['allow', 'cancel', 'cancel', 'cancel', 'allow', 'allow', 'cancel']);
  });
  it('vendor target: w.amazon.com and m.media-amazon.com are cancelled (different trust class)', async () => {
    const { out } = await decisions('https://fleet.uptake.com/p', [
      { url: 'https://w.amazon.com/a.css', webContentsId: 77, resourceType: 'stylesheet' },
      { url: 'https://m.media-amazon.com/i.png', webContentsId: 77, resourceType: 'image' },
      { url: 'https://fleet.uptake.com/app.js', webContentsId: 77, resourceType: 'script' },
      { url: 'https://login.uptake.com/x', webContentsId: 77, resourceType: 'script' },
    ]);
    expect(out).toEqual(['cancel', 'cancel', 'allow', 'allow']);
  });
  it('thin page after cancellations -> THIN_PAGE', async () => {
    const env = makeElectron({ 'https://w.amazon.com/thin': html('x', 'Sign in') }, {
      text: 'Only a header',
      onLoad: (wc, ses) => { ses.listener({ url: 'https://x.cloudfront.net/app.js', webContentsId: 77, method: 'GET', resourceType: 'script' }, () => {}); },
    });
    const r = await run('https://w.amazon.com/thin', env);
    expect(r).toMatchObject({ status: 'read', reason: REASONS.THIN_PAGE, text: 'Only a header' });
    expect(H.allLogged(logger)).toMatch(/int w\.amazon\.com thin cancelled=1 \d+ms/);
    const env2 = makeElectron({ 'https://w.amazon.com/thin': html('x', 'Sign in') }, {
      text: '',
      onLoad: (wc, ses) => { ses.listener({ url: 'https://evil.example/a.js', webContentsId: 77, method: 'GET', resourceType: 'script' }, () => {}); },
    });
    expect(await run('https://w.amazon.com/thin', env2)).toMatchObject({ status: 'failed', reason: REASONS.THIN_PAGE });
  });
});

describe('SharePoint same-host direct download (fix 5)', () => {
  it('maps sharing links and Doc.aspx to download URLs on the same host', () => {
    expect(sharepointDownloadUrl('https://amazon.sharepoint.com/:w:/r/sites/ops/Shared%20Documents/plan.docx?d=w123&csf=1')).toBe('https://amazon.sharepoint.com/:w:/r/sites/ops/Shared%20Documents/plan.docx?d=w123&csf=1&download=1');
    expect(sharepointDownloadUrl('https://amazon-my.sharepoint.com/:x:/g/personal/me/EaBc?e=1')).toContain('download=1');
    expect(sharepointDownloadUrl('https://amazon.sharepoint.com/sites/ops/_layouts/15/Doc.aspx?sourcedoc={0A1B2C3D-1111-2222-3333-444455556666}&file=x.docx'))
      .toBe('https://amazon.sharepoint.com/sites/ops/_layouts/15/download.aspx?UniqueId=0A1B2C3D-1111-2222-3333-444455556666');
    expect(sharepointDownloadUrl('https://amazon.sharepoint.com/sites/ops/SitePages/Home.aspx')).toBe(null);
    expect(sharepointDownloadUrl('https://evil.sharepoint.com/:w:/r/x')).toBe(null);
  });
  it('/:w:/r/... -> first net.request has download=1 and the docx bytes are extracted', async () => {
    const u = 'https://amazon.sharepoint.com/:w:/r/sites/ops/plan.docx?d=w1';
    const env = makeElectron({ [u + '&download=1']: { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: 'DOCXBYTES' } });
    const r = await run(u, env);
    expect(new URL(env.requests[0].url).searchParams.get('download')).toBe('1');
    expect(env.requests[0].session).toBe(env.sessions.default);
    expect(r).toMatchObject({ status: 'read', text: 'DOC DOCXBYTES', meta: { via: 'sharepoint-download' } });
    expect(env.requests).toHaveLength(1);
  });
  it('an HTML response falls through to the page fetch and render', async () => {
    const u = 'https://amazon.sharepoint.com/:w:/r/sites/ops/plan.docx?d=w1';
    const env = makeElectron({ [u + '&download=1']: html('Sign in', 'Sign in'), [u]: html('shell', 'Sign in') }, { text: LONG, title: 'plan.docx' });
    const r = await run(u, env);
    expect(env.requests.map((q) => q.url)).toEqual([u + '&download=1', u]);
    expect(env.windows).toHaveLength(1);
    expect(r).toMatchObject({ status: 'read', meta: { via: 'render' } });
  });
});

describe('fix 15: loopback/link-local pre-lookup', () => {
  it("lookup -> ['127.0.0.1'] -> blocked, net.request never called", async () => {
    const env = makeElectron({ 'https://w.amazon.com/p': html(LONG) });
    env.dns = makeDns({ 'w.amazon.com': ['127.0.0.1'] });
    const r = await run('https://w.amazon.com/p', env);
    expect(r).toMatchObject({ status: 'blocked', reason: REASONS.LOCAL_ADDRESS });
    expect(env.electron.net.request).not.toHaveBeenCalled();
    expect(env.dns.lookup.mock.calls[0][1]).toEqual({ all: true });
  });
  it("['10.1.2.3'] -> proceeds (internal hosts may resolve privately)", async () => {
    const env = makeElectron({ 'https://w.amazon.com/p': html(LONG) });
    env.dns = makeDns({ 'w.amazon.com': ['10.1.2.3'] });
    expect((await run('https://w.amazon.com/p', env)).status).toBe('read');
    expect(env.electron.net.request).toHaveBeenCalledTimes(1);
  });
  it("['169.254.1.1','::1'] -> blocked", async () => {
    const env = makeElectron({ 'https://fleet.uptake.com/p': html(LONG) });
    env.dns = makeDns({ 'fleet.uptake.com': ['169.254.1.1', '::1'] });
    expect((await run('https://fleet.uptake.com/p', env)).reason).toBe(REASONS.LOCAL_ADDRESS);
    expect(env.electron.net.request).not.toHaveBeenCalled();
  });
  it('mixed loopback + routable -> proceeds', async () => {
    const env = makeElectron({ 'https://w.amazon.com/p': html(LONG) });
    env.dns = makeDns({ 'w.amazon.com': ['127.0.0.1', '10.1.2.3'] });
    expect((await run('https://w.amazon.com/p', env)).status).toBe('read');
  });
  it('lookup error -> proceeds (plan D7)', async () => {
    const env = makeElectron({ 'https://w.amazon.com/p': html(LONG) });
    env.dns = makeDns({ 'w.amazon.com': Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) });
    expect((await run('https://w.amazon.com/p', env)).status).toBe('read');
    expect(env.electron.net.request).toHaveBeenCalledTimes(1);
  });
  it('a redirect hop to an internal host resolving to loopback is stopped', async () => {
    const env = makeElectron({ 'https://w.amazon.com/a': { redirect: 'https://rebind.a2z.com/b' }, 'https://rebind.a2z.com/b': html(LONG) });
    env.dns = makeDns({ 'rebind.a2z.com': ['127.0.0.1'] });
    const r = await run('https://w.amazon.com/a', env);
    expect(r).toMatchObject({ status: 'blocked', reason: REASONS.LOCAL_ADDRESS });
    expect(env.requests.map((q) => q.url)).toEqual(['https://w.amazon.com/a']);
    expect(env.dns.lookup.mock.calls.map((c) => c[0])).toEqual(['w.amazon.com', 'rebind.a2z.com']);
  });
  it('the SharePoint download request is pre-checked too', async () => {
    const u = 'https://amazon.sharepoint.com/:w:/r/x.docx';
    const env = makeElectron({});
    env.dns = makeDns({ 'amazon.sharepoint.com': ['127.0.0.1'] });
    expect((await run(u, env)).reason).toBe(REASONS.LOCAL_ADDRESS);
    expect(env.electron.net.request).not.toHaveBeenCalled();
  });
});
