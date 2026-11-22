'use strict';
/**
 * src/dtna/session.js — DTNA partition, visible sign-in window, hidden context refresh and status.
 *
 * Nothing here runs on its own: every window is opened by a user action (the sign-in click or a pull).
 * The partition persist:vendor-dtna is shared with the Split View webview, so no permission handlers
 * are installed on it. The CDP capture attaches BEFORE the first loadURL of every window, and no
 * page console listener is ever registered (the portal prints its OIDC token to the console).
 * URLs are never logged. Status is computed on demand; no timer polls it.
 */
const { EventEmitter } = require('events');
const C = require('./constants');
const capture = require('./capture');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('dtna');

// Test seam: { electron, autoLogin }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }
function _autoLogin() { return _deps.autoLogin || require('../orcha/auto-login'); }

// ── Partition ──────────────────────────────────────────────────────────────
let _ses = null;
/** getSession() — memoized persist:vendor-dtna session (no permission handlers: shared partition). */
function getSession() {
  if (!_ses) _ses = _electron().session.fromPartition(C.PARTITION);
  return _ses;
}

// ── Status (decision 10) ───────────────────────────────────────────────────
const _bus = new EventEmitter();
const EXPIRED_CODES = new Set(['DTNA_SIGNIN_REQUIRED', 'DTNA_SESSION_EXPIRED']);
let _everCaptured = false;
let _expired = false;
let _pulling = false;
let _lastCode = null;
let _lastPullAt = null;
let _lastState = null;
// Last SessionTimeServlet reading (src/dtna/session-time.js): integers + when it was read. No body.
let _sessionTime = null;

function _expiresInSec() {
  if (!_sessionTime) return null;
  return Math.max(0, _sessionTime.remainingSec - Math.floor((Date.now() - _sessionTime.at) / 1000));
}

function _state() {
  if (_pulling) return 'pulling';
  if (_loginP || _hiddenP) return 'connecting';
  if (_sessionTime) {
    // The servlet reading is the session's own clock (~8 h), so it replaces the capture-age proxy.
    if (_expiresInSec() <= 0) return _everCaptured ? 'expired' : 'signed-out';
    return _expired ? 'expired' : 'connected';
  }
  const has = !!capture.current();
  if (!has && !_everCaptured) return 'signed-out';
  if (!has || _expired || capture.ageMs() >= C.CONTEXT_MAX_AGE_MS) return 'expired';
  return 'connected';
}

/** status() -> { ok:true, state, contextAgeSec, lastPullAt, lastCode } (no secrets, no network). */
function status() {
  const age = capture.ageMs();
  const s = {
    ok: true,
    state: _state(),
    contextAgeSec: Number.isFinite(age) ? Math.round(age / 1000) : null,
    lastPullAt: _lastPullAt,
    lastCode: _lastCode,
  };
  if (_sessionTime) {
    s.expiresInSec = _expiresInSec();
    s.sessionCheckedAt = new Date(_sessionTime.at).toISOString();
  }
  return s;
}

function _emit(force) {
  try {
    const s = status();
    if (!force && s.state === _lastState) return;
    _lastState = s.state;
    _bus.emit('status', s);
  } catch (e) { log.warn('[dtna] status', safeErr(e)); }
}

/** onStatus(fn) -> unsubscribe. fn(status) on every state change. */
function onStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  const h = (s) => { try { fn(s); } catch (e) { log.warn('[dtna] status listener', safeErr(e)); } };
  _bus.on('status', h);
  return () => _bus.removeListener('status', h);
}

function noteResult(code) {
  _lastCode = typeof code === 'string' ? code.slice(0, 40) : null;
  if (EXPIRED_CODES.has(_lastCode)) _expired = true;
  else if (_lastCode === 'OK') _expired = false;
  _emit();
}
function setPulling(on) { _pulling = !!on; _emit(); }
function notePulled(at) { _lastPullAt = typeof at === 'string' && at ? at : new Date().toISOString(); _emit(); }

/** noteSessionTime({remainingSec, periodSec}) — store a servlet reading (integers only) and push status. */
function noteSessionTime(t) {
  const rem = Number(t && t.remainingSec);
  const per = t && t.periodSec != null ? Number(t.periodSec) : null;
  if (!Number.isFinite(rem)) return;
  _sessionTime = {
    remainingSec: Math.max(0, Math.floor(rem)),
    periodSec: per != null && Number.isFinite(per) ? Math.max(0, Math.floor(per)) : null,
    at: Date.now(),
  };
  _emit(true);
}

