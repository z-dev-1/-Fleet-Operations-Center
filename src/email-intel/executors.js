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
 * Phase E registers:
 *   send-reply     payload { conversationKey, mode:'reply'|'reply-all'|'new-message', bodyText } -> owns the send
 *                  attempt; threaded modes use reply/owa_reply.sendThreadReply, 'new-message' the UNCHANGED
 *                  email_actions.sendReply (labeled "New message (not threaded)"). The legacy emailTriage:send-reply
 *                  channel always returns CONFIRMATION_REQUIRED while threadReplies is effective (plan 2.3, F2-03).
 *   mark-send-resolution payload { attemptId, resolution:'sent'|'not-sent', acknowledgeCheckedOutlook:true, override? }
 *
 * Later phases extend registerAll().
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

// ── Phase E: send-reply / mark-send-resolution (design 6.5-6.7; plan 2.3 F2-03) ──
// The send-reply executor OWNS the attempt record (emailIntelSends). Modes 'reply' / 'reply-all' reply inside the
// real Outlook conversation (reply/owa_reply.sendThreadReply); mode 'new-message' calls the UNCHANGED
// email_actions.sendReply(email, body) with the same arguments as the legacy handler and is labeled
// "New message (not threaded)". res.status maps onto the attempt (sent | delivery-uncertain | failed-before-send |
// blocked-auth) and onto the legacy replyState (sent | uncertain | unchanged). Nothing here retries a send.
const SEND_MODES = Object.freeze(['reply', 'reply-all', 'new-message']);
const ATTEMPT_RE = /^sa_[0-9a-f]{16}$/;
const SEND_BODY_MAX = 8_000;
const RESOLUTION_CHECK_MIN_MS = 2 * 60_000;
const NOT_THREADED_LABEL = 'New message (not threaded)';
const SEND_MESSAGES = Object.freeze({
  sent: 'Reply sent.',
  'delivery-uncertain': 'Reply status uncertain - check Outlook and reconcile before retrying. It will not be sent again automatically.',
  'blocked-auth': 'Outlook needs a sign-in. Nothing was sent. Open Outlook on the web once, then try again.',
  'failed-before-send': 'Nothing was sent.',
  'recipient-mismatch': 'Outlook\'s recipients differ from the ones you confirmed. Nothing was sent.',
  'mechanism-unavailable': 'Could not reply inside the Outlook conversation. Nothing was sent. You can send it as a ' + NOT_THREADED_LABEL + '.',
});

const _conv = (ck) => {
  const ledger = require('./ingest/ledger');
  return ledger.conversation(ledger.ensureDoc(require('./stores').load('messages')), ck);
};
function _legacyRecord(conversationKey, legacyId) {
  let results = null;
  try { results = _results(); } catch (_) { results = null; }
  const emails = (results && Array.isArray(results.emails)) ? results.emails : [];
  return emails.find((e) => e && e.intel && e.intel.conversationKey === conversationKey) || emails.find((e) => e && e.id === legacyId) || null;
}
function _storedDraftStale(conversationKey, latestKey) {
  try {
    const as = require('./actions/store');
    return Object.values(as.load().items).some((x) => x.conversationKey === conversationKey && as.LIVE.has(x.state) && x.draft && x.draft.basedOnMessageKey && x.draft.basedOnMessageKey !== latestKey);
  } catch (_) { return false; }
}

/**
 * validateSendReply(payload) -> { ok:true, ... } | { ok:false, code, field?, reason?, attemptId? }
 * payload { conversationKey ^cv_[0-9a-f]{16}$, mode reply|reply-all|new-message, bodyText 1..8000 after trim };
 * findSecret(bodyText) must be null; the conversation must exist and canSend; reply-all needs known recipients;
 * threaded modes need a real Outlook conversation id; new-message needs the legacy record with a sender address.
 */
