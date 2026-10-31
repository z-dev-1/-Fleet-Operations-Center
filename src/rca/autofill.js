'use strict';
/**
 * rca/autofill.js — build a pre-filled RCA draft for one work order.
 *
 * Sources, most-trusted first:
 *   1. An RCA already saved for this WR in Relay (edit mode — returned as-is).
 *   2. Facts from data the app already has: the stored repair event
 *      (ri_repair_event: vendor, dates, cost, downtime, complaint) and the
 *      unit row the renderer passes in (site, program, SCAC, body type).
 *   3. The live WR detail (comment thread, vendor WO number) from the AAP API.
 *   4. AI (relay.ask) for the judgement fields — VMRS/cause/failure codes and
 *      the complaint/cause/correction text — constrained to the template's own
 *      option lists. Facts from (2) always override AI.
 * The result is a DRAFT for the user to review; nothing is submitted here.
 */

const logger = require('../utils/logger')('rca');
const client = require('./client');
const { normalizeResponse } = require('./template');

const AI_TIMEOUT_MS = 120000;

// ── Rule fallbacks for the two required judgement fields ─────────────────────
// Used only when the AI omitted them (or timed out). Encodes the form's own
// helper text. Tagged 'rule' so the user knows to double-check.
const _DRIVER_RE = /body damage|bumper|fender|hood damage|mirror|air ?lines?\b.*(ripped|torn|pulled|broken|damag)|(ripped|torn|pulled) .*air ?lines?|sidewall|5th wheel (plate|handle)|fifth wheel (plate|handle)|mud ?flap|collision|struck|hit (a|the|by)|backed into|accident|abuse|drained batter|dead batter/i;
const _VENDOR_RE = /previous repair|prior repair|comeback|re-?repair|improper(ly)? (repair|install)|technician error|installed (wrong|incorrect)|not (properly )?torqued|repeat (failure|repair)/i;

function _ruleControllable(values, text) {
  const causes = [].concat(values.primaryCauseCode || [], values.secondaryCauseCode || []).join(' | ');
  if (/Driver\/Operator Abuse|Collision\/Impact|Operator Failure/i.test(causes) || _DRIVER_RE.test(text)) return 'Driver Controllable';
  if (/Technician Error/i.test(causes) || _VENDOR_RE.test(text)) return 'Vendor Controllable';
  return 'Amazon Controllable';
}

// Does the reported complaint mention the system that was coded?
const _SYSTEM_WORDS = {
  '001': /a\/?c|air condition|hvac|heat|vent|blower|defrost/i, '002': /cab|door|window|glass|seat|sheet metal|hood|step/i,
  '003': /gauge|dash|instrument|warning light|cluster|meter/i, '004': /fairing|aero|skirt|side extender/i,
  '011': /axle|front end/i, '012': /axle/i, '013': /brake|abs|slack|chamber|drum|rotor|pad|shoe/i,
  '014': /frame|crossmember/i, '015': /steer|tie rod|drag link|power steering/i, '016': /suspension|air bag|airbag|spring|shock|leaf/i,
  '017': /tire|flat|tread/i, '018': /wheel|rim|hub|bearing|lug/i, '021': /axle/i, '022': /axle|differential|diff/i,
  '023': /clutch/i, '024': /drive ?shaft|u-?joint|driveline/i, '026': /transmission|gear|shift/i, '027': /transmission|gear|shift/i,
  '031': /alternator|charging|batter/i, '032': /start|crank|starter|batter|no.?start/i, '033': /ignition/i,
  '034': /light|lamp|headlight|marker|turn signal|tail ?light|bulb/i, '041': /air intake|air filter|turbo/i,
  '042': /coolant|overheat|radiator|water pump|cooling/i, '043': /exhaust|dpf|def\b|regen|aftertreatment|egr|scr/i,
  '044': /fuel|injector|fuel pump/i, '045': /engine|oil leak|misfire|power loss|check engine/i, '051': /accessor/i,
  '052': /electric|wiring|wire/i, '054': /horn|backup alarm|reverse alarm/i, '059': /5th wheel|fifth wheel|coupling|kingpin|latch/i,
  '143': /cng|natural gas/i, '151': /apu/i,
};
function _ruleDriverDescription(values, complaint) {
  const c = String(complaint || '').trim();
  if (!c) return 'N/A';
  const coded = [].concat(values.systemVmrs3 || [], values.electricalCodes || [], values.engineMotorSystemsCodes || [],
    values.accessoriesCodes || [], values.cabClimateControlInstrumentationAeroCodes || []);
  const codes = coded.map((s) => (String(s).match(/^(\d{3})/) || [])[1]).filter(Boolean);
  if (!codes.length) return null; // nothing coded to compare against — leave for the user
  return codes.some((k) => _SYSTEM_WORDS[k] && _SYSTEM_WORDS[k].test(c)) ? 'Yes' : 'No';
}

