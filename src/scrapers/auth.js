'use strict';
// scrapers/auth.js
// AuthManager — injects Midway SSO cookies from ~/.midway/cookie into the
// Electron fleet-scraper session. No visible login window needed.
// User runs mwinit once per session as normal — we read the cookie file.

const { session: electronSession, BrowserWindow } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('auth');

const COOKIE_FILE   = P.midwayCookie;
const SESSION_KEY   = ''; // empty = default session (no partition) to inherit AEA
const AAP_PROBE_URL = 'https://aap-na.corp.amazon.com/v2/page/bafc8b2a-3be6-4a52-a86f-7cb2de7b5400';

// ── Parse Netscape cookie file ────────────────────────────────────────────────
// Format per line: domain \t flag \t path \t secure \t expiry \t name \t value
// HttpOnly prefix: #HttpOnly_<domain>\t...
function parseMidwayCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error('Midway cookie not found at ' + COOKIE_FILE + ' — run mwinit first');
  }

  const text  = fs.readFileSync(COOKIE_FILE, 'utf8');
  const lines = text.split(/\r?\n/);
  const cookies = [];
  const now = Math.floor(Date.now() / 1000);

  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith('# Netscape') || line.startsWith('# This file')) continue;

    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const domain     = parts[0];
    const cookiePath = parts[2] || '/';
    const secure     = parts[3] === 'TRUE';
    const expiry     = parseInt(parts[4], 10);
    const name       = parts[5];
    const value      = parts.slice(6).join('\t');

    if (!/amazon\.(com|dev)|a2z\.com/.test(domain)) continue;
    if (expiry && expiry < now) continue;

    cookies.push({
      url:            'https://' + domain.replace(/^\./, '') + cookiePath,
      domain,
      path:           cookiePath,
      name,
      value,
      secure,
      httpOnly,
      expirationDate: expiry || undefined,
      sameSite:       'no_restriction',
    });
  }

  logger.info('[AuthManager] Parsed', cookies.length, 'Midway cookies');
  return cookies;
}

// ── Inject cookies into the Electron session ──────────────────────────────────
async function injectCookies() {
  const ses     = electronSession.defaultSession;
  const cookies = parseMidwayCookies();
  let injected  = 0;
  let failed    = 0;

  for (const c of cookies) {
    try {
      await ses.cookies.set(c);
      injected++;
    } catch(e) {
      failed++;
      logger.debug('[AuthManager] Skip', c.name, '@', c.domain, ':', e.message);
    }
  }

  // Flush to disk — REQUIRED so hidden BrowserWindows see the cookies immediately
  await ses.cookies.flushStore();

  logger.info('[AuthManager] Injected:', injected, ' Skipped:', failed);
  return injected;
}

// ── Probe: load AAP, decide auth success by URL alone ────────────────────────
// URL-based only — DOM/React class selectors are too fragile.
// Success: final URL stays on aap-na.corp.amazon.com
// Failure: redirected to midway-auth / login / SSO pages
async function probeSession() {
  return new Promise((resolve) => {
    const probe = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        
      }
    });

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { probe.destroy(); } catch(_) {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      logger.info('[AuthManager] Probe timed out');
      done(false);
    }, 25000);

    const isAAP = (url) => /aap-na\.corp\.amazon\.com/i.test(url);
    const isSSO = (url) => /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i.test(url)
                           && !isAAP(url);

    // Catch SSO redirects as early as possible
    probe.webContents.on('will-redirect',        (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate',         (_, url) => { logger.info('[AuthManager] nav:', url); if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate-in-page', (_, url) => { if (isSSO(url)) done(false); });

    probe.webContents.on('did-finish-load', async () => {
      const url = probe.webContents.getURL();
      logger.info('[AuthManager] Probe landed:', url);

      if (isSSO(url)) { done(false); return; }
      if (isAAP(url)) { done(true);  return; }

      // Still loading / unknown intermediate — wait a beat and re-check
      await new Promise(r => setTimeout(r, 1500));
      const finalUrl = probe.webContents.getURL();
      logger.info('[AuthManager] Probe final URL:', finalUrl);
      done(isAAP(finalUrl));
    });

    probe.webContents.on('did-fail-load', (_, code, desc) => {
      // -3 = ERR_ABORTED — normal for redirected navigations, ignore
      if (code === -3) return;
      logger.info('[AuthManager] Probe fail-load:', code, desc);
      done(false);
    });

    probe.loadURL(AAP_PROBE_URL);
  });
}

