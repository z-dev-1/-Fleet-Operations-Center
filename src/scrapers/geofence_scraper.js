'use strict';
/**
 * Geofence Scraper — Fleet Monitoring page on AAP
 *
 * Scrapes: Equipment ID, Last Geofence, Lat/Long
 * For:     Unavailable units only
 * Cache:   Saves to geofence_cache.json for fast lookup
 *
 * Stage 5 Step 1 (2026-06-28):
 *   C-1: Added GEOFENCE_TIMEOUT_MS master timeout (60 s)
 *   H-2: safeWinClose() helper — tolerates already-destroyed windows, no double-destroy crash
 *   L-4: Error envelope now includes errorCode for caller disambiguation
 */

// Lazy-loaded in scrapeGeofences() to avoid early require before app ready
let BrowserWindow, session;
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('geofence');

const CACHE_FILE          = P.geofenceCache;
const GEOFENCE_TIMEOUT_MS = 60_000;  // C-1: master timeout — prevents infinite hang

// ── Safe window close helper (H-2) ───────────────────────────────────────────
// Tolerates already-destroyed windows. Use everywhere instead of direct destroy calls.
function safeWinClose(win) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch (_) {}
}

// Fleet IDs (Z's domicile settings)
const FLEET_IDS = [
  '0bb2e249-fd34-437f-83af-d1d69150558b',
  '0f454f75-1e45-475f-8d8b-2334ade1f6f1',
  '5c19cdf7-ce2f-4593-a37a-3fe5d506e120',
  '7de393df-74e1-45af-9650-560ba008bc65',
  'b84ddc20-589c-4330-af67-3d38f89e28af',
  'b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe',
  'ba97eda1-cb03-446e-a907-474084194777',
  'daa83ad7-5d8f-43a4-ba9c-76c643e45e1e'
];

function buildFleetMonitoringUrl() {
  const states = JSON.stringify([
    { state: 'ACTIVE', reasons: [] },
    { state: 'UNAVAILABLE', reasons: [] }
  ]);
  const fleets = JSON.stringify(FLEET_IDS);
  const params = new URLSearchParams({
    states: states,
    operationalStatuses: '[]',
    geofences: JSON.stringify({ type: 'ANYWHERE', customGeofences: [] }),
    stationCodes: '[]',
    dspShortCodes: '[]',
    domicileSites: '[]',
    fleets: fleets,
    fields: '[]',
    flags: '{}'
  });
  return 'https://aap-na.corp.amazon.com/v2/page/dfd44913-d2f4-4e96-99e2-64729dbdc19a?' + params.toString();
}

// Extraction script — grabs Equipment ID, Last Geofence, Lat/Long from table
const GEOFENCE_EXTRACT = `
(function() {
  var results = [];

  var tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
  var rows = [];

  tables.forEach(function(t) {
    t.querySelectorAll('tr, [role="row"]').forEach(function(r) { rows.push(r); });
  });

  if (rows.length < 2) {
    rows = Array.from(document.querySelectorAll('[class*="row"], [class*="Row"], [data-rowindex]'));
  }

  var headers = [];
  var firstRow = rows[0];
  if (firstRow) {
    firstRow.querySelectorAll('th, [role="columnheader"], [class*="header"]').forEach(function(h) {
      headers.push((h.innerText || h.textContent || '').trim().toLowerCase());
    });
  }

  var eqIdx = -1, geoIdx = -1, latIdx = -1;
  headers.forEach(function(h, i) {
    if (h.indexOf('equipment') > -1 || h.indexOf('asset id') > -1) eqIdx = i;
    if (h.indexOf('geofence') > -1 || h.indexOf('location') > -1 || h.indexOf('last geo') > -1) geoIdx = i;
    if (h.indexOf('lat') > -1 || h.indexOf('coordinate') > -1) latIdx = i;
  });

  for (var i = 1; i < rows.length; i++) {
    var cells = rows[i].querySelectorAll('td, [role="cell"], [role="gridcell"]');
    if (cells.length < 2) continue;

    var equipId  = '';
    var geofence = '';
    var latLong  = '';

    if (eqIdx  >= 0 && cells[eqIdx])  equipId  = (cells[eqIdx].innerText  || '').trim();
    if (geoIdx >= 0 && cells[geoIdx]) geofence = (cells[geoIdx].innerText || '').trim();
    if (latIdx >= 0 && cells[latIdx]) latLong  = (cells[latIdx].innerText || '').trim();

    if (!equipId && cells[0]) equipId = (cells[0].innerText || '').trim();
    if (!geofence) {
      for (var c = 1; c < cells.length; c++) {
        var ct = (cells[c].innerText || '').trim();
        if (/^[A-Z]{3,4}\\d{1,2}$/i.test(ct) || ct.indexOf('Geofence') > -1 || /^[A-Z0-9_-]{4,10}$/.test(ct)) {
          geofence = ct;
          break;
        }
      }
    }
    if (!latLong) {
      for (var c = 1; c < cells.length; c++) {
        var ct = (cells[c].innerText || '').trim();
        if (/^-?\\d{1,3}\\.\\d+/.test(ct)) { latLong = ct; break; }
      }
    }

    if (equipId && equipId.match(/^[A-Za-z]-?\\d{3,6}$|^V\\d{5,7}$/)) {
      results.push({ equipmentId: equipId, geofence: geofence, latLong: latLong });
    }
  }

  if (results.length === 0) {
    var fullText = (document.body ? document.body.innerText : '');
    var lines = fullText.split('\\n');
    var currentUnit = '';
    lines.forEach(function(line) {
      var unitMatch = line.match(/\\b([A-Z]-?\\d{4,6})\\b/);
      if (unitMatch) currentUnit = unitMatch[1];
      var geoMatch = line.match(/\\b([A-Z]{3,4}\\d{1,2})\\b/);
      if (currentUnit && geoMatch && geoMatch[1] !== currentUnit) {
        results.push({ equipmentId: currentUnit, geofence: geoMatch[1], latLong: '' });
      }
    });
  }

  return JSON.stringify({ count: results.length, units: results.slice(0, 300) });
})();
`;

