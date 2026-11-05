'use strict';
/**
 * scrapers/sp_sheet_transport.js - hidden SharePoint window for the Long Dwell
 * weekly sheet (preview, then write). Same window recipe as sharepoint_push
 * spRun (show:false, off-screen, nodeIntegration:false, contextIsolation:true,
 * session.defaultSession, cookies only), but with an SSO settle state machine:
 *
 *   did-finish-load -> already started? ignore
 *                   -> login landing   arm a 15 s settle timer (once) and wait
 *                   -> other host/path auth-required at once
 *                   -> target site     started; the page function runs EXACTLY once per op
 *   settle timer fires                 auth-required
 *   main-frame did-fail-load           network
 *
 * Exports resolveFile, downloadFile, fileMeta, uploadFile (inside the push's
 * _withWriteLock, wait <= 90 s -> busy), withSession (one window for a whole
 * write cycle; the caller holds the lock) and the pure classifyLandingUrl.
 * No auth code is called or changed here.
 *
 * Logs: op names, counts and codes only. Never a URL query, file name or cell text.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger').createLogger('sp_sheet_transport');

const PAGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'sp_sheet_page.js'), 'utf8');
const PAGE_FUNCTIONS = ['spSheetResolve', 'spSheetMeta', 'spSheetGet', 'spSheetPut'];
const TIMEOUTS = Object.freeze({ resolve: 30000, meta: 30000, preview: 90000, write: 180000 });
const SETTLE_MS = 15000;
const LOCK_WAIT_MS = 90000;
const MAX_BYTES = 8 * 1024 * 1024;
const THROTTLE_MAX_WAIT_MS = 10000;
const HOST_RE = /^[a-z0-9-]+\.sharepoint\.com$/i;
const SITE_RE = /^(\/(sites|teams|personal)\/[^/?#]+)?$/i;

// ── pure: where did the hidden window land? ─────────────────────────────────
function classifyLandingUrl(url, host, site) {
  let u;
  try { u = new URL(String(url || '')); } catch { return 'other'; }
  const h = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase();
  if (h === 'login.microsoftonline.com' || h.endsWith('.microsoftonline.com') || h === 'login.live.com'
    || h.startsWith('midway-auth') || p.includes('/oauth2/authorize') || p.includes('/_forms/default.aspx')
    || p.includes('/_layouts/15/authenticate.aspx')) return 'login';
  if (u.protocol !== 'https:') return 'other';
  if (h !== String(host || '').toLowerCase()) return 'other';
  const s = String(site || '').toLowerCase();
  if (s && !(p === s || p.startsWith(s + '/'))) return 'other';
  return 'target';
}

function _validTarget(t) {
  return !!(t && HOST_RE.test(String(t.host || '')) && SITE_RE.test(String(t.site == null ? '' : t.site)));
}

function _electron() { return require('electron'); }
function _lock() { return require('./sharepoint_push')._withWriteLock; }
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function _logInternal(op, e) { logger.error('[sp-sheet] internal', { op, name: (e && e.name) || 'Error' }); }

// ── session: one hidden window ──────────────────────────────────────────────
function openSession(host, site) {
  const { BrowserWindow, session } = _electron();
  const win = new BrowserWindow({
    width: 800, height: 600, show: false, x: -3000, y: -3000,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
  });
  const wc = win.webContents;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  };
  const ready = new Promise((resolve) => {
    let started = false, done = false, settle = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (settle) { clearTimeout(settle); settle = null; }
      try { wc.removeListener('did-finish-load', onLoad); } catch { /* ignore */ }
      try { wc.removeListener('did-fail-load', onFail); } catch { /* ignore */ }
      resolve(r);
    };
    function onLoad() {
      if (started) return;
      let url = '';
      try { url = wc.getURL(); } catch { /* ignore */ }
      const kind = classifyLandingUrl(url, host, site);
      if (kind === 'login') {
        if (!settle) settle = setTimeout(() => finish({ ok: false, code: 'auth-required' }), SETTLE_MS);
        return;
      }
      if (kind === 'other') { finish({ ok: false, code: 'auth-required' }); return; }
      started = true;
      finish({ ok: true });
    }
    function onFail(_e, code, _desc, _url, isMainFrame) {
      if (code === -3 || isMainFrame === false) return;
      finish({ ok: false, code: 'network' });
    }
    wc.on('did-finish-load', onLoad);
    wc.on('did-fail-load', onFail);
  });
  try {
    const p = win.loadURL('https://' + host + (site || '') + '/_layouts/15/blank.htm');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* ignore */ }
  const run = async (fnName, cfg) => {
    if (!PAGE_FUNCTIONS.includes(fnName)) return { ok: false, code: 'internal' };
    const r = await wc.executeJavaScript(PAGE_SCRIPT + '\n;' + fnName + '(' + JSON.stringify(cfg || {}) + ')');
    return r && typeof r === 'object' ? r : { ok: false, code: 'internal' };
  };
  return { ready, run, close, window: win };
}

