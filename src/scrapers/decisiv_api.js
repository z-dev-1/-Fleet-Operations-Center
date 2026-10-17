'use strict';
/**
 * scrapers/decisiv_api.js — Direct Decisiv (Volvo ASIST / PACCAR) JSON API
 * client. Replaces the fragile DOM scrape of the estimate Notes tab with the
 * same JSON endpoint the Decisiv web app itself calls.
 *
 * DISCOVERED (2026-10, via a live network capture of the ASIST estimate page):
 * Decisiv is a Rails app exposing JSON under the authenticated session. The one
 * that matters for us:
 *
 *   GET /mobilecomm/api/estimates/{estimateId}/activity_logs?page=1&per_page=50
 *     -> { notes: [ { id, from:{name,email,location,job_role,...},
 *                     recipients:[...], subject, status, public, internal,
 *                     system_generated, created_at/..., estimate_id } , ... ] }
 *
 * This is the dealer <-> us comment thread the old scraper pulled out of the
 * AngularJS #notes_workspace container (which lazy-loads only in a painted
 * viewport — the root cause of the offscreen-window hack in asist_enrich.js).
 * As JSON it's clean, ordered, and attributed.
 *
 * AUTH MODEL (mirrors aap_api.js):
 *   Decisiv authorizes XHRs with a per-session CSRF token sent as the
 *   `X-CSRF-Token` header (Rails `authenticity_token`), on top of the session
 *   cookies held in the app's persist:vendor-* partition. GETs still require
 *   the token on these endpoints, so we:
 *     1. open ONE authenticated Decisiv window in the vendor partition
 *        (attachAutoLogin logs in with stored creds, exactly like the scraper),
 *     2. read the CSRF token from the page's <meta name="csrf-token"> (Rails
 *        renders it there) — no need to intercept an XHR,
 *     3. run every request INSIDE that page via fetch(), so cookies + token
 *        ride along just like the real app.
 *
 * The window is opened per-host (volvopg vs paccarpg), kept warm briefly, and
 * torn down when idle. All requests are serialized through it.
 *
 * SAFETY: read-only. This module only issues GETs against activity_logs /
 * contacts endpoints. It never POSTs, approves, or mutates a Decisiv record.
 */

const { BrowserWindow } = require('electron');
const logger = require('../utils/logger')('decisiv-api');
let partitionForUrl, attachAutoLogin;
try { ({ partitionForUrl, attachAutoLogin } = require('../orcha/auto-login')); }
catch (_) { partitionForUrl = () => null; attachAutoLogin = () => {}; }

// Hosts we support. Both run the Decisiv platform with identical API shapes.
const HOSTS = {
  volvo:  'https://volvopg.asist.decisiv.net',
  paccar: 'https://paccarpg.decisiv.net',
};
const DEFAULT_HOST = HOSTS.volvo;

const WARM_IDLE_MS  = 3 * 60 * 1000;  // tear the window down after 3 min idle
const AUTH_WAIT_MS  = 75000;          // budget for auto-login to fully settle
// NOTE: a CSRF <meta> token is present even on the /login page, so "token
// found" is NOT a reliable "authenticated" signal. We must first confirm we're
// on an authenticated Decisiv page (not /login or /authentication) before
// trusting the token. Auth via auto-login can take 30-40s (fill creds, redirect
// chain volvo.asist -> volvopg.asist -> /fleet), hence the generous budget.

// One warm window per ORIGIN (volvo vs paccar have separate sessions/partitions).
const _wins   = {};   // origin -> BrowserWindow
const _tokens = {};   // origin -> csrf token string
const _timers = {};   // origin -> teardown timer
let _lock = Promise.resolve();

function _withLock(fn) {
  const next = _lock.then(fn, fn);
  _lock = next.then(() => {}, () => {});
  return next;
}

