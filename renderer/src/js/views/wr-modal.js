/**
 * wr-modal.js — Work Request creation modal (Stage 11)
 *
 * Usage:
 *   import { open as openWRModal } from './wr-modal.js';
 *   openWRModal(unit);
 *
 * Flow:
 *   1. User opens modal from unit-detail "Create WR" button.
 *   2. Modal pre-fills from unit state (PM banner, risk tier, insights).
 *   3. User fills vendor, urgency, area pairs, comments, contact.
 *   4. Submit → aap.createWR(payload, unit) [API-direct, re-entrancy locked].
 *      On failure offers fallback → aap.autofill(url, payload) [browser window].
 *   5. Progress log streams via wr:progress IPC push (onWRProgress).
 *   6. On success: shows WR ID + open-in-AAP link → auto-close after 4s.
 *
 * Screenshot attach:
 *   files.getLatestScreenshot() → files.readAsDataUrl(path) → embedded in payload.
 */

import { aap, files, relay } from '../bridge.js';
import bus from '../bus.js';
import toast           from '../components/toast.js';
import { open as openDealerWOModal } from './dealer-wo-modal.js';

// ── Vendor list (mirrors aap_create_wr.js VENDOR_IDS) ─────────────────────
const VENDORS = [
  'COX',
  'AMERIT',
  'Volvo (ASIST)',
  'Kenworth (PACCAR)',
  'Peterbilt (PACCAR)',
  'KWNE (Kenworth NE)',
  'Freightliner (DAIMLER)',
  'Cummins',
  'TA',
  'Velociti',
  'FleetNet (FLEETNET)',
  'Ryder (RENTAL)',
  'Penske (RENTAL)',
  'GOODYEAR',
  'KOONER',
];

const URGENCY_REASONS = [
  'DEA - Asset Shortage',
  'Safety',
  'Compliance',
  'Customer Impact',
  'Regulatory',
  'Other',
];

// FEATURE (2026-07-22): added "TIRES" key -- was missing from this list
// entirely (confirmed live: the real AAP wizard's Work Area dropdown does
// have a Tires option, this composer's own datalist/AI-Fill area knowledge
// just never included it). Values are the real tire position options from
// the live AAP page (per user-provided screenshots), used here as the
// Sub Area/"Select Tire Position" equivalent. Live AAP also shows a
// separate "Tire Size" dropdown when Tires is selected -- per the user,
// that one should always just take its first/default option
// (295/75R22.5), so it's not modeled as a data field here; see the
// corresponding instruction added to aap_wizard_knowledge.js instead.
const AREA_SUBS = {"BODY":["AIR FILTERS","BATTERY BOX","BODY CAB COMPONENTS","BODY COMPONENTS","BRACKET","BULKHEAD","BUMPER ASSEMBLY","CAB","CARGO BOX","CARGO RESTRAINT","CORNER CAP ASSEMBLY","COWL ASSEMBLY","DEFLECTOR","EXTERIOR LIGHTS","EXTERIOR PANEL ASSEMBLY","FAIRINGS","FASTENERS","FLOOR ASSEMBLY","FRAME ASSEMBLY","GLASS ASSEMBLY","HOOD","INTERIOR TRIM","MIRRORS AND VISOR","MUD FLAPS","ROLL-UP DOOR","ROOF ASSEMBLY","RUNNING BOARDS","SEAT ASSEMBLY","SIDE DOOR ASSEMBLY","TAILGATE","WINDSHIELD","WIPER SYSTEM"],"BRAKES":["AIR BRAKE ASSEMBLY","AIR COMPRESSOR","AIR HOSE ASSEMBLY","AIR TANK ASSEMBLY","AIR VALVE ASSEMBLY","ANTILOCK ASSEMBLY","AXLE BRAKES","BRAKE CHAMBER","BRAKE LINES AND FITTINGS","DRAIN VALVE","ELECTRIC BRAKES ASSEMBLY","GLADHAND ASSEMBLY","HYDRAULIC BRAKE ASSEMBLY","MASTER BRAKE CYLINDER ASSEMBLY","PARKING BRAKE ASSEMBLY","PEDAL ASSEMBLY","POWER BRAKE ASSEMBLY"],"CHASSIS":["ADJUSTER","CHASSIS ASSEMBLY","IDLER","LUBRICATION ASSEMBLY","RESERVOIR AND LINES","ROLLER","TRACK","UNDERCARRIAGE","WHEEL END DISCONNECT ASSEMBLY"],"CHECK ENGINE LIGHT":["CEL AIR TEMPERATURE","CEL AMBIENT TEMPERATURE","CEL BOOST PRESSURE","CEL CAMSHAFT POSITION","CEL COOLANT TEMPERATURE","CEL CRANKCASE PRESSURE","CEL ENGINE POSITION","CEL FUEL PRESSURE","CEL FUEL TEMPERATURE","CEL IDLE","CEL MANIFOLD PRESSURE","CEL MASS AIR FLOW","CEL OIL TEMPERATURE","CEL OVERALL ISSUE","CEL OXYGEN ISSUE","CEL OXYGEN SENSOR","CEL SENSOR KNOCK","CEL SPEED"],"DEVICE INSTALLATION":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DEVICE REMOVAL":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DEVICE REPLACMENT":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DOORS":["DOOR ASSEMBLY","DOOR HINGE ASSEMBLY","SODE DOOR COMPONENT"],"DRIVETRAIN":["AIR CYLINDERS","AUXILIARY ASSEMBLY","AXLE","CHAIN DRIVE","DIFFERENTIAL","DRIVETRAIN ASSEMBLY","FINAL DRIVE ASSEMBLY","GEARS AND BEARINGS","MANIFOLD","PARKING LOCK ASSEMBLY","RETARDER","SHAFT","SHAFT ASSEMBLY","TRANSFER CASE"],"ELECTRICAL":["ADAS","ALTERNATOR ASSEMBLY","BACKUP WARNING SYSTEM","BATTERIES AND CABLES","BULBS, FUSES","CHARGING SYSTEM","DISTRIBUTOR ASSEMBLY","ECU","EV CHARGING SYSTEM","ELECTRICAL SYSTEM","GPS TRACKING","HORN, ANTI-THEFT","IGNITION SYSTEM","INSTRUMENT CLUSTER","LIGHTING SYSTEM","MODULES","OIL PRESSURE WARNING","PRE-HEATER","REGULATOR","SENSOR","SENSORS","SHUTDOWN DEVICES","SOLENOID","STARTER ASSEMBLY","SURVEILLANCE SYSTEM","SWITCHES","WARNING INDICATORS","WIRE HARDNESS"],"ENGINE":["AIR CLEANER","AIR INTAKE","BATTERY ASSEMBLY","CAMSHAFT ASSEMBLY","CARBURETOR","COOLANT","COOLING SYSTEM","CRANKCASE ASSEMBLY","CRANKSHAFT ASSEMBLY","CYLINDER BLOCK ASSEMBLY","DEF ASSEMBLY","ELECTRIC MOTOR ASSEMBLY","ELECTRONIC ENGINE CONTROLS","ENGINE ASSEMBLY","ENGINE SHUTDOWN","FILTERS","FLYWHEEL","INJECTOR","OIL FILTER ASSEMBLY","OIL PAN ASSEMBLY","OIL PUMP ASSEMBLY","PISTONS AND RINGS ASSEMBLY","RADIATOR","RETARDER ASSEMBLY","SPEED CONTROL SYSTEM","THROTTLE BODY","TIMING ASSEMBLY","WATER PUMP"],"EXHAUST":["EXHAUST SYSTEM","MUFFLER EXHAUST PIPE ASSEMBLY"],"FIFTH WHEEL":["FIFTH WHEEL COMPONENTS"],"FUEL":["EVAPORATIVE CONTROL SYSTEM","FUEL PUMP","FUEL TANK SYSTEM","HEATER ASSEMBLY","INJECTORS","TANK ASSEMBLY"],"HVAC":["AIR CONDITIONING","BELTS","DEFROSTER","HVAC ASSEMBLY","HEATING"],"INTERIOR":["AIR BAGS AND INTERIOR SAFETY EQUIPMENT","CAB ACCESSORIES","DISPLAYS AND SIGNS","INSTRUMENT PANEL","INTERIOR PANELS","LIGHTS","MOLDINGS","SLEEPER COMPONENTS"],"SUSPENTION":["ACTIVE SUSPENSION ASSEMBLY","AIR SPRING ASSEMBLY","AIR SUSPENSION ASSEMBLY","FRONT SUSPENSION ASSEMBLY","REAR SUSPENSION ASSEMBLY","RIDE HEIGHT ASSEMBLY","SHOCK ABSORBERS","SLEEPER SUSPENSION","SPRINGS ASSEMBLY","STABILIZER ASSEMBLY","STRUTS ASSEMBLY","SUSPENSION ASSEMBLY","TANDEM SUSPENSION ASSEMBLY"],"TIRES":["Drive Left Front Inside","Drive Left Front Outside","Drive Left Rear Inside","Drive Left Rear Outside","Drive Right Front Inside","Drive Right Front Outside","Drive Right Rear Inside","Drive Right Rear Outside","Steer Left","Steer Right"],"TOW":["MECHANICAL ISSUE","IMPOUND","ABANDONED EQUIPMENT","ACCIDENT/RECOVERY"],"TRANSMISSION":["CVT","CLUTCH","CONVERTER","ELECTRIC VEHICLE","MANUAL TRANSMISSION","SERVO ASSEMBLY","SOLENOID ASSEMBLY","TORQUE ASSEMBLY","TRANSMISSION ASSEMBLY","TRANSMISSION BRAKE","TRANSMISSION CASE","TRANSMISSION COVER","TRANSMISSION EXTERNAL CONTROL","TRANSMISSION OIL PUMP ASSEMBLY","TRANSMISSION PUMP","TRANSMISSION SPLITTER","VALVE BIDY"]};
// ── Live AVM lookups (cascading category dropdowns) ─────────────────────────
// The Component-Area rows are three cascading <select>s — Category (L1) ->
// Sub-category (L2) -> Sub-sub-category (L3) — populated LIVE from AAP's
// avmCodes tree (window.aapApi.avmTree) so they always match the real wizard.
// Option VALUE = AAP code, LABEL = displayName. L3 only shows for L2 codes that
// actually have children (e.g. Tires); it stays hidden otherwise.
//
// TOW is special: it is NOT an avmCode but the tow flow (AI Fill, the tow tab)
// needs it to keep working, so we inject a synthetic TOW L1 option + its reason
// list as L2 so a user can still pick TOW manually and the submit passes it
// straight through (level1:'TOW', level2:<reason>).
const TOW_L1_CODE = 'TOW';
const TOW_REASONS = AREA_SUBS.TOW || ['MECHANICAL ISSUE', 'IMPOUND', 'ABANDONED EQUIPMENT', 'ACCIDENT/RECOVERY'];

// Derive the avmCodes equipmentType token from a unit's body/asset fields,
// mirroring aap_api.js avmTypeFor (there is no renderer avmTypeFor — this is
// the renderer-side equivalent). box -> 'boxTruck'; tractor/sleeper/day cab ->
// 'tractor'; anything else -> 'boxTruck' (a usable default). Exported for tests.
export function avmTypeForUnit(unit) {
  const u = unit || {};
  const hay = [u.bodyType, u.assetType, u.assetDefinitionKey, u.equipmentType, u.type]
    .filter(Boolean).join(' ').toLowerCase();
  if (/box/.test(hay)) return 'boxTruck';
  if (/tractor|sleeper|day\s*cab|daycab/.test(hay)) return 'tractor';
  return 'boxTruck';
}

// Build the <option> list for a cascading select from an array of
// {code,displayName} items, pre-selecting `selected` (a code) when present.
// Exported for tests. `placeholder` is the empty-value first option label.
export function avmOptionsHtml(items, selected, placeholder) {
  const opts = ['<option value="">' + _safe(placeholder || '-- Select --') + '</option>'];
  for (const it of (items || [])) {
    const code = (it && it.code != null) ? String(it.code) : '';
    const name = (it && (it.displayName || it.code)) || '';
    const sel = (selected != null && String(selected) === code) ? ' selected' : '';
    opts.push('<option value="' + _safeAttr(code) + '"' + sel + '>' + _safe(name) + '</option>');
  }
  return opts.join('');
}

// Normalize collected area rows into the submit payload shape, dropping empty
// rows and keeping TOW as a passthrough. Each row in -> {area, subcategory,
// subSubcategory} with codes; TOW rows pass straight through (not avmCodes).
// Exported for tests (the payload-shape proof).
export function buildAreaPairsPayload(rows) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r) continue;
    const area = String(r.area || '').trim();
    const sub = String(r.subcategory || '').trim();
    const subSub = String(r.subSubcategory || '').trim();
    if (!area && !sub) continue;
    out.push({ area, subcategory: sub, subSubcategory: subSub });
  }
  return out;
}

// ── Module state ──────────────────────────────────────────────────────────
let _overlay   = null;
let _unit      = null;
let _areaCount = 1;
// Live AVM tree + vendor list, fetched once per modal-open and cached on the
// module so cascading is instant (no refetch per row). _avmTree is the parsed
// { l1, l2ByParent, l3ByParent, reasons } from window.aapApi.avmTree.
let _avmTree   = null;
let _vendorList = null; // [{vendorName, wrEnabled, ...}] from window.aapApi.vendors
// FEATURE: live AAP VRE vendor recommendation for THIS unit, fetched once per
// modal-open via a Phase-1 (commit-nothing) createWorkOrder call. Shape:
// { ok, phase:'recommend', recommendation:{ vendor, ruleName, autoAssignable, vendors:[...] } }.
// null until the on-open recommendation lands (or stays null when offline / no assetUrl).
let _vreRec    = null;
let _progUnsub = null;
let _towAddrUnsub = null; // BUG FIX (2026-07-16): see _wireTow() below
let _attachments = []; // FEATURE (2026-07-23): [{name, dataUrl}] -- auto-attach + manual + drag-drop
// Tow orchestration plan, set by _runAIAssist when it detects a tow-to-dealer
// scenario. When present, Submit runs the multi-WR flow (repair + tow (+ dealer
// WO)) via deterministic aap.createWR with auto-submit, instead of the single
// AI-wizard runAdaptive path. Cleared after each submit.
let _towPlan = null; // { isTow, towDirection, dealer: <vendor contact>, dealerName }
// Multi-tab state for a tow-to-dealer request. ONE shared form; the tab bar
// just swaps which work-order's data is loaded into it (snapshot current tab
// -> load target tab), so no DOM/fields are duplicated and the no-dealer
// single-WR path is completely untouched when this is null.
//   { active: 'repair'|'tow', repair: {...fields}, tow: {...fields},
//     submitted: { repair: null|{workRequestId}, tow: null|{workRequestId} },
//     rgIntegrated, dealerName, hasRepair }
let _wrTabState = null;
let _copyFromWrId = null; // set by the "+ 2nd WR (reuse data)" flow -> AAP copiedFromWorkRequestId
// "Set unit to Unavailable after the WR is created". Flips at most ONCE per
// modal-open (a repair + tow pair should not flip twice).
let _flipDone = false;
let _flipReasonTouched = false; // user picked a reason → stop auto-suggesting

// ── Flip-to-Unavailable after WR create ────────────────────────────────────
const _FLIP_LABELS = {
  DAMAGED_MODERATE: 'Damaged - Moderate', OFFSITE_SHOP_REPAIR: 'Off-site Shop Repair',
  PARTS_DELAY: 'Parts Delay', PM_FAILED: 'PM Failed', PREVENTATIVE_MAINTENANCE: 'Preventative Maintenance',
  SENSOR_DETECTED_DAMAGE: 'Sensor Detected Damage', SAFETY_INSPECTION_POST_ACCIDENT: 'Safety Inspection Post Accident',
  LICENSE_OR_PERMIT_ISSUE: 'License or Permit Issue', IMPOUNDED_TOW: 'Impounded / Tow',
  GPS_MALFUNCTIONING: 'GPS Malfunctioning', CAMPAIGN: 'Campaign',
};

function _unitLifecycle(unit) {
  const u = unit || {};
  return {
    state: String(u.lifecycleState || u.atsState || '').trim(),
    reason: String(u.lifecycleReason || u.lifecycleStateReason || u.relayStatus || '').trim(),
  };
}

// Suggest a reason from the WR text. Most WRs are damage, so that's the default;
// only clear-cut keywords pick something else. Never overrides a manual pick.
export function suggestFlipReason(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(pm|preventative|preventive)\b/.test(t) && !/\bpm fail/.test(t)) return 'PREVENTATIVE_MAINTENANCE';
  if (/\bpm fail(ed)?\b/.test(t)) return 'PM_FAILED';
  if (/\b(recall|campaign)\b/.test(t)) return 'CAMPAIGN';
  if (/\b(accident|collision)\b/.test(t)) return 'SAFETY_INSPECTION_POST_ACCIDENT';
  if (/\b(registration|permit|license|plate)\b/.test(t)) return 'LICENSE_OR_PERMIT_ISSUE';
  if (/\bgps\b/.test(t)) return 'GPS_MALFUNCTIONING';
  return 'DAMAGED_MODERATE';
}

function _initFlipUI(unit) {
  _flipDone = false;
  _flipReasonTouched = false;
  const cb = _el('wr-flip-unavail');
  const sel = _el('wr-flip-reason');
  const note = _el('wr-flip-note');
  if (!cb || !sel) return;
  const lc = _unitLifecycle(unit);
  const alreadyDown = /unavail/i.test(lc.state);
  // Already Unavailable → default OFF (no point changing a reason by accident).
  cb.checked = !alreadyDown;
  if (note) {
    note.textContent = lc.state
      ? ('Currently ' + lc.state + (lc.reason ? ' - ' + lc.reason : '') + (alreadyDown ? ' (left unchecked)' : ''))
      : 'Current AAP status unknown';
  }
  if (!unit || !unit.assetUrl) {
    cb.checked = false; cb.disabled = true;
    if (note) note.textContent = 'No AAP asset link for this unit — status flip unavailable (run a sync).';
  }
  sel.disabled = !cb.checked;
  cb.addEventListener('change', () => { sel.disabled = !cb.checked; });
  sel.addEventListener('change', () => { _flipReasonTouched = true; });
  const title = _el('wr-title');
  const issue = _el('wr-issue');
  if (title) title.addEventListener('input', _resuggestFlipReason);
  if (issue) issue.addEventListener('input', _resuggestFlipReason);
}

function _resuggestFlipReason() {
  const sel = _el('wr-flip-reason');
  if (!sel || _flipReasonTouched) return;
  const title = _el('wr-title');
  const issue = _el('wr-issue');
  sel.value = suggestFlipReason(((title && title.value) || '') + ' ' + ((issue && issue.value) || ''));
}

// Text appended to the submit confirm so the flip is never a surprise.
function _flipConfirmText() {
  const cb = _el('wr-flip-unavail');
  const sel = _el('wr-flip-reason');
  if (_flipDone || !cb || !cb.checked || !sel) return '';
  _resuggestFlipReason(); // AI Fill sets fields in code (no input event) — refresh now
  return '\n\nThen set the unit to Unavailable - ' + (_FLIP_LABELS[sel.value] || sel.value) + ' in AAP.';
}

