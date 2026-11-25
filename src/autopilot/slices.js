'use strict';
/**
 * autopilot/slices.js — per-case slice fingerprints for continuous monitoring (V2 design §9.1,
 * §9.2, review finding 7). Pure apart from the reads forCase() makes through the given ports.
 *
 *   computeSlices({ row, unit, docs, dtnaEntries, aperiaIssues, riSummary })
 *     -> { comments, estimate, stage, parts, verified_eta, comms, conflict, other }  (sha1 each)
 *   forCase({ row, unit, docs, ports, now, aperiaIssues }) -> slices
 *     reads ports.dtnaCasesForUnit(unit), riSummary { count, maxReportedAt } from
 *     ports.riEvents(unit, now - 365 d), and the Aperia cache (the caller passes
 *     ports.aperiaCachedIssues() once per pass; read here only when not passed).
 *     investigate.js and controller.js both use this one function, so a run and a
 *     controller evaluation over the same sources produce the same slices.
 *   changedSlices(prev, next) -> [slice names that differ] ([] when prev is null)
 *   triggerFor(prev, next)    -> first changed slice's trigger name (§9.2 order) | null
 *
 * Each slice hashes only values the sources state (never fetch / build / scrape times).
 * Cosmetic fields (workDuration, syncedAt, _convFetchedAt, _stageReadAt, scrapedAt, pulledAt,
 * retrievedAt, freshness) are in no slice (FR-11.3). `docs` is an object of store documents
 * or a reader function k -> document.
 *
 * Aperia issues count only for tire-relevant units (plan.tireRelevant), the same rule that
 * decides whether a run reads the Aperia cache at all.
 */

const crypto = require('crypto');
const { stableStringify, ROW_FP_FIELDS } = require('./fingerprint');
const { normUnit, unitIndex, UNIT_KEY_OF, isAuthoritativeEtcTag, woSetOf, DAY } = require('./constants');
const { decisivRef, tireRelevant } = require('./plan');
const { toMs } = require('./updates');

const SLICE_NAMES = Object.freeze(['comments', 'estimate', 'stage', 'parts', 'verified_eta', 'comms', 'conflict', 'other']);
// §9.2: the trigger is named after the first changed slice, in this order.
const TRIGGER_ORDER = Object.freeze([
  ['conflict', 'conflict'], ['verified_eta', 'verified_eta_change'], ['stage', 'stage_change'], ['parts', 'parts_status'],
  ['estimate', 'new_estimate'], ['comments', 'new_comment'], ['comms', 'relevant_comm'], ['other', 'evidence_changed'],
]);
const RI_WINDOW_MS = 365 * DAY;

// Row fields that appear in a named slice; every other ROW_FP_FIELDS field goes to `other`.
const NAMED_ROW_FIELDS = new Set([
  'fullConversation', 'asistNotes', 'estimateStatus', 'totalEstimatePendingApprovalCost', 'dtnaEstimateText',
  'lifecycleState', 'lifecycleReason', 'serviceState', 'subState', 'offsiteStage', 'offsiteStageSince', 'canonicalStatus',
  'completed', 'workRequestId', '_serviceId', '_secondaryWRs', 'partsStatus', 'partsEta', 'repairEtc', 'repairEtcSource',
  '_factEtc', 'canonicalConflictCount', 'factConflicts',
]);
const OTHER_ROW_FIELDS = Object.freeze(ROW_FP_FIELDS.filter((k) => !NAMED_ROW_FIELDS.has(k)));

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _h(v) { return _sha1(stableStringify(v)); }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _obj(v) { return v && typeof v === 'object' ? v : null; }
function _v(x) { return x === undefined ? null : x; }
function _ws(s) { return s == null ? null : String(s).replace(/\s+/g, ' ').trim(); }
function _lc(s) { return s == null || s === '' ? null : String(s).trim().toLowerCase(); }
function _reader(docs) {
  if (typeof docs === 'function') return (k) => { try { return docs(k); } catch (_) { return null; } };
  const d = _obj(docs) || {};
  return (k) => (Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null);
}

