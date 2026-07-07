/**
 * notes-links.js — Notes & Links view
 *
 * Ported from V2 NotesLinksModule, rewritten for VC architecture.
 * Storage: localStorage key 'fleet-notes-links-v1' (no IPC needed).
 * Each entry: { id, name, url, matchPattern, userLabel, user, passLabel, pass, autofill }
 *
 * Features:
 *   - Card list of saved sites with favicon, username, masked password
 *   - Copy username / copy password buttons
 *   - Toggle password visibility per card
 *   - Add / Edit / Delete with inline confirm-delete
 *   - Add New Site modal
 *   - Autofill badge display
 *   - Search/filter bar
 */

import bus   from '../bus.js';
import toast from '../components/toast.js';

// ── Storage ───────────────────────────────────────────────────────────────────
const STORE_KEY = 'fleet-notes-links-v1';

function _load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}

function _save(sites) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sites));
  } catch (_) {}
}

function _genId() {
  return 'nl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const _esc = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function _faviconUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2330363d'/%3E%3Ctext x='16' y='22' font-size='16' text-anchor='middle' fill='%238b949e'%3E${hostname[0].toUpperCase()}%3C/text%3E%3C/svg%3E`;
  } catch (_) {
    return '';
  }
}

function _siteLetter(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function _copyToClipboard(text, label) {
  const val = String(text || '').trim();
  if (!val || val === '--') { toast.show('warn', 'Nothing to copy', 2000); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(val)
      .then(() => toast.show('success', (label || 'Value') + ' copied', 1800))
      .catch(() => toast.show('error', 'Copy failed', 2000));
    return;
  }
  // Fallback for Electron context
  const tmp = document.createElement('textarea');
  tmp.value = val;
  tmp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.appendChild(tmp);
  tmp.select();
  try {
    document.execCommand('copy');
    toast.show('success', (label || 'Value') + ' copied', 1800);
  } catch (_) {
    toast.show('error', 'Copy failed', 2000);
  }
  tmp.remove();
}

// ── Module state ──────────────────────────────────────────────────────────────
let _el        = null;   // root view element
let _pwVisible = {};     // { [id]: boolean }
let _editingId = null;
let _search    = '';

// ── Card renderer ─────────────────────────────────────────────────────────────
function _siteCard(site) {
  const faviconUrl  = _faviconUrl(site.url);
  const letter      = _siteLetter(site.name);
  const pwVisible   = !!_pwVisible[site.id];

  const displayPass = site.pass
    ? (pwVisible ? _esc(site.pass) : '••••••••')
    : '<span class="nl-cred-none">not set</span>';

  const autofillBadge = site.autofill
    ? '<span class="nl-autofill-badge">&#9889; AUTOFILL</span>'
    : '';

  const passRow = (site.pass || site.passLabel)
    ? `<div class="nl-cred-row">
        <span class="nl-cred-label">${_esc(site.passLabel || 'Password')}</span>
        <span class="nl-cred-value${pwVisible ? '' : ' nl-pw-hidden'}">${displayPass}</span>
        <button class="nl-toggle-pw" data-nl-toggle="${_esc(site.id)}" title="${pwVisible ? 'Hide' : 'Show'} password">
          ${pwVisible ? '&#128584;' : '&#128065;'}
        </button>
        <button class="nl-copy-btn" data-nl-copy="pass" data-nl-id="${_esc(site.id)}">COPY</button>
      </div>`
    : '';

  return `
    <div class="nl-card" data-nl-card="${_esc(site.id)}">
      <div class="nl-site-row">
        <img class="nl-favicon" src="${_esc(faviconUrl)}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="">
        <div class="nl-favicon-fallback" style="display:none">${_esc(letter)}</div>
        <div class="nl-site-info">
          <div class="nl-site-name">${_esc(site.name)}</div>
          <a class="nl-site-link" href="${_esc(site.url)}" target="_blank" rel="noopener noreferrer">${_esc(site.url)}</a>
        </div>
        ${autofillBadge}
      </div>
      <div class="nl-cred-row">
        <span class="nl-cred-label">${_esc(site.userLabel || 'Username')}</span>
        <span class="nl-cred-value">${site.user ? _esc(site.user) : '<span class="nl-cred-none">not set</span>'}</span>
        <button class="nl-copy-btn" data-nl-copy="user" data-nl-id="${_esc(site.id)}">COPY</button>
      </div>
      ${passRow}
      <div class="nl-card-actions">
        <button class="nl-edit-btn"   data-nl-edit="${_esc(site.id)}">&#9998; EDIT</button>
        <button class="nl-delete-btn" data-nl-delete="${_esc(site.id)}">&#10005; DELETE</button>
      </div>
    </div>`;
}

// ── List renderer ─────────────────────────────────────────────────────────────
function _renderList() {
  const listEl = _el ? _el.querySelector('#nl-list') : null;
  if (!listEl) return;

  let sites = _load();

  // Apply search filter
  if (_search) {
    const q = _search.toLowerCase();
    sites = sites.filter(s =>
      (s.name  || '').toLowerCase().includes(q) ||
      (s.url   || '').toLowerCase().includes(q) ||
      (s.user  || '').toLowerCase().includes(q)
    );
  }

  const total   = _load().length;
  const countEl = _el.querySelector('#nl-count');
  if (countEl) {
    countEl.textContent = _search
      ? `${sites.length} / ${total} sites`
      : `${total} site${total !== 1 ? 's' : ''}`;
  }

  if (sites.length === 0) {
    listEl.innerHTML = _search
      ? `<div class="nl-empty">No sites match &ldquo;<strong>${_esc(_search)}</strong>&rdquo;</div>`
      : `<div class="nl-empty">No sites saved yet.<br>Click <strong>+ ADD SITE</strong> to get started.</div>`;
    return;
  }

  listEl.innerHTML = sites.map(_siteCard).join('');
  _wireListEvents(listEl);
}

// ── Wire card-level events (delegation) ──────────────────────────────────────
function _wireListEvents(listEl) {
  // Copy buttons
  listEl.querySelectorAll('.nl-copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const field = btn.dataset.nlCopy;
      const id    = btn.dataset.nlId;
      const sites = _load();
      const site  = sites.find(s => s.id === id);
      if (!site) return;
      if (field === 'user') {
        _copyToClipboard(site.user, site.userLabel || 'Username');
      } else {
        _copyToClipboard(site.pass, site.passLabel || 'Password');
      }
    });
  });

  // Toggle password visibility
  listEl.querySelectorAll('.nl-toggle-pw').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.nlToggle;
      _pwVisible[id] = !_pwVisible[id];
      _renderList();
    });
  });

  // Edit buttons
  listEl.querySelectorAll('.nl-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _openModal(btn.dataset.nlEdit);
    });
  });

  // Delete buttons — inline confirm pattern
  listEl.querySelectorAll('.nl-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.nlDelete;
      if (btn.dataset.confirming === '1') {
        // Confirmed — delete
        const remaining = _load().filter(s => s.id !== id);
        _save(remaining);
        toast.show('info', 'Site removed', 2000);
        _renderList();
        return;
      }
      // First click — arm confirm state
      btn.dataset.confirming = '1';
      btn.textContent = 'CONFIRM?';
      btn.classList.add('nl-delete-btn--confirming');
      // Auto-reset after 3 s
      setTimeout(() => {
        if (btn.dataset.confirming === '1') {
          btn.dataset.confirming = '0';
          btn.textContent = '\u2715 DELETE';
          btn.classList.remove('nl-delete-btn--confirming');
        }
      }, 3000);
    });
  });
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────
function _openModal(editId) {
  _editingId = editId || null;
  const sites = _load();
  const site  = editId ? sites.find(s => s.id === editId) : null;

  // Remove any existing modal
  const existing = document.getElementById('nl-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'nl-modal-overlay';
  overlay.className = 'nl-modal-overlay';

  overlay.innerHTML = `
    <div class="nl-modal-box" id="nl-modal-box">
      <div class="nl-modal-title">${site ? '&#9998; EDIT SITE' : '+ ADD NEW SITE'}</div>

      <div class="nl-modal-field">
        <label class="nl-modal-label">SITE NAME</label>
        <input class="nl-modal-input" id="nl-f-name" placeholder="e.g. Decisiv Volvo"
          value="${site ? _esc(site.name) : ''}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">URL</label>
        <input class="nl-modal-input" id="nl-f-url" placeholder="https://..."
          value="${site ? _esc(site.url) : ''}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">USERNAME LABEL</label>
        <input class="nl-modal-input" id="nl-f-userLabel" placeholder="Username"
          value="${site ? _esc(site.userLabel || 'Username') : 'Username'}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">USERNAME / EMAIL / CODE</label>
        <input class="nl-modal-input" id="nl-f-user" placeholder="user@example.com"
          value="${site ? _esc(site.user || '') : ''}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">PASSWORD <span class="nl-modal-label-hint">(leave blank if not needed)</span></label>
        <input class="nl-modal-input" id="nl-f-pass" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"
          value="${site ? _esc(site.pass || '') : ''}">
      </div>
      <div class="nl-modal-field nl-modal-field--row">
        <input type="checkbox" id="nl-f-autofill" ${(!site || site.autofill) ? 'checked' : ''}>
        <label for="nl-f-autofill" class="nl-modal-check-label">Enable autofill when visiting this site</label>
      </div>

      <div class="nl-modal-actions">
        <button class="nl-modal-cancel" id="nl-modal-cancel">Cancel</button>
        <button class="nl-modal-save"   id="nl-modal-save">SAVE</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Focus first field
  setTimeout(() => {
    const nameEl = document.getElementById('nl-f-name');
    if (nameEl) nameEl.focus();
  }, 50);

  // Cancel / backdrop close
  document.getElementById('nl-modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // Save
  document.getElementById('nl-modal-save').addEventListener('click', () => {
    const name      = (document.getElementById('nl-f-name').value      || '').trim();
    const url       = (document.getElementById('nl-f-url').value       || '').trim();
    const userLabel = (document.getElementById('nl-f-userLabel').value || '').trim() || 'Username';
    const user      = (document.getElementById('nl-f-user').value      || '').trim();
    const pass      = document.getElementById('nl-f-pass').value || '';
    const autofill  = document.getElementById('nl-f-autofill').checked;

    if (!name) { toast.show('warn', 'Site name is required', 3000); return; }
    if (!url)  { toast.show('warn', 'URL is required', 3000); return; }

    let hostname = '';
    try { hostname = new URL(url).hostname; } catch (_) { hostname = url; }

    const passLabel = pass ? 'Password' : '';
    const allSites  = _load();

    if (_editingId) {
      const idx = allSites.findIndex(s => s.id === _editingId);
      if (idx !== -1) {
        allSites[idx] = Object.assign(allSites[idx], {
          name, url, matchPattern: hostname,
          userLabel, user, passLabel, pass, autofill,
        });
      }
      toast.show('success', 'Site updated', 2000);
    } else {
      allSites.push({
        id: _genId(),
        name, url, matchPattern: hostname,
        userLabel, user, passLabel, pass, autofill,
        userSelector: 'input[type="email"],input[type="text"],input[name*="user"],input[id*="user"]',
        passSelector: 'input[type="password"]',
        submitSelector: 'button[type="submit"],input[type="submit"]',
      });
      toast.show('success', 'Site added', 2000);
    }

    _save(allSites);
    overlay.remove();
    _editingId = null;
    _renderList();
  });

  // Keyboard shortcuts
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      document.getElementById('nl-modal-save').click();
    }
    if (e.key === 'Escape') overlay.remove();
  });
}