// Called after a WR is created. Never throws; the WR stays created either way.
async function _maybeFlipUnavailable(wrId) {
  const cb = _el('wr-flip-unavail');
  const sel = _el('wr-flip-reason');
  if (_flipDone || !cb || !cb.checked || !sel) return;
  const unit = _unit || {};
  const eqId = unit.equipmentId || unit.id || '';
  if (!eqId || !unit.assetUrl) { _logProgress('Unit status not changed: no AAP asset link for this unit', 'err'); return; }
  _flipDone = true; // claim before awaiting so a concurrent submit can't double-flip
  const reason = sel.value || 'DAMAGED_MODERATE';
  const label = _FLIP_LABELS[reason] || reason;
  _logProgress('Setting ' + eqId + ' to Unavailable - ' + label + '…', 'run');
  try {
    const r = await aap.setLifecycle(eqId, unit.assetUrl, 'Unavailable', reason);
    if (r && r.success) {
      _logProgress((r.message || (eqId + ' set to Unavailable')) , 'ok');
      toast.show('success', eqId + ' → Unavailable - ' + label, 5000);
      cb.checked = false; cb.disabled = true; sel.disabled = true;
      const note = _el('wr-flip-note');
      if (note) note.textContent = 'Set to Unavailable - ' + label + (wrId ? ' after WR ' + wrId : '');
    } else if (r && r.uncertain) {
      _logProgress('Status change could not be verified — check the unit in AAP before relying on it', 'err');
      toast.show('warn', eqId + ': status change unverified — check AAP', 7000);
    } else {
      _flipDone = false; // nothing changed → allow a retry from a later submit
      _logProgress('Status change failed: ' + ((r && r.message) || 'unknown') + ' (the WR was still created)', 'err');
      toast.show('error', eqId + ': WR created, but status change failed — set it manually', 7000);
    }
  } catch (e) {
    _flipDone = false;
    _logProgress('Status change failed: ' + e.message + ' (the WR was still created)', 'err');
    toast.show('error', eqId + ': WR created, but status change failed — set it manually', 7000);
  }
}

// Resolve the unit's EXISTING work-request id (raw UUID) from the unit record,
// so a second WR can be linked to it via AAP's copiedFromWorkRequestId.
// Accepts workRequestId, _serviceUUID, or a /v2/service/<uuid> serviceUrl.
function _existingWrId(unit) {
  if (!unit) return null;
  const cand = unit.workRequestId || unit._serviceUUID || unit.serviceUrl || '';
  const m = String(cand).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (m) return m[1];
  return /^[a-f0-9-]{36}$/i.test(String(cand).trim()) ? String(cand).trim() : null;
}

// ── Escape helpers ────────────────────────────────────────────────────────
const _safe     = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const _safeAttr = (s) => String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const _el       = (id) => document.getElementById(id);

// ── HTML fragments ────────────────────────────────────────────────────────
function _pmBanner(unit) {
  const pills = [
    ['PM-B', unit.pmB], ['PM-X', unit.pmX],
    ['DOT',  unit.dot], ['Qtrly', unit.quarterlyLift],
  ].filter(([, v]) => v && v !== '--')
   .map(([l, v]) => `<span class="wr-pm-pill"><span class="wr-pm-label">${l}</span><span class="wr-pm-val">${_safe(v)}</span></span>`)
   .join('');
  return pills ? `<div class="wr-pm-banner" id="wr-pm-banner">${pills}</div>` : '';
}

function _insightsStrip(unit) {
  const items = (unit.insightsList || []).slice(0, 3)
    .map(i => `<li class="wr-insight-item">${_safe(typeof i === 'object' ? (i.summary || i.text || '') : i)}</li>`)
    .join('');
  return items ? `<div class="wr-insights-strip"><span class="wr-insights-label">Uptake:</span><ul class="wr-insights-list">${items}</ul></div>` : '';
}

function _riskBadge(score) {
  if (!score) return '';
  const tier = score >= 75 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';
  return `<span class="badge badge--risk-${tier.toLowerCase()}">${tier}</span>`;
}

// Build the L1 (Category) option list from the live tree + the synthetic TOW
// option. Falls back to an empty list (just the placeholder) when the tree
// hasn't loaded yet / is offline.
function _l1Options(selected) {
  const l1 = (_avmTree && Array.isArray(_avmTree.l1)) ? _avmTree.l1.slice() : [];
  const items = l1.concat([{ code: TOW_L1_CODE, displayName: 'TOW' }]);
  return avmOptionsHtml(items, selected, '-- Category --');
}

// L2 options for a given L1 code. TOW's "sub-categories" are its reasons.
function _l2ItemsFor(l1code) {
  if (String(l1code) === TOW_L1_CODE) {
    return TOW_REASONS.map((r) => ({ code: r, displayName: r }));
  }
  return (_avmTree && _avmTree.l2ByParent && _avmTree.l2ByParent[l1code]) || [];
}

// L3 options for a given L2 code (empty/undefined => no L3, select hidden).
function _l3ItemsFor(l2code) {
  return (_avmTree && _avmTree.l3ByParent && _avmTree.l3ByParent[l2code]) || [];
}

// Three cascading selects: Category (L1) -> Sub-category (L2) -> Sub-sub (L3).
// `area`/`sub`/`subSub` are AAP codes (for snapshot restore). The L3 select is
// hidden unless the current L2 code actually has children.
function _areaPairRow(idx, area, sub, subSub) {
  const l2Items = area ? _l2ItemsFor(area) : [];
  const l3Items = sub ? _l3ItemsFor(sub) : [];
  const showL3 = l3Items.length > 0;
  return `
    <div class="wr-area-row" id="wr-area-row-${idx}">
      <select class="settings__select wr-area-input" id="wr-area-${idx}" data-idx="${idx}">
        ${_l1Options(area)}
      </select>
      <select class="settings__select wr-area-input" id="wr-sub-${idx}" data-idx="${idx}">
        ${avmOptionsHtml(l2Items, sub, '-- Sub-category --')}
      </select>
      <select class="settings__select wr-area-input" id="wr-subsub-${idx}" data-idx="${idx}"
        style="${showL3 ? '' : 'display:none'}">
        ${avmOptionsHtml(l3Items, subSub, '-- Sub-sub-category --')}
      </select>
      <button class="wr-area-remove" data-idx="${idx}" title="Remove">×</button>
    </div>`;
}

function _buildHTML(unit) {
  return `
<div class="wr-modal" id="wr-modal-box" role="dialog" aria-modal="true" aria-labelledby="wr-modal-title">

  <!-- Header -->
  <div class="wr-modal__header">
    <div class="wr-modal__title-row">
      <span id="wr-modal-title" class="wr-modal__title">Create Work Request</span>
      <span class="wr-modal__unit-id">${_safe(unit.id || unit.equipmentId || '')}</span>
      ${_riskBadge(unit.riskScore)}
    </div>
    <button id="wr-close" class="wr-modal__close" aria-label="Close">×</button>
  </div>

  ${_pmBanner(unit)}
  ${_insightsStrip(unit)}

  <!-- Body -->
  <div class="wr-modal__body">

    <!-- Work Details -->
    <div class="wr-section">
      <div class="wr-section__title" style="display:flex;justify-content:space-between;align-items:center;">Work Details <button id="wr-ai-assist" type="button" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:9px;padding:2px 8px;">✨ AI Fill</button></div>
      <div id="wr-tabbar-host"></div>
      <label class="settings-label">WR Title <span id="wr-title-count" class="wr-title-count" style="float:right;font-size:9px;opacity:.6">0 (AI will summarize to 90)</span>
        <input id="wr-title" class="settings__input" type="text"
          placeholder="Type your request in full — AI Fill will summarize it to 90 chars..."
          value="${_safeAttr(unit.pmStatus || unit.issueDetails || '')}" />
      </label>
      <label class="settings-label" style="margin-top:6px">Issue Description
        <textarea id="wr-issue" class="settings__textarea" rows="3"
          placeholder="Full defect / complaint details...">${_safe(unit.issueDetails || unit.pmStatus || '')}</textarea>
      </label>
    </div>

    <!-- Vendor & Urgency -->
    <div class="wr-section">
      <div class="wr-section__title">Vendor &amp; Urgency</div>
      <div class="wr-two-col">
        <label class="settings-label">Vendor
          <select id="wr-vendor" class="settings__select">
            <option value="">-- Select vendor --</option>
            ${VENDORS.map(v => `<option value="${v}">${v}</option>`).join('')}
          </select>
        </label>
        <label class="settings-label settings-label--inline" style="align-self:flex-end;padding-bottom:6px">
          <input id="wr-urgent" type="checkbox" />
          Urgent
        </label>
      </div>
      <div id="wr-urgency-reason-wrap" style="display:none;margin-top:6px">
        <label class="settings-label">Urgency reason
          <select id="wr-urgency-reason" class="settings__select">
            ${URGENCY_REASONS.map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
        </label>
      </div>
    </div>

    <!-- Asset Condition -- FIX: this field previously did not exist anywhere
         in the payload builder. The real AAP wizard has an "Asset Condition"
         step (Safe to Move / Unsafe to Move) that the AI autofill agent was
         hitting completely blind -- no data, no instruction -- and guessing
         wrong (confirmed live: picked "Safe" on a unit with a clutch
         disengagement fault). This is a real vehicle-safety classification;
         it must be an explicit human decision, never an AI guess, same
         principle as the existing Urgent checkbox above. Defaults to
         "Unsafe to Move" when Urgent is checked (mirrors partner-wr.js's
         own existing safety-issue -> urgent=true rule) but is always
         overridable. -->
    <div class="wr-section">
      <div class="wr-section__title">Asset Condition</div>
      <div class="wr-two-col">
        <label class="settings-label settings-label--inline">
          <input id="wr-condition-safe" type="radio" name="wr-condition" value="Safe to Move" />
          Safe to Move
        </label>
        <label class="settings-label settings-label--inline">
          <input id="wr-condition-unsafe" type="radio" name="wr-condition" value="Unsafe to Move" />
          Unsafe to Move
        </label>
      </div>
    </div>

    <!-- Component Areas -->
    <div class="wr-section">
      <div class="wr-section__title">
        Component Areas
        <span class="wr-section__hint">add as many as the repair needs</span>
      </div>
      <div id="wr-area-rows">${_areaPairRow(0, '', '', '')}</div>
      <button id="wr-add-area" class="detail-panel__btn detail-panel__btn--secondary" style="margin-top:6px">+ Add area</button>
    </div>

    <!-- Contact -->
    <div class="wr-section">
      <div class="wr-section__title">Contact</div>
      <div class="wr-two-col">
        <label class="settings-label">Contact name
          <input id="wr-contact-name"  class="settings__input" type="text" placeholder="Driver / dispatcher name" />
        </label>
        <label class="settings-label">Phone
          <input id="wr-contact-phone" class="settings__input" type="tel"  placeholder="1-555-000-0000" />
        </label>
      </div>
    </div>

    <!-- Comments -->
    <div class="wr-section">
      <div class="wr-section__title">Comments</div>
      <label class="settings-label">
        <textarea id="wr-comments" class="settings__textarea" rows="2"
          placeholder="Additional notes for the vendor..."></textarea>
      </label>
      <label class="settings-label settings-label--inline" style="margin-top:4px">
        <input id="wr-internal" type="checkbox" />
        Internal only (not shared with vendor)
      </label>
    </div>

    <!-- Unit status: flip the unit in AAP after the WR is created -->
    <div class="wr-section">
      <div class="wr-section__title">Unit status</div>
      <label class="settings-label settings-label--inline">
        <input id="wr-flip-unavail" type="checkbox" />
        Set unit to Unavailable after the WR is created
      </label>
      <label class="settings-label" style="margin-top:4px">Reason
        <select id="wr-flip-reason" class="settings__select" aria-label="Unavailable reason">
          <option value="DAMAGED_MODERATE">Damaged - Moderate</option>
          <option value="OFFSITE_SHOP_REPAIR">Off-site Shop Repair</option>
          <option value="PARTS_DELAY">Parts Delay</option>
          <option value="PM_FAILED">PM Failed</option>
          <option value="PREVENTATIVE_MAINTENANCE">Preventative Maintenance</option>
          <option value="SENSOR_DETECTED_DAMAGE">Sensor Detected Damage</option>
          <option value="SAFETY_INSPECTION_POST_ACCIDENT">Safety Inspection Post Accident</option>
          <option value="LICENSE_OR_PERMIT_ISSUE">License or Permit Issue</option>
          <option value="IMPOUNDED_TOW">Impounded / Tow</option>
          <option value="GPS_MALFUNCTIONING">GPS Malfunctioning</option>
          <option value="CAMPAIGN">Campaign</option>
        </select>
      </label>
      <div id="wr-flip-note" class="wr-screenshot-label" style="margin-top:4px"></div>
    </div>

    <!-- Optional -->
    <div class="wr-section">
      <div class="wr-section__title">
        Optional
        <button id="wr-toggle-optional" class="wr-optional-toggle">Show</button>
      </div>
      <div id="wr-optional-fields" style="display:none">
        <div class="wr-two-col" style="margin-top:4px">
          <label class="settings-label">ARC Claim #
            <input id="wr-arc" class="settings__input" type="text" placeholder="ARC-XXXXX" />
          </label>
          <label class="settings-label">SIM #
            <input id="wr-sim" class="settings__input" type="text" placeholder="SIM-XXXXXXXX" />
          </label>
        </div>
      </div>
    </div>

    <!-- Screenshot -->
    <div class="wr-section">
      <div id="wr-tow-wrap" class="wr-section" style="display:none">\n      <div class="wr-section__title">\uD83D\uDE9B Tow Destination (where unit goes)</div>\n      <div class="wr-two-col" style="margin-bottom:6px"><label class="settings-label" style="flex:3"><select id="wr-tow-book" class="settings__select"><option value="">Quick-fill from vendor book...</option></select></label></div>\n      <div class="wr-two-col"><label class="settings-label" style="flex:3">Street<input id="wr-tow-street" class="settings__input" placeholder="Street" /></label><label class="settings-label" style="flex:2">City<input id="wr-tow-city" class="settings__input" placeholder="City" /></label></div>\n      <div class="wr-two-col" style="margin-top:4px"><label class="settings-label">State<input id="wr-tow-state" class="settings__input" placeholder="ST" maxlength="2" style="text-transform:uppercase" /></label><label class="settings-label">ZIP<input id="wr-tow-zip" class="settings__input" placeholder="00000" /></label></div>\n      <div class="wr-section__title" style="margin-top:12px">\uD83D\uDCCD Tow Pickup (where unit is now)</div>\n      <div class="wr-two-col" style="margin-bottom:6px"><label class="settings-label" style="flex:3"><select id="wr-tow-from-book" class="settings__select"><option value="">Quick-fill pickup location...</option></select></label></div>\n      <div class="wr-two-col"><label class="settings-label" style="flex:3">Street<input id="wr-tow-from-street" class="settings__input" placeholder="Pickup street" /></label><label class="settings-label" style="flex:2">City<input id="wr-tow-from-city" class="settings__input" placeholder="City" /></label></div>\n      <div class="wr-two-col" style="margin-top:4px"><label class="settings-label">State<input id="wr-tow-from-state" class="settings__input" placeholder="ST" maxlength="2" style="text-transform:uppercase" /></label><label class="settings-label">ZIP<input id="wr-tow-from-zip" class="settings__input" placeholder="00000" /></label></div>\n    </div>\n\n    <div class="wr-section__title">Attachments</div>
      <div class="wr-screenshot-row">
        <button id="wr-attach-screenshot" class="detail-panel__btn detail-panel__btn--secondary">Attach Uptake screenshots</button>
        <span id="wr-screenshot-label" class="wr-screenshot-label">None</span>
      </div>
      <div id="wr-dropzone" class="wr-dropzone">
        <span>Drag files here, or <button id="wr-attach-browse" type="button" class="wr-dropzone__browse">browse…</button></span>
        <input id="wr-attach-file-input" type="file" multiple accept="image/*,.pdf" style="display:none" />
      </div>
      <div id="wr-attach-list" class="wr-attach-list"></div>
    </div>

    <!-- Progress log -->
    <div id="wr-progress-wrap" class="wr-progress-wrap" style="display:none">
      <div class="wr-section__title">Progress
        <button id="wr-stop-autofill" class="detail-panel__btn detail-panel__btn--secondary" style="display:none;float:right;padding:2px 10px">Stop</button>
      </div>
      <div id="wr-progress-log" class="wr-progress-log"></div>
    </div>

    <!-- Result -->
    <div id="wr-result" class="wr-result" style="display:none"></div>

  </div><!-- /body -->

  <!-- Footer -->
  <div class="wr-modal__footer">
    <button id="wr-autofill-fallback" class="detail-panel__btn detail-panel__btn--secondary"
      title="Open AAP browser window with payload auto-filled">Open in AAP (autofill)</button>
    <div class="wr-footer-right">
      <button id="wr-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
      <button id="wr-submit-second" class="detail-panel__btn detail-panel__btn--secondary"
        title="Create a SECOND work request reusing all of this unit's data (e.g. a Dealer Tracking Event) — just give it a different title. Links to the existing WR.">+ 2nd WR (reuse data)</button>
      <button id="wr-submit" class="detail-panel__btn wr-submit-btn">Submit WR</button>
    </div>
  </div>

</div>`;
}

// ── Tab snapshot / load (multi-tab tow UI) ─────────────────────────────────
// Captures the FULL live form state (not just the createWR payload shape) so
// switching tabs restores exact UI state, including the number of area rows.
function _snapshotForm() {
  const areaPairs = [];
  for (let i = 0; i < _areaCount; i++) {
    const aEl = _el('wr-area-' + i), sEl = _el('wr-sub-' + i), ssEl = _el('wr-subsub-' + i);
    if (!aEl && !sEl && !ssEl) continue;
    areaPairs.push({
      area: (aEl && aEl.value) || '',
      subcategory: (sEl && sEl.value) || '',
      subSubcategory: (ssEl && ssEl.value) || '',
    });
  }
  const condEl = document.querySelector('input[name="wr-condition"]:checked');
  return {
    title: (_el('wr-title') || {}).value || '',
    issue: (_el('wr-issue') || {}).value || '',
    vendor: (_el('wr-vendor') || {}).value || '',
    urgent: !!(_el('wr-urgent') || {}).checked,
    urgencyReason: (_el('wr-urgency-reason') || {}).value || '',
    condition: condEl ? condEl.value : '',
    areaPairs,
    contactName: (_el('wr-contact-name') || {}).value || '',
    contactPhone: (_el('wr-contact-phone') || {}).value || '',
    comments: (_el('wr-comments') || {}).value || '',
    internal: !!(_el('wr-internal') || {}).checked,
    arc: (_el('wr-arc') || {}).value || '',
    sim: (_el('wr-sim') || {}).value || '',
    towStreet: (_el('wr-tow-street') || {}).value || '',
    towCity: (_el('wr-tow-city') || {}).value || '',
    towState: (_el('wr-tow-state') || {}).value || '',
    towZip: (_el('wr-tow-zip') || {}).value || '',
    towFromStreet: (_el('wr-tow-from-street') || {}).value || '',
    towFromCity: (_el('wr-tow-from-city') || {}).value || '',
    towFromState: (_el('wr-tow-from-state') || {}).value || '',
    towFromZip: (_el('wr-tow-from-zip') || {}).value || '',
    towWrapVisible: !!(_el('wr-tow-wrap') && _el('wr-tow-wrap').style.display !== 'none'),
  };
}

