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
  _stopSchedulers();
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
    // Run anomaly detection on every data push
    try {
      const { runAnomalyDetection } = require('./orcha/anomaly');
      const repairHistory = require('./orcha/repair-history');
      const rows = (d && d.rows) || [];
      if (rows.length) {
        const result = runAnomalyDetection(rows);
        if (result && result.alerts && result.alerts.length) {
          _send('orcha:alerts', result);
        // Morning briefing (first push of session)
        if (!global._briefingSent) {
          global._briefingSent = true;
          // Smart reminders — check due reminders
          const _reminderStore = store.load('reminders', []);
          const _today = new Date().toISOString().split('T')[0];
          const _due = _reminderStore.filter(function(r){ return r.when <= _today; });
          if (_due.length) {
            const reminderMsg = '\u23F0 Reminders due today:\n' + _due.map(function(r){ return '\u2022 ' + r.unit + ': ' + r.note; }).join('\n');
            _send('orcha:morning-briefing', { text: reminderMsg, critical: 0, warnings: _due.length, isReminder: true });
            // Remove fired reminders
            const remaining = _reminderStore.filter(function(r){ return r.when > _today; });
            store.save('reminders', remaining);
          }
          // Auto-classify: flag units needing classification
          const needsClassify = rows.filter(function(r) {
            return (r.lifecycleState||'').toLowerCase().includes('unavail') && !r.savedRepairStatus;
          });
          if (needsClassify.length) {
            log.info('[auto-classify] ' + needsClassify.length + ' units need repair status classification');
          }
          const critical = (result.alerts || []).filter(function(a){ return a.severity === 'critical'; });
          const warnings = (result.alerts || []).filter(function(a){ return a.severity === 'warning'; });
          const briefingText = (critical.length + warnings.length) > 0
            ? '☀️ Morning Briefing: ' + critical.length + ' critical, ' + warnings.length + ' warnings.\n' +
              critical.slice(0,5).map(function(a){ return '🔴 ' + a.unit + ' — ' + a.message; }).join('\n') +
              (warnings.length ? '\n' + warnings.slice(0,5).map(function(a){ return '⚠️ ' + a.unit + ' — ' + a.message; }).join('\n') : '')
            : '☀️ Morning Briefing: Fleet is healthy — no critical issues.';
          _send('orcha:morning-briefing', { text: briefingText, critical: critical.length, warnings: warnings.length });
        }
        // Generate action recommendations from alerts
        const recs = (result.alerts || []).filter(a => a.suggestion).map(a => ({
          unit: a.unit,
          type: a.type,
          action: a.suggestion,
          severity: a.severity,
          message: a.message
        }));
        if (recs.length) _send('orcha:recommendations', { recommendations: recs });
        // Detect repair completions (unavail -> available transitions)
        try { repairHistory.detectTransitions(rows, global._prevRows || []); } catch(e) {}
        global._prevRows = rows;
        _send('orcha:health', { overallScore: Math.max(0, 100 - (recs.filter(function(a){return a.severity==="critical"}).length * 5)), lastSync: new Date().toISOString(), totalUnits: (d && d.rows) ? d.rows.length : 0, unavailCount: recs.length, integrations: { relay: {status:'green',label:'Relay'}, ai: {status:'green',label:'AI'}, sp: {status:'green',label:'SharePoint'}, slack: {status:'green',label:'Slack'} } });
        }
      }
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
      const relay = require('./orcha/relay');
      offline.processQueue(async (unit, raw) => {
        try { const r = await relay.ask('Rewrite this fleet timeline entry professionally in 1 sentence (keep date prefix): ' + raw); return r || raw; }
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
  _ctx.reloadSchedulers = _reloadSchedulers;   // IPC handler calls this after saving slot config
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

  // ── 5g. Create tray ────────────────────────────────────────────────────────
  _windowApi.createTray();
  log.info('Tray created');

  // ── 5h. Scheduler — SP push + email auto-send + missed-slot catch-up ───────
  _ctxRef = _ctx;  // expose ctx to module-scope scheduler functions
  _startSchedulers();

  // ── 5i. Sleep resume → catch-up check ─────────────────────────────────────
  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep — checking missed slots (15s delay)');
    setTimeout(() => _catchUpMissedSlots(), 15000);
  });

  log.info('Bootstrap complete');

}).catch((err) => {
  log.error('FATAL: app.whenReady() threw:', err.message, err.stack);
  app.quit();
});

// =============================================================================
// Scheduler — weekday auto SP push + auto email
// Extracted to module scope so _stopSchedulers() can reach the timers.
// =============================================================================

let _ctxRef             = null;  // set before _startSchedulers(); bridges closure to module scope
let _spScheduleTimer    = null;
let _emailScheduleTimer = null;
let _lastSPSlot         = '';
let _lastEmailSlot      = '';

