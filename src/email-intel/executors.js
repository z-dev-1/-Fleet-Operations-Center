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
 * Phase D registers:
 *   delete         payload { conversationKey }      -> owa_reader.deleteMessage (moves to Deleted Items), legacy
 *                  recordDeletion + deleted flag, the conversation's live action items close
 *   delete-batch   payload { conversationKeys[1..25] } -> the same, one target at a time; targets that fail the
 *                  rule are excluded and listed in the confirmation summary
 *   The rule (deleteTarget, R7.6): real conversation id (derived keys excluded), no open action, no question or
 *   decision for me, at most one message without a message-level id.
 *
 * Later phases extend registerAll() (send-reply, ...).
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

// ── Phase D: delete / delete-batch (design 9, F-19; R7.5, R7.6) ───────────────
const CONV_RE = /^cv_[0-9a-f]{16}$/;
const BATCH_MAX = 25;
const DELETE_REASON_TEXT = Object.freeze({
  'unknown-conversation': 'this conversation is not in the app\'s mail ledger',
  'no-conversation-id': 'Outlook gave no real conversation id',
  'open-action': 'it still has an open action for you',
  'question-to-me': 'it has a question or decision for you',
  'multi-message-without-ids': 'several messages have no message-level id',
  'already-deleted': 'it is already deleted',
});

/**
 * deleteTarget(conversationKey) -> { ok:true, target } | { ok:false, reason }
 * The R7.6 rule for a user-chosen delete: a real (not derived) Outlook conversation id, no open action item and
 * no question or decision for me, and at most one message without a message-level id. Fleet-relevant mail may be
 * deleted by the user (the recorded facts and evidence stay in the app) and the summary says so.
 */
function deleteTarget(conversationKey) {
  const stores = require('./stores');
  const ledger = require('./ingest/ledger');
  const recs = ledger.conversation(ledger.ensureDoc(stores.load('messages')), conversationKey);
  if (!recs.length) return { ok: false, reason: 'unknown-conversation' };
  const latest = recs[recs.length - 1];
  if (latest.convIdSource === 'derived' || !latest.convIdRaw) return { ok: false, reason: 'no-conversation-id' };
  try {
    const as = require('./actions/store');
    if (as.openActionsFor(as.load(), conversationKey) > 0) return { ok: false, reason: 'open-action' };
  } catch (_) { /* no action store: the determinations below still apply */ }
  const units = new Set();
  for (const r of recs) {
    const a = r.analysis || {};
    const d = a.determinations;
    if (d && (d.replyRequirement.value === 'required' || d.decisionRequirement.value !== 'none')) return { ok: false, reason: 'question-to-me' };
    for (const u of ((a.deterministic && a.deterministic.units) || [])) if (u.scope === 'in' || u.scope === 'unknown') units.add(u.unit);
  }
  if (recs.filter((r) => r.messageIdSource !== 'owa-item').length > 1) return { ok: false, reason: 'multi-message-without-ids' };
  let legacy = null;
  try { legacy = (_results().emails || []).find((e) => e.id === latest.legacyId) || null; } catch (_) { legacy = null; }
  if (legacy && legacy.deleted) return { ok: false, reason: 'already-deleted' };
  return {
    ok: true,
    target: {
      conversationKey, convId: latest.convIdRaw, folder: latest.folder || 'Inbox', legacyId: latest.legacyId || null, legacy,
      senderName: (latest.from && latest.from.name) || '', subject: latest.subject || '', messages: recs.length, units: Array.from(units).slice(0, 10),
    },
  };
}

/**
 * validateDelete(kind, payload) -> { ok:true, targets, excluded } | { ok:false, code:'BAD_ARG', field, reason? }
 *   delete:       { conversationKey: /^cv_[0-9a-f]{16}$/ }
 *   delete-batch: { conversationKeys: 1..25 unique conversationKeys } (failing targets are excluded and listed)
 */
function validateDelete(kind, payload) {
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  if (kind === 'delete') {
    if (typeof payload.conversationKey !== 'string' || !CONV_RE.test(payload.conversationKey)) return { ok: false, code: 'BAD_ARG', field: 'conversationKey' };
    const t = deleteTarget(payload.conversationKey);
    if (!t.ok) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: t.reason };
    return { ok: true, targets: [t.target], excluded: [] };
  }
  const keys = payload.conversationKeys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > BATCH_MAX || keys.some((k) => typeof k !== 'string' || !CONV_RE.test(k)) || new Set(keys).size !== keys.length) {
    return { ok: false, code: 'BAD_ARG', field: 'conversationKeys' };
  }
  const targets = []; const excluded = [];
  for (const k of keys) { const t = deleteTarget(k); if (t.ok) targets.push(t.target); else excluded.push({ conversationKey: k, reason: t.reason }); }
  if (!targets.length) return { ok: false, code: 'BAD_ARG', field: 'conversationKeys', reason: 'none-deletable' };
  return { ok: true, targets, excluded };
}

