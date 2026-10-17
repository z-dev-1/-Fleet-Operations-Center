'use strict';
/**
 * fas_roster.js — Scrape the full FAS roster in-app (no manual export).
 *
 * The FAS roster page (https://fas.fieldmaintenance.roc.amazon.dev/roster)
 * renders a single HTML table client-side. It paginates, but exposes a
 * "1,000 per page" button that forces every row onto one page — so we don't
 * have to click "Next" repeatedly. There is NO separate JSON/XHR data call;
 * the data lives only in the rendered DOM.
 *
 * Mechanism (reuses the aap_longdwell.js off-screen authenticated pattern):
 *   1. injectCookies() to seed the freshest Midway session (the roster host is
 *      *.amazon.dev, covered by the same Midway cookies),
 *   2. open an OFF-SCREEN authenticated BrowserWindow on the roster page,
 *   3. bail fast if it bounces to Midway SSO (dead session),
 *   4. INSIDE the page: click the "N per page" control to show all rows, wait
 *      for the table to settle, then read every <tbody> row into an object
 *      keyed by the table's own column headers.
 *
 * Columns (as of 2026-10): FAS Name, Site Code, Email, Phone,
 * Uptime Manager, Program, SCAC. We read whatever headers the table actually
 * renders (not a hardcoded list), so a column add/rename on the page flows
 * through without a code change.
 *
 * Returns { ok, columns:[], rows:[{...}] } or a structured { ok:false, error }.
 */

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger')('fas-roster');

const ROSTER_URL = 'https://fas.fieldmaintenance.roc.amazon.dev/roster';

// Second source: the AFP-FAS SharePoint "PARTNERS" roster workbook. Same roster
// data (sometimes complementary — a (site+SCAC) combo may exist in one source
// but not the other), with richer columns (login, sr_pm, asset count). We merge
// both into one combined roster (union by site+SCAC).
const SP_SITE = '/sites/AFP-FAS';
const SP_ROSTER_FILE = 'AFP FAS ROSTER- PARTNERS.xlsx';
const SP_ROSTER_PAGE = 'https://amazon.sharepoint.com/sites/AFP-FAS';

const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');

