/**
 * contact-book.js — Contact Book Panel (two tabs: Slack Contacts + Vendors)
 *
 * Vendors have addresses usable for tow destination in WR modal.
 * Slack contacts have @handles for mentions.
 */

import bus from '../bus.js';

let _el = null;
let _open = false;
let _tab = 'vendors'; // 'vendors' | 'slack'
let _contacts = [];

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
          <div class="cb-card-name">${_esc(c.name)}</div>
          <div class="cb-card-company">${_esc(c.company || '')} ${c.make ? '• ' + _esc(c.make) : ''}</div>
        </div>
        <div class="cb-card-addr">${_esc(c.street || '')}${c.city ? ', ' + _esc(c.city) : ''} ${_esc(c.state || '')} ${_esc(c.zip || '')}</div>
        ${c.domiciles && c.domiciles.length ? '<div class="cb-card-meta" style="color:#58a6ff;">📍 ' + c.domiciles.join(', ') + '</div>' : ''}
        ${c.phone ? '<div class="cb-card-meta">📞 ' + _esc(c.phone) + '</div>' : ''}
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="use-address" data-id="${c.id}">📍 Use for Tow</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '<div class="cb-empty">No vendors yet — add one below</div>';

    listHtml += `
      <div class="cb-add-form">
        <div class="cb-add-title">+ Add Vendor</div>
        <input class="cb-input" id="cb-v-name" placeholder="Vendor / Dealer name" />
        <select class="cb-input" id="cb-v-make" style="padding:5px 8px;">
          <option value="">— Make (for AI routing) —</option>
          <option>VOLVO</option><option>MACK</option><option>FREIGHTLINER</option>
          <option>KENWORTH</option><option>PETERBILT</option><option>INTERNATIONAL</option>
          <option>CUMMINS</option><option>OTHER</option>
        </select>
        <input class="cb-input" id="cb-v-company" placeholder="Company name (Bergeys, Transedge...)" />
        <input class="cb-input" id="cb-v-domiciles" placeholder="Domiciles this vendor serves (ABE40, PHL40...)" />
        <div style="font-size:8px;color:#6e7681;margin-top:2px;">Comma-separated. Must match your managed domiciles in Settings.</div>
        <input class="cb-input" id="cb-v-street" placeholder="Street address" />
        <div class="cb-row">
          <input class="cb-input" id="cb-v-city" placeholder="City" style="flex:2" />
          <input class="cb-input" id="cb-v-state" placeholder="ST" style="flex:0.5" maxlength="2" />
          <input class="cb-input" id="cb-v-zip" placeholder="ZIP" style="flex:1" />
        </div>
        <input class="cb-input" id="cb-v-phone" placeholder="Phone" />
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
        <div class="cb-card-actions">
          <button class="cb-btn cb-btn--use" data-action="slack-msg" data-id="${c.id}">💬 Message</button>
          <button class="cb-btn cb-btn--use" data-action="edit" data-id="${c.id}">✏️</button>
          <button class="cb-btn cb-btn--del" data-action="delete" data-id="${c.id}">✕</button>
        </div>
      </div>`).join('') : '<div class="cb-empty">No Slack contacts yet — add one below</div>';

    listHtml += `
      <div class="cb-add-form">
        <div class="cb-add-title">+ Add Slack Contact</div>
        <input class="cb-input" id="cb-s-name" placeholder="Name" />
        <input class="cb-input" id="cb-s-slack" placeholder="@slack-handle" />
        <input class="cb-input" id="cb-s-company" placeholder="Company / Team" />
        <input class="cb-input" id="cb-s-phone" placeholder="Phone (optional)" />
        <button class="cb-btn cb-btn--add" id="cb-add-slack">Add Contact</button>
      </div>`;
  }

  _el.querySelector('.cb-body').innerHTML = tabsHtml + '<div class="cb-list">' + listHtml + '</div>';
}

function _toggle() {
  _open = !_open;
  if (_el) _el.classList.toggle('open', _open);
  if (_open) _load();
}

async function _addVendor() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const contact = {
    type: 'vendor',
    name: g('cb-v-name'), company: g('cb-v-company'),
    make: g('cb-v-make'),
    domiciles: g('cb-v-domiciles').split(',').map(d => d.trim().toUpperCase()).filter(Boolean),
    street: g('cb-v-street'), city: g('cb-v-city'), state: g('cb-v-state'), zip: g('cb-v-zip'),
    phone: g('cb-v-phone')
  };
  if (!contact.name) return;
  await window.contacts.add(contact);
  _load();
}

async function _addSlack() {
  const g = id => (document.getElementById(id) || {}).value || '';
  const contact = {
    type: 'slack',
    name: g('cb-s-name'), slackId: g('cb-s-slack').trim(),
    company: g('cb-s-company'), phone: g('cb-s-phone')
  };
  if (!contact.name) return;
  await window.contacts.add(contact);
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
  
  card.innerHTML = `
    <div class="cb-add-form" style="margin:0;border:none;padding:0;">
      <input class="cb-input" id="edit-name" value="${contact.name || ''}" placeholder="Name" />
      <input class="cb-input" id="edit-slack" value="${contact.slackId || ''}" placeholder="Slack handle or email" />
      <input class="cb-input" id="edit-company" value="${contact.company || ''}" placeholder="Company" />
      <input class="cb-input" id="edit-phone" value="${contact.phone || ''}" placeholder="Phone" />
      <div style="display:flex;gap:6px;margin-top:4px;">
        <button class="cb-btn cb-btn--add" id="edit-save">Save</button>
        <button class="cb-btn cb-btn--del" id="edit-cancel">Cancel</button>
      </div>
    </div>`;
  
  card.querySelector('#edit-save').addEventListener('click', async () => {
    contact.name = card.querySelector('#edit-name').value.trim();
    contact.slackId = card.querySelector('#edit-slack').value.trim();
    contact.company = card.querySelector('#edit-company').value.trim();
    contact.phone = card.querySelector('#edit-phone').value.trim();
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
    if (btn.dataset.action === 'slack-msg') bus.emit('slack:quick-compose', _contacts.find(x => x.id === btn.dataset.id));
  });

  
  bus.on('ui:contacts-toggle', _toggle);
}

// Export for @ mention autocomplete
export async function searchContacts(query) {
  if (!window.contacts) return [];
  return window.contacts.search(query);
}