function validateSendReply(payload) {
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  const { conversationKey, mode } = payload;
  if (typeof conversationKey !== 'string' || !CONV_RE.test(conversationKey)) return { ok: false, code: 'BAD_ARG', field: 'conversationKey' };
  if (!SEND_MODES.includes(mode)) return { ok: false, code: 'BAD_ARG', field: 'mode' };
  const body = typeof payload.bodyText === 'string' ? payload.bodyText.trim() : null;
  if (!body || body.length > SEND_BODY_MAX) return { ok: false, code: 'BAD_ARG', field: 'bodyText' };
  if (require('../justme-context/secret-scrub').findSecret(body)) return { ok: false, code: 'BAD_ARG', field: 'bodyText', reason: 'secret-like' };
  const records = _conv(conversationKey);
  if (!records.length) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'unknown-conversation' };
  const latest = records[records.length - 1];
  const guard = require('./reply/send-guard');
  const can = guard.canSend(conversationKey);
  if (!can.ok) return { ok: false, code: 'UNRECONCILED_ATTEMPT', attemptId: can.attemptId, state: can.state };
  const me = (require('./config').normalize(require('./stores').load('config')).me) || {};
  const rec = require('./reply/recipients').computeRecipients(latest, mode, me);
  if (mode === 'reply-all' && rec.blocked === 'RECIPIENTS_UNKNOWN') return { ok: false, code: 'RECIPIENTS_UNKNOWN' };
  const legacy = _legacyRecord(conversationKey, latest.legacyId);
  let to = rec.to; let cc = rec.cc;
  if (mode === 'new-message') {
    if (!legacy) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-legacy-record' };
    if (!legacy.from || !/@/.test(String(legacy.from))) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-sender-address' };
    to = [{ name: String(legacy.fromName || '').slice(0, 120), address: String(legacy.from).trim().toLowerCase(), role: 'sender' }]; cc = [];
  } else {
    if (rec.blocked) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-recipients' };
    if (latest.convIdSource === 'derived' || !latest.convIdRaw) return { ok: false, code: 'BAD_ARG', field: 'conversationKey', reason: 'no-conversation-id' };
  }
  const doms = new Set((me.addresses || []).map((a) => String(a).slice(String(a).lastIndexOf('@') + 1).toLowerCase()).filter(Boolean));
  const external = doms.size ? to.concat(cc).filter((e) => e.address && !doms.has(e.address.slice(e.address.lastIndexOf('@') + 1))).length : null;
  return {
    ok: true, conversationKey, mode, body, records, latest, legacy, to, cc, external,
    mechanism: mode === 'new-message' ? 'compose-new' : 'owa-thread',
    stale: _storedDraftStale(conversationKey, latest.messageKey),
    warnings: require('./reply/risk').scanRisk(body),
  };
}

const _who = (e) => cleanLabel(e.name || e.address || 'unknown') + (e.address && e.name ? ' <' + cleanLabel(e.address, 80) + '>' : '');
const _plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

function _sendSummary(v) {
  const n = v.to.length + v.cc.length;
  const verb = v.mode === 'reply-all' ? 'Reply All' : v.mode === 'reply' ? 'Reply' : NOT_THREADED_LABEL;
  const headline = v.mode === 'new-message'
    ? 'Send ' + NOT_THREADED_LABEL + ' to ' + _plural(n, 'person').replace('persons', 'people') + '?'
    : 'Send ' + verb + ' to ' + (n === 1 ? '1 person' : n + ' people') + ' (' + v.cc.length + ' in CC)?';
  const lines = [];
  lines.push(v.mode === 'new-message'
    ? 'NOT THREADED: this sends a new message with "Re:" to the sender. It is not a reply inside the Outlook conversation.'
    : 'Threaded: replies inside the Outlook conversation with Outlook\'s own ' + verb + ' control.');
  lines.push('To (' + v.to.length + '): ' + (v.to.map(_who).join('; ') || 'none'));
  if (v.cc.length) lines.push('CC (' + v.cc.length + ') - check these people: ' + v.cc.map(_who).join('; '));
  if (v.external) lines.push('External recipients: ' + v.external);
  for (const w of v.warnings) lines.push('Warning: the reply ' + w.label + '.');
  if (v.stale) lines.push('Warning: a newer message arrived in this conversation after the draft was written.');
  lines.push('Message:\n' + v.body.slice(0, 600) + (v.body.length > 600 ? '\u2026' : ''));
  return {
    headline, detailText: lines.join('\n'), mode: v.mode, mechanism: v.mechanism, notThreaded: v.mode === 'new-message',
    mechanismLabel: v.mode === 'new-message' ? NOT_THREADED_LABEL : 'Threaded reply in the Outlook conversation',
    to: v.to.map((e) => ({ name: e.name || '', address: e.address || null })), cc: v.cc.map((e) => ({ name: e.name || '', address: e.address || null })),
    toCount: v.to.length, ccCount: v.cc.length, external: v.external, warnings: v.warnings, stale: v.stale,
  };
}

