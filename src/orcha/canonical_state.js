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

// ── Multidimensional axes (independent dimensions) ─────────────────────────────
// The flat `status` enum collapses a unit to ONE state, but reality is
// orthogonal: a unit can be down AND awaiting_parts AND at a vendor all at once.
// We model that as independent AXES, each derived on its own from the fields
// already on the row. `status` stays as the back-compat rollup (availability +
// phase); every existing consumer keeps reading it unchanged. New consumers can
// read `record.dimensions` to reason on any single axis.
//
// Each axis value comes with its own {value, confidence, source} so a surface
// can show per-axis provenance (e.g. location trusted to AAP GPS while phase
// trusted to the offsite thread).
const DIMENSIONS = ['availability', 'phase', 'location', 'waitingOn', 'risk'];

const DIMENSION_VALUES = {
  // Is the unit usable? (independent of WHY it's down)
  availability: ['available', 'down', 'decommissioned', 'unknown'],
  // Where is the repair in its lifecycle? ('none' = not in a repair flow)
  phase:        ['none', 'diagnosing', 'awaiting_parts', 'awaiting_estimate_approval', 'in_repair', 'complete', 'unknown'],
  // Physically, where is the unit?
  location:     ['at_yard', 'in_transit', 'at_vendor', 'offsite', 'unknown'],
  // Who owes the next move?
  waitingOn:    ['us', 'vendor', 'parts', 'approval', 'none'],
  // Predictive risk (from Uptake).
  risk:         ['high', 'medium', 'low', 'none'],
};

function isValidDimensionValue(dim, val) {
  const allowed = DIMENSION_VALUES[dim];
  return Array.isArray(allowed) && allowed.includes(String(val || ''));
}

// ── Small helpers ──────────────────────────────────────────────────────────────

// Clean "mojibake" — text already UTF-8 but decoded once-or-twice as
// Windows-1252/Latin-1 upstream, so a middle dot "·" shows up as "Ã‚Â·", an em
// dash "—" as "Ã¢â‚¬â€", a right single quote "’" as "Ã¢â‚¬â„¢", etc. Blindly
// re-decoding bytes is unreliable (triple-layered sequences produce U+FFFD and
// can damage good text), so instead we SANITIZE deterministically: map the
// handful of well-known garbled sequences to their intended ASCII equivalent
// (longest-first so multi-char sequences win), then strip any leftover
// Ã/Â/â€ noise. This can only remove garbage — clean text with no mojibake
// signature is returned untouched.
const _MOJIBAKE_MAP = [
  ['Ã¢â‚¬â„¢', "'"], ['Ã¢â‚¬Å“', '"'], ['Ã¢â‚¬\u009d', '"'],
  ['Ã¢â‚¬â€œ', '-'], ['Ã¢â‚¬â€', '-'], ['Ã¢â‚¬Â¦', '...'],
  ['Ã¢â€šÂ¬', 'EUR'], ['Ã‚Â·', '·'], ['Ã‚', ''], ['Â·', '·'],
  ['â€™', "'"], ['â€œ', '"'], ['â€\u009d', '"'], ['â€“', '-'], ['â€”', '-'], ['â€¦', '...'],
];
function _fixMojibake(input) {
  let s = String(input == null ? '' : input);
  if (!/[ÃÂâ]/.test(s)) return s; // no mojibake signature — leave clean text alone
  for (const [bad, good] of _MOJIBAKE_MAP) s = s.split(bad).join(good);
  // Strip any residual lone noise bytes left by deeper corruption, plus the
  // U+FFFD replacement char if present. Keep normal accented chars intact.
  s = s.replace(/[ÃÂ](?=[\s·])/g, '').replace(/\uFFFD/g, '');
  return s;
}

// Trim + repair mojibake + strip stray NULs. Use for any human-facing string we
// emit into the canonical record.
function _s(v) { return _fixMojibake(String(v == null ? '' : v)).replace(/\u0000/g, '').trim(); }
function _lc(v) { return _s(v).toLowerCase(); }
function _has(hay, re) { return re.test(_lc(hay)); }

// Is this unit down/unavailable per AAP lifecycle? (same test the sync pass uses)
function isDown(row) {
  return _lc(row && (row.lifecycleState || row.atsState)).includes('unavail');
}

// ── Decisiv/ASIST "ready" vs "tow-out" disambiguation (domain rule) ─────────────
// CONFIRMED by operations: on a Decisiv/ASIST case, the GUARANTEED completion
// marker is the case-status line "Case status set to Asset Ready" (optionally
// with the prose "Asset is Ready ... ready for pickup"). THAT means the repair
// is finished and the unit can be picked up.
//
// CRITICAL: "ready to be towed out" is the OPPOSITE situation — the unit is
// staged at its HOME YARD to be towed OUT to the dealer (inbound tow; repair
// hasn't started). It must NEVER be read as ready-for-pickup, or we'd fire a
// "come get your unit" carrier notification on a unit that isn't even at the
// shop yet.
//
// READY_RE   : the authoritative repair-complete / ready-for-pickup signals.
// TOW_OUT_RE : the inbound "needs to be towed to the dealer" signals.
// We test TOW_OUT_RE FIRST everywhere so the tow-out phrasing can never be
// swallowed by a loose "ready" match (e.g. "asset is ready to be towed out").
const TOW_OUT_RE = /ready\s+to\s+be\s+towed(\s+out)?|towed?\s+out\s+to|tow(ed)?\s+(it\s+)?(out\s+)?to\s+(the\s+)?(dealer|shop|vendor)|needs?\s+to\s+(be\s+towed|go\s+to\s+(the\s+)?(dealer|shop))|staged\s+for\s+(a\s+)?tow|ready\s+for\s+tow(\s+out)?|awaiting\s+tow\s+to/i;
// The guaranteed completion marker + the common prose variants.
const READY_RE = /case\s+status\s+set\s+to\s+asset\s+ready|\basset\s+is\s+ready\b|\basset\s+ready\b|ready\s+for\s+pick\s*-?\s*up|ready\s+to\s+be\s+picked\s+up|awaiting\s+pick\s*-?\s*up|ready\s+to\s+pick\s+up/i;

