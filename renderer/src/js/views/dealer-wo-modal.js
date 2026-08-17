/**
 * dealer-wo-modal.js — Dealer Work Order review modal (PACCAR / Volvo)
 *
 * Mirrors wr-modal.js's UX: an in-app editable modal, pre-filled from the
 * Contact Book (domiciles + vendors) and the user's own Profile, that the
 * user reviews/edits BEFORE any Decisiv portal automation runs. Only after
 * "Create Dealer WO" is clicked here does vendor.startPaccar/startVolvo
 * fire, now carrying a resolved `formData` object the orchestrator's fill
 * step consumes instead of guessing values from the unit record alone.
 *
 * Usage:
 *   import { open as openDealerWOModal } from './dealer-wo-modal.js';
 *   openDealerWOModal(unit, vendorKey, (formData) => { ...start workflow... });
 *
 * Data sources (all resolved client-side, before any portal automation):
 *   - City/State   <- Contact Book, Domiciles tab (match on unit.domicileSite)
 *   - Dealer       <- Contact Book, Vendors tab   (match on make + domicile)
 *   - Name/Phone/Email <- localStorage 'fleet_user_profile' ({name,phone,email})
 *   - Issue        <- unit.issueDetails / pmStatus / issueSummary
 *   - Date         <- defaults to today, editable
 *   - Ack checkbox <- Decisiv's second request-service checkbox; exact
 *     meaning not yet confirmed by the user -- defaults checked, clearly
 *     labeled as unconfirmed so it's obvious in the UI, and always the
 *     live portal review-gate (existing vendor-review-modal.js) is the
 *     final safety net before anything actually submits.
 */

import state from '../state.js';

let _overlay    = null;
let _unit       = null;
let _vendorKey  = null;
let _onSubmit   = null;
let _lastResolvedVendor = null; // { id, name } -- for vendor-load tracking on submit