function _mapLegacyStatus(res) {
  const s = res && res.status;
  if (s === 'sent') return 'sent';
  if (s === 'delivery-uncertain') return 'delivery-uncertain';
  if (s === 'blocked-auth') return 'blocked-auth';
  return 'failed-before-send';                        // 'failed' (never clicked), guards without a status, unknown
}

function _replyHtml(body) {
  return '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;white-space:pre-wrap">' +
    body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
}

const sendReplyExec = {
  summarize(payload) {
    const v = validateSendReply(payload);
    if (!v.ok) throw new Error('invalid send-reply payload');
    return _sendSummary(v);
  },
  async run(payload) {
    const v = validateSendReply(payload);
    if (!v.ok) return v;
    const guard = require('./reply/send-guard');
    const crypto = require('crypto');
    const mailer = require('../scrapers/owa-mailer');
    return guard.withSendLock(async () => {
      const subject = String(v.latest.subject || (v.legacy && v.legacy.subject) || '');
      const reSubject = /^re:/i.test(subject) ? subject : (v.mode === 'new-message' ? 'Re: ' : 'RE: ') + (subject || '(no subject)');
      const marker = mailer.genCorrelationMarker();
      const c = guard.createAttempt({
        conversationKey: v.conversationKey, targetMessageKey: v.latest.messageKey, mode: v.mode, mechanism: v.mechanism, to: v.to, cc: v.cc,
        subjectNorm: mailer.normalizeSubject(reSubject), bodyHash: crypto.createHash('sha256').update(v.body).digest('hex').slice(0, 16), bodyChars: v.body.length, marker,
      });
      if (!c.ok) return { ok: false, code: c.code, attemptId: c.attemptId, state: c.state };
      const id = c.attempt.attemptId;
      let status; let detail = {};
      if (v.mode === 'new-message') {
        guard.markSending(id);                                         // conservative: the unchanged sender hides its click
        let res;
        try { res = await require('../scrapers/email_actions').sendReply(v.legacy, v.body); status = _mapLegacyStatus(res); } catch (e) {
          logger.warn('[email-intel] new-message send threw ' + safeErr(e)); status = 'delivery-uncertain'; detail.code = 'EXCEPTION';
        }
        if (res && !res.ok && status === 'failed-before-send') detail.code = res.status ? String(res.status) : 'NOT_SENT';
      } else {
        let res;
        try {
          res = await require('./reply/owa_reply').sendThreadReply({
            convId: v.latest.convIdRaw, folder: v.latest.folder || 'Inbox', mode: v.mode, expected: { to: v.to, cc: v.cc },
            html: mailer.embedMarker(_replyHtml(v.body), marker), bodyText: v.body, marker, subjectNorm: mailer.normalizeSubject(reSubject),
            attemptHooks: { beforeSendClick: () => { const m = guard.markSending(id); return !!(m.ok && m.attempt.state === 'sending'); } },
          });
        } catch (e) {
          logger.warn('[email-intel] thread reply threw ' + safeErr(e));
          const a = guard.get(id);
          res = { status: a && a.state === 'sending' ? 'delivery-uncertain' : 'failed-before-send', detail: { code: 'EXCEPTION' } };
        }
        status = res.status;
        detail = res.detail || {};
      }
      const state = status === 'sent' || status === 'delivery-uncertain' || status === 'blocked-auth' ? status : 'failed-before-send';
      const f = guard.finish(id, state, { errorCode: state === 'failed-before-send' ? (detail.code || status) : (state === 'delivery-uncertain' ? detail.code : undefined) });
      const results = f.ok ? guard.applyOutcome(f.attempt, { bodyText: v.body, legacyId: v.latest.legacyId }) : null;
      if (results) notifyOverlay(results);
      const out = { ok: state === 'sent', status, attemptId: id, mechanism: v.mechanism, message: SEND_MESSAGES[status] || SEND_MESSAGES['failed-before-send'] };
      if (detail.code) out.code = detail.code;
      if (detail.diff) out.diff = detail.diff;                       // returned to the UI only, never logged
      if (status === 'mechanism-unavailable' || (status === 'failed-before-send' && ['INSERT_UNVERIFIED', 'COMPOSE_NOT_INLINE', 'NO_REPLY_CONTROL'].includes(detail.code))) out.fallback = 'new-message';
      return out;
    });
  },
};

