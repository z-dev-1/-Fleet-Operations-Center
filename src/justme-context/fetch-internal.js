'use strict';
// src/justme-context/fetch-internal.js — internal and vendor fetch (design §9.3).
// Electron net.request in the trust class's session (Chromium attaches that
// session's own cookies; this module adds no cookie or auth header and never
// calls or changes injectCookies), plus a filtered offscreen render fallback.
//
// Round-3 fix 15: before EVERY net.request (the initial host and each followed
// hop) the host is resolved; if every address is loopback or link-local the
// request is not made (LOCAL_ADDRESS). A lookup error proceeds (plan D7): Chromium
// may resolve through its own proxy/PAC. TOCTOU residual: Chromium resolves again.
// Redirects are taken one hop at a time (redirect:'manual', the request is
// aborted and the next hop is a new request) so the async pre-lookup can run.
//
// Round-3 fix 5: SharePoint document links first try a same-host direct download,
// and the render filter also admits exact static CDN hosts (RENDER_STATIC_HOSTS)
// for GET script/stylesheet/image/font/subFrame requests. Cancelled requests are
// counted; a thin result after cancellations reports THIN_PAGE.
//
// Not copied from asist_enrich.js / vendor-workflow.js on purpose: no
// attachAutoLogin call and no certificate-error handler (Chromium's default
// rejection applies).

const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');
const { classifyUrl, isSsoNavHost, isLoopbackOrLinkLocal, RENDER_STATIC_HOSTS } = require('./url-policy');

const THIN_TEXT_CHARS = 500;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'subFrame']);
const SHAREPOINT_HOSTS = new Set(['amazon.sharepoint.com', 'amazon-my.sharepoint.com']);
const LOGIN_TITLE_RE = /sign in|midway|login/i;
const EXTRACT_JS = `(function(){
  try {
    var title = document.title || '';
    var root = document.querySelector('main, article, [role="main"]') || document.body;
    var text = (root ? root.innerText : '') || '';
    return { title: title, text: text.slice(0, 60000) };
  } catch(e) { return { title: '', text: '' }; }
})()`;
const LEN_JS = '(function(){try{return document.body?document.body.innerText.length:0}catch(e){return 0}})()';

function _logger(deps) {
  return (deps && deps.logger) || require('../utils/logger').createLogger('justme-context');
}
const _item = (kind, status, reason, extra) => Object.assign({ kind, status, text: '', chars: 0, truncated: false, reason, meta: {} }, extra || {});
const _host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch (_) { return ''; } };
const _hdr = (h, k) => { const v = h && (h[k] !== undefined ? h[k] : h[k.toLowerCase()]); return Array.isArray(v) ? v[0] : v; };
const _mime = (h) => String(_hdr(h, 'content-type') || '').split(';')[0].trim().toLowerCase();
const _isHtml = (m) => m === 'text/html' || m === 'application/xhtml+xml';

/** SharePoint same-host direct-download URL for a document link, else null (fix 5). */
function sharepointDownloadUrl(u) {
  let url;
  try { url = new URL(u); } catch (_) { return null; }
  if (url.protocol !== 'https:' || !SHAREPOINT_HOSTS.has(_host(u))) return null;
  if (/\/:[wxpb]:\//i.test(url.pathname)) {
    const d = new URL(url.href);
    d.hash = '';
    d.searchParams.set('download', '1');
    return d.href;
  }
  if (/\/_layouts\/15\/Doc\.aspx$/i.test(url.pathname) && url.searchParams.get('sourcedoc')) {
    const id = url.searchParams.get('sourcedoc').replace(/[{}]/g, '');
    if (!/^[0-9A-Fa-f-]{32,36}$/.test(id)) return null;
    const base = url.pathname.replace(/\/_layouts\/15\/Doc\.aspx$/i, '');
    return url.origin + base + '/_layouts/15/download.aspx?UniqueId=' + encodeURIComponent(id);
  }
  return null;
}