// In-page scraper. Runs in the roster page's own context. Forces ALL rows to
// render (via a "per page" control, else by paging "Next" and accumulating),
// then extracts headers + rows. Returns a plain object. Includes a `debug`
// trail so we can see what it found if row counts look wrong.
const IN_PAGE_SCRIPT = `(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const debug = [];

  function headersOf(table) {
    return [...table.querySelectorAll('thead th, thead td')]
      .map((c) => (c.innerText || '').trim())
      .filter((h) => h !== '');
  }

  // Read currently-rendered rows into objects keyed by header.
  function readRows(table, headers) {
    const out = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
      const cells = [...tr.children].map((c) => (c.innerText || '').trim());
      if (!cells.some((v) => v !== '')) continue;
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] != null ? cells[i] : ''; });
      // a stable row signature for de-duping across page clicks
      obj.__sig = cells.join('\\u0001');
      out.push(obj);
    }
    return out;
  }

  // Wait until the table's rendered row count stops changing (two stable reads)
  // or a budget elapses. Returns the final count.
  async function waitStable(table, maxMs) {
    let last = -1, stable = 0; const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const n = table.querySelectorAll('tbody tr').length;
      if (n === last) { stable++; if (stable >= 2) return n; } else stable = 0;
      last = n;
      await sleep(250);
    }
    return table.querySelectorAll('tbody tr').length;
  }

  // Wait for the SPA to render the table. did-finish-load fires before the
  // client app paints its data grid, so poll (up to ~25s) for a <table> that
  // actually has body rows before proceeding.
  let table = null;
  {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const t = document.querySelector('table');
      if (t && t.querySelectorAll('tbody tr').length > 0) { table = t; break; }
      await sleep(400);
    }
    if (!table) table = document.querySelector('table'); // last resort: a table with no rows yet
  }
  if (!table) {
    debug.push('body snip: ' + (document.body ? (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : 'no-body'));
    return { ok: false, error: 'no-table', detail: 'No roster table found.', debug };
  }

  const headers = headersOf(table);
  debug.push('headers=' + headers.length + ':' + headers.join(','));
  debug.push('initial rows=' + table.querySelectorAll('tbody tr').length);

  // ── Strategy 1: the page-size control is a RADIX/headless dropdown. Its
  // TRIGGER shows the current value ("100 per page"); the larger options
  // ("1,000 per page") only exist in the DOM AFTER the trigger is opened. So:
  //   (a) find the trigger (short label matching "<n> per page"),
  //   (b) click it to open the popup,
  //   (c) find the option with the LARGEST page size and click it,
  //   (d) wait for the table to grow.
  let clickedPerPage = false;
  const perPageRe = /^\\s*[\\d,]+\\s*(?:\\/|per)?\\s*page\\s*$/i; // "1,000 per page", "1000 / page", "100 page"
  const numOf = (s) => { const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? -1 : n; };

  // Scan the whole document for short "<n> per page" labels across the widest
  // set of element kinds (Radix renders options as role=option/menuitemradio
  // in a portal, often OUTSIDE the table subtree).
  const scanPerPage = () => [...document.querySelectorAll(
      'button, a, [role=button], [role=option], [role=menuitem], [role=menuitemradio], li, span, div')]
    .map((el) => ({ el, txt: (el.innerText || el.textContent || '').trim() }))
    .filter((x) => x.txt && x.txt.length <= 24 && perPageRe.test(x.txt));

  try {
    // (a) locate the trigger — the currently-shown "N per page" control.
    let pool = scanPerPage();
    debug.push('perPage pre=' + JSON.stringify([...new Set(pool.map((x) => x.txt))].slice(0, 8)));
    // The trigger is typically a button/[role=button]/[role=combobox].
    let trigger = pool.find((x) => /button/i.test(x.el.tagName) || x.el.getAttribute('role') === 'button' || x.el.getAttribute('role') === 'combobox');
    if (!trigger && pool.length) trigger = pool[0];

    if (trigger) {
      // (b) OPEN the popup. Radix/headless dropdowns open on pointer events,
      // not a bare .click() — fire the full pointer+mouse sequence, then also
      // try keyboard (Enter/Space/ArrowDown) as a fallback. Options render in a
      // PORTAL at document.body level with role=option/menuitem(radio).
      const fire = (el, type, opts) => {
        try {
          const Ctor = /^key/.test(type) ? KeyboardEvent : (/^pointer/.test(type) ? PointerEvent : MouseEvent);
          el.dispatchEvent(new Ctor(type, Object.assign({ bubbles: true, cancelable: true, view: window }, opts || {})));
        } catch (e) { try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (_) {} }
      };
      debug.push('open trigger: "' + trigger.txt + '"');
      const tg = trigger.el;
      tg.focus && tg.focus();
      fire(tg, 'pointerdown'); fire(tg, 'mousedown'); fire(tg, 'pointerup'); fire(tg, 'mouseup'); fire(tg, 'click');
      await sleep(500);

      // Collect option elements from the WHOLE document (portal included).
      const collectOptions = () => [...document.querySelectorAll(
          '[role=option], [role=menuitem], [role=menuitemradio], [data-radix-collection-item], li, button, a, div, span')]
        .map((el) => ({ el, txt: (el.innerText || el.textContent || '').trim() }))
        .filter((x) => x.txt && x.txt.length <= 24 && perPageRe.test(x.txt));

      let opts = collectOptions();
      // If only the trigger's own "100 per page" shows, the menu didn't open —
      // retry with keyboard activation and a longer settle.
      if (new Set(opts.map((x) => x.txt)).size <= 1) {
        fire(tg, 'keydown', { key: 'Enter', code: 'Enter' });
        fire(tg, 'keydown', { key: 'ArrowDown', code: 'ArrowDown' });
        await sleep(600);
        opts = collectOptions();
      }
      const uniq = [...new Set(opts.map((x) => x.txt))];
      debug.push('opened options=' + JSON.stringify(uniq.slice(0, 12)));

      // (c) choose the largest page size and activate it (pointer sequence too).
      let best = null, bestN = -1;
      for (const x of opts) { const n = numOf(x.txt); if (n > bestN) { bestN = n; best = x.el; } }
      if (best && bestN > 0) {
        debug.push('select option n=' + bestN);
        best.scrollIntoView && best.scrollIntoView({ block: 'center' });
        fire(best, 'pointerdown'); fire(best, 'mousedown'); fire(best, 'pointerup'); fire(best, 'mouseup'); fire(best, 'click');
        await sleep(800);
        await waitStable(table, 25000);
        clickedPerPage = true;
      } else {
        debug.push('no larger option found after open');
      }
    } else {
      debug.push('no per-page trigger found');
    }

    // Fallback: a native <select> page-size control.
    const sel = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => /per page|\\bpage\\b|rows|\\d{2,}/i.test(o.textContent || '')));
    if (!clickedPerPage && sel) {
      let bo = null, bon = -1;
      for (const o of sel.options) { const n = numOf(o.textContent); if (n > bon) { bon = n; bo = o; } }
      if (bo && sel.value !== bo.value) {
        sel.value = bo.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        debug.push('select page-size → ' + bon);
        await sleep(400); await waitStable(table, 20000); clickedPerPage = true;
      }
    }
  } catch (e) { debug.push('perPage error: ' + e.message); }

  // Collect whatever is now rendered.
  const bySig = new Map();
  for (const r of readRows(table, headers)) bySig.set(r.__sig, r);
  debug.push('after per-page rows=' + bySig.size);

  // ── Strategy 2: if a "Next" pager exists, click through pages and
  // accumulate (de-duped). Covers the case where no per-page control worked.
  try {
    const findNext = () => [...document.querySelectorAll('button, a, [role=button]')]
      .find((el) => /^(next|›|»|next page)$/i.test((el.innerText || '').trim())
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    let guard = 0;
    let next = findNext();
    while (next && guard < 100) {
      guard++;
      const before = bySig.size;
      next.click();
      await sleep(400);
      await waitStable(table, 8000);
      for (const r of readRows(table, headers)) bySig.set(r.__sig, r);
      if (bySig.size === before) break; // no new rows → done
      next = findNext();
    }
    debug.push('after pager rows=' + bySig.size + ' pages=' + guard);
  } catch (e) { debug.push('pager error: ' + e.message); }

  const rows = [...bySig.values()].map((r) => { const o = { ...r }; delete o.__sig; return o; });
  if (!rows.length) return { ok: false, error: 'no-rows', detail: 'Roster rendered no rows.', debug };
  return { ok: true, columns: headers, rows, count: rows.length, debug };
})();`;

