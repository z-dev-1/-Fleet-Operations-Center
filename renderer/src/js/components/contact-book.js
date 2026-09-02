/**
 * contact-book.js — Contact Book Panel (Vendors + Domiciles + Slack)
 *
 * Contact Book is the SINGLE source of truth and the ONLY UI where a Slack
 * contact's identity, fleet scope, data/request/lifecycle permissions and
 * communication preferences are configured. FAS Settings is a read-only
 * summary of what is set here.
 *
 * Vendors have addresses usable for tow destination in the WR modal.
 * Slack contacts have @handles for mentions AND a full permission editor.
 */

import bus from '../bus.js';
import state from '../state.js';

let _el = null;
let _open = false;
let _tab = 'vendors'; // 'vendors' | 'domiciles' | 'slack'
let _contacts = [];
let _slackSearchTimer = null; // debounce handle for live search
let _pendingSlack = null;     // { slackId, name, channelId? } resolved from search

const _esc  = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _attr = (s) => _esc(s).replace(/"/g, '&quot;');

// ── Canonical permission vocabulary ─────────────────────────────────────────
// These MUST mirror src/services/contact-book.js (VALID_IDENTITY / DATA_CATS /
// REQ_TYPES / LIFECYCLE_PERMS). The service re-sanitizes every write against
// these same lists, so the UI can only ever offer values the backend accepts.
const IDENTITY_TYPES = [
  { value: 'internal', label: 'Internal (Amazon team)' },
  { value: 'manager',  label: 'Manager (full access)' },
  { value: 'carrier',  label: 'Carrier / SCAC partner' },
  { value: 'vendor',   label: 'Vendor / dealer' },
  { value: 'unknown',  label: 'Unknown / untriaged' },
];
const DATA_CATS = [
  { value: 'unit_status',     label: 'Unit status' },
  { value: 'repair_timeline', label: 'Repair timeline' },
  { value: 'work_orders',     label: 'Work orders' },
  { value: 'pm_status',       label: 'PM status' },
  { value: 'uptake',          label: 'Uptake' },
  { value: 'vendor_contact',  label: 'Vendor contact' },
  { value: 'site_summary',    label: 'Site summary' },
  { value: 'operator_summary',label: 'Operator summary' },
];
const REQ_TYPES = [
  { value: 'unit_status',      label: 'Ask unit status' },
  { value: 'repair_update',    label: 'Ask repair update' },
  { value: 'follow_up',        label: 'Follow up' },
  { value: 'report',           label: 'Request a report' },
  { value: 'process_question', label: 'Process question' },
  { value: 'lifecycle_change', label: 'Request lifecycle change' },
  { value: 'create_wr',        label: 'Create work request' },
];
const LIFECYCLE_PERMS = [
  { value: 'not_allowed',        label: 'Not allowed', hint: 'Blocks lifecycle actions even if an operator clicks Approve.' },
  { value: 'may_request',        label: 'May request (needs approval)', hint: 'Can request a lifecycle change; a human must approve it.' },
  { value: 'trusted_autonomous', label: 'Trusted (autonomous)', hint: 'FAS may act on lifecycle requests without approval when all gates pass.' },
];
const ALL_DATA_CAT_VALUES = DATA_CATS.map(d => d.value);
const ALL_REQ_TYPE_VALUES = REQ_TYPES.map(r => r.value);

// Identity → default preset. MIRRORS sender-profiles.js presetFor(). Lifecycle
// is deliberately NEVER preset — it is granted explicitly per contact.
function _presetFor(identity) {
  if (identity === 'internal' || identity === 'manager') {
    return { allowedDataCategories: ALL_DATA_CAT_VALUES.slice(), permittedRequestTypes: ALL_REQ_TYPE_VALUES.slice() };
  }
  if (identity === 'carrier' || identity === 'vendor') {
    return {
      allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'],
      permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'process_question'],
    };
  }
  // unknown
  return {
    allowedDataCategories: ['unit_status'],
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'process_question'],
  };
}
// Identity types that are EXTERNAL — empty scope for these means NO access.
const _isExternalIdentity = (id) => id === 'carrier' || id === 'vendor' || id === 'unknown';

// Operator codes (SCAC) from the latest fleet scan, for the data-scope picker.
function _fleetOperators() {
  try {
    const rows = (state.slice('fleet').rows) || [];
    const set = {};
    rows.forEach(function(r){ const o = (r.operator || '').trim(); if (o) set[o.toUpperCase()] = true; });
    return Object.keys(set).sort();
  } catch (e) { return []; }
}
// Domicile site codes from the latest fleet scan (domicileSite, legacy domicile).
function _fleetDomiciles() {
  try {
    const rows = (state.slice('fleet').rows) || [];
    const set = {};
    rows.forEach(function(r){ const d = (r.domicileSite || r.domicile || '').trim(); if (d) set[d.toUpperCase()] = true; });
    return Object.keys(set).sort();
  } catch (e) { return []; }
}

