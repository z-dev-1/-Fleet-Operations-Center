'use strict';
/**
 * src/aperia/constants.js — Aperia HALO Connect (amazon.aperiatech.com) constants. Pure, no requires.
 *
 * Aperia network calls come from a user action (a sign-in, a click or the opt-in alert watcher) or the
 * gated background sign-in (src/aperia/auto-auth.js); nothing here schedules anything. The client is
 * READ-ONLY: GET only, never a write method.
 */
const HOST = 'amazon.aperiatech.com';
const BASE_URL = 'https://amazon.aperiatech.com';
const PORTAL_URL = BASE_URL + '/';
const API_PREFIX = '/api/v1/';
// Dedicated partition (task brief). Not the Split View vendor partition persist:vendor-aperia.
const PARTITION = 'persist:aperia';
const PAGE_SIZE = 500;

// ── REST (confirmed by read-only discovery, task brief "CONFIRMED API shapes") ──
const VEHICLES_PATH = '/api/v1/vehicles';
const ISSUES_BY_VEHICLE_PATH = '/api/v1/issues/by/vehicle';
const VEHICLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function _page(n) { const p = Number(n); return Number.isInteger(p) && p >= 0 ? p : 0; }

/** vehiclesPath(page) -> '/api/v1/vehicles?page=N&size=500' (rows in `vehicles`). */
function vehiclesPath(page) { return VEHICLES_PATH + '?page=' + _page(page) + '&size=' + PAGE_SIZE; }

/** vehiclePath(id) -> '/api/v1/vehicles/{id}' | null when the id is not a plain id. */
function vehiclePath(id) {
  const s = String(id == null ? '' : id).trim();
  return VEHICLE_ID_RE.test(s) ? VEHICLES_PATH + '/' + encodeURIComponent(s) : null;
}

/** issuesByVehiclePath(page) -> the active-issues feed URL from the brief (rows in `content`). */
function issuesByVehiclePath(page) {
  return ISSUES_BY_VEHICLE_PATH + '?page=' + _page(page) + '&size=' + PAGE_SIZE
    + '&withActiveIssuesOnly=true&showOnlyMyVehicles=FALSE'
    + '&sort=issueSummary.maxSeverity,desc&sort=issueSummary.maxDateDetected,desc';
}

// ── WebSocket (alert push) ──
// LIVE DISCOVERY 2026-11-22 (src/dev/dev-aperia-probe.js run + the portal bundle assets/index-HrKNpJjF.js):
//  - Socket: wss://amazon.aperiatech.com/api/ws/events?x-authorization=<JWT>, handshake 101. The JWT is
//    the portal's own `auth_token` (localStorage), set from the Authorization response header of the
//    portal's sign-in (POST /api/v1/login, OTP validate, or SSO /auth-code/exchange). Claims: sub,
//    sessionId, isMfaEnabled, scope=WEB, iat, nbf, exp; lifetime 720h. It must never be logged or stored.
//  - Token mint: NONE. There is no WS-token mint endpoint. /api/v1/notifications/{id} is the alert-SETTINGS
//    resource (GET by id, PUT update), so GET /api/v1/notifications/token is a GET-by-id with a bad id
//    (400 VALIDATION_FAILED). Never call it. The token is captured passively from the portal's own socket
//    URL (CDP Network.webSocketCreated) in the sign-in window.
//  - Client keepalive: send the text `__ping__` every 30 s; the server answers `__pong__`. The portal stops
//    reconnecting after 10 unclean closes.
//  - Message: a JSON text frame `{ type, data }`. Alert types: NEW_ISSUE, SEVERITY_CHANGE (the portal
//    ignores ISSUE_CSV_GENERATED). data fields the portal reads: id (issue id), severity
//    (CRITICAL|MAJOR|MINOR), type (issue state, e.g. UNDERINFLATION), vehicle.id, vehicle.fleetVehicleId.
//    positionName and account.name are NOT read from the frame: get them from GET /api/v1/vehicles/{id}
//    (sensors[].issue.id -> positionName, account.name). No alert frame arrived during the 3-minute watch,
//    so this format comes from the portal's consumer code, not an observed frame.
const WS_URL = 'wss://amazon.aperiatech.com/api/ws/events';
const WS_PATH = '/api/ws/events';
const WS_TOKEN_PARAM = 'x-authorization';
const WS_MINT_PATH = null; // UNDETERMINED by design: no mint exists (see above). Not /api/v1/notifications/token.
const WS_MINT_CONFIRMED = false;
const WS_TOKEN_SOURCE = 'portal-socket-url'; // passive capture only; never minted by this app
const WS_PING = '__ping__';
const WS_PONG = '__pong__';
const WS_PING_MS = 30e3;
const WS_MAX_RECONNECTS = 10;
const WS_EVENT_TYPES = Object.freeze({ NEW_ISSUE: 'NEW_ISSUE', SEVERITY_CHANGE: 'SEVERITY_CHANGE', ISSUE_CSV_GENERATED: 'ISSUE_CSV_GENERATED' });
const WS_ALERT_TYPES = Object.freeze(['NEW_ISSUE', 'SEVERITY_CHANGE']);
// WS-first watcher allowed: the token is captured passively (no mint) and the frame format is known.
// The issues poll runs on every watcher tick, socket open or not (the frame format is unverified live).
const APERIA_WS_ENABLED = true;

