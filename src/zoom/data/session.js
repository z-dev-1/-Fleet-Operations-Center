'use strict';
/**
 * src/zoom/data/session.js — Fleet's own Zoom portal partition, seeding, hidden window and sign-in window.
 *
 * Nothing here runs until the user acts on a Zoom channel (the module is lazy-required by the hub).
 * Fleet never calls executeJavaScript / insertText / sendInputEvent or fills any form in these windows.
 * Every listener and timer body is wrapped in try/catch -> warn safeErr (never a message or URL).
 */
const C = require('../constants');
const { safeErr } = require('../redact');
const log = require('../../utils/logger')('zoom:data');

// Test seam: { electron, seeder, auth, seederDeps }. Production uses the real modules.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }

// ── Partition ──────────────────────────────────────────────────────────────
let _ses = null;

/** getSession() — the persist:fleet-zoom partition (memoized; the only place it is created). */
function getSession() {
  if (_ses) return _ses;
  const ses = _electron().session.fromPartition(C.PARTITION);
  // Deny every permission (camera, mic, notifications, ...) to the portal on THIS partition only;
  // defaultSession is never touched.
  // NOTE (review F-14): this deny-all is unverified against the Midway sign-in flow. The live run must
  // confirm Connect on a cold partition. If it fails, allow exactly the blocked permission for
  // midway-auth.amazon.com only and log it by name.
  try { ses.setPermissionRequestHandler((_wc, _perm, cb) => { try { cb(false); } catch (_) {} }); } catch (e) { log.warn('[zoom] permission handler', safeErr(e)); }
  try { ses.setPermissionCheckHandler(() => false); } catch (e) { log.warn('[zoom] permission check', safeErr(e)); }
  _ses = ses;
  return ses;
}

// ── Seeding ────────────────────────────────────────────────────────────────
let _seedDone = false;
let _seedP = null;

/**
 * ensureSeeded(reason) — single-flight, once per process (plus once after allowReseed()).
 * Propagation OFF: seedOrLegacy runs the injectCookies lambda unchanged.
 * Propagation ON: seedSession seeds this partition through the Amazon-host guard (no Zoom cookies are
 * touched); MIDWAY_PARTITIONS is irrelevant here.
 * Failures are recoverable (SSO or a manual sign-in may still work) and logged as safeErr only.
 */
function ensureSeeded(reason) {
  if (_seedDone) return Promise.resolve(true);
  if (_seedP) return _seedP;
  _seedP = (async () => {
    try {
      const ses = getSession();
      const seeder = _deps.seeder || require('../../auth/session-seeder');
      await seeder.seedOrLegacy(
        ses,
        { reason: 'zoom-' + String(reason || 'action').replace(/[^a-z0-9-]/gi, '').slice(0, 20), partition: C.PARTITION },
        () => (_deps.auth || require('../../scrapers/auth')).injectCookies(ses),
        _deps.seederDeps,
      );
    } catch (e) {
      log.warn('[zoom] seed failed', safeErr(e));
    } finally {
      _seedDone = true;
      _seedP = null;
    }
    return true;
  })();
  return _seedP;
}

/** allowReseed() — permit one more seed (after a re-warm). */
function allowReseed() { _seedDone = false; }

// ── Navigation guard ───────────────────────────────────────────────────────
function _navUrl(ev, urlArg) {
  if (ev && typeof ev.url === 'string') return ev.url;
  return typeof urlArg === 'string' ? urlArg : '';
}

function _guardNav(wc, which) {
  const block = (op) => (ev, urlArg) => {
    try {
      if (op === 'will-frame-navigate' && ev && ev.isMainFrame === false) return;
      const url = _navUrl(ev, urlArg);
      if (!C.isNavAllowed(url)) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        log.warn('[zoom] nav', { op: 'nav-blocked', window: which, hostKind: C.hostKind(url) });
      }
    } catch (e) {
      try { log.warn('[zoom] nav', safeErr(e)); } catch (_) {}
    }
  };
  wc.on('will-navigate', block('will-navigate'));
  wc.on('will-frame-navigate', block('will-frame-navigate'));
  wc.on('will-redirect', block('will-redirect'));
}

function _webPreferences() {
  return { partition: C.PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true };
}

