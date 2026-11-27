'use strict';
/**
 * autopilot/fallback.js — deterministic recommendation (§B9 "Fallback"). Pure.
 *
 * deterministicRecommendation(analysis, pack) -> output in the AI schema v1 with
 * generatedBy 'deterministic'. Used when the AI is off, not needed, unavailable,
 * timed out, invalid, interrupted or over budget.
 *
 *   confirmedFacts   top-authority structured items (confidence >= 0.8, so authority
 *                    index 0/1 and not STALE) that are not conflict members
 *   inferences       none; stageStall { stalled:null, reasoning:'not assessed (AI unavailable)' }
 *   actions          rule templates per reason code, filled only with structured values
 * Every approval action carries requiresApproval:true and executed:false.
 *
 * Repair complete, awaiting return tow / case close-out (analysis.closeout, analyze.js): the
 * REPAIRED_UNVERIFIED actions become the specific close-out steps (check Active in AAP, return
 * tow, lifecycle, RelayGarage close-out), the ETC request and "Repair ETC" missing info are
 * dropped, and the summary / stageStall say closeable, not stalled. Suggestions only.
 */

const { REASONS: R, WRITE_ACTION_CLASSES, OPERATIONAL_CADENCE } = require('./constants');
const { closeoutApplies } = require('./analyze');

const DAY = 86400000;
const FACT_MAX = 10;

