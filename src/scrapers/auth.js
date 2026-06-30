'use strict';
// scrapers/auth.js
// AuthManager — injects Midway SSO cookies from ~/.midway/cookie into the
// Electron fleet-scraper session. Automatically spawns a mwinit terminal
// when cookies are detected as expired by reading actual expiry timestamps
// from the cookie file — no hardcoded hour thresholds.

const { session: electronSession, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs  = require('fs');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('auth');

const COOKIE_FILE       = P.midwayCookie;
const AAP_PROBE_URL     = 'https://aap-na.corp.amazon.com/v2/page/bafc8b2a-3be6-4a52-a86f-7cb2de7b5400';
const AAP_SERVICE_PROBE = 'https://aap-na.corp.amazon.com/v2/service/00000000-0000-0000-0000-000000000000';
const RELAY_PROBE_MS    = 10_000;
const MWINIT_TIMEOUT_MS = 3 * 60 * 1000;

// ── Parse Netscape cookie file ────────────────────────────────────────────────
// Format: domain \t flag \t path \t secure \t expiry(unix) \t name \t value
// HttpOnly lines prefixed with: #HttpOnly_<domain>\t...
// Returns { cookies: [...], expired: [...] }
function parseMidwayCookies() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error('Midway cookie file not found at ' + COOKIE_FILE + ' — run mwinit first');
  }

  const text    = fs.readFileSync(COOKIE_FILE, 'utf8');
  const lines   = text.split(/\r?\n/);
  const now     = Math.floor(Date.now() / 1000);
  const cookies = [];
  const expired = [];

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

    if (expiry && expiry < now) {
      expired.push({ name, domain, expiredAgoMin: Math.round((now - expiry) / 60) });
      continue;
    }

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

  logger.info('[AuthManager] Parsed', cookies.length, 'valid,', expired.length, 'expired');
  return { cookies, expired };
}

// ── Check cookie expiry from file — no hardcoded time thresholds ──────────────
// Reads the actual Unix expiry timestamps embedded in the cookie file.
// Returns { ok: true, count, expiresInMin } or { ok: false, reason, expired }
function checkMwinit() {
  if (!fs.existsSync(COOKIE_FILE)) {
    return { ok: false, reason: 'Midway cookie file missing — run mwinit' };
  }

  let parsed;
  try {
    parsed = parseMidwayCookies();
  } catch (e) {
    return { ok: false, reason: 'Cannot read cookie file: ' + e.message };
  }

  const { cookies, expired } = parsed;

  if (cookies.length === 0) {
    return { ok: false, reason: 'All Midway cookies have expired — run mwinit', expired };
  }

  if (expired.length > 0) {
    const names = expired.map(c => c.name).join(', ');
    return { ok: false, reason: 'Expired cookies: ' + names, expired };
  }

  // Find the soonest expiry for logging
  const now = Math.floor(Date.now() / 1000);
  const soonest = cookies
    .filter(c => c.expirationDate)
    .reduce((min, c) => Math.min(min, c.expirationDate), Infinity);
  const expiresInMin = soonest === Infinity ? null : Math.round((soonest - now) / 60);

  return { ok: true, count: cookies.length, expiresInMin };
}

// ── Inject cookies into the Electron session ─────────────────────────────────
async function injectCookies() {
  const ses             = electronSession.defaultSession;
  const { cookies }     = parseMidwayCookies();
  let injected = 0, failed = 0;

  for (const c of cookies) {
    try {
      await ses.cookies.set(c);
      injected++;
    } catch (e) {
      failed++;
      logger.debug('[AuthManager] Skip', c.name, '@', c.domain, ':', e.message);
    }
  }

  await ses.cookies.flushStore(); // required so hidden BrowserWindows see cookies immediately
  logger.info('[AuthManager] Injected:', injected, ' Skipped:', failed);
  return injected;
}

// ── Spawn a visible terminal and run mwinit -o ────────────────────────────────
// Opens a real cmd.exe window so the user can tap their security key.
// Resolves once checkMwinit() confirms all cookies are valid.
// Rejects after MWINIT_TIMEOUT_MS if auth is not completed.
function runMwinit() {
  return new Promise((resolve, reject) => {
    logger.info('[AuthManager] Spawning mwinit terminal...');

    const child = spawn('cmd.exe', [
      '/c', 'start', 'cmd.exe', '/k',
      [
        'echo Fleet Operations - Midway auth required.',
        'echo.',
        'mwinit -o',
        'echo.',
        'echo Auth complete - this window will close in 3 seconds.',
        'timeout /t 3 /nobreak > nul',
        'exit',
      ].join(' && '),
    ], { detached: true, stdio: 'ignore', shell: false });
    child.unref();

    const started = Date.now();

    // Poll by re-reading the cookie file and checking actual expiry timestamps
    const poll = setInterval(() => {
      try {
        const state = checkMwinit();
        if (state.ok) {
          clearInterval(poll);
          logger.info('[AuthManager] mwinit complete — cookies valid, expires in ' +
            (state.expiresInMin !== null ? state.expiresInMin + 'min' : 'session'));
          resolve();
          return;
        }
        if (Date.now() - started > MWINIT_TIMEOUT_MS) {
          clearInterval(poll);
          reject(new Error('mwinit timed out after 3 minutes'));
        }
      } catch (_) {
        // Ignore transient FS errors while cookie file is being written
      }
    }, 1500);
  });
}

