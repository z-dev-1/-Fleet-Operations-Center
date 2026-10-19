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

  // SESSION VALIDITY IS DEFINED BY THE REAL SESSION CREDENTIAL, NOT "any cookie".
  // FIX: the old check treated the session as alive if ANY non-expired Midway
  // cookie remained — but `user_name` lives ~1 year, so the app could report
  // ok=true for ~a year after the actual session (__Host-session / session,
  // ~20h) had expired. Validity must be keyed to __Host-session / session
  // specifically. parseMidwayCookies() already drops expired cookies, so if the
  // real session credential isn't in `cookies`, it has expired → NOT ok.
  const now = Math.floor(Date.now() / 1000);
  const SESSION_NAMES = new Set(['session', '__Host-session']);
  const sessionCred = cookies.filter(c =>
    SESSION_NAMES.has(c.name) &&
    /midway-auth\.amazon\.com$/i.test(String(c.domain || '').replace(/^\./, '')) &&
    c.expirationDate && c.expirationDate > now);

  if (sessionCred.length === 0) {
    // The real Midway session credential is gone/expired, even if long-lived
    // cookies like user_name are still present. This is a genuine re-auth case.
    const names = expired.map(c => c.name).join(', ');
    const reason = names
      ? 'Midway session cookie (__Host-session/session) expired or missing (expired: ' + names + ') — run mwinit'
      : 'Midway session cookie (__Host-session/session) expired or missing — run mwinit';
    return { ok: false, reason, expired };
  }
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
  // RENEWAL CLOCK = the real session credential's expiry, nothing else.
  // Using sessionCred (the live __Host-session/session cookies computed above)
  // means short-lived tokens (amazon_enterprise_access) AND long-lived ones
  // (user_name ~1yr, sshkeysigner amzn_sso_* ~min) can never skew the clock —
  // the earlier bug where an unrelated near-expiry cookie made this read
  // "0 min / 1 min left" while the session had ~20h.
  const SHORT_LIVED_NAMES = new Set(['amazon_enterprise_access']);
  const soonest = sessionCred.reduce((min, c) => Math.min(min, c.expirationDate), Infinity);
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
// opts.skipAea (default false): when true, do NOT inject amazon_enterprise_access
// from disk. The disk AEA is the SHORT-LIVED token captured at mwinit time and
// is usually STALE; after a silent OIDC handshake the LIVE Electron cookie store
// holds a FRESH AEA. Re-injecting the disk AEA on top of that would overwrite
// the fresh live token with the stale one — the exact bug that made the silent
// refresh "succeed" yet leave AEA expired. So the post-handshake re-inject uses
// skipAea:true to preserve the freshly-minted live AEA while still refreshing the
// long-lived session cookies.
async function injectCookies(targetSession, opts) {
  const ses             = targetSession || electronSession.defaultSession;
  const skipAea         = !!(opts && opts.skipAea);
  const { cookies }     = parseMidwayCookies();
  let injected = 0, failed = 0, skippedAea = 0;

  for (const c of cookies) {
    if (skipAea && c.name === 'amazon_enterprise_access') { skippedAea++; continue; }
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
  logger.info('[AuthManager] Injected:', injected, ' Skipped:', failed +
    (skipAea ? ' (AEA preserved: ' + skippedAea + ' live-token not overwritten)' : ''));
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

// Read the soonest AEA (amazon_enterprise_access) expiry FROM THE COOKIE FILE,
// in minutes, or null when no live AEA cookie is on disk. Used to detect the
// "session valid but AEA missing/lapsed" state and to verify a refresh landed.
function aeaFileExpiryMin() {
  try {
    const { cookies } = parseMidwayCookies();
    const now = Math.floor(Date.now() / 1000);
    const aea = cookies.filter(c => c.name === 'amazon_enterprise_access' && c.expirationDate);
    if (!aea.length) return null;
    const soonest = aea.reduce((min, c) => Math.min(min, c.expirationDate), Infinity);
    return soonest === Infinity ? null : Math.round((soonest - now) / 60);
  } catch (_) { return null; }
}

// ── Refresh ONLY the AEA posture cookie via `mwinit --refresh-aea` ──────────────
// The missing middle rung of the recovery ladder. AEA (amazon_enterprise_access)
// is a short-lived (~6h) posture cookie AAP enforces server-side; when it lapses
// the long-lived Midway session is still valid, so a FULL interactive mwinit
// (PIN + WebAuthn tap) is overkill. `mwinit --refresh-aea` re-mints just the AEA
// cookie into ~/.midway/cookie, reusing the live session — usually with NO tap.
// This is exactly the command that fixes the "AAP session expired, cookie file
// has session but no AEA" state (confirmed live 2026-10-17). Returns
// { ok, aeaMin } — ok=true means a live AEA cookie is now on disk.
let _aeaRefreshInFlight = null;
function refreshAeaViaMwinit() {
  if (_aeaRefreshInFlight) return _aeaRefreshInFlight;
  if (_isOfflineNow()) return Promise.resolve({ ok: false, skipped: 'offline' });
  _aeaRefreshInFlight = new Promise((resolve) => {
    logger.info('[AuthManager] Spawning mwinit --refresh-aea (AEA posture refresh, no full re-auth)...');
    // Run mwinit DIRECTLY with piped stdio so we can READ its output. This is
    // the critical fix: `mwinit --refresh-aea` is non-interactive, but when the
    // underlying Midway SESSION is no longer valid it prints
    //   "Not refreshing AEA cookie because Midway cookie file does not contain
    //    a valid Midway session"
    // and writes NO AEA cookie. The old detached-batch spawn used stdio:'ignore'
    // and only polled the cookie file, so it never learned WHY nothing landed —
    // it just timed out and the caller retried the (hopeless) silent handshake.
    // Now we detect that message and return sessionInvalid:true so the recovery
    // ladder stops the silent loop and surfaces a full-re-auth (YubiKey) prompt.
    let child;
    try {
      child = spawn('mwinit', ['--refresh-aea'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      _aeaRefreshInFlight = null;
      resolve({ ok: false, error: 'spawn:' + e.message });
      return;
    }
    let outBuf = '';
    try {
      child.stdout.on('data', (d) => { outBuf += d.toString(); });
      child.stderr.on('data', (d) => { outBuf += d.toString(); });
    } catch (_) { /* stdio may be unavailable in some envs */ }

    const started = Date.now();
    const AEA_REFRESH_TIMEOUT_MS = 90 * 1000;
    let baselineMtimeMs = 0;
    try { baselineMtimeMs = fs.statSync(COOKIE_FILE).mtimeMs; } catch (_) {}
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { clearInterval(poll); } catch (_) {} try { clearTimeout(killTimer); } catch (_) {} resolve(v); };

    // Detect the "session invalid" message the instant mwinit prints it.
    const SESSION_INVALID_RE = /does not contain a valid Midway session|no valid Midway session|not refreshing AEA/i;
    child.on('exit', () => {
      // On exit, decide from the cookie file + the captured message.
      const aeaMin = aeaFileExpiryMin();
      if (aeaMin != null && aeaMin > 0) {
        logger.info('[AuthManager] mwinit --refresh-aea complete — AEA now ' + aeaMin + 'min');
        finish({ ok: true, aeaMin });
        return;
      }
      if (SESSION_INVALID_RE.test(outBuf)) {
        logger.warn('[AuthManager] mwinit --refresh-aea reports the Midway SESSION is invalid — AEA cannot be minted. A full `mwinit` (YubiKey tap) is required.');
        finish({ ok: false, sessionInvalid: true, aeaMin: null, mwinitMessage: outBuf.trim().slice(0, 300) });
        return;
      }
      logger.warn('[AuthManager] mwinit --refresh-aea produced no AEA cookie: ' + (outBuf.trim().slice(0, 200) || '(no output)'));
      finish({ ok: false, aeaMin: aeaFileExpiryMin(), mwinitMessage: outBuf.trim().slice(0, 300) });
    });
    child.on('error', (e) => finish({ ok: false, error: 'proc:' + e.message }));

    // Safety: bound it (should exit well under this). If mwinit ever blocks on
    // a prompt (it shouldn't for --refresh-aea), kill it so we never hang.
    const killTimer = setTimeout(() => { try { child.kill(); } catch (_) {} }, AEA_REFRESH_TIMEOUT_MS);
    if (killTimer.unref) killTimer.unref();

    // Also poll the cookie file as a secondary success signal (in case exit is
    // delayed on some platforms), but the exit handler is the primary path.
    const poll = setInterval(() => {
      try {
        let rewritten = false;
        try { rewritten = fs.statSync(COOKIE_FILE).mtimeMs > baselineMtimeMs; } catch (_) {}
        const aeaMin = aeaFileExpiryMin();
        if (rewritten && aeaMin != null && aeaMin > 0) { logger.info('[AuthManager] mwinit --refresh-aea complete — AEA now ' + aeaMin + 'min'); finish({ ok: true, aeaMin }); return; }
        if (Date.now() - started > AEA_REFRESH_TIMEOUT_MS) { finish({ ok: false, aeaMin: aeaFileExpiryMin(), mwinitMessage: outBuf.trim().slice(0, 300) }); }
      } catch (_) { /* transient FS error while file is written */ }
    }, 1500);
  });
  _aeaRefreshInFlight.finally(() => { _aeaRefreshInFlight = null; });
  return _aeaRefreshInFlight;
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

// How many times the silent handshake is attempted before we conclude the
// session is genuinely rejected. A single failed probe is often a transient
// SSO bounce / slow redirect, not a dead session — retrying (with a re-inject
// + short backoff) rescues those WITHOUT ever prompting the user. Only a
// consistent failure across all attempts escalates.
const AEA_SILENT_RETRIES = 3;

async function refreshAeaSilently() {
  const before = await aeaSessionExpiryMin();
  let lastErr = '';
  for (let attempt = 1; attempt <= AEA_SILENT_RETRIES; attempt++) {
    try {
      // 1) Push the freshest cookies from disk into the Electron session.
      try { await injectCookies(); } catch (_) {}
      // 2) Run the silent SSO handshake. If the session cookie is valid this
      //    lands on AAP with a fresh AEA and NO prompt. If the session is truly
      //    expired it settles on a login wall and returns false.
      const landed = await probeSession();
      if (landed) {
        // 3) Re-inject the LONG-LIVED session cookies for consistency, but
        //    skipAea:true so we DO NOT overwrite the fresh AEA the handshake
        //    just minted into the live Electron store with the stale disk AEA.
        //    (This was the bug: the old unconditional re-inject clobbered the
        //    new live AEA, so the refresh logged ok=true while AEA stayed stale.)
        try { await injectCookies(undefined, { skipAea: true }); } catch (_) {}
        // 4) VERIFY against the LIVE session cookie store (truth), not the disk
        //    file. The handshake writes the fresh AEA into defaultSession; the
        //    disk file keeps the old expired AEA, so only this proves it worked.
        const after = await aeaSessionExpiryMin();
        // Treat it as a real success only if the live AEA is actually present
        // and not already expired. A landed probe with no live AEA means the
        // handshake didn't truly mint one (posture gate) — report that honestly
        // instead of a false ok=true.
        const aeaOk = after !== null && after > 0;
        logger.info('[AuthManager] AEA refresh OUTCOME: ok=' + aeaOk + ' refreshed=' + aeaOk + ' attempt=' + attempt + '/' + AEA_SILENT_RETRIES +
          ' aeaBefore=' + (before === null ? 'none' : before + 'min') +
          ' aeaAfter=' + (after === null ? 'none' : after + 'min') + ' (no prompt)');
        if (aeaOk) return { ok: true, refreshed: true, aeaMin: after, attempts: attempt };
        lastErr = 'handshake landed but no fresh live AEA minted (posture?)';
        logger.warn('[AuthManager] Silent AEA refresh attempt ' + attempt + '/' + AEA_SILENT_RETRIES + ' landed but AEA still ' + (after === null ? 'missing' : after + 'min') + (attempt < AEA_SILENT_RETRIES ? ' — retrying' : ''));
      } else {
        lastErr = 'handshake did not land on AAP';
        logger.warn('[AuthManager] Silent AEA refresh attempt ' + attempt + '/' + AEA_SILENT_RETRIES + ' did not land on AAP' + (attempt < AEA_SILENT_RETRIES ? ' — retrying' : ''));
      }
    } catch (e) {
      lastErr = e.message;
      logger.warn('[AuthManager] Silent AEA refresh attempt ' + attempt + '/' + AEA_SILENT_RETRIES + ' error: ' + e.message);
    }
    // Don't hammer: short backoff before the next attempt. Bail early if the
    // machine went offline mid-retry (a dead network can't be fixed by retrying
    // and must not be mistaken for a rejected session).
    if (attempt < AEA_SILENT_RETRIES) {
      if (_isOfflineNow()) { lastErr = 'offline mid-retry'; break; }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const after = await aeaSessionExpiryMin();
  logger.warn('[AuthManager] AEA refresh OUTCOME: ok=false refreshed=false attempts=' + AEA_SILENT_RETRIES +
    ' aeaBefore=' + (before === null ? 'none' : before + 'min') +
    ' aeaAfter=' + (after === null ? 'none' : after + 'min') +
    ' why="' + (lastErr || 'unknown') + '" — session likely expired, real mwinit may be needed');
  return { ok: false, refreshed: false, aeaMin: after, why: lastErr };
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
      // Confirmed online + session did NOT re-verify → climb the full ladder
      // (VPN rung, then silent again, then mwinit as last resort) instead of a
      // bare prompt. recoverAuth is defined below in this module.
      if (_isOfflineNow()) return; // dropped again mid-check; don't prompt
      logger.warn('[AuthManager] Reconnect re-verify failed while online — escalating via recovery ladder');
      try { await recoverAuth('reconnect:reverify-failed'); } catch (e) { logger.warn('[AuthManager] Reconnect recovery failed: ' + e.message); }
    } catch (e) {
      logger.warn('[AuthManager] Reconnect re-verify error: ' + e.message);
    } finally {
      _reauthInFlight = false;
    }
  });
  logger.info('[AuthManager] Online-reconnect re-auth watch started');
  return _reauthUnsub;
}

// ── AEA posture-agent self-heal (Windows) ────────────────────────────────────
// ROOT CAUSE (observed 2026-10-18): AAP kept rejecting the session even with a
// valid Midway session, VPN up, and AAP reachable — because the Amazon
// Enterprise Access posture agent (EnterpriseAccessConsoleApp.exe) had THREE
// stuck instances all timing out when queried for the AEA JWT
// ("AEA get_aea_jwt timed out after 2 seconds / AEA JSON is empty"). No amount
// of silent-refresh / mwinit --refresh-aea helps, because every rung queries
// the SAME hung agent. The manual fix was: kill the duplicate
// EnterpriseAccessConsoleApp.exe processes + restart the itacsvc service, after
// which the agent produced a valid JWT ({"Status":"Success"}).
//
// This automates that fix so the app self-heals without the user ever touching
// Task Manager. Windows-only (the agent only exists there); a no-op elsewhere.
// Returns true if it attempted a restart (caller then re-probes).
let _aeaAgentRestartInFlight = false;
let _lastAeaAgentRestartAt = 0;
// Separate attempt / verified timestamps (spec #11) — a restart attempt that
// did not verify must not be treated as a successful restart.
let _lastAeaAgentRestartAttemptAt = 0;
let _lastAeaAgentRestartVerifiedAt = 0;
async function restartAeaAgent() {
  if (process.platform !== 'win32') return false;         // agent is Windows-only
  if (_aeaAgentRestartInFlight) return false;             // don't stack restarts
  // Rate-limit: at most once per 2 min, so a flapping agent can't get into a
  // kill/respawn loop that itself starves the posture query.
  if (Date.now() - _lastAeaAgentRestartAt < 120000) {
    logger.info('[AuthManager] AEA agent restart skipped — restarted <2min ago');
    return false;
  }
  _aeaAgentRestartInFlight = true;
  _lastAeaAgentRestartAt = Date.now();
  logger.warn('[AuthManager] AEA posture agent appears stuck — restarting EnterpriseAccessConsoleApp + itacsvc (self-heal)');
  try {
    const { spawn } = require('child_process');
    // Kill ALL EnterpriseAccessConsoleApp.exe instances (duplicates are the bug),
    // then nudge the itacsvc service to respawn a single clean agent. Use
    // taskkill/powershell via cmd so it works without extra deps. Best-effort:
    // each step is independent and failures are logged, not fatal.
    const run = (cmd) => new Promise((resolve) => {
      try {
        const c = spawn('cmd.exe', ['/c', cmd], { windowsHide: true, stdio: 'ignore' });
        const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(false); }, 15000);
        c.on('exit', () => { clearTimeout(t); resolve(true); });
        c.on('error', () => { clearTimeout(t); resolve(false); });
      } catch (_) { resolve(false); }
    });
    await run('taskkill /F /IM EnterpriseAccessConsoleApp.exe /T');
    // Restart the host service so a fresh single agent comes up. net stop/start
    // may need elevation; if it can't, the killed agent is typically auto-
    // respawned by the service anyway, so this is a best-effort nudge.
    await run('net stop itacsvc & net start itacsvc');

    // SPEC #11: do NOT trust "taskkill returned" as success. VERIFY the agent
    // actually became healthy — i.e. the duplicate/hung condition is resolved
    // (no more than one EnterpriseAccessConsoleApp.exe running) — by polling
    // `tasklist` until it is responsive OR a bounded timeout. Track the attempt
    // vs the VERIFIED outcome separately so a failed restart never masquerades
    // as a successful one (and never starts a cooldown as if it worked).
    _lastAeaAgentRestartAttemptAt = Date.now();
    const procCount = () => new Promise((resolve) => {
      try {
        const c = spawn('cmd.exe', ['/c', 'tasklist /FI "IMAGENAME eq EnterpriseAccessConsoleApp.exe" /NH'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', (d) => { out += d.toString(); });
        const t = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(null); }, 5000);
        c.on('exit', () => { clearTimeout(t); const m = out.match(/EnterpriseAccessConsoleApp\.exe/gi); resolve(m ? m.length : 0); });
        c.on('error', () => { clearTimeout(t); resolve(null); });
      } catch (_) { resolve(null); }
    });
    // Poll for readiness: a single (or zero, about to respawn) clean instance,
    // up to ~15s. "Responsive" = not the duplicate/hung multi-instance state.
    let verified = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const n = await procCount();
      // null = couldn't query (tasklist unavailable) -> fall back to a single
      // settle wait and treat as attempted-but-unverified.
      if (n === null) { await new Promise((r) => setTimeout(r, 4000)); break; }
      if (n <= 1) { verified = true; break; }   // duplicate condition resolved
      logger.info('[AuthManager] AEA agent still shows ' + n + ' instances — waiting for the duplicate/hung condition to clear');
    }
    if (verified) {
      _lastAeaAgentRestartVerifiedAt = Date.now();
      logger.info('[AuthManager] AEA agent restart VERIFIED — single clean agent; posture JWT should mint now');
    } else {
      logger.warn('[AuthManager] AEA agent restart attempted but NOT verified responsive within budget');
    }
    // Return whether the restart was VERIFIED (not merely attempted). The caller
    // (recoverAuth) retries the silent refresh regardless, but a true here means
    // the agent is genuinely healthy; a false lets the ladder escalate without
    // falsely cooling down on an unverified restart (spec #12).
    return verified;
  } catch (e) {
    logger.warn('[AuthManager] AEA agent restart error: ' + e.message);
    return false;
  } finally {
    _aeaAgentRestartInFlight = false;
  }
}

