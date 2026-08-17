'use strict';
/**
 * scheduler/index.js — Weekday auto SP push + auto email
 *
 * Extracted from src/app.js (Phase 4) for maintainability.
 * Owns all scheduled-push logic: slot config, weekday checks,
 * catch-up on startup/sleep-resume, and reload on settings change.
 *
 * Usage (from app.js):
 *   const scheduler = require('./scheduler');
 *   scheduler.start(ctx);          // after sync engine + IPC are wired
 *   scheduler.stop();              // on before-quit
 *   scheduler.reload(newSlots);    // from settings IPC handler
 */

const logger = require('../utils/logger')('scheduler');
const store  = require('../store');

// ── State ─────────────────────────────────────────────────────────────────────
let _ctx                = null;
let _spScheduleTimer    = null;
let _emailScheduleTimer = null;
let _lastSPSlot         = '';
let _lastEmailSlot      = '';

// Slot defaults — used when no saved config exists
const DEFAULT_SP_SLOTS    = [{ h: 7,  m: 30, label: '07:30' }, { h: 15, m: 30, label: '15:30' }];
const DEFAULT_EMAIL_SLOTS = [{ h: 8,  m: 0,  label: '08:00' }, { h: 15, m: 15, label: '15:15' }];

let SP_SLOTS    = DEFAULT_SP_SLOTS.slice();
let EMAIL_SLOTS = DEFAULT_EMAIL_SLOTS.slice();

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function _loadScheduleSlots() {
  try {
    const saved = store.load('settings', {}).schedulerSlots;
    if (saved && Array.isArray(saved.sp) && Array.isArray(saved.email)) {
      SP_SLOTS    = saved.sp;
      EMAIL_SLOTS = saved.email;
      logger.info('Scheduler slots loaded from config — SP:', SP_SLOTS.map(s=>s.label), 'Email:', EMAIL_SLOTS.map(s=>s.label));
    }
  } catch (e) {
    logger.warn('Could not load scheduler slot config, using defaults:', e.message);
  }
}

// ── Scheduled SP push ─────────────────────────────────────────────────────────
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

    logger.info('Auto SP Push triggered: slot=' + slot.label);
    _ctx.pushStatus('\uD83D\uDCE8 Auto SP Push: syncing for ' + slot.label + '...');

    _ctx.runFullSync().then(() => {
      const rows = _ctx.lastData && _ctx.lastData.rows;
      if (!rows) return;
      const { pushToSharePoint } = require('../scrapers/sharepoint_push');
      const win = _ctx.getMainWindow();
      pushToSharePoint(rows, (msg, type) => {
        logger.info('[SP Auto] ' + (type || 'info') + ' | ' + msg);
        if (win && !win.isDestroyed())
          win.webContents.send('sp:progress', { message: msg, type });
      }).then(result => {
        logger.info('Auto SP Push complete (' + slot.label + '): ' + (result.ok ? 'SUCCESS' : result.error));
        _ctx.pushStatus('\u2705 SP Push complete (' + slot.label + ')');
      }).catch(err => {
        logger.error('Auto SP Push error:', err.message);
        _ctx.pushStatus('\u274C SP Push failed: ' + err.message);
      });
    }).catch(err => {
      logger.error('Auto SP Push sync failed:', err.message);
    });
  }, 30000);
}

