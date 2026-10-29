'use strict';
/**
 * rca/midway_token.js — mint a Midway OIDC id_token for a relying party
 * straight from the app's Midway session (~/.midway/cookie, written by mwinit).
 *
 * GET https://midway-auth.amazon.com/SSO?response_type=id_token&scope=openid
 *     &client_id=<rp>&redirect_uri=<rp origin>/&nonce=<random>
 * with the Midway cookies returns the raw JWT as the body. This is the same
 * call AAP's openid.xhr library makes in the browser; doing it here means no
 * hidden window and no login page — it uses the app's existing auth.
 *
 * VERIFIED 2026-10-27: when the session lacks the full Midway sign-in
 * (e.g. only an AEA refresh), Midway answers 401 "More authentication needed"
 * with step_up_methods [LDAPSuccess present:false]. That is surfaced as
 * MIDWAY_STEPUP_REQUIRED — a full `mwinit` fixes it.
 *
 * Tokens live in memory only (never logged or persisted) and are reused until
 * shortly before they expire (~15 min TTL).
 *
 * 2026-10-28: minted FIRST inside the app's live AAP page (same session as
 * every AAP API call); the cookie-file request below is only a fallback.
 */

const https = require('https');
const crypto = require('crypto');
const logger = require('../utils/logger')('rca');

const _cache = new Map(); // clientId -> { token, exp }
const EARLY_MS = 90 * 1000;

// FIX (2026-10-28): the AEA cookie in ~/.midway/cookie is only as fresh as
// the last mwinit (~2h), so RCA started failing with "Midway /SSO HTTP 403"
// once it lapsed, even though the app kept working. The app itself keeps AEA
// fresh from the ACME posture token (auth.js injectAeaFromPostureToken + the
// aea-keepalive). Use that SAME live token as the AEA cookie here; fall back
// to the file's AEA only if the posture token is unreadable/expired.
function _freshAea(auth) {
  try {
    const min = auth.postureTokenExpiryMin();
    if (min == null || min <= 0) return null;
    const t = require('fs').readFileSync(auth.ACME_POSTURE_TOKEN, 'utf8').trim();
    return t && t.split('.').length === 3 ? t : null;
  } catch (_) { return null; }
}

function _cookieHeader() {
  const auth = require('../scrapers/auth');
  const { cookies } = auth.parseMidwayCookies();
  // Cookies Midway itself accepts: midway-auth.amazon.com and parent .amazon.com.
  let ok = cookies.filter((c) => /(^|\.)midway-auth\.amazon\.com$|^\.?amazon\.com$/i.test(String(c.domain || '').replace(/^\./, '')));
  if (!ok.some((c) => c.name === 'session' || c.name === '__Host-session')) {
    throw Object.assign(new Error('No Midway session in ~/.midway/cookie — run mwinit'), { code: 'MIDWAY_SESSION_INVALID' });
  }
  const aea = _freshAea(auth);
  if (aea) {
    ok = ok.filter((c) => c.name !== 'amazon_enterprise_access');
    ok.push({ name: 'amazon_enterprise_access', value: aea });
  }
  return ok.map((c) => c.name + '=' + c.value).join('; ');
}

function _claims(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return null; }
}

