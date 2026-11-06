'use strict';
/**
 * email-intel/facts/reconcile.js — fact evaluation with a fixed precedence (design 4.3; R1.5, R3.2,
 * R3.5, R3.6, R3.7, R3.8, R7.4, R7.5 / F-06, F-02, F-27, F2-01).
 *
 *   evaluateFact(fact, ctx) -> { verdict, reason, reasons[], detail, effectiveConfidence, keys, supersedes?, duplicateOf?, verifiedBy, contradicts? }
 *     verdict: 'out-of-scope' | 'stage' | 'duplicate' | 'duplicate-of-canonical' | 'stale' | 'apply'
 *   ctx: { unit, scope:'in'|'out'|'unknown', rosterMismatch, canonical, canonicalError, row, ledgerEntries[],
 *          msg (MessageRecord), flags (effective), cfg:{autoApplyUnitUpdates, readyDmSuggested} (read ONCE per scan),
 *          intelCfg (emailIntelConfig: minConfidence, mailboxTzVerified), ambiguousOrder }
 *
 * Precedence (first match wins):
 *   1 out-of-scope   2 scope-unknown   3 partial-content / unprocessed-window   4 uncertain-assertion
 *   5 duplicate (ambiguous-item / ambiguous-order stage here)   6 stale-vs-ledger (evidence only)
 *   7 conflict-canonical / conflict-ready / freshness-unprovable / duplicate-of-canonical
 *   4b attachment-conflict (Phase F)
 *   8 spend-related (F-06; Phase F: any amount / approval fact whose evidence is an attachment)   9 roster-mismatch   10 low-confidence / invalid-confidence
 *   11 timeline-disabled: !flags.timelineWrites OR cfg.autoApplyUnitUpdates === false (F2-01)   12 apply
 *
 * Nothing here writes; the caller stages, records evidence or commits through timeline-writer.js.
 * A missing or invalid confidence is 0 and never applies; the threshold is max(0.75, config).
 */
const fk = require('./fact-key');
const im = require('./item-match');
const ca = require('./canonical-at');
const { PHASE_ORDER, phaseIndex } = require('./phase-order');
const conf = require('../understand/confidence');

const COMPARABLE = new Set(['repair_stage', 'pickup_readiness', 'estimated_completion']);
const READY_STAGES = new Set(['ready_for_pickup', 'pickup_scheduled', 'repair_complete', 'closed']);
const CONFLICT_STATUS = new Set(['in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor', 'down']);
const CONFLICT_PHASE = new Set(['diagnosing', 'awaiting_parts', 'awaiting_estimate_approval', 'in_repair']);
// canonical repairPhase vocabulary (canonical_state._derivePhase) -> PHASE_ORDER
const CANON_PHASE = Object.freeze({
  diagnosing: 'diagnosis', awaiting_estimate_approval: 'awaiting_approval', awaiting_parts: 'awaiting_parts',
  in_repair: 'repair_in_progress', complete: 'ready_for_pickup',
});
const ANALYZED = new Set(['content', 'content-partial']);
const AUTO_APPLY_OFF_DETAIL = 'auto-apply is off in Email Triage settings';

const isReadyClaim = (f) => (f.kind === 'pickup_readiness' && f.state === 'ready') || (f.kind === 'repair_stage' && READY_STAGES.has(f.state));

function _canonPhase(canon) {
  if (!canon) return null;
  const raw = String(canon.repairPhase || (canon.dimensions && canon.dimensions.phase && canon.dimensions.phase.value) || '');
  if (PHASE_ORDER.includes(raw)) return raw;
  return CANON_PHASE[raw] || null;
}

function _snapshot(canon, at) {
  const lmu = canon && canon.lastMeaningfulUpdate;
  return {
    status: canon ? String(canon.status || '') : '', repairPhase: canon ? String(canon.repairPhase || '') : '',
    lastUpdateAt: lmu ? String(lmu.at || '').slice(0, 40) : '', lastUpdateSource: lmu ? String(lmu.source || '') : '',
    changeTimePrecision: at ? at.precision : 'none',
  };
}

function _unanalyzedAttachment(msg) {
  return ((msg && msg.attachments) || []).some((a) => !(a && a.analysis && ANALYZED.has(a.analysis.status)));
}

/**
 * Within one scan: facts of the same groupKey from different messages whose order cannot be proven
 * (receivedAt under 60 s apart, or either side without minute precision) and that would compete
 * (different value, items not 'differ'). Returns a Set of candidate ids to stage 'ambiguous-order'.
 * candidates: [{ id, unit, fact, msg }]
 */
