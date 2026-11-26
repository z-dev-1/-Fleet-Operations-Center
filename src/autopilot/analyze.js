'use strict';
/**
 * autopilot/analyze.js — deterministic analysis of one evidence pack (§B8 step 7). Pure.
 *
 *   analyze(pack, caseRec, opts) -> analysis
 *     { unitId, domicile, daysDown, reasons[], primaryReason, eta, repairPhase, blockers[],
 *       responsibleParty, dealer, lastVendorUpdate{at,source}|null, lastLoggedUpdateAt,
 *       conflictGroups[], needsReviewConflict, untrustedNewer }
 *     opts: { row, syncedAt, canonical (record or null), now }
 *   needsAi({ aiInvestigation, fp, aiFp, analysis }) -> boolean
 *   trivial(analysis) -> boolean
 *     REPAIRED_UNVERIFIED with no conflict group other than cf_status and no
 *     untrusted text newer than the newest structured update.
 *
 * Only structured values feed the analysis. Untrusted text is counted, never read.
 */

const { REASONS: R } = require('./constants');
const { needsReview } = require('./conflicts');
const { newestVendorUpdate, newestLoggedUpdate, toMs } = require('./updates');

const PARTIES = Object.freeze(['vendor', 'dealer', 'dsp_carrier', 'amazon_fleet', 'parts_supplier', 'unknown']);

const BLOCKER_OF = Object.freeze({
  [R.WAITING_PARTS]: 'parts',
  [R.WAITING_ESTIMATE_APPROVAL]: 'estimate_approval',
  [R.AWAITING_SCHEDULING]: 'scheduling',
  [R.ETA_NOT_PROVIDED]: 'no_etc',
  [R.UPDATE_STALE]: 'stale_updates',
  [R.STATUS_CONFLICT]: 'status_conflict',
});

function _codes(reasons) {
  return (reasons || []).map((r) => (r && typeof r === 'object' ? r.code : r)).filter(Boolean);
}
function _parse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function _structured(items, source, field) {
  return (items || []).find((i) => i && i.trust === 'structured' && i.source === source && i.field === field && !i.flags.includes('wo_association_mismatch')) || null;
}

function _waitingOnParty(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (!s) return null;
  if (/part/.test(s)) return 'parts_supplier';
  if (/dealer/.test(s)) return 'dealer';
  if (/vendor|shop/.test(s)) return 'vendor';
  if (/dsp|carrier/.test(s)) return 'dsp_carrier';
  if (/amazon|fleet|approv/.test(s)) return 'amazon_fleet';
  return null;
}

function analyze(pack, caseRec, opts) {
  const p = pack || {};
  const items = Array.isArray(p.items) ? p.items : [];
  const c = caseRec || {};
  const o = opts || {};
  const reasons = _codes(c.reasons || _parse(c.reasons_json));
  const has = (code) => reasons.includes(code);

  const canonStatus = (_structured(items, 'canonical', 'status') || {}).value
    || (o.canonical && o.canonical.status) || null;
  const stage = _structured(items, 'decisiv', 'stage') || _structured(items, 'dtna', 'offsiteStage') || _structured(items, 'aap_cache', 'offsiteStage');
  const repairPhase = canonStatus || (stage ? String(stage.value).toLowerCase() : null);

  const blockers = [];
  for (const code of reasons) if (BLOCKER_OF[code] && !blockers.includes(BLOCKER_OF[code])) blockers.push(BLOCKER_OF[code]);

  const dealerItem = _structured(items, 'aap_cache', 'dealerName') || _structured(items, 'aap_cache', 'vendor')
    || _structured(items, 'decisiv', 'dealerName') || _structured(items, 'dtna', 'dealerName');
  const dealer = dealerItem ? String(dealerItem.value) : null;

  // The items behind the party, so the fallback can cite them (an uncited party reads as unknown).
  const canonItem = _structured(items, 'canonical', 'status');
  let partyItems = [];
  let party = _waitingOnParty(o.canonical && o.canonical.waitingOn);
  if (party) partyItems = [canonItem];
  else {
    if (has(R.WAITING_PARTS)) { party = 'parts_supplier'; partyItems = [_structured(items, 'aap_cache', 'partsStatus'), canonItem]; }
    else if (has(R.WAITING_ESTIMATE_APPROVAL)) { party = 'amazon_fleet'; partyItems = [_structured(items, 'aap_cache', 'offsiteStage'), canonItem]; }
    else if (has(R.AWAITING_SCHEDULING)) { party = 'vendor'; partyItems = [_structured(items, 'aap_cache', 'serviceState')]; }
    else if (dealer) { party = 'dealer'; partyItems = [dealerItem]; }
    else party = 'unknown';
  }
  const responsiblePartyEvidenceIds = [...new Set(partyItems.filter(Boolean).map((i) => i.evidenceId).filter((id) => typeof id === 'string' && id))];

  const groups = (p.conflicts && Array.isArray(p.conflicts.groups)) ? p.conflicts.groups : [];
  const loggedFromRow = o.row ? newestLoggedUpdate(o.row.fullConversation, o.syncedAt) : null;
  const liveComments = items.find((i) => i && i.source === 'aap_live' && i.field === 'comments');
  const loggedLive = liveComments ? toMs(liveComments.observedAt) : null;
  const lastLoggedUpdateAt = [loggedFromRow, loggedLive].filter((x) => x != null).reduce((m, x) => Math.max(m, x), -Infinity);

  const structuredAts = items.filter((i) => i && i.trust === 'structured' && i.observedAt != null).map((i) => i.observedAt);
  const untrustedAts = items.filter((i) => i && i.trust === 'untrusted_text' && i.observedAt != null).map((i) => i.observedAt);
  const newestStructured = structuredAts.length ? Math.max(...structuredAts) : null;
  const newestUntrusted = untrustedAts.length ? Math.max(...untrustedAts) : null;
  const untrustedNewer = newestUntrusted != null && (newestStructured == null || newestUntrusted > newestStructured);

  return {
    unitId: c.unit_id || null,
    domicile: c.domicile || null,
    daysDown: Number.isFinite(c.days_down) ? c.days_down : null,
    reasons,
    primaryReason: c.primary_reason || reasons[0] || null,
    eta: _parse(c.eta) || _parse(c.eta_json) || { status: 'NOT_PROVIDED', date: null, source: null },
    repairPhase,
    blockers,
    responsibleParty: PARTIES.includes(party) ? party : 'unknown',
    responsiblePartyEvidenceIds,
    dealer,
    lastVendorUpdate: newestVendorUpdate(items),
    lastLoggedUpdateAt: Number.isFinite(lastLoggedUpdateAt) ? lastLoggedUpdateAt : null,
    conflictGroups: groups,
    needsReviewConflict: needsReview(groups),
    untrustedNewer,
  };
}

function trivial(analysis) {
  const a = analysis || {};
  if (!(a.reasons || []).includes(R.REPAIRED_UNVERIFIED)) return false;
  if ((a.conflictGroups || []).some((g) => g && g.group !== 'cf_status')) return false;
  return !a.untrustedNewer;
}

function needsAi(input) {
  const i = input || {};
  return i.aiInvestigation === true && i.fp !== i.aiFp && !trivial(i.analysis);
}

module.exports = { analyze, trivial, needsAi, PARTIES, BLOCKER_OF };
