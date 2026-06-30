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

const AREA_TEMPLATES = [
  'ENGINE', 'BRAKES', 'TIRES/WHEELS', 'ELECTRICAL',
  'HVAC', 'FRAME/BODY', 'SUSPENSION', 'TRANSMISSION', 'FUEL SYSTEM', 'EXHAUST',
];

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
      <div class="wr-section__title">Work Details</div>
      <label class="settings-label">WR Title
        <input id="wr-title" class="settings__input" type="text"
          placeholder="Brief description of the issue"
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
      <div class="wr-section__title">Screenshot Attachment</div>
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

  fallbackBtn.addEventListener('click', () => _autofillFallback(_collectPayload()));
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

  // Pre-select vendor from relay data if available
  const relayVendor = (unit.relayVendor || unit.vendor || '').toUpperCase();
  if (relayVendor) {
    const match = Array.from(_el('wr-vendor').options)
      .find(o => o.value.toUpperCase().includes(relayVendor));
    if (match) _el('wr-vendor').value = match.value;
  }

  // Focus title field
  setTimeout(() => { const t = _el('wr-title'); if (t) t.focus(); }, 50);
}