// ── Scheduled auto-email ──────────────────────────────────────────────────────
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

    logger.info('Auto-email triggered: slot=' + slot.label);
    const _settingsNow = store.load('settings', {});
    const autoEmailNote = _settingsNow.autoEmailNote || '';
    if (autoEmailNote && _settingsNow.autoEmailNoteOneShot) {
      delete _settingsNow.autoEmailNote;
      _settingsNow.autoEmailNoteOneShot = false;
      store.save('settings', _settingsNow);
      logger.info('Auto-email note was one-shot — cleared after capturing for this send');
    }
    _ctx.pushStatus('\uD83D\uDCE7 Auto-email: syncing for ' + slot.label + ' report...');

    _ctx.runFullSync().then(() => {
      const _fd      = store.load('fleetData', {});
      const _rows    = (_fd && Array.isArray(_fd.rows)) ? _fd.rows : [];
      const _uptakeN = _rows.filter(r => r.riskScore && r.riskScore > 0).length;
      const _ageMin  = _fd.syncedAt
        ? Math.round((Date.now() - new Date(_fd.syncedAt).getTime()) / 60000)
        : 9999;

      if (_rows.length < 3) {
        logger.warn('Auto-email SKIPPED: fleet data has only ' + _rows.length + ' units — possibly empty or sync failed before data loaded');
        _ctx.pushStatus('⚠️ Auto-email skipped: no fleet data available (' + _rows.length + ' units)');
        return;
      }

      const _dataNote = _uptakeN > 0
        ? _uptakeN + ' Uptake-scored units included'
        : 'no Uptake risk scores available';
      logger.info('Auto-email data ready: ' + _rows.length + ' units, ' + _dataNote + ', synced ' + _ageMin + 'min ago');

      setTimeout(() => {
        _ctx.send('fleet:auto-email', {
          slot: slot.label,
          triggeredAt: new Date().toISOString(),
          autoEmailNote,
          dataRowCount: _rows.length,
          dataUptakeCount: _uptakeN,
          dataAgeMins: _ageMin,
        });
      }, 2000);
    }).catch(err => {
      logger.warn('Auto-email sync failed:', err.message);
      const _fd2   = store.load('fleetData', {});
      const _rows2 = (_fd2 && Array.isArray(_fd2.rows)) ? _fd2.rows : [];
      if (_rows2.length < 3) {
        logger.warn('Auto-email SKIPPED after sync failure: no usable cached data (' + _rows2.length + ' units)');
        _ctx.pushStatus('⚠️ Auto-email skipped: sync failed and no cached data available');
        return;
      }
      logger.info('Auto-email using cached data after sync failure: ' + _rows2.length + ' units');
      _ctx.send('fleet:auto-email', {
        slot: slot.label,
        triggeredAt: new Date().toISOString(),
        syncError: err.message,
        autoEmailNote,
        dataRowCount: _rows2.length,
      });
    });
  }, 30000);
}

// ── Missed-slot catch-up ──────────────────────────────────────────────────────
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
    logger.info('Catch-up: missed email slot ' + slot.label + ' (' + missedBy + 'min ago)');
    _ctx.pushStatus('\u23F0 Catch-up: sending ' + slot.label + ' email (missed ' + missedBy + 'min ago)...');
    setTimeout(() => {
      try {
        const rows = _ctx.lastData && _ctx.lastData.rows;
        if (rows) {
          const _settingsNow2  = store.load('settings', {});
          const autoEmailNote2 = _settingsNow2.autoEmailNote || '';
          if (autoEmailNote2 && _settingsNow2.autoEmailNoteOneShot) {
            delete _settingsNow2.autoEmailNote;
            _settingsNow2.autoEmailNoteOneShot = false;
            store.save('settings', _settingsNow2);
          }
          _ctx.send('fleet:auto-email', {
            slot: slot.label,
            triggeredAt: new Date().toISOString(),
            autoEmailNote: autoEmailNote2,
            catchUp: true,
          });
        }
      } catch (e) { logger.error('Catch-up email failed:', e.message); }
    }, 5000);
  });

  SP_SLOTS.forEach(slot => {
    const slotMin  = slot.h * 60 + slot.m;
    const missedBy = currentMinutes - slotMin;
    if (missedBy <= 0 || missedBy > 120) return;
    const dateKey = prefix + '-SP-' + slot.label;
    if (_lastSPSlot === dateKey) return;
    _lastSPSlot = dateKey;
    logger.info('Catch-up: missed SP slot ' + slot.label + ' (' + missedBy + 'min ago)');
    _ctx.pushStatus('\u23F0 Catch-up: SP push for ' + slot.label + ' (missed ' + missedBy + 'min ago)...');
    setTimeout(() => {
      try {
        const rows = _ctx.lastData && _ctx.lastData.rows;
        if (rows) {
          const { pushToSharePoint } = require('../scrapers/sharepoint_push');
          pushToSharePoint(rows, (msg) => logger.info('[SP Catch-up] ' + msg));
        }
      } catch (e) { logger.error('Catch-up SP push failed:', e.message); }
    }, 10000);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(ctx) {
  _ctx = ctx;
  _loadScheduleSlots();
  _scheduleAutoSPPush();
  _scheduleAutoEmail();
  _catchUpMissedSlots();
  logger.info('Schedulers started — SP:', SP_SLOTS.map(s=>s.label), 'Email:', EMAIL_SLOTS.map(s=>s.label));
}

function stop() {
  if (_spScheduleTimer)    { clearInterval(_spScheduleTimer);    _spScheduleTimer    = null; }
  if (_emailScheduleTimer) { clearInterval(_emailScheduleTimer); _emailScheduleTimer = null; }
}

function reload(newSlots) {
  if (newSlots && newSlots.sp)    SP_SLOTS    = newSlots.sp;
  if (newSlots && newSlots.email) EMAIL_SLOTS = newSlots.email;
  stop();
  start(_ctx);
  logger.info('Schedulers reloaded with new slot config');
}

function catchUp() {
  _catchUpMissedSlots();
}

module.exports = { start, stop, reload, catchUp };
