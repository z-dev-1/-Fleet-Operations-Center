'use strict';
/**
 * scrapers/repair_phase.js — first-class repair-phase + waitingOn vocabulary
 * for the Relay ↔ Offsite reconcile engine.
 *
 * This is an ADDITIVE layer on top of the existing reconcile/canonical model.
 * The existing canonical_state `phase` dimension is a coarse 7-value axis
 * (none/diagnosing/awaiting_parts/awaiting_estimate_approval/in_repair/complete/
 * unknown). The reconcile engine needs a finer, operations-grade phase so it can
 * reason like a Fleet Asset Specialist (estimate vs approval vs parts-backorder
 * vs ready-for-pickup are materially different next actions).
 *
 * Nothing here replaces the coarse dimension — `toCanonicalPhase()` projects the
 * fine phase BACK onto the coarse enum so every existing canonical consumer
 * keeps working unchanged.
 *
 * Grounding rule (hard): NEVER infer a more advanced phase than the evidence
 * supports. "Estimate submitted, awaiting approval" is awaiting_approval, NOT
 * repair_in_progress. When the text is ambiguous, return 'unknown'.
 */

// ── The 19-value first-class repair phase enum (spec §3) ─────────────────────
const REPAIR_PHASES = [
  'awaiting_vendor',
  'appointment_scheduled',
  'vehicle_arrived',
  'diagnosis',
  'diagnosis_complete',
  'awaiting_estimate',
  'awaiting_approval',
  'awaiting_parts',
  'parts_backordered',
  'parts_received',
  'repair_in_progress',
  'road_test',
  'quality_check',
  'ready_for_pickup',
  'pickup_scheduled',
  'repair_complete',
  'reroute_required',
  'closed',
  'unknown',
];

// ── The waitingOn enum (spec §4) ─────────────────────────────────────────────
const WAITING_ON = [
  'vendor', 'internal', 'approval', 'parts', 'transportation',
  'pickup', 'customer', 'fleet', 'nobody', 'unknown',
];

function isRepairPhase(v) { return REPAIR_PHASES.includes(String(v || '')); }
function isWaitingOn(v) { return WAITING_ON.includes(String(v || '')); }

// Map the fine repair phase back onto the coarse canonical_state `phase`
// dimension so existing consumers keep working. The coarse enum is:
//   none | diagnosing | awaiting_parts | awaiting_estimate_approval |
//   in_repair | complete | unknown
function toCanonicalPhase(repairPhase) {
  switch (String(repairPhase || '')) {
    case 'diagnosis':
    case 'diagnosis_complete':
      return 'diagnosing';
    case 'awaiting_estimate':
    case 'awaiting_approval':
      return 'awaiting_estimate_approval';
    case 'awaiting_parts':
    case 'parts_backordered':
      return 'awaiting_parts';
    case 'parts_received':
    case 'repair_in_progress':
    case 'road_test':
    case 'quality_check':
      return 'in_repair';
    case 'ready_for_pickup':
    case 'pickup_scheduled':
    case 'repair_complete':
      return 'complete';
    case 'closed':
      return 'complete';
    case 'awaiting_vendor':
    case 'appointment_scheduled':
    case 'vehicle_arrived':
      // The unit is in a repair flow but no sub-work has started; the coarse
      // axis has no dedicated bucket, so 'diagnosing' is the closest "active
      // repair, pre-parts" value without claiming parts/approval/complete.
      return 'diagnosing';
    case 'reroute_required':
      return 'in_repair'; // still down, mid-flow; reroute is an action, not a phase bucket
    case 'unknown':
    default:
      return 'unknown';
  }
}

// Map the fine waitingOn back onto the coarse canonical waitingOn dimension:
//   us | vendor | parts | approval | none
function toCanonicalWaitingOn(waitingOn) {
  switch (String(waitingOn || '')) {
    case 'vendor':         return 'vendor';
    case 'parts':          return 'parts';
    case 'approval':       return 'approval';
    case 'internal':       return 'us';
    case 'fleet':          return 'us';
    case 'pickup':         return 'us';
    case 'transportation': return 'us';
    case 'customer':       return 'us';
    case 'nobody':         return 'none';
    case 'unknown':
    default:               return 'none';
  }
}

const _lc = (s) => String(s == null ? '' : s).toLowerCase();
const _has = (hay, re) => re.test(_lc(hay));

