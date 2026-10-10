'use strict';
/**
 * orcha/canonical_state.js — the ONE authoritative state record per unit.
 *
 * The problem this solves: a unit's "truth" is scattered across AAP
 * (lifecycleState / lifecycleReason), Relay Garage (fullConversation /
 * serviceState), the Offsite vendor thread (asistNotes), the app's own notes /
 * repairTimeline, and the AI reconcile decision. Every surface (Action Board,
 * briefing, Split View, Slack) re-derives "what's going on with this unit" its
 * own way, so they can disagree. Canonical state is the single reconciled
 * record all of them should read.
 *
 * TWO TIERS (so we get canonical state on 100% of units without hammering AI):
 *
 *   1. computeCanonical(row) — a CHEAP, DETERMINISTIC baseline for EVERY unit,
 *      every sync. Pure function, no AI, no I/O. Normalizes a status enum,
 *      picks the freshest trustworthy source as provenance, and raises flags
 *      from fields already present. This alone is a usable canonical record for
 *      the whole fleet.
 *
 *   2. reconcileCanonical(row, {decision}) — an AI UPGRADE for the units that
 *      need deeper reasoning (down / offsite / stale). It does NOT make its own
 *      AI call; it folds an existing relay_reconcile decision (which already
 *      reasons over Relay vs Offsite via the shared reason() core) into the
 *      canonical record — sharper situation/nextStep, waitingOn, confidence,
 *      and an aiReconciled flag. The AI reconciles conflicts and we record
 *      which source it trusted; there is no hardcoded precedence rule.
 *
 * The record shape (per unit):
 *   { equipmentId, status, situation, nextStep, source, confidence,
 *     stale, waitingOn, flags:[], aiReconciled, updatedAt }
 *
 * Grounding rule: deterministic tier only restates fields already on the row;
 * the AI tier only folds in a decision the reconcile engine already produced
 * from grounded facts. Nothing here invents data.
 */

// ── Canonical status vocabulary (the confirmed set) ────────────────────────────
// Keep this list the single source of truth for valid statuses. Everything maps
// into one of these; unknown is the honest default when we can't tell.
const STATUSES = [
  'available',                   // in service / usable
  'down',                        // unavailable, no finer repair state known
  'in_repair',                   // actively being worked
  'awaiting_parts',              // waiting on parts
  'awaiting_estimate_approval',  // estimate submitted, waiting on our/approver sign-off
  'awaiting_vendor',             // waiting on the vendor/dealer to act or respond
  'ready_for_pickup',            // repair complete, awaiting pickup/return
  'in_transit',                  // being towed / moved / in transport
  'decommissioned',              // retired / sold / totaled
  'unknown',                     // genuinely indeterminate
];

function isValidStatus(s) { return STATUSES.includes(String(s || '')); }

// ── Small helpers ──────────────────────────────────────────────────────────────
function _s(v) { return String(v == null ? '' : v).trim(); }
function _lc(v) { return _s(v).toLowerCase(); }
function _has(hay, re) { return re.test(_lc(hay)); }

// Is this unit down/unavailable per AAP lifecycle? (same test the sync pass uses)
function isDown(row) {
  return _lc(row && (row.lifecycleState || row.atsState)).includes('unavail');
}

