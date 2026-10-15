'use strict';
/**
 * asana/discover.js — ONE-SHOT discovery probe (env-gated: ASANA_DISCOVER=1).
 *
 * Purpose: determine HOW app.asana.com authenticates its web/API calls when we
 * ride the Amazon Midway SSO session — specifically whether:
 *   (A) session cookies alone work (in-window fetch with credentials:'include'
 *       against /api/1.0/users/me returns the user), or
 *   (B) the SPA attaches a bearer / CSRF / XSRF header we must capture (then we
 *       clone the Uptake CDP-capture approach).
 *
 * This DOES NOT change any app behavior. It opens a hidden window seeded with
 * the existing Midway cookies, lets SSO settle, runs the probes, writes a
 * report to <userData>/asana-discovery.json, and destroys the window.
 *
 * Run it from a node harness or temporarily call runAsanaDiscovery() behind the
 * ASANA_DISCOVER=1 flag. Delete this file once the auth model is known.
 */

const logger = require('../utils/logger')('asana:discover');

const ASANA_HOME = 'https://app.asana.com/0/home';
const ASANA_ME   = 'https://app.asana.com/api/1.0/users/me';
const PARTITION  = 'persist:asana';

const MIDWAY_RE = /midway|sso\.amazon|oidc|oauth|federate\.amazon|midway-auth\.amazon\.com|signin\.aws/i;
const ASANA_RE  = /app\.asana\.com/i;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Wait until navigation quiets down (SPA fires did-finish-load repeatedly).
function waitQuiet(win, totalMs, quietMs) {
  return new Promise((resolve) => {
    let last = Date.now();
    let done = false;
    const onNav = () => { last = Date.now(); };
    try { win.webContents.on('did-finish-load', onNav); } catch (_) {}
    const started = Date.now();
    const iv = setInterval(() => {
      if (done || win.isDestroyed()) { clearInterval(iv); return; }
      if (Date.now() - last > quietMs || Date.now() - started > totalMs) {
        done = true; clearInterval(iv);
        try { win.webContents.removeListener('did-finish-load', onNav); } catch (_) {}
        resolve();
      }
    }, 300);
  });
}

async function _fetchInWindow(win, url, headers) {
  const expr = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'GET',
        headers: ${JSON.stringify(headers || { 'Accept': 'application/json' })},
        credentials: 'include',
      });
      const txt = await res.text();
      return { ok: res.ok, status: res.status, body: txt.slice(0, 600),
               ctype: res.headers.get('content-type') || '' };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  })()`;
  try { return await win.webContents.executeJavaScript(expr); }
  catch (e) { return { ok: false, status: 0, error: e.message }; }
}

async function runAsanaDiscovery() {
  const { BrowserWindow } = require('electron');
  const { injectCookies } = require('../scrapers/auth');
  const fs   = require('fs');
  const path = require('path');
  const outFile = path.join(require('electron').app.getPath('userData'), 'asana-discovery.json');

  const report = { startedAt: new Date().toISOString(), steps: [] };
  const log = (step, data) => { report.steps.push({ step, ...data }); logger.info('[discover] ' + step + ' ' + JSON.stringify(data).slice(0, 200)); };

  const win = new BrowserWindow({
    show: false, skipTaskbar: true, width: 1440, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: PARTITION },
  });

  // CDP capture of any auth-bearing header the SPA sends to its own API.
  const captured = { authHeaders: {}, apiHosts: {}, sampleRequests: [] };
  let dbgAttached = false;
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) { dbg.attach('1.3'); dbgAttached = true; }
    await dbg.sendCommand('Network.enable');
    dbg.on('message', (_e, method, params) => {
      try {
        if (method !== 'Network.requestWillBeSent') return;
        const u = (params.request && params.request.url) || '';
        if (!/asana\.com\/api\//.test(u) && !/asana\.com\/-\//.test(u)) return;
        const h = params.request.headers || {};
        // Record any auth-ish header names (values redacted except length).
        for (const [k, v] of Object.entries(h)) {
          if (/authorization|x-asana|xsrf|csrf|x-forwarded|cookie/i.test(k)) {
            captured.authHeaders[k.toLowerCase()] = (k.toLowerCase() === 'cookie')
              ? '(cookie present, ' + String(v).length + ' chars)'
              : (String(v).slice(0, 12) + '…(' + String(v).length + ' chars)');
          }
        }
        try { captured.apiHosts[new URL(u).host] = (captured.apiHosts[new URL(u).host] || 0) + 1; } catch (_) {}
        if (captured.sampleRequests.length < 15) {
          captured.sampleRequests.push({ method: params.request.method, url: u.split('?')[0] });
        }
      } catch (_) {}
    });
    log('cdp-attached', { ok: true });
  } catch (e) {
    log('cdp-attach-failed', { error: e.message });
  }

  try {
    // Seed the partition with the live Midway cookies (same as the main window).
    await injectCookies(win.webContents.session);
    log('cookies-seeded', { ok: true });

    // Navigate to Asana home; let SSO settle.
    win.loadURL(ASANA_HOME);
    await waitQuiet(win, 60000, 2000);
    const settledUrl = win.webContents.getURL();
    const onWall = MIDWAY_RE.test(settledUrl) && !ASANA_RE.test(settledUrl);
    log('settled', { url: settledUrl.split('?')[0], onMidwayWall: onWall, onAsana: ASANA_RE.test(settledUrl) });

    // Give the SPA a moment to fire its own API calls (for CDP capture).
    await sleep(4000);

    // PROBE 1: cookie-only call to the documented REST API.
    const p1 = await _fetchInWindow(win, ASANA_ME);
    log('probe:cookie-only /api/1.0/users/me', { ok: p1.ok, status: p1.status, ctype: p1.ctype, bodyHead: (p1.body || p1.error || '').slice(0, 160) });

    report.cdp = {
      authHeaderNames: Object.keys(captured.authHeaders),
      authHeaders: captured.authHeaders,
      apiHosts: captured.apiHosts,
      sampleRequests: captured.sampleRequests,
    };
    report.verdict = p1.ok
      ? 'COOKIES_ONLY: /api/1.0/users/me works with credentials:include — no bearer needed'
      : (Object.keys(captured.authHeaders).some((k) => /authorization/i.test(k))
          ? 'BEARER_REQUIRED: SPA sends an Authorization header — capture it via CDP (like Uptake)'
          : 'NEEDS_REVIEW: cookie-only failed; inspect cdp.authHeaders + sampleRequests');

    report.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); } catch (_) {}
    logger.info('[discover] VERDICT: ' + report.verdict + ' — report at ' + outFile);
    return report;
  } catch (e) {
    report.error = e.message;
    try { fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); } catch (_) {}
    logger.warn('[discover] failed: ' + e.message);
    return report;
  } finally {
    try { if (dbgAttached) win.webContents.debugger.detach(); } catch (_) {}
    try { win.destroy(); } catch (_) {}
  }
}

module.exports = { runAsanaDiscovery };
