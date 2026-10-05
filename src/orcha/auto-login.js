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
  // BUG FIX (2026-07-26): the real PACCAR portal host is pssmfleet.decisiv.net
  // (confirmed live by the user) -- paccarpg.decisiv.net was never correct
  // and is kept below only in case any stale reference still resolves
  // through it. Given its own SEPARATE persist: partition (not shared with
  // paccarpg.decisiv.net or persist:vendor-volvo) -- per user request, the
  // old (possibly-wrong/stale) host and the confirmed-real host must never
  // share cookies with each other, on top of never bleeding into Volvo.
  "pssmfleet.decisiv.net":           "persist:vendor-paccar-pssmfleet",
  "paccarpg.decisiv.net":            "persist:vendor-paccar",
  "volvopg.asist.decisiv.net":       "persist:vendor-volvo",
  "dashboard.record360.com":         "persist:vendor-record360",
  "amazon.aperiatech.com":           "persist:vendor-aperia",
  "amazon.reach24.net":              "persist:vendor-reach24",
  "dtna.my.site.com":                "persist:vendor-dtna",
  "ciam.dtna.com":                   "persist:vendor-dtna",
  "login.dtna.com":                  "persist:vendor-dtna",
  // FEATURE (2026-07-23): DTNA/Daimler Truck migrated their login off the
  // dtna.com domain onto daimlertruck.com (Azure B2C) -- this is the
  // hostname the real login redirect chain lands on now, confirmed by the
  // user from a live redirect URL. Keeping the old *.dtna.com entries
  // above too in case any flow still resolves through them.
  "login.na.ciam.daimlertruck.com":  "persist:vendor-dtna",
  "login.ciam.daimlertruck.com":     "persist:vendor-dtna",
  "roadready.fadv.com":              "persist:vendor-roadready",
  // FEATURE (2026-07-23): RoadReady's real login destination is Amazon
  // Freight Partner's Salesforce org (amazonfreightpartner.my.salesforce.com),
  // reached via an "Amazon SSO" button -- not roadready.fadv.com directly.
  // Confirmed by the user with a live URL. Same session partition as the
  // old host since it's still logically the same vendor.
  "amazonfreightpartner.my.salesforce.com": "persist:vendor-roadready",
  "velogic.my.site.com":             "persist:vendor-velogic",
  "www.access-billing-services.com": "persist:vendor-abs",
  "fleet.uptake.com":                "persist:vendor-uptake",
  // FIX (2026-07-23): fleet.uptake.com immediately redirects to this
  // Keycloak realm host for the actual Amazon-SSO button -- confirmed
  // live (auto-login.log: "No strategy for hostname: login.uptake.com").
  // Same partition so the session carries over once authenticated.
  "login.uptake.com":                "persist:vendor-uptake",
  "outlook.office365.com":           "persist:vendor-owa",
};

