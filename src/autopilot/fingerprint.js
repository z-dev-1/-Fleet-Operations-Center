'use strict';
/**
 * autopilot/fingerprint.js — evidence and cheap fingerprints (§B8 step 4, §B10.3). Pure.
 *
 *   fp(pack)        sha1 over sorted (source, sourceRef, field, normalizedValue, observedAt).
 *                   retrievedAt, freshness and confidence are excluded; so are fallback
 *                   observedAt values (observedFrom buildAt / syncedAt / retrievedAt) and
 *                   the value of time-derived fields (workDuration).
 *   cheapFp(input)  sha1 over the unit's row fields, its entries in the watched
 *                   store keys, its cached Aperia issues and the repair-intel
 *                   30-day summary. Slack is not included.
 */

const crypto = require('crypto');

// observedAt values that are a read / build time, not a time the source stated. Every AAP build
// (and every live read) rewrites them, so they are left out of fp().
const FALLBACK_OBSERVED_FROM = new Set(['buildAt', 'syncedAt', 'retrievedAt']);
// Values recomputed from the clock on every build (aap_api_mapper workDuration = now - downStart).
// Their underlying fact (the WR's created / down-start time) is fingerprinted through 'created'.
const TIME_DERIVED_FIELDS = new Set(['workDuration']);

// Row fields read by the investigation (§B7.3). workDuration is time-derived (see above).
const ROW_FP_FIELDS = Object.freeze([
  'lifecycleState', 'lifecycleReason', 'serviceState', 'subState', 'workRequestId', '_serviceId', '_offsiteWrId',
  '_secondaryWRs', 'vendor', 'dealerName', 'created', 'repairEtc', 'repairEtcSource', '_factEtc',
  'partsEta', 'partsStatus', 'estimateStatus', 'etcMissCount', 'etcSlipCount', 'offsiteStage', 'offsiteStageSince',
  'canonicalStatus', 'canonicalConflictCount', 'factConflicts', 'completed', 'fullConversation', 'asistNotes',
  'decisivCaseId', 'vendorWorkOrderId', 'domicileSite', 'issueSummary', 'level1', 'level2',
]);

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// Deterministic JSON with sorted object keys.
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function _normValue(it) {
  const v = it.normalizedValue !== undefined ? it.normalizedValue : it.value;
  return v != null && typeof v === 'object' ? stableStringify(v) : String(v == null ? '' : v);
}

function _fpValue(it) {
  if (TIME_DERIVED_FIELDS.has(it.field) && (it.source === 'aap_cache' || it.source === 'aap_live')) return '';
  return _normValue(it);
}

function _fpObservedAt(it) {
  if (it.observedAt == null || FALLBACK_OBSERVED_FROM.has(it.observedFrom)) return '';
  return String(it.observedAt);
}

function fp(pack) {
  const items = (pack && Array.isArray(pack.items)) ? pack.items : [];
  const lines = items.filter(Boolean).map((it) => [
    it.source || '', it.sourceRef || '', it.field || '', _fpValue(it), _fpObservedAt(it),
  ].join('\u0001'));
  lines.sort();
  return _sha1(lines.join('\u0002'));
}

/**
 * cheapFp({ row, slices: {dtna, decisiv, email, fas, longDwell, ...}, aperiaIssues, riSummary: {count, maxReportedAt} })
 */
function cheapFp(input) {
  const i = input || {};
  const row = i.row || {};
  const rowPart = {};
  for (const k of ROW_FP_FIELDS) if (row[k] !== undefined) rowPart[k] = row[k];
  return _sha1(stableStringify({
    row: rowPart,
    slices: i.slices || {},
    aperia: i.aperiaIssues || null,
    ri: i.riSummary || null,
  }));
}

module.exports = { fp, cheapFp, stableStringify, ROW_FP_FIELDS, FALLBACK_OBSERVED_FROM, TIME_DERIVED_FIELDS };
