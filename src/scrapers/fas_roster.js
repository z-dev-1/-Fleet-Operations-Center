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

module.exports = { fetchRoster, ROSTER_URL };