function _flat(v, n) {
  const s = String(v == null ? '' : v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}
function _clip(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; }

function _structuredItems(pack) {
  return ((pack && pack.items) || []).filter((i) => i && i.trust === 'structured' && !(i.flags || []).includes('wo_association_mismatch'));
}
function _find(pack, source, field) { return _structuredItems(pack).find((i) => i.source === source && i.field === field) || null; }
function _ids(...items) { return items.filter(Boolean).map((i) => i.evidenceId).filter(Boolean); }
function _date(v) { const s = String(v == null ? '' : v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }

function _action(cls, action, rationale, owner, evidenceIds) {
  const a = {
    action: _clip(action, 300), rationale: _clip(rationale, 400), owner: _clip(owner || 'fleet', 60),
    actionClass: cls, evidenceIds: evidenceIds || [],
  };
  if (WRITE_ACTION_CLASSES.includes(cls)) { a.requiresApproval = true; a.executed = false; }
  return a;
}

function reviewHoursFor(reasons) {
  const h = OPERATIONAL_CADENCE.reviewHours;
  const c = reasons || [];
  if (c.includes(R.REPAIRED_UNVERIFIED)) return h.repairedUnverified;
  if (c.includes(R.ETA_OVERDUE_VERIFIED) || c.includes(R.ETA_PAST_UNVERIFIED) || c.includes(R.ETA_NOT_PROVIDED)) return h.eta;
  if (c.includes(R.UPDATE_STALE)) return h.stale;
  return h.default;
}

function deterministicRecommendation(analysis, pack, opts) {
  const a = analysis || {};
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const reasons = a.reasons || [];
  const has = (c) => reasons.includes(c);
  const dealer = a.dealer ? _flat(a.dealer, 80) : 'the vendor';
  const life = _find(pack, 'aap_cache', 'lifecycleState') || _find(pack, 'aap_live', 'lifecycleState');
  const etcItem = _find(pack, 'aap_cache', 'repairEtc') || _find(pack, 'aap_cache', '_factEtc.date') || _find(pack, 'decisiv', 'repairEtc') || _find(pack, 'dtna', 'repairEtc');
  const eta = a.eta || {};
  const etaDate = _date(eta.date);
  const etaSource = eta.source ? _flat(eta.source, 40) : 'unknown source';
  const co = closeoutApplies(a, a.conflictGroups);
  const coSince = co && Number.isFinite(co.readySince) ? new Date(co.readySince).toISOString().slice(0, 10) : 'an unknown date';
  const coSrcs = co ? co.readySources.join(' and ') : '';

  const facts = [];
  for (const it of _structuredItems(pack)) {
    if (facts.length >= FACT_MAX) break;
    if (it.conflictGroup || !(it.confidence >= 0.8) || it.field === 'wo_association') continue;
    facts.push({ statement: _clip(it.field + ' = ' + _flat(it.value, 200) + ' (' + it.source + ')', 300), evidenceIds: [it.evidenceId] });
  }

  const rec = [];
  const appr = [];
  const push = (x) => (x.requiresApproval ? appr : rec).push(x);

  if (has(R.ETA_OVERDUE_VERIFIED)) {
    const n = etaDate ? Math.max(0, Math.floor((now - Date.parse(etaDate + 'T00:00:00')) / DAY)) : null;
    push(_action('vendor_follow_up',
      'Request an updated ETC from ' + dealer + '; last ETC ' + (etaDate || 'unknown') + ' (' + etaSource + ') passed' + (n != null ? ' ' + n + ' days ago.' : '.'),
      'The ETC from an authoritative source has passed and the unit is still down.', 'fleet', _ids(etcItem, life)));
  } else if (has(R.ETA_PAST_UNVERIFIED)) {
    push(_action('verify_in_system', 'Verify the ETC; ' + (etaDate || 'a date') + ' per ' + etaSource + ' has passed (not verified).',
      'The ETC date passed but its source is not authoritative.', 'fleet', _ids(etcItem)));
  } else if (has(R.ETA_NOT_PROVIDED) && !co) {
    push(_action('vendor_follow_up', 'Ask ' + dealer + ' for an ETC; none is recorded in any source.',
      'No ETC date exists for a down unit.', 'fleet', _ids(life)));
  }
  if (co) {
    push(_action('verify_in_system', 'Repair complete: ' + coSrcs + ' report ready since ' + coSince + '. Check whether the unit went Active in AAP; this case is closeable, not a stalled repair.',
      'Two systems report the repair done while AAP still shows Unavailable; AAP lags.', 'fleet', co.evidenceIds));
    push(_action('vendor_follow_up', 'Arrange the return tow from ' + dealer + ' to the yard if it is not already scheduled.',
      'The repair is done; the unit has to come back before the case can close.', 'fleet', co.evidenceIds));
    push(_action('lifecycle_change', 'Set the unit Active in AAP once it is back; ' + coSrcs + ' report ready since ' + coSince + ' while AAP shows Unavailable.',
      'Only a person can change the lifecycle; Autopilot never does.', 'fleet', co.evidenceIds));
    push(_action('wo_update', 'Close out the RelayGarage case for this repair once the unit is Active in AAP.',
      'The repair is complete; the open case is the last step.', 'fleet', co.evidenceIds));
  } else if (has(R.REPAIRED_UNVERIFIED)) {
    const ready = _structuredItems(pack).find((i) => i.conflictField === 'repairStatus' && String(i.value).toLowerCase() === 'ready')
      || _find(pack, 'canonical', 'status');
    const since = ready && ready.observedAt != null ? new Date(ready.observedAt).toISOString().slice(0, 10) : 'an unknown date';
    push(_action('verify_in_system', 'Check in AAP whether the unit has returned to service.',
      'A source reports the repair as done while AAP still shows the unit down.', 'fleet', _ids(ready, life)));
    push(_action('lifecycle_change', 'Confirm return to service; ' + (ready ? ready.source : 'a source') + ' reports ready since ' + since + ' while AAP shows Unavailable.',
      'Only a person can change the lifecycle; Autopilot never does.', 'fleet', _ids(ready, life)));
  }
  const groups = a.conflictGroups || [];
  if (has(R.STATUS_CONFLICT) || groups.some((g) => g.group !== 'cf_status')) {
    const pos = [];
    const ids = [];
    for (const g of groups) {
      for (const p of g.positions || []) {
        pos.push(p.source + ' ' + p.field + '=' + _flat(p.value, 40));
        if (p.evidenceId) ids.push(p.evidenceId);
      }
    }
    // STATUS_CONFLICT from the row counters only (no conflict group): cite the counters.
    if (!ids.length) ids.push(..._ids(_find(pack, 'aap_cache', 'canonicalConflictCount'), _find(pack, 'aap_cache', 'factConflicts')));
    push(_action('internal_review', _clip('Review the conflicting status' + (pos.length ? ': ' + pos.join('; ') : ' reported on the row.'), 300),
      'Sources disagree; Autopilot does not pick one.', 'fleet', ids.slice(0, 10)));
  }
  if (has(R.UPDATE_STALE)) {
    const lv = a.lastVendorUpdate && a.lastVendorUpdate.at ? new Date(a.lastVendorUpdate.at).toISOString().slice(0, 10) : 'an unknown date';
    push(_action('vendor_follow_up', 'Request a status update from ' + dealer + '; the newest vendor update is from ' + lv + '.',
      'No recent update is recorded.', 'fleet', _ids(life)));
  }
  if (has(R.WAITING_PARTS)) {
    const ps = _find(pack, 'aap_cache', 'partsStatus');
    const pe = _find(pack, 'aap_cache', 'partsEta');
    push(_action('monitor', 'Monitor parts status (' + (ps ? _flat(ps.value, 30) : 'unknown') + '); parts ETA ' + (pe ? _flat(pe.value, 30) : 'unknown') + '.',
      'The repair waits on parts.', 'fleet', _ids(ps, pe, life)));
  }
  if (has(R.WAITING_ESTIMATE_APPROVAL)) {
    push(_action('internal_review', 'Review the pending estimate approval.', 'The repair waits on an estimate approval.', 'fleet', _ids(_find(pack, 'aap_cache', 'offsiteStage'), life)));
  }
  if (has(R.AWAITING_SCHEDULING)) {
    push(_action('internal_review', 'Check that the work order is scheduled with a vendor.', 'The work request has no vendor work order yet.', 'fleet', _ids(_find(pack, 'aap_cache', 'serviceState'), life)));
  }
  if (has(R.RECURRING_DEFECT)) {
    const comps = _structuredItems(pack).filter((i) => i.source === 'repair_intel' && i.field === 'repeatComponent');
    push(_action('internal_review', _clip('Review repeat repairs on: ' + (comps.map((c) => _flat(c.value, 40)).join(', ') || 'the recorded components') + '.', 300),
      'The same component failed more than once in a year.', 'fleet', _ids(...comps)));
  }
  if (!rec.length && !appr.length) {
    push(_action('monitor', 'Keep monitoring; Autopilot will re-check.', 'No rule asks for an action.', 'fleet', _ids(life)));
  }

  const missingInfo = [];
  if (!co && (eta.status === 'NOT_PROVIDED' || has(R.ETA_NOT_PROVIDED))) missingInfo.push({ item: 'Repair ETC', whyNeeded: 'No ETC date exists in any source.', likelySource: 'vendor' });
  if (has(R.DOWN_SINCE_UNKNOWN)) missingInfo.push({ item: 'Down-since date', whyNeeded: 'Days down could not be computed.', likelySource: 'aap' });

  const conflicts = groups.map((g) => ({
    field: _clip((g.fields || []).join('/') || g.group, 40),
    note: _clip((g.positions || []).map((p) => p.source + '=' + _flat(p.value, 40)).join('; ') + (g.authorityWinner ? '' : ' (no authority winner)'), 300),
    evidenceIds: (g.positions || []).map((p) => p.evidenceId).filter(Boolean),
  }));

  // A party with no supporting item is reported as unknown.
  const rpIds = (Array.isArray(a.responsiblePartyEvidenceIds) ? a.responsiblePartyEvidenceIds : []).filter(Boolean).slice(0, 20);

  const summary = 'Unit ' + (a.unitId || '?') + ': ' +
    (co ? 'repair complete, awaiting return tow / case close-out (closeable, not a stalled repair); ready per ' + coSrcs + ' since ' + coSince + ', AAP still Unavailable; ' : '') +
    (reasons.join(', ') || 'no reasons') +
    (a.daysDown != null ? '; ' + (Math.round(a.daysDown * 10) / 10) + ' days down' : '') + '; ETC ' + (eta.status || 'NOT_PROVIDED') + '.';
  const stageStall = co
    ? { stalled: false, stage: 'ready', reasoning: 'Repair complete per ' + coSrcs + '; awaiting return tow and case close-out.', confidence: 0, evidenceIds: co.evidenceIds.slice() }
    : { stalled: null, stage: 'unknown', reasoning: 'not assessed (AI unavailable)', confidence: 0, evidenceIds: [] };

  return {
    schemaVersion: 1,
    generatedBy: 'deterministic',
    summary: _clip(summary, 400),
    confirmedFacts: facts,
    inferences: [],
    stageStall,
    missingInfo,
    conflicts,
    responsibleParty: { party: rpIds.length ? (a.responsibleParty || 'unknown') : 'unknown', evidenceIds: rpIds },
    recommendedActions: rec,
    actionsRequiringApproval: appr,
    urgency: 'normal',
    nextReviewInHours: reviewHoursFor(reasons),
  };
}

module.exports = { deterministicRecommendation, reviewHoursFor };