// A new sign-in starts a new session: the old servlet reading no longer applies.
function _captured() { _everCaptured = true; _expired = false; _sessionTime = null; _emit(); }

// ── Windows ────────────────────────────────────────────────────────────────
function _webPreferences(extra) {
  return Object.assign({ partition: C.PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }, extra || {});
}
function _isDestroyed(win) {
  try { return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed()); } catch (_) { return true; }
}
function _isPortalOrLogin(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && (u.hostname === C.HOST || C.LOGIN_HOST_RE.test(u.hostname));
  } catch (_) { return false; }
}
function _onLoginHost(win) {
  try {
    const u = new URL(String(win.webContents.getURL() || ''));
    return C.LOGIN_HOST_RE.test(u.hostname);
  } catch (_) { return false; }
}

let _quitHooked = false;
function _hookQuit() {
  if (_quitHooked) return;
  _quitHooked = true;
  try {
    const app = _electron().app;
    if (app && typeof app.once === 'function') app.once('before-quit', () => { try { teardownAll(); } catch (e) { log.warn('[dtna] quit', safeErr(e)); } });
  } catch (e) { log.warn('[dtna] quit hook', safeErr(e)); }
}

function _attachAutoLogin(win) {
  try { _autoLogin().attachAutoLogin(win, C.LIST_URL, { maxRetries: 2 }); } catch (e) { log.warn('[dtna] auto-login', safeErr(e)); }
}

const _cancels = new Set(); // finish callbacks of open windows (teardownAll)

// ── Visible sign-in window ─────────────────────────────────────────────────
let _loginP = null;
let _loginWin = null;

/**
 * openLoginWindow(ctx) -> {ok:true, state:'connected'} | {ok:false, code:'DTNA_SIGNIN_CANCELLED'|'DTNA_SIGNIN_TIMEOUT'|'DTNA_CAPTURE_FAILED'}
 * Single-flight. Resolves on the first captured successful aura POST; the window stays open for the user.
 */
function openLoginWindow(ctx) {
  if (_loginP || (_loginWin && !_isDestroyed(_loginWin))) {
    try { if (_loginWin && !_isDestroyed(_loginWin)) _loginWin.focus(); } catch (e) { log.warn('[dtna] focus', safeErr(e)); }
    if (_loginP) return _loginP;
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
        log.info('[dtna] login', { op: 'login', code: r.ok ? 'OK' : r.code });
        resolve(r);
      }
      if (close && win && !_isDestroyed(win)) { try { win.close(); } catch (e) { log.warn('[dtna] close', safeErr(e)); } }
    };
    try {
      const { BrowserWindow } = _electron();
      getSession();
      let parent = null;
      try { parent = ctx && ctx.mainWindow && !_isDestroyed(ctx.mainWindow) ? ctx.mainWindow : null; } catch (_) { parent = null; }
      const opts = {
        title: 'Sign in: DTNA Service Tracker', width: 1100, height: 850, show: true, autoHideMenuBar: true,
        webPreferences: _webPreferences(),
      };
      if (parent) opts.parent = parent;
      win = new BrowserWindow(opts);
      _loginWin = win;
      _hookQuit();
      const wc = win.webContents;
      win.on('page-title-updated', (e) => { try { e.preventDefault(); } catch (_) {} });
      wc.setWindowOpenHandler((details) => {
        try {
          const url = details && details.url;
          if (_isPortalOrLogin(url)) Promise.resolve().then(() => win.loadURL(url)).catch(() => {});
        } catch (e) { try { log.warn('[dtna] window-open', safeErr(e)); } catch (_) {} }
        return { action: 'deny' };
      });
      const cancel = () => finish({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' }, true);
      _cancels.add(cancel);
      win.on('closed', () => {
        try {
          _cancels.delete(cancel);
          if (cap) cap.detach();
          if (_loginWin === win) _loginWin = null;
          finish({ ok: false, code: 'DTNA_SIGNIN_CANCELLED' }, false);
          _emit();
        } catch (e) { log.warn('[dtna] closed', safeErr(e)); }
      });
      cap = capture.createCapture(wc, {
        onSuccess: () => { _captured(); finish({ ok: true, state: 'connected' }, false); },
      });
      try {
        cap.attach();
      } catch (e) {
        log.warn('[dtna] debugger attach', safeErr(e));
        finish({ ok: false, code: 'DTNA_CAPTURE_FAILED' }, true);
        return;
      }
      timer = setTimeout(() => { try { finish({ ok: false, code: 'DTNA_SIGNIN_TIMEOUT' }, true); } catch (e) { log.warn('[dtna] timeout', safeErr(e)); } }, C.SIGNIN_WINDOW_MS);
      Promise.resolve().then(() => win.loadURL(C.LIST_URL)).catch(() => {});
      _attachAutoLogin(win);
    } catch (e) {
      log.warn('[dtna] login window', safeErr(e));
      finish({ ok: false, code: 'DTNA_CAPTURE_FAILED' }, true);
    }
  });
}