function _event(equipmentId, workOrderId) {
  try {
    const store = require('../repair-intel/store');
    const evs = store.eventsForUnit(equipmentId, { includeExcluded: true });
    return evs.find((e) => e.source_id === workOrderId || e.work_order_id === workOrderId || e.service_id === workOrderId) || null;
  } catch (e) { logger.warn('[rca] repair event lookup failed: ' + e.message); return null; }
}

// ISO-8601 week number of a date, clamped to the form's 1..52 options.
function _weekNumber(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return String(Math.min(52, Math.max(1, wk)));
}

function _assetType(unit) {
  const hay = [unit.bodyType, unit.assetType].filter(Boolean).join(' ').toLowerCase();
  if (/hostler|yard\s*(tractor|truck|dog)|spotter/.test(hay)) return 'Hostler';
  if (/box/.test(hay)) return 'Box truck';
  if (/tractor|sleeper|day\s*cab/.test(hay)) return 'Tractor';
  return null;
}

function _fuelType(unit) {
  const hay = [unit.fuelType, unit.engineManufacturer, unit.manufacturer, unit.model, unit.bodyType].filter(Boolean).join(' ').toLowerCase();
  if (/\bcng\b|natural gas|\bnat ?gas\b/.test(hay)) return 'CNG';
  if (/\bev\b|electric|\bbyd\b|tesla|rizon|e-?cascadia|lion/.test(hay)) return 'EV';
  return null;
}

function _program(unit) {
  const p = String(unit.program || '').trim();
  if (!p) return null;
  if (/solo\s*-?\s*1|solo1/i.test(p)) return 'AFP Solo 1';
  if (/solo\s*-?\s*2|solo2/i.test(p)) return 'AFP Solo 2';
  if (/\bdsp\b/i.test(p)) return 'DSP';
  if (/^tom\s*-\s*\S/i.test(p)) return p; // already a form option, e.g. "TOM - SoCal"
  return null; // unmapped AAP program code (e.g. "vupAfp") — left for AI/user
}

function _vendor(ev, unit) {
  const v = String((ev && ev.vendor) || unit.vendor || '').trim();
  if (!v) return null;
  const map = [
    [/amerit/i, 'Amerit'], [/\bcox\b/i, 'COX'], [/fleet\s*pride/i, 'FleetPride'], [/kooner/i, 'Kooner'],
    [/^ta\b|travel\s*cent|\bpetro\b|ta\s*truck/i, 'TA'], [/\bfna\b/i, 'FNA'], [/velocit/i, 'VELOCITI'],
    [/good\s*year/i, 'GoodYear'], [/\bbyd\b/i, 'BYD'], [/cummins/i, 'Cummins'], [/dsp\s*managed/i, 'DSP Managed'],
  ];
  for (const [re, opt] of map) if (re.test(v)) return opt;
  if (ev && ev.wo_type === 'dealer') return 'Dealer';
  return null; // unknown vendor -> left for AI / the user
}

function _hours(ms) {
  if (ms == null || isNaN(ms) || ms <= 0) return null;
  return (ms / 3600000).toFixed(2);
}

async function _serviceDetail(workOrderId) {
  try {
    const aapApi = require('../scrapers/aap_api');
    return await aapApi.getService(workOrderId);
  } catch (e) { logger.warn('[rca] WR detail fetch failed: ' + e.message); return null; }
}

function _commentsText(detail) {
  if (!detail) return '';
  try {
    const mapper = require('../scrapers/aap_api_mapper');
    return mapper.commentsToTimeline(mapper.collectAllComments(detail), { includeInternal: true }) || '';
  } catch (_) { return ''; }
}