// ── Per-hostname login strategy ───────────────────────────────────────────────
// standard  : username+password both on page at once
// two-step  : email first → click button → password appears
// iframe    : form is inside a child <frame>/<iframe>
// sso-click : just click a button (no credentials needed)
// stay-in   : click "Yes" / "Stay signed in" (OWA MFA prompt)
const LOGIN_STRATEGIES = {
  // BUG FIX (2026-07-26): see matching VENDOR_PARTITIONS note above --
  // pssmfleet.decisiv.net is the real host, paccarpg.decisiv.net kept as
  // a stale fallback only.
  "pssmfleet.decisiv.net":           "standard",
  "paccarpg.decisiv.net":            "standard",
  "volvopg.asist.decisiv.net":       "standard",
  "dashboard.record360.com":         "two-step",
  "amazon.aperiatech.com":           "two-step",
  "amazon.reach24.net":              "standard",
  "dtna.my.site.com":                "azure-b2c",
  "ciam.dtna.com":                   "azure-b2c",
  "login.dtna.com":                  "azure-b2c",
  "login.na.ciam.daimlertruck.com":  "azure-b2c",
  "login.ciam.daimlertruck.com":     "azure-b2c",
  "roadready.fadv.com":              "standard",
  "amazonfreightpartner.my.salesforce.com": "sso-click",
  "velogic.my.site.com":             "standard",
  "www.access-billing-services.com": "iframe",
  "fleet.uptake.com":                "sso-click",
  "login.uptake.com":                "sso-click",
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
    // FIX (2026-07-23): Uptake sometimes gates entry behind a one-time
    // "Use and Consent" step (checkbox + Next) with NO username/password
    // field at all -- confirmed live via screenshot. Without this, the
    // checkbox+Next state looked identical to "already fully logged in"
    // to isLoginPage, so credentials:test-login declared success and
    // stopped watching before ever seeing it. Treat an unchecked checkbox
    // next to consent/acknowledge language as pending too.
    'var bodyTxt=(document.body.innerText||"").toLowerCase();' +
    'var hasConsentGate=(bodyTxt.indexOf("acknowledge")!==-1||bodyTxt.indexOf("consent")!==-1)&&document.querySelectorAll("input[type=checkbox]:not(:checked)").length>0;' +
    'return pw>0||em>0||hasConsentGate;' +
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

// DIAGNOSTIC (2026-07-23): dumps every <input>/<iframe> actually present on
// the page (type, id, name, placeholder, visibility) when a fill attempt
// fails, so a real selector mismatch can be read straight from the log
// instead of guessed at blind. Temporary aid for the PACCAR "Could not
// fill password" investigation -- safe to keep, it only runs on failure.
async function _dumpInputs(wc, label) {
  const script = (
    '(function(){' +
    'var out=[];' +
    'document.querySelectorAll("input").forEach(function(el){' +
    '  var r=el.getBoundingClientRect();' +
    '  out.push({type:el.type,id:el.id,name:el.name,placeholder:el.placeholder,visible:(r.width>0&&r.height>0)});' +
    '});' +
    'var frames=document.querySelectorAll("iframe,frame").length;' +
    'return JSON.stringify({inputs:out,frames:frames,url:location.href});' +
    '})()'
  );
  const dump = await _execSafe(wc, script);
  logger.warn('DIAGNOSTIC[' + label + ']:', dump);
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
    'input[placeholder="User ID"]',
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
  if (!passFilled) {
    logger.warn('Could not fill password');
    await _dumpInputs(wc, 'standard-no-password-field');
    return false;
  }

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

// ── Strategy: azure-b2c (DTNA/Daimler Truck CIAM — TWO-STEP email then pass) ─
// DTNA CIAM is a TWO-STEP login (confirmed via screenshots):
//   Step 1: "Email or User ID" field + a "Continue" button.
//   Step 2: (after Continue) "Hello, <userid>" + "Password" field + "Continue".
// There is ALSO a yellow "Login with Daimler Truck Account" button we must NEVER
// click (that's the wrong corporate-SSO path). The old handler assumed user+pass
// on one page and clicked once, so it never reached the password step — the
// confirmed cause of "DTNA won't auto-login". This now ALWAYS drives both steps
// (User ID -> Continue -> wait for the password step -> Password -> Continue).

// Click the primary submit on the CIAM form — "Continue" (or Login/Sign In),
// but DELIBERATELY avoid the "...Daimler Truck Account" corporate button.
const _CIAM_SUBMIT_SCRIPT = (
  '(function(){' +
  'var btns=[].slice.call(document.querySelectorAll("button,input[type=submit],a"));' +
  'function txt(b){return ((b.textContent||b.value||"").trim());}' +
  // Prefer an exact primary action; never the Daimler Truck Account button.
  'for(var i=0;i<btns.length;i++){var t=txt(btns[i]);' +
  '  if(/daimler\\s+truck\\s+account/i.test(t)) continue;' +
  '  if(t==="Continue"||t==="CONTINUE"||t==="Login"||t==="Sign In"||t==="Sign in"||t==="Next"){btns[i].click();return t;}' +
  '}' +
  // Fallback: a submit button that is NOT the Daimler Truck Account one.
  'for(var j=0;j<btns.length;j++){var t2=txt(btns[j]);' +
  '  if(/daimler\\s+truck\\s+account/i.test(t2)) continue;' +
  '  if(btns[j].type==="submit"){btns[j].click();return t2||"submit";}' +
  '}' +
  'var next=document.querySelector("#next,#continue");' +
  'if(next){next.click();return "next";}' +
  'return false;' +
  '})()'
);

// Detect that we've advanced to the PASSWORD step (step 2). The reliable
// signal on DTNA CIAM is the body text switching to the "please enter your
// Password" greeting (shown with "Hello, <user>"); we also accept a password
// field that is actually visible+enabled. Polls because step 2 renders async.
async function _waitForPasswordStep(wc, maxMs) {
  const deadline = Date.now() + (maxMs || 9000);
  const probe = '(function(){' +
    'var bt=(document.body&&document.body.innerText||"").toLowerCase();' +
    'var greetingStep=(bt.indexOf("enter your password")!==-1)||(bt.indexOf("hello,")!==-1 && bt.indexOf("password")!==-1 && bt.indexOf("user id")===-1 && bt.indexOf("email or user id")===-1);' +
    'var el=document.querySelector("input[type=password],#password,input[placeholder=\\"Password\\"]");' +
    'var pwUsable=false; if(el){var r=el.getBoundingClientRect(); pwUsable=(el.offsetParent!==null && r.width>0 && r.height>0 && !el.disabled);}' +
    'return greetingStep||pwUsable;' +
    '})()';
  while (Date.now() < deadline) {
    const ok = await _execSafe(wc, probe);
    if (ok) return true;
    await _wait(500);
  }
  return false;
}

async function _fillFirst(wc, selectors, value) {
  for (const sel of selectors) {
    const ok = await _execSafe(wc, _fillScript(sel, value));
    if (ok) return sel;
  }
  return null;
}

async function _loginAzureB2C(wc, username, password) {
  await _wait(2000); // JS-heavy page — let it render

  const USER_SELECTORS = [
    'input[placeholder="User ID"]',
    'input[placeholder="Email or User ID"]',
    'input[placeholder*="User ID" i]',
    'input[placeholder*="Email" i]',
    '#signInName',
    'input[name="signInName"]',
    'input[type="email"]',
    'input[type="text"]',
  ];
  const PASS_SELECTORS = [
    'input[placeholder="Password"]',
    'input[placeholder*="Password" i]',
    '#password',
    'input[name="password"]',
    'input[type="password"]',
  ];

  // ── Step 1: User ID ──────────────────────────────────────────────────────
  const userSel = await _fillFirst(wc, USER_SELECTORS, username);
  if (!userSel) {
    logger.warn('Azure B2C: could not fill User ID (step 1)');
    await _dumpInputs(wc, 'azure-b2c-no-userid');
    return false;
  }
  logger.info('Azure B2C step1: filled User ID with ' + userSel);

  // ALWAYS two-step for DTNA CIAM. The form processes the User ID first (even
  // though it keeps the password <input> in the DOM), so filling password on
  // step 1 + clicking once lands stuck on "Hello, <user> — enter Password".
  // Click Continue to advance, then handle the password step separately. The
  // "Hello, <user>" greeting is the reliable marker that we're on step 2.
  // Advance via ENTER in the User ID field (what the user does manually) AND
  // click Continue as a fallback — the page re-renders in place on the same URL.
  await _wait(300);
  const step1Enter = (
    '(function(){' +
    'var el=document.querySelector("input[placeholder=\\"User ID\\"],input[placeholder=\\"Email or User ID\\"],#signInName,input[type=email],input[type=text]");' +
    'if(el){el.focus();var o={bubbles:true,cancelable:true,key:"Enter",code:"Enter",keyCode:13,which:13};' +
    'el.dispatchEvent(new KeyboardEvent("keydown",o));el.dispatchEvent(new KeyboardEvent("keypress",o));el.dispatchEvent(new KeyboardEvent("keyup",o));}' +
    'return !!el;' +
    '})()'
  );
  await _execSafe(wc, step1Enter);
  const c1 = await _execSafe(wc, _CIAM_SUBMIT_SCRIPT);
  logger.info('Azure B2C step1: User ID submitted (Enter + "' + c1 + '") — waiting for password step');

  // ── Step 2: Password ──────────────────────────────────────────────────────
  // Wait for the password STEP (the "enter your Password" greeting / an enabled
  // password field), then fill + submit. Poll because step 2 renders async.
  const onPwStep = await _waitForPasswordStep(wc, 9000);
  if (!onPwStep) {
    logger.warn('Azure B2C: password step never appeared after step 1');
    await _dumpInputs(wc, 'azure-b2c-no-password-step2');
    return await _postSubmitDiag(wc);
  }
  await _wait(600); // let the field settle/enable
  const passSel = await _fillFirst(wc, PASS_SELECTORS, password);
  if (!passSel) {
    logger.warn('Azure B2C: on password step but fill failed');
    await _dumpInputs(wc, 'azure-b2c-password-fill-failed');
    return false;
  }
  // Fire the FULL event sequence a framework-controlled field expects, so the
  // value actually commits to React/Angular state BEFORE we submit. The plain
  // input+change from _fillScript was leaving the Continue click to submit an
  // empty/uncommitted password (confirmed: page re-rendered the same password
  // prompt after submit). Also VERIFY the field holds the value first.
  const commitScript = (
    '(function(){' +
    'var el=document.querySelector("input[type=password],#password,input[placeholder=\\"Password\\"]");' +
    'if(!el) return "no-field";' +
    'el.focus();' +
    'el.dispatchEvent(new KeyboardEvent("keydown",{bubbles:true}));' +
    'el.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true}));' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));' +
    'el.dispatchEvent(new Event("change",{bubbles:true}));' +
    'el.dispatchEvent(new Event("blur",{bubbles:true}));' +
    'return el.value && el.value.length ? "ok:"+el.value.length : "empty";' +
    '})()'
  );
  const committed = await _execSafe(wc, commitScript);
  logger.info('Azure B2C step2: filled Password with ' + passSel + ' | commit=' + committed);
  await _wait(700); // give the form time to enable submit after the value commits

  // SUBMIT via ENTER in the password field — the user confirmed that clicking
  // Continue does NOT reliably submit, but pressing Enter DOES log in. Dispatch
  // a full Enter key sequence on the field, then also submit its form + click
  // Continue as belt-and-suspenders. (DTNA CIAM re-renders in place on the same
  // URL, so this is the step that actually completes the login.)
  const enterSubmit = (
    '(function(){' +
    'var el=document.querySelector("input[type=password],#password,input[placeholder=\\"Password\\"]");' +
    'if(!el) return "no-field";' +
    'el.focus();' +
    'var opts={bubbles:true,cancelable:true,key:"Enter",code:"Enter",keyCode:13,which:13};' +
    'el.dispatchEvent(new KeyboardEvent("keydown",opts));' +
    'el.dispatchEvent(new KeyboardEvent("keypress",opts));' +
    'el.dispatchEvent(new KeyboardEvent("keyup",opts));' +
    'try{var f=el.form||el.closest("form"); if(f){ if(typeof f.requestSubmit==="function") f.requestSubmit(); else f.submit(); return "form-submit"; }}catch(e){}' +
    'return "enter";' +
    '})()'
  );
  const submitted = await _execSafe(wc, enterSubmit);
  logger.info('Azure B2C step2: Password submitted via Enter (' + submitted + ')');
  // Belt-and-suspenders: if Enter didn't navigate, also try the Continue button.
  await _wait(1500);
  const stillHere = await _execSafe(wc,
    '(function(){var bt=(document.body&&document.body.innerText||"").toLowerCase();return bt.indexOf("enter your password")!==-1||bt.indexOf("hello,")!==-1;})()'
  );
  if (stillHere) {
    const c2 = await _execSafe(wc, _CIAM_SUBMIT_SCRIPT);
    logger.info('Azure B2C step2: still on password step — also clicked "' + c2 + '"');
  }
  return await _postSubmitDiag(wc);
}

