'use strict';
/**
 * email-intel/transport/token-source.js — bearer + anchor mailbox from one short-lived hidden OWA window (design 4.3).
 *
 *   createTokenSource({ electron, now, log, owaRe, timers }) -> {
 *     getAuth({ minTtlMs, signal }) -> { headers:{ authorization, 'x-anchormailbox' }, expMs, gen, rank }
 *     peek()                        -> the cached material, or TokenUnavailableError('no-cache'); never refreshes
 *     invalidate(reason, gen)       drops the cache only when the generation matches
 *     alternate(usedGen)            R4-L7: a capture of a different rank (and fingerprint) with a fresh gen, or null
 *     describe()                    { present, ttlBucket, hold, rank, lastRefreshAt, refreshCount, lastResult }
 *   }
 *
 * The window is the transport's own: same options as the proven owa_capture window (hidden, offscreen, popups
 * denied, defaultSession), observed through CDP on THIS window only, and always detached and closed. The source
 * never enumerates, navigates or closes any other window, installs no session hook and touches no cookie.
 * Navigations are never cancelled. Values live in this closure only; a header object is built per call.
 *
 * R4-L6 URL helpers: isOutlookUrl = the WHOLE hostname matches OUTLOOK_HOST_RE; isAuthUrl = !isOutlookUrl and
 * (AUTH_HOST_RE on the hostname or on the URL without its query), so a login URL whose redirect_uri names Outlook
 * is an auth URL and an Outlook URL with an `adfs` query value is not.
 */
const crypto = require('crypto');
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const { ApiAuthBlockedError, TokenUnavailableError, AbortedError } = require('./errors');

const BEARER_RE = /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const KMSI_SCRIPT = '(function(){ try { var b = document.querySelector("#idSIButton9") || document.querySelector(\'input[type=submit][value="Yes"]\'); if (b) { b.click(); return "clicked"; } } catch (e) {} return "none"; })()';

