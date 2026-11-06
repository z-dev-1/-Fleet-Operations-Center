'use strict';
/**
 * email-intel/understand/schema.js — the v2 triage response schema, its enums and the written
 * confidence rubric (design 3.4, 3.5; R7.1).
 *
 * Confidence is defined explicitly: a JSON number 0..1 per fact, per question / request / answer /
 * commitment, per classification and overall. Anything else (missing, string, null, NaN, negative,
 * > 1) is INVALID and becomes an effective confidence of 0 (confidence.js); there is no default.
 */
const C = require('../constants');
const { PHASE_ORDER } = require('../facts/phase-order');

const CONFIDENCE_RUBRIC = [
  'confidence is YOUR probability, from 0.0 to 1.0, that the item is correct as extracted, meaning ALL of:',
  ' (a) the unit id refers to the unit named, (b) the message itself ASSERTS the fact (it is not a question,',
  " a wish, a plan, a quote of older mail, or someone else's guess), (c) the value (date, amount, state) is exactly what the text says.",
  ' 0.90-1.00 explicit, unambiguous, all three hold.  0.75-0.89 clear, one minor ambiguity (for example a relative date you resolved).',
  ' 0.50-0.74 inference or ambiguity.  below 0.50 guess.  Do not round up. If you cannot judge, use null. Never use 0.7 as a default.',
  'Evidence must be an EXACT quote from the message text. Amounts must appear in the text. Never use attachment filenames as facts.',
].join('\n');

const FACT_KINDS = Object.freeze([
  'repair_stage', 'parts_availability', 'parts_eta', 'estimated_completion', 'approval_status',
  'vendor_status', 'pickup_readiness', 'transportation', 'blocker',
]);

const STATE_ENUMS = Object.freeze({
  repair_stage: PHASE_ORDER,
  parts_availability: Object.freeze(['ordered', 'backordered', 'in_stock', 'shipped', 'arrived', 'unavailable']),
  parts_eta: Object.freeze(['eta_given', 'eta_changed', 'delayed', 'arrived']),
  estimated_completion: Object.freeze(['eta_given', 'eta_changed', 'delayed', 'complete']),
  approval_status: Object.freeze(['requested', 'pending', 'approved', 'denied', 'authorized', 'estimate_received']),
  vendor_status: Object.freeze(['scheduled', 'received_unit', 'diagnosing', 'working', 'waiting', 'completed', 'other']),
  pickup_readiness: Object.freeze(['ready', 'not_ready', 'scheduled']),
  transportation: Object.freeze(['needed', 'scheduled', 'in_transit', 'delivered']),
  blocker: Object.freeze(['parts', 'approval', 'vendor', 'access', 'other', 'cleared']),
});

const ASSERTIONS = Object.freeze(['stated', 'reported-secondhand', 'planned', 'requested', 'speculative', 'retracted']);
const RELEVANCE_LEVELS = Object.freeze(['none', 'low', 'medium', 'high']);
const ADDRESSEE_KINDS = Object.freeze(['me', 'named-other', 'group', 'unclear']);
const DECISION_KINDS = Object.freeze(['approval', 'estimate', 'spend', 'other']);
const COMMITMENT_BY = Object.freeze(['sender', 'other']);

// Display labels for code-generated summaries (adapter templates; never AI text).
const FACT_LABELS = Object.freeze({
  repair_stage: 'Repair stage', parts_availability: 'Parts', parts_eta: 'Parts ETA', estimated_completion: 'Est. completion',
  approval_status: 'Approval', vendor_status: 'Vendor', pickup_readiness: 'Pickup', transportation: 'Transport', blocker: 'Blocker',
});

const LIMITS = Object.freeze({
  FACTS_PER_UNIT: 10, FACTS_PER_MESSAGE: 30, QUESTIONS: 12, REQUESTS: 12, ANSWERS: 8, COMMITMENTS: 5, UNITS: 20,
  VALUE_MAX: 160, ITEM_MAX: 40, GIST_MAX: 120, EVIDENCE_MIN: 8, EVIDENCE_MAX: 200, QUESTION_MAX: 200, NAME_MAX: 60,
  ADDRESSEE_EVIDENCE_MAX: 120, ANSWER_EVIDENCE_MAX: 200, COMMITMENT_MAX: 160, DUE_TEXT_MAX: 60, REASON_MAX: 160,
  DELETE_REASON_MAX: 100, AMOUNT_MAX: 10_000_000, PRIOR_QUESTIONS: 8,
});

/** The schema text placed in the static instructions of every prompt. */
const SCHEMA_TEXT = [
  '{',
  '  "schemaVersion": 2,',
  '  "messageRef": "<echo of MESSAGE META messageRef>",',
  '  "relevance": { "level": "none|low|medium|high", "reason": "<=160 chars", "confidence": 0.0 },',
  '  "units": [{ "unit": "<id from CANDIDATE UNITS>", "gist": "<=120 chars",',
  '    "facts": [{ "kind": "' + FACT_KINDS.join('|') + '",',
  '      "item": "<=40 chars short noun or null", "value": "<=160 chars normalized statement", "state": "<enum for kind>",',
  '      "date": "YYYY-MM-DD or null", "amount": { "value": 0, "currency": "USD" } or null,',
  '      "assertion": "' + ASSERTIONS.join('|') + '",',
  '      "evidence": "<exact quote, 8..200 chars>", "noteConflictHint": false, "confidence": 0.0 }] }],',
  '  "questions": [{ "ref": "q1", "text": "<=200", "about": ["<unit ids>"],',
  '    "addressee": { "kind": "me|named-other|group|unclear", "name": "<=60 or null", "evidence": "<quote <=120 or null>" },',
  '    "isApprovalOrDecision": false, "decisionKind": "approval|estimate|spend|other|null", "confidence": 0.0 }],',
  '  "requests": [{ "ref": "r1", "text": "<=200", "about": [], "addressee": { "kind": "...", "name": null, "evidence": null }, "isApprovalOrDecision": false, "dueText": "<=60 or null", "confidence": 0.0 }],',
  '  "answers": [{ "pqid": "<id from PRIOR OPEN QUESTIONS>", "evidence": "<quote <=200>", "confidence": 0.0 }],',
  '  "commitments": [{ "by": "sender|other", "who": "<=60 or null", "text": "<=160", "dueDate": "YYYY-MM-DD or null", "confidence": 0.0 }],',
  '  "classification": { "category": "<category>", "intent": "<intent>", "informationalOnly": false, "confidence": 0.0 },',
  '  "suggestDelete": { "suggested": false, "reason": "<=100", "confidence": 0.0 },',
  '  "overallConfidence": 0.0',
  '}',
].join('\n');

function stateEnumText() {
  return FACT_KINDS.map((k) => '- ' + k + ': ' + STATE_ENUMS[k].join('|')).join('\n');
}

module.exports = {
  SCHEMA_VERSION: C.SCHEMA_VERSION, PROMPT_VERSION: C.PROMPT_VERSION, CONFIDENCE_RUBRIC, FACT_KINDS, STATE_ENUMS, ASSERTIONS,
  RELEVANCE_LEVELS, ADDRESSEE_KINDS, DECISION_KINDS, COMMITMENT_BY, FACT_LABELS, LIMITS, SCHEMA_TEXT, stateEnumText,
};
