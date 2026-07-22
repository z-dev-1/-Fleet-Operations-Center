'use strict';
/**
 * graph/client.js — Microsoft Graph mail client (delegated user auth via MSAL)
 *
 * WHY THIS EXISTS (2026-07-21): the previous send paths were both fragile
 * for this team's actual usage:
 *   - SMTP (email_sender.js, ballard.amazon.com:1587) requires VPN, and the
 *     user is "almost never on VPN" -- a hard blocker, not an inconvenience.
 *   - Pasting the built HTML into OWA's web compose editor (misc.js's
 *     email:compose) routes through OWA's own paste-time sanitizer, which
 *     strips color combinations it doesn't like (confirmed live: white
 *     header/section text on dark backgrounds reverted to black on paste).
 *     A verified test send via Microsoft Graph's sendMail endpoint rendered
 *     the exact same HTML perfectly -- because sendMail delivers a finished
 *     message directly, never touching OWA's compose UI or its sanitizer.
 *
 * This client authenticates the SIGNED-IN USER (delegated permissions,
 * Mail.Send) via MSAL's interactive authorization-code flow, using the
 * standard Microsoft-provided native-app redirect URI
 * (https://login.microsoftonline.com/common/oauth2/nativeclient) -- no
 * local HTTP server, no custom URI scheme registration needed. Sign-in UX
 * matches this app's existing Slack integration (src/ipc/slack.js): open a
 * BrowserWindow, watch for the redirect, capture the result, close it.
 *
 * PORTABILITY (per requirement: nothing hardcoded that needs PER-USER setup,
 * must work identically when this app is installed on any teammate's
 * laptop):
 *   - CLIENT_ID below is NOT a secret. For public/native OAuth clients,
 *     Microsoft's own guidance is that the client ID ships inside the
 *     distributed app (same class of constant as this codebase's existing
 *     SP_SITE / AAP_PROBE_URL hardcoded values) -- every teammate's install
 *     uses the SAME client ID; nothing per-user to configure there.
 *   - What IS per-user, unavoidably, by design: each person signs in with
 *     their OWN Microsoft account once (like signing into Slack/Teams).
 *     After that, MSAL's cached refresh token renews silently in the
 *     background -- no repeated prompts under normal use.
 *   - REQUIRES: a one-time Azure AD app registration to obtain a real
 *     CLIENT_ID (public client, "Mobile and desktop applications" platform,
 *     redirect URI = the nativeclient URI above, delegated permission
 *     Mail.Send). This is an org-admin action outside what this codebase
 *     or an AI agent can perform -- replace the placeholder below once
 *     that registration exists.
 */

const { BrowserWindow } = require('electron');
const https = require('https');
const creds = require('../security/credentials');
const logger = require('../utils/logger')('graph:client');

