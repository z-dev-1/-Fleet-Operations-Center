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
import { files } from '../bridge.js';
import { readFileAsAttachment } from './wr-modal.js';

let _overlay    = null;
let _unit       = null;
let _vendorKey  = null;
let _onSubmit   = null;
let _lastResolvedVendor = null; // { id, name, address } -- vendor-load tracking + Volvo assign line
let _attachments = [];          // Volvo: [{ name, dataUrl }] -- auto Uptake screenshots + user files

// ── Volvo (ASIST API path, 2026-10-28) helpers ───────────────────────────────
// "Please assign unit to <dealer> <address> for service" -- the last line of
// the Volvo Issue Details. "for Mobile service" when the job is mobile.
const _ASSIGN_RE = /^Please assign unit to .*$/m;
function _addrLine(c) {
  if (!c) return '';
  // "462 Harleysville Pike, Souderton PA 18964"
  const cityStZip = [String(c.city || '').trim(), String(c.state || '').trim(), String(c.zip || '').trim()]
    .filter(Boolean).join(' ');
  return [String(c.street || '').trim(), cityStZip].filter(Boolean).join(', ');
}
function _assignLine(dealerName, dealerAddr, mobile) {
  const who = [String(dealerName || '').trim(), String(dealerAddr || '').trim()].filter(Boolean).join(' ');
  return 'Please assign unit to ' + (who || '(dealer)') + ' for ' + (mobile ? 'Mobile service' : 'service');
}
// Mentions of mobile work in the issue text (ignoring the assign line itself).
function _mentionsMobile(text) {
  return /\bmobile\s+(maint\w*|service|repair|tech\w*|mechanic|unit)\b/i.test(String(text || '').replace(_ASSIGN_RE, ''));
}
function _setAssignLine(text, line) {
  const t = String(text || '');
  return _ASSIGN_RE.test(t) ? t.replace(_ASSIGN_RE, line) : (t.replace(/\s+$/, '') + '\n' + line);
}

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

// Assemble the FAS pickup-confirmation Issue Details block. `complaint` is the
// text for the "Compliant:" line (AI-synthesized when available, else raw
// issue details). profile/domicile may be partial/empty — every field degrades
// gracefully so the block is always well-formed for the user to edit.
function _buildStructuredIssue(unit, profile, domicile, complaint) {
  profile = profile || {};
  const { first, last } = _splitName(profile.name);
  const pocName = String(profile.name || '').trim() || (first + (last ? ' ' + last : '')).trim();
  const locationAddr = domicile
    ? [String(domicile.street || '').trim(),
       [String(domicile.city || '').trim(), String(domicile.state || '').trim()].filter(Boolean).join(', '),
       String(domicile.zip || '').trim()].filter(Boolean).join(', ')
    : String((unit && unit.domicileSite) || '').trim();
  return [
    'FAS HAS CONFIRMED WITH POC THAT UNIT IS READY FOR PICK UP',
    'Amazon POC: ' + (pocName || ''),
    'Phone number: ' + (profile.phone || ''),
    'Email: ' + (profile.email || ''),
    'Location: ' + (locationAddr || '(domicile address for unit)'),
    'Unit: ' + ((unit && (unit.equipmentId || unit.id)) || ''),
    'Key: ignition',
    'Gate code: none',
    'Unit ready: YES',
    'Unit Drive-able: NO',
    'Compliant: ' + String(complaint || '').trim(),
  ].join('\n');
}

// Minimal defaults used when contact/AI resolution is slow or fails. Still
// produces the structured Issue Details block (from the user profile +
// whatever raw issue text the unit has) so the user never sees a blank/
// unstructured field — they just fill City/State + Dealer and edit as needed.
function _minimalDefaults(unit, vendorKey) {
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}'); } catch (_) {}
  const { first, last } = _splitName(profile.name);
  const rawComplaint = (unit && (unit.issueDetails || unit.issueSummary)) || '';
  let issue = _buildStructuredIssue(unit, profile, null, rawComplaint);
  const mobile = vendorKey === 'volvo' && _mentionsMobile(issue);
  if (vendorKey === 'volvo') issue = _setAssignLine(issue, _assignLine('', '', mobile));
  return {
    cityState: '', dealer: '', breakdownLocation: '', mobile,
    firstName: first, lastName: last,
    phone: profile.phone || '', email: profile.email || '',
    issue,
    date: new Date().toISOString().slice(0, 10), ackCheck: true,
  };
}

