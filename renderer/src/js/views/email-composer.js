/**
 * email-composer.js — Fleet email composer view (Stage 12)
 *
 * Sections:
 *   - Operator + Domicile select (from fleet state + saved domiciles)
 *   - Slot toggle AM / PM (auto-detected from current hour)
 *   - Recipients To / CC (loaded/saved from op-email presets)
 *   - Subject (auto-built, editable)
 *   - Email note (optional red-banner text injected into template)
 *   - Test mode toggle (routes to dev email)
 *   - Preview HTML → email.preview()
 *   - Compose → email.compose() (builds HTML → OWA inject)
 *   - Op-email presets (save/load per-operator recipients)
 *
 * IPC surface used:
 *   email.compose(payload)       → email:compose
 *   email.preview(opts)          → email:preview
 *   email.send(opts)             → email:send  (SMTP fallback)
 *   email.composeOWA(payload)    → email:compose  (same channel)
 *   email.saveOpEmails(data)     → email:save-op-emails
 *   email.loadOpEmails()         → email:load-op-emails
 *   settings.getDomiciles()
 */

import bus      from '../bus.js';
import state    from '../state.js';
import { email as emailBridge, settings as settingsBridge, sp as spBridge } from '../bridge.js';
import toast    from '../components/toast.js';

let _el        = null;
let _opEmails  = {};    // { 'OPERATOR': { to: '', cc: '' } }
let _spEmails  = {};    // { 'OpName__DOMCODE': { to: '', cc: '' } }  — from spConfig.emails
let _domiciles = [];    // ['ABE40', 'PHL40', ...]
let _operators = [];    // derived from fleet rows
// ── Helpers ────────────────────────────────────────────────────────────────
const _el2 = (id) => document.getElementById(id);
const _safe = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function _currentSlot() {
  const h = new Date().getHours();
  return h < 14 ? 'AM' : 'PM';
}

function _buildSubject(op, slot, domicile) {
  const now   = new Date();
  const shift = slot === 'AM' ? 'AM' : 'PM';

  // v2-aligned: [ABE40 · AZNG] Fleet Maintenance Report - 06/30/2026 PM
  const dateStr = (now.getMonth()+1).toString().padStart(2,'0') + '/'
                + now.getDate().toString().padStart(2,'0') + '/'
                + now.getFullYear();

  const opPart  = (op || '').trim().toUpperCase();
  const domPart = (domicile && domicile !== 'ALL') ? domicile.trim().toUpperCase() : '';

  let bracket = '';
  if (domPart && opPart) bracket = `[${domPart} \u00b7 ${opPart}] `;
  else if (opPart)       bracket = `[${opPart}] `;
  else if (domPart)      bracket = `[${domPart}] `;

  return `${bracket}Fleet Maintenance Report  -  ${dateStr} ${shift}`;
}

function _opOptions() {
  const opts = _operators.map(op =>
    `<option value="${_safe(op)}">${_safe(op)}</option>`
  ).join('');
  return `<option value="">-- Select operator --</option>${opts}`;
}

function _domOptions() {
  const opts = _domiciles.map(d =>
    `<option value="${_safe(d)}">${_safe(d)}</option>`
  ).join('');
  return `<option value="ALL">ALL (no filter)</option>${opts}`;
}