// ── AAP record extractors (field paths confirmed from live dumps 2026-10-27) ──
//   asset.attributesText.{fuelType:"DIESEL", program:"vupAfp", owner:<SCAC>,
//     operator, domicileSite}, asset.assetType:"tractor",
//   maintenanceScheduleStatuses[]{maintenanceType:"PM_A"|"PM_B"|"DOT"|"WASH",
//     lastCompletedDateTime}
//   service.{vendor, completedDateTime, vendorWorkOrderIds[]},
//     service.workOrders[]{vendorWorkOrderId, estimate.totalCost}
async function _assetDetail(aaid) {
  if (!aaid) return null;
  try { return await require('../scrapers/aap_api').getAsset(aaid); }
  catch (e) { logger.warn('[rca] asset fetch failed: ' + e.message); return null; }
}

function _fuelFromAsset(asset) {
  const f = String((asset && asset.asset && asset.asset.attributesText && asset.asset.attributesText.fuelType) || '').toUpperCase();
  if (!f) return null;
  if (/CNG|NATURAL|LNG|RNG/.test(f)) return 'CNG';
  if (/ELECTRIC|BEV|\bEV\b|BATTERY/.test(f)) return 'EV';
  if (/DIESEL|GAS|RD\b|RENEWABLE/.test(f)) return 'Diesel';
  return null;
}

function _assetTypeFromAsset(asset) {
  const t = String((asset && asset.asset && asset.asset.assetType) || '').toLowerCase();
  if (/hostler|yard/.test(t)) return 'Hostler';
  if (/box/.test(t)) return 'Box truck';
  if (/tractor/.test(t)) return 'Tractor';
  return null;
}

// Most recent PM (PM_A / PM_B / ...) completed on or before the repair; DOT,
// wash and inspections are not PMs.
function _lastPmDate(asset, beforeMs) {
  const list = (asset && Array.isArray(asset.maintenanceScheduleStatuses)) ? asset.maintenanceScheduleStatuses : [];
  const pms = list
    .filter((m) => m && /^PM/i.test(String(m.maintenanceType || '')) && Number(m.lastCompletedDateTime) > 0)
    .map((m) => Number(m.lastCompletedDateTime));
  if (!pms.length) return null;
  const limit = beforeMs ? beforeMs + 86400000 : Infinity;
  const before = pms.filter((t) => t <= limit);
  return Math.max.apply(null, before.length ? before : pms);
}

// Total cost = sum of the work orders' estimate totals (what AAP shows on the WR).
function _totalCost(detail) {
  const wos = (detail && Array.isArray(detail.workOrders)) ? detail.workOrders : [];
  let sum = 0, any = false;
  for (const w of wos) {
    const t = w && w.estimate && Number(w.estimate.totalCost);
    if (t && !isNaN(t) && t > 0) { sum += t; any = true; }
  }
  return any ? sum.toFixed(2) : null;
}

function _vendorWoNumber(detail, unit, workOrderId) {
  const wos = (detail && Array.isArray(detail.workOrders)) ? detail.workOrders : [];
  for (const w of wos) if (w && w.vendorWorkOrderId) return String(w.vendorWorkOrderId);
  const pools = [detail && detail.vendorWorkOrderIds, detail && detail.workRequest && detail.workRequest.vendorWorkOrderIds];
  for (const p of pools) if (Array.isArray(p) && p.length && p[0]) return String(p[0]);
  if (unit && unit.vendorWorkOrderId && (unit.workRequestId === workOrderId || unit._serviceId === workOrderId)) {
    return String(unit.vendorWorkOrderId).split(/\s*;\s*/)[0];
  }
  return null;
}

function _fieldSpec(f) {
  const parts = ['- ' + f.propertyName + ' (' + (f.displayName || '') + ') type=' + f.fieldType +
    (f.allowsMultiple ? ' MULTI' : '') + (f.required === false ? ' optional' : ' required')];
  if (f.dependsOn) parts.push('  only when ' + JSON.stringify(f.dependsOn));
  if (Array.isArray(f.selectOptions)) parts.push('  options: ' + JSON.stringify(f.selectOptions));
  if (f.helperText) parts.push('  hint: ' + String(f.helperText).replace(/\s+/g, ' ').slice(0, 240));
  return parts.join('\n');
}

function _parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
}

