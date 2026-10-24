'use strict';
/**
 * scrapers/email_intel.js — Digital FAS email intelligence vocabulary + the
 * DETERMINISTIC reasoning core that classifies an email as operational evidence.
 *
 * This is an ADDITIVE layer the triage engine (email_triage.js) delegates to. It
 * does NOT read the inbox, call the AI, send, delete, or persist — it only
 * reasons over already-read email records + fleetData + canonical state, and
 * returns structured classifications. The AI tier in email_triage sharpens these
 * values; this module is the grounded fallback + the validation/normalization
 * boundary so a malformed AI verdict can never produce a nonsensical decision.
 *
 * Core invariant (spec §31): email is an operational evidence source, NOT
 * automatically truth and NOT automatically an action. Scope first, then
 * category/intent, then compare facts to canonical truth, then owner/action.
 */

// ── Vocabularies (spec §2/§3/§4/§5/§9/§10/§13) ───────────────────────────────
const SCOPES = ['mine', 'shared_team', 'other_fas', 'other_region', 'informational', 'unknown'];

const CATEGORIES = [
  'action_request', 'question', 'fleet_status_update', 'repair_blocker',
  'ready_for_pickup', 'estimate_or_approval', 'tow_or_move_request',
  'vendor_escalation', 'maintenance_pm', 'compliance', 'site_operations',
  'data_report', 'audit', 'policy_or_process', 'meeting', 'informational',
  'automated_notification', 'noise', 'unknown',
];

const INTENTS = [
  'request_action', 'request_information', 'request_approval', 'provide_update',
  'provide_data', 'confirm_completion', 'report_problem', 'escalate',
  'assign_work', 'follow_up', 'answer_question', 'acknowledgement', 'fyi', 'none',
];

const PRIORITIES = ['critical', 'high', 'normal', 'low', 'hidden'];

const INFORMATION_TYPES = ['new', 'status_change', 'duplicate', 'confirmation', 'contradiction', 'stale', 'insufficient'];

const ACTION_OWNERS = ['me', 'vendor', 'site', 'operator', 'manager', 'internal_team', 'other_fas', 'other_team', 'system', 'unknown'];

const ACTION_TYPES = [
  'reply', 'review_estimate', 'approve_or_decline', 'provide_information',
  'request_vendor_update', 'schedule_tow', 'arrange_pickup', 'move_unit',
  'create_work_request', 'update_repair_status', 'notify_operator',
  'review_attachment', 'investigate', 'escalate', 'assign_to_other_team', 'no_action',
];

const DATA_PAYLOAD_TYPES = ['pm_report', 'asset_list', 'repair_report', 'audit', 'invoice', 'unknown'];

const _in = (arr, v, dflt) => (arr.includes(String(v || '')) ? v : dflt);
function isScope(v) { return SCOPES.includes(String(v || '')); }
function isCategory(v) { return CATEGORIES.includes(String(v || '')); }
function isIntent(v) { return INTENTS.includes(String(v || '')); }
function isPriority(v) { return PRIORITIES.includes(String(v || '')); }
function isInformationType(v) { return INFORMATION_TYPES.includes(String(v || '')); }
function isActionOwner(v) { return ACTION_OWNERS.includes(String(v || '')); }
function isActionType(v) { return ACTION_TYPES.includes(String(v || '')); }

const _lc = (s) => String(s == null ? '' : s).toLowerCase();
const _has = (hay, re) => re.test(_lc(hay));

