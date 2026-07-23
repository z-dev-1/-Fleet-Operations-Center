'use strict';
/**
 * ipc/credentials.js - Site credential manager IPC handlers
 * S23-0 (2026-06-28): VENDOR_CRED_KEYS, _HOST_TO_VENDOR, getForHostname()
 * BUG FIX: loadCredentials was never exported; auto-login.js was broken.
 *
 * FEATURE (2026-07-22): credentials:test-login -- lets Setup/Settings open
 * a REAL vendor portal window and attempt the exact same auto-login pass
 * (src/orcha/auto-login.js) the background AAP/Relay scraper already
 * relies on in production for these hosts -- so "Test login" here is
 * proof the SAME credentials that power live scraping actually work, not
 * a separate, disconnected check.
 *
 * Deliberately its own small, fixed allowlist (VENDOR_TEST_URLS below)
 * rather than reusing/widening ipc/orcha.js's open-popup
 * POPUP_ALLOWED_HOSTS -- that allowlist is scoped tight on purpose
 * (Issue #4 hardening, internal-Amazon hosts only) and vendor portals are
 * a deliberately separate trust boundary from it. This handler only ever
 * opens one of the fixed hostnames already trusted by auto-login.js's own
 * VENDOR_PARTITIONS/LOGIN_STRATEGIES maps -- never an arbitrary URL.
 */

const { BrowserWindow }          = require('electron');
const creds  = require("../security/credentials");
const logger = require("../utils/logger")("ipc:credentials");
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require("../utils/errors");

const KEY_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function _validateKey(key) {
  requireString(key, "key");
  if (!KEY_RE.test(key)) throw new ConfigError("invalid key chars","key");
}

const VENDOR_CRED_KEYS = {
  paccar:    { user: "vendor.paccar.username",    pass: "vendor.paccar.password"    },
  volvo:     { user: "vendor.volvo.username",     pass: "vendor.volvo.password"     },
  record360: { user: "vendor.record360.username", pass: "vendor.record360.password" },
  aperia:    { user: "vendor.aperia.username",    pass: "vendor.aperia.password"    },
  reach24:   { user: "vendor.reach24.username",   pass: "vendor.reach24.password"   },
  dtna:      { user: "vendor.dtna.username",      pass: "vendor.dtna.password"      },
  roadready: { user: "vendor.roadready.username", pass: "vendor.roadready.password" },
  velogic:   { user: "vendor.velogic.username",   pass: "vendor.velogic.password"   },
  abs:       { user: "vendor.abs.username",       pass: "vendor.abs.password"       },
};

const _HOST_TO_VENDOR = {
  "paccarpg.decisiv.net":           "paccar",
  "volvopg.asist.decisiv.net":      "volvo",
  "dashboard.record360.com":        "record360",
  "amazon.aperiatech.com":          "aperia",
  "amazon.reach24.net":             "reach24",
  "dtna.my.site.com":               "dtna",
  "ciam.dtna.com":                  "dtna",
  "login.dtna.com":                 "dtna",
  // FEATURE (2026-07-23): real login-form hostname after DTNA/Daimler
  // Truck's migration to daimlertruck.com (Azure B2C) -- see matching
  // comment in src/orcha/auto-login.js VENDOR_PARTITIONS.
  "login.na.ciam.daimlertruck.com": "dtna",
  "login.ciam.daimlertruck.com":    "dtna",
  "roadready.fadv.com":             "roadready",
  "velogic.my.site.com":            "velogic",
  "www.access-billing-services.com":"abs",
};

