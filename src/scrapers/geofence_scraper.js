'use strict';
/**
 * Geofence Scraper — Fleet Monitoring page on AAP
 * 
 * Scrapes: Equipment ID, Last Geofence, Lat/Long
 * For: Unavailable units only
 * Cache: Saves to geofence_cache.json for fast lookup
 */

// Lazy-loaded in scrapeGeofences() to avoid early require before app ready
let BrowserWindow, session;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('geofence');

const CACHE_FILE = P.geofenceCache;

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
  
  // Find the main data table
  var tables = document.querySelectorAll('table, [role="table"], [role="grid"]');
  var rows = [];
  
  // Try table rows first
  tables.forEach(function(t) {
    t.querySelectorAll('tr, [role="row"]').forEach(function(r) { rows.push(r); });
  });
  
  // If no table, try grid/list patterns
  if (rows.length < 2) {
    rows = Array.from(document.querySelectorAll('[class*="row"], [class*="Row"], [data-rowindex]'));
  }
  
  // Get headers to find column indices
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
  
  // Process data rows
  for (var i = 1; i < rows.length; i++) {
    var cells = rows[i].querySelectorAll('td, [role="cell"], [role="gridcell"]');
    if (cells.length < 2) continue;
    
    var equipId = '';
    var geofence = '';
    var latLong = '';
    
    if (eqIdx >= 0 && cells[eqIdx]) equipId = (cells[eqIdx].innerText || '').trim();
    if (geoIdx >= 0 && cells[geoIdx]) geofence = (cells[geoIdx].innerText || '').trim();
    if (latIdx >= 0 && cells[latIdx]) latLong = (cells[latIdx].innerText || '').trim();
    
    // Fallback: if no column mapping, try first few cells
    if (!equipId && cells[0]) equipId = (cells[0].innerText || '').trim();
    if (!geofence) {
      // Scan all cells for geofence-like data (site codes like ABE40, EWR10)
      for (var c = 1; c < cells.length; c++) {
        var ct = (cells[c].innerText || '').trim();
        if (/^[A-Z]{3,4}\\d{1,2}$/i.test(ct) || ct.indexOf('Geofence') > -1 || /^[A-Z0-9_-]{4,10}$/.test(ct)) {
          geofence = ct;
          break;
        }
      }
    }
    if (!latLong) {
      // Scan for lat/long pattern
      for (var c = 1; c < cells.length; c++) {
        var ct = (cells[c].innerText || '').trim();
        if (/^-?\\d{1,3}\\.\\d+/.test(ct)) {
          latLong = ct;
          break;
        }
      }
    }
    
    if (equipId && equipId.match(/^[A-Za-z]-?\\d{3,6}$|^V\\d{5,7}$/)) {
      results.push({ equipmentId: equipId, geofence: geofence, latLong: latLong });
    }
  }
  
  // If table parsing failed, try reading full page text for patterns
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
 * @returns {Object} { ok, count, cache }
 */