// Slot defaults — used when no saved config exists
const _DEFAULT_SP_SLOTS    = [{ h: 7,  m: 30, label: '07:30' }, { h: 15, m: 30, label: '15:30' }];
const _DEFAULT_EMAIL_SLOTS = [{ h: 8,  m: 0,  label: '08:00' }, { h: 15, m: 15, label: '15:15' }];

// Live slot arrays — mutated by _loadScheduleSlots() and reloadSchedulers()
let SP_SLOTS    = _DEFAULT_SP_SLOTS.slice();
let EMAIL_SLOTS = _DEFAULT_EMAIL_SLOTS.slice();

// Load saved slot config from store (falls back to defaults if not set)
function _loadScheduleSlots() {
  try {
    const store   = require('./store');
    const saved   = store.load('settings', {}).schedulerSlots;
    if (saved && Array.isArray(saved.sp) && Array.isArray(saved.email)) {
      SP_SLOTS    = saved.sp;
      EMAIL_SLOTS = saved.email;
      log.info('Scheduler slots loaded from config — SP:', SP_SLOTS.map(s=>s.label), 'Email:', EMAIL_SLOTS.map(s=>s.label));
    }
  } catch (e) {
    log.warn('Could not load scheduler slot config, using defaults:', e.message);
  }
}

function _todayPrefix() {
  const n = new Date();
  return n.getFullYear() + '-' +
    String(n.getMonth() + 1).padStart(2, '0') + '-' +
    String(n.getDate()).padStart(2, '0');
}

function _isWeekday() {
  const d = new Date().getDay();
  return d >= 1 && d <= 5;
}

// ── Scheduled SP push — weekdays 07:30 + 15:30 ───────────────────────────────
function _scheduleAutoSPPush() {
  if (_spScheduleTimer) clearInterval(_spScheduleTimer);
  _spScheduleTimer = setInterval(() => {
    if (!_isWeekday()) return;
    const now  = new Date();
    const hh   = now.getHours(), mm = now.getMinutes();
    const slot = SP_SLOTS.find(s => s.h === hh && s.m === mm);
    if (!slot) return;

    const dateKey = _todayPrefix() + '-SP-' + slot.label;
    if (_lastSPSlot === dateKey) return;
    _lastSPSlot = dateKey;

    log.info('Auto SP Push triggered: slot=' + slot.label);
    _ctxRef.pushStatus('\uD83D\uDCE8 Auto SP Push: syncing for ' + slot.label + '...');

    _ctxRef.runFullSync().then(() => {
      const rows = _ctxRef.lastData && _ctxRef.lastData.rows;
      if (!rows) return;
      const { pushToSharePoint } = require('./scrapers/sharepoint_push');
      const win = _ctxRef.getMainWindow();
      pushToSharePoint(rows, (msg, type) => {
        log.info('[SP Auto] ' + (type || 'info') + ' | ' + msg);
        if (win && !win.isDestroyed())
          win.webContents.send('sp:progress', { message: msg, type });
      }).then(result => {
        log.info('Auto SP Push complete (' + slot.label + '): ' + (result.ok ? 'SUCCESS' : result.error));
        _ctxRef.pushStatus('\u2705 SP Push complete (' + slot.label + ')');
      }).catch(err => {
        log.error('Auto SP Push error:', err.message);
        _ctxRef.pushStatus('\u274C SP Push failed: ' + err.message);
      });
    }).catch(err => {
      log.error('Auto SP Push sync failed:', err.message);
    });
  }, 30000);
}

// ── Scheduled auto-email — weekdays 08:00 + 15:15 ────────────────────────────
function _scheduleAutoEmail() {
  if (_emailScheduleTimer) clearInterval(_emailScheduleTimer);
  _emailScheduleTimer = setInterval(() => {
    if (!_isWeekday()) return;
    const now  = new Date();
    const hh   = now.getHours(), mm = now.getMinutes();
    const slot = EMAIL_SLOTS.find(s => s.h === hh && s.m === mm);
    if (!slot) return;

    const dateKey = _todayPrefix() + '-' + slot.label;
    if (_lastEmailSlot === dateKey) return;
    _lastEmailSlot = dateKey;

    log.info('Auto-email triggered: slot=' + slot.label);
    // FEATURE (2026-07-16): persisted "Auto-Email Note" — set once in
    // Settings, rides along with every scheduled auto-send until cleared.
    // If "one-shot" is checked, capture it for THIS send then immediately
    // clear it so it doesn't carry into the next slot. Read fresh (not
    // cached) so edits made between slots take effect right away.
    const _settingsNow = store.load('settings', {});
    const autoEmailNote = _settingsNow.autoEmailNote || '';
    if (autoEmailNote && _settingsNow.autoEmailNoteOneShot) {
      delete _settingsNow.autoEmailNote;
      _settingsNow.autoEmailNoteOneShot = false;
      store.save('settings', _settingsNow);
      log.info('Auto-email note was one-shot — cleared after capturing for this send');
    }
    _ctxRef.pushStatus('\uD83D\uDCE7 Auto-email: syncing for ' + slot.label + ' report...');

    _ctxRef.runFullSync().then(() => {
      setTimeout(() => {
        _ctxRef.send('fleet:auto-email', {
          slot: slot.label,
          triggeredAt: new Date().toISOString(),
          autoEmailNote,
        });
      }, 2000);
    }).catch(err => {
      log.warn('Auto-email sync failed:', err.message);
      _ctxRef.send('fleet:auto-email', {
        slot: slot.label,
        triggeredAt: new Date().toISOString(),
        syncError: err.message,
        autoEmailNote,
      });
    });
  }, 30000);
}

