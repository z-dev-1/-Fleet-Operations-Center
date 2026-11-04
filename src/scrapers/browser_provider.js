'use strict';
/**
 * browser_provider.js — engine-agnostic "authenticated AAP page" provider.
 *
 * PURPOSE (Stage 10):
 *   aap_api.js (and any other borrows-an-authed-page scraper) needs ONE thing:
 *   a page context that (a) carries the current Midway/AEA session and (b) can
 *   run in-page JavaScript (executeJavaScript / page.evaluate). On the laptop
 *   that is an Electron BrowserWindow borrowing session.defaultSession. On the
 *   headless Amazon DevSpace there is no Electron display — but a headless
 *   Playwright Chromium, seeded with the box's ~/.midway/cookie, CAN reach AAP
 *   (proven 2026-08: landing 200, API 200, real JSON — AEA is satisfied by the
 *   box's own cookie; only curl fails the device-posture/JS challenge).
 *
 *   This module picks the right engine at runtime and exposes a tiny uniform
 *   surface so the token-capture + XHR-in-page logic in aap_api.js is identical
 *   on both:
 *       provider.available()                      -> boolean
 *       provider.kind()                           -> 'electron' | 'playwright' | 'none'
 *       const p = await provider.openPage(url)    -> { evaluate, url, close }
 *       p.evaluate(scriptString)                  -> Promise<any>  (in-page eval)
 *       p.url()                                   -> current URL (for SSO detect)
 *       p.close()                                 -> tear the page/context down
 *
 * SAFETY / SCOPE:
 *   - READ-ONLY path. This provider only gives a page to run GETs in. Writes
 *     (lifecycle flips, SP push, OWA) remain gated by mode-gate's 'fleet-mutate'
 *     / 'sp-push' / browser capability and are NOT unlocked here.
 *   - The Playwright engine is used ONLY when (a) Electron is unavailable or has
 *     no display AND (b) FLEET_HEADLESS_BROWSER=1 (or settings opt-in) AND
 *     (c) the `playwright` module + a midway cookie file are present. On the
 *     laptop none of that is true, so the Electron path is used unchanged.
 *   - Nothing here runs at import time; everything is lazy.
 */

const fs = require('fs');
let logger; try { logger = require('../utils/logger')('browser-provider'); } catch (_) { logger = { info() {}, warn() {} }; }

const AAP_ORIGIN = 'https://aap-na.corp.amazon.com';
const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');

// ── Engine detection ─────────────────────────────────────────────────────────

function _hasElectronDisplay() {
  try {
    // Electron main process: BrowserWindow exists and we are NOT a headless
    // Linux box. On win32/darwin a display is assumed present.
    const electron = require('electron');
    if (!electron || !electron.BrowserWindow) return false;
    if (process.platform === 'linux' && !process.env.DISPLAY) return false;
    return true;
  } catch (_) { return false; }
}

function _playwrightOptIn() {
  if (process.env.FLEET_HEADLESS_BROWSER === '1') return true;
  if (process.env.FLEET_HEADLESS_BROWSER === '0') return false;
  try {
    const store = require('../store');
    const c = (store.load('settings', {}) || {}).cluster || {};
    return !!c.headlessBrowser;
  } catch (_) { return false; }
}

function _playwrightUsable() {
  if (!_playwrightOptIn()) return false;
  // Need the module AND a midway cookie file to seed the session.
  try { require.resolve('playwright'); } catch (_) { return false; }
  try {
    const { P } = require('../config/paths');
    if (!P.midwayCookie || !fs.existsSync(P.midwayCookie)) return false;
  } catch (_) { return false; }
  return true;
}

// Which engine will openPage() use? 'electron' preferred when a display exists;
// 'playwright' on a headless host that opted in and is usable; else 'none'.
function kind() {
  if (_hasElectronDisplay()) return 'electron';
  if (_playwrightUsable()) return 'playwright';
  return 'none';
}

function available() { return kind() !== 'none'; }

// ── Electron engine (unchanged behavior; mirrors aap_api's original window) ──

