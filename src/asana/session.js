'use strict';
/**
 * asana/session.js — Asana access over the Amazon Midway SSO session.
 *
 * WHY: this org's Asana is behind Amazon Midway SSO and blocks both PATs and
 * self-registered OAuth apps. So — exactly like the Uptake scraper — we drive
 * Asana inside an Electron window that carries the app's existing Midway
 * session cookies, and call Asana's API in-window with credentials:'include'.
 *
 * AUTH MODEL (resolved live via asana/discover.js):
 *   - COOKIES_ONLY: the session cookies alone authorize /api/1.0 calls. Default.
 *   - BEARER: the SPA attaches an Authorization bearer we capture via CDP, then
 *     replay on API calls (the Uptake ladder). Enabled when a bearer is seen.
 *
 * The window is created lazily, kept warm across calls, re-seeded with the
 * freshest Midway cookies on each use, and torn down when idle.
 *
 * PUBLIC API:
 *   asanaApi(path, method='GET', body=null) -> parsed JSON data (throws on error)
 *   checkAuth() -> { ok, user, email, gid } | { ok:false, error }
 *   dispose()   -> tears the warm window down
 */

const logger = require('../utils/logger')('asana:session');

const ASANA_BASE   = 'https://app.asana.com';
const ASANA_HOME   = 'https://app.asana.com/0/home';
const PARTITION    = 'persist:asana';

const MIDWAY_RE = /midway|sso\.amazon|oidc|oauth|federate\.amazon|midway-auth\.amazon\.com|signin\.aws/i;
const ASANA_RE  = /app\.asana\.com/i;

const NAV_TOTAL_MS = 45000;
const NAV_QUIET_MS = 1800;
const WARM_IDLE_MS = 5 * 60 * 1000;   // tear the window down after 5 min idle

let _win = null;
let _warmTimer = null;
let _authHeader = null;    // captured bearer (if the SPA uses one)
let _dbgAttached = false;
let _lock = Promise.resolve();   // serialize access to the single window

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Run fn with exclusive access to the shared window (simple promise-chain mutex).
function _withLock(fn) {
  const next = _lock.then(fn, fn);
  _lock = next.then(() => {}, () => {});
  return next;
}

function _scheduleTeardown() {
  if (_warmTimer) clearTimeout(_warmTimer);
  _warmTimer = setTimeout(() => dispose(), WARM_IDLE_MS);
  if (_warmTimer.unref) _warmTimer.unref();
}

function dispose() {
  if (_warmTimer) { clearTimeout(_warmTimer); _warmTimer = null; }
  try { if (_dbgAttached && _win && !_win.isDestroyed()) _win.webContents.debugger.detach(); } catch (_) {}
  _dbgAttached = false;
  try { if (_win && !_win.isDestroyed()) _win.destroy(); } catch (_) {}
  _win = null;
}

// Wait until navigation quiets (SPA fires did-finish-load repeatedly on SSO).
function _waitQuiet(win, totalMs, quietMs) {
  return new Promise((resolve) => {
    let last = Date.now();
    let done = false;
    const onNav = () => { last = Date.now(); };
    try { win.webContents.on('did-finish-load', onNav); } catch (_) {}
    const started = Date.now();
    const iv = setInterval(() => {
      if (done || win.isDestroyed()) { clearInterval(iv); return; }
      if (Date.now() - last > quietMs || Date.now() - started > totalMs) {
        done = true; clearInterval(iv);
        try { win.webContents.removeListener('did-finish-load', onNav); } catch (_) {}
        resolve();
      }
    }, 250);
  });
}