// fix 15: true when every resolved address is loopback/link-local. Errors -> false (D7).
function _resolvesLocal(host, deps) {
  const dnsImpl = deps.dns || require('dns');
  return new Promise((resolve) => {
    try {
      dnsImpl.lookup(host, { all: true }, (err, addrs) => {
        if (err) return resolve(false);
        const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (a && typeof a === 'object' ? a.address : a)).filter(Boolean);
        resolve(list.length > 0 && list.every((a) => isLoopbackOrLinkLocal(a)));
      });
    } catch (_) { resolve(false); }
  });
}

// Same trust class as the target: internal targets admit internal + SSO hosts,
// vendor targets admit only their own partition's hosts.
function _sameClass(u, cls) {
  if (isSsoNavHost(u)) return true;
  const c = classifyUrl(u);
  if (cls.kind === 'vendor') return c.kind === 'vendor' && c.partition === (cls.partition || null);
  return c.kind === 'internal';
}

/**
 * One net.request (no redirect following). Resolves with
 * { type:'redirect', location } | { type:'response', status, headers, buffer } | { type:'error', reason, status, tag }.
 */
function _netOnce(electron, ses, u, ctx, endAt, now) {
  return new Promise((resolve) => {
    let req, done = false, timer = null;
    const onAbort = () => fin({ type: 'error', reason: REASONS.BUDGET, status: 'skipped', tag: 'abort' }, true);
    function fin(r, abort) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      if (abort && req) { try { req.abort(); } catch (_) {} }
      resolve(r);
    }
    if (ctx.signal && ctx.signal.aborted) return resolve({ type: 'error', reason: REASONS.BUDGET, status: 'skipped', tag: 'abort' });
    const left = endAt - now();
    if (left <= 0) return resolve({ type: 'error', reason: REASONS.TIMEOUT, status: 'failed', tag: 'timeout' });
    try { req = electron.net.request({ url: u, session: ses, credentials: 'include', redirect: 'manual' }); }
    catch (e) { return resolve({ type: 'error', reason: REASONS.UNREACHABLE, status: 'failed', tag: errTag(e) }); }
    timer = setTimeout(() => fin({ type: 'error', reason: REASONS.TIMEOUT, status: 'failed', tag: 'timeout' }, true), left);
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    req.on('redirect', (status, method, redirectUrl) => fin({ type: 'redirect', location: String(redirectUrl || ''), status }, true));
    req.on('error', (e) => fin({ type: 'error', reason: REASONS.UNREACHABLE, status: 'failed', tag: errTag(e) }, false));
    req.on('response', (res) => {
      const chunks = [];
      let total = 0;
      const headers = res.headers || {};
      res.on('data', (c) => {
        if (done) return;
        total += c.length;
        if (total > LIMITS.MAX_BYTES.internal) return fin({ type: 'error', reason: REASONS.TOO_LARGE, status: 'failed', tag: 'too-large' }, true);
        chunks.push(Buffer.from(c));
      });
      res.on('end', () => fin({ type: 'response', status: res.statusCode, headers, buffer: Buffer.concat(chunks) }, false));
      res.on('error', (e) => fin({ type: 'error', reason: REASONS.UNREACHABLE, status: 'failed', tag: errTag(e) }, true));
    });
    try { req.end(); } catch (e) { fin({ type: 'error', reason: REASONS.UNREACHABLE, status: 'failed', tag: errTag(e) }, false); }
  });
}

/**
 * Network fetch with per-hop classification and pre-lookup. Resolves with
 * { type:'response', status, headers, buffer, finalUrl } | { type:'handoff', url, hops } |
 * { type:'item', item }.
 */