async function _openElectron(url, opts) {
  const { BrowserWindow, session } = require('electron');
  // Seed the freshest Midway/AEA cookies into the default session first — the
  // SAME step aap_api did inline before Stage 10.
  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) { logger.warn('cookie inject skipped: ' + e.message); }

  const win = new BrowserWindow({
    width: 1400, height: 800, show: false, x: -3000, y: -3000, skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      session: session.defaultSession, backgroundThrottling: false,
    },
  });

  const loadMs = (opts && opts.loadMs) || 45000;
  // AAP's HEALTHY auth flow for a VALID session redirects THROUGH midway-auth's
  // OIDC handshake before landing back on AAP:
  //   aap-na.../v2/page/...  →  midway-auth.../SSO/redirect?...redirect_uri=<aap>  →  back to aap-na...
  // So we must NOT declare the session invalid just because an intermediate
  // did-finish-load fired on a midway-auth URL. Judge ONLY by where navigation
  // SETTLES: debounce after the last did-finish-load, then check the final URL.
  // (This mirrors auth.js probeSession's settle logic — the Stage-10 refactor
  // originally checked the FIRST load event, which wrongly reported a valid
  // session as expired mid-handshake. Regression fix.)
  const isAAPHost = (u) => { try { return /(^|\.)aap-na\.corp\.amazon\.com$/i.test(new URL(u).hostname); } catch (_) { return false; } };
  const result = await new Promise((resolve) => {
    let done = false;
    let settleTimer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(hardT); clearTimeout(settleTimer); resolve(v); } };
    const hardT = setTimeout(() => finish({ ok: false, error: 'timeout' }), loadMs);
    const scheduleSettle = () => {
      clearTimeout(settleTimer);
      // Whatever we're on when navigation goes quiet for 2.5s is the FINAL
      // landing. Handshake hops keep navigating and keep resetting this.
      settleTimer = setTimeout(() => {
        let cur = ''; try { cur = win.webContents.getURL(); } catch (_) {}
        if (isAAPHost(cur)) finish({ ok: true, url: cur });
        else if (_isSSO(cur)) finish({ ok: false, error: 'auth', url: cur });
        else finish({ ok: isAAPHost(cur), url: cur });
      }, 2500);
    };
    win.webContents.on('did-finish-load', () => {
      let cur = ''; try { cur = win.webContents.getURL(); } catch (_) {}
      if (isAAPHost(cur)) { finish({ ok: true, url: cur }); return; }  // landed on AAP → done
      scheduleSettle();                                               // else wait for settle
    });
    win.webContents.on('did-navigate', () => scheduleSettle());
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return;               // aborted sub-resource; ignore
      scheduleSettle();                       // transient fail mid-handshake — let it settle
    });
    win.loadURL(url);
  });

  if (!result.ok && result.error === 'auth') {
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
    throw Object.assign(new Error('AAP session expired (Midway/AEA) — re-authenticate'),
      { code: 'MIDWAY_SESSION_INVALID' });
  }
  if (!result.ok) {
    try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
    throw Object.assign(new Error('AAP page failed to load: ' + result.error),
      { code: 'AAP_PAGE_LOAD_FAILED' });
  }

  return {
    engine: 'electron',
    url: () => { try { return win.webContents.getURL(); } catch (_) { return cur; } },
    evaluate: (script) => win.webContents.executeJavaScript(script, true),
    close: () => { try { if (!win.isDestroyed()) win.destroy(); } catch (_) {} },
  };
}

// ── Playwright engine (headless DevSpace; seeds ~/.midway/cookie) ────────────

