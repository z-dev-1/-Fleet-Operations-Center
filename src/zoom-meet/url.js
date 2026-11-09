'use strict';
/**
 * zoom-meet/url.js — pure helpers for the Meetings tab (no Electron, no I/O).
 *
 * Nothing about a specific meeting is hardcoded: every meeting comes from what the
 * user pastes (a Zoom link or a meeting ID + optional passcode). Hosts come from
 * settings (perf-flags resolveZoomMeetFlags) and must be *.zoom.us.
 *
 * Join URLs are rewritten to the Zoom web client (`/wc/join/<id>`) on the web-app
 * host so the meeting opens in-app instead of prompting for the desktop client.
 * (The web app was observed on app.zoom.us/wc/* in the 2026-11-09 test; the exact
 * /wc/join/<id> route is Zoom's documented browser-join route, verified live in phase 0.)
 */

const ZOOM_HOST_RE = /^([a-z0-9-]+\.)*zoom\.us$/i;
// SSO hops observed in the 2026-11-09 sign-in test (+ Midway itself).
const SSO_HOSTS = Object.freeze(['idp.federate.amazon.com', 'midway-auth.amazon.com']);
const MAX_INPUT = 2048;

function isZoomHost(host) { return typeof host === 'string' && ZOOM_HOST_RE.test(host); }

/** Hosts the meeting view may navigate to: Zoom + the SSO hops. */
function isAllowedNavUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:') return true;
    if (u.protocol !== 'https:') return false;
    return isZoomHost(u.hostname) || SSO_HOSTS.includes(u.hostname.toLowerCase());
  } catch (_) { return false; }
}

function _digits(s) { return String(s || '').replace(/[\s-]/g, ''); }
function _isMeetingId(s) { return /^\d{9,12}$/.test(s); }

/**
 * Turn user input into a URL the meeting view can load.
 * @param {string} input     a Zoom link, or a meeting ID (spaces/dashes ok)
 * @param {object} opts      { passcode?, webAppHost }
 * @returns {{ok:true,url:string,kind:'meeting'|'page'} | {ok:false,error:string}}
 */
function normalizeJoinInput(input, opts) {
  const o = opts || {};
  const webAppHost = isZoomHost(o.webAppHost) ? o.webAppHost : 'app.zoom.us';
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'Enter a Zoom link or meeting ID' };
  if (raw.length > MAX_INPUT) return { ok: false, error: 'Input is too long' };
  const pass = String(o.passcode == null ? '' : o.passcode).trim();

  const build = (id, pwd) => {
    const u = new URL('https://' + webAppHost + '/wc/join/' + id);
    if (pwd) u.searchParams.set('pwd', pwd);
    return { ok: true, url: u.toString(), kind: 'meeting' };
  };

  const bare = _digits(raw);
  if (_isMeetingId(bare)) return build(bare, pass);

  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (_) {
    return { ok: false, error: 'Not a Zoom link or meeting ID' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Not a Zoom link' };
  if (!isZoomHost(u.hostname)) return { ok: false, error: 'Only zoom.us links are allowed' };
  const pwd = pass || u.searchParams.get('pwd') || '';
  // /j/<id>, /s/<id>, /w/<id>, /wc/join/<id>, /wc/<id>/join, /wc/<id>/start
  const m = u.pathname.match(/^\/(?:j|s|w)\/(\d{9,12})\/?$/) ||
            u.pathname.match(/^\/wc\/join\/(\d{9,12})\/?$/) ||
            u.pathname.match(/^\/wc\/(\d{9,12})\/(?:join|start)\/?$/);
  if (m) return build(m[1], pwd);
  // Anything else on a Zoom host (personal /my/<name> links, web-app pages): load as-is over https.
  u.protocol = 'https:';
  return { ok: true, url: u.toString(), kind: 'page' };
}

/** zoommtg:// deep link for the explicit "Open in Zoom app" button; null when no meeting ID. */
function toDeepLink(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:j|s|w|wc\/join|wc)\/(\d{9,12})/);
    if (!m) return null;
    const pwd = u.searchParams.get('pwd') || '';
    return 'zoommtg://zoom.us/join?action=join&confno=' + encodeURIComponent(m[1]) +
      (pwd ? '&pwd=' + encodeURIComponent(pwd) : '');
  } catch (_) { return null; }
}

/** True when the URL is an in-meeting web-client page (used for the mini player). */
function isInMeetingUrl(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/wc\/(?:join\/)?\d{9,12}(?:\/|$)/.test(p);
  } catch (_) { return false; }
}

/** Log-safe pattern: host + path with ids masked, never the query (passcodes). */
function maskUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.replace(/\d{6,}/g, '<n>').replace(/[A-Za-z0-9_-]{24,}/g, '<id>');
  } catch (_) { return '<invalid>'; }
}

module.exports = { normalizeJoinInput, toDeepLink, isAllowedNavUrl, isInMeetingUrl, isZoomHost, maskUrl, SSO_HOSTS };
