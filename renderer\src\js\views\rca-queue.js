/**
 * rca-queue.js — RCA-Ready Queue (Stage 28)
 *
 * Port of V2's RcaReadyModule — tracks units needing Root Cause Analysis.
 * Detects transitions to unavailable, queues them for code assignment.
 *
 * Features:
 *   - Auto-detects units that transition to unavailable
 *   - Queue list with unit ID, operator, site, reason, duration, vendor
 *   - Click to select → detail panel with RCA code selectors
 *   - Primary Component, Failure Code, Cause Code, Work Accomplished
 *   - Maintenance code + Controllable flag
 *   - Save/load from localStorage
 *   - Filter by operator
 *   - Badge count in toolbar
 */

import bus   from '../bus.js';
import state from '../state.js';
import toast from '../components/toast.js';
import { vendor } from '../vendor-bridge.js';

// ── Storage ─────────────────────────────────────────────────────────────────
const STORE_KEY = 'fleet_rca_queue_v1';
function _load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (_) { return []; } }
function _save(items) { try { localStorage.setItem(STORE_KEY, JSON.stringify(items)); } catch (_) {} }

// ── RCA Code Options ────────────────────────────────────────────────────────
const PRIMARY_COMPONENTS = [
  'Engine/Motor Systems',
  'Chassis',
  'Electrical',
  'Cab, Climate Control, Instrumentation',
  'Accessories',
  'Tires/Wheels',
  'Brakes',
  'Transmission/Drivetrain',
  'Exhaust/Aftertreatment',
  'Suspension',
  'Cooling System',
  'Fuel System',
  'Body/Frame',
];

const FAILURE_CODES = [
  'Normal wear', 'Defective part', 'Improper previous repair',
  'Driver abuse', 'Road hazard', 'Environmental',
  'Design/manufacturing defect', 'Improper maintenance',
  'Corrosion/contamination', 'Overloading', 'Unknown',
];

const CAUSE_CODES = [
  'Age/mileage', 'Defective part/material', 'Driver error',
  'Improper maintenance', 'Road conditions', 'Weather/environment',
  'Design flaw', 'Installation error', 'Contamination', 'Unknown',
];

const WORK_CODES = [
  'Replaced', 'Repaired', 'Adjusted', 'Cleaned', 'Lubricated',
  'Welded', 'Recharged', 'Reflashed/reprogrammed', 'Tightened',
  'Inspected (no action)', 'Pending parts', 'Deferred',
];

// ── State ───────────────────────────────────────────────────────────────────
let _el = null;
let _items = _load();
let _selectedId = null;
let _filterOp = '';
let _previousStates = {};  // { equipmentId: lifecycleState } — for transition detection

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Transition Detection ────────────────────────────────────────────────────
function _detectTransitions(rows) {
  let added = 0;
  for (const row of rows) {
    const id = row.equipmentId;
    if (!id) continue;
    const prev = _previousStates[id] || '';
    const curr = (row.lifecycleState || '').toLowerCase();
    _previousStates[id] = curr;

    // Detect: was NOT unavailable, now IS unavailable
    if (!prev.includes('unavail') && curr.includes('unavail')) {
      // Check if already in queue
      if (!_items.find(i => i.equipmentId === id)) {
        _items.push({
          equipmentId: id,
          operator: row.operator || '',
          domicileSite: row.domicileSite || '',
          lifecycleReason: row.lifecycleReason || '',
          vendor: row.vendor || '',
          duration: row.duration || row.workDuration || '',
          addedAt: new Date().toISOString(),
          // RCA fields (user fills these)
          primaryComponent: '',
          failureCode: '',
          causeCode: '',
          workCode: '',
          maintenanceCode: '',
          controllable: '',
          notes: '',
          completed: false,
        });
        added++;
      }
    }
  }
  if (added > 0) {
    _save(_items);
    _render();
    bus.emit('rca:count-update', { count: _items.filter(i => !i.completed).length });
  }
}