// Does this text indicate a genuine repair-complete / ready-for-pickup state?
// Tow-out phrasing wins (returns false) so an inbound tow is never "ready".
function _isReadyForPickup(text) {
  const t = String(text || '');
  if (TOW_OUT_RE.test(t)) return false;        // inbound tow — NOT ready
  return READY_RE.test(t);
}
// Does this text indicate the unit needs to be towed TO the dealer (inbound)?
function _isTowOut(text) { return TOW_OUT_RE.test(String(text || '')); }

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

  // INBOUND TOW (home yard -> dealer) — check BEFORE "ready"/"complete" so a
  // note like "asset is ready to be towed out" is read as a pending tow TO the
  // dealer, NOT as a finished repair ready for pickup. Repair hasn't started.
  if (_isTowOut(blob)) return 'in_transit';

  // Ready / complete — a finished repair is the clearest state. Uses the
  // domain rule (_isReadyForPickup): the guaranteed marker is "Case status set
  // to Asset Ready"; tow-out phrasing is already excluded above.
  if (_isReadyForPickup(blob)) return 'ready_for_pickup';
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

// ── Independent-axis derivers (deterministic) ───────────────────────────────────
// Each reads only fields already on the row and returns a bare value from its
// DIMENSION_VALUES vocabulary. _buildDimensions wraps them with {value,
// confidence, source}. None of these fabricate — unknown/none is the honest
// default when the row doesn't say.

// AVAILABILITY — is the unit usable? This is purely the AAP lifecycle signal
// plus the terminal "decommissioned" read; it deliberately ignores repair
// sub-state (that's the `phase` axis).
function _deriveAvailability(row, status) {
  const r = row || {};
  if (status === 'decommissioned') return 'decommissioned';
  const life = _lc(r.lifecycleState || r.atsState);
  if (life.includes('unavail')) return 'down';
  if (_has(life, /avail|active|in service|ready/)) return 'available';
  // No lifecycle signal — fall back to the rollup status.
  if (status === 'available') return 'available';
  if (status && status !== 'unknown') return 'down'; // any repair state implies down
  return 'unknown';
}

// PHASE — where the repair is in its lifecycle, independent of availability.
// Reuses the same text signals as _deriveStatus but ONLY for the repair axis,
// so a unit that's back to available can still report its last phase as
// 'complete'.
function _derivePhase(row, status) {
  const r = row || {};
  // Map the rollup status straight through when it already names a phase.
  switch (status) {
    case 'awaiting_parts':              return 'awaiting_parts';
    case 'awaiting_estimate_approval':  return 'awaiting_estimate_approval';
    case 'in_repair':                   return 'in_repair';
    case 'ready_for_pickup':            return 'complete';
    case 'available':                   return 'none';
    case 'decommissioned':              return 'none';
    default: break;
  }
  const blob = [r.serviceState, r.completed, r.lifecycleReason, r.relayStatus, r.issueSummary, r.correction].map(_lc).join(' | ');
  if (_has(blob, /\bcomplete|completed|repair done|work complete|closed|resolved\b/)) return 'complete';
  if (_has(blob, /estimate.*(approv|authoriz)|awaiting approval|pending approval|approval needed|needs approval/)) return 'awaiting_estimate_approval';
  if (_has(blob, /awaiting part|waiting on part|parts? on order|part ordered|backorder|parts? delay/)) return 'awaiting_parts';
  if (_has(blob, /in repair|in progress|being (repaired|serviced|worked)|under repair|in (the )?shop/)) return 'in_repair';
  if (_has(blob, /diagnos|teardown|inspect|assess|troubleshoot/)) return 'diagnosing';
  // Down with no repair detail yet, or genuinely indeterminate.
  if (isDown(r)) return 'unknown';
  return 'none';
}

// LOCATION — physically where the unit is. GPS/geofence aren't parsed here
// (the canonical row doesn't carry them uniformly), so we read the textual
// signals: in-transit/tow language, an active offsite vendor thread, or a
// vendor assignment implying it's at the shop. Default at_yard when available.
function _deriveLocation(row, status) {
  const r = row || {};
  const blob = [r.serviceState, r.relayStatus, r.lifecycleReason, r.issueSummary, r.correction, r.repairTimeline].map(_lc).join(' | ');
  if (_has(blob, /in transit|towing|being towed|en route|transport|on (a )?(tow|hook)/)) return 'in_transit';
  if (status === 'in_transit') return 'in_transit';
  // A fresh offsite vendor thread means it's physically offsite at that vendor.
  const daysSince = _daysSinceOffsite(r);
  const hasOffsite = !!(_s(r.asistNotes) || _s(r.asistLabel) || _s(r.offsiteShopEvent));
  if (hasOffsite && daysSince !== null && daysSince <= 14) return 'offsite';
  // Down + assigned to a vendor => at the vendor's shop.
  if (isDown(r) && _s(r.vendor) && _s(r.vendor) !== '--') return 'at_vendor';
  if (status === 'available') return 'at_yard';
  return 'unknown';
}

// RISK — predictive-maintenance risk bucket from the Uptake score merged onto
// the row. Thresholds mirror the high_risk flag (>=80) and a soft mid band.
function _deriveRisk(row) {
  const rs = Number(row && row.riskScore);
  if (!Number.isFinite(rs) || rs <= 0) return 'none';
  if (rs >= 80) return 'high';
  if (rs >= 50) return 'medium';
  return 'low';
}

// Assemble the multidimensional block. Each axis carries its own provenance:
//   availability/phase -> the record's trusted `source` (they're read from the
//                         same operational signals that chose it)
//   location           -> offsite when an offsite read drove it, else the source
//   waitingOn          -> same as the record (derived from status/decision)
//   risk               -> 'uptake' when a score exists, else 'none'
// confidence is the deterministic baseline (0.5); reconcileCanonical raises the
// axes the AI actually sharpened.
function _buildDimensions(row, status, source, waitingOn, conf) {
  const r = row || {};
  const c = Number.isFinite(conf) ? conf : 0.5;
  const availability = _deriveAvailability(r, status);
  const phase = _derivePhase(r, status);
  const location = _deriveLocation(r, status);
  const risk = _deriveRisk(r);
  const wait = waitingOn || _deriveWaitingOn(status) || 'none';
  const locSource = (location === 'offsite') ? 'offsite' : source;
  return {
    availability: { value: availability, confidence: c, source },
    phase:        { value: phase,        confidence: c, source },
    location:     { value: location,     confidence: c, source: locSource },
    waitingOn:    { value: wait,         confidence: c, source },
    risk:         { value: risk,         confidence: risk === 'none' ? c : 0.8, source: risk === 'none' ? source : 'uptake' },
  };
}

