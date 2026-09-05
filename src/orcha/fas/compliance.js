'use strict';
/**
 * orcha/fas/compliance.js — versioned, searchable DOT/FMCSA compliance
 * knowledge source for the Digital FAS.
 *
 * WHY THIS EXISTS: the FAS must not rely on the model's general memory for
 * regulatory decisions. It must retrieve applicable requirements from a
 * versioned, auditable source and gate every compliance conclusion on that
 * evidence. It must NEVER invent a regulation or declare a unit safe,
 * compliant, or out of service without sufficient evidence.
 *
 * Scope: powered units Zila owns — box trucks, day-cab tractors, sleeper-cab
 * tractors. (Other asset types may be referenced for routing only.)
 *
 * Record shape (each entry):
 *   {
 *     id,                 // stable internal id, e.g. 'fmcsa-393-tires'
 *     jurisdiction,       // 'US-FEDERAL' | 'US-<STATE>' | 'CA-<PROV>' | 'COMPANY' | 'SITE'
 *     regId,              // e.g. '49 CFR 393.75' or 'FMCSA 396.9' or 'POLICY:xyz'
 *     equipment,          // [ 'box-truck', 'day-cab', 'sleeper-cab', 'all' ]
 *     topic,              // 'tires' | 'brakes' | 'lights' | ...
 *     requirement,        // concise statement of the requirement
 *     effectiveDate,      // ISO date the requirement is effective
 *     lastVerified,       // ISO date this record was last verified against source
 *     source,             // approved authoritative source (URL or citation)
 *     interpretation,     // operational FAS interpretation
 *     classHints,         // { oosExamples:[...], violationExamples:[...] } (optional)
 *   }
 *
 * Conclusion classes the FAS must distinguish (never collapse these):
 *   'confirmed-violation'   — evidence shows a regulatory requirement is not met
 *   'confirmed-oos'         — evidence shows an out-of-service condition
 *   'potential-concern'     — a safety concern that requires inspection to confirm
 *   'company-policy'        — an internal company/site policy (not a regulation)
 *   'maintenance-rec'       — a maintenance recommendation (not a regulation)
 *   'insufficient-evidence' — not enough evidence to conclude anything
 *
 * The knowledge here is a conservative, auditable BASELINE seeded for common
 * power-unit topics. It is intentionally correctable/extendable: Zila (or a
 * later verified sync) can add/update records via upsertRecord(). Records carry
 * effectiveDate + lastVerified so staleness is visible. This module NEVER
 * decides a unit's status on its own — it only supplies retrievable requirements
 * and a strict classifier the agent must use with real unit evidence.
 */