// Attach CDP once to capture a bearer the SPA may send to its own API.
function _attachBearerCapture(win) {
  if (_dbgAttached) return;
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) { dbg.attach('1.3'); _dbgAttached = true; }
    dbg.sendCommand('Network.enable');
    dbg.on('message', (_e, method, params) => {
      try {
        if (method !== 'Network.requestWillBeSent') return;
        const u = (params.request && params.request.url) || '';
        if (!/asana\.com\/api\//.test(u)) return;
        const h = params.request.headers || {};
        const a = h.Authorization || h.authorization;
        if (a && /bearer/i.test(a)) _authHeader = a;
      } catch (_) {}
    });
  } catch (e) {
    logger.warn('CDP attach failed (bearer capture disabled): ' + e.message);
  }
}

// Ensure a warm, authenticated Asana window exists. Re-seeds Midway cookies
// each time so it rides the freshest session. Returns the window or throws.
async function _ensureWindow() {
  const { BrowserWindow } = require('electron');
  const { injectCookies } = require('../scrapers/auth');

  if (_win && !_win.isDestroyed()) {
    // Re-seed cookies (cheap) so a long-lived warm window stays authed.
    try { await injectCookies(_win.webContents.session); } catch (_) {}
    _scheduleTeardown();
    return _win;
  }

  const win = new BrowserWindow({
    show: false, skipTaskbar: true, width: 1440, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: PARTITION },
  });
  _win = win;
  _attachBearerCapture(win);

  await injectCookies(win.webContents.session);
  win.loadURL(ASANA_HOME);
  await _waitQuiet(win, NAV_TOTAL_MS, NAV_QUIET_MS);

  const url = win.webContents.getURL();
  if (MIDWAY_RE.test(url) && !ASANA_RE.test(url)) {
    // Still on the Midway/SSO wall — session not accepted (usually AEA posture).
    dispose();
    throw Object.assign(new Error('Asana not authenticated — stuck on Midway SSO (check AEA)'), { code: 'ASANA_SSO_WALL' });
  }
  // Give the SPA a beat to fire its API calls (lets CDP capture a bearer).
  await sleep(2500);
  _scheduleTeardown();
  return win;
}

// In-window fetch against Asana using session cookies (+ captured bearer).
async function _fetchInWindow(win, url, method, body) {
  const headers = { 'Accept': 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (_authHeader) headers['Authorization'] = _authHeader;
  const expr = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method || 'GET')},
        headers: ${JSON.stringify(headers)},
        credentials: 'include',
        ${body != null ? `body: ${JSON.stringify(JSON.stringify({ data: body }))},` : ''}
      });
      const txt = await res.text();
      let json = null;
      if (/json/i.test(res.headers.get('content-type') || '')) { try { json = JSON.parse(txt); } catch(_) {} }
      return { ok: res.ok, status: res.status, json, text: json ? null : txt.slice(0, 1000) };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  })()`;
  return await win.webContents.executeJavaScript(expr);
}

/**
 * asanaApi(path, method, body) — call the Asana API over the Midway session.
 * path: '/api/1.0/...' (or absolute). Returns parsed `data` (or full json),
 * throws Error on HTTP/network failure. Serialized through the shared window.
 */
async function asanaApi(path, method, body, opts) {
  return _withLock(async () => {
    const win = await _ensureWindow();
    const url = path.startsWith('http') ? path : (ASANA_BASE + path);
    const r = await _fetchInWindow(win, url, method || 'GET', body != null ? body : null);
    if (!r || !r.ok) {
      const msg = (r && r.json && r.json.errors && r.json.errors.map((e) => e.message).join(', '))
        || (r && (r.error || r.text)) || ('HTTP ' + (r && r.status));
      throw new Error('Asana API ' + (r && r.status) + ': ' + msg);
    }
    const j = r.json || {};
    // opts.raw -> return the full envelope ({ data, next_page }) for pagination.
    if (opts && opts.raw) return j;
    return j.data !== undefined ? j.data : j;
  });
}

async function checkAuth() {
  try {
    const me = await asanaApi('/api/1.0/users/me');
    return { ok: true, user: me.name, email: me.email, gid: me.gid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { asanaApi, checkAuth, dispose };
