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
 *
 * Phase B (`multiRecipient`): buildPhaseBResults / phaseBRecord derive every legacy field by code from
 * the v2 analysis of the latest message (design 2.9 table). `ready` is true only when a ready claim is
 * verified by canonical state (status ready_for_pickup) and readyDmSuggested is not false (F2-01).
 * Legacy importance vocabulary is kept ('high' | 'normal' | 'low'; the design's "medium" is 'normal').
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
  const labels = _attachmentsOn();
  return (Array.isArray(list) ? list : []).map((a) => {
    const out = {
      name: a.name || 'attachment', ext: a.ext || '',
      type: a.kind === 'image' ? 'image' : a.kind === 'document' ? 'document' : 'file',
    };
    // Phase F (R6.3): the overlay labels "Analyzed" vs "Filename only". Added only while `attachments` is effective.
    if (labels) {
      const an = (a && a.analysis) || {};
      out.analysisStatus = typeof an.status === 'string' ? an.status : 'filename-only';
      if (an.reasonText) out.analysisReason = String(an.reasonText).slice(0, 80);
    }
    return out;
  });
}

function _attachmentsOn() {
  try { return require('../flags').get().effective.attachments === true; } catch (_) { return false; }
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

// ── Phase B derivation (multiRecipient effective): every legacy field from the v2 analysis, by code ──
// Templates only; the only model-derived strings are validated fact values (evidence-checked, length-capped,
// secret-screened). Legacy triageEmails / _buildDecision are never called on this path, so the legacy
// 0.7 / 0.4 confidence fallback is unreachable (confidence is overallConfidence when valid, else 0).

const OWNER_MAP = { me: 'me', vendor: 'vendor', 'other-person': 'internal_team', 'other-team': 'internal_team', shared: 'internal_team' };
const PENDING_TEXT = { pending: "Couldn't analyze yet", 'pending-reextract': "Couldn't analyze yet", 'ai-unavailable': "Couldn't analyze yet (AI unavailable)", invalid: "Couldn't analyze yet", 'failed-permanent': "Couldn't analyze" };

function _label(kind) {
  try { return require('../understand/schema').FACT_LABELS[kind] || 'Update'; } catch (_) { return 'Update'; }
}

/** In-scope facts of the latest message, best first (effective confidence, then validated confidence). */
function _topFacts(res) {
  const out = [];
  for (const u of (res && res.units) || []) {
    if (u.scope !== 'in') continue;
    for (const f of u.facts || []) out.push({ unit: u.unit, f });
  }
  return out.sort((a, b) => ((b.f.effectiveConfidence || 0) - (a.f.effectiveConfidence || 0)) || ((b.f.confidence || 0) - (a.f.confidence || 0)));
}

function _readyClaim(facts, unit) {
  let phases = ['ready_for_pickup'];
  try { phases = require('../facts/phase-order').READY_PHASES; } catch (_) { /* default */ }
  return facts.some((x) => x.unit === unit && ((x.f.kind === 'pickup_readiness' && x.f.state === 'ready') || (x.f.kind === 'repair_stage' && phases.includes(x.f.state))));
}

/**
 * phaseBRecord(view, prev, ctx) -> legacy record derived from the latest message's analysis.
 * ctx: { cfg:{readyDmSuggested}, canonicalFor(unit), fleetRow(unit), appliedFor(messageKey), deleteFor(records), nowIso }
 */
function phaseBRecord(view, prev, ctx) {
  const recs = view.records;
  const latest = recs[recs.length - 1];
  const a = latest.analysis || {};
  const res = a.status === 'ok' ? a.result : null;
  const d = a.determinations || null;
  const det = a.deterministic || {};
  const carry = _carry(prev, latest.messageKey);
  const facts = _topFacts(res);
  const relevance = d ? d.informationRelevance : null;
  const reply = d ? d.replyRequirement.value : 'unknown';
  const decisionVal = d ? d.decisionRequirement.value : 'none';

  // Units: in-scope units from the deterministic pass and the validated result.
  const unitIds = [];
  const add = (id) => { if (id && !unitIds.includes(id)) unitIds.push(id); };
  for (const u of det.units || []) if (u.scope === 'in') add(u.unit);
  for (const u of (res && res.units) || []) if (u.scope === 'in') add(u.unit);
  const anyIn = unitIds.length > 0;
  const anyOut = (det.units || []).some((u) => u.scope === 'out');
  const prevRefs = {};
  for (const r of (prev && prev.unitRefs) || []) prevRefs[r.unit] = r;
  let verifiedReady = false;
  const unitRefs = unitIds.slice(0, 20).map((unit) => {
    const row = (ctx.fleetRow && ctx.fleetRow(unit)) || {};
    const top = facts.find((x) => x.unit === unit);
    const claim = _readyClaim(facts, unit);
    const verified = claim && _canonStatus(unit, ctx.canonicalFor) === 'ready_for_pickup';      // verifiedBy canonical only
    if (verified) verifiedReady = true;
    const sameMsg = prev && prev.intel && prev.intel.latestMessageKey === latest.messageKey;
    const ref = {
      unit, operator: String(row.operator || ''), domicile: String(row.domicileSite || ''),
      update: top ? (_label(top.f.kind) + ': ' + top.f.value).slice(0, 160) : '',
      ready: verified && !(ctx.cfg && ctx.cfg.readyDmSuggested === false),
      readyDmSent: !!(sameMsg && prevRefs[unit] && prevRefs[unit].readyDmSent),
    };
    if (claim && !verified) ref.readyUnverified = true;
    return ref;
  });

  const status = String(a.status || 'pending');
  let summary;
  if (facts.length) summary = facts.slice(0, 3).map((x) => _label(x.f.kind) + ': ' + x.f.value + ' (' + x.unit + ')').join('; ');
  else if (PENDING_TEXT[status]) summary = PENDING_TEXT[status];
  else summary = relevance ? relevance.reason : 'Informational';

  const importance = (decisionVal === 'me' || reply === 'required' || verifiedReady) ? 'high'
    : (relevance && (relevance.level === 'high' || relevance.level === 'medium')) ? 'normal' : 'low';
  const why = d && reply === 'required' ? d.replyRequirement.reason
    : d && decisionVal === 'me' ? d.decisionRequirement.reason
    : (relevance ? relevance.reason : (PENDING_TEXT[status] || ''));
  const scope = anyIn ? 'mine' : (anyOut ? 'other_fas' : 'unknown');
  const cls = (res && res.classification) || det.classification || { category: 'unknown', intent: 'none' };
  const firstOpen = d ? d.actionOwnership.items.find((x) => x.state === 'open' && x.type !== 'commitment') : null;
  const del = typeof ctx.deleteFor === 'function' ? ctx.deleteFor(recs) : { suggested: false };
  return Object.assign({}, carry, {
    id: latest.legacyId, convId: latest.convIdRaw || '', from: (latest.from && latest.from.address) || '', fromName: (latest.from && latest.from.name) || '',
    subject: latest.subject || '(no subject)', receivedText: latest.receivedAtRaw || '', folder: latest.folder || 'Inbox',
    bodyText: String((latest.body && latest.body.newContent) || '').slice(0, C.BODY_FOR_LEGACY_CAP),
    attachments: legacyAttachments(latest.attachments),
    summary: String(summary).slice(0, 600), importance, importanceWhy: String(why || '').slice(0, 200),
    scope, category: cls.category || 'unknown', intent: cls.intent || 'none',
    replySuggested: reply === 'required' || reply === 'suggested', deleteSuggested: !!(del && del.suggested),
    unitRefs,
    decision: {
      replyNeeded: reply === 'required', actionOwner: firstOpen ? (OWNER_MAP[firstOpen.owner] || 'none') : 'none', scope,
      decisionRequired: decisionVal === 'me', decisionKind: d ? d.decisionRequirement.kind : null,
      informationRelevance: relevance ? relevance.level : null, replyRequirement: reply, decisionRequirement: decisionVal,
    },
    unitUpdateApplied: !!(typeof ctx.appliedFor === 'function' && ctx.appliedFor(latest.messageKey)),
    confidence: res && res.overallValid && Number.isFinite(res.overallConfidence) ? res.overallConfidence : 0,
    triagedAt: a.analyzedAt || ctx.nowIso, firstSeenAt: (prev && prev.firstSeenAt) || a.analyzedAt || ctx.nowIso,
    intel: Object.assign(_intelMeta(view, prev), { analysisStatus: status }),
  });
}

/**
 * buildPhaseBResults({ prev, views, meta, cfg, canonicalFor, fleetRow, appliedFor, deleteFor, now }) -> LegacyResults
 * Same contract and ordering as buildResults; records of conversations outside `views` are carried.
 */
function buildPhaseBResults(input) {
  const prev = input.prev && Array.isArray(input.prev.emails) ? input.prev : { emails: [] };
  const meta = input.meta || {};
  const nowIso = new Date(Number.isFinite(input.now) ? input.now : Date.now()).toISOString();
  const prevById = {};
  for (const e of prev.emails) prevById[e.id] = e;
  const fresh = []; const freshIds = {};
  const ctx = { cfg: input.cfg, canonicalFor: input.canonicalFor, fleetRow: input.fleetRow, appliedFor: input.appliedFor, deleteFor: input.deleteFor, nowIso };
  for (const view of input.views || []) {
    if (!view.records || !view.records.length) continue;
    const id = view.records[view.records.length - 1].legacyId;
    if (freshIds[id]) continue;
    freshIds[id] = 1;
    fresh.push(phaseBRecord(view, prevById[id], ctx));
  }
  const merged = fresh.slice();
  for (const e of prev.emails) if (!freshIds[e.id]) merged.push(e);
  merged.sort((a, b) => String(b.triagedAt || b.firstSeenAt || '').localeCompare(String(a.triagedAt || a.firstSeenAt || '')));
  return {
    emails: merged.slice(0, LEGACY_CAP), ranAt: nowIso, authBlocked: !!meta.authBlocked, readError: meta.readError || null,
    intel: Object.assign({ scanId: null, outcome: 'complete', partial: false, coalesced: false }, meta.intel || {}),
  };
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

module.exports = { CONFLICTING_CANONICAL, LEGACY_CAP, legacyAttachments, toLegacyEmail, buildResults, phaseBRecord, buildPhaseBResults, skippedResults, failedResults };
