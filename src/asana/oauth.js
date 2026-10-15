'use strict';
/**
 * asana/oauth.js — Asana OAuth 2.0 (Authorization Code) for the desktop app.
 *
 * Flow (loopback redirect — Asana's standard desktop pattern):
 *   1. login() builds the authorize URL and opens it in the SYSTEM browser
 *      (shell.openExternal), then starts a short-lived loopback HTTP server on
 *      127.0.0.1:<port> that matches the registered redirect URI.
 *   2. Asana redirects back to http://localhost:<port>/auth/asana/callback?code=...
 *      The server captures the code, closes immediately (single-use), and the
 *      promise resolves.
 *   3. We exchange code -> { access_token, refresh_token, expires_in } and
 *      auto-discover the user (/users/me). Tokens are stored ENCRYPTED via
 *      security/credentials.js (OS keychain); only non-secret metadata (user
 *      list, active user, expiry) lives in the asanaOAuth store.
 *
 * Multi-user: each person logs in with their own Asana account. Tokens are
 * namespaced by userGid: asana.oauth.<userGid>.access / .refresh. The active
 * user gid is tracked in the asanaOAuth metadata store.
 *
 * SECURITY:
 *   - clientSecret + tokens never leave the main process. status() returns only
 *     { connected, user, email, gid, expiresAt } — never a token.
 *   - The loopback server binds 127.0.0.1 only, is single-use, and times out.
 *   - clientId/clientSecret are provided by the user via Settings (stored:
 *     clientId in asanaConfig, clientSecret ENCRYPTED in credentials.js).
 */

const https = require('https');
const http  = require('http');
const { URL, URLSearchParams } = require('url');

const store  = require('../store');
const creds  = require('../security/credentials');
const logger = require('../utils/logger')('asana:oauth');

const ASANA_AUTHORIZE_URL = 'https://app.asana.com/-/oauth_authorize';
const ASANA_TOKEN_URL     = 'https://app.asana.com/-/oauth_token';
const ASANA_API_BASE      = 'https://app.asana.com/api/1.0';

const DEFAULT_PORT    = 3000;
const CALLBACK_PATH   = '/auth/asana/callback';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;   // user has 3 min to complete consent
const REFRESH_SKEW_MS  = 60 * 1000;       // refresh 60s before expiry

// Credential-store key helpers (per-user, encrypted at rest).
const _accessKey  = (gid) => 'asana.oauth.' + gid + '.access';
const _refreshKey = (gid) => 'asana.oauth.' + gid + '.refresh';
const SECRET_KEY  = 'asana.oauth.clientSecret';

// ── OAuth app config (clientId public; clientSecret encrypted) ─────────────────
function _oauthConfig() {
  const cfg = store.load('asanaConfig', {}) || {};
  return {
    clientId:    cfg.oauthClientId || process.env.ASANA_OAUTH_CLIENT_ID || '',
    redirectUri: cfg.oauthRedirectUri || ('http://localhost:' + DEFAULT_PORT + CALLBACK_PATH),
    port:        _portFromRedirect(cfg.oauthRedirectUri) || DEFAULT_PORT,
  };
}

function _portFromRedirect(uri) {
  if (!uri) return null;
  try { const u = new URL(uri); return u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80); }
  catch (_) { return null; }
}

async function _getClientSecret() {
  const s = await creds.get(SECRET_KEY);
  return s || process.env.ASANA_OAUTH_CLIENT_SECRET || '';
}

/** Persist the OAuth app credentials from Settings. Secret is encrypted. */
async function saveOAuthConfig({ clientId, clientSecret, redirectUri } = {}) {
  const cfg = store.load('asanaConfig', {}) || {};
  if (typeof clientId === 'string' && clientId.trim())    cfg.oauthClientId = clientId.trim();
  if (typeof redirectUri === 'string' && redirectUri.trim()) cfg.oauthRedirectUri = redirectUri.trim();
  // authMode flips to 'oauth' once a client id is present.
  if (cfg.oauthClientId) cfg.authMode = 'oauth';
  store.save('asanaConfig', cfg);
  if (typeof clientSecret === 'string' && clientSecret.trim()) {
    await creds.set(SECRET_KEY, clientSecret.trim());
  }
  return { ok: true, configured: !!cfg.oauthClientId };
}

function isConfigured() {
  return !!_oauthConfig().clientId;
}

// ── Metadata store (non-secret): { activeGid, users: { gid: {...} } } ──────────
function _meta() {
  return store.load('asanaOAuth', { activeGid: null, users: {} }) || { activeGid: null, users: {} };
}
function _saveMeta(m) { store.save('asanaOAuth', m); }

