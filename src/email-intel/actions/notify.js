'use strict';
/**
 * email-intel/actions/notify.js — notify once, escalation only (design 5.4; R4.12, AC-C, AC-I).
 *
 *   eligible(item)                -> boolean
 *   buildMessage(items)           -> { title, body }   counts and unit ids only, never email content
 *   notifyPending({ now, osNotify, push }) -> { notified, body|null }   at most ONE OS notification per call (per scan)
 *
 * Eligible: open items with no notification yet (or a new escalation since the last one) in
 *   reply (required), decision (required or suggested), review with a conflict-* reason, followup (overdue).
 * Never: recorded, info, outofscope, suggested reply, closed / dismissed / snoozed items. Items whose question was
 * answered never exist as open items (derive.js), so an answered question is never notified (case I).
 * Delivery: the in-app push `emailIntel:updated` plus an optional OS notification (electron Notification, as in
 * ipc/misc.js). When the platform has no notification support only the in-app badge counts are updated.
 */
const store = require('./store');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const UNITS_MAX = 6;

function eligible(item) {
  const x = item || {};
  if (x.state !== 'open') return false;
  const kind = (x.category === 'reply' && x.tier === 'required') || x.category === 'decision'
    || (x.category === 'review' && /^conflict-/.test(String(x.reasonCode || ''))) || x.category === 'followup';
  if (!kind) return false;
  return !x.notifiedAt || (x.escalations || 0) > (x.notifiedEscalations || 0);
}

const _plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function buildMessage(items) {
  const by = { reply: 0, decision: 0, followup: 0, review: 0 };
  const units = [];
  for (const x of items || []) {
    if (by[x.category] !== undefined) by[x.category]++;
    for (const u of x.units || []) { const id = String(u).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20); if (id && !units.includes(id)) units.push(id); }
  }
  const parts = [];
  if (by.decision) parts.push(_plural(by.decision, 'item needs your decision', 'items need your decision'));
  if (by.reply) parts.push(_plural(by.reply, 'reply needed', 'replies needed'));
  if (by.followup) parts.push(_plural(by.followup, 'follow-up overdue', 'follow-ups overdue'));
  if (by.review) parts.push(_plural(by.review, 'conflicting update to review', 'conflicting updates to review'));
  const u = units.length ? ' (' + units.slice(0, UNITS_MAX).join(', ') + (units.length > UNITS_MAX ? ', +' + (units.length - UNITS_MAX) : '') + ')' : '';
  return { title: 'My Email Actions', body: (parts.join('; ') + u).slice(0, 256) };
}

function _defaultOsNotify(msg) {
  let electron = null;
  try { electron = require('electron'); } catch (_) { electron = null; }
  const N = electron && electron.Notification;
  if (!N || typeof N.isSupported !== 'function' || !N.isSupported()) return false;
  const n = new N({ title: String(msg.title).slice(0, 64), body: String(msg.body).slice(0, 256), silent: false });
  n.show();
  return true;
}

/**
 * notifyPending({ now, osNotify(msg)->bool, push(payload) }) — marks every eligible item notified (once per
 * escalation) in the store, then sends ONE batched OS notification.
 */
function notifyPending(o) {
  const opts = o || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let picked = [];
  const r = store.update((doc) => {
    picked = Object.values(doc.items).filter(eligible);
    for (const x of picked) {
      x.notifiedAt = new Date(now).toISOString();
      x.notifyCount = (x.notifyCount || 0) + 1;
      x.notifiedEscalations = x.escalations || 0;
    }
    return picked.length;
  });
  if (!r.ok) { logger.warn('[email-intel] notify skipped: actions store ' + String(r.code || 'error')); return { notified: 0, body: null }; }
  if (!picked.length) return { notified: 0, body: null };
  const msg = buildMessage(picked);
  let shown = false;
  try { shown = (typeof opts.osNotify === 'function' ? opts.osNotify : _defaultOsNotify)(msg) !== false; } catch (_) { shown = false; }
  try { if (typeof opts.push === 'function') opts.push({ kind: 'actions', notified: picked.length }); } catch (_) { /* push only */ }
  logger.info('[email-intel] actions notified items=' + picked.length + ' os=' + (shown ? 'yes' : 'no'));
  return { notified: picked.length, body: msg.body };
}

module.exports = { eligible, buildMessage, notifyPending };
