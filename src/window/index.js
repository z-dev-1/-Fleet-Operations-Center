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
 * Differences from V-B window.js:
 *   - store.load/save replaces inline fs + app.getPath('userData') calls
 *   - P.* used for renderer, preload, assets, bubble HTML paths
 *   - setup/state.js isSetupComplete() replaces raw setupDoneFile existsSync check
 *   - DATA_FILE reference in tray fixed (was undefined in V-B scope) — now P.fleetData
 *   - logger replaces console.log throughout
 *   - ROOT_DIR derived from __dirname (src/window → ../../ = project root)
 *   - showBubble/hideBubble exported so app-shell / sync can call them
 *   - getBubbleWin() exported for sync engine ctx
 *
 * ctx provided by app.js must expose:
 *   pushData, pushStatus, pushError, send
 *   startAutoSync, runFullSync
 *   showBubble, hideBubble  (passed back in return value — app.js binds them)
 */

const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  nativeImage, shell, screen, session, Notification,
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const logger = require('../utils/logger')('window');
const { P }  = require('../config/paths');
const store  = require('../store');
const { isSetupComplete } = require('../../setup/state');

// Project root: src/window/ -> src/ -> root
const ROOT_DIR = path.join(__dirname, '..', '..');

// ── Field map for AAP table column → camelCase property ─────────────────────
const AAP_FIELD_MAP = {
  'Equipment ID':               'equipmentId',
  'Asset type':                 'assetType',
  'Lifecycle state':            'lifecycleState',
  'Lifecycle state reason':     'lifecycleReason',
  'Operator':                   'operator',
  'Manufacturer':               'manufacturer',
  'Body type':                  'bodyType',
  'Due date':                   'dueDate',
  'Engine manufacturer':        'engineManufacturer',
  'Domicile site':              'domicileSite',
  'Fuel type':                  'fuelType',
  'Open Unplanned Work Requests': 'openUnplanned',
  'Open Planned Work Requests': 'openPlanned',
  'Last geofences':             'geofence',
  'Lat/Long':                   'latLong',
};

