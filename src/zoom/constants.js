'use strict';
/**
 * src/zoom/constants.js — hosts, partition, allow-lists, timeouts and caps for the Zoom hub.
 *
 * Pure: no electron, no I/O. AUTH_HOST_RE / SIGNIN_PATH_RE are copied BY VALUE from
 * src/dev/dev-zoom-probe.js (a dev file that is never required from product code). They only
 * CLASSIFY "this looks like a sign-in page"; navigation is allowed only through isNavAllowed().
 */

const PORTAL_HOST = 'amazon.zoom.us';
const PORTAL_ORIGIN = 'https://amazon.zoom.us';
const PARTITION = 'persist:fleet-zoom';

const ZOOM_HOST_RE = /(^|\.)zoom\.us$/i;
const AUTH_HOST_RE = /midway|sso\.amazon|oidc|oauth|federate\.amazon|signin\.aws|login\.amazon|\/saml|\/signin|\/login\b/i;
const SIGNIN_PATH_RE = /\/(signin|login|saml)/i;

// Strict hostname allow-list for every navigation in Fleet's Zoom windows (https: only).
// The live run may add an exact host here, never a pattern.
const NAV_HOST_ALLOW = [/(^|\.)zoom\.us$/i, /(^|\.)amazon\.com$/i, /(^|\.)a2z\.com$/i, /(^|\.)amazon\.dev$/i];

/** parseUrl(x) -> URL | null. Never throws. */
function parseUrl(x) {
  try {
    if (x == null) return null;
    return new URL(String(x));
  } catch (_) {
    return null;
  }
}

/** isNavAllowed(url) -> true only for https: URLs whose hostname is on NAV_HOST_ALLOW. */
function isNavAllowed(url) {
  const u = parseUrl(url);
  if (!u || u.protocol !== 'https:') return false;
  const h = u.hostname;
  return NAV_HOST_ALLOW.some((re) => re.test(h));
}

/** hostKind(url) -> 'zoom' | 'auth' | 'other' (host class only, for logs). */
function hostKind(url) {
  const u = parseUrl(url);
  if (!u) return 'other';
  if (ZOOM_HOST_RE.test(u.hostname) && !SIGNIN_PATH_RE.test(u.pathname)) return 'zoom';
  if (AUTH_HOST_RE.test(u.hostname) || SIGNIN_PATH_RE.test(u.pathname)) return 'auth';
  return 'other';
}

// Timeouts (ms)
const NET_TIMEOUT_MS = 20_000;
const AUTH_WAIT_MS = 40_000;
const AUTH_POLL_MS = 500;
const CAPTURE_WAIT_MS = 30_000;
const CAPTURE_QUIET_MS = 1_500;
const SIGNIN_WINDOW_MS = 300_000;
const SIGNIN_SETTLE_MS = 1_000;
const IDLE_TEARDOWN_MS = 300_000;
const REWARM_MIN_INTERVAL_MS = 600_000;
const STATUS_CACHE_MS = 60_000;
const LIST_CACHE_MS = 120_000;

// Caps (bytes)
const GET_MAX_BYTES = 512 * 1024;
const CAPTURE_BODY_MAX_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

// Pages
const MEETINGS_UPCOMING_URL = PORTAL_ORIGIN + '/meeting#/upcoming';
const MEETINGS_PREVIOUS_URL = PORTAL_ORIGIN + '/meeting#/previous';
const RECORDINGS_URL = PORTAL_ORIGIN + '/recording';
const SCHEDULE_URL = PORTAL_ORIGIN + '/meeting/schedule';
const PROFILE_URL = PORTAL_ORIGIN + '/profile';
const SIGNIN_URL = PORTAL_ORIGIN + '/signin';

// Allow-lists (paths on PORTAL_ORIGIN)
const ALLOWED_GET = Object.freeze(['/nws/recording/1.0/recording-info', '/account/user/assistant_host']);
const ALLOWED_POST = Object.freeze(['/rest/meeting/list', '/nws/recording/1.0/host-list']);
const RECORDING_INFO_PATH = '/nws/recording/1.0/recording-info';
const MEETING_LIST_PATH = '/rest/meeting/list';
const RECORDING_LIST_PATH = '/nws/recording/1.0/host-list';

// pageKind -> { url, path } for capture and replay
const PAGE_KINDS = Object.freeze({
  upcoming: { url: MEETINGS_UPCOMING_URL, path: MEETING_LIST_PATH },
  previous: { url: MEETINGS_PREVIOUS_URL, path: MEETING_LIST_PATH },
  recordings: { url: RECORDINGS_URL, path: RECORDING_LIST_PATH },
});

// Filled from the live run; the sign-in regex in transport.classify covers the gap until then.
const AUTH_ERROR_CODES = new Set();

const CHALLENGE_PATH_RE = /\/cdn-cgi\/challenge-platform\//i;

module.exports = {
  PORTAL_HOST, PORTAL_ORIGIN, PARTITION,
  ZOOM_HOST_RE, AUTH_HOST_RE, SIGNIN_PATH_RE, NAV_HOST_ALLOW, CHALLENGE_PATH_RE,
  parseUrl, isNavAllowed, hostKind,
  NET_TIMEOUT_MS, AUTH_WAIT_MS, AUTH_POLL_MS, CAPTURE_WAIT_MS, CAPTURE_QUIET_MS, SIGNIN_WINDOW_MS, SIGNIN_SETTLE_MS,
  IDLE_TEARDOWN_MS, REWARM_MIN_INTERVAL_MS, STATUS_CACHE_MS, LIST_CACHE_MS,
  GET_MAX_BYTES, CAPTURE_BODY_MAX_BYTES, TRANSCRIPT_MAX_BYTES,
  MEETINGS_UPCOMING_URL, MEETINGS_PREVIOUS_URL, RECORDINGS_URL, SCHEDULE_URL, PROFILE_URL, SIGNIN_URL,
  ALLOWED_GET, ALLOWED_POST, RECORDING_INFO_PATH, MEETING_LIST_PATH, RECORDING_LIST_PATH, PAGE_KINDS,
  AUTH_ERROR_CODES,
};