function _isDestroyed(win) {
  try { return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed()); } catch (_) { return true; }
}

function _currentUrl(win) {
  try { return _isDestroyed(win) ? '' : String(win.webContents.getURL() || ''); } catch (_) { return ''; }
}

/** isAuthedUrl(url) — the probe rule: on PORTAL_HOST and not on a sign-in path. */
function isAuthedUrl(url) {
  const u = C.parseUrl(url);
  if (!u || u.protocol !== 'https:' || u.hostname.toLowerCase() !== C.PORTAL_HOST) return false;
  if (C.SIGNIN_PATH_RE.test(u.pathname)) return false;
  if (C.AUTH_HOST_RE.test(u.pathname)) return false;
  return true;
}

// ── Timers (all cleared on teardown; F-16) ─────────────────────────────────
const _polls = new Set();   // { iv, resolve, win }

/** waitForAuthed(win, ms) -> {ok:true} | {ok:false, lastHostKind}. Polls every 500 ms. */
function waitForAuthed(win, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = { iv: null, resolve: null, win };
    const done = (r) => {
      if (!_polls.has(p)) return;
      _polls.delete(p);
      clearInterval(p.iv);
      resolve(r);
    };
    p.resolve = done;
    _polls.add(p);
    const tick = () => {
      try {
        if (_isDestroyed(win)) { done({ ok: false, lastHostKind: 'other', destroyed: true }); return; }
        const url = _currentUrl(win);
        if (isAuthedUrl(url)) { done({ ok: true }); return; }
        if (Date.now() - started >= ms) done({ ok: false, lastHostKind: C.hostKind(url) });
      } catch (e) {
        try { log.warn('[zoom] auth poll', safeErr(e)); } catch (_) {}
        done({ ok: false, lastHostKind: 'other' });
      }
    };
    p.iv = setInterval(tick, C.AUTH_POLL_MS);
  });
}

function _clearPolls(win) {
  for (const p of Array.from(_polls)) { if (win && p.win !== win) continue; try { p.resolve({ ok: false, lastHostKind: 'other', destroyed: true }); } catch (_) {} }
}

/** load(win, url) -> {} | {code:'NETWORK'}. ERR_ABORTED (redirects, blocked or replaced navigations) is not a failure. */
async function load(win, url) {
  if (_isDestroyed(win)) return { code: 'CAPTURE_FAILED' };
  let timer = null;
  try {
    const loading = Promise.resolve().then(() => win.loadURL(url)).then(() => ({}), (e) => {
      if (e && (e.code === 'ERR_ABORTED' || e.errno === -3)) return {};
      log.warn('[zoom] load', safeErr(e));
      return { code: 'NETWORK' };
    });
    // loadURL may never settle on a long-polling SPA: stop waiting after NET_TIMEOUT_MS (not an error).
    const capped = new Promise((resolve) => { timer = setTimeout(() => { try { resolve({}); } catch (_) {} }, C.NET_TIMEOUT_MS); });
    return await Promise.race([loading, capped]);
  } catch (e) {
    log.warn('[zoom] load', safeErr(e));
    return { code: 'NETWORK' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Hidden window ──────────────────────────────────────────────────────────
let _hidden = null;          // { win, capture, crashed }
let _lock = Promise.resolve();
let _idleTimer = null;
let _quitHooked = false;

function _withLock(fn) {
  const run = _lock.then(() => fn());
  _lock = run.then(() => {}, () => {});
  return run;
}

function _hookQuit() {
  if (_quitHooked) return;
  _quitHooked = true;
  try {
    const app = _electron().app;
    if (app && typeof app.once === 'function') app.once('before-quit', () => { try { teardownAll(); } catch (e) { log.warn('[zoom] quit teardown', safeErr(e)); } });
  } catch (e) { log.warn('[zoom] quit hook', safeErr(e)); }
}

function _createHidden() {
  const { BrowserWindow } = _electron();
  getSession();
  const win = new BrowserWindow({
    show: false, skipTaskbar: true, x: -32000, y: -32000, width: 1280, height: 800, focusable: false,
    webPreferences: _webPreferences(),
  });
  const h = { win, capture: null, crashed: false };
  const wc = win.webContents;
  try { wc.setAudioMuted(true); } catch (e) { log.warn('[zoom] mute', safeErr(e)); }
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  _guardNav(wc, 'hidden');
  win.on('show', () => { try { win.hide(); } catch (e) { log.warn('[zoom] hide', safeErr(e)); } });
  wc.on('render-process-gone', (_e, details) => {
    try {
      h.crashed = true;
      log.warn('[zoom] hidden window gone', { op: 'render-process-gone', reason: details && typeof details.reason === 'string' ? details.reason.slice(0, 30) : 'unknown' });
    } catch (e) { try { log.warn('[zoom] gone', safeErr(e)); } catch (_) {} }
  });
  // CDP capture attaches BEFORE any loadURL.
  const capture = require('./cdp-capture').createCapture(wc);
  try {
    capture.attach();
  } catch (e) {
    log.warn('[zoom] debugger attach failed', safeErr(e));
    try { win.destroy(); } catch (_) {}
    const { ZoomError } = require('../errors');
    throw new ZoomError('CAPTURE_FAILED');
  }
  h.capture = capture;
  _hookQuit();
  log.info('[zoom] hidden window created', { op: 'window-created' });
  return h;
}

function _teardownHidden() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const h = _hidden;
  _hidden = null;
  if (!h) return;
  _clearPolls(h.win);
  try { if (h.capture) h.capture.detach(); } catch (e) { log.warn('[zoom] detach', safeErr(e)); }
  try { if (!_isDestroyed(h.win)) h.win.destroy(); } catch (e) { log.warn('[zoom] destroy', safeErr(e)); }
  log.info('[zoom] hidden window destroyed', { op: 'window-destroyed' });
}

function _armIdle() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    try {
      _idleTimer = null;
      _withLock(() => _teardownHidden()).catch((e) => { try { log.warn('[zoom] idle teardown', safeErr(e)); } catch (_) {} });
    } catch (e) { try { log.warn('[zoom] idle', safeErr(e)); } catch (_) {} }
  }, C.IDLE_TEARDOWN_MS);
}

