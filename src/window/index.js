'use strict';
/**
 * src/window/index.js  [Version C]
 *
 * Manages all BrowserWindows for Fleet Operations:
 *   - Main window  (AAP startup scrape → Fleet Status app)
 *   - Tray         (system-tray icon + animated frames)
 *   - Bubble       (always-on-top HUD shown when main window is minimised/hidden)
 *   - AAP setup    (column-config helper, shown once)
 *   - Setup wizard (first-launch onboarding)
 *   - Popup windows: Uptake, Relay, email preview (via IPC handlers)
 *
 * Auth strategy:
 *   - On startup: checkMwinit() reads actual cookie expiry timestamps from
 *     ~/.midway/cookie. If any are expired, runMwinit() spawns a visible
 *     terminal automatically — no hardcoded hour thresholds.
 *   - Mid-session: _authPoller detects SSO redirect loop (10+ consecutive
 *     seconds on midway-auth.amazon.com) and triggers runMwinit() automatically.
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  nativeImage, shell, screen, session, Notification,
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger')('window');
const { attachAutoLogin, partitionForUrl } = require('../orcha/auto-login');
const { P }  = require('../config/paths');
const { getAppIconPath } = require('../config/app-icon');
const store  = require('../store');
const { isSetupComplete } = require('../../setup/state');
const { buildWRUrls } = require('./wr_capture');

const ROOT_DIR = path.join(__dirname, '..', '..');

// ── Field map: AAP table column header → camelCase property ─────────────────
const AAP_FIELD_MAP = {
  'Equipment ID':                 'equipmentId',
  'Asset type':                   'assetType',
  'Lifecycle state':              'lifecycleState',
  'Lifecycle state reason':       'lifecycleReason',
  'Operator':                     'operator',
  'Manufacturer':                 'manufacturer',
  'Body type':                    'bodyType',
  'Due date':                     'dueDate',
  'pmBDue':                       'pmBDue',
  'pmXDue':                       'pmXDue',
  'dotDue':                       'dotDue',
  'quarterlyLiftDue':             'quarterlyLiftDue',
  'Engine manufacturer':          'engineManufacturer',
  'Domicile site':                'domicileSite',
  'Fuel type':                    'fuelType',
  'Open Unplanned Work Requests':     'openUnplanned',
  'Open Unplanned Work Requests_url': 'openUnplannedUrl',
  'Open Planned Work Requests':       'openPlanned',
  'Open Planned Work Requests_url':   'openPlannedUrl',
  'Last geofences':               'geofence',
  'Lat/Long':                     'latLong',
  'Owner':                        'owner',
  'Asset ID':                     'assetId',
};

// ── JS injected into AAP: force 1000 rows per page ───────────────────────────
const JS_FORCE_1000_RPP = `(function(){
  function simClick(el){
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
    el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  }
  var rpp = document.querySelector('[aria-label="Results per page"]') ||
            document.querySelector('[data-testid="results-per-page"]');
  if (!rpp) {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].childNodes.length === 1 && (all[i].textContent||'').trim() === 'Results per page') {
        rpp = all[i].parentElement.querySelector('button,select,[role="button"],[role="combobox"],[role="listbox"]');
        break;
      }
    }
  }
  if (!rpp) {
    var btns = document.querySelectorAll('button,[role="button"]');
    for (var b = 0; b < btns.length; b++) {
      var txt = (btns[b].textContent||'').trim();
      if (txt === '150' || txt === '50' || txt === '100') { rpp = btns[b]; break; }
    }
  }
  if (rpp) { simClick(rpp); return 'clicked_rpp:' + (rpp.textContent||'').trim().substring(0,20); }
  return 'rpp_not_found';
})()`;

const JS_CLICK_1000 = `(function(){
  function simClick(el){
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
    el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  }
  var opts = document.querySelectorAll('[role="option"],[role="menuitem"],li,option');
  for (var i = 0; i < opts.length; i++) {
    if ((opts[i].textContent||'').trim() === '1000') { simClick(opts[i]); return 'clicked_1000'; }
  }
  return 'no_1000_option';
})()`;

const JS_EXTRACT_TABLE = `(function(){
  var tables = document.querySelectorAll('table');
  var t = null;
  for (var i = 0; i < tables.length; i++) {
    if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
  }
  if (!t) return { rows:[], count:0, debug:'no_table_with_rows', wrRows:[] };
  var h = [];
  t.querySelectorAll('thead th').forEach(function(x){
    h.push((x.innerText||'').trim().replace(/[\\n\\r]+/g,' '));
  });
  var colUnplanned = h.indexOf('Open Unplanned Work Requests');
  var colPlanned   = h.indexOf('Open Planned Work Requests');
  var colState     = h.indexOf('Lifecycle state');
  var dueDateIdx   = h.indexOf('Due date');
  var r = [];
  var wrRows = [];
  // The 'Due date' cell packs multiple maintenance items into one cell as
  // repeated <p>DATE</p><div>LABEL</div> pairs (e.g. PM A, PM B, PM X, DOT,
  // Quarterly Lift, Wash, APU, R360 Handoff Inspection). Reading the flattened
  // text naively pairs each label with the WRONG date (off-by-one) since the
  // date precedes its label in the DOM. Parse the actual <p> elements and
  // their next-sibling label instead of trusting innerText order.
  function _parseDueDateMap(cell) {
    var map = {};
    if (!cell) return map;
    var dates = cell.querySelectorAll('p');
    for (var di = 0; di < dates.length; di++) {
      var dateText = (dates[di].innerText||'').trim();
      var labelEl  = dates[di].nextElementSibling;
      var labelText = labelEl ? (labelEl.innerText||'').trim() : '';
      if (labelText) map[labelText] = dateText;
    }
    return map;
  }
  function _pickDue(map, prefix) {
    var keys = Object.keys(map);
    var pfx  = prefix.toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase().indexOf(pfx) === 0) return map[keys[i]];
    }
    return null;
  }
  t.querySelectorAll('tbody tr').forEach(function(tr, ri){
    var c = tr.querySelectorAll('td');
    if (c.length < 3) return;
    var o = {};
    for (var i = 0; i < c.length; i++) { o[h[i]||'c'+i] = (c[i].innerText||'').trim(); }
    if (!o['Equipment ID'] && !o[h[1]]) return;
    if (dueDateIdx >= 0 && c[dueDateIdx]) {
      var dueMap = _parseDueDateMap(c[dueDateIdx]);
      // Precise raw values, correctly paired via DOM parsing (see
      // _parseDueDateMap above). The renderer's short pill format
      // ('overdue' | 'Mon D' | '--') is derived from these downstream in
      // src/scrapers/relay.js (_parsePMDates / _formatPmDate) — do not
      // re-derive it here to avoid two divergent implementations.
      o['pmBDue']            = _pickDue(dueMap, 'pm b');
      o['pmXDue']            = _pickDue(dueMap, 'pm x');
      o['dotDue']            = _pickDue(dueMap, 'dot');
      o['quarterlyLiftDue']  = _pickDue(dueMap, 'quarterly lift');
    }
    r.push(o);
    // Only click-capture for UNAVAILABLE units
    if ((o['Lifecycle state']||'').toLowerCase() !== 'unavailable') return;
    // Check BOTH columns independently — a unit can have both planned and
    // unplanned WRs simultaneously (e.g. expired inspection + active breakdown).
    var eqIdVal = o['Equipment ID'] || '';
    var stateReason = o['Lifecycle state reason'] || '';
    if (colUnplanned >= 0) {
      var ucnt = (c[colUnplanned] ? c[colUnplanned].innerText : '').trim();
      if (ucnt && ucnt !== '0' && ucnt !== '--') {
        wrRows.push({ rowIdx: ri, eqId: eqIdVal, colToClick: 'unplanned', colIdx: colUnplanned, reason: stateReason });
      }
    }
    if (colPlanned >= 0) {
      var pcnt = (c[colPlanned] ? c[colPlanned].innerText : '').trim();
      if (pcnt && pcnt !== '0' && pcnt !== '--') {
        wrRows.push({ rowIdx: ri, eqId: eqIdVal, colToClick: 'planned', colIdx: colPlanned, reason: stateReason });
      }
    }
  });
  return { rows:r, count:r.length, headers:h, wrRows:wrRows,
    debug:'table class='+t.className+' trs='+t.querySelectorAll('tbody tr').length };
})()`;


// ── Map raw AAP rows → normalised camelCase, drop rows with no equipmentId ───
function _mapAAPRows(rawRows) {
  return rawRows.map(row => {
    const m = {};
    Object.keys(row).forEach(k => {
      const f = AAP_FIELD_MAP[k];
      if (f) m[f] = row[k];
    });
    // Build AAP asset URL from captured Asset ID
    if (m.assetId && m.assetId.trim()) {
      m.assetUrl = 'https://aap-na.corp.amazon.com/v2/asset/' + m.assetId.trim();
    } else if (row._assetUrl) {
      m.assetUrl = row._assetUrl;
    }
    return m;
  }).filter(x => x.equipmentId);
}

// ── Save scrape results to aap_cache + fleetData ──────────────────────────────
function _saveAAPCaches(rows) {
  const now     = new Date().toISOString();
  // Save raw AAP data to aap cache
  store.save('aapCache', { rows, count: rows.length, scrapedAt: now, syncedAt: now, stale: false });

  // Re-merge relay + uptake before saving to fleetData (prevents wiping enriched data)
  let mergedRows = rows;
  try {
    const P = require('../config/paths').P;
    const _fs = require('fs');
    // Merge Uptake
    const uptakeHash = store.load('uptakeHash', {});
    if (uptakeHash.units && uptakeHash.units.length) {
      const { mergeUptakeIntoRows } = require('../scrapers/uptake');
      mergedRows = mergeUptakeIntoRows(mergedRows, uptakeHash.units);
    }
    // Merge Relay from cache file
    // Phase 1 fix: use store.load() instead of raw fs.readFileSync for atomic-read safety.
    const relayData = store.load('relayCache', {});
    if (relayData && Object.keys(relayData).length > 0) {
      const notesStore = store.load('notesStore', {});
      const { mergeRelayIntoRows } = require('../scrapers/relay');
      mergedRows = mergeRelayIntoRows(mergedRows, relayData, notesStore);
    }
  } catch (e) {
    require('../utils/logger')('window').warn('_saveAAPCaches merge failed:', e.message);
  }

  const payload = { rows: mergedRows, count: mergedRows.length, scrapedAt: now, syncedAt: now, stale: false };
  store.save('fleetData', payload);
  return payload;
}

// ── initWindows(ctx) ──────────────────────────────────────────────────────────
function initWindows(ctx) {
  const { pushData, pushStatus, pushError, send, startAutoSync, runFullSync } = ctx;

  let mainWindow        = null;
  let tray              = null;
  let bubbleWin         = null;
  let wizWin             = null; // BUG FIX (2026-07-22): hoisted so closeSetupWizard() below can reach it
  let _bubbleLastPos    = null;
  // CHAT HEAD (2026-07-24): true when the bubble was popped up temporarily
  // for an incoming-message notification while the main window was still
  // open (Messenger-style chat head), as opposed to the normal persistent
  // bubble shown while the main window is minimized/closed.
  let _bubbleIsTemporary   = false;
  let _bubbleAutoHideTimer = null;
  const BUBBLE_AUTO_HIDE_MS = 15000;
  let _rescanInProgress = false;
  let _rescanHitSSO     = false; // set when a rescan window lands on Midway SSO (dead session)
  let _appReady         = false;
  let _startupScrapeStarted = false; // hoisted so API mode can hard-block the scrape loop
  let _uptakeRefreshing = false;     // hoisted: guards the background Uptake API refresh
  let _deepScanRunning  = false;     // hoisted: guards the background Orcha AI timeline build
  let _lastDeepScanAt   = 0;         // hoisted: throttles the AI timeline build to once / 20 min
  let _autoSyncStarted  = false;     // hoisted: ensures the auto-sync timer starts exactly once
  let _reauthInFlight   = false;     // hoisted: guards the AEA/mwinit recovery ladder (one at a time)
  let _apiLoadInFlight  = false;     // hoisted: single-flight guard for _loadFleetViaApiStartup (no concurrent builds)
  let _apiLoadPendingReason = null;  // hoisted: a load requested while one was in flight → one trailing refresh
  let _pmFillRunning    = false;     // hoisted: guards the background PM/location fill
  let _lastPmFillAt     = 0;         // hoisted: throttles the PM/location fill to once/hour
  const RESCAN_INTERVAL_MS = 5 * 60 * 1000; // hoisted: _showApp reads it synchronously in API mode

  // Lazy-load scrapers to avoid circular require at module load
  function _getAap()  { return require('../scrapers/aap'); }
  function _getAuth() { return require('../scrapers/auth'); }
// Phase D: the ONE auth health authority. All session-rejection recovery routes
// through the supervisor (target-verified, single-lock, bounded auto-retry) so
// no caller runs its own competing ladder.
function _getAuthSupervisor() { try { return require('../auth/midway-health-supervisor'); } catch (_) { return null; } }

  function getDomiciles() {
    const settings = store.load('settings', {});
    return (settings.domiciles && settings.domiciles.length)
      ? settings.domiciles
      : require('../config/defaults').DEFAULT_DOMICILES;
  }

  // ── Data source mode ────────────────────────────────────────────────────
  // The direct AAP/RG JSON API is the DEFAULT fleet data source. The legacy
  // BrowserWindow scrape (which depends on AEA and can bounce into Midway SSO
  // loops) is used ONLY when the user explicitly opts into 'scrape' mode via
  // the status-bar sync pill toggle. When API mode is active we must NOT load
  // the AAP scan URL in the main window, NOT run the startup/rescan scrape
  // loops, and NOT let scrape writers overwrite the API-sourced fleetData.
  // RETIRED SCRAPE (2026-10-28): the API is the only fleet source. The legacy
  // settings.dataSource='scrape' value is ignored; the scrape branches below
  // are kept as a disabled backup, reachable only via FLEET_LEGACY_SCRAPE=1.
  // See src/config/data-source.js.
  function _apiMode() {
    try { return require('../config/data-source').isApiMode(); }
    catch (_) { return true; }
  }

  // ── Bubble ────────────────────────────────────────────────────────────────
  function showBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      // Already showing (e.g. as a temporary chat-head) — the main window
      // is now actually minimized/closed too, so promote it to the normal
      // persistent bubble instead of letting the auto-hide timer kill it.
      _bubbleIsTemporary = false;
      if (_bubbleAutoHideTimer) { clearTimeout(_bubbleAutoHideTimer); _bubbleAutoHideTimer = null; }
      return;
    }

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const savedPos = _bubbleLastPos || { x: width - 70, y: height - 70 };
    // BUBBLE MIRROR (2026-07-24): the bubble now loads the SAME renderer
    // entry point/component tree as the real in-app Orcha FAB (see
    // renderer/src/bubble-fab.html + renderer/src/js/components/orcha-fab.js)
    // instead of the old thin, hand-rolled renderer/bubble.html, and shares
    // the app's real preload.js (which now also exposes window.bubble.*)
    // instead of the old separate bubble-preload.js.
    const bubbleHtml = path.join(ROOT_DIR, 'renderer', 'src', 'bubble-fab.html');

    bubbleWin = new BrowserWindow({
      width: 56, height: 56,
      x: savedPos.x, y: savedPos.y,
      frame: false, transparent: true, backgroundColor: '#00000000',
      // WINDOWS 11 BACKDROP MATERIAL FIX (2026-07-25): DWM can silently
      // apply an automatic Mica/frosted backdrop material to frameless
      // windows even with transparent:true set, painting a flat pale tint
      // over anything not covered by real content. Barely visible on the
      // tiny 56x56 mini icon (almost no blank margin), but glaringly
      // obvious as a solid rectangle on the ~400x580 expanded panel (lots
      // of blank margin around the actual chat panel). 'none' opts the
      // window out of any backdrop material entirely.
      backgroundMaterial: 'none',
      alwaysOnTop: true,
      // WINDOWS RESIZE REPAINT FIX (2026-07-25): this window is resized
      // programmatically at runtime (56x56 mini <-> ~400x580 expanded, see
      // 'bubble:resize' handler below) every time the panel opens/closes.
      // resizable:false + a layered/transparent surface is a known bad
      // combination on Windows -- DWM treats non-resizable windows as
      // fixed-size and can fail to re-invalidate/repaint the compositor
      // surface for a *programmatic* setSize() call on one, leaving it
      // blank until some unrelated event forces a repaint. frame:false
      // already removes any visible border/handles, so there is no UX
      // downside to allowing resize -- the user still has nothing to
      // drag, there's just no frame to grab.
      resizable: true, skipTaskbar: true, hasShadow: false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    if (fs.existsSync(bubbleHtml)) {
      bubbleWin.loadFile(bubbleHtml);
    } else {
      logger.warn('bubble-fab.html not found — bubble will be blank until renderer is built');
      bubbleWin.loadURL('data:text/html,<body style="background:transparent"></body>');
    }

    bubbleWin.setAlwaysOnTop(true, 'floating');
    bubbleWin.setIgnoreMouseEvents(false);

    bubbleWin.on('moved', () => {
      if (bubbleWin && !bubbleWin.isDestroyed()) {
        const [x, y] = bubbleWin.getPosition();
        _bubbleLastPos = { x, y };
      }
    });

    const lastData = store.load('fleetData', null);
    if (lastData && lastData.rows) {
      const unavail = lastData.rows.filter(
        r => /unavailable/i.test(r.atsState || r.lifecycleState || '')
      ).length;
      bubbleWin.webContents.once('did-finish-load', () => {
        if (bubbleWin && !bubbleWin.isDestroyed())
          bubbleWin.webContents.send('bubble:badge', unavail);
      });
    }

    // CHAT FLOATER TRANSPARENCY (2026-07-25): apply the user's saved panel
    // opacity as soon as the bubble finishes loading, so it doesn't flash
    // fully opaque then jump to the saved value.
    bubbleWin.webContents.once('did-finish-load', () => {
      if (!bubbleWin || bubbleWin.isDestroyed()) return;
      const bubbleCfg = store.load('bubbleConfig', { opacity: 100 });
      bubbleWin.webContents.send('bubble:opacity-changed', bubbleCfg.opacity);
    });
  }

  function hideBubble() {
    if (_bubbleAutoHideTimer) { clearTimeout(_bubbleAutoHideTimer); _bubbleAutoHideTimer = null; }
    _bubbleIsTemporary = false;
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.destroy();
      bubbleWin = null;
    }
  }

  function _scheduleBubbleAutoHide() {
    if (_bubbleAutoHideTimer) clearTimeout(_bubbleAutoHideTimer);
    _bubbleAutoHideTimer = setTimeout(() => {
      // Only auto-hide if it's still in temporary chat-head mode (the user
      // hasn't opened the panel, and the main window hasn't been minimized
      // in the meantime -- both of those paths already clear this flag).
      if (_bubbleIsTemporary) hideBubble();
    }, BUBBLE_AUTO_HIDE_MS);
  }

  function pushBubbleNotification(notif) {
    // CHAT HEAD (2026-07-24): if nothing is showing yet, pop the bubble up
    // temporarily for this notification -- like Android Messenger chat
    // heads -- even though the main window may still be open. If the main
    // window is genuinely hidden/minimized already, showBubble() below
    // behaves exactly as before (persistent, not temporary).
    const mainOpen = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
    if (!bubbleWin || bubbleWin.isDestroyed()) {
      showBubble();
      if (mainOpen) {
        _bubbleIsTemporary = true;
        _scheduleBubbleAutoHide();
      }
    } else if (_bubbleIsTemporary) {
      // Already showing as a chat head -- another message came in, so
      // restart the countdown instead of letting it vanish mid-read.
      _scheduleBubbleAutoHide();
    }

    if (bubbleWin && !bubbleWin.isDestroyed())
      bubbleWin.webContents.send('bubble:notification', notif);

    _sendDesktopNotification(
      notif.title || (notif.unit ? ('Unit ' + notif.unit) : 'Fleet Update'),
      notif.message || '',
      () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          if (notif.unit) mainWindow.webContents.send('navigate:unit', notif.unit);
        }
      }
    );
  }

  function _sendDesktopNotification(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    const notif = new Notification({
      title, body,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      if (onClick) onClick();
    });
    notif.show();
  }

  // ── AAP scrape loop ───────────────────────────────────────────────────────
  // Given a BrowserWindow already loaded with an AAP page:
  //  1. Auto-configures AAP columns via UI injection
  //  2. Polls for table rows every 2s
  //  3. Forces 1000/page, extracts, maps, calls onComplete(rows)
  async function _runAAPScrapeLoop(win, { label, maxPolls = 18, onComplete, onTimeout }) {
    let done  = false;
    let polls = 0;

    // Configure columns before polling starts.
    // NOTE: chunked rescans use labels like 'rescan#1/2', so match by prefix —
    // an exact 'rescan' check would skip the DOM-settle wait + column config for
    // every chunk, causing them to poll an unrendered/unconfigured page and
    // return 0 rows (observed: chunk 'rescan#2/2' polled 0 rows x18 then gave up).
    if (label === 'startup' || label.indexOf('rescan') === 0) {
      try {
        // Wait for DOM to settle: 1.5s quiet window AFTER last did-finish-load.
        // Do NOT arm timer immediately -- scrape starts mid-redirect-storm.
        // Most reloads already fired. Wait for next real reload then debounce.
        // 10s ceiling: edge case where AAP is already fully settled.
        await new Promise(function(resolve) {
          // Hard 4s delay to let the initial redirect storm start,
          // then debounce: resolve 1.5s after the last did-finish-load.
          // 15s ceiling from attach point as absolute safety net.
          setTimeout(function() {
            var settled;
            var ceiling = setTimeout(function() {
              // BUG FIX (2026-07-14): the removeListener call below was
              // missing a win.isDestroyed() guard. Confirmed live in
              // errors.log: "Object has been destroyed" thrown from exactly
              // this line (2026-07-14 08:03 EDT). The window can be destroyed
              // by an unrelated timeout/cancel path while this 15s ceiling
              // timer is still pending.
              if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', arm);
              resolve();
            }, 15000);
            function arm() {
              clearTimeout(settled);
              settled = setTimeout(function() {
                clearTimeout(ceiling);
                if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', arm);
                resolve();
              }, 2000);
            }
            win.webContents.on('did-finish-load', arm);
            arm(); // arm once to handle pre-settled case after the hard delay
          }, 6000);
        });
        // Pre-check: read current table headers — skip config if all columns already present
        const headerCheck = await win.webContents.executeJavaScript(`(function() {
  var WANT = [
    "Domicile site","Operator","Asset type","Fuel type",
    "Lifecycle state","Lifecycle state reason","Manufacturer","Body type",
    "Due date","Open Unplanned Work Requests","Open Planned Work Requests","Last geofences","Asset ID"
  ];
  var headers = Array.from(document.querySelectorAll('th button, th[role="columnheader"]')).map(function(h) {
    return (h.textContent || '').trim();
  });
  // Also check plain th text
  Array.from(document.querySelectorAll('th')).forEach(function(th) {
    var t = (th.textContent || '').trim();
    if (t && !headers.includes(t)) headers.push(t);
  });
  var missing = WANT.filter(function(w) {
    return !headers.some(function(h) { return h === w; });
  });
  return { missing: missing, headers: headers.slice(0, 20) };
})()`);
        logger.info('[' + label + '] Column header check: missing=' + JSON.stringify(headerCheck.missing));
        if (headerCheck.missing.length === 0) {
          logger.info('[' + label + '] All columns already configured — skipping column config');
        } else {

        // Step 1: get eye button screen coords
        const btnCoords = await win.webContents.executeJavaScript(`(function() {
  // Primary: full selector confirmed via Chrome DevTools console
  // CSS class segments will rotate on AAP deploys - ID anchor + nth-child(4) is stable
  var btn = document.querySelector(
    '#app-layout-content-1 > div > div > div.css-1h2w845 > div > div.css-1d7jqjm > div.css-1k6haed > div > div:nth-child(1) > div > div > div > button:nth-child(4)'
  );
  // Fallback: ID anchor + any 4th button in a toolbar-like div container
  if (!btn) {
    var root = document.getElementById('app-layout-content-1');
    if (root) {
      // Find all groups of 3+ adjacent buttons inside root, pick 4th of the toolbar group
      var allBtns = Array.from(root.querySelectorAll('button'));
      // Group buttons by their direct parent
      var parentMap = {};
      allBtns.forEach(function(b) {
        var key = b.parentElement;
        if (!parentMap.has(key)) parentMap.set(key, []);
        parentMap.get(key).push(b);
      });
      parentMap.forEach(function(group, parent) {
        if (!btn && group.length >= 4) {
          // Pick the 4th button (index 3) in this group
          var candidate = group[3];
          var r = candidate.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) btn = candidate;
        }
      });
    }
  }
  if (!btn) return null;
  var r = btn.getBoundingClientRect();
  var svg = btn.querySelector('svg path');
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), path: svg ? svg.getAttribute('d').slice(0,30) : '' };
})()`);
        if (!btnCoords) {
          logger.warn('[' + label + '] Column config: eye button not found');
        } else {
          logger.info('[' + label + '] Column config: clicking eye button at', JSON.stringify(btnCoords));
          // Step 2: click the button directly via JS (same as DevTools console - works)
          await win.webContents.executeJavaScript(`(function() {
  var btn = document.querySelector(
    '#app-layout-content-1 > div > div > div.css-1h2w845 > div > div.css-1d7jqjm > div.css-1k6haed > div > div:nth-child(1) > div > div > div > button:nth-child(4)'
  );
  if (!btn) {
    var root = document.getElementById('app-layout-content-1');
    if (root) {
      var allBtns = Array.from(root.querySelectorAll('button'));
      var parentMap = new Map();
      allBtns.forEach(function(b) {
        var key = b.parentElement;
        if (!parentMap.has(key)) parentMap.set(key, []);
        parentMap.get(key).push(b);
      });
      parentMap.forEach(function(group) {
        if (!btn && group.length >= 4) {
          var r = group[3].getBoundingClientRect();
          if (r.width > 0) btn = group[3];
        }
      });
    }
  }
  if (btn) { btn.focus(); btn.click(); return true; }
  return false;
})()`);
          await new Promise(r => setTimeout(r, 2500));
          // Step 3: interact with popup
          const colRes = await win.webContents.executeJavaScript(`(async function __aapConfigCols() {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function simClick(el) {
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(ev) {
      var Ctor = ev.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(ev, { bubbles: true, cancelable: true, pointerId: 1 }));
    });
  }
  var WANT = [
    "Domicile site","Operator","Asset type","Fuel type",
    "Lifecycle state","Lifecycle state reason","Manufacturer","Body type",
    "Due date","Open Unplanned Work Requests","Open Planned Work Requests","Last geofences","Asset ID"
  ];

  // Find popup: check portal divs on body first (Chrome Recorder showed body>div[3])
  var popup = null;
  // Check each direct child of body for portal
  // Portal divs: popup renders inside existing body children (div 17-19), not as new child
  // Search all divs including deep inside portal containers
  var bodyDivs = Array.from(document.body.children);
  for (var bi = bodyDivs.length - 1; bi >= 0; bi--) {
    var t = bodyDivs[bi].textContent || '';
    if (t.includes('Available Columns') && t.includes('Selected columns')) {
      popup = bodyDivs[bi]; break;
    }
  }
  // Fallback: deep search all divs
  if (!popup) {
    popup = Array.from(document.querySelectorAll('div')).find(function(d) {
      var t = d.textContent || '';
      return t.includes('Available Columns') && t.includes('Selected columns');
    }) || null;
  }
  // Log body child count and what we found
  if (!popup) return { ok: false, reason: 'popup not found', bodyChildren: document.body.children.length, bodyText: Array.from(document.body.children).map(function(c,i){return i+':'+c.tagName+(c.textContent||'').slice(0,20);}).join('|') };

  // Split popup into Available (left) and Selected (right) sections by h4 headings
  var h4s = Array.from(popup.querySelectorAll('h4'));
  var availHead = h4s.find(function(h) { return (h.textContent||'').trim() === 'Available Columns'; });
  var selHead   = h4s.find(function(h) { return (h.textContent||'').trim() === 'Selected columns'; });
  var availSection = availHead && availHead.closest('div');
  var selSection   = selHead   && selHead.closest('div');

  // Remove all selected columns except Equipment ID
  if (selSection) {
    for (var rr = 0; rr < 50; rr++) {
      var remRows = Array.from(selSection.querySelectorAll('p')).filter(function(p) {
        return (p.textContent||'').trim() !== 'Equipment ID' && (p.textContent||'').trim().length > 0;
      });
      if (remRows.length === 0) break;
      var remBtn = remRows[0].parentElement && remRows[0].parentElement.querySelector('button[data-mdn-interactive]');
      if (remBtn) { simClick(remBtn); await sleep(200); } else break;
    }
  }

  // Add each wanted column via search + p.parentElement button
  var searchInput = availSection ? availSection.querySelector('input[type="text"]') : null;
  var added = [], failed = [];
  for (var ci = 0; ci < WANT.length; ci++) {
    var name = WANT[ci];
    if (searchInput) {
      var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSet.call(searchInput, name);
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
    }
    var leaf = Array.from((availSection || popup).querySelectorAll('p')).find(function(p) {
      return (p.textContent||'').trim() === name;
    });
    var addBtn = leaf && leaf.parentElement && leaf.parentElement.querySelector('button[data-mdn-interactive]');
    if (addBtn) { simClick(addBtn); added.push(name); await sleep(250); }
    else { failed.push(name); }
    if (searchInput) {
      var clearBtn = availSection && availSection.querySelector('button[aria-label="Clear search"]');
      if (clearBtn) { simClick(clearBtn); await sleep(200); }
    }
  }

  // Click Apply
  await sleep(300);
  var applyBtn = Array.from(document.querySelectorAll('button[data-mdn-interactive]')).find(function(b) {
    return (b.textContent||'').trim() === 'Apply';
  });
  if (applyBtn) { simClick(applyBtn); return { ok: true, added: added, failed: failed }; }
  return { ok: false, reason: 'Apply not found', added: added, failed: failed };
})()`);
          logger.info('[' + label + '] Column config:', JSON.stringify(colRes));
          if (colRes && colRes.ok) await new Promise(r => setTimeout(r, 1800));
        }
        }
      } catch (e) {
        logger.warn('[' + label + '] Column config failed:', e.message);
      }
    }

    const iv = setInterval(async () => {
      polls++;
      if (done) { clearInterval(iv); return; }
      if (polls > maxPolls) {
        clearInterval(iv);
        if (!done) { done = true; onTimeout(); }
        return;
      }

      try {
        const count = await win.webContents.executeJavaScript(
          `document.querySelectorAll('tbody tr').length`
        );

        if (label === 'startup' && (polls === 5 || polls === 20)) {
          const info = await win.webContents.executeJavaScript(`(function(){
            return JSON.stringify({
              tables:   document.querySelectorAll('table').length,
              tbodies:  document.querySelectorAll('tbody').length,
              trs:      document.querySelectorAll('tr').length,
              bodySnip: (document.body.innerText||'').substring(0,300),
            });
          })()`);
          logger.info('[' + label + '] DOM probe poll=' + polls + ': ' + info);
        }

        logger.info('[' + label + '] Poll ' + polls + ' \u2192 ' + count + ' rows');

        if (count > 5 && !done) {
          clearInterval(iv);
          done = true;
          logger.info('[' + label + '] Found ' + count + ' rows \u2014 forcing 1000/page...');

          try {
            const rpp = await win.webContents.executeJavaScript(JS_FORCE_1000_RPP);
            logger.info('[' + label + '] RPP:', rpp);
            await new Promise(r => setTimeout(r, 500));
            const c1000 = await win.webContents.executeJavaScript(JS_CLICK_1000);
            logger.info('[' + label + '] 1000-click:', c1000);
            await new Promise(r => setTimeout(r, 8000));
            const newCount = await win.webContents.executeJavaScript(
              `document.querySelectorAll('tbody tr').length`
            );
            logger.info('[' + label + '] After 1000 force: ' + newCount + ' rows');
          } catch (e) {
            logger.warn('[' + label + '] Force-1000 error:', e.message);
          }


          const data = await win.webContents.executeJavaScript(JS_EXTRACT_TABLE);
          logger.info('[' + label + '] Extracted ' + data.count + ' records. ' + data.debug);
          // Build WR URLs from scraped data — no clicking needed
          // URL: /v2/page/{ID}?tab={Unplanned|Planned}&states=[...]&equipmentId={eq}
          const wrCount   = (data.wrRows||[]).length;
          logger.info('[' + label + '] Unavailable units for WR URL build: ' + wrCount);
          const wrUrlMap  = wrCount > 0
            ? buildWRUrls(data.wrRows, data.rows, null, logger, label)
            : {};
          logger.info('[' + label + '] WR URLs built: ' + Object.keys(wrUrlMap).length);
          if (Object.keys(wrUrlMap).length > 0) {
            (data.rows||[]).forEach(function(row) {
              const hit = wrUrlMap[row['Equipment ID']];
              if (hit) {
                // hit is now { planned?: url, unplanned?: url } — set whichever exist
                if (hit.planned)   row['Open Planned Work Requests_url']   = hit.planned;
                if (hit.unplanned) row['Open Unplanned Work Requests_url'] = hit.unplanned;
              }
            });
          }

          const rows = _mapAAPRows(data.rows || []);
          logger.info('[' + label + '] Mapped ' + rows.length + ' units');
          onComplete(rows);
        }
      } catch (e) {
        logger.info('[' + label + '] Poll ' + polls + ' error (page navigating): ' + e.message);
      }
    }, 5000); // Phase 2 perf fix: reduced from 2s to 5s — AAP load time is server-bound, faster polling just adds IPC noise
  }

  // ── Main window ───────────────────────────────────────────────────────────
  function createMainWindow() {
    const { buildScanURL } = _getAap();

    mainWindow = new BrowserWindow({
      width: 900, height: 700,
      // BUG FIX (2026-10): minHeight:500 let the window shrink below what the
      // UI actually needs (48px topbar + filterbar + KPI strip), which combined
      // with dashboard-mode's old forced 60vh table height caused header
      // content to be pushed out of view on shorter laptop screens. Raised the
      // floor; the fleet.css dashboard-mode fix (removal of that 60vh floor) is
      // the primary fix, this is just a safety margin so the window itself
      // can't be squeezed smaller than the chrome needs.
      minWidth: 600, minHeight: 600,
      title: 'Fleet Operations \u2014 Sign in\u2026',
      icon: getAppIconPath(), // FEATURE (2026-07-22): real app icon instead of default Electron icon in taskbar/titlebar
      backgroundColor: '#0d1117',
      show: false,
      center: true,
      resizable: true,
      // Frameless -- the custom in-app toolbar (renderer/src/js/components/
      // toolbar.js) already ships its own drag region (-webkit-app-region:
      // drag on #topbar in fleet.css) plus its own minimize/maximize/close
      // buttons wired to win:minimize/maximize/close below. Without
      // `frame:false` here, Windows was ALSO drawing its own native
      // titlebar + default File/Edit/View/Window menu on top of that --
      // two competing, confusing sets of window chrome. autoHideMenuBar is
      // a defensive second layer against any residual default menu.
      frame: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
        webviewTag:       true,
        devTools:         true,
      },
    });
    Menu.setApplicationMenu(null);

    // DIAGNOSTIC (2026-07-27): forward the main window's own devtools console
    // to our logger. Without this, renderer-side "Uncaught TypeError" reports
    // are unlocatable from here -- there's no browser/devtools access in this
    // tooling, only whatever text the user manually copies out of a toast.
    // levels: 0=verbose/log, 1=info, 2=warning, 3=error
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) {
        logger.warn('[renderer-console] ' + message + '  (' + (sourceId || '').split(/[\\/]/).pop() + ':' + line + ')');
      }
    });

    // Forward maximize/restore state to the renderer so the custom toolbar
    // button can swap its icon -- native titlebars do this automatically;
    // a frameless window has to do it by hand.
    mainWindow.on('maximize',   () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('win:state-changed', { maximized: true }); });
    mainWindow.on('unmaximize', () => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('win:state-changed', { maximized: false }); });

    // Keep all links inside the app
    // Open external URL in a popup window with Back to Fleet button
    function _openExternalInPopup(url) {
      logger.info("[popup] Opening external: " + url.substring(0, 80));
      const { BrowserWindow: BW } = require('electron');
      const popup = new BW({
        width: 1400, height: 900,
        title: 'Fleet Operations - External',
        icon: getAppIconPath(),
        backgroundColor: '#0d1117',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      // Use vendor partition if available for isolated session
      popup.loadURL(url);
      // Auto-login: detect login pages on vendor sites and fill saved credentials
      attachAutoLogin(popup, url); // auto-login for vendor sites
      popup.once('ready-to-show', () => popup.show());
    }


    // Track navigation for back-to-fleet (no page injection)
    let _fleetUrl = null;
    mainWindow.webContents.on('did-navigate', (_e, url) => {
      if (url.includes('localhost:5173') || url.includes('dist/renderer')) {
        _fleetUrl = url;
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // During startup scrape (before app is ready), keep AAP/Midway navigation
      // inside the main window instead of hijacking it into a popup — this was
      // causing the app to get stuck showing a raw AAP popup and never switch
      // to the Fleet Operations UI.
      if (!_appReady && (url.includes('aap-na.corp.amazon.com') || url.includes('midway-auth.amazon.com'))) {
        mainWindow.loadURL(url);
        return { action: 'deny' };
      }
      // Open in a new window with native back-to-fleet
      _openExternalInPopup(url);
      return { action: 'deny' };
    });

    


    // Keyboard shortcut: Alt+Home to return to fleet app
    const { globalShortcut } = require('electron');
    // Register after window is ready
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.alt && input.key === 'Home') {
        const currentUrl = mainWindow.webContents.getURL();
        if (!currentUrl.includes('localhost:5173') && !currentUrl.includes('dist/renderer')) {
          if (process.env.NODE_ENV === 'development') {
            mainWindow.loadURL('http://localhost:5173');
          } else {
            mainWindow.loadFile(require('path').join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
          }
        }
      }
    });


    mainWindow.webContents.on('will-navigate', (event, url) => {
      // Allow local dev server
      if (url.includes('localhost:5173') || url.includes('dist/renderer') || url.startsWith('file://') || url.startsWith('data:')) return;
      // During startup scrape (before app is ready), allow AAP/Midway navigation
      // to complete in-window — don't divert the startup scrape target to a popup.
      if (!_appReady && (url.includes('aap-na.corp.amazon.com') || url.includes('midway-auth.amazon.com'))) return;
      // External links open in popup - main window stays on fleet
      event.preventDefault();
      _openExternalInPopup(url);
    });

    const scrapeDomiciles = getDomiciles();
    // AAP caps the search filter at 6 domiciles (more -> empty page). If the user
    // has >6 configured, the startup scrape loads only the FIRST 6 so the app shows
    // quickly with partial data; the chunked triggerLiveRescan() that fires 90s
    // after _showApp() then backfills the remaining chunks into the full dataset.
    const startupDomiciles = scrapeDomiciles.slice(0, 6);
    const startUrl        = buildScanURL(startupDomiciles);
    if (scrapeDomiciles.length > 6) {
      logger.info('Startup: ' + scrapeDomiciles.length + ' domiciles configured; scraping first 6 now, rest via chunked rescan');
    }
    // ── API MODE (default): skip the AAP BrowserWindow scrape entirely ──────
    // The direct AAP/RG JSON API is the default source. Don't load the AAP scan
    // URL (which triggers AEA/SSO churn) — show the Fleet UI immediately and
    // kick off the API load. The scrape pipeline is used only in 'scrape' mode.
    if (_apiMode()) {
      logger.info('[data-source] API mode \u2014 skipping AAP scrape, loading Fleet UI + API data');
      _startupScrapeStarted = true;   // hard-block the scrape loop in _onMainWindowNav
      try { send('auth:mwinit-status', { ok: true }); } catch (_) {}
      // Expose the API loader on ctx NOW (before the early return) so the
      // scheduler-driven runFullSync() + the status-bar toggle can trigger an
      // API refresh. _loadFleetViaApiStartup is a hoisted function declaration,
      // so it's safe to reference here even though it's defined further down.
      if (ctx) ctx._loadFleetViaApiStartup = _loadFleetViaApiStartup;
      // Paint the app UI right away from cache (if any), then load live via API.
      _showApp();
      _loadFleetViaApiStartup();
      // Start the scheduler-driven auto-sync timer. In API mode _showApp() loads
      // the renderer BEFORE the did-finish-load listener (registered later in
      // this function) is attached, so that event is missed and startAutoSync
      // never fires on its own — kick it off directly here. Guarded to run once.
      try {
        if (!_autoSyncStarted) {
          _autoSyncStarted = true;
          if (ctx && ctx.startAutoSync) ctx.startAutoSync();
        }
      } catch (e) { logger.warn('[data-source] startAutoSync failed: ' + e.message); }
      return;
    }

    logger.info('Loading AAP in main window: ' + startUrl.substring(0, 80));

    // ── Midway pre-flight: check actual cookie expiry, run mwinit if needed ──
    // Reads ~/.midway/cookie expiry timestamps — no hardcoded hour thresholds.
    // Spawns a visible cmd.exe terminal automatically when any cookie is expired.
    (async function _midwayPreFlight() {
      const { checkMwinit } = _getAuth();
      const state = checkMwinit();
      const supervisor = _getAuthSupervisor();

      if (supervisor && typeof supervisor.ensureHealthyConverging === 'function') {
        // DELEGATE startup entirely to the ONE supervisor (spec #3/#4/#18).
        //
        // NO cookie-only short-circuit: disk cookies (even a fresh-looking AEA)
        // are EVIDENCE, not proof. They do not establish that Electron has the
        // cookies, that live AEA is valid, that the posture agent is healthy, or
        // that AAP accepts the session. The authoritative question is: can the
        // REAL authenticated AAP target succeed? So we always VERIFY against the
        // target. The API smoke test is cheap (one read-only GET), so this does
        // not meaningfully slow startup.
        //
        // ensureHealthyConverging (not ensureHealthy) so that if startup
        // recovery fails, bounded auto-retry is ARMED automatically — startup is
        // NOT a one-shot health check. forceVerify makes it a fresh real-target
        // check even if we think we are healthy.
        logger.info('[startup] verifying Midway via supervisor (disk session ' + (state.ok ? 'ok' : state.reason) + ', aea ' + (state.aeaExpiresInMin == null ? 'missing' : state.aeaExpiresInMin + 'min') + ') — cookies are evidence only');
        pushStatus('\uD83D\uDD04 Verifying Midway session\u2026');
        try {
          const r = await supervisor.ensureHealthyConverging({ reason: 'startup', allowPrompt: true, forceVerify: true });
          if (r && r.ok && r.verified) {
            send('auth:mwinit-status', { ok: true });
            pushStatus('\u2705 Midway session ready');
          } else {
            send('auth:mwinit-status', { ok: false, reason: (r && r.reason) || 'session not verified' });
            if (r && r.state === supervisor.STATE.WAITING_FOR_USER) pushStatus('\uD83D\uDD11 Complete mwinit in the terminal to finish sign-in\u2026');
            else pushStatus('\u26A0\uFE0F Midway session not verified\u2014' + ((r && r.reason) || 'will auto-retry'));
          }
        } catch (e) {
          logger.error('[startup] supervisor ensureHealthyConverging failed: ' + e.message);
          pushError('\u26A0\uFE0F Auth check failed: ' + e.message + ' \u2014 try running mwinit -f in a terminal');
        }
      } else {
        // FALLBACK (supervisor unavailable): minimal legacy behavior.
        const { runMwinit, injectCookies } = _getAuth();
        if (!state.ok) {
          pushStatus('\uD83D\uDD11 Midway session expired \u2014 complete auth in the terminal window...');
          try { await runMwinit(); await injectCookies(); pushStatus('\u2705 Midway auth complete'); }
          catch (e) { pushError('\u26A0\uFE0F mwinit failed: ' + e.message + ' \u2014 try running mwinit -f in a terminal'); }
        } else {
          send('auth:mwinit-status', { ok: true, expiresInMin: state.expiresInMin });
        }
      }

      // Start the ONE background health monitor (spec #20). It periodically
      // verifies against the real AAP target and re-verifies on reconnect,
      // arming bounded auto-recovery when genuinely degraded (no prompt).
      // Idempotent, so safe even if preflight re-runs.
      try { if (supervisor && typeof supervisor.startHealthMonitor === 'function') supervisor.startHealthMonitor(); }
      catch (e) { logger.warn('[startup] health monitor start failed: ' + e.message); }

      // Keep window invisible during AAP scrape
      mainWindow.setPosition(-3000, -3000);
      // Window hidden during scrape via position
      // Auto-login: detect login pages and fill credentials

      mainWindow.loadURL(startUrl);
    })();

    // ── API-mode fleet load (default source) ───────────────────────────────
    // Builds the fleet dataset from the direct AAP/RG JSON API, merges Uptake +
    // saved notes (same enrichment the scrape path uses), persists to the SAME
    // fleetData store and pushes on the SAME fleet:data channel — so the table,
    // filters, KPIs, Split View and detail panel render identically. Comments
    // are NOT fetched here (table is instant); a unit's thread loads lazily via
    // refreshUnit when its detail panel opens. Called once at startup in API
    // mode, and on the recurring API refresh timer.
    async function _loadFleetViaApiStartup(reason) {
      // SINGLE-FLIGHT GUARD (2026-10-19): only ONE fleet build may run at a
      // time. Without this, a burst of callers — e.g. several AAP reads that
      // all failed while auth was down and then each fire a 'post-reauth' retry
      // when the supervisor recovers — launch concurrent buildFleetDataset()
      // runs that race on the shared AAP warm window (and one sibling calling
      // aap_api.dispose() mid-build), so none completes and the table never
      // repaints. If a build is already in flight, remember that another was
      // requested and run exactly ONE follow-up when the current one finishes
      // (coalescing the whole burst into a single trailing refresh).
      if (_apiLoadInFlight) {
        _apiLoadPendingReason = reason || 'coalesced';
        logger.info('[data-source] API load (' + (reason || 'startup') + ') skipped — a build is already in flight (coalescing)');
        return;
      }
      _apiLoadInFlight = true;
      try {
        // Stage 11: cluster live-pull gate. This is the single chokepoint every
        // recurring live AAP read converges on (the 5-min API timer, the rescan
        // redirect, app.js auto-sync via sync/index.js, and the scheduler
        // pipeline's runFullSync all funnel here). A host that may NOT pull live
        // (a non-capable standby) skips the live pull and keeps whatever the
        // cluster sync engine already applied as a snapshot. A capable host
        // (the laptop, or a headless DevSpace standby advertising aapLivePull
        // via browser_provider) proceeds exactly as before. When the cluster
        // flag is OFF, mayLivePull() is true → byte-for-byte unchanged behavior.
        // This is a READ gate, independent of leadership/production writes.
        try {
          const cluster = require('../cluster');
          if (typeof cluster.mayLivePull === 'function' && !cluster.mayLivePull()) {
            logger.info('[data-source] API load (' + (reason || 'startup') +
              ') skipped — host is not live-pull capable (standby); using synced snapshot');
            pushStatus('\uD83D\uDD04 Standby — showing synced fleet snapshot');
            return;
          }
        } catch (_) { /* cluster not wired → behave as legacy single-host */ }

        logger.info('[data-source] API load (' + (reason || 'startup') + '): building fleet dataset…');
        pushStatus('\uD83D\uDD04 Loading fleet via API…');
        const api = require('../scrapers/aap_api');
        const { mergeUptakeIntoRows } = require('../scrapers/uptake');
        const { mergeRelayIntoRows } = require('../scrapers/relay');
        const ds  = await api.buildFleetDataset({ withComments: false });
        let rows  = ds.rows || [];

        // Enrich from the CACHED Uptake units immediately (never block the table
        // on a live Uptake refresh). Uptake data is layered by equipmentId.
        try {
          const uu = (store.load('uptakeHash', {}).units) || [];
          if (uu.length) rows = mergeUptakeIntoRows(rows, uu);
        } catch (e) { logger.warn('[data-source] uptake merge skipped: ' + e.message); }
        // Saved notes by equipmentId. EMPTY relayData so the API's vendor/WO/
        // offsite/comment fields pass through unmodified.
        try {
          const ns = store.load('notesStore', {});
          rows = mergeRelayIntoRows(rows, {}, ns);
        } catch (e) { logger.warn('[data-source] notes merge skipped: ' + e.message); }

        // CARRY-FORWARD per-unit enrichment that the bulk rebuild CANNOT
        // reproduce (PM due dates + location from getAsset, offsite URL from WO
        // comments, fetched lazily by hydration / PM-fill / refreshUnit). Without
        // this, every recurring 5-min rebuild wiped PM/geo/offsite back to blank
        // (observed: PM pills 201 -> 0 after the refresh). Overlay the previous
        // fleetData's values for these fields by equipmentId; the fresh rebuild
        // wins for everything else (lifecycle, WO, vendor, etc.).
        try {
          const prev = store.load('fleetData', null);
          if (prev && Array.isArray(prev.rows) && prev.rows.length) {
            const CARRY = ['pmBDue','pmXDue','dotDue','quarterlyLiftDue','pmB','pmX','dot','quarterlyLift',
              'geofence','offsiteShopEventUrl','savedOffsiteUrl','offsiteShopEvent','asistSrUrl','asistLabel','asistSource','asistNotes','offsiteStage','dealerName'];
            const prevById = new Map(prev.rows.map((r) => [r.equipmentId, r]));
            for (const row of rows) {
              const p = prevById.get(row.equipmentId);
              if (!p) continue;
              for (const k of CARRY) {
                // carry prior value only when the fresh rebuild left it blank/'--'
                if ((row[k] == null || row[k] === '' || row[k] === '--') && p[k] != null && p[k] !== '' && p[k] !== '--') {
                  row[k] = p[k];
                }
              }
            }
          }
        } catch (e) { logger.warn('[data-source] carry-forward merge skipped: ' + e.message); }

        const now = new Date().toISOString();
        const payload = {
          rows, count: rows.length, unavailableCount: ds.unavailableCount,
          scrapedAt: now, syncedAt: now, stale: false, source: 'aap-api',
        };
        store.save('fleetData', payload);
        if (ctx) ctx.lastData = payload;
        pushData(payload);   // TABLE PAINTS NOW — instant, no Uptake wait.
        logger.info('[data-source] API load: pushed ' + rows.length + ' units (' + ds.unavailableCount + ' unavailable)');
        pushStatus('\u2705 ' + rows.length + ' units \u2014 ' + ds.unavailableCount + ' unavailable (API)');

        // BACKGROUND: if the Uptake cache is stale (>1h), refresh it via Uptake's
        // OWN REST API (src/scrapers/uptake.js), then re-merge + re-push. This is
        // NOT awaited — the table is already live; Uptake risk scores fold in when
        // ready. Guarded so only one Uptake refresh runs at a time.
        _maybeRefreshUptakeAsync(ds, mergeUptakeIntoRows, mergeRelayIntoRows);

        // BACKGROUND: AI repair-timeline build. The API provides raw WO comments
        // in fullConversation (+ offsite asistNotes); the OFFICIAL timeline shown
        // to partners is built by Orcha (deep-scan.js), NOT a raw comment dump.
        // Same builder the scrape sync used. Non-blocking; writes repairTimeline
        // + notesStore and re-pushes when done.
        _maybeRunDeepScanAsync(payload);

        // BACKGROUND: PM + location for the REST of the fleet (available units).
        // The bulk asset search can't return maintenanceScheduleStatuses (HTTP
        // 400), so fetch getAsset per unit — throttled, low priority, re-pushing
        // in chunks — so every unit eventually shows PM due dates + location in
        // the table. Guarded to run once per load cycle.
        _maybeFillPmAllAsync(payload);
      } catch (e) {
        // A server-REJECTED AAP session (bounced to the SSO login wall) is the
        // one failure the timestamp-based checkMwinit() can't see — the cookie
        // file reads "valid" by expiry while AAP rejects it (almost always a
        // lapsed/missing AEA posture cookie). Recovery LADDER (cheap → costly):
        //   1. silent AEA re-mint (OIDC handshake, no prompt)
        //   2. `mwinit --refresh-aea` — re-mint JUST the AEA cookie (rung A)
        //   3. full interactive `mwinit` — only if the session itself is gone (B)
        // then retry the load once. Guarded so only one ladder runs at a time.
        const sessionRejected = (e && e.code === 'MIDWAY_SESSION_INVALID') ||
          /session expired|session rejected|re-authenticate/i.test(e && e.message || '');
        const _supervisor = _getAuthSupervisor();
        if (sessionRejected && _supervisor && typeof _supervisor.ensureHealthyConverging === 'function') {
          // Phase D: delegate to the ONE supervisor. It owns the global lock
          // (so no second ladder runs — _reauthInFlight is subsumed), runs the
          // proven rungs (silent AEA → mwinit --refresh-aea → AEA-agent self-heal
          // → interactive mwinit), VERIFIES against the real AAP target (not
          // just a probe / mwinit completion), and on failure ARMS a bounded
          // auto-retry so it converges back to HEALTHY on its own instead of
          // staying stuck. VPN is never a gate.
          logger.warn('[data-source] API load failed — AAP session rejected; delegating to auth supervisor: ' + e.message);
          try { send('auth:mwinit-status', { ok: false, reason: 'AAP session rejected — recovering' }); } catch (_) {}
          pushError('AAP session expired — recovering enterprise-access (AEA)…');
          (async () => {
            try {
              const r = await _supervisor.ensureHealthyConverging({ reason: 'data-source-api-load', allowPrompt: true });
              try { require('../scrapers/aap_api').dispose(); } catch (_) {}  // drop stale warm window
              if (r && r.ok && r.verified) {
                try { send('auth:mwinit-status', { ok: true }); } catch (_) {}
                logger.info('[data-source] supervisor recovered (rung=' + r.rung + ') — retrying fleet load');
                _loadFleetViaApiStartup('post-reauth');
              } else {
                try { send('auth:mwinit-status', { ok: false, reason: (r && r.reason) || 'AAP still rejecting' }); } catch (_) {}
                const when = (r && r.nextRetryAt) ? (' Auto-retry scheduled.') : '';
                pushError('AAP still rejecting the session (' + ((r && r.state) || 'unhealthy') + ').' + when + ' Or run `mwinit --refresh-aea` (or `mwinit -f`) in a terminal, then click Sync.');
                logger.error('[data-source] supervisor did not reach HEALTHY: ' + ((r && r.reason) || r && r.class || 'unknown') + ' (state=' + (r && r.state) + ')');
              }
            } catch (err) {
              logger.error('[data-source] supervisor recovery error: ' + err.message);
              pushError('Re-auth failed: ' + err.message + ' — run `mwinit --refresh-aea` in a terminal, then Sync.');
            }
          })();
        } else if (sessionRejected && !_reauthInFlight) {
          // FALLBACK (supervisor unavailable): the legacy hand-rolled ladder.
          _reauthInFlight = true;
          logger.warn('[data-source] API load failed — AAP session rejected; legacy recovery ladder: ' + e.message);
          try { send('auth:mwinit-status', { ok: false, reason: 'AAP session rejected — recovering' }); } catch (_) {}
          pushError('AAP session expired — refreshing enterprise-access (AEA)…');
          (async () => {
            try {
              const sup = _getAuthSupervisor();
              const r = sup ? await sup.ensureHealthyConverging({ reason: 'data-source-legacy', allowPrompt: true }) : null;
              const ok = !!(r && r.ok && r.verified);
              try { require('../scrapers/aap_api').dispose(); } catch (_) {}
              if (ok) { try { send('auth:mwinit-status', { ok: true }); } catch (_) {} _loadFleetViaApiStartup('post-reauth'); }
              else { pushError('AAP still rejecting the session. Run `mwinit --refresh-aea` (or `mwinit -f`) in a terminal, then click Sync.'); }
            } catch (err) {
              logger.error('[data-source] recovery error: ' + err.message);
              pushError('Re-auth failed: ' + err.message + ' — run `mwinit --refresh-aea` in a terminal, then Sync.');
            } finally {
              _reauthInFlight = false;
            }
          })();
        } else {
          logger.warn('[data-source] API load failed: ' + e.message);
          pushError('API load failed: ' + e.message);
        }
      } finally {
        // Release the single-flight guard. If other callers asked for a load
        // while this one was running, run exactly ONE trailing refresh now so
        // the latest data lands — without stacking the whole burst.
        _apiLoadInFlight = false;
        if (_apiLoadPendingReason) {
          const nextReason = _apiLoadPendingReason;
          _apiLoadPendingReason = null;
          logger.info('[data-source] running coalesced follow-up fleet load (' + nextReason + ')');
          setTimeout(() => { _loadFleetViaApiStartup(nextReason); }, 250);
        }
      }
    }

    // Background AI timeline build (Orcha deep-scan) + re-push. Non-blocking.
    // Guarded so only one runs at a time.
    //
    // The bulk fleet load uses withComments:false (fast), so down units have no
    // fullConversation yet. The AI timeline needs it — so FIRST hydrate each
    // down unit's conversation via the API (refreshUnit returns fullConversation
    // + _secondaryWRs' conversations, internal comments already excluded), THEN
    // hand the rows to runOrchaDeepScan which transforms them into the official
    // partner-facing timeline (exactly the scrape path's behavior).
    function _maybeRunDeepScanAsync(payload) {
      if (_deepScanRunning) return;
      // Don't re-run the full AI build more than once per 20 min — it's a heavy
      // per-unit hydrate + AI call. The 5-min API refresh keeps the table fresh;
      // the AI timeline doesn't need rebuilding that often.
      if (_lastDeepScanAt && (Date.now() - _lastDeepScanAt) < 20 * 60 * 1000) return;
      const rows = (payload && payload.rows) || [];
      const downRows = rows.filter((r) => /unavail/i.test(String(r.lifecycleState || '')) || /offsite/i.test(String(r.lifecycleReason || '')));
      if (!downRows.length) return;
      _deepScanRunning = true;
      _lastDeepScanAt = Date.now();
      logger.info('[data-source] AI timeline build: hydrating ' + downRows.length + ' down units\u2019 conversations, then Orcha deep-scan…');
      (async () => {
        try {
          const api = require('../scrapers/aap_api');
          // Hydrate the down units via getAsset (PM due dates) + their WO
          // conversations (bounded). PM is fetched even when the conversation is
          // already cached, so the pills fill in. Mutates the rows in `payload`.
          let hydrated = 0;
          for (const r of downRows) {
            try {
              // api.refreshUnit() returns the mapped row directly. It calls
              // getAsset(), which carries maintenanceScheduleStatuses — so this
              // is where the PM due-date pills get populated for the table
              // (the bulk asset search does NOT return that field).
              const fr = await api.refreshUnit(r.equipmentId);
              if (fr && fr.fullConversation) { r.fullConversation = fr.fullConversation; r._convFetchedAt = new Date().toISOString(); hydrated++; }
              if (fr && fr._secondaryWRs) r._secondaryWRs = fr._secondaryWRs;
              // PM due dates (raw + pills), offsite URL (Split View right pane),
              // and location — all from getAsset + the WO comment thread.
              if (fr) {
                for (const k of ['pmBDue', 'pmXDue', 'dotDue', 'quarterlyLiftDue', 'pmB', 'pmX', 'dot', 'quarterlyLift',
                                 'offsiteShopEventUrl', 'savedOffsiteUrl', 'offsiteShopEvent', 'asistSrUrl', 'asistLabel', 'asistSource', 'geofence']) {
                  if (fr[k] != null && fr[k] !== '' && fr[k] !== '--') r[k] = fr[k];
                }
                if (fr.vin && !r.vin) r.vin = fr.vin;
              }
            } catch (_) { /* skip this unit */ }
          }
          // Persist + push the hydrated rows NOW (PM pills + conversations) so the
          // saved fleetData + table reflect them even before the AI timeline
          // finishes. (The deep-scan below only pushData()s; it doesn't save.)
          try {
            payload.syncedAt = new Date().toISOString();
            store.save('fleetData', payload);
            if (ctx) ctx.lastData = payload;
            pushData(payload);
          } catch (_) {}
          logger.info('[data-source] AI timeline build: hydrated ' + hydrated + ' conversations + PM — running Orcha deep-scan');
          const { runOrchaDeepScan } = require('../orcha/deep-scan');
          await runOrchaDeepScan(rows, {
            pushData,
            pushStatus,
            payload,
            uptakeCount: (store.load('uptakeHash', {}).units || []).length,
            relayCount: 0,
          });
        } catch (e) {
          logger.warn('[data-source] deep-scan error (non-fatal): ' + e.message);
        } finally { _deepScanRunning = false; }
      })();
    }

    // Background PM + location fill for ALL units (throttled). getAsset per unit
    // — only the ones still missing PM — in small chunks with a pause between,
    // re-pushing so the table fills progressively. Runs once per load cycle,
    // throttled to once/hour (PM/location change slowly). Non-blocking.
    function _maybeFillPmAllAsync(payload) {
      if (_pmFillRunning) return;
      if (_lastPmFillAt && (Date.now() - _lastPmFillAt) < 60 * 60 * 1000) return;
      const rows = (payload && payload.rows) || [];
      // Units still lacking PM pills (down units were already filled by hydration).
      const todo = rows.filter((r) => r.equipmentId && !(r.pmBDue || r.dotDue || r.pmXDue || r.quarterlyLiftDue));
      if (!todo.length) return;
      _pmFillRunning = true;
      _lastPmFillAt = Date.now();
      logger.info('[data-source] PM/location fill: ' + todo.length + ' units to enrich (throttled background)');
      (async () => {
        try {
          const api = require('../scrapers/aap_api');
          const mapper = require('../scrapers/aap_api_mapper');
          const { parsePMDates } = require('../scrapers/relay');
          // Accumulate computed PM/geo fields by equipmentId. We apply them onto
          // the LIVE store (not a stale snapshot) at each save, so concurrent
          // background enrichers (Uptake re-merge, deep-scan) don't clobber each
          // other — each only overlays its own fields by equipmentId.
          const pmByUnit = {};   // equipmentId -> { pmBDue, pmB, ..., geofence }
          const _applyToStore = () => {
            try {
              const cur = store.load('fleetData', null);
              if (!cur || !Array.isArray(cur.rows)) return;
              for (const row of cur.rows) {
                const fields = pmByUnit[row.equipmentId];
                if (fields) Object.assign(row, fields);
              }
              cur.syncedAt = new Date().toISOString();
              store.save('fleetData', cur);
              if (ctx) ctx.lastData = cur;
              pushData(cur);
            } catch (_) {}
          };
          let done = 0;
          for (const r of todo) {
            try {
              const aaid = r.assetId || r.aaid;
              if (!aaid) continue;
              const full = await api.getAsset(aaid);
              if (full) {
                const pmRaw = mapper.pmDueFields(full);
                const _hasPm = pmRaw.pmBDue || pmRaw.pmXDue || pmRaw.dotDue || pmRaw.quarterlyLiftDue;
                const fields = {};
                if (_hasPm) {
                  for (const k of Object.keys(pmRaw)) { if (pmRaw[k]) fields[k] = pmRaw[k]; }
                  if (parsePMDates) { const pm = parsePMDates(pmRaw); fields.pmB = pm.pmB; fields.pmX = pm.pmX; fields.dot = pm.dot; fields.quarterlyLift = pm.quarterlyLift; }
                }
                const ll = (full.latestLocation) || (full.asset && full.asset.latestLocation) || {};
                const gf = (g) => (Array.isArray(g) && g.length) ? (g[0] && (g[0].name || g[0].geofenceName || g[0])) : '';
                const geo = gf(ll.geoFences) || ll.geofenceName || ll.yardBuildingID || '';
                if (geo) fields.geofence = geo;
                if (Object.keys(fields).length) { pmByUnit[r.equipmentId] = fields; done++; }
              }
            } catch (_) { /* skip */ }
            // Throttle: overlay onto the live store + push in chunks.
            if (done % 15 === 0 && done > 0) {
              _applyToStore();
              await new Promise((res) => setTimeout(res, 1500));
            }
          }
          _applyToStore();
          logger.info('[data-source] PM/location fill: enriched ' + done + ' units');
        } catch (e) { logger.warn('[data-source] PM/location fill failed: ' + e.message); }
        finally { _pmFillRunning = false; }
      })();
    }

    // Background Uptake refresh (via Uptake REST API) + re-push. Non-blocking.
    function _maybeRefreshUptakeAsync(ds) {
      try {
        const hash = store.load('uptakeHash', {});
        const ageMs = hash.scrapedAt ? (Date.now() - new Date(hash.scrapedAt).getTime()) : Infinity;
        const stale = !(Array.isArray(hash.units) && hash.units.length) || ageMs > 3600 * 1000;
        if (!stale || _uptakeRefreshing) return;
        _uptakeRefreshing = true;
        logger.info('[data-source] Uptake cache stale (' + (isFinite(ageMs) ? Math.round(ageMs / 60000) + 'min' : 'empty') + ') — background refresh via Uptake API');
        const { scrapeUptake, mergeUptakeIntoRows } = require('../scrapers/uptake');
        const { mergeRelayIntoRows } = require('../scrapers/relay');
        (async () => {
          try {
            const res = await scrapeUptake();
            if (res && Array.isArray(res.units) && res.units.length) {
              store.save('uptakeHash', {
                units: res.units, count: res.units.length,
                scrapedAt: res.scrapedAt || new Date().toISOString(),
              });
              logger.info('[data-source] Uptake API: ' + res.units.length + ' units refreshed + cached — re-merging');
              // Re-merge onto the CURRENT fleet rows and re-push so risk scores appear.
              const cur = store.load('fleetData', null);
              if (cur && Array.isArray(cur.rows)) {
                let rows2 = mergeUptakeIntoRows(cur.rows, res.units);
                try { rows2 = mergeRelayIntoRows(rows2, {}, store.load('notesStore', {})); } catch (_) {}
                const now2 = new Date().toISOString();
                const p2 = { rows: rows2, count: rows2.length, unavailableCount: cur.unavailableCount, scrapedAt: now2, syncedAt: now2, stale: false, source: 'aap-api' };
                store.save('fleetData', p2);
                if (ctx) ctx.lastData = p2;
                pushData(p2);
                logger.info('[data-source] Uptake re-merge pushed (' + rows2.length + ' units)');
              }
            }
          } catch (e) { logger.warn('[data-source] background Uptake refresh failed: ' + e.message); }
          finally { _uptakeRefreshing = false; }
        })();
      } catch (e) { _uptakeRefreshing = false; logger.warn('[data-source] Uptake refresh scheduling failed: ' + e.message); }
    }
    // Expose on ctx so toggle/IPC can trigger a refresh the same way.
    if (ctx) ctx._loadFleetViaApiStartup = _loadFleetViaApiStartup;

    function _showApp() {
      _appReady = true;
      // In API mode the fleet comes from the direct JSON API, not the chunked
      // scrape rescan — skip scheduling the scrape backfill/recurring rescan.
      if (_apiMode()) {
        logger.info('[data-source] API mode \u2014 scheduling recurring API refresh (no scrape rescan)');
        setInterval(() => { _loadFleetViaApiStartup('refresh'); }, RESCAN_INTERVAL_MS);
      } else {
      // Startup shows only the first 6 domiciles for a fast first paint; the
      // chunked rescan backfills the remaining domiciles. Run that FIRST backfill
      // almost immediately (~5s) instead of after 90s so all configured
      // domiciles appear within seconds of launch, not a minute and a half later.
      // The recurring rescan keeps its normal 5-min cadence, offset from the
      // initial backfill so they don't stack.
      setTimeout(() => { triggerLiveRescan(false); }, 5000);
      setTimeout(() => {
        setInterval(() => triggerLiveRescan(false), RESCAN_INTERVAL_MS);
      }, RESCAN_INTERVAL_MS);
      }
      logger.info('Switching to Fleet Operations app...');
      if (process.env.NODE_ENV === 'development') {
        mainWindow.loadURL('http://localhost:5173');
      } else {
        mainWindow.loadFile(path.join(ROOT_DIR,'renderer','src','index.html'));
      }
      mainWindow.setMinimumSize(1200, 700);
      mainWindow.setSize(1600, 960);
      mainWindow.center();
      mainWindow.setTitle('Fleet Operations');
      mainWindow.show();
      mainWindow.focus();
    }

    function switchToApp() {
      try {
        const store=require('../store');
        const cached=store.load('fleetData',null);
        if(cached&&cached.rows&&cached.rows.length>0){
          const cacheAge=Date.now()-(cached._ts||0);
          if(cacheAge<30*60*1000){
            logger.info('[switchToApp] Fast path: '+cached.rows.length+' rows, '+Math.round(cacheAge/60000)+'min old');
            _showApp(); return;
          }
        }
      }catch(e){}
      _showApp();
    }
    function _onMainWindowNav(url) {
      if (!url) url = mainWindow.webContents.getURL();
      logger.info('Main window loaded: ' + url.substring(0, 80));
      const onAAP = url.includes('aap-na.corp.amazon.com') && !url.includes('midway-auth');
      if (onAAP && !_startupScrapeStarted) {
        _startupScrapeStarted = true;
        // Fast path: fresh cache -> show app immediately, scrape updates live
        try {
          const _cs=require('../store');
          const _cd=_cs.load('fleetData',null);
          if(_cd&&_cd.rows&&_cd.rows.length>0&&(Date.now()-(_cd._ts||0))<30*60*1000){
            logger.info('[startup] Cache hit - showing app now, background scrape active');
            switchToApp();
          }
        }catch(e){}
        logger.info('[startup] AAP loaded \u2014 starting scrape loop');
        _runAAPScrapeLoop(mainWindow, {
          label: 'startup', maxPolls: 18,
          onComplete: (rows) => {
            // Sanity guard: don't let an empty/degraded startup scrape (auth
            // blip, AAP error page) overwrite good cached fleet data and blank
            // the table. Same <50% threshold as the rescan. If we already have
            // usable cached rows and this scrape came back drastically smaller,
            // keep the cache and just show the app.
            try {
              const _cs = require('../store');
              const _existing = _cs.load('fleetData', {});
              const _existingCount = (_existing.rows || []).length;
              if (rows.length === 0 || (_existingCount > 10 && rows.length < _existingCount * 0.5)) {
                logger.warn('Startup scrape: got ' + rows.length + ' rows but cache has ' + _existingCount +
                  ' \u2014 keeping cached data (likely auth/error page), not overwriting');
                switchToApp();
                return;
              }
            } catch (_) {}
            const payload = _saveAAPCaches(rows);
            logger.info('Startup scrape: saved ' + rows.length + ' units');
            pushData(payload);
            switchToApp();
          },
          onTimeout: () => {
            logger.warn('Startup scrape timed out \u2014 switching to app with cached data');
            switchToApp();
          },
        });
      }
    }

    mainWindow.webContents.on('did-finish-load',      ()        => _onMainWindowNav());
    mainWindow.webContents.on('did-navigate',         (_e, url) => _onMainWindowNav(url));
    mainWindow.webContents.on('did-navigate-in-page', (_e, url) => _onMainWindowNav(url));
    mainWindow.webContents.on('dom-ready',            ()        => _onMainWindowNav());

    // ── Auth poller: detects SSO redirect loop, auto-triggers mwinit ─────────
    // Polls current URL every 1s. If stuck on midway-auth for 10+ consecutive
    // seconds → cookies expired mid-session → spawns mwinit terminal automatically.
    // Uses the same checkMwinit() expiry detection as startup (no hardcoded hours).
    let _ssoCount      = 0;
    let _mwinitRunning = false;

    const _authPoller = setInterval(async () => {
      if (_startupScrapeStarted || !mainWindow || mainWindow.isDestroyed()) {
        clearInterval(_authPoller);
        return;
      }

      const url   = mainWindow.webContents.getURL();
      const isSSO = url.includes('midway-auth.amazon.com') || url.includes('/SSO/redirect');
      logger.info('[auth-poll] ' + url.substring(0, 80));

      // OFFLINE GATE (2026-10): if there's no internet, a page can look "stuck"
      // on an SSO URL purely because nothing can load — that is NOT an expired
      // session. Do not count toward the SSO-loop escalation while offline;
      // just wait. The reconnect watcher (auth.startOnlineReauthWatch) re-checks
      // the session when the internet returns. "Offline" = raw internet only
      // (net.isOnline); VPN state does not count.
      let _offline = false;
      try { _offline = require('../orcha/offline').isOffline(); } catch (_) {}

      if (isSSO && !_offline) {
        _ssoCount++;
        if (_ssoCount >= 10 && !_mwinitRunning) {
          _mwinitRunning = true;
          clearInterval(_authPoller);
          logger.warn('[auth-poll] SSO redirect loop detected');
          logger.warn('[auth-poll] SSO redirect loop \u2014 delegating to the ONE auth supervisor');
          pushStatus('\uD83D\uDD04 Resolving Midway session\u2026');
          try {
            // Delegate to the supervisor (spec #18): it runs the verified ladder
            // (silent AEA → mwinit --refresh-aea → AEA-agent self-heal →
            // interactive mwinit only if the session is truly dead), VERIFIES
            // against the real AAP target, and arms a bounded auto-retry on
            // failure. Replaces the hand-rolled silent-refresh + recoverAuth +
            // explicit-mwinit sequence that used to live here. Falls back to the
            // centralized recoverAuth ladder if the supervisor is unavailable.
            const supervisor = _getAuthSupervisor();
            let recovered = false, prompted = false, offline = false, stateReason = '';
            if (supervisor && typeof supervisor.ensureHealthyConverging === 'function') {
              const r = await supervisor.ensureHealthyConverging({ reason: 'auth-poll:sso-loop', allowPrompt: true, forceVerify: true });
              recovered = !!(r && r.ok && r.verified);
              prompted = !!(r && r.prompted);
              offline = !!(r && r.state === supervisor.STATE.OFFLINE);
              stateReason = (r && (r.reason || r.state)) || '';
            } else {
              const _auth = _getAuth();
              const res = _auth.recoverAuth ? await _auth.recoverAuth('auth-poll:sso-loop') : { recovered: false };
              recovered = !!(res && res.recovered); prompted = !!(res && res.prompted); offline = (res && res.rung === 'offline');
            }
            try { require('../scrapers/aap_api').dispose(); } catch (_) {}
            if (recovered) {
              logger.info('[auth-poll] supervisor recovered the SSO loop \u2014 reloading AAP');
              pushStatus(prompted ? '\u2705 Midway auth complete \u2014 reloading AAP...' : '\u2705 Session refreshed \u2014 reloading AAP...');
              _ssoCount = 0;
              mainWindow.loadURL(startUrl);
            } else if (offline) {
              pushStatus('\uD83D\uDCF6 Offline \u2014 will resume when the connection returns');
            } else {
              logger.warn('[auth-poll] supervisor did not recover (' + stateReason + ') \u2014 bounded auto-retry armed');
              pushStatus('\u26A0\uFE0F Midway session not verified \u2014 auto-retrying\u2026');
            }
          } catch (e) {
            logger.error('[auth-poll] recovery failed:', e.message);
            pushError('\u26A0\uFE0F ' + e.message);
          }
        }
      } else if (isSSO && _offline) {
        // On an SSO URL but offline — don't escalate and don't treat it as a
        // real navigation. Hold steady (don't reset _ssoCount upward) and wait
        // for connectivity to return.
        logger.info('[auth-poll] on SSO URL but offline — holding, no re-auth until online');
      } else {
        _ssoCount = 0;
        _onMainWindowNav(url);
      }
    }, 1000);

    mainWindow.webContents.on('before-input-event', (_event, input) => {
      // Ctrl+R (Cmd+R on mac) — RESTART THE WHOLE APP (main + renderer), the
      // same as a manual stop/start. Handled here in the main process so it
      // still works when the renderer is frozen. Force sync moved to
      // Ctrl+Shift+R (handled in the renderer's keyboard-shortcuts.js).
      // The close handler below always cancels close (hide-to-bubble), so
      // app.quit() would be blocked — run the before-quit cleanup (scheduler
      // stop, cluster lease release) explicitly, then relaunch + exit.
      if (input.type === 'keyDown' && !input.isAutoRepeat && (input.control || input.meta) &&
          !input.shift && !input.alt && String(input.key).toLowerCase() === 'r') {
        _event.preventDefault();
        logger.info('[shortcut] Ctrl+R \u2014 restarting app');
        try { pushStatus('\uD83D\uDD04 Restarting app...'); } catch (_) {}
        setTimeout(() => {
          try { app.emit('before-quit'); } catch (e) { logger.warn('[shortcut] before-quit cleanup failed: ' + e.message); }
          app.relaunch();
          app.exit(0);
        }, 300);
        return;
      }
      if (input.key === 'F12' && input.type === 'keyDown') {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
      // F5 — refresh the UI from the latest cached fleet data (instant, no scrape).
      // Re-pushes the freshest merged fleetData so every view (and the open unit
      // detail panel, via its fleet:data listener) re-renders with current data.
      // This is the fast fix for the propagation-lag cases where a unit's WR/
      // timeline resolved on a recent cycle but the on-screen view was rendered
      // before it landed. Shift+F5 forces a full re-sync (scrape) instead.
      if (input.key === 'F5' && input.type === 'keyDown') {
        try {
          if (input.shift) {
            logger.info('[shortcut] Shift+F5 — forcing full re-sync');
            pushStatus('\uD83D\uDD04 Refreshing (full sync)...');
            ipcMain.emit('aap:rescan', null, { force: true });
            if (runFullSync) { try { runFullSync(); } catch (_) {} }
          } else {
            const cached = store.load('fleetData', null);
            if (cached && cached.rows) {
              logger.info('[shortcut] F5 — re-pushing cached fleet data (' + cached.rows.length + ' rows)');
              pushData(cached);
              pushStatus('\u2705 Refreshed \u2014 ' + cached.rows.length + ' units');
            } else {
              logger.info('[shortcut] F5 — no cached data to refresh');
            }
          }
        } catch (e) {
          logger.warn('[shortcut] F5 refresh failed: ' + e.message);
        }
      }
    });

    mainWindow.on('close', e => {
      e.preventDefault();
      mainWindow.hide();
      try { showBubble(); } catch (err) { logger.error('showBubble on close:', err.message); }
    });

    mainWindow.on('minimize', () => {
      setTimeout(() => {
        try { showBubble(); } catch (err) { logger.error('showBubble on minimize:', err.message); }
      }, 300);
    });

    mainWindow.on('restore', () => { try { hideBubble(); } catch (_) {} });
    mainWindow.on('show',    () => { try { hideBubble(); } catch (_) {} });

    mainWindow.webContents.on('did-finish-load', () => {
      const url = mainWindow.webContents.getURL();
      // Start the scheduler-driven auto-sync once the Fleet UI (renderer) is
      // loaded. Match the dev server (localhost:5173) too, not just the packaged
      // index.html/file:// — otherwise the sync-interval timer never starts in
      // dev and the scheduler's Fleet Sync never fires on its own.
      if ((url.includes('index.html') || url.startsWith('file://') || url.includes('localhost:5173') || url.includes('dist/renderer')) && !_autoSyncStarted) {
        _autoSyncStarted = true;
        if (ctx.startAutoSync) ctx.startAutoSync(); else if (startAutoSync) startAutoSync();
      }
    });

    ipcMain.on('renderer:ready', (event) => {
      // BUBBLE MIRROR (2026-07-25): this handler used to be sender-unaware
      // (always targeted mainWindow + always forced a fresh AAP sync). Now
      // that the bubble window mounts the same renderer tree and also fires
      // window.fleet.signalReady() on load, treat it distinctly: just hand
      // it the cached snapshot directly, no forced resync (the mirror fix
      // to _send() in app.js already keeps it live going forward).
      const isMainWindow = mainWindow && event.sender === mainWindow.webContents;
      if (!isMainWindow) {
        const cached = store.load('fleetData', null);
        if (cached) event.sender.send('fleet:data', { ...cached, stale: true });
        return;
      }
      logger.info('renderer:ready \u2014 pushing cached data...');
      const cached = store.load('fleetData', null);
      if (cached) {
        pushData({ ...cached, stale: true });
        const age    = cached.syncedAt
          ? Math.round((Date.now() - new Date(cached.syncedAt).getTime()) / 60000) : null;
        const t      = cached.syncedAt
          ? new Date(cached.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '?';
        const ageStr = age !== null ? ' \u00B7 ' + (age < 1 ? '<1' : age) + 'min ago' : '';
        pushStatus('\uD83D\uDCE6 Cached data (' + cached.count + ' units, last sync ' + t + ageStr + ') \u2014 refreshing...');
      } else {
        pushStatus('\uD83D\uDD0C First launch \u2014 connecting to AAP...');
      }
      if (ctx.runFullSync) ctx.runFullSync();
    });

    // ── Live rescan: off-screen BrowserWindow every 5 min ────────────────────
    // RESCAN_INTERVAL_MS is declared at initWindows scope (hoisted) so _showApp
    // can read it synchronously at startup in API mode without a TDZ error.

    // The AAP dashboard hard-caps the domicile/search filter at 6 sites — pass
    // more and the page returns an EMPTY result set. To support fleets spread
    // across >6 domiciles we chunk the configured list into groups of <=6,
    // scrape each chunk in its own off-screen window, and merge the rows
    // (deduped by Equipment ID) into ONE fleet dataset. <=6 domiciles behaves
    // exactly as before (single scrape).
    const AAP_MAX_DOMICILES_PER_SCAN = 6;

    function _chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    }

    // Scrape ONE domicile chunk in a throwaway off-screen window. Resolves with
    // the mapped rows, or [] on timeout/failure (never rejects — callers decide
    // whether a partial/empty chunk should abort the whole rescan).
    async function _scrapeChunk(freshUrl, label) {
      // AUTH-AWARE RESCAN (fix for erratic ~2h re-auth churn): the background
      // rescan window shares session.defaultSession but used to loadURL(AAP)
      // with NO cookie re-injection -- so once AAP invalidated the session
      // server-side (AEA token lapse), this window silently landed on the
      // Midway login page, scraped 0 rows for ~90s, and repeated every 5min
      // without ever self-healing. Recovery only happened when the MAIN window
      // happened to drift to SSO and its auth-poller fired mwinit -- hence the
      // erratic timing. Fix part 1: re-inject the freshest cookies before every
      // chunk load (same pattern relay:open-url / uptake:open-url already use),
      // so the AEA the app holds is pushed in before AAP can reject it.
      try { await _getAuth().injectCookies(); }
      catch (e) { logger.warn('[' + label + '] pre-scrape cookie inject skipped: ' + e.message); }

      return new Promise((resolve) => {
        let settled = false;
        const finish = (rows) => { if (settled) return; settled = true; resolve(rows || []); };

        const scrapeWin = new BrowserWindow({
          width: 1400, height: 800,
          show: true, x: -3000, y: -3000, skipTaskbar: true,
          webPreferences: {
            nodeIntegration:  false,
            contextIsolation: true,
            session:          session.defaultSession,
          },
        });

        // Fix part 2: detect an SSO/login landing and bail immediately instead
        // of wasting the full ~90s poll budget on a bounced session. If the
        // rescan window ends up on midway-auth.amazon.com, the session is dead
        // server-side; abandon this chunk fast and flag it so the main-window
        // auth-poller path re-auths promptly rather than after minutes of
        // 0-row scans.
        const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');
        const _bailIfSSO = () => {
          let u = '';
          try { u = scrapeWin.webContents.getURL(); } catch (_) {}
          if (_isSSO(u)) {
            logger.warn('[' + label + '] rescan landed on Midway SSO -- session invalid; bailing fast (will re-auth)');
            _rescanHitSSO = true;
            clearTimeout(timeout);
            try { scrapeWin.destroy(); } catch (_) {}
            finish([]);
            return true;
          }
          return false;
        };

        // Safety-net timeout only. _runAAPScrapeLoop has its OWN budget
        // (maxPolls 18 x 5s poll = 90s) AND then does a force-1000 click +
        // ~8s settle + table extract + WR-URL build AFTER it finds rows. So a
        // healthy-but-slow scrape can legitimately run ~100s+. The old 90s
        // outer timeout raced that finalization and killed chunks that had
        // ALREADY found rows (observed: chunk found 150 rows at poll 12, then
        // got destroyed mid-extract and returned 0). Set the net well beyond
        // the loop's real worst case so it only fires on a truly hung window.
        const timeout = setTimeout(() => {
          logger.warn('[' + label + '] chunk safety-net timeout (150s) — window hung');
          try { scrapeWin.destroy(); } catch (_) {}
          finish([]);
        }, 150000);

        scrapeWin.webContents.once('did-finish-load', () => {
          if (_bailIfSSO()) return; // dead session -> don't burn 90s polling a login page
          _runAAPScrapeLoop(scrapeWin, {
            label, maxPolls: 18,
            onComplete: (rows) => {
              clearTimeout(timeout);
              try { scrapeWin.destroy(); } catch (_) {}
              finish(rows);
            },
            onTimeout: () => {
              _bailIfSSO(); // note SSO if that's why we got 0 rows
              clearTimeout(timeout);
              try { scrapeWin.destroy(); } catch (_) {}
              finish([]);
            },
          });
        });

        scrapeWin.loadURL(freshUrl);
      });
    }

    async function triggerLiveRescan(force) {
      // In API mode the scrape is disabled entirely — redirect any rescan
      // request (timer, F5, aap:rescan IPC) to an API refresh instead so the
      // AAP BrowserWindow never opens and can't bounce into AEA/SSO.
      if (_apiMode()) {
        logger.info('[data-source] API mode \u2014 rescan request redirected to API refresh');
        if (ctx && ctx._loadFleetViaApiStartup) { try { await ctx._loadFleetViaApiStartup('rescan'); } catch (_) {} }
        return;
      }
      if (!_appReady)         { logger.info('Rescan skipped \u2014 app not ready'); return; }
      if (_rescanInProgress)  { logger.info('Rescan already in progress'); return; }
      // Skip the TIMER-driven rescan while a Long Dwell AI Fill is running -- a
      // rescan pushes a fleet:data REPLACE that momentarily zeros the grid
      // mid-fill. A user-FORCED rescan (force=true) still runs.
      if (!force && ctx && ctx.aiFillActive) { logger.info('Rescan skipped \u2014 AI fill in progress'); return; }
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const domiciles = getDomiciles();
      const chunks = _chunk(domiciles, AAP_MAX_DOMICILES_PER_SCAN);
      const multi = chunks.length > 1;
      logger.info('Rescan' + (force ? ' (forced)' : ' (timer)') +
        ': ' + domiciles.length + ' domiciles in ' + chunks.length + ' chunk(s)');

      _rescanInProgress = true;
      _rescanHitSSO = false; // reset per rescan; a chunk sets it if it lands on SSO
      try {
        // Scrape each chunk sequentially (running several visible scrape windows
        // in parallel fights over the shared Midway session and CPU). Accumulate
        // rows deduped by Equipment ID — first chunk wins on collision.
        const seen = new Set();
        const allRows = [];
        let anyChunkFailed = false;

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const label = multi ? ('rescan#' + (i + 1) + '/' + chunks.length) : 'rescan';
          const url = buildScanURL(chunk);
          if (multi) {
            pushStatus('\uD83D\uDD04 Rescan ' + (i + 1) + '/' + chunks.length +
              ' \u2014 ' + chunk.join(', ') + '...');
          }
          logger.info('[' + label + '] ' + chunk.join(', ') + ' \u2014 ' + url.substring(0, 70));
          const rows = await _scrapeChunk(url, label);
          if (!rows.length) {
            anyChunkFailed = true;
            logger.warn('[' + label + '] returned 0 rows');
          }
          for (const r of rows) {
            const id = r.equipmentId;
            if (id && !seen.has(id)) { seen.add(id); allRows.push(r); }
          }
          logger.info('[' + label + '] +' + rows.length + ' rows (running total: ' + allRows.length + ')');
        }

        const store = require('../store');
        const existing = store.load('fleetData', {});
        const existingCount = (existing.rows || []).length;

        if (allRows.length === 0) {
          logger.warn('Rescan: 0 combined rows \u2014 nothing to save');
          return;
        }

        // Partial-failure recovery (multi-chunk only): if SOME chunks succeeded
        // but at least one returned 0 rows, don't discard the good chunks just
        // because the combined total dipped under the 50% guard. Instead merge
        // the fresh rows OVER the existing dataset (fresh units update, units
        // from the failed chunk keep their last-known-good values). This avoids
        // a single flaky chunk throwing away the other chunks' fresh data.
        if (multi && anyChunkFailed && existingCount > 10) {
          const byId = new Map((existing.rows || []).map(r => [r.equipmentId, r]));
          for (const r of allRows) if (r.equipmentId) byId.set(r.equipmentId, r);
          const merged = Array.from(byId.values());
          const payload = _saveAAPCaches(merged);
          logger.warn('Rescan: ' + allRows.length + ' fresh rows from surviving chunk(s) merged over '
            + existingCount + ' existing \u2014 ' + merged.length + ' total (a chunk returned 0; kept prior data for it)');
          pushData(payload);
          return;
        }

        // Sanity guard: a drastically-shrunken FULL result means a bad page state
        // (auth blip, AAP error page) rather than real fleet shrinkage. Discard to
        // avoid wiping the table with garbage. Threshold: <50% of current rows,
        // compared against the COMBINED total so a legitimately-partial (but
        // complete) chunk set doesn't trip it.
        if (existingCount > 10 && allRows.length < existingCount * 0.5) {
          logger.warn('Rescan: got ' + allRows.length + ' combined rows but have ' +
            existingCount + ' \u2014 discarding bad scrape (likely AAP error page)');
          return;
        }

        const payload = _saveAAPCaches(allRows);
        logger.info('Rescan complete: ' + allRows.length + ' units saved' +
          (multi ? (' from ' + chunks.length + ' chunks' + (anyChunkFailed ? ' (some chunks empty)' : '')) : ''));
        pushData(payload);
      } catch (e) {
        logger.warn('Rescan failed:', e.message);
      } finally {
        _rescanInProgress = false;
      }

      // If any chunk landed on Midway SSO, the AAP session is dead server-side
      // (AEA token lapsed) even if the 20h cookie is still valid. Recovery is
      // NOT a rescan decision — it belongs to the ONE auth supervisor (spec
      // #5/#13). Rescan does not re-inject cookies, inspect AEA freshness, or
      // run mwinit itself; it just hands auth ownership to the supervisor, which
      // runs the verified ladder, VERIFIES against the real AAP target, and arms
      // bounded auto-retry so the next rescan isn't another bounced 0-row cycle.
      if (_rescanHitSSO) {
        _rescanHitSSO = false;
        const supervisor = _getAuthSupervisor();
        if (supervisor && typeof supervisor.ensureHealthyConverging === 'function') {
          try {
            logger.warn('[rescan] landed on SSO -- delegating recovery to auth supervisor (single owner)');
            const r = await supervisor.ensureHealthyConverging({ reason: 'rescan:sso', allowPrompt: true, forceVerify: true });
            if (r && r.ok && r.verified) {
              logger.info('[rescan] supervisor recovered + verified against AAP -- next rescan should succeed');
            } else if (r && r.state === supervisor.STATE.WAITING_FOR_USER) {
              pushStatus('\uD83D\uDD11 Session expired \u2014 complete Midway auth in the terminal window...');
            } else {
              logger.warn('[rescan] supervisor did not verify (' + ((r && r.reason) || 'unknown') + ') -- bounded auto-retry armed');
            }
          } catch (e) {
            logger.warn('[rescan] supervisor recovery error: ' + e.message);
          }
        } else {
          logger.warn('[rescan] auth supervisor unavailable -- skipping proactive recovery (next rescan will re-detect)');
        }
      }
    }

    ipcMain.on('aap:rescan', (_e, opts) => triggerLiveRescan(!!(opts && opts.force)));
  }

  // ── System tray ───────────────────────────────────────────────────────────
  function createTray() {
    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('Fleet Operations \u00B7 Loading...');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Fleet Operations', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: 'Sync Now',              click: () => { if (ctx.runFullSync) ctx.runFullSync(); } },
      { type: 'separator' },
      { label: '\u2699 Setup AAP Columns', click: () => openAAPSetupWindow() },
      { type: 'separator' },
      { label: 'Open Data Folder', click: () => shell.showItemInFolder(P.fleetData) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.exit(0) },
    ]));
    tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });

    // Animated tray icon — 12-frame pulse at ~8fps
    const trayDir = path.join(ROOT_DIR, 'assets', 'tray');
    const frames  = [];
    for (let i = 0; i < 12; i++) {
      const fp = path.join(trayDir, 'frame_' + String(i).padStart(2, '0') + '.png');
      frames.push(fs.existsSync(fp) ? nativeImage.createFromPath(fp) : icon);
    }
    let frameIdx = 0;
    setInterval(() => {
      frameIdx = (frameIdx + 1) % 12;
      try { tray.setImage(frames[frameIdx]); } catch (_) {}
    }, 120);
  }

  // ── AAP Column Setup window ───────────────────────────────────────────────
  function openAAPSetupWindow() {
    const { buildScanURL } = _getAap();
    const setupWin = new BrowserWindow({
      width: 1400, height: 900,
      title: 'AAP Column Setup \u2014 configure columns, then close this window',
      icon: getAppIconPath(),
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        partition:        '',
      },
    });

    // Cap at 6 domiciles — AAP returns an empty page past that, and this window
    // only needs the table to render so the user can add/remove columns.
    setupWin.loadURL(buildScanURL(getDomiciles().slice(0, 6)));

    setupWin.webContents.on('did-finish-load', () => {
      setupWin.webContents.executeJavaScript(`
        setTimeout(function() {
          var b = document.createElement('div');
          b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
            'background:#f0a800;color:#000;font-weight:bold;font-size:14px;padding:10px 16px;text-align:center;';
          b.textContent = '\u2699 SETUP MODE: Add the columns you want (Domicile site, Manufacturer, etc.),' +
            ' then CLOSE this window. Settings are saved automatically.';
          document.body.prepend(b);
        }, 2000);
      `).catch(() => {});
    });

    setupWin.on('closed', () => {
      logger.info('AAP setup window closed \u2014 column prefs saved to session');
      setTimeout(() => { if (ctx.runFullSync) ctx.runFullSync(); }, 1000);
    });
  }

  // ── Setup wizard (first launch) ───────────────────────────────────────────
  function showSetupWizard() {
    const wizardHtml = path.join(ROOT_DIR, 'renderer', 'src', 'setup', 'index.html');
    // BUG FIX (2026-07-22): the wizard used to collect all its data (name,
    // domiciles, Orcha config, etc.) into a single object and hand it to a
    // 'wizard:complete' IPC event here -- but nothing ever sent that
    // event (confirmed dead code via a full-codebase search), so every
    // field the user filled in was silently discarded and the app booted
    // on defaults every time. The wizard renderer now saves each step
    // directly through the exact same bridge calls Settings uses
    // (window.settings / window.slack / window.email / etc. -- all
    // already exposed via this same preload.js), so there is no longer a
    // second, separate "apply everything" step to go stale/dead. This
    // window only needs to exist, load, and close when told to.
    // Enlarged + made resizable: the wizard now has real functional
    // sections (vendor credentials, SharePoint discovery, etc.) that
    // didn't exist when 620x580 fixed was chosen, and there was
    // previously zero CSS anywhere for any '.setup-*' class (confirmed --
    // 0 matches in fleet.css), so nothing ever needed to fit/scroll
    // before. See fleet.css '#setup-app' block for the new styling.
    wizWin = new BrowserWindow({
      width: 720, height: 720,
      minWidth: 640, minHeight: 560,
      icon: getAppIconPath(),
      frame: false, resizable: true, center: true, show: false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    wizWin.loadFile(wizardHtml);
    wizWin.once('ready-to-show', () => wizWin.show());
    wizWin.on('closed', () => { wizWin = null; });
  }

  // ── Window IPC handlers ───────────────────────────────────────────────────
  ipcMain.on('fleet:request-sync', () => {
    if (_rescanInProgress) { logger.info('request-sync skipped \u2014 rescan in progress'); return; }
    if (ctx.runFullSync) ctx.runFullSync();
  });

  ipcMain.on('win:minimize', () => {
    if (!mainWindow) return;
    mainWindow.minimize();
    // FIX (minimize-FAB): on a frameless (frame:false) window, programmatic
    // mainWindow.minimize() does NOT reliably emit the 'minimize' event on
    // Windows — so the on('minimize') handler that shows the desktop bubble
    // never ran, and the FAB didn't appear. Show the bubble directly from the
    // IPC that we KNOW fired (the custom titlebar minimize button). Guarded so
    // it's a no-op if the event path DID fire (showBubble early-returns when a
    // live bubbleWin already exists).
    setTimeout(() => { try { showBubble(); } catch (err) { logger.error('showBubble on win:minimize: ' + err.message); } }, 300);
  });
  ipcMain.on('win:maximize', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
  ipcMain.on('win:close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.on('win:show',  () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
  // Lets the renderer sync the maximize/restore icon on first paint,
  // before the first 'maximize'/'unmaximize' event has fired.
  ipcMain.handle('win:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));


  ipcMain.on('app:quit', () => app.exit(0));

  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.on('bubble:clicked', () => {
    hideBubble();
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  ipcMain.on('bubble:reposition', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      // BUBBLE MIRROR (2026-07-24): expanded panel is now ~400x580 (real
      // .orcha-panel is 360x480 positioned bottom:84px/right:24px -- see
      // renderer/src/css/fleet.css) instead of the old bubble.html's
      // 340x500, so leave a bit more margin.
      bubbleWin.setPosition(width - 410, height - 590);
    }
  });

  ipcMain.on('bubble:reposition-mini', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      bubbleWin.setPosition(width - 70, height - 70);
    }
  });

  ipcMain.on('bubble:resize', (_e, w, h) => {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.setSize(w, h);
      // WINDOWS TRANSPARENCY FIX (2026-07-25): on Windows, a runtime
      // setSize() on a frameless transparent BrowserWindow can drop DWM's
      // transparency compositing and paint an opaque fallback color
      // instead. Re-assert it after every resize (expand AND collapse).
      bubbleWin.setBackgroundColor('#00000000');
    }
    // CHAT HEAD (2026-07-24): the FAB panel opening/closing is what drives
    // these resize calls (56x56 mini <-> ~400x580 expanded -- see
    // _togglePanel() in orcha-fab.js), so reuse it as the signal for
    // "user is looking at it" / "user is done with it" instead of adding a
    // separate IPC channel.
    if (w > 56) {
      if (_bubbleAutoHideTimer) { clearTimeout(_bubbleAutoHideTimer); _bubbleAutoHideTimer = null; }
    } else if (_bubbleIsTemporary) {
      _bubbleIsTemporary = false;
      hideBubble();
    }
  });

  ipcMain.on('bubble:hide', () => { hideBubble(); });

  // CHAT FLOATER TRANSPARENCY (2026-07-25): user-controlled opacity for the
  // desktop bubble's expanded panel (Settings -> UI -> Transparency). Persists
  // across restarts via the store; pushed live to the bubble if it's open.
  ipcMain.handle('bubble:get-opacity', () => {
    const cfg = store.load('bubbleConfig', { opacity: 100 });
    return cfg.opacity;
  });

  ipcMain.on('bubble:set-opacity', (_e, opacity) => {
    const clamped = Math.max(40, Math.min(100, Number(opacity) || 100));
    const cfg = store.load('bubbleConfig', {});
    cfg.opacity = clamped;
    store.save('bubbleConfig', cfg);
    if (bubbleWin && !bubbleWin.isDestroyed())
      bubbleWin.webContents.send('bubble:opacity-changed', clamped);
  });

  ipcMain.on('bubble:open-unit', (_e, unitId) => {
    hideBubble();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('navigate:unit', unitId);
    }
  });

  ipcMain.handle('uptake:open-url', async (_e, url) => {
    // Re-inject Midway cookies so AEA passes on first load
    try { await _getAuth().injectCookies(); } catch(e) { logger.warn('[uptake:open-url] Cookie inject skipped:', e.message); }
    if (!url || !/^https?:\/\//i.test(url)) return;
    const win = new BrowserWindow({
      width: 1400, height: 900, title: 'Uptake',
      icon: getAppIconPath(),
      backgroundColor: '#0d1117', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });
    win.loadURL(url);
    win.once('ready-to-show', () => win.show());
  });

  ipcMain.handle('relay:open-url', async (_e, url) => {
    // Re-inject Midway cookies so AEA passes on first load
    try { await _getAuth().injectCookies(); } catch(e) { logger.warn('[relay:open-url] Cookie inject skipped:', e.message); }
    if (!url || !/^https?:\/\//i.test(url)) return;

    // Use vendor-specific partition if available (preserves login session per vendor)
    const partition = partitionForUrl(url) || '';
    const ses = partition ? session.fromPartition(partition) : session.defaultSession;

    const win = new BrowserWindow({
      width: 1400, height: 900, title: 'Fleet Ops \u2013 Vendor Portal',
      icon: getAppIconPath(),
      backgroundColor: '#0d1117', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
    });

    // Attach auto-login: if the page redirects to a login page, fill credentials automatically
    attachAutoLogin(win, url, {
      maxRetries: 3,
      onDone: (result) => {
        if (result.success) {
          logger.info('[relay:open-url] Auto-login succeeded for', url.slice(0, 80));
        } else {
          logger.warn('[relay:open-url] Auto-login failed:', result.error || 'unknown', '| url:', url.slice(0, 80));
        }
      }
    });

    win.loadURL(url);
    win.once('ready-to-show', () => win.show());
  });

  ipcMain.on('fleet:trigger-email', (_e, opts) => {
    send('fleet:auto-email', {
      slot: 'manual', triggeredAt: new Date().toISOString(), ...(opts || {}),
    });
  });

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    createMainWindow,
    createTray,
    openAAPSetupWindow,
    showSetupWizard,
    closeSetupWizard: () => { if (wizWin && !wizWin.isDestroyed()) wizWin.close(); },
    showBubble,
    hideBubble,
    getBubbleWin:  () => bubbleWin,
    getMainWindow: () => mainWindow,
    getTray:       () => tray,
    pushBubbleNotification,
    isSetupComplete,
    triggerRescan: (force) => ipcMain.emit('aap:rescan', null, { force: !!force }),
  };
}

module.exports = { initWindows };