// ── Render ──────────────────────────────────────────────────────────────────
function _render() {
  if (!_el) return;
  const pending = _items.filter(i => !i.completed);
  const filtered = _filterOp
    ? pending.filter(i => (i.operator || '').toUpperCase().includes(_filterOp.toUpperCase()))
    : pending;

  // Get unique operators for filter
  const ops = [...new Set(pending.map(i => i.operator).filter(Boolean))].sort();

  _el.innerHTML = `
    <div class="rca-wrap">
      <div class="rca-header">
        <div class="rca-header__left">
          <span class="rca-title">🔬 RCA-Ready Queue</span>
          <span class="rca-badge">${pending.length}</span>
        </div>
        <div class="rca-header__right">
          <select id="rca-op-filter" class="rca-filter-select">
            <option value="">All Operators</option>
            ${ops.map(op => '<option value="' + _esc(op) + '"' + (_filterOp === op ? ' selected' : '') + '>' + _esc(op) + '</option>').join('')}
          </select>
          <button id="rca-clear-done" class="rca-btn rca-btn--ghost">Clear Completed</button>
        </div>
      </div>

      <div class="rca-body">
        <div class="rca-list" id="rca-list">
          ${filtered.length === 0
            ? '<div class="rca-empty">No units awaiting RCA. Units will appear here when they transition to Unavailable.</div>'
            : filtered.map(item => _renderItem(item)).join('')
          }
        </div>
        <div class="rca-detail" id="rca-detail">
          ${_selectedId ? _renderDetail(_items.find(i => i.equipmentId === _selectedId)) : '<div class="rca-empty">Select a unit to assign RCA codes</div>'}
        </div>
      </div>
    </div>
  `;

  _wireEvents();
}

function _renderItem(item) {
  const isSelected = item.equipmentId === _selectedId;
  const hasCodes = !!(item.primaryComponent || item.failureCode);
  return `
    <div class="rca-item${isSelected ? ' rca-item--active' : ''}${hasCodes ? ' rca-item--coded' : ''}" data-id="${_esc(item.equipmentId)}">
      <div class="rca-item__dot${hasCodes ? ' rca-item__dot--done' : ''}"></div>
      <div class="rca-item__body">
        <div class="rca-item__id">${_esc(item.equipmentId)}</div>
        <div class="rca-item__meta">${_esc(item.operator)} · ${_esc(item.domicileSite)} · ${_esc(item.lifecycleReason || 'Unavailable')}</div>
        ${item.vendor ? '<div class="rca-item__vendor">' + _esc(item.vendor) + '</div>' : ''}
      </div>
      <div class="rca-item__right">
        ${item.duration && item.duration !== '--' ? '<span class="rca-item__dur">' + _esc(item.duration) + '</span>' : ''}
        ${hasCodes ? '<span class="rca-item__check">✓</span>' : ''}
      </div>
    </div>
  `;
}