function hostOf(u) { try { return new URL(String(u || '')).hostname.toLowerCase(); } catch (_) { return ''; } }
function isOutlookUrl(u, owaRe) {
  const h = hostOf(u);
  if (!h || !owaRe || !owaRe.OUTLOOK_HOST_RE) return false;
  const m = owaRe.OUTLOOK_HOST_RE.exec(h);
  return !!m && m[0].toLowerCase() === h;
}
function isAuthUrl(u, owaRe) {
  if (!owaRe || !owaRe.AUTH_HOST_RE || isOutlookUrl(u, owaRe)) return false;
  const s = String(u || '');
  const noQuery = s.split(/[?#]/)[0];
  return owaRe.AUTH_HOST_RE.test(hostOf(s)) || owaRe.AUTH_HOST_RE.test(noQuery);
}

/** exp (ms) from a JWT bearer, or null. Values are never returned or logged. */
function jwtExpMs(authorization) {
  const t = String(authorization || '').replace(/^Bearer\s+/, '');
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch (_) { return null; }
}
const fpOf = (authorization) => crypto.createHash('sha256').update(String(authorization)).digest('hex');

function _hdr(h, name) {
  if (!h || typeof h !== 'object') return null;
  for (const k of Object.keys(h)) if (String(k).toLowerCase() === name) return typeof h[k] === 'string' ? h[k] : null;
  return null;
}

function createTokenSource(deps) {
  const d = deps || {};
  const electron = d.electron;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const log = d.log || { info() {}, warn() {} };
  const owaRe = d.owaRe;
  const timers = d.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };

  let state = null;                 // { authorization, anchor, expMs, gen, rank, fp }
  let genCounter = 0;
  let lastFp = null; let lastGen = 0;
  let inflight = null;
  let cooldownUntil = 0; let cooldownErr = null;
  let holdUntil = 0;
  let lastResult = null; let lastRefreshAt = null; let refreshCount = 0;
  let byRank = {};                  // R4-L7: best capture per rank from the latest window (memory only)
  let altTried = new Set();

  const out = (s) => ({ headers: { authorization: s.authorization, 'x-anchormailbox': s.anchor }, expMs: s.expMs, gen: s.gen, rank: s.rank });

  function _withSignal(p, signal) {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(new AbortedError('aborted'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new AbortedError('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  async function getAuth(o) {
    const opts = o || {};
    const minTtlMs = Number.isFinite(opts.minTtlMs) ? opts.minTtlMs : TC.REFRESH_MARGIN_MS;
    const t = now();
    if (state && (state.expMs - t >= minTtlMs || (t < holdUntil && state.expMs - t >= TC.FRESH_ACCEPT_MS))) return out(state);
    // A cached token that still has FRESH_ACCEPT_MS left keeps serving while a refresh is cooling down or failed.
    const usable = () => !!state && state.expMs - now() >= TC.FRESH_ACCEPT_MS;
    if (!inflight) {
      if (t < cooldownUntil) {
        if (usable()) return out(state);
        if (cooldownErr instanceof ApiAuthBlockedError) throw new ApiAuthBlockedError();
        throw new TokenUnavailableError('cooldown');
      }
      inflight = _refresh().finally(() => { inflight = null; });
    }
    try {
      await _withSignal(inflight, opts.signal);
    } catch (e) {
      if (!(e instanceof AbortedError) && usable()) return out(state);
      throw e;
    }
    if (!state) throw new TokenUnavailableError('no-cache');
    if (state.expMs - now() < TC.FRESH_ACCEPT_MS) throw new TokenUnavailableError('short-ttl');
    return out(state);
  }

  async function _refresh() {
    refreshCount++;
    lastRefreshAt = new Date(now()).toISOString();
    const t0 = now();
    let cap;
    try {
      cap = await _capture();
    } catch (e) {
      cooldownUntil = now() + TC.REFRESH_COOLDOWN_MS;
      cooldownErr = e;
      lastResult = e instanceof ApiAuthBlockedError ? 'auth-blocked' : 'unavailable';
      log.warn('[email-api] op=token err=' + String((e && e.reason) || (e && e.code) || 'error').slice(0, 30) + ' ms=' + (now() - t0));
      throw e;
    }
    if (cap.expMs - now() < TC.FRESH_ACCEPT_MS) {
      cooldownUntil = now() + TC.REFRESH_COOLDOWN_MS;
      cooldownErr = new TokenUnavailableError('short-ttl');
      lastResult = 'unavailable';
      throw cooldownErr;
    }
    const prevFp = lastFp;
    const gen = cap.fp === lastFp ? lastGen : ++genCounter;
    lastFp = cap.fp; lastGen = gen;
    state = { authorization: cap.authorization, anchor: cap.anchor, expMs: cap.expMs, gen, rank: cap.rank, fp: cap.fp };
    byRank = cap.byRank;
    altTried = new Set();
    const sameFp = cap.fp === prevFp;
    holdUntil = (cap.expMs - now() < TC.REFRESH_MARGIN_MS || sameFp) ? Math.min(cap.expMs - TC.FRESH_ACCEPT_MS, now() + TC.REFRESH_COOLDOWN_MS) : 0;
    cooldownUntil = 0; cooldownErr = null;
    lastResult = 'ok';
    log.info('[email-api] op=token rank=' + cap.rank + ' ms=' + (now() - t0));
    return state;
  }

  function peek() {
    if (!state || state.expMs <= now()) throw new TokenUnavailableError('no-cache');
    return out(state);
  }

  function invalidate(_reason, gen) {
    if (state && state.gen === gen) { state = null; holdUntil = 0; }
  }

  function alternate(usedGen) {
    if (!state || state.gen !== usedGen) return null;
    const t = now();
    const cands = Object.values(byRank).filter((c) => c && c.rank !== state.rank && c.fp !== state.fp && !altTried.has(c.fp) && c.expMs - t >= TC.FRESH_ACCEPT_MS)
      .sort((a, b) => b.rank - a.rank);
    const c = cands[0];
    if (!c) return null;
    altTried.add(state.fp);                               // one alternate per capture: never flip back
    altTried.add(c.fp);
    const gen = ++genCounter;
    lastFp = c.fp; lastGen = gen;
    state = { authorization: c.authorization, anchor: c.anchor, expMs: c.expMs, gen, rank: c.rank, fp: c.fp };
    log.info('[email-api] op=token alternate rank=' + c.rank);
    return out(state);
  }

  function describe() {
    const t = now();
    const left = state ? state.expMs - t : -1;
    return {
      present: !!state,
      ttlBucket: !state || left <= 0 ? 'none' : (left < 5 * 60_000 ? '<5m' : (left <= 30 * 60_000 ? '5-30m' : '>30m')),
      hold: t < holdUntil,
      rank: state ? state.rank : 0,
      lastRefreshAt, refreshCount, lastResult,
    };
  }

  /** One hidden window, CDP capture, settle rules (4.3 _capture). */
  function _capture() {
    return new Promise((resolve, reject) => {
      const { BrowserWindow, session } = electron;
      let win = null; let dbg = null; let done = false;
      const handles = new Set();
      const later = (fn, ms) => { const h = timers.setTimeout(() => { handles.delete(h); fn(); }, ms); handles.add(h); return h; };
      const cancel = (h) => { if (h) { handles.delete(h); timers.clearTimeout(h); } };
      let wallTimer = null; let settleTimer = null; let bearerWait = null; let kmsiTimer = null;
      let best = null; const ranks = {};
      const curUrl = () => { try { return win && !win.isDestroyed() ? win.webContents.getURL() : ''; } catch (_) { return ''; } };

      const finish = (err, cap) => {
        if (done) return;
        done = true;
        for (const h of handles) timers.clearTimeout(h);
        handles.clear();
        _cleanup(win, dbg, listeners).then(() => (err ? reject(err) : resolve(cap)), () => (err ? reject(err) : resolve(cap)));
      };
      const succeed = () => {
        if (!best) return;
        finish(null, { authorization: best.authorization, anchor: best.anchor, expMs: best.expMs, rank: best.rank, fp: best.fp, byRank: Object.assign({}, ranks) });
      };
      const observe = (params) => {
        if (done) return;
        const req = (params && params.request) || {};
        const rank = endpoints.authSourceRank(req.url);
        if (!rank) return;
        const authorization = _hdr(req.headers, 'authorization');
        const anchor = _hdr(req.headers, 'x-anchormailbox');
        if (!authorization || !BEARER_RE.test(authorization)) return;
        if (!anchor || anchor.length > 512 || /[\r\n]/.test(anchor)) return;
        const expMs = jwtExpMs(authorization);
        if (!Number.isFinite(expMs) || expMs - now() <= TC.FRESH_ACCEPT_MS) return;
        const cand = { authorization, anchor, expMs, rank, fp: fpOf(authorization) };
        ranks[rank] = cand;
        if (!best || rank >= best.rank) best = cand;
        if (rank === 3) { succeed(); return; }
        if (!settleTimer) settleTimer = later(succeed, TC.BEARER_SETTLE_MS);
      };
      const kmsi = () => {
        kmsiTimer = null;
        if (done) return;
        if (isAuthUrl(curUrl(), owaRe)) {
          try { const p = win.webContents.executeJavaScript(KMSI_SCRIPT); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) { /* page busy */ }
          kmsiTimer = later(kmsi, TC.KMSI_POLL_MS);
        }
      };
      const onNav = (_e, url) => {
        if (done) return;
        if (isAuthUrl(url, owaRe)) {
          if (!wallTimer) {
            wallTimer = later(() => { if (isAuthUrl(curUrl(), owaRe)) finish(new ApiAuthBlockedError()); }, TC.TOKEN_AUTH_WALL_MS);
          }
          if (!kmsiTimer) kmsiTimer = later(kmsi, TC.KMSI_POLL_MS);
        } else if (isOutlookUrl(url, owaRe)) {
          cancel(wallTimer); wallTimer = null;
        }
      };
      const onLoad = () => {
        if (done || bearerWait) return;
        const u = curUrl();
        if (isAuthUrl(u, owaRe) || !(owaRe.MAILBOX_RE && owaRe.MAILBOX_RE.test(u))) return;
        bearerWait = later(() => { if (best) succeed(); else finish(new TokenUnavailableError('no-bearer')); }, TC.BEARER_WAIT_MS);
      };
      const onMessage = (_e, method, params) => { if (method === 'Network.requestWillBeSent') { try { observe(params); } catch (_) { /* metadata only */ } } };
      const listeners = { onNav, onLoad, onMessage };

      try {
        win = new BrowserWindow({
          width: 1280, height: 900, show: false, x: -32000, y: -32000, skipTaskbar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
        });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.on('show', () => { try { win.hide(); } catch (_) { /* hidden window */ } });
      } catch (_) {
        finish(new TokenUnavailableError('window-error'));
        return;
      }
      later(() => {
        if (best) { succeed(); return; }
        finish(isAuthUrl(curUrl(), owaRe) ? new ApiAuthBlockedError() : new TokenUnavailableError('timeout'));
      }, TC.TOKEN_WINDOW_HARD_MS);
      try {
        dbg = win.webContents.debugger;
        dbg.attach('1.3');
        dbg.on('message', onMessage);
        const p = dbg.sendCommand('Network.enable');
        if (p && typeof p.catch === 'function') p.catch(() => finish(new TokenUnavailableError('cdp-failed')));
      } catch (_) {
        finish(new TokenUnavailableError('cdp-failed'));
        return;
      }
      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-redirect-navigation', onNav);
      win.webContents.on('did-finish-load', onLoad);
      try {
        const p = win.loadURL(TC.TOKEN_PAGE_URL);
        if (p && typeof p.catch === 'function') p.catch(() => { /* SPA aborts are normal; the timers decide */ });
      } catch (_) { finish(new TokenUnavailableError('window-error')); }
    });
  }

  async function _cleanup(win, dbg, l) {
    if (!win) return;
    try {
      win.webContents.removeListener('did-navigate', l.onNav);
      win.webContents.removeListener('did-redirect-navigation', l.onNav);
      win.webContents.removeListener('did-finish-load', l.onLoad);
    } catch (_) { /* window gone */ }
    try { if (dbg) { dbg.removeListener('message', l.onMessage); if (dbg.isAttached()) dbg.detach(); } } catch (_) { /* detached */ }
    let destroyed = false;
    try { destroyed = win.isDestroyed(); } catch (_) { destroyed = true; }
    if (destroyed) return;
    await new Promise((resolve) => {
      let h = null;
      const fin = () => { if (h) timers.clearTimeout(h); resolve(); };
      try { win.once('closed', fin); } catch (_) { /* no event api */ }
      h = timers.setTimeout(() => { try { if (!win.isDestroyed()) win.destroy(); } catch (_) { /* gone */ } resolve(); }, TC.WINDOW_CLOSE_WAIT_MS);
      try { win.close(); } catch (_) { fin(); }
      try { if (win.isDestroyed()) fin(); } catch (_) { fin(); }
    });
  }

  return { getAuth, peek, invalidate, alternate, describe };
}

module.exports = { createTokenSource, isOutlookUrl, isAuthUrl, hostOf, jwtExpMs, BEARER_RE, KMSI_SCRIPT };