function _applyFormSnapshot(s) {
  if (!s) return;
  const rowsContainer = _el('wr-area-rows');
  // Rebuild area rows to match the snapshot's count exactly.
  if (rowsContainer) {
    rowsContainer.innerHTML = (s.areaPairs.length ? s.areaPairs : [{ area: '', subcategory: '', subSubcategory: '' }])
      .map((p, i) => _areaPairRow(i, p.area, p.subcategory, p.subSubcategory)).join('');
    _areaCount = Math.max(1, s.areaPairs.length);
    _wireAreaCascade();
  }
  const set = (id, v) => { const el = _el(id); if (el) el.value = v; };
  set('wr-title', s.title); set('wr-issue', s.issue); set('wr-vendor', s.vendor);
  const u = _el('wr-urgent'); if (u) u.checked = !!s.urgent;
  const urw = _el('wr-urgency-reason-wrap'); if (urw) urw.style.display = s.urgent ? '' : 'none';
  set('wr-urgency-reason', s.urgencyReason);
  const safeEl = _el('wr-condition-safe'), unsafeEl = _el('wr-condition-unsafe');
  if (safeEl) safeEl.checked = s.condition === 'Safe to Move';
  if (unsafeEl) unsafeEl.checked = s.condition === 'Unsafe to Move';
  set('wr-contact-name', s.contactName); set('wr-contact-phone', s.contactPhone);
  set('wr-comments', s.comments);
  const i2 = _el('wr-internal'); if (i2) i2.checked = !!s.internal;
  set('wr-arc', s.arc); set('wr-sim', s.sim);
  set('wr-tow-street', s.towStreet); set('wr-tow-city', s.towCity); set('wr-tow-state', s.towState); set('wr-tow-zip', s.towZip);
  set('wr-tow-from-street', s.towFromStreet); set('wr-tow-from-city', s.towFromCity); set('wr-tow-from-state', s.towFromState); set('wr-tow-from-zip', s.towFromZip);
  const tw = _el('wr-tow-wrap'); if (tw) tw.style.display = s.towWrapVisible ? '' : 'none';
  _wireTitleCount();
}

// Build the TOW work-order title with the correct DIRECTION. The AI already
// parses towDirection + pickup/destination from the user's words; the old
// template hardcoded "TOW <unit> to <dealer>" and ignored it, so a return tow
// ("towed back FROM dealer TO home yard") came out backwards. Rules:
//   return-to-yard : TOW <unit> from <pickup/dealer> to <destination/home yard>
//   yard-to-yard   : TOW <unit> from <origin> to <destination>
//   to-dealer      : TOW <unit> to <dealer>            (default)
// Falls back cleanly to "TOW <unit> to <dealer>" when a name is missing.
// Exported for unit testing.
function _buildTowTitle(unit, plan, dealerName) {
  const eq = (unit && (unit.equipmentId || unit.id)) || '';
  const dir = (plan && plan.towDirection) || 'to-dealer';
  const homeYard = (plan && plan.towDestName) || (unit && (unit.domicileSite || unit.site)) || '';
  const pickup = (plan && plan.towPickupName) || dealerName || '';
  const dest = (plan && plan.towDestName) || '';
  let title;
  if (dir === 'return-to-yard') {
    // Unit is at the dealer; bring it home. Pickup = dealer, dest = home yard.
    const from = pickup || dealerName || 'dealer';
    const to = homeYard || 'home yard';
    title = 'TOW ' + eq + ' from ' + from + ' to ' + to;
  } else if (dir === 'yard-to-yard') {
    const from = pickup || 'yard';
    const to = dest || homeYard || 'yard';
    title = 'TOW ' + eq + ' from ' + from + ' to ' + to;
  } else {
    // to-dealer (default): unit goes TO the dealer.
    title = 'TOW ' + eq + ' to ' + (dealerName || dest || 'dealer');
  }
  return title.replace(/\s{2,}/g, ' ').trim().slice(0, 90);
}

// Build the two tabs' initial field snapshots from a tow plan + base form
// state (whatever AI Fill / the user has typed so far). Mirrors the vendor
// and title rules from _buildTowPayloads, but as EDITABLE form snapshots.
function _buildTabSnapshots(baseSnapshot) {
  const unit = _unit || {};
  const plan = _towPlan;
  const dealer = plan.dealer;
  const dealerName = (dealer && dealer.name) || plan.dealerName || 'dealer';
  const rgIntegrated = _isRgIntegrated(dealer);
  const makeVendor = _makeVendorFor(unit);
  const hasRepair = plan.hasRepair !== false;

  const repair = { ...baseSnapshot };
  repair.title = rgIntegrated ? baseSnapshot.title : 'Relay Garage Repair Work Order - Dealer Tracking';
  repair.vendor = rgIntegrated ? dealerName : makeVendor;
  repair.areaPairs = (baseSnapshot.areaPairs || []).filter(p => (p.area || '').toUpperCase() !== 'TOW');
  if (!repair.areaPairs.length) repair.areaPairs = baseSnapshot.areaPairs;
  repair.towWrapVisible = false;

  const tow = { ...baseSnapshot };
  tow.title = _buildTowTitle(unit, plan, dealerName);
  tow.vendor = rgIntegrated ? dealerName : (baseSnapshot.vendor || '');
  tow.areaPairs = [{ area: 'TOW', subcategory: 'MECHANICAL ISSUE' }];
  tow.urgent = true;
  tow.urgencyReason = baseSnapshot.urgencyReason || 'DEA - Asset Shortage';
  tow.towWrapVisible = true;

  return { repair, tow, rgIntegrated, dealerName, hasRepair };
}

// ── Tab bar (only rendered when _wrTabState is set) ────────────────────────
function _renderTabBar() {
  const host = _el('wr-tabbar-host');
  if (!host) return;
  if (!_wrTabState) { host.innerHTML = ''; return; }
  const st = _wrTabState;
  const tabLabel = (key, label) => {
    const done = st.submitted[key];
    return '<button type="button" class="wr-tab-btn' + (st.active === key ? ' active' : '') + (done ? ' done' : '') + '" data-tab="' + key + '">' +
      (done ? '✓ ' : '') + _esc_wr(label) + '</button>';
  };
  host.innerHTML = '<div class="wr-tabbar">' +
    tabLabel('repair', st.hasRepair ? 'Repair / Dealer Tracking' : 'Repair (skipped)') +
    tabLabel('tow', 'Tow') +
    '<span class="wr-tabbar-note">' + (st.rgIntegrated ? _esc_wr(st.dealerName) + ' is RG-integrated — no Dealer WO' : 'Dealer WO opens after both are submitted') + '</span>' +
    '<button type="button" id="wr-submit-all" class="detail-panel__btn detail-panel__btn--secondary" style="margin-left:auto">Submit All (' + (st.hasRepair ? '2' : '1') + ')</button>' +
    '</div>';
  const submitAllBtn = _el('wr-submit-all');
  if (submitAllBtn) submitAllBtn.addEventListener('click', () => _submitAllTabs());
  host.querySelectorAll('.wr-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });
}
function _esc_wr(s) { return _safe(s); }

function _switchTab(key) {
  if (!_wrTabState || _wrTabState.active === key) return;
  _wrTabState[_wrTabState.active] = _snapshotForm();
  _wrTabState.active = key;
  _applyFormSnapshot(_wrTabState[key]);
  _renderTabBar();
}

// ── Payload collector ─────────────────────────────────────────────────────
function _collectPayload() {
  // Read the three cascading selects per row (values are AAP codes; TOW is a
  // passthrough). buildAreaPairsPayload drops empty rows + normalizes the shape.
  // Iterate the ACTUAL rows in the DOM (ids are non-contiguous after adds/
  // removes, and there is no fixed max), reading each row's three selects by
  // its data-idx. buildAreaPairsPayload drops empty rows + normalizes the shape.
  const rawRows = [];
  const rowsEl = _el('wr-area-rows');
  const domRows = rowsEl ? rowsEl.querySelectorAll('.wr-area-row') : [];
  domRows.forEach((rowEl) => {
    // Each row renders exactly three selects in order: L1 area, L2 sub, L3 sub-sub.
    const sels = rowEl.querySelectorAll('select.wr-area-input');
    if (!sels.length) return;
    rawRows.push({
      area: (sels[0] && sels[0].value) || '',
      subcategory: (sels[1] && sels[1].value) || '',
      subSubcategory: (sels[2] && sels[2].value) || '',
    });
  });
  const areaPairs = buildAreaPairsPayload(rawRows);

  // FEATURE (2026-07-23): attachments are now a list (_attachments module
  // state, populated by auto-attach, the manual Uptake-screenshot button,
  // file browse, and drag-and-drop) instead of a single hidden _dataUrl on
  // the button. screenshotDataUrl is kept for any older backend code that
  // only reads that single field; attachments carries the full list.
  const screenshotDataUrl = (_attachments[0] && _attachments[0].dataUrl) || null;
  const attachments = _attachments.map(a => a.dataUrl);

  return {
    unit:            _unit.id          || _unit.equipmentId || '',
    title:           (_el('wr-title').value   || '').trim().slice(0, 90),
    copiedFromWorkRequestId: _copyFromWrId || null,
    issue:           (_el('wr-issue').value   || '').trim(),
    vendor:          (_el('wr-vendor').value  || '').trim(),
    urgent:          _el('wr-urgent').checked ? 'Yes' : 'No',
    urgencyReason:   _el('wr-urgent').checked ? (_el('wr-urgency-reason').value || '') : '',
    areaPairs,
    contactName:     (_el('wr-contact-name').value  || '').trim(),
    contactPhone:    (_el('wr-contact-phone').value || '').trim(),
    comments:        (_el('wr-comments').value      || '').trim(),
    shareWith:       _el('wr-internal').checked ? 'internal' : 'all',
    arcClaim:        (_el('wr-arc').value || '').trim() || null,
    simNumber:       (_el('wr-sim').value || '').trim() || null,
    screenshotDataUrl,
    attachments,
    domicile:        _unit.site || _unit.domicileSite || '',
    towStreet:     (_el('wr-tow-street')||{}).value||'',
    towCity:       (_el('wr-tow-city')||{}).value||'',
    towState:      (_el('wr-tow-state')||{}).value||'',
    towZip:        (_el('wr-tow-zip')||{}).value||'',
    towFromStreet: (_el('wr-tow-from-street')||{}).value||'',
    towFromCity:   (_el('wr-tow-from-city')||{}).value||'',
    towFromState:  (_el('wr-tow-from-state')||{}).value||'',
    towFromZip:    (_el('wr-tow-from-zip')||{}).value||'',
    // Tow direction (from the AI tow plan) so the submitted unit-location can
    // reflect where the unit actually is (dealer on a return tow, not home yard).
    towDirection:  (_towPlan && _towPlan.towDirection) || '',
    // Off-site location for the AAP Location wizard step: when the unit is NOT
    // in its yard (return/yard-to-yard tow) the wizard must select "Off Site
    // (Address)" and type the pickup STREET/CITY/STATE/ZIP, not a geofence.
    ...(() => { const l = _resolveWrLocation({
          towDirection: (_towPlan && _towPlan.towDirection) || '',
          towFromStreet: (_el('wr-tow-from-street')||{}).value||'',
          towFromCity:   (_el('wr-tow-from-city')||{}).value||'',
          towFromState:  (_el('wr-tow-from-state')||{}).value||'',
          towFromZip:    (_el('wr-tow-from-zip')||{}).value||'',
        });
        return { offSite: l.offSite, locStreet: l.locStreet, locCity: l.locCity, locState: l.locState, locZip: l.locZip }; })(),
    // Supplier: only present when a supplierRequired vendor is selected (the
    // Supplier <select> is visible). Carries the chosen supplierId (or string).
    ...(() => {
      const supWrap = _el('wr-supplier-wrap'), supSel = _el('wr-supplier');
      const visible = !!(supWrap && supWrap.style.display !== 'none' && supSel);
      return visible ? { supplierId: (supSel.value || '').trim() } : {};
    })(),
  };
}

// ── Tow orchestration (multi-WR) ──────────────────────────────────────────
// Fired from _doSubmit when _towPlan is set (AI detected a tow-to-dealer).
// Creates, auto-submitted via the deterministic aap.createWR 3-step API:
//   1. a REPAIR work request
//   2. a TOW work request (linked to the repair via copiedFromWorkRequestId)
// Then, if the chosen dealer is NOT Relay-Garage/Reach integrated, opens the
// Dealer WO modal pre-filled so the user can submit that too.
//
// Vendor + title rules (confirmed with user):
//   Case A — dealer IS RG-integrated (affiliation contains Relay Garage/Reach):
//     repair WR vendor = the dealer itself; NO Dealer WO.
//   Case B — dealer NOT RG-integrated:
//     repair WR vendor = unit's MAKE (Volvo/Kenworth/Peterbilt/Freightliner),
//     repair WR title = fixed "Relay Garage Repair Work Order - Dealer Tracking";
//     then open the Dealer WO modal.
const _MAKE_VENDOR = [
  { re: /volvo|mack/i,            vendor: 'Volvo (ASIST)' },
  { re: /kenworth|kwne/i,         vendor: 'Kenworth (PACCAR)' },
  { re: /peterbilt/i,             vendor: 'Peterbilt (PACCAR)' },
  { re: /freightliner|western/i,  vendor: 'Freightliner (DAIMLER)' },
];
function _makeVendorFor(unit) {
  const hay = [unit && unit.manufacturer, unit && unit.make, unit && unit.model].map(s => String(s||'')).join(' ');
  const hit = _MAKE_VENDOR.find(m => m.re.test(hay));
  return hit ? hit.vendor : '';
}
function _isRgIntegrated(dealer) {
  return !!(dealer && /relay\s*garage|reach/i.test(String(dealer.affiliation || '')));
}

// Case B: open the Dealer WO modal pre-filled (shared by both paths).
function _openDealerWOForTow(dealerName) {
  const unit = _unit || {};
  const vendorKey = _detectVendorKeyLocal(unit);
  if (vendorKey && typeof openDealerWOModal === 'function') {
    const unitForWO = { ...unit, _towDealerName: dealerName };
    setTimeout(() => {
      openDealerWOModal(unitForWO, vendorKey, async (formData) => {
        try {
          const fn = vendorKey === 'paccar' ? (window.vendor && window.vendor.startPaccar) : (window.vendor && window.vendor.startVolvo);
          if (fn) await fn(unitForWO, formData);
        } catch (e) { toast.show('error', 'Dealer WO workflow failed: ' + e.message, 5000); }
      });
    }, 600);
  } else {
    toast.show('info', dealerName + ' has no automated Dealer WO — submit it manually in the dealer portal.', 7000);
  }
}

// Submit the CURRENTLY ACTIVE tab's live (edited) fields as one real WR via
// the deterministic createWR path. Marks that tab done; once BOTH tabs are
// done, opens the Dealer WO for a non-RG dealer (unchanged flow).
async function _submitActiveTab(btn) {
  const st = _wrTabState;
  const key = st.active;
  const unit = _unit || {};
  st[key] = _snapshotForm(); // capture any edits made on this tab
  const snap = st[key];

  if (!window.confirm('Create and SUBMIT this ' + (key === 'repair' ? 'Repair' : 'Tow') + ' work order: "' + (snap.title || '').slice(0, 90) + '"?' + _flipConfirmText())) return;

  const origText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Submitting ' + key + '...';
  const resultEl = _el('wr-result');
  resultEl.style.display = 'none';
  _el('wr-progress-wrap').style.display = '';
  if (_progUnsub) { _progUnsub(); _progUnsub = null; }
  _progUnsub = aap.onWRProgress(_logProgress);

  const payload = {
    unit: unit.id || unit.equipmentId || '',
    title: String(snap.title || '').slice(0, 90),
    issue: snap.issue, vendor: snap.vendor,
    urgent: snap.urgent ? 'Yes' : 'No', urgencyReason: snap.urgent ? snap.urgencyReason : '',
    areaPairs: snap.areaPairs, contactName: snap.contactName, contactPhone: snap.contactPhone,
    comments: snap.comments, shareWith: snap.internal ? 'internal' : 'all',
    arcClaim: snap.arc || null, simNumber: snap.sim || null,
    attachments: _attachments.map(a => a.dataUrl), screenshotDataUrl: (_attachments[0] && _attachments[0].dataUrl) || null,
    domicile: unit.site || unit.domicileSite || '',
    towStreet: snap.towStreet, towCity: snap.towCity, towState: snap.towState, towZip: snap.towZip,
    towFromStreet: snap.towFromStreet, towFromCity: snap.towFromCity, towFromState: snap.towFromState, towFromZip: snap.towFromZip,
    // Tow direction drives the submitted unit-location (return-from-dealer =>
    // unit is at the dealer/pickup, not the home yard). Only the tow tab has one.
    towDirection: (key === 'tow' && _towPlan) ? (_towPlan.towDirection || 'to-dealer') : '',
    copiedFromWorkRequestId: key === 'tow' ? ((st.submitted.repair && st.submitted.repair.workRequestId) || null) : null,
    autoSubmit: true,
  };

  try {
    _logProgress('[' + key + '] Creating work request...');
    const res = await aap.createWR(payload, unit);
    if (_progUnsub) { _progUnsub(); _progUnsub = null; }
    if (!res || !res.ok) { _showError((key === 'repair' ? 'Repair' : 'Tow') + ' WR failed: ' + ((res && res.error) || 'unknown')); return; }
    _logProgress('[' + key + '] Created: ' + res.workRequestId);
    st.submitted[key] = { workRequestId: res.workRequestId };
    toast.show('success', (key === 'repair' ? 'Repair' : 'Tow') + ' WR ' + res.workRequestId + ' created', 5000);
    _renderTabBar();
    await _maybeFlipUnavailable(res.workRequestId);
    await _afterTabSubmitted();
  } catch (e) {
    if (_progUnsub) { _progUnsub(); _progUnsub = null; }
    _showError((key === 'repair' ? 'Repair' : 'Tow') + ' WR failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = origText;
  }
}

// After a tab submits: if the OTHER required tab is also done (or not
// needed), open the Dealer WO for a non-RG dealer and finish up.
async function _afterTabSubmitted() {
  const st = _wrTabState;
  if (!st) return;
  const repairDone = !st.hasRepair || !!st.submitted.repair;
  const towDone = !!st.submitted.tow;
  if (repairDone && towDone) {
    const resultEl = _el('wr-result');
    const parts = [];
    if (st.submitted.repair) parts.push('Repair WR ' + st.submitted.repair.workRequestId);
    if (st.submitted.tow) parts.push('Tow WR ' + st.submitted.tow.workRequestId);
    if (resultEl) {
      resultEl.innerHTML = '<div class="wr-result--success"><span class="wr-result__icon">✓</span><span>Created ' + _safe(parts.join(' + ')) +
        (st.rgIntegrated ? ' (RG-integrated — assigned in RG).' : '. Opening Dealer WO…') + '</span></div>';
      resultEl.style.display = '';
    }
    if (!st.rgIntegrated) _openDealerWOForTow(st.dealerName);
    const unit = _unit || {};
    const _eqId = unit && (unit.equipmentId || unit.id);
    if (_eqId && relay && typeof relay.refreshUnit === 'function') relay.refreshUnit(_eqId).catch(() => {});
    if (st.rgIntegrated) setTimeout(() => _close(), 3500);
  }
}

// "Submit All" — runs the repair tab then the tow tab in sequence (each via
// the SAME per-tab submit as a single click would), using whatever is
// currently loaded/edited in _wrTabState for each (switches tabs as needed).
async function _submitAllTabs() {
  const st = _wrTabState;
  if (!st) return;
  if (!window.confirm('Submit All will create and SUBMIT ' + (st.hasRepair ? '2 work orders (Repair + Tow)' : '1 work order (Tow)') +
    (st.rgIntegrated ? '.' : ', then open the Dealer WO.') + ' Continue?' + _flipConfirmText())) return;
  const allBtn = _el('wr-submit-all');
  if (allBtn) { allBtn.disabled = true; allBtn.textContent = 'Submitting…'; }
  try {
    if (st.hasRepair && !st.submitted.repair) {
      if (st.active !== 'repair') { st[st.active] = _snapshotForm(); st.active = 'repair'; _applyFormSnapshot(st.repair); _renderTabBar(); }
      await _submitOneTabSilently('repair');
    }
    if (!st.submitted.tow) {
      if (st.active !== 'tow') { st[st.active] = _snapshotForm(); st.active = 'tow'; _applyFormSnapshot(st.tow); _renderTabBar(); }
      await _submitOneTabSilently('tow');
    }
  } finally {
    if (allBtn) { allBtn.disabled = false; allBtn.textContent = 'Submit All'; }
  }
}

// Same as _submitActiveTab's core but WITHOUT its own confirm dialog (Submit
// All already confirmed once for the whole batch) and operating on a named
// tab rather than always "the active one" at call time.
async function _submitOneTabSilently(key) {
  const st = _wrTabState;
  const unit = _unit || {};
  st[key] = _snapshotForm();
  const snap = st[key];
  _el('wr-progress-wrap').style.display = '';
  if (_progUnsub) { _progUnsub(); _progUnsub = null; }
  _progUnsub = aap.onWRProgress(_logProgress);
  const payload = {
    unit: unit.id || unit.equipmentId || '',
    title: String(snap.title || '').slice(0, 90),
    issue: snap.issue, vendor: snap.vendor,
    urgent: snap.urgent ? 'Yes' : 'No', urgencyReason: snap.urgent ? snap.urgencyReason : '',
    areaPairs: snap.areaPairs, contactName: snap.contactName, contactPhone: snap.contactPhone,
    comments: snap.comments, shareWith: snap.internal ? 'internal' : 'all',
    arcClaim: snap.arc || null, simNumber: snap.sim || null,
    attachments: _attachments.map(a => a.dataUrl), screenshotDataUrl: (_attachments[0] && _attachments[0].dataUrl) || null,
    domicile: unit.site || unit.domicileSite || '',
    towStreet: snap.towStreet, towCity: snap.towCity, towState: snap.towState, towZip: snap.towZip,
    towFromStreet: snap.towFromStreet, towFromCity: snap.towFromCity, towFromState: snap.towFromState, towFromZip: snap.towFromZip,
    // Tow direction drives the submitted unit-location (return-from-dealer =>
    // unit is at the dealer/pickup, not the home yard). Only the tow tab has one.
    towDirection: (key === 'tow' && _towPlan) ? (_towPlan.towDirection || 'to-dealer') : '',
    copiedFromWorkRequestId: key === 'tow' ? ((st.submitted.repair && st.submitted.repair.workRequestId) || null) : null,
    autoSubmit: true,
  };
  try {
    _logProgress('[' + key + '] Creating work request...');
    const res = await aap.createWR(payload, unit);
    if (!res || !res.ok) { _showError((key === 'repair' ? 'Repair' : 'Tow') + ' WR failed: ' + ((res && res.error) || 'unknown')); return; }
    _logProgress('[' + key + '] Created: ' + res.workRequestId);
    st.submitted[key] = { workRequestId: res.workRequestId };
    _renderTabBar();
    await _maybeFlipUnavailable(res.workRequestId);
    await _afterTabSubmitted();
  } catch (e) {
    _showError((key === 'repair' ? 'Repair' : 'Tow') + ' WR failed: ' + e.message);
  } finally {
    if (_progUnsub) { _progUnsub(); _progUnsub = null; }
  }
}

// Build an aap.autofill-shaped payload from a tab snapshot (mirrors the
// Resolve where the unit ACTUALLY is for the AAP Location wizard step.
// In-yard (default / to-dealer tow): the unit is at its home yard, so the
// wizard should pick the domicile GEOFENCE (On Site / Yard).
// Off-site (return-from-dealer or yard-to-yard tow): the unit is at the tow
// PICKUP location (the dealer), which is NOT a yard geofence — so the wizard
// must select "Off Site (Address)" and type the STREET/CITY/STATE/ZIP instead.
// Returns { offSite, locStreet, locCity, locState, locZip } the engine reads.
function _resolveWrLocation(src) {
  const dir = String((src && src.towDirection) || (_towPlan && _towPlan.towDirection) || '').toLowerCase();
  const offSite = (dir === 'return-to-yard' || dir === 'yard-to-yard');
  // Pickup = where the unit is NOW (dealer, on a return tow).
  const locStreet = (src && src.towFromStreet) || '';
  const locCity   = (src && src.towFromCity)   || '';
  const locState  = (src && src.towFromState)  || '';
  const locZip    = (src && src.towFromZip)    || '';
  const hasAddr = !!(locStreet || locCity || locState || locZip);
  return { offSite: offSite && hasAddr, locStreet, locCity, locState, locZip };
}

// fields _submitActiveTab sends to createWR, minus autoSubmit).
function _snapshotToAutofillPayload(snap, copiedFromWorkRequestId) {
  const unit = _unit || {};
  const towDirection = (snap && snap.towDirection) || (_towPlan && _towPlan.towDirection) || '';
  const loc = _resolveWrLocation({
    towDirection,
    towFromStreet: snap.towFromStreet, towFromCity: snap.towFromCity,
    towFromState: snap.towFromState, towFromZip: snap.towFromZip,
  });
  return {
    unit: unit.id || unit.equipmentId || '',
    title: String(snap.title || '').slice(0, 90),
    issue: snap.issue, vendor: snap.vendor,
    urgent: snap.urgent ? 'Yes' : 'No', urgencyReason: snap.urgent ? snap.urgencyReason : '',
    areaPairs: snap.areaPairs, contactName: snap.contactName, contactPhone: snap.contactPhone,
    comments: snap.comments, shareWith: snap.internal ? 'internal' : 'all',
    arcClaim: snap.arc || null, simNumber: snap.sim || null,
    attachments: _attachments.map(a => a.dataUrl), screenshotDataUrl: (_attachments[0] && _attachments[0].dataUrl) || null,
    domicile: unit.site || unit.domicileSite || '',
    towDirection,
    // Location for the wizard's Location step (off-site => address, not geofence).
    offSite: loc.offSite, locStreet: loc.locStreet, locCity: loc.locCity, locState: loc.locState, locZip: loc.locZip,
    towStreet: snap.towStreet, towCity: snap.towCity, towState: snap.towState, towZip: snap.towZip,
    towFromStreet: snap.towFromStreet, towFromCity: snap.towFromCity, towFromState: snap.towFromState, towFromZip: snap.towFromZip,
    copiedFromWorkRequestId: copiedFromWorkRequestId || null,
  };
}

// Autofill the CURRENTLY ACTIVE tab only — same "Open in AAP (autofill)"
// mechanism as the single-WR path (aap.autofill opens a window + fills, you
// review/submit there). Marks the tab done once the window settles; opens
// the Dealer WO once BOTH required tabs are done, same as Submit.
async function _autofillActiveTab(btn) {
  if (!_unit || !_unit.assetUrl) { toast.show('warn', 'No AAP URL for this unit — run a scan first', 4000); return; }
  const st = _wrTabState;
  const key = st.active;
  st[key] = _snapshotForm();
  const snap = st[key];
  if (!window.confirm('Open AAP and autofill this ' + (key === 'repair' ? 'Repair' : 'Tow') + ' work order: "' + (snap.title || '').slice(0, 90) + '"? You will review and Submit it there.')) return;

  const NEW_WR_URL = 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24';
  const origText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Autofilling ' + key + '…';
  const stopBtn = _el('wr-stop-autofill');
  const onStopClick = async () => { if (stopBtn) stopBtn.disabled = true; await aap.stopAutofill(); toast.show('info', 'Autofill stopped.', 3000); };
  if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.addEventListener('click', onStopClick); }

  const copiedFrom = key === 'tow' ? ((st.submitted.repair && st.submitted.repair.workRequestId) || null) : null;
  const payload = _snapshotToAutofillPayload(snap, copiedFrom);
  try {
    toast.show('info', 'Opening AAP to autofill the ' + key + ' WR — review and Submit it in that window…', 5000);
    const result = await aap.autofill(NEW_WR_URL, payload);
    if (result && result.ok === false) {
      toast.show('error', key + ' autofill: ' + (result.message || 'stopped') + ' — finish it manually in the AAP window.', 7000);
    } else {
      toast.show('success', (result && result.message) || (key + ' WR autofilled — review & submit in AAP.'), 4000);
      // We can't know the real workRequestId from autofill (user submits
      // manually in the AAP window), so mark the tab "attempted" rather than
      // carrying a workRequestId — still lets the Dealer WO open once both
      // tabs have been through autofill.
      st.submitted[key] = { workRequestId: null, viaAutofill: true };
      _renderTabBar();
      await _afterTabSubmitted();
    }
  } catch (e) {
    toast.show('error', 'Autofill failed: ' + e.message, 5000);
  } finally {
    btn.disabled = false; btn.textContent = origText;
    if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.removeEventListener('click', onStopClick); }
  }
}

