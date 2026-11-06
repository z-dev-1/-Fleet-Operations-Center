'use strict';
/**
 * email-intel/reply/context.js — the conversation context for a thread-aware reply draft (design 6.2 step 2;
 * R5.1, R5.3).
 *
 *   buildReplyContext({ records, questions, units, canonicalFor, ledgerEntries, stagedItems, me, nonce })
 *     -> { text, messages:[{ messageKey, index, role, chars }], questionStates:[{ questionId, status, owner, addressee }],
 *          facts:{ verified:[], applied:[], unverified:[] }, units }
 *   inScopeUnits(records)  units the deterministic scan put in scope for this conversation (max 10)
 *
 * Messages: the LAST 6 messages' newContent, oldest first, each clipped to 1,500 characters (total 8,000), each in
 * its own nonce fence with a code-added header line (sender display name, received time, my recipient role).
 * Question states carry their ids and status; the question wording is model output, so it sits in a fence too.
 * Facts per in-scope unit, each with an explicit label:
 *   VERIFIED                          canonical state (getCanonical)
 *   FROM EMAIL, applied               timeline-ledger entries already applied
 *   UNVERIFIED, do not state as fact  open staged / conflicting facts; staged READY claims are never offered (R3.5)
 * Pure apart from canonicalFor (injected). Nothing here logs.
 */
const untrusted = require('../untrusted');
const { cleanLabel } = require('../confirm');
const { recipientRole } = require('../understand/ownership');
const { FACT_LABELS } = require('../understand/schema');
const { isReadyClaim } = require('../facts/reconcile');

const MAX_MESSAGES = 6;
const PER_MESSAGE_CHARS = 1_500;
const TOTAL_CHARS = 8_000;
const MAX_UNITS = 10;
const MAX_FACTS_PER_LABEL = 12;
const ROLE_TEXT = { 'to-direct': 'you are in To', 'to-dl': 'you are reached through a distribution list in To', cc: 'you are in CC', 'cc-dl': 'you are reached through a distribution list in CC', 'sender-self': 'sent by you', unknown: 'your role is unknown' };

function inScopeUnits(records) {
  const s = new Set();
  for (const r of records || []) {
    const det = (r && r.analysis && r.analysis.deterministic) || {};
    for (const u of (det.units || [])) if (u && u.scope === 'in' && u.unit) s.add(String(u.unit));
  }
  return Array.from(s).slice(0, MAX_UNITS);
}

const _label = (kind) => FACT_LABELS[kind] || String(kind || 'Update');
const _clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; };

function _canonLines(unit, canonicalFor) {
  let c = null;
  try { c = typeof canonicalFor === 'function' ? canonicalFor(unit) : null; } catch (_) { c = null; }
  if (!c || typeof c !== 'object') return [];
  const bits = [];
  if (c.status) bits.push('status ' + _clip(c.status, 40));
  if (c.repairPhase && c.repairPhase !== 'unknown') bits.push('repair phase ' + _clip(c.repairPhase, 40));
  if (c.waitingOnFine && c.waitingOnFine !== 'unknown') bits.push('waiting on ' + _clip(c.waitingOnFine, 40));
  if (c.nextStep) bits.push('next step ' + _clip(c.nextStep, 120));
  if (c.lastMeaningfulUpdate && c.lastMeaningfulUpdate.text) bits.push('latest update ' + _clip(c.lastMeaningfulUpdate.text, 160));
  return bits.length ? ['Unit ' + unit + ': ' + bits.join('; ')] : [];
}