// ── Azure AD app registration ────────────────────────────────────────────
// PLACEHOLDER — replace with the real Client ID once an Azure AD app has
// been registered (see file header comment). Not a secret; safe to embed.
const CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'REPLACE_WITH_REAL_CLIENT_ID';
const TENANT = process.env.GRAPH_TENANT || 'organizations'; // any Microsoft work/school account
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}`;
const REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const SCOPES = ['Mail.Send', 'User.Read'];

function isConfigured() {
  return !!CLIENT_ID && CLIENT_ID !== 'REPLACE_WITH_REAL_CLIENT_ID';
}

// ── Persistent token cache, backed by this app's existing encrypted
//    credential store (same OS-keychain-backed mechanism Slack's token
//    already uses) — NOT plaintext JSON on disk. ──────────────────────────
const CACHE_KEY = 'graph.msalTokenCache';
const cachePlugin = {
  beforeCacheAccess: async (ctx) => {
    const cached = await creds.get(CACHE_KEY);
    if (cached) ctx.tokenCache.deserialize(cached);
  },
  afterCacheAccess: async (ctx) => {
    if (ctx.cacheHasChanged) {
      await creds.set(CACHE_KEY, ctx.tokenCache.serialize());
    }
  },
};

let _pca = null;
function getPCA() {
  if (_pca) return _pca;
  const { PublicClientApplication } = require('@azure/msal-node');
  _pca = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin },
  });
  return _pca;
}

async function getCachedAccount() {
  const pca = getPCA();
  const accounts = await pca.getTokenCache().getAllAccounts();
  return accounts[0] || null;
}

async function isSignedIn() {
  if (!isConfigured()) return false;
  const account = await getCachedAccount();
  return !!account;
}

// ── Silent token acquisition — uses the cached refresh token, renews
//    automatically in the background, no user interaction. This is the
//    call every real send should try FIRST. ──────────────────────────────
async function getAccessTokenSilent() {
  const pca = getPCA();
  const account = await getCachedAccount();
  if (!account) return null;
  try {
    const result = await pca.acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  } catch (e) {
    logger.warn('[Graph] Silent token acquisition failed (may need interactive sign-in):', e.message);
    return null;
  }
}

// ── Interactive sign-in — one-time per user, opens a BrowserWindow (same
//    UX pattern as this app's existing Slack sign-in). ────────────────────
function signInInteractive() {
  if (!isConfigured()) {
    return Promise.reject(new Error('Graph mail is not configured yet — an Azure AD app registration (Client ID) is required. See src/graph/client.js header comment.'));
  }
  return new Promise((resolve, reject) => {
    const pca = getPCA();
    pca.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI }).then((authUrl) => {
      const win = new BrowserWindow({
        width: 900, height: 700, title: 'Sign in to Outlook (Microsoft)',
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:graph-signin' },
      });
      win.setMenuBarVisibility(false);

      let settled = false;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        try { win.close(); } catch (_) {}
        err ? reject(err) : resolve(val);
      };

      const tryExtractCode = (url) => {
        if (!url.startsWith(REDIRECT_URI)) return;
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
        if (error) { finish(new Error('Microsoft sign-in error: ' + error)); return; }
        if (!code) return;
        pca.acquireTokenByCode({ code, scopes: SCOPES, redirectUri: REDIRECT_URI })
          .then((result) => {
            logger.info('[Graph] Signed in successfully:', result.account && result.account.username);
            finish(null, { ok: true, account: result.account && result.account.username });
          })
          .catch((e) => finish(e));
      };

      win.webContents.on('will-redirect', (_e, url) => tryExtractCode(url));
      win.webContents.on('did-navigate', (_e, url) => tryExtractCode(url));
      win.on('closed', () => finish(new Error('Sign-in window closed before completing')));
      win.loadURL(authUrl);
    }).catch(reject);
  });
}

async function signOut() {
  const pca = getPCA();
  const account = await getCachedAccount();
  if (account) await pca.getTokenCache().removeAccount(account);
  await creds.delete(CACHE_KEY);
  return { ok: true };
}

// ── Send mail via Graph's /me/sendMail — delivers a finished message
//    directly; never touches OWA's compose UI, so nothing can sanitize or
//    strip inline styles/colors. ──────────────────────────────────────────
function toRecipientList(addrs) {
  return (addrs || '').split(/[;,]/).map((a) => a.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
}

async function sendMail({ to, cc, bcc, subject, htmlBody }) {
  let token = await getAccessTokenSilent();
  if (!token) {
    throw Object.assign(new Error('Not signed in to Outlook (Microsoft). Go to Settings → Accounts → Outlook and sign in.'), { code: 'GRAPH_NOT_SIGNED_IN' });
  }

  const payload = JSON.stringify({
    message: {
      subject: subject || '',
      body: { contentType: 'HTML', content: htmlBody || '' },
      toRecipients: toRecipientList(to),
      ccRecipients: toRecipientList(cc),
      bccRecipients: toRecipientList(bcc),
    },
    saveToSentItems: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.microsoft.com', path: '/v1.0/me/sendMail', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info('[Graph] Mail sent successfully to', to);
          resolve({ ok: true });
        } else {
          reject(new Error('Graph sendMail failed HTTP ' + res.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', (e) => reject(new Error('Graph sendMail network error: ' + e.message)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Graph sendMail timeout (30s)')); });
    req.write(payload);
    req.end();
  });
}

module.exports = { isConfigured, isSignedIn, signInInteractive, signOut, sendMail, getAccessTokenSilent };
