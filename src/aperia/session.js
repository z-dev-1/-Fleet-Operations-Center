'use strict';
/**
 * src/aperia/session.js — persist:aperia partition, visible sign-in window on the portal, background
 * sign-in, status.
 *
 * The visible sign-in window is opened by a user action. backgroundLogin (Phase E: at startup and on
 * expiry from src/aperia/auto-auth.js, and from reauth after a 401) runs the same capture in a HIDDEN
 * window with the stored-credential auto-login; it is single-flight and rate limited
 * (src/utils/auth-retry-gate.js). One that rests on a sign-in step it cannot finish latches
 * status().actionNeeded so the pill asks the user to sign in; no window is ever shown for it. After
 * Sign out no background sign-in runs until the user signs in again (this app run).
 * The CDP Bearer capture (./capture.js) attaches BEFORE the first loadURL; no webRequest listener and
 * no page console listener are installed. URLs and tokens are never logged. Status is computed on
 * demand; no timer polls it.
 */
const { EventEmitter } = require('events');
const C = require('./constants');
const capture = require('./capture');
const { safeErr } = require('./redact');
const { createRetryGate } = require('../utils/auth-retry-gate');
const log = require('../utils/logger')('aperia');

// Test seam: { electron, autoLogin }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }
function _autoLogin() { return _deps.autoLogin || require('../orcha/auto-login'); }

// Background sign-in rate limit. ACTION_CODE = the hidden auto-login needs the user.
const ACTION_CODE = 'APERIA_SIGNIN_ACTION_NEEDED';
const _gate = createRetryGate({
  minGapMs: C.BG_MIN_GAP_MS, failCooldownMs: C.BG_FAIL_COOLDOWN_MS, actionCooldownMs: C.BG_ACTION_COOLDOWN_MS,
  actionCodes: new Set([ACTION_CODE]),
});
let _bgP = null;
let _userSignedOut = false;
const _cancels = new Set(); // finish callbacks of hidden windows (logout / teardown)

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
  if (_loginP || _bgP) return 'connecting';
  return _everCaptured ? 'expired' : 'signed-out';
}

/** status() -> { ok:true, state, secondsLeft, lastCode, lastPullAt[, actionNeeded:true] } (no secrets, no network). */
function status() {
  const s = { ok: true, state: _state(), secondsLeft: capture.secondsLeft(), lastCode: _lastCode, lastPullAt: _lastPullAt };
  // Only while a background sign-in is waiting for the user (the pill then asks for a sign-in).
  if (_gate.state().actionNeeded) s.actionNeeded = true;
  return s;
}

