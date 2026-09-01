'use strict';
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('sharepoint_push');
const { withRetry } = require('../utils/retry');    // H-1: auth + digest retry

const SP_ORIGIN = 'https://amazon.sharepoint.com';
const SP_SITE   = '/sites/AFP-FAS'; // Now overridable via config filePath
const SP_API    = SP_ORIGIN + SP_SITE + '/_api';


// SP Push config file — user can add/remove workbooks
const SP_CONFIG_FILE = P.spConfig;

const DEFAULT_WORKBOOKS = []; // Configured via Settings → Operators & SP

function loadWorkbooks() {
  try {
    if (fs.existsSync(SP_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(SP_CONFIG_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
      if (data && Array.isArray(data.workbooks) && data.workbooks.length) return data.workbooks;
    }
  } catch(e) { logger.warn('[SP Push] Config load error:', e.message); }
  // First run — save defaults
  saveWorkbooks(DEFAULT_WORKBOOKS);
  return DEFAULT_WORKBOOKS;
}

function saveWorkbooks(workbooks) {
  try { fs.writeFileSync(SP_CONFIG_FILE, JSON.stringify(workbooks, null, 2), 'utf8'); }
  catch(e) { logger.warn('[SP Push] Config save error:', e.message); }
}

const WORKBOOKS = loadWorkbooks();


// Load the injectable push script
const PUSH_SCRIPT = fs.readFileSync(path.join(__dirname, 'sp_push_script.js'), 'utf8');

/**
 * Run the push script inside an authenticated SP BrowserWindow.
 */
function spRun(config, timeoutMs) {
  const spSes = session.defaultSession;
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 800, height: 600, show: false, x: -3000, y: -3000,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes } });
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; try { win.close(); } catch(e){} err ? reject(err) : resolve(val); };
    setTimeout(() => finish(new Error('SP push timeout (' + (timeoutMs/1000) + 's)')), timeoutMs || 60000);
    win.webContents.on('did-fail-load', (_, code, desc) => { if (code !== -3) finish(new Error('SP load failed: ' + desc)); });
    win.loadURL(SP_ORIGIN + SP_SITE + '/_layouts/15/blank.htm');
    win.webContents.on('did-finish-load', async () => {
      try {
        // Inject the push script + call it with config
        const fullScript = PUSH_SCRIPT + '\n;spPushWorksheet(' + JSON.stringify(config) + ')';
        const result = await win.webContents.executeJavaScript(fullScript);
        finish(null, result);
      } catch(e) { finish(e); }
    });
  });
}

/**
 * Ensure SP session is authenticated.
 */
async function ensureSpAuth() {
  const spSes = session.defaultSession;
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 1000, height: 700, show: false, x: -3000, y: -3000,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes } });
    let done = false;
    const finish = (err) => { if (done) return; done = true; try { win.close(); } catch(e){} err ? reject(err) : resolve(); };
    setTimeout(() => finish(new Error('SP auth timeout')), 30000);
    win.webContents.on('did-navigate', (_, url) => {
      if (url.includes('amazon.sharepoint.com/sites/') && !url.includes('login') && !url.includes('oauth')) {
        setTimeout(() => finish(null), 1500);
      }
    });
    win.webContents.on('did-fail-load', (_, code, desc) => { if (code !== -3) finish(new Error('SP auth: ' + desc)); });
    win.loadURL(SP_ORIGIN + SP_SITE);
  });
}

/**
 * Get form digest.
 */
async function getDigest() {
  const spSes = session.defaultSession;
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 800, height: 600, show: false, x: -3000, y: -3000,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes } });
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; try { win.close(); } catch(e){} err ? reject(err) : resolve(val); };
    setTimeout(() => finish(new Error('Digest timeout')), 15000);
    win.loadURL(SP_ORIGIN + SP_SITE + '/_layouts/15/blank.htm');
    win.webContents.on('did-finish-load', async () => {
      try {
        const digest = await win.webContents.executeJavaScript(`
          fetch('${SP_API}/contextinfo', { method: 'POST', credentials: 'include',
            headers: { 'Accept': 'application/json;odata=verbose', 'Content-Length': '0' }
          }).then(r => r.json()).then(d => d.d.GetContextWebInformation.FormDigestValue).catch(e => 'ERROR:' + e.message)
        `);
        if (typeof digest === 'string' && digest.startsWith('ERROR:')) finish(new Error(digest));
        else finish(null, digest);
      } catch(e) { finish(e); }
    });
  });
}

