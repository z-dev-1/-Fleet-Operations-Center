'use strict';
/**
 * orcha/fas/case-store.js — Digital FAS Stage 8: persistent case memory.
 *
 * Case memory lives OUTSIDE the AI context. Before handling a new message we
 * fetch only the related case(s); after handling we update a COMPACT summary —
 * we never stuff unlimited raw AI conversation history into future prompts.
 *
 * Keyed by caseId (typically "unit-<id>", or "sender-<slackId>" for non-unit
 * threads). Stored in the `fasCases` store.
 */

const store = require('../../store');
const now = () => new Date().toISOString();

function _load() {
  const raw = store.load('fasCases', {});
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}
function _save(all) { store.save('fasCases', all); }

function _blank(caseId, unit) {
  return {
    caseId,
    unit: unit || null,
    status: 'open',                // open | resolved | escalated
    currentSummary: '',
    verifiedFacts: [],
    openQuestions: [],
    promises: [],                  // [{text, madeAt, dueAt, owner}]
    completedActions: [],
    failedActions: [],
    responsibleParty: '',
    nextFollowUpAt: null,
    relatedSlackMessages: [],      // [{channelId, ts}]
    sources: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

function caseIdForUnit(unit) { return 'unit-' + String(unit).trim().toLowerCase(); }
function caseIdForSender(slackId) { return 'sender-' + slackId; }

function getCase(caseId) {
  const all = _load();
  return all[caseId] || null;
}

/** Find related cases for an incoming message: unit-based first, then sender. */
function findRelated({ units, slackId }) {
  const all = _load();
  const out = [];
  (units || []).forEach(u => { const c = all[caseIdForUnit(u)]; if (c) out.push(c); });
  if (slackId && all[caseIdForSender(slackId)]) out.push(all[caseIdForSender(slackId)]);
  return out;
}

/**
 * upsert(caseId, patch) — merge a compact update into a case. Arrays in the
 * patch are APPENDED (capped) rather than replacing, except currentSummary /
 * status / responsibleParty / nextFollowUpAt which are set.
 */
function upsert(caseId, patch, unit) {
  const all = _load();
  const c = all[caseId] || _blank(caseId, unit);
  const appendCap = (arr, add, cap) => {
    if (!add) return arr;
    const merged = arr.concat(Array.isArray(add) ? add : [add]);
    return merged.slice(-1 * (cap || 50));
  };
  if (patch.currentSummary != null) c.currentSummary = String(patch.currentSummary).slice(0, 1000);
  if (patch.status) c.status = patch.status;
  if (patch.responsibleParty != null) c.responsibleParty = patch.responsibleParty;
  if (patch.nextFollowUpAt !== undefined) c.nextFollowUpAt = patch.nextFollowUpAt;
  if (patch.unit && !c.unit) c.unit = patch.unit;
  // verifiedFacts: NEWER facts SUPERSEDE older ones for the same field (Part 7)
  // — don't accumulate conflicting permanent values. Incoming facts replace any
  // existing fact with the same `field`; other fields are preserved.
  if (patch.verifiedFacts && patch.verifiedFacts.length) {
    const incoming = Array.isArray(patch.verifiedFacts) ? patch.verifiedFacts : [patch.verifiedFacts];
    const incomingFields = new Set(incoming.map(f => f && f.field).filter(Boolean));
    const kept = (c.verifiedFacts || []).filter(f => !(f && f.field && incomingFields.has(f.field)));
    c.verifiedFacts = kept.concat(incoming).slice(-40);
  }
  c.openQuestions = appendCap(c.openQuestions, patch.openQuestions, 20);
  c.promises = appendCap(c.promises, patch.promises, 30);
  c.completedActions = appendCap(c.completedActions, patch.completedActions, 40);
  c.failedActions = appendCap(c.failedActions, patch.failedActions, 40);
  c.relatedSlackMessages = appendCap(c.relatedSlackMessages, patch.relatedSlackMessages, 50);
  c.sources = appendCap(c.sources, patch.sources, 40);
  c.updatedAt = now();
  all[caseId] = c;
  _save(all);
  return c;
}

/** Cases with a follow-up due at or before `whenISO` (default now). */
function dueFollowUps(whenISO) {
  const cutoff = whenISO || now();
  const all = _load();
  return Object.values(all).filter(c => c.status === 'open' && c.nextFollowUpAt && c.nextFollowUpAt <= cutoff);
}

/** Mark that a due follow-up was surfaced now (anti-spam: controls resurface). */
function markSurfaced(caseId, atISO) {
  const all = _load();
  const c = all[caseId];
  if (!c) return null;
  c.lastSurfacedAt = atISO || now();
  c.updatedAt = now();
  _save(all);
  return c;
}

/** Snooze a follow-up until `untilISO` (keeps the case open). */
function snoozeFollowUp(caseId, untilISO) {
  const all = _load();
  const c = all[caseId];
  if (!c) return { ok: false, error: 'case not found' };
  const ms = Date.parse(untilISO);
  if (isNaN(ms)) return { ok: false, error: 'invalid snooze date' };
  c.nextFollowUpAt = new Date(ms).toISOString();
  c.lastSurfacedAt = null; // allow it to resurface when the new time comes
  c.updatedAt = now();
  _save(all);
  return { ok: true, case: c };
}

/** Complete a follow-up: clears the due time and records completion. */
function completeFollowUp(caseId, note) {
  const all = _load();
  const c = all[caseId];
  if (!c) return { ok: false, error: 'case not found' };
  c.nextFollowUpAt = null;
  c.completedActions = (c.completedActions || []).concat([{ tool: 'FOLLOW_UP', note: String(note || '').slice(0, 300), at: now() }]).slice(-40);
  c.updatedAt = now();
  _save(all);
  return { ok: true, case: c };
}

/** Dismiss a follow-up: clears the due time WITHOUT recording completion. */
function dismissFollowUp(caseId) {
  const all = _load();
  const c = all[caseId];
  if (!c) return { ok: false, error: 'case not found' };
  c.nextFollowUpAt = null;
  c.updatedAt = now();
  _save(all);
  return { ok: true, case: c };
}

module.exports = { getCase, findRelated, upsert, caseIdForUnit, caseIdForSender, dueFollowUps,
  markSurfaced, snoozeFollowUp, completeFollowUp, dismissFollowUp };
