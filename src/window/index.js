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
    if (_fs.existsSync(P.relayCache)) {
      const relayData = JSON.parse(_fs.readFileSync(P.relayCache, 'utf8'));
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
  let _appReady         = false;

  // Lazy-load scrapers to avoid circular require at module load
  function _getAap()  { return require('../scrapers/aap'); }
  function _getAuth() { return require('../scrapers/auth'); }

  function getDomiciles() {
    const settings = store.load('settings', {});
    return (settings.domiciles && settings.domiciles.length)
      ? settings.domiciles
      : require('../config/defaults').DEFAULT_DOMICILES;
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
  async function _runAAPScrapeLoop(win, { label, maxPolls = 45, onComplete, onTimeout }) {
    let done  = false;
    let polls = 0;

    // Configure columns before polling starts
    if (label === 'startup' || label === 'rescan') {
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
    }, 2000);
  }

  // ── Main window ───────────────────────────────────────────────────────────
  function createMainWindow() {
    const { buildScanURL } = _getAap();

    mainWindow = new BrowserWindow({
      width: 900, height: 700,
      minWidth: 600, minHeight: 500,
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
    const startUrl        = buildScanURL(scrapeDomiciles);
    logger.info('Loading AAP in main window: ' + startUrl.substring(0, 80));

    // ── Midway pre-flight: check actual cookie expiry, run mwinit if needed ──
    // Reads ~/.midway/cookie expiry timestamps — no hardcoded hour thresholds.
    // Spawns a visible cmd.exe terminal automatically when any cookie is expired.
    (async function _midwayPreFlight() {
      const { checkMwinit, runMwinit, injectCookies } = _getAuth();
      const state = checkMwinit();

      if (!state.ok) {
        logger.warn('[startup] ' + state.reason + ' \u2014 launching mwinit terminal');
        pushStatus('\uD83D\uDD11 Midway session expired \u2014 complete auth in the terminal window...');
        try {
          await runMwinit();
          await injectCookies();
          // Verify the session actually works after standard mwinit
          const { probeSession } = _getAuth();
          const startupPageOk = await probeSession();
          if (!startupPageOk) {
            logger.warn('[startup] probeSession failed after standard mwinit -- retrying with mwinit -f');
            pushStatus('\uD83D\uDD04 Session still rejected -- retrying with mwinit -f (tap WebAuthn again)...');
            await runMwinit(true);
            await injectCookies();
          }
          logger.info('[startup] mwinit complete \u2014 loading AAP');
          pushStatus('\u2705 Midway auth complete \u2014 loading AAP...');
        } catch (e) {
          logger.error('[startup] mwinit failed:', e.message);
          pushError('\u26A0\uFE0F mwinit failed: ' + e.message + ' \u2014 try running mwinit -f in a terminal');
        }
      } else {
        logger.info('[startup] Cookies valid (' + state.count + ' cookies, expires in ' +
          (state.expiresInMin !== null ? state.expiresInMin + 'min' : 'session') + ')');
        // Push session status to renderer immediately so the auth badge is green on startup
        send('auth:mwinit-status', { ok: true, expiresInMin: state.expiresInMin });
      }

      // Keep window invisible during AAP scrape
      mainWindow.setPosition(-3000, -3000);
      // Window hidden during scrape via position
      // Auto-login: detect login pages and fill credentials

      mainWindow.loadURL(startUrl);
    })();

    function _showApp() {
      _appReady = true;
      setTimeout(() => {
        triggerLiveRescan(false);
        setInterval(() => triggerLiveRescan(false), RESCAN_INTERVAL_MS);
      }, 90000);
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
    let _startupScrapeStarted = false;

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
          label: 'startup', maxPolls: 45,
          onComplete: (rows) => {
            const payload = _saveAAPCaches(rows);
            logger.info('Startup scrape: saved ' + rows.length + ' units');
            pushData(payload);
            switchToApp();
          },
          onTimeout: () => {
            logger.warn('Startup scrape timed out \u2014 switching to app with empty cache');
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

      if (isSSO) {
        _ssoCount++;
        if (_ssoCount >= 10 && !_mwinitRunning) {
          _mwinitRunning = true;
          clearInterval(_authPoller);
          logger.warn('[auth-poll] SSO redirect loop \u2014 launching mwinit terminal');
          pushStatus('\uD83D\uDD11 Session expired \u2014 complete Midway auth in the terminal window...');
          try {
            // FIX (2026-07-21): this recovery path was calling runMwinit() +
            // injectCookies() directly, then doing a raw mainWindow.loadURL()
            // with NO verification and NO retry -- a materially weaker flow
            // than src/scrapers/auth.js's ensureAuthenticated(), which does
            // inject -> verify via a real probe-window navigation -> verify
            // via a relay-endpoint ping -> automatically retry injection once
            // if the relay check fails. Confirmed via logs/auth.log:
            // 2026-07-20 (working) sessions all logged the full "nav:" /
            // "Probe landed:" / "Relay landed:" / "Session confirmed"
            // sequence; 2026-07-21 (broken) attempts never did, because this
            // path never called it. Injecting cookies successfully is
            // necessary but not sufficient for AAP to actually accept the
            // session -- only the probe/relay checks prove that.
            //
            // NOT delegating to ensureAuthenticated() wholesale: its own
            // internal mwinit auto-spawn is deliberately disabled
            // (`if (false /* DISABLED: mwinit auto-spawn causes boot loops */)`)
            // per a prior fix, so calling it alone would silently skip
            // spawning mwinit here. Keeping the explicit runMwinit() call
            // below and adding the same probeSession()/pingRelayEndpoint()
            // verification+retry ensureAuthenticated() does, without its
            // disabled auto-spawn branch.
            const { runMwinit, injectCookies, probeSession, pingRelayEndpoint } = _getAuth();

            // ATTEMPT 1: standard mwinit
            await runMwinit();
            await injectCookies();

            let pageOk = await probeSession();
            if (!pageOk) {
              // ATTEMPT 2: force mwinit (-f) clears stale server-side session.
              // Fixes the "AAP rejected session" startup blocker that required
              // manual mwinit -f + restart. Now happens automatically.
              logger.warn('[auth-poll] probeSession failed after standard mwinit -- retrying with mwinit -f');
              pushStatus('\uD83D\uDD04 Session still rejected -- retrying with mwinit -f (tap WebAuthn again)...');
              await runMwinit(true);
              await injectCookies();
              pageOk = await probeSession();
            }
            if (!pageOk) throw new Error('AAP rejected session after mwinit -f -- check VPN/network and restart');

            let relayOk = await pingRelayEndpoint();
            if (!relayOk) {
              logger.warn('[auth-poll] Relay check failed -- re-injecting and retrying');
              await injectCookies();
              relayOk = await pingRelayEndpoint();
            }
            if (!relayOk) throw new Error('AAP relay rejected session -- try restarting the app');

            logger.info('[auth-poll] session verified (page + relay probes passed) \u2014 reloading AAP');
            pushStatus('\u2705 Midway auth complete \u2014 reloading AAP...');
            mainWindow.loadURL(startUrl);
          } catch (e) {
            logger.error('[auth-poll] mwinit/verification failed:', e.message);
            pushError('\u26A0\uFE0F ' + e.message);
          }
        }
      } else {
        _ssoCount = 0;
        _onMainWindowNav(url);
      }
    }, 1000);

    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
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
      if (url.includes('index.html') || url.startsWith('file://')) {
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
    const RESCAN_INTERVAL_MS = 5 * 60 * 1000;

    function triggerLiveRescan(force) {
      if (!_appReady)         { logger.info('Rescan skipped \u2014 app not ready'); return; }
      if (_rescanInProgress)  { logger.info('Rescan already in progress'); return; }
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const freshUrl = buildScanURL(getDomiciles());
      logger.info('Rescan' + (force ? ' (forced)' : ' (timer)') + ': ' + freshUrl.substring(0, 60));

      _rescanInProgress = true;
      const scrapeWin = new BrowserWindow({
        width: 1400, height: 800,
        show: true, x: -3000, y: -3000, skipTaskbar: true,
        webPreferences: {
          nodeIntegration:  false,
          contextIsolation: true,
          session:          session.defaultSession,
        },
      });

      const timeout = setTimeout(() => {
        logger.warn('Rescan timed out (90s)');
        _rescanInProgress = false;
        try { scrapeWin.destroy(); } catch (_) {}
      }, 90000);

      scrapeWin.webContents.once('did-finish-load', () => {
        _runAAPScrapeLoop(scrapeWin, {
          label: 'rescan', maxPolls: 40,
          onComplete: (rows) => {
            const payload = _saveAAPCaches(rows);
            logger.info('Rescan complete: ' + rows.length + ' units saved');
            pushData(payload);
            clearTimeout(timeout);
            _rescanInProgress = false;
            try { scrapeWin.destroy(); } catch (_) {}
          },
          onTimeout: () => {
            logger.warn('Rescan: no rows within poll limit');
            clearTimeout(timeout);
            _rescanInProgress = false;
            try { scrapeWin.destroy(); } catch (_) {}
          },
        });
      });

      scrapeWin.loadURL(freshUrl);
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

    setupWin.loadURL(buildScanURL(getDomiciles()));

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

  ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
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
    const win = new BrowserWindow({
      width: 1400, height: 900, title: 'AAP Relay \u2013 Service Request',
      icon: getAppIconPath(),
      backgroundColor: '#0d1117', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
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