async function _aiFill(template, facts, commentsText, ev) {
  let relay;
  try { relay = require('../orcha/relay'); } catch (_) { return { values: {}, error: 'AI unavailable' }; }
  if (!relay || !relay.ask) return { values: {}, error: 'AI unavailable' };
  const fields = template.fields.filter((f) => f && f.propertyName && !/^text(Header|Body)Label$/.test(f.fieldType));
  const prompt =
    'You are filling Amazon fleet maintenance\'s "Root Cause Analysis" form for ONE completed truck work order.\n' +
    'Return ONLY a JSON object keyed by propertyName. Rules:\n' +
    '- For select fields use option strings EXACTLY as listed; MULTI fields are JSON arrays; single fields are one string.\n' +
    '- booleanInput fields are true/false. Dates are "YYYY-MM-DD". Number fields are plain numbers like "125.50".\n' +
    '- Ground every value in the facts and work-order thread below. Do NOT invent parts, costs, dates or causes.\n' +
    '- If something is not supported by the evidence, omit that key (the user fills it in).\n' +
    '- complaint = the defect originally reported; cause = what the tech found as root cause; correction = the work done. One or two plain sentences each, no names.\n' +
    '- Pick VMRS/system codes, technician failure codes and cause codes that match the actual failure.\n' +
    '- ALWAYS answer "controllable" and "driverDescription" (never omit them):\n' +
    '  controllable: "Driver Controllable" if the damage was driver-caused — body damage, damaged mirrors, air lines ripped off, tire sidewall damage, 5th wheel plate or handle damage, damaged mud flaps, drained batteries installed in the past 6 months, collisions or abuse; ' +
    '"Vendor Controllable" if a 3rd-party vendor is responsible (improper or failed previous repair, technician error); otherwise "Amazon Controllable" (normal wear, component failure, PM gap/quality, design or manufacturing defect).\n' +
    '  driverDescription: "Yes" if the originally reported complaint (driver/DVIR description) matches the system you coded, "No" if it describes a different system or problem, "N/A" if there is no driver-reported complaint.\n\n' +
    'FORM FIELDS:\n' + fields.map(_fieldSpec).join('\n') + '\n\n' +
    'KNOWN FACTS (already filled, you may omit these):\n' + JSON.stringify(facts) + '\n\n' +
    'REPAIR RECORD:\n' + JSON.stringify({
      vendor: ev && ev.vendor, category: ev && ev.repair_category, component: ev && ev.repair_component,
      subcategory: ev && ev.repair_subcategory, reportedComplaint: ev && ev.reported_complaint,
      suspectedRootCause: ev && ev.suspected_root_cause, correctiveActions: ev && ev.corrective_actions,
      woType: ev && ev.wo_type, status: ev && ev.status, estimateCost: ev && ev.estimate_cost,
    }) + '\n\n' +
    'WORK ORDER THREAD (oldest first):\n' + (commentsText ? commentsText.slice(-9000) : '(none)') + '\n';
  try {
    const txt = await Promise.race([
      relay.ask(prompt),
      new Promise((res) => setTimeout(() => res(''), AI_TIMEOUT_MS)),
    ]);
    const parsed = _parseJson(txt);
    if (!parsed) return { values: {}, error: txt ? 'AI reply was not JSON' : 'AI timed out' };
    return { values: parsed };
  } catch (e) {
    return { values: {}, error: 'AI failed: ' + e.message };
  }
}

// moment().week() in moment's default "en" locale (weeks start Sunday; week 1
// is the week containing Jan 1) — exactly what AAP uses for weekNumber.
function _momentWeek(d) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sunday = new Date(day); sunday.setDate(day.getDate() - day.getDay());
  const sat = new Date(sunday); sat.setDate(sunday.getDate() + 6);
  // The week belongs to the year of its Saturday (the week holding Jan 1 is week 1).
  const year = sat.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const firstSunday = new Date(jan1); firstSunday.setDate(1 - jan1.getDay());
  return Math.round((sunday - firstSunday) / (7 * 86400000)) + 1;
}

// Most recent PM schedule entry (maintenanceType contains "PM") — AAP passes
// its lastCompletedDateTime through unchanged.
function _lastPmRaw(asset) {
  const list = (asset && Array.isArray(asset.maintenanceScheduleStatuses)) ? asset.maintenanceScheduleStatuses : [];
  const pms = list.filter((m) => m && String(m.maintenanceType || '').includes('PM') && m.lastCompletedDateTime != null);
  if (!pms.length) return undefined;
  pms.sort((a, b) => Number(b.lastCompletedDateTime) - Number(a.lastCompletedDateTime));
  return pms[0].lastCompletedDateTime;
}

