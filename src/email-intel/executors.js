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
 * Phase C registers:
 *   approve-staged payload { stagedId, acknowledgeConflictReady? } -> writes the staged fact through the ledgered
 *                  timeline writer with " (user-approved)" (needs timelineWrites; works when the legacy
 *                  autoApplyUnitUpdates opt-out is off, because an explicit approval is not "auto" apply, F2-01)
 *   reject-staged  payload { stagedId } -> marks the item rejected (local decision, no native dialog)
 *
 * Later phases extend registerAll() (send-reply, delete, ...).
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

// ── Phase C: staged facts (design 4.5, 9) ─────────────────────────────────────
const STAGED_RE = /^st_[0-9a-f]{16}$/;

function _timelineWrites() {
  try { return require('./flags').get().effective.timelineWrites === true; } catch (_) { return false; }
}

/**
 * validateStaged(kind, payload) -> { ok:true, item } | { ok:false, code:'BAD_ARG', field }
 * approve-staged: { stagedId, acknowledgeConflictReady?: boolean } (true required for conflict-ready); the item must be
 * open and carry a fact with a proposed line. reject-staged: { stagedId } of an open item.
 */
function validateStaged(kind, payload) {
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  if (typeof payload.stagedId !== 'string' || !STAGED_RE.test(payload.stagedId)) return { ok: false, code: 'BAD_ARG', field: 'stagedId' };
  if (payload.acknowledgeConflictReady !== undefined && typeof payload.acknowledgeConflictReady !== 'boolean') return { ok: false, code: 'BAD_ARG', field: 'acknowledgeConflictReady' };
  const item = require('./facts/staged').load().items[payload.stagedId];
  if (!item || item.state !== 'open') return { ok: false, code: 'BAD_ARG', field: 'stagedId' };
  if (kind === 'approve-staged') {
    if (!item.fact || !item.proposedLine) return { ok: false, code: 'BAD_ARG', field: 'stagedId' };       // a unit mention has nothing to write
    if (item.reason === 'conflict-ready' && payload.acknowledgeConflictReady !== true) return { ok: false, code: 'BAD_ARG', field: 'acknowledgeConflictReady' };
  }
  return { ok: true, item };
}

function _stagedSummary(item, verb) {
  const snap = item.canonicalSnapshot || {};
  const canon = snap.status || snap.repairPhase ? 'Canonical: ' + cleanLabel(snap.status || 'unknown', 40) + (snap.repairPhase ? ' / ' + cleanLabel(snap.repairPhase, 40) : '')
    + (snap.lastUpdateSource ? ' (last ' + cleanLabel(snap.lastUpdateSource, 20) + ' update ' + cleanLabel(snap.lastUpdateAt || 'time unknown', 40) + ')' : '') : 'Canonical: no record';
  return {
    headline: verb + ' staged update for unit ' + cleanLabel(item.unit, 20) + '?',
    detailText: [
      'Unit: ' + cleanLabel(item.unit, 20),
      'Line to write: ' + String(item.proposedLine || '(none)').slice(0, 240),
      'Evidence: "' + String((item.fact && item.fact.evidenceQuote) || '').slice(0, 200) + '"',
      'Staged because: ' + cleanLabel(item.reason, 40) + (item.detail ? ' - ' + cleanLabel(item.detail, 160) : ''),
      canon,
      item.reason === 'conflict-ready' ? 'Warning: canonical state says this unit is not ready. The line will say it is not confirmed.' : '',
    ].filter(Boolean).join('\n'),
    unit: item.unit, reason: item.reason, proposedLine: item.proposedLine,
  };
}

function _factFromItem(item) {
  const f = item.fact || {};
  return {
    kind: f.kind, item: f.item || null, value: f.value, state: f.state, date: f.date || null, amount: f.amount || null,
    assertion: f.assertion, evidence: f.evidenceQuote || '', effectiveConfidence: f.confidenceEffective, caps: f.caps || [],
  };
}

function _msgFromItem(item) {
  const p = item.provenance || {};
  try {
    const doc = require('./stores').load('messages');
    const rec = p.messageKey && doc.messages && doc.messages[p.messageKey];
    if (rec) return rec;
  } catch (_) { /* fall back to the provenance */ }
  return { messageKey: p.messageKey, conversationKey: p.conversationKey, legacyId: p.legacyId, receivedAt: p.receivedAt, receivedAtQuality: p.receivedAtQuality, from: { name: p.senderName || '' }, body: { status: p.bodyStatus } };
}