function buildReplyContext(input) {
  const i = input || {};
  const nonce = i.nonce || untrusted.newNonce();
  const all = Array.isArray(i.records) ? i.records : [];
  const recent = all.slice(-MAX_MESSAGES);
  const units = Array.isArray(i.units) ? i.units.slice(0, MAX_UNITS) : inScopeUnits(all);
  const parts = [];
  const messages = [];
  let budget = TOTAL_CHARS;
  // Newest messages keep their budget first; the output is still oldest first.
  const clipped = new Array(recent.length);
  for (let k = recent.length - 1; k >= 0; k--) {
    const text = _clip((recent[k].body && recent[k].body.newContent) || '', Math.min(PER_MESSAGE_CHARS, Math.max(0, budget)));
    budget -= text.length;
    clipped[k] = text;
  }
  recent.forEach((rec, k) => {
    const role = recipientRole(rec, i.me);
    const who = cleanLabel(untrusted.sanitize((rec.from && rec.from.name) || 'unknown sender', nonce), 60) || 'unknown sender';
    const when = rec.receivedAt ? String(rec.receivedAt).slice(0, 25) : 'time unknown';
    const partial = rec.body && rec.body.status && rec.body.status !== 'complete' ? ' (content ' + cleanLabel(rec.body.status, 20) + ')' : '';
    parts.push('Message ' + (all.length - recent.length + k + 1) + ' of ' + all.length + ' | from: ' + who + ' | received: ' + when + ' | ' + (ROLE_TEXT[role] || ROLE_TEXT.unknown) + partial);
    parts.push(untrusted.fence('EMAIL', clipped[k], nonce));
    messages.push({ messageKey: rec.messageKey, index: all.length - recent.length + k + 1, role, chars: clipped[k].length });
  });

  const qs = Object.values(i.questions || {}).filter((q) => q && !q.mergedInto);
  const questionStates = qs.map((q) => ({ questionId: q.questionId, status: q.status, owner: q.owner, addressee: (q.addressee && q.addressee.kind) || 'unclear' }));
  if (qs.length) {
    parts.push('QUESTION STATES (code-built; "answered" means someone already answered it in the thread, do not answer it again):');
    for (const q of qs) parts.push('- ' + q.questionId + ': status=' + q.status + ', addressed to=' + ((q.addressee && q.addressee.kind) || 'unclear') + ', owner=' + (q.owner || 'unknown'));
    parts.push(untrusted.fence('QUESTION_TEXT', qs.map((q) => q.questionId + ': ' + _clip(q.text, 200)).join('\n'), nonce));
  }

  const verified = []; const applied = []; const unverified = [];
  const unitSet = new Set(units);
  for (const u of units) verified.push(..._canonLines(u, i.canonicalFor));
  for (const e of (i.ledgerEntries || [])) {
    if (!e || e.state !== 'applied' || !unitSet.has(String(e.unit)) || applied.length >= MAX_FACTS_PER_LABEL) continue;
    const f = e.fact || {};
    applied.push('Unit ' + e.unit + ': ' + _label(e.kind || f.kind) + ': ' + _clip(f.value, 160));
  }
  for (const s of (i.stagedItems || [])) {
    if (!s || s.state !== 'open' || !s.fact || !unitSet.has(String(s.unit)) || unverified.length >= MAX_FACTS_PER_LABEL) continue;
    if (isReadyClaim(s.fact)) continue;                                   // R3.5: a staged ready claim is never offered as a fact
    unverified.push('Unit ' + s.unit + ': ' + _label(s.fact.kind) + ': ' + _clip(s.fact.value, 160));
  }
  const factLines = []
    .concat(verified.map((l) => 'VERIFIED: ' + l))
    .concat(applied.map((l) => 'FROM EMAIL, applied: ' + l))
    .concat(unverified.map((l) => 'UNVERIFIED, do not state as fact: ' + l));
  if (factLines.length) {
    parts.push('FLEET FACTS for your units (each line is labeled; state only VERIFIED or FROM EMAIL, applied facts as facts):');
    parts.push(untrusted.fence('FLEET_FACTS', factLines.join('\n'), nonce));
  } else {
    parts.push('FLEET FACTS: none available. Do not state any unit status, date or cost as a fact.');
  }
  return { text: parts.join('\n'), nonce, messages, questionStates, facts: { verified, applied, unverified }, units };
}

module.exports = { buildReplyContext, inScopeUnits, MAX_MESSAGES, PER_MESSAGE_CHARS, TOTAL_CHARS };