async function _resolveDefaults(unit, vendorKey) {
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}'); } catch (_) {}
  const { first, last } = _splitName(profile.name);

  let domicile = null, vendorContact = null;
  const MAX_UNITS_PER_VENDOR = 3; // route to next preference once a vendor hits this many active units
  try {
    const contacts = (window.contacts && await window.contacts.getAll()) || [];
    // Match the unit's domicile against the Contact Book "Domiciles" tab.
    // Case-insensitive + trimmed on BOTH sides — Contact Book entries and the
    // scraped domicileSite can differ in case/whitespace ("PHL40 " vs "phl40"),
    // and an exact === match would silently leave Location blank.
    const site = String(unit.domicileSite || '').trim();
    const siteU = site.toUpperCase();
    domicile = contacts.find(c => c.type === 'domicile' && site &&
      String(c.name || '').trim().toUpperCase() === siteU) || null;

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
    // Vendor must serve this unit's make AND cover this domicile. Domicile
    // codes compared case-insensitively/trimmed (same reason as above).
    const servesSite = (c) => Array.isArray(c.domiciles) &&
      c.domiciles.some(d => String(d || '').trim().toUpperCase() === siteU);
    let candidates = contacts.filter(c => c.type === 'vendor' && servesMake(c)
      && site && servesSite(c)).sort(byPreference);
    if (!candidates.length) {
      // No vendor scoped to this domicile — fall back to any vendor for the make.
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

  _lastResolvedVendor = vendorContact ? {
    id: vendorContact.id, name: vendorContact.company || vendorContact.name || '',
    address: _addrLine(vendorContact), mobile: !!vendorContact.mobile,
  } : null;

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


  // Structured FAS pickup-confirmation Issue Details. The "Compliant:" line
  // uses the AI-synthesized issue (folds in the CEL/complaint, the prior
  // vendor's out-of-scope rejection, and shared diagnostic notes).
  let structuredIssue = _buildStructuredIssue(unit, profile, domicile, issue);

  // Volvo: add the "Please assign unit to <dealer> <address> for service"
  // line; "Mobile service" when the dealer is a mobile vendor or the issue
  // text says it's mobile maintenance.
  let mobile = false;
  if (vendorKey === 'volvo') {
    mobile = !!(_lastResolvedVendor && _lastResolvedVendor.mobile) || _mentionsMobile(structuredIssue);
    structuredIssue = _setAssignLine(structuredIssue, _assignLine(
      _lastResolvedVendor && _lastResolvedVendor.name, _lastResolvedVendor && _lastResolvedVendor.address, mobile));
  }

  return {
    breakdownLocation: _addrLine(domicile),
    mobile,
    cityState: domicile
      ? [String(domicile.city || '').trim(), String(domicile.state || '').trim()]
          .filter(Boolean).join(', ')
      : '',
    dealer:    vendorContact ? (vendorContact.company || vendorContact.name || '') : '',
    firstName: first,
    lastName:  last,
    phone:     profile.phone || '',
    email:     profile.email || '',
    issue:     structuredIssue,
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
      <textarea id="dwo-issue" class="settings__textarea" rows="13"
        placeholder="Full defect / complaint details...">${_esc(d.issue)}</textarea>
      ${vendorKey === 'volvo' ? `<div style="font-size:11px;opacity:.7;margin-top:4px">Sent to ASIST as the Complaint, Notes and attachment Description.</div>` : ''}
    </div>

    ${vendorKey === 'volvo' ? `
    <div class="wr-section">
      <div class="wr-section__title">Volvo ASIST</div>
      <label class="settings-label">Breakdown Location <span style="opacity:.6">(domicile address)</span>
        <input id="dwo-breakdown-location" class="settings__input" type="text"
          placeholder="Street, City ST ZIP" value="${_attr(d.breakdownLocation)}" />
      </label>
      <label class="settings-label settings-label--inline" style="margin-top:6px">
        <input id="dwo-mobile" type="checkbox" ${d.mobile ? 'checked' : ''} />
        Mobile service <span style="opacity:.6">(changes the last line to "for Mobile service")</span>
      </label>
      <div style="font-size:11px;opacity:.7;margin-top:4px">Auth Number = the AMZ dealer-tracking number (you can correct it on the review screen). Requested Appointment Time = when this WO is created.</div>
    </div>

    <div class="wr-section">
      <div class="wr-section__title">Attachments</div>
      <div class="wr-screenshot-row">
        <button id="dwo-attach-uptake" type="button" class="detail-panel__btn detail-panel__btn--secondary">Attach Uptake screenshots</button>
      </div>
      <div id="dwo-dropzone" class="wr-dropzone">
        <span>Drag files here, or <button id="dwo-attach-browse" type="button" class="wr-dropzone__browse">browse…</button></span>
        <input id="dwo-attach-file-input" type="file" multiple accept="image/*,.pdf" style="display:none" />
      </div>
      <div id="dwo-attach-list" class="wr-attach-list"></div>
    </div>` : ''}

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
    // Volvo-only fields (absent for PACCAR -> empty / false / [])
    breakdownLocation: ((_el('dwo-breakdown-location') || {}).value || '').trim(),
    mobile:    !!(_el('dwo-mobile') || {}).checked,
    attachments: _attachments.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
  };
}

// ── Volvo attachments + assign line wiring ───────────────────────────────────
function _addAttachment(name, dataUrl) {
  if (!dataUrl || _attachments.some(a => a.dataUrl === dataUrl)) return;
  _attachments.push({ name: name || 'attachment', dataUrl });
  _renderAttachments();
}
function _renderAttachments() {
  const list = _el('dwo-attach-list');
  if (!list) return;
  list.innerHTML = _attachments.map((a, i) =>
    '<div class="wr-attach-chip"><span class="wr-attach-chip__name">' + _esc(a.name) + '</span>' +
    '<button type="button" class="wr-attach-chip__remove" data-idx="' + i + '" title="Remove" aria-label="Remove ' + _attr(a.name) + '">×</button></div>').join('');
  list.querySelectorAll('.wr-attach-chip__remove').forEach(btn => {
    btn.addEventListener('click', () => { _attachments.splice(Number(btn.dataset.idx), 1); _renderAttachments(); });
  });
}
function _uptakePaths(unit) {
  return Array.from(new Set([].concat(
    unit && unit.screenshotPath ? [unit.screenshotPath] : [],
    unit && Array.isArray(unit.screenshots) ? unit.screenshots : []
  ).filter(Boolean)));
}
async function _attachUptake(unit, { quiet } = {}) {
  const paths = _uptakePaths(unit);
  if (!paths.length) {
    const r = _el('dwo-result');
    if (!quiet && r) { r.style.display = 'block'; r.textContent = 'No Uptake screenshot stored for this unit (run a sync first).'; }
    return 0;
  }
  let n = 0;
  for (const p of paths) {
    try { const dataUrl = await files.readAsDataUrl(p); if (dataUrl) { _addAttachment(p.split(/[/\\]/).pop(), dataUrl); n++; } }
    catch (_) { /* unreadable file -- skip */ }
  }
  return n;
}
function _addFiles(fileList) {
  Array.from(fileList || []).forEach(async (file) => {
    const att = await readFileAsAttachment(file);
    if (att && !att.warn) _addAttachment(att.name, att.dataUrl);
    else {
      const r = _el('dwo-result');
      if (r) { r.style.display = 'block'; r.textContent = '"' + file.name + '" could not be attached' + (att && att.warn ? ' (' + att.warn + ')' : '') + '.'; }
    }
  });
}
function _wireVolvo(unit) {
  if (!_el('dwo-attach-list')) return; // not the Volvo form
  // Uptake screenshots auto-attach (same rule as the WR form: whenever this
  // unit has stored Uptake screenshots). User can remove them.
  _attachUptake(unit, { quiet: true }).catch(() => {});
  const up = _el('dwo-attach-uptake');
  if (up) up.addEventListener('click', () => _attachUptake(unit).catch(() => {}));
  const input = _el('dwo-attach-file-input');
  const browse = _el('dwo-attach-browse');
  if (browse && input) {
    browse.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { _addFiles(input.files); input.value = ''; });
  }
  const dz = _el('dwo-dropzone');
  if (dz) {
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('wr-dropzone--active'); }));
    ['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('wr-dropzone--active'); }));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); dz.classList.remove('wr-dropzone--active');
      if (e.dataTransfer && e.dataTransfer.files) _addFiles(e.dataTransfer.files);
    });
  }
  // Keep the "Please assign unit to ..." line in sync with the Dealer field
  // and the Mobile checkbox. Typing "mobile maintenance" in the issue ticks it.
  const issueEl = _el('dwo-issue'), dealerEl = _el('dwo-dealer'), mobileEl = _el('dwo-mobile');
  const sync = () => {
    if (!issueEl || !mobileEl) return;
    const name = dealerEl ? dealerEl.value : '';
    const addr = (_lastResolvedVendor && _lastResolvedVendor.name === String(name).trim()) ? _lastResolvedVendor.address : '';
    const next = _setAssignLine(issueEl.value, _assignLine(name, addr, mobileEl.checked));
    if (next !== issueEl.value) issueEl.value = next;
  };
  if (mobileEl) mobileEl.addEventListener('change', sync);
  if (dealerEl) dealerEl.addEventListener('change', sync);
  if (issueEl && mobileEl) issueEl.addEventListener('input', () => {
    if (!mobileEl.checked && _mentionsMobile(issueEl.value)) { mobileEl.checked = true; sync(); }
  });
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
  try {
    console.log('[dealer-wo-modal] open()', { unit: unit && (unit.equipmentId || unit.id), vendorKey });
    if (_overlay) close();
    _unit      = unit;
    _vendorKey = vendorKey;
    _onSubmit  = onSubmit;
    _attachments = [];

    _overlay           = document.createElement('div');
    _overlay.id        = 'dwo-modal-overlay';
    _overlay.className = 'wr-modal-overlay';
    _overlay.innerHTML = '<div class="wr-modal" style="padding:24px;color:var(--text-secondary,#999)">Loading contact book / profile — generating issue description…</div>';
    document.body.appendChild(_overlay);
  } catch (e) {
    console.error('[dealer-wo-modal] open() failed before render:', e);
    return;
  }

  // Render defaults. Wrapped so a slow/failing AI issue-synthesis or contact
  // lookup can NEVER leave the modal stuck on "Loading…" — we render the form
  // with whatever we have and let the user fill the rest.
  const _renderWith = (d) => {
    if (!_overlay) return; // closed while resolving
    try {
      _overlay.innerHTML = _buildHTML(unit, vendorKey, d || {});
      _overlay.addEventListener('click', (e) => { if (e.target === _overlay) close(); });
      const closeBtn = _el('dwo-close');  if (closeBtn)  closeBtn.addEventListener('click', close);
      const cancelBtn = _el('dwo-cancel'); if (cancelBtn) cancelBtn.addEventListener('click', close);
      _wireSubmit();
      _wireVolvo(unit);
      setTimeout(() => { const t = _el('dwo-city-state'); if (t) t.focus(); }, 50);
    } catch (e) {
      console.error('[dealer-wo-modal] render failed:', e);
      if (_overlay) _overlay.innerHTML = '<div class="wr-modal" style="padding:24px;color:#f85149">Dealer WO modal failed to render: ' + _esc(e.message) + '</div>';
    }
  };

  // Cap _resolveDefaults so a hung AI call (window.ai.ask can take 60-240s or
  // never resolve) cannot hold the modal on "Loading…" forever. If it doesn't
  // resolve within 6s, render the form immediately with minimal defaults;
  // the AI-enriched issue text simply won't be pre-filled.
  let _settled = false;
  const _fallbackTimer = setTimeout(() => {
    if (_settled) return;
    _settled = true;
    console.warn('[dealer-wo-modal] _resolveDefaults slow — rendering with minimal defaults');
    _renderWith(_minimalDefaults(unit, vendorKey));
  }, 6000);

  Promise.resolve()
    .then(() => _resolveDefaults(unit, vendorKey))
    .then((d) => {
      if (_settled) return; // timeout already rendered
      _settled = true;
      clearTimeout(_fallbackTimer);
      _renderWith(d);
    })
    .catch((e) => {
      if (_settled) return;
      _settled = true;
      clearTimeout(_fallbackTimer);
      console.error('[dealer-wo-modal] _resolveDefaults failed:', e);
      _renderWith(_minimalDefaults(unit, vendorKey));
    });
}

export function close() {
  if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
  _overlay   = null;
  _unit      = null;
  _vendorKey = null;
  _onSubmit  = null;
  _lastResolvedVendor = null;
  _attachments = [];
}
