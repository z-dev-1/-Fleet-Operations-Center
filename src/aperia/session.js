'use strict';
/**
 * src/aperia/session.js — persist:aperia partition, visible sign-in window on the portal, status.
 *
 * Nothing here runs on its own: the sign-in window is opened by a user action. The CDP Bearer capture
 * (./capture.js) attaches BEFORE the first loadURL; no webRequest listener and no page console listener
 * are installed. URLs and tokens are never logged. Status is computed on demand; no timer polls it.
 */
const { EventEmitter } = require('events');
const C = require('./constants');
const capture = require('./capture');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

// Test seam: { electron }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }

let _ses = null;
/** getSession() — memoized persist:aperia session. */
function getSession() {
  if (!_ses) _ses = _electron().session.fromPartition(C.PARTITION);
  return _ses;
}

// ── Status ─────────────────────────────────────────────────────────────────
const _bus = new EventEmitter();
let _everCaptured = false;
let _lastCode = null;
let _lastState = null;
let _lastPullAt = null;
let _reauthP = null;

function _state() {
  if (capture.current()) return 'connected';
  if (_loginP) return 'connecting';
  return _everCaptured ? 'expired' : 'signed-out';
}

/** status() -> { ok:true, state, secondsLeft, lastCode, lastPullAt } (no secrets, no network). */
function status() {
  return { ok: true, state: _state(), secondsLeft: capture.secondsLeft(), lastCode: _lastCode, lastPullAt: _lastPullAt };
}

/** notePull(atIso) — remember when the last successful Aperia read finished (shown in the panel). */
function notePull(atIso) {
  const ms = Date.parse(String(atIso || ''));
  _lastPullAt = Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function _emit() {
  try {
    const s = status();
    if (s.state === _lastState) return;
    _lastState = s.state;
    _bus.emit('status', s);
  } catch (e) { log.warn('[aperia] status', safeErr(e)); }
}

/** onStatus(fn) -> unsubscribe. fn(status) on every state change. */
function onStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  const h = (s) => { try { fn(s); } catch (e) { log.warn('[aperia] status listener', safeErr(e)); } };
  _bus.on('status', h);
  return () => _bus.removeListener('status', h);
}

/** onWindow(fn) -> unsubscribe. fn(win) right after the sign-in window is created, before its first load. */
function onWindow(fn) {
  if (typeof fn !== 'function') return () => {};
  const h = (w) => { try { fn(w); } catch (e) { log.warn('[aperia] window listener', safeErr(e)); } };
  _bus.on('window', h);
  return () => _bus.removeListener('window', h);
}

function noteResult(code) {
  _lastCode = typeof code === 'string' ? code.slice(0, 40) : null;
  if (_lastCode === 'APERIA_SESSION_EXPIRED') capture.clear();
  _emit();
}

/** logout() — drop the in-memory token (cookies in the partition are left to the portal). */
function logout() { capture.clearAll(); _emit(); return { ok: true, state: status().state }; }

// ── Sign-in window ─────────────────────────────────────────────────────────
function _isDestroyed(win) {
  try { return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed()); } catch (_) { return true; }
}

let _loginP = null;
let _loginWin = null;
let _quitHooked = false;

function _hookQuit() {
  if (_quitHooked) return;
  _quitHooked = true;
  try {
    const app = _electron().app;
    if (app && typeof app.once === 'function') app.once('before-quit', () => { try { teardownAll(); } catch (_) {} });
  } catch (e) { log.warn('[aperia] quit hook', safeErr(e)); }
}

/** loginWindow() -> the open sign-in BrowserWindow | null. */
function loginWindow() { return _loginWin && !_isDestroyed(_loginWin) ? _loginWin : null; }

/**
 * openLoginWindow(ctx) -> {ok:true, state:'connected'} | {ok:false, code:'APERIA_SIGNIN_CANCELLED'|'APERIA_SIGNIN_TIMEOUT'|'APERIA_CAPTURE_FAILED'}
 * Single-flight. Resolves on the first captured Bearer whose portal request succeeded; the window stays open.
 */
function openLoginWindow(ctx) {
  if (_loginP) { try { if (loginWindow()) _loginWin.focus(); } catch (_) {} return _loginP; }
  if (loginWindow()) {
    try { _loginWin.focus(); } catch (_) {}
    return Promise.resolve({ ok: true, state: status().state });
  }
  _loginP = _openLogin(ctx).finally(() => { _loginP = null; _emit(); });
  _emit();
  return _loginP;
}

