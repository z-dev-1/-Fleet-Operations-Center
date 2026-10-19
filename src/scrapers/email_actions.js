'use strict';
/**
 * scrapers/email_actions.js — the ACTING layer for OWA inbox triage.
 *
 * email_triage.js only reads + reasons (advisory). This module performs the
 * three real, mutating actions the triage can lead to — each one invoked ONLY
 * from a confirm-gated path (the overlay's explicit buttons, or a Slack YES):
 *
 *   1. applyUnitTimelineUpdate(unitId, entry)
 *        Appends an email-derived repair note to a unit's timeline, mirroring
 *        the EXACT behavior of ipc/notes.js 'notes:add-timeline' — including the
 *        notesStore manualEntries bookkeeping, the fleetData.repairTimeline
 *        mirror (so the unit detail panel + carrier briefing see it), and the
 *        'notes:updated' renderer notification. (The ai.js inline TIMELINE
 *        action does NOT mirror to fleetData; this one does, correctly.)
 *
 *   2. draftReply(email) / sendReply(email, bodyText)
 *        AI-drafts a reply to an email (draftReply), and sends it through the
 *        existing authenticated OWA path (owa-mailer.sendViaOwa) — reply-all is
 *        NOT used; we reply only to the sender. Sending is confirm-gated.
 *
 *   3. draftReadyDm(unitRef) / sendReadyDm(unitRef, message)
 *        When an email says a unit is READY, AI-drafts a short "unit is ready
 *        for pickup" message to the unit's operator/partner, resolved to their
 *        Slack channel + owner via pm_alert_reply.resolveOperatorEntry, and
 *        sends it (confirm-gated). Tags the owner so they're notified.
 *
 * Nothing here sends/writes without an explicit caller decision. The draft
 * functions are pure-ish (AI only, no side effects); the apply and send
 * functions mutate and are the confirm-gated targets.
 */

const store = require('../store');
const relay = require('../orcha/relay');
let logger; try { logger = require('../utils/logger')('email-actions'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

// Reuse the REAL timeline cleaner exported by ipc/notes.js so an email-derived
// line is normalized exactly like a manually-added one (requiring notes.js only
// defines functions — registerNotesIPC is not invoked on require, so this is a
// safe cross-module reuse, not an IPC side effect).
let cleanTimeline = null;
try { cleanTimeline = require('../ipc/notes').cleanTimeline; } catch (_) { cleanTimeline = null; }

// ── 1. Apply a unit timeline update (mirror of notes:add-timeline) ─────────────
function applyUnitTimelineUpdate(unitId, entry) {
  const uid = String(unitId || '').trim();
  const line = String(entry || '').trim();
  if (!uid) return { ok: false, error: 'unitId required' };
  if (!line) return { ok: false, error: 'entry required' };

  const ns = store.load('notesStore', {}) || {};
  const u = ns[uid] || {};
  u.timeline = u.timeline ? u.timeline + '\n' + line : line;
  if (cleanTimeline) { try { u.timeline = cleanTimeline(u.timeline); } catch (_) {} }
  u.manualEntries = Array.isArray(u.manualEntries) ? u.manualEntries : [];
  u.manualEntries.push(line);
  ns[uid] = u;
  store.save('notesStore', ns);

  // Mirror into fleetData so the unit detail panel + carrier briefing read it.
  try {
    const fd = store.load('fleetData', {}) || {};
    if (fd.rows) {
      const row = fd.rows.find((r) => r.equipmentId === uid);
      if (row) row.repairTimeline = u.timeline;
      store.save('fleetData', fd);
    }
  } catch (e) { logger.warn('[email-actions] fleetData mirror failed: ' + e.message); }

  // Notify the main renderer for an instant refresh (best-effort).
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('notes:updated', { unitId: uid, timeline: u.timeline });
  } catch (_) {}

  // Record a repair-history event too (same as the ai.js TIMELINE action).
  try { require('../orcha/repair-history').addEvent(uid, { summary: line, vendor: '', outcome: 'in-progress' }); } catch (_) {}

  return { ok: true, timeline: u.timeline };
}

// ── AI helper (bounded, with a graceful fallback) ──────────────────────────────
// Wrapped in a hard timeout so a slow/stalled AI backend can never leave the
// overlay's "Drafting…" state hanging indefinitely — on timeout we return ''
// and the caller falls back to an editable starter draft the user can finish.
async function _ask(prompt, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 45000;
  try {
    const raw = await Promise.race([
      relay.ask(prompt, { signal: opts.signal, requestId: opts.requestId }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), timeoutMs)),
    ]);
    const text = (typeof raw === 'string') ? raw.trim() : (raw && raw.text ? String(raw.text).trim() : '');
    return text;
  } catch (e) {
    logger.warn('[email-actions] AI ask failed: ' + e.message);
    return '';
  }
}

