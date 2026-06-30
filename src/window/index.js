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
const { P }  = require('../config/paths');
const store  = require('../store');
const { isSetupComplete } = require('../../setup/state');

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
  'Engine manufacturer':          'engineManufacturer',
  'Domicile site':                'domicileSite',
  'Fuel type':                    'fuelType',
  'Open Unplanned Work Requests': 'openUnplanned',
  'Open Planned Work Requests':   'openPlanned',
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

// ── Map raw AAP rows → normalised camelCase, drop rows with no equipmentId ───
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

// ── Save scrape results to aap_cache + fleetData ──────────────────────────────
function _saveAAPCaches(rows) {
  const now     = new Date().toISOString();
  const payload = { rows, count: rows.length, scrapedAt: now, syncedAt: now, stale: false };
  store.save('aapCache',  payload);
  store.save('fleetData', payload);
  return payload;
}

// ── initWindows(ctx) ──────────────────────────────────────────────────────────
function initWindows(ctx) {
  const { pushData, pushStatus, pushError, send, startAutoSync, runFullSync } = ctx;

  let mainWindow        = null;
  let tray              = null;
  let bubbleWin         = null;
  let _bubbleLastPos    = null;
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
    if (bubbleWin && !bubbleWin.isDestroyed()) return;

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const savedPos = _bubbleLastPos || { x: width - 360, y: height - 520 };
    const bubbleHtml = path.join(ROOT_DIR, 'renderer', 'bubble.html');

    bubbleWin = new BrowserWindow({
      width: 340, height: 500,
      x: savedPos.x, y: savedPos.y,
      frame: false, transparent: true, alwaysOnTop: true,
      resizable: false, skipTaskbar: true, hasShadow: false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'renderer', 'bubble-preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

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
  }

  function hideBubble() {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.destroy();
      bubbleWin = null;
    }
  }

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
              win.webContents.removeListener('did-finish-load', arm);
              resolve();
            }, 15000);
            function arm() {
              clearTimeout(settled);
              settled = setTimeout(function() {
                clearTimeout(ceiling);
                win.webContents.removeListener('did-finish-load', arm);
                resolve();
              }, 2000);
            }
            win.webContents.on('did-finish-load', arm);
            arm(); // arm once to handle pre-settled case after the hard delay
          }, 6000);
        });
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
    "Open Unplanned Work Requests","Open Planned Work Requests","Last geofences"
  ];


  // Find column-selector button using stable MDN framework attributes (wont rotate on AAP deploys unlike CSS hashes)
  var btn = document.querySelector('button[data-mdn-interactive][mdn-popover-offset="-4"]') || null;


  // Fallback: button where inner span has aria-label='Menu' (the eye icon label)
  if (!btn) {
    btn = Array.from(document.querySelectorAll('button')).find(function(b) {
      var sp = b.querySelector('span[aria-label]');
      return sp && sp.getAttribute('aria-label') === 'Menu';
    }) || null;
  }


  if (!btn) return { ok: false, reason: 'button not found' };
  simClick(btn);
  await sleep(1800);

  // Find popup: div containing both Available Columns + Selected columns headings
  var popup = Array.from(document.querySelectorAll('div')).find(function(d) {
    var t = d.textContent || '';
    return t.includes('Available Columns') && t.includes('Selected columns');
  }) || null;
  if (!popup) return { ok: false, reason: 'popup not found' };

  // Split popup into Available (left) and Selected (right) sections by h4 headings
  var h4s = Array.from(popup.querySelectorAll('h4'));
  var availHead = h4s.find(function(h) { return (h.textContent||''). trim() === 'Available Columns'; });
  var selHead   = h4s.find(function(h) { return (h.textContent||''). trim() === 'Selected columns'; });
  var availSection = availHead && availHead.closest('div');
  var selSection   = selHead   && selHead.closest('div');

  // Remove all selected columns except Equipment ID
  if (selSection) {
    for (var rr = 0; rr < 50; rr++) {
      var remRows = Array.from(selSection.querySelectorAll('p')).filter(function(p) {
        return (p.textContent||''). trim() !== 'Equipment ID' && (p.textContent||''). trim().length > 0;
      });
      if (remRows.length === 0) break;
      var remBtn = remRows[0].parentElement && remRows[0].parentElement.querySelector('button[data-mdn-interactive]');
      if (remBtn) { simClick(remBtn); await sleep(200); } else break;
    }
  }

  // Add each wanted column: search -> find p with exact text in availSection -> click sibling button
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
      return (p.textContent||''). trim() === name;
    });
    var addBtn = leaf && leaf.parentElement && leaf.parentElement.querySelector('button[data-mdn-interactive]');
    if (addBtn) { simClick(addBtn); added.push(name); await sleep(250); }
    else { failed.push(name); }
    // Clear search after each
    if (searchInput) {
      var clearBtn = availSection && availSection.querySelector('button[aria-label="Clear search"]');
      if (clearBtn) { simClick(clearBtn); await sleep(200); }
    }
  }

  // Click Apply
  await sleep(300);
  var applyBtn = Array.from(document.querySelectorAll('button[data-mdn-interactive]')).find(function(b) {
    return (b.textContent||''). trim() === 'Apply';
  });
  if (applyBtn) { simClick(applyBtn); return { ok: true, added: added, failed: failed }; }
  return { ok: false, reason: 'Apply not found', added: added, failed: failed };
})()
        `);
        logger.info('[' + label + '] Column config:', JSON.stringify(colRes));
        if (colRes && colRes.ok) await new Promise(r => setTimeout(r, 1800));
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
      backgroundColor: '#0d1117',
      show: true,
      center: true,
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
          logger.info('[startup] mwinit complete \u2014 loading AAP');
          pushStatus('\u2705 Midway auth complete \u2014 loading AAP...');
        } catch (e) {
          logger.error('[startup] mwinit failed:', e.message);
          pushError('\u26A0\uFE0F mwinit failed: ' + e.message + ' \u2014 run mwinit manually then restart');
        }
      } else {
        logger.info('[startup] Cookies valid (' + state.count + ' cookies, expires in ' +
          (state.expiresInMin !== null ? state.expiresInMin + 'min' : 'session') + ')');
      }

      mainWindow.loadURL(startUrl); mainWindow.webContents.openDevTools();
    })();

    function switchToApp() {
      _appReady = true;
      setTimeout(() => {
        triggerLiveRescan(false);
        setInterval(() => triggerLiveRescan(false), RESCAN_INTERVAL_MS);
      }, 90000);
      logger.info('Switching to Fleet Operations app...');
      if (process.env.NODE_ENV === 'development') {
        logger.info('[window] Dev mode: loading Vite dev server at http://localhost:5173');
        //DBG: mainWindow.loadURL('http://localhost:5173');
      } else {
        mainWindow.loadFile(path.join(ROOT_DIR, 'renderer', 'src', 'index.html'));
      }
      mainWindow.setMinimumSize(1200, 700);
      mainWindow.setSize(1600, 960);
      mainWindow.center();
      mainWindow.setTitle('Fleet Operations');
      mainWindow.show();
      mainWindow.focus();
    }

    let _startupScrapeStarted = false;

    function _onMainWindowNav(url) {
      if (!url) url = mainWindow.webContents.getURL();
      logger.info('Main window loaded: ' + url.substring(0, 80));
      const onAAP = url.includes('aap-na.corp.amazon.com') && !url.includes('midway-auth');
      if (onAAP && !_startupScrapeStarted) {
        _startupScrapeStarted = true;
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
            const { runMwinit, injectCookies } = _getAuth();
            await runMwinit();
            await injectCookies();
            logger.info('[auth-poll] mwinit done \u2014 reloading AAP');
            pushStatus('\u2705 Midway auth complete \u2014 reloading AAP...');
            mainWindow.loadURL(startUrl);
          } catch (e) {
            logger.error('[auth-poll] mwinit failed:', e.message);
            pushError('\u26A0\uFE0F mwinit failed: ' + e.message + ' \u2014 run mwinit manually then restart');
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

    ipcMain.on('renderer:ready', () => {
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
        show: true, x: -2000, y: 0,
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
    const wizWin = new BrowserWindow({
      width: 620, height: 580,
      frame: false, resizable: false, center: true, show: false,
      webPreferences: {
        preload:          path.join(ROOT_DIR, 'preload.js'),
        contextIsolation: true,
        nodeIntegration:  false,
      },
    });

    wizWin.loadFile(wizardHtml);
    wizWin.once('ready-to-show', () => wizWin.show());

    ipcMain.once('wizard:complete', (_e, config) => {
      logger.info('Setup wizard complete \u2014 applying config');
      const { markStepComplete } = require('../../setup/state');

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

      store.save('orchaConfig', {
        mode: config.orchaMode || 'local',
        host: config.orchaHost || '',
        port: config.orchaPort || 4799,
      });

      store.save('opEmails', {
        username:  'ANT\\' + (config.userEmail || '').split('@')[0],
        password:  '',
        from:      config.userEmail || '',
        defaultTo: '',
        defaultCc: '',
      });

      markStepComplete('profile',   { name: settings.profile.name });
      markStepComplete('domiciles', { domiciles: settings.domiciles });
      markStepComplete('orcha',     { mode: config.orchaMode || 'local' });

      logger.info('Setup: domiciles=' + settings.domiciles.join(','));

      wizWin.close();
      createMainWindow();
      createTray();
    });
  }

  // ── Window IPC handlers ───────────────────────────────────────────────────
  ipcMain.on('fleet:request-sync', () => {
    if (_rescanInProgress) { logger.info('request-sync skipped \u2014 rescan in progress'); return; }
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
      width: 1400, height: 900, title: 'Uptake',
      backgroundColor: '#0d1117', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });
    win.loadURL(url);
    win.once('ready-to-show', () => win.show());
  });

  ipcMain.handle('relay:open-url', (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const win = new BrowserWindow({
      width: 1400, height: 900, title: 'AAP Relay \u2013 Service Request',
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