// Validate/normalize a dimensions block so a value out of vocabulary never
// leaks into the record. Returns a clean block; coerces bad values to the
// dimension's honest default.
function _normalizeDimensions(dims) {
  const d = dims || {};
  const DEFAULTS = { availability: 'unknown', phase: 'unknown', location: 'unknown', waitingOn: 'none', risk: 'none' };
  const out = {};
  for (const dim of DIMENSIONS) {
    const axis = d[dim] || {};
    let value = axis.value;
    if (!isValidDimensionValue(dim, value)) value = DEFAULTS[dim];
    out[dim] = {
      value,
      confidence: Number.isFinite(axis.confidence) ? axis.confidence : 0.5,
      source: _s(axis.source) || '',
    };
  }
  return out;
}

// ── Evidence (the facts the conclusion rests on, by source) ────────────────────
// Deterministic: restates fields already on the row, each tagged with the source
// that produced it + when it was observed (if known). usedInConclusion marks the
// facts that drove the chosen status/source. Never fabricates — only lists what
// is present. Capped so the record stays small.
const _EVIDENCE_CAP = 6;
function _clipVal(v, n) { return _s(v).slice(0, n || 160); }

// ── Uptake predictive-maintenance block ────────────────────────────────────────
// mergeUptakeIntoRows() writes riskScore, riskLabel, insights (count),
// insightsList, and subsystems onto the fleetData row BEFORE the canonical pass
// runs. We fold a compact, deterministic summary of that onto the canonical
// record so every surface reads Uptake's predictive signal from the one
// authoritative place (not just the raw row). Never fabricates — only restates
// what Uptake already produced. Returns null when the row has no Uptake data.
const _UPTAKE_TOP_INSIGHTS = 5;
function _buildUptake(row) {
  const r = row || {};
  if (!r.uptakeSynced && r.riskScore == null && !Array.isArray(r.insightsList)) return null;
  const list = Array.isArray(r.insightsList) ? r.insightsList : [];
  const rs = Number(r.riskScore);
  const topInsights = list.slice(0, _UPTAKE_TOP_INSIGHTS).map((i) => ({
    title:     _clipVal(i && (i.title || i.name), 120),
    subsystem: _clipVal(i && i.subsystem, 60),
    status:    _clipVal(i && i.status, 40),
    lastSeen:  _s(i && (i.lastSeen || i.lastDetected)),
  })).filter((i) => i.title);
  return {
    riskScore:    Number.isFinite(rs) ? rs : null,
    riskLabel:    _clipVal(r.riskLabel, 60),
    insightCount: list.length || (Number(r.insights) || 0),
    subsystems:   Array.isArray(r.subsystems) ? r.subsystems.slice(0, 12) : [],
    topInsights,
    syncedAt:     _s(r.uptakeSyncedAt) || null,
  };
}

function _buildEvidence(row, status, source) {
  const r = row || {};
  const ev = [];
  const push = (src, field, value, observedAt) => {
    const val = _clipVal(value);
    if (!val) return;
    ev.push({ source: src, field, value: val, observedAt: observedAt || '', usedInConclusion: src === source });
  };
  // AAP lifecycle — the base availability signal.
  const life = _s(r.lifecycleState || r.atsState);
  if (life) push('aap', 'lifecycleState', life);
  if (_s(r.lifecycleReason)) push('aap', 'lifecycleReason', r.lifecycleReason);
  // Relay (internal WR) — state + last comment context.
  if (_s(r.serviceState)) push('relay', 'serviceState', r.serviceState);
  if (_s(r.relayStatus)) push('relay', 'relayStatus', r.relayStatus);
  // Offsite (vendor portal) — the freshest external reality, with its scrape time.
  if (_s(r.asistNotes)) push('offsite', 'asistNotes', r.asistNotes, _s(r.asistScrapedAt));
  else if (_s(r.offsiteShopEvent)) push('offsite', 'offsiteShopEvent', r.offsiteShopEvent, _s(r.asistScrapedAt));
  // Manual / operator note — human-confirmed.
  if (_s(r.manualNote) || _s(r.operatorNote) || _s(r.notesStatus)) {
    push('manual', 'note', r.manualNote || r.operatorNote || r.notesStatus);
  }
  // Timeline — the day-by-day narrative (last line is the most recent).
  const tl = _s(r.repairTimeline);
  if (tl) { const last = tl.split('\n').filter(Boolean).pop(); if (last) push('timeline', 'repairTimeline', last); }
  // Uptake predictive signal — risk score + the top insight title(s). This is a
  // forward-looking fact (a predicted/observed fault), tagged 'uptake' so it's
  // distinguishable from the operational AAP/relay/offsite signals above.
  const _rsEv = Number(r.riskScore);
  if (Number.isFinite(_rsEv) && _rsEv > 0) {
    const label = _s(r.riskLabel);
    push('uptake', 'riskScore', _rsEv + (label ? ' (' + label + ')' : ''), _s(r.uptakeSyncedAt));
  }
  const _insList = Array.isArray(r.insightsList) ? r.insightsList : [];
  if (_insList.length) {
    const titles = _insList.slice(0, 3).map((i) => _s(i && (i.title || i.name))).filter(Boolean);
    if (titles.length) push('uptake', 'insights', titles.join('; '), _s(r.uptakeSyncedAt));
  }
  // Order: used-in-conclusion first, then by richness; cap.
  ev.sort((a, b) => (b.usedInConclusion ? 1 : 0) - (a.usedInConclusion ? 1 : 0));
  return ev.slice(0, _EVIDENCE_CAP);
}

