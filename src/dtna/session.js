'use strict';
/**
 * src/dtna/session.js — DTNA partition, visible sign-in window, hidden context refresh and status.
 *
 * Windows open from a user action (the sign-in click or a pull), as a silent hidden context refresh
 * from the sync pass while signed in (no credentials filled), or as a background sign-in
 * (backgroundLogin): a HIDDEN window running the same stored-credential auto-login as the pill's Sign in,
 * at startup and on expiry (src/dtna/auto-auth.js) and when a sync / pre-flight finds the session gone.
 * Background sign-ins are single-flight and rate limited (src/utils/auth-retry-gate.js). One that rests
 * on a sign-in step the auto-login cannot finish (MFA, terms, no stored credentials) latches
 * status().actionNeeded, so the pill asks the user to sign in; no window is ever shown for it.
 * The partition persist:vendor-dtna is shared with the Split View webview, so no permission handlers
 * are installed on it. The CDP capture attaches BEFORE the first loadURL of every window, and no
 * page console listener is ever registered (the portal prints its OIDC token to the console).
 * URLs are never logged. Status is computed on demand; no timer polls it.
 */
const { EventEmitter } = require('events');
const C = require('./constants');
const capture = require('./capture');
const { safeErr } = require('./redact');
const { createRetryGate } = require('../utils/auth-retry-gate');
const log = require('../utils/logger')('dtna');

// Background sign-in rate limit (Phase E). ACTION_CODE = the hidden auto-login needs the user.
const ACTION_CODE = 'DTNA_SIGNIN_ACTION_NEEDED';
const _gate = createRetryGate({
  minGapMs: C.BG_MIN_GAP_MS, failCooldownMs: C.BG_FAIL_COOLDOWN_MS, actionCooldownMs: C.BG_ACTION_COOLDOWN_MS,
  actionCodes: new Set([ACTION_CODE]),
});

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
  // Only while a background sign-in is waiting for the user (the pill then asks for a sign-in).
  if (_gate.state().actionNeeded) s.actionNeeded = true;
  return s;
}