function computeSlices(input) {
  const i = input || {};
  const row = _obj(i.row) || {};
  const unit = normUnit(i.unit || row.equipmentId);
  const doc = _reader(i.docs);
  const dtna = _arr(i.dtnaEntries).filter(Boolean);

  const ref = decisivRef(row);
  const decDoc = _obj(doc('decisivCaseCache'));
  const dec = ref.estimateId && decDoc ? _obj(decDoc[ref.estimateId]) : null;
  const dtnaStage = dtna.length ? _lc(dtna[0].offsiteStage) : null;
  const decisivStage = dec ? _lc(dec.stage) : null;

  const comments = {
    conv: _ws(row.fullConversation), asist: _v(row.asistNotes),
    dtna: dtna.map((e) => ({ caseId: _v(e.caseId || e.caseNumber), lastCommentAt: _v(e.lastCommentAt), threadLength: _arr(e.thread || e.comments).length })),
    decisiv: dec ? { notesCount: _v(dec.notesCount), newestNoteAt: _v(dec.newestNoteAt) } : null,
  };
  const estimate = {
    status: _v(row.estimateStatus), pending: _v(row.totalEstimatePendingApprovalCost),
    dtnaText: row.dtnaEstimateText == null ? null : _sha1(String(row.dtnaEstimateText)),
    decisiv: dec ? _v(dec.estimateStatus) : null,
  };
  const stage = {
    lifecycleState: _v(row.lifecycleState), lifecycleReason: _v(row.lifecycleReason), serviceState: _v(row.serviceState),
    subState: _v(row.subState), offsiteStage: _v(row.offsiteStage), offsiteStageSince: _v(row.offsiteStageSince),
    canonicalStatus: _v(row.canonicalStatus), completed: _v(row.completed), wo: woSetOf(row).ids.slice().sort(),
    dtna: dtna.map((e) => _v(e.offsiteStage)), decisiv: dec ? _v(dec.stage) : null,
  };
  const parts = { partsStatus: _v(row.partsStatus), partsEta: _v(row.partsEta) };
  const fe = _obj(row._factEtc);
  const verifiedEta = {
    row: isAuthoritativeEtcTag(row.repairEtcSource) ? { repairEtc: _v(row.repairEtc), source: _v(row.repairEtcSource) } : null,
    fact: fe && (isAuthoritativeEtcTag(fe.source) || fe.state === 'missed') ? { state: _v(fe.state), date: _v(fe.date), source: _v(fe.source) } : null,
    dtna: dtna.map((e) => _v(e.repairEtc || e.etc)),
    decisiv: dec ? _v(dec.etr !== undefined ? dec.etr : dec.repairEtc) : null,
  };

  const email = _obj(doc('emailEvidence')) || {};
  const emailEntries = [];
  for (const k of unitIndex(email, UNIT_KEY_OF.emailEvidence).get(unit) || []) {
    for (const it of _arr(email[k])) if (it) emailEntries.push({ messageId: _v(it.messageId), field: _v(it.field), value: _v(it.value) });
  }
  const fasDoc = _obj(doc('fasCases')) || {};
  const fas = unit ? _obj(fasDoc['unit-' + unit.toLowerCase()]) : null;
  const ldStore = _obj(doc('longDwellStore')) || {};
  const ld = [];
  for (const k of unitIndex(ldStore, UNIT_KEY_OF.longDwellStore).get(unit) || []) {
    const e = _obj(ldStore[k]) || {};
    ld.push({ k, updatedAt: _v(e.updatedAt), delayReason: _v(e.delayReason), escalationLevel: _v(e.escalationLevel) });
  }
  const csv = _obj(doc('longDwellCsv'));
  const csvRows = csv ? (_obj(csv.rows) || csv) : {};
  for (const k of unitIndex(csvRows, UNIT_KEY_OF.longDwellCsvRows).get(unit) || []) {
    const e = _obj(csvRows[k]) || {};
    ld.push({ k: 'csv/' + k, updatedAt: _v(e.updatedAt), delayReason: _v(e.delayReason), escalationLevel: _v(e.escalationLevel) });
  }
  const comms = { email: emailEntries, fas: fas ? { status: _v(fas.status), updatedAt: _v(fas.updatedAt) } : null, longDwell: ld };

  const conflict = {
    canonicalConflictCount: _v(row.canonicalConflictCount), factConflicts: _v(row.factConflicts),
    stageMismatch: dtnaStage != null && decisivStage != null && dtnaStage !== decisivStage,
  };

  const otherRow = {};
  for (const k of OTHER_ROW_FIELDS) if (row[k] !== undefined) otherRow[k] = row[k];
  const ap = tireRelevant(row) ? _obj(i.aperiaIssues) : null;
  const aperia = ap ? _arr(ap.issues).filter((x) => x && normUnit(x.fleetVehicleId) === unit)
    .map((x) => ({ id: _v(x.id || x.issueId), severity: _v(x.severity), state: _v(x.state), dateDetected: _v(x.dateDetected) })) : [];
  const ri = _obj(i.riSummary);
  const other = { row: otherRow, aperia, ri: ri ? { count: _v(ri.count), maxReportedAt: _v(ri.maxReportedAt) } : null };

  return {
    comments: _h(comments), estimate: _h(estimate), stage: _h(stage), parts: _h(parts), verified_eta: _h(verifiedEta),
    comms: _h(comms), conflict: _h(conflict), other: _h(other),
  };
}