// Boilerplate / chrome lines that are NOT a real update (page footers, nav,
// copyright, version banners, generic labels). We skip these when picking the
// "last meaningful update" so we never surface "Copyright © Decisiv..." as the
// freshest news.
const _BOILERPLATE_RE = /copyright|all rights reserved|privacy policy|policies\s*&|cookie|news center|version\s+v?\d|terms of|skip to main|associate workspace|dark mode|contact us|^\s*(none\.*|--|n\/a)\s*$/i;
function _isBoilerplate(line) {
  const s = String(line || '').trim();
  if (!s || s.length < 6) return true;
  return _BOILERPLATE_RE.test(s);
}
// "Ref noise" — process/bookkeeping lines that are technically a comment but say
// nothing about the unit's real state: bare reach/reference IDs, "reached out to
// vendor" with no content, work-order pointers, blank acknowledgements. These
// are poor status-change reasons, so we skip them when synthesizing one.
const _REF_NOISE_RE = /^(sm\/?nra|nra|w\/ad|aa reach|reached out to (the )?vendor|as per reach ref|reach ref|per reach|work order #?\d|wo #?\d|ref\s*[:#]|bo\d{5,}|ro\s*#|po\s*#|https?:\/\/|disregard|please disregard|automation|recipient)\b/i;
function _isRefNoise(line) {
  // Strip a leading date/timeline prefix ("10/10 - ", "Oct 9, 2026: ") so the
  // noise patterns match the actual content, not the date.
  let s = String(line || '').trim().replace(/^\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*[-:]\s*/, '').replace(/^[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}[^:]*:\s*/, '').trim();
  if (!s) return true;
  if (_REF_NOISE_RE.test(s)) return true;
  // A line that's mostly an ID/reference token with little prose.
  if (s.length < 40 && /\b[A-Z]{2,}\d{4,}\b/.test(s) && !/[.?!]/.test(s)) return true;
  // Very short acknowledgements with no substance.
  if (s.length < 8) return true;
  return false;
}
// Is this text a SUBSTANTIVE update (not boilerplate, not ref-noise)?
function _isSubstantive(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return !_isBoilerplate(s) && !_isRefNoise(s);
}

// Last NON-boilerplate line of a multi-line blob (scanning upward).
function _lastRealLine(blob) {
  const lines = String(blob || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!_isBoilerplate(lines[i])) return lines[i];
  }
  return '';
}
// Last SUBSTANTIVE line (skips both boilerplate AND ref-noise), for status
// reasons where a bare "reached out to vendor" or ref ID is useless.
function _lastSubstantiveLine(blob) {
  const lines = String(blob || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (_isSubstantive(lines[i])) return lines[i];
  }
  return '';
}

// The freshest SUBSTANTIVE update we can point to (not status noise, not page
// chrome). Prefers a structured last comment, then the offsite thread's last
// real line, then the latest timeline line, then issue summary.
function _lastMeaningfulUpdate(row) {
  const r = row || {};
  // Best: the latest SUBSTANTIVE comment from the parsed Relay/Offsite thread.
  // Walk backward past ref-noise/boilerplate comments so we don't surface a
  // bare "reached out to vendor" / ref-ID as the freshest news.
  try {
    const cp = require('../scrapers/convo_parse');
    const relayC = cp.parseConversation(_s(r.fullConversation), { cap: 20 });
    const offC = cp.parseConversation(_s(r.asistNotes), { cap: 20 });
    const arr = offC.length ? offC : relayC;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].text && _isSubstantive(arr[i].text)) {
        return { source: offC.length ? 'offsite' : 'relay', text: _clipVal(arr[i].text, 300), at: arr[i].date || _s(r.asistScrapedAt) };
      }
    }
  } catch (_) { /* parser unavailable — fall through to line scan */ }
  const offsite = _s(r.asistNotes);
  if (offsite) {
    const line = _lastSubstantiveLine(offsite) || _lastRealLine(offsite);
    if (line) return { source: 'offsite', text: _clipVal(line, 300), at: _s(r.asistScrapedAt) };
  }
  const tl = _s(r.repairTimeline);
  if (tl) {
    const last = _lastSubstantiveLine(tl) || _lastRealLine(tl);
    if (last) return { source: 'timeline', text: _clipVal(last, 300), at: '' };
  }
  const sum = _s(r.issueSummary || r.correction);
  if (sum) return { source: 'relay', text: _clipVal(sum, 300), at: '' };
  return null;
}

// Deterministic obvious-conflict detection: AAP says available but a repair
// state says otherwise, or AAP says down but completion text says ready. These
// are the cross-source disagreements we can see WITHOUT the AI. The AI tier adds
// reasoned resolution; here we record the disagreement + a plain resolution note.
function _detectObviousConflicts(row, status, source) {
  const r = row || {};
  const conflicts = [];
  const down = isDown(r);
  const svc = _s(r.serviceState) || _s(r.relayStatus);
  // AAP down but Relay/Offsite say ready/complete.
  if (down && (status === 'ready_for_pickup' || status === 'available')) {
    conflicts.push({
      field: 'status',
      positions: [
        { source: 'aap', value: _s(r.lifecycleState || 'Unavailable') },
        { source, value: svc || 'repair complete' },
      ],
      resolution: source,
      reason: 'AAP lifecycle still shows unavailable but the repair record indicates the work is finished; trusting the repair record pending the lifecycle clear.',
    });
  }
  return conflicts;
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
  const situation = situationBits.join(' - ').slice(0, 300);
  return {
    equipmentId,
    status,
    // Independent axes — the multidimensional view. `status` above stays the
    // back-compat rollup; `dimensions` lets a consumer reason on any single axis
    // (availability / phase / location / waitingOn / risk) with per-axis
    // provenance. Deterministic baseline (confidence 0.5); the AI tier sharpens.
    dimensions: _buildDimensions(r, status, source, waitingOn, 0.5),
    situation,
    nextStep: '',          // deterministic tier doesn't guess a next step
    source,                // provenance: where the trusted signal came from
    confidence: 0.5,       // deterministic baseline confidence
    stale,
    waitingOn,
    flags,
    aiReconciled: false,
    // Next-action intent — the deterministic tier can't read a conversation to
    // detect an unanswered question, so it stays 'none'/empty here; the AI tier
    // (reconcileCanonical) fills these in. Keeps the record shape consistent.
    nextActionType: 'none',
    awaitingReply: '',
    threadOfRecord: '',
    // Audit trail — the facts behind the conclusion, the freshest real update,
    // and any obvious cross-source disagreement (deterministic).
    evidence: _buildEvidence(r, status, source),
    conflicts: _detectObviousConflicts(r, status, source),
    lastMeaningfulUpdate: _lastMeaningfulUpdate(r),
    // Uptake predictive-maintenance summary (null when the unit has no Uptake
    // data). Deterministic restatement of the merged row's riskScore/insights.
    uptake: _buildUptake(r),
    // Temporal fields — filled by diffAgainstPrior() in buildAll against the
    // previous cycle's record. Defaults here so a standalone compute is complete.
    changedFields: [],
    previousStatus: null,
    statusChangedAt: null,
    statusChangeReason: '',
    // Set by ready_pickup_notify after it messages the carrier that the unit is
    // ready for pickup. Carried across cycles by diffAgainstPrior and CLEARED
    // when the unit leaves ready_for_pickup — so the carrier is notified exactly
    // ONCE per ready episode, no matter how much the raw status flaps.
    carrierNotifiedAt: null,
    history: [],
    // Cheap change-detection proxy for next cycle (not displayed): length of the
    // relay conversation, so detectChangedUnits can see a new comment landed.
    _convoLen: _s(r.fullConversation).length,
    updatedAt: new Date().toISOString(),
  };
}