/** notePull(atIso) — remember when the last successful Aperia read finished (shown in the panel). */
function notePull(atIso) {
  const ms = Date.parse(String(atIso || ''));
  _lastPullAt = Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function _emit() {
  try {
    const s = status();
    const key = s.state + '|' + (s.actionNeeded === true);
    if (key === _lastState) return;
    _lastState = key;
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

/**
 * logout() — close the sign-in window (its CDP capture detaches with it, same as app quit) and drop both
 * in-memory tokens, so the portal's own traffic cannot sign the app back in. Partition cookies stay.
 */
function logout() {
  // Sign out wins over background sign-in for the rest of this run (until the user signs in again).
  _userSignedOut = true;
  _cancelHidden();
  try { if (loginWindow()) _loginWin.close(); } catch (e) { log.warn('[aperia] logout close', safeErr(e)); }
  _loginWin = null;
  capture.clearAll();
  _emit();
  return { ok: true, state: status().state };
}

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
  _userSignedOut = false;
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
        if (r.ok) { _everCaptured = true; _gate.clearAction(); }
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

/** teardownAll() — app before-quit: close the sign-in and hidden windows and drop the token. */
function teardownAll() {
  _cancelHidden();
  try { if (loginWindow()) _loginWin.close(); } catch (e) { log.warn('[aperia] teardown', safeErr(e)); }
  _loginWin = null;
  capture.clearAll();
}

function _cancelHidden() {
  for (const c of Array.from(_cancels)) { try { c(); } catch (_) {} }
  _cancels.clear();
}

// ── Background sign-in (Phase E) ───────────────────────────────────────────
const BG_REASONS = new Set(['startup', 'expired', 'reauth']);
// The auto-login gave up; a capture that lands inside this grace still wins.
const AUTO_LOGIN_GRACE_MS = 5e3;

/**
 * backgroundLogin({reason}) -> {ok:true} | {ok:false, code}
 * A Bearer held -> ok, no window. After Sign out -> APERIA_SIGNED_OUT (no window). The visible sign-in
 * open or in progress -> APERIA_SIGNIN_IN_PROGRESS. Single-flight and gated (AUTH_COOLDOWN, no window).
 * Else a HIDDEN portal window: capture first, then the stored-credential auto-login. A sign-in step it
 * cannot finish -> APERIA_SIGNIN_ACTION_NEEDED (latches status().actionNeeded). Never starts the alert
 * watcher. Logs: { op, reason, code, ms } per attempt.
 */
function backgroundLogin(opts) {
  const reason = opts && BG_REASONS.has(opts.reason) ? opts.reason : 'reauth';
  if (capture.current()) return Promise.resolve({ ok: true });
  if (_userSignedOut) return Promise.resolve({ ok: false, code: 'APERIA_SIGNED_OUT' });
  if (_loginP || loginWindow()) return Promise.resolve({ ok: false, code: 'APERIA_SIGNIN_IN_PROGRESS' });
  if (_bgP) return _bgP;
  if (!_gate.canStart()) return Promise.resolve({ ok: false, code: 'AUTH_COOLDOWN' });
  const t0 = Date.now();
  _bgP = _gate.run(() => _hiddenLogin()).then((r) => {
    const code = r && r.ok ? 'OK' : String((r && r.code) || 'APERIA_INTERNAL').slice(0, 40);
    log.info('[aperia] auth', { op: 'background-login', reason, code, ms: Date.now() - t0 });
    return r && r.ok ? { ok: true } : { ok: false, code };
  }).finally(() => { _bgP = null; _emit(); });
  _emit();
  return _bgP;
}

function _hiddenLogin() {
  return new Promise((resolve) => {
    let settled = false;
    let torn = false;
    let timer = null;
    let grace = null;
    let wsWait = null;
    let cap = null;
    let win = null;
    const teardown = () => {
      if (torn) return;
      torn = true;
      if (wsWait) { clearTimeout(wsWait); wsWait = null; }
      _cancels.delete(cancel);
      try { if (cap) cap.detach(); } catch (e) { log.warn('[aperia] detach', safeErr(e)); }
      try { if (win && !_isDestroyed(win)) win.destroy(); } catch (e) { log.warn('[aperia] destroy', safeErr(e)); }
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (grace) { clearTimeout(grace); grace = null; }
      resolve(r);
      // Signed in but the portal's alert socket not seen yet: keep the hidden window briefly for it.
      if (r.ok && !capture.wsToken() && win && !_isDestroyed(win)) {
        try {
          win.webContents.debugger.on('message', (_e, method) => {
            if (method === 'Network.webSocketCreated' && capture.wsToken()) teardown();
          });
        } catch (_) { teardown(); return; }
        wsWait = setTimeout(teardown, C.BG_WS_GRACE_MS);
        if (wsWait && typeof wsWait.unref === 'function') wsWait.unref();
        return;
      }
      teardown();
    };
    const cancel = () => { finish({ ok: false, code: 'APERIA_SIGNIN_CANCELLED' }); teardown(); };
    _cancels.add(cancel);
    try {
      const { BrowserWindow } = _electron();
      getSession();
      win = new BrowserWindow({
        show: false, skipTaskbar: true, x: -4000, y: -4000, width: 1200, height: 900, paintWhenInitiallyHidden: true,
        webPreferences: { partition: C.PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      _hookQuit();
      const wc = win.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => { finish({ ok: false, code: 'APERIA_SIGNIN_CANCELLED' }); teardown(); });
      cap = capture.createCapture(wc, {
        onConnected: () => { _everCaptured = true; _gate.clearAction(); finish({ ok: true }); },
      });
      try {
        cap.attach();
      } catch (e) {
        log.warn('[aperia] debugger attach', safeErr(e));
        finish({ ok: false, code: 'APERIA_CAPTURE_FAILED' });
        return;
      }
      // Out of time: still on the portal's sign-in form = a step the auto-login cannot finish.
      timer = setTimeout(() => {
        timer = null;
        Promise.resolve()
          .then(() => (settled || _isDestroyed(win) ? false : _autoLogin().isLoginPage(wc)))
          .catch(() => false)
          .then((onLogin) => finish({ ok: false, code: onLogin ? ACTION_CODE : 'APERIA_TIMEOUT' }));
      }, C.BG_LOGIN_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      Promise.resolve().then(() => win.loadURL(C.PORTAL_URL)).catch(() => {});
      try {
        _autoLogin().attachAutoLogin(win, C.PORTAL_URL, {
          maxRetries: 2,
          onDone: (res) => {
            if (settled || grace || (res && res.success)) return;
            grace = setTimeout(() => { grace = null; finish({ ok: false, code: ACTION_CODE }); }, AUTO_LOGIN_GRACE_MS);
            if (grace && typeof grace.unref === 'function') grace.unref();
          },
        });
      } catch (e) { log.warn('[aperia] auto-login', safeErr(e)); }
    } catch (e) {
      log.warn('[aperia] hidden window', safeErr(e));
      finish({ ok: false, code: 'APERIA_CAPTURE_FAILED' });
    }
  });
}

/**
 * reauth(ctx, {timeoutMs}) -> {ok:true} | {ok:false, code:'APERIA_SESSION_EXPIRED'}
 * Single-flight (all concurrent callers share one wait). Immediate {ok:true} when a Bearer is held.
 * The user's sign-in window open -> reload it and wait for the next captured Bearer, up to
 * C.REAUTH_WAIT_MS. Otherwise one hidden background sign-in (no visible window).
 */
function reauth(ctx, opts) {
  if (capture.current()) return Promise.resolve({ ok: true });
  if (_reauthP) return _reauthP;
  if (!loginWindow()) {
    _emit(); // sync _lastState (a silently expired token) so the next capture emits 'connected'
    _reauthP = backgroundLogin({ reason: 'reauth' })
      .then((r) => (r && r.ok ? { ok: true } : { ok: false, code: 'APERIA_SESSION_EXPIRED' }))
      .catch((e) => { log.warn('[aperia] reauth', safeErr(e)); return { ok: false, code: 'APERIA_SESSION_EXPIRED' }; })
      .then((r) => { log.info('[aperia] reauth', { op: 'reauth', code: r.ok ? 'OK' : r.code }); return r; })
      .finally(() => { _reauthP = null; });
    return _reauthP;
  }
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
  _bgP = null; _userSignedOut = false; _cancels.clear(); _gate._reset();
  _bus.removeAllListeners();
}

module.exports = {
  getSession, status, onStatus, onWindow, noteResult, notePull, logout, loginWindow, openLoginWindow, reloadPortal, reauth,
  backgroundLogin, teardownAll, _setDeps, _resetForTests,
};
