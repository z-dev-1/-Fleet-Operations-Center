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
// Vendor filter state (Vendors tab). domicile: site code or '' (all);
// cng: show only CNG-accepting; make: make code or '' (all);
// maxMiles: cap distance from the selected domicile (0 = any). Only meaningful
// when a domicile is selected (mileage is per-site).
let _vfilter = { domicile: '', cng: false, make: '', maxMiles: 0, rg: false };
let _pasteOpen = false;      // paste-dealer box visibility
let _pastePreviews = null;   // array of parsed dealers from the paste box
let _pasteText = '';         // raw textarea content (preserved across re-renders)
let _pasteBusy = false;      // true while AI parse is in flight
let _pasteMode = '';         // 'ai' | 'local' — which parser produced the preview
let _slackSearchTimer = null; // debounce handle for live search
let _pendingSlack = null;     // { slackId, name, channelId? } resolved from search

const _esc  = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _attr = (s) => _esc(s).replace(/"/g, '&quot;');

// ── Permission model (2026-09 simplified) ───────────────────────────────────
// FOUR identities. Data categories + request types are always "all" under the
// hood (governed by SCOPE, not toggles), so the editor only exposes the things
// that actually matter: identity, SCAC/domicile scope, and the two sensitive
// 3-state capabilities (lifecycle change, create work request).
const IDENTITY_TYPES = [
  { value: 'internal', label: 'Internal (Amazon team)' },
  { value: 'carrier',  label: 'Carrier / SCAC partner' },
  { value: 'vendor',   label: 'Vendor / dealer (mechanic)' },
  { value: 'unknown',  label: 'Unknown / untriaged' },
];
const CAP_PERMS = [
  { value: 'not_allowed',        label: 'Not allowed', hint: 'Blocked even if an operator clicks Approve.' },
  { value: 'may_request',        label: 'May request (needs approval)', hint: 'Can request it; a human must approve.' },
  { value: 'trusted_autonomous', label: 'Trusted (autonomous)', hint: 'FAS may act without approval when all gates pass.' },
];
const ALL_SCOPE = '*';

// Vendors (mechanics) can never be trusted/autonomous for lifecycle or WR
// creation — they ask, you act.
const _isVendor = (id) => id === 'vendor';
// Only `unknown` defaults to all-scope; carrier/internal/vendor start empty and
// mean NO data until scoped.
const _defaultAllScope = (id) => id === 'unknown';

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

// ── Searchable multi-select (checkbox list + search + all/clear + All-'*') ───
// `kind` distinguishes multiple selectors on the same form (op | dom).
// An "All (every current + future)" checkbox maps to the '*' wildcard: when it
// is checked, the individual boxes are disabled and the stored value is ['*'].
function _multiSelectHtml(kind, label, options, selected, opts) {
  opts = opts || {};
  const sel = (selected || []).map(function(s){ return String(s || '').trim() === ALL_SCOPE ? ALL_SCOPE : String(s || '').toUpperCase(); });
  const allChecked = sel.indexOf(ALL_SCOPE) !== -1;
  const searchId = 'cb-ms-search-' + kind;
  const listId = 'cb-ms-list-' + kind;
  const allBox = '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;font-weight:600">' +
    '<input type="checkbox" class="cb-ms-all-flag cb-ms-all-' + kind + '" data-kind="' + kind + '"' + (allChecked ? ' checked' : '') + ' style="margin:0"/>' +
    'All (every ' + (kind === 'op' ? 'SCAC' : 'domicile') + ', incl. future)</label>';
  let body;
  if (!options.length) {
    body = '<div style="font-size:9px;color:#8b949e">' + _esc(opts.emptyText || 'No options yet — waiting for fleet data…') + '</div>';
  } else {
    body = '<div class="cb-ms-list" id="' + listId + '" style="max-height:110px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;padding:4px;border:1px solid rgba(139,148,158,0.2);border-radius:4px' + (allChecked ? ';opacity:0.4;pointer-events:none' : '') + '">' +
      options.map(function(op){
        const chk = (!allChecked && sel.indexOf(op) !== -1) ? ' checked' : '';
        return '<label class="cb-ms-item" data-value="' + _attr(op) + '" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
          '<input type="checkbox" class="cb-ms-' + kind + '" value="' + _attr(op) + '"' + chk + (allChecked ? ' disabled' : '') + ' style="margin:0"/>' + _esc(op) +
          '</label>';
      }).join('') + '</div>';
  }
  return '<div class="cb-ms" data-kind="' + kind + '">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0 3px">' +
      '<span style="font-size:9px;color:#8b949e">' + _esc(label) + '</span>' +
      (options.length ? '<span style="font-size:9px">' +
        '<a href="#" class="cb-ms-allsel" data-kind="' + kind + '" style="color:#58a6ff;text-decoration:none">select all</a> · ' +
        '<a href="#" class="cb-ms-none" data-kind="' + kind + '" style="color:#8b949e;text-decoration:none">clear</a></span>' : '') +
    '</div>' +
    '<div style="margin-bottom:4px">' + allBox + '</div>' +
    (options.length ? '<input class="cb-input cb-ms-search" id="' + searchId + '" data-kind="' + kind + '" placeholder="Search…" autocomplete="off" style="margin-bottom:4px"' + (allChecked ? ' disabled' : '') + ' />' : '') +
    body +
  '</div>';
}

// ── The full permission editor block (shared by add + edit) ──────────────────
// `p` prefix keys every control id so the add form and an inline edit form can
// coexist. `c` is the current contact (or {} for a new one).
function _permissionEditorHtml(p, c) {
  c = c || {};
  const identity = IDENTITY_TYPES.some(t => t.value === c.identityType) ? c.identityType : 'unknown';
  const enabled = c.enabled !== false;
  const isVendor = _isVendor(identity);
  const lifecycle = isVendor ? 'not_allowed' : (CAP_PERMS.some(l => l.value === c.lifecyclePermission) ? c.lifecyclePermission : 'not_allowed');
  const createWr = isVendor ? 'not_allowed' : (CAP_PERMS.some(l => l.value === c.createWrPermission) ? c.createWrPermission : 'not_allowed');
  const commPrefs = (c.communicationPreferences && typeof c.communicationPreferences === 'object' && !Array.isArray(c.communicationPreferences)) ? c.communicationPreferences : {};

  // Scope: if the contact has no explicit scope, apply the identity default
  // (unknown -> all '*', others -> empty).
  let ops = Array.isArray(c.operators) ? c.operators : null;
  let doms = Array.isArray(c.domiciles) ? c.domiciles : null;
  if (ops == null && doms == null && _defaultAllScope(identity)) { ops = [ALL_SCOPE]; doms = [ALL_SCOPE]; }
  ops = ops || []; doms = doms || [];

  const identityOpts = IDENTITY_TYPES.map(function(t){
    return '<option value="' + _attr(t.value) + '"' + (t.value === identity ? ' selected' : '') + '>' + _esc(t.label) + '</option>';
  }).join('');

  const capRadios = (field, current) => CAP_PERMS.map(function(l){
    const locked = isVendor ? ' disabled' : '';
    return '<label style="display:flex;align-items:flex-start;gap:6px;font-size:11px;cursor:pointer;margin:2px 0' + (isVendor ? ';opacity:0.5' : '') + '">' +
      '<input type="radio" name="' + p + '-' + field + '" class="' + p + '-' + field + '" value="' + _attr(l.value) + '"' + (l.value === current ? ' checked' : '') + locked + ' style="margin:2px 0 0"/>' +
      '<span><strong>' + _esc(l.label) + '</strong><br/><span style="color:#8b949e;font-size:9px">' + _esc(l.hint) + '</span></span>' +
    '</label>';
  }).join('');

  const vendorNote = isVendor
    ? '<div style="font-size:9px;color:#8b949e;margin:2px 0 0">Vendors (mechanics) can ask and receive updates, but lifecycle changes and work-request creation are always operator-only.</div>'
    : '';

  return '' +
    '<div class="cb-perm" data-prefix="' + p + '" data-identity="' + _attr(identity) + '">' +
      '<div style="font-size:9px;color:#8b949e;margin:6px 0 3px">Identity</div>' +
      '<select class="cb-input ' + p + '-identity" id="' + p + '-identity">' + identityOpts + '</select>' +

      '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;margin:8px 0 2px">' +
        '<input type="checkbox" class="' + p + '-enabled" id="' + p + '-enabled"' + (enabled ? ' checked' : '') + ' style="margin:0"/>' +
        'Enabled (unchecked = disabled, revokes ALL FAS access)' +
      '</label>' +

      '<div style="font-size:9px;color:#8b949e;margin:6px 0 2px">Who gets what data — by SCAC/operator and domicile (both can be multiple, or All):</div>' +
      // Carrier / SCAC scope.
      _multiSelectHtml(p + '-op', 'Carrier / SCAC scope', _fleetOperators(), ops, { emptyText: 'No operators yet — waiting for fleet data…' }) +
      // Domicile scope.
      _multiSelectHtml(p + '-dom', 'Domicile scope', _fleetDomiciles(), doms, { emptyText: 'No domiciles yet — waiting for fleet data…' }) +

      '<div class="cb-scope-warn ' + p + '-scope-warn" style="display:none;font-size:9px;color:#f0883e;background:rgba(240,136,62,0.08);border:1px solid rgba(240,136,62,0.3);border-radius:4px;padding:5px 7px;margin-top:6px"></div>' +

      '<div style="font-size:9px;color:#8b949e;margin:10px 0 3px">Lifecycle change permission</div>' +
      '<div class="' + p + '-lifecycle-group">' + capRadios('lifecycle', lifecycle) + '</div>' +

      '<div style="font-size:9px;color:#8b949e;margin:10px 0 3px">Create work request permission</div>' +
      '<div class="' + p + '-createwr-group">' + capRadios('createwr', createWr) + '</div>' +
      vendorNote +

      '<div style="font-size:9px;color:#8b949e;margin:10px 0 3px">Communication preferences</div>' +
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

// Read one multi-select back into a scope array, honoring the All ('*') flag.
function _readScope(root, kind) {
  const allFlag = root.querySelector('.cb-ms-all-' + kind);
  if (allFlag && allFlag.checked) return [ALL_SCOPE];
  return Array.from(root.querySelectorAll('.cb-ms-' + kind)).filter(b => b.checked).map(b => b.value);
}

// Read the editor block back into a contact patch object. Data categories +
// request types are ALWAYS all (governed by scope, not toggles).
function _readPermissionEditor(root, p) {
  const q = (sel) => root.querySelector(sel);
  const identityEl = q('.' + p + '-identity');
  const identity = identityEl ? identityEl.value : 'unknown';
  const isVendor = _isVendor(identity);
  const lifeEl = root.querySelector('.' + p + '-lifecycle:checked');
  const wrEl = root.querySelector('.' + p + '-createwr:checked');
  return {
    identityType: identity,
    enabled: !!(q('.' + p + '-enabled') && q('.' + p + '-enabled').checked),
    operators: _readScope(root, p + '-op'),
    domiciles: _readScope(root, p + '-dom'),
    // Always-all under the hood; the backend re-applies the preset too.
    allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'],
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'],
    lifecyclePermission: isVendor ? 'not_allowed' : (lifeEl ? lifeEl.value : 'not_allowed'),
    createWrPermission: isVendor ? 'not_allowed' : (wrEl ? wrEl.value : 'not_allowed'),
    communicationPreferences: {
      slack: !!(q('.' + p + '-comm-slack') && q('.' + p + '-comm-slack').checked),
      email: !!(q('.' + p + '-comm-email') && q('.' + p + '-comm-email').checked),
    },
  };
}

// Plain-language summary — MIRRORS sender-profiles.js permissionSummary().
// Empty scope = NO fleet units (never full fleet); '*' = all fleet.
function _permissionSummaryText(v) {
  if (v.enabled === false) return 'Disabled — no FAS access.';
  const ops = v.operators || []; const doms = v.domiciles || [];
  const allScope = ops.indexOf(ALL_SCOPE) !== -1 || doms.indexOf(ALL_SCOPE) !== -1;
  let scope;
  if (allScope) scope = 'all fleet units (all SCAC + all domiciles)';
  else {
    const parts = [];
    if (ops.length) parts.push(ops.join('/') + ' units');
    if (doms.length) parts.push('units at ' + doms.join('/'));
    scope = parts.length ? parts.join(' and ') : 'NO fleet-scoped units (no SCAC/domicile scope set)';
  }
  const lp = v.lifecyclePermission || 'not_allowed';
  const wp = v.createWrPermission || 'not_allowed';
  const cap = (label, val) => val === 'trusted_autonomous' ? (label + ': trusted (autonomous)')
    : val === 'may_request' ? (label + ': may request (approval)') : null;
  let out = 'Can view fleet data for ' + scope + '.';
  const canCaps = [cap('lifecycle changes', lp), cap('work requests', wp)].filter(Boolean);
  if (canCaps.length) out += ' ' + canCaps.join('; ') + '.';
  const cannot = [];
  if (lp === 'not_allowed') cannot.push('change lifecycle');
  if (wp === 'not_allowed') cannot.push('create work requests');
  if (cannot.length) out += ' Cannot ' + cannot.join(' or ') + '.';
  return out;
}

// Refresh the live summary + no-scope warning for one editor block.
function _refreshEditorFeedback(root, p) {
  const v = _readPermissionEditor(root, p);
  const summaryEl = root.querySelector('.' + p + '-summary');
  if (summaryEl) summaryEl.textContent = _permissionSummaryText(v);
  const warnEl = root.querySelector('.' + p + '-scope-warn');
  if (warnEl) {
    const noScope = !(v.operators && v.operators.length) && !(v.domiciles && v.domiciles.length);
    if (v.enabled !== false && noScope) {
      warnEl.textContent = '⚠ No SCAC or domicile scope set. An empty scope means this contact gets NO fleet data — it does NOT mean full-fleet access. Use the "All" box for full fleet.';
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// Apply the identity default to an editor block WITH confirm. Because data +
// requests are always all, the only preset effect is: set the vendor lock, and
// set default scope for unknown (all '*') vs others (leave scope as-is unless
// switching to unknown from empty).
function _applyPresetToEditor(root, p, identity) {
  // Re-render this editor block's capability + scope controls for the new
  // identity by rebuilding from a synthetic contact carrying the current scope.
  const cur = _readPermissionEditor(root, p);
  const synthetic = {
    identityType: identity,
    enabled: cur.enabled,
    operators: (identity === 'unknown' && !cur.operators.length && !cur.domiciles.length) ? [ALL_SCOPE] : cur.operators,
    domiciles: (identity === 'unknown' && !cur.operators.length && !cur.domiciles.length) ? [ALL_SCOPE] : cur.domiciles,
    lifecyclePermission: cur.lifecyclePermission,
    createWrPermission: cur.createWrPermission,
    communicationPreferences: cur.communicationPreferences,
  };
  const wrap = root.querySelector('.cb-perm');
  if (wrap) {
    // Replace only the inner permission block markup, preserving the outer form.
    const holder = document.createElement('div');
    holder.innerHTML = _permissionEditorHtml(p, synthetic);
    const fresh = holder.querySelector('.cb-perm');
    if (fresh) wrap.replaceWith(fresh);
  }
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

// Parse "SITE:miles, SITE:miles" into { SITE: number } (uppercased site). Mirrors
// _parsePrefOverrides but keeps decimals (mileage like 4.3).
function _parseMileage(raw) {
  const out = {};
  String(raw || '').split(',').forEach(pair => {
    const [site, mi] = pair.split(':').map(s => (s || '').trim());
    const n = parseFloat(mi);
    if (site && Number.isFinite(n) && n >= 0) out[site.toUpperCase()] = n;
  });
  return Object.keys(out).length ? out : null;
}

// Mileage-from-site badges, sorted nearest first.
function _mileageBadgeHtml(c) {
  const m = c.mileageByDomicile || {};
  const keys = Object.keys(m);
  if (!keys.length) return '';
  return keys.sort((a, b) => m[a] - m[b]).map(s =>
    '<span class="cb-pref-badge" style="background:rgba(63,185,80,0.12);color:#3fb950;">' + _esc(s) + ': ' + _esc(m[s]) + ' mi</span>'
  ).join(' ');
}

// Capability badges (CNG / Mobile) — the two routing-critical flags.
function _capBadgeHtml(c) {
  const out = [];
  if (c.cng) out.push('<span class="cb-pref-badge" style="background:rgba(88,166,255,0.15);color:#58a6ff;">CNG</span>');
  if (c.mobile) out.push('<span class="cb-pref-badge" style="background:rgba(240,136,62,0.15);color:#f0883e;">Mobile</span>');
  return out.join(' ');
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
  const ops = Array.isArray(c.operators) ? c.operators : [];
  const doms = Array.isArray(c.domiciles) ? c.domiciles : [];
  const identity = c.identityType || 'unknown';
  // Unknown with no explicit scope defaults to all-scope ('*').
  const allScope = ops.indexOf('*') !== -1 || doms.indexOf('*') !== -1 ||
    (identity === 'unknown' && !ops.length && !doms.length);
  if (allScope) return '<div class="cb-card-meta" style="color:#3fb950">🔓 All fleet (all SCAC + domiciles)</div>';
  const parts = [];
  if (ops.length) parts.push(ops.join(', '));
  if (doms.length) parts.push('@' + doms.join(', '));
  if (parts.length) return '<div class="cb-card-meta" style="color:#3fb950">🔒 ' + _esc(parts.join(' · ')) + '</div>';
  return '<div class="cb-card-meta" style="color:#f0883e">⚠ ' + _esc(identity) + ' — no scope (no fleet data)</div>';
}

// ── Vendor filtering (domicile + CNG + make) ────────────────────────────────
// All domiciles that appear on vendor cards, unioned with type:'domicile'
// contacts, so the filter never shows a site with zero dealers that isn't real.
function _allVendorDomiciles() {
  const set = {};
  _contacts.forEach(c => {
    if (c.type === 'vendor' && Array.isArray(c.domiciles)) c.domiciles.forEach(d => { const k = String(d || '').trim().toUpperCase(); if (k) set[k] = true; });
    if (c.type === 'vendor' && c.mileageByDomicile) Object.keys(c.mileageByDomicile).forEach(d => { const k = String(d || '').trim().toUpperCase(); if (k) set[k] = true; });
    if (c.type === 'domicile') { const k = String(c.name || '').trim().toUpperCase(); if (k) set[k] = true; }
  });
  return Object.keys(set).sort();
}
// All makes present on vendor cards, for the make dropdown.
function _allVendorMakes() {
  const set = {};
  _contacts.forEach(c => {
    if (c.type !== 'vendor') return;
    const makes = Array.isArray(c.makes) && c.makes.length ? c.makes : (c.make ? [c.make] : []);
    makes.forEach(m => { const k = String(m || '').trim().toUpperCase(); if (k) set[k] = true; });
  });
  return Object.keys(set).sort();
}
// Apply the active filters to a vendor list; when a domicile is selected, sort
// nearest-first by that site's mileage (vendors with no mileage sink to the end).
function _applyVendorFilters(vendors) {
  const dom = _vfilter.domicile;
  const make = _vfilter.make;
  let out = vendors.filter(c => {
    if (dom) {
      const doms = (c.domiciles || []).map(d => String(d).toUpperCase());
      const hasMi = c.mileageByDomicile && c.mileageByDomicile[dom] != null;
      if (doms.indexOf(dom) === -1 && !hasMi) return false;
    }
    if (_vfilter.cng && !c.cng) return false;
    if (_vfilter.rg && !/relay\s*garage|reach/i.test(String(c.affiliation || ''))) return false;
    if (make) {
      const makes = (Array.isArray(c.makes) && c.makes.length ? c.makes : (c.make ? [c.make] : [])).map(m => String(m).toUpperCase());
      if (makes.indexOf(make) === -1) return false;
    }
    // Mileage cap only applies when a domicile is selected (mileage is per-site).
    if (dom && _vfilter.maxMiles > 0) {
      const mi = c.mileageByDomicile && c.mileageByDomicile[dom];
      if (mi == null || mi > _vfilter.maxMiles) return false;
    }
    return true;
  });
  if (dom) {
    const miOf = c => (c.mileageByDomicile && c.mileageByDomicile[dom] != null) ? c.mileageByDomicile[dom] : Infinity;
    out = out.slice().sort((a, b) => miOf(a) - miOf(b));
  }
  return out;
}
// Filter bar markup for the Vendors tab.
function _vendorFilterBarHtml(total, shown) {
  const doms = _allVendorDomiciles();
  const makes = _allVendorMakes();
  const chip = (label, active, data) =>
    '<button class="cb-chip' + (active ? ' active' : '') + '" ' + data + '>' + _esc(label) + '</button>';
  const domChips = ['<span class="cb-filter-label">Domicile</span>',
    chip('All', !_vfilter.domicile, 'data-vf="dom" data-val=""')]
    .concat(doms.map(d => chip(d, _vfilter.domicile === d, 'data-vf="dom" data-val="' + _attr(d) + '"')))
    .join('');
  const cngChip = '<button class="cb-chip cb-chip--cng' + (_vfilter.cng ? ' active' : '') + '" data-vf="cng">CNG only</button>';
  const rgChip = '<button class="cb-chip cb-chip--cng' + (_vfilter.rg ? ' active' : '') + '" data-vf="rg" title="Integrated via Relay Garage/Reach">RG integrated</button>';
  const makeOpts = ['<option value="">All makes</option>']
    .concat(makes.map(m => '<option value="' + _attr(m) + '"' + (_vfilter.make === m ? ' selected' : '') + '>' + _esc(m) + '</option>'))
    .join('');
  const makeSel = '<span class="cb-filter-label">Make</span><select class="cb-filter-make" data-vf="make">' + makeOpts + '</select>';
  // Mileage cap — only meaningful with a domicile selected (disabled otherwise).
  const miChoices = [0, 10, 25, 50, 100];
  const miOpts = miChoices.map(m =>
    '<option value="' + m + '"' + (_vfilter.maxMiles === m ? ' selected' : '') + '>' + (m === 0 ? 'Any distance' : '≤ ' + m + ' mi') + '</option>'
  ).join('');
  const miSel = '<span class="cb-filter-label">Within</span><select class="cb-filter-make" data-vf="miles"' +
    (_vfilter.domicile ? '' : ' disabled title="Pick a domicile first"') + '>' + miOpts + '</select>';
  const pasteBtn = '<button class="cb-chip' + (_pasteOpen ? ' active' : '') + '" data-vf="paste" title="Paste a dealer block to add/merge">📋 Paste dealer</button>';
  const count = '<span class="cb-filter-count">' + shown + ' of ' + total + ' vendors</span>';
  return '<div class="cb-filters">' + domChips + '<span class="cb-filter-sep"></span>' + cngChip + rgChip +
    '<span class="cb-filter-sep"></span>' + makeSel +
    '<span class="cb-filter-sep"></span>' + miSel +
    '<span class="cb-filter-sep"></span>' + pasteBtn + count + '</div>';
}

// ── Paste-to-create: parse a dealer-locator block into a vendor record ───────
// Handles the emoji-formatted block the user pastes from the dealer-locator
// tool. Everything is best-effort; name is the only hard requirement. Lines:
//   first non-empty line           -> name (⭐ and trailing "Unassigned" stripped)
//   🔧 <makes>                      -> makes (CSV / slash-separated); "Mobile Service Available" -> mobile
//   🔗 Affiliation/Integration: X   -> affiliation
//   <SITE> Pref #<n> / Specialist   -> domicile + preference
//   📍 <addr>                       -> street/city/state/zip (first 📍 line)
//   🕐 <hours>                      -> hours
//   🏷️ <tags>                       -> cng/mobile flags (+ raw tags appended to notes)
//   📞 ... | ✉️ email | 👤 person    -> phone / email / contactPerson
//   📍 <n> miles                    -> mileage from the Pref-tag domicile
//   free text line                  -> notes
function _parseDealerBlock(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  const rec = { type: 'vendor', makes: [], domiciles: [], mileageByDomicile: {}, prefTags: [] };
  const noteParts = [];
  let domicile = '', pref = null, miles = null;

  const stripEmoji = s => s.replace(/[\u2600-\u27BF\uE000-\uF8FF\uD83C-\uDBFF\uDC00-\uDFFF\u2B50\uFE0F\u2705\u26D4\u26A0]/g, '').trim();

  // Name = first line, minus star ratings / trailing status words.
  rec.name = stripEmoji(lines[0]).replace(/\s*(Unassigned|Do Not Use)\s*$/i, '').trim();

  const addMakes = str => String(str || '').split(/[,/]/).map(s => s.trim().toUpperCase()).filter(Boolean).forEach(m => { if (rec.makes.indexOf(m) === -1) rec.makes.push(m); });

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const body = stripEmoji(line);

    if (/^🔧/.test(line)) {
      if (/mobile service available/i.test(body)) { rec.mobile = true; continue; }
      addMakes(body); continue;
    }
    if (/^🔗/.test(line)) {
      rec.affiliation = body.replace(/^(Affiliation|Integration)\s*:\s*/i, '').replace(/\s*[•·]\s*/g, ' / ').trim();
      continue;
    }
    if (/^📍/.test(line)) {
      const m = body.match(/^([\d.]+)\s*miles?$/i);
      if (m) { miles = parseFloat(m[1]); continue; }
      if (!rec.street) {
        // Address: "<street>, <city>, <ST> <zip>, <city>, <ST>" — take first street,
        // and a ST+ZIP if present anywhere.
        const parts = body.split(',').map(s => s.trim()).filter(Boolean);
        rec.street = parts[0] || '';
        const zipm = body.match(/\b([A-Z]{2})\s+(\d{5})\b/);
        if (zipm) { rec.state = zipm[1]; rec.zip = zipm[2]; }
        // City = the part just before the ST+ZIP token when resolvable.
        if (parts.length >= 2) { const cand = parts[1]; if (cand && !/^\d/.test(cand)) rec.city = cand.replace(/\s+[A-Z]{2}\s+\d{5}.*$/, '').trim(); }
      }
      continue;
    }
    if (/^🕐/.test(line)) { rec.hours = body; continue; }
    if (/^🏷️?/.test(line) || /^🏷/.test(line)) {
      const tags = body.toLowerCase();
      if (/\bcng\b/.test(tags)) rec.cng = true;
      if (/\bmobile\b/.test(tags)) rec.mobile = true;
      noteParts.push('Tags: ' + body);
      continue;
    }
    if (/^📞/.test(line) || /✉️|👤/.test(line)) {
      // "📞 phone | ✉️ email | 👤 person"
      const segs = line.split('|').map(s => s.trim());
      segs.forEach(seg => {
        const sb = stripEmoji(seg);
        if (/✉️/.test(seg) || /@/.test(sb)) { if (!rec.email) rec.email = sb; }
        else if (/👤/.test(seg)) { if (!rec.contactPerson) rec.contactPerson = sb; }
        else if (sb && !/^N\/?A$/i.test(sb)) { if (!rec.phone) rec.phone = sb; }
      });
      continue;
    }
    if (/^🚛/.test(line) || /^✅/.test(line)) { continue; } // units-assigned / integration confirmation — ignore
    // Pref tag: "ABE40 Pref #1" or "EWR5 Specialist" / "CDW5 Specialist"
    const prefm = body.match(/^([A-Z0-9]{3,8})\s+Pref\s+#?(\d+)/i);
    const specm = body.match(/^([A-Z0-9]{3,8})\s+Specialist$/i);
    if (prefm) { domicile = prefm[1].toUpperCase(); pref = parseInt(prefm[2], 10); rec.prefTags.push(body); continue; }
    if (specm) { domicile = specm[1].toUpperCase(); rec.prefTags.push(body); continue; }
    // Otherwise free-text note.
    if (body && body.length > 1) noteParts.push(body);
  }

  if (domicile) {
    rec.domiciles = [domicile];
    if (pref != null) { rec.preference = pref; rec.preferenceByDomicile = { [domicile]: pref }; }
    if (miles != null) rec.mileageByDomicile = { [domicile]: miles };
  } else if (miles != null) {
    // No pref tag but a distance — keep it unkeyed is useless; drop silently.
  }
  rec.make = rec.makes[0] || '';
  if (noteParts.length) rec.notes = noteParts.join(' | ').slice(0, 500);
  rec.company = rec.name;
  rec._doNotUse = /do not use/i.test(raw);
  return rec;
}

// One preview card for a parsed dealer. idx = position in _pastePreviews, used
// to wire the per-dealer domicile override dropdown back on change.
function _pastePreviewCard(p, idx) {
  if (p._doNotUse) {
    return '<div class="cb-paste-preview" style="color:#f85149">⛔ "' + _esc(p.name) + '" is marked "Do Not Use" — will be SKIPPED.</div>';
  }
  const dom = (p.domiciles || [])[0] || '';
  const mi = dom && p.mileageByDomicile ? p.mileageByDomicile[dom] : null;
  // Prefer the AI's duplicate judgment; fall back to literal name match.
  const litMatch = _contacts.find(c => c.type === 'vendor' && (c.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase());
  const dupName = p.aiDuplicateOf || (litMatch ? litMatch.name : null);
  const flags = [p.cng ? 'CNG' : '', p.mobile ? 'Mobile' : '', /relay\s*garage|reach/i.test(p.affiliation || '') ? 'RG' : ''].filter(Boolean).join(' · ');
  // Domicile line: show assignment + estimated marker + an override dropdown.
  const sites = _allVendorDomiciles();
  const domOpts = ['<option value="">— no site —</option>']
    .concat(sites.map(s => '<option value="' + _attr(s) + '"' + (s === dom ? ' selected' : '') + '>' + _esc(s) + '</option>'))
    .join('');
  const milesTxt = mi != null ? (mi + ' mi' + (p._milesEstimated ? ' (est.)' : '')) : '';
  const assignNote = p._assignedByAI ? ' <span style="color:#d29922">· AI-assigned nearest</span>' : '';
  return '<div class="cb-paste-preview">' +
    (dupName ? '<div style="color:#58a6ff;font-size:10px">↻ MERGE onto "' + _esc(dupName) + '"' + (p.aiDuplicateOf ? ' <span style="color:#8b949e">(AI matched)</span>' : '') + '</div>'
             : '<div style="color:#3fb950;font-size:10px">+ NEW</div>') +
    '<div style="font-size:11px;font-weight:600;color:var(--txt)">' + _esc(p.name) + '</div>' +
    '<div style="font-size:10px;color:#8b949e">' +
      _esc((p.makes || []).join(', ') || '—') +
      (milesTxt ? ' · ' + _esc(milesTxt) : '') +
      (flags ? ' · ' + _esc(flags) : '') +
    '</div>' +
    '<div style="font-size:9px;color:var(--txt2)">' + _esc([p.street, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—') + '</div>' +
    '<div style="font-size:9px;color:#8b949e;margin-top:3px;display:flex;align-items:center;gap:4px">Site:' +
      '<select class="cb-filter-make" data-paste-dom="' + idx + '">' + domOpts + '</select>' + assignNote +
    '</div>' +
  '</div>';
}

// Paste-dealer box markup (shown when _pasteOpen). Supports one OR many dealers.
function _pasteBoxHtml() {
  if (!_pasteOpen) return '';
  let preview = '';
  if (_pasteBusy) {
    preview = '<div class="cb-paste-preview" style="color:#58a6ff">🤖 AI is reading the paste…</div>';
  }
  const list = _pastePreviews;
  if (!_pasteBusy && list && list.length) {
    const addable = list.filter(p => !p._doNotUse).length;
    const skipped = list.length - addable;
    const modeNote = _pasteMode === 'ai' ? '🤖 AI-parsed' : '📝 parsed locally (AI offline)';
    preview =
      '<div style="font-size:10px;color:#8b949e;margin:8px 0 4px">' + modeNote + ' — ' + list.length + ' dealer' + (list.length === 1 ? '' : 's') +
        (skipped ? ' (' + skipped + ' Do-Not-Use skipped)' : '') + ':</div>' +
      '<div class="cb-paste-list">' + list.map((p, i) => _pastePreviewCard(p, i)).join('') + '</div>' +
      (addable ? '<div style="display:flex;gap:6px;margin-top:8px"><button class="cb-btn cb-btn--add" id="cb-paste-save">Add / Merge ' + addable + '</button></div>' : '');
  }
  return '<div class="cb-paste-box">' +
    '<div style="font-size:10px;color:#8b949e;margin-bottom:4px">Paste one OR many dealer blocks (name, 🔧 makes, 🔗 affiliation, SITE Pref #, 📍 address, 🕐 hours, 🏷️ tags, 📞 phone, 📍 miles). Auto-parses and adds or merges. "Do Not Use" are skipped.</div>' +
    '<textarea class="cb-input" id="cb-paste-text" rows="6" placeholder="Paste one or more dealer blocks here…" style="font-family:monospace;font-size:11px;width:100%">' + _esc(_pasteText) + '</textarea>' +
    '<div style="display:flex;gap:6px;margin-top:6px"><button class="cb-btn cb-btn--use" id="cb-paste-parse">Preview</button>' +
    '<button class="cb-btn cb-btn--del" id="cb-paste-close">Close</button></div>' +
    preview +
  '</div>';
}

// Split a multi-dealer paste into individual blocks and parse each. The reliable
// per-dealer marker is the "🚛 N units assigned" line that follows every dealer
// name. A new block begins at the NAME line that precedes each 🚛 line (i.e. the
// first line after the previous dealer's content). We also drop a leading
// "📍 SITE — address" header line and a "🏢 Primary on-site vendor" line if the
// user pasted the whole list including its header. "Beyond 50 mi" separators are
// ignored.
function _parseDealerBlocks(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const lines = raw.split('\n');
  // Find indices of the 🚛 marker lines.
  const truckIdx = [];
  lines.forEach((l, i) => { if (/^\s*🚛/.test(l)) truckIdx.push(i); });
  if (truckIdx.length <= 1) {
    const one = _parseDealerBlock(raw);
    return one ? [one] : [];
  }
  // Each dealer block = from the line AFTER the previous dealer's last content
  // up to (but not including) the next dealer's name. Practically: the name sits
  // 1+ lines above each 🚛; a block runs from the name line to just before the
  // next block's name line. We compute block boundaries as the name line =
  // the first non-empty, non-"Beyond"/non-header line scanning back from 🚛.
  const isNoise = s => !s.trim() || /^\s*(Beyond\s+\d+\s*mi|📍\s*[A-Z0-9]{3,8}\s*—|🏢)/i.test(s);
  const nameLineFor = (ti) => {
    let j = ti - 1;
    while (j >= 0 && isNoise(lines[j])) j--;
    return j; // index of the name line for the dealer at truck-line ti
  };
  const nameIdx = truckIdx.map(nameLineFor);
  const blocks = [];
  for (let b = 0; b < nameIdx.length; b++) {
    const start = nameIdx[b];
    const end = (b + 1 < nameIdx.length) ? nameIdx[b + 1] : lines.length;
    const chunk = lines.slice(start, end).join('\n');
    const rec = _parseDealerBlock(chunk);
    if (rec && rec.name) blocks.push(rec);
  }
  return blocks;
}

// ── AI-powered paste parse + dedupe ─────────────────────────────────────────
// Sends the pasted text + a compact existing-vendor list to fleet-brain, asking
// it to (a) extract structured dealer records and (b) flag likely duplicates of
// existing vendors by name/address/phone (not just literal name match). Returns
// an array of records in the SAME shape as _parseDealerBlocks, with an added
// `aiDuplicateOf` (existing vendor name or null). Falls back to the local regex
// parser on any failure (offline, bad JSON, AI off). Confirm step is unchanged.
async function _aiParseDealers(text) {
  if (!window.ai || typeof window.ai.ask !== 'function') return null;
  const existing = _contacts.filter(c => c.type === 'vendor').map(c => ({
    name: c.name || '', city: c.city || '', street: c.street || '', phone: c.phone || '',
  }));
  // Keep the context compact — name/city/street/phone is enough to judge dupes.
  const existingList = existing.map((e, i) => (i + 1) + '. ' + e.name + ' | ' + [e.street, e.city].filter(Boolean).join(', ') + (e.phone ? ' | ' + e.phone : '')).join('\n');

  // Domicile addresses — so the AI can assign the nearest site + estimate miles
  // when the pasted block has no explicit "SITE Pref #" tag or stated distance.
  const domiciles = _contacts.filter(c => c.type === 'domicile');
  const domicileList = domiciles.map(d => '  ' + (d.name || '').trim() + ' = ' + [d.street, d.city, d.state, d.zip].filter(Boolean).join(', ')).join('\n');

  const prompt =
    'You are parsing truck-dealer entries pasted from a dealer-locator tool into a fleet app vendor book. ' +
    'Extract EACH dealer into a structured record, and decide if it duplicates one of the EXISTING vendors ' +
    '(same physical shop — judge by name + address + phone, not just identical text; different branches of the ' +
    'same chain in different cities are NOT duplicates).\n\n' +
    'For each dealer return these fields (omit a field if unknown):\n' +
    '  name (string), company (string, usually same as name), makes (array of UPPERCASE make names), ' +
    'cng (bool, true if the entry mentions CNG), mobile (bool, true if mobile service), ' +
    'affiliation (string, e.g. "PACCAR", "Volvo Uptime", "DTNA (Service Tracker)", "Relay Garage/Reach"), ' +
    'street, city, state (2-letter), zip, phone, email, contactPerson, hours, notes (short), ' +
    'domicile (the SITE code explicitly before "Pref #" or "Specialist" in the text, e.g. ABE40, or null if none), ' +
    'preference (integer after "Pref #", or null), ' +
    'miles (number before "miles" in the text — distance from the domicile this list is for, or null if none stated), ' +
    'doNotUse (bool, true if the entry says "Do Not Use"), ' +
    'duplicateOf (the EXACT name from the EXISTING list it duplicates, or null).\n\n' +
    'ASSIGNING A DOMICILE WHEN THE TEXT DOES NOT STATE ONE: I manage these domiciles (home yards) with addresses:\n' +
    (domicileList || '  (none on file)') + '\n' +
    'For EACH dealer, also return:\n' +
    '  assignedDomicile = the domicile code that is GEOGRAPHICALLY NEAREST to the dealer address (choose from the domiciles above). ' +
    'If the text already states a domicile (via Pref #), use that one. If you cannot tell, null.\n' +
    '  estimatedMiles = your best estimate of road miles from that assigned domicile address to the dealer address ' +
    '(a number). If the text already states miles, echo that number instead.\n' +
    '  milesEstimated = true if YOU estimated the miles (text did not state them), false if the number came from the text.\n\n' +
    'EXISTING VENDORS:\n' + (existingList || '(none)') + '\n\n' +
    'PASTED DEALER TEXT:\n' + text + '\n\n' +
    'RESPOND WITH JSON ONLY, no prose, in the form: {"dealers":[ {...}, {...} ]}';

  let res;
  try { res = await window.ai.ask(prompt); } catch (e) { return null; }
  const raw = (res && res.text) ? res.text : (typeof res === 'string' ? res : '');
  if (!raw) return null;
  let parsed;
  try {
    const cleaned = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    parsed = JSON.parse(m[0]);
  } catch (e) { return null; }
  const dealers = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.dealers) ? parsed.dealers : null);
  if (!dealers || !dealers.length) return null;

  // Map AI output into the vendor-record shape used by the preview + save path.
  return dealers.map(d => {
    const explicitDom = d.domicile ? String(d.domicile).toUpperCase().trim() : '';
    const assignedDom = d.assignedDomicile ? String(d.assignedDomicile).toUpperCase().trim() : '';
    // Precedence: explicit "SITE Pref #" tag in the text > AI-assigned nearest.
    const dom = explicitDom || assignedDom;
    const makes = Array.isArray(d.makes) ? d.makes.map(m => String(m).toUpperCase().trim()).filter(Boolean) : [];
    // Miles precedence: explicit stated miles > AI estimate. milesEstimated flag
    // reflects whether the final number is an estimate (for the "(estimated)" tag).
    const statedMiles = (d.miles != null && Number.isFinite(+d.miles)) ? +d.miles : null;
    const estMiles = (d.estimatedMiles != null && Number.isFinite(+d.estimatedMiles)) ? +d.estimatedMiles : null;
    const finalMiles = statedMiles != null ? statedMiles : estMiles;
    const milesEstimated = statedMiles == null && estMiles != null && (d.milesEstimated !== false);
    const rec = {
      type: 'vendor',
      name: String(d.name || '').trim(),
      company: String(d.company || d.name || '').trim(),
      makes, make: makes[0] || '',
      cng: !!d.cng, mobile: !!d.mobile,
      affiliation: d.affiliation ? String(d.affiliation).trim() : '',
      street: d.street || '', city: d.city || '', state: d.state || '', zip: d.zip ? String(d.zip) : '',
      phone: d.phone || '', email: d.email || '', contactPerson: d.contactPerson || '',
      hours: d.hours || '', notes: d.notes || '',
      domiciles: dom ? [dom] : [], mileageByDomicile: {}, prefTags: [],
      _doNotUse: !!d.doNotUse,
      aiDuplicateOf: d.duplicateOf && String(d.duplicateOf).trim() ? String(d.duplicateOf).trim() : null,
      _ai: true,
      _assignedByAI: !explicitDom && !!assignedDom, // domicile inferred, not from text
      _milesEstimated: !!milesEstimated,
    };
    if (dom) {
      if (d.preference != null && Number.isFinite(+d.preference)) { rec.preference = +d.preference; rec.preferenceByDomicile = { [dom]: +d.preference }; }
      if (finalMiles != null) rec.mileageByDomicile = { [dom]: finalMiles };
    }
    if (!rec.name) return null;
    return rec;
  }).filter(Boolean);
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
  let filterBarHtml = '';
  let gridClass = '';
  if (_tab === 'vendors') {
    const filtered = _applyVendorFilters(vendors);
    filterBarHtml = _vendorFilterBarHtml(vendors.length, filtered.length) + _pasteBoxHtml();
    gridClass = ' cb-grid';
    listHtml = filtered.length ? filtered.map((c, i) => `
      <div class="cb-card" data-idx="${i}" data-id="${c.id}">
        <div class="cb-card-top">
          <div class="cb-card-name">${_esc(c.name)} ${_prefBadgeHtml(c)} ${_capBadgeHtml(c)}</div>
          <div class="cb-card-company">${_esc(c.company || '')} ${_vendorMakesLabel(c)}</div>
        </div>
        <div class="cb-card-addr">${_esc(c.street || '')}${c.city ? ', ' + _esc(c.city) : ''} ${_esc(c.state || '')} ${_esc(c.zip || '')}</div>
        ${c.domiciles && c.domiciles.length ? '<div class="cb-card-meta" style="color:#58a6ff;">📍 ' + c.domiciles.join(', ') + '</div>' : ''}
        ${_mileageBadgeHtml(c) ? '<div class="cb-card-meta">🧭 ' + _mileageBadgeHtml(c) + '</div>' : ''}
        ${c.affiliation ? '<div class="cb-card-meta">🔗 ' + _esc(c.affiliation) + '</div>' : ''}
        ${c.hours ? '<div class="cb-card-meta">🕐 ' + _esc(c.hours) + '</div>' : ''}
        ${c.phone ? '<div class="cb-card-meta">📞 ' + _esc(c.phone) + '</div>' : ''}
        ${c.email ? '<div class="cb-card-meta">📧 ' + _esc(c.email) + '</div>' : ''}
        ${c.contactPerson ? '<div class="cb-card-meta">👤 ' + _esc(c.contactPerson) + '</div>' : ''}
        ${c.notes ? '<div class="cb-card-meta" style="color:#8b949e;">📝 ' + _esc(c.notes) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="use-address" data-id="${c.id}">📍 Use for Tow</button>
          ${c.email ? `<button class="cb-btn cb-btn--use" data-action="email-contact" data-id="${c.id}">📧 Email</button>` : ''}
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️ Edit</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : ('<div class="cb-empty">' + (vendors.length ? 'No vendors match these filters.' : 'No vendors yet — add one below') + '</div>');

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
        <input class="cb-input" id="cb-v-mileage" placeholder="Miles from each domicile, e.g. AVP40:4.3, ABE40:1.2 (optional)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">Distance from each site. Shown nearest-first on the card and used to prefer closer vendors.</div>
        <div class="cb-row" style="align-items:center;gap:12px;margin:4px 0;">
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="cb-v-cng" style="margin:0" /> CNG accepted</label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="cb-v-mobile" style="margin:0" /> Mobile service</label>
        </div>
        <input class="cb-input" id="cb-v-affiliation" placeholder="Affiliation / Integration (PACCAR, Volvo Uptime, DTNA, Relay Garage/Reach...)" />
        <input class="cb-input" id="cb-v-hours" placeholder="Hours (M-F 7a-9p...)" />
        <input class="cb-input" id="cb-v-street" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="cb-v-city" placeholder="City" style="flex:2" />
          <input class="cb-input" id="cb-v-state" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="cb-v-zip" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="cb-v-phone" placeholder="Phone" />
        <input class="cb-input" id="cb-v-email" placeholder="Email (for direct email from chat)" />
        <input class="cb-input" id="cb-v-contact-person" placeholder="Contact person (Service Manager: ...)" />
        <input class="cb-input" id="cb-v-notes" placeholder="Notes (certifications, specialties, caveats...)" />
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
        ${c.gateCode ? '<div class="cb-card-meta">🔑 Gate Code: ' + _esc(c.gateCode) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️ Edit</button>
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
        <input class="cb-input" id="cb-d-gatecode" placeholder="Gate code (optional, e.g. #7466)" />
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

  _el.querySelector('.cb-body').innerHTML = tabsHtml + filterBarHtml + '<div class="cb-list' + gridClass + '">' + listHtml + '</div>';

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
    contactPerson: g('cb-v-contact-person'),
    affiliation: g('cb-v-affiliation'), hours: g('cb-v-hours'), notes: g('cb-v-notes'),
    cng: !!(document.getElementById('cb-v-cng') && document.getElementById('cb-v-cng').checked),
    mobile: !!(document.getElementById('cb-v-mobile') && document.getElementById('cb-v-mobile').checked),
    mileageByDomicile: _parseMileage(g('cb-v-mileage')) || {},
    preference: Number.isFinite(prefRaw) && prefRaw > 0 ? prefRaw : null,
    preferenceByDomicile: _parsePrefOverrides(g('cb-v-pref-overrides'))
  };
  if (!contact.name) return;
  await window.contacts.add(contact);
  _load();
}

// Save all parsed paste-previews as vendors (add or merge via the service's
// name dedupe + union). Skips "Do Not Use" blocks.
async function _savePastedDealers() {
  const list = _pastePreviews || [];
  const toSave = list.filter(p => p && !p._doNotUse && p.name);
  if (!toSave.length) return;
  for (const p of toSave) {
    const rec = Object.assign({}, p);
    const dupOf = rec.aiDuplicateOf;
    delete rec._doNotUse; delete rec.aiDuplicateOf; delete rec._ai;
    delete rec._assignedByAI; delete rec._milesEstimated;
    // If AI flagged this as a duplicate of an existing vendor whose NAME differs,
    // merge onto that card: attach its id + keep its name so the service matches
    // by id and unions domiciles/makes/mileage (no near-duplicate card).
    if (dupOf) {
      const match = _contacts.find(c => c.type === 'vendor' && (c.name || '').trim().toLowerCase() === String(dupOf).trim().toLowerCase());
      if (match) { rec.id = match.id; rec.name = match.name; }
    }
    try { await window.contacts.add(rec); } catch (_) {}
  }
  _pastePreviews = null; _pasteText = '';
  // Keep the box open so the user can paste the next batch immediately.
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
    street: g('cb-d-street'), city: g('cb-d-city'), state: g('cb-d-state'), zip: g('cb-d-zip'),
    gateCode: g('cb-d-gatecode')
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

  if (contact.type === 'domicile') {
    card.innerHTML = `
      <div class="cb-add-form" style="margin:0;border:none;padding:0;">
        <input class="cb-input" id="edit-d-name" value="${_attr(contact.name)}" placeholder="Site code (ABE40, PHL40...)" />
        <input class="cb-input" id="edit-d-street" value="${_attr(contact.street || '')}" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="edit-d-city" value="${_attr(contact.city || '')}" placeholder="City" style="flex:2" />
          <input class="cb-input" id="edit-d-state" value="${_attr(contact.state || '')}" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="edit-d-zip" value="${_attr(contact.zip || '')}" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="edit-d-gatecode" value="${_attr(contact.gateCode || '')}" placeholder="Gate code (optional, e.g. #7466)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">This address is what the AI compares pasted dealers against to pick the nearest domicile. Keep it accurate. Gate code is used in tow comments.</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="cb-btn cb-btn--add" id="edit-save">Save</button>
          <button class="cb-btn cb-btn--del" id="edit-cancel">Cancel</button>
        </div>
      </div>`;
    card.querySelector('#edit-save').addEventListener('click', async () => {
      const g = sel => (card.querySelector(sel) || {}).value || '';
      contact.name   = g('#edit-d-name').trim();
      contact.street = g('#edit-d-street').trim();
      contact.city   = g('#edit-d-city').trim();
      contact.state  = g('#edit-d-state').trim();
      contact.zip    = g('#edit-d-zip').trim();
      contact.gateCode = g('#edit-d-gatecode').trim();
      await window.contacts.update(contact);
      _load();
    });
    card.querySelector('#edit-cancel').addEventListener('click', () => _render());
    return;
  }

  if (contact.type === 'vendor') {
    card.innerHTML = `
      <div class="cb-add-form" style="margin:0;border:none;padding:0;">
        <input class="cb-input" id="edit-name" value="${_attr(contact.name)}" placeholder="Vendor / Dealer name" />
        <input class="cb-input" id="edit-makes" value="${_attr((Array.isArray(contact.makes) && contact.makes.length ? contact.makes : (contact.make ? [contact.make] : [])).join(', '))}" placeholder="Makes this vendor services (VOLVO, KENWORTH, PETERBILT...)" />
        <input class="cb-input" id="edit-company" value="${_attr(contact.company || '')}" placeholder="Company name" />
        <input class="cb-input" id="edit-domiciles" value="${_attr((contact.domiciles || []).join(', '))}" placeholder="Domiciles this vendor serves (ABE40, PHL40...)" />
        <input class="cb-input" id="edit-preference" type="number" min="1" step="1" value="${_attr(contact.preference || '')}" placeholder="Preference rank (1 = first choice) -- applies to all domiciles above" />
        <input class="cb-input" id="edit-pref-overrides" value="${_attr(Object.entries(contact.preferenceByDomicile || {}).map(([s, r]) => s + ':' + r).join(', '))}" placeholder="Override rank for specific domiciles, e.g. AVP40:1, ABE40:2 (optional)" />
        <input class="cb-input" id="edit-mileage" value="${_attr(Object.entries(contact.mileageByDomicile || {}).map(([s, mi]) => s + ':' + mi).join(', '))}" placeholder="Miles from each domicile, e.g. AVP40:4.3, ABE40:1.2" />
        <div class="cb-row" style="align-items:center;gap:12px;margin:4px 0;">
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="edit-cng" ${contact.cng ? 'checked' : ''} style="margin:0" /> CNG accepted</label>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;"><input type="checkbox" id="edit-mobile" ${contact.mobile ? 'checked' : ''} style="margin:0" /> Mobile service</label>
        </div>
        <input class="cb-input" id="edit-affiliation" value="${_attr(contact.affiliation || '')}" placeholder="Affiliation / Integration" />
        <input class="cb-input" id="edit-hours" value="${_attr(contact.hours || '')}" placeholder="Hours" />
        <input class="cb-input" id="edit-street" value="${_attr(contact.street || '')}" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="edit-city" value="${_attr(contact.city || '')}" placeholder="City" style="flex:2" />
          <input class="cb-input" id="edit-state" value="${_attr(contact.state || '')}" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="edit-zip" value="${_attr(contact.zip || '')}" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="edit-phone" value="${_attr(contact.phone || '')}" placeholder="Phone" />
        <input class="cb-input" id="edit-email" value="${_attr(contact.email || '')}" placeholder="Email" />
        <input class="cb-input" id="edit-contact-person" value="${_attr(contact.contactPerson || '')}" placeholder="Contact person" />
        <input class="cb-input" id="edit-notes" value="${_attr(contact.notes || '')}" placeholder="Notes" />
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
      contact.mileageByDomicile = _parseMileage(g('#edit-mileage')) || {};
      contact.cng    = !!(card.querySelector('#edit-cng') && card.querySelector('#edit-cng').checked);
      contact.mobile = !!(card.querySelector('#edit-mobile') && card.querySelector('#edit-mobile').checked);
      contact.affiliation = g('#edit-affiliation').trim();
      contact.hours  = g('#edit-hours').trim();
      contact.street = g('#edit-street').trim();
      contact.city   = g('#edit-city').trim();
      contact.state  = g('#edit-state').trim();
      contact.zip    = g('#edit-zip').trim();
      contact.phone  = g('#edit-phone').trim();
      contact.email  = g('#edit-email').trim();
      contact.contactPerson = g('#edit-contact-person').trim();
      contact.notes  = g('#edit-notes').trim();
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

    // Vendor filter chips (domicile / CNG / paste). Make + miles are <select>s.
    const vf = e.target.closest('[data-vf]');
    if (vf && vf.tagName !== 'SELECT') {
      const kind = vf.dataset.vf;
      if (kind === 'dom') { _vfilter.domicile = vf.dataset.val || ''; _render(); return; }
      if (kind === 'cng') { _vfilter.cng = !_vfilter.cng; _render(); return; }
      if (kind === 'rg') { _vfilter.rg = !_vfilter.rg; _render(); return; }
      if (kind === 'paste') { _pasteOpen = !_pasteOpen; if (!_pasteOpen) { _pastePreviews = null; _pasteText = ''; } _render(); return; }
    }

    // Paste-dealer box buttons.
    if (e.target.id === 'cb-paste-parse') {
      const ta = document.getElementById('cb-paste-text');
      _pasteText = ta ? ta.value : '';
      if (!_pasteText.trim()) { _pastePreviews = null; _render(); return; }
      _pasteBusy = true; _pastePreviews = null; _render();
      // AI first (parse + dedupe); fall back to local regex parser on any failure.
      _aiParseDealers(_pasteText).then(aiRecs => {
        if (aiRecs && aiRecs.length) { _pastePreviews = aiRecs; _pasteMode = 'ai'; }
        else { _pastePreviews = _parseDealerBlocks(_pasteText); _pasteMode = 'local'; }
      }).catch(() => {
        _pastePreviews = _parseDealerBlocks(_pasteText); _pasteMode = 'local';
      }).finally(() => { _pasteBusy = false; _render(); });
      return;
    }
    if (e.target.id === 'cb-paste-close') { _pasteOpen = false; _pastePreviews = null; _pasteText = ''; _render(); return; }
    if (e.target.id === 'cb-paste-save') { _savePastedDealers(); return; }

    // Multi-select "select all" (checks every visible individual box; does NOT
    // set the '*' wildcard — that's the separate "All" checkbox) / clear links.
    const allLink = e.target.closest('.cb-ms-allsel');
    if (allLink) {
      e.preventDefault();
      const root = _editorRootFor(allLink);
      const kind = allLink.dataset.kind; // full kind, e.g. 'cb-s-op' / 'edit-op'
      if (root) {
        root.querySelectorAll('.cb-ms-' + kind).forEach(b => { if (!b.disabled) b.checked = true; });
        _refreshEditorFeedback(root, _prefixFor(root));
      }
      return;
    }
    const noneLink = e.target.closest('.cb-ms-none');
    if (noneLink) {
      e.preventDefault();
      const root = _editorRootFor(noneLink);
      const kind = noneLink.dataset.kind; // full kind, e.g. 'cb-s-op'
      if (root) {
        // Clear both the All ('*') flag and the individual boxes.
        const allFlag = root.querySelector('.cb-ms-all-' + kind);
        if (allFlag) allFlag.checked = false;
        root.querySelectorAll('.cb-ms-' + kind).forEach(b => { b.disabled = false; b.checked = false; });
        const wrap = allFlag && allFlag.closest('.cb-ms'); if (wrap) { const list = wrap.querySelector('.cb-ms-list'); if (list) { list.style.opacity = ''; list.style.pointerEvents = ''; } }
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
    // Vendor make / miles filter dropdowns.
    if (e.target.dataset && e.target.dataset.vf === 'make') { _vfilter.make = e.target.value || ''; _render(); return; }
    if (e.target.dataset && e.target.dataset.vf === 'miles') { _vfilter.maxMiles = parseInt(e.target.value, 10) || 0; _render(); return; }

    // Per-dealer domicile override in the paste preview.
    if (e.target.dataset && e.target.dataset.pasteDom != null && e.target.dataset.pasteDom !== '') {
      const idx = parseInt(e.target.dataset.pasteDom, 10);
      const p = _pastePreviews && _pastePreviews[idx];
      if (p) {
        const newDom = (e.target.value || '').toUpperCase();
        // Carry whatever mileage we had to the newly chosen site (if any).
        const oldDom = (p.domiciles || [])[0];
        const miles = oldDom && p.mileageByDomicile ? p.mileageByDomicile[oldDom] : null;
        if (newDom) {
          p.domiciles = [newDom];
          p.mileageByDomicile = miles != null ? { [newDom]: miles } : {};
          if (p.preferenceByDomicile && oldDom && p.preferenceByDomicile[oldDom] != null) {
            p.preferenceByDomicile = { [newDom]: p.preferenceByDomicile[oldDom] };
          }
        } else {
          p.domiciles = []; p.mileageByDomicile = {}; delete p.preferenceByDomicile;
        }
        p._assignedByAI = false; // user set it explicitly now
        _render();
      }
      return;
    }

    const root = _editorRootFor(e.target);
    if (!root) return;
    const prefix = _prefixFor(root);

    // Identity changed -> re-render the permission block so vendor lock +
    // unknown all-scope default apply. Data/request permissions are always
    // "all" (not user-editable), so there's nothing to overwrite/confirm.
    if (e.target.classList.contains(prefix + '-identity')) {
      _applyPresetToEditor(root, prefix, e.target.value);
      return;
    }
    // "All ('*')" scope flag toggled -> enable/disable that multi-select's list.
    if (e.target.classList.contains('cb-ms-all-flag')) {
      const wrap = e.target.closest('.cb-ms');
      if (wrap) {
        const on = e.target.checked;
        const list = wrap.querySelector('.cb-ms-list');
        const search = wrap.querySelector('.cb-ms-search');
        if (list) { list.style.opacity = on ? '0.4' : ''; list.style.pointerEvents = on ? 'none' : ''; }
        if (search) search.disabled = on;
        wrap.querySelectorAll('input[type="checkbox"]').forEach(b => { if (b !== e.target && !b.classList.contains('cb-ms-all-flag')) b.disabled = on; });
      }
      _refreshEditorFeedback(root, prefix);
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
