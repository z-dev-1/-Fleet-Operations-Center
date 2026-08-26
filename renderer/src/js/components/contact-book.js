/**
 * contact-book.js — Contact Book Panel (two tabs: Slack Contacts + Vendors)
 *
 * Vendors have addresses usable for tow destination in WR modal.
 * Slack contacts have @handles for mentions.
 */

import bus from '../bus.js';
import state from '../state.js';

let _el = null;
let _open = false;
let _tab = 'vendors'; // 'vendors' | 'slack'
let _contacts = [];
let _slackSearchTimer = null; // debounce handle for live search
let _pendingSlack = null;     // { slackId, name, channelId? } resolved from search

const _esc  = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _attr = (s) => _esc(s).replace(/"/g, '&quot;');

// Operator codes from the latest fleet scan, for the per-contact data-scope picker.
function _fleetOperators() {
  try {
    const rows = (state.slice('fleet').rows) || [];
    const set = {};
    rows.forEach(function(r){ const o = (r.operator||'').trim(); if(o) set[o.toUpperCase()] = true; });
    return Object.keys(set).sort();
  } catch(e) { return []; }
}
// Build <option> list for the operators multi-select; marks selected ones.
function _operatorOptions(selected) {
  const sel = (selected || []).map(function(s){ return String(s||'').toUpperCase(); });
  return _fleetOperators().map(function(op){
    const isSel = sel.indexOf(op) !== -1 ? ' selected' : '';
    return '<option value="' + _attr(op) + '"' + isSel + '>' + _esc(op) + '</option>';
  }).join('');
}
// Checkbox list for operator scope — clearer than a native multi-select
// (no Ctrl+click, no accidental single-select reset). Used in add + edit forms.
function _operatorCheckboxes(cls, selected) {
  const sel = (selected || []).map(function(s){ return String(s||'').toUpperCase(); });
  const ops = _fleetOperators();
  if (!ops.length) return '<div style="font-size:9px;color:#8b949e">No operators yet — waiting for fleet data…</div>';
  return '<div style="display:flex;flex-wrap:wrap;gap:8px">' + ops.map(function(op){
    const chk = sel.indexOf(op) !== -1 ? ' checked' : '';
    return '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">' +
      '<input type="checkbox" class="' + cls + '" value="' + _attr(op) + '"' + chk + ' style="margin:0"/>' + _esc(op) +
      '</label>';
  }).join('') + '</div>';
}

// A vendor's rank can differ per domicile it serves (e.g. #1 at AVP40 but #2
// at ABE40 because a closer competitor covers ABE40 better). `preference` is
// the shared default that applies to every domicile the vendor serves unless
// a specific site is overridden in `preferenceByDomicile`.
// Parses "AVP40:1, ABE40:2" into { AVP40: 1, ABE40: 2 }. Malformed/blank
// entries are skipped rather than throwing, so a typo doesn't block saving.
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
  // Mixed ranks across domiciles -- show each site's rank explicitly.
  return sites.map(s => {
    const p = _prefFor(c, s);
    return p ? '<span class="cb-pref-badge">' + _esc(s) + ': #' + _esc(p) + '</span>' : '';
  }).join(' ');
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
          <div class="cb-card-company">${_esc(c.company || c.role || '')}</div>
        </div>
        <div class="cb-card-meta">${_esc(c.slackId || '')} ${c.phone ? '• ' + _esc(c.phone) : ''}</div>
        ${(Array.isArray(c.operators) && c.operators.length) ? '<div class="cb-card-meta" style="color:#3fb950">🔒 ' + _esc(c.operators.join(', ')) + ' only</div>' : ''}
        ${c.email ? '<div class="cb-card-meta">📧 ' + _esc(c.email) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="slack-msg" data-id="${c.id}">💬 Message</button>
          ${c.email ? `<button class="cb-btn cb-btn--use" data-action="email-contact" data-id="${c.id}">📧 Email</button>` : ''}
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '<div class="cb-empty">No Slack contacts yet — add one below</div>';

    listHtml += `
      <div class="cb-add-form">
        <div class="cb-add-title">+ Add Slack Contact</div>
        <input class="cb-input" id="cb-s-name" placeholder="Name (searches Slack as you type)" autocomplete="off" />
        <div class="cb-slack-results" id="cb-slack-results"></div>
        <div class="cb-slack-confirm" id="cb-slack-confirm" style="display:none"></div>
        <input class="cb-input" id="cb-s-slack" placeholder="@slack-handle (auto-filled from search)" />
        <input class="cb-input" id="cb-s-company" placeholder="Company / Team" />
        <div style="font-size:9px;color:#8b949e;margin-top:6px;margin-bottom:3px;">Operators (data scope) &mdash; leave empty to share full fleet</div>
        ${_operatorCheckboxes('cb-s-op', [])}
        <input class="cb-input" id="cb-s-email" placeholder="Email (optional)" />
        <input class="cb-input" id="cb-s-phone" placeholder="Phone (optional)" />
        <button class="cb-btn cb-btn--add" id="cb-add-slack">Add Contact</button>
      </div>`;
  }

  _el.querySelector('.cb-body').innerHTML = tabsHtml + '<div class="cb-list">' + listHtml + '</div>';
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
  // Fill name field
  const nameEl = document.getElementById('cb-s-name');
  if (nameEl) nameEl.value = name;
  // Clear dropdown
  const resultsEl = document.getElementById('cb-slack-results');
  if (resultsEl) resultsEl.innerHTML = '';
  // Show confirmed badge
  const confirmEl = document.getElementById('cb-slack-confirm');
  if (confirmEl) {
    confirmEl.innerHTML =
      '<span>✓ Found in Slack: <strong>' + _esc(name) + '</strong></span>' +
      '<button class="cb-slack-clear-btn" id="cb-slack-clear">×</button>';
    confirmEl.style.display = 'flex';
  }
  // Store immediately; resolve DM channelId in background
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
    make: makes[0] || '', // legacy single-make field kept in sync for older display code
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
  const contact = {
    type: 'slack',
    name: g('cb-s-name'),
    slackId: (_pendingSlack && _pendingSlack.slackId) || g('cb-s-slack').replace(/^@/, '').trim(),
    channelId: (_pendingSlack && _pendingSlack.channelId) || null,
    company: g('cb-s-company'), email: g('cb-s-email'), phone: g('cb-s-phone'),
    operators: Array.from(document.querySelectorAll('.cb-s-op')).filter(function(b){return b.checked;}).map(function(b){return b.value;})
  };
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

  // Show inline edit form
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
      contact.make        = editMakes[0] || ''; // legacy single-make field kept in sync
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

  card.innerHTML = `
    <div class="cb-add-form" style="margin:0;border:none;padding:0;">
      <input class="cb-input" id="edit-name" value="${contact.name || ''}" placeholder="Name" />
      <input class="cb-input" id="edit-slack" value="${contact.slackId || ''}" placeholder="Slack handle or email" />
      <input class="cb-input" id="edit-company" value="${contact.company || ''}" placeholder="Company" />
      <input class="cb-input" id="edit-email" value="${contact.email || ''}" placeholder="Email" />
      <input class="cb-input" id="edit-phone" value="${contact.phone || ''}" placeholder="Phone" />
      <div style="font-size:9px;color:#8b949e;margin-top:6px;margin-bottom:3px;">Operators (data scope) &mdash; empty = full fleet</div>
      ${_operatorCheckboxes('edit-op', contact.operators || [])}
      <div style="display:flex;gap:6px;margin-top:4px;">
        <button class="cb-btn cb-btn--add" id="edit-save">Save</button>
        <button class="cb-btn cb-btn--del" id="edit-cancel">Cancel</button>
      </div>
    </div>`;

  card.querySelector('#edit-save').addEventListener('click', async () => {
    contact.name = card.querySelector('#edit-name').value.trim();
    contact.slackId = card.querySelector('#edit-slack').value.trim();
    contact.company = card.querySelector('#edit-company').value.trim();
    contact.email = card.querySelector('#edit-email').value.trim();
    contact.phone = card.querySelector('#edit-phone').value.trim();
    contact.operators = Array.from(card.querySelectorAll('.edit-op')).filter(function(b){return b.checked;}).map(function(b){return b.value;});
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

export function init() {
  // Live refresh when main process auto-saves a new DM contact
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

  // Delegated events
  _el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { _tab = tab.dataset.tab; _render(); return; }

    // Add buttons
    if (e.target.id === 'cb-add-vendor') { _addVendor(); return; }
    if (e.target.id === 'cb-add-slack') { _addSlack(); return; }
    if (e.target.id === 'cb-add-domicile') { _addDomicile(); return; }

    // Action buttons (delete, use-address)
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
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
      if (_open) _toggle(); // close the contact book so the FAB compose bubble is visible
      return;
    }

    // Live search result item
    const resultItem = e.target.closest('.cb-slack-result-item');
    if (resultItem) { _pickSlackPerson(resultItem.dataset.id, resultItem.dataset.name); return; }

    // Clear confirmed-person banner
    if (e.target.id === 'cb-slack-clear') { _clearSlackPick(); return; }
  });

  
  bus.on('ui:contacts-toggle', _toggle);

  // Delegated input handler for the Slack live-search name field
  _el.addEventListener('input', (e) => {
    if (e.target.id === 'cb-s-name') {
      // If user edits name after confirming, reset the pending pick
      if (_pendingSlack) _clearSlackPick();
      clearTimeout(_slackSearchTimer);
      _slackSearchTimer = setTimeout(() => _searchSlackContacts(e.target.value.trim()), 400);
    }
  });
}

// Export for @ mention autocomplete
export async function searchContacts(query) {
  if (!window.contacts) return [];
  return window.contacts.search(query);
}