// ── Hidden refresh window ──────────────────────────────────────────────────
let _hiddenP = null;

/**
 * ensureContext({force}) -> {ok:true} | {ok:false, code:'DTNA_SIGNIN_REQUIRED'|'DTNA_TIMEOUT'|'DTNA_CAPTURE_FAILED'}
 * Fresh capture (< 30 min) and not forced -> ok. Else a single-flight hidden window on the Cases list
 * (only reached inside a user pull), destroyed after use.
 */
function ensureContext(opts) {
  const force = !!(opts && opts.force);
  if (!force && capture.current() && capture.ageMs() < C.CONTEXT_MAX_AGE_MS) return Promise.resolve({ ok: true });
  if (_hiddenP) return _hiddenP;
  _hiddenP = _hiddenRefresh().finally(() => { _hiddenP = null; _emit(); });
  _emit();
  return _hiddenP;
}

function _hiddenRefresh() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let cap = null;
    let win = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      _cancels.delete(cancel);
      try { if (cap) cap.detach(); } catch (e) { log.warn('[dtna] detach', safeErr(e)); }
      try { if (win && !_isDestroyed(win)) win.destroy(); } catch (e) { log.warn('[dtna] destroy', safeErr(e)); }
      log.info('[dtna] context', { op: 'hidden-refresh', code: r.ok ? 'OK' : r.code, ms: Date.now() - t0 });
      resolve(r);
    };
    const cancel = () => finish({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
    _cancels.add(cancel);
    try {
      const { BrowserWindow } = _electron();
      getSession();
      win = new BrowserWindow({
        show: false, skipTaskbar: true, x: -4000, y: -4000, width: 1400, height: 950, paintWhenInitiallyHidden: true,
        webPreferences: _webPreferences({ backgroundThrottling: false }),
      });
      _hookQuit();
      const wc = win.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('closed', () => { try { finish({ ok: false, code: _onLoginHostSafe() ? 'DTNA_SIGNIN_REQUIRED' : 'DTNA_TIMEOUT' }); } catch (e) { log.warn('[dtna] closed', safeErr(e)); } });
      cap = capture.createCapture(wc, { onSuccess: () => { _captured(); finish({ ok: true }); } });
      try {
        cap.attach();
      } catch (e) {
        log.warn('[dtna] debugger attach', safeErr(e));
        finish({ ok: false, code: 'DTNA_CAPTURE_FAILED' });
        return;
      }
      timer = setTimeout(() => {
        try { finish({ ok: false, code: _onLoginHost(win) ? 'DTNA_SIGNIN_REQUIRED' : 'DTNA_TIMEOUT' }); } catch (e) { log.warn('[dtna] wait', safeErr(e)); }
      }, C.HIDDEN_WAIT_MS);
      Promise.resolve().then(() => win.loadURL(C.LIST_URL)).catch(() => {});
      _attachAutoLogin(win);
    } catch (e) {
      log.warn('[dtna] hidden window', safeErr(e));
      finish({ ok: false, code: 'DTNA_CAPTURE_FAILED' });
    }
    function _onLoginHostSafe() { return win && !_isDestroyed(win) ? _onLoginHost(win) : false; }
  });
}

/** teardownAll() — app before-quit: close every DTNA window and clear every timer. */
function teardownAll() {
  for (const c of Array.from(_cancels)) { try { c(); } catch (_) {} }
  _cancels.clear();
  try { if (_loginWin && !_isDestroyed(_loginWin)) _loginWin.close(); } catch (e) { log.warn('[dtna] teardown', safeErr(e)); }
  _loginWin = null;
}

function _resetForTests() {
  try { teardownAll(); } catch (_) {}
  _ses = null; _deps = {}; _loginP = null; _loginWin = null; _hiddenP = null; _quitHooked = false;
  _everCaptured = false; _expired = false; _pulling = false; _lastCode = null; _lastPullAt = null; _lastState = null;
  _sessionTime = null;
  _bus.removeAllListeners();
}

module.exports = {
  getSession, status, onStatus, noteResult, setPulling, notePulled, noteSessionTime, openLoginWindow, ensureContext, teardownAll,
  _setDeps, _resetForTests,
};
