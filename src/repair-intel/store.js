/**
 * repair-intel/store.js — data access + normalization for the repair-history
 * engine. Maps RAW AAP/Relay work-order objects into ri_repair_event rows,
 * applies the vendor-exclusion filter, upserts idempotently by source id, and
 * exposes query helpers for the unit report + trends dashboard.
 *
 * NO-FABRICATION: only fields the AAP API genuinely provides are stored as
 * structured values. Fields the API does NOT expose (confirmed root cause,
 * diagnosed problem, tech findings, parts/part numbers, return-to-service time,
 * hands-on labor time, invoiced cost, mileage-at-repair) are left NULL here and
 * are filled ONLY by the AI extraction layer as SUSPECTED/REPORTED values — the
 * confirmed_* columns stay NULL unless a source truly confirms them.
 */

const engine = require('../store/sqlite_engine');
const crypto = require('crypto');
let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }
const { ensureSchema } = require('./schema');

// Vendor exclusion (Velocity/Fleetnet/Goodyear) uses the SINGLE canonical
// chokepoint in the AAP mapper so history/trends/vendor-network all agree.
const { isExcludedVendor: _isExcludedVendor, EXCLUDED_VENDORS } = require('../scrapers/aap_api_mapper');

// ── Status / type classification (deterministic, from the API status enum) ────
function _classifyStatus(wo) {
  const s = (wo && wo.status) || {};
  const d = s.description || s;
  const val = String(d.value || d.displayText || wo.status || '').toUpperCase();
  const type = String(s.type || '').toUpperCase();
  if (/CANCEL/.test(val) || type === 'ALERT' && /CANCEL/.test(val)) return 'cancelled';
  if (/COMPLETE|CLOSED|DONE/.test(val) || type === 'COMPLETE') return 'completed';
  if (/REOPEN/.test(val)) return 'reopened';
  if (/TRANSFER/.test(val)) return 'transferred';
  return 'open';
}

function _classifyWoType(wo) {
  const cat = String((wo && wo.category) || '').toLowerCase();
  if (/preventive|\bpm\b/.test(cat)) return 'PM';
  if (/roadside/.test(cat)) return 'roadside';
  if (/dealer/.test(cat)) return 'dealer';
  if (/offsite/.test(cat)) return 'offsite';
  if (/plan/.test(cat) && !/unplan/.test(cat)) return 'planned';
  return 'unplanned';
}

const _n = (v) => (v == null || v === '' ? null : Number(v));