const approveStaged = {
  summarize(payload) {
    const v = validateStaged('approve-staged', payload);
    if (!v.ok) throw new Error('invalid approve-staged payload');
    return _stagedSummary(v.item, 'Apply');
  },
  async run(payload) {
    const v = validateStaged('approve-staged', payload);
    if (!v.ok) return { ok: false, code: v.code, field: v.field };
    if (!_timelineWrites()) return { ok: false, code: 'TIMELINE_DISABLED' };
    const item = v.item;
    const staged = require('./facts/staged');
    const fk = require('./facts/fact-key');
    const writer = require('./facts/timeline-writer');
    const stores = require('./stores');
    // R3.8: scope is re-checked at the moment of the write
    const cfg = require('./config').normalize(stores.load('config'));
    const index = require('./understand/scope').buildScopeIndex({ now: Date.now(), fasName: cfg.me && cfg.me.fasName });
    if (index.scopeOf(item.unit) !== 'in') return { ok: false, code: 'OUT_OF_SCOPE' };
    const fact = _factFromItem(item);
    const msg = _msgFromItem(item);
    const cls = fk.classify(fact, item.unit, Object.values(stores.load('ledger').entries || {}));
    if (cls.kind === 'duplicate') {
      staged.closeItem(item.stagedId, 'superseded', 'already-recorded');
      return { ok: true, state: 'duplicate' };
    }
    let verifiedBy = 'none';
    if (item.reason !== 'conflict-ready') {
      try { const c = require('../orcha/canonical_state').getCanonical(item.unit); verifiedBy = c && c.status === 'ready_for_pickup' ? 'canonical' : 'none'; } catch (_) { verifiedBy = 'none'; }
    }
    const r = await writer.commitFact({
      fact, unit: item.unit, msg, userApproved: true, scopeOf: index.scopeOf, now: Date.now(), canonicalSnapshot: item.canonicalSnapshot,
      evalResult: { verifiedBy, supersededEntry: cls.kind === 'supersede' ? cls.entry : null },
    });
    if (r.state === 'applied') {
      staged.closeItem(item.stagedId, 'approved', 'user-approved');
      logger.info('[email-intel] staged item approved unit=' + item.unit + ' reason=' + item.reason);
      return { ok: true, state: 'applied', line: r.line };
    }
    if (r.state === 'duplicate') { staged.closeItem(item.stagedId, 'superseded', 'already-recorded'); return { ok: true, state: 'duplicate' }; }
    if (r.state === 'filtered') return { ok: false, code: 'TIMELINE_FILTERED' };
    if (r.state === 'disabled') return { ok: false, code: 'TIMELINE_DISABLED' };
    if (r.state === 'out-of-scope') return { ok: false, code: 'OUT_OF_SCOPE' };
    return { ok: false, code: 'WRITE_FAILED' };
  },
};

const rejectStaged = {
  summarize(payload) {
    const v = validateStaged('reject-staged', payload);
    if (!v.ok) throw new Error('invalid reject-staged payload');
    return _stagedSummary(v.item, 'Reject');
  },
  async run(payload) {
    const v = validateStaged('reject-staged', payload);
    if (!v.ok) return { ok: false, code: v.code, field: v.field };
    const r = require('./facts/staged').closeItem(v.item.stagedId, 'rejected', 'user-rejected');
    if (!r.ok) return { ok: false, code: r.code || 'STORE_ERROR' };
    logger.info('[email-intel] staged item rejected unit=' + v.item.unit + ' reason=' + v.item.reason);
    return { ok: true, state: 'rejected' };
  },
};

let _registered = false;
/** registerAll(): idempotent (confirm.registerExecutor replaces a previous registration for the same kind). */
function registerAll() {
  confirm.registerExecutor('send-ready-dm', readyDm);
  confirm.registerExecutor('approve-staged', approveStaged);
  confirm.registerExecutor('reject-staged', rejectStaged);
  _registered = true;
}
function isRegistered() { return _registered && confirm.hasExecutor('send-ready-dm'); }

module.exports = { validateReadyDm, validateStaged, notifyOverlay, registerAll, isRegistered };
