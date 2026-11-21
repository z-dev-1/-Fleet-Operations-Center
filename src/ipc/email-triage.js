'use strict';
/**
 * ipc/email-triage.js — IPC surface for the OWA Inbox Triage overlay.
 *
 * Thin, safe wrappers over src/scrapers/email_triage.js (read + reason) and
 * src/scrapers/email_actions.js (the confirm-gated acting layer). The renderer
 * overlay calls these; nothing here sends/deletes/DMs without an explicit
 * renderer action (a button click), and every mutating action maps to one
 * discrete handler so there is no implicit batch send.
 *
 * Handlers:
 *   emailTriage:get-config / set-config
 *   emailTriage:get-results
 *   emailTriage:run           — read inbox + AI triage; auto-apply validated
 *                               unit timeline updates when configured; persist.
 *   emailTriage:draft-reply   — AI-draft a reply for one email (persisted).
 *   emailTriage:send-reply    — send the (edited) reply via OWA (confirm-gated).
 *   emailTriage:dismiss-reply — mark an email's reply option dismissed.
 *   emailTriage:draft-ready-dm/send-ready-dm — operator "unit ready" DM.
 *
 * Outlook REST transport (email.intel.apiTransport effective): probe runs one API GET; send-reply becomes the
 * confirmed Reply (validateSendReply -> confirm.prepare -> native dialog -> send-reply executor); delete and
 * delete-suggested move through the API (executors.apiLegacyDelete). No OWA page is opened and nothing falls back
 * to the DOM. Flag OFF: unchanged.
 */

const store = require('../store');
const logger = require('../utils/logger')('ipc:email-triage');
const { handle, requireString } = require('./_safe');
const { ConfigError } = require('../utils/errors');

const triage = require('../scrapers/email_triage');
const actions = require('../scrapers/email_actions');

// Mutate one persisted email record in place (by id) and save. Returns the
// updated record (or null if not found). Notifies the overlay to refresh.
function _patchEmail(id, patch) {
  const results = triage.loadResults();
  const idx = results.emails.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  results.emails[idx] = { ...results.emails[idx], ...patch };
  store.save('emailTriageResults', results);
  _notifyOverlay(results);
  return results.emails[idx];
}

function _notifyOverlay(results) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('emailTriage:updated', results || triage.loadResults());
  } catch (_) {}
}

// True only when the Email Triage Intelligence capture flag is effective. Any failure reading the
// flags means "not effective" (legacy behavior).
function _captureEffective() {
  try { return require('../email-intel/flags').get().effective.capture === true; } catch (_) { return false; }
}

// ── Free-write reply with clarifying questions (draft-reply opts) ─────────────
// Only clarify / answers are read; anything else in opts is ignored. Returned only when present.
function _freeWriteOpts(opts) {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new ConfigError('opts must be an object', 'opts');
  const out = {};
  if (opts.clarify !== undefined) {
    if (typeof opts.clarify !== 'boolean') throw new ConfigError('clarify must be a boolean', 'clarify');
    out.clarify = opts.clarify;
  }
  if (opts.answers !== undefined) {
    if (typeof opts.answers !== 'string' || opts.answers.length > 1000) throw new ConfigError('answers must be a string of at most 1000 characters', 'answers');
    const a = opts.answers.replace(FW_CTRL_RE, '').trim();
    if (a) out.answers = a;
  }
  return out;
}

const FW_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const FW_CONTRACT = [
  'Before writing: if the email, the grounded context and the intent above give you enough to write a correct reply, write it. If a fact the reply needs is missing (a date, amount, unit, who approves, what to commit to), ASK 1-3 short questions instead of guessing. Never fabricate specifics.',
  'Respond as STRICT JSON only, one of:',
  '{"done":true,"draft":"<reply body>"}',
  '{"done":false,"questions":["q1","q2"]}',
  'No text outside the JSON.',
].join('\n');