// Map an auth.js cookie object to Playwright's addCookies() shape. auth.js
// already gives us {url, domain, path, name, value, secure, httpOnly,
// expirationDate, sameSite}. Playwright wants `expires` (seconds) and a
// capitalized sameSite enum, and either url OR domain+path (not both for
// __Host- host-only cookies — we pass url for those, matching the Electron fix).
function _toPwCookies(cookies) {
  const SAMESITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
  const out = [];
  for (const c of cookies) {
    const base = {
      name: c.name,
      value: c.value,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: SAMESITE[String(c.sameSite || '').toLowerCase()] || 'None',
    };
    if (typeof c.expirationDate === 'number') base.expires = c.expirationDate;
    // __Host- cookies MUST be host-only: give url, never domain (same contract
    // the Electron injector enforces). For the rest, domain+path scopes them to
    // every AAP subdomain the session spans.
    if (c.name.startsWith('__Host-')) {
      base.url = c.url;
    } else {
      base.domain = c.domain;
      base.path = c.path || '/';
    }
    out.push(base);
  }
  return out;
}

let _pwBrowser = null;   // reused across openPage() calls within a process

async function _playwrightBrowser() {
  if (_pwBrowser) return _pwBrowser;
  const { chromium } = require('playwright');
  _pwBrowser = await chromium.launch({
    headless: true,
    // chromium-headless-shell is already downloaded on the DevSpace; these args
    // keep it happy in a container with no sandbox namespace.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return _pwBrowser;
}

async function _openPlaywright(url, opts) {
  const { parseMidwayCookies } = require('./auth');
  const { cookies } = parseMidwayCookies();     // reuse the exact parser
  const browser = await _playwrightBrowser();
  const context = await browser.newContext();
  try { await context.addCookies(_toPwCookies(cookies)); }
  catch (e) { logger.warn('addCookies partial: ' + e.message); }
  const page = await context.newPage();

  const loadMs = (opts && opts.loadMs) || 45000;
  let navErr = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: loadMs });
  } catch (e) { navErr = e; }

  let cur = '';
  try { cur = page.url(); } catch (_) {}
  if (navErr && _isSSO(cur)) { /* fallthrough to SSO branch below */ }
  else if (navErr) {
    try { await context.close(); } catch (_) {}
    throw Object.assign(new Error('AAP page failed to load (headless): ' + navErr.message),
      { code: 'AAP_PAGE_LOAD_FAILED' });
  }
  if (_isSSO(cur)) {
    try { await context.close(); } catch (_) {}
    throw Object.assign(new Error('AAP session expired (Midway/AEA) on headless host — run mwinit -o'),
      { code: 'MIDWAY_SESSION_INVALID' });
  }

  return {
    engine: 'playwright',
    url: () => { try { return page.url(); } catch (_) { return cur; } },
    // Playwright's page.evaluate runs a function; we receive a SCRIPT STRING
    // (same contract aap_api uses for Electron). The aap_api scripts are
    // self-invoking expressions that end in a trailing `;`, e.g.
    //   (async function(){ ... })();
    // so the body is `return <that-expression>;` — a valid function body whose
    // trailing semicolon just ends the return statement. (The earlier
    // `return (<src>)` wrapper produced `return (...;)` → SyntaxError on the
    // inner `;`.) new Function returns the IIFE's value (a Promise for the
    // async ones); Playwright awaits thenables, matching Electron's
    // executeJavaScript(scriptString) semantics exactly.
    evaluate: (script) => page.evaluate(
      // eslint-disable-next-line no-new-func
      (src) => (new Function('return ' + src))(), script),
    close: () => { context.close().catch(() => {}); },
  };
}

// ── Public: open one authenticated AAP page on whichever engine is available ─

async function openPage(url, opts) {
  const k = kind();
  if (k === 'electron') return _openElectron(url || AAP_ORIGIN, opts);
  if (k === 'playwright') return _openPlaywright(url || AAP_ORIGIN, opts);
  throw Object.assign(
    new Error('no browser provider available (no Electron display; headless Playwright not opted in/usable)'),
    { code: 'NO_BROWSER_PROVIDER' });
}

// Tear down the shared Playwright browser (called on shutdown / idle).
async function shutdown() {
  if (_pwBrowser) { try { await _pwBrowser.close(); } catch (_) {} _pwBrowser = null; }
}

// Test/reset hook.
function _reset() { _pwBrowser = null; }

module.exports = {
  AAP_ORIGIN, available, kind, openPage, shutdown,
  _toPwCookies, _isSSO, _reset,
};