// ── Full view HTML ────────────────────────────────────────────────────────────
function _html() {
  return `
    <div class="nl-wrap">
      <div class="nl-header">
        <div class="nl-header__left">
          <span class="nl-title">&#8599; Notes &amp; Links</span>
          <span class="nl-subtitle">Saved portal credentials &amp; site logins</span>
        </div>
        <div class="nl-header__actions">
          <input id="nl-search" class="nl-search-input" type="search"
            placeholder="Search sites..." autocomplete="off" spellcheck="false" />
          <button id="nl-add-btn" class="detail-panel__btn nl-add-btn">+ ADD SITE</button>
          <button id="nl-back" class="detail-panel__btn detail-panel__btn--secondary">Back to Fleet</button>
        </div>
      </div>
      <div class="nl-meta">
        <span id="nl-count" class="nl-count">0 sites</span>
      </div>
      <div class="nl-body">
        <div id="nl-list" class="nl-list"></div>
      </div>
    </div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-notes-links';
  _el.className = 'view view--notes-links';
  _el.style.display = 'none';
  _el.innerHTML = _html();
  container.appendChild(_el);

  // Back to fleet
  _el.querySelector('#nl-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'notes-links', to: 'fleet' });
  });

  // Add site button
  _el.querySelector('#nl-add-btn').addEventListener('click', () => {
    _openModal(null);
  });

  // Search
  let _searchTimer = null;
  _el.querySelector('#nl-search').addEventListener('input', e => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _search = e.target.value.trim();
      _renderList();
    }, 150);
  });

  // Show / hide on view-change
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'notes-links' ? 'flex' : 'none';
    if (to === 'notes-links') {
      _search = '';
      const si = _el.querySelector('#nl-search');
      if (si) si.value = '';
      _renderList();
    }
  });

  // Initial render
  _renderList();
}
