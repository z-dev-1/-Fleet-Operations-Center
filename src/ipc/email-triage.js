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

function _findEmail(id) {
  const results = triage.loadResults();
  return results.emails.find((e) => e.id === id) || null;
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
    let results = await triage.runTriage({ max });

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
  handle('emailTriage:draft-reply', async (_e, id, guidance) => {
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    const r = await actions.draftReply(email, guidance ? String(guidance).slice(0, 1000) : '', {});
    if (!r.ok) return r;
    _patchEmail(id, { replyDraft: r.draft, replyState: 'drafted' });
    return { ok: true, draft: r.draft, aiUnavailable: !!r.aiUnavailable };
  });

  // ── Reply sending (confirm-gated by the overlay's Send button) ────────────
  handle('emailTriage:send-reply', async (_e, id, bodyText) => {
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    const body = String(bodyText || email.replyDraft || '').trim();
    if (!body) throw new ConfigError('reply body is empty', 'bodyText');
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
    requireString(id, 'id');
    const email = _findEmail(id);
    if (!email) throw new ConfigError('email not found: ' + id, 'id');
    if (!email.convId) return { ok: false, error: 'This message has no conversation id, so it can\'t be auto-deleted. Delete it in Outlook.' };
    const del = require('../scrapers/owa_reader').deleteMessage;
    const r = await del({ convId: email.convId, folder: email.folder || 'Inbox' });
    if (r && r.ok) {
      try { triage.recordDeletion(email); } catch (_) {}
      _patchEmail(id, { deleted: true, deletedAt: new Date().toISOString() });
      return { ok: true, message: 'Deleted — moved to Deleted Items in Outlook.' };
    }
    return { ok: false, error: (r && r.error) || 'delete failed', status: r && r.status };
  });

  // Keep: user says this is NOT junk — clear the suggestion + teach the AI.
  handle('emailTriage:keep', (_e, id) => {
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
    const results = triage.loadResults();
    const targets = (results.emails || []).filter((e) => e.deleteSuggested && !e.kept && !e.deleted && e.convId);
    const del = require('../scrapers/owa_reader').deleteMessage;
    const outcomes = [];
    for (const email of targets) {
      try {
        const r = await del({ convId: email.convId, folder: email.folder || 'Inbox' });
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