// "Autofill All" via Submit All's button is covered by _submitAllTabs for the
// createWR path; for autofill, Submit All is intentionally the createWR path
// (per user: Submit = auto-submit). The per-tab autofill button above covers
// the "open in AAP, I'll submit it" case for each WR individually.

// Local copy of unit-detail's vendorKey derivation (paccar/volvo/null).
function _detectVendorKeyLocal(unit) {
  const hay = [unit && unit.manufacturer, unit && unit.make, unit && unit.vendor, unit && unit.model]
    .map(s => String(s || '').toLowerCase()).join(' ');
  if (/kenworth|peterbilt|paccar|kwne/.test(hay)) return 'paccar';
  if (/volvo/.test(hay)) return 'volvo';
  return null;
}

// ── Progress log ──────────────────────────────────────────────────────────
function _logProgress(msg, status) {
  const wrap = _el('wr-progress-wrap');
  const log  = _el('wr-progress-log');
  if (!log) return;
  if (wrap) wrap.style.display = '';
  const line = document.createElement('div');
  line.className = 'wr-progress-line';
  // Optional status (2nd arg): 'ok' → green ✓ prefix, 'err' → red ✗, 'run' →
  // a spinner-ish ⋯. Lets each submit step show its own success confirmation
  // in the progress panel instead of only one line at the very end.
  const icon = status === 'ok' ? '✓ ' : status === 'err' ? '✗ ' : status === 'run' ? '⋯ ' : '';
  line.textContent = icon + msg;
  if (status === 'ok')  line.style.color = 'var(--ok,#3fb950)';
  if (status === 'err') line.style.color = 'var(--err,#f85149)';
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ── Wire: area rows ───────────────────────────────────────────────────────
function _wireAreaRows() {
  const rows = _el('wr-area-rows');
  if (!rows) return;

  rows.addEventListener('click', (e) => {
    const btn = e.target.closest('.wr-area-remove');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const row = _el('wr-area-row-' + idx);
    if (!row) return;
    if (rows.querySelectorAll('.wr-area-row').length > 1) {
      row.remove();
    } else {
      // Last row — reset the selects rather than remove the row.
      const a = _el('wr-area-' + idx); if (a) a.selectedIndex = 0;
      _repopulateL2(idx);
    }
  });

  _el('wr-add-area').addEventListener('click', () => {
    // No fixed cap — a unit can have any number of component areas. Keep a
    // sanity ceiling only to prevent runaway UI; the AAP WR accepts the full
    // suggestedItems list we send.
    const current = rows.querySelectorAll('.wr-area-row').length;
    if (current >= 50) { toast.show('warn', 'That is a lot of areas — 50 max per request', 2500); return; }
    rows.insertAdjacentHTML('beforeend', _areaPairRow(_areaCount++, '', '', ''));
  });

  _wireAreaCascade();
}

// Delegated cascade handler for the 3 category selects. Picking L1 repopulates
// L2 (and resets/hides L3); picking L2 repopulates + SHOWS L3 only when that L2
// has children. Idempotent — safe to call again after rows are rebuilt (it
// clears its own prior listener via a dataset flag on the container).
function _wireAreaCascade() {
  const rows = _el('wr-area-rows');
  if (!rows || rows.dataset.cascadeWired === '1') return;
  rows.dataset.cascadeWired = '1';
  rows.addEventListener('change', (e) => {
    const sel = e.target;
    if (!sel || sel.tagName !== 'SELECT') return;
    const idx = parseInt(sel.dataset.idx, 10);
    if (Number.isNaN(idx)) return;
    if (sel.id === 'wr-area-' + idx) {
      _repopulateL2(idx);
      _syncTowWrap();
    } else if (sel.id === 'wr-sub-' + idx) {
      _repopulateL3(idx);
    }
  });
}

// Repopulate row `idx`'s L2 select from the chosen L1 code, then reset L3.
function _repopulateL2(idx) {
  const aEl = _el('wr-area-' + idx);
  const sEl = _el('wr-sub-' + idx);
  if (!sEl) return;
  const items = aEl ? _l2ItemsFor(aEl.value) : [];
  sEl.innerHTML = avmOptionsHtml(items, '', '-- Sub-category --');
  _repopulateL3(idx);
}

// Repopulate + show/hide row `idx`'s L3 select from the chosen L2 code. Hidden
// (and emptied) when the L2 has no children.
function _repopulateL3(idx) {
  const sEl = _el('wr-sub-' + idx);
  const ssEl = _el('wr-subsub-' + idx);
  if (!ssEl) return;
  const items = sEl ? _l3ItemsFor(sEl.value) : [];
  if (items.length) {
    ssEl.innerHTML = avmOptionsHtml(items, '', '-- Sub-sub-category --');
    ssEl.style.display = '';
  } else {
    ssEl.innerHTML = avmOptionsHtml([], '', '-- Sub-sub-category --');
    ssEl.style.display = 'none';
  }
}

// Resolve an AI-provided area/sub (which may be a display name OR a code) to a
// matching option CODE in `items`. Case-insensitive match on code or
// displayName. Returns '' when no match. Keeps AI Fill working now that the
// selects are code-valued while the AI prompt still speaks in display text.
function _resolveAvmCode(items, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const vl = v.toLowerCase();
  const hit = (items || []).find((it) =>
    String(it.code || '').toLowerCase() === vl ||
    String(it.displayName || '').toLowerCase() === vl);
  return hit ? String(hit.code) : '';
}

// Apply an AI-provided {area, subcategory} (display text or codes) to row `idx`:
// resolve L1, repopulate + resolve L2, repopulate + show L3 if present. TOW is a
// passthrough (its synthetic code IS 'TOW' and its L2 values are the reasons).
function _applyAiAreaToRow(idx, area, subcategory) {
  const aEl = _el('wr-area-' + idx);
  const sEl = _el('wr-sub-' + idx);
  if (!aEl) return;
  // L1: TOW passes straight through; otherwise resolve against the live L1 list.
  const l1Items = (_avmTree && Array.isArray(_avmTree.l1)) ? _avmTree.l1.concat([{ code: TOW_L1_CODE, displayName: 'TOW' }]) : [{ code: TOW_L1_CODE, displayName: 'TOW' }];
  const l1code = String(area).trim().toUpperCase() === TOW_L1_CODE ? TOW_L1_CODE : _resolveAvmCode(l1Items, area);
  aEl.value = l1code;
  _repopulateL2(idx);
  if (!sEl) return;
  const l2code = _resolveAvmCode(_l2ItemsFor(l1code), subcategory);
  sEl.value = l2code;
  _repopulateL3(idx);
}

// Show/hide the Tow Destination section based on whether any row's L1 is TOW.
function _syncTowWrap() {
  const wrap = _el('wr-tow-wrap');
  if (!wrap) return;
  let isTow = false;
  const rowsEl = _el('wr-area-rows');
  const domRows = rowsEl ? rowsEl.querySelectorAll('.wr-area-row') : [];
  domRows.forEach((rowEl) => {
    const aEl = rowEl.querySelector('select.wr-area-input'); // first select = L1
    if (aEl && String(aEl.value) === TOW_L1_CODE) isTow = true;
  });
  wrap.style.display = isTow ? '' : 'none';
}

// ── Wire: urgency ─────────────────────────────────────────────────────────
function _wireUrgency() {
  const cb   = _el('wr-urgent');
  const wrap = _el('wr-urgency-reason-wrap');
  cb.addEventListener('change', () => {
    wrap.style.display = cb.checked ? '' : 'none';
  });
}

// ── Wire: optional section ────────────────────────────────────────────────
function _wireOptional() {
  const btn    = _el('wr-toggle-optional');
  const fields = _el('wr-optional-fields');
  btn.addEventListener('click', () => {
    const show = fields.style.display === 'none';
    fields.style.display = show ? '' : 'none';
    btn.textContent = show ? 'Hide' : 'Show';
  });
}

// ── Attachments: shared add/remove/render ───────────────────────────────
// FEATURE (2026-07-23): replaces the old single-screenshot-only flow.
// _attachments holds every file that will go out with the WR -- the
// auto-attached Uptake screenshot, a manually re-grabbed one, and/or
// anything the user drags in or picks from their computer.
function _addAttachment(name, dataUrl) {
  if (!dataUrl) return;
  if (_attachments.some(a => a.dataUrl === dataUrl)) return; // dedupe identical files
  _attachments.push({ name: name || 'attachment', dataUrl });
  _renderAttachments();
}

function _removeAttachment(index) {
  _attachments.splice(index, 1);
  _renderAttachments();
}

function _renderAttachments() {
  const list = _el('wr-attach-list');
  if (!list) return;
  list.innerHTML = _attachments.map((a, i) => `
    <div class="wr-attach-chip">
      <span class="wr-attach-chip__name">${_safe(a.name)}</span>
      <button type="button" class="wr-attach-chip__remove" data-idx="${i}" title="Remove">×</button>
    </div>`).join('');
  list.querySelectorAll('.wr-attach-chip__remove').forEach(btn => {
    btn.addEventListener('click', () => _removeAttachment(Number(btn.dataset.idx)));
  });
  const label = _el('wr-screenshot-label');
  if (label) {
    if (_attachments.length) {
      label.textContent = _attachments.length + ' file' + (_attachments.length > 1 ? 's' : '') + ' attached';
      label.className = 'wr-screenshot-label wr-screenshot-label--attached';
    } else {
      label.textContent = 'None';
      label.className = 'wr-screenshot-label';
    }
  }
}

// AAP accepts PNG/JPEG (and PDF) attachments. A user may drop a HEIC/webp/gif/
// bmp/tiff image that AAP would reject, so we normalize images to PNG BEFORE
// they go on the attachment list. PNG/JPEG pass through untouched; PDFs pass
// through. Anything the browser can decode is re-encoded to PNG via a canvas
// (no dependency). HEIC can't be decoded client-side — we keep it but warn so
// it's never a silent rejected upload.
const _ALLOWED_IMG = /^image\/(png|jpeg|jpg)$/i;

function _dataUrlToPng(dataUrl) {
  // Returns a Promise<string|null> — PNG data URL, or null if the browser
  // couldn't decode the source (e.g. HEIC).
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          if (!canvas.width || !canvas.height) return resolve(null);
          const ctx = canvas.getContext('2d');
          // white matte so transparency doesn't go black on JPEG-origin alpha
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch (_) { resolve(null); }
  });
}