// FEATURE (2026-07-22): fixed set of vendor portal "landing page" URLs
// that credentials:test-login is allowed to open -- root/entry-point URL
// for each, not a user-specific bookmark (e.g. a saved estimate ID),
// since this is meant to work for ANY user on a fresh install, not just
// whoever's Accounts list happens to already have a stale deep link.
// 'uptake' is intentionally separate from VENDOR_CRED_KEYS/_HOST_TO_VENDOR
// above -- fleet.uptake.com uses Amazon Midway SSO (LOGIN_STRATEGIES:
// 'sso-click' in auto-login.js), not a stored username/password, so it
// has no credential keys and needs none.
const VENDOR_TEST_URLS = {
  paccar:    'https://paccarpg.decisiv.net/',
  volvo:     'https://volvopg.asist.decisiv.net/',
  record360: 'https://dashboard.record360.com/',
  aperia:    'https://amazon.aperiatech.com/',
  reach24:   'https://amazon.reach24.net/',
  // FEATURE (2026-07-23): user confirmed directly -- this exact
  // Daimler Truck CIAM authorize URL is the real DTNA login entry
  // point, not dtna.my.site.com (which shows a different, wrong login
  // form first). Using it verbatim per the user's explicit correction.
  dtna:      'https://login.na.ciam.daimlertruck.com/ef757345-807b-4e61-b1f1-14006aeb0b83/b2c_1a_signin_oidc/oauth2/v2.0/authorize?client_id=d65b878e-f980-4fc6-a03d-27d301a34c23&redirect_uri=https%3a%2f%2flogin.ciam.daimlertruck.com%2f3db550f0-0c7f-439b-8e24-e32bf233615d%2foauth2%2fauthresp&response_type=code&scope=openid&response_mode=form_post&nonce=41rb05OaBkXKoUEzR5U4MQ%3d%3d&AppClientID=222e5aee-3a77-4214-a3c3-a4f6ae644e95&CustomUI=default&state=StateProperties%3deyJTSUQiOiJ4LW1zLWNwaW0tcmM6MjQ1MjNlMjktOGJjOS00NzkxLWIwOTAtOGUxOGU2MGFiMTAwIiwiVElEIjoiMmZlZDY3NGEtYWIyNC00NjcwLTk1ZDctMGQ2YTI0MGUzMDdlIiwiVE9JRCI6IjNkYjU1MGYwLTBjN2YtNDM5Yi04ZTI0LWUzMmJmMjMzNjE1ZCJ9',
  // FEATURE (2026-07-23): RoadReady's real entry point is this Amazon
  // Freight Partner Salesforce case-list URL, confirmed live by the user
  // -- not roadready.fadv.com. Lands on a page with an 'Amazon SSO'
  // button (see auto-login.js sso-click handling for
  // amazonfreightpartner.my.salesforce.com), no stored credentials
  // needed, same as Uptake.
  roadready: 'https://amazonfreightpartner.my.salesforce.com/?ec=302&startURL=%2Fvisualforce%2Fsession%3Furl%3Dhttps%253A%252F%252Famazonfreightpartner.lightning.force.com%252Flightning%252Fo%252FCase%252Flist%253FfilterName%253DAll_AFP_Maintenance_Cases',
  velogic:   'https://velogic.my.site.com/',
  abs:       'https://www.access-billing-services.com/',
  uptake:    'https://fleet.uptake.com/?realm=amzlmiddlemile',
};

async function getForHostname(hostname) {
  const vendor = _HOST_TO_VENDOR[hostname];
  if (vendor && VENDOR_CRED_KEYS[vendor]) {
    const keys = VENDOR_CRED_KEYS[vendor];
    const user = await creds.get(keys.user);
    const pass = await creds.get(keys.pass);
    if (user && pass) { logger.info("getForHostname: hit:", vendor); return { username: user, password: pass, label: vendor }; }
    logger.warn("getForHostname: no creds for:", vendor, "-- save via Settings > Credentials");
    return null;
  }
  const all = creds.list();
  for (const key of all) {
    const raw = await creds.get(key); if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      if (entry.url && entry.username && entry.password) {
        try { if (new URL(entry.url).hostname === hostname) return { username: entry.username, password: entry.password, label: entry.label || key }; } catch (_) {}
      }
    } catch (_) {}
  }
  logger.warn("getForHostname: no match for:", hostname); return null;
}

