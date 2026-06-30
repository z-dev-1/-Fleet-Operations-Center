'use strict';
// scrapers/aap.js — ports the exact TM autoForce1000 + scrape logic

const { BrowserWindow } = require('electron');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('aap');
const { withRetry } = require('../utils/retry'); // P1-A: retry on transient failures

// Hardcoded production URL (from live AAP session 2026-06-29)
// Page UUID:  bafc8b2a-3be6-4a52-a86f-7cb2de7b5400
// Fleets:     8 UUIDs — all operators (TUZR, SAPB, AZNG, AUVTE, ...)
// States:     ACTIVE + UNAVAILABLE | domicileSites=[] fleet UUIDs drive scope
// V-C extras: sortColumn, limit/pageSize=1000 force full table load
const AAP_SCAN_URL =
  'https://aap-na.corp.amazon.com/v2/page/bafc8b2a-3be6-4a52-a86f-7cb2de7b5400' +
  '?tab=Unplanned' +
  '&states=%5B%7B%22state%22%3A%22ACTIVE%22%2C%22reasons%22%3A%5B%5D%7D%2C%7B%22state%22%3A%22UNAVAILABLE%22%2C%22reasons%22%3A%5B%5D%7D%5D' +
  '&operationalStatuses=%5B%5D' +
  '&geofences=%7B%22type%22%3A%22ANYWHERE%22%2C%22customGeofences%22%3A%5B%5D%7D' +
  '&stationCodes=%5B%5D' +
  '&dspShortCodes=%5B%5D' +
  '&domicileSites=%5B%5D' +
  '&fleets=%5B%220bb2e249-fd34-437f-83af-d1d69150558b%22%2C%220f454f75-1e45-475f-8d8b-2334ade1f6f1%22%2C%225c19cdf7-ce2f-4593-a37a-3fe5d506e120%22%2C%227de393df-74e1-45af-9650-560ba008bc65%22%2C%22b84ddc20-589c-4330-af67-3d38f89e28af%22%2C%22b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe%22%2C%22ba97eda1-cb03-446e-a907-474084194777%22%2C%22daa83ad7-5d8f-43a4-ba9c-76c643e45e1e%22%5D' +
  // fields=["domicileSite","fuelType","engineManufacturerName","bodyType"]
  '&fields=%5B%22domicileSite%22%2C%22fuelType%22%2C%22bodyType%22%2C%22engineManufacturerName%22%2C%22lifecycleStateReason%22%2C%22manufacturer%22%2C%22openUnplannedWorkRequests%22%2C%22openPlannedWorkRequests%22%2C%22lastGeofences%22%2C%22latLong%22%2C%22assetId%22%2C%22owner%22%5D' +
  '&flags=%7B%7D' +
  '&sortColumn=lifecycleStateReason' +
  '&limit=1000&pageSize=1000' +
  '&sortDirection=descending';

// buildScanURL — base URL is hardcoded; appends &search= when domiciles are set in Fleet Config.
// Examples:
//   No filter   → AAP_SCAN_URL (all fleets, no search param)
//   ['ABE40']   → AAP_SCAN_URL + '&search=abe40'
//   ['ABE40','SAPB','TUZR'] → AAP_SCAN_URL + '&search=abe40+sapb+tuzr'
function buildScanURL(domiciles) {
  if (!domiciles || domiciles.length === 0) return AAP_SCAN_URL;
  const searchVal = domiciles.map(d => encodeURIComponent(d.toLowerCase())).join('+');
  return AAP_SCAN_URL + '&search=' + searchVal;
}


const FIELD_MAP = {
  // ── Display name → internal field (verified from Chrome localStorage 2026-06-18) ──
  'Equipment ID':           'equipmentId',
  'Vehicle ID':             'equipmentId',       // alternate label
  'Asset type':             'assetType',
  'Asset Type':             'assetType',
  'Lifecycle state':        'lifecycleState',
  'Lifecycle State':        'lifecycleState',
  'Lifecycle state reason': 'lifecycleReason',   // maps to lifecycleStateReason in AAP API
  'Lifecycle State Reason': 'lifecycleReason',
  'Operator':               'operator',
  'Owner':                  'operator',          // AAP 6-col default uses "Owner"
  'Manufacturer':           'manufacturer',
  'Manufacturer name':      'manufacturer',      // manufacturerName → display as "Manufacturer name"
  'Body type':              'bodyType',
  'Body Type':              'bodyType',
  'Due date':               'dueDate',
  'Due Date':               'dueDate',
  'Maintenance due date':   'dueDate',
  'Engine manufacturer':    'engineManufacturer',
  'Engine manufacturer name': 'engineManufacturer',
  'Domicile site':          'domicileSite',
  'Domicile Site':          'domicileSite',
  'Fuel type':              'fuelType',
  'Fuel Type':              'fuelType',
  'Open unplanned work requests': 'openUnplanned',
  'Open Unplanned Work Requests': 'openUnplanned',
  'Open planned work requests':   'openPlanned',
};