function _renderDetail(item) {
  if (!item) return '<div class="rca-empty">Select a unit to assign RCA codes</div>';
  return `
    <div class="rca-detail-inner">
      <div class="rca-detail__header">
        <span class="rca-detail__id">${_esc(item.equipmentId)}</span>
        <span class="rca-detail__meta">${_esc(item.operator)} · ${_esc(item.domicileSite)}</span>
      </div>
      <div class="rca-detail__info">
        <div class="rca-detail__row"><span class="rca-detail__lbl">Reason:</span> <span>${_esc(item.lifecycleReason || '--')}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Vendor:</span> <span>${_esc(item.vendor || '--')}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Duration:</span> <span>${_esc(item.duration || '--')}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Added:</span> <span>${_fmtDate(item.addedAt)}</span></div>
      </div>

      <div class="rca-detail__section-title">
        Root Cause Analysis
        <button id="rca-ai-suggest" class="rca-btn rca-btn--accent" style="margin-left:auto;font-size:11px;padding:3px 10px" title="AI-infer RCA codes from lifecycle reason">⚡ Auto-detect</button>
      </div>
      <div id="rca-ai-hints" class="rca-ai-hints" style="display:none"></div>
      <div class="rca-field">
        <label class="rca-field__label">Primary Component</label>
        <select class="rca-field__select" data-field="primaryComponent">
          <option value="">— Select —</option>
          ${PRIMARY_COMPONENTS.map(c => '<option value="' + _esc(c) + '"' + (item.primaryComponent === c ? ' selected' : '') + '>' + _esc(c) + '</option>').join('')}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Technician Failure Code</label>
        <select class="rca-field__select" data-field="failureCode">
          <option value="">— Select —</option>
          ${FAILURE_CODES.map(c => '<option value="' + _esc(c) + '"' + (item.failureCode === c ? ' selected' : '') + '>' + _esc(c) + '</option>').join('')}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Primary Cause Code</label>
        <select class="rca-field__select" data-field="causeCode">
          <option value="">— Select —</option>
          ${CAUSE_CODES.map(c => '<option value="' + _esc(c) + '"' + (item.causeCode === c ? ' selected' : '') + '>' + _esc(c) + '</option>').join('')}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Work Accomplished</label>
        <select class="rca-field__select" data-field="workCode">
          <option value="">— Select —</option>
          ${WORK_CODES.map(c => '<option value="' + _esc(c) + '"' + (item.workCode === c ? ' selected' : '') + '>' + _esc(c) + '</option>').join('')}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Maintenance Code</label>
        <input class="rca-field__input" type="text" data-field="maintenanceCode" value="${_esc(item.maintenanceCode)}" placeholder="e.g. PM-B, DOT, Unplanned"/>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Controllable?</label>
        <select class="rca-field__select" data-field="controllable">
          <option value="">— Select —</option>
          <option value="Yes"${item.controllable === 'Yes' ? ' selected' : ''}>Yes — Controllable</option>
          <option value="No"${item.controllable === 'No' ? ' selected' : ''}>No — Non-controllable</option>
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Notes</label>
        <textarea class="rca-field__textarea" data-field="notes" placeholder="Additional RCA notes...">${_esc(item.notes)}</textarea>
      </div>

      <div class="rca-detail__actions">
        <button id="rca-investigate" class="rca-btn rca-btn--accent" title="Launch vendor investigation workflow for this unit">\uD83D\uDD0D Investigate</button>
        <button id="rca-mark-done" class="rca-btn rca-btn--primary"${item.completed ? ' disabled' : ''}>\u2713 Mark Complete</button>
        <button id="rca-remove" class="rca-btn rca-btn--danger">Remove</button>
      </div>
    </div>
  `;
}

