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

import { aap, files } from '../bridge.js';
import bus from '../bus.js';
import toast           from '../components/toast.js';

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

const AREA_SUBS = {"BODY":["AIR FILTERS","BATTERY BOX","BODY CAB COMPONENTS","BODY COMPONENTS","BRACKET","BULKHEAD","BUMPER ASSEMBLY","CAB","CARGO BOX","CARGO RESTRAINT","CORNER CAP ASSEMBLY","COWL ASSEMBLY","DEFLECTOR","EXTERIOR LIGHTS","EXTERIOR PANEL ASSEMBLY","FAIRINGS","FASTENERS","FLOOR ASSEMBLY","FRAME ASSEMBLY","GLASS ASSEMBLY","HOOD","INTERIOR TRIM","MIRRORS AND VISOR","MUD FLAPS","ROLL-UP DOOR","ROOF ASSEMBLY","RUNNING BOARDS","SEAT ASSEMBLY","SIDE DOOR ASSEMBLY","TAILGATE","WINDSHIELD","WIPER SYSTEM"],"BRAKES":["AIR BRAKE ASSEMBLY","AIR COMPRESSOR","AIR HOSE ASSEMBLY","AIR TANK ASSEMBLY","AIR VALVE ASSEMBLY","ANTILOCK ASSEMBLY","AXLE BRAKES","BRAKE CHAMBER","BRAKE LINES AND FITTINGS","DRAIN VALVE","ELECTRIC BRAKES ASSEMBLY","GLADHAND ASSEMBLY","HYDRAULIC BRAKE ASSEMBLY","MASTER BRAKE CYLINDER ASSEMBLY","PARKING BRAKE ASSEMBLY","PEDAL ASSEMBLY","POWER BRAKE ASSEMBLY"],"CHASSIS":["ADJUSTER","CHASSIS ASSEMBLY","IDLER","LUBRICATION ASSEMBLY","RESERVOIR AND LINES","ROLLER","TRACK","UNDERCARRIAGE","WHEEL END DISCONNECT ASSEMBLY"],"CHECK ENGINE LIGHT":["CEL AIR TEMPERATURE","CEL AMBIENT TEMPERATURE","CEL BOOST PRESSURE","CEL CAMSHAFT POSITION","CEL COOLANT TEMPERATURE","CEL CRANKCASE PRESSURE","CEL ENGINE POSITION","CEL FUEL PRESSURE","CEL FUEL TEMPERATURE","CEL IDLE","CEL MANIFOLD PRESSURE","CEL MASS AIR FLOW","CEL OIL TEMPERATURE","CEL OVERALL ISSUE","CEL OXYGEN ISSUE","CEL OXYGEN SENSOR","CEL SENSOR KNOCK","CEL SPEED"],"DEVICE INSTALLATION":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DEVICE REMOVAL":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DEVICE REPLACMENT":["FLEETEDGE-AI BOX","GEOTAB","HALO GATEWAY","HALO SENSOR","HALO TIRE INFLATOR (GEN 1 and GEN 2)","NETRADYNE","XIRGO-HARP"],"DOORS":["DOOR ASSEMBLY","DOOR HINGE ASSEMBLY","SODE DOOR COMPONENT"],"DRIVETRAIN":["AIR CYLINDERS","AUXILIARY ASSEMBLY","AXLE","CHAIN DRIVE","DIFFERENTIAL","DRIVETRAIN ASSEMBLY","FINAL DRIVE ASSEMBLY","GEARS AND BEARINGS","MANIFOLD","PARKING LOCK ASSEMBLY","RETARDER","SHAFT","SHAFT ASSEMBLY","TRANSFER CASE"],"ELECTRICAL":["ADAS","ALTERNATOR ASSEMBLY","BACKUP WARNING SYSTEM","BATTERIES AND CABLES","BULBS, FUSES","CHARGING SYSTEM","DISTRIBUTOR ASSEMBLY","ECU","EV CHARGING SYSTEM","ELECTRICAL SYSTEM","GPS TRACKING","HORN, ANTI-THEFT","IGNITION SYSTEM","INSTRUMENT CLUSTER","LIGHTING SYSTEM","MODULES","OIL PRESSURE WARNING","PRE-HEATER","REGULATOR","SENSOR","SENSORS","SHUTDOWN DEVICES","SOLENOID","STARTER ASSEMBLY","SURVEILLANCE SYSTEM","SWITCHES","WARNING INDICATORS","WIRE HARDNESS"],"ENGINE":["AIR CLEANER","AIR INTAKE","BATTERY ASSEMBLY","CAMSHAFT ASSEMBLY","CARBURETOR","COOLANT","COOLING SYSTEM","CRANKCASE ASSEMBLY","CRANKSHAFT ASSEMBLY","CYLINDER BLOCK ASSEMBLY","DEF ASSEMBLY","ELECTRIC MOTOR ASSEMBLY","ELECTRONIC ENGINE CONTROLS","ENGINE ASSEMBLY","ENGINE SHUTDOWN","FILTERS","FLYWHEEL","INJECTOR","OIL FILTER ASSEMBLY","OIL PAN ASSEMBLY","OIL PUMP ASSEMBLY","PISTONS AND RINGS ASSEMBLY","RADIATOR","RETARDER ASSEMBLY","SPEED CONTROL SYSTEM","THROTTLE BODY","TIMING ASSEMBLY","WATER PUMP"],"EXHAUST":["EXHAUST SYSTEM","MUFFLER EXHAUST PIPE ASSEMBLY"],"FIFTH WHEEL":["FIFTH WHEEL COMPONENTS"],"FUEL":["EVAPORATIVE CONTROL SYSTEM","FUEL PUMP","FUEL TANK SYSTEM","HEATER ASSEMBLY","INJECTORS","TANK ASSEMBLY"],"HVAC":["AIR CONDITIONING","BELTS","DEFROSTER","HVAC ASSEMBLY","HEATING"],"INTERIOR":["AIR BAGS AND INTERIOR SAFETY EQUIPMENT","CAB ACCESSORIES","DISPLAYS AND SIGNS","INSTRUMENT PANEL","INTERIOR PANELS","LIGHTS","MOLDINGS","SLEEPER COMPONENTS"],"SUSPENTION":["ACTIVE SUSPENSION ASSEMBLY","AIR SPRING ASSEMBLY","AIR SUSPENSION ASSEMBLY","FRONT SUSPENSION ASSEMBLY","REAR SUSPENSION ASSEMBLY","RIDE HEIGHT ASSEMBLY","SHOCK ABSORBERS","SLEEPER SUSPENSION","SPRINGS ASSEMBLY","STABILIZER ASSEMBLY","STRUTS ASSEMBLY","SUSPENSION ASSEMBLY","TANDEM SUSPENSION ASSEMBLY"],"TOW":["MECHANICAL ISSUE","IMPOUND","ABANDONED EQUIPMENT","ACCIDENT/RECOVERY"],"TRANSMISSION":["CVT","CLUTCH","CONVERTER","ELECTRIC VEHICLE","MANUAL TRANSMISSION","SERVO ASSEMBLY","SOLENOID ASSEMBLY","TORQUE ASSEMBLY","TRANSMISSION ASSEMBLY","TRANSMISSION BRAKE","TRANSMISSION CASE","TRANSMISSION COVER","TRANSMISSION EXTERNAL CONTROL","TRANSMISSION OIL PUMP ASSEMBLY","TRANSMISSION PUMP","TRANSMISSION SPLITTER","VALVE BIDY"]};
const AREA_TEMPLATES = Object.keys(AREA_SUBS);



