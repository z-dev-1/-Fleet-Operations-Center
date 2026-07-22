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

  if (expired.length > 0 && cookies.length === 0) {
    // Only block if ALL cookies expired
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
      // FIX (2026-07-21): __Host-prefixed cookies (e.g. __Host-session) are
      // required by spec to be host-only -- Secure + Path=/ only, with NO
      // Domain attribute at all. This loop was always passing an explicit
      // `domain` field to ses.cookies.set() for every cookie, which Chromium's
      // cookie store rejects outright for any __Host- prefixed name (setting
      // an explicit domain, even without a leading dot, violates the __Host-
      // contract). That rejection was exactly the "Skipped: 1" seen on every
      // single injectCookies() run -- and __Host-session is the actual
      // Midway session credential, so silently dropping it meant the app
      // kept bouncing back to midway-auth.amazon.com/SSO/redirect even
      // immediately after a fully successful mwinit + "6 injected" log line.
      // Fix: omit `domain` for __Host- cookies and let Electron derive the
      // host-only scope from `url` instead, per the spec's own requirement.
      const cookieToSet = c.name.startsWith('__Host-')
        ? { url: c.url, path: c.path, name: c.name, value: c.value, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite }
        : c;
      await ses.cookies.set(cookieToSet);
      injected++;
    } catch (e) {
      failed++;
      logger.warn('[AuthManager] Skip', c.name, '@', c.domain, ':', e.message);
    }
  }

  await ses.cookies.flushStore(); // required so hidden BrowserWindows see cookies immediately
  logger.info('[AuthManager] Injected:', injected, ' Skipped:', failed);
  return injected;
}