async function scrapeGeofences(log) {
  if (!log) log = console.log;
  
  // Lazy require electron modules
  if (!BrowserWindow) {
    const electron = require('electron');
    BrowserWindow = electron.BrowserWindow;
    session = electron.session;
  }
  
  const url = buildFleetMonitoringUrl();
  log('[Geofence] Opening Fleet Monitoring page: ' + url.substring(0, 80) + '...');
  
  // Copy auth cookies from main session into scraper partition
  const ses = session.fromPartition('persist:deep-scan', { cache: true });
  try {
    const mainCookies = await session.defaultSession.cookies.get({ url: 'https://aap-na.corp.amazon.com' });
    for (const c of mainCookies) { await ses.cookies.set({ url: 'https://aap-na.corp.amazon.com', name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly }); }
    log('[Geofence] Auth cookies copied (' + mainCookies.length + ')');
  } catch(e) { log('[Geofence] Cookie copy failed: ' + e.message); }
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses }
  });
  
  try {
    await win.loadURL(url);
    log('[Geofence] Page loaded, waiting for table render...');
    await new Promise(r => setTimeout(r, 8000)); // Wait for React table to render
    
    // Check if page actually loaded content
    const pageCheck = await win.webContents.executeJavaScript(`
      (function() {
        var text = (document.body ? document.body.innerText : '');
        return JSON.stringify({ len: text.length, hasTable: !!document.querySelector('table, [role="grid"], [role="table"]'), title: document.title, sample: text.substring(0, 200) });
      })();
    `);
    const check = JSON.parse(pageCheck);
    log('[Geofence] Page check: len=' + check.len + ' hasTable=' + check.hasTable + ' title=' + check.title);
    if (check.len < 500) {
      log('[Geofence] ⚠️ Page appears empty or not loaded. May need auth.');
      win.close();
      return { ok: false, error: 'Page not loaded (auth required?)', pageInfo: check };
    }
    
    // Scroll to load all rows if virtualized
    await win.webContents.executeJavaScript(`
      (function() {
        var scroller = document.querySelector('[class*="scroll"], [class*="table-body"], [style*="overflow"]');
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
          setTimeout(function() { scroller.scrollTop = 0; }, 1000);
        }
      })();
    `);
    await new Promise(r => setTimeout(r, 3000));
    
    // Extract data
    const raw = await win.webContents.executeJavaScript(GEOFENCE_EXTRACT);
    const result = JSON.parse(raw);
    log('[Geofence] Extraction result: ' + result.count + ' units found');
    
    // If table extraction failed, try full-page text parse as fallback
    if (result.count === 0) {
      // Dump the actual table structure for debugging
      const structDump = await win.webContents.executeJavaScript(`
        (function() {
          var info = { tables: [], grids: [], rows: [] };
          document.querySelectorAll('table, [role="table"], [role="grid"]').forEach(function(t, i) {
            info.tables.push({ idx: i, tag: t.tagName, role: t.getAttribute('role'), class: (t.className || '').substring(0, 60), childCount: t.children.length });
          });
          // Check for virtualized grid rows
          document.querySelectorAll('[role="row"], [role="gridcell"], [data-rowindex], [class*="row"]').forEach(function(r, i) {
            if (i < 5) info.rows.push({ tag: r.tagName, role: r.getAttribute('role'), class: (r.className || '').substring(0, 50), text: (r.innerText || '').substring(0, 100) });
          });
          // Get first 500 chars of the page to see structure
          info.sample = (document.body ? document.body.innerText : '').substring(0, 1500);
          return JSON.stringify(info);
        })();
      `);
      const struct = JSON.parse(structDump);
      log('[Geofence] TABLE STRUCTURE: ' + JSON.stringify(struct.tables));
      log('[Geofence] SAMPLE ROWS: ' + JSON.stringify(struct.rows));
      log('[Geofence] PAGE SAMPLE: ' + struct.sample.substring(0, 500));
      
      log('[Geofence] Table extraction failed — trying full-page text fallback...');
      const fallbackRaw = await win.webContents.executeJavaScript(`
        (function() {
          var text = (document.body ? document.body.innerText : '');
          var lines = text.split('\\n');
          var units = [];
          // Look for lines that have equipment IDs followed by geofence codes or coordinates
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            // Match unit IDs (6-digit numbers or T-XXXX patterns)
            var unitMatch = line.match(/\\b(\\d{5,6}|[A-Z]-?\\d{4,6})\\b/);
            if (unitMatch) {
              var unitId = unitMatch[1];
              // Look ahead for geofence (like ABE40, EWR45) or coordinates
              var geoMatch = line.match(/\\b([A-Z]{3,5}\\d{1,2})\\b/);
              var coordMatch = line.match(/(-?\\d{1,3}\\.\\d{3,})\\s*[,/]\\s*(-?\\d{1,3}\\.\\d{3,})/);
              if (geoMatch || coordMatch) {
                units.push({
                  equipmentId: unitId,
                  geofence: geoMatch ? geoMatch[1] : '',
                  latLong: coordMatch ? coordMatch[1] + ',' + coordMatch[2] : ''
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
    
    win.close();
    
    if (result.count === 0) {
      log('[Geofence] ⚠️ No units extracted from table. Page may need different parsing.');
      return { ok: false, count: 0, error: 'No data extracted' };
    }
    
    // Build/update cache
    const cache = loadGeofenceCache();
    let updated = 0;
    
    result.units.forEach(u => {
      const id = u.equipmentId;
      if (!id) return;
      const existing = cache[id] || {};
      const changed = existing.geofence !== u.geofence || existing.latLong !== u.latLong;
      if (changed || !existing.geofence) {
        cache[id] = {
          geofence: u.geofence || existing.geofence || '',
          latLong: u.latLong || existing.latLong || '',
          lastUpdated: new Date().toISOString()
        };
        updated++;
      }
    });
    
    saveGeofenceCache(cache);
    log(`[Geofence] ✓ Done: ${result.count} units scraped, ${updated} updated. Cache has ${Object.keys(cache).length} entries.`);
    
    return { ok: true, count: result.count, updated, cache };
    
  } catch (e) {
    if (!win.isDestroyed()) win.close();
    log(`[Geofence] ✗ Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { scrapeGeofences, loadGeofenceCache, saveGeofenceCache, buildFleetMonitoringUrl, FLEET_IDS };
