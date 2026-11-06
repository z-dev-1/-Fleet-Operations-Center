'use strict';
/**
 * email-intel/executors.js — the ONLY place (with later reply/delete executors) where a consequential
 * action is performed on the user's behalf. Each executor is registered with confirm.registerExecutor
 * and runs only after a single-use token AND an accepted native main-process dialog (design 1.7, F-18).
 *
 * Phase A registers:
 *   send-ready-dm  payload { id: legacy email id, unit, message }  -> posts the operator "unit ready" DM
 *                  through the unchanged email_actions.sendReadyDm and marks the record readyDmSent.
 *
 * Later phases extend registerAll() (send-reply, delete, approve-staged, ...).
 */
const confirm = require('./confirm');
const { cleanLabel } = confirm;
const { safeErr } = require('./redact');
let logger;
try { logger = require('../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const ID_RE = /^em_[0-9a-z]+$/i;

function _isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/**
 * validateReadyDm(payload, results) -> { ok:true, email, ref } | { ok:false, code:'BAD_ARG', field }
 * Shared by prepare-action (validation) and the executor (re-check at run time).
 */
function validateReadyDm(payload, results) {
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  const { id, unit, message } = payload;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, code: 'BAD_ARG', field: 'id' };
  if (typeof unit !== 'string' || !unit.trim() || unit.length > 20) return { ok: false, code: 'BAD_ARG', field: 'unit' };
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) return { ok: false, code: 'BAD_ARG', field: 'message' };
  const emails = (results && Array.isArray(results.emails)) ? results.emails : [];
  const email = emails.find((e) => e.id === id);
  if (!email) return { ok: false, code: 'BAD_ARG', field: 'id' };
  const ref = (email.unitRefs || []).find((u) => u.unit === unit);
  if (!ref) return { ok: false, code: 'BAD_ARG', field: 'unit' };
  if (ref.ready !== true) return { ok: false, code: 'BAD_ARG', field: 'unit' };       // only a verified-ready unit may be offered
  return { ok: true, email, ref };
}

function notifyOverlay(results) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('emailTriage:updated', results);
  } catch (_) { /* overlay push only */ }
}

function _results() { return require('../scrapers/email_triage').loadResults(); }

const readyDm = {
  summarize(payload) {
    const check = validateReadyDm(payload, _results());
    if (!check.ok) throw new Error('invalid ready-dm payload');
    const who = check.ref.operator ? ' to ' + cleanLabel(check.ref.operator) : '';
    return {
      headline: 'Send ready message' + who + ' about unit ' + cleanLabel(payload.unit, 20) + '?',
      detailText: 'Unit: ' + cleanLabel(payload.unit, 20) + '\nMessage:\n' + String(payload.message).trim().slice(0, 1200),
    };
  },
  async run(payload) {
    const results = _results();
    const check = validateReadyDm(payload, results);
    if (!check.ok) return { ok: false, code: check.code, field: check.field };
    const actions = require('../scrapers/email_actions');
    const r = await actions.sendReadyDm(check.ref, String(payload.message).trim(), {});
    if (r && r.ok) {
      try {
        const store = require('../store');
        const fresh = _results();
        const idx = fresh.emails.findIndex((e) => e.id === payload.id);
        if (idx !== -1) {
          const refs = (fresh.emails[idx].unitRefs || []).map((u) => (u.unit === payload.unit ? { ...u, readyDmSent: true } : u));
          fresh.emails[idx] = { ...fresh.emails[idx], unitRefs: refs, readyDmSent: true };
          store.save('emailTriageResults', fresh);
          notifyOverlay(fresh);
        }
      } catch (e) { logger.warn('[email-intel] ready-dm bookkeeping failed ' + safeErr(e)); }
    }
    return r;
  },
};

let _registered = false;
/** registerAll(): idempotent (confirm.registerExecutor replaces a previous registration for the same kind). */
function registerAll() {
  confirm.registerExecutor('send-ready-dm', readyDm);
  _registered = true;
}
function isRegistered() { return _registered && confirm.hasExecutor('send-ready-dm'); }

module.exports = { validateReadyDm, notifyOverlay, registerAll, isRegistered };