// ── Deterministic phase derivation from the known text signals ───────────────
// Reads the SAME operational signals the rest of the engine uses (serviceState,
// completed, lifecycleReason, offsite/relay thread text). Order matters: more
// terminal / more specific states are tested first, and we NEVER claim a more
// advanced phase than the matched signal supports.
//
// `text` is a single blob (caller joins the relevant fields). `opts.completed`
// lets the caller force the terminal check (e.g. AAP says closed).
function derivePhase(text, opts) {
  opts = opts || {};
  const t = _lc(text);

  // Tow-OUT (home yard -> dealer) means the repair has NOT started; treat as
  // awaiting_vendor, never ready. Tested before any "ready" match.
  const towOut = /ready\s+to\s+be\s+towed(\s+out)?|towed?\s+out\s+to|needs?\s+to\s+(be\s+towed|go\s+to\s+(the\s+)?(dealer|shop))|staged\s+for\s+(a\s+)?tow|ready\s+for\s+tow(\s+out)?|awaiting\s+tow\s+to/;
  if (towOut.test(t)) return 'awaiting_vendor';

  // Terminal.
  if (opts.closed || _has(t, /work order (closed|cancell?ed)|wo closed|case closed|invoiced|picked up|pickup complete/)) return 'closed';

  // Ready for pickup — the guaranteed completion markers (mirrors canonical
  // _isReadyForPickup, tow-out already excluded above).
  if (_has(t, /case status set to asset ready|\basset is ready\b|\basset ready\b|ready for pick\s*-?\s*up|ready to be picked up|awaiting pick\s*-?\s*up|ready to pick up/)) return 'ready_for_pickup';
  if (_has(t, /pickup scheduled|scheduled for pickup|pickup (set|arranged)|driver (dispatched|en route) (for|to) pick/)) return 'pickup_scheduled';

  // Repair-complete prose (not necessarily "ready for pickup" wording).
  if (_has(t, /repairs? (are )?complete|repair done|work complete(d)?|all repairs finished/)) return 'repair_complete';

  // Reroute — current vendor cannot do the repair.
  if (_has(t, /cannot (perform|complete|do) (this|the) repair|needs? (an? )?oem dealer|refer(red)? to (another|oem)|reroute|re-route|send to (a )?different (dealer|shop)/)) return 'reroute_required';

  // Quality / road test (post-repair verification).
  if (_has(t, /road test|test driv|quality (check|control)|qc (check|pass)|final inspection/)) {
    return _has(t, /quality (check|control)|qc (check|pass)|final inspection/) ? 'quality_check' : 'road_test';
  }

  // Parts sub-states (most specific first).
  if (_has(t, /back\s*order|backordered|no eta (on|for) (the )?part|part.*no eta/)) return 'parts_backordered';
  if (_has(t, /parts? (have )?(arrived|received|are in|came in|delivered)|received the parts?/)) return 'parts_received';
  if (_has(t, /awaiting part|waiting on (the )?parts?|parts? on order|parts? ordered|part ordered|ordered the parts?|parts? eta|parts? delay/)) return 'awaiting_parts';

  // Approval / estimate (approval is more advanced than "preparing estimate").
  if (_has(t, /estimate.*(approv|authoriz)|awaiting approval|pending approval|approval (needed|required|pending)|needs approval|waiting (for|on) approval|approve the estimate|estimate submitted/)) return 'awaiting_approval';
  if (_has(t, /preparing (an? )?estimate|estimate (is )?(being )?(prepared|in progress|pending|to follow)|working on (the )?estimate|quote to follow/)) return 'awaiting_estimate';

  // Active repair.
  if (_has(t, /in (the )?bay|repairs? (are )?(underway|in progress)|currently (being )?(repaired|worked)|work in progress|wip|under repair|installing|replacing the/)) return 'repair_in_progress';

  // Diagnosis.
  if (_has(t, /diagnosis complete|diagnosed|diagnostics? complete|found the (issue|problem|fault)|root cause (identified|found)/)) return 'diagnosis_complete';
  if (_has(t, /diagnos|teardown|troubleshoot|inspect|assess|evaluating|checking (the|into)/)) return 'diagnosis';

  // Arrival / appointment.
  if (_has(t, /(unit|asset|vehicle|truck) (has )?arrived|checked in|dropped off|at the (dealer|shop|vendor)|in (the )?shop/)) return 'vehicle_arrived';
  if (_has(t, /appointment (scheduled|set|booked)|scheduled for \w+ \d|drop\s*-?\s*off scheduled|service appointment/)) return 'appointment_scheduled';

  // Earliest state: unit is down and we're waiting on the vendor to engage.
  if (_has(t, /awaiting vendor|waiting on (the )?(vendor|dealer)|pending vendor|vendor to (respond|engage)|no response from (the )?(vendor|dealer)/)) return 'awaiting_vendor';

  return 'unknown';
}

// ── Deterministic waitingOn from phase (+ who spoke last) ────────────────────
// Phase strongly implies who owes the next move; lastSpeaker breaks ties for
// the "awaiting" phases (if WE spoke last we're waiting on them, not ourselves).
function deriveWaitingOn(repairPhase, lastSpeaker) {
  switch (String(repairPhase || '')) {
    case 'awaiting_approval':   return 'approval';
    case 'awaiting_estimate':   return 'vendor';   // vendor is preparing it
    case 'awaiting_parts':      return 'parts';
    case 'parts_backordered':   return 'parts';
    case 'parts_received':      return 'vendor';   // vendor resumes work
    case 'repair_in_progress':  return 'vendor';
    case 'diagnosis':           return 'vendor';
    case 'diagnosis_complete':  return 'vendor';   // vendor moves to estimate/repair
    case 'road_test':           return 'vendor';
    case 'quality_check':       return 'vendor';
    case 'ready_for_pickup':    return 'pickup';
    case 'pickup_scheduled':    return 'transportation';
    case 'repair_complete':     return 'pickup';
    case 'reroute_required':    return 'internal';
    case 'vehicle_arrived':     return 'vendor';
    case 'appointment_scheduled': return 'vendor';
    case 'awaiting_vendor':
      // If we spoke last we're waiting on the vendor; if they spoke last we may
      // owe a reply (caller's question logic refines this).
      return 'vendor';
    case 'closed':              return 'nobody';
    case 'unknown':
    default:                    return 'unknown';
  }
}

module.exports = {
  REPAIR_PHASES,
  WAITING_ON,
  isRepairPhase,
  isWaitingOn,
  toCanonicalPhase,
  toCanonicalWaitingOn,
  derivePhase,
  deriveWaitingOn,
};