function _emit(force) {
  try {
    const s = status();
    const key = s.state + '|' + (s.actionNeeded === true);
    if (!force && key === _lastState) return;
    _lastState = key;
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

/**
 * canAutoSync() -> true only while the user is signed in: captured this run, not marked expired, no
 * sign-in window in progress and the last session-time reading (if any) not at 0 s. Pure, no network.
 */
function canAutoSync() {
  return _everCaptured && !_expired && !_loginP && !(_sessionTime && _expiresInSec() <= 0);
}

// A new sign-in starts a new session: the old servlet reading no longer applies.
function _captured() { _everCaptured = true; _expired = false; _sessionTime = null; _gate.clearAction(); _emit(); }

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

function _attachAutoLogin(win, onDone) {
  const opts = typeof onDone === 'function' ? { maxRetries: 2, onDone } : { maxRetries: 2 };
  try { _autoLogin().attachAutoLogin(win, C.LIST_URL, opts); } catch (e) { log.warn('[dtna] auto-login', safeErr(e)); }
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

// Silent refresh: how long the hidden window may sit on a sign-in host (an SSO bounce passes through
// in well under this) before it gives up with DTNA_SIGNIN_REQUIRED.
const SILENT_LOGIN_GRACE_MS = 5e3;

// A silent (sync-pass) caller only ever sees these codes.
function _silentResult(r) {
  if (r && r.ok) return { ok: true };
  const c = r && r.code;
  return { ok: false, code: c === 'DTNA_TIMEOUT' || c === 'DTNA_CAPTURE_FAILED' ? c : 'DTNA_SIGNIN_REQUIRED' };
}
function _silentLogin() { return backgroundLogin({ reason: 'sync' }).then(_silentResult); }

/**
 * ensureContext({force, silent}) -> {ok:true} | {ok:false, code:'DTNA_SIGNIN_REQUIRED'|'DTNA_TIMEOUT'|'DTNA_CAPTURE_FAILED'}
 * Fresh capture (< 30 min) and not forced -> ok. Else a single-flight hidden window on the Cases list
 * (inside a user pull, or a silent sync-pass read), destroyed after use.
 * silent (sync pass): never a visible window. Signed in (canAutoSync) -> the hidden refresh gets no
 * auto-login and gives up as soon as it rests on a sign-in host; then, like a signed-out or expired
 * session, one gated background sign-in (backgroundLogin) runs.
 */
function ensureContext(opts) {
  const force = !!(opts && opts.force);
  const silent = !!(opts && opts.silent);
  if (silent && _loginP) return Promise.resolve({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' });
  if (silent && !canAutoSync()) return _silentLogin();
  if (!force && capture.current() && capture.ageMs() < C.CONTEXT_MAX_AGE_MS) return Promise.resolve({ ok: true });
  if (!_hiddenP) {
    _hiddenP = _hiddenRefresh({ autoLogin: !silent }).finally(() => { _hiddenP = null; _emit(); });
    _emit();
  }
  if (!silent) return _hiddenP;
  return _hiddenP.then((r) => (r && !r.ok && r.code === 'DTNA_SIGNIN_REQUIRED' ? _silentLogin() : _silentResult(r)));
}

// ── Background sign-in (Phase E) ───────────────────────────────────────────
const BG_REASONS = new Set(['startup', 'sync', 'expired', 'expiry', 'preflight']);
let _bgP = null;

/**
 * backgroundLogin({reason}) -> {ok:true} | {ok:false, code}
 * The pill's Sign in flow (capture + stored-credential auto-login on the Cases list) in a HIDDEN window.
 * Already connected with a fresh capture -> ok, no window. The visible sign-in in progress ->
 * DTNA_SIGNIN_IN_PROGRESS (never waits on the user's window). Single-flight and gated: a gated call
 * returns AUTH_COOLDOWN with no window. A sign-in step it cannot finish -> DTNA_SIGNIN_ACTION_NEEDED,
 * which latches status().actionNeeded (pushed once) until any capture succeeds.
 * Logs: { op, reason, code, ms } per attempt.
 */
function backgroundLogin(opts) {
  const reason = opts && BG_REASONS.has(opts.reason) ? opts.reason : 'sync';
  if (_loginP) return Promise.resolve({ ok: false, code: 'DTNA_SIGNIN_IN_PROGRESS' });
  if (canAutoSync() && capture.current() && capture.ageMs() < C.CONTEXT_MAX_AGE_MS) return Promise.resolve({ ok: true });
  if (_bgP) return _bgP;
  if (_hiddenP) return _hiddenP;
  const t0 = Date.now();
  _bgP = _gate.run(() => {
    _hiddenP = _hiddenRefresh({ autoLogin: true, background: true }).finally(() => { _hiddenP = null; _emit(); });
    _emit();
    return _hiddenP;
  }).then((r) => {
    const code = r && r.ok ? 'OK' : String((r && r.code) || 'DTNA_INTERNAL').slice(0, 40);
    if (!(r && r.gated)) log.info('[dtna] auth', { op: 'background-login', reason, code, ms: Date.now() - t0 });
    _emit(!!(r && r.firstAction));
    return r && r.ok ? { ok: true } : { ok: false, code };
  }).finally(() => { _bgP = null; });
  return _bgP;
}

function _hiddenRefresh(o) {
  const autoLogin = !(o && o.autoLogin === false);
  const background = !!(o && o.background);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let grace = null;
    let cap = null;
    let win = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (grace) { clearTimeout(grace); grace = null; }
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
      // Background: still on a sign-in host when the wait runs out = a step the auto-login cannot finish.
      const loginCode = background ? ACTION_CODE : 'DTNA_SIGNIN_REQUIRED';
      timer = setTimeout(() => {
        try { finish({ ok: false, code: _onLoginHost(win) ? loginCode : 'DTNA_TIMEOUT' }); } catch (e) { log.warn('[dtna] wait', safeErr(e)); }
      }, background ? C.BG_LOGIN_WAIT_MS : C.HIDDEN_WAIT_MS);
      // Silent: no credentials are filled, so a window resting on a sign-in host will never connect.
      const checkLogin = () => {
        if (autoLogin || settled || grace || _isDestroyed(win) || !_onLoginHost(win)) return;
        grace = setTimeout(() => {
          grace = null;
          try { if (!settled && !_isDestroyed(win) && _onLoginHost(win)) finish({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' }); } catch (e) { log.warn('[dtna] wait', safeErr(e)); }
        }, SILENT_LOGIN_GRACE_MS);
      };
      if (!autoLogin) wc.on('did-navigate', () => { try { checkLogin(); } catch (e) { log.warn('[dtna] navigate', safeErr(e)); } });
      Promise.resolve().then(() => win.loadURL(C.LIST_URL)).then(() => { if (!autoLogin) checkLogin(); }).catch(() => {});
      if (autoLogin && !background) _attachAutoLogin(win);
      // Background: the auto-login giving up (bad / no credentials, a form still showing after its
      // retries) means the user must finish a step; a late capture inside the grace still wins.
      if (background) {
        _attachAutoLogin(win, (res) => {
          try {
            if (settled || grace || (res && res.success)) return;
            grace = setTimeout(() => { grace = null; finish({ ok: false, code: ACTION_CODE }); }, SILENT_LOGIN_GRACE_MS);
          } catch (e) { log.warn('[dtna] auto-login done', safeErr(e)); }
        });
      }
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
  _sessionTime = null; _bgP = null;
  _gate._reset();
  _bus.removeAllListeners();
}

module.exports = {
  getSession, status, onStatus, noteResult, setPulling, notePulled, noteSessionTime, openLoginWindow, ensureContext, canAutoSync,
  backgroundLogin, teardownAll, _setDeps, _resetForTests,
};
