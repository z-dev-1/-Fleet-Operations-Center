/**
 * acct-bridge.js — Accounts tab controller  Fleet Ops V-C
 * Sections: Auth Status pills | Credentials | Scan Domiciles | Operator Configs
 * Exposes: window._acctBridge
 */
(function () {
  'use strict';

  /* ── helpers ─────────────────────────────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function setPill(id, state, label) {
    const el = $(id);
    if (!el) return;
    el.className = 'acct-pill ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'warn');
    el.textContent = label;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, type) {
    if (typeof window.toast === 'function') window.toast(msg, type || 'success', 'Settings');
  }

  /* ── 1. Auth Status ──────────────────────────────────────────────────────── */

  async function refreshAuthPills() {
    try {
      if (window.auth && typeof window.auth.checkMidway === 'function') {
        const r = await window.auth.checkMidway();
        const ok = r && (r.ok || r.authenticated || r.valid);
        setPill('acct-pill-midway', ok ? 'ok' : 'err', ok ? 'Active' : 'Expired');
      } else { setPill('acct-pill-midway', 'warn', 'No bridge'); }
    } catch (_) { setPill('acct-pill-midway', 'warn', 'Error'); }

    try {
      if (window.slack && typeof window.slack.checkAuth === 'function') {
        const r = await window.slack.checkAuth();
        const ok = r && (r.ok || r.authed);
        setPill('acct-pill-slack', ok ? 'ok' : 'err', ok ? 'Connected' : 'Not set');
      } else { setPill('acct-pill-slack', 'warn', 'No bridge'); }
    } catch (_) { setPill('acct-pill-slack', 'warn', 'Error'); }

    try {
      if (window.ai && typeof window.ai.test === 'function') {
        const r = await window.ai.test();
        const ok = r && (r.ok || r.ready || r.status === 'ok');
        setPill('acct-pill-orcha', ok ? 'ok' : 'err', ok ? 'Ready' : 'Not ready');
      } else { setPill('acct-pill-orcha', 'warn', 'Not configured'); }
    } catch (_) { setPill('acct-pill-orcha', 'warn', 'Error'); }
  }

  /* ── 2. Credentials ──────────────────────────────────────────────────────── */

  async function refreshCredsList() {
    const el = $('acct-creds-list');
    if (!el) return;
    const fn = (window._settingsBridge && window._settingsBridge.listCredentials) || window.listCredentials;
    if (!fn) { el.textContent = 'Credentials IPC not available.'; return; }
    const keys = await fn();
    if (!keys || !keys.length) { el.textContent = 'No credentials stored.'; return; }
    el.innerHTML = keys.map(function (entry) {
      const key = typeof entry === 'string' ? entry : (entry.key || '?');
      return (
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(240,246,252,.05)">'
        + '<span style="font-family:var(--mono);font-size:10px;color:var(--acc2)">' + esc(key) + '</span>'
        + '<span style="display:flex;align-items:center;gap:8px">'
        +   '<span style="font-size:9px;color:var(--grn)">&#9679; stored</span>'
        +   '<button onclick="window._acctBridge._deleteCredKey(\'' + esc(key) + '\')" '
        +     'style="background:none;border:none;color:var(--red);cursor:pointer;font-size:10px;padding:1px 4px" '
        +     'title="Delete">&#10005;</button>'
        + '</span></div>'
      );
    }).join('');
  }

  async function saveCredFromUI() {
    const keyIn = $('acct-cred-key'), valIn = $('acct-cred-val');
    if (!keyIn || !valIn) return;
    const key = keyIn.value.trim(), val = valIn.value;
    if (!key || !val) { toast('Key and value required', 'warning'); return; }
    const setFn = (window._settingsBridge && window._settingsBridge.setCredential) || window.setCredential;
    if (!setFn) { toast('Credentials not available', 'warning'); return; }
    await setFn(key, val);
    keyIn.value = ''; valIn.value = '';
    await refreshCredsList();
  }

  async function _deleteCredKey(key) {
    const fn = (window._settingsBridge && window._settingsBridge.deleteCredential) || window.deleteCredential;
    if (fn) await fn(key);
    await refreshCredsList();
  }

  /* ── 3. Scan Domiciles ───────────────────────────────────────────────────── */

  let _domiciles = [];

  function renderDomChips() {
    const el = $('acct-dom-chips');
    if (!el) return;
    if (!_domiciles.length) {
      el.innerHTML = '<span style="font-size:10px;color:var(--txt2)">No domiciles configured.</span>';
      return;
    }
    el.innerHTML = _domiciles.map(function (d, i) {
      return (
        '<span class="dom-chip">' + esc(d)
        + '<button onclick="window._acctBridge._removeDomicile(' + i + ')" title="Remove">&#10005;</button>'
        + '</span>'
      );
    }).join('');
  }

  async function loadDomicilesData() {
    const fn = window.loadDomiciles || (window._settingsBridge && window._settingsBridge.loadDomiciles);
    if (!fn) { _domiciles = []; renderDomChips(); return; }
    const r = await fn();
    _domiciles = Array.isArray(r) ? r : [];
    renderDomChips();
  }

  async function addDomicile() {
    const inp = $('acct-dom-in');
    if (!inp) return;
    const val = inp.value.trim().toUpperCase();
    if (!val) return;
    if (_domiciles.includes(val)) { toast(val + ' already in list', 'info'); return; }
    _domiciles.push(val);
    inp.value = '';
    renderDomChips();
    await _saveDomiciles();
  }

  async function _removeDomicile(idx) {
    _domiciles.splice(idx, 1);
    renderDomChips();
    await _saveDomiciles();
  }

  async function _saveDomiciles() {
    const fn = window.saveDomiciles || (window._settingsBridge && window._settingsBridge.saveDomiciles);
    if (!fn) return;
    await fn(_domiciles);
    toast('Domiciles saved');
  }

  /* ── 4. Operator Configs — inline form ───────────────────────────────────── */

  let _operators = [];
  let _editIdx = null;   // null = adding new, number = editing existing

  // ── CSS injected once ──────────────────────────────────────────────────────
  function _injectOpStyles() {
    if (document.getElementById('acct-op-styles')) return;
    const s = document.createElement('style');
    s.id = 'acct-op-styles';
    s.textContent = [
      '.op-form{background:var(--el);border:1px solid var(--acc);border-radius:7px;padding:12px 14px;margin-bottom:10px;animation:opFormIn .18s ease}',
      '@keyframes opFormIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
      '.op-form-title{font-size:11px;font-weight:700;color:var(--acc);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}',
      '.op-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}',
      '.op-form-row{display:flex;flex-direction:column;gap:3px}',
      '.op-form-row.full{grid-column:1/-1}',
      '.op-form-label{font-size:9px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em}',
      '.op-form-input{background:var(--bg);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;color:var(--txt);font-size:11px;outline:none;font-family:inherit;transition:border-color .15s}',
      '.op-form-input:focus{border-color:var(--acc)}',
      '.op-form-input.mono{font-family:var(--mono)}',
      '.op-form-actions{display:flex;gap:6px;justify-content:flex-end}',
      '.op-form-save{padding:5px 14px;background:var(--acc);border:none;border-radius:5px;color:#fff;font-size:11px;font-weight:700;cursor:pointer}',
      '.op-form-save:hover{opacity:.88}',
      '.op-form-cancel{padding:5px 12px;background:none;border:1px solid var(--bdr);border-radius:5px;color:var(--txt2);font-size:11px;cursor:pointer}',
      '.op-form-cancel:hover{color:var(--txt);border-color:var(--txt2)}',
      '.op-card{background:var(--el);border:1px solid var(--bdr);border-radius:6px;padding:9px 11px;margin-bottom:6px;transition:border-color .15s}',
      '.op-card:hover{border-color:var(--acc2)}',
      '.op-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}',
      '.op-code{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--acc)}',
      '.op-domicile{font-size:10px;color:var(--txt2);margin-left:8px}',
      '.op-card-actions{display:flex;gap:4px}',
      '.op-btn{background:none;border:none;cursor:pointer;font-size:10px;padding:2px 6px;border-radius:4px}',
      '.op-btn.edit{color:var(--acc2)}',
      '.op-btn.edit:hover{background:rgba(88,166,255,.1)}',
      '.op-btn.del{color:var(--red)}',
      '.op-btn.del:hover{background:rgba(248,81,73,.1)}',
      '.op-detail-row{font-size:10px;color:var(--txt2);line-height:1.7;word-break:break-all}',
      '.op-detail-row b{color:var(--txt3,var(--txt2));font-weight:600}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Form HTML builder ──────────────────────────────────────────────────────
  function _opFormHTML(op) {
    op = op || { code: '', domicile: '', to: '', cc: '', spUrl: '', atsUrl: '' };
    const isNew = _editIdx === null;
    return (
      '<div class="op-form" id="op-inline-form">'
      + '<div class="op-form-title">'
      +   '<span>' + (isNew ? '+ New Operator' : '✏️ Edit Operator') + '</span>'
      +   '<button class="op-form-cancel" onclick="window._acctBridge._closeOpForm()" style="padding:1px 8px">&#10005;</button>'
      + '</div>'
      + '<div class="op-form-grid">'

      + '<div class="op-form-row">'
      +   '<label class="op-form-label">Code *</label>'
      +   '<input id="opf-code" class="op-form-input mono" placeholder="e.g. SAPB" value="' + esc(op.code) + '" '
      +     'style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">'
      + '</div>'

      + '<div class="op-form-row">'
      +   '<label class="op-form-label">Domicile *</label>'
      +   '<input id="opf-domicile" class="op-form-input mono" placeholder="e.g. ABE40" value="' + esc(op.domicile) + '" '
      +     'style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">'
      + '</div>'

      + '<div class="op-form-row full">'
      +   '<label class="op-form-label">TO Recipients <span style="font-weight:400;text-transform:none;letter-spacing:0">(semicolon-separated)</span></label>'
      +   '<input id="opf-to" class="op-form-input" placeholder="user@amazon.com;user2@vendor.com" value="' + esc(op.to) + '">'
      + '</div>'

      + '<div class="op-form-row full">'
      +   '<label class="op-form-label">CC Recipients <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>'
      +   '<input id="opf-cc" class="op-form-input" placeholder="manager@amazon.com" value="' + esc(op.cc || '') + '">'
      + '</div>'

      + '<div class="op-form-row full">'
      +   '<label class="op-form-label">SharePoint URL <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>'
      +   '<input id="opf-sp" class="op-form-input" placeholder="https://amazon.sharepoint.com/..." value="' + esc(op.spUrl || '') + '">'
      + '</div>'

      + '<div class="op-form-row full">'
      +   '<label class="op-form-label">ATS URL <span style="font-weight:400;text-transform:none;letter-spacing:0">(opens in browser)</span></label>'
      +   '<input id="opf-ats" class="op-form-input" placeholder="https://aap-na.corp.amazon.com/v2/page/..." value="' + esc(op.atsUrl || '') + '">'
      + '</div>'

      + '</div>'  // end grid
      + '<div class="op-form-actions">'
      +   '<button class="op-form-cancel" onclick="window._acctBridge._closeOpForm()">Cancel</button>'
      +   '<button class="op-form-save" onclick="window._acctBridge._commitOpForm()">'
      +     (isNew ? 'Add Operator' : 'Save Changes')
      +   '</button>'
      + '</div>'
      + '</div>'
    );
  }

  // ── Card HTML builder ──────────────────────────────────────────────────────
  function _opCardHTML(op, i) {
    return (
      '<div class="op-card" id="op-card-' + i + '">'
      + '<div class="op-card-head">'
      +   '<span><span class="op-code">' + esc(op.code || '') + '</span>'
      +     '<span class="op-domicile">' + esc(op.domicile || '') + '</span>'
      +   '</span>'
      +   '<span class="op-card-actions">'
      +     '<button class="op-btn edit" onclick="window._acctBridge._editOperator(' + i + ')">✏️ Edit</button>'
      +     '<button class="op-btn del" onclick="window._acctBridge._removeOperator(' + i + ')">&#10005;</button>'
      +   '</span>'
      + '</div>'
      + (op.to ? '<div class="op-detail-row"><b>To:</b> ' + esc(op.to) + '</div>' : '')
      + (op.cc ? '<div class="op-detail-row"><b>CC:</b> ' + esc(op.cc) + '</div>' : '')
      + (op.spUrl ? '<div class="op-detail-row"><b>SP:</b> ' + esc(op.spUrl) + '</div>' : '')
      + (op.atsUrl
          ? '<div class="op-detail-row"><b>ATS:</b> '
            + '<a href="#" onclick="event.preventDefault();if(window.files&&window.files.openExternal){window.files.openExternal(' + JSON.stringify(op.atsUrl) + ');}" '
            + 'style="color:var(--acc);text-decoration:none;cursor:pointer;" title="Open ATS">Open ATS &rarr;</a></div>'
          : '')
      + '</div>'
    );
  }

  // ── Render operator list ───────────────────────────────────────────────────
  function renderOperators() {
    _injectOpStyles();
    const el = $('acct-op-list');
    if (!el) return;

    const cards = _operators.length
      ? _operators.map(_opCardHTML).join('')
      : '<div style="font-size:11px;color:var(--txt2);padding:4px 0">No operators configured.</div>';

    el.innerHTML = cards;
  }

  // ── Open form (Add or Edit) ────────────────────────────────────────────────
  function _openOpForm(idx) {
    _editIdx = (typeof idx === 'number') ? idx : null;
    const op = (_editIdx !== null) ? _operators[_editIdx] : null;

    // Remove existing form if open
    const existing = $('op-inline-form');
    if (existing) existing.remove();

    const el = $('acct-op-list');
    if (!el) return;

    // Insert form at top of the list div
    el.insertAdjacentHTML('afterbegin', _opFormHTML(op));

    // Focus the first empty required field
    const codeInp = $('opf-code');
    if (codeInp) {
      codeInp.focus();
      codeInp.select();
    }

    // Enter key on any input triggers save
    ['opf-code', 'opf-domicile', 'opf-to', 'opf-cc', 'opf-sp', 'opf-ats'].forEach(function (id) {
      const inp = $(id);
      if (inp) inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); _commitOpForm(); }
        if (e.key === 'Escape') { e.preventDefault(); _closeOpForm(); }
      });
    });
  }

  function _closeOpForm() {
    const form = $('op-inline-form');
    if (form) {
      form.style.transition = 'opacity .15s';
      form.style.opacity = '0';
      setTimeout(function () { if (form.parentNode) form.remove(); }, 150);
    }
    _editIdx = null;
  }

  async function _commitOpForm() {
    const code     = ($('opf-code')     || {}).value.trim().toUpperCase();
    const domicile = ($('opf-domicile') || {}).value.trim().toUpperCase();
    const to       = ($('opf-to')       || {}).value.trim();
    const cc       = ($('opf-cc')       || {}).value.trim();
    const spUrl    = ($('opf-sp')       || {}).value.trim();
    const atsUrl    = ($('opf-ats')       || {}).value.trim();

    if (!code) {
      const inp = $('opf-code');
      if (inp) { inp.style.borderColor = 'var(--red)'; inp.focus(); }
      toast('Operator code is required', 'warning');
      return;
    }
    if (!domicile) {
      const inp = $('opf-domicile');
      if (inp) { inp.style.borderColor = 'var(--red)'; inp.focus(); }
      toast('Domicile is required', 'warning');
      return;
    }

    const entry = { code, domicile, to, cc, spUrl, atsUrl };

    if (_editIdx !== null) {
      _operators[_editIdx] = entry;
    } else {
      _operators.push(entry);
    }

    _closeOpForm();
    renderOperators();
    await _saveOperators();
    toast(_editIdx !== null ? 'Operator updated' : 'Operator added');
  }

  // ── Public entry points ────────────────────────────────────────────────────
  function addOperator()      { _openOpForm(null); }
  function _editOperator(idx) { _openOpForm(idx);  }

  function _removeOperator(idx) {
    const op = _operators[idx];
    if (!op) return;

    // Inline confirmation — replace card with confirm row
    const card = $('op-card-' + idx);
    if (!card) return;

    const orig = card.innerHTML;
    card.innerHTML = (
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0">'
      + '<span style="font-size:11px;color:var(--txt)">Remove <b>' + esc(op.code) + '</b>?</span>'
      + '<span style="display:flex;gap:6px">'
      +   '<button onclick="window._acctBridge._confirmRemove(' + idx + ')" '
      +     'style="padding:4px 12px;background:var(--red);border:none;border-radius:5px;color:#fff;font-size:11px;font-weight:700;cursor:pointer">Remove</button>'
      +   '<button onclick="document.getElementById(\'op-card-' + idx + '\').innerHTML=' + "'" + orig.replace(/'/g, "\\'") + "'" + '" '
      +     'style="padding:4px 10px;background:none;border:1px solid var(--bdr);border-radius:5px;color:var(--txt2);font-size:11px;cursor:pointer">Cancel</button>'
      + '</span>'
      + '</div>'
    );
  }

  async function _confirmRemove(idx) {
    _operators.splice(idx, 1);
    renderOperators();
    await _saveOperators();
    toast('Operator removed');
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  async function loadOperatorsData() {
    if (window.settings && typeof window.settings.getOperators === 'function') {
      try {
        const r = await window.settings.getOperators();
        _operators = Array.isArray(r) ? r : [];
      } catch (_) { _operators = []; }
    } else if (typeof window.OPERATOR_CONFIG_DEFAULT !== 'undefined') {
      _operators = JSON.parse(JSON.stringify(window.OPERATOR_CONFIG_DEFAULT));
    } else {
      _operators = [];
    }
    renderOperators();
  }

  async function _saveOperators() {
    if (window.settings && typeof window.settings.saveOperators === 'function') {
      try { await window.settings.saveOperators(_operators); } catch (_) {}
    }
  }

  /* ── 5. Master refresh ───────────────────────────────────────────────────── */

  function refresh() {
    refreshAuthPills();
    refreshCredsList();
    loadDomicilesData();
    loadOperatorsData();
  }

  /* ── 6. Expose ───────────────────────────────────────────────────────────── */

  window._acctBridge = {
    refresh,
    addDomicile,
    addOperator,
    saveCredFromUI,
    _deleteCredKey,
    _removeDomicile,
    _editOperator,
    _removeOperator,
    _confirmRemove,
    _closeOpForm,
    _commitOpForm,
  };

  console.log('[acct-bridge] loaded v2 (inline forms)');

})();