// ── HTML ───────────────────────────────────────────────────────────────────
function _html() {
  return `
    <div class="ec-wrap">

      <!-- Header -->
      <div class="ec-header">
        <div class="ec-header__left">
          <span class="ec-title">Email Composer</span>
          <span class="ec-subtitle">Build &amp; send fleet status reports</span>
        </div>
        <button id="ec-back" class="detail-panel__btn">Back to Fleet</button>
      </div>

      <!-- Two-panel layout: form left, status right -->
      <div class="ec-body">

        <!-- ── LEFT: compose form ── -->
        <div class="ec-form">

          <!-- Operator + Domicile -->
          <div class="ec-section">
            <div class="ec-section__title">Report Scope</div>
            <div class="ec-two-col">
              <label class="settings-label">Operator
                <select id="ec-operator" class="settings__select ec-select">
                  ${_opOptions()}
                </select>
              </label>
              <label class="settings-label">Domicile
                <select id="ec-domicile" class="settings__select ec-select">
                  ${_domOptions()}
                </select>
              </label>
            </div>
          </div>

          <!-- Slot toggle -->
          <div class="ec-section">
            <div class="ec-section__title">Slot</div>
            <div class="ec-slot-row">
              <button id="ec-slot-am" class="ec-slot-btn ${_currentSlot() === 'AM' ? 'ec-slot-btn--active' : ''}" data-slot="AM">
                ☀ AM — SOS Report
              </button>
              <button id="ec-slot-pm" class="ec-slot-btn ${_currentSlot() === 'PM' ? 'ec-slot-btn--active' : ''}" data-slot="PM">
                🌆 PM — EOS Report
              </button>
            </div>
          </div>

          <!-- Recipients -->
          <div class="ec-section">
            <div class="ec-section__title">
              Recipients
              <div class="ec-preset-controls">
                <button id="ec-preset-load"  class="ec-preset-btn">Load preset</button>
                <button id="ec-preset-save"  class="ec-preset-btn">Save preset</button>
              </div>
            </div>
            <label class="settings-label">To
              <input id="ec-to" class="settings__input" type="text"
                placeholder="recipient@amazon.com; other@amazon.com" />
            </label>
            <label class="settings-label" style="margin-top:6px">CC
              <input id="ec-cc" class="settings__input" type="text"
                placeholder="manager@amazon.com" />
            </label>
          </div>

          <!-- Subject -->
          <div class="ec-section">
            <div class="ec-section__title">Subject</div>
            <div class="ec-subject-row">
              <input id="ec-subject" class="settings__input ec-subject-input" type="text"
                placeholder="Auto-generated subject..." />
              <button id="ec-subject-reset" class="ec-icon-btn" title="Reset to auto-generated">↺</button>
            </div>
          </div>

          <!-- Email note -->
          <div class="ec-section">
            <div class="ec-section__title">
              Email Note
              <span class="ec-section__hint">Shown as a red banner at top of email</span>
            </div>
            <textarea id="ec-note" class="settings__textarea" rows="2"
              placeholder="Optional — e.g. 'Units at EWR45 excluded due to site freeze'"></textarea>
          </div>

          <!-- Options row -->
          <div class="ec-section">
            <div class="ec-section__title">Options</div>
            <div class="ec-options-row">
              <label class="settings-label settings-label--inline">
                <input id="ec-test-mode" type="checkbox" />
                Test mode — routes to dev email only
              </label>
            </div>
          </div>

          <!-- Actions -->
          <div class="ec-actions">
            <button id="ec-preview"  class="detail-panel__btn detail-panel__btn--secondary">Preview HTML</button>
            <button id="ec-compose"  class="detail-panel__btn ec-compose-btn">Compose in OWA</button>
            <button id="ec-send-smtp" class="detail-panel__btn detail-panel__btn--secondary" title="Send via SMTP (requires email config in Settings)">Send via SMTP</button>
          </div>

        </div><!-- /ec-form -->

        <!-- ── RIGHT: status + log ── -->
        <div class="ec-status-panel">

          <div class="ec-section__title">Status</div>

          <div id="ec-status-badge" class="ec-status-badge ec-status-badge--idle">Idle</div>

          <div id="ec-log-wrap" class="ec-log-wrap" style="display:none">
            <div id="ec-log" class="ec-log"></div>
          </div>

          <div id="ec-result" class="ec-result" style="display:none"></div>

          <!-- Preset list -->
          <div class="ec-preset-list-wrap">
            <div class="ec-section__title" style="margin-top:16px">Saved presets</div>
            <div id="ec-preset-list" class="ec-preset-list">
              <span class="ec-empty">No presets saved.</span>
            </div>
          </div>

          <!-- Unit count indicator -->
          <div class="ec-unit-count-wrap">
            <div class="ec-section__title" style="margin-top:16px">Matching units</div>
            <div id="ec-unit-count" class="ec-unit-count">—</div>
          </div>

        </div><!-- /ec-status-panel -->

      </div><!-- /ec-body -->

    </div>
  `;
}