// ── Module state ──────────────────────────────────────────────────────────
let _overlay   = null;
let _unit      = null;
let _areaCount = 1;
let _progUnsub = null;

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

function _areaPairRow(idx, area, sub) {
  return `
    <div class="wr-area-row" id="wr-area-row-${idx}">
      <input class="settings__input wr-area-input" id="wr-area-${idx}" type="text"
        placeholder="Area" value="${_safeAttr(area)}" list="wr-area-datalist" />
      <input class="settings__input wr-area-input" id="wr-sub-${idx}" type="text"
        placeholder="Subcategory" value="${_safeAttr(sub)}" />
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
      <label class="settings-label">WR Title
        <input id="wr-title" class="settings__input" type="text"
          placeholder="Type title then press Enter or click AI Fill..."
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

    <!-- Component Areas -->
    <div class="wr-section">
      <div class="wr-section__title">
        Component Areas
        <span class="wr-section__hint">up to 4 pairs</span>
      </div>
      <datalist id="wr-area-datalist">
        ${AREA_TEMPLATES.map(a => `<option value="${a}">`).join('')}
      </datalist>
      <div id="wr-area-rows">${_areaPairRow(0, '', '')}</div>
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
      <div id="wr-tow-wrap" class="wr-section" style="display:none">\n      <div class="wr-section__title">\uD83D\uDE9B Tow Destination (where unit goes)</div>\n      <div class="wr-two-col" style="margin-bottom:6px"><label class="settings-label" style="flex:3"><select id="wr-tow-book" class="settings__select"><option value="">Quick-fill from vendor book...</option></select></label></div>\n      <div class="wr-two-col"><label class="settings-label" style="flex:3">Street<input id="wr-tow-street" class="settings__input" placeholder="Street" /></label><label class="settings-label" style="flex:2">City<input id="wr-tow-city" class="settings__input" placeholder="City" /></label></div>\n      <div class="wr-two-col" style="margin-top:4px"><label class="settings-label">State<input id="wr-tow-state" class="settings__input" placeholder="ST" maxlength="2" style="text-transform:uppercase" /></label><label class="settings-label">ZIP<input id="wr-tow-zip" class="settings__input" placeholder="00000" /></label></div>\n      <div class="wr-section__title" style="margin-top:12px">\uD83D\uDCCD Tow Pickup (where unit is now)</div>\n      <div class="wr-two-col" style="margin-bottom:6px"><label class="settings-label" style="flex:3"><select id="wr-tow-from-book" class="settings__select"><option value="">Quick-fill pickup location...</option></select></label></div>\n      <div class="wr-two-col"><label class="settings-label" style="flex:3">Street<input id="wr-tow-from-street" class="settings__input" placeholder="Pickup street" /></label><label class="settings-label" style="flex:2">City<input id="wr-tow-from-city" class="settings__input" placeholder="City" /></label></div>\n      <div class="wr-two-col" style="margin-top:4px"><label class="settings-label">State<input id="wr-tow-from-state" class="settings__input" placeholder="ST" maxlength="2" style="text-transform:uppercase" /></label><label class="settings-label">ZIP<input id="wr-tow-from-zip" class="settings__input" placeholder="00000" /></label></div>\n    </div>\n\n    <div class="wr-section__title">Screenshot Attachment</div>
      <div class="wr-screenshot-row">
        <button id="wr-attach-screenshot" class="detail-panel__btn detail-panel__btn--secondary">Attach latest Uptake screenshot</button>
        <span id="wr-screenshot-label" class="wr-screenshot-label">None</span>
      </div>
    </div>

    <!-- Progress log -->
    <div id="wr-progress-wrap" class="wr-progress-wrap" style="display:none">
      <div class="wr-section__title">Progress</div>
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
      <button id="wr-submit" class="detail-panel__btn wr-submit-btn">Submit WR</button>
    </div>
  </div>

</div>`;
}