// ── Centralized recovery ladder ───────────────────────────────────────────────
// ONE place every "auth looks broken, what now?" decision routes through, so
// the escalation policy isn't re-implemented (and divergent) across the 5+
// callers (heartbeat, SSO-loop poller, reconnect watcher, rescan recovery, IPC
// buttons). The ladder climbs from cheapest/least-intrusive to the only
// user-interrupting rung, and STOPS at the first rung that recovers:
//
//   1. OFFLINE?        -> raw internet down (net.isOnline). Can't auth against a
//                         dead network; a failure here is NOT a rejected session.
//                         Return without prompting; the reconnect watcher retries.
//   2. VPN DOWN?       -> corp resources need the tunnel. ensureVpn (non-blocking
//                         reconnect) then re-probe. Still no prompt.
//   3. SESSION VALID + probe failing -> the common case: the ~24h __Host-session
//                         is fine but AEA lapsed, so AAP bounced us. refreshAeaSilently
//                         (now retried internally) re-mints AEA with NO tap. Re-probe.
//   4. LAST RESORT     -> session cookie genuinely expired on disk, OR the silent
//                         refresh is exhausted while confirmed online. ONLY NOW
//                         prompt mwinit (deduped via runMwinit's _mwinitInFlight).
//
// Returns { recovered, rung, prompted, reason } so callers can log/branch.
// opts.allowPrompt (default true) lets a caller run the whole ladder but STOP
// before the interactive rung (e.g. a background pass that must never prompt).
async function recoverAuth(reason, opts) {
  opts = opts || {};
  const allowPrompt = opts.allowPrompt !== false;
  const label = reason || 'unspecified';
  logger.info('[AuthManager] recoverAuth START (reason=' + label + ', allowPrompt=' + allowPrompt + ')');

  // Rung 1 — offline. A dead network is not a rejected session.
  if (_isOfflineNow()) {
    logger.info('[AuthManager] recoverAuth rung=offline — no internet; deferring (no prompt). Reconnect watcher will retry.');
    return { recovered: false, rung: 'offline', prompted: false, reason: label };
  }

  // Rung 2 — VPN down. Kick a non-blocking reconnect, then re-probe once.
  try {
    const { checkVpnState, ensureVpn } = require('../utils/vpn');
    const vpn = await checkVpnState();
    if (vpn && !vpn.connected && vpn.status !== 'not-installed') {
      logger.info('[AuthManager] recoverAuth rung=vpn — tunnel ' + vpn.status + '; reconnecting then re-probing (no prompt)');
      try { await ensureVpn(logger.info); } catch (_) {}
      if (await probeSession()) {
        logger.info('[AuthManager] recoverAuth recovered at rung=vpn — session OK once tunnel was up');
        return { recovered: true, rung: 'vpn', prompted: false, reason: label };
      }
    }
  } catch (_) { /* vpn module unavailable — skip this rung */ }

  // Rung 3 — session cookie valid but probe failing => AEA lapsed. Silent re-mint.
  const state = checkMwinit();
  if (state.ok) {
    logger.info('[AuthManager] recoverAuth rung=silent — session cookie valid (expires ' + (state.expiresInMin === null ? 'session' : state.expiresInMin + 'min') + '); attempting silent AEA refresh (no prompt)');
    const r = await refreshAeaSilently();
    if (r && r.ok) {
      logger.info('[AuthManager] recoverAuth recovered at rung=silent — AEA re-minted with no prompt');
      return { recovered: true, rung: 'silent', prompted: false, reason: label };
    }
    // Silent refresh exhausted. If we somehow dropped offline during it, defer.
    if (_isOfflineNow()) {
      logger.info('[AuthManager] recoverAuth — went offline during silent refresh; deferring (no prompt)');
      return { recovered: false, rung: 'offline', prompted: false, reason: label };
    }

    // Rung 3.25 — AEA-ONLY re-mint via `mwinit --refresh-aea` (no WebAuthn tap).
    // Cheaper than restarting the posture agent; the proven middle rung that
    // re-mints JUST the AEA cookie when the session is valid but AEA lapsed.
    // It now reports sessionInvalid when mwinit itself says the session is gone
    // — in that case silent/agent repair cannot help, so jump to the prompt.
    try {
      const rA = await refreshAeaViaMwinit();
      if (rA && rA.ok) {
        try { await injectCookies(undefined, { skipAea: true }); } catch (_) {}
        logger.info('[AuthManager] recoverAuth recovered at rung=aea-mwinit — AEA re-minted (no tap)');
        return { recovered: true, rung: 'aea-mwinit', prompted: false, reason: label };
      }
      if (rA && rA.sessionInvalid) {
        logger.warn('[AuthManager] recoverAuth — mwinit --refresh-aea reports session invalid; AEA repair cannot help, escalating to interactive mwinit');
        // Skip the agent rung (it cannot fix a dead session) and fall straight
        // through to the interactive mwinit rung below.
      } else {
        // Rung 3.5 — AEA AGENT SELF-HEAL. Session cookie is valid + online + VPN up,
    // yet the silent AEA re-mint failed. The dominant cause (confirmed 2026-10)
    // is a STUCK Enterprise Access posture agent (duplicate/hung
    // EnterpriseAccessConsoleApp.exe instances timing out the posture query).
    // Restart the agent automatically and retry the silent refresh ONCE — this
    // is the app doing, on its own, what previously required manually killing
    // the processes. Only if THIS still fails do we fall through to the
    // interactive mwinit prompt. Windows-only; a no-op (returns false) elsewhere.
    // restartAeaAgent now returns true only when the restart was VERIFIED
    // (duplicate/hung condition resolved). But even an UNVERIFIED attempt may
    // have helped, so retry the silent refresh whenever a restart was attempted
    // (not skipped by the rate-limit) — the silent refresh + real-target verify
    // is the actual proof of recovery, not the restart itself (spec #11/#12).
    const verifiedRestart = await restartAeaAgent();
    const attemptedRestart = verifiedRestart || (Date.now() - _lastAeaAgentRestartAttemptAt < 30000);
    if (attemptedRestart) {
      logger.info('[AuthManager] recoverAuth rung=aea-agent — agent restart ' + (verifiedRestart ? 'VERIFIED' : 'attempted (unverified)') + '; retrying silent AEA refresh');
      const r2 = await refreshAeaSilently();
      if (r2 && r2.ok) {
        logger.info('[AuthManager] recoverAuth recovered at rung=aea-agent — posture agent self-healed, AEA re-minted, no prompt');
        return { recovered: true, rung: 'aea-agent', prompted: false, reason: label };
      }
      logger.warn('[AuthManager] recoverAuth — silent refresh still failing after AEA agent restart; escalating');
      }
      } // end: AEA-mwinit did not short-circuit to prompt (agent rung ran)
    } catch (_) { /* AEA-only rung unavailable — fall through to prompt */ }
  } else {
    logger.warn('[AuthManager] recoverAuth — on-disk session cookie genuinely expired (' + (state.reason || 'expired') + ')');
  }

  // Rung 4 — last resort: prompt mwinit (deduped). Only reached when online, and
  // either the disk session is truly expired OR the silent refresh is exhausted.
  if (!allowPrompt) {
    logger.info('[AuthManager] recoverAuth — recovery exhausted but allowPrompt=false; NOT prompting (caller will handle)');
    return { recovered: false, rung: 'needs-prompt', prompted: false, reason: label };
  }
  logger.warn('[AuthManager] recoverAuth rung=mwinit — escalating to interactive mwinit (reason=' + label + ')');
  try {
    await runMwinit();
    try { await injectCookies(); } catch (_) {}
    logger.info('[AuthManager] recoverAuth recovered at rung=mwinit — re-auth completed');
    return { recovered: true, rung: 'mwinit', prompted: true, reason: label };
  } catch (e) {
    logger.warn('[AuthManager] recoverAuth mwinit failed: ' + e.message);
    return { recovered: false, rung: 'mwinit', prompted: true, reason: label, error: e.message };
  }
}