// ── Load operators from fleet state ───────────────────────────────────────
function _refreshOperators() {
  const rows = state.slice('fleet').rows || [];
  const ops  = [...new Set(rows.map(r => (r.op || r.operator || '')).filter(Boolean).map(o => o.toUpperCase()))].sort();
  _operators = ops;
}

// ── Load domiciles from settings ──────────────────────────────────────────
async function _loadDomiciles() {
  try {
    const d = await settingsBridge.getDomiciles();
    if (Array.isArray(d)) _domiciles = d;
  } catch (_) {}
}

// ── Op-email presets ─────────────────────────────────────────────────────────
// Source of truth is spConfig.emails (keyed "Op__DOM") saved from Settings.
// Legacy per-operator presets (_opEmails) are kept as fallback only.

async function _loadPresets() {
  try {
    const data = await emailBridge.loadOpEmails();
    if (data && typeof data === 'object') _opEmails = data;
  } catch (_) {}
  // spEmails already loaded by _loadSpEmails() called in init
  _renderPresetList();
}

function _renderPresetList() {
  const el = _el2('ec-preset-list');
  if (!el) return;

  // Build combined list: sp presets (Op__DOM) first, then legacy (Op-only)
  const spKeys     = Object.keys(_spEmails).filter(k => _spEmails[k]?.to);
  const legacyKeys = Object.keys(_opEmails).filter(k => !spKeys.some(s => s.startsWith(k + '__')));

  if (!spKeys.length && !legacyKeys.length) {
    el.innerHTML = '<span class="ec-empty">No presets — save email recipients in Settings → Operators.</span>';
    return;
  }

  const spRows = spKeys.map(key => {
    const [opPart, domPart] = key.split('__');
    const preset = _spEmails[key];
    const label  = domPart ? `${_safe(opPart)} · ${_safe(domPart)}` : _safe(opPart);
    const addr   = (preset.to || '').slice(0, 44) + ((preset.to || '').length > 44 ? '...' : '');
    return `<div class="ec-preset-row" data-key="${_safe(key)}" data-type="sp">
      <span class="ec-preset-op">${label}</span>
      <span class="ec-preset-addr">${_safe(addr)}</span>
      <button class="ec-preset-load-btn" data-key="${_safe(key)}" data-type="sp">Load</button>
    </div>`;
  });

  const legacyRows = legacyKeys.map(op => {
    const preset = _opEmails[op];
    const addr   = (preset.to || '').slice(0, 44) + ((preset.to || '').length > 44 ? '...' : '');
    return `<div class="ec-preset-row" data-key="${_safe(op)}" data-type="legacy">
      <span class="ec-preset-op">${_safe(op)}</span>
      <span class="ec-preset-addr">${_safe(addr)}</span>
      <button class="ec-preset-load-btn" data-key="${_safe(op)}" data-type="legacy">Load</button>
      <button class="ec-preset-del-btn settings-btn--danger" data-key="${_safe(op)}">×</button>
    </div>`;
  });

  el.innerHTML = [
    spKeys.length     ? `<div class="ec-preset-group-label">From Settings</div>` : '',
    ...spRows,
    legacyKeys.length ? `<div class="ec-preset-group-label">Saved presets</div>` : '',
    ...legacyRows,
  ].join('');
}