// ── Payload collector ─────────────────────────────────────────────────────
function _collectPayload() {
  const areaPairs = [];
  for (let i = 0; i < 4; i++) {
    const aEl = _el('wr-area-' + i);
    const sEl = _el('wr-sub-'  + i);
    if (!aEl && !sEl) continue;
    const area = (aEl && aEl.value || '').trim();
    const sub  = (sEl && sEl.value || '').trim();
    if (area || sub) areaPairs.push({ area, subcategory: sub });
  }

  const attachBtn = _el('wr-attach-screenshot');
  const screenshotDataUrl = (attachBtn && attachBtn._dataUrl) || null;

  return {
    unit:            _unit.id          || _unit.equipmentId || '',
    title:           (_el('wr-title').value   || '').trim(),
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
    domicile:        _unit.site || _unit.domicileSite || '',
    tow: { street: (_el('wr-tow-street')||{}).value||'', city: (_el('wr-tow-city')||{}).value||'', state: (_el('wr-tow-state')||{}).value||'', zip: (_el('wr-tow-zip')||{}).value||'' },
    towFrom: { street: (_el('wr-tow-from-street')||{}).value||'', city: (_el('wr-tow-from-city')||{}).value||'', state: (_el('wr-tow-from-state')||{}).value||'', zip: (_el('wr-tow-from-zip')||{}).value||'' },
  };
}