async function _netFetch(u, cls, ses, ctx, deps, state) {
  const electron = deps.electron;
  const now = deps.now || Date.now;
  let cur = u;
  for (;;) {
    const host = _host(cur);
    if (await _resolvesLocal(host, deps)) return { type: 'item', item: _item('page', 'blocked', REASONS.LOCAL_ADDRESS) };
    state.requests++;
    const r = await _netOnce(electron, ses, cur, ctx, state.endAt, now);
    if (r.type === 'error') return { type: 'item', item: _item('page', r.status, r.reason), tag: r.tag };
    if (r.type === 'response') return Object.assign(r, { finalUrl: cur });
    // redirect: decided here, followed as a new request after the pre-lookup
    let next;
    try { next = new URL(r.location, cur).href; } catch (_) { return { type: 'item', item: _item('page', 'failed', REASONS.REDIRECT_DISALLOWED) }; }
    if (state.hops >= LIMITS.INT_MAX_REDIRECTS) return { type: 'item', item: _item('page', 'failed', REASONS.TOO_MANY_REDIRECTS) };
    state.hops++;
    const c = classifyUrl(next);
    if (isSsoNavHost(next) || c.kind === 'internal' || (c.kind === 'vendor' && c.partition === (cls.partition || null))) {
      if (cls.kind === 'vendor' && c.kind === 'internal') return { type: 'item', item: _item('page', 'blocked', REASONS.REDIRECT_DISALLOWED) };
      cur = next;
      continue;
    }
    if (c.kind === 'external') return { type: 'handoff', url: next, hops: state.hops };
    return { type: 'item', item: _item('page', 'blocked', REASONS.REDIRECT_DISALLOWED) };
  }
}

function _titleOf(buf) {
  const s = buf.subarray(0, 65536).toString('latin1');
  const lower = s.toLowerCase();
  const i = lower.indexOf('<title');
  if (i < 0) return '';
  const j = lower.indexOf('>', i);
  const k = lower.indexOf('</title', j + 1);
  return j < 0 || k < 0 ? '' : s.slice(j + 1, Math.min(k, j + 1 + 300));
}

function _signinReason(cls, deps) {
  if (cls.kind === 'vendor') return REASONS.VENDOR_SIGNIN;
  try {
    const chk = (deps.checkMwinit || require('../scrapers/auth').checkMwinit)();   // read-only helper
    if (chk && chk.ok === false) return /^Cannot read cookie file/.test(String(chk.reason || '')) ? REASONS.MIDWAY_UNREADABLE : REASONS.MIDWAY_EXPIRED;
  } catch (_) { /* fall through to the plain reason */ }
  return REASONS.NEEDS_SIGNIN;
}

