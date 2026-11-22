'use strict';
/**
 * src/aperia/constants.js — Aperia HALO Connect (amazon.aperiatech.com) constants. Pure, no requires.
 *
 * Every Aperia network call is user-initiated (a sign-in, a click or the opt-in alert watcher);
 * nothing here schedules anything. The client is READ-ONLY: GET only, never a write method.
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
// The issues poll stays as the fallback whenever the socket is not open.
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
  parseUrl, isApiUrl, isForbiddenPath, isPortalUrl,
};