// ── Progress log ──────────────────────────────────────────────────────────
function _logProgress(msg) {
  const wrap = _el('wr-progress-wrap');
  const log  = _el('wr-progress-log');
  if (!log) return;
  if (wrap) wrap.style.display = '';
  const line = document.createElement('div');
  line.className = 'wr-progress-line';
  line.textContent = msg;
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
      // Last row — clear values rather than remove
      const a = _el('wr-area-' + idx); if (a) a.value = '';
      const s = _el('wr-sub-'  + idx); if (s) s.value = '';
    }
  });

  _el('wr-add-area').addEventListener('click', () => {
    const current = rows.querySelectorAll('.wr-area-row').length;
    if (current >= 4) { toast.show('warn', 'Maximum 4 area pairs', 2000); return; }
    rows.insertAdjacentHTML('beforeend', _areaPairRow(_areaCount++, '', ''));
  });
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

// ── Wire: screenshot ──────────────────────────────────────────────────────
function _wireScreenshot() {
  const btn   = _el('wr-attach-screenshot');
  const label = _el('wr-screenshot-label');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Loading...';
    try {
      const result = await files.getLatestScreenshot();
      if (result && result.path) {
        const dataUrl = await files.readAsDataUrl(result.path);
        if (dataUrl) {
          btn._dataUrl = dataUrl;
          label.textContent = result.path.split(/[/\\]/).pop();
          label.className = 'wr-screenshot-label wr-screenshot-label--attached';
          toast.show('success', 'Screenshot attached', 2000);
        } else {
          toast.show('warn', 'Could not read screenshot file', 3000);
        }
      } else {
        toast.show('info', 'No Uptake screenshot found — run a sync first', 4000);
      }
    } catch (e) {
      toast.show('error', 'Screenshot load failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Attach latest Uptake screenshot';
    }
  });
}

