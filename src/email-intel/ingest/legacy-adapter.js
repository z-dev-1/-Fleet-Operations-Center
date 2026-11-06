'use strict';
/**
 * email-intel/ingest/legacy-adapter.js — maps the message ledger back onto the legacy
 * `emailTriageResults` shape so the overlay, Keep/Delete/Draft handlers, ai.js digest and the
 * auto-scan tick keep working unchanged (design 2.9, F-01).
 *
 *   toLegacyEmail(view)           -> the email object legacy triageEmails() expects (latest message of a conversation)
 *   buildResults(input)           -> LegacyResults (the object runTriage resolves to AND the stored document)
 *   skippedResults(prev, skipped) -> LegacyResults for a scheduled skip (keeps supervisor isSkip semantics)
 *   failedResults(prev)           -> LegacyResults for a scan that failed before writing anything
 *
 * Phase A (`capture` only): the legacy triageEmails fills the decision fields exactly as today.
 * Reply state, drafts, kept / deleted and readyDmSent carry from the previous record only when the
 * conversation's latest message is unchanged (a new reply starts fresh), except replyState 'uncertain',
 * which carries until the send attempt is reconciled. One Phase A safety post-filter applies: a
 * unitRef is never `ready` while the canonical status says the unit is in repair, awaiting parts /
 * approval / vendor, or down (R3.5). readyDmSuggested === false forces unitRefs[].ready false (F2-01).
 */
const C = require('../constants');

const CONFLICTING_CANONICAL = new Set(['in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor', 'down']);
const LEGACY_CAP = 100;

function _canonStatus(unit, canonicalFor) {
  try {
    const rec = canonicalFor ? canonicalFor(unit) : null;
    return rec && rec.status ? String(rec.status) : '';
  } catch (_) { return ''; }
}

/** Attachment list in the legacy shape; placeholders are shown as "attachment" (never an invented name). */
function legacyAttachments(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    name: a.name || 'attachment', ext: a.ext || '',
    type: a.kind === 'image' ? 'image' : a.kind === 'document' ? 'document' : 'file',
  }));
}

/** view: { conversationKey, records:[MessageRecord oldest first] } -> the email handed to legacy triageEmails. */
function toLegacyEmail(view) {
  const recs = view.records;
  const latest = recs[recs.length - 1];
  return {
    id: latest.legacyId, convId: latest.convIdRaw || '',
    from: (latest.from && latest.from.address) || '', fromName: (latest.from && latest.from.name) || '',
    subject: latest.subject || '(no subject)', receivedText: latest.receivedAtRaw || '',
    bodyText: String((latest.body && latest.body.newContent) || '').slice(0, C.BODY_FOR_LEGACY_CAP),
    attachments: legacyAttachments(latest.attachments), folder: latest.folder || 'Inbox',
  };
}

function _intelMeta(view, prev) {
  const recs = view.records;
  const latest = recs[recs.length - 1];
  const incomplete = recs.some((r) => r.flags && r.flags.threadContextIncomplete);
  return {
    conversationKey: view.conversationKey, latestMessageKey: latest.messageKey, messageCount: recs.length,
    bodyStatus: latest.body && latest.body.status, recipientsKnown: !!latest.recipientsKnown, threadContextIncomplete: incomplete,
    actionIds: (prev && prev.intel && prev.intel.actionIds) || [], stagedIds: (prev && prev.intel && prev.intel.stagedIds) || [],
    analysisStatus: 'legacy-triage',
  };
}

/** Fields carried from the previous record: only when the latest message is unchanged (or the prev record predates intel). */
function _carry(prev, latestKey) {
  if (!prev) return { replyDraft: '', replyState: 'none', unitUpdateApplied: false, readyDmSent: false, kept: false, deleted: false };
  const sameMessage = !prev.intel || prev.intel.latestMessageKey === latestKey;
  const uncertain = prev.replyState === 'uncertain';
  if (!sameMessage && !uncertain) return { replyDraft: '', replyState: 'none', unitUpdateApplied: false, readyDmSent: false, kept: false, deleted: false };
  const out = {
    replyDraft: prev.replyDraft || '', replyState: prev.replyState || 'none', unitUpdateApplied: !!prev.unitUpdateApplied, readyDmSent: !!prev.readyDmSent,
    kept: !!prev.kept, deleted: !!prev.deleted,
  };
  if (prev.deletedAt) out.deletedAt = prev.deletedAt;
  if (!sameMessage && uncertain) { out.replyState = 'uncertain'; out.replyDraft = prev.replyDraft || ''; }
  return out;
}

