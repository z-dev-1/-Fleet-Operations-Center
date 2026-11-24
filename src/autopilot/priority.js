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

module.exports = { score, strongestReason, compareCases };