// Operations bound to one open session.
function _ops(sess, target) {
  const base = { origin: 'https://' + target.host, site: target.site || '', serverRelativeUrl: target.serverRelativeUrl };
  const meta = () => sess.run('spSheetMeta', base);
  const get = async () => {
    let r = await sess.run('spSheetGet', { ...base, maxBytes: MAX_BYTES, bust: Date.now() });
    if (!r.ok && r.code === 'throttled') {
      await _sleep(Math.min(Number(r.retryAfterMs) > 0 ? Number(r.retryAfterMs) : 3000, THROTTLE_MAX_WAIT_MS));
      r = await sess.run('spSheetGet', { ...base, maxBytes: MAX_BYTES, bust: Date.now() });
    }
    if (!r.ok) return { ok: false, code: r.code || 'internal', http: r.http };
    const bytes = new Uint8Array(Buffer.from(String(r.b64 || ''), 'base64'));
    return { ok: true, bytes, length: bytes.length };
  };
  const _metaFail = (m) => ({ ok: false, code: m.code === 'auth-required' ? 'auth-required' : 'guard-unavailable' });
  // meta M0, GET, meta M0b; repeated once when M0b differs from M0.
  const download = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const m0 = await meta();
      if (!m0.ok) return _metaFail(m0);
      const g = await get();
      if (!g.ok) return g;
      const m0b = await meta();
      if (!m0b.ok) return _metaFail(m0b);
      if (m0b.etag === m0.etag && m0b.modified === m0.modified) return { ok: true, bytes: g.bytes, meta: m0 };
    }
    return { ok: false, code: 'changed-since-preview' };
  };
  // Never retried. A thrown executeJavaScript after the call started is an unknown outcome.
  const put = async (bytes, opts = {}) => {
    const cfg = { ...base, b64: Buffer.from(bytes).toString('base64') };
    if (typeof opts.ifMatch === 'string' && opts.ifMatch) cfg.ifMatch = opts.ifMatch;
    try { return await sess.run('spSheetPut', cfg); } catch { return { ok: false, code: 'network', sent: true }; }
  };
  const resolve = (cfg) => sess.run('spSheetResolve', { ...cfg, origin: base.origin, site: base.site });
  return { meta, get, download, put, resolve };
}

// Opens one window, waits for the landing state machine, runs fn(ops), closes
// the window in finally. Overall timeout destroys the window.
async function withSession(target, fn, opts = {}) {
  if (!_validTarget(target)) return { ok: false, code: 'bad-target' };
  const op = opts.op || 'session';
  const timeoutMs = opts.timeoutMs || TIMEOUTS.write;
  let sess = null, timer = null;
  try {
    sess = openSession(target.host, target.site || '');
    const s = sess;
    const work = (async () => {
      const r = await s.ready;
      if (!r.ok) return r;
      return fn(_ops(s, target));
    })();
    work.catch(() => {});
    const timeout = new Promise((res) => { timer = setTimeout(() => res({ ok: false, code: 'timeout' }), timeoutMs); });
    const out = await Promise.race([work, timeout]);
    if (out && out.ok === false) logger.warn('[sp-sheet] ' + op, { code: out.code });
    return out;
  } catch (e) {
    _logInternal(op, e);
    return { ok: false, code: 'internal' };
  } finally {
    if (timer) clearTimeout(timer);
    if (sess) sess.close();
  }
}

// Waits for the shared write lock at most waitMs; a cancelled waiter becomes a no-op.
function lockWithTimeout(lockFn, waitMs, fn) {
  return new Promise((resolve) => {
    let cancelled = false;
    const t = setTimeout(() => { cancelled = true; resolve({ ok: false, code: 'busy' }); }, waitMs);
    let p;
    try {
      p = lockFn(async () => {
        if (cancelled) return;
        clearTimeout(t);
        try { resolve(await fn()); } catch (e) { _logInternal('lock', e); resolve({ ok: false, code: 'internal' }); }
      });
    } catch (e) {
      clearTimeout(t); _logInternal('lock', e); resolve({ ok: false, code: 'internal' }); return;
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });
}

// ── public operations ───────────────────────────────────────────────────────
// parsed: parseSheetLink() result; linkUrl: the stored link (sent only to the page).
async function resolveFile(parsed, linkUrl) {
  if (!parsed || !parsed.ok) return { ok: false, code: 'unresolvable-link' };
  const target = { host: parsed.host, site: parsed.site || '', serverRelativeUrl: null };
  const r = await withSession(target, (ops) => ops.resolve({
    serverRelativeUrl: parsed.serverRelativeUrl || null, fileGuid: parsed.fileGuid || null, linkUrl: linkUrl || parsed.canonicalUrl || null,
  }), { op: 'resolve', timeoutMs: TIMEOUTS.resolve });
  if (r && r.ok) {
    logger.info('[sp-sheet] resolved', { strategy: r.strategy, failures: (r.failures || []).length });
    return { ok: true, host: r.host, site: r.site, serverRelativeUrl: r.serverRelativeUrl, uniqueId: r.uniqueId, name: r.name, etag: r.etag, length: r.length };
  }
  if (r && Array.isArray(r.failures)) logger.warn('[sp-sheet] resolve failed', { code: r.code, steps: r.failures.map((f) => ({ strategy: f.strategy, code: f.code, http: f.http })) });
  return { ok: false, code: (r && r.code) || 'internal' };
}

async function downloadFile(target) {
  const r = await withSession(target, (ops) => ops.download(), { op: 'download', timeoutMs: TIMEOUTS.preview });
  if (r && r.ok) logger.info('[sp-sheet] downloaded', { bytes: r.bytes.length });
  return r;
}

function fileMeta(target) {
  return withSession(target, (ops) => ops.meta(), { op: 'meta', timeoutMs: TIMEOUTS.meta });
}

function uploadFile(target, bytes, opts = {}) {
  return lockWithTimeout(_lock(), LOCK_WAIT_MS, () => withSession(target, (ops) => ops.put(bytes, { ifMatch: opts.ifMatch }), { op: 'upload', timeoutMs: TIMEOUTS.write }));
}

module.exports = {
  classifyLandingUrl, openSession, withSession, lockWithTimeout,
  resolveFile, downloadFile, fileMeta, uploadFile,
  TIMEOUTS, SETTLE_MS, LOCK_WAIT_MS, MAX_BYTES,
};
