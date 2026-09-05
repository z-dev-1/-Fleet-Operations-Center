'use strict';
/**
 * src/app.js  [Version C]
 *
 * Application bootstrap — wires every subsystem together.
 *
 * Startup order (mandatory):
 *   1. Global error boundary
 *   2. Logger bootstrap
 *   3. Single-instance lock
 *   4. App lifecycle event handlers
 *   5. app.whenReady():
 *       a. Configure log dir + level
 *       b. Build shared ctx object
 *       c. Init window manager   → createMainWindow / createTray / etc.
 *       d. Build sync engine     → runFullSync / startAutoSync
 *       e. registerAllIPC(ctx)   → every IPC channel live
 *       f. Create main window    → triggers AAP scrape then renders app
 *       g. Create tray
 *       h. Start scheduler       → SP push + email auto-send + catch-up
 *       i. Sleep resume listener → catch-up on wake
 *
 * This file owns NO business logic — it only wires modules together.
 */

const { app, ipcMain, powerMonitor } = require('electron');
const logger    = require('./utils/logger');
const { installGlobalBoundary }      = require('./utils/errors');
const { P }     = require('./config/paths');
const DEFAULTS  = require('./config/defaults');
const store     = require('./store');
const scheduler = require('./scheduler');

// ── 1. Error boundary — must be first ────────────────────────────────────
installGlobalBoundary();

// ── 2. Logger bootstrap (level set again after app.ready) ────────────────
const log = logger('app');

// ── 3. Single-instance lock ───────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.warn('Another instance is already running — quitting.');
  app.quit();
  process.exit(0);
}

// ── 4. App lifecycle events ───────────────────────────────────────────────

// Second instance attempted → bring existing window to front
app.on('second-instance', () => {
  try {
    const win = _ctx && _ctx.getMainWindow && _ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  } catch (_) {}
});

// macOS: keep alive until explicit Cmd-Q
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// macOS: re-open when dock icon clicked
app.on('activate', () => {
  try {
    const win = _ctx && _ctx.getMainWindow && _ctx.getMainWindow();
    if (!win || win.isDestroyed()) _ctx.createMainWindow();
  } catch (_) {}
});

// Graceful shutdown — clear all timers
app.on('before-quit', () => {
  log.info('Shutting down...');
  scheduler.stop();
});