const _wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Step 2: filtered offscreen render. Resolves { title, text, finalUrl, cancelled } or { error }.
async function _render(u, cls, ses, ctx, deps) {
  const electron = deps.electron;
  const now = deps.now || Date.now;
  const timing = Object.assign({ pollMs: 750, settleMs: 15000 }, deps.renderTiming || {});
  const endAt = Math.min(now() + LIMITS.INT_RENDER_TIMEOUT_MS, Number.isFinite(ctx.deadline) ? ctx.deadline : Infinity);
  let win = null;
  let cancelled = 0;
  let onDownload = null;
  let filterSet = false;
  let timer = null;
  try {
    win = new electron.BrowserWindow({
      show: false, width: 1400, height: 900, x: -4000, y: -4000, paintWhenInitiallyHidden: true, skipTaskbar: true,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    const wcId = wc.id;
    const staticHosts = RENDER_STATIC_HOSTS[cls.kind] || [];
    const allowNav = (url) => _sameClass(url, cls);
    const allowReq = (d) => {
      if (allowNav(d.url)) return true;
      return staticHosts.includes(_host(d.url)) && d.method === 'GET' && STATIC_TYPES.has(d.resourceType) && classifyUrl(d.url).kind !== 'blocked';
    };
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
      if (/^(data|blob):/i.test(details.url)) return cb({});                       // inline, no network
      if (details.webContentsId === wcId) {
        if (allowReq(details)) return cb({});
        cancelled++;
        return cb({ cancel: true });
      }
      if (details.webContentsId == null && classifyUrl(details.url).kind === 'blocked') return cb({ cancel: true }); // service workers: no private/local targets
      return cb({});                                                               // other windows untouched
    });
    filterSet = true;
    onDownload = (e, item, fromWc) => { if (fromWc === wc) { try { e.preventDefault(); } catch (_) {} try { item.cancel(); } catch (_) {} } };
    ses.on('will-download', onDownload);
    wc.on('will-frame-navigate', (e) => { if (!allowNav(e.url)) e.preventDefault(); });
    wc.on('will-navigate', (e, url) => { if (!allowNav((e && e.url) || url)) e.preventDefault(); });
    wc.on('will-redirect', (e, url) => { if (!allowNav((e && e.url) || url)) e.preventDefault(); });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), Math.max(0, endAt - now())); });
    const abort = new Promise((resolve) => {
      if (!ctx.signal) return;
      if (ctx.signal.aborted) return resolve({ error: 'abort' });
      ctx.signal.addEventListener('abort', () => resolve({ error: 'abort' }), { once: true });
    });
    const work = (async () => {
      await wc.loadURL(u);
      const settleEnd = now() + timing.settleMs;
      let last = -1, stable = 0;
      while (now() < settleEnd) {
        const len = await wc.executeJavaScript(LEN_JS);
        stable = len === last ? stable + 1 : 0;
        last = len;
        if (stable >= 2) break;
        await _wait(timing.pollMs);
      }
      const r = await wc.executeJavaScript(EXTRACT_JS);
      let finalUrl = u;
      try { finalUrl = wc.getURL() || u; } catch (_) {}
      return { title: String((r && r.title) || '').slice(0, 300), text: String((r && r.text) || '').slice(0, LIMITS.RAW_TEXT_MAX_CHARS), finalUrl };
    })().catch((e) => ({ error: errTag(e) }));
    const res = await Promise.race([work, timeout, abort]);
    return Object.assign(res, { cancelled });
  } catch (e) {
    return { error: errTag(e), cancelled };
  } finally {
    clearTimeout(timer);
    if (filterSet) { try { ses.webRequest.onBeforeRequest(null); } catch (_) {} }
    if (onDownload) { try { ses.removeListener('will-download', onDownload); } catch (_) {} }
    if (win) { try { win.destroy(); } catch (_) {} }
  }
}

/**
 * fetchInternal(url, cls, ctx, deps) -> item { kind, status, text, chars, truncated, reason, meta }
 * cls = classifyUrl(url) with kind 'internal' or 'vendor'. ctx = the gather context
 * (passed unchanged to extractItem / fetchExternal so the worker session is shared).
 * deps: electron, dns, fetchExternal, extractItem, checkMwinit, logger, now, renderTiming.
 */