// ── Forbidden ──
// Never called: /tires and /sensors (405), /pressures and /telemetry (404).
const FORBIDDEN_PATH_RES = Object.freeze([
  /^\/api\/v1\/vehicles\/[^/]+\/tires(\/|$)/i,
  /^\/api\/v1\/vehicles\/[^/]+\/sensors(\/|$)/i,
  /^\/api\/v1\/vehicles\/[^/]+\/pressures(\/|$)/i,
  /^\/api\/v1\/vehicles\/[^/]+\/telemetry(\/|$)/i,
]);
const FORBIDDEN_ENDPOINTS = Object.freeze([
  '/api/v1/vehicles/{id}/tires', '/api/v1/vehicles/{id}/sensors', '/api/v1/vehicles/{id}/pressures', '/api/v1/vehicles/{id}/telemetry',
]);
const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_METHODS = Object.freeze(['GET']);

// ── Timing ──
const SIGNIN_WINDOW_MS = 10 * 60e3;
const FETCH_TIMEOUT_MS = 30e3;
const MAX_BODY_BYTES = 40 * 1024 * 1024;

// ── Client core ──
const CONCURRENCY = 6;
const INDEX_TTL_MS = 6 * 3600e3;
const INDEX_MISS_REBUILD_MS = 15 * 60e3;
const REAUTH_WAIT_MS = 120e3;
// Background sign-in (Phase E, src/aperia/auto-auth.js + session.backgroundLogin): a hidden window on the
// portal with the stored-credential auto-login. Same rate limits as DTNA (src/utils/auth-retry-gate.js).
const BG_LOGIN_WAIT_MS = 60e3;
const BG_STARTUP_DELAY_MS = 25e3;
const BG_MIN_GAP_MS = 2 * 60e3;
const BG_FAIL_COOLDOWN_MS = 5 * 60e3;
const BG_ACTION_COOLDOWN_MS = 30 * 60e3;
// After the Bearer is captured the hidden window stays up to this long for the portal's own alert
// socket, so its x-authorization token is captured too (the opt-in watcher's WS path).
const BG_WS_GRACE_MS = 10e3;
const MAX_PAGES = 100;
const BULK_MAX = 500;
const UNIT_MAX = 40;

// ── Tire / GPS rules ──
const STALE_MS = 7 * 24 * 3600e3;
const CRITICAL_RATIO = 0.8;
const LOW_RATIO = 0.9;
const HIGH_RATIO = 1.1;
const PLACEHOLDER_GPS = Object.freeze({ lat: -11.11111, lng: 11.11111 });
const GPS_EPS = 1e-4;
const US_BOX = Object.freeze({ latMin: 24, latMax: 50, lngMin: -125, lngMax: -66 });