/** withHiddenWindow(fn) — serialized by _withLock; fn receives {win, capture, crashed}. */
function withHiddenWindow(fn) {
  return _withLock(async () => {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_hidden && (_isDestroyed(_hidden.win) || _hidden.crashed)) _teardownHidden();
    if (!_hidden) _hidden = _createHidden();
    try {
      return await fn(_hidden);
    } finally {
      if (_hidden && _hidden.crashed) _teardownHidden();
      else if (_hidden) _armIdle();
    }
  });
}

/** getCapture() -> the live hidden window's capture | null. */
function getCapture() { return _hidden ? _hidden.capture : null; }

/** clearCaptured() — drop captured header values and templates (they belong to the old session). */
function clearCaptured() { try { if (_hidden && _hidden.capture) _hidden.capture.clear(); } catch (e) { log.warn('[zoom] clear', safeErr(e)); } }

// ── Connect / sign-in window ───────────────────────────────────────────────
let _connectP = null;
let _signinWin = null;

/**
 * connect(ctx) -> {ok:true, signedIn:true} | {ok:false, code:'SIGN_IN_TIMEOUT'|'CANCELLED'|'SSO_WALL'|...}
 * Single-flight: a second call returns the same promise and focuses the visible window.
 */
function connect(ctx) {
  if (_connectP) {
    try { if (_signinWin && !_isDestroyed(_signinWin)) _signinWin.focus(); } catch (e) { log.warn('[zoom] focus', safeErr(e)); }
    return _connectP;
  }
  _connectP = _connect(ctx).finally(() => { _connectP = null; });
  return _connectP;
}

async function _connect(ctx) {
  await ensureSeeded('connect');
  // 1. Silent attempt on the hidden window.
  let silent = { ok: false };
  try {
    silent = await withHiddenWindow(async (h) => {
      const lr = await load(h.win, C.PROFILE_URL);
      if (lr.code === 'NETWORK') return { ok: false, code: 'NETWORK' };
      return waitForAuthed(h.win, C.AUTH_WAIT_MS);
    });
  } catch (e) {
    log.warn('[zoom] silent connect', safeErr(e));
  }
  if (silent && silent.ok) {
    clearCaptured();
    log.info('[zoom] connect', { op: 'connect', code: 'OK', mode: 'silent' });
    return { ok: true, signedIn: true };
  }
  // 2. Visible sign-in window (the user signs in themselves; Fleet never fills anything).
  const r = await _visibleSignIn(ctx);
  log.info('[zoom] connect', { op: 'connect', code: r.ok ? 'OK' : r.code, mode: 'window' });
  if (r.ok) clearCaptured();
  return r;
}