// ── Injected script — ported directly from TM autoForce1000 ──────────────────
// Fully synchronous-return safe: wraps everything in try/catch, returns result as data.
// Uses mousedown+mouseup+click (React requires all three).
// ── Hash-agnostic AAP table selector ───────────────────────────────────────────────────
// AAP uses Chakra UI / CSS Modules — the class hash (css-1op8d4g) changes on every
// deploy.  We find the table by structure: any <table> with a <thead> of ≥3 <th>s.
// All injected scripts call findAAPTable() instead of a hardcoded class.
const FIND_TABLE_FN = `
  function findAAPTable() {
    var t = document.querySelector('table[class*="css-"]');
    if (t && t.querySelector('thead th')) return t;
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelectorAll('thead th').length >= 3) return tables[i];
    }
    return null;
  }
`;

const FORCE_1000_AND_SCRAPE = FIND_TABLE_FN + `(function() {
  try {
    function simulateClick(el) {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    }

    // ── Find Results per page dropdown ──────────────────────────────────────
    var rppEl =
      document.querySelector('[aria-label="Results per page"]') ||
      document.querySelector('[data-testid="results-per-page"]') ||
      (function(){
        var btns = document.querySelectorAll('button,[role="button"],[role="combobox"],select');
        for (var i=0; i<btns.length; i++) {
          if (btns[i].textContent.includes('150') ||
              btns[i].closest('[class*="pagination"]') ||
              btns[i].closest('[class*="page-size"]')) return btns[i];
        }
        return null;
      })();

    if (!rppEl) {
      var allEls = document.querySelectorAll('*');
      for (var i=0; i<allEls.length; i++) {
        var t = allEls[i].textContent.trim();
        if (t === 'Results per page' || t === '150') {
          var parent = allEls[i].closest('div');
          if (parent) {
            rppEl = parent.querySelector('button,select,[role="button"],[role="listbox"],[role="combobox"]') || allEls[i];
          } else {
            rppEl = allEls[i];
          }
          break;
        }
      }
    }

    var rppFound = !!rppEl;
    if (rppEl) {
      simulateClick(rppEl);
    }

    return {
      step: 'rpp_clicked',
      rppFound: rppFound,
      rppTag: rppEl ? rppEl.tagName : null,
      rppText: rppEl ? (rppEl.textContent||'').trim().slice(0,40) : null,
      url: window.location.href,
      tableExists: !!findAAPTable()
    };
  } catch(e) {
    return { step: 'rpp_clicked', error: e.message };
  }
})()`;

const CLICK_1000_OPTION = `(function() {
  try {
    function simulateClick(el) {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    }

    var opts = document.querySelectorAll('[role="option"],[role="menuitem"],li,option');
    for (var i=0; i<opts.length; i++) {
      if ((opts[i].textContent||'').trim() === '1000') {
        simulateClick(opts[i]);
        return { clicked: true, method: 'option' };
      }
    }

    // Fallback: native select
    var sel = document.querySelector('select');
    if (sel) {
      try {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, '1000');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { clicked: true, method: 'native_select' };
      } catch(se) {}
    }

    var available = [];
    var lis = document.querySelectorAll('[role="option"],[role="menuitem"],li');
    for (var j=0; j<Math.min(lis.length,20); j++) {
      var txt = (lis[j].textContent||'').trim();
      if (txt) available.push(txt);
    }
    return { clicked: false, available: available };
  } catch(e) {
    return { clicked: false, error: e.message };
  }
})()`;