function _pngName(name) {
  return String(name || 'attachment').replace(/\.[^.]+$/, '') + '.png';
}

// Read one or more browser File objects (from <input type=file> or a drop
// event) via FileReader -- purely renderer-side, no IPC needed. Images in a
// non-AAP format are auto-converted to PNG before attaching.
// Shared (also used by the unit-detail "Attach to open WR" section): read one
// File and normalize it for AAP. Resolves { name, dataUrl, converted, warn }
// or null if the file could not be read at all.
export function readFileAsAttachment(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = async () => {
      const dataUrl = reader.result;
      const mime = (file.type || '').toLowerCase();
      const name = (file.name || '').toLowerCase();
      const looksImage = mime.startsWith('image/') || /^data:image\//i.test(String(dataUrl)) ||
        /\.(heic|heif|webp|gif|bmp|tif|tiff|avif)$/i.test(name);
      // PDFs and already-allowed images attach as-is.
      if (mime === 'application/pdf' || name.endsWith('.pdf') || _ALLOWED_IMG.test(mime)) {
        return resolve({ name: file.name, dataUrl });
      }
      // Any other image type -> convert to PNG.
      if (looksImage) {
        let png = await _dataUrlToPng(dataUrl);
        if (!png && (window.files && window.files.heicToPng) &&
            (/^image\/(heic|heif)$/i.test(mime) || /\.(heic|heif)$/i.test(name) || !mime)) {
          // Browser canvas can't decode HEIC — convert in the main process via
          // the pure-JS heic-convert library, then attach the PNG it returns.
          try {
            const res = await window.files.heicToPng(dataUrl);
            if (res && res.ok && res.dataUrl) png = res.dataUrl;
          } catch (_) { /* fall through to warning */ }
        }
        if (png) return resolve({ name: _pngName(file.name), dataUrl: png, converted: true });
        // Genuinely could not convert — keep it but be honest.
        return resolve({ name: file.name, dataUrl, warn: 'could not be converted. Try exporting it as PNG/JPEG first.' });
      }
      // Non-image, non-PDF (rare, input accepts image/*,.pdf) — attach as-is.
      resolve({ name: file.name, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

function _readFilesAsAttachments(fileList) {
  Array.from(fileList || []).forEach(async (file) => {
    const att = await readFileAsAttachment(file);
    if (!att) { toast.show('warn', 'Could not read "' + file.name + '"', 3000); return; }
    _addAttachment(att.name, att.dataUrl);
    if (att.converted) toast.show('info', 'Converted "' + file.name + '" to PNG for upload', 2500);
    if (att.warn) toast.show('warn', '"' + file.name + '" ' + att.warn, 5000);
  });
}

// ── Wire: screenshot / attachments ───────────────────────────────
function _wireScreenshot() {
  const btn = _el('wr-attach-screenshot');
  const BTN_LABEL = 'Attach Uptake screenshots';
  btn.textContent = BTN_LABEL;
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Loading...';
    try {
      // A unit can have MULTIPLE Uptake insights (e.g. 622086 has 3), and the
      // scraper takes ONE screenshot per insight into unit.screenshots[]. This
      // used to attach only screenshotPath || screenshots[0] — the first one —
      // so the other insights' screenshots were silently dropped from the WR.
      // Attach ALL of them (deduped by _addAttachment's identical-dataUrl guard).
      const paths = Array.from(new Set(
        [].concat(
          (_unit && _unit.screenshotPath) ? [_unit.screenshotPath] : [],
          (_unit && Array.isArray(_unit.screenshots)) ? _unit.screenshots : []
        ).filter(Boolean)
      ));
      if (!paths.length) {
        toast.show('info', 'No Uptake screenshot found for this unit — run a sync first', 4000);
        return;
      }
      let attached = 0, failed = 0;
      for (const p of paths) {
        try {
          const dataUrl = await files.readAsDataUrl(p);
          if (dataUrl) { _addAttachment(p.split(/[/\\]/).pop(), dataUrl); attached++; }
          else failed++;
        } catch (_) { failed++; }
      }
      if (attached) {
        toast.show('success', attached + ' screenshot' + (attached > 1 ? 's' : '') + ' attached' + (failed ? ' (' + failed + ' unreadable)' : ''), 2500);
      } else {
        toast.show('warn', 'Could not read screenshot file' + (paths.length > 1 ? 's' : ''), 3000);
      }
    } catch (e) {
      toast.show('error', 'Screenshot load failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = BTN_LABEL;
    }
  });

  // Manual file picker
  const fileInput = _el('wr-attach-file-input');
  const browseBtn = _el('wr-attach-browse');
  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      _readFilesAsAttachments(fileInput.files);
      fileInput.value = '';
    });
  }

  // Drag-and-drop
  const dropzone = _el('wr-dropzone');
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('wr-dropzone--active');
    }));
    ['dragleave', 'dragend'].forEach(evt => dropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('wr-dropzone--active');
    }));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('wr-dropzone--active');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        _readFilesAsAttachments(e.dataTransfer.files);
      }
    });
  }

  _renderAttachments();
}

// ── Wire: title character counter ──────────────────────────────────────────
// Typing is UNRESTRICTED — the title field is where the user describes their
// full request/intent; AI Fill reads it and produces the final <=90-char
// summary title. Only the AI's OUTPUT is capped (see _runAIAssist / _doSubmit).
function _wireTitleCount() {
  const titleEl = _el('wr-title');
  const countEl = _el('wr-title-count');
  if (!titleEl || !countEl) return;
  const update = () => {
    const n = (titleEl.value || '').length;
    countEl.textContent = n <= 90 ? (n + '/90') : (n + ' chars — AI Fill will summarize to 90');
    countEl.style.color = n > 90 ? 'var(--acc,#58a6ff)' : (n >= 80 ? 'var(--warn,#b8860b)' : '');
  };
  titleEl.addEventListener('input', update);
  update();
}

// ── Wire: submit ──────────────────────────────────────────────────────────
function _wireSubmit() {
  const submitBtn   = _el('wr-submit');
  const secondBtn   = _el('wr-submit-second');
  const fallbackBtn = _el('wr-autofill-fallback');
  const resultEl    = _el('wr-result');

  // Shared submit core used by BOTH "Submit WR" and "+ 2nd WR (reuse data)".
  // For the 2nd-WR path, `copyFromWrId` links the new WR to the existing one
  // (AAP copiedFromWorkRequestId) and ALL current form data is reused as-is —
  // the only thing that differs is the title the user supplies.
  async function _doSubmit(btn, opts) {
    opts = opts || {};
    // The 2nd-WR path reuses all data + links to the existing WR.
    _copyFromWrId = opts.copyFromWrId || null;
    const payload = _collectPayload();
    if (!payload.title)  { toast.show('warn', 'WR title required', 3000); _copyFromWrId = null; return; }
    // Supplier guard: a vendor flagged supplierRequired must have a supplier
    // chosen before we commit anything. Block (no commit) and prompt the user.
    if (_supplierMissing()) {
      toast.show('warn', 'This vendor requires a supplier — pick one', 4000);
      _copyFromWrId = null; return;
    }
    // Title is unrestricted while typing; _collectPayload() already caps the
    // SUBMITTED value at 90 chars (AI Fill produces a proper summary — this
    // slice is just a safety net if the user submits without running it).

    // Safety net: if the title clearly implies a tow-to-dealer but AI Fill
    // hasn't run yet (no _towPlan), tell the user to run AI Fill so the
    // multi-WR plan is built, rather than silently creating a single WR.
    if (!_towPlan && !opts.copyFromWrId) {
      const t = (payload.title || '').toLowerCase();
      const looksTow = /(^|\b)(tow|needs to go to|send (it |unit )?to|take (it|unit) to|return tow|back to (the )?yard|haul to)\b/.test(t);
      if (looksTow) {
        toast.show('warn', 'This looks like a tow-to-dealer. Press Enter in the title or click ✨ AI Fill first so it can set up the repair + tow work orders.', 7000);
        return;
      }
    }

    // Multi-tab tow: Submit acts on the CURRENTLY ACTIVE TAB ONLY (its live,
    // possibly-edited fields) via the deterministic createWR, auto-submitted.
    // When both tabs are submitted, opens the Dealer WO for non-RG dealers.
    if (_wrTabState && !opts.copyFromWrId) {
      await _submitActiveTab(btn);
      return;
    }
    if (opts.copyFromWrId) {
      // A second WR must have a DIFFERENT title from the existing WR it copies,
      // so it's a distinct request (e.g. a Dealer Tracking Event). We don't
      // block on "already open" — a second WR is always allowed with a new title.
      const existingTitle = String((_unit && (_unit.wrTitle || _unit.savedRepairStatus)) || '').trim().toLowerCase();
      if (existingTitle && payload.title.trim().toLowerCase() === existingTitle) {
        toast.show('warn', 'Give the 2nd WR a DIFFERENT title (e.g. "Dealer Tracking Event")', 4000);
        _copyFromWrId = null; return;
      }
    }

    const origText = btn.textContent;
    btn.disabled = true; btn.textContent = opts.copyFromWrId ? 'Creating 2nd WR...' : 'Submitting...';
    submitBtn.disabled = true; secondBtn.disabled = true; fallbackBtn.disabled = true;
    resultEl.style.display = 'none';
    _el('wr-progress-wrap').style.display = '';
    _el('wr-progress-log').innerHTML = '';

    if (_progUnsub) { _progUnsub(); _progUnsub = null; }
    _progUnsub = aap.onWRProgress(_logProgress);

    // Submit WR drives the LIVE AI wizard (adaptive agent): opens AAP, reads
    // Submit WR now creates the work order DIRECTLY via AAP's VRE
    // recommendation API (PUT /vre/recommendation/UNPLANNED/ACTIVE), two-phase:
    //   Phase 1 — ask AAP which vendor it recommends (nothing committed).
    //   Phase 2 — commit the WO with the confirmed vendor (the operator's
    //             picked vendor if they chose one, else the recommended one,
    //             confirmed via a prompt).
    // The "Open in AAP (autofill)" button is the untouched manual backup.
    btn.textContent = 'Creating WR in AAP…';
    try {
      // The VRE API needs the asset id, which lives on the unit's AAP asset URL.
      const assetUrl = _unit && _unit.assetUrl;
      if (!assetUrl) {
        _showError('No AAP asset URL for this unit — run a scan first, or use "Open in AAP (autofill)".');
        return;
      }

      // ── Phase 1: get the vendor recommendation ──────────────────────────
      _logProgress('Requesting AAP vendor recommendation…', 'run');
      const rec = await aap.createWorkOrder({ ...payload, assetUrl, confirmVendor: false });
      if (!rec || !rec.ok) {
        _logProgress('Vendor recommendation failed', 'err');
        _showError((rec && (rec.error || rec.message)) || 'AAP did not return a vendor recommendation.');
        return;
      }
      const recommendedVendor = (rec.recommendation && rec.recommendation.vendor) || '';
      const _recRule = (rec.recommendation && rec.recommendation.ruleName) || '';
      _logProgress('Recommendation received: ' + (recommendedVendor || '(none)') +
        (_recRule ? ' (rule: ' + _recRule + ')' : ''), 'ok');

      // Vendor the operator picked in the form (display string → code is done
      // backend-side). If they left it blank, fall back to AAP's recommendation.
      const pickedDisplay = (payload.vendor || '').trim();
      const commitVendor  = pickedDisplay || recommendedVendor;

      if (!commitVendor) {
        _showError('AAP could not recommend a vendor and none was selected. Pick a vendor and try again.');
        return;
      }

      // Confirm before committing. If the operator picked a vendor that differs
      // from AAP's recommendation, surface both so they can decide.
      const confirmMsg = pickedDisplay
        ? ('Create this work order and assign vendor "' + pickedDisplay + '"?' +
           (recommendedVendor && recommendedVendor.toUpperCase() !== pickedDisplay.split(' (')[0].toUpperCase()
             ? '\n\n(AAP recommended: ' + recommendedVendor + ')' : ''))
        : ('AAP recommends vendor "' + recommendedVendor + '".\n\nCreate this work order with that vendor?');
      const confirmFull = confirmMsg + _flipConfirmText();
      if (!window.confirm(confirmFull)) {
        if (_progUnsub) { _progUnsub(); _progUnsub = null; }
        toast.show('info', 'Work order not created — vendor not confirmed.', 4000);
        return;
      }

      // ── Phase 2: commit the work order with the confirmed vendor ────────
      btn.textContent = 'Submitting WR…';
      const _attachCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
      _logProgress('Creating work order with vendor ' + commitVendor + '…', 'run');
      const result = await aap.createWorkOrder({
        ...payload, assetUrl, confirmVendor: true, vendor: commitVendor,
      });
      if (_progUnsub) { _progUnsub(); _progUnsub = null; }

      if (result && result.ok) {
        const wrId = result.workRequestId || '';
        _logProgress('Work order created' + (wrId ? ' — WR ' + wrId : '') +
          ' (vendor ' + (result.vendor || commitVendor) + ')', 'ok');

        // Per-attachment confirmation. result.attachments = [{name, ok, error}]
        // from the backend upload step (present only when attachments were sent).
        const atts = Array.isArray(result.attachments) ? result.attachments : [];
        let attachOk = 0, attachFail = 0;
        for (const a of atts) {
          if (a && a.ok) { attachOk++; _logProgress('Attachment uploaded: ' + (a.name || 'file'), 'ok'); }
          else { attachFail++; _logProgress('Attachment FAILED: ' + ((a && a.name) || 'file') + (a && a.error ? ' — ' + a.error : ''), 'err'); }
        }
        if (_attachCount && !atts.length) {
          _logProgress(_attachCount + ' attachment(s) queued — upload result not reported', 'run');
        }

        // Build the final result banner, summarizing attachments when present.
        let attachSummary = '';
        if (atts.length) {
          attachSummary = ' · ' + attachOk + '/' + atts.length + ' file' + (atts.length > 1 ? 's' : '') + ' uploaded' +
            (attachFail ? ' (' + attachFail + ' failed)' : '');
        }
        resultEl.innerHTML = `
          <div class="wr-result--success">
            <span class="wr-result__icon">✓</span>
            <span>Work order created${wrId ? ' — WR ' + _safe(wrId) : ''} (vendor ${_safe(result.vendor || commitVendor)})${_safe(attachSummary)}</span>
          </div>`;
        resultEl.style.display = '';
        toast.show('success', 'WR created' + (wrId ? ' ' + wrId : '') + (attachSummary || ''), 6000);
        await _maybeFlipUnavailable(wrId);
        const _eqId = _unit && (_unit.equipmentId || _unit.id);
        if (_eqId && relay && typeof relay.refreshUnit === 'function') {
          relay.refreshUnit(_eqId).catch(() => {});
        }
      } else {
        // Self-healing diagnosis: when the backend got STUCK on a specific
        // field, show exactly where + what it tried to correct, so the problem
        // is actionable instead of a generic "failed".
        if (result && result.stuckField) {
          _logProgress('Stuck at field "' + result.stuckField + '"', 'err');
        }
        if (result && Array.isArray(result.corrections) && result.corrections.length) {
          _logProgress('Auto-corrections attempted: ' + result.corrections.join('; '), 'run');
        }
        _logProgress('Work order creation failed', 'err');
        const diag = (result && result.stuckField)
          ? ('Stuck at "' + result.stuckField + '". ' + ((result.error || '')) +
             (result.aapMessage ? ' AAP said: ' + String(result.aapMessage).slice(0, 220) : ''))
          : ((result && (result.error || result.message)) || 'AAP rejected the work order.');
        _showError(diag);
      }
    } catch (e) {
      if (_progUnsub) { _progUnsub(); _progUnsub = null; }
      _showError(e.message);
    } finally {
      _copyFromWrId = null;
      submitBtn.disabled = false; submitBtn.textContent = 'Submit WR';
      secondBtn.disabled = false; secondBtn.textContent = '+ 2nd WR (reuse data)';
      fallbackBtn.disabled = false;
      btn.textContent = origText;
    }
  }

  // "Submit WR" — a normal (first/independent) work request.
  submitBtn.addEventListener('click', () => _doSubmit(submitBtn, {}));

  // "+ 2nd WR (reuse data)" — a SECOND work request that reuses ALL of this
  // unit's current form data and links to the existing WR via AAP's
  // copiedFromWorkRequestId. Requires only a DIFFERENT title (e.g. a Dealer
  // Tracking Event). If no existing WR id is resolvable, we still create the
  // second WR (unlinked) rather than block — a dealer-tracking-only WR is valid.
  secondBtn.addEventListener('click', () => {
    const copyFrom = _existingWrId(_unit);
    if (!copyFrom) toast.show('info', 'No existing WR found to link — creating a standalone second WR with your title.', 4000);
    _doSubmit(secondBtn, { copyFromWrId: copyFrom });
  });

  // FIX (2026-07-23): this handler called aap.createWR() -- the same
  // deterministic API path as the Submit WR button -- instead of
  // aap.autofill(). That meant clicking 'Open in AAP (autofill)' silently
  // repeated the same createRepair call (and its Forbidden/etc. failure)
  // with no browser window ever opening. Delegate to the same
  // _autofillFallback() the post-error 'Try AAP autofill instead' button
  // already uses correctly.
  fallbackBtn.addEventListener('click', async () => {
    // Multi-tab tow: autofill the CURRENTLY ACTIVE tab only (same mechanism,
    // per-WR) instead of a single combined autofill window.
    if (_wrTabState) { await _autofillActiveTab(fallbackBtn); return; }
    await _autofillFallback(_collectPayload());
  });
}

function _showError(msg) {
  const resultEl = _el('wr-result');
  if (!resultEl) return;
  resultEl.innerHTML = `
    <div class="wr-result--error">
      <span class="wr-result__icon">✗</span>
      <span>Submit failed: ${_safe(msg)}</span>
      <button id="wr-fallback-from-error" class="detail-panel__btn detail-panel__btn--secondary">
        Try AAP autofill instead
      </button>
    </div>`;
  resultEl.style.display = '';
  const fbBtn = _el('wr-fallback-from-error');
  if (fbBtn) fbBtn.addEventListener('click', () => _autofillFallback(_collectPayload()));
}