/**
 * Scrape the full FAS roster. Resolves with { ok, columns, rows } or a
 * structured { ok:false, error, detail }. Never throws for expected failure
 * modes (SSO bounce, no table, timeout).
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] overall budget (default 60s)
 */
async function fetchRoster(opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000; // generous: SPA render + per-page re-render

  // Seed the freshest Midway cookies so the off-screen window is authenticated.
  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) {
    logger.warn('cookie inject skipped: ' + e.message);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(res);
    };

    const win = new BrowserWindow({
      width: 1400, height: 900,
      show: false, x: -3000, y: -3000, skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: session.defaultSession,
      },
    });

    const timeout = setTimeout(() => {
      logger.warn('roster fetch timed out after ' + timeoutMs + 'ms');
      finish({ ok: false, error: 'timeout', detail: 'The FAS roster page did not respond in time.' });
    }, timeoutMs);

    const run = async () => {
      let url = '';
      try { url = win.webContents.getURL(); } catch (_) {}
      if (_isSSO(url)) {
        clearTimeout(timeout);
        logger.warn('landed on Midway SSO — session invalid');
        finish({ ok: false, error: 'auth', detail: 'Midway session expired. Open the app’s main window to re-authenticate, then try again.' });
        return;
      }
      try {
        // Give the SPA a moment to render its initial table before scraping.
        const result = await win.webContents.executeJavaScript(IN_PAGE_SCRIPT, true);
        clearTimeout(timeout);
        if (result && result.ok) {
          logger.info('scraped FAS roster: ' + result.count + ' rows, ' + (result.columns || []).length + ' columns');
          if (Array.isArray(result.debug)) logger.info('[roster debug] ' + result.debug.join(' | '));
          finish({ ok: true, columns: result.columns, rows: result.rows });
        } else {
          if (result && Array.isArray(result.debug)) logger.info('[roster debug] ' + result.debug.join(' | '));
          const err = (result && (result.detail || result.error)) || 'unknown error';
          logger.warn('roster scrape failed: ' + (result && result.error) + ' — ' + err);
          finish({ ok: false, error: (result && result.error) || 'failed', detail: err });
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.error('executeJavaScript threw: ' + e.message);
        finish({ ok: false, error: 'script', detail: e.message });
      }
    };

    win.webContents.once('did-finish-load', run);
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return; // ignore sub-resource aborts
      logger.warn('did-fail-load: ' + code + ' ' + desc);
    });

    win.loadURL(ROSTER_URL);
  });
}