// Map a relay_reconcile decision's free-text status/next-step into our enum when
// the deterministic status is weak (down/unknown). The AI reconcile already read
// Relay vs Offsite, so prefer its read when it's clearly more specific.
function _statusFromDecision(decision, baseStatus) {
  const d = decision || {};
  const txt = _lc(d.currentStatus + ' ' + d.nextStep);
  // Inbound tow (home yard -> dealer) first — never let it read as ready.
  if (_isTowOut(txt)) return 'in_transit';
  // Ready for pickup only on a genuine completion signal (tow-out excluded).
  if (d.completed || _isReadyForPickup(txt)) return 'ready_for_pickup';
  if (_has(txt, /\bcomplete|completed|repair done|closed|resolved\b/)) return 'ready_for_pickup';
  if (_has(txt, /in transit|towing|being towed|en route/)) return 'in_transit';
  if (_has(txt, /estimate.*(approv|authoriz)|awaiting approval|pending approval|approval needed/)) return 'awaiting_estimate_approval';
  if (_has(txt, /awaiting part|waiting on .*part|parts? on order|parts? ordered|parts? (arriv|delay|eta|back[- ]?order)|backorder/)) return 'awaiting_parts';
  if (_has(txt, /awaiting vendor|waiting on (the )?(vendor|dealer)|vendor to respond|dealer to respond/)) return 'awaiting_vendor';
  if (_has(txt, /in repair|in progress|being (repaired|serviced|worked)|under repair|diagnos|teardown/)) return 'in_repair';
  // Decision didn't sharpen the status — keep the deterministic one.
  return baseStatus;
}

// waitingOn from the reconcile decision's richer signal. The next-action intent
// is the strongest signal (it already resolved the back-and-forth):
//   reply_to_vendor -> WE owe the vendor an answer ('us')
//   request_update  -> THEY owe us the next thing      ('vendor')
// Fall back to who-commented-last when there's no clear intent.
function _waitingOnFromDecision(decision, fallback) {
  const d = decision || {};
  if (d.nextActionType === 'reply_to_vendor' || d.weOweReply) return 'us';     // we must reply
  if (d.nextActionType === 'request_update') return 'vendor';                  // they owe us
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
  // Intent flags — an open vendor question we owe an answer to is the single
  // most action-worthy state, so flag it loudly.
  if (decision.nextActionType === 'reply_to_vendor' || decision.weOweReply) addFlag('question_open');
  if (decision.nextActionType === 'request_update') addFlag('awaiting_vendor_reply');

  // Evidence: start from the deterministic set, then add what the AI pulled from
  // Offsite that Relay lacked (the gap-fill) as an offsite fact that drove the
  // conclusion. Keeps the audit trail honest about what the AI actually used.
  const evidence = Array.isArray(base.evidence) ? base.evidence.slice() : [];
  if (_s(decision.missingUpdate)) {
    evidence.unshift({ source: 'offsite', field: 'missingUpdate', value: _clipVal(decision.missingUpdate), observedAt: '', usedInConclusion: true });
  }
  // An open question the vendor asked us is a decisive fact — record it as
  // evidence from the thread it came from so the audit trail shows why we owe a reply.
  if (_s(decision.awaitingReply)) {
    const qSrc = decision.threadOfRecord === 'relay' ? 'relay' : 'offsite';
    evidence.unshift({ source: qSrc, field: 'openQuestion', value: _clipVal(decision.awaitingReply, 300), observedAt: '', usedInConclusion: true });
  }

  // Conflicts: prefer the AI's reasoned conflicts when it returned any (strictly
  // optional, sanitized, never-throw); otherwise keep the deterministic ones.
  const conflicts = _normalizeConflicts(decision.conflicts, source) || base.conflicts || [];

  // lastMeaningfulUpdate: the AI's missing-update IS the freshest substantive
  // thing when present; else keep the deterministic read.
  let lastMeaningfulUpdate = base.lastMeaningfulUpdate;
  if (_s(decision.missingUpdate)) {
    lastMeaningfulUpdate = { source: 'offsite', text: _clipVal(decision.missingUpdate, 300), at: _s(decision.decidedAt) };
  }

  // Rebuild the independent axes from the AI-sharpened status/source/waitingOn.
  // The axes the decision actually reasoned over (phase via the sharpened
  // status, waitingOn, and availability) inherit the decision's confidence; the
  // others keep the deterministic baseline. Location also lifts to the
  // decision's confidence when the AI trusted offsite (it read the thread).
  const finalStatus = isValidStatus(status) ? status : base.status;
  const dimensions = _buildDimensions(row, finalStatus, source, waitingOn, confidence);
  dimensions.phase.confidence = confidence;
  dimensions.waitingOn.confidence = confidence;
  dimensions.availability.confidence = confidence;
  if (source === 'offsite') dimensions.location.confidence = confidence;

  return {
    equipmentId: base.equipmentId,
    status: finalStatus,
    dimensions,
    situation: situation.slice(0, 400),
    nextStep: nextStep.slice(0, 400),
    source,
    confidence,
    stale,
    waitingOn,
    flags,
    aiReconciled: true,
    // Next-action intent — what WE must do next (reply to a vendor question /
    // request an update / post to Relay / nothing) + the open question text and
    // which thread the exchange is in. These drive the apply + Split View routing.
    nextActionType: ['reply_to_vendor', 'request_update', 'post_to_relay', 'none'].includes(decision.nextActionType) ? decision.nextActionType : 'none',
    awaitingReply: _clipVal(decision.awaitingReply, 300),
    threadOfRecord: decision.threadOfRecord === 'relay' ? 'relay' : (decision.threadOfRecord === 'offsite' ? 'offsite' : ''),
    evidence: evidence.slice(0, _EVIDENCE_CAP + 2),
    conflicts,
    lastMeaningfulUpdate,
    // AI's grounded reason for a status change (if it supplied one); the real
    // from/to + timestamps are set by diffAgainstPrior() in buildAll.
    changedFields: [],
    previousStatus: null,
    statusChangedAt: null,
    statusChangeReason: _clipVal(decision.statusChangeReason, 300),
    history: [],
    _convoLen: base._convoLen || 0,
    updatedAt: new Date().toISOString(),
  };
}