const POLL_TABLE = FIND_TABLE_FN + `(function() {
  try {
    var url = window.location.href;
    var isSSO = /midway|login\\.amazon|signin|sso\\.amazon|oidc|oauth|\\/auth\\//i.test(url)
                && !/aap-na\\.corp\\.amazon\\.com/i.test(url);
    if (isSSO) return { status: 'sso', url: url };

    // Still on a redirect / non-AAP page
    if (!/aap-na\\.corp\\.amazon\\.com/i.test(url)) {
      return { status: 'waiting', url: url, title: document.title };
    }

    var tbl = findAAPTable();
    if (!tbl) {
      // Check if a loading spinner is present
      var isLoading = !!(
        document.querySelector('[class*="loading"]') ||
        document.querySelector('[class*="spinner"]') ||
        document.querySelector('[aria-label*="loading" i]') ||
        document.querySelector('[data-testid*="loading"]')
      );
      return { status: isLoading ? 'loading' : 'waiting', url: url, title: document.title };
    }

    var rows = tbl.querySelectorAll('tbody tr');
    var tds  = tbl.querySelectorAll('tbody tr td');
    if (!tds.length) {
      return { status: 'empty_table', url: url, rowCount: rows.length };
    }

    // AAP virtual scroller renders <td> shells BEFORE populating text content.
    // Check that at least the first row has non-empty cell text before declaring ready.
    var firstRowText = '';
    var firstTds = rows.length > 0 ? rows[0].querySelectorAll('td') : [];
    for (var ci = 0; ci < firstTds.length; ci++) {
      var txt = (firstTds[ci].textContent || '').trim();
      if (txt.length > 0) { firstRowText = txt; break; }
    }
    if (!firstRowText) {
      return { status: 'empty_cells', url: url, rowCount: rows.length, tdCount: tds.length };
    }

    return { status: 'ready', rowCount: rows.length };
  } catch(e) {
    return { status: 'error', msg: e.message };
  }
})()`;

// Exact getCellText + scrape logic from TM lines 24707-24754
const EXTRACT_TABLE = FIND_TABLE_FN + `(function() {
  try {
    function getCellText(cell) {
      if (cell.title && cell.title.trim() && !cell.title.includes('.')) return cell.title.trim();
      var childTitles = [];
      var titled = cell.querySelectorAll('[title]');
      for (var i=0; i<titled.length; i++) {
        var t = (titled[i].title||'').trim();
        if (t && !t.includes('.')) childTitles.push(t);
      }
      if (childTitles.length) return childTitles.join(' | ');
      var ariaLabel = cell.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      var raw = (cell.textContent||'').trim();
      if (raw) {
        return raw.replace(/[\\r\\n]+/g,'\\n')
                  .split('\\n')
                  .map(function(s){ return s.trim(); })
                  .filter(function(s){ return s.length > 0; })
                  .join(' | ');
      }
      return '';
    }

    var allData = [];
    var headers = [];
    var tables = (function(){ var t=findAAPTable(); return t ? [t] : []; })();

    if (!tables.length) return { error: 'No AAP data table found', url: window.location.href };

    for (var t=0; t<tables.length; t++) {
      var table = tables[t];
      if (headers.length === 0) {
        var ths = table.querySelectorAll('thead th');
        for (var h=0; h<ths.length; h++) {
          headers.push((ths[h].innerText||ths[h].textContent||'').trim());
        }
      }
      var rows = table.querySelectorAll('tbody tr');
      for (var r=0; r<rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (!cells.length) continue;
        var obj = {};
        for (var c=0; c<cells.length; c++) {
          obj[headers[c] || ('col'+c)] = getCellText(cells[c]);
        }
        allData.push(obj);
      }
    }

    return { rows: allData, headers: headers, count: allData.length, scrapedAt: new Date().toISOString() };
  } catch(e) {
    return { error: 'Extraction error: ' + e.message };
  }
})()`;

// ── Main scrape ───────────────────────────────────────────────────────────────
// ── AAP localStorage column config (copied from user's real Chrome session) ──────
// Key:   columns_bafc8b2a-3be6-4a52-a86f-7cb2de7b5400
// Value: the exact field list AAP uses to render columns (verified 2026-06-18)
const AAP_COL_KEY   = 'columns_bafc8b2a-3be6-4a52-a86f-7cb2de7b5400';
const AAP_COL_VALUE = JSON.stringify([
  'vehicleId', 'assetType', 'lifecycleState', 'lifecycleStateReason',
  'operator', 'manufacturerName', 'bodyType', 'maintenanceDueDate',
  'engineManufacturerName', 'domicileSite', 'fuelType',
  'openUnplannedWorkRequests', 'openPlannedWorkRequests'
]);

// H-4: named constant — was an unnamed inline literal inside pollAndScrape()
// 45 s: fail-fast budget; scraper retries sooner on dead sessions than waiting 90 s.
const TABLE_WAIT_MS = 45_000;

