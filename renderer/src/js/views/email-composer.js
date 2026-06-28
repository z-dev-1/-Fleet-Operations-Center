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
import { email as emailBridge, settings as settingsBridge } from '../bridge.js';
import toast    from '../components/toast.js';

let _el        = null;
let _opEmails  = {};    // { 'OPERATOR': { to: '', cc: '' } }
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
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const date  = months[now.getMonth()] + ' ' + now.getDate();
  const label = slot === 'AM' ? 'SOS' : 'EOS';
  const site  = (domicile && domicile !== 'ALL') ? (' — ' + domicile) : '';
  return `${label} Fleet Report — ${op || 'ALL'}${site} — ${date}`;
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

// ── Op-email presets ──────────────────────────────────────────────────────
async function _loadPresets() {
  try {
    const data = await emailBridge.loadOpEmails();
    if (data && typeof data === 'object') _opEmails = data;
  } catch (_) {}
  _renderPresetList();
}

function _renderPresetList() {
  const el = _el2('ec-preset-list');
  if (!el) return;
  const keys = Object.keys(_opEmails);
  if (!keys.length) {
    el.innerHTML = '<span class="ec-empty">No presets saved.</span>';
    return;
  }
  el.innerHTML = keys.map(op => `
    <div class="ec-preset-row" data-op="${_safe(op)}">
      <span class="ec-preset-op">${_safe(op)}</span>
      <span class="ec-preset-addr">${_safe((_opEmails[op].to || '').slice(0, 48))}${(_opEmails[op].to || '').length > 48 ? '...' : ''}</span>
      <button class="ec-preset-load-btn" data-op="${_safe(op)}">Load</button>
      <button class="ec-preset-del-btn settings-btn--danger" data-op="${_safe(op)}">×</button>
    </div>`).join('');
}

function _wirePresets() {
  _el2('ec-preset-save').addEventListener('click', async () => {
    const op = (_el2('ec-operator').value || '').trim().toUpperCase();
    if (!op) { toast.show('warn', 'Select an operator first', 3000); return; }
    const to = (_el2('ec-to').value || '').trim();
    const cc = (_el2('ec-cc').value || '').trim();
    _opEmails[op] = { to, cc };
    try {
      await emailBridge.saveOpEmails(_opEmails);
      toast.show('success', 'Preset saved for ' + op, 2000);
      _renderPresetList();
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  _el2('ec-preset-load').addEventListener('click', () => {
    const op = (_el2('ec-operator').value || '').trim().toUpperCase();
    if (!op) { toast.show('warn', 'Select an operator first', 3000); return; }
    _applyPreset(op);
  });

  // Delegation for load/delete in preset list
  _el2('ec-preset-list').addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('.ec-preset-load-btn');
    const delBtn  = e.target.closest('.ec-preset-del-btn');
    if (loadBtn) {
      _applyPreset(loadBtn.dataset.op);
    } else if (delBtn) {
      const op = delBtn.dataset.op;
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

function _applyPreset(op) {
  const preset = _opEmails[op];
  if (!preset) { toast.show('info', 'No preset for ' + op, 2000); return; }
  const toEl = _el2('ec-to');
  const ccEl = _el2('ec-cc');
  if (toEl) toEl.value = preset.to || '';
  if (ccEl) ccEl.value = preset.cc || '';
  // Also set operator select
  const opSel = _el2('ec-operator');
  if (opSel) {
    const opt = Array.from(opSel.options).find(o => o.value.toUpperCase() === op.toUpperCase());
    if (opt) opSel.value = opt.value;
  }
  _updateSubject();
  _updateUnitCount();
  toast.show('success', 'Preset loaded: ' + op, 2000);
}

// ── Subject auto-build ────────────────────────────────────────────────────
function _currentSlotValue() {
  const amBtn = _el2('ec-slot-am');
  return (amBtn && amBtn.classList.contains('ec-slot-btn--active')) ? 'AM' : 'PM';
}

function _updateSubject() {
  const subEl = _el2('ec-subject');
  if (!subEl) return;
  const op  = (_el2('ec-operator').value || '').trim();
  const dom = (_el2('ec-domicile').value || 'ALL').trim();
  const slot = _currentSlotValue();
  subEl.value = _buildSubject(op, slot, dom);
}

// ── Unit count indicator ──────────────────────────────────────────────────
function _updateUnitCount() {
  const countEl = _el2('ec-unit-count');
  if (!countEl) return;
  const rows = state.slice('fleet').rows || [];
  const op   = (_el2('ec-operator').value || '').trim().toUpperCase();
  const dom  = (_el2('ec-domicile').value || 'ALL').trim().toUpperCase();
  if (!op) { countEl.textContent = '—'; return; }
  const matching = rows.filter(r => {
    const rowOp  = (r.op || r.operator || '').toUpperCase();
    const rowDom = (r.site || r.domicileSite || '').toUpperCase();
    if (rowOp !== op) return false;
    if (dom && dom !== 'ALL' && rowDom !== dom) return false;
    return true;
  });
  countEl.textContent = matching.length + ' unit' + (matching.length !== 1 ? 's' : '');
}

// ── Status helpers ────────────────────────────────────────────────────────
function _setStatus(type, text) {
  const el = _el2('ec-status-badge');
  if (!el) return;
  el.className = 'ec-status-badge ec-status-badge--' + type;
  el.textContent = text;
}

function _logLine(msg) {
  const wrap = _el2('ec-log-wrap');
  const log  = _el2('ec-log');
  if (!log) return;
  if (wrap) wrap.style.display = '';
  const line = document.createElement('div');
  line.className = 'ec-log-line';
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ── Build payload ─────────────────────────────────────────────────────────
function _buildPayload() {
  return {
    to:        (_el2('ec-to').value      || '').trim(),
    cc:        (_el2('ec-cc').value      || '').trim(),
    subject:   (_el2('ec-subject').value || '').trim(),
    operator:  (_el2('ec-operator').value || '').trim().toUpperCase(),
    domicile:  (_el2('ec-domicile').value || 'ALL').trim().toUpperCase(),
    slot:      _currentSlotValue(),
    emailNote: (_el2('ec-note').value    || '').trim() || null,
    testMode:  _el2('ec-test-mode').checked,
  };
}

function _validatePayload(p) {
  if (!p.operator) return 'Select an operator';
  if (!p.to)       return 'Enter at least one To address';
  return null;
}

// ── Wire: slot buttons ────────────────────────────────────────────────────
function _wireSlot() {
  const amBtn = _el2('ec-slot-am');
  const pmBtn = _el2('ec-slot-pm');
  function activate(active, inactive) {
    active.classList.add('ec-slot-btn--active');
    inactive.classList.remove('ec-slot-btn--active');
    _updateSubject();
  }
  amBtn.addEventListener('click', () => activate(amBtn, pmBtn));
  pmBtn.addEventListener('click', () => activate(pmBtn, amBtn));
}

// ── Wire: scope changes ───────────────────────────────────────────────────
function _wireScope() {
  _el2('ec-operator').addEventListener('change', () => { _updateSubject(); _updateUnitCount(); });
  _el2('ec-domicile').addEventListener('change', () => { _updateSubject(); _updateUnitCount(); });
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