// Sanitize an AI-provided conflicts array into our shape. Optional + defensive:
// returns null when nothing usable (so the caller keeps the deterministic set),
// never throws. Each conflict: { field, positions:[{source,value}], resolution,
// reason }. We never invent a source — resolution must be one of the positions'
// sources (or the record's trusted source), else we drop the resolution.
function _normalizeConflicts(raw, trustedSource) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const field = _clipVal(c.field, 40);
    const positions = Array.isArray(c.positions) ? c.positions
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({ source: _clipVal(p.source, 20), value: _clipVal(p.value, 160) }))
      .filter((p) => p.source && p.value)
      .slice(0, 4) : [];
    if (!field || positions.length < 2) continue; // a conflict needs >=2 positions
    const srcs = positions.map((p) => p.source);
    let resolution = _clipVal(c.resolution, 20);
    if (resolution && !srcs.includes(resolution)) {
      // Resolution must name one of the conflicting sources; else fall back to
      // the trusted source if it's among them, otherwise drop it (don't invent).
      resolution = srcs.includes(trustedSource) ? trustedSource : '';
    }
    out.push({ field, positions, resolution, reason: _clipVal(c.reason, 300) });
    if (out.length >= 4) break;
  }
  return out.length ? out : null;
}

// ── Temporal diffing (event history) ───────────────────────────────────────────
// Which row/record fields we track for "something changed." The sync pass uses
// the SAME set to decide which units get a priority AI reconcile (event-trigger).
const TRACKED_FIELDS = ['status', 'situation', 'nextStep', 'source', 'waitingOn', 'stale'];
const _HISTORY_CAP = 10;

/**
 * diffAgainstPrior(record, prior) -> record (mutated copy returned)
 * Compares the freshly-built record against the previous cycle's record for the
 * same unit and fills the temporal fields:
 *   changedFields[]   — {field, from, to} for each tracked field that moved
 *   previousStatus    — prior.status when status changed (else carried through)
 *   statusChangedAt   — now when status changed, else carried from prior
 *   statusChangeReason— kept from the record (AI) or synthesized deterministically
 *   history[]         — prior.history + a new {from,to,at,reason} entry on a
 *                       status change, capped at _HISTORY_CAP (most recent last)
 * Pure. If prior is null (first time we see the unit) returns the record with
 * empty change-set and a fresh statusChangedAt.
 */
function diffAgainstPrior(record, prior) {
  if (!record) return record;
  const now = record.updatedAt || new Date().toISOString();
  if (!prior) {
    record.changedFields = [];
    record.previousStatus = null;
    record.statusChangedAt = now;      // first observation = the baseline moment
    record.history = [];
    return record;
  }
  const changed = [];
  for (const f of TRACKED_FIELDS) {
    const a = prior[f]; const b = record[f];
    if (JSON.stringify(a == null ? '' : a) !== JSON.stringify(b == null ? '' : b)) {
      changed.push({ field: f, from: a == null ? '' : a, to: b == null ? '' : b });
    }
  }
  record.changedFields = changed;

  const statusChanged = prior.status !== record.status;
  record.previousStatus = statusChanged ? prior.status : (prior.previousStatus || null);
  record.statusChangedAt = statusChanged ? now : (prior.statusChangedAt || now);

  // Reason: prefer an AI-supplied reason; else synthesize from the drivers — but
  // ONLY from a SUBSTANTIVE update. A bare ref ("as per reach ref: BO890273") or
  // process line ("reached out to vendor") is a useless reason, so we skip those
  // and fall back to a clean "moved X -> Y" statement rather than surface noise.
  if (statusChanged && !record.statusChangeReason) {
    const lmu = record.lastMeaningfulUpdate;
    const human = (f, t) => f.replace(/_/g, ' ') + ' \u2192 ' + t.replace(/_/g, ' ');
    if (lmu && lmu.text && _isSubstantive(lmu.text)) {
      record.statusChangeReason = ('Per ' + (lmu.source || 'latest') + ': ' + lmu.text).slice(0, 300);
    } else {
      record.statusChangeReason = 'Status moved ' + human(prior.status, record.status) + '.';
    }
  }
  if (!statusChanged) record.statusChangeReason = prior.statusChangeReason || record.statusChangeReason || '';

  // History: carry prior, append on a real status change.
  const hist = Array.isArray(prior.history) ? prior.history.slice() : [];
  if (statusChanged) {
    hist.push({ from: prior.status, to: record.status, at: now, reason: record.statusChangeReason });
    if (hist.length > _HISTORY_CAP) hist.splice(0, hist.length - _HISTORY_CAP);
  }
  record.history = hist;

  // Carrier-notify episode flag: carry the prior value forward ALWAYS, so once
  // we've messaged the carrier that a unit is ready we never message again for
  // the same episode — even while the raw status FLAPS (ready -> down -> ready
  // across adjacent cycles). It is NOT cleared on a single non-ready reading
  // (that would reintroduce the flapping double-send); the notifier's event-time
  // cooldown handles when a genuinely NEW ready episode (days later) may notify
  // again. Set by ready_pickup_notify after a successful send.
  record.carrierNotifiedAt = (record.carrierNotifiedAt || prior.carrierNotifiedAt || null);
  return record;
}

/**
 * mirrorFields(record) -> a small object of canonical fields to copy onto the
 * fleetData row so existing panels can read canonical state without a new UI.
 * Prefixed `canonical*` so they never collide with scraped fields.
 */