async function _scrapeAAPOnce(domiciles) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show:   false,
      width:  1600,
      height: 900,
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
      }
    });

    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(masterTimeout);
      try { win.destroy(); } catch(_) {}
      if (err) reject(err); else resolve(data);
    };

    const masterTimeout = setTimeout(
      () => finish(new Error('AAP scrape timed out after 180s')),
      180000
    );

    win.webContents.on('did-fail-load', (_, code, desc) => {
      if (code === -3) return;
      finish(new Error('Page load failed: ' + desc + ' (' + code + ')'));
    });

    // ── Step 1: inject fetch/XHR interceptor on dom-ready (before React mounts) ─
    win.webContents.on('dom-ready', async () => {
      logger.info('[AAP] dom-ready - injecting fetch interceptor + column config');
      try {
        // Inject localStorage column config
        const colJs = 'localStorage.setItem(' + JSON.stringify(AAP_COL_KEY) + ','
          + JSON.stringify(AAP_COL_VALUE) + ');'
          + '"col:injected"';
        await win.webContents.executeJavaScript(colJs);
        logger.info('[AAP] Column config injected into localStorage');
      } catch(e) {
        logger.warn('[AAP] Col inject failed:', e.message);
      }
      try {
        // Inject fetch/XHR interceptor
        const interceptJs = `
  (function() {
    if (window.__AAP_INTERCEPT_INSTALLED__) return 'already';
    window.__AAP_INTERCEPT_INSTALLED__ = true;
    window.__AAP_ASSETS__ = null;
    window.__AAP_ASSETS_RAW__ = null;

    var TARGET = '/api/v2/assets/search';

    // Patch fetch
    var _origFetch = window.fetch;
    window.fetch = function(url, opts) {
      var urlStr = (typeof url === 'string') ? url : (url && url.url) || String(url);
      var p = _origFetch.apply(this, arguments);
      if (urlStr.indexOf(TARGET) !== -1) {
        return p.then(function(resp) {
          var clone = resp.clone();
          clone.json().then(function(data) {
            window.__AAP_ASSETS_RAW__ = data;
            var items = data.assets || data.equipment || data.items || data.results || data.data || data;
            if (Array.isArray(items) && items.length > 0) {
              window.__AAP_ASSETS__ = items;
              console.log('[AAP-INTERCEPT] fetch captured', items.length, 'assets');
            } else if (data && typeof data === 'object') {
              // Try one level deeper
              var keys = Object.keys(data);
              for (var i = 0; i < keys.length; i++) {
                var v = data[keys[i]];
                if (Array.isArray(v) && v.length > 0 && v[0] && (v[0].vehicleId || v[0].equipmentId || v[0].assetId)) {
                  window.__AAP_ASSETS__ = v;
                  console.log('[AAP-INTERCEPT] fetch captured (nested key=' + keys[i] + ')', v.length, 'assets');
                  break;
                }
              }
            }
            if (!window.__AAP_ASSETS__) {
              console.log('[AAP-INTERCEPT] fetch response captured but no asset array found. Keys:', Object.keys(data).join(','), 'raw:', JSON.stringify(data).slice(0,300));
            }
          }).catch(function(e){ console.log('[AAP-INTERCEPT] fetch json parse error:', e.message); });
          return resp;
        });
      }
      return p;
    };

    // Patch XHR as fallback
    var _origOpen = XMLHttpRequest.prototype.open;
    var _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._aapUrl = String(url || '');
      return _origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      if (this._aapUrl && this._aapUrl.indexOf(TARGET) !== -1) {
        var xhr = this;
        this.addEventListener('load', function() {
          try {
            var data = JSON.parse(xhr.responseText);
            window.__AAP_ASSETS_RAW__ = data;
            var items = data.assets || data.equipment || data.items || data.results || data.data || data;
            if (Array.isArray(items) && items.length > 0) {
              window.__AAP_ASSETS__ = items;
              console.log('[AAP-INTERCEPT] XHR captured', items.length, 'assets');
            }
          } catch(e) { console.log('[AAP-INTERCEPT] XHR parse error:', e.message); }
        });
      }
      return _origSend.apply(this, arguments);
    };

    return 'installed';
  })()
`;
        const r = await win.webContents.executeJavaScript(interceptJs);
        logger.info('[AAP] Fetch interceptor:', r);
      } catch(e) {
        logger.warn('[AAP] Fetch interceptor failed:', e.message);
      }
    });

    // ── Step 2: after page load, poll window.__AAP_ASSETS__ ──────────────────
    win.webContents.on('did-finish-load', async () => {
      logger.info('[AAP] Page loaded - polling for intercepted assets...');
      const MAX_WAIT = 60000;
      const POLL_MS  = 500;
      const t0 = Date.now();
      let rawStored = null;

      while (Date.now() - t0 < MAX_WAIT && !done) {
        await sleep(POLL_MS);
        if (win.isDestroyed()) return;
        try {
          const check = await win.webContents.executeJavaScript(
            '(function(){ var a=window.__AAP_ASSETS__; var r=window.__AAP_ASSETS_RAW__;'
            + ' return { count: a ? a.length : -1, hasRaw: !!r, rawKeys: r ? Object.keys(r).join(",") : "" }; })()'
          );
          if ((Date.now() - t0) % 5000 < POLL_MS + 100) {
            logger.info('[AAP] Poll:', JSON.stringify(check));
          }
          if (check.count > 0) {
            logger.info('[AAP] Assets captured via __AAP_ASSETS__! count=' + check.count);
            rawStored = await win.webContents.executeJavaScript('JSON.stringify(window.__AAP_ASSETS__)');
            break;
          }
          // hasRaw=true but count=-1 means raw response present but interceptor
          // didn't find the assets array — only bail if raw has 'assets' key
          // (count-only response with just totalRecordCountInDB should keep waiting)
          if (check.hasRaw && check.count === -1 && check.rawKeys.indexOf('assets') !== -1) {
            logger.info('[AAP] Raw has assets key but __AAP_ASSETS__ not set. rawKeys:', check.rawKeys);
            rawStored = await win.webContents.executeJavaScript('JSON.stringify(window.__AAP_ASSETS_RAW__)');
            break;
          }
          if (check.hasRaw && check.count === -1) {
            logger.info('[AAP] Partial response (count-only), still waiting... rawKeys:', check.rawKeys);
          }
        } catch(e) {
          logger.warn('[AAP] Poll error:', e.message);
        }
      }

      if (done) return;

      if (rawStored) {
        try {
          const raw = JSON.parse(rawStored);
          logger.info('[AAP] Raw type:', typeof raw, Array.isArray(raw) ? 'array len=' + raw.length : 'object keys=' + Object.keys(raw).join(','));

          // Normalize to array
          let items = Array.isArray(raw) ? raw
            : raw.assets || raw.equipment || raw.items || raw.results || raw.data || [];

          // If still not an array, scan one level deep
          if (!Array.isArray(items) || items.length === 0) {
            const keys = Object.keys(raw);
            for (const k of keys) {
              const v = raw[k];
              if (Array.isArray(v) && v.length > 0 && v[0] && (v[0].vehicleId || v[0].equipmentId || v[0].assetId)) {
                items = v;
                logger.info('[AAP] Found asset array at key:', k, 'len:', items.length);
                break;
              }
            }
          }

          logger.info('[AAP] Mapping', items.length, 'items');
          if (items.length > 0) logger.info('[AAP] Sample item keys:', Object.keys(items[0]).join(','));
          if (items.length > 0) logger.info('[AAP] Sample item[0].asset:', JSON.stringify(items[0].asset || {}).slice(0,500));
          if (items.length > 0) logger.info('[AAP] Sample item[0].payload:', JSON.stringify(items[0].payload || {}).slice(0,300));
          if (items.length > 0) logger.info('[AAP] Sample item[0].maintenanceScheduleStatuses:', JSON.stringify(items[0].maintenanceScheduleStatuses || []).slice(0,300));

          const mapped = items.map(r => {
            // Confirmed API schema (2026-06-29):
            //   r.asset              = core asset object
            //   r.asset.attributesText = flat kv bag (vehicleId, operator, manufacturerName, etc.)
            //   r.payload            = { openUnplannedWorkRequestIds:[], openPlannedWorkRequestIds:[] }
            //   r.maintenanceScheduleStatuses = [ { maintenanceType, nextDueDate, daysUntilDue, ... } ]
            const a    = r.asset || r;
            const attr = a.attributesText || {};
            const pay  = r.payload || {};

            // Build dueDate string from maintenanceScheduleStatuses
            // Format: 'Overdue 5 months\n\nPM A\n\nJul 28, 2026\n\nPM B' etc.
            const pmStatuses = Array.isArray(r.maintenanceScheduleStatuses) ? r.maintenanceScheduleStatuses : [];
            const dueDate = pmStatuses.map(s => {
              const days = s.daysUntilDue != null ? Number(s.daysUntilDue) : null;
              let dateLabel = '';
              if (s.nextDueDate) {
                const d = new Date(s.nextDueDate);
                dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              }
              const overdueLabel = (days != null && days < 0)
                ? 'Overdue ' + Math.abs(Math.round(days / 30)) + ' months'
                : dateLabel;
              const typeLabel = s.maintenanceType || '';
              return (overdueLabel || dateLabel) + (typeLabel ? '\n\n' + typeLabel : '');
            }).filter(Boolean).join('\n\n');

            // openUnplanned / openPlanned — payload has arrays of IDs
            const openUnplanned = String(
              (Array.isArray(pay.openUnplannedWorkRequestIds) ? pay.openUnplannedWorkRequestIds.length : null)
              ?? pay.openUnplannedWorkRequests ?? attr.openUnplannedWorkRequests ?? ''
            );
            const openPlanned = String(
              (Array.isArray(pay.openPlannedWorkRequestIds) ? pay.openPlannedWorkRequestIds.length : null)
              ?? pay.openPlannedWorkRequests ?? attr.openPlannedWorkRequests ?? ''
            );

            return {
              equipmentId:      attr.vehicleId || a.displayName || a.equipmentId || r.displayName || '',
              lifecycleState:   a.lifecycleState || '',
              lifecycleReason:  a.lifecycleStateReason || '',
              assetType:        a.assetType || attr.assetType || '',
              bodyType:         attr.bodyType || a.bodyType || a.assetType || '',
              manufacturer:     attr.manufacturerName || attr.manufacturer || '',
              domicileSite:     attr.domicileSite || attr.domicile || a.domicileSite || '',
              operator:         attr.operator || a.operator || '',
              fuelType:         attr.fuelType || a.fuelType || '',
              openUnplanned,
              openPlanned,
              dueDate,
              engineManufacturer: attr.engineManufacturerName || attr.engineManufacturer || '',
              geofence:         attr.geofence || a.geofence || r.geofence || '',
            };
          }).filter(r => r.equipmentId);

          if (mapped.length > 0) {
            logger.info('[AAP] SUCCESS via fetch intercept:', mapped.length, 'units');
            if (mapped[0]) logger.info('[AAP] Sample unit:', JSON.stringify(mapped[0]));
            finish(null, { source: 'aap', rows: mapped, count: mapped.length, scrapedAt: new Date().toISOString() });
            return;
          } else {
            logger.warn('[AAP] items array present but 0 mapped (no equipmentId). Sample:', JSON.stringify(items[0]).slice(0,200));
          }
        } catch(e) {
          logger.warn('[AAP] Raw parse/map failed:', e.message);
        }
      }

      // ── Fallback: DOM-based pollAndScrape ────────────────────────────────────
      logger.warn('[AAP] fetch intercept gave no data — falling back to pollAndScrape');
      pollAndScrape(win, finish);
    });

    // fields= param now set in AAP_SCAN_URL — CDP diagnostic block removed (field registry confirmed)

    win.loadURL(buildScanURL(domiciles));
  });
}