/**
 * computePrefill(workOrderId, vendorWorkOrderId) — the exact `predefinedFields`
 * AAP's Custom Forms tab passes into the RCA form (from AAP's app bundle,
 * eFYEg6Gxy$pwO5l.js, 2026-10-27). Values are AAP's RAW record values — AAP
 * does not map them to the form's options (e.g. "tractor", "DIESEL",
 * "vupAfp"), the form shows + submits them as-is and locks those fields.
 *   aaid, assetType, dateOfLastPMPerformed, fuelType ("N/A" if none), program,
 *   scac (= attributesText.operator), site (= workRequest.reportedLocation.code),
 *   totalCostOfWorkOrder, vehicleId (= attributesText.vehicleId), vendor,
 *   weekNumber (CURRENT week), workOrderCompletionDate, workOrderNumber,
 *   workOrderId, workRequestId
 * The work-order-scoped fields come from the WR's work order whose
 * vendorWorkOrderId is selected (AAP: "Work order for auto-populating fields").
 * Returns { prefill, workOrders:[{id,vendorWorkOrderId}], selected, detail, asset }.
 */
async function computePrefill(workOrderId, vendorWorkOrderId) {
  const detail = await _serviceDetail(workOrderId);
  if (!detail) throw new Error('Could not load the WR from AAP');
  const asset = await _assetDetail(detail.aaid);
  const at = (asset && asset.asset && asset.asset.attributesText) || {};
  const wos = Array.isArray(detail.workOrders) ? detail.workOrders : [];
  const workOrders = wos.filter((w) => w && w.vendorWorkOrderId).map((w) => ({ id: w.id, vendorWorkOrderId: String(w.vendorWorkOrderId) }));
  const selected = vendorWorkOrderId && workOrders.some((w) => w.vendorWorkOrderId === String(vendorWorkOrderId))
    ? String(vendorWorkOrderId)
    : (workOrders[0] ? workOrders[0].vendorWorkOrderId : null);
  const ve = selected ? wos.find((w) => w && String(w.vendorWorkOrderId) === selected) : null;

  const raw = {
    aaid: detail.aaid,
    assetType: asset && asset.asset && asset.asset.assetType,
    dateOfLastPMPerformed: _lastPmRaw(asset),
    fuelType: asset ? (at.fuelType || 'N/A') : undefined,
    program: at.program,
    scac: at.operator,
    site: detail.workRequest && detail.workRequest.reportedLocation && detail.workRequest.reportedLocation.code,
    totalCostOfWorkOrder: ve && ve.estimate ? ve.estimate.totalCost : undefined,
    vehicleId: at.vehicleId,
    vendor: detail.vendor,
    weekNumber: String(_momentWeek(new Date())),
    workOrderCompletionDate: ve ? ve.actualCompletionDateTime : undefined,
    workOrderNumber: ve ? ve.vendorWorkOrderId : undefined,
    workOrderId: ve ? ve.id : undefined,
    workRequestId: detail.workRequest && detail.workRequest.id,
  };
  // AAP treats a field as prefilled (locked) when its value != undefined/null.
  const prefill = {};
  Object.keys(raw).forEach((k) => { if (raw[k] != null) prefill[k] = raw[k]; });
  return { prefill, workOrders, selected, detail, asset };
}

/**
 * buildDraft({ equipmentId, workOrderId, vendorWorkOrderId, unit }) -> {
 *   ok, template, values, sources: { field: 'aap'|'saved'|'data'|'ai'|'default' },
 *   locked: [field...], workOrders, selectedWorkOrder,
 *   existing: { responseId } | null, warnings, aiError
 * }
 * AAP's prefilled fields are copied exactly and locked; the AI only fills the rest.
 */
