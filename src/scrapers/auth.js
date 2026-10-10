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

// Connectivity check (raw internet only; VPN does NOT count). Lazy-required to
// avoid a load-order/circular dependency with orcha/offline, and defensively
// wrapped so a missing/uninitialized module never blocks auth (defaults to
// "online" so behavior is unchanged if offline monitoring isn't running).
function _isOfflineNow() {
  try { return !!require('../orcha/offline').isOffline(); }
  catch (_) { return false; }
}

// Chromium network-layer error codes that mean "could not reach the network"
// (connectivity/offline), as opposed to the page loading and the server
// rejecting the session. Used to keep a connectivity blip from being misread
// as an auth rejection. See https://source.chromium.org/ net_error_list.
const _NETWORK_ERR_CODES = new Set([
  -2,   // FAILED (generic)
  -21,  // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -137, // NAME_RESOLUTION_FAILED
  -138, // NETWORK_ACCESS_DENIED
  -324, // EMPTY_RESPONSE
]);

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

    // Accept all Midway/Amazon auth domains. FIX (2026-10-10): the old filter
    // was /amazon\.(com|dev)|a2z\.com/ which DROPPED the amazon_enterprise_access
    // cookie on `.auth.midway.aws.dev` (matches none of those) — confirmed from
    // the live cookie file. AAP checks AEA across all four of its domains, so a
    // dropped one weakens the session. Added aws.dev + a generic midway match.
    if (!/amazon\.(com|dev)|a2z\.com|aws\.dev|midway/i.test(domain)) continue;

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
    // All cookies in the file have expired
    const names = expired.map(c => c.name).join(', ');
    const reason = expired.length > 0
      ? 'All Midway cookies have expired (' + names + ') — run mwinit'
      : 'All Midway cookies have expired — run mwinit';
    return { ok: false, reason, expired };
  }

  // Some cookies expired, some still valid — session is still usable.
  // The soonest-expiry logic below will reflect how much time is left.
  const now = Math.floor(Date.now() / 1000);
  // FIX (2026-07-28): was computing soonest expiry across ALL cookies, which
  // always picked up amazon_enterprise_access — a short-lived (~2h) JWT access
  // token that Midway issues alongside the real ~20h session cookies. That
  // made the app report "expires in ~2h" and fire auto-renewal ~18h too early.
  //
  // Cookie lifetime breakdown (confirmed from live cookie file):
  //   amazon_enterprise_access  → ~2h  (JWT access token, 4 domains)
  //   __Host-session / session  → ~20h (actual Midway session credential)
  //   tpm_metrics               → ~20h (TPM metrics token)
  //   user_name                 → ~1yr (static identity cookie)
  //
  // The session is alive as long as __Host-session / session are valid.
  // amazon_enterprise_access is a short-lived token used during the Midway
  // handshake — it is NOT the ongoing session credential and must be excluded
  // from the expiry clock.
  //
  // SESSION_COOKIES: names that represent the real ~20h session.
  // SHORT_LIVED:     names to exclude from the expiry/renewal clock.
  const SHORT_LIVED_NAMES = new Set(['amazon_enterprise_access']);
  const sessionCookies = cookies.filter(c => !SHORT_LIVED_NAMES.has(c.name) && c.expirationDate);
  const allCookies     = cookies.filter(c => c.expirationDate);

  // Find the soonest expiry among SESSION cookies only (for renewal clock)
  const soonest = sessionCookies.length
    ? sessionCookies.reduce((min, c) => Math.min(min, c.expirationDate), Infinity)
    : allCookies.reduce((min, c) => Math.min(min, c.expirationDate), Infinity);

  const expiresInMin = soonest === Infinity ? null : Math.round((soonest - now) / 60);

  // AEA (amazon_enterprise_access) is the short-lived access token that AAP
  // actually enforces server-side. It is deliberately EXCLUDED from the
  // session renewal clock above (renewing the 20h session early doesn't help),
  // but AAP will bounce us to Midway SSO the moment this token lapses even
  // though the session cookie still has many hours left. So we report its
  // expiry SEPARATELY here (aeaExpiresInMin) so callers can proactively
  // re-inject / refresh ahead of an AAP bounce instead of only reacting to the
  // SSO-redirect loop after the fact. Root cause of the erratic ~2h re-auth
  // churn (confirmed via cookie file + window.log SSO-loop correlation).
  const aeaCookies = cookies.filter(c => SHORT_LIVED_NAMES.has(c.name) && c.expirationDate);
  const aeaSoonest = aeaCookies.length
    ? aeaCookies.reduce((min, c) => Math.min(min, c.expirationDate), Infinity)
    : Infinity;
  const aeaExpiresInMin = aeaSoonest === Infinity ? null : Math.round((aeaSoonest - now) / 60);

  return { ok: true, count: cookies.length, expiresInMin, aeaExpiresInMin };
}

