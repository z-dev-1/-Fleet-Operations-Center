'use strict';
/**
 * auto-login.js -- Auto-login engine for vendor BrowserWindows [V-C]
 *
 * S23-0b (2026-06-28):
 *   BUG FIX: loadCredentials was never exported from ipc/credentials.
 *   Auto-login was completely broken for every site. Fixed by importing
 *   getForHostname() instead -- resolves creds by hostname in main process.
 *
 *   NEW: VENDOR_PARTITIONS -- isolated Electron persist: partitions.
 *     paccarpg.decisiv.net       persist:vendor-paccar
 *     volvopg.asist.decisiv.net  persist:vendor-volvo
 *   Prevents PACCAR and Volvo sessions from bleeding into each other.
 *
 *   NEW: attachAutoLogin(win, targetUrl, opts)
 *   Full lifecycle: detect login page -> fill creds -> post-login redirect
 *   -> retry targetUrl. Removes listener on success or max retries.
 */

const logger = require("../utils/logger")("auto-login");
const { getForHostname } = require("../ipc/credentials");

const VENDOR_PARTITIONS = {
  "paccarpg.decisiv.net":       "persist:vendor-paccar",
  "volvopg.asist.decisiv.net":  "persist:vendor-volvo",
};

function partitionForUrl(url) {
  try { return VENDOR_PARTITIONS[new URL(url).hostname] || null; }
  catch (_) { return null; }
}

async function isLoginPage(wc) {
  try { return await wc.executeJavaScript("(function(){return document.querySelectorAll('input[type=password]').length>0;})()"); }
  catch (_) { return false; }
}
async function attemptAutoLogin(wc, currentUrl) {
  if (!currentUrl || !currentUrl.startsWith('http')) return { filled: false, site: '' };
  let hostname;
  try { hostname = new URL(currentUrl).hostname; }
  catch (_) { return { filled: false, site: '' }; }
  const match = await getForHostname(hostname);
  if (!match) return { filled: false, site: '' };
  const uJ = JSON.stringify(match.username);
  const pJ = JSON.stringify(match.password);
  const fillScript = [
    '(function(){',
    'var uF=document.querySelectorAll("input[type=text],input[type=email],input[name*=user],input[name*=email],input[autocomplete=username]");',
    'var pF=document.querySelectorAll("input[type=password]");',
    'if(!pF.length) return JSON.stringify({found:false});',
    'var u=uF.length?uF[0]:null; var p=pF[0];',
    'var sv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;',
    'if(u){sv([u,+]'+uJ+']);u.dispatchEvent(new Event("input",{bubbles:true}));u.dispatchEvent(new Event("change",{bubbles:true}));}',
    'sv([p,+]'+pJ+']);p.dispatchEvent(new Event("input",{bubbles:true}));p.dispatchEvent(new Event("change",{bubbles:true}));',
    'setTimeout(function(){var f=p.closest("form");var b=f?f.querySelector("button[type=submit],input[type=submit]"):null;if(!b) b=document.querySelector("button[type=submit],input[type=submit]");if(b) b.click(); else if(f) f.submit();},500);',
    'return JSON.stringify({found:true,user:!!u,pass:true});',
    '})()'
  ].join('\n');
  try {
    const r = JSON.parse(await wc.executeJavaScript(fillScript) || '{"found":false}');
    if (r.found) {
      logger.info('Filled credentials for', match.label, '(' + hostname + ')');
      return { filled: true, site: match.label };
    }
  } catch (e) { logger.warn('Inject failed:', e.message); }
  return { filled: false, site: '' };
}

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
        logger.warn('attachAutoLogin: still on login page -- bad credentials?');
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

    const onLoginPage = await isLoginPage(win.webContents);
    if (!onLoginPage) return;

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
      logger.warn('attachAutoLogin: no credentials for', currentUrl.slice(0, 80));
      _done = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      if (onDone) onDone({ success: false, url: currentUrl, error: 'no_credentials' });
    }
  }

  win.webContents.on('did-finish-load', onLoad);
  logger.info('attachAutoLogin: attached for', targetUrl.slice(0, 80));
}

module.exports = { attemptAutoLogin, attachAutoLogin, isLoginPage, partitionForUrl, VENDOR_PARTITIONS };
