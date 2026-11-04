'use strict';
/**
 * quicksight_dbr.js — DBR DATA page-text capture (AFP + DSP QuickSight dashboards)
 *
 * Opens the AFP/DSP QuickSight dashboards (Midway/SSO-authenticated, same
 * session as AAP — Midway cookies are already injected into electron's
 * defaultSession at app startup, see src/scrapers/auth.js) and captures the
 * RENDERED PAGE TEXT. QuickSight renders its pivot tables as a virtualized
 * widget grid with no stable/discoverable DOM structure (confirmed via
 * live iteration — selector-based extraction could not reliably find real
 * table rows across several rounds of tuning), so this module intentionally
 * does NOT try to parse the table structurally in the main process.
 *
 * Instead it hands the raw `document.body.innerText` back to the caller
 * (the Daily Call renderer), which asks AI (window.ai.ask, the same
 * mechanism wr-modal.js already uses for structured JSON extraction) to
 * read the table out of that text and return it as JSON. AI handles messy/
 * irregular rendered-text layouts far better than brittle DOM selectors —
 * see renderer/src/js/views/daily-call.js's _dbrParseAfpText /
 * _dbrParseDspText for the actual parsing prompts.
 *
 * This module's only job: get past auth, wait for the real content to
 * render (not a loading/notification state), and return clean page text.
 */

const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger').createLogger('quicksight-dbr');

// Debug aid: while we're tuning the AI-parsing prompts against real
// QuickSight output, dump the raw captured page text to a file next to the
// app logs so it can be inspected directly (the main log only records char
// counts — not useful for diagnosing "AI found table A but not table B").
function _dumpDebugText(label, text) {
  try {
    const { P } = require('../config/paths');
    const dir = P && P.dataDir ? P.dataDir : require('electron').app.getPath('userData');
    const file = path.join(dir, 'quicksight_debug_' + label + '.txt');
    fs.writeFileSync(file, text, 'utf8');
    logger.info('Debug text dumped to ' + file);
  } catch (e) {
    logger.warn('Could not dump debug text for ' + label + ':', e.message);
  }
}

// ── Config ───────────────────────────────────────────────────────────────
// AFP Performance dashboard — "By Domicile Site" / "By SCAC" sheet.
const AFP_DASHBOARD_URL =
  'https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/0ee23476-f37d-4d54-b8ab-5709197e62b6/sheets/0ee23476-f37d-4d54-b8ab-5709197e62b6_5073d7e6-5c43-409e-8c93-32e636f6dcd1?sso_login=true';

// DSP dashboard — SCAC-ranked Downtime%/Uptime%/Asset# table.
const DSP_DASHBOARD_URL =
  'https://us-east-1.quicksight.aws.amazon.com/sn/account/amazonbi/dashboards/c8f07257-b38e-426a-9a83-528c9272a8ff/sheets/c8f07257-b38e-426a-9a83-528c9272a8ff_20cb9681-153d-4cb0-82c1-7980256b225f';

const QUICKSIGHT_HOST_RE = /quicksight\.aws\.amazon\.com/i;
const SSO_HOST_RE        = /midway|login\.amazon|signin|sso\.amazon|oidc|oauth|\/auth\//i;

// Budgets are env-overridable so a very slow link can be given more room
// without a code change (QS_LOAD_MS / QS_READY_MS, in milliseconds).
// SLOW-NETWORK FIX (2026-10-17): the old fixed 45s load + 40s poll gave up
// before QuickSight finished on slow connections — the capture returned early,
// so the DBR pull "failed" even though the dashboard would have rendered given
// more time. Budgets raised AND the readiness wait is now progress-aware (keeps
// waiting while the page is visibly still loading, see pollUntilReady) instead
// of bailing at a fixed try count.
const PAGE_LOAD_TIMEOUT = Number(process.env.QS_LOAD_MS) || 90000; // was 45s
const DOM_POLL_INTERVAL = 1500;
const READY_BUDGET_MS   = Number(process.env.QS_READY_MS) || 180000; // up to 3 min for content to render on slow links
// Kept for the back-compat pollUntil signature; readiness now uses READY_BUDGET_MS.
const DOM_POLL_MAX      = Math.ceil(READY_BUDGET_MS / DOM_POLL_INTERVAL);