function mirrorFields(record) {
  const r = record || {};
  const dims = _normalizeDimensions(r.dimensions);
  return {
    canonicalStatus: r.status || 'unknown',
    // Lean per-axis VALUES mirrored onto the row so the grid/Slack can read any
    // single dimension without touching the store. The full {value,confidence,
    // source} objects stay in the canonicalState store (read it for provenance).
    canonicalAvailability: dims.availability.value,
    canonicalPhase: dims.phase.value,
    canonicalLocation: dims.location.value,
    canonicalRisk: dims.risk.value,
    canonicalSituation: r.situation || '',
    canonicalNextStep: r.nextStep || '',
    canonicalSource: r.source || '',
    canonicalConfidence: Number.isFinite(r.confidence) ? r.confidence : null,
    canonicalStale: !!r.stale,
    canonicalWaitingOn: r.waitingOn || '',
    canonicalFlags: Array.isArray(r.flags) ? r.flags.slice() : [],
    canonicalAiReconciled: !!r.aiReconciled,
    canonicalUpdatedAt: r.updatedAt || null,
    // Lean temporal summary (the big evidence/conflicts/history arrays stay in
    // the canonicalState store; read it directly when you need them).
    canonicalPreviousStatus: r.previousStatus || null,
    canonicalStatusChangedAt: r.statusChangedAt || null,
    canonicalStatusChangeReason: r.statusChangeReason || '',
    canonicalChangedFieldCount: Array.isArray(r.changedFields) ? r.changedFields.length : 0,
    canonicalConflictCount: Array.isArray(r.conflicts) ? r.conflicts.length : 0,
    // Next-action intent (lean, mirrored so the grid/Slack can read it off the row).
    canonicalNextActionType: r.nextActionType || 'none',
    canonicalAwaitingReply: r.awaitingReply || '',
    canonicalThreadOfRecord: r.threadOfRecord || '',
    canonicalQuestionOpen: !!(Array.isArray(r.flags) && r.flags.includes('question_open')),
    // Lean Uptake predictive signal mirrored onto the row (full topInsights
    // array stays in the canonicalState store; read it there when needed).
    canonicalRiskScore: (r.uptake && Number.isFinite(r.uptake.riskScore)) ? r.uptake.riskScore : null,
    canonicalRiskLabel: (r.uptake && r.uptake.riskLabel) || '',
    canonicalInsightCount: (r.uptake && Number(r.uptake.insightCount)) || 0,
    canonicalSubsystems: (r.uptake && Array.isArray(r.uptake.subsystems)) ? r.uptake.subsystems.slice() : [],
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
 * opts.prior     — optional object keyed by equipmentId -> the previous cycle's
 *                  canonical record (typically canonicalState.units). Used to
 *                  diff each unit for the temporal fields (changedFields,
 *                  previousStatus, statusChangedAt, history). Omit on first run.
 */
function buildAll(rows, opts) {
  opts = opts || {};
  const list = Array.isArray(rows) ? rows : [];
  const decisions = opts.decisions || {};
  const prior = opts.prior || {};
  const getDecision = (id) => {
    if (decisions instanceof Map) return decisions.get(id);
    return decisions[id];
  };
  const getPrior = (id) => {
    if (prior instanceof Map) return prior.get(id);
    return prior[id];
  };
  const units = {};
  let reconciled = 0, baseline = 0, changed = 0;
  const mirrored = list.map((row) => {
    const id = _s(row && row.equipmentId);
    if (!id) return row;
    const decision = getDecision(id);
    let record = decision ? reconcileCanonical(row, { decision }) : computeCanonical(row);
    if (!record) return row;
    // Temporal diff against the previous cycle's record for this unit.
    record = diffAgainstPrior(record, getPrior(id));
    if (record.changedFields && record.changedFields.length) changed++;
    units[id] = record;
    if (record.aiReconciled) reconciled++; else baseline++;
    return Object.assign({}, row, mirrorFields(record));
  });
  return {
    units,
    mirrored,
    counts: { total: Object.keys(units).length, reconciled, baseline, changed },
  };
}

/**
 * detectChangedUnits(rows, prior) -> Set<equipmentId>
 * The EVENT-TRIGGER core: which units changed in a way that warrants a fresh AI
 * reconcile this cycle. Compares the raw row's reality-bearing fields against
 * the prior canonical record (and its mirrored provenance) WITHOUT any AI — so
 * the sync pass can cheaply decide who to prioritize. A unit is "changed" when
 * its deterministic status moved, or a tracked raw signal (offsite freshness/
 * notes, relay conversation, vendor, lifecycleReason, parts/ETC text) differs
 * from what the prior record was built on. Units with NO prior record count as
 * changed (first observation). Pure.
 */
function detectChangedUnits(rows, prior) {
  const list = Array.isArray(rows) ? rows : [];
  const priorMap = prior instanceof Map ? prior : new Map(Object.entries(prior || {}));
  const changed = new Set();
  for (const row of list) {
    const id = _s(row && row.equipmentId);
    if (!id) continue;
    const prev = priorMap.get(id);
    if (!prev) { changed.add(id); continue; } // never seen -> reason it
    // 1. deterministic status moved vs the prior record's status.
    if (_deriveStatus(row) !== prev.status) { changed.add(id); continue; }
    // 2. offsite freshness / notes moved (compare the stored lastMeaningfulUpdate
    //    'at' + a hash of the current offsite text).
    const offAt = _s(row.asistScrapedAt);
    const prevAt = (prev.lastMeaningfulUpdate && prev.lastMeaningfulUpdate.at) || '';
    if (offAt && offAt !== prevAt) { changed.add(id); continue; }
    // 3. a tracked raw signal differs from the prior record's evidence snapshot.
    const prevEvidence = Array.isArray(prev.evidence) ? prev.evidence : [];
    const evidenceVal = (field) => { const e = prevEvidence.find((x) => x.field === field); return e ? e.value : ''; };
    const trackedRaw = [
      ['serviceState', _s(row.serviceState)],
      ['relayStatus', _s(row.relayStatus)],
      ['lifecycleReason', _s(row.lifecycleReason)],
    ];
    let moved = false;
    for (const [field, cur] of trackedRaw) {
      const was = evidenceVal(field);
      // Compare on the clipped form the evidence stored (so lengths match).
      if (_clipVal(cur) !== was) { moved = true; break; }
    }
    if (moved) { changed.add(id); continue; }
    // 4. vendor assignment changed (vendor isn't in evidence; use situation).
    const curVendor = _s(row.vendor);
    if (curVendor && prev.situation && prev.situation.indexOf(curVendor) === -1 && curVendor !== '--') {
      // vendor present now but not reflected in the prior situation line
      changed.add(id); continue;
    }
    // 5. relay conversation grew (new comment) — compare a cheap length proxy.
    const convoLen = _s(row.fullConversation).length;
    const prevConvoLen = Number(prev._convoLen || 0);
    if (convoLen && convoLen !== prevConvoLen) { changed.add(id); continue; }
  }
  return changed;
}

// ── Shared read accessors (the single way consumers read canonical state) ──────
// Every reasoning surface (Action Board, briefing, Split View, Slack, grid)
// should read a unit's canonical record through getCanonical() so they all see
// ONE reconciled truth with ONE consistent fallback chain. Readers must never
// need to know whether the record came from the store, the mirrored row fields,
// or a fresh deterministic compute.

// Reconstruct a canonical record from the canonical* fields mirrored onto a
// fleetData row (written by the sync pass). Returns null if the row carries no
// mirror (older row that predates the first canonical pass).
function fromRow(row) {
  const r = row || {};
  if (r.canonicalStatus == null && r.canonicalUpdatedAt == null) return null;
  const _conf = Number.isFinite(r.canonicalConfidence) ? r.canonicalConfidence : 0.5;
  const _src = r.canonicalSource || '';
  // Reconstruct the independent axes from the lean mirrored values. Per-axis
  // confidence/source aren't mirrored (they live in the store record), so we
  // fill the record's overall confidence + trusted source as a reasonable read;
  // callers needing exact per-axis provenance should read the store (step 2 of
  // getCanonical). Values are normalized back into vocabulary.
  const dimensions = _normalizeDimensions({
    availability: { value: r.canonicalAvailability, confidence: _conf, source: _src },
    phase:        { value: r.canonicalPhase,        confidence: _conf, source: _src },
    location:     { value: r.canonicalLocation,     confidence: _conf, source: (r.canonicalLocation === 'offsite' ? 'offsite' : _src) },
    waitingOn:    { value: r.canonicalWaitingOn || 'none', confidence: _conf, source: _src },
    risk:         { value: r.canonicalRisk,         confidence: _conf, source: (r.canonicalRisk && r.canonicalRisk !== 'none' ? 'uptake' : _src) },
  });
  return {
    equipmentId: _s(r.equipmentId),
    status: r.canonicalStatus || 'unknown',
    dimensions,
    situation: r.canonicalSituation || '',
    nextStep: r.canonicalNextStep || '',
    source: r.canonicalSource || '',
    confidence: _conf,
    stale: !!r.canonicalStale,
    waitingOn: r.canonicalWaitingOn || '',
    flags: Array.isArray(r.canonicalFlags) ? r.canonicalFlags.slice() : [],
    aiReconciled: !!r.canonicalAiReconciled,
    nextActionType: r.canonicalNextActionType || 'none',
    awaitingReply: r.canonicalAwaitingReply || '',
    threadOfRecord: r.canonicalThreadOfRecord || '',
    updatedAt: r.canonicalUpdatedAt || null,
    // Reconstruct the lean Uptake summary from the mirrored fields. The full
    // topInsights array only lives in the canonicalState store; read it there
    // when the detail is needed (getCanonical step 2).
    uptake: (r.canonicalRiskScore != null || r.canonicalInsightCount)
      ? {
          riskScore:    Number.isFinite(r.canonicalRiskScore) ? r.canonicalRiskScore : null,
          riskLabel:    r.canonicalRiskLabel || '',
          insightCount: Number(r.canonicalInsightCount) || 0,
          subsystems:   Array.isArray(r.canonicalSubsystems) ? r.canonicalSubsystems.slice() : [],
          topInsights:  [],
        }
      : null,
  };
}

// getCanonical(rowOrId, opts) -> record | null
// Fallback chain, cheapest-first:
//   1. the canonical* fields already mirrored on the row (no I/O) — if a row is given,
//   2. the persisted canonicalState store (keyed by equipmentId),
//   3. a fresh deterministic computeCanonical(row) when a row is available,
//   4. null.
// opts.store lets tests inject a stub; defaults to require('../store').
function getCanonical(rowOrId, opts) {
  opts = opts || {};
  const row = (rowOrId && typeof rowOrId === 'object') ? rowOrId : null;
  const id = row ? _s(row.equipmentId) : _s(rowOrId);
  if (!id) return null;
  // 1. mirrored row fields
  if (row) {
    const fromMirror = fromRow(row);
    if (fromMirror) return fromMirror;
  }
  // 2. persisted store
  try {
    const st = opts.store || require('../store');
    const cs = st.load('canonicalState', {}) || {};
    const rec = cs.units && cs.units[id];
    if (rec) return rec;
  } catch (_) {}
  // 3. fresh deterministic compute from the row
  if (row) {
    const rec = computeCanonical(row);
    if (rec) return rec;
  }
  return null;
}

// Humanize a canonical status enum for display ("awaiting_parts" -> "Awaiting parts").
function statusLabel(status) {
  const s = _s(status) || 'unknown';
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// Compact tokens for an AI signal/prompt line, e.g.
//   "canon=awaiting_parts src=offsite conf=0.8 STALE wait=vendor next=\"chase dealer\""
// Only emits what's present; returns '' when there is no canonical record.
function signalTokens(rowOrId, opts) {
  const rec = getCanonical(rowOrId, opts);
  if (!rec) return '';
  const t = ['canon=' + (rec.status || 'unknown')];
  // Independent axes (only emit the informative ones — skip none/unknown noise).
  const d = rec.dimensions;
  if (d) {
    if (d.availability && !['unknown'].includes(d.availability.value)) t.push('avail=' + d.availability.value);
    if (d.phase && !['none', 'unknown'].includes(d.phase.value)) t.push('phase=' + d.phase.value);
    if (d.location && !['unknown'].includes(d.location.value)) t.push('loc=' + d.location.value);
    if (d.risk && d.risk.value !== 'none') t.push('risk=' + d.risk.value);
  }
  if (rec.source) t.push('src=' + rec.source);
  if (Number.isFinite(rec.confidence)) t.push('conf=' + rec.confidence.toFixed(2));
  if (rec.stale) t.push('STALE');
  if (rec.waitingOn) t.push('wait=' + rec.waitingOn);
  if (rec.nextActionType && rec.nextActionType !== 'none') t.push('action=' + rec.nextActionType);
  if (rec.awaitingReply) t.push('OPEN-Q="' + rec.awaitingReply.slice(0, 80) + '"');
  if (rec.aiReconciled) t.push('ai-reconciled');
  if (rec.nextStep) t.push('next="' + rec.nextStep.slice(0, 80) + '"');
  return t.join(' ');
}

module.exports = {
  STATUSES,
  TRACKED_FIELDS,
  DIMENSIONS,
  DIMENSION_VALUES,
  isValidStatus,
  isValidDimensionValue,
  isDown,
  computeCanonical,
  reconcileCanonical,
  mirrorFields,
  buildAll,
  diffAgainstPrior,
  detectChangedUnits,
  fromRow,
  getCanonical,
  statusLabel,
  signalTokens,
  // exported for tests / reuse
  _deriveStatus,
  _deriveSource,
  _deriveFlags,
  _isReadyForPickup,
  _isTowOut,
  READY_RE,
  TOW_OUT_RE,
  _deriveAvailability,
  _derivePhase,
  _deriveLocation,
  _deriveRisk,
  _buildDimensions,
  _normalizeDimensions,
  _daysSinceOffsite,
  _statusFromDecision,
  _waitingOnFromDecision,
  _buildEvidence,
  _lastMeaningfulUpdate,
  _detectObviousConflicts,
  _normalizeConflicts,
  _isRefNoise,
  _isSubstantive,
  _lastSubstantiveLine,
};
