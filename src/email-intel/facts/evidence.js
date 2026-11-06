'use strict';
/**
 * email-intel/facts/evidence.js — email evidence for canonical reconcile (design 4.4 step 8; R3.4, R3.9).
 *
 * Writes the existing `emailEvidence` store (per unit, newest first, 30 entries) with the legacy v1
 * fields (email_actions.buildEmailEvidence shape) plus the additive fields messageKeyV2,
 * conversationKey, factKey, confidence, quote and receivedAt. Deduped by (messageKeyV2, factKey).
 * Evidence is kept separate from authoritative state: canonicalState is never written here, and
 * `usedInConclusion` is true only for a fact that actually landed on the timeline.
 * The sender is the display name only (no address).
 */
const store = require('../../store');
const { FACT_LABELS } = require('../understand/schema');

const PER_UNIT = 30;

function buildEvidence(input) {
  const i = input || {};
  const f = i.fact || {};
  const msg = i.msg || {};
  const name = String((msg.from && msg.from.name) || '').replace(/\s+/g, ' ').trim();
  return {
    source: 'email', field: 'repairUpdate',
    value: ((FACT_LABELS[f.kind] || 'Update') + ': ' + String(f.value || '')).slice(0, 400),
    observedAt: String(msg.receivedAt || ''),
    messageId: String(msg.legacyId || ''), conversationId: String(msg.convIdRaw || ''),
    sender: name && !name.includes('@') ? name.slice(0, 160) : '',
    informationType: i.informationType || 'new',
    usedInConclusion: i.usedInConclusion === true,
    isConflict: i.isConflict === true,
    // additive v2 fields
    messageKeyV2: msg.messageKey || null, conversationKey: msg.conversationKey || null, factKey: (i.keys && i.keys.factKey) || null,
    confidence: Number.isFinite(f.effectiveConfidence) ? f.effectiveConfidence : 0,
    quote: String(f.evidence || '').slice(0, 200), receivedAt: msg.receivedAt || null,
    ledgerKey: i.ledgerKey || null, stagedReason: i.stagedReason || null,
  };
}

/** recordEvidence(input) -> { recorded:boolean } ; input: { unit, fact, keys, msg, usedInConclusion, isConflict, informationType, ledgerKey, stagedReason } */
function recordEvidence(input) {
  const unit = String((input && input.unit) || '').trim();
  if (!unit) return { recorded: false };
  const item = buildEvidence(input);
  let recorded = false;
  try {
    store.update('emailEvidence', (ev) => {
      const doc = ev && typeof ev === 'object' && !Array.isArray(ev) ? ev : {};
      const list = Array.isArray(doc[unit]) ? doc[unit] : [];
      const at = list.findIndex((x) => x && x.messageKeyV2 && x.messageKeyV2 === item.messageKeyV2 && x.factKey === item.factKey);
      if (at !== -1) {
        // a later decision on the same fact (for example user approval) upgrades the entry in place
        if (item.usedInConclusion && !list[at].usedInConclusion) { list[at] = Object.assign({}, list[at], { usedInConclusion: true, ledgerKey: item.ledgerKey, stagedReason: null }); recorded = true; }
        return doc;
      }
      list.unshift(item);
      doc[unit] = list.slice(0, PER_UNIT);
      recorded = true;
      return doc;
    }, {});
  } catch (_) { recorded = false; }
  return { recorded };
}

module.exports = { buildEvidence, recordEvidence };