function _openLogin(ctx) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let cap = null;
    let win = null;
    const finish = (r, close) => {
      if (!settled) {
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (r.ok) _everCaptured = true;
        log.info('[aperia] login', { op: 'login', code: r.ok ? 'OK' : r.code });
        resolve(r);
      }
      if (close && win && !_isDestroyed(win)) { try { win.close(); } catch (e) { log.warn('[aperia] close', safeErr(e)); } }
    };
    try {
      const { BrowserWindow } = _electron();
      getSession();
      let parent = null;
      try { parent = ctx && ctx.mainWindow && !_isDestroyed(ctx.mainWindow) ? ctx.mainWindow : null; } catch (_) { parent = null; }
      const opts = {
        title: 'Sign in: Aperia HALO Connect', width: 1200, height: 900, show: true, autoHideMenuBar: true,
        webPreferences: { partition: C.PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      };
      if (parent) opts.parent = parent;
      win = new BrowserWindow(opts);
      _loginWin = win;
      _hookQuit();
      const wc = win.webContents;
      win.on('page-title-updated', (e) => { try { e.preventDefault(); } catch (_) {} });
      // Popups: same-window navigation for portal / SSO https URLs, never a new window.
      wc.setWindowOpenHandler((details) => {
        try {
          const u = C.parseUrl(details && details.url);
          if (u && u.protocol === 'https:') Promise.resolve().then(() => win.loadURL(u.href)).catch(() => {});
        } catch (_) {}
        return { action: 'deny' };
      });
      win.on('closed', () => {
        try {
          if (cap) cap.detach();
          if (_loginWin === win) _loginWin = null;
          finish({ ok: false, code: 'APERIA_SIGNIN_CANCELLED' }, false);
          _emit();
        } catch (e) { log.warn('[aperia] closed', safeErr(e)); }
      });
      cap = capture.createCapture(wc, {
        onConnected: () => { _everCaptured = true; finish({ ok: true, state: 'connected' }, false); _emit(); },
        onUnauthorized: () => { _emit(); },
      });
      try {
        cap.attach();
      } catch (e) {
        log.warn('[aperia] debugger attach', safeErr(e));
        finish({ ok: false, code: 'APERIA_CAPTURE_FAILED' }, true);
        return;
      }
      _bus.emit('window', win);
      timer = setTimeout(() => { finish({ ok: false, code: 'APERIA_SIGNIN_TIMEOUT' }, false); }, C.SIGNIN_WINDOW_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      Promise.resolve().then(() => win.loadURL(C.PORTAL_URL)).catch(() => {});
    } catch (e) {
      log.warn('[aperia] login window', safeErr(e));
      finish({ ok: false, code: 'APERIA_CAPTURE_FAILED' }, true);
    }
  });
}

/** reloadPortal() — after a 401: reload the sign-in window if open, else open it. */
function reloadPortal(ctx) {
  const w = loginWindow();
  if (w) { try { w.show(); w.webContents.reload(); } catch (e) { log.warn('[aperia] reload', safeErr(e)); } return Promise.resolve({ ok: true }); }
  return openLoginWindow(ctx);
}

/** teardownAll() — app before-quit: close the sign-in window and drop the token. */
function teardownAll() {
  try { if (loginWindow()) _loginWin.close(); } catch (e) { log.warn('[aperia] teardown', safeErr(e)); }
  _loginWin = null;
  capture.clearAll();
}

/**
 * reauth(ctx, {timeoutMs}) -> {ok:true} | {ok:false, code:'APERIA_SESSION_EXPIRED'}
 * Single-flight (all concurrent callers share one wait). Immediate {ok:true} when a Bearer is held;
 * else reload / show the portal window and wait for the next captured Bearer, up to C.REAUTH_WAIT_MS.
 */
function reauth(ctx, opts) {
  if (capture.current()) return Promise.resolve({ ok: true });
  if (_reauthP) return _reauthP;
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : C.REAUTH_WAIT_MS;
  _reauthP = new Promise((resolve) => {
    let done = false;
    let timer = null;
    let off = () => {};
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      off();
      log.info('[aperia] reauth', { op: 'reauth', code: r.ok ? 'OK' : r.code });
      resolve(r);
    };
    _emit(); // sync _lastState (a silently expired token) so the next capture emits 'connected'
    off = onStatus((s) => { if (s && s.state === 'connected') finish({ ok: true }); });
    timer = setTimeout(() => finish({ ok: false, code: 'APERIA_SESSION_EXPIRED' }), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve()
      .then(() => reloadPortal(ctx))
      .then((r) => {
        if (capture.current()) finish({ ok: true });
        else if (r && r.ok === false) finish({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
      })
      .catch((e) => { log.warn('[aperia] reauth', safeErr(e)); finish({ ok: false, code: 'APERIA_SESSION_EXPIRED' }); });
  }).finally(() => { _reauthP = null; });
  return _reauthP;
}

function _resetForTests() {
  try { teardownAll(); } catch (_) {}
  _ses = null; _deps = {}; _loginP = null; _loginWin = null; _quitHooked = false;
  _everCaptured = false; _lastCode = null; _lastState = null; _lastPullAt = null; _reauthP = null;
  _bus.removeAllListeners();
}

module.exports = {
  getSession, status, onStatus, onWindow, noteResult, notePull, logout, loginWindow, openLoginWindow, reloadPortal, reauth,
  teardownAll, _setDeps, _resetForTests,
};