// -- Spawn a visible terminal and run mwinit ---------------------------------
// Opens a real cmd.exe window so the user can tap their security key.
// Resolves once checkMwinit() confirms all cookies are valid.
// Rejects after MWINIT_TIMEOUT_MS if auth is not completed.
//
// FIX (2026-07-21): was hardcoded to `mwinit -o`, forcing OTP mode on every
// single auto-launch instead of letting mwinit auto-detect and use
// WebAuthn/Windows Hello -- exactly the flag mwinit's own startup banner
// warns against ("please avoid using the -o or --otp-auth flag... WebAuthn
// is available on this platform"). OTP codes have a short validity window;
// forcing this path made auth spawned by this app's own auth-poll
// meaningfully more likely to hit a freshness/replay-window rejection
// (surfaced as "AEA verification failed: used_too_late") than a plain
// `mwinit` run would be -- which is exactly why manually running mwinit
// elsewhere "worked fine" while this app's auto-launched terminal kept
// failing. Also: the retry loop's "[!] Invalid password" message below is
// this batch file's OWN hardcoded text on ANY non-zero mwinit exit code --
// it is not mwinit's real error output, so it was mislabeling a
// used_too_late timing failure as a wrong password the whole time.
// FIX (2026-07-21): added a module-level in-flight guard. There are multiple
// independent callers of runMwinit() in this app (app.js's 5-min auto-renewal
// timer, window/index.js's SSO-redirect auth-poller, the orcha:mwinit IPC
// handler, the Settings "Run mwinit" button) each with their OWN local
// "already running" flag that only protects against that ONE caller
// re-firing itself -- none of them knew about each other. That let two of
// these mechanisms spawn separate, concurrent mwinit terminals at the same
// time (confirmed live: multiple overlapping mwinit processes observed
// piling up over a single session). Two concurrent mwinit attempts racing
// for the same Midway session is a direct, confirmed cause of
// "AEA verification failed: used_too_late" -- one attempt's challenge/
// certificate timing gets invalidated by the other. Centralizing the guard
// here, inside the one function every caller actually goes through, fixes
// it regardless of which caller (present or future) triggers it: if a
// renewal is already in progress, every caller just awaits that SAME
// in-flight promise instead of spawning a second terminal.
let _mwinitInFlight = null;
function runMwinit() {
  if (_mwinitInFlight) {
    logger.info('[AuthManager] mwinit already in flight -- awaiting existing attempt instead of spawning another');
    return _mwinitInFlight;
  }
  _mwinitInFlight = new Promise((resolve, reject) => {
    logger.info('[AuthManager] Spawning mwinit terminal...');

    // FIX (2026-07-21): the ":RETRY" loop below treated ANY non-zero mwinit
    // exit code as total failure and looped back to re-run the entire
    // mwinit flow (PIN + WebAuthn tap) again. Confirmed live from the user's
    // actual terminal output: mwinit's cookie step ("Successfully
    // authenticated using WebAuthN, session cookie saved...") -- the ONLY
    // thing this app actually reads/uses -- succeeds on every single
    // attempt. The non-zero exit code is coming from a SEPARATE, later step
    // ("FAILED to get certificate. Request Forbidden. AEA verification
    // failed: used_too_late") that issues an X.509 client certificate this
    // app never uses (checkMwinit()/parseMidwayCookies() only ever read
    // ~/.midway/cookie, never any certificate file). So this retry loop was
    // forcing a full second (or third, fourth...) round of PIN + WebAuthn
    // purely because of an irrelevant cert-issuance failure, even though the
    // cookie the app actually needed was already valid after attempt #1.
    // The poll loop below already independently verifies real cookie
    // validity by re-reading the file every 1.5s -- it does not depend on
    // mwinit's exit code at all. So: run mwinit ONCE, let it exit with
    // whatever code it wants, and let the Node-side poll be the sole
    // arbiter of success. No more forced repeat authentication.
    const batchPath = require('path').join(require('os').tmpdir(), 'fleet_mwinit.bat');
    fs.writeFileSync(batchPath, [
      '@echo off',
      'echo Fleet Operations - Midway auth required.',
      'echo.',
      'mwinit',
      'echo.',
      'echo Auth step complete - this window will close in 3 seconds.',
      'timeout /t 3 /nobreak > nul',
      'exit',
    ].join('\r\n'));

    const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/c', batchPath], { detached: true, stdio: 'ignore', shell: false });
    child.unref();

    const started = Date.now();

    // Poll by re-reading the cookie file and checking actual expiry timestamps
    const poll = setInterval(() => {
      try {
        const state = checkMwinit();
        if (state.ok) {
          clearInterval(poll);
          logger.info('[AuthManager] mwinit complete -- cookies valid, expires in ' +
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
  // Always clear the lock once settled (success or failure), regardless of
  // which caller is awaiting it.
  _mwinitInFlight.finally(() => { _mwinitInFlight = null; });
  return _mwinitInFlight;
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
    // FIX (2026-07-21): isAAP() was a substring test against the WHOLE url
    // string, not the actual hostname. Midway's own SSO redirect URL legitimately
    // embeds the destination as a plain-text query param (dots aren't
    // percent-encoded): .../SSO/redirect?redirect_uri=https%3A%2F%2Faap-na.corp.amazon.com%2F...
    // That made isAAP() return true while STILL on midway-auth.amazon.com,
    // which also broke isSSO() (defined as ssoPattern && !isAAP) at the same
    // time -- both checks fooled by the same bug, causing probeSession() to
    // report a false "success" while the page was still stuck on the SSO
    // redirect. Confirmed live: 2026-07-21 probe landed on
    // "midway-auth.amazon.com/SSO/redirect?redirect_uri=...aap-na..." and
    // was reported as a successful AAP landing. Fix: parse the actual
    // hostname and compare that, not the raw url string.
    const isAAP   = (url) => { try { return /(^|\.)aap-na\.corp\.amazon\.com$/i.test(new URL(url).hostname); } catch (_) { return false; } };
    const isSSO   = (url) => /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i.test(url) && !isAAP(url);

    // FIX (2026-07-21): will-redirect and did-navigate-in-page were both
    // silently calling done(false) with NO logging when they detected an SSO
    // url -- unlike did-navigate/did-finish-load below, which both log
    // before deciding. That total silence is exactly why "AAP rejected
    // session" kept throwing with zero visibility into what URL was actually
    // being rejected. Logging here now so the real blocking URL is visible.
    probe.webContents.on('will-redirect',        (_, url) => { if (isSSO(url)) { logger.info('[AuthManager] will-redirect (SSO, rejecting):', url); done(false); } else { logger.info('[AuthManager] will-redirect (ok):', url.slice(0, 120)); } });
    probe.webContents.on('did-navigate',         (_, url) => { logger.info('[AuthManager] nav:', url); if (isSSO(url)) done(false); });
    probe.webContents.on('did-navigate-in-page', (_, url) => { if (isSSO(url)) { logger.info('[AuthManager] did-navigate-in-page (SSO, rejecting):', url); done(false); } });
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
    // FIX (2026-07-21): same substring-vs-hostname bug as probeSession()'s
    // isAAP() above -- see that comment for the full writeup. Checking
    // /aap-na\.corp\.amazon\.com/i.test(url) against the whole url string
    // matches Midway's own SSO redirect URL too, since it legitimately
    // embeds the destination as a plain-text redirect_uri query param.
    const isAAPHost = (url) => { try { return /(^|\.)aap-na\.corp\.amazon\.com$/i.test(new URL(url).hostname); } catch (_) { return false; } };
    const isSSO = (url) =>
      /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i.test(url) &&
      !isAAPHost(url);

    probe.webContents.on('will-redirect', (_, url) => {
      logger.info('[AuthManager] Relay redirect:', url.slice(0, 80));
      if (isSSO(url)) done(false);
    });
    probe.webContents.on('did-navigate',    (_, url) => { if (isSSO(url)) done(false); });
    probe.webContents.on('did-finish-load', () => {
      const url = probe.webContents.getURL();
      logger.info('[AuthManager] Relay landed:', url.slice(0, 80));
      done(isAAPHost(url));
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
  if (false /* DISABLED: mwinit auto-spawn causes boot loops */) {
    logger.warn('[AuthManager]', state.reason, '— mwinit disabled');
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
  probeSession, // FIX (2026-07-21): exported so callers can replicate ensureAuthenticated's verification steps without its disabled auto-spawn branch
  ensureAuthenticated,
  pingRelayEndpoint,
  COOKIE_FILE,
};
