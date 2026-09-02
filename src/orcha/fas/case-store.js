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
  c.verifiedFacts = appendCap(c.verifiedFacts, patch.verifiedFacts, 40);
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

module.exports = { getCase, findRelated, upsert, caseIdForUnit, caseIdForSender, dueFollowUps };