async function _autofillFallback(payload) {
  if (!_unit || !_unit.assetUrl) {
    toast.show('warn', 'No AAP URL for this unit — run a scan first', 4000);
    return;
  }
  // BUG FIX (2026-07-16): previously showed a static 'Opening AAP in
  // autofill mode...' info toast immediately after requesting the
  // window open, then NEVER checked what actually happened -- the IPC
  // call used to resolve with a hardcoded {ok:true} the instant the
  // window was created, regardless of whether the fill script ever ran
  // or succeeded. This was the user-facing half of "I click Open in AAP
  // (autofill) and it does nothing but open the link" -- the backend
  // fix (src/ipc/scrapers.js's 'aap:autofill' handler + aap_autofill_
  // engine.js's run()) now actually waits for and returns a real
  // {ok, message} result; this now displays it honestly instead of
  // assuming success.
  const fbBtn = _el('wr-autofill-fallback');
  const fbBtnOriginalText = fbBtn ? fbBtn.textContent : '';
  if (fbBtn) { fbBtn.disabled = true; fbBtn.textContent = 'Filling in AAP\u2026'; }
  toast.show('info', 'Opening AAP and filling in fields \u2014 this can take up to a minute...', 4000);
  // Stop button lets the user abort a stuck/unresponsive autofill window
  // without having to force-close the whole app.
  const stopBtn = _el('wr-stop-autofill');
  const onStopClick = async () => {
    if (stopBtn) { stopBtn.disabled = true; }
    const r = await aap.stopAutofill();
    toast.show('info', r && r.ok ? 'Autofill stopped.' : (r && r.message) || 'Autofill stopped.', 3000);
  };
  if (stopBtn) {
    stopBtn.style.display = '';
    stopBtn.disabled = false;
    stopBtn.addEventListener('click', onStopClick);
  }
  try {
    // FIX (2026-07-23): was passing _unit.assetUrl (the asset's own
    // detail page) here. aap_autofill_engine.js does not read equipment
    // context from the URL at all -- it types payload.unit into an empty
    // Equipment ID combobox on AAP's generic 'New Work Request' page.
    // Opening assetUrl landed on the wrong page entirely (no such
    // combobox there), which is why autofill opened 'the wrong URL'.
    // The correct fixed entry point (same one runAdaptiveWR() uses) is:
    const NEW_WR_URL = 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24';
    const result = await aap.autofill(NEW_WR_URL, payload);
    if (result && result.ok === false) {
      toast.show('error', 'AAP autofill stopped: ' + (result.message || 'unknown error') + ' \u2014 finish filling manually in the AAP window.', 7000);
    } else {
      toast.show('success', (result && result.message) || 'AAP autofill complete \u2014 review before submitting.', 4000);
    }
  } catch (e) {
    toast.show('error', 'Autofill launch failed: ' + e.message);
  } finally {
    if (fbBtn) { fbBtn.disabled = false; fbBtn.textContent = fbBtnOriginalText; }
    if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.removeEventListener('click', onStopClick); }
  }
}

// ── Open / close ──────────────────────────────────────────────────────────
function _close() {
  if (_progUnsub) { _progUnsub(); _progUnsub = null; }
  if (_towAddrUnsub) { _towAddrUnsub(); _towAddrUnsub = null; }
  if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay   = null;
  _unit      = null;
  _areaCount = 1;
  _attachments = [];
  _copyFromWrId = null;
  _towPlan   = null;
  _wrTabState = null;
  _flipDone  = false;
  _flipReasonTouched = false;
  _avmTree   = null;
  _vreRec    = null; // recommendation is unit-specific — clear it on close.
  // _vendorList is intentionally kept (6h-cached, vendor set is unit-agnostic).
}


// ── Tow Address Handling (uses Contact Book) ─────────────────────────────
async function _wireTow() {
  // BUG FIX (2026-07-16): resurrects a real listener for the Contact
  // Book's "Use for Tow" button (components/contact-book.js,
  // which does `bus.emit('contacts:use-address', {...})` on click). This
  // listener previously existed ONLY as dead text accidentally pasted
  // inside an unrelated string literal (areaList's .join() separator, a
  // few hundred lines below in this same file) -- meaning the button has
  // never worked: clicking it fired an event that nothing was listening
  // for. Restored as real, executable code. Registered unconditionally
  // (before the early-return below) since it only touches simple DOM
  // fields and doesn't depend on window.contacts or the towBook/fromBook
  // select elements existing.
  _towAddrUnsub = bus.on('contacts:use-address', (addr) => {
    const s = _el('wr-tow-street'); if (s) s.value = addr.street || '';
    const ct = _el('wr-tow-city');  if (ct) ct.value = addr.city || '';
    const st = _el('wr-tow-state'); if (st) st.value = addr.state || '';
    const z = _el('wr-tow-zip');    if (z) z.value = addr.zip || '';
    const tw = _el('wr-tow-wrap');  if (tw) tw.style.display = '';
    toast.show('success', 'Tow address filled from contact' + (addr.name ? ': ' + addr.name : ''), 2500);
  });

  const towBook = _el('wr-tow-book');
  const fromBook = _el('wr-tow-from-book');
  if (!towBook || !fromBook || !window.contacts) return;

  // Load contacts that have addresses
  const all = await window.contacts.getAll();
  const vendors = all.filter(c => c.type === 'vendor' && c.street);
  const domiciles = all.filter(c => c.type === 'domicile' && c.street);

  // Option 2: prioritize vendors near the unit's domicile (nearest-first) at
  // the top of the tow dropdowns; everything else stays available below.
  const unitSite = ((_unit && (_unit.domicileSite || _unit.site)) || '').toUpperCase();
  const _towMi = (v) => (v.mileageByDomicile && v.mileageByDomicile[unitSite] != null) ? v.mileageByDomicile[unitSite] : null;
  const _towServes = (v) => unitSite && (
    (Array.isArray(v.domiciles) && v.domiciles.map(d => String(d).toUpperCase()).indexOf(unitSite) !== -1) ||
    (v.mileageByDomicile && v.mileageByDomicile[unitSite] != null)
  );
  const _towNear = unitSite ? vendors.filter(_towServes).slice().sort((a, b) => {
    const ma = _towMi(a), mb = _towMi(b);
    if (ma == null && mb == null) return (a.name || '').localeCompare(b.name || '');
    if (ma == null) return 1; if (mb == null) return -1; return ma - mb;
  }) : [];
  const _towOther = vendors.filter(v => _towNear.indexOf(v) === -1);
  const _towVLabel = (v) => { const mi = _towMi(v); return v.name + (mi != null ? ' (' + mi + ' mi)' : '') + ' - ' + v.street + ', ' + (v.city || '') + ' ' + (v.state || ''); };
  const _towDLabel = (d) => d.name + ' - ' + d.street + ', ' + (d.city || '') + ' ' + (d.state || '');
  const _towGroup = (sel, lbl, items, labeler) => {
    if (!items.length) return;
    const og = document.createElement('optgroup'); og.label = lbl;
    items.forEach(c => { const o = document.createElement('option'); o.value = JSON.stringify(c); o.textContent = labeler(c); og.appendChild(o); });
    sel.appendChild(og);
  };

  // Populate tow destination: nearest vendors for the unit's domicile FIRST,
  // then the rest, then home yards. Nothing hidden.
  towBook.innerHTML = '<option value="">Select destination...</option>';
  if (_towNear.length) _towGroup(towBook, 'NEAREST \u2014 ' + unitSite, _towNear, _towVLabel);
  _towGroup(towBook, _towNear.length ? 'OTHER VENDORS' : 'VENDORS', _towOther, _towVLabel);
  _towGroup(towBook, 'HOME YARDS', domiciles, _towDLabel);

  // Populate tow pickup: unit's own yard first, then other yards, then vendors.
  fromBook.innerHTML = '<option value="">Select pickup location...</option>';
  {
    const _hy = unitSite ? domiciles.filter(d => (d.name || '').toUpperCase().indexOf(unitSite) !== -1) : [];
    const _oy = domiciles.filter(d => _hy.indexOf(d) === -1);
    _towGroup(fromBook, _hy.length ? "UNIT'S YARD" : 'HOME YARDS', _hy, _towDLabel);
    if (_hy.length) _towGroup(fromBook, 'OTHER HOME YARDS', _oy, _towDLabel);
    _towGroup(fromBook, 'VENDORS', [].concat(_towNear, _towOther), _towVLabel);
  }

  towBook.addEventListener('change', () => {
    if (!towBook.value) return;
    const loc = JSON.parse(towBook.value);
    _el('wr-tow-street').value = loc.street || '';
    _el('wr-tow-city').value = loc.city || '';
    _el('wr-tow-state').value = loc.state || '';
    _el('wr-tow-zip').value = loc.zip || '';
  });
  fromBook.addEventListener('change', () => {
    if (!fromBook.value) return;
    const loc = JSON.parse(fromBook.value);
    _el('wr-tow-from-street').value = loc.street || '';
    _el('wr-tow-from-city').value = loc.city || '';
    _el('wr-tow-from-state').value = loc.state || '';
    _el('wr-tow-from-zip').value = loc.zip || '';
  });

  // Show/hide the tow section when a row's Category is TOW. The area rows are
  // now cascading <select>s rebuilt on snapshot restore, so this is driven by
  // the delegated cascade handler (_syncTowWrap) rather than a per-element
  // listener that would be lost on rebuild.
  _syncTowWrap();

  // Auto-fill pickup from unit domicile
  const unit = _unit || {};
  const site = (unit.domicileSite || unit.site || '').toUpperCase();
  if (site && domiciles.length) {
    const match = domiciles.find(d => (d.name || '').toUpperCase().includes(site));
    if (match) {
      _el('wr-tow-from-street').value = match.street || '';
      _el('wr-tow-from-city').value = match.city || '';
      _el('wr-tow-from-state').value = match.state || '';
      _el('wr-tow-from-zip').value = match.zip || '';
    }
  }
}

// ── AI Assist — auto-fill from title ──────────────────────────────────────
let _aiTimer = null;
let _aiRunning = false; // BUG FIX (2026-07-16): see keydown/run guard below
function _wireAIAssist() {
  const titleEl = _el('wr-title');
  const btn = _el('wr-ai-assist');
  if (!btn || !titleEl) return;
  // AI Fill runs ONLY on an EXPLICIT action: clicking the AI Fill button, or
  // pressing Enter in the title field. EXACTLY ONE call per action, then done.
  //
  // FIX (2026-09-08): removed the auto-fire-on-input debounce. Previously an
  // 'input' listener re-armed a 2.5s timer on every keystroke and fired
  // _runAIAssist() automatically whenever you paused typing — so editing a
  // title produced MULTIPLE unrequested AI calls (and races), which is exactly
  // "it keeps making AI calls instead of one call → output → done". AI Fill is
  // now strictly user-triggered.
  btn.addEventListener('click', () => _runAIAssist());
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _runAIAssist(); }
  });
}

// Gather this unit's Uptake insight text. Returns a clean string or ''.
function _uptakeText(unit) {
  return (unit.insightsList || [])
    .map(i => (typeof i === 'object' ? (i.summary || i.text || '') : i))
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join('; ');
}