// ── Missed-slot catch-up — fires on startup and on sleep resume ───────────────
function _catchUpMissedSlots() {
  if (!_isWeekday()) return;

  const now            = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const prefix         = _todayPrefix();

  EMAIL_SLOTS.forEach(slot => {
    const slotMin  = slot.h * 60 + slot.m;
    const missedBy = currentMinutes - slotMin;
    if (missedBy <= 0 || missedBy > 120) return;
    const dateKey = prefix + '-' + slot.label;
    if (_lastEmailSlot === dateKey) return;
    _lastEmailSlot = dateKey;
    log.info('Catch-up: missed email slot ' + slot.label + ' (' + missedBy + 'min ago)');
    _ctxRef.pushStatus('\u23F0 Catch-up: sending ' + slot.label + ' email (missed ' + missedBy + 'min ago)...');
    setTimeout(() => {
      try {
        const rows = _ctxRef.lastData && _ctxRef.lastData.rows;
        if (rows) {
          // BUG FIX (2026-07-16): this block previously called
          // composeAndSendEmail(rows, win), a function that does not exist
          // anywhere in email_sender.js's exports (confirmed exports:
          // sendFleetEmail, loadEmailConfig, saveEmailConfig, CONFIG_FILE
          // only). Every missed-slot catch-up email has silently failed
          // since this code was written -- caught by the try/catch below,
          // logged as "Catch-up email failed: ... is not a function", with
          // no functional recovery. Fix: fire the same fleet:auto-email
          // event the on-time scheduler uses (_scheduleAutoEmail above) so
          // the catch-up path reuses the real, tested renderer-side compose
          // logic (recipient lookup, OWA compose, subject building, SOS/EOS
          // slot labeling) instead of a second, separate, broken path.
          const _settingsNow2  = store.load('settings', {});
          const autoEmailNote2 = _settingsNow2.autoEmailNote || '';
          if (autoEmailNote2 && _settingsNow2.autoEmailNoteOneShot) {
            delete _settingsNow2.autoEmailNote;
            _settingsNow2.autoEmailNoteOneShot = false;
            store.save('settings', _settingsNow2);
          }
          _ctxRef.send('fleet:auto-email', {
            slot: slot.label,
            triggeredAt: new Date().toISOString(),
            autoEmailNote: autoEmailNote2,
            catchUp: true,
          });
        }
      } catch (e) { log.error('Catch-up email failed:', e.message); }
    }, 5000);
  });

  SP_SLOTS.forEach(slot => {
    const slotMin  = slot.h * 60 + slot.m;
    const missedBy = currentMinutes - slotMin;
    if (missedBy <= 0 || missedBy > 120) return;
    const dateKey = prefix + '-SP-' + slot.label;
    if (_lastSPSlot === dateKey) return;
    _lastSPSlot = dateKey;
    log.info('Catch-up: missed SP slot ' + slot.label + ' (' + missedBy + 'min ago)');
    _ctxRef.pushStatus('\u23F0 Catch-up: SP push for ' + slot.label + ' (missed ' + missedBy + 'min ago)...');
    setTimeout(() => {
      try {
        const rows = _ctxRef.lastData && _ctxRef.lastData.rows;
        if (rows) {
          const { pushToSharePoint } = require('./scrapers/sharepoint_push');
          pushToSharePoint(rows, (msg) => log.info('[SP Catch-up] ' + msg));
        }
      } catch (e) { log.error('Catch-up SP push failed:', e.message); }
    }, 10000);
  });
}

function _startSchedulers() {
  _loadScheduleSlots();
  _scheduleAutoSPPush();
  _scheduleAutoEmail();
  _catchUpMissedSlots();
  log.info('Schedulers started — SP:', SP_SLOTS.map(s=>s.label), 'Email:', EMAIL_SLOTS.map(s=>s.label));
}

function _stopSchedulers() {
  if (_spScheduleTimer)    { clearInterval(_spScheduleTimer);    _spScheduleTimer    = null; }
  if (_emailScheduleTimer) { clearInterval(_emailScheduleTimer); _emailScheduleTimer = null; }
}

// Called by IPC handler when user saves new slot config
function _reloadSchedulers(newSlots) {
  if (newSlots && newSlots.sp)    SP_SLOTS    = newSlots.sp;
  if (newSlots && newSlots.email) EMAIL_SLOTS = newSlots.email;
  _stopSchedulers();
  _startSchedulers();
  log.info('Schedulers reloaded with new slot config');
}