async function buildDraft(args) {
  const equipmentId = String((args && args.equipmentId) || '').trim();
  const workOrderId = String((args && args.workOrderId) || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(workOrderId)) return { ok: false, error: 'Invalid work order id' };

  const template = await client.getTemplate();
  const { prefill, workOrders, selected, detail, asset } = await computePrefill(workOrderId, args && args.vendorWorkOrderId);
  const fieldNames = new Set(template.fields.map((f) => f.propertyName));
  const locked = Object.keys(prefill).filter((k) => fieldNames.has(k));
  const base = { ok: true, template, locked, workOrders, selectedWorkOrder: selected };

  // 1) An RCA already saved for THIS work order -> edit mode with its answers
  //    (AAP keeps one RCA per work order, matched on response.workOrderNumber).
  let existing = null;
  try { existing = await client.findRcaResponse(workOrderId, { workOrderNumber: selected }); }
  catch (e) { logger.warn('[rca] saved-response lookup failed: ' + e.message); }
  if (existing && existing.response) {
    const sources = {};
    Object.keys(existing.response).forEach((k) => { sources[k] = 'saved'; });
    locked.forEach((k) => { sources[k] = 'aap'; });
    return Object.assign(base, { values: Object.assign({}, existing.response, prefill), sources,
      existing: { responseId: client.responseIdOf(existing) }, warnings: [], aiError: null });
  }

  // 2) Extra facts for the non-prefilled fields (stored repair event).
  const ev = _event(equipmentId, workOrderId);
  const facts = {};
  const put = (k, v) => { if (v != null && v !== '' && !(k in facts) && !(k in prefill)) facts[k] = v; };
  const _ms = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Date.parse(v); return isNaN(n) ? null : n; };
  const completedAt = _ms(prefill.workOrderCompletionDate) || _ms(detail.completedDateTime) || (ev && ev.repair_completed_at) || null;
  const reportedAt = (ev && ev.reported_at) || _ms(detail.createdDateTime) || null;
  if (ev && ev.wo_type === 'dealer') put('dealOrOemRepair', true);
  put('downtimeHours', _hours((ev && ev.total_elapsed_ms) || (completedAt && reportedAt ? completedAt - reportedAt : null)));
  put('complaint', ev && ev.reported_complaint);
  put('complaint', detail.workRequest && detail.workRequest.damageDescription);
  // Only when AAP has no value for them (otherwise they are prefilled above).
  put('dateOfLastPMPerformed', _lastPmDate(asset, completedAt));
  put('totalCostOfWorkOrder', _totalCost(detail));

  // 3) AI for the judgement fields (codes, cause/correction text).
  const known = Object.assign({}, prefill, facts);
  const ai = await _aiFill(template, known, _commentsText(detail), ev);
  const aiVals = {};
  Object.keys(ai.values || {}).forEach((k) => { if (!(k in prefill)) aiVals[k] = ai.values[k]; });

  const free = Object.assign({}, aiVals, facts);
  const sources = {};
  Object.keys(aiVals).forEach((k) => { sources[k] = 'ai'; });
  Object.keys(facts).forEach((k) => { sources[k] = 'data'; });
  if (!('totalCostOfWorkOrder' in prefill) && (free.totalCostOfWorkOrder == null || free.totalCostOfWorkOrder === '')) {
    free.totalCostOfWorkOrder = '0.00'; sources.totalCostOfWorkOrder = 'default'; // form: "enter 0.00" when none
  }

  // Normalize only the free fields; prefilled ones stay exactly as AAP sends them.
  const norm = normalizeResponse(template, free, { requireAll: false });
  // Required judgement fields the AI skipped (or timed out on) -> rule fallback.
  const r = norm.response;
  const evidence = [r.complaint, r.cause, r.correction, ev && ev.reported_complaint, ev && ev.suspected_root_cause,
    ev && ev.corrective_actions].filter(Boolean).join(' \n ');
  if (!r.controllable && !('controllable' in prefill)) { r.controllable = _ruleControllable(r, evidence); sources.controllable = 'rule'; }
  if (!r.driverDescription && !('driverDescription' in prefill)) {
    const dd = _ruleDriverDescription(r, (ev && ev.reported_complaint) || (detail.workRequest && detail.workRequest.damageDescription) || r.complaint);
    if (dd) { r.driverDescription = dd; sources.driverDescription = 'rule'; }
  }
  Object.keys(sources).forEach((k) => { if (!(k in norm.response)) delete sources[k]; });
  locked.forEach((k) => { sources[k] = 'aap'; });
  const values = Object.assign({}, norm.response, prefill);
  logger.info('[rca] draft for ' + equipmentId + ' WR ' + workOrderId + ' WO ' + (selected || '-') + ': ' +
    locked.length + ' AAP-prefilled, ' + Object.keys(aiVals).length + ' AI' + (ai.error ? ' — ' + ai.error : ''));
  return Object.assign(base, { values, sources, existing: null, warnings: norm.warnings, aiError: ai.error || null });
}

module.exports = { buildDraft, computePrefill, _ruleControllable, _ruleDriverDescription, _momentWeek, _lastPmRaw, _weekNumber, _assetType, _fuelType, _vendor, _program };