// ── Public: ensure session is valid, injecting Midway cookies ─────────────────
async function ensureAuthenticated(mainWindow) {
  const send = (ch, msg) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(ch, msg);
  };

  // Step 1: inject cookies from disk
  let injected;
  try {
    injected = await injectCookies();
  } catch(e) {
    send('fleet:error', e.message);
    throw e;
  }

  if (injected === 0) {
    const msg = 'No valid Midway cookies found — run mwinit and try again';
    send('fleet:error', msg);
    throw new Error(msg);
  }

  // Step 2: confirm AAP accepts session - if not, show visible login window
  send('fleet:status', 'Verifying session...');
  let ok = await probeSession();
  
  if (!ok) {
    logger.info('[AuthManager] Session invalid - showing login window...');
    send('fleet:status', 'Login required - complete auth in popup window...');
    await new Promise((resolve) => {
      const LoginWin = require('electron').BrowserWindow;
      const lw = new LoginWin({ width: 950, height: 700, show: true, title: 'Fleet - Login to AAP', webPreferences: { nodeIntegration: false, contextIsolation: true } });
      const tmout = setTimeout(() => { try { lw.close(); } catch(e) {} resolve(); }, 120000);
      lw.webContents.on('did-finish-load', () => {
        const u = lw.webContents.getURL();
        logger.info('[AuthManager] Login nav:', u);
        if (/aap-na\.corp\.amazon\.com/i.test(u) && !/midway|login|signin|sso|oidc/i.test(u)) {
          logger.info('[AuthManager] AAP loaded - login complete');
          clearTimeout(tmout);
          setTimeout(() => { try { lw.close(); } catch(e) {} resolve(); }, 3000);
        }
      });
      lw.on('closed', () => { clearTimeout(tmout); resolve(); });
      lw.loadURL(AAP_PROBE_URL);
    });
    ok = await probeSession();
  }
  
  if (!ok) {
    const msg = 'Still cannot access AAP - try running mwinit -f then restart';
    send('fleet:error', msg);
    throw Object.assign(new Error(msg), { code: 'MIDWAY_SESSION_INVALID' });
  }

  logger.info('[AuthManager] Session confirmed');
  return true;
}

/* ORIGINAL step 2:
  // Step 2: confirm AAP accepts the session
  send('fleet:status', '🔐 Verifying Midway session...');
  const ok = await probeSession();

  if (!ok) {
    const msg = 'AAP rejected Midway session — re-run mwinit then click Sync Now';
    send('fleet:error', msg);
    throw Object.assign(new Error(msg), { code: 'MIDWAY_SESSION_INVALID' });
  }

  logger.info('[AuthManager] Session confirmed ✓');
  return true;
} */

// ── Utility: check mwinit cookie age ─────────────────────────────────────────
function checkMwinit() {
  if (!fs.existsSync(COOKIE_FILE))
    return { ok: false, reason: 'Cookie file missing — run mwinit' };
  const ageHours = (Date.now() - fs.statSync(COOKIE_FILE).mtimeMs) / 3600000;
  if (ageHours > 12)
    return { ok: false, reason: 'Midway cookie is ' + ageHours.toFixed(1) + 'h old — re-run mwinit' };
  return { ok: true, ageHours: ageHours.toFixed(1) };
}

module.exports = { ensureAuthenticated, injectCookies, checkMwinit, COOKIE_FILE };
