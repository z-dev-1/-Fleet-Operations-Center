'use strict';
/**
 * autopilot/classify.js — trust classification of evidence values (§B7.3). Pure.
 *
 *   trustOf(source, field, value) -> 'structured' | 'untrusted_text'
 *   structuredValue(value, field) -> true when the value has a structured shape (rule 1)
 *
 * Rules, in order:
 *   2. Free-text sources and fields are untrusted regardless of shape.
 *   3. Dealer / vendor names are structured only after sanitize + a strict pattern.
 *   1. Structured: a known enum member for the field, an ISO date/timestamp, a
 *      finite number, a boolean, or a short id.
 *   4. Anything else is untrusted.
 */

const untrusted = require('../email-intel/untrusted');

const LIFECYCLE_STATES = Object.freeze(['active', 'unavailable', 'ordered', 'decommissioned', 'inactive', 'retired', 'sold', 'pending', 'available']);
const CANONICAL_STATUSES = Object.freeze([
  'available', 'down', 'in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor',
  'ready_for_pickup', 'in_transit', 'decommissioned', 'unknown',
]);
// 'none' is the structured form of a Decisiv '' stage answer (plan R2).
const STAGES = Object.freeze(['arrival', 'diagnosis', 'approval', 'repair', 'ready', 'none']);
const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical', 'info', 'warning']);
const PARTS_STATUSES = Object.freeze(['ordered', 'backorder', 'received', 'none', 'pending', 'shipped']);

const FIELD_ENUMS = Object.freeze({
  lifecycleState: LIFECYCLE_STATES,
  status: CANONICAL_STATUSES,           // canonical status (source 'canonical')
  canonicalStatus: CANONICAL_STATUSES,
  offsiteStage: STAGES,
  stage: STAGES,
  repairStatus: STAGES,
  severity: SEVERITIES,
  partsStatus: PARTS_STATUSES,
});

const UNTRUSTED_SOURCES = new Set(['email', 'slack', 'fas_case']);
const UNTRUSTED_FIELDS = new Set([
  'delayReason', 'escalationLevel', 'escalation', 'escalationAction', 'summary', 'notes',
  '_factEtc.snippet', 'snippet', 'etcReason', 'lifecycleReason', 'issueSummary',
  'fullConversation', 'asistNotes', 'comment', 'comments', 'thread', 'activity', 'note', 'quote',
]);
// Source-specific free text (rule 2).
const UNTRUSTED_SOURCE_FIELDS = Object.freeze({
  decisiv: new Set(['status', 'activity', 'note', 'notes']),
  dtna: new Set(['caseStatus', 'thread', 'comment']),
  aperia_cache: new Set(['state', 'positionName']),
  long_dwell: new Set(['delayReason', 'escalationLevel', 'escalation', 'summary', 'notes']),
});
const NAME_FIELDS = new Set(['vendor', 'dealerName']);

const ID_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const NAME_RE = /^[\w .,&'()-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function _isIso(s) { return ISO_RE.test(s) && Number.isFinite(Date.parse(s)); }

/** Rule 1 shapes. */
function structuredValue(value, field) {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  const en = field ? FIELD_ENUMS[field] : null;
  if (en && en.includes(s.toLowerCase())) return true;
  if (_isIso(s)) return true;
  return ID_RE.test(s);
}

function _structuredName(value) {
  if (typeof value !== 'string') return false;
  const s = untrusted.sanitize(value, '');
  return s === value && NAME_RE.test(s.trim());
}

/**
 * trustOf(source, field, value, flags?) — V2 (§7.5) adds the derived trust values:
 *   timeline          -> derived_ai (untrusted_text when flags has 'manual_entry')
 *   autopilot_memory  -> prior_conclusion
 *   repair_intel aiAnalysis -> derived_ai
 *   autopilot_derived -> structured (deterministic calculations)
 * V1 callers pass three arguments and get the V1 result.
 */
function trustOf(source, field, value, flags) {
  const src = String(source || '');
  const f = String(field || '');
  const fl = Array.isArray(flags) ? flags : [];
  if (src === 'timeline') return fl.includes('manual_entry') ? 'untrusted_text' : 'derived_ai';
  if (src === 'autopilot_memory') return 'prior_conclusion';
  if (src === 'autopilot_derived') return 'structured';
  if (src === 'repair_intel' && f === 'aiAnalysis') return 'derived_ai';
  if (UNTRUSTED_SOURCES.has(src)) return 'untrusted_text';
  if (UNTRUSTED_FIELDS.has(f)) return 'untrusted_text';
  const sf = UNTRUSTED_SOURCE_FIELDS[src];
  if (sf && sf.has(f)) return 'untrusted_text';
  if (NAME_FIELDS.has(f)) return _structuredName(value) ? 'structured' : 'untrusted_text';
  return structuredValue(value, f) ? 'structured' : 'untrusted_text';
}

module.exports = { trustOf, structuredValue, FIELD_ENUMS, STAGES, LIFECYCLE_STATES, CANONICAL_STATUSES };