// Map any Decisiv URL (or a bare 'volvo'/'paccar') to its API origin.
function originFor(urlOrVendor) {
  const s = String(urlOrVendor || '');
  if (/paccarpg\.decisiv\.net/i.test(s) || /^paccar$/i.test(s)) return HOSTS.paccar;
  if (/volvopg\.asist\.decisiv\.net/i.test(s) || /^volvo$/i.test(s)) return HOSTS.volvo;
  return DEFAULT_HOST;
}

function _scheduleTeardown(origin) {
  if (_timers[origin]) clearTimeout(_timers[origin]);
  _timers[origin] = setTimeout(() => _disposeOrigin(origin), WARM_IDLE_MS);
  if (_timers[origin].unref) _timers[origin].unref();
}

function _disposeOrigin(origin) {
  if (_timers[origin]) { clearTimeout(_timers[origin]); delete _timers[origin]; }
  const w = _wins[origin];
  try { if (w && !w.isDestroyed()) w.destroy(); } catch (_) {}
  delete _wins[origin];
  delete _tokens[origin];
}

function dispose() { Object.keys(_wins).forEach(_disposeOrigin); }

// Read the Rails CSRF token out of the authenticated page. Rails renders it as
// <meta name="csrf-token" content="..."> and the app also reflects it on live
// XHRs; the meta tag is the most reliable source and needs no XHR interception.
const _TOKEN_SCRIPT = `(function(){
  try {
    var m = document.querySelector('meta[name="csrf-token"]');
    if (m && m.content) return m.content;
    var p = document.querySelector('meta[name="csrf-param"]');
    // Fallback: a hidden authenticity_token input on a form.
    var i = document.querySelector('input[name="authenticity_token"]');
    if (i && i.value) return i.value;
  } catch (e) {}
  return '';
})()`;