// Legacy (no conversation key) free-write: the unchanged legacy reply prompt plus the answers and the JSON contract.
// -> { questions } | { draft } | { empty:true } (AI gave nothing) | { invalid:true } | null (nothing to reply to).
// Logs counts only, never the guidance, answers, questions or draft.
async function _legacyClarify(email, guidance, answers) {
  if (!email.from && !email.fromName && !email.subject) return null;
  const lines = [actions._buildReplyPrompt(email, guidance)];
  if (answers) { lines.push(''); lines.push('THE USER\'S ANSWERS TO YOUR QUESTIONS (follow these): ' + answers); }
  lines.push('');
  lines.push(FW_CONTRACT);
  if (answers) lines.push('The user already answered your questions: ask again only if something critical is still missing.');
  let text = '';
  try {
    const raw = await require('../orcha/relay').askWithTimeout(lines.join('\n'), { source: 'email_actions', timeoutMs: 45000, timeoutMessage: 'ai-timeout' });
    text = (typeof raw === 'string') ? raw.trim() : (raw && raw.text ? String(raw.text).trim() : '');
  } catch (_) { text = ''; }
  if (!text) { logger.warn('[email-triage] free-write draft: AI unavailable'); return { empty: true }; }
  const m = /\{[\s\S]*\}/.exec(text);
  let p = null;
  try { p = m ? JSON.parse(m[0]) : null; } catch (_) { p = null; }
  if (p && p.done === false && Array.isArray(p.questions)) {
    const questions = p.questions.filter((q) => typeof q === 'string')
      .map((q) => q.replace(FW_CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 3);
    if (questions.length) { logger.info('[email-triage] free-write draft needs answers questions=' + questions.length); return { questions }; }
  }
  if (p && p.done === true && typeof p.draft === 'string') {
    const draft = p.draft.replace(/\r\n/g, '\n').replace(FW_CTRL_RE, '').trim();
    if (draft && draft.length <= 4000) return { draft };
  }
  if (!m) {
    // The model ignored the contract and wrote a plain reply: use it as the draft.
    const draft = text.replace(/\r\n/g, '\n').replace(FW_CTRL_RE, '').trim();
    if (draft && draft.length <= 4000) return { draft };
  }
  logger.warn('[email-triage] free-write draft: unusable AI output chars=' + text.length);
  return { invalid: true };
}

// True only when the My Email Actions view (actionsView) is effective: the legacy delete / delete-suggested / keep
// channels then fail closed (F2-03); deletes go through emailIntel:prepare-action / confirm-action.
function _actionsViewEffective() {
  try { return require('../email-intel/flags').get().effective.actionsView === true; } catch (_) { return false; }
}
const _CONFIRM_DELETE = () => ({ ok: false, code: 'CONFIRMATION_REQUIRED', error: 'Confirmation required: use the confirmed delete flow.' });

// True only when thread-aware replies (threadReplies) are effective. The legacy send-reply channel then ALWAYS
// fails closed (plan 2.3, F2-03): it cannot carry a confirmation token, so it sends nothing; sends go through
// emailIntel:prepare-action / confirm-action, whose executor owns the attempt record.
function _repliesEffective() {
  try { return require('../email-intel/flags').get().effective.threadReplies === true; } catch (_) { return false; }
}

function _findEmail(id) {
  const results = triage.loadResults();
  return results.emails.find((e) => e.id === id) || null;
}

// True only when the Email Triage Outlook REST transport (email.intel.apiTransport) is effective: probe, send-reply,
// delete and delete-suggested then go through the API only (no OWA page, no DOM fallback). Any failure -> false.
function _apiTransportEffective() {
  try { return require('../email-intel/flags').apiTransport() === true; } catch (_) { return false; }
}

const RUN_A_SCAN = 'Run a scan so this email is read through the Outlook API, then reply.';
// Legacy Send refusals under the API transport (fixed strings; no ids or addresses).
function _legacyRefusalText(check) {
  const c = check || {};
  if (c.code === 'UNRECONCILED_ATTEMPT') return 'Reply status uncertain - reconcile before retrying. Nothing was sent.';
  if (c.reason === 'no-api-id' || c.reason === 'unknown-conversation' || c.reason === 'no-conversation-id') return RUN_A_SCAN;
  if (c.reason === 'no-recipients' || c.code === 'RECIPIENTS_UNKNOWN') return 'The recipients of this email are not known. Nothing was sent.';
  if (c.reason === 'secret-like') return 'The reply looks like it contains a secret or credential. Nothing was sent.';
  return 'Not sent (' + c.code + (c.field ? ' ' + c.field : '') + ').';
}
// The legacy overlay has no "New message" option, so the mechanism-unavailable text names none (no `fallback`).
function _legacyResultText(r, executors) {
  if (r.status === 'mechanism-unavailable') return 'Could not reply inside the Outlook conversation. Nothing was sent.';
  if (r.code === 'USER_CANCELLED') return 'Cancelled. Nothing was sent.';
  return executors.SEND_MESSAGES[r.status] || r.message || 'Nothing was sent.';
}

function registerEmailTriageIPC(_ctx) {
  // ── Config ────────────────────────────────────────────────────────────────
  handle('emailTriage:get-config', () => triage.getConfig());
  handle('emailTriage:set-config', (_e, patch) => {
    if (patch && typeof patch !== 'object') throw new ConfigError('config patch must be an object', 'patch');
    return triage.saveConfig(patch || {});
  });

  // ── Results ─────────────────────────────────────────────────────────────
  handle('emailTriage:get-results', () => triage.loadResults());

  // ── Diagnostic: dump what the OWA reader actually sees in the live mailbox,
  //    so the DOM selectors can be tuned to the user's real OWA build. Logs the
  //    probe output and returns it to the caller.
  handle('emailTriage:probe', async () => {
    if (_apiTransportEffective()) {
      // One tiny Outlook REST GET; status, latency and token presence only (no ids, no content).
      const r = await require('../email-intel/transport').probe();
      logger.info('[email-triage][probe] transport=api ok=' + !!r.ok + ' status=' + (r.status || 0));
      return r;
    }
    const probe = require('../scrapers/owa_reader').probeInbox;
    const r = await probe({});
    try { logger.info('[email-triage][probe] ' + JSON.stringify(r && r.data ? r.data : r)); } catch (_) {}
    return r;
  });

  // ── Run a triage: read inbox + AI triage, then (optionally) auto-apply the
  //    validated unit timeline updates. The operator READY DM is NEVER
  //    auto-sent — it is always surfaced for an explicit confirm.
  handle('emailTriage:run', async (_e, opts) => {
    const cfg = triage.getConfig();
    const max = opts && Number.isFinite(opts.max) ? opts.max : cfg.maxEmails;
    // runTriageForIpc == runTriage in comms mode off/shadow; single-flight in on (design §6).
    let results = await triage.runTriageForIpc({ max });

    if (results && results.authBlocked) {
      _notifyOverlay(results);
      return results;
    }

    // Auto-apply validated unit updates (user asked: "if it can validate it's
    // one of my units then add it to timeline"). Shared with the auto-scan timer.
    if (cfg.autoApplyUnitUpdates && results && Array.isArray(results.emails)) {
      const applied = triage.applyPendingUnitUpdates(results);
      if (applied) logger.info('[email-triage] auto-applied ' + applied + ' unit timeline update(s)');
    }

    _notifyOverlay(results);
    return results;
  });

  // ── Reply drafting (persists the draft + flips replyState to 'drafted') ────
  // opts (free-write, optional): { clarify?: boolean, answers?: string <= 1000 }. Without opts: unchanged.
  handle('emailTriage:draft-reply', async (_e, id, guidance, opts) => {
    requireString(id, 'id');
    const fw = _freeWriteOpts(opts);
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    // threadReplies: draft through the thread-aware path (resolved-question gate, isolated lane, fenced context).
    if (_repliesEffective() && email.intel && email.intel.conversationKey) {
      const t = await require('../email-intel/reply/draft').draftThreadReply(Object.assign({ conversationKey: email.intel.conversationKey, mode: 'reply', guidance: guidance ? String(guidance).slice(0, 1000) : '' }, fw));
      if (!t.ok) return Object.assign({}, t, { error: t.code === 'ALREADY_RESOLVED' ? 'Already answered in the thread; no reply is needed.' : 'Draft not created (' + t.code + ').' });
      if (t.needsAnswers) return { ok: true, needsAnswers: true, questions: t.questions };
      _notifyOverlay();
      return { ok: true, draft: t.draft, aiUnavailable: !!t.aiUnavailable };
    }
    const g = guidance ? String(guidance).slice(0, 1000) : '';
    if (fw.clarify === true && g) {
      const c = await _legacyClarify(email, g, fw.answers || '');
      if (c && c.questions) return { ok: true, needsAnswers: true, questions: c.questions };
      if (c && c.draft) {
        _patchEmail(id, { replyDraft: c.draft, replyState: 'drafted' });
        return { ok: true, draft: c.draft, aiUnavailable: false };
      }
      if (c && c.empty) {
        // AI unavailable: the same editable starter as actions.draftReply, without a second 45 s wait.
        const who = email.fromName ? String(email.fromName).split(/[\s,<]/)[0] : '';
        const fb = 'Hi' + (who ? ' ' + who : '') + ',\n\nThank you for your email.\n\n\n\nBest regards';
        _patchEmail(id, { replyDraft: fb, replyState: 'drafted' });
        return { ok: true, draft: fb, aiUnavailable: true };
      }
      // unusable JSON from the AI: the normal draft below (never stuck asking)
    }
    const r = await actions.draftReply(email, fw.answers ? g + '\n' + fw.answers : g, {});
    if (!r.ok) return r;
    _patchEmail(id, { replyDraft: r.draft, replyState: 'drafted' });
    return { ok: true, draft: r.draft, aiUnavailable: !!r.aiUnavailable };
  });

  // ── Reply sending (confirm-gated by the overlay's Send button) ────────────
  handle('emailTriage:send-reply', async (_e, id, bodyText) => {
    if (_repliesEffective()) return { ok: false, code: 'CONFIRMATION_REQUIRED', error: 'Confirmation required: use the confirmed reply flow.' };
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    const body = String(bodyText || email.replyDraft || '').trim();
    if (!body) throw new ConfigError('reply body is empty', 'bodyText');
    if (_apiTransportEffective()) {
      // Outlook REST transport: the confirmed Reply through the send-reply executor (single-use token + native dialog).
      const executors = require('../email-intel/executors');
      const confirm = require('../email-intel/confirm');
      const ck = email.intel && email.intel.conversationKey;
      if (!ck) return { ok: false, code: 'NO_CONVERSATION', transport: 'api', error: RUN_A_SCAN };
      const payload = { conversationKey: ck, mode: 'reply', bodyText: body };
      const check = executors.validateSendReply(payload);              // before prepare: prepare maps a summarize throw to BAD_ARG
      if (!check.ok) return { ok: false, transport: 'api', code: check.code, reason: check.reason, error: _legacyRefusalText(check) };
      const prep = confirm.prepare('send-reply', payload);
      if (!prep.ok) return { ok: false, transport: 'api', code: prep.code, error: 'Not sent (' + prep.code + ').' };
      const res = await confirm.confirm(prep.token, { event: _e });     // native dialog; Cancel -> nothing sent
      const out = Object.assign({}, res, { transport: 'api', error: res && res.ok ? undefined : _legacyResultText(res || {}, executors) });
      delete out.fallback;
      return out;
    }
    const r = await actions.sendReply(email, body);
    if (r.ok) _patchEmail(id, { replyState: 'sent', replyDraft: body });
    return r;
  });

  handle('emailTriage:dismiss-reply', (_e, id) => {
    requireString(id, 'id');
    const updated = _patchEmail(id, { replyState: 'dismissed' });
    return updated ? { ok: true } : { ok: false, error: 'email not found' };
  });

  // ── Delete (move to Deleted Items — reversible) ───────────────────────────
  // Confirm-gated by the overlay. Deletes the message in OWA, records the
  // deletion so the AI learns the user's junk habits, and marks the record.
  handle('emailTriage:delete', async (_e, id) => {
    if (_actionsViewEffective()) return _CONFIRM_DELETE();
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    if (!email.convId) return { ok: false, error: 'This message has no conversation id, so it can\'t be auto-deleted. Delete it in Outlook.' };
    let r;
    if (_apiTransportEffective()) {
      r = await require('../email-intel/executors').apiLegacyDelete(email);         // Outlook REST move (no DOM)
    } else {
      const del = require('../scrapers/owa_reader').deleteMessage;
      r = await del({ convId: email.convId, folder: email.folder || 'Inbox' });
    }
    if (r && r.ok) {
      try { triage.recordDeletion(email); } catch (_) {}
      _patchEmail(id, { deleted: true, deletedAt: new Date().toISOString() });
      return { ok: true, message: 'Deleted — moved to Deleted Items in Outlook.' };
    }
    return { ok: false, error: (r && r.error) || 'delete failed', status: r && r.status };
  });

  // Keep: user says this is NOT junk — clear the suggestion + teach the AI.
  handle('emailTriage:keep', (_e, id) => {
    if (_actionsViewEffective()) return _CONFIRM_DELETE();
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    try { triage.recordKeep(email); } catch (_) {}
    _patchEmail(id, { deleteSuggested: false, kept: true });
    return { ok: true };
  });

  // Delete ALL currently-suggested (and not-kept, not-already-deleted) emails,
  // one confirmed batch. Returns per-email outcomes.
  handle('emailTriage:delete-suggested', async () => {
    if (_actionsViewEffective()) return _CONFIRM_DELETE();
    const results = triage.loadResults();
    const targets = (results.emails || []).filter((e) => e.deleteSuggested && !e.kept && !e.deleted && e.convId);
    const api = _apiTransportEffective();
    const del = api ? require('../email-intel/executors').apiLegacyDelete : require('../scrapers/owa_reader').deleteMessage;
    const outcomes = [];
    for (const email of targets) {
      try {
        const r = api ? await del(email) : await del({ convId: email.convId, folder: email.folder || 'Inbox' });
        if (r && r.ok) {
          try { triage.recordDeletion(email); } catch (_) {}
          _patchEmail(email.id, { deleted: true, deletedAt: new Date().toISOString() });
          outcomes.push({ id: email.id, ok: true });
        } else {
          outcomes.push({ id: email.id, ok: false, error: (r && r.error) || 'failed' });
        }
      } catch (e) { outcomes.push({ id: email.id, ok: false, error: e.message }); }
    }
    const okCount = outcomes.filter((o) => o.ok).length;
    return { ok: true, deleted: okCount, total: targets.length, outcomes };
  });

  // ── Operator "unit ready" DM ──────────────────────────────────────────────
  handle('emailTriage:draft-ready-dm', async (_e, id, unit) => {
    requireString(id, 'id');
    requireString(unit, 'unit');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    const ref = (email.unitRefs || []).find((u) => u.unit === unit);
    if (!ref) throw new ConfigError('unit ref not found on email: ' + unit, 'unit');
    const r = await actions.draftReadyDm(ref, email, {});
    // Stash the resolved entry channel id on the response so the overlay can
    // pass it back to send without re-resolving (it is not persisted).
    return r.ok
      ? { ok: true, draft: r.draft, channelId: r.entry && r.entry.channelId, operator: ref.operator }
      : r;
  });

  handle('emailTriage:send-ready-dm', async (_e, id, unit, message) => {
    // Email Triage Intelligence (F2-03): while capture is effective this legacy channel cannot carry a
    // confirmation token, so it fails closed. The overlay uses emailIntel:prepare-action / confirm-action
    // (single-use token + native dialog) instead. Flags OFF: unchanged.
    if (_captureEffective()) return { ok: false, code: 'CONFIRMATION_REQUIRED', error: 'Confirmation required: use the confirmed send flow.' };
    requireString(id, 'id');
    requireString(unit, 'unit');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    const ref = (email.unitRefs || []).find((u) => u.unit === unit);
    if (!ref) throw new ConfigError('unit ref not found on email: ' + unit, 'unit');
    const r = await actions.sendReadyDm(ref, String(message || '').trim(), {});
    if (r.ok) {
      // Mark this email's readiness DM as sent (bookkeeping; non-blocking).
      const email2 = _findEmail(id);
      const refs = (email2 && email2.unitRefs) || [];
      const updated = refs.map((u) => (u.unit === unit ? { ...u, readyDmSent: true } : u));
      _patchEmail(id, { unitRefs: updated, readyDmSent: true });
    }
    return r;
  });

  // Push auto-scan results to the overlay the same way manual runs do.
  try { triage._setAutoNotify((results) => _notifyOverlay(results)); } catch (_) {}
  // Start the hourly (configurable) auto-scan scheduler. It only fires when the
  // feature is enabled AND autoScan is on — otherwise each tick is a cheap no-op.
  try { triage.startAutoScan(); } catch (e) { logger.warn('auto-scan start failed: ' + e.message); }

  logger.info('Email Triage IPC handlers registered');
}

module.exports = { registerEmailTriageIPC };