// ── Inject cookies into the Electron session ─────────────────────────────────
// FEATURE (2026-07-23): accepts an optional target session (defaults to
// defaultSession, preserving every existing call site's behavior). Needed
// so credentials:test-login can seed a vendor's OWN isolated partition
// (e.g. persist:vendor-roadready) with the same already-valid Midway
// cookies that let the main window reach AAP without ever hitting the
// "AEA extension not installed" gate -- a brand-new partition has never
// been through mwinit/WebAuthn itself, so it hits that gate cold even
// though this app already holds a fully valid Midway session elsewhere.
async function injectCookies(targetSession) {
  const ses             = targetSession || electronSession.defaultSession;
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
function runMwinit(force) {
  if (_mwinitInFlight) {
    logger.info('[AuthManager] mwinit already in flight -- awaiting existing attempt instead of spawning another');
    return _mwinitInFlight;
  }
  // OFFLINE GATE (2026-10): never spawn the interactive mwinit terminal while
  // the machine has no internet. Historically a brief network drop (or VPN
  // hiccup) made the session probes fail to LOAD, which was indistinguishable
  // from an SSO rejection and forced an unnecessary re-auth prompt — the root
  // cause of "re-authing multiple times a day". "Offline" here is raw internet
  // connectivity only (net.isOnline); VPN state deliberately does NOT count. On
  // reconnect, the auth layer re-probes the SAME cookies first (see
  // startOnlineReauthWatch) and only prompts if the server genuinely rejects
  // the session while confirmed online.
  if (_isOfflineNow()) {
    logger.info('[AuthManager] mwinit requested while OFFLINE — skipping prompt; will re-probe on reconnect');
    return Promise.resolve({ ok: false, skipped: 'offline' });
  }
  _mwinitInFlight = new Promise((resolve, reject) => {
    logger.info('[AuthManager] Spawning mwinit terminal' + (force ? ' (force -f)' : '') + '...');

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
      force ? 'mwinit -f' : 'mwinit',
      'echo.',
      'echo Auth step complete - this window will close in 3 seconds.',
      'timeout /t 3 /nobreak > nul',
      'exit',
    ].join('\r\n'));

    const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/c', batchPath], { detached: true, stdio: 'ignore', shell: false });
    child.unref();

    const started = Date.now();

    // FIX (2026-07-23): checkMwinit().ok only reflects whether the cookie
    // file, AS IT SITS ON DISK RIGHT NOW, isn't expired yet -- it has no way
    // to tell "unchanged stale file" apart from "freshly rewritten by
    // mwinit". Every caller of runMwinit() fires precisely when the old
    // file's local expiry hasn't quite hit zero but the server/AAP side has
    // already rejected it, so the very first 1.5s poll tick was seeing the
    // SAME untouched stale file, declaring victory, and re-injecting the
    // exact cookies that just got rejected -- confirmed live in
    // auth.log 2026-07-23T17:21:28 -> 17:21:31 ("31min" -> false "complete...
    // 30min" 1.5s later) vs. the real refresh landing 13 minutes later at
    // 17:34:09 ("108min") once the user actually tapped WebAuthn. Now we
    // snapshot the cookie file's mtime before spawning mwinit and require
    // BOTH state.ok AND a newer mtime (i.e. mwinit actually rewrote the
    // file) before resolving, so we wait for the real WebAuthn/PIN tap
    // instead of silently no-oping against the stale file.
    let baselineMtimeMs = 0;
    try { baselineMtimeMs = fs.statSync(COOKIE_FILE).mtimeMs; } catch (_) {}

    // Poll by re-reading the cookie file and checking actual expiry timestamps
    const poll = setInterval(() => {
      try {
        const state = checkMwinit();
        let rewritten = false;
        try { rewritten = fs.statSync(COOKIE_FILE).mtimeMs > baselineMtimeMs; } catch (_) {}
        if (state.ok && rewritten) {
          clearInterval(poll);
          logger.info('[AuthManager] mwinit complete -- cookies valid, expires in ' +
            (state.expiresInMin !== null ? state.expiresInMin + 'min' : 'session'));
          resolve();
          return;
        }
        if (Date.now() - started > MWINIT_TIMEOUT_MS) {
          clearInterval(poll);
          reject(new Error('mwinit timed out after 3 minutes -- terminal may still be waiting on WebAuthn/PIN'));
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

    // FIX (2026-08-24): the probe used to call done(false) the instant it saw
    // ANY Midway/SSO URL in will-redirect / did-navigate. But AAP's NORMAL,
    // healthy auth flow for a VALID session redirects THROUGH Midway's OIDC
    // handshake first:
    //   aap-na.../v2/page/...  ->  midway-auth.../SSO/redirect?response_type=id_token&redirect_uri=<aap>  ->  back to aap-na...
    // With good cookies that hop auto-completes in well under a second. The old
    // code killed the probe on that transient hop and reported the session
    // invalid EVEN THOUGH mwinit had just written valid cookies (observed live
    // 2026-08-24: 6 straight "will-redirect (SSO, rejecting)" on the standard
    // id_token handshake URL, one of them right after a fresh mwinit -f).
    //
    // New approach: do NOT fail on a transient SSO HANDSHAKE redirect (one that
    // carries a redirect_uri back to AAP — Midway is about to bounce us home).
    // Let the chain run and judge only by where navigation FINALLY SETTLES:
    //   - lands on AAP           -> success
    //   - settles on a Midway    -> failure (real login wall; cookies rejected)
    //     page that does NOT
    //     immediately redirect onward within the settle grace window
    // A terminal login wall stops navigating; a handshake keeps going. We use a
    // short debounce after each navigation to tell them apart.

    // An SSO URL that is just the OIDC handshake bouncing back to AAP — carries
    // redirect_uri/redirect back to the aap-na host. NOT a terminal login wall.
    const isHandshakeHop = (url) => {
      if (!isSSO(url)) return false;
      try {
        const dec = decodeURIComponent(url);
        return /redirect_uri=[^&]*aap-na\.corp\.amazon\.com/i.test(url)
            || /aap-na\.corp\.amazon\.com/i.test(dec.split('?')[1] || '');
      } catch (_) { return false; }
    };

    let settleTimer = null;
    const scheduleSettleCheck = () => {
      clearTimeout(settleTimer);
      // If navigation goes quiet for this long, whatever we're on is the final
      // landing. Handshake hops keep navigating and keep resetting this timer.
      settleTimer = setTimeout(() => {
        if (settled) return;
        const cur = probe.webContents.getURL();
        if (isAAP(cur)) { logger.info('[AuthManager] Probe settled on AAP — session OK'); done(true); }
        else if (isSSO(cur)) { logger.info('[AuthManager] Probe settled on SSO/login wall — session rejected:', cur.slice(0, 120)); done(false); }
        else { logger.info('[AuthManager] Probe settled on unknown page:', cur.slice(0, 120)); done(isAAP(cur)); }
      }, 2500);
    };

    probe.webContents.on('will-redirect', (_, url) => {
      if (isHandshakeHop(url)) { logger.info('[AuthManager] will-redirect (SSO handshake -> AAP, allowing):', url.slice(0, 120)); }
      else if (isSSO(url))     { logger.info('[AuthManager] will-redirect (SSO):', url.slice(0, 120)); }
      else                     { logger.info('[AuthManager] will-redirect (ok):', url.slice(0, 120)); }
      scheduleSettleCheck();
    });
    probe.webContents.on('did-navigate', (_, url) => { logger.info('[AuthManager] nav:', url.slice(0, 120)); if (isAAP(url)) { done(true); return; } scheduleSettleCheck(); });
    probe.webContents.on('did-navigate-in-page', (_, url) => { if (isAAP(url)) done(true); else scheduleSettleCheck(); });
    probe.webContents.on('did-finish-load', async () => {
      const url = probe.webContents.getURL();
      logger.info('[AuthManager] Probe landed:', url.slice(0, 120));
      if (isAAP(url)) { done(true); return; }
      // On an SSO URL: could be mid-handshake (will redirect onward) or a
      // terminal wall. Don't decide yet — let the settle timer arbitrate.
      scheduleSettleCheck();
    });
    probe.webContents.on('did-fail-load', (_, code, desc) => {
      if (code === -3) return; // ABORTED (navigation superseded) — not a failure
      // Network-layer errors (negative Chromium codes like -106
      // ERR_INTERNET_DISCONNECTED, -105 ERR_NAME_NOT_RESOLVED, -118
      // ERR_CONNECTION_TIMED_OUT, -21 ERR_NETWORK_CHANGED) mean the page could
      // not load at all — a connectivity problem, NOT a rejected session. Log
      // it as such; ensureAuthenticated's offline guard decides what to do.
      if (_NETWORK_ERR_CODES.has(code)) {
        logger.info('[AuthManager] Probe network error (offline/connectivity), not a session rejection:', code, desc);
      } else {
        logger.info('[AuthManager] Probe fail-load:', code, desc);
      }
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
      if (_NETWORK_ERR_CODES.has(code)) {
        logger.info('[AuthManager] Relay network error (offline/connectivity), not a session rejection:', code, desc);
      } else {
        logger.warn('[AuthManager] Relay fail-load:', code, desc);
      }
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
  let ok = await probeSession();
  if (!ok) {
    // FIX (2026-08-17): a failed page probe used to throw MIDWAY_SESSION_INVALID
    // immediately, which surfaced the interactive re-auth prompt (PIN + WebAuthn
    // tap). But the vast majority of these failures are TRANSIENT: AAP/CloudFront
    // intermittently bounces a probe to midway-auth SSO even while the Midway
    // cookie file is fully valid (~20h __Host-session/session still live). The
    // relay probe below already recovers from exactly this via a re-inject +
    // retry; the page probe had no such recovery, so every transient blip forced
    // a full manual re-auth — the ~2h "keeps asking me to re-auth" symptom.
    //
    // Recovery ladder (cheap → expensive), only escalating to mwinit if the
    // cookie file is ACTUALLY expired or retries are exhausted:
    //   1. If checkMwinit() says the file is expired, this is a real expiry →
    //      throw so the caller prompts mwinit.
    //   2. Otherwise re-inject the still-valid cookies and re-probe (up to 2x
    //      with a short backoff) — recovers transient SSO bounces silently.
    logger.warn('[AuthManager] Page probe failed — cookie file valid? re-injecting and retrying before prompting re-auth');
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      const liveState = checkMwinit();
      if (!liveState.ok) {
        // Genuinely expired — no amount of re-injecting will help.
        logger.warn('[AuthManager] Cookie file genuinely expired (' + (liveState.reason || 'unknown') + ') — escalating to mwinit');
        break;
      }
      logger.info('[AuthManager] Page probe retry ' + attempt + '/2 — cookies still valid (' +
        liveState.count + ' cookies, ' +
        (liveState.expiresInMin !== null ? liveState.expiresInMin + 'min left' : 'session') + '), re-injecting');
      try { await injectCookies(); } catch (_) {}
      await new Promise(r => setTimeout(r, 2000 * attempt));
      ok = await probeSession();
      if (ok) logger.info('[AuthManager] Page probe recovered on retry ' + attempt + ' — no re-auth needed');
    }
  }
  if (!ok) {
    // OFFLINE GUARD: a probe can only "fail" because the page didn't load. If
    // we're offline, that's a network failure, NOT a rejected session — do not
    // escalate to the invalid-session error (which would prompt re-auth).
    // Signal a transient network condition the caller can treat as "retry
    // later / stay on cached data" instead of a real auth failure.
    if (_isOfflineNow()) {
      logger.info('[AuthManager] Page probe failed but OFFLINE — treating as network error, not session rejection');
      send('fleet:status', '\uD83D\uDCE1 Offline — will re-verify Midway session when connection returns');
      throw Object.assign(new Error('Offline — cannot verify Midway session'), { code: 'NETWORK_OFFLINE' });
    }
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
    // OFFLINE GUARD (same rationale as the page probe above): a relay probe
    // failure while offline is a network error, not a rejected session.
    if (_isOfflineNow()) {
      logger.info('[AuthManager] Relay probe failed but OFFLINE — treating as network error, not session rejection');
      send('fleet:status', '\uD83D\uDCE1 Offline — will re-verify relay session when connection returns');
      throw Object.assign(new Error('Offline — cannot verify relay session'), { code: 'NETWORK_OFFLINE' });
    }
    const msg = 'AAP relay rejected session — run mwinit -f then retry';
    send('fleet:error', msg);
    throw Object.assign(new Error(msg), { code: 'RELAY_SESSION_INVALID' });
  }

  logger.info('[AuthManager] Session confirmed (page + relay probes passed)');
  return true;
}

// ── Silent AEA refresh (NO WebAuthn tap) ─────────────────────────────────────
// ROOT CAUSE of "a single auth doesn't last 20h" (confirmed from the live
// cookie file 2026-09-30):
//   __Host-session / session / tpm_metrics  -> ~24h  (the real session)
//   amazon_enterprise_access (AEA, x4)       -> ~6h   (short-lived access token)
// AAP enforces AEA server-side: the moment AEA lapses (~6h), AAP bounces every
// request to Midway SSO — so the effective session was capped at ~6h, forcing a
// re-auth long before the 24h session cookie expires.
//
// THE KEY: AEA can be re-minted SILENTLY. While the __Host-session cookie is
// still valid, navigating to AAP triggers Midway's OIDC handshake
// (aap -> midway-auth/SSO/redirect?...redirect_uri=aap -> back to aap) which
// completes WITHOUT any WebAuthn/PIN prompt and issues a fresh AEA into the
// Electron session. probeSession() already performs exactly this handshake and
// returns true when it lands back on AAP. So a proactive probeSession() run,
// followed by a cookie re-inject, refreshes AEA with NO tap — letting a single
// mwinit auth actually last the full ~24h session, refreshing AEA in the
// background every time it nears expiry.
//
// Returns { ok, refreshed } — ok=true means the silent handshake landed on AAP
// (session still valid, AEA refreshed). ok=false means the session itself is
// gone and a real mwinit is required.
// Read the live AEA (amazon_enterprise_access) expiry FROM THE ELECTRON SESSION
// cookie store (not the stale ~/.midway/cookie disk file). After a silent
// handshake, AAP issues a fresh AEA into defaultSession — that is the real
// source of truth for whether AEA is actually valid right now. Returns minutes
// until the soonest live AEA expires, or null if none present.
async function aeaSessionExpiryMin() {
  try {
    const all = await electronSession.defaultSession.cookies.get({ name: 'amazon_enterprise_access' });
    if (!all || !all.length) return null;
    const now = Math.floor(Date.now() / 1000);
    const soonest = all.reduce((min, c) => (c.expirationDate ? Math.min(min, c.expirationDate) : min), Infinity);
    if (soonest === Infinity) return null;
    return Math.round((soonest - now) / 60);
  } catch (_) { return null; }
}

async function refreshAeaSilently() {
  try {
    // 1) Make sure the freshest cookies from disk are in the Electron session.
    try { await injectCookies(); } catch (_) {}
    // 2) Run the silent SSO handshake. If the session cookie is valid this
    //    lands on AAP with a fresh AEA and NO prompt. If the session is truly
    //    expired it settles on a login wall and returns false.
    const landed = await probeSession();
    if (!landed) {
      logger.warn('[AuthManager] Silent AEA refresh: handshake did not land on AAP — session likely expired, real mwinit needed');
      return { ok: false, refreshed: false };
    }
    // 3) Re-inject so any refreshed cookies (incl. a new AEA) are consistent.
    try { await injectCookies(); } catch (_) {}
    // 4) VERIFY against the live session cookie store (truth), not the disk
    //    file. The handshake writes the fresh AEA into defaultSession; the disk
    //    file keeps the old expired AEA, so only this check proves it worked.
    const liveAea = await aeaSessionExpiryMin();
    logger.info('[AuthManager] Silent AEA refresh OK — AAP handshake completed with no prompt (live AEA expiry: ' + (liveAea === null ? 'unknown' : liveAea + 'min') + ')');
    return { ok: true, refreshed: true, aeaMin: liveAea };
  } catch (e) {
    logger.warn('[AuthManager] Silent AEA refresh error: ' + e.message);
    return { ok: false, refreshed: false };
  }
}

// ── Reconnect watcher (re-probe the SAME session when internet returns) ───────
// Subscribes to the offline module's online/offline transitions. When the
// machine comes back ONLINE, re-verify the existing on-disk cookies ONCE
// (silently, via refreshAeaSilently — re-inject + SSO handshake, no prompt).
//   - If that lands on AAP: the session was fine all along; do nothing. This is
//     the common case after a brief drop/VPN flap and means NO re-auth prompt.
//   - If it fails while we are CONFIRMED ONLINE: the server genuinely rejected
//     the session, so auto-prompt mwinit (per the user's choice). runMwinit is
//     itself offline-gated, but we're online here so it proceeds.
// Idempotent; a second call replaces the prior subscription.
let _reauthUnsub = null;
let _reauthInFlight = false;
function startOnlineReauthWatch() {
  let offline;
  try { offline = require('../orcha/offline'); } catch (_) { return () => {}; }
  if (_reauthUnsub) { try { _reauthUnsub(); } catch (_) {} _reauthUnsub = null; }
  _reauthUnsub = offline.onChange(async (status) => {
    if (status !== 'online') return;
    if (_reauthInFlight) return;
    _reauthInFlight = true;
    try {
      // Settle briefly so DNS/routing is actually ready before we probe.
      await new Promise((r) => setTimeout(r, 2500));
      if (_isOfflineNow()) return; // flapped back offline — bail, wait for next 'online'
      logger.info('[AuthManager] Back online — re-verifying existing Midway session (no prompt unless rejected)');
      const res = await refreshAeaSilently();
      if (res && res.ok) {
        logger.info('[AuthManager] Reconnect re-verify OK — session still valid, no re-auth needed');
        return;
      }
      // Confirmed online + session did NOT re-verify → genuine rejection.
      if (_isOfflineNow()) return; // dropped again mid-check; don't prompt
      logger.warn('[AuthManager] Reconnect re-verify failed while online — session genuinely rejected, prompting mwinit');
      try { await runMwinit(); } catch (e) { logger.warn('[AuthManager] Reconnect mwinit failed: ' + e.message); }
    } catch (e) {
      logger.warn('[AuthManager] Reconnect re-verify error: ' + e.message);
    } finally {
      _reauthInFlight = false;
    }
  });
  logger.info('[AuthManager] Online-reconnect re-auth watch started');
  return _reauthUnsub;
}

module.exports = {
  checkMwinit,
  runMwinit,
  injectCookies, // FEATURE (2026-07-23): now accepts optional target session
  probeSession, // FIX (2026-07-21): exported so callers can replicate ensureAuthenticated's verification steps without its disabled auto-spawn branch
  refreshAeaSilently, // FIX (2026-09-30): silent AEA re-mint so one auth lasts the full ~24h session
  aeaSessionExpiryMin, // FIX (2026-10-10): read live AEA expiry from the Electron session (truth), not the stale disk file
  ensureAuthenticated,
  pingRelayEndpoint,
  startOnlineReauthWatch, // FIX (2026-10): re-probe same session on reconnect; prompt only on confirmed-online rejection
  COOKIE_FILE,
};