// ── Unit extraction + fleet validation (spec §2/§5) ──────────────────────────
// Extract candidate equipment IDs from text, then split into IN-FLEET (valid,
// strong scope evidence) vs OUT-OF-FLEET (mentioned but NOT ours — must NEVER
// become an action or hallucinated association).
function extractUnits(text, fleetRows) {
  const rows = Array.isArray(fleetRows) ? fleetRows : [];
  const byId = new Map();
  for (const r of rows) {
    const id = String(r && r.equipmentId || '').trim();
    if (id) byId.set(id.toLowerCase(), r);
  }
  const t = String(text || '');
  // Fleet units are typically 4-7 digit numbers; capture standalone numeric
  // tokens (and an optional single letter prefix like B62049).
  const cands = new Set();
  const re = /\b([A-Za-z]?\d{4,7})\b/g;
  let m;
  while ((m = re.exec(t)) !== null) cands.add(m[1]);
  const inFleet = [];
  const outOfFleet = [];
  for (const c of cands) {
    const row = byId.get(c.toLowerCase());
    if (row) inFleet.push({ unit: String(row.equipmentId).trim(), operator: String(row.operator || '').trim(), domicile: String(row.domicileSite || '').trim(), row });
    else outOfFleet.push(c);
  }
  return { inFleet, outOfFleet };
}

// ── Scope (spec §2) ──────────────────────────────────────────────────────────
// Determine operational scope deterministically from the available evidence.
// Rules (from the spec):
//   - a valid in-fleet unit is STRONG evidence for 'mine'
//   - explicit assignment language ("your unit", "Zila", "@z") overrides broad distro
//   - CC-only on a broad email is WEAK evidence
//   - a unit outside the fleet should NOT become 'mine'
//   - unknown stays unknown — never invent ownership
// opts: { myNames:[], mySites:[], toMe:boolean, ccOnly:boolean }
function deriveScope(email, fleetRows, opts) {
  opts = opts || {};
  const subject = String(email && email.subject || '');
  const body = String(email && email.bodyText || email && email.summary || '');
  const text = subject + ' ' + body;
  const { inFleet, outOfFleet } = extractUnits(text, fleetRows);

  // Explicit assignment to me (name/handle or "your unit/site") is the strongest
  // signal and overrides broad distribution.
  const myNames = (opts.myNames || ['zila', 'santiago', 'z santiago']).map(_lc).filter(Boolean);
  const assignedToMe = myNames.some((n) => n && _lc(text).includes(n))
    || _has(text, /\byour (unit|truck|asset|site|yard|fleet)\b/)
    || _has(text, /\bassigned to you\b/)
    || !!opts.explicitlyAssigned;

  // In-fleet unit present -> mine (strong), unless the email is clearly another
  // region's/another FAS's (explicit) — handled below.
  const hasMine = inFleet.length > 0;

  // Other-region / other-FAS explicit signals.
  const otherRegion = _has(text, /\bother region\b|\bwest (coast|region)\b|\beast (coast|region)\b/) && !hasMine;
  const otherFas = _has(text, /\bassigned to (another|the other) fas\b|\bnot your (unit|fleet)\b/);

  if (otherFas) return { scope: 'other_fas', inFleet, outOfFleet, assignedToMe };
  if (assignedToMe && hasMine) return { scope: 'mine', inFleet, outOfFleet, assignedToMe };
  if (hasMine) return { scope: 'mine', inFleet, outOfFleet, assignedToMe };
  if (assignedToMe) return { scope: 'mine', inFleet, outOfFleet, assignedToMe };
  // A unit mentioned that is NOT in the fleet, and no assignment to me.
  if (outOfFleet.length && !hasMine) {
    if (otherRegion) return { scope: 'other_region', inFleet, outOfFleet, assignedToMe };
    return { scope: 'other_fas', inFleet, outOfFleet, assignedToMe };
  }
  // CC-only broad distribution with no unit + no assignment -> informational.
  if (opts.ccOnly) return { scope: 'informational', inFleet, outOfFleet, assignedToMe };
  return { scope: 'unknown', inFleet, outOfFleet, assignedToMe };
}