// JS snippet injected into AAP pages — forces "Results per page" to 1000.
// Kept as a named constant so it isn't duplicated between startup scrape
// and live rescan.
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
      if (all[i].childNodes.length === 1 &&
          (all[i].textContent||'').trim() === 'Results per page') {
        var parent = all[i].parentElement;
        rpp = parent.querySelector(
          'button,select,[role="button"],[role="combobox"],[role="listbox"]'
        );
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
  if (!t) return { rows:[], count:0, debug:'no_table_with_rows' };
  var h = [];
  t.querySelectorAll('thead th').forEach(function(x){
    h.push((x.innerText||'').trim().replace(/[\\n\\r]+/g,' '));
  });
  var r = [];
  t.querySelectorAll('tbody tr').forEach(function(tr){
    var c = tr.querySelectorAll('td');
    if (c.length < 3) return;
    var o = {};
    for (var i = 0; i < c.length; i++) o[h[i]||'c'+i] = (c[i].innerText||'').trim();
    if (o['Equipment ID'] || o[h[1]]) r.push(o);
  });
  return { rows:r, count:r.length, headers:h,
    debug:'table class='+t.className+' trs='+t.querySelectorAll('tbody tr').length };
})()`;

// Map raw AAP row objects → normalised camelCase objects, drop rows with no ID
function _mapAAPRows(rawRows) {
  return rawRows.map(row => {
    const m = {};
    Object.keys(row).forEach(k => {
      const f = AAP_FIELD_MAP[k];
      if (f) m[f] = row[k];
    });
    if (row._assetUrl) m.assetUrl = row._assetUrl;
    return m;
  }).filter(x => x.equipmentId);
}

// Save scraped AAP data to both aap_cache and fleetData so renderer:ready
// gets a populated table immediately.
function _saveAAPCaches(rows) {
  const now     = new Date().toISOString();
  const payload = { rows, count: rows.length, scrapedAt: now, syncedAt: now, stale: false };
  store.save('aapCache',  payload);
  store.save('fleetData', payload);
  return payload;
}

// ---------------------------------------------------------------------------
// initWindows(ctx)  — sets up all windows and registers window-related IPC.
// Returns an object the rest of app.js binds into its shared ctx.
// ---------------------------------------------------------------------------
function initWindows(ctx) {
  const { pushData, pushStatus, pushError, send, startAutoSync, runFullSync } = ctx;

  let mainWindow       = null;
  let tray             = null;
  let bubbleWin        = null;
  let _bubbleLastPos   = null;
  let _rescanInProgress = false;

  // ── Lazy-loaded scraper deps (avoid circular require at module load) ───────
  function _getAap()  { return require('../scrapers/aap'); }
  function _getAuth() { return require('../scrapers/auth'); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getDomiciles() {
    const settings = store.load('settings', {});
    return (settings.domiciles && settings.domiciles.length)
      ? settings.domiciles
      : require('../config/defaults').DEFAULT_DOMICILES;
  }

  // ── Bubble ────────────────────────────────────────────────────────────────
  function showBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) return;

    const display  = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;
    const savedPos = _bubbleLastPos || { x: width - 360, y: height - 520 };

    const bubbleHtml = path.join(ROOT_DIR, 'renderer', 'bubble.html');

    bubbleWin = new BrowserWindow({
      width: 340, height: 500,
      x: savedPos.x, y: savedPos.y,
      frame:       false,
      transparent: true,
      alwaysOnTop: true,
      resizable:   false,
      skipTaskbar: true,
      hasShadow:   false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'renderer', 'bubble-preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    // Fall back gracefully if bubble.html doesn't exist yet (renderer not built)
    if (fs.existsSync(bubbleHtml)) {
      bubbleWin.loadFile(bubbleHtml);
    } else {
      logger.warn('bubble.html not found — bubble will be blank until renderer is built');
      bubbleWin.loadURL('data:text/html,<body style="background:transparent"></body>');
    }

    bubbleWin.setAlwaysOnTop(true, 'floating');
    bubbleWin.setIgnoreMouseEvents(false);

    bubbleWin.on('moved', () => {
      if (bubbleWin && !bubbleWin.isDestroyed()) {
        const pos = bubbleWin.getPosition();
        _bubbleLastPos = { x: pos[0], y: pos[1] };
      }
    });

    // Send current unavailable badge count once loaded
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
  }

  function hideBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.destroy();
      bubbleWin = null;
    }
  }

  function getBubbleWin() { return bubbleWin; }

  function pushBubbleNotification(notif) {
    if (bubbleWin && !bubbleWin.isDestroyed())
      bubbleWin.webContents.send('bubble:notification', notif);

    _sendDesktopNotification(
      notif.unit ? ('Unit ' + notif.unit) : 'Fleet Update',
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

  // ── Desktop notifications ─────────────────────────────────────────────────
  function _sendDesktopNotification(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    const notif = new Notification({
      title,
      body,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      silent: false,
    });
    notif.on('click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      if (onClick) onClick();
    });
    notif.show();
  }

  // ── AAP scrape helpers ────────────────────────────────────────────────────

  // Shared scrape logic: given a BrowserWindow already loaded with an AAP page,
  // waits for rows, forces 1000/page, extracts, maps, and saves.
  // onComplete(rows) is called with the mapped rows on success.
  // onTimeout() is called if no rows appear within maxPolls * 2s.
  async function _runAAPScrapeLoop(win, { label, maxPolls = 45, onComplete, onTimeout }) {
    let done  = false;
    let polls = 0;

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

        // Diagnostic DOM probe on polls 5 and 20 (startup scrape only)
        if (label === 'startup' && (polls === 5 || polls === 20)) {
          const domInfo = await win.webContents.executeJavaScript(`(function(){
            return JSON.stringify({
              tables:   document.querySelectorAll('table').length,
              tbodies:  document.querySelectorAll('tbody').length,
              trs:      document.querySelectorAll('tr').length,
              bodySnip: (document.body.innerText||'').substring(0,300),
            });
          })()`);
          logger.info(`[${label}] DOM probe poll=${polls}: ${domInfo}`);
        }

        logger.info(`[${label}] Poll ${polls} → ${count} rows`);

        if (count > 5 && !done) {
          clearInterval(iv);
          done = true;
          logger.info(`[${label}] Found ${count} rows — forcing 1000/page...`);

          try {
            const rppResult = await win.webContents.executeJavaScript(JS_FORCE_1000_RPP);
            logger.info(`[${label}] RPP: ${rppResult}`);
            await new Promise(r => setTimeout(r, 500));
            const clickResult = await win.webContents.executeJavaScript(JS_CLICK_1000);
            logger.info(`[${label}] 1000-click: ${clickResult}`);
            await new Promise(r => setTimeout(r, 8000));
            const newCount = await win.webContents.executeJavaScript(
              `document.querySelectorAll('tbody tr').length`
            );
            logger.info(`[${label}] After 1000 force: ${newCount} rows`);
          } catch (e) {
            logger.warn(`[${label}] Force-1000 error:`, e.message);
          }

          const data = await win.webContents.executeJavaScript(JS_EXTRACT_TABLE);
          logger.info(`[${label}] Extracted ${data.count} records. ${data.debug}`);

          const rows = _mapAAPRows(data.rows || []);
          logger.info(`[${label}] Mapped ${rows.length} units`);
          onComplete(rows);
        }
      } catch (e) {
        // page still navigating — not fatal
        logger.info(`[${label}] Scrape iteration error (poll ${polls}): ${e.message}`);
      }
    }, 2000);
  }

  // ── Main window ───────────────────────────────────────────────────────────
  function createMainWindow() {
    const { buildScanURL } = _getAap();
    const { checkMwinit }  = _getAuth();

    // Start hidden at 1×1 off-screen while AAP scrapes.
    // switchToApp() moves/resizes to full size once scraping is done.
    mainWindow = new BrowserWindow({
      width: 1, height: 1,
      x: -9999, y: -9999,
      minWidth: 1, minHeight: 1,
      title: 'Fleet Operations',
      backgroundColor: '#0d1117',
      show: false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
        webviewTag:       true,
        devTools:         true,
      },
    });

    const scrapeDomiciles = getDomiciles();
    const startUrl        = buildScanURL(scrapeDomiciles);
    logger.info(`Loading AAP in main window: ${startUrl.substring(0, 80)}`);
    mainWindow.loadURL(startUrl);

    function switchToApp() {
      logger.info('Switching to Fleet Operations app...');
      if (process.env.NODE_ENV === 'development') {
        logger.info('[window] Dev mode: loading Vite dev server at http://localhost:5173');
        mainWindow.loadURL('http://localhost:5173');
      } else {
        const rendererHtml = path.join(ROOT_DIR, 'renderer', 'src', 'index.html');
        mainWindow.loadFile(rendererHtml);
      }
      mainWindow.setMinimumSize(1200, 700);
      mainWindow.setSize(1600, 960);
      mainWindow.center();
      mainWindow.show();
      mainWindow.focus();
    }

    mainWindow.webContents.on('did-finish-load', () => {
      const url = mainWindow.webContents.getURL();
      logger.info(`Main window loaded: ${url.substring(0, 60)}`);
      if (url.includes('aap-na.corp.amazon.com')) {
        _runAAPScrapeLoop(mainWindow, {
          label: 'startup', maxPolls: 45,
          onComplete: (rows) => {
            const payload = _saveAAPCaches(rows);
            logger.info(`Startup scrape: saved ${rows.length} units to aapCache + fleetData`);
            pushData(payload);
            switchToApp();
          },
          onTimeout: () => {
            logger.warn('Startup scrape timed out — switching to app with empty AAP cache');
            switchToApp();
          },
        });
      }
    });

    // F12 toggles DevTools
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });

    // Close → hide, show bubble
    mainWindow.on('close', e => {
      e.preventDefault();
      mainWindow.hide();
      try { showBubble(); } catch (err) { logger.error('showBubble on close:', err.message); }
    });

    // Minimize → show bubble after brief delay
    mainWindow.on('minimize', () => {
      setTimeout(() => {
        try { showBubble(); } catch (err) { logger.error('showBubble on minimize:', err.message); }
      }, 300);
    });

    // Restore / show → hide bubble
    mainWindow.on('restore', () => { try { hideBubble(); } catch (_) {} });
    mainWindow.on('show',    () => { try { hideBubble(); } catch (_) {} });

    // did-finish-load fires for the renderer HTML — kick auto-sync timer
    mainWindow.webContents.on('did-finish-load', () => {
      const url = mainWindow.webContents.getURL();
      if (url.includes('index.html') || url.startsWith('file://')) {
        if (ctx.startAutoSync) ctx.startAutoSync(); else if (startAutoSync) startAutoSync();
      }
    });

    // renderer:ready — renderer has registered IPC listeners; push cache + kick first sync
    ipcMain.on('renderer:ready', () => {
      logger.info('renderer:ready — pushing cached data...');
      const cached = store.load('fleetData', null);
      if (cached) {
        pushData({ ...cached, stale: true });
        const age    = cached.syncedAt
          ? Math.round((Date.now() - new Date(cached.syncedAt).getTime()) / 60000) : null;
        const t      = cached.syncedAt
          ? new Date(cached.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '?';
        const ageStr = age !== null ? ` \u00B7 ${age < 1 ? '<1' : age}min ago` : '';
        pushStatus(
          `\uD83D\uDCE6 Cached data (${cached.count} units, last sync ${t}${ageStr}) \u2014 refreshing...`
        );
      } else {
        pushStatus('\uD83D\uDD0C First launch \u2014 connecting to AAP...');
      }

      const { checkMwinit: mwCheck } = _getAuth();
      const mw = mwCheck();
      if (!mw.ok) {
        pushError('\u26A0\uFE0F  ' + mw.reason);
        pushStatus('\u26A0\uFE0F  ' + mw.reason);
      }

      if (ctx.runFullSync) ctx.runFullSync();
    });

    // ── Live rescan timer: dedicated off-screen window every 5 min ──────────
    // Runs a full fresh AAP scrape without touching the user-visible main window.
    const RESCAN_INTERVAL_MS = 5 * 60 * 1000;
    function triggerLiveRescan(force) {
      if (_rescanInProgress) {
        logger.info('Rescan already in progress — skipping');
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const freshUrl = buildScanURL(getDomiciles());
      logger.info(`Rescan${force ? ' (domicile change)' : ' (timer)'}: ${freshUrl.substring(0, 60)}`);

      _rescanInProgress = true;
      const scrapeWin = new BrowserWindow({
        width: 1400, height: 800,
        show: true,
        x: -2000, y: 0,  // off-screen
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
            logger.info(`Rescan complete: ${rows.length} units saved`);
            pushData(payload);
            clearTimeout(timeout);
            _rescanInProgress = false;
            try { scrapeWin.destroy(); } catch (_) {}
          },
          onTimeout: () => {
            logger.warn('Rescan: no rows found within poll limit');
            clearTimeout(timeout);
            _rescanInProgress = false;
            try { scrapeWin.destroy(); } catch (_) {}
          },
        });
      });

      scrapeWin.loadURL(freshUrl);
    }

    // First rescan 1 min after startup; then every 5 min
    setTimeout(() => {
      triggerLiveRescan(false);
      setInterval(() => triggerLiveRescan(false), RESCAN_INTERVAL_MS);
    }, 60000);

    // Expose trigger for domicile-change forced rescan
    ipcMain.on('aap:rescan', (_e, opts) => triggerLiveRescan(!!(opts && opts.force)));
  }

  // ── System tray ───────────────────────────────────────────────────────────
  function createTray() {
    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    const icon     = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('Fleet Operations \u00B7 Loading...');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Fleet Operations',     click: () => { mainWindow.show(); mainWindow.focus(); } },
      { label: 'Sync Now', click: () => { if (ctx.runFullSync) ctx.runFullSync(); } },
      { type: 'separator' },
      { label: '\u2699 Setup AAP Columns',  click: () => openAAPSetupWindow() },
      { type: 'separator' },
      { label: 'Open Data Folder',          click: () => shell.showItemInFolder(P.fleetData) },
      { type: 'separator' },
      { label: 'Quit',                      click: () => app.exit(0) },
    ]));
    tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });

    // Animated tray icon — 12-frame pulse cycle at ~8fps
    const trayDir    = path.join(ROOT_DIR, 'assets', 'tray');
    const frameCount = 12;
    const frames     = [];
    for (let i = 0; i < frameCount; i++) {
      const fp = path.join(trayDir, `frame_${String(i).padStart(2, '0')}.png`);
      frames.push(fs.existsSync(fp) ? nativeImage.createFromPath(fp) : icon);
    }
    let frameIdx = 0;
    setInterval(() => {
      frameIdx = (frameIdx + 1) % frameCount;
      try { tray.setImage(frames[frameIdx]); } catch (_) {}
    }, 120);
  }

  // ── AAP Column Setup window ───────────────────────────────────────────────
  function openAAPSetupWindow() {
    const { buildScanURL } = _getAap();
    const setupWin = new BrowserWindow({
      width: 1400, height: 900,
      title: 'AAP Column Setup \u2014 configure columns, then close this window',
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        partition: '',  // same session as the scraper
      },
    });

    setupWin.loadURL(buildScanURL(getDomiciles()));

    setupWin.webContents.on('did-finish-load', () => {
      setupWin.webContents.executeJavaScript(`
        setTimeout(function() {
          var b = document.createElement('div');
          b.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:99999;' +
            'background:#f0a800;color:#000;font-weight:bold;' +
            'font-size:14px;padding:10px 16px;text-align:center;';
          b.textContent =
            '\u2699 SETUP MODE: Add the columns you want (Domicile site, ' +
            'Manufacturer, etc.), then CLOSE this window. ' +
            'Settings are saved automatically.';
          document.body.prepend(b);
        }, 2000);
      `).catch(() => {});
    });

    setupWin.on('closed', () => {
      logger.info('AAP setup window closed — column prefs saved to session');
      setTimeout(() => { if (ctx.runFullSync) ctx.runFullSync(); }, 1000);
    });
  }

  // ── Setup wizard (first launch) ───────────────────────────────────────────
  function showSetupWizard() {
    const wizardHtml = path.join(ROOT_DIR, 'renderer', 'src', 'setup', 'index.html');
    const wizWin = new BrowserWindow({
      width: 620, height: 580,
      frame:     false,
      resizable: false,
      center:    true,
      show:      false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    wizWin.loadFile(wizardHtml);
    wizWin.once('ready-to-show', () => wizWin.show());

    ipcMain.once('wizard:complete', (_e, config) => {
      logger.info('Setup wizard complete — applying config');
      const { markStepComplete } = require('../../setup/state');

      // Persist settings through the store
      const settings = store.load('settings', {});
      settings.domiciles = (config.domiciles || '')
        .split(/[\n,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      settings.profile = {
        name:  config.userName  || '',
        email: config.userEmail || '',
        phone: config.userPhone || '',
        role:  'Fleet Coordinator',
      };
      store.save('settings', settings);

      // Orcha config
      store.save('orchaConfig', {
        mode: config.orchaMode || 'local',
        host: config.orchaHost || '',
        port: config.orchaPort || 4799,
      });

      // Email config
      store.save('opEmails', {
        username: 'ANT\\' + (config.userEmail || '').split('@')[0],
        password: '',
        from:      config.userEmail || '',
        defaultTo: '',
        defaultCc: '',
      });

      markStepComplete('profile',  { name: settings.profile.name });
      markStepComplete('domiciles', { domiciles: settings.domiciles });
      markStepComplete('orcha',    { mode: config.orchaMode || 'local' });

      logger.info(
        `Setup: domiciles=${settings.domiciles.join(',')}, ` +
        `orchaMode=${settings.profile && config.orchaMode}`
      );

      wizWin.close();
      createMainWindow();
      createTray();
      // Scheduler is started from app.js after init
    });
  }

  // ── Window-related IPC handlers ───────────────────────────────────────────

  ipcMain.on('fleet:request-sync', () => {
    if (_rescanInProgress) {
      logger.info('request-sync skipped — rescan in progress');
      return;
    }
    if (ctx.runFullSync) ctx.runFullSync();
  });

  ipcMain.handle('app:version', () => app.getVersion());


  ipcMain.on('bubble:clicked', () => {
    hideBubble();
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  ipcMain.on('bubble:open-unit', (_e, unitId) => {
    hideBubble();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('navigate:unit', unitId);
    }
  });

  ipcMain.handle('uptake:open-url', (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const win = new BrowserWindow({
      width: 1400, height: 900,
      title: 'Uptake',
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        session: session.defaultSession,
      },
    });
    win.loadURL(url);
    win.once('ready-to-show', () => win.show());
  });

  ipcMain.handle('relay:open-url', (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const win = new BrowserWindow({
      width: 1400, height: 900,
      title: 'AAP Relay \u2013 Service Request',
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true,
        session: session.defaultSession,
      },
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
    showBubble,
    hideBubble,
    getBubbleWin:              () => bubbleWin,
    getMainWindow:             () => mainWindow,
    getTray:                   () => tray,
    pushBubbleNotification,
    isSetupComplete,
    triggerRescan: (force) => {
      ipcMain.emit('aap:rescan', null, { force: !!force });
    },
  };
}

module.exports = { initWindows };
