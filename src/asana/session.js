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

const NAV_TOTAL_MS = 20000;
const NAV_QUIET_MS = 1500;
const AUTH_WAIT_MS = 40000;            // SAML SSO round-trip can take 10-20s
const WARM_IDLE_MS = 5 * 60 * 1000;   // tear the window down after 5 min idle

let _win = null;
let _warmTimer = null;
let _authHeader = null;    // captured bearer (if the SPA uses one)
let _asanaTicket = null;   // captured x-asana-ticket (Asana web session token)
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

// Attach CDP once to capture the Asana web session's auth header. CONFIRMED
// live: the Asana SPA authorizes its /api/1.0 calls with an `x-asana-ticket`
// header (+ `x-requested-with: XMLHttpRequest`), NOT a bearer and NOT cookies
// alone (cookie-only /api/1.0 returns 401). We grab the ticket off the wire and
// replay it on our in-window fetches.
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
        if (!/asana\.com/.test(u)) return;
        const h = params.request.headers || {};
        const a = h.Authorization || h.authorization;
        if (a && /bearer/i.test(a)) _authHeader = a;
        const ticket = h['x-asana-ticket'] || h['X-Asana-Ticket'];
        if (ticket) _asanaTicket = ticket;
      } catch (_) {}
    });
  } catch (e) {
    logger.warn('CDP attach failed (ticket capture disabled): ' + e.message);
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

  // Asana auth is SAML SSO (confirmed: landing URL carries redirected_from=saml).
  // The handshake bounces app.asana.com/-/login -> Midway -> back, and only
  // THEN lands on an authenticated workspace path (app.asana.com/0/...). That
  // round-trip can take 10-20s, so poll until we're on an authed path rather
  // than trusting the first quiet moment (which is often still /-/login).
  const authed = await _waitForAsanaAuthed(win, AUTH_WAIT_MS);
  if (!authed) {
    const url = win.webContents.getURL();
    dispose();
    throw Object.assign(
      new Error('Asana SAML login did not complete (stuck at ' + url.split('?')[0] + ') — check Midway/AEA'),
      { code: 'ASANA_SSO_WALL' });
  }
  // Wait for the SPA to fire an authed request so CDP captures the
  // x-asana-ticket (what authorizes our API calls). Poll up to ~10s; if none
  // appears, nudge by reloading the tasks view (which fires ticketed calls).
  let waited = 0;
  while (!_asanaTicket && waited < 10000) { await sleep(500); waited += 500; }
  if (!_asanaTicket) {
    try { win.loadURL('https://app.asana.com/0/my-tasks'); await _waitQuiet(win, NAV_TOTAL_MS, NAV_QUIET_MS); } catch (_) {}
    waited = 0;
    while (!_asanaTicket && waited < 8000) { await sleep(500); waited += 500; }
  }
  if (!_asanaTicket) logger.warn('[session] authed but no x-asana-ticket captured yet — API calls may 401 until the SPA fires one');
  _scheduleTeardown();
  return win;
}

// Poll until the window is on an AUTHENTICATED Asana path. Authed = app.asana.com
// with a workspace path (/0/... or /app...) and NOT /-/login or an SSO/SAML hop.
function _waitForAsanaAuthed(win, totalMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(iv); resolve(false); return; }
      const url = win.webContents.getURL();
      const onLogin = /app\.asana\.com\/-\/(login|saml)/i.test(url);
      const onMidway = MIDWAY_RE.test(url) && !ASANA_RE.test(url);
      const authed = ASANA_RE.test(url) && !onLogin && /\/(0|app)\b|\/0\//.test(url);
      if (authed) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - started > totalMs) { clearInterval(iv); resolve(false); return; }
      void onMidway;
    }, 500);
  });
}

// In-window fetch against Asana. Runs from the AUTHENTICATED Asana page context
// so it inherits the SPA's session cookies; also replays the captured
// x-asana-ticket + x-requested-with that the web app uses on its API calls.
async function _fetchInWindow(win, url, method, body) {
  const headers = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (_authHeader) headers['Authorization'] = _authHeader;
  if (_asanaTicket) headers['X-Asana-Ticket'] = _asanaTicket;
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

// First-time interactive sign-in: Asana's SAML flow shows its own login page
// (email entry) on a cold partition before handing off to Amazon Midway. Open
// a VISIBLE window so the user completes that once; the persist:asana partition
// then caches the Asana session and subsequent loads are silent. Resolves when
// authenticated (or rejects on timeout). Used by the Settings "Connect" button.
function signIn() {
  return _withLock(async () => {
    const { BrowserWindow } = require('electron');
    const { injectCookies } = require('../scrapers/auth');
    dispose();   // start clean so the visible window is the live one
    const win = new BrowserWindow({
      show: true, width: 1100, height: 820, title: 'Sign in to Asana',
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: PARTITION },
    });
    win.setMenuBarVisibility(false);
    _win = win;
    _attachBearerCapture(win);
    try { await injectCookies(win.webContents.session); } catch (_) {}
    win.loadURL(ASANA_HOME);
    const authed = await _waitForAsanaAuthed(win, 3 * 60 * 1000);   // 3 min for the user
    if (!authed) {
      return { ok: false, error: 'Sign-in not completed (still on the Asana/Midway login page)' };
    }
    // Capture the ticket, then verify the API actually works.
    let waited = 0;
    while (!_asanaTicket && waited < 10000) { await sleep(500); waited += 500; }
    let user = null;
    try {
      const me = await _fetchInWindow(win, ASANA_BASE + '/api/1.0/users/me', 'GET', null);
      if (me && me.ok && me.json && me.json.data) user = me.json.data;
    } catch (_) {}
    try { win.hide(); } catch (_) {}
    _scheduleTeardown();
    return user
      ? { ok: true, user: user.name, email: user.email, gid: user.gid }
      : { ok: true, note: 'Signed in; verify connection in Settings' };
  });
}

module.exports = { asanaApi, checkAuth, signIn, dispose };
