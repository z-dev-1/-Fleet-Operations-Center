'use strict';
/**
 * auto-login.js -- Auto-login engine for vendor BrowserWindows [V-C]
 *
 * S27-8 expansion (2026-07-01):
 *   Added 7 new sites with per-hostname login strategies:
 *     standard   — email+pass both visible, fill+submit in one shot
 *     two-step   — email → click Next/Continue → wait → fill pass → submit
 *     iframe     — login form lives inside a child frame
 *     sso-click  — just click an SSO/agree button (Uptake)
 *     stay-in    — click "Yes"/"Stay signed in" prompt (OWA)
 *
 *   VENDOR_PARTITIONS expanded with isolated persist: sessions for all sites.
 */

const logger = require("../utils/logger")("auto-login");
const { getForHostname } = require("../ipc/credentials");

// ── Session partitions (one per site — prevents cookie bleed) ─────────────────
const VENDOR_PARTITIONS = {
  "paccarpg.decisiv.net":            "persist:vendor-paccar",
  "volvopg.asist.decisiv.net":       "persist:vendor-volvo",
  "dashboard.record360.com":         "persist:vendor-record360",
  "amazon.aperiatech.com":           "persist:vendor-aperia",
  "amazon.reach24.net":              "persist:vendor-reach24",
  "dtna.my.site.com":                "persist:vendor-dtna",
  "roadready.fadv.com":              "persist:vendor-roadready",
  "velogic.my.site.com":             "persist:vendor-velogic",
  "www.access-billing-services.com": "persist:vendor-abs",
  "fleet.uptake.com":                "persist:vendor-uptake",
  "outlook.office365.com":           "persist:vendor-owa",
};

// ── Per-hostname login strategy ───────────────────────────────────────────────
// standard  : username+password both on page at once
// two-step  : email first → click button → password appears
// iframe    : form is inside a child <frame>/<iframe>
// sso-click : just click a button (no credentials needed)
// stay-in   : click "Yes" / "Stay signed in" (OWA MFA prompt)
const LOGIN_STRATEGIES = {
  "paccarpg.decisiv.net":            "standard",
  "volvopg.asist.decisiv.net":       "standard",
  "dashboard.record360.com":         "two-step",
  "amazon.aperiatech.com":           "two-step",
  "amazon.reach24.net":              "standard",
  "dtna.my.site.com":                "standard",
  "roadready.fadv.com":              "standard",
  "velogic.my.site.com":             "standard",
  "www.access-billing-services.com": "iframe",
  "fleet.uptake.com":                "sso-click",
  "outlook.office365.com":           "stay-in",
};

function partitionForUrl(url) {
  try { return VENDOR_PARTITIONS[new URL(url).hostname] || null; }
  catch (_) { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _execSafe(wc, script) {
  try { return await wc.executeJavaScript(script); }
  catch (e) { logger.warn('execSafe failed:', e.message); return null; }
}

async function isLoginPage(wc) {
  const r = await _execSafe(wc,
    '(function(){' +
    'var pw=document.querySelectorAll("input[type=password]").length;' +
    'var em=document.querySelectorAll("input[type=email],input[type=text],input[placeholder*=mail i],input[placeholder*=user i]").length;' +
    'return pw>0||em>0;' +
    '})()'
  );
  return !!r;
}

// Inject a value into a React/Vue controlled input
function _fillScript(selector, value) {
  const vJ = JSON.stringify(value);
  return (
    '(function(){' +
    'var el=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!el) return false;' +
    'el.focus();' +
    'var sv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
    'sv.call(el,' + vJ + ');' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));' +
    'el.dispatchEvent(new Event("change",{bubbles:true}));' +
    'return true;' +
    '})()'
  );
}

function _clickScript(selector) {
  return (
    '(function(){' +
    'var el=document.querySelector(' + JSON.stringify(selector) + ');' +
    'if(!el) return false;' +
    'el.click(); return true;' +
    '})()'
  );
}

// ── Strategy: standard (user+pass on same page) ───────────────────────────────
async function _loginStandard(wc, username, password) {
  // Salesforce uses #username / #password; generic fallback covers others
  const userSelectors = [
    '#username',
    'input[name="username"]',
    'input[type="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="user" i]',
    'input[type="text"]',
  ];
  const passSelectors = [
    '#password',
    'input[name="password"]',
    'input[type="password"]',
  ];

  let userFilled = false;
  for (const sel of userSelectors) {
    const ok = await _execSafe(wc, _fillScript(sel, username));
    if (ok) { userFilled = true; logger.info('Filled username with selector:', sel); break; }
  }
  if (!userFilled) { logger.warn('Could not fill username'); return false; }

  let passFilled = false;
  for (const sel of passSelectors) {
    const ok = await _execSafe(wc, _fillScript(sel, password));
    if (ok) { passFilled = true; logger.info('Filled password with selector:', sel); break; }
  }
  if (!passFilled) { logger.warn('Could not fill password'); return false; }

  await _wait(400);

  // Click submit button
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:not([type="button"]):not([type="reset"])',
  ];
  for (const sel of submitSelectors) {
    const ok = await _execSafe(wc, _clickScript(sel));
    if (ok) { logger.info('Clicked submit:', sel); break; }
  }
  return true;
}