// ── Wire: submit ──────────────────────────────────────────────────────────
function _wireSubmit() {
  const submitBtn   = _el('wr-submit');
  const fallbackBtn = _el('wr-autofill-fallback');
  const resultEl    = _el('wr-result');

  submitBtn.addEventListener('click', async () => {
    const payload = _collectPayload();
    if (!payload.vendor) { toast.show('warn', 'Select a vendor',  3000); return; }
    if (!payload.title)  { toast.show('warn', 'WR title required', 3000); return; }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting...';
    fallbackBtn.disabled = true;
    resultEl.style.display = 'none';
    _el('wr-progress-wrap').style.display = '';
    _el('wr-progress-log').innerHTML = '';

    if (_progUnsub) { _progUnsub(); _progUnsub = null; }
    _progUnsub = aap.onWRProgress(_logProgress);

    try {
      const result = await aap.createWR(payload, _unit);
      if (_progUnsub) { _progUnsub(); _progUnsub = null; }

      if (result && result.ok) {
        const wrId = result.workRequestId || '';
        resultEl.innerHTML = `
          <div class="wr-result--success">
            <span class="wr-result__icon">✓</span>
            <span>WR created — <strong>${_safe(wrId)}</strong></span>
            ${_unit.assetUrl ? `<a href="#" id="wr-open-aap" class="wr-result__link">Open in AAP</a>` : ''}
          </div>`;
        resultEl.style.display = '';
        const link = _el('wr-open-aap');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); aap.openUrl(_unit.assetUrl); });
        toast.show('success', 'WR ' + wrId + ' created', 6000);
        setTimeout(() => _close(), 4000);
      } else {
        _showError((result && result.error) || 'Unknown error');
      }
    } catch (e) {
      if (_progUnsub) { _progUnsub(); _progUnsub = null; }
      _showError(e.message);
    } finally {
      submitBtn.disabled   = false; submitBtn.textContent = 'Submit WR';
      fallbackBtn.disabled = false;
    }
  });

  fallbackBtn.addEventListener('click', async () => {
    const payload = _collectPayload();
    fallbackBtn.disabled = true; fallbackBtn.textContent = 'Launching AI...';
    try { await aap.createWR(payload, _unit); } catch(e) { toast.show('error', e.message); }
    fallbackBtn.disabled = false; fallbackBtn.textContent = 'Open in AAP (autofill)';
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
  try {
    await aap.autofill(_unit.assetUrl, payload);
    toast.show('info', 'Opening AAP in autofill mode...', 3000);
  } catch (e) {
    toast.show('error', 'Autofill launch failed: ' + e.message);
  }
}

// ── Open / close ──────────────────────────────────────────────────────────
function _close() {
  if (_progUnsub) { _progUnsub(); _progUnsub = null; }
  if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay   = null;
  _unit      = null;
  _areaCount = 1;
}


// ── Tow Address Handling (uses Contact Book) ─────────────────────────────
async function _wireTow() {
  const towBook = _el('wr-tow-book');
  const fromBook = _el('wr-tow-from-book');
  if (!towBook || !fromBook || !window.contacts) return;

  // Load contacts that have addresses
  const all = await window.contacts.getAll();
  const vendors = all.filter(c => c.type === 'vendor' && c.street);
  const domiciles = all.filter(c => c.type === 'domicile' && c.street);

  // Populate tow destination (vendors/dealers)
  towBook.innerHTML = '<option value="">Select destination...</option>';
  if (vendors.length) {
    vendors.forEach(v => {
      const o = document.createElement('option');
      o.value = JSON.stringify(v);
      o.textContent = v.name + ' — ' + v.street + ', ' + (v.city || '') + ' ' + (v.state || '');
      towBook.appendChild(o);
    });
  }
  // Also add domiciles as tow destination options
  if (domiciles.length) {
    const og = document.createElement('optgroup');
    og.label = 'HOME YARDS';
    domiciles.forEach(d => {
      const o = document.createElement('option');
      o.value = JSON.stringify(d);
      o.textContent = d.name + ' — ' + d.street + ', ' + (d.city || '') + ' ' + (d.state || '');
      og.appendChild(o);
    });
    towBook.appendChild(og);
  }

  // Populate tow pickup (domiciles + vendors)
  fromBook.innerHTML = '<option value="">Select pickup location...</option>';
  if (domiciles.length) {
    const og = document.createElement('optgroup');
    og.label = 'HOME YARDS';
    domiciles.forEach(d => {
      const o = document.createElement('option');
      o.value = JSON.stringify(d);
      o.textContent = d.name + ' — ' + d.street + ', ' + (d.city || '') + ' ' + (d.state || '');
      og.appendChild(o);
    });
    fromBook.appendChild(og);
  }
  if (vendors.length) {
    const og = document.createElement('optgroup');
    og.label = 'VENDORS';
    vendors.forEach(v => {
      const o = document.createElement('option');
      o.value = JSON.stringify(v);
      o.textContent = v.name + ' — ' + v.street + ', ' + (v.city || '') + ' ' + (v.state || '');
      og.appendChild(o);
    });
    fromBook.appendChild(og);
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

  // Show/hide tow section based on area input
  const checkTow = () => {
    const areaEl = _el('wr-area-0');
    const isTow = areaEl && areaEl.value.toUpperCase() === 'TOW';
    const wrap = _el('wr-tow-wrap');
    if (wrap) wrap.style.display = isTow ? '' : 'none';
  };
  const areaEl = _el('wr-area-0');
  if (areaEl) {
    areaEl.addEventListener('input', checkTow);
    areaEl.addEventListener('change', checkTow);
  }

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
function _wireAIAssist() {
  const titleEl = _el('wr-title');
  const btn = _el('wr-ai-assist');
  if (!btn || !titleEl) return;
  btn.addEventListener('click', () => _runAIAssist());
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _runAIAssist(); }
  });
  titleEl.addEventListener('input', () => {
    clearTimeout(_aiTimer);
    if (titleEl.value.trim().length > 8) _aiTimer = setTimeout(_runAIAssist, 2500);
  });
}