// ── Probe AAP session by URL (no DOM — too fragile) ──────────────────────────
async function probeSession() {
  return new Promise((resolve) => {
    const probe = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { probe.destroy(); } catch (_) {}
      resolve(ok);
    };

    const timeout = setTimeout(() => { logger.info('[AuthManager] Probe timed out'); done(false); }, 25000);
    const isAAP   = (url) => /aap-na\.corp\.amazon\.com/i.test(url);
    const isSSO   = (url) => /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i.test(url) && !isAAP(url);

    probe.webContents.on('will-redirect',        (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate',         (_, url) => { logger.info('[AuthManager] nav:', url); if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate-in-page', (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-finish-load', async () => {
      const url = probe.webContents.getURL();
      logger.info('[AuthManager] Probe landed:', url);
      if (isSSO(url)) { done(false); return; }
      if (isAAP(url)) { done(true);  return; }
      await new Promise(r => setTimeout(r, 1500));
      done(isAAP(probe.webContents.getURL()));
    });
    probe.webContents.on('did-fail-load', (_, code, desc) => {
      if (code === -3) return;
      logger.info('[AuthManager] Probe fail-load:', code, desc);
      done(false);
    });

    probe.loadURL(AAP_PROBE_URL);
  });
}

// ── Relay probe — hits /v2/service/ which bypasses CloudFront cache ───────────
async function pingRelayEndpoint() {
  return new Promise((resolve) => {
    const probe = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { probe.destroy(); } catch (_) {}
      resolve(ok);
    };

    const timer = setTimeout(() => { logger.warn('[AuthManager] Relay probe timed out'); done(false); }, RELAY_PROBE_MS);
    const isSSO = (url) =>
      /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i.test(url) &&
      !/aap-na\.corp\.amazon\.com/i.test(url);

    probe.webContents.on('will-redirect', (_, url) => {
      logger.info('[AuthManager] Relay redirect:', url.slice(0, 80));
      if (isSSO(url)) done(false);
    });
    probe.webContents.on('did-navigate',    (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-finish-load', () => {
      const url = probe.webContents.getURL();
      logger.info('[AuthManager] Relay landed:', url.slice(0, 80));
      done(/aap-na\.corp\.amazon\.com/i.test(url));
    });
    probe.webContents.on('did-fail-load', (_, code, desc) => {
      if (code === -3) return;
      logger.warn('[AuthManager] Relay fail-load:', code, desc);
      done(false);
    });

    probe.loadURL(AAP_SERVICE_PROBE);
  });
}

// ── ensureAuthenticated ───────────────────────────────────────────────────────
// Full auth flow: check expiry → mwinit if needed → inject → probe.
// Called before any mainWindow.loadURL(aap-url).
async function ensureAuthenticated(mainWindow) {
  const send = (ch, msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, msg);
  };

  // Check cookie expiry from file — if any expired, run mwinit automatically
  const state = checkMwinit();
  if (!state.ok) {
    logger.warn('[AuthManager]', state.reason, '— spawning mwinit terminal');
    send('fleet:status', '\uD83D\uDD11 Midway session expired — complete auth in terminal...');
    try {
      await runMwinit();
    } catch (e) {
      const msg = 'mwinit failed: ' + e.message;
      send('fleet:error', '\u26A0\uFE0F ' + msg);
      throw Object.assign(new Error(msg), { code: 'MWINIT_FAILED' });
    }
  } else {
    logger.info('[AuthManager] Cookies valid (' + state.count + ' cookies, expires in ' +
      (state.expiresInMin !== null ? state.expiresInMin + 'min' : 'session') + ')');
  }

  // Inject into Electron session
  let injected;
  try {
    injected = await injectCookies();
  } catch (e) {
    send('fleet:error', e.message);
    throw e;
  }

  if (injected === 0) {
    const msg = 'No valid Midway cookies after inject — run mwinit -f and restart';
    send('fleet:error', msg);
    throw new Error(msg);
  }

  // Verify AAP accepts the session
  send('fleet:status', 'Verifying session...');
  const ok = await probeSession();
  if (!ok) {
    const msg = 'AAP rejected session — run mwinit -f then restart';
    send('fleet:error', msg);
    throw Object.assign(new Error(msg), { code: 'MIDWAY_SESSION_INVALID' });
  }

  // Verify relay endpoints (not cached — definitive auth check)
  send('fleet:status', 'Verifying relay session...');
  let relayOk = await pingRelayEndpoint();
  if (!relayOk) {
    logger.warn('[AuthManager] Relay failed — re-injecting and retrying');
    try { await injectCookies(); } catch (_) {}
    relayOk = await pingRelayEndpoint();
  }
  if (!relayOk) {
    const msg = 'AAP relay rejected session — run mwinit -f then retry';
    send('fleet:error', msg);
    throw Object.assign(new Error(msg), { code: 'RELAY_SESSION_INVALID' });
  }

  logger.info('[AuthManager] Session confirmed (page + relay probes passed)');
  return true;
}

module.exports = {
  checkMwinit,
  runMwinit,
  injectCookies,
  ensureAuthenticated,
  pingRelayEndpoint,
  COOKIE_FILE,
};