// ── Searchable multi-select (checkbox list + search + select-all/clear) ──────
// `kind` distinguishes multiple selectors on the same form (op | dom).
function _multiSelectHtml(kind, label, options, selected, opts) {
  opts = opts || {};
  const sel = (selected || []).map(function(s){ return String(s || '').toUpperCase(); });
  const searchId = 'cb-ms-search-' + kind;
  const listId = 'cb-ms-list-' + kind;
  let body;
  if (!options.length) {
    body = '<div style="font-size:9px;color:#8b949e">' + _esc(opts.emptyText || 'No options yet — waiting for fleet data…') + '</div>';
  } else {
    body = '<div class="cb-ms-list" id="' + listId + '" style="max-height:120px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;padding:4px;border:1px solid rgba(139,148,158,0.2);border-radius:4px">' +
      options.map(function(op){
        const chk = sel.indexOf(op) !== -1 ? ' checked' : '';
        return '<label class="cb-ms-item" data-value="' + _attr(op) + '" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" class="cb-ms-' + kind + '" value="' + _attr(op) + '"' + chk + ' style="margin:0"/>' + _esc(op) +
          '</label>';
      }).join('') + '</div>';
  }
  return '<div class="cb-ms" data-kind="' + kind + '">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 3px">' +
      '<span style="font-size:9px;color:#8b949e">' + _esc(label) + '</span>' +
      (options.length ? '<span style="font-size:9px">' +
        '<a href="#" class="cb-ms-all" data-kind="' + kind + '" style="color:#58a6ff;text-decoration:none">all</a> · ' +
        '<a href="#" class="cb-ms-none" data-kind="' + kind + '" style="color:#8b949e;text-decoration:none">clear</a></span>' : '') +
    '</div>' +
    (options.length ? '<input class="cb-input cb-ms-search" id="' + searchId + '" data-kind="' + kind + '" placeholder="Search…" autocomplete="off" style="margin-bottom:4px" />' : '') +
    body +
  '</div>';
}

// Fixed-vocabulary checkbox grid (data categories / request types).
function _checkGridHtml(cls, label, options, selected) {
  const sel = (selected || []);
  return '<div style="font-size:9px;color:#8b949e;margin:6px 0 3px">' + _esc(label) + '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px">' + options.map(function(o){
      const chk = sel.indexOf(o.value) !== -1 ? ' checked' : '';
      return '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
        '<input type="checkbox" class="' + cls + '" value="' + _attr(o.value) + '"' + chk + ' style="margin:0"/>' + _esc(o.label) +
        '</label>';
    }).join('') + '</div>';
}

// ── The full permission editor block (shared by add + edit) ──────────────────
// `p` prefix keys every control id so the add form and an inline edit form can
// coexist. `c` is the current contact (or {} for a new one).
function _permissionEditorHtml(p, c) {
  c = c || {};
  const identity = c.identityType || 'unknown';
  const enabled = c.enabled !== false;
  const preset = _presetFor(identity);
  const cats = Array.isArray(c.allowedDataCategories) ? c.allowedDataCategories : preset.allowedDataCategories;
  const reqs = Array.isArray(c.permittedRequestTypes) ? c.permittedRequestTypes : preset.permittedRequestTypes;
  const lifecycle = LIFECYCLE_PERMS.some(l => l.value === c.lifecyclePermission) ? c.lifecyclePermission : 'not_allowed';
  const commPrefs = (c.communicationPreferences && typeof c.communicationPreferences === 'object' && !Array.isArray(c.communicationPreferences)) ? c.communicationPreferences : {};

  const identityOpts = IDENTITY_TYPES.map(function(t){
    return '<option value="' + _attr(t.value) + '"' + (t.value === identity ? ' selected' : '') + '>' + _esc(t.label) + '</option>';
  }).join('');

  const lifecycleRadios = LIFECYCLE_PERMS.map(function(l){
    return '<label style="display:flex;align-items:flex-start;gap:6px;font-size:11px;cursor:pointer;margin:2px 0">' +
      '<input type="radio" name="' + p + '-lifecycle" class="' + p + '-lifecycle" value="' + _attr(l.value) + '"' + (l.value === lifecycle ? ' checked' : '') + ' style="margin:2px 0 0"/>' +
      '<span><strong>' + _esc(l.label) + '</strong><br/><span style="color:#8b949e;font-size:9px">' + _esc(l.hint) + '</span></span>' +
    '</label>';
  }).join('');

  return '' +
    '<div class="cb-perm" data-prefix="' + p + '" data-identity="' + _attr(identity) + '">' +
      '<div style="font-size:9px;color:#8b949e;margin:6px 0 3px">Identity</div>' +
      '<select class="cb-input ' + p + '-identity" id="' + p + '-identity">' + identityOpts + '</select>' +

      '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin:8px 0 2px">' +
        '<input type="checkbox" class="' + p + '-enabled" id="' + p + '-enabled"' + (enabled ? ' checked' : '') + ' style="margin:0"/>' +
        'Enabled (unchecked = disabled, revokes ALL FAS access)' +
      '</label>' +

      // Carrier / SCAC scope.
      _multiSelectHtml(p + '-op', 'Carrier / SCAC scope', _fleetOperators(), c.operators || [], { emptyText: 'No operators yet — waiting for fleet data…' }) +
      // Domicile scope.
      _multiSelectHtml(p + '-dom', 'Domicile scope', _fleetDomiciles(), c.domiciles || [], { emptyText: 'No domiciles yet — waiting for fleet data…' }) +

      '<div class="cb-scope-warn ' + p + '-scope-warn" style="display:none;font-size:9px;color:#f0883e;background:rgba(240,136,62,0.08);border:1px solid rgba(240,136,62,0.3);border-radius:4px;padding:5px 7px;margin-top:6px"></div>' +

      _checkGridHtml(p + '-cat', 'Data categories this contact may see', DATA_CATS, cats) +
      _checkGridHtml(p + '-req', 'Request types this contact may make', REQ_TYPES, reqs) +

      '<div style="font-size:9px;color:#8b949e;margin:8px 0 3px">Lifecycle permission</div>' +
      '<div class="' + p + '-lifecycle-group">' + lifecycleRadios + '</div>' +

      '<div style="font-size:9px;color:#8b949e;margin:8px 0 3px">Communication preferences</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px">' +
        '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" class="' + p + '-comm-slack" ' + (commPrefs.slack !== false ? 'checked' : '') + ' style="margin:0"/>Slack</label>' +
        '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" class="' + p + '-comm-email" ' + (commPrefs.email ? 'checked' : '') + ' style="margin:0"/>Email</label>' +
      '</div>' +

      '<div style="font-size:9px;color:#8b949e;margin:10px 0 3px">Summary preview</div>' +
      '<div class="cb-perm-summary ' + p + '-summary" style="font-size:11px;color:#c9d1d9;background:rgba(88,166,255,0.06);border:1px solid rgba(88,166,255,0.2);border-radius:4px;padding:6px 8px;line-height:1.4"></div>' +
    '</div>';
}