/**
 * fetchSharePointRoster — download + parse the AFP-FAS PARTNERS roster xlsx via
 * an authenticated SharePoint window. Resolves with { ok, columns, rows } where
 * rows are header-keyed objects (site, SCAC, fas_name, ...), or { ok:false }.
 */
async function fetchSharePointRoster(opts = {}) {
  const timeoutMs = opts.timeoutMs || 90000;
  const sp = require('./sp_discover');

  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) { logger.warn('cookie inject skipped: ' + e.message); }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return; settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(res);
    };

    const win = new BrowserWindow({
      width: 1200, height: 800, show: false, x: -3000, y: -3000, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });

    const timeout = setTimeout(() => {
      logger.warn('SharePoint roster timed out');
      finish({ ok: false, error: 'timeout', detail: 'SharePoint roster did not respond in time.' });
    }, timeoutMs);

    const run = async () => {
      let url = '';
      try { url = win.webContents.getURL(); } catch (_) {}
      if (_isSSO(url)) {
        clearTimeout(timeout);
        finish({ ok: false, error: 'auth', detail: 'Midway session expired for SharePoint.' });
        return;
      }
      try {
        // Resolve the file's server-relative path by name, then read the grid.
        const filePath = await sp.findFileOnSite(win, SP_SITE, SP_ROSTER_FILE);
        if (!filePath) { clearTimeout(timeout); finish({ ok: false, error: 'not-found', detail: 'Could not locate ' + SP_ROSTER_FILE + ' on SharePoint.' }); return; }
        const grid = await sp.readXlsxGrid(win, filePath, {});
        clearTimeout(timeout);
        if (grid && grid.ok && Array.isArray(grid.rows)) {
          logger.info('SharePoint roster: ' + grid.rows.length + ' rows, ' + (grid.headers || []).length + ' cols from ' + filePath);
          finish({ ok: true, columns: grid.headers || [], rows: grid.rows });
        } else {
          finish({ ok: false, error: (grid && grid.error) || 'parse-failed', detail: (grid && grid.error) || 'Could not parse the roster workbook.' });
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.error('SharePoint roster threw: ' + e.message);
        finish({ ok: false, error: 'script', detail: e.message });
      }
    };

    win.webContents.once('did-finish-load', run);
    win.webContents.once('did-fail-load', (_e, code, desc) => { if (code === -3) return; logger.warn('SP did-fail-load: ' + code + ' ' + desc); });
    win.loadURL(SP_ROSTER_PAGE);
  });
}

// Unified roster columns we store (superset the lookup + Contact Book use).
const UNIFIED_COLUMNS = [
  'FAS Name', 'Site Code', 'SCAC', 'Email', 'Phone', 'Login',
  'Uptime Manager', 'Uptime Manager Email', 'Sr PM', 'Program', 'Asset Count', 'Source',
];

