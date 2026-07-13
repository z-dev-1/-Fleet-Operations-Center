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
  function _midwayAutoRefresh() {
    _midwayRefreshTimer = setInterval(async () => {
      try {
        const state = _authModule.checkMwinit();
        if (state.ok && state.expiresInMin !== null && state.expiresInMin < 15) {
          logger.info('[midway] Cookies expire in ' + state.expiresInMin + 'min — auto-renewing');
          _send('app:midway-renewing', { expiresIn: state.expiresInMin });
          await _authModule.runMwinit();
          await _authModule.injectCookies();
          logger.info('[midway] Auto-renewed successfully');
          _send('app:midway-renewed', {});
        } else if (!state.ok) {
          logger.warn('[midway] Cookies expired — launching mwinit');
          _send('app:midway-expired', {});
          await _authModule.runMwinit();
          await _authModule.injectCookies();
          _send('app:midway-renewed', {});
        }
      } catch (e) {
        logger.error('[midway] Auto-refresh failed: ' + e.message);
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

  // ── 5d. Sync engine ────────────────────────────────────────────────────────
  const { createSyncEngine } = require('./sync');
  const _syncEngine = createSyncEngine(_ctx);

  // Auto-sync timer
  let _syncTimer = null;
  function _startAutoSync() {
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(
      () => { if (_ctx.runFullSync) _ctx.runFullSync(); },
      DEFAULTS.SYNC_INTERVAL_MS
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
    _ctxRef.pushStatus('\uD83D\uDCE7 Auto-email: syncing for ' + slot.label + ' report...');

    _ctxRef.runFullSync().then(() => {
      setTimeout(() => {
        _ctxRef.send('fleet:auto-email', {
          slot: slot.label,
          triggeredAt: new Date().toISOString(),
        });
      }, 2000);
    }).catch(err => {
      log.warn('Auto-email sync failed:', err.message);
      _ctxRef.send('fleet:auto-email', {
        slot: slot.label,
        triggeredAt: new Date().toISOString(),
        syncError: err.message,
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
          const { composeAndSendEmail } = require('./scrapers/email_sender');
          composeAndSendEmail(rows, _ctxRef.getMainWindow());
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
