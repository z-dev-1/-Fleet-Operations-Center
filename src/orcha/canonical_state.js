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

// ── Evidence (the facts the conclusion rests on, by source) ────────────────────
// Deterministic: restates fields already on the row, each tagged with the source
// that produced it + when it was observed (if known). usedInConclusion marks the
// facts that drove the chosen status/source. Never fabricates — only lists what
// is present. Capped so the record stays small.
const _EVIDENCE_CAP = 6;
function _clipVal(v, n) { return _s(v).slice(0, n || 160); }

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
  // Order: used-in-conclusion first, then by richness; cap.
  ev.sort((a, b) => (b.usedInConclusion ? 1 : 0) - (a.usedInConclusion ? 1 : 0));
  return ev.slice(0, _EVIDENCE_CAP);
}

// The freshest SUBSTANTIVE update we can point to (not status noise). Prefers the
// offsite thread (dated), then the latest timeline line, then issue summary.
function _lastMeaningfulUpdate(row) {
  const r = row || {};
  const offsite = _s(r.asistNotes);
  if (offsite) {
    const line = offsite.split('\n').filter(Boolean).pop() || offsite;
    return { source: 'offsite', text: _clipVal(line, 300), at: _s(r.asistScrapedAt) };
  }
  const tl = _s(r.repairTimeline);
  if (tl) {
    const last = tl.split('\n').filter(Boolean).pop();
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
    // Temporal fields — filled by diffAgainstPrior() in buildAll against the
    // previous cycle's record. Defaults here so a standalone compute is complete.
    changedFields: [],
    previousStatus: null,
    statusChangedAt: null,
    statusChangeReason: '',
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

  // Reason: prefer an AI-supplied reason; else synthesize from the drivers.
  if (statusChanged && !record.statusChangeReason) {
    const lmu = record.lastMeaningfulUpdate;
    record.statusChangeReason = lmu && lmu.text
      ? ('Per ' + (lmu.source || 'latest') + ': ' + lmu.text).slice(0, 300)
      : ('Status moved ' + prior.status + ' -> ' + record.status + '.');
  }
  if (!statusChanged) record.statusChangeReason = prior.statusChangeReason || record.statusChangeReason || '';

  // History: carry prior, append on a real status change.
  const hist = Array.isArray(prior.history) ? prior.history.slice() : [];
  if (statusChanged) {
    hist.push({ from: prior.status, to: record.status, at: now, reason: record.statusChangeReason });
    if (hist.length > _HISTORY_CAP) hist.splice(0, hist.length - _HISTORY_CAP);
  }
  record.history = hist;
  return record;
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
  return {
    equipmentId: _s(r.equipmentId),
    status: r.canonicalStatus || 'unknown',
    situation: r.canonicalSituation || '',
    nextStep: r.canonicalNextStep || '',
    source: r.canonicalSource || '',
    confidence: Number.isFinite(r.canonicalConfidence) ? r.canonicalConfidence : 0.5,
    stale: !!r.canonicalStale,
    waitingOn: r.canonicalWaitingOn || '',
    flags: Array.isArray(r.canonicalFlags) ? r.canonicalFlags.slice() : [],
    aiReconciled: !!r.canonicalAiReconciled,
    nextActionType: r.canonicalNextActionType || 'none',
    awaitingReply: r.canonicalAwaitingReply || '',
    threadOfRecord: r.canonicalThreadOfRecord || '',
    updatedAt: r.canonicalUpdatedAt || null,
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
  isValidStatus,
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
  _daysSinceOffsite,
  _statusFromDecision,
  _waitingOnFromDecision,
  _buildEvidence,
  _lastMeaningfulUpdate,
  _detectObviousConflicts,
  _normalizeConflicts,
};