// ── Low-level HTTPS JSON helper (matches client.js house style) ────────────────
function _httpsJson(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = body != null ? body : null;
    const opts = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method,
      headers:  Object.assign({ 'Accept': 'application/json' }, headers),
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : {}; } catch (e) { reject(new Error('Asana OAuth parse error: ' + e.message)); return; }
        if (res.statusCode >= 400) {
          const msg = (parsed && (parsed.error_description || parsed.error))
            || (parsed && parsed.errors && parsed.errors.map((x) => x.message).join(', '))
            || ('HTTP ' + res.statusCode);
          reject(new Error('Asana OAuth ' + res.statusCode + ': ' + msg));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', (e) => reject(new Error('Asana OAuth network error: ' + e.message)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Asana OAuth timeout (30s)')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── Authorize URL ──────────────────────────────────────────────────────────────
function _authorizeUrl(state) {
  const { clientId, redirectUri } = _oauthConfig();
  const p = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    state:         state,
  });
  return ASANA_AUTHORIZE_URL + '?' + p.toString();
}

// ── Loopback callback server (single-use, loopback-only, timed out) ────────────
function _awaitCallback(port, expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      let reqUrl;
      try { reqUrl = new URL(req.url, 'http://localhost:' + port); }
      catch (_) { res.writeHead(400); res.end('Bad request'); return; }
      if (reqUrl.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end('Not found'); return; }

      const code  = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const err   = reqUrl.searchParams.get('error');

      const done = (ok, payload) => {
        if (settled) return;
        settled = true;
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(_resultHtml(ok, payload));
        // close after the response flushes
        setImmediate(() => { try { server.close(); } catch (_) {} });
      };

      if (err) { done(false, 'Asana returned: ' + err); reject(new Error('OAuth error: ' + err)); return; }
      if (!code) { done(false, 'Missing authorization code'); reject(new Error('Missing authorization code')); return; }
      if (expectedState && state !== expectedState) {
        done(false, 'State mismatch (possible CSRF) — login aborted');
        reject(new Error('OAuth state mismatch'));
        return;
      }
      done(true, 'You can close this window and return to Fleet Ops.');
      resolve(code);
    });

    server.on('error', (e) => {
      if (!settled) { settled = true; reject(new Error('Callback server error: ' + e.message + (e.code === 'EADDRINUSE' ? ' (port ' + port + ' in use)' : ''))); }
    });

    // Bind loopback only — never expose on the network.
    server.listen(port, '127.0.0.1', () => {
      logger.info('OAuth callback server listening on 127.0.0.1:' + port);
    });

    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { server.close(); } catch (_) {} reject(new Error('Login timed out — no callback within ' + Math.round(LOGIN_TIMEOUT_MS / 1000) + 's')); }
    }, LOGIN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

function _resultHtml(ok, msg) {
  const title = ok ? '\u2705 Logged into Asana' : '\u26A0\uFE0F Asana login failed';
  const color = ok ? '#1b7f3b' : '#b23b3b';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title></head>'
    + '<body style="font-family:Arial,Helvetica,sans-serif;text-align:center;padding:60px;color:#0b1324">'
    + '<h1 style="color:' + color + '">' + title + '</h1>'
    + '<p style="font-size:15px;color:#334">' + String(msg || '') + '</p>'
    + '</body></html>';
}

// ── Token exchange + refresh ────────────────────────────────────────────────────
async function _exchangeCode(code) {
  const { clientId, redirectUri } = _oauthConfig();
  const clientSecret = await _getClientSecret();
  if (!clientId || !clientSecret) throw new Error('Asana OAuth not configured (missing client id or secret)');
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    code,
  }).toString();
  return _httpsJson(ASANA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
}