// Parts / back-order signal. Honest: derived ONLY from the delay reason codes
// and lifecycle reason the API actually returns (PARTS_DELAY / BACK_ORDER /
// WAITING/AWAITING PARTS, etc.) — never inferred/guessed. Returns { codes, flag }.
const _PARTS_RE = /PARTS?[_ ]?(DELAY|ORDER|BACK|HOLD|WAIT)|BACK[_ ]?ORDER|AWAIT.*PART|WAIT.*PART|PART.*AWAIT|PART.*BACK/i;
function _partsSignal(wo) {
  const codes = [];
  if (Array.isArray(wo.delayReasonCodes)) codes.push(...wo.delayReasonCodes);
  else if (wo.delayReasonCodes) codes.push(String(wo.delayReasonCodes));
  const lcReason = String(wo.lifecycleStateReason || wo.lifecycleReason || '');
  const subStatus = String((wo.subStatus && (wo.subStatus.value || wo.subStatus)) || wo.substatus || '');
  const haystack = codes.join(' ') + ' ' + lcReason + ' ' + subStatus;
  const flag = _PARTS_RE.test(haystack) ? 1 : 0;
  return { codes: codes.length ? codes.join('; ') : (lcReason || null), flag };
}
function _epoch(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

// Compute the deterministic downtime components we CAN from available dates.
// Anything that cannot be computed stays null (UI shows "Unknown"). We never
// treat "whole time the WO was open" as hands-on labor (left null — the API
// does not provide actual labor time).
function _downtime(reportedAt, startAt, completedAt, returnAt) {
  const out = { total_elapsed_ms: null, hands_on_ms: null, wait_diagnosis_ms: null,
    wait_parts_ms: null, wait_approval_ms: null, wait_capacity_ms: null,
    wait_transfer_ms: null, wait_return_ms: null };
  if (reportedAt && completedAt && completedAt >= reportedAt) out.total_elapsed_ms = completedAt - reportedAt;
  if (completedAt && returnAt && returnAt >= completedAt) out.wait_return_ms = returnAt - completedAt;
  // wait_diagnosis = reported -> start (time before hands-on began), when both exist.
  if (reportedAt && startAt && startAt >= reportedAt) out.wait_diagnosis_ms = startAt - reportedAt;
  return out;
}

// Normalize ONE raw work-order object into a ri_repair_event row (plain object).
// `asset` optionally supplies master fields (vin/make/model/year/mileage).
function normalizeWorkOrder(wo, asset) {
  if (!wo) return null;
  const sourceId = String(wo.workRequestId || wo.id || '').trim();
  if (!sourceId) return null;

  const a = asset || {};
  const l1 = []; const l2 = [];
  for (const si of (wo.suggestedItems || [])) {
    if (si && si.level1 && !l1.includes(si.level1)) l1.push(si.level1);
    if (si && si.level2 && !l2.includes(si.level2)) l2.push(si.level2);
  }
  const vendor = String(wo.vendor || '').trim();
  const reportedAt  = _epoch(wo.reportedDateTime || wo.createdDateTime || wo.scheduledDateTime);
  const createdAt   = _epoch(wo.createdDateTime || wo.scheduledDateTime);
  const startAt     = _epoch(wo.actualStartDateTime || wo.expectedStartDateTime);
  const completedAt = _epoch(wo.completedDateTime);
  const returnAt    = _epoch(wo.returnToServiceDateTime); // usually absent -> null
  const dt = _downtime(reportedAt, startAt, completedAt, returnAt);

  const row = {
    source_id:        sourceId,
    work_order_id:    String(wo.workRequestId || wo.id || '') || null,
    service_id:       String(wo.id || '') || null,
    // Offsite/dealer event id. The aggregate carries caseNumber / alternateUniqueId
    // (the amz-xxxx case). The AI/detail layer can later confirm a true offsite
    // event from the comment thread; here we capture the id + build the AAP
    // offsite-events URL so an offsite WO is linkable from day one.
    offsite_id:       String(wo.caseNumber || wo.alternateUniqueId || '').trim() || null,
    amz_id:           String(wo.aaid || '') || null,
    equipment_id:     String(wo.assetDisplayName || a.equipmentId || wo.equipmentId || '').trim() || null,
    vin:              a.vin || null,
    make:             a.manufacturer || a.make || null,
    model:            a.model || null,
    model_year:       a.modelYear || null,
    domicile:         String(wo.assetDomicileSite || a.domicileSite || '') || null,
    operator:         String(wo.operator || a.operator || '') || null,
    mileage_at_repair: _n(a.odometerMiles),  // null when unknown
    vendor:           vendor || null,
    repair_location:  String(wo.reportedLocation || wo.latestLocation || '') || null,
    repair_category:  String(wo.category || '') || null,
    repair_component: l1.join('; ') || null,
    repair_subcategory: l2.join('; ') || null,
    wo_type:          _classifyWoType(wo),
    status:           _classifyStatus(wo),
    reported_at:      reportedAt,
    created_at:       createdAt,
    repair_start_at:  startAt,
    repair_completed_at: completedAt,
    return_to_service_at: returnAt,
    cancelled_at:     _classifyStatus(wo) === 'cancelled' ? (_epoch(wo.completedDateTime) || null) : null,
    modified_at:      _epoch(wo.lastModifiedDateTime || wo.modifiedDateTime || wo.rocModifiedDateTime || wo.completedDateTime || wo.scheduledDateTime),
    // Repair detail: structured-from-API only. The AI layer fills the rest from
    // the comment thread as SUSPECTED/REPORTED later; confirmed_* stays null.
    reported_complaint: String(wo.damageDescription || '') || null,
    symptoms:         null,
    tech_findings:    null,
    diagnosed_problem: null,
    confirmed_root_cause: null,
    suspected_root_cause: null,
    corrective_actions: null,
    outcome:          null,                  // set by AI effectiveness classifier
    complaint_resolved: null,
    verification_result: null,
    outstanding_issues: null,
    cancellation_reason: Array.isArray(wo.delayReasonCodes) && _classifyStatus(wo) === 'cancelled' ? wo.delayReasonCodes.join('; ') : null,
    delay_reason_codes: _partsSignal(wo).codes,
    parts_on_order:   _partsSignal(wo).flag,
    total_elapsed_ms: dt.total_elapsed_ms,
    hands_on_ms:      dt.hands_on_ms,
    wait_diagnosis_ms: dt.wait_diagnosis_ms,
    wait_parts_ms:    dt.wait_parts_ms,
    wait_approval_ms: dt.wait_approval_ms,
    wait_capacity_ms: dt.wait_capacity_ms,
    wait_transfer_ms: dt.wait_transfer_ms,
    wait_return_ms:   dt.wait_return_ms,
    in_scope:         'unknown',
    out_of_scope_reason: null,
    dealer_required:  _classifyWoType(wo) === 'dealer' ? 'yes' : 'unknown',
    specialist_required: null,
    transferred:      _classifyStatus(wo) === 'transferred' ? 'yes' : 'unknown',
    receiving_vendor: null,
    transfer_date:    null,
    transfer_result:  null,
    estimate_cost:    _n(wo.totalEstimatePendingApprovalCost),
    invoiced_cost:    null,                  // API does not expose actual invoiced cost
    source_refs:      JSON.stringify({
      relay: wo.workRequestId || wo.id ? ('https://aap-na.corp.amazon.com/v2/service/' + (wo.workRequestId || wo.id)) : null,
      offsite: (wo.caseNumber || wo.alternateUniqueId) ? ('https://aap-na.corp.amazon.com/v2/offsite-events/' + String(wo.caseNumber || wo.alternateUniqueId).trim()) : null,
    }),
    source_conflict:  null,
    excluded_vendor:  _isExcludedVendor(vendor) ? 1 : 0,
    first_seen_at:    Date.now(),
    last_synced_at:   Date.now(),
  };
  row.raw_hash = crypto.createHash('sha1').update(JSON.stringify([
    row.status, row.vendor, row.repair_category, row.repair_component, row.reported_complaint,
    row.reported_at, row.repair_completed_at, row.modified_at, row.estimate_cost,
    row.parts_on_order, row.delay_reason_codes,
  ])).digest('hex');
  return row;
}

const _COLS = [
  'source_id','work_order_id','service_id','offsite_id','amz_id','equipment_id','vin','make','model','model_year',
  'domicile','operator','mileage_at_repair','vendor','repair_location','repair_category','repair_component','repair_subcategory',
  'wo_type','status','reported_at','created_at','repair_start_at','repair_completed_at','return_to_service_at','cancelled_at','modified_at',
  'reported_complaint','symptoms','tech_findings','diagnosed_problem','confirmed_root_cause','suspected_root_cause','corrective_actions',
  'outcome','complaint_resolved','verification_result','outstanding_issues','cancellation_reason','delay_reason_codes','parts_on_order',
  'total_elapsed_ms','hands_on_ms','wait_diagnosis_ms','wait_parts_ms','wait_approval_ms','wait_capacity_ms','wait_transfer_ms','wait_return_ms',
  'in_scope','out_of_scope_reason','dealer_required','specialist_required','transferred','receiving_vendor','transfer_date','transfer_result',
  'estimate_cost','invoiced_cost','source_refs','source_conflict','excluded_vendor','raw_hash','first_seen_at','last_synced_at',
];

// Idempotent upsert of one normalized event. Preserves first_seen_at on update,
// and skips the write entirely when raw_hash is unchanged (avoids churn). AI-
// filled columns (outcome, *_root_cause, etc.) are NOT overwritten by a re-sync.
// Returns 'added' | 'updated' | 'unchanged'.
function upsertEvent(row) {
  if (!ensureSchema()) return 'skipped';
  const existing = engine.prepare('SELECT id, raw_hash, first_seen_at FROM ri_repair_event WHERE source_id = ?');
  const cur = existing ? existing.get(row.source_id) : null;
  if (cur && cur.raw_hash === row.raw_hash) return 'unchanged';

  if (cur) {
    row.first_seen_at = cur.first_seen_at || row.first_seen_at;
    // Update only the source-derived columns; leave AI columns intact.
    const aiCols = new Set(['outcome','symptoms','tech_findings','diagnosed_problem','confirmed_root_cause','suspected_root_cause','corrective_actions','complaint_resolved','verification_result','outstanding_issues','in_scope','out_of_scope_reason','specialist_required','receiving_vendor','transfer_result']);
    const setCols = _COLS.filter(c => !aiCols.has(c));
    const set = setCols.map(c => c + ' = @' + c).join(', ');
    const stmt = engine.prepare('UPDATE ri_repair_event SET ' + set + ' WHERE source_id = @source_id');
    stmt.run(_params(row, setCols.concat(['source_id'])));
    return 'updated';
  }
  const stmt = engine.prepare('INSERT INTO ri_repair_event (' + _COLS.join(',') + ') VALUES (' + _COLS.map(c => '@' + c).join(',') + ')');
  stmt.run(_params(row, _COLS));
  return 'added';
}

// node:sqlite named params require an object with ONLY the used keys, all
// primitives (no undefined). Coerce undefined->null.
function _params(row, cols) {
  const o = {};
  for (const c of cols) { const v = row[c]; o[c] = (v === undefined ? null : v); }
  return o;
}

// Store the SUSPECTED back-ordered parts extracted from a WO's comment thread
// (array of {part, phrase, at}). Deterministic evidence from comments — stored
// as JSON on the event. Safe to call repeatedly (overwrites with latest).
function setBackorderedParts(sourceId, items) {
  if (!ensureSchema() || !sourceId) return;
  const json = (Array.isArray(items) && items.length) ? JSON.stringify(items) : null;
  const stmt = engine.prepare('UPDATE ri_repair_event SET backordered_parts = ? WHERE source_id = ?');
  if (stmt) stmt.run(json, String(sourceId));
}

// Replace the parts for an event (idempotent: delete + insert).
function setParts(eventId, equipmentId, parts) {
  if (!ensureSchema() || !Array.isArray(parts)) return;
  engine.prepare('DELETE FROM ri_repair_part WHERE event_id = ?').run(eventId);
  const ins = engine.prepare('INSERT INTO ri_repair_part (event_id, equipment_id, part_name, part_number, component, action, qty) VALUES (?,?,?,?,?,?,?)');
  for (const p of parts) {
    ins.run(eventId, equipmentId || null, p.name || null, p.number || null, p.component || null, p.action || null, p.qty || null);
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────
// All event reads EXCLUDE the excluded-vendor set by default (Velocity/Fleetnet/
// Goodyear) unless includeExcluded is passed.
function eventsForUnit(equipmentId, opts = {}) {
  if (!ensureSchema()) return [];
  // Default to ALL stored events (the engine only ever stores what the API
  // actually returned for this unit, so there is nothing to hide). A caller can
  // still pass an explicit sinceMs to narrow the window. NOTE: use `!= null` so
  // an explicit sinceMs:0 means "from epoch 0" (all), not the falsy-|| fallback.
  const windowStart = (opts.sinceMs != null) ? opts.sinceMs : 0;
  const incl = opts.includeExcluded ? '' : ' AND excluded_vendor = 0';
  const stmt = engine.prepare(
    'SELECT * FROM ri_repair_event WHERE equipment_id = ?' + incl +
    ' AND (reported_at IS NULL OR reported_at >= ?) ORDER BY COALESCE(reported_at, created_at, 0) DESC');
  return stmt ? stmt.all(String(equipmentId), windowStart) : [];
}

function getCheckpoint(equipmentId) {
  if (!ensureSchema()) return null;
  const s = engine.prepare('SELECT * FROM ri_sync_checkpoint WHERE equipment_id = ?');
  return s ? s.get(String(equipmentId)) : null;
}

function saveCheckpoint(cp) {
  if (!ensureSchema()) return;
  const stmt = engine.prepare(`INSERT INTO ri_sync_checkpoint
    (equipment_id, last_full_sync_at, last_incr_sync_at, last_modified_seen, window_start_at, source_coverage, last_error, records_total, updated_at)
    VALUES (@equipment_id,@last_full_sync_at,@last_incr_sync_at,@last_modified_seen,@window_start_at,@source_coverage,@last_error,@records_total,@updated_at)
    ON CONFLICT(equipment_id) DO UPDATE SET
      last_full_sync_at=COALESCE(excluded.last_full_sync_at,ri_sync_checkpoint.last_full_sync_at),
      last_incr_sync_at=COALESCE(excluded.last_incr_sync_at,ri_sync_checkpoint.last_incr_sync_at),
      last_modified_seen=MAX(COALESCE(excluded.last_modified_seen,0),COALESCE(ri_sync_checkpoint.last_modified_seen,0)),
      window_start_at=COALESCE(excluded.window_start_at,ri_sync_checkpoint.window_start_at),
      source_coverage=excluded.source_coverage, last_error=excluded.last_error,
      records_total=excluded.records_total, updated_at=excluded.updated_at`);
  if (stmt) stmt.run(_params({
    equipment_id: String(cp.equipmentId), last_full_sync_at: cp.lastFullSyncAt || null,
    last_incr_sync_at: cp.lastIncrSyncAt || null, last_modified_seen: cp.lastModifiedSeen || null,
    window_start_at: cp.windowStartAt || null, source_coverage: cp.sourceCoverage ? JSON.stringify(cp.sourceCoverage) : null,
    last_error: cp.lastError || null, records_total: cp.recordsTotal || null, updated_at: Date.now(),
  }, ['equipment_id','last_full_sync_at','last_incr_sync_at','last_modified_seen','window_start_at','source_coverage','last_error','records_total','updated_at']));
}

// ── AI write-back (Phase 4) ───────────────────────────────────────────────────
// The AI layer may ONLY fill interpretive columns (suspected cause, corrective
// actions, outcome, complaint_resolved, verification/outstanding, scope hints).
// It must NEVER write confirmed_root_cause or any numeric/duration/cost column —
// those stay source-derived. This helper enforces that allow-list.
const _AI_WRITABLE = new Set([
  'symptoms','tech_findings','diagnosed_problem','suspected_root_cause','corrective_actions',
  'outcome','complaint_resolved','verification_result','outstanding_issues',
  'in_scope','out_of_scope_reason','specialist_required','receiving_vendor','transfer_result',
]);

function applyAiToEvent(sourceId, ai) {
  if (!ensureSchema() || !sourceId || !ai || typeof ai !== 'object') return false;
  const cols = Object.keys(ai).filter(k => _AI_WRITABLE.has(k) && ai[k] != null && ai[k] !== '');
  if (!cols.length) return false;
  const set = cols.map(c => c + ' = @' + c).join(', ');
  const stmt = engine.prepare('UPDATE ri_repair_event SET ' + set + ' WHERE source_id = @source_id');
  if (!stmt) return false;
  const params = { source_id: String(sourceId) };
  for (const c of cols) params[c] = ai[c];
  stmt.run(params);
  return true;
}

// Per-unit AI analysis cache (narrative report). Keyed by equipment_id; carries
// the evidence_hash it was built from so the UI/engine can skip re-analysis
// when the underlying events have not changed.
function getAiAnalysis(equipmentId) {
  if (!ensureSchema()) return null;
  const s = engine.prepare('SELECT * FROM ri_ai_analysis WHERE equipment_id = ?');
  return s ? s.get(String(equipmentId)) : null;
}

function saveAiAnalysis(rec) {
  if (!ensureSchema() || !rec || !rec.equipmentId) return;
  const stmt = engine.prepare(`INSERT INTO ri_ai_analysis
    (equipment_id, report_json, evidence_hash, analysis_version, model_id, analyzed_at)
    VALUES (@equipment_id,@report_json,@evidence_hash,@analysis_version,@model_id,@analyzed_at)
    ON CONFLICT(equipment_id) DO UPDATE SET
      report_json=excluded.report_json, evidence_hash=excluded.evidence_hash,
      analysis_version=excluded.analysis_version, model_id=excluded.model_id,
      analyzed_at=excluded.analyzed_at`);
  if (stmt) stmt.run({
    equipment_id: String(rec.equipmentId),
    report_json: rec.reportJson ? (typeof rec.reportJson === 'string' ? rec.reportJson : JSON.stringify(rec.reportJson)) : null,
    evidence_hash: rec.evidenceHash || null,
    analysis_version: rec.analysisVersion || 1,
    model_id: rec.modelId || null,
    analyzed_at: Date.now(),
  });
}

// Replace advisory recommendations for a scope+key (idempotent: clear + insert).
// Recommendations are ADVISORY ONLY — they never alter canonical readiness.
function replaceRecommendations(scope, scopeKey, recs) {
  if (!ensureSchema() || !Array.isArray(recs)) return;
  engine.prepare('DELETE FROM ri_recommendation WHERE scope = ? AND scope_key = ? AND dismissed = 0').run(scope, String(scopeKey));
  const ins = engine.prepare(`INSERT INTO ri_recommendation
    (scope, scope_key, kind, finding, reason, recommended_action, owner, priority, confidence, incident_count, period_start_at, period_end_at, supporting_wos, created_at, dismissed)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);
  const now = Date.now();
  for (const r of recs) {
    ins.run(scope, String(scopeKey), r.kind || 'monitor', r.finding || null, r.reason || null,
      r.recommendedAction || null, r.owner || null, r.priority || 'low', r.confidence || 'low',
      r.incidentCount || null, r.periodStartAt || null, r.periodEndAt || null,
      r.supportingWos ? JSON.stringify(r.supportingWos) : null, now);
  }
}

function getRecommendations(scope, scopeKey) {
  if (!ensureSchema()) return [];
  const s = engine.prepare('SELECT * FROM ri_recommendation WHERE scope = ? AND scope_key = ? AND dismissed = 0 ORDER BY created_at DESC');
  return s ? s.all(scope, String(scopeKey)) : [];
}

// Fleet-wide: every COMPLETED work order finished at/after `sinceMs` (excluded
// vendors skipped — same rule as the per-unit report the History tab shows).
// Used by the overview's "RCA to do" count.
function completedSince(sinceMs) {
  if (!ensureSchema()) return [];
  const s = engine.prepare(
    "SELECT equipment_id, work_order_id, vendor, repair_component, repair_category, reported_complaint," +
    " repair_completed_at, domicile, operator FROM ri_repair_event" +
    " WHERE status = 'completed' AND excluded_vendor = 0 AND work_order_id IS NOT NULL" +
    " AND repair_completed_at IS NOT NULL AND repair_completed_at >= ? ORDER BY repair_completed_at ASC");
  return s ? s.all(Number(sinceMs) || 0) : [];
}

module.exports = {
  completedSince,
  EXCLUDED_VENDORS, _isExcludedVendor,
  normalizeWorkOrder, upsertEvent, setParts, setBackorderedParts,
  eventsForUnit, getCheckpoint, saveCheckpoint,
  applyAiToEvent, getAiAnalysis, saveAiAnalysis,
  replaceRecommendations, getRecommendations,
  _classifyStatus, _classifyWoType, _downtime,
};