function _deleteLine(t) {
  return 'From: ' + cleanLabel(t.senderName || 'unknown') + ' | Subject: ' + cleanLabel(t.subject || '(no subject)') + (t.messages > 1 ? ' | ' + t.messages + ' messages' : '');
}

/** One OWA delete (moves the conversation to Deleted Items) plus the legacy bookkeeping. */
async function _deleteOne(t) {
  const del = require('../scrapers/owa_reader').deleteMessage;
  const r = await del({ convId: t.convId, folder: t.folder });
  if (!(r && r.ok)) return { ok: false, error: (r && r.error) || 'delete failed', status: r && r.status };
  try {
    const triage = require('../scrapers/email_triage');
    const store = require('../store');
    const fresh = _results();
    const idx = (fresh.emails || []).findIndex((e) => e.id === t.legacyId);
    if (idx !== -1) {
      try { triage.recordDeletion(fresh.emails[idx]); } catch (_) { /* learning only */ }
      fresh.emails[idx] = { ...fresh.emails[idx], deleted: true, deletedAt: new Date().toISOString() };
      store.save('emailTriageResults', fresh);
      notifyOverlay(fresh);
    }
  } catch (e) { logger.warn('[email-intel] delete bookkeeping failed ' + safeErr(e)); }
  try {
    const as = require('./actions/store');
    as.update((doc) => as.closeConversation(doc, t.conversationKey, 'superseded', Date.now()));
  } catch (_) { /* actions bookkeeping only */ }
  return { ok: true };
}

const deleteOne = {
  summarize(payload) {
    const v = validateDelete('delete', payload);
    if (!v.ok) throw new Error('invalid delete payload');
    const t = v.targets[0];
    return {
      headline: 'Delete this email from ' + cleanLabel(t.senderName || 'unknown sender') + '?',
      detailText: [_deleteLine(t), 'Folder: ' + cleanLabel(t.folder, 40), 'It moves to Deleted Items in Outlook (recoverable).',
        t.units.length ? 'It mentions your unit(s) ' + t.units.map((u) => cleanLabel(u, 20)).join(', ') + '; facts already recorded stay in the app.' : ''].filter(Boolean).join('\n'),
      count: 1,
    };
  },
  async run(payload) {
    const v = validateDelete('delete', payload);
    if (!v.ok) return { ok: false, code: v.code, field: v.field, reason: v.reason };
    const r = await _deleteOne(v.targets[0]);
    if (r.ok) logger.info('[email-intel] delete done conv=' + require('./redact').rid(v.targets[0].conversationKey));
    return r.ok ? { ok: true, message: 'Deleted - moved to Deleted Items in Outlook.' } : r;
  },
};

const deleteBatch = {
  summarize(payload) {
    const v = validateDelete('delete-batch', payload);
    if (!v.ok) throw new Error('invalid delete-batch payload');
    const lines = v.targets.slice(0, 10).map(_deleteLine);
    if (v.targets.length > 10) lines.push('... and ' + (v.targets.length - 10) + ' more');
    if (v.excluded.length) lines.push('Not included (' + v.excluded.length + '): ' + v.excluded.map((x) => DELETE_REASON_TEXT[x.reason] || x.reason).filter((x, i, a) => a.indexOf(x) === i).join('; '));
    lines.push('They move to Deleted Items in Outlook (recoverable).');
    return { headline: 'Delete ' + v.targets.length + ' email' + (v.targets.length === 1 ? '' : 's') + '?', detailText: lines.join('\n'), count: v.targets.length, excluded: v.excluded.length };
  },
  async run(payload) {
    const v = validateDelete('delete-batch', payload);
    if (!v.ok) return { ok: false, code: v.code, field: v.field, reason: v.reason };
    const outcomes = [];
    for (const t of v.targets) {                                   // one at a time, never in parallel
      let r;
      try { r = await _deleteOne(t); } catch (e) { r = { ok: false, error: 'delete failed' }; logger.warn('[email-intel] delete failed ' + safeErr(e)); }
      outcomes.push({ conversationKey: t.conversationKey, id: t.legacyId, ok: !!r.ok, error: r.ok ? undefined : r.error });
    }
    const deleted = outcomes.filter((o) => o.ok).length;
    logger.info('[email-intel] delete-batch done deleted=' + deleted + ' total=' + v.targets.length + ' excluded=' + v.excluded.length);
    return { ok: true, deleted, total: v.targets.length, outcomes, excluded: v.excluded };
  },
};

let _registered = false;
/** registerAll(): idempotent (confirm.registerExecutor replaces a previous registration for the same kind). */
function registerAll() {
  confirm.registerExecutor('send-ready-dm', readyDm);
  confirm.registerExecutor('approve-staged', approveStaged);
  confirm.registerExecutor('reject-staged', rejectStaged);
  confirm.registerExecutor('delete', deleteOne);
  confirm.registerExecutor('delete-batch', deleteBatch);
  _registered = true;
}
function isRegistered() { return _registered && confirm.hasExecutor('send-ready-dm'); }

module.exports = { validateReadyDm, validateStaged, validateDelete, deleteTarget, DELETE_REASON_TEXT, notifyOverlay, registerAll, isRegistered };