async function fetchInternal(url, cls, ctx, deps) {
  ctx = ctx || {};
  deps = Object.assign({}, deps || {});
  if (!deps.electron) deps.electron = require('electron');
  const electron = deps.electron;
  const now = deps.now || Date.now;
  const log = _logger(deps);
  const t0 = now();
  const host = _host(url);
  const state = { hops: 0, requests: 0, endAt: Math.min(t0 + LIMITS.INT_NET_TIMEOUT_MS, Number.isFinite(ctx.deadline) ? ctx.deadline : Infinity) };
  let cancelled = 0;
  const done = (item, tag) => {
    try { log.info('[jmctx][' + (ctx.jobId || '-') + '] int ' + host + ' ' + tag + ' cancelled=' + cancelled + ' ' + (now() - t0) + 'ms'); } catch (_) {}
    return item;
  };
  const extractItem = deps.extractItem || require('./extract-host').extractItem;
  const handoff = (r) => {
    const fx = deps.fetchExternal || require('./fetch-external').fetchExternal;
    return fx(r.url, ctx, deps, r.hops);
  };
  const ses = cls.partition ? electron.session.fromPartition(cls.partition) : electron.session.defaultSession;
  const nameOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '').slice(0, 120); } catch (_) { return ''; } };

  // fix 5: SharePoint same-host direct download first.
  const spUrl = cls.kind === 'internal' ? sharepointDownloadUrl(url) : null;
  if (spUrl) {
    const r = await _netFetch(spUrl, cls, electron.session.defaultSession, ctx, deps, state);
    if (r.type === 'item' && r.item.status === 'blocked') return done(r.item, 'blocked');
    if (r.type === 'item' && r.item.status === 'skipped') return done(r.item, 'abort');
    if (r.type === 'response' && r.status === 200 && !_isHtml(_mime(r.headers)) && r.buffer.length) {
      const item = await extractItem({ buffer: r.buffer, name: nameOf(r.finalUrl), mimetype: _mime(r.headers) }, ctx, deps);
      item.meta = Object.assign({}, item.meta || {}, { via: 'sharepoint-download' });
      return done(item, '200 sharepoint-download');
    }
    state.hops = 0;   // fall through to the normal page fetch
  }

  const r = await _netFetch(url, cls, ses, ctx, deps, state);
  if (r.type === 'handoff') return done(await handoff(r), 'handoff');
  if (r.type === 'item' && (r.item.status === 'blocked' || r.item.status === 'skipped')) return done(r.item, r.item.status);
  let item = null;
  let needRender = false;
  let loginLike = false;
  if (r.type === 'item') {
    if (r.item.reason !== REASONS.UNREACHABLE && r.item.reason !== REASONS.TIMEOUT) return done(r.item, r.tag || 'failed');
    needRender = true;   // net error: the browser may still reach it (proxy/PAC)
  } else if (r.status === 401 || r.status === 403) {
    needRender = true;
  } else if (r.status !== 200) {
    return done(_item('page', 'failed', REASONS.HTTP_ERROR, { meta: { status: r.status } }), String(r.status));
  } else {
    const mime = _mime(r.headers);
    item = await extractItem({ buffer: r.buffer, name: nameOf(r.finalUrl), mimetype: mime || 'application/octet-stream' }, ctx, deps);
    if (item.kind !== 'html') return done(item, '200 ' + r.buffer.length + 'B');
    item.kind = 'page';
    const title = _titleOf(r.buffer);
    loginLike = _host(r.finalUrl) === 'midway-auth.amazon.com' || LOGIN_TITLE_RE.test(title);
    needRender = item.status === 'failed' || item.chars < THIN_TEXT_CHARS || loginLike;
    if (!needRender) return done(item, '200 ' + r.buffer.length + 'B');
  }
  if (ctx.signal && ctx.signal.aborted) return done(_item('page', 'skipped', REASONS.BUDGET), 'abort');

  // Step 2: offscreen render
  const rr = await _render(url, cls, ses, ctx, deps);
  cancelled = rr.cancelled || 0;
  if (rr.error) {
    if (rr.error === 'abort') return done(_item('page', 'skipped', REASONS.BUDGET), 'render-abort');
    // The static text from step 1 is still usable unless it was a login page.
    if (item && !loginLike && item.status !== 'failed' && item.text) return done(item, 'render-' + rr.error);
    return done(_item('page', 'failed', rr.error === 'timeout' ? REASONS.TIMEOUT : REASONS.RENDER_FAILED), 'render-' + rr.error);
  }
  if (_host(rr.finalUrl) === 'midway-auth.amazon.com' || LOGIN_TITLE_RE.test(rr.title)) {
    return done(_item('page', 'failed', _signinReason(cls, deps)), 'signin');
  }
  const text = rr.text;
  const truncated = text.length >= LIMITS.RAW_TEXT_MAX_CHARS;
  if (cancelled > 0 && text.trim().length < THIN_TEXT_CHARS) {
    return done(text.trim() ? _item('page', 'read', REASONS.THIN_PAGE, { text, chars: text.length }) : _item('page', 'failed', REASONS.THIN_PAGE), 'thin');
  }
  if (!text.trim()) return done(_item('page', 'failed', REASONS.HTML_EMPTY), 'empty');
  return done(_item('page', truncated ? 'truncated' : 'read', '', { text, chars: text.length, truncated, meta: { via: 'render' } }), 'rendered');
}

module.exports = { fetchInternal, sharepointDownloadUrl, EXTRACT_JS, __test__: { titleOf: _titleOf, resolvesLocal: _resolvesLocal } };