const _ci = (row, names) => {
  if (!row) return '';
  const keys = Object.keys(row);
  for (const n of names) {
    const k = keys.find((kk) => kk.toLowerCase() === n.toLowerCase());
    if (k && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
};

// Normalize a WEB-roster row (headers: FAS Name, Site Code, Email, Phone,
// Uptime Manager, Program, SCAC) to the unified shape.
function _fromWeb(r) {
  return {
    'FAS Name': _ci(r, ['FAS Name', 'Name']),
    'Site Code': _ci(r, ['Site Code', 'Site']),
    'SCAC': _ci(r, ['SCAC']),
    'Email': _ci(r, ['Email', 'fas_email']),
    'Phone': _ci(r, ['Phone', 'fas_phone']),
    'Login': _ci(r, ['Login', 'fas_login']),
    'Uptime Manager': _ci(r, ['Uptime Manager', 'uptime_manager']),
    'Uptime Manager Email': _ci(r, ['Uptime Manager Email', 'uptime_manager_email']),
    'Sr PM': _ci(r, ['Sr PM', 'sr_pm_name']),
    'Program': _ci(r, ['Program']),
    'Asset Count': _ci(r, ['Asset Count', 'asset count']),
    'Source': 'web',
  };
}

// Normalize a SHAREPOINT-roster row (headers: site, SCAC, fas_name, fas_email,
// fas_login, fas_phone, fas_mailing_address, uptime_manager, uptime_manager_email,
// uptime_manager_login, sr_pm_name, sr_pm_email, sr_pm_login, program, asset count).
function _fromSharePoint(r) {
  return {
    'FAS Name': _ci(r, ['fas_name', 'FAS Name', 'Name']),
    'Site Code': _ci(r, ['site', 'Site Code', 'Site']),
    'SCAC': _ci(r, ['SCAC', 'scac']),
    'Email': _ci(r, ['fas_email', 'Email']),
    'Phone': _ci(r, ['fas_phone', 'Phone']),
    'Login': _ci(r, ['fas_login', 'Login']),
    'Uptime Manager': _ci(r, ['uptime_manager', 'Uptime Manager']),
    'Uptime Manager Email': _ci(r, ['uptime_manager_email', 'Uptime Manager Email']),
    'Sr PM': _ci(r, ['sr_pm_name', 'Sr PM']),
    'Program': _ci(r, ['program', 'Program']),
    'Asset Count': _ci(r, ['asset count', 'Asset Count']),
    'Source': 'sharepoint',
  };
}

// Merge both sources by (Site + SCAC). Union: every combo from either source.
// When a combo exists in both, prefer the row with more filled fields (usually
// SharePoint, which has richer columns), but keep a combined Source tag.
function _mergeRosters(webRows, spRows) {
  const key = (r) => (String(r['SCAC'] || '').trim().toUpperCase()) + '|' + (String(r['Site Code'] || '').trim().toUpperCase());
  const filled = (r) => UNIFIED_COLUMNS.reduce((n, c) => n + (String(r[c] || '').trim() !== '' ? 1 : 0), 0);
  const byKey = new Map();

  const ingest = (rows, norm) => {
    for (const raw of rows) {
      const r = norm(raw);
      if (!r['FAS Name'] && !r['SCAC'] && !r['Site Code']) continue;
      const k = key(r);
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, r); continue; }
      // Combo in both sources → keep the richer row, note combined source.
      const winner = filled(r) >= filled(prev) ? r : prev;
      const merged = { ...winner };
      // Fill any blanks on the winner from the other row (don't lose data).
      for (const c of UNIFIED_COLUMNS) {
        if (String(merged[c] || '').trim() === '') {
          const other = winner === r ? prev : r;
          if (String(other[c] || '').trim() !== '') merged[c] = other[c];
        }
      }
      merged['Source'] = 'both';
      byKey.set(k, merged);
    }
  };
  ingest(webRows || [], _fromWeb);
  ingest(spRows || [], _fromSharePoint);

  return [...byKey.values()];
}

/**
 * fetchCombinedRoster — pull BOTH roster sources (web page + SharePoint
 * workbook), normalize, and union by (Site + SCAC). Returns
 * { ok, columns, rows, sources:{web, sharepoint} }. Succeeds if AT LEAST ONE
 * source returns data (so a SharePoint hiccup doesn't block the web roster,
 * and vice-versa); reports which sources failed.
 */
async function fetchCombinedRoster(opts = {}) {
  const web = await fetchRoster(opts);
  const sp  = await fetchSharePointRoster(opts);

  const webRows = (web && web.ok && Array.isArray(web.rows)) ? web.rows : [];
  const spRows  = (sp && sp.ok && Array.isArray(sp.rows)) ? sp.rows : [];

  if (!webRows.length && !spRows.length) {
    const why = [web && !web.ok ? ('web: ' + (web.detail || web.error)) : null,
                 sp && !sp.ok ? ('sharepoint: ' + (sp.detail || sp.error)) : null].filter(Boolean).join('; ');
    return { ok: false, error: why || 'Both roster sources returned no data.' };
  }

  const rows = _mergeRosters(webRows, spRows);
  logger.info('combined roster: web=' + webRows.length + ' sharepoint=' + spRows.length + ' merged=' + rows.length);
  return {
    ok: true,
    columns: UNIFIED_COLUMNS.slice(),
    rows,
    sources: {
      web: web && web.ok ? webRows.length : ('failed: ' + ((web && (web.detail || web.error)) || 'unknown')),
      sharepoint: sp && sp.ok ? spRows.length : ('failed: ' + ((sp && (sp.detail || sp.error)) || 'unknown')),
    },
  };
}

module.exports = { fetchRoster, fetchSharePointRoster, fetchCombinedRoster, ROSTER_URL };
