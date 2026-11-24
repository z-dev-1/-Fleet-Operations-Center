'use strict';
/**
 * autopilot/constants.js — shared enums, limits and small pure helpers for
 * Fleet Autopilot V1 (read-only / shadow mode).
 *
 * Pure. Requires nothing outside ./ and Node built-ins.
 *
 * LIMITS are reliability limits (retry counts, resume age, per-case run caps).
 * They change case state for operational safety only and are never shown as
 * deadlines (plan R6). OPERATIONAL_CADENCE only orders and schedules work; it
 * never opens, closes or labels a case (FR-2.3).
 */

const STATES = Object.freeze({
  DETECTED: 'DETECTED',
  QUEUED: 'QUEUED',
  INVESTIGATING: 'INVESTIGATING',
  ANALYZING: 'ANALYZING',
  RECOMMENDATION_READY: 'RECOMMENDATION_READY',
  MONITORING: 'MONITORING',
  RESOLVED: 'RESOLVED',
  WAITING_FOR_DATA: 'WAITING_FOR_DATA',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FAILED: 'FAILED',
  PAUSED: 'PAUSED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});

const REASONS = Object.freeze({
  OOS: 'OOS',
  DWELL_EXCEEDED: 'DWELL_EXCEEDED',
  LONG_DWELL_LISTED: 'LONG_DWELL_LISTED',
  ETA_OVERDUE_VERIFIED: 'ETA_OVERDUE_VERIFIED',
  ETA_PAST_UNVERIFIED: 'ETA_PAST_UNVERIFIED',
  ETA_NOT_PROVIDED: 'ETA_NOT_PROVIDED',
  UPDATE_STALE: 'UPDATE_STALE',
  ANNOTATION_STALE: 'ANNOTATION_STALE',
  WAITING_PARTS: 'WAITING_PARTS',
  WAITING_ESTIMATE_APPROVAL: 'WAITING_ESTIMATE_APPROVAL',
  AWAITING_SCHEDULING: 'AWAITING_SCHEDULING',
  STATUS_CONFLICT: 'STATUS_CONFLICT',
  REPAIRED_UNVERIFIED: 'REPAIRED_UNVERIFIED',
  RECURRING_DEFECT: 'RECURRING_DEFECT',
  DOWN_SINCE_UNKNOWN: 'DOWN_SINCE_UNKNOWN',
});

// Source ids. The Aperia source id is 'aperia_cache' so no Autopilot file ever
// contains the pattern that tests/aperia-ipc.test.js reserves (plan R12).
const SOURCES = Object.freeze({
  AAP_CACHE: 'aap_cache',
  AAP_LIVE: 'aap_live',
  CANONICAL: 'canonical',
  REPAIR_INTEL: 'repair_intel',
  DTNA: 'dtna',
  DECISIV: 'decisiv',
  LONG_DWELL: 'long_dwell',
  SLACK: 'slack',
  EMAIL: 'email',
  VENDOR_INTEL: 'vendor_intel',
  FAS_CASE: 'fas_case',
  APERIA: 'aperia_cache',
  SHAREPOINT: 'sharepoint',
});

// Action classes that need no approval (§B9).
const ACTION_CLASSES = Object.freeze(['monitor', 'internal_review', 'verify_in_system']);
// Action classes that always require approval; never executed in V1 (§B9).
const WRITE_ACTION_CLASSES = Object.freeze([
  'vendor_follow_up', 'slack_message', 'email_message', 'wo_create', 'wo_update',
  'lifecycle_change', 'road_ready', 'dot_safety_override', 'estimate_approval',
  'financial_commitment', 'external_escalation', 'sharepoint_edit',
]);

// The first three entries of authority.FIELD_AUTHORITY.repairEtc; excludes the comment-derived
// 'relaygarage' (incl. relaygarage/fas, relaygarage/approver) and 'notes' (incl. notes/email).
const AUTHORITATIVE_ETC_SOURCES = Object.freeze(['decisiv', 'offsiteevent', 'relaygarage/vendor']);
function isAuthoritativeEtcTag(tag) {
  const t = String(tag || '').toLowerCase();
  return AUTHORITATIVE_ETC_SOURCES.some((a) => t === a || t.startsWith(a + '/'));
}

// Same set as src/workers/supervisor.js AUTH_DOWN.
const AUTH_DOWN = new Set(['OFFLINE', 'WAITING_FOR_USER', 'COOLDOWN', 'RECOVERING', 'FAILED']);

const WATCHED_KEYS = Object.freeze([
  'fleetData', 'canonicalState', 'longDwellStore', 'longDwellCsv',
  'dtnaCaseCache', 'decisivCaseCache', 'emailEvidence', 'fasCases',
]);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Reliability limits (plan R6). Never displayed as deadlines.
const LIMITS = Object.freeze({
  maxAttempts: 3,              // attempts >= 3 -> FAILED
  missingBuilds: 2,            // unit missing from 2 real builds -> NEEDS_REVIEW unit_missing
  aiRejectStreak: 2,           // AI output rejected twice in a row -> NEEDS_REVIEW
  aiDeferMax: 3,               // AI deferrals before the fallback is used
  resumeMaxAgeMs: 30 * MIN,    // checkpoints older than this are not resumed
  autoRunsPerDay: 6,           // automatic runs per case per local day
  minAutoSpacingMs: 30 * MIN,  // no automatic trigger within 30 min of the last run
  retryBackoffMin: Object.freeze([5, 15, 45]),
  checkpointMaxBytes: 64 * 1024,
  eventDetailMaxBytes: 8 * 1024,
  findingValueMaxChars: 2000,
});

// Retention (§B5.3).
const RETENTION = Object.freeze({
  pruneEveryMs: 6 * HOUR,
  runsKept: 5,
  runsKeptNoHistory: 1,
  eventMaxAgeMs: 180 * DAY,
  eventBatch: 500,
});

// Scheduling / display only (FR-2.3). Never opens, closes or labels a case.
const OPERATIONAL_CADENCE = Object.freeze({
  detectEveryMs: 30 * MIN,
  cheapFpEveryMs: 30 * MIN,
  aapLiveMinAgeMs: 6 * HOUR,
  decisivLiveMinAgeMs: 12 * HOUR,
  reviewHours: Object.freeze({ repairedUnverified: 4, eta: 12, stale: 12, default: 24 }),
  priority: Object.freeze({
    base: Object.freeze({
      REPAIRED_UNVERIFIED: 40,
      ETA_OVERDUE_VERIFIED: 35,
      STATUS_CONFLICT: 30,
      DWELL_EXCEEDED: 20,
      LONG_DWELL_LISTED: 20,
    }),
    baseOther: 10,
    daysDownCap: 30,
    daysDownDivisor: 2,
    neverInvestigated: 10,
    triggerBoost: 10,
    aiHigh: 10,
    aiLow: -5,
    monitoringUnchanged: -20,
  }),
});

// Same-field conflict candidates (plan R2). Used only by evidence.js and
// conflicts.js. `tag` '$repairEtcSource' / '$factEtcSource' means the item
// carries its own authority tag. `mirror: true` candidates count only when no
// non-mirror candidate exists for the field.
const CONFLICT_FIELDS = Object.freeze({
  lifecycleState: Object.freeze({
    norm: 'lifecycle',
    candidates: Object.freeze([
      Object.freeze({ source: 'aap_cache', field: 'lifecycleState', tag: 'aap' }),
      Object.freeze({ source: 'aap_live', field: 'lifecycleState', tag: 'aap' }),
    ]),
  }),
  repairStatus: Object.freeze({
    norm: 'stage',
    candidates: Object.freeze([
      Object.freeze({ source: 'decisiv', field: 'stage', tag: 'decisiv' }),
      Object.freeze({ source: 'dtna', field: 'offsiteStage', tag: 'offsiteevent' }),
      Object.freeze({ source: 'aap_cache', field: 'offsiteStage', tag: 'fleetdata', mirror: true }),
    ]),
  }),
  repairEtc: Object.freeze({
    norm: 'date',
    candidates: Object.freeze([
      Object.freeze({ source: 'aap_cache', field: 'repairEtc', tag: '$repairEtcSource' }),
      Object.freeze({ source: 'aap_cache', field: '_factEtc.date', tag: '$factEtcSource' }),
      Object.freeze({ source: 'dtna', field: 'repairEtc', tag: 'offsiteevent' }),
      Object.freeze({ source: 'decisiv', field: 'repairEtc', tag: 'decisiv' }),
    ]),
  }),
  partsEta: Object.freeze({
    norm: 'date',
    candidates: Object.freeze([
      Object.freeze({ source: 'aap_cache', field: 'partsEta', tag: 'notes' }),
      Object.freeze({ source: 'decisiv', field: 'partsEta', tag: 'decisiv' }),
    ]),
  }),
  dealerName: Object.freeze({
    norm: 'name',
    candidates: Object.freeze([
      Object.freeze({ source: 'aap_cache', field: 'dealerName', tag: 'fleetdata' }),
      Object.freeze({ source: 'decisiv', field: 'dealerName', tag: 'decisiv' }),
      Object.freeze({ source: 'dtna', field: 'dealerName', tag: 'offsiteevent' }),
    ]),
  }),
});

function normUnit(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

/**
 * unitIndex(doc, keyOf?) -> Map(normUnit -> [originalKey, ...])
 * Built once per tick per unit-keyed store document. `keyOf(key, value)`
 * returns the unit part of a key; the default strips a '::<wo>' suffix
 * (longDwellStore compound keys). Keys that normalize to the same unit merge.
 */
function _defaultKeyOf(k) { return String(k).split('::')[0]; }
function unitIndex(doc, keyOf) {
  const out = new Map();
  if (!doc || typeof doc !== 'object') return out;
  const fn = typeof keyOf === 'function' ? keyOf : _defaultKeyOf;
  for (const k of Object.keys(doc)) {
    let u;
    try { u = normUnit(fn(k, doc[k])); } catch (_) { u = ''; }
    if (!u) continue;
    const list = out.get(u);
    if (list) list.push(k); else out.set(u, [k]);
  }
  return out;
}
// keyOf presets for the documents §B3 lists.
const UNIT_KEY_OF = Object.freeze({
  emailEvidence: (k) => k,
  longDwellStore: _defaultKeyOf,
  longDwellCsvRows: (k, v) => (v && v.assetId != null ? v.assetId : ''),
  fasCases: (k) => String(k).replace(/^unit-/i, ''),
});

function _pad(n) { return String(n).padStart(2, '0'); }
/** YYYY-MM-DD in the process time zone. */
function localDate(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
}

class ApError extends Error {
  constructor(code, message) {
    super(message ? code + ': ' + message : code);
    this.name = 'ApError';
    this.code = code;
  }
}

module.exports = {
  STATES, REASONS, SOURCES, ACTION_CLASSES, WRITE_ACTION_CLASSES,
  AUTHORITATIVE_ETC_SOURCES, isAuthoritativeEtcTag, AUTH_DOWN, WATCHED_KEYS,
  LIMITS, RETENTION, OPERATIONAL_CADENCE, CONFLICT_FIELDS,
  normUnit, unitIndex, UNIT_KEY_OF, localDate, ApError,
  MIN, HOUR, DAY,
};