function _fetchToken(clientId) {
  const origin = 'https://' + clientId;
  const q = new URLSearchParams({
    response_type: 'id_token', scope: 'openid', client_id: clientId,
    redirect_uri: origin + '/', nonce: crypto.randomBytes(16).toString('hex'),
  });
  const headers = { Cookie: _cookieHeader(), Accept: '*/*', Origin: origin, Referer: origin + '/' };
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'midway-auth.amazon.com', path: '/SSO?' + q.toString(), method: 'GET', headers, timeout: 20000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 100000) req.destroy(); });
      res.on('end', () => {
        const t = body.trim();
        if (res.statusCode === 200 && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) return resolve(t);
        let msg = 'Midway /SSO HTTP ' + res.statusCode;
        let code = 'MIDWAY_TOKEN_FAILED';
        try {
          const j = JSON.parse(t);
          if (j && j.message) msg = 'Midway: ' + j.message;
          if (Array.isArray(j && j.step_up_methods) && j.step_up_methods.some((m) => m && m.present === false)) {
            code = 'MIDWAY_STEPUP_REQUIRED';
            msg = 'Midway needs a full sign-in for this (the current session only has an AEA refresh). Run mwinit, then try again.';
          }
        } catch (_) {
          if (res.statusCode === 302 || /login/i.test(String(res.headers.location || ''))) code = 'MIDWAY_STEPUP_REQUIRED';
        }
        reject(Object.assign(new Error(msg), { code, status: res.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Midway /SSO timed out'), { code: 'MIDWAY_TOKEN_FAILED' })));
    req.on('error', (e) => reject(Object.assign(e, { code: e.code || 'MIDWAY_TOKEN_FAILED' })));
    req.end();
  });
}

// PRIMARY PATH (2026-10-28): mint the token INSIDE the app's live, logged-in
// AAP page -- the same session the whole app's AAP API runs on (startup
// login, AEA keepalive, auth supervisor recovery). This is exactly the call
// AAP's own page makes (openid.xhr), so RCA is only ever as logged-in as the
// app itself, never behind it because a cookie FILE went stale.
function _ssoScript(clientId) {
  const origin = 'https://' + clientId;
  const q = new URLSearchParams({
    response_type: 'id_token', scope: 'openid', client_id: clientId,
    redirect_uri: origin + '/', nonce: crypto.randomBytes(16).toString('hex'),
  });
  return `(async function () {
    try {
      var r = await fetch(${JSON.stringify('https://midway-auth.amazon.com/SSO?' + q.toString())},
        { credentials: 'include', headers: { 'Accept': '*/*' } });
      var t = String(await r.text()).trim();
      return { status: r.status, token: /^eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+$/.test(t) ? t : null, body: /^eyJ/.test(t) ? '' : t.slice(0, 300) };
    } catch (e) { return { status: 0, error: String(e && e.message || e) }; }
  })()`;
}

async function _fetchTokenViaApp(clientId, deps) {
  const aap = deps.aap || require('../scrapers/aap_api');
  if (!aap || typeof aap.evaluateInPage !== 'function') throw new Error('app AAP session unavailable');
  // Only the aap-na page can mint for its own origin.
  if (!/^aap-na\.corp\.amazon\.com$/i.test(clientId)) throw new Error('in-app mint only for aap-na');
  const r = await aap.evaluateInPage(_ssoScript(clientId));
  if (r && r.status === 200 && r.token) return r.token;
  throw Object.assign(new Error('in-app Midway /SSO ' + (r && r.status) + (r && (r.error || r.body) ? ': ' + String(r.error || r.body).slice(0, 160) : '')),
    { code: 'MIDWAY_TOKEN_FAILED', status: r && r.status });
}

/** getIdToken(clientId, { force }) -> JWT string (from cache when still fresh). */
async function getIdToken(clientId, opts = {}, deps = {}) {
  const c = _cache.get(clientId);
  if (!opts.force && c && Date.now() < c.exp - EARLY_MS) return c.token;
  let token, via;
  try {
    token = await _fetchTokenViaApp(clientId, deps);
    via = 'app session';
  } catch (appErr) {
    // Fallback: cookie file + fresh AEA from the ACME posture token.
    logger.warn('[rca] in-app token mint failed (' + appErr.message + ') -- falling back to cookie file');
    token = await (deps.fetchFromFile || _fetchToken)(clientId);
    via = 'cookie file';
  }
  const cl = _claims(token);
  const exp = cl && cl.exp ? cl.exp * 1000 : Date.now() + 10 * 60 * 1000;
  _cache.set(clientId, { token, exp });
  logger.info('[rca] minted Midway token for ' + clientId + ' via ' + via + ' (valid ' + Math.round((exp - Date.now()) / 60000) + ' min)');
  return token;
}

function clear(clientId) { if (clientId) _cache.delete(clientId); else _cache.clear(); }

module.exports = { getIdToken, clear };