/**
 * validateResolution(payload, now) -> { ok:true, attempt, override } | { ok:false, code:'BAD_ARG', field, reason? }
 * { attemptId, resolution:'sent'|'not-sent', acknowledgeCheckedOutlook: true (exactly), override?: boolean }.
 * not-sent also needs a reconcile check at least 2 minutes after the click that found nothing, or override:true.
 */
function validateResolution(payload, now) {
  if (!_isPlain(payload)) return { ok: false, code: 'BAD_ARG', field: 'payload' };
  if (typeof payload.attemptId !== 'string' || !ATTEMPT_RE.test(payload.attemptId)) return { ok: false, code: 'BAD_ARG', field: 'attemptId' };
  if (payload.resolution !== 'sent' && payload.resolution !== 'not-sent') return { ok: false, code: 'BAD_ARG', field: 'resolution' };
  if (payload.acknowledgeCheckedOutlook !== true) return { ok: false, code: 'BAD_ARG', field: 'acknowledgeCheckedOutlook' };
  if (payload.override !== undefined && typeof payload.override !== 'boolean') return { ok: false, code: 'BAD_ARG', field: 'override' };
  const a = require('./reply/send-guard').get(payload.attemptId);
  if (!a || !['delivery-uncertain', 'unconfirmed-not-found'].includes(a.state)) return { ok: false, code: 'BAD_ARG', field: 'attemptId', reason: 'not-unresolved' };
  if (payload.resolution === 'not-sent' && payload.override !== true) {
    const t0 = Date.parse(a.sendClickedAt || a.createdAt) || 0;
    const checked = (a.reconcile.checks || []).some((c) => c.found === false && (Date.parse(c.at) || 0) - t0 >= RESOLUTION_CHECK_MIN_MS);
    if (!checked) return { ok: false, code: 'BAD_ARG', field: 'resolution', reason: 'reconcile-first' };
  }
  const t = Number.isFinite(now) ? now : Date.now();
  return { ok: true, attempt: a, override: payload.override === true, now: t };
}

const markResolution = {
  summarize(payload) {
    const v = validateResolution(payload);
    if (!v.ok) throw new Error('invalid mark-send-resolution payload');
    const a = v.attempt;
    const lines = [
      'Recipients: ' + a.toCount + ' in To, ' + a.ccCount + ' in CC (' + (a.mode === 'new-message' ? NOT_THREADED_LABEL : a.mode === 'reply-all' ? 'Reply All' : 'Reply') + ').',
      'You confirmed that you checked Outlook Sent Items yourself.',
    ];
    if (payload.resolution === 'not-sent') lines.push('Marking it not sent lets you send this reply again. If it was actually delivered, a second send is a duplicate.');
    if (v.override) lines.push('Warning: no Sent Items check at least 2 minutes after the click has confirmed it is missing.');
    return { headline: payload.resolution === 'sent' ? 'Mark this reply as sent?' : 'Mark this reply as NOT sent?', detailText: lines.join('\n'), resolution: payload.resolution, override: v.override };
  },
  async run(payload) {
    const v = validateResolution(payload);
    if (!v.ok) return v;
    const guard = require('./reply/send-guard');
    const r = guard.resolve(v.attempt.attemptId, payload.resolution, Date.now());
    if (!r.ok) return { ok: false, code: r.code || 'STORE_ERROR' };
    const results = guard.applyOutcome(r.attempt, {});
    if (results) notifyOverlay(results);
    logger.info('[email-intel] send resolution sa=' + require('./redact').rid(v.attempt.attemptId) + ' resolution=' + payload.resolution + (v.override ? ' override' : ''));
    return { ok: true, state: r.attempt.state, resolution: r.attempt.reconcile.resolution };
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
  confirm.registerExecutor('send-reply', sendReplyExec);
  confirm.registerExecutor('mark-send-resolution', markResolution);
  _registered = true;
}
function isRegistered() { return _registered && confirm.hasExecutor('send-ready-dm'); }

module.exports = {
  validateReadyDm, validateStaged, validateDelete, validateSendReply, validateResolution, deleteTarget, DELETE_REASON_TEXT, NOT_THREADED_LABEL,
  SEND_MESSAGES, notifyOverlay, registerAll, isRegistered,
};