async function _runAIAssist() {
  const titleEl = _el('wr-title');
  const btn = _el('wr-ai-assist');
  const title = (titleEl.value || '').trim();
  if (!title) { toast.show('warn', 'Type a title first', 2000); return; }
  btn.disabled = true; btn.textContent = '⏳ AI...';
  
  const unit = _unit || {};
  const unitId = unit.id || unit.equipmentId || '';
  const make = unit.manufacturer || '';
  const site = unit.domicileSite || unit.site || '';
  const notes = (unit.savedNotes || '').substring(0, 500);
  const uptake = (unit.insightsList || []).map(i => typeof i === 'object' ? (i.summary || i.text || '') : i).join('; ');
  
  const areaList = Object.entries(AREA_SUBS).map(([a, s]) => a + ': ' + s.join(', ')).join('\  // Listen for address from contact book\n  bus.on("contacts:use-address", (addr) => {\n    const s=_el("wr-tow-street");if(s)s.value=addr.street||"";;\n    const ct=_el("wr-tow-city");if(ct)ct.value=addr.city||"";;\n    const st=_el("wr-tow-state");if(st)st.value=addr.state||"";;\n    const z=_el("wr-tow-zip");if(z)z.value=addr.zip||"";;\n    const tw=_el("wr-tow-wrap");if(tw)tw.style.display="";;\n  });\nn');
  
  // Load vendor book for AI context
  let vendorBookCtx = '';
  if (window.contacts) {
    try {
      const allContacts = await window.contacts.getAll();
      const vendors = allContacts.filter(v => v.type === 'vendor' && v.street);
      if (vendors.length) {
        vendorBookCtx = '\nVENDOR BOOK (pick dealer by unit domicile + make):\n' +
          vendors.map(v => v.name + ' | Make: ' + (v.make || 'ANY') + ' | Domiciles: ' + (v.domiciles || []).join(',') + ' | ' + v.street + ', ' + (v.city||'') + ' ' + (v.state||'')).join('\n') +
          '\nWhen user says "send to dealer": pick the vendor from this book that matches unit make AND domicile. If no match, leave vendor empty.\n';
      }
    } catch(e) {}
  }

  const prompt = 'You are a fleet maintenance work request assistant for Amazon Transportation.\n\n'
    + 'User typed this WR title: "' + title + '"\n\n'
    + 'UNIT: ' + unitId + ' | Make: ' + make + ' | Site: ' + site + '\n'
    + (notes ? 'Notes: ' + notes + '\n' : '')
    + (uptake ? 'Uptake Insights: ' + uptake + '\n' : '')
    + '\nRULES:\n'
    + '- "Tow" = Area=TOW, sub=MECHANICAL ISSUE or ACCIDENT/RECOVERY, vendor=FleetNet (FLEETNET), urgent=true\n'
    + '- Vendor: LEAVE EMPTY by default (AAP auto-assigns). Only fill if user says "send to dealer" or "send to [vendor name]"\n'
    + '- If user says "send to dealer": Volvo/Mack→"Volvo (ASIST)", Kenworth→"Kenworth (PACCAR)", Peterbilt→"Peterbilt (PACCAR)", Freightliner→"Freightliner (DAIMLER)"\n'
    + '- Safety/brakes/fire → urgent=true\n'
    + '- For Predictive Maintenance: title must include "Predictive Maintenance", reference Uptake data in comments\n\n'
    + 'VALID AREAS/SUBCATEGORIES (use EXACT values):\n' + areaList + '\n\n'
    + 'Respond ONLY with valid JSON:\n'
    + '{"title":"improved title","issue":"2-3 sentence description","areaPairs":[{"area":"EXACT area","subcategory":"EXACT sub"}],"vendor":"","urgent":false,"comments":"what we need from vendor"}\n'
    + 'areaPairs can have 1-4 pairs if multiple systems are affected.\n'
    + 'vendor: LEAVE EMPTY unless user explicitly says "send to dealer" or names a specific vendor. AAP auto-assigns default vendor.';

  try {
    const result = await window.ai.ask(prompt);
    const text = (result && result.text) ? result.text : (result || '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { toast.show('warn', 'AI returned no data', 3000); return; }
    const ai = JSON.parse(match[0]);
    
    if (ai.title) titleEl.value = ai.title;
    if (ai.issue) { const el = _el('wr-issue'); if (el) el.value = ai.issue; }
    // Only set vendor if AI explicitly returned one (user said "send to dealer")
    if (ai.vendor && ai.vendor.trim()) {
      const sel = _el('wr-vendor');
      const opt = Array.from(sel.options).find(o => o.value === ai.vendor || o.value.toUpperCase().includes((ai.vendor||'').toUpperCase()));
      if (opt) sel.value = opt.value;
    }
    // Fill area/subcategory pairs (up to 4)
    const pairs = ai.areaPairs || (ai.area ? [{ area: ai.area, subcategory: ai.subcategory }] : []);
    const rowsContainer = _el('wr-area-rows');
    pairs.forEach((pair, i) => {
      if (i > 0 && rowsContainer) {
        // Add new row if needed
        const existing = _el('wr-area-' + i);
        if (!existing) {
          rowsContainer.insertAdjacentHTML('beforeend', _areaPairRow(_areaCount++, '', ''));
        }
      }
      const aEl = _el('wr-area-' + i);
      const sEl = _el('wr-sub-' + i);
      if (aEl) aEl.value = pair.area || '';
      // Show tow section if area is TOW
      if (i === 0 && (pair.area || '').toUpperCase() === 'TOW') {
        const towWrap = _el('wr-tow-wrap');
        if (towWrap) towWrap.style.display = '';
        // Auto-set urgent
        _el('wr-urgent').checked = true;
        _el('wr-urgency-reason-wrap').style.display = '';
        _el('wr-urgency-reason').value = 'DEA - Asset Shortage';
      }
      if (sEl) sEl.value = pair.subcategory || '';
    });
    if (ai.urgent) {
      _el('wr-urgent').checked = true;
      _el('wr-urgency-reason-wrap').style.display = '';
      _el('wr-urgency-reason').value = 'DEA - Asset Shortage';
    }
    if (ai.comments) { const el = _el('wr-comments'); if (el) el.value = ai.comments; }
    
    toast.show('success', '✨ AI filled — review and submit', 3000);
  } catch(e) {
    toast.show('error', 'AI failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false; btn.textContent = '✨ AI Fill';
  }
}

// ── Auto-attach Uptake screenshot for PM units ────────────────────────────
async function _wireAutoUptake() {
  const unit = _unit || {};
  if (!unit.riskScore || unit.riskScore < 50) return;
  try {
    const result = await files.getLatestScreenshot(unit.id || unit.equipmentId);
    if (result && result.path) {
      const dataUrl = await files.readAsDataUrl(result.path);
      if (dataUrl) {
        const btn = _el('wr-attach-screenshot');
        if (btn) btn._dataUrl = dataUrl;
        const label = _el('wr-screenshot-label');
        if (label) {
          label.textContent = '📎 Uptake screenshot auto-attached (risk: ' + unit.riskScore + '%)';
          label.className = 'wr-screenshot-label wr-screenshot-label--attached';
        }
      }
    }
  } catch(e) { /* silent */ }
}

export function open(unit) {
  if (_overlay) _close();
  _unit      = unit;
  _areaCount = 1;

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
  _wireSubmit();
  _wireAIAssist();
  _wireAutoUptake();
  _wireTow();

  // Pre-select vendor from relay data if available
  const relayVendor = (unit.relayVendor || unit.vendor || '').toUpperCase();
  if (relayVendor) {
    const match = Array.from(_el('wr-vendor').options)
      .find(o => o.value.toUpperCase().includes(relayVendor));
    if (match) _el('wr-vendor').value = match.value;
  }

  // Pre-fill contact from user profile
  const _profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}');
  if (_profile.name) { const el = _el('wr-contact-name'); if (el) el.value = _profile.name; }
  if (_profile.phone) { const el = _el('wr-contact-phone'); if (el) el.value = _profile.phone; }

  // Focus title field
  setTimeout(() => { const t = _el('wr-title'); if (t) t.focus(); }, 50);
}
