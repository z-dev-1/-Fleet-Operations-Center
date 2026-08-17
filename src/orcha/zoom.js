'use strict';
/**
 * src/orcha/zoom.js -- Zoom integration: Authorization-Code OAuth sign-in
 * (like window.slack.login), meeting list, Meeting SDK JWT signing, and a
 * lightweight reminder poller.
 *
 * Two separate Zoom Marketplace apps, two separate purposes:
 *
 *   1. OAuth app ("Sign in with Zoom") -- registered ONCE by whoever sets
 *      this app up. Yields zoom.clientId / zoom.clientSecret / a redirect
 *      URL. This is app registration, not a per-user secret -- comparable
 *      to Slack app credentials. After that one-time setup, actually
 *      connecting a Zoom account is a single "Sign in with Zoom" click
 *      (ipc zoom:login) that pops a real Zoom login window, exactly like
 *      slack:login -- no manual token pasting. The resulting refresh token
 *      is what lets listUpcomingMeetings() work for that signed-in user.
 *
 *   2. Meeting SDK app -- yields zoom.sdkKey / zoom.sdkSecret, used only to
 *      sign the JWT the embedded SDK needs to join a meeting. Unrelated to
 *      OAuth sign-in; there is no "sign in" analog for this one, it is a
 *      server-side app secret (never exposed to the renderer).
 *
 * https://developers.zoom.us/docs/integrations/oauth/ (Authorization Code)
 * https://developers.zoom.us/docs/meeting-sdk/auth/     (Meeting SDK JWT)
 */

const jwt     = require('jsonwebtoken');
const creds   = require('../security/credentials');
const logger  = require('../utils/logger')('orcha:zoom');

// -- OAuth app config (client id/secret/redirect -- see docblock) -----------

async function _getAppConfig() {
  const [clientId, clientSecret, redirectUri] = await Promise.all([
    creds.get('zoom.clientId'),
    creds.get('zoom.clientSecret'),
    creds.get('zoom.redirectUri'),
  ]);
  return { clientId, clientSecret, redirectUri: redirectUri || 'https://fleet-ops.local/oauth/zoom/callback' };
}

/** True once the one-time OAuth app registration (Client ID/Secret) is saved. */
async function isAppConfigured() {
  const { clientId, clientSecret } = await _getAppConfig();
  return !!(clientId && clientSecret);
}

/** True once a user has actually signed in (we hold a refresh token). */
async function isSignedIn() {
  const rt = await creds.get('zoom.refreshToken');
  return !!rt;
}

/** Returns true if the Meeting SDK (join) credentials are all present. */
async function hasSdkCredentials() {
  const [sdkKey, sdkSecret] = await Promise.all([creds.get('zoom.sdkKey'), creds.get('zoom.sdkSecret')]);
  return !!(sdkKey && sdkSecret);
}

async function logout() {
  await creds.delete('zoom.refreshToken');
  _tokenCache = null;
}

// -- Token exchange / refresh -------------------------------------------------

let _tokenCache = null; // { accessToken, expiresAt }

/** Exchanges an authorization `code` (from the Zoom sign-in redirect) for tokens. */
async function exchangeCodeForTokens(code, redirectUri) {
  const { clientId, clientSecret } = await _getAppConfig();
  if (!clientId || !clientSecret) throw new Error('Zoom OAuth app not configured (clientId/clientSecret)');
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token?grant_type=authorization_code&code=' + encodeURIComponent(code) +
    '&redirect_uri=' + encodeURIComponent(redirectUri), {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('Zoom sign-in failed (' + res.status + '): ' + (body.reason || body.error || 'unknown error'));
  }
  await creds.set('zoom.refreshToken', body.refresh_token);
  _tokenCache = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  logger.info('Zoom sign-in complete -- refresh token stored');
  return true;
}

async function _refreshAccessToken() {
  const { clientId, clientSecret } = await _getAppConfig();
  const refreshToken = await creds.get('zoom.refreshToken');
  if (!clientId || !clientSecret) throw new Error('Zoom OAuth app not configured (clientId/clientSecret)');
  if (!refreshToken) throw new Error('Not signed in to Zoom -- use "Sign in with Zoom" first');
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://zoom.us/oauth/token?grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken), {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('Zoom token refresh failed (' + res.status + '): ' + (body.reason || body.error || 'unknown error'));
  }
  // Zoom rotates the refresh token on every use -- must persist the new one.
  if (body.refresh_token) await creds.set('zoom.refreshToken', body.refresh_token);
  _tokenCache = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return _tokenCache.accessToken;
}

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60000) return _tokenCache.accessToken;
  return await _refreshAccessToken();
}