function registerCredentialIPC() {
  handle("credentials:list", async () => creds.list());
  handle("credentials:has", async (_e, key) => { const all = await creds.list(); return all.includes(key); });
  handle("credentials:set", async (_e, key, val) => { _validateKey(key); await creds.set(key, typeof val==="string"?val:JSON.stringify(val)); logger.info("set:",key); return {ok:true}; });
  handle("credentials:get", async (_e, key) => { requireString(key,"key"); const v=await creds.get(key); return v===null?null:{ exists: true, key }; });
  handle("credentials:save", async (_e, e) => { if (!e||typeof e!=="object") throw new ConfigError("entry must be object","entry"); _validateKey(e.key); await creds.set(e.key, typeof e.value==="string"?e.value:JSON.stringify(e.value)); logger.info("saved:",e.key); return {ok:true,key:e.key}; });
  handle("credentials:delete", async (_e, key) => { requireString(key,"key"); await creds.delete(key); logger.info("deleted:",key); return {ok:true}; });
  handle("credentials:get-for-url", async (_e, url) => { requireString(url,"url"); try { const h=new URL(url).hostname; const f=await getForHostname(h); return f?{exists:true,hostname:h,label:f.label}:null; } catch(_){return null;} });

  // FEATURE (2026-07-22): opens a real, visible vendor portal window and
  // attempts one real auto-login pass -- see the module docblock above
  // for why this is a separate, fixed allowlist from open-popup's.
  // Returns as soon as the FIRST attempt completes (filled+submitted, or
  // determined not possible) and leaves the window open so the user can
  // see the actual result with their own eyes (dashboard vs. error page)
  // rather than this handler guessing at success from the URL alone --
  // deliberately not over-claiming a "verified successful login" this
  // handler can't fully confirm without knowing every vendor's specific
  // post-login page shape.
  handle("credentials:test-login", async (_e, vendorId) => {
    requireString(vendorId, "vendorId");
    const url = VENDOR_TEST_URLS[vendorId];
    if (!url) throw new ConfigError("unknown vendor for test-login: " + vendorId, "vendorId");
    const { attemptAutoLogin, isLoginPage, VENDOR_PARTITIONS } = require('../orcha/auto-login');
    const hostname = new URL(url).hostname;
    const win = new BrowserWindow({
      width: 1200, height: 800, show: true,
      title: 'Sign in \u2014 ' + vendorId,
      icon: require('../config/app-icon').getAppIconPath(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: VENDOR_PARTITIONS[hostname] || undefined,
      },
    });
    win.loadURL(url);
    // BUG FIX (2026-07-23): this used to attempt login exactly once, on the
    // very first did-finish-load. That works fine for a single-hop site,
    // but breaks for a vendor like DTNA whose landing page
    // (dtna.my.site.com) shows its OWN native Salesforce-style login form
    // (with real #username/#password fields that happily get filled and
    // submitted) before redirecting on to a completely different SSO
    // hostname (login.na.ciam.daimlertruck.com, an Azure B2C page) for the
    // credentials that actually matter. By the time that real page loaded,
    // this handler had already resolved and stopped listening, so the user
    // always ended up stuck on the SSO page unauthenticated -- looking like
    // "auto-login doesn't work" even though the fill+submit on the first
    // hop succeeded (confirmed in auto-login.log).
    // Now debounced across the WHOLE redirect chain, same as the live
    // scraper's attachAutoLogin(): every navigation resets a short settle
    // timer; once things stop moving we check once more for a login page
    // and try again (up to maxAttempts) instead of giving up after hop 1.
    return await new Promise((resolve) => {
      let resolved = false;
      let attempts = 0;
      let lastSite = hostname;
      const maxAttempts = 3;
      let settleTimer = null;
      const hardTimeout = setTimeout(() => finish({ ok: true, attempted: attempts > 0, site: lastSite, timedOut: true }), 25000);

      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimeout);
        clearTimeout(settleTimer);
        win.webContents.removeListener('did-finish-load', onNav);
        win.webContents.removeListener('did-navigate', onNav);
        resolve(result);
      };

      async function checkSettled() {
        if (resolved || win.isDestroyed()) return;
        const currentUrl = win.webContents.getURL();
        const onLoginPg = await isLoginPage(win.webContents);
        if (!onLoginPg) {
          // Settled somewhere that isn't a login form -- either the real
          // target (success) or a page auto-login has no strategy for.
          logger.info('test-login:', vendorId, 'settled, no login form present at', currentUrl.slice(0, 80));
          finish({ ok: true, attempted: attempts > 0, site: lastSite });
          return;
        }
        if (attempts >= maxAttempts) {
          logger.warn('test-login: max attempts reached, still on a login page:', vendorId, currentUrl.slice(0, 80));
          finish({ ok: true, attempted: attempts > 0, site: lastSite, maxAttemptsReached: true });
          return;
        }
        attempts++;
        try {
          const result = await attemptAutoLogin(win.webContents, currentUrl);
          lastSite = result.site || lastSite;
          logger.info('test-login:', vendorId, 'attempt', attempts, '-> filled:', result.filled, 'on', currentUrl.slice(0, 80));
          if (!result.filled) { finish({ ok: true, attempted: false, site: lastSite }); return; }
        } catch (e) {
          logger.warn('test-login error:', vendorId, e.message);
          finish({ ok: false, error: e.message });
          return;
        }
        // Filled + submitted -- wait for the resulting navigation, onNav
        // below will call checkSettled() again once things quiet down.
      }

      function onNav() {
        if (resolved) return;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(checkSettled, 1200);
      }

      win.webContents.on('did-finish-load', onNav);
      win.webContents.on('did-navigate', onNav);
      win.on('closed', () => finish({ ok: true, attempted: attempts > 0, site: lastSite, closedByUser: true }));
    });
  });
  logger.info("Credentials IPC handlers registered");
}

module.exports = { registerCredentialIPC, getForHostname, VENDOR_CRED_KEYS, VENDOR_TEST_URLS };