// ── 2. Reply drafting + sending ────────────────────────────────────────────────
// Build a compact GROUNDED-CONTEXT block for the reply from the canonical state
// of any in-scope unit the email references (spec §23). This lets the reply
// ANSWER the real question using app truth (current phase, who we're waiting on,
// latest meaningful update, open question) instead of a generic acknowledgement.
// Read-only; returns '' when there's no canonical context to add.
function _replyContextBlock(email) {
  try {
    const refs = Array.isArray(email && email.unitRefs) ? email.unitRefs : [];
    if (!refs.length) return '';
    const canon = ((store.load('canonicalState', {}) || {}).units) || {};
    const blocks = [];
    for (const ref of refs.slice(0, 3)) {
      const rec = ref && ref.unit ? canon[ref.unit] : null;
      if (!rec) continue;
      const bits = [];
      if (rec.situation) bits.push('status: ' + String(rec.situation).slice(0, 160));
      if (rec.repairPhase && rec.repairPhase !== 'unknown') bits.push('repair phase: ' + rec.repairPhase);
      if (rec.waitingOnFine && rec.waitingOnFine !== 'unknown') bits.push('waiting on: ' + rec.waitingOnFine);
      if (rec.nextStep) bits.push('next step: ' + String(rec.nextStep).slice(0, 120));
      if (rec.lastMeaningfulUpdate && rec.lastMeaningfulUpdate.text) bits.push('latest update: ' + String(rec.lastMeaningfulUpdate.text).slice(0, 160));
      if (bits.length) blocks.push('Unit ' + ref.unit + ' — ' + bits.join('; ') + '.');
    }
    if (!blocks.length) return '';
    return '\nGROUNDED FLEET CONTEXT (use ONLY these app facts to answer; do NOT invent anything beyond them):\n' + blocks.map((b) => '- ' + b).join('\n') + '\n';
  } catch (_) { return ''; }
}

function _buildReplyPrompt(email, guidance) {
  const atts = (email.attachments || []).map((a) => a.name + ' [' + a.type + ']').join(', ');
  const lines = [];
  lines.push('You are drafting a professional email REPLY on behalf of a fleet operations manager. Write ONLY the reply body text — no subject, no "To:", no signature block beyond a simple sign-off, no markdown. Keep it concise, warm, and professional.');
  lines.push('');
  lines.push('ORIGINAL EMAIL you are replying to:');
  const fromLine = email.fromName
    ? (email.from ? email.fromName + ' <' + email.from + '>' : email.fromName)
    : (email.from || '(unknown sender)');
  lines.push('From: ' + fromLine);
  lines.push('Subject: ' + (email.subject || '(no subject)'));
  if (atts) lines.push('Attachments: ' + atts);
  lines.push('Body: ' + String(email.bodyText || email.summary || '').slice(0, 2000));
  // §23: fold in grounded canonical fleet context so the reply can actually
  // ANSWER a status/ETC question from app truth rather than a generic reply.
  const ctx = _replyContextBlock(email);
  if (ctx) lines.push(ctx);
  if (guidance) { lines.push(''); lines.push('WHAT THE REPLY SHOULD SAY (follow this intent): ' + guidance); }
  lines.push('');
  lines.push('Write the reply now. Answer the actual question using the grounded fleet context above when it applies. Do not invent facts, prices, dates, or commitments not supported by the original email or the context above. If the question requires an authority decision (approving a cost, authorizing a tow) that the context does not settle, do NOT fabricate approval — write that it is under review.');
  return lines.join('\n');
}

// Draft a reply (AI only, no send). Returns { ok, draft } or a safe fallback.
// NOTE: drafting only needs a sender NAME or SUBJECT — not an email address.
// OWA message rows expose the sender name but not the address, so requiring an
// address here is wrong (it was the bug behind "nothing happens on Reply"). The
// address is only needed at SEND time (sendReply resolves it then).
async function draftReply(email, guidance, opts) {
  if (!email) return { ok: false, error: 'no email' };
  if (!email.from && !email.fromName && !email.subject) {
    return { ok: false, error: 'email has no sender or subject to reply to' };
  }
  const draft = await _ask(_buildReplyPrompt(email, guidance), opts);
  if (draft) return { ok: true, draft };
  // Fallback skeleton the user can edit — never a fabricated commitment.
  const who = email.fromName ? String(email.fromName).split(/[\s,<]/)[0] : '';
  const fb = 'Hi' + (who ? ' ' + who : '') + ',\n\nThank you for your email.\n\n\n\nBest regards';
  return { ok: true, draft: fb, aiUnavailable: true };
}

