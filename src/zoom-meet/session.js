'use strict';
/**
 * zoom-meet/session.js — the Meetings tab's Electron session.
 *
 * Partition 'persist:zoom-portal': kept apart from the shipped OAuth 'persist:zoom',
 * from defaultSession (Midway/AAP/Outlook jar) and from the spike/probe partitions.
 * Configured once per process:
 *   - plain Chrome user agent (the 2026-11-09 test ran with it; Zoom's web client
 *     may reject an "Electron/x" UA — kept until phase 0 proves it unnecessary)
 *   - mic / camera / notifications / screen-share permitted for *.zoom.us only
 *   - screen share through the OS picker, falling back to the primary screen
 *   - partition seeded read-only with Midway cookies via scrapers/auth.injectCookies
 * Never fills credentials: if Zoom shows its SSO button the user clicks it.
 */

const PARTITION = 'persist:zoom-portal';
const ALLOWED_PERMISSIONS = new Set([
  'media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection',
]);

let _configured = null;   // the configured session (memoized)
let _seedPromise = null;

function _deps(d) { return d || {}; }

function chromeUserAgent(fallback) {
  return String(fallback || '')
    .replace(/\sElectron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))\s+\S+\/\S+\s+(Chrome\/)/, '$1 $2');
}

function _originHost(urlLike) {
  try { return new URL(urlLike).hostname; } catch (_) { return ''; }
}

/** Pure decision used by both permission handlers (exported for tests). */
function permissionAllowed(permission, requestingUrl) {
  const { isZoomHost } = require('./url');
  return ALLOWED_PERMISSIONS.has(permission) && isZoomHost(_originHost(requestingUrl));
}

function getSession(deps) {
  if (_configured) return _configured;
  const d = _deps(deps);
  const electron = d.electron || require('electron');
  const { app, session, desktopCapturer } = electron;
  const log = d.log || require('../utils/logger')('zoom-meet');
  const ses = session.fromPartition(PARTITION);

  try { ses.setUserAgent(chromeUserAgent(app.userAgentFallback)); } catch (e) { log.warn('[zoom-meet] UA not set: ' + e.message); }

  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
    cb(permissionAllowed(permission, url));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => permissionAllowed(permission, origin));

  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler(async (req, cb) => {
      try {
        if (!permissionAllowed('display-capture', (req && req.securityOrigin) || (req && req.frame && req.frame.url) || '')) { cb({}); return; }
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        cb(sources && sources.length ? { video: sources[0] } : {});
      } catch (e) { log.warn('[zoom-meet] display media failed: ' + e.message); cb({}); }
    }, { useSystemPicker: true });
  }

  _configured = ses;
  return ses;
}

/** Seed the partition with Midway cookies once (read-only use of the shared helper). */
function seedMidway(deps) {
  if (_seedPromise) return _seedPromise;
  const d = _deps(deps);
  const log = d.log || require('../utils/logger')('zoom-meet');
  const inject = d.injectCookies || ((s) => require('../scrapers/auth').injectCookies(s));
  _seedPromise = Promise.resolve()
    .then(() => inject(getSession(d)))
    .then(() => true)
    .catch((e) => { log.warn('[zoom-meet] midway seed failed: ' + (e && e.message)); _seedPromise = null; return false; });
  return _seedPromise;
}

function _resetForTests() { _configured = null; _seedPromise = null; }

module.exports = { PARTITION, getSession, seedMidway, permissionAllowed, chromeUserAgent, _resetForTests };