async function orchaScrape(win, finish) {
  // Simple approach: wait for table, grab all text, parse rows
  const MAX_WAIT = 90000;
  const t0 = Date.now();
  
  logger.info('[AAP-Orcha] Waiting for table to render...');
  
  // Poll until we find table rows
  while (Date.now() - t0 < MAX_WAIT) {
    await sleep(2000);
    if (win.isDestroyed()) return;
    
    try {
      const check = await win.webContents.executeJavaScript(`
        (function() {
          var tbl = document.querySelector('table[class*="css-"]') || document.querySelector('table');
          if (!tbl) return { found: false, status: 'no_table' };
          var rows = tbl.querySelectorAll('tbody tr');
          return { found: rows.length > 0, rowCount: rows.length, status: rows.length > 0 ? 'ready' : 'empty' };
        })();
      `);
      
      logger.info('[AAP-Orcha] Check:', JSON.stringify(check));
      
      if (check.found && check.rowCount > 0) {
        logger.info('[AAP-Orcha] Table has ' + check.rowCount + ' rows - extracting...');
        break;
      }
      
      // Try clicking "Results per page" to trigger render
      if (check.status === 'empty' && (Date.now() - t0) > 10000) {
        await win.webContents.executeJavaScript(`
          (function() {
            // Try to find and click page size selector
            var btns = document.querySelectorAll('button,[role="button"],[role="combobox"]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].textContent.includes('150') || btns[i].textContent.includes('Results')) {
                btns[i].click();
                return 'clicked_rpp';
              }
            }
            // Try scrolling the table area
            var scroller = document.querySelector('[class*="virtualiz"]') || document.querySelector('table');
            if (scroller) { scroller.scrollTop = 100; setTimeout(function(){ scroller.scrollTop = 0; }, 500); return 'scrolled'; }
            return 'nothing_found';
          })();
        `).then(r => logger.info('[AAP-Orcha] Nudge:', r)).catch(() => {});
      }
    } catch(e) {
      logger.info('[AAP-Orcha] Poll error:', e.message);
    }
  }
  
  // Extract data using simple DOM read
  try {
    const rawData = await win.webContents.executeJavaScript(`
      (function() {
        var tbl = document.querySelector('table[class*="css-"]') || document.querySelector('table');
        if (!tbl) return JSON.stringify({ error: 'no table', rows: [] });
        
        // Get headers
        var headers = [];
        var ths = tbl.querySelectorAll('thead th');
        for (var h = 0; h < ths.length; h++) {
          headers.push((ths[h].innerText || ths[h].textContent || '').trim().split('\\n').join(' '));
        }
        
        // Get rows
        var allRows = [];
        var trs = tbl.querySelectorAll('tbody tr');
        for (var r = 0; r < trs.length; r++) {
          var cells = trs[r].querySelectorAll('td');
          if (cells.length < 3) continue;
          var row = {};
          for (var c = 0; c < cells.length; c++) {
            var key = headers[c] || ('col' + c);
            row[key] = (cells[c].innerText || cells[c].textContent || '').trim();
          }
          // Extract asset URL from any link
          var links = trs[r].querySelectorAll('a[href]');
          for (var a = 0; a < links.length; a++) {
            var href = links[a].getAttribute('href') || '';
            if (href.includes('/v2/asset/')) { row._assetUrl = href; break; }
          }
          if (row[headers[0]]) allRows.push(row);
        }
        
        return JSON.stringify({ headers: headers, rows: allRows, count: allRows.length });
      })();
    `);
    
    const result = JSON.parse(rawData);
    logger.info('[AAP-Orcha] Extracted ' + result.count + ' rows with headers: ' + (result.headers || []).join(', '));
    
    if (result.count === 0) {
      finish(new Error('Table rendered but 0 rows extracted'));
      return;
    }
    
    // Map headers to our FIELD_MAP
    const mapped = result.rows.map(row => {
      const item = {};
      Object.keys(row).forEach(k => {
        if (k === '_assetUrl') { item.assetUrl = row[k]; return; }
        const key = FIELD_MAP[k] || FIELD_MAP[k.split('\\n').join(' ').trim()];
        if (key) item[key] = row[k];
        else if (k && !k.startsWith('col')) { if (!item._unmapped) item._unmapped = ''; item._unmapped += k + '|'; }
      });
      return item;
    }).filter(item => item.equipmentId);
    
    logger.info('[AAP-Orcha] Mapped ' + mapped.length + ' units');
    finish(null, { rows: mapped, count: mapped.length, headers: result.headers, scrapedAt: new Date().toISOString() });
    
  } catch(e) {
    logger.info('[AAP-Orcha] Extract error:', e.message);
    finish(new Error('Extraction failed: ' + e.message));
  }
}