/**
 * Lists the signed-in user's upcoming scheduled meetings.
 * https://developers.zoom.us/docs/api/meetings/#tag/meetings/GET/users/{userId}/meetings
 */
async function listUpcomingMeetings() {
  const token = await getAccessToken();
  const res = await fetch('https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=100', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn('listUpcomingMeetings failed:', res.status, body.message || '(no message)');
    throw new Error('Zoom list-meetings failed (' + res.status + '): ' + (body.message || 'unknown error'));
  }
  return Array.isArray(body.meetings) ? body.meetings : [];
}

// -- Meeting SDK JWT (join signature) ----------------------------------------

/**
 * Generates a Meeting SDK JWT ("signature") for joining a meeting from the
 * embedded web SDK. Signed server-side with the SDK Secret -- the secret
 * itself never leaves the main process.
 *
 * @param {string|number} meetingNumber
 * @param {number} [role] 0 = participant (default), 1 = host. Only 0 is
 *   valid without an accompanying ZAK token (see Zoom docs) -- this app
 *   does not implement ZAK/host-start, so callers should not pass 1.
 */
async function generateJoinSignature(meetingNumber, role) {
  if (role === undefined) role = 0;
  const [sdkKey, sdkSecret] = await Promise.all([creds.get('zoom.sdkKey'), creds.get('zoom.sdkSecret')]);
  if (!sdkKey || !sdkSecret) {
    throw new Error('Zoom Meeting SDK credentials not configured (sdkKey/sdkSecret)');
  }
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2; // 2 hours -- well within Zoom's 30min-48h window
  const payload = {
    appKey: sdkKey,
    mn: String(meetingNumber),
    role: role,
    iat: iat,
    exp: exp,
    tokenExp: exp,
  };
  const signature = jwt.sign(payload, sdkSecret, { algorithm: 'HS256' });
  return { signature: signature, sdkKey: sdkKey };
}

// -- Reminder poller ----------------------------------------------------------

let _pollTimer = null;
const _notified = new Set(); // meeting IDs already reminded this app session

/**
 * Starts a background poller that checks the signed-in user's upcoming
 * meetings every `intervalMs` and invokes `onReminder(meeting)` once for
 * each meeting whose start time falls within `leadMinutes` of now.
 * Dedup is in-memory only (per app session) -- acceptable since a fresh
 * restart simply re-polls and would only re-notify for meetings still
 * genuinely upcoming.
 *
 * @param {{ leadMinutes?: number, intervalMs?: number, onReminder: (meeting: object) => void }} opts
 */
function startReminderPoller(opts) {
  opts = opts || {};
  const onReminder = opts.onReminder;
  const leadMinutes = opts.leadMinutes === undefined ? 5 : opts.leadMinutes;
  const intervalMs = opts.intervalMs === undefined ? 60000 : opts.intervalMs;
  if (typeof onReminder !== 'function') throw new Error('startReminderPoller requires onReminder(meeting)');
  if (_pollTimer) clearInterval(_pollTimer);

  const tick = async () => {
    try {
      if (!(await isSignedIn())) return; // not signed in yet -- silently skip
      const meetings = await listUpcomingMeetings();
      const now = Date.now();
      for (const m of meetings) {
        if (!m.start_time || !m.id) continue;
        const startMs = new Date(m.start_time).getTime();
        const msUntil = startMs - now;
        if (msUntil <= leadMinutes * 60000 && msUntil > -60000 && !_notified.has(m.id)) {
          _notified.add(m.id);
          onReminder(m);
        }
      }
    } catch (e) {
      logger.warn('reminder poll failed:', e.message);
    }
  };

  _pollTimer = setInterval(tick, intervalMs);
  if (_pollTimer.unref) _pollTimer.unref();
  tick(); // fire once immediately on startup
  logger.info('Zoom reminder poller started (leadMinutes=' + leadMinutes + ', intervalMs=' + intervalMs + ')');
}

function stopReminderPoller() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

module.exports = {
  isAppConfigured: isAppConfigured,
  isSignedIn: isSignedIn,
  hasSdkCredentials: hasSdkCredentials,
  logout: logout,
  exchangeCodeForTokens: exchangeCodeForTokens,
  getAccessToken: getAccessToken,
  listUpcomingMeetings: listUpcomingMeetings,
  generateJoinSignature: generateJoinSignature,
  startReminderPoller: startReminderPoller,
  stopReminderPoller: stopReminderPoller,
};