// Read the editor block back into a contact patch object.
function _readPermissionEditor(root, p) {
  const q = (sel) => root.querySelector(sel);
  const checkedVals = (cls) => Array.from(root.querySelectorAll('.' + cls)).filter(b => b.checked).map(b => b.value);
  const identityEl = q('.' + p + '-identity');
  const identity = identityEl ? identityEl.value : 'unknown';
  const lifeEl = root.querySelector('.' + p + '-lifecycle:checked');
  return {
    identityType: identity,
    enabled: !!(q('.' + p + '-enabled') && q('.' + p + '-enabled').checked),
    operators: checkedVals(p + '-op'),
    domiciles: checkedVals(p + '-dom'),
    allowedDataCategories: checkedVals(p + '-cat'),
    permittedRequestTypes: checkedVals(p + '-req'),
    lifecyclePermission: lifeEl ? lifeEl.value : 'not_allowed',
    communicationPreferences: {
      slack: !!(q('.' + p + '-comm-slack') && q('.' + p + '-comm-slack').checked),
      email: !!(q('.' + p + '-comm-email') && q('.' + p + '-comm-email').checked),
    },
  };
}

// Plain-language summary — MIRRORS sender-profiles.js permissionSummary().
// Empty external scope = NO fleet units (never full fleet).
function _permissionSummaryText(v) {
  if (v.enabled === false) return 'Disabled — no FAS access.';
  const internal = v.identityType === 'internal' || v.identityType === 'manager';
  let scope;
  if (internal) {
    scope = 'all fleet units';
  } else {
    const parts = [];
    if (v.operators && v.operators.length) parts.push(v.operators.join('/') + ' units');
    if (v.domiciles && v.domiciles.length) parts.push('units at ' + v.domiciles.join('/'));
    scope = parts.length ? parts.join(' and ') : 'NO fleet-scoped units (no operator/domicile scope set)';
  }
  const cats = (v.allowedDataCategories || []);
  const canView = cats.length ? ('can view ' + cats.map(x => x.replace(/_/g, ' ')).join(', ')) : 'cannot view fleet data';
  const cannot = [];
  const reqs = v.permittedRequestTypes || [];
  if (reqs.indexOf('lifecycle_change') === -1 || v.lifecyclePermission === 'not_allowed') cannot.push('request lifecycle changes');
  if (reqs.indexOf('create_wr') === -1) cannot.push('create work requests');
  let life = '';
  if (v.lifecyclePermission === 'trusted_autonomous') life = ' Trusted for autonomous lifecycle actions.';
  else if (v.lifecyclePermission === 'may_request') life = ' May request lifecycle changes (needs approval).';
  return 'Can ' + canView + ' for ' + scope + '.' +
    (cannot.length ? ' Cannot ' + cannot.join(' or ') + '.' : '') + life;
}