async function _runAIAssist() {
  // BUG FIX (2026-07-16): defense-in-depth alongside the keydown fix above
  // -- guards against ANY overlapping call (double Enter, button click
  // mid-flight, etc.) actually executing concurrently and racing to
  // overwrite each other's field writes.
  if (_aiRunning) { toast.show('info', 'AI Fill already running\u2026', 1500); return; }
  _aiRunning = true;
  const titleEl = _el('wr-title');
  const btn = _el('wr-ai-assist');
  const title = (titleEl.value || '').trim();
  if (!title) { toast.show('warn', 'Type a title first', 2000); _aiRunning = false; return; }

  btn.disabled = true; btn.textContent = '⏳ AI...';
  
  const unit = _unit || {};
  const unitId = unit.id || unit.equipmentId || '';
  const make = unit.manufacturer || '';
  const site = unit.domicileSite || unit.site || '';
  const notes = (unit.savedNotes || '').substring(0, 500);
  // Cap the Uptake insight text — a unit's full guidance can be thousands of
  // chars and pushed the whole prompt past ai:ask's 32000-char limit (confirmed
  // live: "use uptake data" → prompt 32027 → ConfigError → no fill). 2500 chars
  // is plenty for the AI to summarize the insight into the WR.
  const uptake = _uptakeText(unit).substring(0, 2500);
  
  // BUG FIX (2026-07-16): this .join(...) call's separator argument was NOT
  // '\n' -- it was corrupted into a huge string containing a large block of
  // UNRELATED real code as dead text (a bus.on('contacts:use-address', ...)
  // listener that was clearly meant to be a real, separate statement
  // elsewhere in this file -- see _wireTow() below where it's now properly
  // restored as executable code). This meant EVERY area/subcategory list
  // entry sent to the AI Assist prompt (the "✨ AI Fill" / Enter-key feature)
  // was being joined with this huge garbage blob instead of a clean
  // newline -- injecting dozens of lines of irrelevant JS source into the
  // "VALID AREAS/SUBCATEGORIES" section of the prompt sent to the LLM on
  // every single AI Assist call. This is the most likely root cause of the
  // "AI struggles to fill out the rest" behavior: the model was being asked
  // to parse a corrupted, code-polluted area list every time, which would
  // plausibly cause inconsistent/hallucinated area+subcategory values or
  // outright malformed JSON responses depending on how the model handled
  // the injected noise.
  const areaList = Object.entries(AREA_SUBS).map(([a, s]) => a + ': ' + s.join(', ')).join('\n');
  
  // Load vendor + domicile book for AI context (vendors for dealer matching,
  // domiciles for tow pickup address + gate code).
  let vendorBookCtx = '';
  let domicileBookCtx = '';
  if (window.contacts) {
    try {
      const allContacts = await window.contacts.getAll();
      const vendors = allContacts.filter(v => v.type === 'vendor' && v.street);
      if (vendors.length) {
        vendorBookCtx = '\nVENDOR BOOK (pick dealer by unit domicile + make; "miles" = distance from that site):\n' +
          vendors.map(v => {
            const miStr = v.mileageByDomicile ? Object.entries(v.mileageByDomicile).map(([s, m]) => s + ':' + m + 'mi').join(' ') : '';
            return v.name + ' | Make: ' + ((Array.isArray(v.makes) && v.makes.length ? v.makes.join('/') : v.make) || 'ANY') + ' | Domiciles: ' + (v.domiciles || []).join(',') + (miStr ? ' | ' + miStr : '') + ' | ' + v.street + ', ' + (v.city||'') + ' ' + (v.state||'') + ' ' + (v.zip||'');
          }).join('\n') +
          '\nWhen user names a dealer (e.g. "gabriellis", "to the pete store"): match it to the closest-named vendor in this book that serves the unit domicile. If user says "send to dealer" with no name, pick the vendor matching unit make AND domicile (nearest first). If no match, leave vendor empty.\n';
      }
      const domiciles = allContacts.filter(d => d.type === 'domicile' && d.street);
      if (domiciles.length) {
        domicileBookCtx = '\nDOMICILE BOOK (home yards — use for tow PICKUP/RETURN address + gate code):\n' +
          domiciles.map(d => d.name + ' | ' + d.street + ', ' + (d.city||'') + ' ' + (d.state||'') + ' ' + (d.zip||'') + ' | Gate Code: ' + (d.gateCode ? d.gateCode : 'None')).join('\n') + '\n';
      }
    } catch(e) {}
  }

  // AAP LIVE VENDOR LIST — the EXACT values the vendor dropdown is populated
  // with (from window.aapApi.vendors()). These are the only valid override
  // values; many are vendor + LOCATION entries (e.g. "Gabrielli Truck Sales &
  // Service - Rockaway"). The AI must pick the override from THIS list so it
  // matches a real dropdown option. Flag integrated vendors (wrEnabled).
  let aapVendorCtx = '';
  try {
    const live = (_vendorList || []).map((v) => v && v.vendorName).filter(Boolean);
    if (live.length) {
      aapVendorCtx = '\nAAP VENDOR LIST (these are the EXACT dropdown values — any vendor override MUST be one of these verbatim; many include a LOCATION after a dash):\n'
        + live.join('\n') + '\n';
    }
  } catch (_) {}

  const prompt = 'You are a fleet maintenance work request assistant for Amazon Transportation.\n\n'
    + 'User typed this WR title (free text — interpret their intent): "' + title + '"\n\n'
    + 'UNIT: ' + unitId + ' | Make: ' + make + ' | Site (home domicile): ' + site + '\n'
    + (notes ? 'Notes: ' + notes + '\n' : '')
    + (uptake ? 'Uptake Insights: ' + uptake + '\n' : '')
    + aapVendorCtx
    + vendorBookCtx
    + domicileBookCtx
    + '\nRULES — READ CAREFULLY. Interpret the user\'s words LITERALLY. Do not add intent they did not state. This decides ONE vs MULTIPLE work orders, the vendor, and urgency:\n'
    + '- URGENCY IS EXPLICIT ONLY: set urgent=true ONLY if the user literally says "urgent" (or "emergency"/"ASAP"/"priority"). If they do NOT say it, urgent=false — EVEN for brakes/safety/fire. Never infer urgency from the problem type. When urgent=true and no reason was given, urgencyReason="DEA - Asset Shortage".\n'
    + '- VENDOR vs LOCATION (two separate fields): vendor = the COMPANY from the AAP VENDOR LIST (verbatim, no location); vendorLocation = the branch/city the user named (or ""). AAP then shows a "preferred vendor location" picker for that vendor\'s branches.\n'
    + '    * THE USER\'S NAMED VENDOR ALWAYS WINS over the unit\'s make. Freightliner unit + "send to Kenworth"/"to Cummins" -> vendor=KWNE/Cummins. Honor what they SAID, not the make.\n'
    + '    * NAMED VENDOR + LOCATION ("send to Gabrielli Rockaway", "Allegiance Flemington", "Cummins Bristol", "Cox NY/NJ"): vendor = the company from the list (e.g. "Gabrielli", "Allegiance and Ascendance", "COX"), vendorLocation = the branch ("Rockaway", "Flemington", "Bristol", "NY/NJ"), vendorIsOverride=true.\n'
    + '    * NAMED VENDOR, NO LOCATION ("send to Gabrielli", "assign to Kenworth dealer"): vendor = that company, vendorLocation="" (the app auto-picks the CLOSEST branch to the asset), vendorIsOverride=true.\n'
    + '    * GENERIC "send to dealer" with NO vendor name: fall back to the unit\'s make — vendor = the AAP VENDOR LIST company matching the unit make, vendorLocation="", vendorIsOverride=true.\n'
    + '    * NO dealer/vendor mentioned (just a problem): vendor="", vendorLocation="", vendorIsOverride=false — defer to AAP\'s recommendation, do NOT guess.\n'
    + '    * vendor MUST be an exact company from the AAP VENDOR LIST. If nothing matches what the user named, leave vendor="" and note it in comments rather than inventing one.\n'
    + '- MOVING THE UNIT = TOW. Naming a dealer as a DESTINATION the unit must go to ("send/take/bring/needs to go TO <dealer>", "from <X> to <dealer>") means the physical unit is towed there -> isTow=true. Naming a dealer is the tow signal; the word "tow" is not required.\n'
    + '- REPAIR vs TOW-ONLY (hasRepair):\n'
    + '    * hasRepair=true when a mechanical problem/symptom is stated ("check engine light", "air leak", "brakes", "won\'t start"). A named dealer destination does NOT remove the repair — "air leak, send to Cummins Bristol from ABE" = hasRepair=true AND isTow=true (TWO work orders: the repair WR with vendor=Cummins, plus the tow WR).\n'
    + '    * hasRepair=false when the user ONLY asks to move the unit and states NO mechanical problem — e.g. "tow back from dealer", "return tow from the shop", "bring it back to the yard". That is a TOW-ONLY request: isTow=true, hasRepair=false, areaPairs=[] (no repair WR, tow WR only).\n'
    + '- TOW DIRECTION — read the words literally; do not assume to-dealer:\n'
    + '    * TO DEALER ("send/take/bring TO <dealer>", "from <SITE> to <dealer>"): towDirection="to-dealer", pickup=home domicile <SITE>, destination=the named dealer (use its address; if the user typed a full address like "Cummins Bristol 2727 Ford Road Bristol PA 19007", use THAT address for the destination).\n'
    + '    * BACK TO YARD ("tow back from dealer", "return tow", "bring/tow it BACK to <SITE>/home/yard", "from <dealer> to <SITE>", "pick up from dealer"): towDirection="return-to-yard", pickup=the DEALER (where the unit is now), destination=the home yard <SITE>.\n'
    + '    * BETWEEN YARDS ("from <SITE_A> to <SITE_B>", neither end a dealer): towDirection="yard-to-yard", pickup=origin yard, destination=target yard.\n'
    + '    "from X to Y" means pickup=X, destination=Y — honor it literally. "back"/"return" means the unit is at the dealer and is coming home.\n'
    + '- INTEGRATED VENDORS (automated dealer workflow via Decisiv/portal): Kenworth (PACCAR), Peterbilt (PACCAR), Volvo (ASIST), Mack (ASIST), Freightliner (DAIMLER). When the chosen/override vendor is one of these AND the unit is being sent to that dealer (to-dealer tow), set needsDealerWorkOrder=true (a dealer WO/tracking event is also needed). For non-integrated vendors, needsDealerWorkOrder=false.\n'
    + '- For Predictive Maintenance: title must include "Predictive Maintenance", reference Uptake data in comments\n'
    + '- EXCEPTION \u2014 if the title clearly says TRACKING/MONITORING ONLY: return areaPairs=[] and base issue/comments only on the referenced data.\n'
    + '- TITLE: produce a clean, specific summary of what the user asked, MAX 90 characters.\n'
    + '- COMMENTS when isTow=true: FIRST state the reason the unit is down / the mechanical issue in a sentence (if hasRepair), THEN append EXACTLY this structured line:\n'
    + '    "Requesting unit be picked up from domicile site <PICKUP_SITE> ; <PICKUP_ADDRESS> and tow unit to dealer service shop <DEALER_NAME> <DEALER_ADDRESS> || <SITE> Gate Code: <CODE or None> || Key Location: <phrase meaning the key is in the unit or with onsite staff>"\n'
    + '  Use the real addresses from the DOMICILE/VENDOR books. If gate code is None, write "Gate Code: None". For return-to-yard, swap pickup/destination accordingly (pickup=dealer, destination=domicile) but keep the same overall phrasing.\n'
    + '- COMMENTS when isTow=false (the normal case): describe what we need from the vendor to fix the problem. NO tow line.\n\n'
    + 'VALID AREAS/SUBCATEGORIES (use EXACT values):\n' + areaList + '\n\n'
    + 'Respond ONLY with valid JSON:\n'
    + '{"title":"<=90 char summary","issue":"2-3 sentence description","areaPairs":[{"area":"EXACT area","subcategory":"EXACT sub"}],"vendor":"","vendorLocation":"","vendorIsOverride":false,"urgent":false,"urgencyReason":"","comments":"what we need (+ tow line only if isTow)","hasRepair":true,"isTow":false,"needsDealerWorkOrder":false,"towDirection":"to-dealer|return-to-yard|yard-to-yard|","towPickup":{"name":"","street":"","city":"","state":"","zip":""},"towDestination":{"name":"","street":"","city":"","state":"","zip":""}}\n'
    + 'vendor = the top-level company ONLY (e.g. "Gabrielli", "KWNE", "Allegiance and Ascendance", "COX") — NOT the location. vendorLocation = the branch/city the user named if any (e.g. "Rockaway", "Flemington", "Bristol", "NY/NJ") else "". The app maps vendorLocation to the preferred-supplier location and auto-picks the CLOSEST location when vendorLocation is empty.\n'
    + 'Set vendorIsOverride=true when YOU set vendor because the user named one (an override); false when vendor is empty (defer to AAP). areaPairs can have 1-4 pairs; empty [] for tow-only. urgent=true ONLY if the user literally said urgent. Remember: naming ANY specific dealer as destination = isTow=true (no "tow" keyword needed); "tow back"/"return" with no stated problem = tow-only (hasRepair=false, areaPairs=[]).';

  // FINAL SAFETY CLAMP: ai:ask rejects prompts over 32000 chars (ConfigError →
  // no fill). Keep a margin under that. If we're over, trim the LARGEST
  // variable sections (vendor/domicile books + uptake text) rather than the
  // rules, so the AI still gets the instructions + area list. Trim from the end
  // of the context block, preserving the rules header and the JSON schema tail.
  const AI_PROMPT_MAX = 31000;
  let safePrompt = prompt;
  if (safePrompt.length > AI_PROMPT_MAX) {
    const over = safePrompt.length - AI_PROMPT_MAX;
    // The big optional context blocks sit between the UNIT line and the RULES
    // section; drop that middle chunk first (vendor/domicile/uptake context).
    const rulesIdx = safePrompt.indexOf('\nRULES — READ CAREFULLY');
    if (rulesIdx > 0) {
      const head = safePrompt.slice(0, rulesIdx);
      const tail = safePrompt.slice(rulesIdx);
      const trimmedHead = head.length > over + 40 ? head.slice(0, head.length - over - 40) + '\n…(context trimmed to fit)\n' : head;
      safePrompt = trimmedHead + tail;
    }
    // If still over (rules/area list themselves are huge), hard-clamp the end.
    if (safePrompt.length > AI_PROMPT_MAX) safePrompt = safePrompt.slice(0, AI_PROMPT_MAX);
    try { console.warn('[wr-modal] AI prompt clamped from ' + prompt.length + ' to ' + safePrompt.length + ' chars'); } catch (_) {}
  }

  try {
    // Client-side timeout so a slow/stuck AI backend never leaves AI Fill
    // spinning (and never blocks the NEXT unit's fill). The main-process
    // ai:ask has its own hard timeout + slot release; this is the UI guard.
    const result = await Promise.race([
      window.ai.ask(safePrompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('AI Fill timed out — the AI service may be unavailable')), 95000)),
    ]);
    // Explicit backend rejection (e.g. ai:ask ConfigError "prompt exceeds
    // maximum length"): surface a clear message instead of a silent no-fill.
    if (result && result.ok === false && result.error) {
      try { console.error('[wr-modal] AI Fill backend error: ' + result.error + ' (code=' + (result.code || '?') + ')'); } catch (_) {}
      toast.show('error', 'AI Fill: ' + result.error, 5000);
      return;
    }
    // Normalize the AI response to a STRING before parsing. window.ai.ask can
    // return a bare string, { text }, or (for some backends/inputs) an object
    // whose `text`/`content`/`message` is itself an object or where the JSON is
    // at the top level. Coercing with String() on a non-string gave "[object
    // Object]" and then text.match crashed ("text.match is not a function")
    // for inputs that happened to hit that shape — worked for others by luck.
    let text = '';
    if (typeof result === 'string') text = result;
    else if (result && typeof result.text === 'string') text = result.text;
    else if (result && typeof result.content === 'string') text = result.content;
    else if (result && typeof result.message === 'string') text = result.message;
    else if (result && result.text && typeof result.text === 'object') { try { text = JSON.stringify(result.text); } catch (_) { text = ''; } }
    else if (result && typeof result === 'object') { try { text = JSON.stringify(result); } catch (_) { text = ''; } }
    else text = String(result || '');

    const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
    if (!match) { toast.show('warn', 'AI returned no data (AI service may be down) — fill fields manually', 4000); return; }
    const ai = JSON.parse(match[0]);
    
    if (ai.title) { titleEl.value = String(ai.title).slice(0, 90); titleEl.dispatchEvent(new Event('input')); } // enforce 90-char cap + refresh counter
    if (ai.issue) { const el = _el('wr-issue'); if (el) el.value = ai.issue; }
    // Vendor: set it only if the AI explicitly returned one (title said "send to
    // dealer" / named a vendor). If the AI returned empty (e.g. tracking-only or
    // let-AAP-auto-assign), reset the dropdown to its default rather than keeping
    // a stale/guessed vendor from a prior fill.
    {
      const sel = _el('wr-vendor');
      if (sel) {
        const want = String(ai.vendor || '').trim();
        if (want) {
          const opts = Array.from(sel.options).filter((o) => o.value);
          const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const w = norm(want);
          // 1) exact value, 2) exact normalized, 3) option contains the AI value
          //    (or vice-versa), 4) best token-overlap (handles "Gabrielli ...
          //    Rockaway" vs the dropdown's full "Gabrielli Truck Sales & Service
          //    - Rockaway"), so vendor+location overrides land on the right row.
          let opt = opts.find((o) => o.value === want)
            || opts.find((o) => norm(o.value) === w)
            || opts.find((o) => norm(o.value).includes(w) || w.includes(norm(o.value)));
          if (!opt) {
            const wTokens = new Set(w.split(' ').filter((t) => t.length > 2));
            let best = null, bestScore = 0;
            for (const o of opts) {
              const oTokens = norm(o.value).split(' ').filter((t) => t.length > 2);
              const score = oTokens.reduce((n, t) => n + (wTokens.has(t) ? 1 : 0), 0);
              if (score > bestScore) { bestScore = score; best = o; }
            }
            // Require at least 2 shared significant tokens (vendor + location)
            // so we don't mis-match on a single common word.
            if (best && bestScore >= 2) opt = best;
          }
          if (opt) sel.value = opt.value;
          else _logProgress && _logProgress('AI vendor "' + want + '" not found in the AAP vendor list — pick it manually', 'err');
        } else {
          sel.selectedIndex = 0; // default (AAP auto-assign / recommendation)
        }
        // Reflect the pick in the override badge + supplier UI immediately.
        if (typeof _updateVendorOverrideBadge === 'function') _updateVendorOverrideBadge();
        if (typeof _syncSupplierSelect === 'function') _syncSupplierSelect();
        // If the user named a specific LOCATION ("Rockaway", "Flemington"),
        // select that preferred-supplier branch; otherwise _syncSupplierSelect
        // already auto-picked the closest.
        const loc = String(ai.vendorLocation || '').trim();
        if (loc && typeof _supplierIdForNamedLocation === 'function') {
          const supSel = _el('wr-supplier');
          const supId = _supplierIdForNamedLocation(loc);
          if (supSel && supId && Array.from(supSel.options).some((o) => o.value === supId)) {
            supSel.value = supId;
          } else if (supId === '' && loc) {
            _logProgress && _logProgress('Location "' + loc + '" not found for ' + (want || 'vendor') + ' — closest branch selected; adjust if needed', 'run');
          }
        }
      }
    }
    // Fill area/subcategory pairs (up to 4). If the AI decided this title needs
    // NO repair areas (e.g. a tracking/monitoring-only intent), it returns an
    // empty list — honor that by clearing the first area row instead of leaving
    // stale/guessed values behind.
    const pairs = ai.areaPairs || (ai.area ? [{ area: ai.area, subcategory: ai.subcategory }] : []);
    if (!pairs.length) {
      const a0 = _el('wr-area-0'); if (a0) a0.selectedIndex = 0;
      _repopulateL2(0); // resets L2 + hides/empties L3
    }
    const rowsContainer = _el('wr-area-rows');
    pairs.forEach((pair, i) => {
      if (i > 0 && rowsContainer) {
        // Add new row if needed
        const existing = _el('wr-area-' + i);
        if (!existing) {
          rowsContainer.insertAdjacentHTML('beforeend', _areaPairRow(_areaCount++, '', '', ''));
        }
      }
      // AI returns display text; resolve it to the live tree's codes and drive
      // the cascading selects (L1 -> L2 -> L3).
      _applyAiAreaToRow(i, pair.area || '', pair.subcategory || '');
      // Show tow section if area is TOW. Do NOT force urgent here — urgency is
      // explicit-only (set below strictly from ai.urgent, which the prompt
      // only returns true when the user literally said "urgent").
      if (i === 0 && (pair.area || '').toUpperCase() === 'TOW') {
        const towWrap = _el('wr-tow-wrap');
        if (towWrap) towWrap.style.display = '';
      }
    });
    // Urgency: EXPLICIT ONLY. Mirror exactly what the AI returned (the prompt
    // sets urgent=true only when the user literally said urgent). When not
    // urgent, make sure the box is unchecked + reason hidden.
    {
      const urgentEl = _el('wr-urgent');
      const reasonWrap = _el('wr-urgency-reason-wrap');
      const reasonEl = _el('wr-urgency-reason');
      if (ai.urgent) {
        if (urgentEl) urgentEl.checked = true;
        if (reasonWrap) reasonWrap.style.display = '';
        if (reasonEl) reasonEl.value = (ai.urgencyReason && String(ai.urgencyReason).trim()) || 'DEA - Asset Shortage';
      } else {
        if (urgentEl) urgentEl.checked = false;
        if (reasonWrap) reasonWrap.style.display = 'none';
      }
    }
    if (ai.comments) { const el = _el('wr-comments'); if (el) el.value = ai.comments; }

    // Tow intent: reveal the tow section and fill pickup + destination addresses
    // from the AI's resolved locations (it pulled real addresses from the
    // domicile/vendor books). This complements the TOW-area reveal above.
    if (ai.isTow) {
      const towWrap = _el('wr-tow-wrap');
      if (towWrap) towWrap.style.display = '';
      const setAddr = (prefix, loc) => {
        if (!loc) return;
        const s = _el(prefix + '-street'); if (s && loc.street) s.value = loc.street;
        const c = _el(prefix + '-city');   if (c && loc.city)   c.value = loc.city;
        const st = _el(prefix + '-state'); if (st && loc.state) st.value = loc.state;
        const z = _el(prefix + '-zip');    if (z && loc.zip)    z.value = loc.zip;
      };
      // wr-tow-* = destination (where unit goes); wr-tow-from-* = pickup.
      setAddr('wr-tow-from', ai.towPickup);
      setAddr('wr-tow', ai.towDestination);
      // Keep share-with-vendor ON for tows (comments carry gate/key info the
      // dealer needs) — ensure "Internal only" is unchecked.
      const internal = _el('wr-internal'); if (internal) internal.checked = false;

      // Record a tow-orchestration plan so Submit creates BOTH the repair WR
      // and the tow WR (and a Dealer WO when the dealer is not RG-integrated).
      // Resolve the dealer the AI chose from the Contact Book so we can read
      // its affiliation (RG-integrated?) and real address.
      try {
        const dealerName = (ai.towDirection === 'return-to-yard')
          ? ((ai.towPickup && ai.towPickup.name) || ai.vendor || '')
          : ((ai.towDestination && ai.towDestination.name) || ai.vendor || '');
        let dealer = null;
        if (dealerName && window.contacts) {
          const all = await window.contacts.getAll();
          const key = String(dealerName).trim().toLowerCase();
          dealer = all.find(c => c.type === 'vendor' && (c.name || '').trim().toLowerCase() === key)
                || all.find(c => c.type === 'vendor' && (c.name || '').trim().toLowerCase().includes(key))
                || all.find(c => c.type === 'vendor' && key.includes((c.name || '').trim().toLowerCase()) && (c.name || '').length > 4);
        }
        _towPlan = { isTow: true, hasRepair: ai.hasRepair !== false, towDirection: ai.towDirection || 'to-dealer', dealer, dealerName,
          towPickupName: (ai.towPickup && ai.towPickup.name) || '', towDestName: (ai.towDestination && ai.towDestination.name) || '' };
      } catch (_) { _towPlan = { isTow: true, hasRepair: ai.hasRepair !== false, towDirection: ai.towDirection || 'to-dealer', dealer: null, dealerName: ai.vendor || '',
          towPickupName: (ai.towPickup && ai.towPickup.name) || '', towDestName: (ai.towDestination && ai.towDestination.name) || '' }; }
      // Visible signal that Submit will create MULTIPLE work orders.
      const _rgInt = _isRgIntegrated(_towPlan.dealer);
      const _dn = _towPlan.dealerName || '(none)';
      let _msg;
      if (!_towPlan.dealer) {
        _msg = '🔗 Tow detected to "' + _dn + '" but that dealer is NOT in your Contact Book — add it so RG-integration can be detected. Submit will still create a tow WR.';
      } else if (_rgInt) {
        _msg = '🔗 2 tabs: ' + (_towPlan.hasRepair ? 'Repair (to ' + _towPlan.dealer.name + ') + ' : '') + 'Tow. ' + _towPlan.dealer.name + ' is RG-INTEGRATED — no Dealer WO. Review each tab, then Submit All.';
      } else {
        _msg = '🔗 2 tabs: ' + (_towPlan.hasRepair ? 'Repair (dealer tracking) + ' : '') + 'Tow. Dealer WO opens for ' + _towPlan.dealer.name + ' after both submit.';
      }
      toast.show('info', _msg, 8000);

      // Build the editable 2-tab state from the CURRENT form (whatever AI
      // Fill just wrote) and switch into the Repair tab.
      const baseSnap = _snapshotForm();
      const tabs = _buildTabSnapshots(baseSnap);
      _wrTabState = {
        active: 'repair',
        repair: tabs.repair, tow: tabs.tow,
        submitted: { repair: null, tow: null },
        rgIntegrated: tabs.rgIntegrated, dealerName: tabs.dealerName, hasRepair: tabs.hasRepair,
      };
      _applyFormSnapshot(_wrTabState.repair);
      _renderTabBar();
    } else {
      _towPlan = null; // not a tow — normal single-WR submit
      if (_wrTabState) { _wrTabState = null; _renderTabBar(); }
    }

    toast.show('success', '✨ AI filled — review and submit', 3000);
  } catch(e) {
    // Forward the REAL error + stack to the main log (console-message bridge)
    // so AI-Fill failures are diagnosable, not just a transient toast.
    try { console.error('[wr-modal] AI Fill failed: ' + (e && e.message) + ' | stack: ' + (e && e.stack || '')); } catch (_) {}
    toast.show('error', 'AI failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false; btn.textContent = '✨ AI Fill';
    _aiRunning = false;
  }
}

// ── Auto-attach Uptake screenshot for PM units ────────────────────────────
// FEATURE (2026-07-23): previously only ran for unit.riskScore >= 50, which
// meant most normal uptake WRs never got an auto-attached screenshot at all.
// Now it always tries -- if this specific unit has a stored screenshot from
// its last Uptake sync, attach it; otherwise it's a silent no-op (the user
// can still attach manually / drag one in via _wireScreenshot()).
async function _wireAutoUptake() {
  const unit = _unit || {};
  try {
    // Attach ALL of this unit's Uptake insight screenshots (one per insight),
    // not just the first — a unit with multiple insights should bring them all
    // onto the WR. Deduped by _addAttachment's identical-dataUrl guard.
    const paths = Array.from(new Set(
      [].concat(
        unit.screenshotPath ? [unit.screenshotPath] : [],
        Array.isArray(unit.screenshots) ? unit.screenshots : []
      ).filter(Boolean)
    ));
    for (const p of paths) {
      try {
        const dataUrl = await files.readAsDataUrl(p);
        if (dataUrl) _addAttachment(p.split(/[/\\]/).pop(), dataUrl);
      } catch (_) { /* skip unreadable, continue */ }
    }
  } catch(e) { /* silent -- manual attach is always still available */ }
}