function _wirePresets() {
  // "Save preset" — writes to legacy store (op-only key) AND to spConfig.emails (Op__DOM)
  _el2('ec-preset-save').addEventListener('click', async () => {
    const op  = (_el2('ec-operator').value || '').trim().toUpperCase();
    const dom = (_el2('ec-domicile').value || '').trim().toUpperCase();
    if (!op) { toast.show('warn', 'Select an operator first', 3000); return; }
    const to = (_el2('ec-to').value || '').trim();
    const cc = (_el2('ec-cc').value || '').trim();

    // Write to legacy store
    _opEmails[op] = { to, cc };
    try { await emailBridge.saveOpEmails(_opEmails); } catch (_) {}

    // Write to spConfig.emails under Op__DOM key (if domicile is set)
    if (dom && dom !== 'ALL') {
      try {
        const existing = await spBridge.getConfig().catch(() => ({})) || {};
        const emails   = existing.emails || {};
        const key      = `${op}__${dom}`;
        emails[key]    = { to, cc };
        await spBridge.saveConfig({ ...existing, emails });
        _spEmails = emails;
      } catch (_) {}
    }

    toast.show('success', `Preset saved — ${op}${dom && dom !== 'ALL' ? ' · ' + dom : ''}`, 2500);
    _renderPresetList();
  });

  // "Load preset" button (header shortcut — loads for currently selected op)
  _el2('ec-preset-load').addEventListener('click', () => {
    const op  = (_el2('ec-operator').value || '').trim().toUpperCase();
    const dom = (_el2('ec-domicile').value || '').trim().toUpperCase();
    if (!op) { toast.show('warn', 'Select an operator first', 3000); return; }
    // Try sp key first, fall back to legacy
    const spKey = dom && dom !== 'ALL' ? `${op}__${dom}` : null;
    if (spKey && _spEmails[spKey]) { _applyPreset(spKey, 'sp'); }
    else { _applyPreset(op, 'legacy'); }
  });

  // Delegated clicks on preset list rows
  _el2('ec-preset-list').addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('.ec-preset-load-btn');
    const delBtn  = e.target.closest('.ec-preset-del-btn');
    if (loadBtn) {
      _applyPreset(loadBtn.dataset.key, loadBtn.dataset.type);
    } else if (delBtn) {
      const op = delBtn.dataset.key;
      delete _opEmails[op];
      try {
        await emailBridge.saveOpEmails(_opEmails);
        _renderPresetList();
        toast.show('info', 'Preset deleted: ' + op, 2000);
      } catch (e) {
        toast.show('error', 'Delete failed: ' + e.message);
      }
    }
  });
}

function _applyPreset(key, type) {
  let preset, opCode, domCode;

  if (type === 'sp') {
    preset = _spEmails[key];
    const parts = key.split('__');
    opCode  = parts[0] || '';
    domCode = parts[1] || '';
  } else {
    preset = _opEmails[key];
    opCode  = key;
    domCode = '';
  }

  if (!preset) { toast.show('info', 'No preset for ' + key, 2000); return; }

  const toEl  = _el2('ec-to');
  const ccEl  = _el2('ec-cc');
  if (toEl) toEl.value = preset.to || '';
  if (ccEl) ccEl.value = preset.cc || '';

  // Set operator select
  const opSel = _el2('ec-operator');
  if (opSel && opCode) {
    const opt = Array.from(opSel.options).find(o => o.value.toUpperCase() === opCode.toUpperCase());
    if (opt) opSel.value = opt.value;
  }

  // Set domicile select (sp presets only)
  const domSel = _el2('ec-domicile');
  if (domSel && domCode && domCode !== 'ALL') {
    const opt = Array.from(domSel.options).find(o => o.value.toUpperCase() === domCode.toUpperCase());
    if (opt) domSel.value = opt.value;
  }

  _updateSubject();
  _updateUnitCount();
  const label = domCode ? `${opCode} · ${domCode}` : opCode;
  toast.show('success', 'Loaded: ' + label, 2000);
}

// ── Subject auto-build (v2-aligned format) ───────────────────────────────────
function _currentSlotValue() {
  const amBtn = _el2('ec-slot-am');
  return (amBtn && amBtn.classList.contains('ec-slot-btn--active')) ? 'AM' : 'PM';
}