/** F2-01 + R3.5 filters on a record's unitRefs (never turns a ready flag ON). */
function _filterUnitRefs(refs, cfg, canonicalFor) {
  return (Array.isArray(refs) ? refs : []).map((u) => {
    if (!u || !u.ready) return u;
    if (cfg && cfg.readyDmSuggested === false) return Object.assign({}, u, { ready: false });
    if (CONFLICTING_CANONICAL.has(_canonStatus(u.unit, canonicalFor))) return Object.assign({}, u, { ready: false, readyConflict: true });
    return u;
  });
}

/**
 * buildResults({ prev, views, triaged, meta, cfg, canonicalFor, now }) -> LegacyResults
 *   prev: previous stored results; views: touched conversations (oldest-first records);
 *   triaged: legacy triageEmails records keyed by id (for NEW latest messages only);
 *   meta: { authBlocked, readError, intel:{scanId,outcome,partial,coalesced} }
 *   cfg: { readyDmSuggested } read ONCE per scan by the orchestrator
 */
function buildResults(input) {
  const prev = input.prev && Array.isArray(input.prev.emails) ? input.prev : { emails: [] };
  const triaged = input.triaged || {};
  const meta = input.meta || {};
  const nowIso = new Date(Number.isFinite(input.now) ? input.now : Date.now()).toISOString();
  const prevById = {};
  for (const e of prev.emails) prevById[e.id] = e;
  const fresh = [];
  const freshIds = {};
  for (const view of input.views || []) {
    if (!view.records || !view.records.length) continue;
    const latest = view.records[view.records.length - 1];
    const id = latest.legacyId;
    const p = prevById[id];
    const t = triaged[id];
    const intel = _intelMeta(view, p);
    if (t) {
      freshIds[id] = 1;
      const carry = _carry(p, latest.messageKey);
      fresh.push(Object.assign({}, t, carry, {
        id, convId: latest.convIdRaw || '', from: (latest.from && latest.from.address) || t.from || '', fromName: (latest.from && latest.from.name) || t.fromName || '',
        subject: latest.subject || t.subject, receivedText: latest.receivedAtRaw || t.receivedText || '', folder: latest.folder || t.folder || 'Inbox',
        bodyText: String((latest.body && latest.body.newContent) || '').slice(0, C.BODY_FOR_LEGACY_CAP),
        attachments: legacyAttachments(latest.attachments),
        firstSeenAt: (p && p.firstSeenAt) || t.triagedAt || nowIso,
        unitRefs: _filterUnitRefs(t.unitRefs, input.cfg, input.canonicalFor),
        intel,
      }));
    } else if (p && p.intel && p.intel.latestMessageKey === latest.messageKey) {
      freshIds[id] = 1;
      // Same latest message: keep the stored legacy decision, refresh the additive intel summary.
      fresh.push(Object.assign({}, p, { convId: p.convId || latest.convIdRaw || '', unitRefs: _filterUnitRefs(p.unitRefs, input.cfg, input.canonicalFor), intel }));
    }
  }
  const merged = fresh.slice();
  for (const e of prev.emails) if (!freshIds[e.id]) merged.push(e);
  merged.sort((a, b) => String(b.triagedAt || b.firstSeenAt || '').localeCompare(String(a.triagedAt || a.firstSeenAt || '')));
  const out = {
    emails: merged.slice(0, LEGACY_CAP), ranAt: nowIso,
    authBlocked: !!meta.authBlocked, readError: meta.readError || null,
    intel: Object.assign({ scanId: null, outcome: 'complete', partial: false, coalesced: false }, meta.intel || {}),
  };
  return out;
}

/** A scheduled scan skipped by the lock: the stored results plus `skipped` so the supervisor's isSkip works. */
function skippedResults(prev, skipped) {
  const base = prev && Array.isArray(prev.emails) ? prev : { emails: [], ranAt: null, authBlocked: false };
  return Object.assign({}, base, { skipped, intel: { scanId: null, outcome: 'skipped', partial: false, coalesced: false } });
}

/** A scan that failed before writing anything: the stored results with a read error. */
function failedResults(prev, readError, errorCode) {
  const base = prev && Array.isArray(prev.emails) ? prev : { emails: [], ranAt: null, authBlocked: false };
  return Object.assign({}, base, { authBlocked: false, readError: readError || 'read failed', intel: { scanId: null, outcome: 'failed', partial: false, coalesced: false, errorCode: errorCode || 'read-failed' } });
}

module.exports = { CONFLICTING_CANONICAL, LEGACY_CAP, legacyAttachments, toLegacyEmail, buildResults, skippedResults, failedResults };