// ── Alert watcher ──
const ALERT_POLL_DEFAULT_MIN = 5;
const ALERT_POLL_MIN = 1;
const ALERT_POLL_MAX = 60;
const SEEN_FILE = 'aperia_seen_alerts.json';
const SEEN_MAX_AGE_MS = 60 * 24 * 3600e3;
const SEEN_MAX = 50000;
const TZ = 'America/New_York';
const WS_OPEN_TIMEOUT_MS = 15e3;

/** isAllowedApiPath(pathname) -> true only for /api/v1/vehicles, /api/v1/vehicles/{id}, /api/v1/issues/by/vehicle. */
function isAllowedApiPath(pathname) {
  const p = String(pathname || '').split('?')[0];
  if (p === VEHICLES_PATH || p === ISSUES_BY_VEHICLE_PATH) return true;
  return /^\/api\/v1\/vehicles\/[A-Za-z0-9_-]{1,64}$/.test(p);
}

/** parseUrl(s) -> URL | null. */
function parseUrl(s) { try { return new URL(String(s || '')); } catch (_) { return null; } }

/** isApiUrl(url) -> true for https://amazon.aperiatech.com/api/v1/* only. */
function isApiUrl(url) {
  const u = parseUrl(url);
  return !!u && u.protocol === 'https:' && u.hostname === HOST && u.pathname.startsWith(API_PREFIX);
}

/** isForbiddenPath(pathname) -> true for the never-call endpoints. */
function isForbiddenPath(pathname) {
  const p = String(pathname || '').split('?')[0];
  return FORBIDDEN_PATH_RES.some((re) => re.test(p));
}

/** isPortalUrl(url) -> https on the Aperia host (navigation allow-list for the sign-in window). */
function isPortalUrl(url) {
  const u = parseUrl(url);
  return !!u && u.protocol === 'https:' && u.hostname === HOST;
}

module.exports = {
  HOST, BASE_URL, PORTAL_URL, API_PREFIX, PARTITION, PAGE_SIZE,
  VEHICLES_PATH, ISSUES_BY_VEHICLE_PATH, VEHICLE_ID_RE, vehiclesPath, vehiclePath, issuesByVehiclePath,
  WS_URL, WS_PATH, WS_TOKEN_PARAM, WS_MINT_PATH, WS_MINT_CONFIRMED, WS_TOKEN_SOURCE,
  WS_PING, WS_PONG, WS_PING_MS, WS_MAX_RECONNECTS, WS_EVENT_TYPES, WS_ALERT_TYPES, APERIA_WS_ENABLED,
  FORBIDDEN_PATH_RES, FORBIDDEN_ENDPOINTS, WRITE_METHODS, ALLOWED_METHODS,
  SIGNIN_WINDOW_MS, FETCH_TIMEOUT_MS, MAX_BODY_BYTES,
  CONCURRENCY, INDEX_TTL_MS, INDEX_MISS_REBUILD_MS, REAUTH_WAIT_MS, MAX_PAGES, BULK_MAX, UNIT_MAX,
  BG_LOGIN_WAIT_MS, BG_STARTUP_DELAY_MS, BG_MIN_GAP_MS, BG_FAIL_COOLDOWN_MS, BG_ACTION_COOLDOWN_MS, BG_WS_GRACE_MS,
  STALE_MS, CRITICAL_RATIO, LOW_RATIO, HIGH_RATIO, PLACEHOLDER_GPS, GPS_EPS, US_BOX,
  ALERT_POLL_DEFAULT_MIN, ALERT_POLL_MIN, ALERT_POLL_MAX, SEEN_FILE, SEEN_MAX_AGE_MS, SEEN_MAX, TZ, WS_OPEN_TIMEOUT_MS,
  parseUrl, isApiUrl, isForbiddenPath, isPortalUrl, isAllowedApiPath,
};