// ── Load spConfig.emails into _spEmails ──────────────────────────────────────
async function _loadSpEmails() {
  try {
    const cfg = await spBridge.getConfig();
    _spEmails = cfg?.emails || {};
  } catch (err) {
    console.warn('[email-composer] _loadSpEmails failed:', err);
    _spEmails = {};
  }
}

// ── Auto-fill To/CC from spConfig.emails ─────────────────────────────────────
function _autoFillRecipients() {
  const op  = (_el2('ec-operator')?.value || '').toUpperCase().trim();
  const dom = (_el2('ec-domicile')?.value || '').trim();
  if (!op) return;

  // Try Op__DOM first, then Op__ALL, then first sp preset for this operator
  const key     = dom && dom !== 'ALL' ? `${op}__${dom}` : null;
  const anyKey  = Object.keys(_spEmails).find(k => k.startsWith(op + '__'));
  const preset  = (key && _spEmails[key]) || (anyKey && _spEmails[anyKey]) || _opEmails[op];
  if (!preset) return;

  const toField = _el2('ec-to');
  const ccField = _el2('ec-cc');
  const toEmpty = !toField?.value?.trim();
  const ccEmpty = !ccField?.value?.trim();
  if (toEmpty && preset.to) toField.value = preset.to;
  if (ccEmpty && preset.cc) ccField.value = preset.cc;
}


// ── Wire: subject reset ───────────────────────────────────────────────────
function _wireSubjectReset() {
  _el2('ec-subject-reset').addEventListener('click', () => _updateSubject());
}

// ── Wire: preview ─────────────────────────────────────────────────────────
function _wirePreview() {
  _el2('ec-preview').addEventListener('click', async () => {
    const p = _buildPayload();
    const err = _validatePayload(p);
    if (err) { toast.show('warn', err, 3000); return; }
    const btn = _el2('ec-preview');
    btn.disabled = true; btn.textContent = 'Building...';
    _setStatus('loading', 'Building preview...');
    try {
      const result = await emailBridge.compose(p);
      if (result && result.success === false) {
        toast.show('error', 'Build failed: ' + (result.error || 'unknown'), 5000);
        _setStatus('error', 'Build failed');
      } else {
        // compose opens OWA; for preview we call email.preview with the payload
        // The main process builds HTML via buildEmail and opens a preview window
        await emailBridge.preview(p);
        _setStatus('ok', 'Preview opened');
        toast.show('info', 'Preview window opened', 2000);
      }
    } catch (e) {
      toast.show('error', 'Preview failed: ' + e.message);
      _setStatus('error', 'Preview failed');
    } finally {
      btn.disabled = false; btn.textContent = 'Preview HTML';
    }
  });
}

// ── Wire: compose (OWA) ───────────────────────────────────────────────────
function _wireCompose() {
  _el2('ec-compose').addEventListener('click', async () => {
    const p   = _buildPayload();
    const err = _validatePayload(p);
    if (err) { toast.show('warn', err, 3000); return; }

    const btn      = _el2('ec-compose');
    const smtpBtn  = _el2('ec-send-smtp');
    btn.disabled   = true; btn.textContent = 'Composing...';
    smtpBtn.disabled = true;

    _setStatus('loading', 'Building email...');
    _el2('ec-log-wrap').style.display = '';
    _el2('ec-log').innerHTML = '';
    _el2('ec-result').style.display = 'none';

    _logLine('Building HTML from template...');

    try {
      const result = await emailBridge.compose(p);
      if (result && result.success === false) {
        const msg = result.error || 'Compose failed';
        _logLine('✗ ' + msg);
        _setStatus('error', 'Failed');
        _el2('ec-result').innerHTML = `<div class="ec-result--error"><span class="ec-result__icon">✗</span> ${_safe(msg)}</div>`;
        _el2('ec-result').style.display = '';
        toast.show('error', msg, 5000);
      } else {
        _logLine('✓ OWA compose window opened — paste in progress...');
        _setStatus('ok', 'OWA window opened');
        _el2('ec-result').innerHTML = `<div class="ec-result--success"><span class="ec-result__icon">✓</span> Email composed in OWA — review and send.</div>`;
        _el2('ec-result').style.display = '';
        toast.show('success', 'OWA compose window opened', 4000);
      }
    } catch (e) {
      _logLine('✗ Error: ' + e.message);
      _setStatus('error', 'Error');
      toast.show('error', 'Compose failed: ' + e.message);
    } finally {
      btn.disabled     = false; btn.textContent = 'Compose in OWA';
      smtpBtn.disabled = false;
    }
  });
}