function forCase(input) {
  const i = input || {};
  const row = _obj(i.row) || {};
  const ports = i.ports || {};
  const unit = normUnit(i.unit || row.equipmentId);
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  let dtnaEntries = [];
  try { dtnaEntries = _arr(ports.dtnaCasesForUnit(unit)); } catch (_) { dtnaEntries = []; }
  let aperiaIssues = i.aperiaIssues;
  if (aperiaIssues === undefined) {
    aperiaIssues = null;
    if (tireRelevant(row)) { try { aperiaIssues = ports.aperiaCachedIssues(); } catch (_) { aperiaIssues = null; } }
  }
  let events = [];
  try { events = _arr(ports.riEvents(unit, now - RI_WINDOW_MS)); } catch (_) { events = []; }
  const maxReportedAt = events.reduce((m, e) => Math.max(m, toMs(e && e.reported_at) || 0), 0) || null;
  return computeSlices({ row, unit, docs: i.docs, dtnaEntries, aperiaIssues, riSummary: { count: events.length, maxReportedAt } });
}

/**
 * sliceFp(slice, row, docs) -> pre-call fingerprint of a live tool's source (§6.2.5), stored as
 * ap_step.source_fp and part of call_key. 'comments' (AAP) is the comments slice of the row and
 * docs; 'decisiv' hashes the Decisiv cache entry's slice values (no fetch times). null when the
 * source has nothing to fingerprint.
 */
function sliceFp(slice, row, docs) {
  const r = _obj(row) || {};
  if (slice === 'decisiv') {
    const ref = decisivRef(r);
    const decDoc = _obj(_reader(docs)('decisivCaseCache'));
    const dec = ref.estimateId && decDoc ? _obj(decDoc[ref.estimateId]) : null;
    if (!dec) return null;
    return _h({
      notesCount: _v(dec.notesCount), newestNoteAt: _v(dec.newestNoteAt), stage: _v(dec.stage),
      estimateStatus: _v(dec.estimateStatus), etr: _v(dec.etr !== undefined ? dec.etr : dec.repairEtc),
    });
  }
  const s = computeSlices({ row: r, docs });
  return Object.prototype.hasOwnProperty.call(s, slice) ? s[slice] : null;
}

function changedSlices(prev, next) {
  const p = _obj(prev);
  const n = _obj(next);
  if (!p || !n) return [];
  return SLICE_NAMES.filter((k) => p[k] !== n[k]);
}

function triggerFor(prev, next) {
  const changed = new Set(changedSlices(prev, next));
  for (const [slice, trigger] of TRIGGER_ORDER) if (changed.has(slice)) return trigger;
  return null;
}

module.exports = { computeSlices, forCase, sliceFp, changedSlices, triggerFor, SLICE_NAMES, TRIGGER_ORDER };