// ── 5. Ready ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {

  // ── 5a. Logger now has a data dir ────────────────────────────────────────
  logger.setLogDir(P.logsDir);
  logger.setLevel(DEFAULTS.LOG_LEVEL);
  log.info('Fleet Operations v' + (app.getVersion() || '3.0') + ' starting...');
  log.info('Platform: ' + process.platform + ' ' + process.arch);
  log.info('Data dir: ' + P.dataDir);

  // ── 5a-2. BETA GATE (2026-07-22) ─────────────────────────────────────────
  // v3.1.0-beta.1 is restricted to an explicit allowlist of corp usernames
  // -- see src/config/beta-gate.js for the full design + how to add/remove
  // users or lift the gate entirely. Checked as the very first thing after
  // the logger is ready and BEFORE any window, IPC, or sync subsystem is
  // created, so a non-allowlisted user never sees any part of the app
  // initialize -- just a small "Beta Access Restricted" window.
  {
    const { isBetaUser, isAdminUser, getCurrentUsername, BETA_ALLOWED_USERS } = require('./config/beta-gate');
    const currentUser = getCurrentUsername();
    if (!isBetaUser()) {
      log.warn('Beta gate: blocked launch for user "' + (currentUser || 'unknown') + '" -- not in allowlist: [' + BETA_ALLOWED_USERS.join(', ') + ']');
      const { BrowserWindow } = require('electron');
      const denyWin = new BrowserWindow({
        width: 480, height: 280, resizable: false, center: true, show: false,
        title: 'Fleet Operations \u2014 Beta Access Restricted',
        icon: require('./config/app-icon').getAppIconPath(),
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      const safeUser = String(currentUser || 'unknown').replace(/[<>&"]/g, '');
      denyWin.loadURL('data:text/html,' + encodeURIComponent(
        '<html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;' +
        'padding:28px;margin:0;box-sizing:border-box;">' +
        '<div style="font-size:28px;margin-bottom:10px;">\u{1F512}</div>' +
        '<h2 style="margin:0 0 12px;font-size:16px;">Beta Access Restricted</h2>' +
        '<p style="font-size:13px;line-height:1.6;color:#8b949e;margin:0 0 10px;">' +
        'This beta build of Fleet Operations is currently limited to a specific set of users. ' +
        'Your account (<strong style="color:#e6edf3;">' + safeUser + '</strong>) is not on that list yet.</p>' +
        '<p style="font-size:12px;color:#6e7681;margin:0;">Contact the app owner if you believe this is a mistake.</p>' +
        '</body></html>'
      ));
      denyWin.once('ready-to-show', () => denyWin.show());
      denyWin.on('closed', () => app.quit());
      return; // stop bootstrap here -- no window manager, no sync, no IPC registered
    }
    log.info('Beta gate: launch allowed for user "' + currentUser + '" (' + (isAdminUser() ? 'admin' : 'beta tester') + ')');
  }

  // ── 5a-3. VPN GATE — block launch until Amazon VPN is connected ────────────
  // Internal resources (AAP, SharePoint, SMTP relay, Relay scraper) all live
  // behind corp DNS. Launching without VPN silently fails every scrape and
  // auth flow. This gate shows a small window and polls vpncli every 5 s;
  // bootstrap resumes automatically the moment the tunnel comes up.
  // Closing the gate window quits the app rather than launching in a broken state.
  {
    const { checkVpnState, connectVpn } = require('./utils/vpn');
    const _vpnInitial = await checkVpnState();
    log.info('[vpn-gate] Initial state: ' + _vpnInitial.status);

    if (!_vpnInitial.connected) {
      log.warn('[vpn-gate] VPN not connected — holding startup until tunnel is up');
      const _vpnAttempt = await connectVpn();
      log.info('[vpn-gate] Auto-connect: ' + _vpnAttempt.raw.substring(0,100));
      const _vpnRecheck = await checkVpnState();
      log.info('[vpn-gate] Post-connect: ' + _vpnRecheck.status);
      if (_vpnRecheck.connected) {
        log.info('[vpn-gate] Auto-connect succeeded');
        // VPN auto-connected successfully
      } else { // auto-connect failed - fall back to manual gate

      await new Promise((resolve) => {
        const { BrowserWindow } = require('electron');

        const _vpnHtml = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1117;color:#e6edf3;padding:32px;font-family:system-ui,sans-serif;user-select:none}.icon{font-size:36px;margin-bottom:14px}h2{font-size:16px;font-weight:600;margin-bottom:10px}p{font-size:13px;line-height:1.6;color:#8b949e;margin-bottom:10px}.btn{display:inline-flex;align-items:center;gap:8px;margin-top:4px;margin-bottom:14px;padding:9px 18px;background:#1f6feb;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}.btn:hover{background:#388bfd}.btn:active{background:#1158c7}.status{font-size:12px;color:#6e7681;display:flex;align-items:center;gap:8px}.dot{width:8px;height:8px;border-radius:50%;background:#f0883e;animation:pulse 1.8s ease-in-out infinite;flex-shrink:0}.dot.green{background:#3fb950;animation:none}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}</style></head><body><div class=\"icon\">🔒</div><h2>VPN Required</h2><p>Fleet Operations needs an active Amazon VPN to reach internal resources.</p><button class=\"btn\" id=\"vpnBtn\">🖥️ Open Cisco Secure Client</button><p style=\"font-size:12px;color:#6e7681;margin-bottom:16px\">Click Connect in Cisco — this window closes automatically.</p><div class=\"status\"><div class=\"dot\" id=\"dot\"></div><span id=\"lbl\">Checking VPN…</span></div><script>document.getElementById(\"vpnBtn\").onclick=function(){console.log(\"vpn-btn-open\");};var n=5;setInterval(function(){n=n<=1?5:n-1;var el=document.getElementById(\"lbl\");if(el)el.textContent=\"Checking VPN... next check: \"+n+\"s\";},1000);<\\/script></body></html>";

        const _vpnWin = new BrowserWindow({
          width: 460, height: 320, resizable: false, center: true, show: false,
          title: 'Fleet Operations \u2014 VPN Required',
          icon: require('./config/app-icon').getAppIconPath(),
          frame: true, autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false },
        });
        _vpnWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(_vpnHtml));
        _vpnWin.once('ready-to-show', () => _vpnWin.show());

        // Open Cisco Secure Client: intercept console-message from renderer (works with contextIsolation)
        _vpnWin.webContents.on('console-message', (_e, _level, msg) => {
          log.info('[vpn-gate] renderer msg: ' + msg.substring(0,80));
          if (msg.includes('vpn-btn-open')) {
            const { VPNUI_PATH } = require('./utils/vpn');
            log.info('[vpn-gate] Launching Cisco Secure Client UI: ' + VPNUI_PATH);
            try {
              const _vpnUi = require('child_process').spawn(VPNUI_PATH, [], { detached: true, stdio: 'ignore', windowsHide: false });
              _vpnUi.unref();
            } catch (e) {
              log.warn('[vpn-gate] Failed to launch vpnui: ' + e.message + ' — trying shell.openPath');
              require('electron').shell.openPath(VPNUI_PATH);
            }
          }
        });

        // Poll vpncli every 5 s; auto-close + continue when connected
        const _vpnPoll = setInterval(async () => {
          const s = await checkVpnState();
          log.info('[vpn-gate] Poll: ' + s.status);
          if (s.connected) {
            clearInterval(_vpnPoll);
            if (!_vpnWin.isDestroyed()) _vpnWin.close();
            resolve();
          }
        }, 5000);

        // User closes window manually \u2192 quit rather than boot broken
        _vpnWin.on('closed', () => {
          clearInterval(_vpnPoll);
          log.warn('[vpn-gate] Window closed by user \u2014 quitting');
          app.quit();
        });
      });

      } // end else: manual gate fallback
      log.info('[vpn-gate] VPN connected \u2014 resuming startup');
    }
  }

  // ── 5b. Shared ctx — one object, passed to every subsystem ───────────────
  // Mutable cells — updated by sync engine via setters, read by everyone.
  let _isSyncing = false;
  let _lastData  = null;

  // Safe IPC push helpers — no-op if window is gone
  function _send(channel, payload) {
    try {
      const win = _windowApi && _windowApi.getMainWindow();
      if (win && !win.isDestroyed())
        win.webContents.send(channel, payload);
    } catch (_) {}
    // BUBBLE MIRROR (2026-07-25): the bubble window now runs the exact same
    // renderer (bridge.js + orcha-fab.js) as the main window, so it needs
    // the exact same real-time pushes (fleet:data, fleet:status, etc.) --
    // otherwise its Alerts tab (and anything else keyed off live fleet
    // state) sees a permanently-empty default and never updates. Without
    // this, the bubble was a "mirror" of the UI but silently starved of
    // the data that UI depends on.
    try {
      const bubble = _windowApi && _windowApi.getBubbleWin && _windowApi.getBubbleWin();
      if (bubble && !bubble.isDestroyed())
        bubble.webContents.send(channel, payload);
    } catch (_) {}
  }

  // pushData: guards against out-of-order stale pushes arriving after a fresh one
  let _lastPushTs = 0;
  function _pushData(d) {
    const ts = d && (d.syncedAt || d.aapScrapedAt || d.scrapedAt);
    if (ts) {
      const t = new Date(ts).getTime();
      if (t < _lastPushTs) {
        log.info('pushData skipped — stale (' + (d.count || '?') + ' units, ts=' +
          new Date(t).toISOString().slice(11, 19) + ' < last=' +
          new Date(_lastPushTs).toISOString().slice(11, 19) + ')');
        return;
      }
      _lastPushTs = t;
    }
    _send('fleet:data',   d);
    // Run anomaly detection + morning briefing + recommendations on every data push
    // (extracted to src/orcha/briefing.js — Phase 4)
    try {
      const briefing = require('./orcha/briefing');
      const rows = (d && d.rows) || [];
      if (rows.length) briefing.process(rows, _send);
    } catch(e) { /* advisory — don't block data push */ }
  }
  function _pushStatus(s) { _send('fleet:status', s); }
  function _pushError(e)  { _send('fleet:error',  e); }

  // ── Offline mode monitoring ─────────────────────────────────────────────
  const offline = require('./orcha/offline');
  offline.startMonitoring((status) => {
    _send('app:connection-status', { online: status === 'online' });
    if (status === 'online') {
      // Process queued entries with AI rewrite
      // Phase 3: 30s timeout per rewrite — if AI is slow, use raw text and continue
      const relay = require('./orcha/relay');
      offline.processQueue(async (unit, raw) => {
        try {
          const r = await Promise.race([
            relay.ask('Rewrite this fleet timeline entry professionally in 1 sentence (keep date prefix): ' + raw),
            new Promise((_, reject) => setTimeout(() => reject(new Error('rewrite timeout')), 30000))
          ]);
          return r || raw;
        }
        catch(e) { return raw; }
      }).then((results) => {
        if (results.length) {
          // BUG FIX: this flush handler wrote straight to notesStore[id].timeline with
          // none of the safeguards that notes:add-timeline / ai:append-timeline have:
          // (1) no manualEntries[] tracking -> the next Orcha deep-scan rescan would
          //     silently overwrite/drop these entries (same class of bug fixed earlier
          //     for the '+' quick-add and chat-add paths);
          // (2) no mirror into fleetData.rows[].repairTimeline -> the detail panel
          //     (which reads unit.repairTimeline, not notesStore directly) would not
          //     show the entry until an unrelated full data refresh happened to touch it;
          // (3) no notes:updated push -> no instant UI refresh;
          // (4) no cleanTimeline() gap-filler pass, unlike every other write path.
          const { cleanTimeline } = require('./ipc/notes');
          const notesStore = store.load('notesStore', {});
          const fd = store.load('fleetData', {});
          const touchedIds = [];
          results.forEach((r) => {
            const u = notesStore[r.equipmentId] || {};
            u.timeline = u.timeline ? u.timeline + '\n' + r.rewritten : r.rewritten;
            if (cleanTimeline) u.timeline = cleanTimeline(u.timeline);
            u.manualEntries = Array.isArray(u.manualEntries) ? u.manualEntries : [];
            u.manualEntries.push(r.rewritten);
            notesStore[r.equipmentId] = u;
            if (fd.rows) {
              const row = fd.rows.find(function (x) { return x.equipmentId === r.equipmentId; });
              if (row) row.repairTimeline = u.timeline;
            }
            touchedIds.push({ unitId: r.equipmentId, timeline: u.timeline });
          });
          store.save('notesStore', notesStore);
          if (fd.rows) store.save('fleetData', fd);
          touchedIds.forEach(function (t) { _send('notes:updated', t); });
          _send('notes:batch-updated', { count: results.length });
        }
      }).catch(() => {});
    }
  });

  // ── Midway auto-refresh — check every 5 minutes, renew 15 min before expiry ──
  const _authModule = require('./scrapers/auth');
  let _midwayRefreshTimer = null;
  let _midwayRenewalInFlight = false; // FIX (2026-07-21): see note below
  function _midwayAutoRefresh() {
    _midwayRefreshTimer = setInterval(async () => {
      // FIX (2026-07-21): this 5-min setInterval had no guard against firing
      // again while a PREVIOUS tick's runMwinit() was still pending (i.e.
      // still waiting on the user to complete the terminal prompt). Before
      // 2026-07-14 this never mattered because a logger typo crashed the
      // block before runMwinit() was ever reached, so the timer was
      // effectively a no-op. Once that typo was fixed, this became a real,
      // periodically-firing background task -- and with no lock, any
      // runMwinit() that took longer than 5 minutes to complete (easy, if
      // the user is mid-troubleshooting or just slow to respond to the
      // prompt) got a SECOND overlapping mwinit terminal spawned on top of
      // it on the next tick. Two concurrent mwinit attempts racing for the
      // same Midway session is a direct, confirmed cause of
      // "AEA verification failed: used_too_late" -- one attempt's challenge/
      // certificate timing gets invalidated by the other. This also explains
      // the pileup of multiple stale mwinit processes observed accumulating
      // over hours in the same session (each 5-min tick spawning a new one
      // on top of incomplete previous ones). The guard below simply skips
      // this tick entirely if a renewal is already in progress.
      if (_midwayRenewalInFlight) {
        log.info('[midway] heartbeat: renewal already in flight, skipping this tick');
        return;
      }
      try {
        const state = _authModule.checkMwinit();
        // OBSERVABILITY FIX (2026-07-14): the block below only logs on a state
        // CHANGE (renewing / expired) -- a healthy check with time remaining
        // produces zero log output. That's exactly why the logger.error typo
        // above went undetected for a full day (2026-07-13 to 2026-07-14):
        // silence was indistinguishable from "working fine, nothing due yet."
        // A low-volume heartbeat every 5-min cycle removes that blind spot.
        log.info('[midway] heartbeat: ok=' + state.ok + ' expiresInMin=' + state.expiresInMin);
        // Push live session status to renderer so the auth badge updates every tick
        _send('auth:mwinit-status', { ok: state.ok, expiresInMin: state.expiresInMin });
        if (state.ok && state.expiresInMin !== null && state.expiresInMin < 15) {
          log.info('[midway] Cookies expire in ' + state.expiresInMin + 'min -- auto-renewing');
          _midwayRenewalInFlight = true;
          _send('app:midway-renewing', { expiresIn: state.expiresInMin });
          await _authModule.runMwinit();
          await _authModule.injectCookies();
          log.info('[midway] Auto-renewed successfully');
          _send('app:midway-renewed', {});
        } else if (!state.ok) {
          log.warn('[midway] Cookies expired -- launching mwinit');
          _midwayRenewalInFlight = true;
          _send('app:midway-expired', {});
          await _authModule.runMwinit();
          await _authModule.injectCookies();
          _send('app:midway-renewed', {});
        }
      } catch (e) {
        log.error('[midway] Auto-refresh failed: ' + e.message);
      } finally {
        _midwayRenewalInFlight = false;
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }
  _midwayAutoRefresh();
  // The ctx object — everything reads/writes through this
  const _ctx = {
    // ── Sync state (get/set so sync engine mutates by assignment) ───────────
    get isSyncing() { return _isSyncing; },
    set isSyncing(v) { _isSyncing = v; },
    get lastData()  { return _lastData; },
    set lastData(v) { _lastData = v; },

    // ── Window refs (lazy — window module populated below) ──────────────────
    getMainWindow:  () => _windowApi ? _windowApi.getMainWindow()  : null,
    getTray:        () => _windowApi ? _windowApi.getTray()        : null,
    getBubbleWin:   () => _windowApi ? _windowApi.getBubbleWin()   : null,

    // ── Live getter for misc.js which uses ctx.mainWindow directly ──────────
    get mainWindow() { return _windowApi ? _windowApi.getMainWindow() : null; },

    // ── IPC send helpers ────────────────────────────────────────────────────
    pushData:     _pushData,
    pushStatus:   _pushStatus,
    pushError:    _pushError,
    // S7: structured auth-failure channel — carries { code, message } for session errors
    pushAuthFailure: (payload) => _send('fleet:auth-failure', payload),
    send:         _send,

    // Alias expected by IPC handlers
    sendToWindow: _send,

    // ── Bubble ───────────────────────────────────────────────────────────────
    showBubble:  () => { try { _windowApi && _windowApi.showBubble(); } catch (_) {} },
    hideBubble:  () => { try { _windowApi && _windowApi.hideBubble(); } catch (_) {} },
    pushBubbleNotification: (n) => {
      try { _windowApi && _windowApi.pushBubbleNotification(n); } catch (_) {}
    },

    // ── Sync entry points (populated after sync engine is created) ──────────
    runFullSync:   null,   // set below
    startAutoSync: null,   // set below
    triggerRescan: null,   // set below

    // ── Scrapers (injected into sync engine ctx) ─────────────────────────────
    ensureAuthenticated: (...args) => require('./scrapers/auth').ensureAuthenticated(...args),
    scrapeUptake:        (...args) => require('./scrapers/uptake').scrapeUptake(...args),
    scrapeRelay:         (...args) => require('./scrapers/relay').scrapeRelay(...args),
    mergeUptakeIntoRows: (...args) => require('./scrapers/uptake').mergeUptakeIntoRows(...args),
    mergeRelayIntoRows:  (...args) => require('./scrapers/relay').mergeRelayIntoRows(...args),

    // ── Window factory refs (populated after window init) ───────────────────
    createMainWindow: null,  // set below
  };

  // ── 5c. Window manager ────────────────────────────────────────────────────
  const { initWindows } = require('./window');
  const _windowApi = initWindows(_ctx);

  // Back-fill window factory refs on ctx
  _ctx.createMainWindow = _windowApi.createMainWindow;
  _ctx.closeSetupWizard = _windowApi.closeSetupWizard; // BUG FIX (2026-07-22): setup:complete needs this to close the wizard window itself
  _ctx.openZoomMeetingWindow = _windowApi.openZoomMeetingWindow; // FEATURE (2026-07-23): lets ipc/zoom.js open the embedded Zoom meeting window

  // ── 5d. Sync engine ────────────────────────────────────────────────────────
  const { createSyncEngine } = require('./sync');
  const _syncEngine = createSyncEngine(_ctx);

  // Auto-sync timer
  let _syncTimer = null;
  // FEATURE (2026-07-16): "Schedulers – Config → Sync interval (minutes)" in
// Settings previously did nothing at all -- the field/button existed in the
// HTML but nothing ever read it, and the timer below used the hardcoded
// DEFAULTS.SYNC_INTERVAL_MS constant with no override path. This reads
// settings.syncIntervalMinutes fresh from disk every time _startAutoSync()
// runs, falling back to the DEFAULTS constant if unset/invalid. Bounds
// (1-360 min) mirror the validation in the settings:save-sync-interval IPC
// handler in src/ipc/settings.js.
function _getSyncIntervalMs() {
  const s    = store.load('settings', {});
  const mins = Number(s.syncIntervalMinutes);
  if (Number.isFinite(mins) && Number.isInteger(mins) && mins >= 1 && mins <= 360) {
    return mins * 60 * 1000;
  }
  return DEFAULTS.SYNC_INTERVAL_MS;
}
function _startAutoSync() {
    if (_syncTimer) clearInterval(_syncTimer);
    const ms = _getSyncIntervalMs();
    log.info('Auto-sync interval: ' + Math.round(ms / 60000) + ' minutes');
    _syncTimer = setInterval(
      () => { if (_ctx.runFullSync) _ctx.runFullSync(); },
      ms
    );
  }
  function _stopAutoSync() {
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
  }

  // Back-fill sync entry points on ctx
  _ctx.runFullSync      = _syncEngine.runFullSync;
  _ctx.startAutoSync    = _startAutoSync;
  _ctx.triggerRescan    = _windowApi.triggerRescan;
  _ctx.reloadSchedulers = (newSlots) => scheduler.reload(newSlots);   // IPC handler calls this after saving slot config
  _ctx.reloadSyncInterval = _startAutoSync;    // settings:save-sync-interval calls this to apply immediately

  // ── 5e. Register all IPC handlers ─────────────────────────────────────────
  const { registerAllIPC } = require('./ipc');
  registerAllIPC(_ctx);
  log.info('IPC handlers registered');

  // ── 5e-ii. Fleet Brain — persistent Orcha connection ───────────────────
  try {
    const fleetBrain = require('./orcha/fleet-brain');
    fleetBrain.init();
    log.info('Fleet Brain initialized — persistent Orcha session active');
  } catch (e) { log.warn('Fleet Brain init failed (non-fatal):', e.message); }

  // ── 5f. Create main window (triggers AAP startup scrape) ──────────────────
  const { isSetupComplete } = require('../setup/state');
  if (isSetupComplete()) {
    _windowApi.createMainWindow();
    log.info('Main window created');
  } else {
    log.info('First launch — showing setup wizard');
    _windowApi.showSetupWizard();
    // wizard:complete IPC (in window/index.js) calls createMainWindow internally
  }

  // FEATURE (2026-07-23): starts polling for upcoming Zoom meetings and
  // firing desktop-notification reminders -- no-ops until the user has
  // signed in via "Sign in with Zoom" (see orcha/zoom.js isSignedIn()).
  // Guarded: Zoom wiring in window/index.js is still WIP (no credentials yet
  // to test end-to-end) -- skip silently until that function actually exists.
  if (typeof _windowApi.startZoomReminders === 'function') {
    _windowApi.startZoomReminders();
  }

  // ── 5g. Create tray ────────────────────────────────────────────────────────
  _windowApi.createTray();
  log.info('Tray created');

  // ── 5h. Scheduler — SP push + email auto-send + missed-slot catch-up ───────
  scheduler.start(_ctx);

  // ── 5i. Sleep resume → catch-up check ─────────────────────────────────────
  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep — checking missed slots (15s delay)');
    setTimeout(() => scheduler.catchUp(), 15000);
  });

  // ── 5j. Digital FAS coverage profile — derive Zila's domiciles+operators ───
  // (SCAC/carriers) from the authoritative synced fleetData at startup, then on
  // a periodic safety refresh. Sync-complete also refreshes it (see sync/index).
  // Preserves last verified coverage if a refresh is empty/failed. Non-fatal.
  try { require('./orcha/fas/coverage').start(); log.info('FAS coverage profile started'); }
  catch (e) { log.warn('FAS coverage start failed (non-fatal):', e.message); }

  log.info('Bootstrap complete');

}).catch((err) => {
  log.error('FATAL: app.whenReady() threw:', err.message, err.stack);
  app.quit();
});