// Post-submit diagnostic: ~2.5s after the final submit, if still on a CIAM/B2C
// login host, dump the page so any remaining step (MFA/consent) is visible.
// Returns true (credentials were driven) regardless — log-only.
async function _postSubmitDiag(wc) {
  try {
    await _wait(2500);
    const nowUrl = await _execSafe(wc, 'location.href') || '';
    if (/ciam\.daimlertruck\.com|ciam\.dtna\.com|b2clogin\.com|login\.microsoftonline/i.test(nowUrl)) {
      const snippet = await _execSafe(wc,
        '(function(){var t=(document.body&&document.body.innerText||"").replace(/\\s+/g," ").trim();return t.slice(0,400);})()'
      );
      logger.warn('Azure B2C: still on login host 2.5s after final submit — url=' + String(nowUrl).slice(0, 120) + ' | body="' + String(snippet || '').slice(0, 300) + '"');
      await _dumpInputs(wc, 'azure-b2c-post-submit');
    } else {
      logger.info('Azure B2C: navigated off login host after submit → ' + String(nowUrl).slice(0, 100));
    }
  } catch (_) { /* diagnostic only */ }
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

  // Text-based match first -- most "Amazon SSO" buttons are rendered as an
  // <a>/<button> whose visible label says so, which no CSS selector can
  // match on directly (href/class conventions vary per site and are easy
  // to guess wrong).
  const textClickScript = (
    '(function(){' +
    'var els=[].slice.call(document.querySelectorAll("a,button"));' +
    'for(var i=0;i<els.length;i++){' +
    '  var t=(els[i].textContent||"").trim().toLowerCase();' +
    '  if(t.indexOf("amazon")!==-1){els[i].click();return t;}' +
    '}' +
    'return false;' +
    '})()'
  );
  const textMatch = await _execSafe(wc, textClickScript);
  if (textMatch) { logger.info('SSO click: clicked by text match:', textMatch); return true; }

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

  // FIX (2026-07-23): Uptake sometimes shows a one-time "Use and Consent"
  // gate after SSO succeeds -- a checkbox + Next button, no SSO link to
  // click at all. Confirmed live via screenshot (STEP 2: USE AND CONSENT).
  const consentOk = await _clickConsentCheckboxAndNext(wc);
  if (consentOk) return true;

  logger.warn('SSO click: no SSO button found');
  return false;
}

