'use strict';
/**
 * longdwell/pane-guard.js - main-process guard for the Long Dwell sheet side
 * panel (a renderer-created <webview> showing the weekly SharePoint sheet).
 *
 * The renderer cannot cancel a webview's navigations and controls its tag
 * attributes, so the restrictions live here, on the host webContents:
 *
 *   will-attach-webview  only for an https *.sharepoint.com src: drop partition
 *                        (default session), preload/preloadURL and allowpopups;
 *                        force nodeIntegration off, contextIsolation, webSecurity,
 *                        sandbox; add the marker '--fleet-ldsp-pane'.
 *                        Any other webview (Unit Detail panes) is left untouched.
 *   did-attach-webview   hooks a guest only when its webPreferences carry the
 *                        marker: window.open denied (https opened externally),
 *                        top-level navigations/redirects off the allow list denied.
 *
 * Never reads or writes cookies, never calls auth code. Logs the host only.
 */
const logger = require('../utils/logger').createLogger('ldsp-pane');

const MARKER = '--fleet-ldsp-pane';
const ALLOWED_SUFFIXES = ['.sharepoint.com', '.microsoftonline.com', '.msauth.net', '.msftauth.net', '.office.com',
  '.officeapps.live.com', '.live.com', '.amazon.com', '.amazon.dev'];
const ALLOWED_HOSTS = ['login.microsoftonline.com'];
const OPEN_EXTERNAL_GAP_MS = 2000;

const _installed = new WeakSet();

function _url(u) {
  if (typeof u !== 'string' || !u) return null;
  try { return new URL(u); } catch (_) { return null; }
}

function isSharepointHost(h) {
  const host = String(h || '').toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) && host.endsWith('.sharepoint.com') && host.length > '.sharepoint.com'.length;
}

function _hostAllowed(h) {
  const host = String(h || '').toLowerCase();
  if (ALLOWED_HOSTS.includes(host)) return true;
  return ALLOWED_SUFFIXES.some((s) => host === s.slice(1) || (host.endsWith(s) && host.length > s.length));
}

function isAllowedPaneUrl(url) {
  const u = _url(url);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return false;
  return _hostAllowed(u.hostname);
}

// 'allow' | 'external' (https, not on the list: deny here, open in the browser) | 'deny'
function classifyPaneNavigation(url) {
  if (isAllowedPaneUrl(url)) return 'allow';
  const u = _url(url);
  if (u && u.protocol === 'https:' && !u.username && !u.password) return 'external';
  return 'deny';
}

function _hostOf(url) { const u = _url(url); return u ? u.hostname : ''; }

// Mutates the attach arguments of a SharePoint webview. Returns true when hardened.
function hardenAttach(webPreferences, params) {
  if (!params || typeof params.src !== 'string' || !params.src) return false;
  const u = _url(params.src);
  if (!u || u.protocol !== 'https:' || !isSharepointHost(u.hostname)) return false;
  delete params.partition;
  delete params.allowpopups;
  params.allowpopups = false;
  if (webPreferences && typeof webPreferences === 'object') {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = true;
    const args = Array.isArray(webPreferences.additionalArguments) ? webPreferences.additionalArguments.slice() : [];
    if (!args.includes(MARKER)) args.push(MARKER);
    webPreferences.additionalArguments = args;
  }
  return true;
}

function isMarkedGuest(guest) {
  try {
    const wp = guest && typeof guest.getLastWebPreferences === 'function' ? guest.getLastWebPreferences() : null;
    return !!(wp && Array.isArray(wp.additionalArguments) && wp.additionalArguments.includes(MARKER));
  } catch (_) { return false; }
}

function _deps(d) {
  const o = d || {};
  return {
    shell: o.shell || null,
    now: typeof o.now === 'function' ? o.now : () => Date.now(),
    log: o.logger || logger,
  };
}

function _shell(d) { return d.shell || require('electron').shell; }

function hookGuest(guest, deps) {
  const d = _deps(deps);
  let lastOpen = -Infinity;
  // https only (no userinfo); one call per 2 s.
  const openExternal = (url) => {
    if (classifyPaneNavigation(url) === 'deny') return false;
    const now = d.now();
    if (now - lastOpen < OPEN_EXTERNAL_GAP_MS) return false;
    lastOpen = now;
    try { const p = _shell(d).openExternal(url); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
    return true;
  };
  if (typeof guest.setWindowOpenHandler === 'function') {
    guest.setWindowOpenHandler((details) => {
      const url = details && details.url;
      d.log.info('[ldsp-pane] popup denied', { host: _hostOf(url) });
      openExternal(url);
      return { action: 'deny' };
    });
  }
  const guardNav = (e, urlArg, _isInPlace, isMainFrame) => {
    if (isMainFrame === false) return; // subframes (Excel editor iframes) are not top-level navigations
    const url = typeof urlArg === 'string' ? urlArg : (e && e.url);
    if (isAllowedPaneUrl(url)) return;
    try { if (e && typeof e.preventDefault === 'function') e.preventDefault(); } catch (_) {}
    d.log.info('[ldsp-pane] navigation blocked', { host: _hostOf(url) });
    openExternal(url);
  };
  guest.on('will-navigate', guardNav);
  guest.on('will-redirect', guardNav);
  return true;
}

// Idempotent per host webContents.
function installPaneGuard(host, deps) {
  if (!host || typeof host.on !== 'function') return false;
  if (_installed.has(host)) return false;
  _installed.add(host);
  host.on('will-attach-webview', (_e, webPreferences, params) => {
    try {
      if (hardenAttach(webPreferences, params)) _deps(deps).log.info('[ldsp-pane] webview hardened', { host: _hostOf(params.src) });
    } catch (_) { /* never break other webviews */ }
  });
  host.on('did-attach-webview', (_e, guest) => {
    try { if (isMarkedGuest(guest)) hookGuest(guest, deps); } catch (_) { /* not hooked */ }
  });
  return true;
}

module.exports = {
  MARKER, ALLOWED_SUFFIXES, ALLOWED_HOSTS,
  installPaneGuard, isAllowedPaneUrl, classifyPaneNavigation, isSharepointHost, hardenAttach, isMarkedGuest, hookGuest,
};
