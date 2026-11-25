'use strict';
/**
 * autopilot/priority.js — case ordering score 0..100 (§B10.4). Pure.
 * Weights live in OPERATIONAL_CADENCE.priority and are ordering hints only.
 */

const { OPERATIONAL_CADENCE, STATES } = require('./constants');

const W = OPERATIONAL_CADENCE.priority;

function _codes(reasons) {
  return (reasons || []).map((r) => (r && typeof r === 'object' ? r.code : r)).filter(Boolean);
}

function _base(code) { return Object.prototype.hasOwnProperty.call(W.base, code) ? W.base[code] : W.baseOther; }

/** Strongest reason code (highest base weight; first seen wins a tie), or null. */
function strongestReason(reasons) {
  let best = null;
  let bestW = -1;
  for (const c of _codes(reasons)) {
    const w = _base(c);
    if (w > bestW) { best = c; bestW = w; }
  }
  return best;
}

/**
 * score({ reasons, daysDown, neverInvestigated, trigger, aiUrgency, aiInvestigation, state, unchanged })
 */
function score(input) {
  const i = input || {};
  const top = strongestReason(i.reasons);
  let s = top ? _base(top) : 0;
  const dd = Number(i.daysDown);
  if (Number.isFinite(dd) && dd > 0) s += Math.min(W.daysDownCap, Math.floor(dd / W.daysDownDivisor));
  if (i.neverInvestigated) s += W.neverInvestigated;
  if (i.trigger === 'evidence_changed' || i.trigger === 'eta_due') s += W.triggerBoost;
  if (i.aiInvestigation !== false) {
    if (i.aiUrgency === 'high') s += W.aiHigh;
    else if (i.aiUrgency === 'low') s += W.aiLow;
  }
  if (i.state === STATES.MONITORING && i.unchanged) s += W.monitoringUnchanged;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** Comparator used to pick queued cases: priority DESC, state_changed_at ASC. */
function compareCases(a, b) {
  return ((b.priority || 0) - (a.priority || 0)) || ((a.state_changed_at || 0) - (b.state_changed_at || 0));
}

const W2 = OPERATIONAL_CADENCE.priorityV2;

/**
 * scoreV2({ reasons, safety, daysDown, recurrenceOf, recurrenceCount, neverInvestigated, aiUrgency,
 *           aiInvestigation, state, unchanged, deep }) -> 0..100 (V2 §8.3)
 * Band floor + modifiers, clamped to the band, so bands never overlap: safety 80..100,
 * operational 55..79 (REPAIRED_UNVERIFIED floor 60, ETA_OVERDUE_VERIFIED floor 57), other 10..54.
 * A deep request lifts the result to at least deepMin (95). No trigger boost.
 */
function scoreV2(input) {
  const i = input || {};
  const codes = new Set(_codes(i.reasons));
  const B = W2.bands;
  let floor;
  let min;
  let max;
  if (codes.has('SAFETY_CRITICAL') || i.safety === true || i.safety === 1) { floor = B.safety.floor; min = B.safety.min; max = B.safety.max; }
  else if (codes.has('REPAIRED_UNVERIFIED')) { floor = B.operational.floorRepairedUnverified; min = B.operational.min; max = B.operational.max; }
  else if (codes.has('ETA_OVERDUE_VERIFIED')) { floor = B.operational.floorEtaOverdue; min = B.operational.min; max = B.operational.max; }
  else { floor = B.other.floor; min = B.other.min; max = B.other.max; }
  let s = floor;
  const dd = Number(i.daysDown);
  if (Number.isFinite(dd) && dd > 0) s += Math.min(W2.daysDownMax, Math.floor(dd));
  if (codes.has('UPDATE_STALE') || codes.has('ANNOTATION_STALE')) s += W2.missingUpdates;
  if ((i.recurrenceOf != null && i.recurrenceOf !== '') || Number(i.recurrenceCount) >= 1) s += W2.repeatFailure;
  if (codes.has('STATUS_CONFLICT')) s += W2.evidenceConflict;
  if (i.neverInvestigated) s += W2.newOos;
  if (i.aiInvestigation !== false) {
    if (i.aiUrgency === 'high') s += W2.aiHigh;
    else if (i.aiUrgency === 'low') s += W2.aiLow;
  }
  if (i.state === STATES.MONITORING && i.unchanged) s += W2.monitoringUnchanged;
  s = Math.max(min, Math.min(max, Math.round(s)));
  if (i.deep) s = Math.max(s, W2.deepMin);
  return Math.max(0, Math.min(100, s));
}

module.exports = { score, scoreV2, strongestReason, compareCases };