module.exports = {
  checkMwinit,
  parseMidwayCookies, // Stage 10: browser_provider seeds a headless Playwright context from the same parsed cookies
  runMwinit,
  recoverAuth, // FIX (2026-10): single centralized recovery ladder every caller routes through
  restartAeaAgent, // FIX (2026-10-18): self-heal a stuck Enterprise Access posture agent (duplicate/hung EnterpriseAccessConsoleApp.exe) so AAP recovers with no manual Task Manager step
  injectCookies, // FEATURE (2026-07-23): now accepts optional target session
  probeSession, // FIX (2026-07-21): exported so callers can replicate ensureAuthenticated's verification steps without its disabled auto-spawn branch
  refreshAeaSilently, // FIX (2026-09-30): silent AEA re-mint so one auth lasts the full ~24h session
  refreshAeaViaMwinit, // FIX (2026-10-17): middle recovery rung — `mwinit --refresh-aea` re-mints just the AEA posture cookie (no full re-auth) when session is valid but AEA lapsed
  aeaFileExpiryMin, // FIX (2026-10-17): soonest AEA expiry from the cookie FILE (to detect session-valid-but-AEA-missing)
  aeaSessionExpiryMin, // FIX (2026-10-10): read live AEA expiry from the Electron session (truth), not the stale disk file
  ensureAuthenticated,
  pingRelayEndpoint,
  startOnlineReauthWatch, // FIX (2026-10): re-probe same session on reconnect; prompt only on confirmed-online rejection
  COOKIE_FILE,
};
