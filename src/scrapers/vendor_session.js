'use strict';
/**
 * scrapers/vendor_session.js — Silent vendor-portal session pre-warm.
 *
 * Keeps a vendor portal logged in IN THE BACKGROUND so that by the time the
 * user needs it (e.g. clicks "Split View" for DTNA), the session is already
 * warm. Mirrors the proven credentials:test-login flow (src/ipc/credentials.js)
 * — same hidden-redirect-chain debounced auto-login the live scraper uses — but
 * with a HIDDEN window that auto-destroys when settled, so it never steals
 * focus or shows UI.
 *
 * Primary use: DTNA (Daimler Truck CIAM / Azure B2C), whose session expires
 * ~daily. A morning pre-warm + an on-demand warm cover the two cases where the
 * user otherwise lands on a login screen.
 *
 * warmVendorSession(vendorId) -> { ok, loggedIn, attempted }
 *   loggedIn  : settled on the real vendor site (not a login/SSO host)
 *   attempted : auto-login actually filled+submitted at least once
 * Concurrency-guarded per vendor so overlapping triggers don't open two windows.
 */

const { BrowserWindow } = require('electron');
const logger = require('../utils/logger').createLogger('vendor-session');

const _inFlight = new Map(); // vendorId -> Promise (dedupe concurrent warms)

// Hosts that mean "still on a login/SSO page" (NOT the real vendor site).
const _LOGIN_HOSTS_RE = /(ciam\.daimlertruck\.com|ciam\.dtna\.com|login\.dtna\.com|login\.microsoftonline|b2clogin\.com|midway-auth\.amazon\.com|\/SSO\/)/i;