async function _refresh(gid) {
  const { clientId } = _oauthConfig();
  const clientSecret = await _getClientSecret();
  const refreshToken = await creds.get(_refreshKey(gid));
  if (!refreshToken) throw new Error('No refresh token for user ' + gid + ' — re-login required');
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();
  const tok = await _httpsJson(ASANA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  await creds.set(_accessKey(gid), tok.access_token);
  // Asana may issue a new refresh token on refresh; keep the latest.
  if (tok.refresh_token) await creds.set(_refreshKey(gid), tok.refresh_token);
  const m = _meta();
  if (m.users[gid]) {
    m.users[gid].expiresAt = Date.now() + (Number(tok.expires_in || 3600) * 1000);
    _saveMeta(m);
  }
  return tok.access_token;
}

async function _fetchMe(accessToken) {
  const json = await _httpsJson(ASANA_API_BASE + '/users/me', {
    headers: { 'Authorization': 'Bearer ' + accessToken },
  });
  return json && json.data ? json.data : {};
}

// ── Public: login (opens browser, awaits callback, stores tokens) ──────────────
async function login() {
  if (!isConfigured()) throw new Error('Asana OAuth not configured — set Client ID + Secret in Settings first');
  const clientSecret = await _getClientSecret();
  if (!clientSecret) throw new Error('Asana OAuth Client Secret missing — set it in Settings');

  const { port } = _oauthConfig();
  const state = require('crypto').randomBytes(16).toString('hex');

  // Start the callback listener BEFORE opening the browser so we never miss it.
  const codePromise = _awaitCallback(port, state);
  const { shell } = require('electron');
  await shell.openExternal(_authorizeUrl(state));
  logger.info('Opened Asana consent in system browser; awaiting callback...');

  const code = await codePromise;
  const tok  = await _exchangeCode(code);
  const me   = await _fetchMe(tok.access_token);
  const gid  = me.gid;
  if (!gid) throw new Error('Could not resolve Asana user after login');

  await creds.set(_accessKey(gid), tok.access_token);
  if (tok.refresh_token) await creds.set(_refreshKey(gid), tok.refresh_token);

  const m = _meta();
  m.users[gid] = {
    gid,
    name:  me.name || '',
    email: me.email || '',
    workspaceGid: (me.workspaces && me.workspaces[0] && me.workspaces[0].gid) || '',
    expiresAt: Date.now() + (Number(tok.expires_in || 3600) * 1000),
    linkedAt: new Date().toISOString(),
  };
  m.activeGid = gid;
  _saveMeta(m);

  logger.info('OAuth login complete for ' + (me.name || gid) + ' (' + (me.email || '') + ')');
  return { ok: true, user: me.name, email: me.email, gid };
}

// ── Public: get a valid access token for the active user (auto-refresh) ────────
async function getAccessToken() {
  const m = _meta();
  const gid = m.activeGid;
  if (!gid || !m.users[gid]) return null;
  const user = m.users[gid];
  if (user.expiresAt && Date.now() > (user.expiresAt - REFRESH_SKEW_MS)) {
    try { return await _refresh(gid); }
    catch (e) { logger.warn('Token refresh failed for ' + gid + ': ' + e.message); return null; }
  }
  return await creds.get(_accessKey(gid));
}

function isActive() {
  const m = _meta();
  return !!(m.activeGid && m.users[m.activeGid]);
}

// ── Public: status (NEVER returns a token) ─────────────────────────────────────
async function status() {
  const m = _meta();
  const configured = isConfigured();
  const clientId = _oauthConfig().clientId || '';   // public, safe to surface
  const gid = m.activeGid;
  const user = gid ? m.users[gid] : null;
  if (!user) return { ok: true, configured, clientId, connected: false, users: _listUsers(m) };
  return {
    ok: true,
    configured,
    clientId,
    connected: true,
    user:  user.name,
    email: user.email,
    gid:   user.gid,
    expiresAt: user.expiresAt || null,
    users: _listUsers(m),
  };
}

function _listUsers(m) {
  return Object.values(m.users || {}).map((u) => ({ gid: u.gid, name: u.name, email: u.email, active: u.gid === m.activeGid }));
}

/** Switch the active user (multi-user shared device). */
function switchUser(gid) {
  const m = _meta();
  if (!m.users[gid]) throw new Error('Asana user ' + gid + ' not logged in');
  m.activeGid = gid;
  _saveMeta(m);
  return { ok: true, activeGid: gid };
}

/** Log out the active (or a specific) user: wipe tokens + metadata entry. */
async function logout(gid) {
  const m = _meta();
  const target = gid || m.activeGid;
  if (!target) return { ok: true };
  try { await creds.delete(_accessKey(target)); } catch (_) {}
  try { await creds.delete(_refreshKey(target)); } catch (_) {}
  delete m.users[target];
  if (m.activeGid === target) {
    const remaining = Object.keys(m.users);
    m.activeGid = remaining.length ? remaining[0] : null;
  }
  _saveMeta(m);
  logger.info('OAuth logout for ' + target);
  return { ok: true, activeGid: m.activeGid };
}

module.exports = {
  isConfigured,
  isActive,
  saveOAuthConfig,
  login,
  logout,
  switchUser,
  status,
  getAccessToken,
};