let _qsLock = false; // re-entrancy guard, mirrors _uptakeLock / _relayLock

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Wait for did-finish-load to go quiet (SPA rehydration fires it 2-3x) ──
function waitForLoadQuiet(win, timeoutMs = PAGE_LOAD_TIMEOUT, quietMs = 1000) {
  return new Promise((resolve) => {
    let quietTimer = null;
    let done = false;
    function cleanup() {
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(master);
      if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', onLoad);
    }
    const master = setTimeout(() => { if (done) return; cleanup(); resolve(); }, timeoutMs);
    function onLoad() {
      if (done) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (done) return; cleanup(); resolve(); }, quietMs);
    }
    win.webContents.on('did-finish-load', onLoad);
  });
}

// ── Poll until a JS expression (evaluated in-page) returns truthy ─────────
async function pollUntil(win, expr, intervalMs = DOM_POLL_INTERVAL, maxTries = DOM_POLL_MAX) {
  for (let i = 0; i < maxTries; i++) {
    if (win.isDestroyed()) return false;
    try {
      const result = await win.webContents.executeJavaScript(expr);
      if (result) return true;
    } catch (_) {}
    await sleep(intervalMs);
  }
  return false;
}

// Snapshot of page "progress" signals, evaluated in-page: how much text has
// rendered, and whether QuickSight is still visibly loading (spinner / loading
// text / the data-query overlay). Used so the readiness wait is PATIENT on slow
// networks — it keeps waiting as long as the page is still making progress,
// and only gives up once the budget is spent.
const PROGRESS_PROBE = `
(function(){
  var t = document.body ? (document.body.innerText || '') : '';
  var loading = /\\bloading\\b|please wait|retrieving|fetching/i.test(t)
    || !!document.querySelector('[class*="loading" i],[class*="spinner" i],[class*="Spinner"],[data-automation-id*="loading" i],[aria-busy="true"]');
  return { len: t.length, loading: loading };
})()`;

// ── Progress-aware readiness wait (slow-network resilient) ────────────────
// Resolves true as soon as readyCheckExpr passes. Otherwise keeps polling until
// READY_BUDGET_MS is exhausted — but it will NOT give up early just because a
// fixed try-count elapsed: as long as the page is still loading or its text is
// still growing, it keeps waiting within the budget. Only a page that has gone
// quiet (no spinner, text not growing) AND has blown the budget is treated as a
// genuine timeout.
async function pollUntilReady(win, readyCheckExpr, label) {
  const deadline = Date.now() + READY_BUDGET_MS;
  let lastLen = 0;
  let lastProgressAt = Date.now();
  // If the page stops making ANY progress for this long AND the ready check
  // still fails, conclude it's stuck (not just slow) and stop early.
  const STALL_MS = 45000;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false;
    try {
      const ready = await win.webContents.executeJavaScript(readyCheckExpr);
      if (ready) return true;
    } catch (_) {}
    let prog = null;
    try { prog = await win.webContents.executeJavaScript(PROGRESS_PROBE); } catch (_) {}
    if (prog) {
      const growing = prog.len > lastLen;
      if (growing || prog.loading) lastProgressAt = Date.now();
      lastLen = prog.len;
      // Stuck: no growth and not loading for STALL_MS → give up early (don't
      // burn the whole 3-min budget on a genuinely broken/empty page).
      if (!growing && !prog.loading && (Date.now() - lastProgressAt) > STALL_MS) {
        logger.warn('[' + label + '] page stalled (no progress for ' + Math.round(STALL_MS/1000) + 's) — giving up before budget');
        return false;
      }
    }
    await sleep(DOM_POLL_INTERVAL);
  }
  logger.warn('[' + label + '] readiness budget (' + Math.round(READY_BUDGET_MS/1000) + 's) exhausted');
  return false;
}

