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
 */

const https = require('https');
const crypto = require('crypto');
const logger = require('../utils/logger')('rca');

const _cache = new Map(); // clientId -> { token, exp }
const EARLY_MS = 90 * 1000;

function _cookieHeader() {
  const { parseMidwayCookies } = require('../scrapers/auth');
  const { cookies } = parseMidwayCookies();
  // Cookies Midway itself accepts: midway-auth.amazon.com and parent .amazon.com.
  const ok = cookies.filter((c) => /(^|\.)midway-auth\.amazon\.com$|^\.?amazon\.com$/i.test(String(c.domain || '').replace(/^\./, '')));
  if (!ok.some((c) => c.name === 'session' || c.name === '__Host-session')) {
    throw Object.assign(new Error('No Midway session in ~/.midway/cookie — run mwinit'), { code: 'MIDWAY_SESSION_INVALID' });
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

/** getIdToken(clientId, { force }) -> JWT string (from cache when still fresh). */
async function getIdToken(clientId, opts = {}) {
  const c = _cache.get(clientId);
  if (!opts.force && c && Date.now() < c.exp - EARLY_MS) return c.token;
  const token = await _fetchToken(clientId);
  const cl = _claims(token);
  const exp = cl && cl.exp ? cl.exp * 1000 : Date.now() + 10 * 60 * 1000;
  _cache.set(clientId, { token, exp });
  logger.info('[rca] minted Midway token for ' + clientId + ' (valid ' + Math.round((exp - Date.now()) / 60000) + ' min)');
  return token;
}

function clear(clientId) { if (clientId) _cache.delete(clientId); else _cache.clear(); }

module.exports = { getIdToken, clear };