function _fmtDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Wire Events ─────────────────────────────────────────────────────────────
function _wireEvents() {
  // List item selection
  _el.querySelectorAll('.rca-item').forEach(item => {
    item.addEventListener('click', () => {
      _selectedId = item.dataset.id;
      _render();
    });
  });

  // Operator filter
  const filterSel = document.getElementById('rca-op-filter');
  if (filterSel) {
    filterSel.addEventListener('change', () => {
      _filterOp = filterSel.value;
      _render();
    });
  }

  // Clear completed
  const clearBtn = document.getElementById('rca-clear-done');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _items = _items.filter(i => !i.completed);
      _save(_items);
      _render();
      toast.show('info', 'Completed RCA items cleared', 2000);
    });
  }

  // Detail field changes (auto-save)
  _el.querySelectorAll('.rca-field__select, .rca-field__input, .rca-field__textarea').forEach(el => {
    const evt = el.tagName === 'TEXTAREA' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      if (!_selectedId) return;
      const item = _items.find(i => i.equipmentId === _selectedId);
      if (!item) return;
      item[el.dataset.field] = el.value;
      _save(_items);
      // Update list item visual (checkmark if has codes)
      const listItem = _el.querySelector(`.rca-item[data-id="${_selectedId}"]`);
      if (listItem) {
        const hasCodes = !!(item.primaryComponent || item.failureCode);
        listItem.classList.toggle('rca-item--coded', hasCodes);
      }
    });
  });

  // AI auto-detect RCA codes
  const aiSuggestBtn = document.getElementById('rca-ai-suggest');
  if (aiSuggestBtn) {
    aiSuggestBtn.addEventListener('click', async () => {
      const item = _items.find(i => i.equipmentId === _selectedId);
      if (!item) return;
      aiSuggestBtn.disabled = true;
      aiSuggestBtn.textContent = '\u23F3...';
      const hintsEl = document.getElementById('rca-ai-hints');
      try {
        const text = [item.lifecycleReason, item.vendor, item.notes || ''].filter(Boolean).join(' ');
        const { ai } = await import('../bridge.js');
        const result = await ai.inferRCA(text, { vendor: item.vendor, component: item.primaryComponent });
        if (result && result.suggestions && result.suggestions.length) {
          hintsEl.style.display = 'block';
          hintsEl.innerHTML = result.suggestions.slice(0, 3).map(s =>
            '<div class="rca-ai-hint" data-code="' + _esc(s.code) + '">' +
            '<span class="rca-ai-hint__code">' + _esc(s.code) + '</span> ' +
            '<span class="rca-ai-hint__desc">' + _esc(s.desc) + '</span> ' +
            '<span class="rca-ai-hint__conf">' + Math.round(s.confidence) + '%</span>' +
            '</div>'
          ).join('');
          toast.show('info', 'AI detected ' + result.suggestions.length + ' possible RCA codes', 2500);
        } else {
          hintsEl.style.display = 'block';
          hintsEl.innerHTML = '<div class="rca-ai-hint rca-ai-hint--empty">No patterns matched — assign manually</div>';
        }
      } catch (e) {
        toast.show('error', 'RCA inference error: ' + e.message, 3000);
      }
      aiSuggestBtn.disabled = false;
      aiSuggestBtn.textContent = '\u26A1 Auto-detect';
    });
  }

  // Investigate — launch vendor workflow
  const investigateBtn = document.getElementById('rca-investigate');
  if (investigateBtn) {
    investigateBtn.addEventListener('click', async () => {
      const item = _items.find(i => i.equipmentId === _selectedId);
      if (!item) return;
      investigateBtn.disabled = true;
      investigateBtn.textContent = '\u23F3 Launching...';
      try {
        // Build a unit object from the RCA item for the vendor workflow
        const unit = {
          equipmentId: item.equipmentId,
          operator:    item.operator,
          domicileSite: item.domicileSite,
          lifecycleReason: item.lifecycleReason,
          vendor: item.vendor,
        };
        const result = await vendor.investigate(unit);
        if (result && result.error) {
          toast.show('error', 'Investigation failed: ' + result.error, 3000);
        } else {
          toast.show('success', 'Vendor investigation launched for ' + item.equipmentId, 3000);
          item.investigatedAt = new Date().toISOString();
          _save(_items);
        }
      } catch (e) {
        toast.show('error', 'Investigate error: ' + e.message, 3000);
      }
      investigateBtn.disabled = false;
      investigateBtn.textContent = '\uD83D\uDD0D Investigate';
    });
  }

  // Mark complete
  const doneBtn = document.getElementById('rca-mark-done');
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      const item = _items.find(i => i.equipmentId === _selectedId);
      if (item) {
        item.completed = true;
        item.completedAt = new Date().toISOString();
        _save(_items);
        _selectedId = null;
        _render();
        bus.emit('rca:count-update', { count: _items.filter(i => !i.completed).length });
        toast.show('success', 'RCA complete for ' + item.equipmentId, 2500);
      }
    });
  }

  // Remove
  const removeBtn = document.getElementById('rca-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      _items = _items.filter(i => i.equipmentId !== _selectedId);
      _save(_items);
      _selectedId = null;
      _render();
      bus.emit('rca:count-update', { count: _items.filter(i => !i.completed).length });
      toast.show('info', 'Unit removed from RCA queue', 2000);
    });
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-rca-queue';
  _el.className = 'view view--rca-queue';
  _el.style.display = 'none';
  container.appendChild(_el);

  _render();

  // Detect transitions when fleet data arrives
  bus.on('fleet:data', (data) => {
    const rows = data.rows || [];
    _detectTransitions(rows);
  });

  // Show/hide
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'rca-queue' ? 'flex' : 'none';
    if (to === 'rca-queue') _render();
  });

  // Emit initial count
  bus.emit('rca:count-update', { count: _items.filter(i => !i.completed).length });
}