// ── Wire: send via SMTP ───────────────────────────────────────────────────
function _wireSMTP() {
  _el2('ec-send-smtp').addEventListener('click', async () => {
    const p   = _buildPayload();
    const err = _validatePayload(p);
    if (err) { toast.show('warn', err, 3000); return; }

    const btn   = _el2('ec-send-smtp');
    const owaBtn = _el2('ec-compose');
    btn.disabled = true; btn.textContent = 'Sending...';
    owaBtn.disabled = true;

    _setStatus('loading', 'Sending via SMTP...');
    _el2('ec-log-wrap').style.display = '';
    _el2('ec-log').innerHTML = '';
    _el2('ec-result').style.display = 'none';
    _logLine('Sending via SMTP...');

    try {
      const result = await emailBridge.send({
        to:      p.to,
        cc:      p.cc,
        subject: p.subject,
        // Pass full compose payload so main can build HTML body
        composePayload: p,
      });
      if (result && result.ok) {
        _logLine('✓ Sent successfully');
        _setStatus('ok', 'Sent');
        _el2('ec-result').innerHTML = `<div class="ec-result--success"><span class="ec-result__icon">✓</span> Email sent via SMTP.</div>`;
        _el2('ec-result').style.display = '';
        toast.show('success', 'Email sent', 4000);
      } else {
        const msg = (result && result.error) || 'SMTP send failed';
        _logLine('✗ ' + msg);
        _setStatus('error', 'Failed');
        _el2('ec-result').innerHTML = `<div class="ec-result--error"><span class="ec-result__icon">✗</span> ${_safe(msg)}</div>`;
        _el2('ec-result').style.display = '';
        toast.show('error', msg, 5000);
      }
    } catch (e) {
      _logLine('✗ Error: ' + e.message);
      _setStatus('error', 'Error');
      toast.show('error', 'SMTP failed: ' + e.message);
    } finally {
      btn.disabled  = false; btn.textContent = 'Send via SMTP';
      owaBtn.disabled = false;
    }
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
export async function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-email-composer';
  _el.className = 'view view--email-composer';
  _el.style.display = 'none';

  // Pre-load data before inserting HTML so selects are populated
  await _loadDomiciles();
  _refreshOperators();

  _el.innerHTML = _html();
  container.appendChild(_el);

  // Back button
  _el2('ec-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'email-composer', to: 'fleet' });
  });

  // Wire all interactions
  _wireSlot();
  _wireScope();
  _wireSubjectReset();
  _wirePresets();
  _wirePreview();
  _wireCompose();
  _wireSMTP();

  // Load presets from disk
  await _loadPresets();
  await _loadSpEmails();

  // Initial subject + count
  _updateSubject();
  _updateUnitCount();

  // Refresh operators when fleet data changes
  bus.on('fleet:data', () => {
    _refreshOperators();
    // Re-render operator options if visible
    const opSel = _el2('ec-operator');
    if (opSel) {
      const current = opSel.value;
      opSel.innerHTML = _opOptions();
      if (current) opSel.value = current;
    }
    _updateUnitCount();
  });

  // Show/hide based on view
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'email-composer' ? 'flex' : 'none';
    if (to === 'email-composer') {
      _refreshOperators();
      _updateUnitCount();
    }
  });
}