// Load/save cache
function loadGeofenceCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveGeofenceCache(cache) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * Scrape Fleet Monitoring for geofence data
 * @param {Function} log - logging callback
 * @returns {Promise<{ok, count?, updated?, cache?, error?, errorCode?, pageInfo?}>}
 *   errorCode values: 'TIMEOUT' | 'AUTH_REQUIRED' | 'NO_DATA' | 'SCRAPE_ERROR'
 */
async function scrapeGeofences(log) {
  if (!log) log = console.log;

  // Lazy require electron modules
  if (!BrowserWindow) {
    const electron = require('electron');
    BrowserWindow  = electron.BrowserWindow;
    session        = electron.session;
  }

  const url = buildFleetMonitoringUrl();
  log('[Geofence] Opening Fleet Monitoring page: ' + url.substring(0, 80) + '...');

  // ── C-1: Master timeout race ──────────────────────────────────────────────
  // Wraps the entire scrape. If the page hangs or Midway redirects silently,
  // the Promise resolves within GEOFENCE_TIMEOUT_MS instead of hanging forever.
  let _masterTimer = null;
  let _win         = null;
  let _settled     = false;

  // Called exactly once — clears timer and destroys window
  const _settle = (result) => {
    if (_settled) return result;
    _settled = true;
    clearTimeout(_masterTimer);
    safeWinClose(_win);
    return result;
  };

  const timeoutRace = new Promise((resolve) => {
    _masterTimer = setTimeout(() => {
      logger.warn('[Geofence] Master timeout (' + GEOFENCE_TIMEOUT_MS + 'ms)');
      log('[Geofence] ⚠️ Timeout: page did not respond within ' + (GEOFENCE_TIMEOUT_MS / 1000) + 's');
      resolve(_settle({ ok: false, error: 'Scrape timed out', errorCode: 'TIMEOUT' }));
    }, GEOFENCE_TIMEOUT_MS);
  });

  const scrapeWork = (async () => {
    // Copy auth cookies from main session into scraper partition
    const ses = session.fromPartition('persist:deep-scan', { cache: true });
    try {
      const mainCookies = await session.defaultSession.cookies.get({ url: 'https://aap-na.corp.amazon.com' });
      for (const c of mainCookies) {
        await ses.cookies.set({
          url: 'https://aap-na.corp.amazon.com',
          name: c.name, value: c.value, domain: c.domain,
          path: c.path, secure: c.secure, httpOnly: c.httpOnly
        });
      }
      log('[Geofence] Auth cookies copied (' + mainCookies.length + ')');
    } catch (e) {
      log('[Geofence] Cookie copy failed: ' + e.message);
    }

    _win = new BrowserWindow({
      width: 1400, height: 900, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses }
    });

    try {
      await _win.loadURL(url);
      log('[Geofence] Page loaded, waiting for table render...');
      await new Promise(r => setTimeout(r, 8000));

      const pageCheck = await _win.webContents.executeJavaScript(`
        (function() {
          var text = (document.body ? document.body.innerText : '');
          return JSON.stringify({
            len: text.length,
            hasTable: !!document.querySelector('table, [role="grid"], [role="table"]'),
            title: document.title,
            sample: text.substring(0, 200)
          });
        })();
      `);
      const check = JSON.parse(pageCheck);
      log('[Geofence] Page check: len=' + check.len + ' hasTable=' + check.hasTable + ' title=' + check.title);

      if (check.len < 500) {
        log('[Geofence] ⚠️ Page appears empty or not loaded. May need auth.');
        // H-2: _settle() calls safeWinClose — safe on early-return paths
        return _settle({ ok: false, error: 'Page not loaded (auth required?)', errorCode: 'AUTH_REQUIRED', pageInfo: check });
      }

      // Scroll to load all rows if virtualized
      await _win.webContents.executeJavaScript(`
        (function() {
          var scroller = document.querySelector('[class*="scroll"], [class*="table-body"], [style*="overflow"]');
          if (scroller) {
            scroller.scrollTop = scroller.scrollHeight;
            setTimeout(function() { scroller.scrollTop = 0; }, 1000);
          }
        })();
      `);
      await new Promise(r => setTimeout(r, 3000));

      const raw    = await _win.webContents.executeJavaScript(GEOFENCE_EXTRACT);
      const result = JSON.parse(raw);
      log('[Geofence] Extraction result: ' + result.count + ' units found');

      // If table extraction failed, try full-page text parse as fallback
      if (result.count === 0) {
        const structDump = await _win.webContents.executeJavaScript(`
          (function() {
            var info = { tables: [], grids: [], rows: [] };
            document.querySelectorAll('table, [role="table"], [role="grid"]').forEach(function(t, i) {
              info.tables.push({ idx: i, tag: t.tagName, role: t.getAttribute('role'),
                class: (t.className || '').substring(0, 60), childCount: t.children.length });
            });
            document.querySelectorAll('[role="row"], [role="gridcell"], [data-rowindex], [class*="row"]').forEach(function(r, i) {
              if (i < 5) info.rows.push({ tag: r.tagName, role: r.getAttribute('role'),
                class: (r.className || '').substring(0, 50), text: (r.innerText || '').substring(0, 100) });
            });
            info.sample = (document.body ? document.body.innerText : '').substring(0, 1500);
            return JSON.stringify(info);
          })();
        `);
        const struct = JSON.parse(structDump);
        log('[Geofence] TABLE STRUCTURE: ' + JSON.stringify(struct.tables));
        log('[Geofence] SAMPLE ROWS: '     + JSON.stringify(struct.rows));
        log('[Geofence] PAGE SAMPLE: '     + struct.sample.substring(0, 500));

        log('[Geofence] Table extraction failed — trying full-page text fallback...');
        const fallbackRaw = await _win.webContents.executeJavaScript(`
          (function() {
            var text = (document.body ? document.body.innerText : '');
            var lines = text.split('\\n');
            var units = [];
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              var unitMatch = line.match(/\\b(\\d{5,6}|[A-Z]-?\\d{4,6})\\b/);
              if (unitMatch) {
                var unitId     = unitMatch[1];
                var geoMatch   = line.match(/\\b([A-Z]{3,5}\\d{1,2})\\b/);
                var coordMatch = line.match(/(-?\\d{1,3}\\.\\d{3,})\\s*[,\\/]\\s*(-?\\d{1,3}\\.\\d{3,})/);
                if (geoMatch || coordMatch) {
                  units.push({
                    equipmentId: unitId,
                    geofence:    geoMatch   ? geoMatch[1]                         : '',
                    latLong:     coordMatch ? coordMatch[1] + ',' + coordMatch[2] : ''
                  });
                }
              }
            }
            return JSON.stringify({ count: units.length, units: units.slice(0, 300) });
          })();
        `);
        const fallback = JSON.parse(fallbackRaw);
        log('[Geofence] Fallback extraction: ' + fallback.count + ' units');
        if (fallback.count > result.count) {
          result.count = fallback.count;
          result.units = fallback.units;
        }
      }

      // H-2: _settle() calls safeWinClose — clears timer and destroys window on success path
      _settle({});  // clears timer + destroys window; result built below

      if (result.count === 0) {
        log('[Geofence] ⚠️ No units extracted from table. Page may need different parsing.');
        return { ok: false, count: 0, error: 'No data extracted', errorCode: 'NO_DATA' };
      }

      const cache = loadGeofenceCache();
      let updated = 0;
      result.units.forEach(u => {
        const id = u.equipmentId;
        if (!id) return;
        const existing = cache[id] || {};
        const changed  = existing.geofence !== u.geofence || existing.latLong !== u.latLong;
        if (changed || !existing.geofence) {
          cache[id] = {
            geofence:    u.geofence || existing.geofence || '',
            latLong:     u.latLong  || existing.latLong  || '',
            lastUpdated: new Date().toISOString()
          };
          updated++;
        }
      });

      saveGeofenceCache(cache);
      log(`[Geofence] Done: ${result.count} units scraped, ${updated} updated. Cache has ${Object.keys(cache).length} entries.`);
      return { ok: true, count: result.count, updated, cache };

    } catch (e) {
      // H-2: _settle() in catch path — no crash on double-close
      logger.warn('[Geofence] Scrape error:', e.message);
      log('[Geofence] Error: ' + e.message);
      return _settle({ ok: false, error: e.message, errorCode: 'SCRAPE_ERROR' });
    }
  })();

  // Race: scrape work vs master timeout
  return Promise.race([scrapeWork, timeoutRace]);
}

module.exports = { scrapeGeofences, loadGeofenceCache, saveGeofenceCache, buildFleetMonitoringUrl, FLEET_IDS };