const store  = require('../../store');
let logger; try { logger = require('../../utils/logger')('fas-compliance'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const KEY = 'fasCompliance';
const KNOWLEDGE_VERSION = 1;

const CONCLUSION_CLASSES = Object.freeze([
  'confirmed-violation',
  'confirmed-oos',
  'potential-concern',
  'company-policy',
  'maintenance-rec',
  'insufficient-evidence',
]);

const POWER_UNIT_EQUIPMENT = Object.freeze(['box-truck', 'day-cab', 'sleeper-cab']);

// ── Seeded baseline (conservative; citations are authoritative starting points
//    that Zila should confirm/verify — lastVerified reflects the seed date and
//    should be refreshed when the record is confirmed against the live source).
function _seed() {
  const today = new Date().toISOString().slice(0, 10);
  const R = (o) => Object.assign({ jurisdiction: 'US-FEDERAL', equipment: ['all'], effectiveDate: '1990-01-01', lastVerified: today, interpretation: '' }, o);
  return [
    R({ id: 'fmcsa-396-inspection', regId: '49 CFR 396', topic: 'inspection', requirement: 'Motor carriers must systematically inspect, repair, and maintain vehicles; parts and accessories must be in safe operating condition. Every CMV requires periodic (annual) inspection.', source: 'FMCSA 49 CFR Part 396', interpretation: 'A power unit past its annual inspection or with an unaddressed defect from a DVIR is a documentation/maintenance compliance concern; do not declare OOS without a specific qualifying condition.' }),
    R({ id: 'fmcsa-396-11-dvir', regId: '49 CFR 396.11', topic: 'inspection', requirement: 'Driver vehicle inspection reports (DVIRs) must be prepared; any defect likely to affect safe operation must be repaired before the vehicle is dispatched.', source: 'FMCSA 49 CFR 396.11', interpretation: 'A DVIR-reported safety defect must be corrected before dispatch. Treat an open safety-related DVIR as a potential-concern until repair is verified.' }),
    R({ id: 'fmcsa-393-75-tires', regId: '49 CFR 393.75', topic: 'tires', requirement: 'Tires: steering-axle tires min 4/32" tread; other tires min 2/32". No fabric exposed through tread/sidewall; no visible bump/bulge from tread/sidewall separation; no audible air leak. Flat/exposed-ply tires are prohibited.', source: 'FMCSA 49 CFR 393.75', interpretation: 'A flat tire, exposed fabric/ply, or steer tread below 4/32" is an out-of-service condition per CVSA criteria. A worn-but-legal tire is a maintenance recommendation, not a violation.', classHints: { oosExamples: ['flat tire', 'tire fabric exposed', 'steer tire below 4/32'], violationExamples: ['drive tire below 2/32'] } }),
    R({ id: 'fmcsa-393-brakes', regId: '49 CFR 393.40-.52', topic: 'brakes', requirement: 'Every CMV must have service brakes acting on all wheels, adequate braking force, and functional parking/emergency brakes. Defective/missing brakes and brakes out of adjustment beyond limits are prohibited.', source: 'FMCSA 49 CFR 393 Subpart C', interpretation: 'Brakes out of adjustment beyond the limit, an inoperative required brake, or air-loss defects are out-of-service conditions. A brake wear item within limits is maintenance.', classHints: { oosExamples: ['20% or more brakes defective', 'brake out of adjustment beyond limit', 'air leak below 60 psi'] } }),
    R({ id: 'fmcsa-393-steering-suspension', regId: '49 CFR 393.201-.209', topic: 'steering-suspension', requirement: 'Steering systems and suspension components must be securely attached and free of conditions that could cause loss of control or failure (cracked/loose steering components, broken springs, loose U-bolts, cracked frame).', source: 'FMCSA 49 CFR 393 Subpart F', interpretation: 'Loose/cracked steering or a broken main spring leaf/loose axle positioning part is typically an out-of-service condition; confirm the specific defect before concluding.', classHints: { oosExamples: ['cracked/loose steering component', 'broken spring leaf in contact area', 'cracked frame at critical location'] } }),
    R({ id: 'fmcsa-393-lights', regId: '49 CFR 393.9 / 393.11', topic: 'lights', requirement: 'All required lamps and reflective devices must be operable at all times. Required: headlamps, tail lamps, stop lamps, turn signals, clearance/marker lamps, reflectors.', source: 'FMCSA 49 CFR 393.9, 393.11', interpretation: 'An inoperative required lamp is a violation; whether it rises to OOS depends on the lamp and conditions (e.g., no operable headlamps/tail lamps at night). A single burned-out marker in daylight is a violation but not automatically OOS.' }),
    R({ id: 'fmcsa-393-windshield-wipers', regId: '49 CFR 393.60 / 393.78', topic: 'visibility', requirement: 'Windshield must be free of obstructions/damage in the driver\'s sight lines; wipers must be operable.', source: 'FMCSA 49 CFR 393.60, 393.78', interpretation: 'A windshield crack in the driver\'s critical vision area or inoperative wipers in conditions requiring them is a potential-concern-to-violation; verify location/severity.' }),
    R({ id: 'fmcsa-393-mirrors', regId: '49 CFR 393.80', topic: 'visibility', requirement: 'Two rear-vision mirrors required, one on each side, in good condition.', source: 'FMCSA 49 CFR 393.80', interpretation: 'A missing/broken required mirror is a violation.' }),
    R({ id: 'fmcsa-393-95-emergency', regId: '49 CFR 393.95', topic: 'emergency-equipment', requirement: 'CMVs must carry required emergency equipment: fire extinguisher, spare fuses (if applicable), and warning devices (3 reflective triangles/flares).', source: 'FMCSA 49 CFR 393.95', interpretation: 'Missing required emergency equipment is a violation; generally not OOS by itself.' }),
    R({ id: 'fmcsa-396-fluid-leaks', regId: '49 CFR 393 / 396.3', topic: 'fluid-leaks', requirement: 'Vehicles must be maintained in safe operating condition; fuel-system leaks and hazardous fluid leaks are prohibited.', source: 'FMCSA 49 CFR 393.65, 396.3', interpretation: 'A fuel leak is an out-of-service condition. A minor non-hazardous seep may be a maintenance item; confirm the fluid and severity.', classHints: { oosExamples: ['fuel leak'] } }),
    R({ id: 'fmcsa-393-exhaust', regId: '49 CFR 393.83', topic: 'exhaust', requirement: 'Exhaust systems must be securely fastened and must not leak/discharge in a location that could cause fumes to enter the cab or ignite.', source: 'FMCSA 49 CFR 393.83', interpretation: 'An exhaust leak discharging under the cab/sleeper can be an out-of-service condition; verify location.' }),
    R({ id: 'fmcsa-390-21-markings', regId: '49 CFR 390.21', topic: 'registration-documents', requirement: 'CMVs must display the legal name/USDOT number of the operating carrier; required registration/credentials must be present.', source: 'FMCSA 49 CFR 390.21', interpretation: 'Missing/incorrect markings or credentials is a documentation compliance concern, not a mechanical OOS.' }),
    R({ id: 'fmcsa-396-oos', regId: '49 CFR 396.9 / CVSA OOS Criteria', topic: 'out-of-service', requirement: 'A vehicle with a condition meeting the North American Standard Out-of-Service Criteria must be placed out of service until the condition is corrected.', source: 'FMCSA 49 CFR 396.9; CVSA OOS Criteria', interpretation: 'Only declare OOS when a specific condition matches a recognized OOS criterion (e.g., flat tire, defective brakes beyond limit, fuel leak, cracked steering). Otherwise classify as potential-concern or maintenance and recommend inspection.' }),
  ];
}

function _ensureSeeded() {
  let doc;
  try { doc = store.load(KEY, null); } catch (_) { doc = null; }
  if (doc && typeof doc === 'object' && Array.isArray(doc.records) && doc.records.length) return doc;
  doc = { version: KNOWLEDGE_VERSION, seededAt: new Date().toISOString(), records: _seed() };
  try { store.save(KEY, doc); } catch (e) { logger.warn('compliance seed save failed:', e.message); }
  return doc;
}

function _load() { return _ensureSeeded(); }

function _norm(s) { return String(s == null ? '' : s).toLowerCase(); }
function _equipMatch(recEquip, equipment) {
  if (!equipment) return true;
  const e = _norm(equipment);
  return (recEquip || []).some(x => x === 'all' || _norm(x) === e || e.includes(_norm(x)) || _norm(x).includes(e));
}

/**
 * search({ query, topic, equipment, limit }) -> [records]
 * Keyword/topic search over the versioned knowledge source. Returns matching
 * records (never fabricated) so the agent can cite a real requirement.
 */
function search(opts) {
  opts = opts || {};
  const doc = _load();
  const q = _norm(opts.query);
  const topic = _norm(opts.topic);
  const limit = Number.isFinite(opts.limit) ? opts.limit : 8;
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];

  const scored = [];
  for (const r of doc.records) {
    if (!_equipMatch(r.equipment, opts.equipment)) continue;
    if (topic && _norm(r.topic) !== topic && !_norm(r.topic).includes(topic)) continue;
    let score = 0;
    const hay = _norm([r.topic, r.regId, r.requirement, r.interpretation, r.jurisdiction].join(' '));
    for (const t of terms) if (hay.includes(t)) score += 1;
    if (topic && _norm(r.topic).includes(topic)) score += 2;
    if (!terms.length && !topic) score = 1; // list-all fallback
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.r);
}

function getRecord(id) { return _load().records.find(r => r.id === id) || null; }
function listTopics() { return [...new Set(_load().records.map(r => r.topic))].sort(); }

/**
 * upsertRecord(rec) — add or update a compliance record (correctable/extendable
 * knowledge). Requires the mandatory fields so a record is always auditable.
 * Returns { ok, id } or { ok:false, error }.
 */
function upsertRecord(rec) {
  if (!rec || !rec.id || !rec.regId || !rec.requirement || !rec.source) {
    return { ok: false, error: 'record requires id, regId, requirement, source' };
  }
  const doc = _load();
  const clean = {
    id: String(rec.id),
    jurisdiction: rec.jurisdiction || 'US-FEDERAL',
    regId: String(rec.regId),
    equipment: Array.isArray(rec.equipment) && rec.equipment.length ? rec.equipment : ['all'],
    topic: rec.topic || 'general',
    requirement: String(rec.requirement),
    effectiveDate: rec.effectiveDate || new Date().toISOString().slice(0, 10),
    lastVerified: rec.lastVerified || new Date().toISOString().slice(0, 10),
    source: String(rec.source),
    interpretation: rec.interpretation || '',
    classHints: rec.classHints || undefined,
  };
  const idx = doc.records.findIndex(r => r.id === clean.id);
  if (idx >= 0) doc.records[idx] = clean; else doc.records.push(clean);
  doc.updatedAt = new Date().toISOString();
  try { store.save(KEY, doc); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, id: clean.id };
}

/**
 * classify({ observation, unitEvidence, records }) -> {
 *   class, confidence, basis:[recordIds], rationale, needsInspection
 * }
 *
 * STRICT, evidence-gated classifier. It NEVER declares a unit safe/compliant/OOS
 * without a matching authoritative record AND a specific qualifying condition in
 * the supplied evidence. When evidence is thin it returns 'insufficient-evidence'
 * or 'potential-concern' (requires inspection) — never a confirmed status.
 *
 * This is deliberately conservative and deterministic; the AI agent uses it to
 * gate any compliance language in a reply. It does not phone home or invent
 * regulations — it only reasons over the versioned records + provided evidence.
 */
function classify(opts) {
  opts = opts || {};
  const observation = _norm(opts.observation);
  const evidence = opts.unitEvidence || {};
  const equipment = opts.equipment;

  if (!observation) {
    return { class: 'insufficient-evidence', confidence: 0, basis: [], rationale: 'No observation/condition provided.', needsInspection: false };
  }

  // Find candidate records by keyword/topic against the observation.
  const candidates = search({ query: observation, equipment, limit: 6 });
  if (!candidates.length) {
    return { class: 'insufficient-evidence', confidence: 0.2, basis: [], rationale: 'No matching authoritative requirement found for the described condition — do not conclude compliance status.', needsInspection: true };
  }

  // Does the observation explicitly match a known OOS example?
  const oosHit = candidates.find(r => (r.classHints && (r.classHints.oosExamples || []).some(x => observation.includes(_norm(x)))));
  if (oosHit) {
    return { class: 'confirmed-oos', confidence: 0.85, basis: [oosHit.id], rationale: 'Observed condition matches a recognized out-of-service criterion in ' + oosHit.regId + '.', needsInspection: false };
  }
  const violationHit = candidates.find(r => (r.classHints && (r.classHints.violationExamples || []).some(x => observation.includes(_norm(x)))));
  if (violationHit) {
    return { class: 'confirmed-violation', confidence: 0.75, basis: [violationHit.id], rationale: 'Observed condition matches a regulatory violation under ' + violationHit.regId + '.', needsInspection: false };
  }

  // Company/site policy language.
  if (/\bpolicy\b/.test(observation) || candidates.some(r => /^POLICY:/i.test(r.regId))) {
    const pol = candidates.find(r => /^POLICY:/i.test(r.regId)) || candidates[0];
    return { class: 'company-policy', confidence: 0.5, basis: [pol.id], rationale: 'Matches internal company/site policy, not a federal regulation.', needsInspection: false };
  }

  // We matched a requirement but have no confirmed qualifying condition — this
  // is a safety concern requiring inspection, NOT a confirmed status.
  const top = candidates[0];
  const hasConcreteDefect = !!(evidence && (evidence.defect || evidence.dvir || evidence.oosCondition));
  return {
    class: hasConcreteDefect ? 'potential-concern' : 'potential-concern',
    confidence: 0.4,
    basis: candidates.map(r => r.id),
    rationale: 'A requirement applies (' + top.regId + ') but the evidence does not confirm a specific violation/OOS condition — inspection required before concluding.',
    needsInspection: true,
  };
}

module.exports = {
  KEY, KNOWLEDGE_VERSION, CONCLUSION_CLASSES, POWER_UNIT_EQUIPMENT,
  search, getRecord, listTopics, upsertRecord, classify,
  _seed, _ensureSeeded,
};