const _esc  = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _attr = (s) => _esc(s).replace(/"/g, '&quot;');
const _el   = (id) => document.getElementById(id);

// BUGFIX-AVOIDANCE (2026-07-26): Decisiv's ad-hoc-contact "First Name" field
// (#input-field-target-241 on the PACCAR portal) needs at least 3 characters
// -- confirmed live by the user with a 1-char first name ("Z") that had to be
// sent as "  Z" (2 leading spaces). This is a generic left-pad-to-3 rule
// applied to whatever the real profile first name is, not a hardcoded value.
function _padName3(name) {
  const s = String(name || '').trim();
  if (s.length >= 3) return s;
  return ' '.repeat(3 - s.length) + s;
}

function _splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

async function _resolveDefaults(unit) {
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}'); } catch (_) {}
  const { first, last } = _splitName(profile.name);

  let domicile = null, vendorContact = null;
  const MAX_UNITS_PER_VENDOR = 3; // route to next preference once a vendor hits this many active units
  try {
    const contacts = (window.contacts && await window.contacts.getAll()) || [];
    // Trim names on both sides -- some Contact Book entries have trailing spaces
    const site = String(unit.domicileSite || '').trim();
    domicile = contacts.find(c => c.type === 'domicile' && site &&
      String(c.name || '').trim() === site) || null;

    const make = String(unit.manufacturer || unit.make || '').toUpperCase();
    // A vendor's rank can differ per domicile it serves (e.g. #1 at AVP40 but
    // #2 at ABE40) -- preferenceByDomicile[site] overrides the vendor's
    // shared `preference` default for that one site only.
    const rankFor = (c) => {
      const overrides = c.preferenceByDomicile || {};
      if (site && overrides[site] != null) return overrides[site];
      return c.preference != null ? c.preference : Infinity;
    };
    const byPreference = (a, b) => rankFor(a) - rankFor(b);
    // Many dealers service multiple makes -- check the `makes` array first,
    // falling back to the legacy single `make` field for older entries.
    const servesMake = (c) => Array.isArray(c.makes) && c.makes.length
      ? c.makes.map(m => String(m).toUpperCase()).includes(make)
      : String(c.make || '').toUpperCase() === make;
    let candidates = contacts.filter(c => c.type === 'vendor' && servesMake(c)
      && site && Array.isArray(c.domiciles) && c.domiciles.includes(site)).sort(byPreference);
    if (!candidates.length) {
      candidates = contacts.filter(c => c.type === 'vendor' && servesMake(c)).sort(byPreference);
    }

    if (candidates.length) {
      // Preference 1, 2, 3... -- walk in rank order and skip any vendor that
      // already has MAX_UNITS_PER_VENDOR+ units actively assigned to it.
      try {
        const assignments = (window.vendorAssignments && await window.vendorAssignments.getAll()) || [];
        const liveRows = (state.slice('fleet').rows) || [];
        const activeIds = new Set(
          liveRows
            .filter(u => String(u.lifecycleState || '').toLowerCase() !== 'available')
            .map(u => u.equipmentId || u.id)
        );
        const activeCountFor = (vendorId) =>
          assignments.filter(a => a.vendorId === vendorId && activeIds.has(a.unitId)).length;
        vendorContact = candidates.find(c => activeCountFor(c.id) < MAX_UNITS_PER_VENDOR) || candidates[0];
      } catch (_) {
        vendorContact = candidates[0]; // tracking unavailable -- fall back to top preference
      }
    }
  } catch (_) {}

  _lastResolvedVendor = vendorContact ? { id: vendorContact.id, name: vendorContact.company || vendorContact.name || '' } : null;

  // AI-synthesized issue description: combine issueDetails + repairTimeline into
  // a concise, dealer-ready description the tech can act on immediately.
  // Falls back to raw issueDetails if AI is unavailable or the unit has no timeline.
  let issue = unit.issueDetails || unit.pmStatus || unit.issueSummary || '';
  const timeline = unit.repairTimeline || unit.timeline || '';
  if (issue || timeline) {
    try {
      const make = (unit.manufacturer || unit.make || 'commercial truck');
      const body = unit.bodyType || '';
      const prompt = 'Write a dealer work order issue description (3-5 sentences) for a '
        + make + ' ' + body + '. Use the following information:\n'
        + (issue    ? 'Issue details: ' + issue + '\n'   : '')
        + (timeline ? 'Repair timeline (chronological technician/vendor notes):\n' + timeline + '\n' : '')
        + '\nThe repair timeline above is the most important source -- it contains the actual '
        + 'diagnostic findings (fault codes, components inspected, parts ordered, technician '
        + 'observations). Pull every specific technical detail mentioned across ALL timeline entries '
        + '(not just the first one) into the description: named components (e.g. turbocharger, '
        + 'CAC hoses, speed sensor, VGT, fifth wheel, air suspension), specific fault/diagnostic '
        + 'findings, and any parts or repairs identified as needed. Write it as a single technical '
        + 'summary a dealer technician can act on without reading the raw notes. '
        + 'Do not include dates, vendor names, escalation/approval status, or estimate/paperwork '
        + 'details -- only the mechanical issue and diagnostic findings.';
      const aiResult = window.ai && typeof window.ai.ask === 'function'
        ? await window.ai.ask(prompt)
        : null;
      // window.ai.ask() resolves through ipc ai:ask -> askOrcha(), which returns
      // { ok: true, text } / { ok: false, error } -- NOT a plain string. The old
      // `typeof aiResult === 'string'` check was always false, so the AI synthesis
      // was silently discarded on every call and `issue` fell back to the raw
      // issueDetails field (never including timeline data). Unwrap the real shape.
      const aiText = typeof aiResult === 'string' ? aiResult
        : (aiResult && aiResult.ok && typeof aiResult.text === 'string') ? aiResult.text
        : '';
      if (aiText && aiText.trim().length > 10) {
        issue = aiText.trim();
      }
    } catch (_) { /* non-fatal -- keep raw issueDetails */ }
  }


  return {
    cityState: domicile
      ? [String(domicile.city || '').trim(), String(domicile.state || '').trim()]
          .filter(Boolean).join(', ')
      : '',
    dealer:    vendorContact ? (vendorContact.company || vendorContact.name || '') : '',
    firstName: first,
    lastName:  last,
    phone:     profile.phone || '',
    email:     profile.email || '',
    issue,
    date:      new Date().toISOString().slice(0, 10),
    ackCheck:  true,
  };
}