// Send a reply via the authenticated OWA path. Confirm-gated by the caller.
// Replies to the SENDER only (never reply-all). Subject gets a "Re:" prefix.
async function sendReply(email, bodyText, opts) {
  opts = opts || {};
  if (!email) return { ok: false, error: 'no email' };
  const body = String(bodyText || '').trim();
  if (!body) return { ok: false, error: 'reply body required' };
  // Sending needs a real recipient address. OWA message rows only expose the
  // sender NAME, so if we never captured an address, say so clearly instead of
  // silently failing — the user can copy the draft and send from Outlook.
  if (!email.from || !/@/.test(String(email.from))) {
    return { ok: false, error: 'No sender email address was captured for this message, so it can\'t be auto-sent. Your draft is ready — copy it and reply from Outlook. (Open the email in Outlook once and re-scan to capture the address.)' };
  }

  const subject = /^re:/i.test(email.subject || '') ? email.subject : ('Re: ' + (email.subject || '(no subject)'));
  // Plain-text body rendered in a <pre> so spacing survives OWA's sanitizer
  // (same approach the chat EMAIL path uses).
  const html = '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;white-space:pre-wrap">' +
    body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';

  const { sendViaOwa } = require('./owa-mailer');
  const res = await sendViaOwa({ to: email.from, subject, html, _electron: opts._electron });
  const status = res && res.status;
  if (status === 'sent') return { ok: true, message: 'Reply sent to ' + email.from, status };
  if (status === 'blocked-auth') return { ok: false, error: 'OWA needs sign-in — open Outlook once, then retry.', status };
  if (status === 'delivery-uncertain') return { ok: false, error: 'Reply was submitted but could not be confirmed in Sent Items — check Outlook before resending.', status };
  return { ok: false, error: 'Reply send failed (' + (status || 'unknown') + ')', status };
}

// ── 3. Operator "unit ready" DM drafting + sending ─────────────────────────────
function _buildReadyDmPrompt(unitRef, ownerTag, email) {
  const lines = [];
  lines.push('You are messaging a trucking carrier/operator partner on Slack to tell them one of their units is READY for pickup after a repair. Write ONLY the message text — short, warm, professional, Slack-friendly (a tasteful emoji or two is fine). No markdown headers, no JSON.');
  lines.push('');
  lines.push('FACTS (use only these; never invent a date, price, location, or detail):');
  lines.push('- Unit: ' + unitRef.unit);
  if (unitRef.operator) lines.push('- Operator: ' + unitRef.operator);
  if (unitRef.domicile) lines.push('- Domicile: ' + unitRef.domicile);
  if (unitRef.update) lines.push('- Latest update: ' + unitRef.update);
  if (email && email.summary) lines.push('- Context from the email: ' + String(email.summary).slice(0, 300));
  lines.push('');
  if (ownerTag) lines.push('Start the message by tagging them with EXACTLY this token so Slack notifies them: ' + ownerTag);
  lines.push('Tell them the unit is ready for pickup and to coordinate retrieval. Keep it to 1-3 short sentences.');
  lines.push('MUST NOT mention "Z", "Zila", "FAS", any internal requester, or invent anything not in the facts above.');
  return lines.join('\n');
}

// Resolve the operator entry (channel + owner) for a unit ref.
function _resolveOperator(unitRef) {
  try {
    const { resolveOperatorEntry } = require('./pm_alert_reply');
    return resolveOperatorEntry(unitRef && unitRef.operator) || null;
  } catch (e) {
    logger.warn('[email-actions] resolveOperatorEntry failed: ' + e.message);
    return null;
  }
}

// Draft the operator DM (AI only, no send). Returns { ok, draft, entry } where
// entry is the resolved operator channel/owner (so the caller can send it).
async function draftReadyDm(unitRef, email, opts) {
  if (!unitRef || !unitRef.unit) return { ok: false, error: 'unitRef required' };
  const entry = _resolveOperator(unitRef);
  if (!entry || !entry.channelId) {
    return { ok: false, error: 'No mapped carrier channel for operator "' + (unitRef.operator || '?') + '" — map it in Settings → Operator Channels.' };
  }
  const ownerTag = entry.ownerId ? '<@' + entry.ownerId + '>' : '';
  let draft = await _ask(_buildReadyDmPrompt(unitRef, ownerTag, email), opts);
  if (!draft) {
    draft = (ownerTag ? ownerTag + ' ' : '') + ':wrench: Good news — unit ' + unitRef.unit +
      ' is ready for pickup. Please coordinate retrieval at your convenience.';
  }
  // Safety net: ensure the owner is tagged even if the AI omitted it.
  if (ownerTag && draft.indexOf(ownerTag) === -1) draft = ownerTag + ' ' + draft;
  return { ok: true, draft, entry };
}