function buildRowValues(unit) {
  // Extract just manufacturer name (not "Volvo Day Cab" -> "VOLVO")
  let make = (unit.model || unit.make || unit.manufacturer || '').toUpperCase();
  // Strip body type from make if appended
  make = make.replace(/\s*(DAY\s*CAB|SLEEPER|BOX\s*TRUCK|TRACTOR|STANDARD)\s*/gi, '').trim();
  // Convert date: "Jun 11, 2026 09:05AM -04:00 (11 days ago)" -> "6/11/2026"
  let dateDown = '';
  let daysUnavail = '';
  const rawDate = unit.created || '';
  if (rawDate) {
    const monMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    const dm = rawDate.match(/^(\w+)\s+(\d+),?\s+(\d{4})\s+(\d+):(\d+)(AM|PM)/i);
    if (dm) {
      let hr = parseInt(dm[4]);
      if (dm[6].toUpperCase() === 'PM' && hr < 12) hr += 12;
      if (dm[6].toUpperCase() === 'AM' && hr === 12) hr = 0;
      const d = new Date(parseInt(dm[3]), monMap[dm[1].toLowerCase()] || 0, parseInt(dm[2]), hr, parseInt(dm[5]));
      if (!isNaN(d.getTime())) {
        dateDown = (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
        daysUnavail = String(Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
      }
    }
    if (!dateDown) dateDown = rawDate.replace(/\s*\(.*?\)\s*$/, '').trim();
  }


  return {
    values: [
      (unit.op || unit.operator || '').toUpperCase(),          // A: CARRIER
      unit.id || unit.equipmentId || '',                       // B: UNIT NUMBER
      (unit.bodyType || '').toUpperCase(),                     // C: BODY TYPE
      make,                                                     // D: MAKE
    (!/unavailable/i.test((unit.atsState||unit.lifecycleState) || '') ? 'ACTIVE' : 'UNAVAILABLE'), // E: LIFECYCLE STATE
      unit.savedRepairStatus || '',                             // F: REPAIR STATUS
      unit.savedPrimaryComponent || '',                         // G: PRIMARY COMPONENT
      (unit.altId && unit.altId !== '\u2014' ? unit.altId : unit.alternativeId || ''), // H: RELAY GARAGE
      unit.savedOffsiteEvent || '',                             // I: OFFSITE SHOP EVENT (display)
      unit.savedSalesforceCase || '',                           // J: SALESFORCE CASE (display)
      (unit.repairTimeline || unit.savedNotes || ''),           // K: REPAIR UPDATES (timeline)
      unit.vendor || '',                                        // L: ASSIGNED VENDOR
      dateDown,                                                 // M: DATE DOWNED
      daysUnavail                                               // N: # DAYS UNAVAILABLE
    ],
    urls: {
      H: unit.serviceUrl || '',                                // Relay garage URL
      I: unit.savedOffsiteUrl || unit.offsiteShopEventUrl || '', // Offsite event URL
      J: unit.savedSalesforceCaseUrl || ''                      // Salesforce case URL
    }
  };
}






async function pushToSharePoint(units, onProgress) {
  const log = onProgress || ((msg, type) => logger.info('[SP Push]', type, msg));
  log('Starting SharePoint push...', 'info');

  // Push ALL units — renderer uses atsState: 'Unavailable' or 'Available'
  const allUnits = units; // push everything, let the script decide
  const unavailCount = allUnits.filter(u => /unavailable/i.test((u.atsState||u.lifecycleState) || '')).length;
  const activeCount = allUnits.length - unavailCount;

  log('Total units to push: ' + allUnits.length + ' (' + unavailCount + ' unavailable, ' + activeCount + ' active)', 'info');

  // Auth
  try {
    await withRetry(() => ensureSpAuth(), { attempts: 2, backoffMs: 3000, label: 'sp:auth' });
    log('SP session authenticated.', 'ok');
  } catch(e) { log('Auth failed: ' + e.message, 'bad'); return { success: false, error: e.message }; }

  let digest;
  try {
    digest = await withRetry(() => getDigest(), { attempts: 2, backoffMs: 3000, label: 'sp:digest' });
    log('Write token acquired.', 'ok');
  } catch(e) { log('Digest failed: ' + e.message, 'bad'); return { success: false, error: e.message }; }

  let totalPushed = 0, totalUpdated = 0, totalErrors = 0;

  const LIVE_WORKBOOKS = loadWorkbooks();
  for (const wb of LIVE_WORKBOOKS) {
    const wbUnits = allUnits.filter(u => {

      const op = (u.op || u.operator || '').trim().toUpperCase();
      const carrierMatch = wb.carriers.some(c => (c.code || '').trim().toUpperCase() === op);
      if (!carrierMatch) return false;
      // Filter by domicile: if workbook has a domicile set, only include units from that domicile
      if (wb.domicile) {
        const unitDom = (u.site || u.domicileSite || u.domicile || '').trim().toUpperCase();
        return unitDom === wb.domicile.trim().toUpperCase() || unitDom.includes(wb.domicile.trim().toUpperCase());
      }
      // No domicile filter on this workbook -> include all carrier-matched units.
      // (BUG FIX: previously fell through to `undefined` here, which rejected
      // every unit, so any workbook with an empty domicile pushed nothing.)
      return true;
    });



    if (!wbUnits.length) { log(wb.name + ': No units.', 'info'); continue; }

    for (const carrier of wb.carriers) {
      const carrierCode = (carrier.code || '').trim().toUpperCase();
      const carrierUnits = wbUnits.filter(u => (u.op || u.operator || '').trim().toUpperCase() === carrierCode);
      if (!carrierUnits.length) continue;

      log(wb.name + ' / ' + carrier.code + ' -> ' + carrier.sheet + ': ' + carrierUnits.length + ' units', 'info');

      const rowData = carrierUnits.map(u => {
        const row = buildRowValues(u);
        // When unit is ACTIVE, clear all maintenance fields
        if (!/unavailable/i.test((u.atsState||u.lifecycleState) || '')) {
          row.values[5] = '';   // F: Repair Status
          row.values[6] = '';   // G: Primary Component
          row.values[7] = '';   // H: Relay Garage (Alt ID)
          row.values[8] = '';   // I: Offsite Shop Event
          row.values[9] = '';   // J: Salesforce Case
          row.values[10] = '';  // K: Repair Updates (notes)
          row.values[11] = '';  // L: Assigned Vendor
          row.values[12] = '';  // M: Date Downed
          row.values[13] = '';  // N: Days Unavailable
          row.urls = {};        // No hyperlinks for active units
        }

        return row;
      });



      try {
        const result = await spRun({
          filePath: wb.path,
          sheetName: carrier.sheet,
          units: rowData,
          digest: digest,
          // Prefer the per-carrier headerRow when set (each sheet can differ),
          // fall back to the workbook-level value. Generic — no hardcoding.
          headerRow: (carrier.headerRow != null ? carrier.headerRow : wb.headerRow),
          dryRun: false
        }, 90000);


        if (result && result.log) result.log.forEach(l => log('    ' + l, 'info'));
        totalPushed += (result && result.pushed) || 0;
        totalUpdated += (result && result.updated) || 0;
        totalErrors += (result && result.errors) || 0;
      } catch(e) {
        log('  [ERROR] ' + carrier.code + ': ' + e.message, 'bad');
        totalErrors++;
      }
    }
  }

  const summary = 'Done: ' + totalPushed + ' new, ' + totalUpdated + ' updated, ' + totalErrors + ' errors.';
  log(summary, totalErrors ? 'warn' : 'ok');
  return { success: true, pushed: totalPushed, updated: totalUpdated, errors: totalErrors };
}

module.exports = { pushToSharePoint, WORKBOOKS, buildRowValues, loadWorkbooks, saveWorkbooks, SP_CONFIG_FILE };
