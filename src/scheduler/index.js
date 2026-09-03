'use strict';
/**
 * scheduler/index.js — Weekday auto SP push + auto email (production backend).
 *
 * The central scheduler. It owns slot timing, weekday checks, catch-up on
 * startup/sleep-resume, restart recovery, and hot-reload on settings change.
 * ALL delivery work is delegated to the durable, verified pipeline
 * (scheduler/pipeline.js) which is driven by the ledger (scheduler/ledger.js).
 *
 * What changed vs the legacy scheduler (root-cause fixes):
 *   - Completed-slot dedup keys now live in the ledger and SURVIVE RESTART
 *     (the old in-memory _lastSPSlot/_lastEmailSlot were lost on restart, so a
 *     restart right after a slot could re-fire it).
 *   - Email is delivered + Sent-Items-verified in the MAIN process via the
 *     hidden OWA service. fleet:auto-email is now a STATUS-ONLY event — the
 *     renderer no longer performs the send.
 *   - SharePoint push is read-back verified and its real status is honored.
 *   - Overlap between scheduled / catch-up / manual is prevented by ledger
 *     leases + idempotency (get-or-create collapses duplicates).
 *
 * Usage (from app.js) is unchanged: start(ctx) / stop() / reload(slots) / catchUp().
 */

const logger = require('../utils/logger')('scheduler');
const store  = require('../store');
const ledger = require('./ledger');
const pipeline = require('./pipeline');

// ── State ─────────────────────────────────────────────────────────────────────
let _ctx                = null;
let _spScheduleTimer    = null;
let _emailScheduleTimer = null;

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

function _enabled(channel) {
  const s = store.load('settings', {}) || {};
  const e = s.schedulerEnabled;
  if (!e || typeof e !== 'object') return true; // default ON
  return channel === 'sp' ? e.sp !== false : e.email !== false;
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
    if (!_isWeekday() || !_enabled('sp')) return;
    const now  = new Date();
    const slot = SP_SLOTS.find(s => s.h === now.getHours() && s.m === now.getMinutes());
    if (!slot) return;
    const dateKey = _todayPrefix();
    // Ledger-backed completed-slot dedup (survives restart).
    if (ledger.isSlotCompleted(ledger.CHANNELS.SHAREPOINT, dateKey, slot.label)) return;
    _fireSP(dateKey, slot, 'scheduled');
  }, 30000);
}

function _fireSP(dateKey, slot, origin) {
  logger.info('SP push (' + origin + '): slot=' + slot.label);
  _ctx.pushStatus('\uD83D\uDCE8 SP Push: ' + slot.label + ' (' + origin + ')...');
  pipeline.runSharePointJob(_ctx, { dateKey, slotLabel: slot.label, origin, testMode: false })
    .then(r => {
      if (r.ok) _ctx.pushStatus('\u2705 SP Push verified (' + slot.label + ')');
      else if (r.blocked) _ctx.pushStatus('\u26D4 SP Push blocked: ' + r.blocked + ' (' + slot.label + ')');
      else if (r.partial) _ctx.pushStatus('\u26A0\uFE0F SP Push ' + r.partial + ' (' + slot.label + ')');
      else if (r.skipped) logger.info('SP push skipped: ' + r.skipped);
      else _ctx.pushStatus('\u274C SP Push not verified (' + slot.label + ')');
    })
    .catch(e => { logger.error('SP push error:', e.message); _ctx.pushStatus('\u274C SP Push error: ' + e.message); });
}

// ── Scheduled auto-email ──────────────────────────────────────────────────────
function _scheduleAutoEmail() {
  if (_emailScheduleTimer) clearInterval(_emailScheduleTimer);
  _emailScheduleTimer = setInterval(() => {
    if (!_isWeekday() || !_enabled('email')) return;
    const now  = new Date();
    const slot = EMAIL_SLOTS.find(s => s.h === now.getHours() && s.m === now.getMinutes());
    if (!slot) return;
    const dateKey = _todayPrefix();
    if (ledger.isSlotCompleted(ledger.CHANNELS.EMAIL, dateKey, slot.label)) return;
    _fireEmail(dateKey, slot, 'scheduled', false);
  }, 30000);
}