// Refresh the live summary + no-scope warning for one editor block.
function _refreshEditorFeedback(root, p) {
  const v = _readPermissionEditor(root, p);
  const summaryEl = root.querySelector('.' + p + '-summary');
  if (summaryEl) summaryEl.textContent = _permissionSummaryText(v);
  const warnEl = root.querySelector('.' + p + '-scope-warn');
  if (warnEl) {
    const external = _isExternalIdentity(v.identityType);
    const noScope = !(v.operators && v.operators.length) && !(v.domiciles && v.domiciles.length);
    if (v.enabled !== false && external && noScope) {
      warnEl.textContent = '⚠ No carrier or domicile scope set. An empty scope means this external contact gets NO fleet data — it does NOT mean full-fleet access.';
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// Apply the identity preset to an editor block's category/request checkboxes,
// AFTER confirming (so a manual selection is never silently overwritten).
function _applyPresetToEditor(root, p, identity) {
  const preset = _presetFor(identity);
  root.querySelectorAll('.' + p + '-cat').forEach(b => { b.checked = preset.allowedDataCategories.indexOf(b.value) !== -1; });
  root.querySelectorAll('.' + p + '-req').forEach(b => { b.checked = preset.permittedRequestTypes.indexOf(b.value) !== -1; });
  _refreshEditorFeedback(root, p);
}

// ── Vendor helpers (unchanged) ───────────────────────────────────────────────
function _parsePrefOverrides(raw) {
  const out = {};
  String(raw || '').split(',').forEach(pair => {
    const [site, rank] = pair.split(':').map(s => (s || '').trim());
    const n = parseInt(rank, 10);
    if (site && Number.isFinite(n) && n > 0) out[site.toUpperCase()] = n;
  });
  return Object.keys(out).length ? out : null;
}

function _vendorMakesLabel(c) {
  const makes = Array.isArray(c.makes) && c.makes.length ? c.makes : (c.make ? [c.make] : []);
  return makes.length ? '• ' + _esc(makes.join(', ')) : '';
}

function _prefFor(c, site) {
  const overrides = c.preferenceByDomicile || {};
  if (site && overrides[site] != null) return overrides[site];
  return c.preference != null ? c.preference : null;
}

function _prefBadgeHtml(c) {
  const sites = Array.isArray(c.domiciles) ? c.domiciles : [];
  const overrides = c.preferenceByDomicile || {};
  const hasOverride = sites.some(s => overrides[s] != null && overrides[s] !== c.preference);
  if (!hasOverride) {
    return c.preference ? '<span class="cb-pref-badge">Pref #' + _esc(c.preference) + '</span>' : '';
  }
  return sites.map(s => {
    const pr = _prefFor(c, s);
    return pr ? '<span class="cb-pref-badge">' + _esc(s) + ': #' + _esc(pr) + '</span>' : '';
  }).join(' ');
}

// Short permission badge for a Slack contact card.
function _slackScopeBadge(c) {
  if (c.enabled === false) return '<div class="cb-card-meta" style="color:#f85149">⛔ Disabled — no FAS access</div>';
  const identity = c.identityType || 'unknown';
  if (identity === 'internal' || identity === 'manager') return '<div class="cb-card-meta" style="color:#3fb950">🔓 Internal — all fleet</div>';
  const parts = [];
  if (Array.isArray(c.operators) && c.operators.length) parts.push(c.operators.join(', '));
  if (Array.isArray(c.domiciles) && c.domiciles.length) parts.push('@' + c.domiciles.join(', '));
  if (parts.length) return '<div class="cb-card-meta" style="color:#3fb950">🔒 ' + _esc(parts.join(' · ')) + '</div>';
  return '<div class="cb-card-meta" style="color:#f0883e">⚠ ' + _esc(identity) + ' — no scope (no fleet data)</div>';
}

async function _load() {
  if (!window.contacts) return;
  _contacts = await window.contacts.getAll();
  _render();
}

function _render() {
  if (!_el) return;
  const vendors = _contacts.filter(c => c.type === 'vendor');
  const slack = _contacts.filter(c => c.type === 'slack');

  const tabsHtml = `
    <div class="cb-tabs">
      <button class="cb-tab ${_tab === 'vendors' ? 'active' : ''}" data-tab="vendors">🏢 Vendors</button>
      <button class="cb-tab ${_tab === 'domiciles' ? 'active' : ''}" data-tab="domiciles">🏠 Domiciles</button>
      <button class="cb-tab ${_tab === 'slack' ? 'active' : ''}" data-tab="slack">💬 Slack</button>
    </div>`;

  let listHtml = '';
  if (_tab === 'vendors') {
    listHtml = vendors.length ? vendors.map((c, i) => `
      <div class="cb-card" data-idx="${i}" data-id="${c.id}">
        <div class="cb-card-top">
          <div class="cb-card-name">${_esc(c.name)} ${_prefBadgeHtml(c)}</div>
          <div class="cb-card-company">${_esc(c.company || '')} ${_vendorMakesLabel(c)}</div>
        </div>
        <div class="cb-card-addr">${_esc(c.street || '')}${c.city ? ', ' + _esc(c.city) : ''} ${_esc(c.state || '')} ${_esc(c.zip || '')}</div>
        ${c.domiciles && c.domiciles.length ? '<div class="cb-card-meta" style="color:#58a6ff;">📍 ' + c.domiciles.join(', ') + '</div>' : ''}
        ${c.phone ? '<div class="cb-card-meta">📞 ' + _esc(c.phone) + '</div>' : ''}
        ${c.email ? '<div class="cb-card-meta">📧 ' + _esc(c.email) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="use-address" data-id="${c.id}">📍 Use for Tow</button>
          ${c.email ? `<button class="cb-btn cb-btn--use" data-action="email-contact" data-id="${c.id}">📧 Email</button>` : ''}
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️ Edit</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '<div class="cb-empty">No vendors yet — add one below</div>';

    listHtml += `
      <div class="cb-add-form">
        <div class="cb-add-title">+ Add Vendor</div>
        <input class="cb-input" id="cb-v-name" placeholder="Vendor / Dealer name" />
        <input class="cb-input" id="cb-v-makes" placeholder="Makes this vendor services (VOLVO, KENWORTH, PETERBILT...)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">Comma-separated. Many dealers service multiple makes -- list all of them so Dealer WO can route to this vendor for any of them.</div>
        <input class="cb-input" id="cb-v-company" placeholder="Company name (Bergeys, Transedge...)" />
        <input class="cb-input" id="cb-v-domiciles" placeholder="Domiciles this vendor serves (ABE40, PHL40...)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">Comma-separated. Must match your managed domiciles in Settings.</div>
        <input class="cb-input" id="cb-v-preference" type="number" min="1" step="1" placeholder="Preference rank (1 = first choice, 2 = backup...) -- applies to every domicile above" />
        <input class="cb-input" id="cb-v-pref-overrides" placeholder="Override rank for specific domiciles, e.g. AVP40:1, ABE40:2 (optional)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">Preference applies to all domiciles listed above by default. Only use overrides if this vendor's rank actually differs by site. Dealer WO picks the lowest-ranked vendor for that domicile with fewer than 3 units already there.</div>
        <input class="cb-input" id="cb-v-street" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="cb-v-city" placeholder="City" style="flex:2" />
          <input class="cb-input" id="cb-v-state" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="cb-v-zip" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="cb-v-phone" placeholder="Phone" />
        <input class="cb-input" id="cb-v-email" placeholder="Email (for direct email from chat)" />
        <button class="cb-btn cb-btn--add" id="cb-add-vendor">Add Vendor</button>
      </div>`;
  } else if (_tab === 'domiciles') {
    const domiciles = _contacts.filter(c => c.type === 'domicile');

    listHtml = '<div class="cb-add-form" style="margin-bottom:8px;border-color:rgba(88,166,255,0.2);"><div class="cb-add-title">i️ Domiciles from Settings → Integrations</div><div style="font-size:9px;color:#8b949e;margin-bottom:6px;">Add addresses here so AI and Tow events can use them.</div></div>';

    listHtml += domiciles.length ? domiciles.map((c, i) => `
      <div class="cb-card" data-id="${c.id}">
        <div class="cb-card-top">
          <div class="cb-card-name">${_esc(c.name)}</div>
          <div class="cb-card-company">Home Yard</div>
        </div>
        <div class="cb-card-addr">${_esc(c.street || '')}${c.city ? ', ' + _esc(c.city) : ''} ${_esc(c.state || '')} ${_esc(c.zip || '')}</div>
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '';

    listHtml += `
      <div class="cb-add-form">
        <div class="cb-add-title">+ Add Domicile Address</div>
        <input class="cb-input" id="cb-d-name" placeholder="Site code (ABE40, PHL40, EWR45...)" />
        <input class="cb-input" id="cb-d-street" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="cb-d-city" placeholder="City" style="flex:2" />
          <input class="cb-input" id="cb-d-state" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="cb-d-zip" placeholder="ZIP" style="flex:1" />
        </div>
        <button class="cb-btn cb-btn--add" id="cb-add-domicile">Add Domicile</button>
      </div>`;
  } else {
    listHtml = slack.length ? slack.map((c, i) => `
      <div class="cb-card" data-id="${c.id}">
        <div class="cb-card-top">
          <div class="cb-card-name">${_esc(c.name)}</div>
          <div class="cb-card-company">${_esc(c.company || c.role || '')} · ${_esc((c.identityType || 'unknown'))}</div>
        </div>
        <div class="cb-card-meta">${_esc(c.slackId || '')} ${c.phone ? '• ' + _esc(c.phone) : ''}</div>
        ${_slackScopeBadge(c)}
        ${c.email ? '<div class="cb-card-meta">📧 ' + _esc(c.email) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="slack-msg" data-id="${c.id}">💬 Message</button>
          ${c.email ? `<button class="cb-btn cb-btn--use" data-action="email-contact" data-id="${c.id}">📧 Email</button>` : ''}
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️ Edit permissions</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '<div class="cb-empty">No Slack contacts yet — add one below</div>';

    listHtml += `
      <div class="cb-add-form" id="cb-slack-add-form">
        <div class="cb-add-title">+ Add Slack Contact</div>
        <input class="cb-input" id="cb-s-name" placeholder="Name (searches Slack as you type)" autocomplete="off" />
        <div class="cb-slack-results" id="cb-slack-results"></div>
        <div class="cb-slack-confirm" id="cb-slack-confirm" style="display:none"></div>
        <input class="cb-input" id="cb-s-slack" placeholder="@slack-handle (auto-filled from search)" />
        <input class="cb-input" id="cb-s-company" placeholder="Company / Team" />
        <input class="cb-input" id="cb-s-email" placeholder="Email (optional)" />
        <input class="cb-input" id="cb-s-phone" placeholder="Phone (optional)" />
        <div style="border-top:1px solid rgba(139,148,158,0.15);margin:8px 0 2px"></div>
        ${_permissionEditorHtml('cb-s', {})}
        <button class="cb-btn cb-btn--add" id="cb-add-slack">Add Contact</button>
      </div>`;
  }

  _el.querySelector('.cb-body').innerHTML = tabsHtml + '<div class="cb-list">' + listHtml + '</div>';

  // Initialize live summary/warning for the Slack add form's editor block.
  if (_tab === 'slack') {
    const form = document.getElementById('cb-slack-add-form');
    if (form) _refreshEditorFeedback(form, 'cb-s');
  }
}

// ── Slack live-search (add-contact form) ─────────────────────────────────────
async function _searchSlackContacts(query) {
  const resultsEl = document.getElementById('cb-slack-results');
  if (!resultsEl) return;
  if (!query || query.length < 2) { resultsEl.innerHTML = ''; return; }
  if (!window.slack) { resultsEl.innerHTML = ''; return; }
  resultsEl.innerHTML = '<div class="cb-slack-searching">Searching…</div>';
  try {
    const results = await window.slack.searchDirectory({ query, limit: 6 });
    const people = (results || []).filter(r => r.type === 'user');
    if (!people.length) { resultsEl.innerHTML = '<div class="cb-slack-searching">No matches</div>'; return; }
    resultsEl.innerHTML = people.map(p =>
      '<div class="cb-slack-result-item" data-id="' + _esc(p.id) + '" data-name="' + _esc(p.name) + '">' + _esc(p.name) + '</div>'
    ).join('');
  } catch (_) {
    resultsEl.innerHTML = ''; // Slack not connected — manual entry still works
  }
}

function _pickSlackPerson(id, name) {
  const nameEl = document.getElementById('cb-s-name');
  if (nameEl) nameEl.value = name;
  const resultsEl = document.getElementById('cb-slack-results');
  if (resultsEl) resultsEl.innerHTML = '';
  const confirmEl = document.getElementById('cb-slack-confirm');
  if (confirmEl) {
    confirmEl.innerHTML =
      '<span>✓ Found in Slack: <strong>' + _esc(name) + '</strong></span>' +
      '<button class="cb-slack-clear-btn" id="cb-slack-clear">×</button>';
    confirmEl.style.display = 'flex';
  }
  _pendingSlack = { slackId: id, name, channelId: null };
  if (window.slack) {
    window.slack.openConversation({ id, type: 'user' })
      .then(res => { if (_pendingSlack && _pendingSlack.slackId === id) _pendingSlack.channelId = res && res.channelId; })
      .catch(() => {});
  }
}

function _clearSlackPick() {
  _pendingSlack = null;
  const confirmEl = document.getElementById('cb-slack-confirm');
  if (confirmEl) { confirmEl.innerHTML = ''; confirmEl.style.display = 'none'; }
  const nameEl = document.getElementById('cb-s-name');
  if (nameEl) { nameEl.value = ''; nameEl.focus(); }
}

function _toggle() {
  _open = !_open;
  if (_el) _el.classList.toggle('open', _open);
  if (_open) _load();
}

async function _addVendor() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const prefRaw = parseInt(g('cb-v-preference'), 10);
  const makes = g('cb-v-makes').split(',').map(m => m.trim().toUpperCase()).filter(Boolean);
  const contact = {
    type: 'vendor',
    name: g('cb-v-name'), company: g('cb-v-company'),
    makes: makes,
    make: makes[0] || '',
    domiciles: g('cb-v-domiciles').split(',').map(d => d.trim().toUpperCase()).filter(Boolean),
    street: g('cb-v-street'), city: g('cb-v-city'), state: g('cb-v-state'), zip: g('cb-v-zip'),
    phone: g('cb-v-phone'), email: g('cb-v-email'),
    preference: Number.isFinite(prefRaw) && prefRaw > 0 ? prefRaw : null,
    preferenceByDomicile: _parsePrefOverrides(g('cb-v-pref-overrides'))
  };
  if (!contact.name) return;
  await window.contacts.add(contact);
  _load();
}

async function _addSlack() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const form = document.getElementById('cb-slack-add-form');
  const perms = form ? _readPermissionEditor(form, 'cb-s') : {};
  const contact = Object.assign({
    type: 'slack',
    name: g('cb-s-name'),
    slackId: (_pendingSlack && _pendingSlack.slackId) || g('cb-s-slack').replace(/^@/, '').trim(),
    channelId: (_pendingSlack && _pendingSlack.channelId) || null,
    company: g('cb-s-company'), email: g('cb-s-email'), phone: g('cb-s-phone'),
  }, perms);
  if (!contact.name) return;
  await window.contacts.add(contact);
  _pendingSlack = null;
  _load();
}

async function _addDomicile() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const contact = {
    type: 'domicile',
    name: g('cb-d-name'),
    street: g('cb-d-street'), city: g('cb-d-city'), state: g('cb-d-state'), zip: g('cb-d-zip')
  };
  if (!contact.name) return;
  await window.contacts.add(contact);
  _load();
}

async function _editContact(id) {
  const contact = _contacts.find(x => x.id === id);
  if (!contact) return;
  const card = _el.querySelector('[data-id="' + id + '"]');
  if (!card) return;

  if (contact.type === 'vendor') {
    card.innerHTML = `
      <div class="cb-add-form" style="margin:0;border:none;padding:0;">
        <input class="cb-input" id="edit-name" value="${_attr(contact.name)}" placeholder="Vendor / Dealer name" />
        <input class="cb-input" id="edit-makes" value="${_attr((Array.isArray(contact.makes) && contact.makes.length ? contact.makes : (contact.make ? [contact.make] : [])).join(', '))}" placeholder="Makes this vendor services (VOLVO, KENWORTH, PETERBILT...)" />
        <input class="cb-input" id="edit-company" value="${_attr(contact.company || '')}" placeholder="Company name" />
        <input class="cb-input" id="edit-domiciles" value="${_attr((contact.domiciles || []).join(', '))}" placeholder="Domiciles this vendor serves (ABE40, PHL40...)" />
        <input class="cb-input" id="edit-preference" type="number" min="1" step="1" value="${_attr(contact.preference || '')}" placeholder="Preference rank (1 = first choice) -- applies to all domiciles above" />
        <input class="cb-input" id="edit-pref-overrides" value="${_attr(Object.entries(contact.preferenceByDomicile || {}).map(([s, r]) => s + ':' + r).join(', '))}" placeholder="Override rank for specific domiciles, e.g. AVP40:1, ABE40:2 (optional)" />
        <input class="cb-input" id="edit-street" value="${_attr(contact.street || '')}" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="edit-city" value="${_attr(contact.city || '')}" placeholder="City" style="flex:2" />
          <input class="cb-input" id="edit-state" value="${_attr(contact.state || '')}" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="edit-zip" value="${_attr(contact.zip || '')}" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="edit-phone" value="${_attr(contact.phone || '')}" placeholder="Phone" />
        <input class="cb-input" id="edit-email" value="${_attr(contact.email || '')}" placeholder="Email" />
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="cb-btn cb-btn--add" id="edit-save">Save</button>
          <button class="cb-btn cb-btn--del" id="edit-cancel">Cancel</button>
        </div>
      </div>`;

    card.querySelector('#edit-save').addEventListener('click', async () => {
      const g = sel => (card.querySelector(sel) || {}).value || '';
      contact.name       = g('#edit-name').trim();
      const editMakes    = g('#edit-makes').split(',').map(m => m.trim().toUpperCase()).filter(Boolean);
      contact.makes      = editMakes;
      contact.make        = editMakes[0] || '';
      contact.company    = g('#edit-company').trim();
      contact.domiciles  = g('#edit-domiciles').split(',').map(d => d.trim().toUpperCase()).filter(Boolean);
      const prefRaw = parseInt(g('#edit-preference'), 10);
      contact.preference = Number.isFinite(prefRaw) && prefRaw > 0 ? prefRaw : null;
      contact.preferenceByDomicile = _parsePrefOverrides(g('#edit-pref-overrides'));
      contact.street = g('#edit-street').trim();
      contact.city   = g('#edit-city').trim();
      contact.state  = g('#edit-state').trim();
      contact.zip    = g('#edit-zip').trim();
      contact.phone  = g('#edit-phone').trim();
      contact.email  = g('#edit-email').trim();
      await window.contacts.update(contact);
      _load();
    });
    card.querySelector('#edit-cancel').addEventListener('click', () => _render());
    return;
  }

  // ── Slack contact: FULL permission editor ──────────────────────────────────
  card.innerHTML = `
    <div class="cb-add-form" id="edit-perm-form" style="margin:0;border:none;padding:0;">
      <input class="cb-input" id="edit-name" value="${_attr(contact.name || '')}" placeholder="Name" />
      <input class="cb-input" id="edit-slack" value="${_attr(contact.slackId || '')}" placeholder="Slack handle or ID" />
      <input class="cb-input" id="edit-company" value="${_attr(contact.company || '')}" placeholder="Company / Team" />
      <input class="cb-input" id="edit-email" value="${_attr(contact.email || '')}" placeholder="Email" />
      <input class="cb-input" id="edit-phone" value="${_attr(contact.phone || '')}" placeholder="Phone" />
      <div style="border-top:1px solid rgba(139,148,158,0.15);margin:8px 0 2px"></div>
      ${_permissionEditorHtml('edit', contact)}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button class="cb-btn cb-btn--add" id="edit-save">Save</button>
        <button class="cb-btn cb-btn--del" id="edit-cancel">Cancel</button>
      </div>
    </div>`;

  const form = card.querySelector('#edit-perm-form');
  _refreshEditorFeedback(form, 'edit');

  card.querySelector('#edit-save').addEventListener('click', async () => {
    const g = sel => (card.querySelector(sel) || {}).value || '';
    const perms = _readPermissionEditor(form, 'edit');
    Object.assign(contact, {
      name: g('#edit-name').trim(),
      slackId: g('#edit-slack').replace(/^@/, '').trim(),
      company: g('#edit-company').trim(),
      email: g('#edit-email').trim(),
      phone: g('#edit-phone').trim(),
    }, perms);
    await window.contacts.update(contact);
    _load();
  });
  card.querySelector('#edit-cancel').addEventListener('click', () => _render());
}

async function _delete(id) {
  await window.contacts.remove(id);
  _load();
}

function _useAddress(id) {
  const c = _contacts.find(x => x.id === id);
  if (!c) return;
  bus.emit('contacts:use-address', { street: c.street, city: c.city, state: c.state, zip: c.zip, name: c.name });
}

// ── Editor interaction: identity-preset confirm, multi-select search/all/clear,
//    and live summary/warning refresh. Delegated on the panel root. ──────────
function _editorRootFor(target) {
  return target.closest('#edit-perm-form') || target.closest('#cb-slack-add-form');
}
function _prefixFor(root) {
  if (!root) return null;
  return root.id === 'edit-perm-form' ? 'edit' : 'cb-s';
}

export function init() {
  if (window.electron && window.electron.on) {
    window.electron.on('contacts:updated', () => _load());
  }

  _el = document.createElement('div');
  _el.className = 'cb-panel';
  _el.innerHTML = `
    <div class="cb-header">
      <span class="cb-header-title">📇 Contact Book</span>
      <button class="cb-close" id="cb-close">✕</button>
    </div>
    <div class="cb-body"></div>
  `;
  document.body.appendChild(_el);

  _el.querySelector('#cb-close').addEventListener('click', _toggle);

  // Delegated click events.
  _el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { _tab = tab.dataset.tab; _render(); return; }

    // Multi-select select-all / clear links.
    const allLink = e.target.closest('.cb-ms-all');
    if (allLink) {
      e.preventDefault();
      const root = _editorRootFor(allLink);
      const kind = allLink.dataset.kind;
      if (root) {
        root.querySelectorAll('.' + kind).forEach(b => { if (b.closest('.cb-ms-item').style.display !== 'none') b.checked = true; });
        _refreshEditorFeedback(root, _prefixFor(root));
      }
      return;
    }
    const noneLink = e.target.closest('.cb-ms-none');
    if (noneLink) {
      e.preventDefault();
      const root = _editorRootFor(noneLink);
      const kind = noneLink.dataset.kind;
      if (root) {
        root.querySelectorAll('.' + kind).forEach(b => { b.checked = false; });
        _refreshEditorFeedback(root, _prefixFor(root));
      }
      return;
    }

    // Add buttons
    if (e.target.id === 'cb-add-vendor') { _addVendor(); return; }
    if (e.target.id === 'cb-add-slack') { _addSlack(); return; }
    if (e.target.id === 'cb-add-domicile') { _addDomicile(); return; }

    const btn = e.target.closest('[data-action]');
    if (btn) {
      if (btn.dataset.action === 'delete') _delete(btn.dataset.id);
      if (btn.dataset.action === 'edit') _editContact(btn.dataset.id);
      if (btn.dataset.action === 'use-address') _useAddress(btn.dataset.id);
      if (btn.dataset.action === 'email-contact') {
        bus.emit('contacts:quick-email', _contacts.find(x => x.id === btn.dataset.id));
        if (_open) _toggle();
        return;
      }
      if (btn.dataset.action === 'slack-msg') {
        bus.emit('slack:quick-compose', _contacts.find(x => x.id === btn.dataset.id));
        if (_open) _toggle();
        return;
      }
    }

    const resultItem = e.target.closest('.cb-slack-result-item');
    if (resultItem) { _pickSlackPerson(resultItem.dataset.id, resultItem.dataset.name); return; }
    if (e.target.id === 'cb-slack-clear') { _clearSlackPick(); return; }
  });

  bus.on('ui:contacts-toggle', _toggle);

  // Delegated change: identity-preset confirm + live summary refresh.
  _el.addEventListener('change', (e) => {
    const root = _editorRootFor(e.target);
    if (!root) return;
    const prefix = _prefixFor(root);

    // Identity changed -> offer to apply that identity's default permissions,
    // confirming first so a manual selection is never silently overwritten.
    if (e.target.classList.contains(prefix + '-identity')) {
      const identity = e.target.value;
      root.querySelector('.cb-perm').dataset.identity = identity;
      const ok = window.confirm('Apply the default data + request permissions for "' + identity + '"? This overwrites the current category/request selections. Scope, lifecycle and comms are left unchanged.');
      if (ok) _applyPresetToEditor(root, prefix, identity);
      else _refreshEditorFeedback(root, prefix); // still refresh warning/summary
      return;
    }
    // Any other permission control toggled -> refresh summary + warning.
    _refreshEditorFeedback(root, prefix);
  });

  // Delegated input: Slack live-search name field + multi-select search filter.
  _el.addEventListener('input', (e) => {
    if (e.target.id === 'cb-s-name') {
      if (_pendingSlack) _clearSlackPick();
      clearTimeout(_slackSearchTimer);
      _slackSearchTimer = setTimeout(() => _searchSlackContacts(e.target.value.trim()), 400);
      return;
    }
    if (e.target.classList.contains('cb-ms-search')) {
      const wrap = e.target.closest('.cb-ms');
      const q = (e.target.value || '').trim().toUpperCase();
      if (wrap) wrap.querySelectorAll('.cb-ms-item').forEach(item => {
        item.style.display = (!q || (item.dataset.value || '').indexOf(q) !== -1) ? '' : 'none';
      });
    }
  });
}

// Export for @ mention autocomplete
export async function searchContacts(query) {
  if (!window.contacts) return [];
  return window.contacts.search(query);
}