async function pollAndScrape(win, finish) {
  // Phase 1: wait for table rows (up to 90s — AAP React SPA can be slow to render)
  // H-4: TABLE_WAIT_MS now a named module-level constant (was inline 45000)
  const POLL_MS    = 200;
  const t0         = Date.now();
  let lastStatus   = '';
  let scrollDone   = false;

  while (Date.now() - t0 < TABLE_WAIT_MS) {
    await sleep(POLL_MS);
    if (win.isDestroyed()) return;

    let check;
    try { check = await win.webContents.executeJavaScript(POLL_TABLE); }
    catch(e) { continue; }

    if (check.status !== lastStatus) {
      logger.info('[AAP] Status changed:', lastStatus, '->', check.status,
        '| rows:', check.rowCount, '| url:', (check.url||'').slice(0,60));
      lastStatus = check.status;
    }

    if (check.status === 'sso') {
      finish(Object.assign(new Error('AAP_AUTH_REQUIRED'), { code: 'AAP_AUTH_REQUIRED' }));
      return;
    }
    if (check.status === 'ready') break;
    if (check.status === 'error') { finish(new Error('Page error: ' + check.msg)); return; }

    // If table exists but empty, try a scroll nudge after 3s to kick React virtualizer
    if ((check.status === 'empty_table' || check.status === 'empty_cells') && !scrollDone && (Date.now() - t0) > 3000) {
      scrollDone = true;
      logger.info('[AAP] Table empty — trying scroll nudge to trigger React render...');
      await win.webContents.executeJavaScript(FIND_TABLE_FN + `
        (function() {
          var tbl = findAAPTable();
          if (tbl) {
            var scroller = tbl.closest('[class*="scroll"]') || tbl.closest('[style*="overflow"]') || tbl.parentElement;
            if (scroller) { scroller.scrollTop = 1; scroller.scrollTop = 0; }
            window.scrollTo(0, 100); window.scrollTo(0, 0);
          }
          // Also click the Equipment ID header to trigger sort/render
          var ths = (function(){ var t=document.querySelector('table[class*="css-"]') || (function(){ var ts=document.querySelectorAll('table'); for(var i=0;i<ts.length;i++) if(ts[i].querySelectorAll('thead th').length>=3) return ts[i]; return null; })(); return t ? t.querySelectorAll('thead th') : []; })();
          if (ths.length > 0) {
            ths[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }
        })()
      `).catch(() => {});
    }

    // Log every 10s
    if ((Date.now() - t0) % 10000 < POLL_MS + 50) {
      logger.info('[AAP] Still waiting...', Math.round((Date.now()-t0)/1000)+'s',
        'status:', check.status);
    }
  }

  // ── Log final poll state before proceeding ──────────────────────────────────
  const finalPoll = await win.webContents.executeJavaScript(POLL_TABLE).catch(() => ({}));
  logger.info('[AAP] Poll finished. Final state:', JSON.stringify(finalPoll));

  // ── Snapshot the raw page HTML for debugging (saved to AppData) ─────────────
  try {
    const snap = await win.webContents.executeJavaScript(FIND_TABLE_FN + `(function(){
      return {
        url:   window.location.href,
        title: document.title,
        tableClass: (document.querySelector('table') || {}).className || 'NO TABLE',
        allTableClasses: Array.from(document.querySelectorAll('table')).map(t=>t.className).join(' | '),
        bodyText: document.body ? document.body.innerText.slice(0,500) : 'NO BODY',
        tableCount: document.querySelectorAll('table').length,
        targetTable: !!findAAPTable(),
      };
    })()`);
    const debugPath = require('path').join(P.dataDir, 'aap_debug.json');
    fs.writeFileSync(debugPath, JSON.stringify(snap, null, 2));
    logger.info('[AAP] Debug snapshot saved to', debugPath);
    logger.info('[AAP] Snapshot:', JSON.stringify(snap));
  } catch(de) {
    logger.warn('[AAP] Debug snapshot failed:', de.message);
  }

  if (win.isDestroyed()) return;

  // Phase 2: simulateClick RPP dropdown (mousedown+mouseup+click)
  try {
    const r1 = await win.webContents.executeJavaScript(FORCE_1000_AND_SCRAPE);
    logger.info('[AAP] RPP click:', JSON.stringify(r1));

    if (r1.rppFound) {
      await sleep(300); // exact same wait as TM (line 24673)

      const r2 = await win.webContents.executeJavaScript(CLICK_1000_OPTION);
      logger.info('[AAP] 1000 option:', JSON.stringify(r2));

      if (r2.clicked) {
        // Wait for React to re-render 1000 rows — poll same as TM (line 25022)
        const t1 = Date.now();
        while (Date.now() - t1 < 10000) {
          await sleep(100);
          if (win.isDestroyed()) return;
          let chk;
          try { chk = await win.webContents.executeJavaScript(POLL_TABLE); } catch(_) { continue; }
          if (chk.status === 'ready') break;
        }
      }
    }
  } catch(e) {
    logger.warn('[AAP] Force-1000 failed (non-fatal):', e.message);
  }

  // Phase 3: extract
  if (win.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(EXTRACT_TABLE);
    logger.info('[AAP] Extracted:', result.count, 'rows', result.error || '');

    // ── DEBUG: log exact headers and first row so we can verify FIELD_MAP ──────
    if (result.headers && result.headers.length) {
      logger.info('[AAP] Headers:', JSON.stringify(result.headers));
    }
    if (result.rows && result.rows.length > 0) {
      logger.info('[AAP] Row[0] raw:', JSON.stringify(result.rows[0]));
    }
    // ──────────────────────────────────────────────────────────────────────────

    if (result.error) { finish(new Error(result.error)); return; }

    const mapped = (result.rows || []).map(row => {
      const item = {};
      Object.keys(row).forEach(k => { const key = FIELD_MAP[k]; if (key) item[key] = row[k]; });
      return item;
    }).filter(item => item.equipmentId);

    // Log first mapped row so we can see what fields came through
    if (mapped.length > 0) {
      logger.info('[AAP] Mapped row[0]:', JSON.stringify(mapped[0]));
    }

    // ── DEBUG: save raw headers + first row to disk so FIELD_MAP can be verified ──
    try {
      const headerDebug = {
        headers:  result.headers  || [],
        row0_raw: result.rows?.[0] || {},
        row0_mapped: mapped[0]    || {},
        count:    result.count,
        savedAt:  new Date().toISOString(),
      };
      fs.writeFileSync(
        require('path').join(P.dataDir, 'aap_headers.json'),
        JSON.stringify(headerDebug, null, 2)
      );
    } catch(_) {}

    finish(null, { source: 'aap', rows: mapped, count: mapped.length, scrapedAt: result.scrapedAt });
  } catch(e) {
    finish(new Error('Extraction failed: ' + e.message));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * scrapeAAP(domiciles) -- P1-A: withRetry wrapper
 * Wraps _scrapeAAPOnce: up to 3 attempts, 5s backoff (doubles each retry).
 * Fresh BrowserWindow per attempt -- destroyed on error/timeout.
 * Retries: React render timeout, 0-row extraction, load failure.
 */
async function scrapeAAP(domiciles) {
  return withRetry(() => _scrapeAAPOnce(domiciles), {
    attempts:  3,
    backoffMs: 5000,
    label:     'aap-scrape',
  });
}

module.exports = { scrapeAAP, buildScanURL, AAP_SCAN_URL };