// Send the operator "unit ready" DM to the mapped carrier channel. Confirm-gated.
async function sendReadyDm(unitRef, message, opts) {
  opts = opts || {};
  if (!unitRef || !unitRef.unit) return { ok: false, error: 'unitRef required' };
  const body = String(message || '').trim();
  if (!body) return { ok: false, error: 'message required' };
  const entry = opts.entry || _resolveOperator(unitRef);
  if (!entry || !entry.channelId) {
    return { ok: false, error: 'No mapped carrier channel for operator "' + (unitRef.operator || '?') + '".' };
  }
  try {
    const { sendToChannel } = require('./slack_send');
    const r = await sendToChannel(entry.channelId, body);
    const ok = !!(r && r.ok !== false);
    return ok
      ? { ok: true, message: 'Sent "unit ' + unitRef.unit + ' ready" to ' + (entry.operator || entry.channelId) }
      : { ok: false, error: 'Slack send failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 4. Email as a canonical EVIDENCE source (spec §6) ──────────────────────────
// Email is ONE evidence source among AAP/Relay/Offsite/Uptake/Slack — not an
// independent truth system. This records the structured email evidence (the §6
// shape) into a per-unit `emailEvidence` store so canonical reconcile can read
// it as one more source, and flags a CONFLICT (instead of overwriting) when the
// email contradicts fresher canonical evidence. It NEVER mutates the unit
// timeline or canonical state directly — the §17 safe-apply gate + the existing
// confirm-gated applyUnitTimelineUpdate remain the only writers.
//
// buildEmailEvidence(decision, email, unitRef) -> the §6 evidence object.
function buildEmailEvidence(decision, email, unitRef) {
  const d = decision || {};
  const observedAt = String((email && email.receivedText) || d.receivedAt || '').trim();
  return {
    source: 'email',
    field: 'repairUpdate',
    value: String((unitRef && unitRef.update) || (email && email.summary) || '').trim().slice(0, 400),
    observedAt,
    messageId: String((email && email.id) || '').trim(),
    conversationId: String((email && email.convId) || '').trim(),
    sender: String((email && email.from) || (email && email.fromName) || '').trim().slice(0, 160),
    informationType: d.informationType || 'insufficient',
    // usedInConclusion: only true when the email actually carries a usable,
    // non-stale, non-duplicate fact for an in-scope unit.
    usedInConclusion: d.scope === 'mine' && ['new', 'status_change'].includes(d.informationType),
    isConflict: d.informationType === 'contradiction' || !!d.hasConflict,
  };
}

// recordEmailEvidence(decision, email) -> { recorded, conflicts } — persists one
// evidence item per referenced in-scope unit into store 'emailEvidence'
// (keyed by equipmentId, newest-first, bounded). Deduplicates by messageId +
// unit so re-triaging the same email never double-records. Pure storage —
// no timeline/canonical mutation here.
function recordEmailEvidence(decision, email) {
  const d = decision || {};
  const units = Array.isArray(d.units) ? d.units : [];
  if (d.scope !== 'mine' || !units.length) return { recorded: 0, conflicts: 0 };
  const refs = Array.isArray(email && email.unitRefs) ? email.unitRefs : [];
  const refByUnit = {};
  for (const r of refs) if (r && r.unit) refByUnit[r.unit] = r;

  let ev = {};
  try { ev = store.load('emailEvidence', {}) || {}; } catch (_) { ev = {}; }
  let recorded = 0, conflicts = 0;
  for (const unit of units) {
    const item = buildEmailEvidence(d, email, refByUnit[unit]);
    if (!item.value) continue;
    const list = Array.isArray(ev[unit]) ? ev[unit] : [];
    // Dedup by messageId (same email never recorded twice for the same unit).
    if (item.messageId && list.some((x) => x.messageId === item.messageId)) continue;
    list.unshift(item);
    ev[unit] = list.slice(0, 30); // bounded history per unit
    recorded++;
    if (item.isConflict) conflicts++;
  }
  if (recorded) {
    try { store.save('emailEvidence', ev); } catch (e) { logger.warn('[email-actions] emailEvidence save failed: ' + e.message); }
  }
  return { recorded, conflicts };
}

// Read the recorded email evidence for a unit (newest-first). For canonical
// reconcile / Split View consumption.
function getEmailEvidence(unitId) {
  try {
    const ev = store.load('emailEvidence', {}) || {};
    return Array.isArray(ev[String(unitId || '').trim()]) ? ev[String(unitId || '').trim()] : [];
  } catch (_) { return []; }
}

module.exports = {
  applyUnitTimelineUpdate,
  draftReply,
  sendReply,
  draftReadyDm,
  sendReadyDm,
  buildEmailEvidence,
  recordEmailEvidence,
  getEmailEvidence,
  _resolveOperator,
  _buildReplyPrompt,
  _replyContextBlock,
  _buildReadyDmPrompt,
};