// ── Strategy: two-step (email → Next → password → Submit) ────────────────────
async function _loginTwoStep(wc, username, password) {
  // Step 1: fill email and click Next/Continue
  const emailSelectors = [
    'input[type="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="user" i]',
    'input[type="text"]',
  ];
  let step1 = false;
  for (const sel of emailSelectors) {
    const ok = await _execSafe(wc, _fillScript(sel, username));
    if (ok) { step1 = true; logger.info('Two-step step1: filled email with:', sel); break; }
  }
  if (!step1) { logger.warn('Two-step: could not fill email'); return false; }

  await _wait(300);

  // Click Next / Continue button
  const nextSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button',
  ];
  for (const sel of nextSelectors) {
    const ok = await _execSafe(wc, _clickScript(sel));
    if (ok) { logger.info('Two-step: clicked next button:', sel); break; }
  }

  // Wait for password field to appear (up to 5s)
  let passVisible = false;
  for (let i = 0; i < 10; i++) {
    await _wait(500);
    const hasPw = await _execSafe(wc, '!!document.querySelector("input[type=password]")');
    if (hasPw) { passVisible = true; break; }
  }
  if (!passVisible) { logger.warn('Two-step: password field never appeared'); return false; }

  // Step 2: fill password and submit
  const ok = await _execSafe(wc, _fillScript('input[type="password"]', password));
  if (!ok) { logger.warn('Two-step: could not fill password'); return false; }

  await _wait(400);
  for (const sel of ['button[type="submit"]', 'input[type="submit"]', 'button']) {
    const clicked = await _execSafe(wc, _clickScript(sel));
    if (clicked) { logger.info('Two-step: clicked final submit:', sel); break; }
  }
  return true;
}

// ── Strategy: iframe (form inside child frame) ────────────────────────────────
async function _loginIframe(wc, username, password) {
  const script = (
    '(async function(){' +
    'var frames=document.querySelectorAll("frame,iframe");' +
    'for(var i=0;i<frames.length;i++){' +
    '  try{' +
    '    var d=frames[i].contentDocument||frames[i].contentWindow.document;' +
    '    var pw=d.querySelector("input[type=password]");' +
    '    if(!pw) continue;' +
    '    var uf=d.querySelector("input[type=text],input[type=email],input[name*=user i],input[name*=login i]");' +
    '    var sv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;' +
    '    if(uf){sv.call(uf,' + JSON.stringify(username) + ');uf.dispatchEvent(new Event("input",{bubbles:true}));}' +
    '    sv.call(pw,' + JSON.stringify(password) + ');pw.dispatchEvent(new Event("input",{bubbles:true}));' +
    '    await new Promise(r=>setTimeout(r,400));' +
    '    var f=pw.closest("form");' +
    '    var btn=f?f.querySelector("button[type=submit],input[type=submit]"):null;' +
    '    if(!btn) btn=d.querySelector("button[type=submit],input[type=submit]");' +
    '    if(btn) btn.click(); else if(f) f.submit();' +
    '    return true;' +
    '  }catch(e){}' +
    '}' +
    'return false;' +
    '})()'
  );
  const ok = await _execSafe(wc, script);
  if (ok) { logger.info('Iframe login filled and submitted'); }
  else { logger.warn('Iframe login: no password frame found'); }
  return !!ok;
}

// ── Strategy: sso-click (Uptake — scroll + click Amazon SSO) ─────────────────
async function _loginSsoClick(wc) {
  // Scroll to bottom in case there's an "agree" button below the fold
  await _execSafe(wc, 'window.scrollTo(0, document.body.scrollHeight)');
  await _wait(800);

  const ssoSelectors = [
    'a[href*="amazon"][href*="sso" i]',
    'a[href*="amazon"][href*="login" i]',
    'button[class*="amazon" i]',
    'a[class*="amazon" i]',
    '[data-provider*="amazon" i]',
    'a:not([href="#"]):not([href=""])',  // last resort: first meaningful link
  ];
  for (const sel of ssoSelectors) {
    const ok = await _execSafe(wc, _clickScript(sel));
    if (ok) { logger.info('SSO click: clicked', sel); return true; }
  }
  logger.warn('SSO click: no SSO button found');
  return false;
}