// ── Consent gate: check an "I acknowledge/consent" checkbox, then click
// whatever Next/Submit/Continue/Accept button is enabled ───────────────────
async function _clickConsentCheckboxAndNext(wc) {
  const bodyTxt = await _execSafe(wc, '(document.body.innerText||"").toLowerCase()');
  if (!bodyTxt || (bodyTxt.indexOf('acknowledge') === -1 && bodyTxt.indexOf('consent') === -1)) return false;

  const checkScript = (
    '(function(){' +
    'var cbs=[].slice.call(document.querySelectorAll("input[type=checkbox]"));' +
    'for(var i=0;i<cbs.length;i++){if(!cbs[i].checked){cbs[i].click();return true;}}' +
    'return false;' +
    '})()'
  );
  const checked = await _execSafe(wc, checkScript);
  if (!checked) return false;
  logger.info('Consent: checked acknowledge/consent checkbox');

  // Give the page a moment to re-enable Next after the checkbox state
  // change (React/controlled-component re-render), then click it.
  await _wait(500);
  const nextScript = (
    '(function(){' +
    'var els=[].slice.call(document.querySelectorAll("button,a,input[type=submit]"));' +
    'for(var i=0;i<els.length;i++){' +
    '  var t=((els[i].textContent||els[i].value||"").trim().toLowerCase());' +
    '  if((t==="next"||t==="submit"||t==="continue"||t==="accept")&&!els[i].disabled){els[i].click();return t;}' +
    '}' +
    'return false;' +
    '})()'
  );
  const clicked = await _execSafe(wc, nextScript);
  if (clicked) { logger.info('Consent: clicked', clicked); return true; }
  logger.warn('Consent: checked the box but no enabled Next/Submit/Continue button yet -- will retry next settle pass');
  return true; // checkbox state did change -- report success so the caller doesn't treat this as a dead end
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
async function attemptAutoLogin(wc, currentUrl, overrideHostname) {
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
  } else if (strategy === 'azure-b2c') {
    ok = await _loginAzureB2C(wc, match.username, match.password);
  } else if (strategy === 'iframe') {
    ok = await _loginIframe(wc, match.username, match.password);
  }

  return { filled: ok, site: match.label || hostname };
}

