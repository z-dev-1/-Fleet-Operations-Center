'use strict';
/**
 * writes/relay-action-policy.js — the escalation SOP and style exemplars used by the
 * Relay action drafter (writes/relay-action-draft.js) for the unit-detail Escalate and
 * Add Relay Comment modals.
 *
 *   ESCALATION_TARGETS  ordered RG escalation types { key, label, sop }
 *   STYLE_EXEMPLARS     few-shot example lines per target (SHORT ALL CAPS)
 *   TOWING_NOTE         towing is never an RG escalation
 *   HVE_HINT            High Value Estimate: the threshold is confirmed with the MCS lead
 *   COMMENT_TEMPLATES   Relay comment template ids
 *
 * Text only. No numeric threshold lives here or anywhere in the drafter: the High Value
 * Estimate cut-off is contested and is confirmed with the MCS lead per unit.
 */

const TOWING_NOTE = 'Towing goes through a SIM, not RG escalation.';
const HVE_HINT = 'confirm threshold with MCS lead';

const ESCALATION_TARGETS = Object.freeze([
  Object.freeze({
    key: 'FAS', label: 'FAS',
    sop: 'Use when the vendor has gone quiet or missed an ETR and the FAS needs to push the vendor for status or an ETA. State how long since the last vendor update and what is needed.',
  }),
  Object.freeze({
    key: 'MCS_LEAD', label: 'MCS Lead',
    sop: 'Use when the unit needs MCS lead support beyond normal FAS follow-up: long downtime, repeated missed ETRs, vendor not responding, or a decision only the lead can make. State the downtime, the blocker and the ask.',
  }),
  Object.freeze({
    key: 'MCS_HIGH_VALUE_ESTIMATE', label: 'MCS High Value Estimate',
    sop: 'Use when an offsite estimate is submitted and needs high value approval. The dollar threshold is contested: do not hard-code or assume one; ' + HVE_HINT + '. Use the OFFSITE EST SUBMITTED format: vendor, unit, estimate amount, short repair, estimate link, downtime, and the approval request.',
  }),
  Object.freeze({
    key: 'MCS_REACTIVATION', label: 'MCS Reactivation',
    sop: 'Use to re-raise an escalation that went stale or was closed while the unit is still down. Use it on the most recent RG event. State what changed since the last escalation and the current status.',
  }),
  Object.freeze({
    key: 'TOM_PENDING_ACTION', label: 'TOM Pending Action',
    sop: 'Use when the repair is waiting on an action from the TOM (site operations): a decision, an authorization or site-side information. State exactly what action is pending.',
  }),
  Object.freeze({
    key: 'DOCUMENT_REQUEST', label: 'Document Request',
    sop: 'Use when documents are needed to move the repair forward (estimate, invoice, photos, inspection or DVIR, police report). Name the documents needed.',
  }),
  Object.freeze({
    key: 'MCS_RECOVERY_SIM_POST_REPAIR', label: 'MCS Recovery SIM Post Repair',
    sop: 'Use after the repair is complete when the unit needs recovery from the vendor through a SIM. State that the repair is complete and the pickup details. ' + TOWING_NOTE,
  }),
  Object.freeze({
    key: 'MCS_CARRIER_UPDATE_REQUEST', label: 'MCS Carrier Update Request',
    sop: 'Use to request an update from the carrier on the unit. Removing this escalation needs a comment and it is removed on its own.',
  }),
]);

// Few-shot style only. Every value in a real draft comes from the unit data; anything
// unknown is a <FILL: …> placeholder.
const STYLE_EXEMPLARS = Object.freeze({
  FAS: Object.freeze([
    'VENDOR NO UPDATE IN 26 HOURS 40 MINUTES. UNIT DOWN. PLEASE PUSH VENDOR FOR ETA.',
    'ETR MISSED. NO CALLBACK FROM SHOP. PLEASE CALL FOR CURRENT STATUS AND NEW ETR.',
  ]),
  MCS_LEAD: Object.freeze([
    'UNIT DOWN 5 DAYS. 2 ETRS MISSED. VENDOR NOT RESPONDING. NEED MCS LEAD TO ESCALATE WITH VENDOR.',
  ]),
  MCS_HIGH_VALUE_ESTIMATE: Object.freeze([
    'OFFSITE EST SUBMITTED - <VENDOR> (<CITY, ST>)\nUNIT: <UNIT> | EST $<AMOUNT>\nREPAIR: <SHORT REPAIR DESC>\nLINE ITEMS MATCH PICS. LABOR WITHIN GUIDEBOOK.\nEST LINK: <VENDOR PORTAL URL>\nUNIT DOWNED <Xh Ym>. ETR PENDING EST APPROVAL.\nREQUEST IMMEDIATE APPROVAL.',
  ]),
  MCS_REACTIVATION: Object.freeze([
    'REACTIVATING ESCALATION. UNIT STILL DOWN. LAST VENDOR UPDATE 2 DAYS AGO. NO ETR GIVEN.',
  ]),
  DOCUMENT_REQUEST: Object.freeze([
    'REQUESTING SIGNED ESTIMATE AND DAMAGE PHOTOS FROM VENDOR TO PROCEED WITH APPROVAL.',
  ]),
});

const COMMENT_TEMPLATES = Object.freeze(['offsite-update', 'update-request', 'free-form']);

function targetByKey(key) {
  return ESCALATION_TARGETS.find((t) => t.key === key) || null;
}

module.exports = {
  ESCALATION_TARGETS, STYLE_EXEMPLARS, TOWING_NOTE, HVE_HINT, COMMENT_TEMPLATES, targetByKey,
};
