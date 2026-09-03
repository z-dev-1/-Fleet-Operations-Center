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

// ── Concurrency guard (Task #5) ───────────────────────────────────────────────
// A single in-process promise-chain mutex prevents two pushToSharePoint() runs
// from writing the shared workbooks at the same time (scheduled + manual +
// catch-up could otherwise overlap and clobber each other's uploads). The
// backend pipeline (Task #7) ALSO holds a durable ledger lease per channel;
// this mutex is the last-line, in-process guarantee even for direct IPC calls.
let _spWriteLock = Promise.resolve();
function _withWriteLock(fn) {
  const run = _spWriteLock.then(fn, fn);
  // keep the chain alive regardless of success/failure, swallow to avoid unhandled
  _spWriteLock = run.then(() => {}, () => {});
  return run;
}

/**
 * Run an injected function inside an authenticated SP BrowserWindow.
 * fnCall is the JS expression to invoke (e.g. "spPushWorksheet({...})").
 */
function spRun(config, timeoutMs, fnName) {
  const call = fnName || 'spPushWorksheet';
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
        // Inject the script + call the requested function with config
        const fullScript = PUSH_SCRIPT + '\n;' + call + '(' + JSON.stringify(config) + ')';
        const result = await win.webContents.executeJavaScript(fullScript);
        finish(null, result);
      } catch(e) { finish(e); }
    });
  });
}