// ── Category (deterministic signal classifier; spec §3) ──────────────────────
// Subject + body + attachment names. Order: most-specific/operational first.
function classifyCategory(email) {
  const subject = _lc(email && email.subject);
  const body = _lc(email && email.bodyText || email && email.summary);
  const atts = (email && Array.isArray(email.attachments) ? email.attachments : []).map((a) => _lc(a && a.name)).join(' ');
  const t = subject + ' | ' + body + ' | ' + atts;
  const from = _lc(email && email.from);

  // Automated / noise first (cheap to rule out).
  if (/no-?reply|do-?not-?reply|mailer-daemon|notifications?@|newsletter|unsubscribe/.test(from + ' ' + t)) {
    if (/newsletter|unsubscribe|marketing|promo/.test(t)) return 'noise';
    return 'automated_notification';
  }
  if (_has(t, /\bmeeting\b|calendar invite|teams meeting|outlook invite|accepted:|declined:|when:.*where:/)) return 'meeting';
  // Data/report (attachment-driven).
  if (atts && /\.(xlsx|xls|csv|pdf)\b/.test(atts)) {
    if (_has(t, /\bpm\b|preventive|preventative|overdue/)) return 'data_report';
    if (_has(t, /audit/)) return 'audit';
    if (_has(t, /invoice|billing/)) return 'data_report';
    if (_has(t, /asset list|fleet (list|report)|repair (report|list)|export/)) return 'data_report';
  }
  if (_has(t, /\baudit\b/)) return 'audit';
  if (_has(t, /ready for pickup|ready to be picked up|repairs? (are )?complete|passed road test|available for (pickup|release)/)
      && !_has(t, /ready to be towed out|tow(ed)? out to/)) return 'ready_for_pickup';
  if (_has(t, /tow|move the unit|relocate|transport the (unit|truck)|needs to be moved/)) return 'tow_or_move_request';
  if (_has(t, /estimate|approve|approval|authorize|quote|\$\d/)) return 'estimate_or_approval';
  if (_has(t, /escalat|been waiting|no response|urgent|unacceptable|days without/)) return 'vendor_escalation';
  if (_has(t, /waiting on parts|backorder|blocked|cannot proceed|repair blocker|stuck/)) return 'repair_blocker';
  if (_has(t, /\bpm\b|preventive|preventative maintenance|service due|inspection due/)) return 'maintenance_pm';
  if (_has(t, /compliance|dot|csa|violation|out of service|oos\b/)) return 'compliance';
  if (_has(t, /yard|site|dock|gate|facility|building/)) return 'site_operations';
  if (_has(t, /policy|process|procedure|sop|guideline/)) return 'policy_or_process';
  // Questions vs updates vs requests.
  if (/\?/.test(t) || _has(t, /can you|could you|please (confirm|advise|let me know)|what('| i)s the|when (will|can)/)) {
    if (_has(t, /please (send|do|arrange|schedule|order|create|move|tow)/)) return 'action_request';
    return 'question';
  }
  if (_has(t, /please (send|do|arrange|schedule|order|create|move|tow|update)/)) return 'action_request';
  if (_has(t, /parts (arrived|received|ordered)|repair (started|underway|in progress)|diagnos|status update|update on/)) return 'fleet_status_update';
  if (_has(t, /\bfyi\b|for your (information|awareness)|just so you know|heads up/)) return 'informational';
  return 'unknown';
}

// ── Intent (spec §4) ──────────────────────────────────────────────────────────
function classifyIntent(email, category) {
  const subject = _lc(email && email.subject);
  const body = _lc(email && email.bodyText || email && email.summary);
  const t = subject + ' | ' + body;
  if (_has(t, /approve|approval|authorize|sign off/)) return 'request_approval';
  if (_has(t, /\bfyi\b|for your (information|awareness)|just so you know/)) return 'fyi';
  if (_has(t, /thank you|thanks|appreciate|acknowledged|received, thanks/)) return 'acknowledgement';
  if (_has(t, /escalat|been waiting|no response|unacceptable/)) return 'escalate';
  if (_has(t, /please (send|do|arrange|schedule|order|create|move|tow)|can you (please )?(send|do|arrange|schedule|order|create|move|tow)/)) return 'request_action';
  if (/\?/.test(t) || _has(t, /what('| i)s|when (will|can)|how (do|much)|which|can you (confirm|tell|advise)/)) return 'request_information';
  if (category === 'data_report') return 'provide_data';
  if (_has(t, /complete|completed|done|finished|ready for pickup/)) return 'confirm_completion';
  if (_has(t, /problem|issue|broke|failure|not working|concern/)) return 'report_problem';
  if (_has(t, /assign|taking over|please handle|your action/)) return 'assign_work';
  if (_has(t, /following up|follow-?up|checking in|circling back/)) return 'follow_up';
  if (_has(t, /parts (arrived|received|ordered)|repair (started|underway)|update|status/)) return 'provide_update';
  return 'none';
}

// ── Information-type: compare an email fact to canonical truth (spec §5) ─────
// canon = the unit's canonical record (may be undefined). Returns one of
// INFORMATION_TYPES. Deterministic + conservative: when we can't tell, 'insufficient'.
// emailFact: { phase?, text, ready?, observedAtMs? }  canon: canonical record.
function deriveInformationType(emailFact, canon) {
  const ef = emailFact || {};
  const text = _lc(ef.text);
  if (!text) return 'insufficient';
  if (!canon) return 'new'; // no prior canonical state — the email is new info

  const rp = _lc(canon.repairPhase);
  const efPhase = _lc(ef.phase);

  // Freshness: if the email is OLDER than the canonical last-meaningful update,
  // and the canonical phase is already at/ahead, it's stale (do not regress).
  const canonAtMs = Date.parse((canon.lastMeaningfulUpdate && canon.lastMeaningfulUpdate.at) || canon.updatedAt || '') || 0;
  if (ef.observedAtMs && canonAtMs && ef.observedAtMs < canonAtMs) {
    // Only 'stale' when the email would REGRESS or merely restate an older phase.
    return 'stale';
  }

  // Phase ordering for regress/advance detection (coarse).
  const ORDER = ['awaiting_vendor', 'appointment_scheduled', 'vehicle_arrived', 'diagnosis',
    'diagnosis_complete', 'awaiting_estimate', 'awaiting_approval', 'awaiting_parts',
    'parts_backordered', 'parts_received', 'repair_in_progress', 'road_test',
    'quality_check', 'ready_for_pickup', 'pickup_scheduled', 'repair_complete', 'closed'];
  const ci = ORDER.indexOf(rp);
  const ei = ORDER.indexOf(efPhase);

  if (efPhase && ci >= 0 && ei >= 0) {
    if (ei < ci) return 'stale';            // email describes an EARLIER phase -> don't regress
    if (ei > ci) return 'status_change';    // email advances the phase
    // same phase -> duplicate or confirmation
    return 'duplicate';
  }

  // No phase signal — fall back to text comparison against the canonical
  // situation / last meaningful text.
  const canonText = _lc((canon.situation || '') + ' ' + ((canon.lastMeaningfulUpdate && canon.lastMeaningfulUpdate.text) || ''));
  if (canonText && _overlaps(text, canonText)) return 'duplicate';
  // A ready/complete claim when canon is NOT complete is a status_change.
  if (ef.ready && rp && !['ready_for_pickup', 'repair_complete', 'closed', 'pickup_scheduled'].includes(rp)) return 'status_change';
  return 'new';
}

// Cheap token-overlap test: do two short status strings say substantially the
// same thing? (>=60% of the email fact's significant words appear in canon).
function _overlaps(a, b) {
  const stop = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'is', 'are', 'per', 'with', 'eta']);
  const words = (s) => _lc(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w));
  const aw = words(a);
  if (!aw.length) return false;
  const bset = new Set(words(b));
  const hit = aw.filter((w) => bset.has(w)).length;
  return hit / aw.length >= 0.6;
}

// ── Priority (spec §13) ──────────────────────────────────────────────────────
function derivePriority(email, scope, category) {
  const t = _lc(email && email.subject) + ' | ' + _lc(email && email.bodyText || email && email.summary);
  if (scope === 'informational' || scope === 'other_region') {
    // Out-of-scope noise is hidden unless it is a safety/critical signal.
    if (_has(t, /safety|accident|injury|out of service|dot (hold|violation)/)) return 'high';
    return 'hidden';
  }
  if (_has(t, /safety|accident|injury|blocking (operations|the dock)|urgent|same.?day|today|immediately|asap|emergency|out of service/)) return 'critical';
  if (category === 'estimate_or_approval' || category === 'ready_for_pickup' || category === 'vendor_escalation') return 'high';
  if (category === 'question' || category === 'action_request' || category === 'repair_blocker' || category === 'tow_or_move_request') return 'high';
  if (category === 'fleet_status_update' || category === 'maintenance_pm' || category === 'data_report' || category === 'compliance') return 'normal';
  if (category === 'informational' || category === 'meeting' || category === 'policy_or_process') return 'low';
  if (category === 'noise' || category === 'automated_notification') return 'hidden';
  return 'normal';
}

// ── Relevance score (spec §14) ───────────────────────────────────────────────
// A 0..1 operational-relevance score. Factors from the spec; never used ALONE
// (the explicit scope/category classification is preserved).
function scoreRelevance(email, scopeInfo, category) {
  let s = 0.3; // neutral baseline
  const info = scopeInfo || {};
  if (info.scope === 'mine') s += 0.4;
  else if (info.scope === 'shared_team') s += 0.15;
  else if (info.scope === 'other_region' || info.scope === 'other_fas') s -= 0.3;
  else if (info.scope === 'informational') s -= 0.15;
  if (info.inFleet && info.inFleet.length) s += 0.2;
  if (info.assignedToMe) s += 0.2;
  if (info.outOfFleet && info.outOfFleet.length && (!info.inFleet || !info.inFleet.length)) s -= 0.2;
  // Operational categories are more relevant than informational/noise.
  if (['action_request', 'question', 'estimate_or_approval', 'ready_for_pickup', 'repair_blocker', 'tow_or_move_request', 'vendor_escalation'].includes(category)) s += 0.15;
  if (['noise', 'automated_notification'].includes(category)) s -= 0.3;
  if (['informational', 'meeting', 'policy_or_process'].includes(category)) s -= 0.1;
  return Math.max(0, Math.min(1, Number(s.toFixed(2))));
}

// ── Action owner + action type (spec §9/§10) ─────────────────────────────────
// Derived from category/intent + canonical waitingOn. The spec's key rule:
// "estimate submitted, awaiting approval" -> owner me/internal_team,
// action review_estimate; NEVER a vendor chase. "We asked, no reply" -> vendor.
function deriveActionOwner(category, intent, canon) {
  const wait = _lc(canon && canon.waitingOnFine);
  if (category === 'estimate_or_approval' || intent === 'request_approval') return 'internal_team';
  if (wait === 'approval' || wait === 'internal' || wait === 'fleet') return 'internal_team';
  if (wait === 'vendor') return 'vendor';
  if (wait === 'parts') return 'vendor';
  if (wait === 'pickup' || wait === 'transportation') return 'operator';
  if (category === 'question' || category === 'action_request') return 'me';
  if (category === 'vendor_escalation' || category === 'repair_blocker') return 'internal_team';
  if (category === 'tow_or_move_request') return 'me';
  if (category === 'ready_for_pickup') return 'operator';
  if (category === 'data_report' || category === 'audit') return 'me';
  if (category === 'informational' || category === 'noise' || category === 'automated_notification' || category === 'meeting') return 'system';
  return 'unknown';
}

function deriveActionType(category, intent, canon) {
  switch (category) {
    case 'estimate_or_approval': return 'review_estimate';
    case 'ready_for_pickup':     return 'arrange_pickup';
    case 'tow_or_move_request':  return 'schedule_tow';
    case 'vendor_escalation':    return 'escalate';
    case 'data_report':
    case 'audit':                return 'review_attachment';
    case 'meeting':
    case 'informational':
    case 'policy_or_process':
    case 'noise':
    case 'automated_notification': return 'no_action';
    default: break;
  }
  if (intent === 'request_approval') return 'approve_or_decline';
  if (intent === 'request_information' || category === 'question') return 'provide_information';
  if (intent === 'request_action' || category === 'action_request') return 'reply';
  if (category === 'repair_blocker') {
    const wait = _lc(canon && canon.waitingOnFine);
    return wait === 'vendor' ? 'request_vendor_update' : 'update_repair_status';
  }
  if (category === 'fleet_status_update') return 'update_repair_status';
  return 'no_action';
}

// ── Data/report detection (spec §15/§16) ─────────────────────────────────────
function detectDataPayload(email, fleetRows) {
  const atts = (email && Array.isArray(email.attachments) ? email.attachments : []);
  const names = atts.map((a) => String(a && a.name || '')).filter(Boolean);
  const parseable = names.filter((n) => /\.(xlsx|xls|csv|pdf)$/i.test(n));
  const subject = _lc(email && email.subject);
  const body = _lc(email && email.bodyText || email && email.summary);
  const t = subject + ' | ' + body + ' | ' + _lc(names.join(' '));
  const detected = parseable.length > 0 || _has(t, /\bpm (overdue|list|report)\b|asset (list|report)|repair (report|list|export)|audit (list|report)|invoice|spreadsheet|attached .*(list|report)/);
  if (!detected) return { detected: false };
  let type = 'unknown';
  if (_has(t, /\bpm\b|preventive|preventative|overdue/)) type = 'pm_report';
  else if (_has(t, /asset list|fleet (list|report)/)) type = 'asset_list';
  else if (_has(t, /repair (report|list|export)/)) type = 'repair_report';
  else if (_has(t, /audit/)) type = 'audit';
  else if (_has(t, /invoice|billing/)) type = 'invoice';
  const { inFleet } = extractUnits(subject + ' ' + body, fleetRows);
  return {
    detected: true,
    type,
    attachmentNames: names,
    referencedUnits: inFleet.map((u) => u.unit),
    requiresAttachmentParse: parseable.length > 0,
    summary: '',
  };
}

// ── §17 safe-auto-apply gate ─────────────────────────────────────────────────
// Only auto-apply a unit timeline update when ALL conditions hold. Returns
// { apply:boolean, reason:string }. Everything else -> stage / evidence only.
function shouldAutoApply(decision, opts) {
  opts = opts || {};
  const minConf = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.75;
  const d = decision || {};
  if (d.scope !== 'mine') return { apply: false, reason: 'not-in-scope' };
  if (!['new', 'status_change'].includes(d.informationType)) return { apply: false, reason: 'not-new-info:' + d.informationType };
  if (d.informationType === 'stale') return { apply: false, reason: 'stale' };
  if (d.hasConflict) return { apply: false, reason: 'conflicts-with-canonical' };
  if (Number(d.confidence) < minConf) return { apply: false, reason: 'low-confidence' };
  if (d.decisionRequired) return { apply: false, reason: 'human-decision-required' };
  // Factual update only — not a question/request/opinion.
  if (['question', 'action_request', 'estimate_or_approval'].includes(d.category)) return { apply: false, reason: 'not-factual' };
  if (['request_action', 'request_information', 'request_approval'].includes(d.intent)) return { apply: false, reason: 'not-factual-intent' };
  return { apply: true, reason: 'ok' };
}

module.exports = {
  SCOPES, CATEGORIES, INTENTS, PRIORITIES, INFORMATION_TYPES, ACTION_OWNERS, ACTION_TYPES, DATA_PAYLOAD_TYPES,
  isScope, isCategory, isIntent, isPriority, isInformationType, isActionOwner, isActionType,
  extractUnits,
  deriveScope,
  classifyCategory,
  classifyIntent,
  deriveInformationType,
  derivePriority,
  scoreRelevance,
  deriveActionOwner,
  deriveActionType,
  detectDataPayload,
  shouldAutoApply,
};