// ── attachAutoLogin — attach lifecycle to a BrowserWindow ────────────────────
function attachAutoLogin(win, targetUrl, opts = {}) {
  const { maxRetries = 3, onDone } = opts;
  let loginAttempts = 0;
  let _loginAttempted = false;
  let _done = false;

  // Remove ALL three listeners (finish-load, navigate, stop-loading) in one
  // place so no exit path leaks a listener.
  function _cleanup() {
    try {
      _cleanup();
      win.webContents.removeListener('did-navigate', onLoad);
      win.webContents.removeListener('did-stop-loading', onLoad);
    } catch (_) { /* window already destroyed */ }
  }

  async function onLoad() {
    if (_done || !win || win.isDestroyed()) return;
    const currentUrl = win.webContents.getURL();

    if (currentUrl === targetUrl || currentUrl.startsWith(targetUrl)) {
      // BUG FIX (2026-10): DTNA (Salesforce Lightning) renders its login screen
      // IN PLACE on the case URL when you're not logged in — the URL still
      // equals the target, so the old code declared "reached target" and
      // stopped WITHOUT ever logging in. That's why Split View / offsite sync
      // never logged in (while Test Login, which starts on the CIAM URL, did).
      // So: only treat a target-URL match as success if the page is NOT a login
      // page. If a login form is showing on the target URL, fall through and run
      // the login instead of falsely succeeding.
      let onLoginPg = false;
      try { onLoginPg = await isLoginPage(win.webContents); } catch (_) {}
      // DTNA/Salesforce Lightning renders the login IN PLACE and ASYNC — at the
      // instant the target URL finishes loading, the login form may not have
      // mounted yet, so isLoginPage() is briefly false. Don't conclude success
      // immediately: wait a moment and re-check for a login form that renders
      // a beat later (this is why Split View "landed on the login page" with no
      // auto-login — the first check passed before the form appeared).
      if (!onLoginPg) {
        await _wait(3000);
        if (_done || win.isDestroyed()) return;
        try { onLoginPg = await isLoginPage(win.webContents); } catch (_) {}
      }
      if (!onLoginPg) {
        _done = true;
        _cleanup();
        logger.info('attachAutoLogin: reached target:', currentUrl.slice(0, 80));
        if (onDone) onDone({ success: true, url: currentUrl });
        return;
      }
      logger.info('attachAutoLogin: on target URL but a login form is showing — logging in first:', currentUrl.slice(0, 80));
      if (!_loginAttempted) {
        if (loginAttempts >= maxRetries) {
          logger.warn('attachAutoLogin: login still showing on target after', loginAttempts, 'attempts');
          _done = true;
          _cleanup();
          if (onDone) onDone({ success: false, url: currentUrl, error: 'login_required' });
          return;
        }
        loginAttempts++;
        const result = await attemptAutoLogin(win.webContents, currentUrl, new URL(targetUrl).hostname);
        if (result.filled) _loginAttempted = true;
        else logger.warn('attachAutoLogin: could not act on login at target URL (no strategy/creds for this host?)');
      }
      return;
    }

    if (_loginAttempted) {
      const stillLogin = await isLoginPage(win.webContents);
      if (stillLogin) {
        // FIX (2026-07-23): don't bail on the first "still looks like a login
        // page" check — sso-click vendors (RoadReady/Uptake) can show a
        // second gate (e.g. a one-time consent checkbox) after the initial
        // SSO click that isLoginPage() also detects. Retry the click/consent
        // flow up to maxRetries before concluding it's actually bad creds.
        if (loginAttempts >= maxRetries) {
          logger.warn('attachAutoLogin: still on login page after', loginAttempts, 'attempts — bad credentials?');
          _done = true;
          _cleanup();
          if (onDone) onDone({ success: false, url: currentUrl, error: 'bad_credentials' });
          return;
        }
        loginAttempts++;
        logger.info('attachAutoLogin: still on login-like page (consent gate?) — retry', loginAttempts);
        const targetHostname = new URL(targetUrl).hostname;
        const retryResult = await attemptAutoLogin(win.webContents, currentUrl, targetHostname);
        if (!retryResult.filled) {
          logger.warn('attachAutoLogin: retry could not act on', currentUrl.slice(0, 80));
        }
        return;
      }

      // FIX (2026-07-23): don't force-navigate back to targetUrl while still
      // mid-redirect on a different host than the target (e.g. RoadReady's
      // amazonfreightpartner.my.salesforce.com -> midway-auth.amazon.com ->
      // idp.federate.amazon.com -> amazonfreightpartner.lightning.force.com).
      // Forcing a reload of the deep-linked case URL during that hop races
      // the SSO handshake before the target site sets its own session
      // cookie, dropping the startURL deep link and landing on the generic
      // case list instead ("stays in Salesforce"). Just wait for the chain
      // to finish naturally — it already carries startURL through.
      let sameHost = false;
      try { sameHost = new URL(currentUrl).hostname === new URL(targetUrl).hostname; } catch (_) {}
      if (!sameHost) {
        logger.info('attachAutoLogin: post-login, mid-redirect on', currentUrl.slice(0, 60), '— waiting for natural navigation');
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
      _cleanup();
      if (onDone) onDone({ success: false, url: currentUrl, error: 'max_retries' });
      return;
    }

    loginAttempts++;
    logger.info('attachAutoLogin: login page detected, attempt', loginAttempts);
    const targetHostname = new URL(targetUrl).hostname;
    const result = await attemptAutoLogin(win.webContents, currentUrl, targetHostname);
    if (result.filled) {
      _loginAttempted = true;
    } else {
      logger.warn('attachAutoLogin: could not fill for', currentUrl.slice(0, 80));
      _done = true;
      _cleanup();
      if (onDone) onDone({ success: false, url: currentUrl, error: 'no_credentials' });
    }
  }

  win.webContents.on('did-finish-load', onLoad);
  win.webContents.on('did-navigate', onLoad);
  // did-stop-loading also fires for in-place SPA renders (Salesforce Lightning
  // swapping to the login view without a navigation), so a late-rendering login
  // form still gets caught even when no navigation event fires.
  win.webContents.on('did-stop-loading', onLoad);
  logger.info('attachAutoLogin: attached for', targetUrl.slice(0, 80));
}

// ── runAutoLoginLoop — the PROVEN "Test Login" settle loop ────────────────────
// This is exactly the loop credentials:test-login uses (which the user confirms
// WORKS for DTNA), lifted so Split View / offsite windows can use the SAME
// behavior instead of attachAutoLogin's URL-matching approach (which kept
// landing on DTNA's in-place login without acting). Core idea: it is URL-
// AGNOSTIC — on every settle it just asks "is a login form showing?" If yes,
// run attemptAutoLogin and wait for the next settle; if no, it's done. Each
// navigation/stop-loading/in-page render re-arms a short settle check.
// Returns a Promise<{ ok, attempted, site, timedOut? }>. Does NOT create or
// close the window — the caller owns its lifecycle.
function runAutoLoginLoop(win, opts = {}) {
  const label = opts.label || 'auto-login-loop';
  const maxAttempts = opts.maxAttempts || 4;
  const timeoutMs = opts.timeoutMs || 45000;
  return new Promise((resolve) => {
    let resolved = false, attempts = 0, lastSite = '';
    let settleTimer = null, urlAtLastAttempt = null, graceChecks = 0;
    const maxGraceChecks = 6;

    const finish = (r) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout); clearTimeout(settleTimer);
      try {
        win.webContents.removeListener('did-finish-load', onNav);
        win.webContents.removeListener('did-navigate', onNav);
        win.webContents.removeListener('did-navigate-in-page', onNav);
        win.webContents.removeListener('did-stop-loading', onNav);
      } catch (_) {}
      logger.info('[' + label + '] done | attempted=' + (attempts > 0) + (r.timedOut ? ' (timeout)' : ''));
      resolve(r);
    };
    const hardTimeout = setTimeout(() => finish({ ok: true, attempted: attempts > 0, site: lastSite, timedOut: true }), timeoutMs);

    async function checkSettled() {
      if (resolved || !win || win.isDestroyed()) return;
      const currentUrl = win.webContents.getURL();
      let onLoginPg = false;
      try { onLoginPg = await isLoginPage(win.webContents); } catch (_) {}
      if (!onLoginPg) {
        if (urlAtLastAttempt && currentUrl === urlAtLastAttempt && graceChecks < maxGraceChecks) {
          graceChecks++; settleTimer = setTimeout(checkSettled, 1200); return;
        }
        logger.info('[' + label + '] settled, no login form at ' + currentUrl.slice(0, 80));
        finish({ ok: true, attempted: attempts > 0, site: lastSite });
        return;
      }
      if (attempts >= maxAttempts) {
        logger.warn('[' + label + '] max attempts, still on login: ' + currentUrl.slice(0, 80));
        finish({ ok: true, attempted: attempts > 0, site: lastSite, maxAttemptsReached: true });
        return;
      }
      attempts++;
      try {
        const result = await attemptAutoLogin(win.webContents, currentUrl);
        lastSite = result.site || lastSite;
        logger.info('[' + label + '] attempt ' + attempts + ' -> filled:' + result.filled + ' on ' + currentUrl.slice(0, 80));
        if (!result.filled) { finish({ ok: true, attempted: false, site: lastSite }); return; }
        urlAtLastAttempt = currentUrl; graceChecks = 0;
      } catch (e) {
        logger.warn('[' + label + '] error: ' + e.message);
        finish({ ok: false, error: e.message, site: lastSite });
      }
    }
    function onNav() {
      if (resolved) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(checkSettled, 1500);
    }
    win.webContents.on('did-finish-load', onNav);
    win.webContents.on('did-navigate', onNav);
    win.webContents.on('did-navigate-in-page', onNav); // SPA in-place renders
    win.webContents.on('did-stop-loading', onNav);
    // Kick off an initial settle in case the page is already loaded.
    settleTimer = setTimeout(checkSettled, 1500);
    logger.info('[' + label + '] started');
  });
}

module.exports = { attemptAutoLogin, attachAutoLogin, runAutoLoginLoop, isLoginPage, partitionForUrl, VENDOR_PARTITIONS, LOGIN_STRATEGIES };