// Read-back verification runner — invokes spVerifyWorkbook in the SP window.
function spVerify(config, timeoutMs) {
  return spRun(config, timeoutMs || 90000, 'spVerifyWorkbook');
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






// ── Standardized SharePoint result contract (Task #5) ─────────────────────────
// {
//   ok, status, workbooksAttempted, workbooksSucceeded, workbooksFailed,
//   sheetsAttempted, sheetsSucceeded, sheetsFailed,
//   rowsInserted, rowsUpdated, rowsVerified,
//   readBack: { verifiedWorkbooks:[names], sampleUnits:[...], hyperlinksChecked },
//   workbooks: [ { name, status, sheets:[...], verify:{...}, error? } ],
//   errors: [], completedAt
// }
// status values:
//   'ok'                     — all required workbooks+sheets pushed AND read-back verified
//   'partial-failure'        — some workbooks/sheets ok, some not
//   'verification-pending'   — pushed but read-back could not confirm
//   'blocked-configuration'  — no workbooks configured / nothing to push
//   'auth-failed' / 'digest-failed' / 'failed'
// `ok` is true ONLY for status 'ok'.
function _newSpResult() {
  return {
    ok: false, status: 'failed',
    workbooksAttempted: 0, workbooksSucceeded: 0, workbooksFailed: 0,
    sheetsAttempted: 0, sheetsSucceeded: 0, sheetsFailed: 0,
    rowsInserted: 0, rowsUpdated: 0, rowsVerified: 0,
    readBack: { verifiedWorkbooks: [], sampleUnits: [], hyperlinksChecked: false },
    workbooks: [], errors: [], completedAt: null,
  };
}

// Total count of expected-but-missing units across a read-back verify result.
// Used to pick the BEST read-back attempt during propagation-lag retries — the
// attempt with the fewest missing is closest to the truth.
function _verifyMissingCount(verify) {
  if (!verify || !Array.isArray(verify.sheets)) return Infinity;
  let n = 0;
  for (const s of verify.sheets) {
    if (!s.found) { n += 1000; continue; }   // a missing worksheet is worse than a few missing rows
    n += (s.expectedMissing ? s.expectedMissing.length : 0);
    if (s.sampleLifecycleMatch === false) n += 1;
  }
  return n;
}

// Pure status derivation from workbook accounting (Task #5) — extracted so it
// can be unit-tested without a live SharePoint session. `ok` is true ONLY when
// at least one workbook was attempted, none failed, and every attempted
// workbook verified via read-back.
function _deriveSpStatus(R) {
  if (R.workbooksAttempted === 0) return { status: 'blocked-configuration', ok: false };
  if (R.workbooksFailed === 0 && R.workbooksSucceeded === R.workbooksAttempted) return { status: 'ok', ok: true };
  if (R.workbooksSucceeded > 0) return { status: 'partial-failure', ok: false };
  const pending = (R.workbooks || []).some(w => w.status === 'verification-pending');
  return { status: pending ? 'verification-pending' : 'failed', ok: false };
}

function pushToSharePoint(units, onProgress) {
  // Serialize workbook writes — no two pushes touch the shared files at once.
  return _withWriteLock(() => _pushToSharePointInner(units, onProgress));
}

async function _pushToSharePointInner(units, onProgress) {
  const log = onProgress || ((msg, type) => logger.info('[SP Push]', type, msg));
  log('Starting SharePoint push...', 'info');
  const R = _newSpResult();
  const _finish = () => { R.completedAt = new Date().toISOString(); return R; };

  // Push ALL units — renderer uses atsState: 'Unavailable' or 'Available'
  const allUnits = units; // push everything, let the script decide
  const unavailCount = allUnits.filter(u => /unavailable/i.test((u.atsState||u.lifecycleState) || '')).length;
  const activeCount = allUnits.length - unavailCount;

  log('Total units to push: ' + allUnits.length + ' (' + unavailCount + ' unavailable, ' + activeCount + ' active)', 'info');

  const LIVE_WORKBOOKS = loadWorkbooks();
  if (!Array.isArray(LIVE_WORKBOOKS) || !LIVE_WORKBOOKS.length) {
    log('No workbooks configured — nothing to push.', 'warn');
    R.status = 'blocked-configuration';
    R.errors.push('no workbooks configured');
    return _finish();
  }

  // Auth
  try {
    await withRetry(() => ensureSpAuth(), { attempts: 2, backoffMs: 3000, label: 'sp:auth' });
    log('SP session authenticated.', 'ok');
  } catch(e) { log('Auth failed: ' + e.message, 'bad'); R.status = 'auth-failed'; R.errors.push('auth: ' + e.message); return _finish(); }

  let digest;
  try {
    digest = await withRetry(() => getDigest(), { attempts: 2, backoffMs: 3000, label: 'sp:digest' });
    log('Write token acquired.', 'ok');
  } catch(e) { log('Digest failed: ' + e.message, 'bad'); R.status = 'digest-failed'; R.errors.push('digest: ' + e.message); return _finish(); }

  let totalPushed = 0, totalUpdated = 0, totalErrors = 0;

  for (const wb of LIVE_WORKBOOKS) {
    const wbUnits = allUnits.filter(u => {

      const op = (u.op || u.operator || '').trim().toUpperCase();
      // Find the matching carrier entry (trim+case-normalized).
      const matchedCarrier = wb.carriers.find(c => (c.code || '').trim().toUpperCase() === op);
      if (!matchedCarrier) return false;
      // Operator-specific domicile scoping: only carriers flagged
      // `domicileScoped: true` (multi-domicile operators like AZNG, which can
      // appear at more than one domicile) get filtered to THIS workbook's
      // domicile. Every other operator (TUZR, SAPB, EOFE, YTSC, AGNLI, ...)
      // belongs to its SharePoint regardless of domicile, so it's NOT filtered.
      // Generic + config-driven — nothing hardcoded to a specific operator.
      if (matchedCarrier.domicileScoped && wb.domicile) {
        const unitDom = (u.site || u.domicileSite || u.domicile || '').trim().toUpperCase();
        const wbDom = wb.domicile.trim().toUpperCase();
        return unitDom === wbDom || unitDom.includes(wbDom);
      }
      // Not domicile-scoped -> include all carrier-matched units for this workbook.
      return true;
    });



    const wbRec = { name: wb.name, path: wb.path, status: 'zero-eligible', sheets: [], verify: null, error: null };

    if (!wbUnits.length) { log(wb.name + ': No units.', 'info'); wbRec.status = 'zero-eligible'; wbRec.error = 'no eligible units for this workbook'; R.workbooks.push(wbRec); continue; }

    // Build ALL carrier→sheet mappings for this workbook, then push them
    // in a SINGLE download→modify-all→upload cycle. This eliminates the race
    // condition where sequential per-carrier uploads overwrite each other
    // (SharePoint's write propagation isn't instant, so a second carrier's
    // download could grab the pre-first-carrier version and blank its data).
    const sheets = [];
    // Read-back expectations captured alongside each sheet (Task #5).
    const verifySheets = [];
    for (const carrier of wb.carriers) {
      const carrierCode = (carrier.code || '').trim().toUpperCase();
      const carrierUnits = wbUnits.filter(u => (u.op || u.operator || '').trim().toUpperCase() === carrierCode);
      if (!carrierUnits.length) continue;

      log(wb.name + ' / ' + carrier.code + ' -> ' + carrier.sheet + ': ' + carrierUnits.length + ' units', 'info');

      const expectedIds = [];
      let sampleUnavail = null;
      const rowData = carrierUnits.map(u => {
        const row = buildRowValues(u);
        const isActive = !/unavailable/i.test((u.atsState||u.lifecycleState) || '');
        // When unit is ACTIVE, clear all maintenance fields
        if (isActive) {
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
        const uid = String(row.values[1] || '');
        if (uid) expectedIds.push(uid);
        // First unavailable unit WITH at least one hyperlink is our representative
        // sample for read-back (confirms lifecycle=UNAVAILABLE + hyperlink landed).
        if (!sampleUnavail && !isActive && uid) {
          sampleUnavail = { id: uid, cols: { E: String(row.values[4] || '').toUpperCase() },
            wantUrls: { H: row.urls.H || '', I: row.urls.I || '', J: row.urls.J || '' } };
        }
        return row;
      });

      const headerRow = (carrier.headerRow != null ? carrier.headerRow : wb.headerRow);
      sheets.push({ sheetName: carrier.sheet, units: rowData, headerRow, carrierCode: carrier.code });
      // Cap the expected-id sample to keep the read-back payload small but
      // representative (first 25 ids + the sample unavailable unit).
      verifySheets.push({
        sheetName: carrier.sheet, headerRow, carrierCode: carrier.code,
        expectedIds: expectedIds.slice(0, 25),
        sampleUnavail,
      });
    }

    if (!sheets.length) { log(wb.name + ': No carrier sheets to push.', 'info'); wbRec.status = 'zero-eligible'; wbRec.error = 'no carrier sheets matched'; R.workbooks.push(wbRec); continue; }

    R.workbooksAttempted++;
    R.sheetsAttempted += sheets.length;

    let pushResult = null;
    try {
      // ONE download → modify ALL sheets → ONE upload per workbook.
      pushResult = await spRun({
        filePath: wb.path,
        sheets: sheets,
        digest: digest,
        dryRun: false,
      }, 120000);

      if (pushResult && pushResult.log) pushResult.log.forEach(l => log('    ' + l, 'info'));
      totalPushed += (pushResult && pushResult.pushed) || 0;
      totalUpdated += (pushResult && pushResult.updated) || 0;
      totalErrors += (pushResult && pushResult.errors) || 0;
    } catch(e) {
      log('  [ERROR] ' + wb.name + ': ' + e.message, 'bad');
      totalErrors++;
      wbRec.status = 'failed';
      wbRec.error = e.message;
      R.workbooksFailed++;
      R.sheetsFailed += sheets.length;
      R.errors.push(wb.name + ': ' + e.message);
      R.workbooks.push(wbRec);
      continue;
    }

    // A push-side hard error (upload failed / no sheets modified) means we do
    // NOT claim success and do NOT bother verifying — record and move on.
    const pushErrs = (pushResult && pushResult.errors) || 0;
    const uploadFailed = !!(pushResult && pushResult.uploadFailed);
    if (uploadFailed || pushErrs > 0) {
      wbRec.status = 'failed';
      wbRec.error = uploadFailed ? 'upload failed' : (pushErrs + ' in-sheet error(s)');
      R.workbooksFailed++;
      R.sheetsFailed += sheets.length;
      R.errors.push(wb.name + ': ' + wbRec.error);
      R.workbooks.push(wbRec);
      continue;
    }

    // ── READ-BACK VERIFICATION (Task #5) ─────────────────────────────────────
    // Re-download the workbook fresh and confirm the write actually landed.
    // SharePoint write propagation is NOT instant — a read-back run immediately
    // after upload can see a slightly-stale copy where a couple of just-written
    // rows haven't propagated yet, producing a false "N missing" partial-failure
    // (observed live: AUVTE01 reported 23/25 with 2 "missing" even though the
    // upload succeeded). So we retry the read-back a few times with increasing
    // settle delays and accept the first fully-verified result. We keep the
    // BEST (most-complete) attempt if none fully verify, so the reported result
    // is honest, not worse than reality.
    let verify = null;
    const _settles = [2500, 4000, 6000];   // ~12.5s total worst case
    for (let attempt = 0; attempt < _settles.length; attempt++) {
      try {
        await new Promise(r => setTimeout(r, _settles[attempt]));
        const v = await spVerify({ filePath: wb.path, sheets: verifySheets }, 90000);
        if (v && v.log) v.log.forEach(l => log('    [verify' + (attempt ? ' retry' + attempt : '') + '] ' + l, 'info'));
        // Keep the best attempt: prefer ok, else the one with fewest missing.
        if (!verify) verify = v;
        else if (v && _verifyMissingCount(v) < _verifyMissingCount(verify)) verify = v;
        if (v && v.ok) { verify = v; break; }   // fully verified — done
        if (attempt < _settles.length - 1) log('  [verify] ' + wb.name + ' not fully confirmed yet — retrying after propagation delay', 'info');
      } catch (e) {
        log('  [VERIFY ERROR] ' + wb.name + ': ' + e.message, 'warn');
        if (!verify) verify = { ok: false, errors: ['verify exception: ' + e.message], sheets: [] };
      }
    }
    wbRec.verify = verify;
    wbRec.sheets = (verify && verify.sheets) || [];

    // Aggregate read-back evidence into the top-level result.
    const verifiedSheets = (verify && verify.sheets) || [];
    const verifiedRows = verifiedSheets.reduce((n, s) => n + (s.dataRows || 0), 0);
    const sheetsOk = verifiedSheets.filter(s => s.found && (!s.expectedMissing || !s.expectedMissing.length) && s.sampleLifecycleMatch !== false).length;
    const anyLinkCheck = verifiedSheets.some(s => s.sampleHyperlinksFound != null);
    if (anyLinkCheck) R.readBack.hyperlinksChecked = true;
    verifiedSheets.forEach(s => { if (s.sampleUnit) R.readBack.sampleUnits.push({ workbook: wb.name, sheet: s.sheetName, unit: s.sampleUnit, lifecycleMatch: s.sampleLifecycleMatch, links: s.sampleHyperlinksFound }); });

    if (verify && verify.ok) {
      wbRec.status = 'verified';
      R.workbooksSucceeded++;
      R.sheetsSucceeded += sheets.length;
      R.rowsVerified += verifiedRows;
      R.readBack.verifiedWorkbooks.push(wb.name);
    } else {
      // Pushed but read-back did not confirm -> verification-pending, NOT ok.
      wbRec.status = 'verification-pending';
      wbRec.error = (verify && verify.errors && verify.errors.join('; ')) || 'read-back could not confirm';
      R.workbooksFailed++;
      R.sheetsFailed += sheets.length;
      R.errors.push(wb.name + ': verification-pending — ' + wbRec.error);
    }
    R.workbooks.push(wbRec);
  }

  R.rowsInserted = totalPushed;
  R.rowsUpdated = totalUpdated;

  // Overall status: ok only when at least one workbook was attempted, none
  // failed, and every attempted workbook verified via read-back.
  const derived = _deriveSpStatus(R);
  R.status = derived.status;
  R.ok = derived.ok;

  const summary = 'Done: ' + totalPushed + ' new, ' + totalUpdated + ' updated, ' +
    R.rowsVerified + ' verified · ' + R.workbooksSucceeded + '/' + R.workbooksAttempted +
    ' workbooks verified · status=' + R.status;
  log(summary, R.ok ? 'ok' : (R.status === 'partial-failure' || R.status === 'verification-pending' ? 'warn' : 'bad'));
  return _finish();
}

module.exports = { pushToSharePoint, WORKBOOKS, buildRowValues, loadWorkbooks, saveWorkbooks, SP_CONFIG_FILE, _newSpResult, _deriveSpStatus, _verifyMissingCount };
