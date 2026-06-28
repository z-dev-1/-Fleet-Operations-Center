'use strict';
/**
 * auto-login.js — Auto-login engine for webviews [V-C]
 * V-C changes vs V-B:
 *   - credentials import updated to V-C path (ipc/credentials)
 *   - console.log replaced with namespaced logger
 *   - loadCredentials now uses V-C safeStorage-based credential store
 */

const logger = require('../utils/logger')('auto-login');

// V-C: credentials module is in ipc/ (safeStorage-backed)
const { loadCredentials } = require('../ipc/credentials');

/**
 * attemptAutoLogin(wv, currentUrl)
 * Attempt auto-login on a webview by injecting credential fill.
 * Call this on 'dom-ready' or 'did-finish-load' for any webview.
 *
 * @param {WebviewTag|BrowserWindow} wv - the webview or window
 * @param {string} currentUrl           - current page URL
 * @returns {Promise<{filled: boolean, site: string}>}
 */
async function attemptAutoLogin(wv, currentUrl) {
  if (!currentUrl || !currentUrl.startsWith('http')) return { filled: false, site: '' };

  const creds = loadCredentials();
  let match = null;
  try {
    const target = new URL(currentUrl).hostname;
    match = creds.find(c => {
      try { return new URL(c.url).hostname === target; } catch (_) { return false; }
    });
  } catch (_) { return { filled: false, site: '' }; }

  if (!match || !match.username || !match.password) return { filled: false, site: '' };

  const fillScript = `
    (function() {
      var userFields = document.querySelectorAll(
        'input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], ' +
        'input[name*="email"], input[id*="user"], input[id*="email"], input[id*="login"], ' +
        'input[autocomplete="username"]'
      );
      var passFields = document.querySelectorAll('input[type="password"]');
      if (passFields.length === 0) return JSON.stringify({ found: false });

      var userField = userFields.length > 0 ? userFields[0] : null;
      var passField = passFields[0];

      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (userField) {
        setter.call(userField, ${JSON.stringify(match.username)});
        userField.dispatchEvent(new Event('input',  { bubbles: true }));
        userField.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setter.call(passField, ${JSON.stringify(match.password)});
      passField.dispatchEvent(new Event('input',  { bubbles: true }));
      passField.dispatchEvent(new Event('change', { bubbles: true }));

      setTimeout(function() {
        var form      = passField.closest('form');
        var submitBtn = form
          ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
          : null;
        if (!submitBtn) submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) submitBtn.click();
        else if (form) form.submit();
      }, 500);

      return JSON.stringify({ found: true, user: !!userField, pass: true });
    })();
  `;

  try {
    const result = JSON.parse(await wv.executeJavaScript(fillScript) || '{"found":false}');
    if (result.found) {
      logger.info(`Filled credentials for ${match.name} (${match.url})`);
      return { filled: true, site: match.name };
    }
  } catch (e) {
    logger.warn('Inject failed: ' + e.message);
  }

  return { filled: false, site: '' };
}

/**
 * isLoginPage(wv) — Check if a page has a password field
 */
async function isLoginPage(wv) {
  try {
    return await wv.executeJavaScript(
      '(function(){ return document.querySelectorAll(\'input[type="password"]\').length > 0; })()'
    );
  } catch (_) { return false; }
}

module.exports = { attemptAutoLogin, isLoginPage };