function ambiguousOrder(candidates) {
  const out = new Set();
  const list = candidates || [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.msg.messageKey === b.msg.messageKey) continue;
      const ka = fk.keysOf(a.fact, a.unit); const kb = fk.keysOf(b.fact, b.unit);
      if (ka.groupKey !== kb.groupKey || ka.valueKey === kb.valueKey) continue;
      if (fk.itemRelation(a.fact.kind, ka.item, kb.item) === 'differ') continue;
      const ta = Date.parse(a.msg.receivedAt || ''); const tb = Date.parse(b.msg.receivedAt || '');
      const unprovable = !Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) < 60_000
        || a.msg.receivedAtPrecision !== 'minute' || b.msg.receivedAtPrecision !== 'minute';
      if (unprovable) { out.add(a.id); out.add(b.id); }
    }
  }
  return out;
}

function evaluateFact(fact, ctx) {
  const c = ctx || {};
  const f = fact || {};
  const msg = c.msg || {};
  const keys = fk.keysOf(f, c.unit);
  const eff = Number.isFinite(f.effectiveConfidence) ? f.effectiveConfidence : 0;
  const base = { keys, effectiveConfidence: eff, verifiedBy: null, reasons: [] };
  const out = (verdict, reason, detail, extra) => Object.assign({}, base, { verdict, reason: reason || null, reasons: reason ? [reason] : [], detail: String(detail || '').slice(0, 160) }, extra || {});
  const stage = (reason, detail, extra) => out('stage', reason, detail, extra);

  // 1-2 scope (R3.8): never write a unit outside my fleet; unknown scope stages.
  if (c.scope === 'out') return out('out-of-scope', 'out-of-scope', 'unit is not in my assigned fleet');
  if (c.scope !== 'in') return stage('scope-unknown', 'fleet scope could not be confirmed');

  // 3 partial content (R1.5)
  const body = msg.body || {};
  if (body.status !== 'complete') return stage('partial-content', 'email content was ' + String(body.status || 'unknown'));
  if (c.unprocessed && c.unprocessed.has && c.unprocessed.has(String(c.unit))) return stage('unprocessed-window', 'part of the email was not analyzed');

  // 4 uncertain assertion
  const entries = (c.ledgerEntries || []).filter((e) => e && e.groupKey === keys.groupKey);
  if (f.assertion !== 'stated' || f.dateInvalid || f.amountUnverified) {
    let contradicts = null;
    if (f.assertion === 'retracted') {
      const hit = entries.find((e) => e.state === 'applied' && fk.itemRelation(f.kind, keys.item, e.item) !== 'differ');
      if (hit) contradicts = hit.ledgerKey;
    }
    const why = f.assertion !== 'stated' ? 'the email does not state it as fact (' + f.assertion + ')' : (f.dateInvalid ? 'the date could not be verified' : 'the amount was not found in the text');
    return stage('uncertain-assertion', why, contradicts ? { contradicts } : null);
  }
  // 4b attachment conflict (design 7.7): the attachment's amount disagrees with the email's.
  if (f.attachmentConflict === true) return stage('attachment-conflict', 'the attachment disagrees with the email');

  // 5 duplicate / ambiguous item / ambiguous order (R3.6, F-07)
  const cls = fk.classify(f, c.unit, entries);
  if (cls.kind === 'duplicate') return out('duplicate', 'duplicate', 'already recorded', { duplicateOf: cls.entry.ledgerKey });
  if (cls.kind === 'ambiguous-item') return stage('ambiguous-item', 'cannot tell which part this refers to');
  if (c.ambiguousOrder) return stage('ambiguous-order', 'two emails arrived too close together to order');

  // 6 stale vs ledger: a newer recorded fact for the same item exists -> evidence only.
  const recT = Date.parse(msg.receivedAt || '');
  const newer = entries.find((e) => (e.state === 'applied' || e.state === 'pending') && fk.itemRelation(f.kind, keys.item, e.item) !== 'differ'
    && Number.isFinite(recT) && Date.parse(e.observedAt || '') > recT);
  if (newer) return out('stale', 'stale', 'a newer email already recorded this', { newerThan: newer.ledgerKey });

  // 7 canonical (R3.2, R3.5, F-02, F-27)
  if (c.canonicalError) return stage('freshness-unprovable', 'canonical state unavailable');
  const canon = c.canonical || null;
  const lmu = canon && canon.lastMeaningfulUpdate;
  const at = lmu ? ca.parseCanonicalAt(lmu, c.row) : null;
  const tzVerified = !!(c.intelCfg && c.intelCfg.mailboxTzVerified === true);
  const fresh = ca.compareFreshness(at, msg, { tzVerified });
  const snap = _snapshot(canon, at);
  const withSnap = { canonicalSnapshot: snap };
  let verifiedBy = null;
  if (isReadyClaim(f)) {
    const st = canon ? String(canon.status || '') : '';
    const ph = canon && canon.dimensions && canon.dimensions.phase ? String(canon.dimensions.phase.value || '') : '';
    if (CONFLICT_STATUS.has(st) || CONFLICT_PHASE.has(ph)) return stage('conflict-ready', 'canonical status is ' + (st || ph), withSnap);
    verifiedBy = st === 'ready_for_pickup' ? 'canonical' : 'none';
  }
  if (COMPARABLE.has(f.kind)) {
    if (fresh === 'unprovable') return stage('freshness-unprovable', 'cannot prove the email is newer than the canonical update', Object.assign({ verifiedBy }, withSnap));
    if (f.kind === 'repair_stage') {
      const cp = _canonPhase(canon);
      const ci = cp ? phaseIndex(cp) : -1;
      const ei = phaseIndex(f.state);
      if (fresh === 'canonical-newer' && ci !== -1 && ci !== ei) return stage('conflict-canonical', 'a newer canonical update shows ' + cp, Object.assign({ verifiedBy }, withSnap));
      if (ci !== -1 && ei !== -1 && ei < ci) return stage('conflict-canonical', 'email-behind-canonical', Object.assign({ verifiedBy }, withSnap));
      if (ci !== -1 && ci === ei) return out('duplicate-of-canonical', 'duplicate-of-canonical', 'canonical state already shows this', { verifiedBy });
    } else if (fresh === 'canonical-newer') {
      return stage('conflict-canonical', 'fresher-canonical-update', Object.assign({ verifiedBy }, withSnap));
    }
  } else if (lmu && at && at.authoritative && im.shareToken(lmu.text, [keys.item || '', f.value || ''].join(' '))) {
    if (fresh === 'canonical-newer') return stage('conflict-canonical', 'fresher-canonical-update', withSnap);
    if (fresh === 'unprovable') return stage('freshness-unprovable', 'cannot prove the email is newer than the canonical update', withSnap);
  }

  // 8 spend-related (F-06): approvals, authorizations and estimates are never auto-applied.
  // Phase F (D9): amounts and approval facts read from an attachment are staged for confirmation too.
  if (/^attachment:/.test(String(f.evidenceSource || '')) && (f.amount || f.kind === 'approval_status')) {
    return stage('spend-related', 'amounts and approvals read from an attachment need your review', { verifiedBy });
  }
  if ((f.kind === 'approval_status' && (f.state === 'approved' || f.state === 'authorized')) || f.state === 'estimate_received') {
    return stage('spend-related', 'approvals and estimates need your review', { verifiedBy });
  }
  if (f.kind === 'approval_status' && _unanalyzedAttachment(msg)) return stage('spend-related', 'an attachment that may hold the amount was not read', { verifiedBy });

  // 9 roster
  if (c.rosterMismatch) return stage('roster-mismatch', 'the FAS roster does not list this unit for you', { verifiedBy });

  // 10 confidence (R7.3, R7.4): invalid input is 0; threshold max(0.75, config), compared with >=.
  if (!conf.meetsThreshold(eff, c.intelCfg)) {
    const invalid = (f.caps || []).some((x) => x === 'invalid-confidence' || x === 'invalid-overall-confidence') || !Number.isFinite(f.effectiveConfidence);
    return stage(invalid ? 'invalid-confidence' : 'low-confidence', invalid ? 'the AI confidence was missing or invalid' : 'confidence ' + eff.toFixed(2) + ' is below the threshold', { verifiedBy });
  }

  // 11 timeline disabled (shadow mode) or the user's Email Triage auto-apply opt-out (F2-01).
  if (!(c.flags && c.flags.timelineWrites === true)) return stage('timeline-disabled', 'timeline writes are not enabled', { verifiedBy });
  if (c.cfg && c.cfg.autoApplyUnitUpdates === false) return stage('timeline-disabled', AUTO_APPLY_OFF_DETAIL, { verifiedBy });

  // 12 apply
  return out('apply', null, '', { verifiedBy, supersedes: cls.kind === 'supersede' ? cls.entry.ledgerKey : undefined, supersededEntry: cls.kind === 'supersede' ? cls.entry : undefined });
}

module.exports = { evaluateFact, ambiguousOrder, isReadyClaim, AUTO_APPLY_OFF_DETAIL, COMPARABLE, READY_STAGES, CONFLICT_STATUS, CONFLICT_PHASE, CANON_PHASE };