function _fireEmail(dateKey, slot, origin, testMode) {
  logger.info('Auto-email (' + origin + (testMode ? '/test' : '') + '): slot=' + slot.label);
  _ctx.pushStatus('\uD83D\uDCE7 Auto-email: ' + slot.label + (testMode ? ' [TEST]' : '') + ' (' + origin + ')...');
  // Status-only renderer event (execution now owned by the main process).
  try {
    _ctx.send('fleet:auto-email', { slot: slot.label, triggeredAt: new Date().toISOString(), statusOnly: true, origin, testMode: !!testMode });
  } catch (_) {}
  pipeline.runEmailSlot(_ctx, { dateKey, slotLabel: slot.label, origin, testMode: !!testMode })
    .then(r => {
      if (r.blocked === 'no-test-recipient') { _ctx.pushStatus('\u26D4 Test email blocked: configure a test recipient first'); return; }
      if (r.skipped === 'no-recipients') { _ctx.pushStatus('\u26A0\uFE0F Auto-email: no recipients configured'); return; }
      const outs = r.outcomes || [];
      const sent = outs.filter(o => o.state === ledger.STATES.COMPLETED).length;
      const blockedAuth = outs.some(o => o.state === ledger.STATES.BLOCKED_AUTH);
      const uncertain = outs.filter(o => o.state === ledger.STATES.DELIVERY_UNCERTAIN).length;
      if (blockedAuth) _ctx.pushStatus('\uD83D\uDD10 Auto-email paused: OWA sign-in required');
      else if (uncertain) _ctx.pushStatus('\u26A0\uFE0F Auto-email: ' + sent + '/' + outs.length + ' verified, ' + uncertain + ' unconfirmed');
      else _ctx.pushStatus('\u2705 Auto-email: ' + sent + '/' + outs.length + ' verified sent (' + slot.label + ')');
    })
    .catch(e => { logger.error('Auto-email error:', e.message); _ctx.pushStatus('\u274C Auto-email error: ' + e.message); });
}

// ── Missed-slot catch-up ──────────────────────────────────────────────────────
function _catchUpMissedSlots() {
  if (!_isWeekday()) return;
  const now            = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const dateKey        = _todayPrefix();

  if (_enabled('email')) EMAIL_SLOTS.forEach(slot => {
    const missedBy = currentMinutes - (slot.h * 60 + slot.m);
    if (missedBy <= 0 || missedBy > 120) return;
    if (ledger.isSlotCompleted(ledger.CHANNELS.EMAIL, dateKey, slot.label)) return;
    logger.info('Catch-up: missed email slot ' + slot.label + ' (' + missedBy + 'min ago)');
    setTimeout(() => _fireEmail(dateKey, slot, 'catchup', false), 5000);
  });

  if (_enabled('sp')) SP_SLOTS.forEach(slot => {
    const missedBy = currentMinutes - (slot.h * 60 + slot.m);
    if (missedBy <= 0 || missedBy > 120) return;
    if (ledger.isSlotCompleted(ledger.CHANNELS.SHAREPOINT, dateKey, slot.label)) return;
    logger.info('Catch-up: missed SP slot ' + slot.label + ' (' + missedBy + 'min ago)');
    setTimeout(() => _fireSP(dateKey, slot, 'catchup'), 10000);
  });
}

// ── Manual / test entry points (used by scheduler:* IPC) ───────────────────────
function runSpNow() {
  const dateKey = _todayPrefix();
  const label = 'manual-' + new Date().toTimeString().slice(0, 5);
  return pipeline.runSharePointJob(_ctx, { dateKey, slotLabel: label, origin: ledger.ORIGINS.MANUAL, testMode: false });
}

// "Run next email slot as test now" — uses the next upcoming email slot label
// (or the most recent) so the test idempotency key is meaningful.
function runNextEmailAsTest() {
  const dateKey = _todayPrefix();
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  const upcoming = EMAIL_SLOTS.filter(s => (s.h * 60 + s.m) >= now).sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m));
  const slot = upcoming[0] || EMAIL_SLOTS[EMAIL_SLOTS.length - 1] || DEFAULT_EMAIL_SLOTS[0];
  return pipeline.runEmailSlot(_ctx, { dateKey, slotLabel: slot.label, origin: ledger.ORIGINS.TEST, testMode: true });
}

// ── Public API ────────────────────────────────────────────────────────────────
function start(ctx) {
  _ctx = ctx;
  // Establish + migrate the ledger before anything reads it.
  try { ledger.migrate(); } catch (e) { logger.warn('Ledger migrate failed (non-fatal): ' + e.message); }
  _loadScheduleSlots();
  // Restart recovery: re-commit verified-but-uncommitted sends, requeue retries.
  Promise.resolve().then(() => pipeline.recover(_ctx)).catch(e => logger.warn('Recovery failed: ' + e.message));
  _scheduleAutoSPPush();
  _scheduleAutoEmail();
  _catchUpMissedSlots();
  // Prune old ledger entries occasionally.
  ledger.pruneOldJobs().catch(() => {});
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

module.exports = { start, stop, reload, catchUp, runSpNow, runNextEmailAsTest };