// Readiness checks — cheap truthy text probes, NOT the real extraction.
const AFP_READY_CHECK = `
(function() {
  var t = document.body ? (document.body.innerText || '') : '';
  return /WTD Bottom 10 Performing (Domicile Sites|SCAC)/i.test(t);
})()`;

const DSP_READY_CHECK = `
(function() {
  var t = document.body ? (document.body.innerText || '') : '';
  return /downtime/i.test(t) && /uptime/i.test(t);
})()`;

const GET_BODY_TEXT = `(function(){ return document.body ? (document.body.innerText || '') : ''; })()`;

// ── "Data as of (PT)" freshness extraction ────────────────────────────────
// Both dashboards render a refresh-timestamp near the top, e.g.:
//     Oct 8, 2026 6:27am
//     Data as of (PT)
// The date line comes immediately BEFORE the "Data as of (PT)" label (seen in
// the live capture). We pull that date so the scheduler can require the pulled
// data to be CURRENT FOR TODAY (Pacific) — a scrape that returns yesterday's
// snapshot must be treated as "not populated yet" and retried.
//
// Month-name -> 1-based month number (handles both "Oct" and "October").
const _MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Returns the captured "data as of" day as a normalized "YYYY-MM-DD" PT
// calendar-day string, or null if not found/parseable. We DELIBERATELY do not
// build a JS Date and reformat it — the dashboard's "Data as of (PT)" value is
// ALREADY a Pacific calendar day, so round-tripping it through Date()+timezone
// formatting would shift it a day (local-midnight-vs-PT off-by-one). Instead we
// read the month/day/year straight out of the matched text.
function extractDataAsOf(text) {
  if (!text) return null;
  // Primary: the "Mon D, YYYY[ h:mma]" line directly ABOVE a "Data as of" label.
  const labelRe = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})(?:\s+\d{1,2}:\d{2}\s*[ap]m)?\s*\n\s*Data as of/i;
  let m = text.match(labelRe);
  if (!m) {
    // Fallback: "Data as of (PT)" then the date on the NEXT line.
    const afterRe = /Data as of[^\n]*\n\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i;
    m = text.match(afterRe);
  }
  if (!m) return null;
  const mon = _MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!mon || !day || !year) return null;
  return year + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// Today's calendar date in America/Los_Angeles as "YYYY-MM-DD".
function _todayPacific() {
  // en-CA formats as YYYY-MM-DD; forcing the LA timezone gives the PT calendar day.
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  } catch (_) {
    // Fallback: local date (PT support is universal in modern Node/Electron).
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
}

// Is the captured "data as of" day (a "YYYY-MM-DD" string from extractDataAsOf)
// TODAY in Pacific time? A null/unparseable value is NOT today (caller treats
// that as "retry — data not populated yet").
function isDataAsOfToday(dataAsOf) {
  if (!dataAsOf) return false;
  return dataAsOf === _todayPacific();
}

/**
 * _capturePageText(url, readyCheckExpr, label) — shared navigate+wait+grab-text
 * flow for both dashboards. Returns { ok, text, error? }.
 */