function _wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Core: open a hidden window to the vendor entry URL in its partition, run the
// same debounced auto-login pass as test-login, auto-close when settled.
async function _warm(vendorId, opts) {
  opts = opts || {};
  // DTNA's two-step CIAM login (user id -> continue -> password -> continue ->
  // post-submit redirect through frontdoor.jsp) can take ~20s end to end, so
  // give the warm a generous ceiling.
  const timeoutMs = opts.timeoutMs || 45000;
  const { VENDOR_TEST_URLS } = require('../ipc/credentials');
  const { attemptAutoLogin, isLoginPage, VENDOR_PARTITIONS, LOGIN_STRATEGIES } = require('../orcha/auto-login');

  // Prefer an explicit target URL (e.g. the exact DTNA CASE url the user is
  // opening) over the generic vendor landing URL. CRITICAL for DTNA: the
  // Servicetracker ROOT may load WITHOUT triggering auth (warm wrongly reports
  // loggedIn=true), while the actual /s/case/<id> URL requires login — so warm
  // the SAME url that needs auth, not a generic one. (Confirmed: root warm said
  // loggedIn=true while the case webview showed the CIAM login.)
  const url = (opts.targetUrl && /^https?:/i.test(opts.targetUrl)) ? opts.targetUrl : VENDOR_TEST_URLS[vendorId];
  if (!url) { logger.warn('[warm] unknown vendor: ' + vendorId); return { ok: false, loggedIn: false, attempted: false }; }
  let hostname;
  try { hostname = new URL(url).hostname; } catch (_) { return { ok: false, loggedIn: false, attempted: false }; }
  logger.info('[warm] ' + vendorId + ' using url ' + url.slice(0, 90));

  const win = new BrowserWindow({
    width: 1200, height: 800,
    show: false,            // hidden — fully silent
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: VENDOR_PARTITIONS[hostname] || undefined,
    },
  });

  // sso-click vendors route through Midway — seed the app's valid Midway
  // cookies into the (cold) vendor partition so it isn't gated by a posture
  // check. Same rationale as credentials:test-login.
  if (LOGIN_STRATEGIES[hostname] === 'sso-click') {
    try {
      const { injectCookies } = require('./auth');
      await require('../auth/session-seeder').seedOrLegacy(win.webContents.session, { reason: 'vendor-warm', partition: VENDOR_PARTITIONS[hostname] || null }, () => injectCookies(win.webContents.session));
    } catch (e) { logger.warn('[warm] could not seed Midway cookies for ' + vendorId + ': ' + e.message); }
  }

  win.loadURL(url);

  return await new Promise((resolve) => {
    let resolved = false;
    let attempts = 0;
    let attempted = false;
    const maxAttempts = 3;
    let settleTimer = null;
    let urlAtLastAttempt = null;
    let graceChecks = 0;
    const maxGraceChecks = 8; // ~12s of post-submit redirect grace (frontdoor -> app)

    const hardTimeout = setTimeout(() => finish({ ok: true, loggedIn: _looksLoggedIn(), attempted, timedOut: true }), timeoutMs);

    function _looksLoggedIn() {
      try {
        const u = win.isDestroyed() ? '' : win.webContents.getURL();
        return !!u && !_LOGIN_HOSTS_RE.test(u) && /^https?:/i.test(u);
      } catch (_) { return false; }
    }

    function finish(result) {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      clearTimeout(settleTimer);
      try {
        win.webContents.removeListener('did-finish-load', onNav);
        win.webContents.removeListener('did-navigate', onNav);
      } catch (_) {}
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
      logger.info('[warm] ' + vendorId + ' done | loggedIn=' + !!result.loggedIn + ' attempted=' + !!result.attempted + (result.timedOut ? ' (timeout)' : ''));
      resolve(result);
    }

    async function checkSettled() {
      if (resolved || win.isDestroyed()) return;
      const currentUrl = win.webContents.getURL();
      let onLoginPg = false;
      try { onLoginPg = await isLoginPage(win.webContents); } catch (_) {}

      if (!onLoginPg) {
        const onLoginHost = _LOGIN_HOSTS_RE.test(currentUrl);
        // After a submit, the post-login redirect chain passes through transient
        // hops (e.g. Salesforce frontdoor.jsp) before landing on the real app
        // page. If we're still on the login host OR on the exact URL we just
        // filled, don't conclude yet — give the redirect time to complete so we
        // correctly observe the logged-in landing instead of reporting a false
        // loggedIn=false. (Root cause of the earlier mismatch where
        // attachAutoLogin reached the case page but the warm said loggedIn=false.)
        const stillSettling = onLoginHost ||
          (urlAtLastAttempt && currentUrl === urlAtLastAttempt) ||
          !/^https?:/i.test(currentUrl);
        if (stillSettling && graceChecks < maxGraceChecks) {
          graceChecks++;
          settleTimer = setTimeout(checkSettled, 1500);
          return;
        }
        // DIAGNOSTIC (2026-10): if we settle on a LOGIN HOST but isLoginPage()
        // saw no form (so no login attempt was made), log the page so we can
        // see what state DTNA's B2C page is actually in (loading? pick-account?
        // consent?) — this is the 'attempted=false, loggedIn=false' case.
        if (onLoginHost && !attempted) {
          try {
            const snip = await win.webContents.executeJavaScript(
              '(function(){var t=(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim();return t.slice(0,300);})()'
            ).catch(() => '');
            logger.warn('[warm] ' + vendorId + ' settled on login host with NO detected form. url=' + currentUrl.slice(0, 120) + ' | body="' + String(snip || '').slice(0, 220) + '"');
          } catch (_) {}
        }
        // Settled on a non-login page. loggedIn iff it's the real vendor site.
        finish({ ok: true, loggedIn: !onLoginHost, attempted });
        return;
      }

      if (attempts >= maxAttempts) {
        finish({ ok: true, loggedIn: false, attempted, maxAttemptsReached: true });
        return;
      }
      attempts++;
      try {
        const result = await attemptAutoLogin(win.webContents, currentUrl);
        if (!result.filled) { finish({ ok: true, loggedIn: false, attempted }); return; }
        attempted = true;
        urlAtLastAttempt = currentUrl;
        graceChecks = 0;
        // filled + submitted — wait for navigation; onNav re-arms checkSettled.
      } catch (e) {
        logger.warn('[warm] ' + vendorId + ' attempt error: ' + e.message);
        finish({ ok: false, loggedIn: false, attempted });
      }
    }

    function onNav() {
      if (resolved) return;
      clearTimeout(settleTimer);
      // Azure B2C / Salesforce pages hydrate their login form asynchronously
      // after did-finish-load. Give them 2.5s to render before isLoginPage()
      // checks, otherwise we settle on a "no form yet" page and never attempt
      // the fill (the observed attempted=false). Matches the 2000ms the
      // azure-b2c handler itself waits for the form.
      settleTimer = setTimeout(checkSettled, 2500);
    }

    win.webContents.on('did-finish-load', onNav);
    win.webContents.on('did-navigate', onNav);
    win.on('closed', () => finish({ ok: true, loggedIn: false, attempted, closed: true }));
  });
}

// Public: concurrency-guarded warm. Returns the in-flight promise if one is
// already running for this vendor.
function warmVendorSession(vendorId, opts) {
  if (_inFlight.has(vendorId)) {
    logger.info('[warm] ' + vendorId + ' already in flight — reusing');
    return _inFlight.get(vendorId);
  }
  const p = _warm(vendorId, opts).finally(() => { _inFlight.delete(vendorId); });
  _inFlight.set(vendorId, p);
  return p;
}

// Morning pre-warm scheduler removed (DTNA Phase A, user-initiated only). User-visible effect: if the
// DTNA session expired overnight, the first Split View open or first DTNA pull of the day shows sign-in
// (or the on-demand warm handles it).
module.exports = { warmVendorSession };