function _buildHTML(unit, vendorKey, d) {
  const label = vendorKey === 'paccar' ? 'PACCAR (Kenworth / Peterbilt)' : 'Volvo (ASIST)';
  return `
<div class="wr-modal" id="dwo-modal-box" role="dialog" aria-modal="true" aria-labelledby="dwo-modal-title">

  <div class="wr-modal__header">
    <div class="wr-modal__title-row">
      <span id="dwo-modal-title" class="wr-modal__title">Create Dealer Work Order</span>
      <span class="wr-modal__unit-id">${_esc(unit.id || unit.equipmentId || '')}</span>
    </div>
    <button id="dwo-close" class="wr-modal__close" aria-label="Close">×</button>
  </div>

  <div class="wr-modal__body">

    <div class="wr-section">
      <div class="wr-section__title">Dealer Portal — ${_esc(label)}</div>
      <div class="wr-two-col">
        <label class="settings-label">City / State
          <input id="dwo-city-state" class="settings__input" type="text"
            placeholder="e.g. Allentown, PA, USA" value="${_attr(d.cityState)}" />
        </label>
        <label class="settings-label">Dealer
          <input id="dwo-dealer" class="settings__input" type="text"
            placeholder="From Contact Book vendor" value="${_attr(d.dealer)}" />
        </label>
      </div>
      <div class="wr-two-col" style="margin-top:6px">
        <label class="settings-label">Appointment Date
          <input id="dwo-date" class="settings__input" type="date" value="${_attr(d.date)}" />
        </label>
        <label class="settings-label settings-label--inline" style="align-self:flex-end;padding-bottom:6px">
          <input id="dwo-ack" type="checkbox" ${d.ackCheck ? 'checked' : ''} />
          Acknowledge / confirm details <span style="opacity:.6">(meaning unconfirmed — leave checked unless portal review shows otherwise)</span>
        </label>
      </div>
    </div>

    <div class="wr-section">
      <div class="wr-section__title">Contact — from your User Profile</div>
      <div class="wr-two-col">
        <label class="settings-label">First Name
          <input id="dwo-first" class="settings__input" type="text" value="${_attr(d.firstName)}" />
        </label>
        <label class="settings-label">Last Name
          <input id="dwo-last" class="settings__input" type="text" value="${_attr(d.lastName)}" />
        </label>
      </div>
      <div class="wr-two-col" style="margin-top:6px">
        <label class="settings-label">Phone
          <input id="dwo-phone" class="settings__input" type="text" value="${_attr(d.phone)}" />
        </label>
        <label class="settings-label">Email
          <input id="dwo-email" class="settings__input" type="text" value="${_attr(d.email)}" />
        </label>
      </div>
    </div>

    <div class="wr-section">
      <div class="wr-section__title">Issue Details</div>
      <textarea id="dwo-issue" class="settings__textarea" rows="3"
        placeholder="Full defect / complaint details...">${_esc(d.issue)}</textarea>
    </div>

    <div id="dwo-result" class="wr-result" style="display:none"></div>

  </div><!-- /body -->

  <div class="wr-modal__footer">
    <div class="wr-footer-right">
      <button id="dwo-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
      <button id="dwo-submit" class="detail-panel__btn wr-submit-btn">Create Dealer WO</button>
    </div>
  </div>

</div>`;
}

function _collectFormData() {
  return {
    cityState: (_el('dwo-city-state').value || '').trim(),
    dealer:    (_el('dwo-dealer').value || '').trim(),
    date:      (_el('dwo-date').value || '').trim(),
    ackCheck:  !!_el('dwo-ack').checked,
    // Padded here (not in the visible input) so the review UI always shows
    // the user's real name, while the value actually sent to Decisiv meets
    // its undocumented 3-char minimum.
    firstName: _padName3(_el('dwo-first').value || ''),
    lastName:  (_el('dwo-last').value || '').trim(),
    phone:     (_el('dwo-phone').value || '').trim(),
    email:     (_el('dwo-email').value || '').trim(),
    issue:     (_el('dwo-issue').value || '').trim(),
  };
}

function _wireSubmit() {
  _el('dwo-submit').addEventListener('click', () => {
    const formData = _collectFormData();
    const resultEl = _el('dwo-result');
    if (!formData.cityState || !formData.dealer) {
      if (resultEl) {
        resultEl.style.display = 'block';
        resultEl.textContent = 'City/State and Dealer are required.';
      }
      return;
    }
    // Record which specific vendor this WO was routed to (only if the dealer
    // field still matches what we auto-resolved -- if the user typed in a
    // different dealer by hand, we don't know its Contact Book id, so skip
    // tracking rather than guess).
    if (window.vendorAssignments && _unit && _lastResolvedVendor &&
        _lastResolvedVendor.name === formData.dealer) {
      window.vendorAssignments.upsert({
        unitId:     _unit.equipmentId || _unit.id || '',
        vendorId:   _lastResolvedVendor.id,
        vendorName: _lastResolvedVendor.name,
        make:       _unit.manufacturer || _unit.make || '',
        site:       _unit.domicileSite || '',
      }).catch(() => {});
    }

    const cb = _onSubmit;
    close();
    if (typeof cb === 'function') cb(formData);
  });
}

export function open(unit, vendorKey, onSubmit) {
  if (_overlay) close();
  _unit      = unit;
  _vendorKey = vendorKey;
  _onSubmit  = onSubmit;

  _overlay           = document.createElement('div');
  _overlay.id        = 'dwo-modal-overlay';
  _overlay.className = 'wr-modal-overlay';
  _overlay.innerHTML = '<div class="wr-modal" style="padding:24px;color:var(--text-secondary,#999)">Loading contact book / profile — generating issue description…</div>';
  document.body.appendChild(_overlay);

  _resolveDefaults(unit).then((d) => {
    if (!_overlay) return; // closed while resolving
    _overlay.innerHTML = _buildHTML(unit, vendorKey, d);
    _overlay.addEventListener('click', (e) => { if (e.target === _overlay) close(); });
    _el('dwo-close').addEventListener('click', close);
    _el('dwo-cancel').addEventListener('click', close);
    _wireSubmit();
    setTimeout(() => { const t = _el('dwo-city-state'); if (t) t.focus(); }, 50);
  });
}

export function close() {
  if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay   = null;
  _unit      = null;
  _vendorKey = null;
  _onSubmit  = null;
  _lastResolvedVendor = null;
}