// ── Strategy: stay-in (OWA "Stay signed in?" prompt) ─────────────────────────
async function _loginStayIn(wc) {
  const selectors = [
    'input[value="Yes"]',
    'button[value="yes"]',
    '#idSIButton9',                          // Microsoft standard "Yes" button id
    'button[data-bind*="stay" i]',
    'button',
  ];
  for (const sel of selectors) {
    const ok = await _execSafe(wc, _clickScript(sel));
    if (ok) { logger.info('Stay-in: clicked', sel); return true; }
  }
  logger.warn('Stay-in: no button found');
  return false;
}

// ── Main entry: attempt login based on hostname strategy ─────────────────────
async function attemptAutoLogin(wc, currentUrl) {
  if (!currentUrl || !currentUrl.startsWith('http')) return { filled: false, site: '' };
  let hostname;
  try { hostname = new URL(currentUrl).hostname; }
  catch (_) { return { filled: false, site: '' }; }

  const strategy = LOGIN_STRATEGIES[hostname];
  if (!strategy) { logger.info('No strategy for hostname:', hostname); return { filled: false, site: '' }; }

  logger.info('attemptAutoLogin:', hostname, '→ strategy:', strategy);

  // Button-only strategies (no credentials needed)
  if (strategy === 'sso-click') {
    const ok = await _loginSsoClick(wc);
    return { filled: ok, site: hostname };
  }
  if (strategy === 'stay-in') {
    const ok = await _loginStayIn(wc);
    return { filled: ok, site: hostname };
  }

  // Credential strategies — need user+pass from store
  const match = await getForHostname(hostname);
  if (!match) {
    logger.warn('No credentials stored for:', hostname);
    return { filled: false, site: hostname };
  }

  let ok = false;
  if (strategy === 'standard') {
    ok = await _loginStandard(wc, match.username, match.password);
  } else if (strategy === 'two-step') {
    ok = await _loginTwoStep(wc, match.username, match.password);
  } else if (strategy === 'iframe') {
    ok = await _loginIframe(wc, match.username, match.password);
  }

  return { filled: ok, site: match.label || hostname };
}

// ── attachAutoLogin — attach lifecycle to a BrowserWindow ────────────────────
function attachAutoLogin(win, targetUrl, opts = {}) {
  const { maxRetries = 2, onDone } = opts;
  let loginAttempts = 0;
  let _loginAttempted = false;
  let _done = false;

  async function onLoad() {
    if (_done || !win || win.isDestroyed()) return;
    const currentUrl = win.webContents.getURL();

    if (currentUrl === targetUrl || currentUrl.startsWith(targetUrl)) {
      _done = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      logger.info('attachAutoLogin: reached target:', currentUrl.slice(0, 80));
      if (onDone) onDone({ success: true, url: currentUrl });
      return;
    }

    if (_loginAttempted) {
      const stillLogin = await isLoginPage(win.webContents);
      if (stillLogin) {
        logger.warn('attachAutoLogin: still on login page — bad credentials?');
        _done = true;
        win.webContents.removeListener('did-finish-load', onLoad);
        if (onDone) onDone({ success: false, url: currentUrl, error: 'bad_credentials' });
        return;
      }
      logger.info('attachAutoLogin: post-login, navigating to target');
      _loginAttempted = false;
      win.loadURL(targetUrl);
      return;
    }

    const onLoginPg = await isLoginPage(win.webContents);
    if (!onLoginPg) return;

    if (loginAttempts >= maxRetries) {
      logger.warn('attachAutoLogin: max retries reached');
      _done = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      if (onDone) onDone({ success: false, url: currentUrl, error: 'max_retries' });
      return;
    }

    loginAttempts++;
    logger.info('attachAutoLogin: login page detected, attempt', loginAttempts);
    const result = await attemptAutoLogin(win.webContents, currentUrl);
    if (result.filled) {
      _loginAttempted = true;
    } else {
      logger.warn('attachAutoLogin: could not fill for', currentUrl.slice(0, 80));
      _done = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      if (onDone) onDone({ success: false, url: currentUrl, error: 'no_credentials' });
    }
  }

  win.webContents.on('did-finish-load', onLoad);
  logger.info('attachAutoLogin: attached for', targetUrl.slice(0, 80));
}

module.exports = { attemptAutoLogin, attachAutoLogin, isLoginPage, partitionForUrl, VENDOR_PARTITIONS, LOGIN_STRATEGIES };
