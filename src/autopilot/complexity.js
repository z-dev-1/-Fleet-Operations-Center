'use strict';
/**
 * autopilot/complexity.js — investigation complexity tier (V2 design §6.6, FR-5.1). Pure.
 *
 *   classify({ rec, row, analysis, basePack, priorCases, now }) -> { tier, signals[] }
 *     tier: 'simple' | 'standard' | 'complex'
 *     signals ⊆ status_conflict, authority_tie, multi_wo, etc_miss, etc_slip, eta_overdue,
 *               repeat_episode, trivial, single_wo_future_eta
 *
 * complex when any of: STATUS_CONFLICT; an authority tie (analysis.needsReviewConflict);
 *   >= 2 WOs in the case wo_set; etcMissCount >= 1; etcSlipCount >= 2; ETA_OVERDUE_VERIFIED;
 *   recurrence_of set or recurrence_count >= 1.
 * simple when trivial(analysis), or one WO with an authoritative FUTURE ETC and no conflict group.
 * standard otherwise. RECURRING_DEFECT alone does not make a case complex. A deep request is
 * handled by the caller (tier 'complex').
 */

const { REASONS: R, isAuthoritativeEtcTag } = require('./constants');
const { trivial } = require('./analyze');

function _parse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function _codes(list) { return (Array.isArray(list) ? list : []).map((r) => (r && typeof r === 'object' ? r.code : r)).filter(Boolean); }

function _woCount(rec) {
  const set = _parse(rec.wo_set_json !== undefined ? rec.wo_set_json : rec.wo_set);
  if (!Array.isArray(set)) return 0;
  return new Set(set.map((w) => (w && typeof w === 'object' ? w.id : w)).filter(Boolean)).size;
}

function classify(input) {
  const i = input || {};
  const rec = i.rec || {};
  const row = i.row || {};
  const a = i.analysis || {};
  const reasons = a.reasons ? _codes(a.reasons) : _codes(_parse(rec.reasons_json));
  const groups = Array.isArray(a.conflictGroups) ? a.conflictGroups
    : ((i.basePack && i.basePack.conflicts && Array.isArray(i.basePack.conflicts.groups)) ? i.basePack.conflicts.groups : []);
  const wos = _woCount(rec);

  const complex = [];
  if (reasons.includes(R.STATUS_CONFLICT)) complex.push('status_conflict');
  if (a.needsReviewConflict === true) complex.push('authority_tie');
  if (wos >= 2) complex.push('multi_wo');
  if (Number(row.etcMissCount) >= 1) complex.push('etc_miss');
  if (Number(row.etcSlipCount) >= 2) complex.push('etc_slip');
  if (reasons.includes(R.ETA_OVERDUE_VERIFIED)) complex.push('eta_overdue');
  if (rec.recurrence_of != null || Number(rec.recurrence_count) >= 1) complex.push('repeat_episode');
  if (complex.length) return { tier: 'complex', signals: complex };

  if (trivial(a)) return { tier: 'simple', signals: ['trivial'] };
  const eta = a.eta || {};
  if (wos === 1 && eta.status === 'FUTURE' && isAuthoritativeEtcTag(eta.source) && groups.length === 0) {
    return { tier: 'simple', signals: ['single_wo_future_eta'] };
  }
  return { tier: 'standard', signals: [] };
}

module.exports = { classify };