async function _capturePageText(url, readyCheckExpr, label) {
  try { require('./auth').injectCookies(); } catch (e) { logger.warn('injectCookies skipped:', e.message); }

  let win = null;
  try {
    win = new BrowserWindow({
      show: false, skipTaskbar: true,
      width: 1600, height: 1200,
      // Keep rendering at full speed while hidden AND while the workstation is
      // locked — QuickSight's SPA needs a live, non-throttled surface to finish
      // its (slow) visual render; a throttled hidden window stalls on lock.
      paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });

    logger.info('Loading ' + label + ' QuickSight dashboard...');
    const loadPromise = win.loadURL(url);
    await Promise.race([loadPromise, sleep(PAGE_LOAD_TIMEOUT)]);
    // Longer quiet window: on a slow link the SPA fires did-finish-load in
    // widely-spaced bursts; 1.2s was short enough to "settle" mid-load. The
    // real content wait is pollUntilReady below, so being generous here is safe.
    await waitForLoadQuiet(win, PAGE_LOAD_TIMEOUT, 2500);

    // SSO check — but on a slow link we may still be MID-redirect through
    // Midway when the load quiets, which is NOT a failure. Wait up to ~30s for
    // the redirect chain to land on QuickSight before concluding "not logged
    // in". Only a URL that STAYS on the SSO/login host is a real auth failure.
    let curUrl = win.isDestroyed() ? '' : win.webContents.getURL();
    if (SSO_HOST_RE.test(curUrl) && !QUICKSIGHT_HOST_RE.test(curUrl)) {
      const ssoDeadline = Date.now() + 30000;
      while (Date.now() < ssoDeadline && !win.isDestroyed()) {
        await sleep(2000);
        curUrl = win.webContents.getURL();
        if (QUICKSIGHT_HOST_RE.test(curUrl)) break;         // landed on QS — good
        if (!SSO_HOST_RE.test(curUrl)) break;               // moved off SSO host
      }
      if (SSO_HOST_RE.test(curUrl) && !QUICKSIGHT_HOST_RE.test(curUrl)) {
        logger.warn('Stuck on SSO/login page, not QuickSight:', curUrl);
        return { ok: false, error: 'Not logged in to QuickSight/Midway — open the dashboard once in a browser to establish SSO, then retry.' };
      }
    }

    logger.info('Polling for ' + label + ' content to render (patient; up to ' + Math.round(READY_BUDGET_MS / 1000) + 's on slow links)...');
    const ready = await pollUntilReady(win, readyCheckExpr, label);
    if (!ready) {
      logger.warn('Timed out waiting for ' + label + ' content to appear.');
      return { ok: false, error: 'Timed out waiting for the ' + label + ' dashboard to load (slow network?). It kept trying for ' + Math.round(READY_BUDGET_MS / 1000) + 's — retry on a better connection, or set QS_READY_MS higher.' };
    }

    const text = await win.webContents.executeJavaScript(GET_BODY_TEXT);
    if (!text || text.length < 50) {
      return { ok: false, error: 'Page loaded but returned almost no text — the dashboard may not have rendered correctly.' };
    }
    logger.info('Captured ' + label + ' page text (' + text.length + ' chars)');
    _dumpDebugText(label, text);
    const dataAsOf = extractDataAsOf(text); // "YYYY-MM-DD" (PT calendar day) or null
    const freshToday = isDataAsOfToday(dataAsOf);
    logger.info('[' + label + '] data as of (PT): ' + (dataAsOf || 'UNKNOWN') + ' — fresh for today(PT)=' + freshToday);
    return {
      ok: true,
      text,
      scrapedAt: new Date().toISOString(),
      dataAsOf: dataAsOf || null,
      freshToday,
    };
  } catch (e) {
    logger.error('_capturePageText(' + label + ') failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  }
}

/**
 * captureAfpText() — load the AFP dashboard and return its rendered page
 * text (raw; the renderer feeds this to AI for parsing). Returns
 * { ok, text, scrapedAt, error? }.
 */
async function captureAfpText() {
  if (_qsLock) {
    logger.warn('A DBR capture is already in progress — rejecting duplicate call');
    return { ok: false, error: 'A DBR scrape is already in progress' };
  }
  _qsLock = true;
  try {
    return await _capturePageText(AFP_DASHBOARD_URL, AFP_READY_CHECK, 'AFP');
  } finally {
    _qsLock = false;
  }
}

/**
 * captureDspText() — load the DSP dashboard and return its rendered page
 * text. Returns { ok, text, scrapedAt, error? }.
 */
async function captureDspText() {
  if (_qsLock) {
    logger.warn('A DBR capture is already in progress — rejecting duplicate call');
    return { ok: false, error: 'A DBR scrape is already in progress' };
  }
  _qsLock = true;
  try {
    return await _capturePageText(DSP_DASHBOARD_URL, DSP_READY_CHECK, 'DSP');
  } finally {
    _qsLock = false;
  }
}

module.exports = {
  captureAfpText, captureDspText,
  AFP_DASHBOARD_URL, DSP_DASHBOARD_URL,
  extractDataAsOf, isDataAsOfToday,
};