// Days since the offsite thread was last scraped (freshness proxy), falling
// back to a leading day-count in workDuration. Mirrors relay_reconcile.
function _daysSinceOffsite(row) {
  const scraped = _s(row && row.asistScrapedAt);
  if (scraped) {
    const t = Date.parse(scraped);
    if (!Number.isNaN(t)) return Math.floor((Date.now() - t) / 86400000);
  }
  const m = _s(row && row.workDuration).match(/(\d+)\s*d/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ── Deterministic status derivation ────────────────────────────────────────────
// Reads only fields already on the row. Order matters: more specific repair
// states win over the generic "down". Completed/ready beats everything because
// a finished repair is the clearest signal.
function _deriveStatus(row) {
  const r = row || {};
  const blob = [
    r.serviceState, r.completed, r.lifecycleReason, r.relayStatus,
    r.issueSummary, r.correction,
  ].map(_lc).join(' | ');

  // Decommissioned / retired — terminal, check first.
  if (_has(blob, /decommission|retired|totaled|sold|salvage|scrapp?ed/)) return 'decommissioned';

  // Ready / complete — a finished repair is the clearest state.
  if (_has(blob, /ready for pickup|ready for pick-up|awaiting pickup|ready to pick/)) return 'ready_for_pickup';
  if (_has(blob, /\bcomplete|completed|repair done|work complete|closed|resolved\b/)) {
    // Completed but still flagged unavailable in AAP => treat as ready for pickup,
    // not "available", until lifecycle clears.
    return isDown(r) ? 'ready_for_pickup' : 'available';
  }

  // In transit / tow.
  if (_has(blob, /in transit|towing|being towed|en route|transport/)) return 'in_transit';

  // Waiting states (most specific first).
  if (_has(blob, /estimate.*(approv|authoriz)|awaiting approval|pending approval|approval needed|needs approval/)) return 'awaiting_estimate_approval';
  if (_has(blob, /awaiting part|waiting on part|parts? on order|part ordered|backorder|parts? delay/)) return 'awaiting_parts';
  if (_has(blob, /awaiting vendor|waiting on (the )?(vendor|dealer)|pending vendor|vendor to|dealer to respond/)) return 'awaiting_vendor';

  // Actively in repair.
  if (_has(blob, /in repair|in progress|being (repaired|serviced|worked)|under repair|diagnos|teardown|in (the )?shop/)) return 'in_repair';

  // Fallback on AAP lifecycle.
  if (isDown(r)) return 'down';

  // Available if AAP says available/active, else unknown.
  const life = _lc(r.lifecycleState || r.atsState);
  if (_has(life, /avail|active|in service|ready/)) return 'available';
  return 'unknown';
}

// Which source currently carries the freshest trustworthy signal for this unit.
// This is PROVENANCE for the deterministic tier (the AI tier can override it
// with the source it actually trusted). Preference, when present and non-empty:
//   manual note (operator) > offsite (fresh vendor thread) > relay > aap.
function _deriveSource(row) {
  const r = row || {};
  // A manual/operator note is the strongest human-confirmed signal.
  if (_s(r.manualNote) || _s(r.operatorNote) || _s(r.notesStatus)) return 'manual';
  const daysSince = _daysSinceOffsite(r);
  const hasOffsite = !!(_s(r.asistNotes) || _s(r.asistLabel) || _s(r.offsiteShopEvent));
  // A recent offsite thread is usually the freshest reality for a down unit.
  if (hasOffsite && daysSince !== null && daysSince <= 7) return 'offsite';
  if (_s(r.fullConversation) || _s(r.relayStatus) || _s(r.serviceState)) return 'relay';
  if (hasOffsite) return 'offsite';
  return 'aap';
}

// Deterministic flags from fields already present — no AI, no fabrication.
function _deriveFlags(row, status) {
  const r = row || {};
  const flags = [];
  const daysSince = _daysSinceOffsite(r);
  if (isDown(r)) flags.push('down');
  if (status === 'ready_for_pickup') flags.push('ready');
  if (status === 'awaiting_parts') flags.push('parts');
  if (status === 'awaiting_estimate_approval') flags.push('approval');
  const rs = Number(r.riskScore);
  if (Number.isFinite(rs) && rs >= 80) flags.push('high_risk');
  // Stale when down and no offsite refresh in a while (default 3d like reconcile).
  if (isDown(r) && daysSince !== null && daysSince >= 3) flags.push('stale');
  return flags;
}

// Who are we waiting on, deterministically, from the derived status.
function _deriveWaitingOn(status) {
  switch (status) {
    case 'awaiting_parts': return 'parts';
    case 'awaiting_estimate_approval': return 'approval';
    case 'awaiting_vendor': return 'vendor';
    case 'in_repair': return 'vendor';
    case 'ready_for_pickup': return 'us';
    default: return '';
  }
}

/**
 * computeCanonical(row) -> canonical record (deterministic, no AI, no I/O).
 * Safe to call on EVERY unit every sync. Returns null only if there's no
 * equipmentId to key on.
 */
function computeCanonical(row) {
  const r = row || {};
  const equipmentId = _s(r.equipmentId);
  if (!equipmentId) return null;
  const status = _deriveStatus(r);
  const flags = _deriveFlags(r, status);
  const stale = flags.includes('stale');
  const source = _deriveSource(r);
  const waitingOn = _deriveWaitingOn(status);
  // A compact human-readable situation line, built only from known fields.
  const situationBits = [];
  if (_s(r.lifecycleReason)) situationBits.push(_s(r.lifecycleReason));
  if (_s(r.vendor)) situationBits.push('@ ' + _s(r.vendor));
  if (_s(r.workDuration)) situationBits.push(_s(r.workDuration) + ' down');
  const situation = situationBits.join(' · ').slice(0, 300);
  return {
    equipmentId,
    status,
    situation,
    nextStep: '',          // deterministic tier doesn't guess a next step
    source,                // provenance: where the trusted signal came from
    confidence: 0.5,       // deterministic baseline confidence
    stale,
    waitingOn,
    flags,
    aiReconciled: false,
    updatedAt: new Date().toISOString(),
  };
}

// Map a relay_reconcile decision's free-text status/next-step into our enum when
// the deterministic status is weak (down/unknown). The AI reconcile already read
// Relay vs Offsite, so prefer its read when it's clearly more specific.
function _statusFromDecision(decision, baseStatus) {
  const d = decision || {};
  const txt = _lc(d.currentStatus + ' ' + d.nextStep);
  if (d.completed || _has(txt, /ready for pickup|ready to pick|awaiting pickup/)) return 'ready_for_pickup';
  if (_has(txt, /\bcomplete|completed|repair done|closed|resolved\b/)) return 'ready_for_pickup';
  if (_has(txt, /in transit|towing|being towed|en route/)) return 'in_transit';
  if (_has(txt, /estimate.*(approv|authoriz)|awaiting approval|pending approval|approval needed/)) return 'awaiting_estimate_approval';
  if (_has(txt, /awaiting part|waiting on .*part|parts? on order|parts? ordered|parts? (arriv|delay|eta|back[- ]?order)|backorder/)) return 'awaiting_parts';
  if (_has(txt, /awaiting vendor|waiting on (the )?(vendor|dealer)|vendor to respond|dealer to respond/)) return 'awaiting_vendor';
  if (_has(txt, /in repair|in progress|being (repaired|serviced|worked)|under repair|diagnos|teardown/)) return 'in_repair';
  // Decision didn't sharpen the status — keep the deterministic one.
  return baseStatus;
}

// waitingOn from the reconcile decision's richer signal (who commented last).
function _waitingOnFromDecision(decision, fallback) {
  const d = decision || {};
  if (d.followUpNeeded || d.lastCommentBy === 'us') return 'vendor'; // ball in vendor's court
  if (d.lastCommentBy === 'vendor') return 'us';                     // they updated us
  return fallback || '';
}

/**
 * reconcileCanonical(row, opts) -> canonical record UPGRADED with the AI decision.
 * opts.decision is a relay_reconcile decision (from reconcileUnit). This does NOT
 * call the AI itself — it folds an already-produced decision into the record so
 * canonical state carries the reconciled truth without a second AI round-trip.
 * If no decision is given, falls back to the deterministic baseline.
 */
function reconcileCanonical(row, opts) {
  opts = opts || {};
  const base = computeCanonical(row);
  if (!base) return null;
  const decision = opts.decision;
  if (!decision || decision.aiUnavailable) {
    // No usable AI decision — keep the deterministic baseline, but if a decision
    // object exists it may still carry a confidence/stale read worth recording.
    if (decision) {
      base.stale = !!decision.isStale || base.stale;
      if (base.stale && !base.flags.includes('stale')) base.flags.push('stale');
    }
    return base;
  }
  // Fold the AI reconcile decision in.
  const status = _statusFromDecision(decision, base.status);
  const situation = _s(decision.currentStatus) || base.situation;
  const nextStep = _s(decision.nextStep) || base.nextStep;
  const confidence = Number.isFinite(decision.confidence) ? decision.confidence : base.confidence;
  const stale = !!decision.isStale;
  const waitingOn = _waitingOnFromDecision(decision, base.waitingOn);

  // Provenance: when the AI pulled a missing update out of Offsite that Relay
  // lacked, Offsite was the trusted source; otherwise keep the derived source.
  let source = base.source;
  if (_s(decision.missingUpdate) && decision.relayHasLatest === false) source = 'offsite';

  // Merge flags (dedup) + add reconcile-derived ones.
  const flags = base.flags.slice();
  const addFlag = (f) => { if (f && !flags.includes(f)) flags.push(f); };
  if (stale) addFlag('stale'); else { const i = flags.indexOf('stale'); if (i >= 0) flags.splice(i, 1); }
  if (decision.followUpNeeded) addFlag('needs_followup');
  if (_s(decision.dealerAsk)) addFlag('dealer_ask');
  if (decision.relayHasLatest === false && _s(decision.missingUpdate)) addFlag('relay_gap');

  return {
    equipmentId: base.equipmentId,
    status: isValidStatus(status) ? status : base.status,
    situation: situation.slice(0, 400),
    nextStep: nextStep.slice(0, 400),
    source,
    confidence,
    stale,
    waitingOn,
    flags,
    aiReconciled: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * mirrorFields(record) -> a small object of canonical fields to copy onto the
 * fleetData row so existing panels can read canonical state without a new UI.
 * Prefixed `canonical*` so they never collide with scraped fields.
 */
function mirrorFields(record) {
  const r = record || {};
  return {
    canonicalStatus: r.status || 'unknown',
    canonicalSituation: r.situation || '',
    canonicalNextStep: r.nextStep || '',
    canonicalSource: r.source || '',
    canonicalConfidence: Number.isFinite(r.confidence) ? r.confidence : null,
    canonicalStale: !!r.stale,
    canonicalWaitingOn: r.waitingOn || '',
    canonicalFlags: Array.isArray(r.flags) ? r.flags.slice() : [],
    canonicalAiReconciled: !!r.aiReconciled,
    canonicalUpdatedAt: r.updatedAt || null,
  };
}

/**
 * buildAll(rows, opts) -> { units, mirrored, counts }
 * Pure (no I/O): compute a canonical record for EVERY row (deterministic), then
 * UPGRADE the subset for which an AI reconcile decision was provided. Returns
 * the keyed units map, the same rows with canonical fields mirrored on, and
 * simple counts. The sync pass handles persistence + the (bounded) AI calls;
 * keeping this pure makes the whole thing unit-testable without a store or AI.
 *
 * opts.decisions — optional Map or object keyed by equipmentId -> relay_reconcile
 *                  decision. Rows with a decision get reconcileCanonical(); all
 *                  others get the deterministic computeCanonical() baseline.
 */
function buildAll(rows, opts) {
  opts = opts || {};
  const list = Array.isArray(rows) ? rows : [];
  const decisions = opts.decisions || {};
  const getDecision = (id) => {
    if (decisions instanceof Map) return decisions.get(id);
    return decisions[id];
  };
  const units = {};
  let reconciled = 0, baseline = 0;
  const mirrored = list.map((row) => {
    const id = _s(row && row.equipmentId);
    if (!id) return row;
    const decision = getDecision(id);
    const record = decision ? reconcileCanonical(row, { decision }) : computeCanonical(row);
    if (!record) return row;
    units[id] = record;
    if (record.aiReconciled) reconciled++; else baseline++;
    return Object.assign({}, row, mirrorFields(record));
  });
  return {
    units,
    mirrored,
    counts: { total: Object.keys(units).length, reconciled, baseline },
  };
}

module.exports = {
  STATUSES,
  isValidStatus,
  isDown,
  computeCanonical,
  reconcileCanonical,
  mirrorFields,
  buildAll,
  // exported for tests / reuse
  _deriveStatus,
  _deriveSource,
  _deriveFlags,
  _daysSinceOffsite,
  _statusFromDecision,
  _waitingOnFromDecision,
};