// A login / auth URL — we are NOT authenticated while on one of these.
function _isLoginUrl(u) { return /\/login\b|\/sign[_-]?in\b|\/authentication\/|midway-auth|\/SSO\//i.test(u || ''); }
// Is the window ON the exact API host for this origin (so an in-page fetch is
// same-origin)? Login redirects through volvo.asist.decisiv.net (no "pg"), but
// the JSON API is served from volvopg.asist.decisiv.net — a fetch from the
// wrong host is cross-origin and blocked. We must capture the token (and run
// requests) on the API host itself.
function _onApiHost(u, origin) {
  try { return new URL(u).host === new URL(origin).host && !_isLoginUrl(u); }
  catch (_) { return false; }
}

// Ensure a warm, authenticated window for `origin` with a captured CSRF token.
async function _ensureWindow(origin) {
  const existing = _wins[origin];
  if (existing && !existing.isDestroyed() && _tokens[origin]) return existing;

  const partition = partitionForUrl(origin + '/') || undefined;
  if (!partition) throw Object.assign(new Error('no vendor partition for ' + origin), { code: 'DECISIV_NO_PARTITION' });

  // Decisiv's login form fill/submit (via auto-login) needs a REAL painted
  // viewport to complete reliably — the same constraint the Notes DOM scrape
  // hit (see asist_enrich.js openAndScrapeEstimate). We size the window like a
  // real one and position it far offscreen so it authenticates without ever
  // flashing in front of the user. DECISIV_API_SHOW=1 makes it visible for
  // debugging.
  const _show = process.env.DECISIV_API_SHOW === '1';
  const win = new BrowserWindow({
    show: _show, width: 1400, height: 900,
    x: _show ? undefined : -4000, y: _show ? undefined : -4000,
    paintWhenInitiallyHidden: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false },
  });
  _wins[origin] = win;

  // Log in exactly like the scraper if we hit a login page. We navigate to the
  // API host's fleet page: auto-login may redirect through the login host
  // (volvo.asist, no "pg"), but once authenticated the app settles back on the
  // API host (volvopg.asist). We MUST end up on the API host so the in-page
  // fetch is same-origin (a cross-host fetch is CORS-blocked -> "Failed to
  // fetch"). If login parks us on the non-API host, we re-navigate to it.
  try { attachAutoLogin(win, origin + '/fleet', { maxRetries: 2 }); } catch (_) {}
  win.loadURL(origin + '/fleet');

  const deadline = Date.now() + AUTH_WAIT_MS;
  let lastReNav = 0;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) throw Object.assign(new Error('Decisiv window destroyed during auth'), { code: 'DECISIV_WINDOW_GONE' });
    let url = '';
    try { url = win.webContents.getURL(); } catch (_) {}

    if (_onApiHost(url, origin)) {
      // On the API host and not a login page — grab the (authenticated) token.
      let tok = '';
      try { tok = await win.webContents.executeJavaScript(_TOKEN_SCRIPT, true); } catch (_) {}
      if (tok) { _tokens[origin] = tok; logger.info('[decisiv-api] authenticated on ' + url.split('?')[0]); return win; }
    } else if (!_isLoginUrl(url) && /decisiv\.net\//i.test(url) && (Date.now() - lastReNav > 8000)) {
      // Authenticated but parked on the login HOST (volvo.asist, no "pg").
      // Re-navigate to the API host now that the session cookie is set. Gated
      // to once per 8s so a bouncing redirect can't spin.
      lastReNav = Date.now();
      logger.info('[decisiv-api] authed on non-API host (' + url.split('?')[0] + '), re-navigating to API host');
      try { win.loadURL(origin + '/fleet'); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Object.assign(new Error('Decisiv auth timeout (never settled on API host)'), { code: 'DECISIV_LOAD_TIMEOUT' });
}

// Build the in-page fetch script. Runs INSIDE the authenticated window so
// cookies + the Rails CSRF token authorize the call just like the web app.
function _fetchScript(url, token) {
  return `(async function () {
    return await new Promise(function (resolve) {
      try {
        fetch(${JSON.stringify(url)}, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': ${JSON.stringify(token || '')}
          }
        }).then(function (r) {
          return r.text().then(function (txt) {
            var json = null; try { json = JSON.parse(txt); } catch (e) {}
            resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: json, text: json ? null : String(txt).slice(0, 1000) });
          });
        }).catch(function (e) { resolve({ ok: false, status: 0, error: String(e && e.message || e) }); });
      } catch (e) { resolve({ ok: false, status: -1, error: e.message }); }
    });
  })();`;
}

// Core GET: run inside the warm authenticated window for `origin`.
async function _apiGet(origin, path) {
  return _withLock(async () => {
    const win = await _ensureWindow(origin);
    const token = _tokens[origin] || '';
    const url = path.startsWith('http') ? path : (origin + path);
    const r = await win.webContents.executeJavaScript(_fetchScript(url, token), true);
    _scheduleTeardown(origin);
    if (!r || !r.ok) {
      const detail = (r && (r.text || r.error)) || ('HTTP ' + (r && r.status));
      if (r && (r.status === 401 || r.status === 403)) {
        // Token/session lapsed — drop the cached token so the next call re-auths.
        delete _tokens[origin];
        throw Object.assign(new Error('Decisiv API ' + r.status + ' (session/token rejected)'), { code: 'DECISIV_SESSION_INVALID' });
      }
      throw Object.assign(new Error('Decisiv API ' + (r && r.status) + ': ' + detail), { code: 'DECISIV_API_ERROR', status: r && r.status });
    }
    return r.json;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * getActivityLogs(estimateId, opts) -> raw JSON { notes: [...] }
 * opts.vendor | opts.host | opts.srUrl selects volvo vs paccar (defaults volvo).
 * opts.page / opts.perPage paginate (defaults 1 / 50, matching the web app).
 */
async function getActivityLogs(estimateId, opts = {}) {
  const id = String(estimateId || '').trim();
  if (!id) throw Object.assign(new Error('getActivityLogs: estimateId required'), { code: 'DECISIV_NO_ESTIMATE_ID' });
  const origin = originFor(opts.host || opts.vendor || opts.srUrl || DEFAULT_HOST);
  const page = opts.page || 1;
  const perPage = opts.perPage || 50;
  const path = `/mobilecomm/api/estimates/${encodeURIComponent(id)}/activity_logs?page=${page}&per_page=${perPage}`;
  return _apiGet(origin, path);
}

/** Estimate contacts (dealer + Amazon) — supporting endpoint, read-only. */
async function getEstimateContacts(estimateId, opts = {}) {
  const id = String(estimateId || '').trim();
  if (!id) throw Object.assign(new Error('getEstimateContacts: estimateId required'), { code: 'DECISIV_NO_ESTIMATE_ID' });
  const origin = originFor(opts.host || opts.vendor || opts.srUrl || DEFAULT_HOST);
  const path = `/mobilecomm/api/contacts/estimate_contacts.json?estimate_id=${encodeURIComponent(id)}&exclude_recipients=true&mobile=false`;
  return _apiGet(origin, path);
}

// Strip Decisiv's HTML out of a note subject/body into readable plain text.
function _plain(s) {
  return String(s == null ? '' : s)
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function _noteDate(n) {
  const raw = n && (n.created_at || n.createdAt || n.sent_at || n.date || n.timestamp);
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw).slice(0, 19);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * formatActivityLogs(json, opts) -> flat dated comment thread as plain text,
 * in the SAME shape asist_enrich.js's estimateComments/offsiteText produce, so
 * this is a drop-in replacement for the Notes DOM scrape.
 *
 * Newest-last (chronological) to match how the scraped thread reads. Skips
 * purely system/platform-generated bookkeeping notes when opts.includeSystem is
 * falsy (default), so the timeline shows real dealer<->us messages.
 * Returns { text, count, newest } .
 */
function formatActivityLogs(json, opts = {}) {
  const notes = (json && Array.isArray(json.notes)) ? json.notes
    : (Array.isArray(json) ? json : []);
  const includeSystem = !!opts.includeSystem;
  const lines = [];
  let newest = '';
  for (const n of notes) {
    if (!n) continue;
    if (!includeSystem && (n.system_generated || n.platform_generated)) continue;
    const who = (n.from && (n.from.name || n.from.email)) || 'Unknown';
    const where = (n.from && n.from.location) ? (' (' + n.from.location + ')') : '';
    const when = _noteDate(n);
    const subject = _plain(n.subject || '');
    const bodyTxt = _plain(n.body || n.message || n.text || '');
    const content = [subject, bodyTxt].filter(Boolean).join(' — ');
    if (!content) continue;
    const line = (when ? when + ' ' : '') + who + where + ': ' + content;
    lines.push(line);
    newest = line;
  }
  return { text: lines.join('\n').slice(0, 8000), count: lines.length, newest };
}

/**
 * getEstimateComments(estimateId, opts) -> { ok, text, count, newest, raw } .
 * Convenience wrapper: fetch + format in one call, matching the field the
 * enricher wants (estimateComments). Never throws — returns { ok:false, error }
 * so the caller can fall back to the DOM scrape.
 */
async function getEstimateComments(estimateId, opts = {}) {
  try {
    const raw = await getActivityLogs(estimateId, opts);
    const { text, count, newest } = formatActivityLogs(raw, opts);
    logger.info('[decisiv-api] activity_logs estimate=' + estimateId + ' notes=' + count);
    return { ok: true, text, count, newest, raw };
  } catch (e) {
    logger.warn('[decisiv-api] getEstimateComments failed estimate=' + estimateId + ': ' + e.message);
    return { ok: false, error: e.message, code: e.code || 'DECISIV_API_ERROR', text: '', count: 0 };
  }
}

module.exports = {
  HOSTS, originFor,
  getActivityLogs, getEstimateContacts, getEstimateComments,
  formatActivityLogs,
  dispose,
  // exported for tests
  _plain, _noteDate,
};