function _visibleSignIn(ctx) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let settle = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (settle) clearTimeout(settle);
      _visibleTimers.delete(cancelAll);
      const w = _signinWin;
      _signinWin = null;
      try { if (w && !_isDestroyed(w)) w.close(); } catch (e) { log.warn('[zoom] close', safeErr(e)); }
      resolve(r);
    };
    const cancelAll = () => finish({ ok: false, code: 'CANCELLED' });
    _visibleTimers.add(cancelAll);
    try {
      const { BrowserWindow } = _electron();
      let parent = null;
      try { parent = ctx && ctx.mainWindow && !_isDestroyed(ctx.mainWindow) ? ctx.mainWindow : null; } catch (_) { parent = null; }
      const opts = {
        width: 1000, height: 800, title: 'Sign in to Zoom (Fleet)', show: true, autoHideMenuBar: true,
        webPreferences: _webPreferences(),
      };
      if (parent) opts.parent = parent;
      const win = new BrowserWindow(opts);
      _signinWin = win;
      try { win.setMenuBarVisibility(false); } catch (_) {}
      const wc = win.webContents;
      wc.setWindowOpenHandler((details) => {
        try {
          const url = details && details.url;
          // Popups are always denied; an allowed URL loads in this same window instead.
          if (C.isNavAllowed(url)) Promise.resolve().then(() => win.loadURL(url)).catch(() => {});
        } catch (e) { try { log.warn('[zoom] window-open', safeErr(e)); } catch (_) {} }
        return { action: 'deny' };
      });
      _guardNav(wc, 'signin');
      win.on('closed', () => { try { finish({ ok: false, code: 'CANCELLED' }); } catch (e) { log.warn('[zoom] closed', safeErr(e)); } });
      timer = setTimeout(() => { try { finish({ ok: false, code: 'SIGN_IN_TIMEOUT' }); } catch (e) { log.warn('[zoom] signin timeout', safeErr(e)); } }, C.SIGNIN_WINDOW_MS);
      load(win, C.SIGNIN_URL).catch(() => {});
      waitForAuthed(win, C.SIGNIN_WINDOW_MS).then((a) => {
        try {
          if (settled) return;
          if (!a.ok) {
            if (a.destroyed) finish({ ok: false, code: 'CANCELLED' });
            else finish({ ok: false, code: 'SIGN_IN_TIMEOUT' });
            return;
          }
          // Let cookies settle before closing the window.
          settle = setTimeout(() => { try { finish({ ok: true, signedIn: true }); } catch (e) { log.warn('[zoom] settle', safeErr(e)); } }, C.SIGNIN_SETTLE_MS);
        } catch (e) { try { log.warn('[zoom] signin', safeErr(e)); } catch (_) {} }
      }, () => finish({ ok: false, code: 'SIGN_IN_TIMEOUT' }));
    } catch (e) {
      log.warn('[zoom] signin window', safeErr(e));
      finish({ ok: false, code: 'CAPTURE_FAILED' });
    }
  });
}

const _visibleTimers = new Set();

/** teardownAll() — app before-quit: close every Zoom window and clear every timer. */
function teardownAll() {
  for (const c of Array.from(_visibleTimers)) { try { c(); } catch (_) {} }
  _teardownHidden();
  _clearPolls();
}

function _resetForTests() {
  try { teardownAll(); } catch (_) {}
  _ses = null; _seedDone = false; _seedP = null; _hidden = null; _lock = Promise.resolve();
  _idleTimer = null; _quitHooked = false; _connectP = null; _signinWin = null; _deps = {};
}

module.exports = {
  getSession, ensureSeeded, allowReseed, withHiddenWindow, waitForAuthed, isAuthedUrl, load, connect,
  getCapture, clearCaptured, teardownAll, _electron, _setDeps, _resetForTests, _withLock,
};