// ── Live lookups: vendors + AVM category tree ──────────────────────────────
// Fetched once when the modal opens (the + Create WR / AAP work request button
// in the unit-detail Actions tab). Vendors populate the Vendor dropdown
// (filtered to wrEnabled), the avmTree drives the cascading category selects.
// Both are cached on the module so cascading is instant. Everything falls back
// gracefully when offline (hardcoded VENDORS; empty tree => just placeholders).

// Populate the Vendor <select> LIVE, filtered to wrEnabled vendors. Preserves
// any currently selected value. Falls back to the hardcoded VENDORS list when
// the live call fails or returns nothing, so the modal is never empty offline.
function _renderVendorOptions(selectedValue) {
  const sel = _el('wr-vendor');
  if (!sel) return;
  const keep = selectedValue != null ? selectedValue : sel.value;
  let names;
  const live = (_vendorList || []).filter((v) => v && v.wrEnabled).map((v) => v.vendorName).filter(Boolean);
  // De-dupe while preserving order.
  const seen = new Set();
  const liveUnique = live.filter((n) => { const k = n.toUpperCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  names = liveUnique.length ? liveUnique : VENDORS;
  const opts = ['<option value="">-- Select vendor --</option>']
    .concat(names.map((v) => '<option value="' + _safeAttr(v) + '">' + _safe(v) + '</option>'));
  sel.innerHTML = opts.join('');
  // Restore the prior selection if it still exists; else leave on placeholder.
  if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
}

// Fetch vendors + avmTree for this unit and render the live dropdowns. Non-
// blocking: the modal opens immediately with fallbacks, this upgrades it when
// the data arrives. Shows a brief loading hint on the vendor select.
async function _loadLiveLookups(unit) {
  const equipmentType = avmTypeForUnit(unit);
  const vendorSel = _el('wr-vendor');
  const prevVendor = vendorSel ? vendorSel.value : '';
  if (vendorSel) {
    const loading = document.createElement('option');
    loading.value = ''; loading.textContent = 'Loading vendors…'; loading.disabled = true;
    // Non-destructive hint: prepend without wiping the fallback list.
    vendorSel.insertBefore(loading, vendorSel.firstChild);
    vendorSel.selectedIndex = 0;
  }

  // Vendors.
  try {
    if (window.aapApi && typeof window.aapApi.vendors === 'function') {
      const res = await window.aapApi.vendors();
      if (res && res.ok && Array.isArray(res.vendors) && res.vendors.length) {
        _vendorList = res.vendors;
      }
    }
  } catch (_) { /* keep fallback */ }
  _renderVendorOptions(prevVendor);

  // FEATURE: fire ONE Phase-1 (commit-nothing) VRE recommendation for this
  // unit now that vendors are loaded. Non-blocking + fully guarded — the modal
  // stays usable if this fails / the unit has no AAP asset URL / we're offline.
  _loadVreRecommendation(unit).catch(() => {});

  // AVM category tree (drives the cascading selects).
  try {
    if (window.aapApi && typeof window.aapApi.avmTree === 'function') {
      const res = await window.aapApi.avmTree(equipmentType);
      if (res && res.ok && res.tree) _avmTree = res.tree;
    }
  } catch (_) { /* keep empty tree (selects show placeholders + TOW only) */ }

  // Rebuild the area rows now the tree is available, preserving current picks.
  _refreshAreaRowsFromTree();
}

// Re-render all area rows from the (now-loaded) tree, preserving each row's
// current L1/L2/L3 selection so a user who picked before the tree arrived
// keeps their choice. Called after the live tree loads.
function _refreshAreaRowsFromTree() {
  const rows = _el('wr-area-rows');
  if (!rows) return;
  const current = [];
  for (let i = 0; i < _areaCount; i++) {
    const aEl = _el('wr-area-' + i), sEl = _el('wr-sub-' + i), ssEl = _el('wr-subsub-' + i);
    if (!aEl && !sEl && !ssEl) continue;
    current.push({ area: (aEl && aEl.value) || '', subcategory: (sEl && sEl.value) || '', subSubcategory: (ssEl && ssEl.value) || '' });
  }
  const list = current.length ? current : [{ area: '', subcategory: '', subSubcategory: '' }];
  rows.innerHTML = list.map((p, i) => _areaPairRow(i, p.area, p.subcategory, p.subSubcategory)).join('');
  _areaCount = Math.max(1, list.length);
  _wireAreaCascade();
  _syncTowWrap();
}

// ── Live VRE vendor recommendation (on-open, commit-nothing) ────────────────
// Fires ONE Phase-1 createWorkOrder call (confirmVendor:false — commits
// nothing) to ask AAP which vendor it recommends for THIS unit, using whatever
// the form currently holds (title/issue may be placeholders, area rows may be
// empty — a bare recommendation is valid). Stores the result in _vreRec, then
// renders the recommendation line, pre-selects the recommended vendor (unless
// the user/relay already picked one), and refreshes the override + supplier UI.
// Fully guarded + non-blocking: silently falls back when there's no asset URL
// or the call fails, leaving the modal fully usable.
async function _loadVreRecommendation(unit) {
  const u = unit || _unit || {};
  const assetUrl = u && u.assetUrl;
  if (!assetUrl) return; // no AAP asset context — nothing to recommend against.
  try {
    if (!(window.aap && typeof window.aap.createWorkOrder === 'function')) return;
    const titleEl = _el('wr-title'), issueEl = _el('wr-issue');
    const title = (titleEl && titleEl.value || '').trim() || 'Work request';
    const issue = (issueEl && issueEl.value || '').trim();
    // Collect current area rows (may be empty — that's fine for a bare rec).
    // Iterate the actual DOM rows (no fixed cap).
    const rawRows = [];
    const recRowsEl = _el('wr-area-rows');
    const recDomRows = recRowsEl ? recRowsEl.querySelectorAll('.wr-area-row') : [];
    recDomRows.forEach((rowEl) => {
      const sels = rowEl.querySelectorAll('select.wr-area-input');
      if (!sels.length) return;
      rawRows.push({ area: (sels[0] && sels[0].value) || '', subcategory: (sels[1] && sels[1].value) || '', subSubcategory: (sels[2] && sels[2].value) || '' });
    });
    const areaPairs = buildAreaPairsPayload(rawRows);
    const rec = await aap.createWorkOrder({
      assetUrl, title, issue, areaPairs, urgent: 'No', confirmVendor: false,
    });
    // Guard against a late-arriving response after the modal was closed/reopened.
    if (!_overlay) return;
    if (rec && rec.ok && rec.recommendation) {
      _vreRec = rec;
      _preselectRecommendedVendor();
    }
  } catch (_) { /* silent — modal stays usable without a recommendation */ }
  // Always refresh the dependent UI (rec line hides itself when empty).
  _renderVendorRecLine();
  _updateVendorOverrideBadge();
  _syncSupplierSelect();
}

// Look up the recommended vendor name from _vreRec. Returns '' when none.
function _recommendedVendorName() {
  return (_vreRec && _vreRec.recommendation && _vreRec.recommendation.vendor) || '';
}

// Normalize a vendor string for comparison: lowercase + strip the display
// suffix after a ' (' (so "Volvo (ASIST)" compares as "volvo"). The matrix
// recommends by code/display name; options may carry the display suffix.
function _vendorCodePart(s) {
  return String(s || '').split(' (')[0].trim().toLowerCase();
}

// Render / update the "AAP recommends: <vendor> (rule: <ruleName>)" line
// directly under the Vendor <select>. Creates the element if missing; hides it
// when there is no recommended vendor.
function _renderVendorRecLine() {
  const sel = _el('wr-vendor');
  if (!sel) return;
  let line = _el('wr-vendor-rec');
  if (!line) {
    line = document.createElement('div');
    line.id = 'wr-vendor-rec';
    line.className = 'wr-vendor-rec';
    line.style.cssText = 'font-size:10px;opacity:.75;margin-top:3px';
    // Place directly under the vendor select (inside its label when possible).
    const host = sel.parentNode || sel;
    if (sel.nextSibling) host.insertBefore(line, sel.nextSibling);
    else host.appendChild(line);
  }
  const rec = _vreRec && _vreRec.recommendation;
  const vendor = _recommendedVendorName();
  if (!vendor) { line.style.display = 'none'; line.textContent = ''; return; }
  const ruleName = (rec && rec.ruleName) || '';
  let txt = 'AAP recommends: ' + vendor + (ruleName ? ' (rule: ' + ruleName + ')' : '');
  if (rec && rec.autoAssignable) txt += ' · auto-assignable';
  line.textContent = txt; // textContent = inherently escaped, no injection.
  line.style.display = '';
}

// Pre-select the recommended vendor in the wr-vendor dropdown, but ONLY if the
// user/relay has not already chosen one (don't overwrite a non-empty value).
// Matches case-insensitively against option values, same style as the relay
// pre-select in open().
function _preselectRecommendedVendor() {
  const sel = _el('wr-vendor');
  if (!sel) return;
  const vendor = _recommendedVendorName();
  if (!vendor) { _renderVendorRecLine(); _updateVendorOverrideBadge(); _syncSupplierSelect(); return; }
  if (!sel.value) { // respect an existing (relay / user) selection.
    const want = _vendorCodePart(vendor);
    const match = Array.from(sel.options).find((o) => o.value && _vendorCodePart(o.value) === want)
      || Array.from(sel.options).find((o) => o.value && o.value.toUpperCase().includes(vendor.toUpperCase()));
    if (match) sel.value = match.value;
  }
  _renderVendorRecLine();
  _updateVendorOverrideBadge();
  _syncSupplierSelect();
}

// Show/hide the "Override — not AAP-recommended" badge next to the vendor
// select. Shown when the current selection differs from the recommended vendor
// (comparing the code part); hidden when they match or there's no recommendation.
function _updateVendorOverrideBadge() {
  const sel = _el('wr-vendor');
  if (!sel) return;
  let badge = _el('wr-vendor-override');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'wr-vendor-override';
    badge.className = 'badge badge--risk-medium wr-vendor-override';
    badge.style.cssText = 'font-size:9px;margin-left:6px';
    badge.textContent = 'Override — not AAP-recommended';
    const recLine = _el('wr-vendor-rec');
    if (recLine && recLine.parentNode) recLine.parentNode.insertBefore(badge, recLine.nextSibling);
    else {
      const host = sel.parentNode || sel;
      if (sel.nextSibling) host.insertBefore(badge, sel.nextSibling); else host.appendChild(badge);
    }
  }
  const rec = _recommendedVendorName();
  const cur = (sel.value || '').trim();
  const isOverride = !!rec && !!cur && _vendorCodePart(cur) !== _vendorCodePart(rec);
  badge.style.display = isOverride ? '' : 'none';
}

// Find a vendor record in _vendorList by name (case-insensitive). Null when
// not found / list not loaded.
function _vendorRecordByName(name) {
  const want = _vendorCodePart(name);
  if (!want) return null;
  return (_vendorList || []).find((v) => v && v.vendorName &&
    (_vendorCodePart(v.vendorName) === want || String(v.vendorName).toLowerCase() === String(name).toLowerCase())) || null;
}

// Show a required Supplier <select> when the selected vendor has
// supplierRequired === true; populate it from that vendor's suppliers[]
// (strings OR {supplierId, supplierName}). Hide + clear it otherwise. The
// select is created right after the vendor select if missing.
function _syncSupplierSelect() {
  const sel = _el('wr-vendor');
  if (!sel) return;
  let supWrap = _el('wr-supplier-wrap');
  let supSel = _el('wr-supplier');
  if (!supSel) {
    supWrap = document.createElement('label');
    supWrap.id = 'wr-supplier-wrap';
    supWrap.className = 'settings-label';
    supWrap.style.cssText = 'display:block;margin-top:6px';
    supWrap.innerHTML = 'Supplier <span style="color:var(--err,#f85149)">*</span>' +
      '<select id="wr-supplier" class="settings__select"></select>';
    // Insert after the override badge / rec line / vendor select, whichever exists.
    const anchor = _el('wr-vendor-override') || _el('wr-vendor-rec') || sel;
    const host = anchor.parentNode || sel.parentNode || sel;
    if (anchor.nextSibling) host.insertBefore(supWrap, anchor.nextSibling);
    else host.appendChild(supWrap);
    supSel = _el('wr-supplier');
  }
  const rec = _vendorRecordByName(sel.value);
  const required = !!(rec && rec.supplierRequired === true);
  if (!required) {
    supWrap.style.display = 'none';
    if (supSel) supSel.innerHTML = '';
    return;
  }
  // Supplier = the vendor LOCATION (confirmed live shape: {id, name, latitude,
  // longitude, vendorSystemSupplierId, ...}). Compute distance from the asset's
  // GPS to each location (same "Approx. N miles" AAP shows), sort nearest-first,
  // and auto-select the closest — mirroring AAP highlighting the nearest branch.
  const suppliers = (rec && Array.isArray(rec.suppliers)) ? rec.suppliers.slice() : [];
  const gps = _assetGps();
  const withDist = suppliers.map((s) => {
    const o = (s && typeof s === 'object') ? s : { name: String(s), id: String(s) };
    const mi = (gps && o.latitude != null && o.longitude != null)
      ? _haversineMiles(gps.lat, gps.lng, Number(o.latitude), Number(o.longitude)) : null;
    return { raw: o, id: o.id != null ? o.id : (o.supplierId != null ? o.supplierId : o.name), name: o.name || String(o.id || ''), mi };
  });
  // Sort nearest-first (unknown distances last).
  withDist.sort((a, b) => (a.mi == null) - (b.mi == null) || (a.mi || 0) - (b.mi || 0));
  const prev = supSel ? supSel.value : '';
  const opts = ['<option value="">-- Select a preferred vendor location --</option>'];
  for (const s of withDist) {
    const miTxt = s.mi != null ? ('  ·  ~' + s.mi.toFixed(1) + ' mi') : '';
    opts.push('<option value="' + _safeAttr(s.id) + '">' + _safe(s.name + miTxt) + '</option>');
  }
  if (supSel) {
    supSel.innerHTML = opts.join('');
    // Restore a prior pick if still valid; else auto-select the CLOSEST location
    // (first after the nearest-first sort), matching AAP's default highlight.
    if (prev && Array.from(supSel.options).some((o) => o.value === prev)) supSel.value = prev;
    else if (withDist.length && withDist[0].mi != null) supSel.value = String(withDist[0].id);
  }
  supWrap.style.display = '';
}

// Asset GPS for supplier-distance math. Prefers the VRE recommendation's
// currentLocation (fetched live on open), falls back to the unit's stored
// geoPoint. Returns {lat,lng} or null.
function _assetGps() {
  try {
    const ll = _unit && (_unit.latestLocation || _unit.geoPoint || _unit.location);
    const gp = (ll && (ll.geoPoint || ll)) || null;
    const lat = gp && (gp.latitude != null ? gp.latitude : gp.lat);
    const lng = gp && (gp.longitude != null ? gp.longitude : (gp.lng != null ? gp.lng : gp.lon));
    if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
  } catch (_) {}
  return null;
}

// Great-circle distance in miles (same metric AAP's "Approx. N miles" uses).
function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Given a free-text location the user named ("Flemington", "Rockaway"), find
// the matching supplier id within the selected vendor's locations. Returns '' .
function _supplierIdForNamedLocation(locText) {
  const rec = _vendorRecordByName((_el('wr-vendor') || {}).value);
  const suppliers = (rec && Array.isArray(rec.suppliers)) ? rec.suppliers : [];
  const want = String(locText || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!want || !suppliers.length) return '';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Match the location against the supplier NAME (which includes the branch).
  const hit = suppliers.find((s) => norm(s.name).includes(want))
    || suppliers.find((s) => want.includes(norm(s.city)) && norm(s.city))
    || suppliers.find((s) => norm(s.name).split(' ').some((t) => t === want));
  return hit ? String(hit.id != null ? hit.id : hit.name) : '';
}

// Wire the vendor <select> change event to keep the override badge + supplier
// select in sync as the user picks vendors. Idempotent via a dataset flag.
function _wireVendorRecUI() {
  const sel = _el('wr-vendor');
  if (!sel || sel.dataset.recWired === '1') return;
  sel.dataset.recWired = '1';
  sel.addEventListener('change', () => {
    _updateVendorOverrideBadge();
    _syncSupplierSelect();
  });
}

// Whether the currently-selected vendor requires a supplier and none is chosen.
function _supplierMissing() {
  const supWrap = _el('wr-supplier-wrap');
  const supSel = _el('wr-supplier');
  const visible = !!(supWrap && supWrap.style.display !== 'none' && supSel);
  if (!visible) return false;
  return !(supSel.value || '').trim();
}

export function open(unit) {
  if (_overlay) _close();
  _unit      = unit;
  _areaCount = 1;
  _avmTree   = null;
  _vreRec    = null; // recommendation is per-unit — reset before fetching this unit's.
  // Keep the vendor list across opens (6h-cached backend anyway); clear only
  // the tree since equipmentType can differ per unit.

  _overlay           = document.createElement('div');
  _overlay.id        = 'wr-modal-overlay';
  _overlay.className = 'wr-modal-overlay';
  _overlay.innerHTML = _buildHTML(unit);
  document.body.appendChild(_overlay);

  // Dismiss on backdrop click
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) _close(); });
  _el('wr-close').addEventListener('click', _close);
  _el('wr-cancel').addEventListener('click', _close);

  // Wire all interactions
  _wireAreaRows();
  _wireUrgency();
  _wireOptional();
  _wireScreenshot();
  _wireTitleCount();
  _wireSubmit();
  _wireAIAssist();
  _wireAutoUptake();
  _wireTow();
  _wireVendorRecUI();
  _initFlipUI(unit);

  // Pre-select vendor from relay data if available (against the fallback list;
  // _loadLiveLookups below preserves this selection when the live list lands).
  const relayVendor = (unit.relayVendor || unit.vendor || '').toUpperCase();
  if (relayVendor) {
    const match = Array.from(_el('wr-vendor').options)
      .find(o => o.value.toUpperCase().includes(relayVendor));
    if (match) _el('wr-vendor').value = match.value;
  }
  // Reflect any relay/user pre-select in the override badge + supplier select
  // immediately (the recommendation line/pre-select arrives later, async).
  _updateVendorOverrideBadge();
  _syncSupplierSelect();

  // Auto-populate vendors + category tree LIVE from AAP as soon as the modal
  // opens. Non-blocking — the modal is usable immediately with fallbacks and
  // upgrades in place when the data arrives. Runs after the relay pre-select so
  // it captures + preserves that selection.
  _loadLiveLookups(unit).catch(() => {});

  // Pre-fill contact from user profile
  const _profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}');
  if (_profile.name) { const el = _el('wr-contact-name'); if (el) el.value = _profile.name; }
  if (_profile.phone) { const el = _el('wr-contact-phone'); if (el) el.value = _profile.phone; }

  // Focus title field
  setTimeout(() => { const t = _el('wr-title'); if (t) t.focus(); }, 50);
}
