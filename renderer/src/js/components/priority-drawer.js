/**
 * priority-drawer.js -- Left priority pins drawer
 *
 * Shows manually pinned units (right-click → Pin) + top auto-ranked by risk score.
 * Manual pins appear first, are draggable to reorder, and can be right-click unpinned.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el      = null;
let _open    = true;
let _allRows = [];

// Manual pin order (array of equipmentIds, ordered by drag)
let _pinnedOrder = JSON.parse(localStorage.getItem('fleet_pinned_order') || '[]');
let _pinnedIds   = new Set(JSON.parse(localStorage.getItem('fleet_pinned_ids')  || '[]'));

function _savePins() {
  localStorage.setItem('fleet_pinned_ids',   JSON.stringify([..._pinnedIds]));
  localStorage.setItem('fleet_pinned_order', JSON.stringify(_pinnedOrder));
}

function _syncFromFleet(ids) {
  _pinnedIds = new Set(ids);
  _pinnedOrder = _pinnedOrder.filter(id => _pinnedIds.has(id));
  ids.forEach(id => { if (!_pinnedOrder.includes(id)) _pinnedOrder.push(id); });
  _savePins();
  _renderPins(_allRows);
}

const STATUS_TAG = {
  'in progress':   { cls: 'tag--org',  label: 'In Progress' },
  'pending parts': { cls: 'tag--org',  label: 'Pending Parts' },
  'offsite shop':  { cls: 'tag--red',  label: 'Offsite Shop' },
  'shop repair':   { cls: 'tag--red',  label: 'Shop Repair' },
  'pending diag':  { cls: 'tag--pur',  label: 'Pending Diag' },
  'available':     { cls: 'tag--grn',  label: 'Available' },
  'accident':      { cls: 'tag--mut',  label: 'Accident' },
};

function _tag(reason) {
  const key = (reason || '').toLowerCase();
  for (const [k, t] of Object.entries(STATUS_TAG)) {
    if (key.includes(k)) return `<span class="pin-tag ${t.cls}">${t.label}</span>`;
  }
  return reason ? `<span class="pin-tag tag--mut">${reason}</span>` : '';
}

function _dotClass(score) {
  if (score >= 70) return 'pin-dot--crit';
  if (score >= 40) return 'pin-dot--watch';
  return 'pin-dot--ok';
}
function _scoreColor(score) {
  if (score >= 70) return 'var(--red)';
  if (score >= 40) return 'var(--org)';
  return 'var(--grn)';
}

function _buildPinList(rows) {
  const byId = Object.fromEntries(rows.map(r => [r.equipmentId, r]));
  const manual = _pinnedOrder
    .filter(id => byId[id])
    .map(id => ({ ...byId[id], _manual: true }));
  const autoUnits = [...rows]
    .filter(r => !_pinnedIds.has(r.equipmentId) &&
                 (r.riskScore > 0 || (r.lifecycleState || '').toLowerCase() === 'unavailable'))
    .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0))
    .slice(0, Math.max(0, 10 - manual.length));
  return [...manual, ...autoUnits];
}

// ── Drag-to-reorder ────────────────────────────────────────────────────────
let _dragSrc = null;

function _attachDrag(list) {
  list.querySelectorAll('.pin-item[data-manual="true"]').forEach(item => {
    item.setAttribute('draggable', 'true');

    item.addEventListener('dragstart', () => {
      _dragSrc = item;
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.pin-item').forEach(i => i.classList.remove('drag-over'));
      _dragSrc = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (_dragSrc && _dragSrc !== item && item.dataset.manual === 'true') {
        list.querySelectorAll('.pin-item').forEach(i => i.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!_dragSrc || _dragSrc === item) return;
      const srcId  = _dragSrc.dataset.id;
      const destId = item.dataset.id;
      const si = _pinnedOrder.indexOf(srcId);
      const di = _pinnedOrder.indexOf(destId);
      if (si === -1 || di === -1) return;
      _pinnedOrder.splice(si, 1);
      _pinnedOrder.splice(di, 0, srcId);
      _savePins();
      _renderPins(_allRows);
    });

    // Right-click → unpin
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = item.dataset.id;
      _pinnedIds.delete(id);
      _pinnedOrder = _pinnedOrder.filter(x => x !== id);
      _savePins();
      bus.emit('fleet:pins-updated', { pinnedIds: [..._pinnedIds] });
      bus.emit('ui:toast', { type: 'info', message: 'Unpinned ' + id, duration: 1800 });
      _renderPins(_allRows);
    });
  });
}

function _renderPins(rows) {
  const list = document.getElementById('pin-list');
  if (!list) return;
  const pins  = _buildPinList(rows);
  const count = document.getElementById('pin-count');
  if (count) count.textContent = pins.length || '0';

  if (pins.length === 0) {
    list.innerHTML = '<div class="pin-empty">No priority units<div class="pin-empty-hint">Right-click a row to pin</div></div>';
    return;
  }

  list.innerHTML = pins.map(r => {
    const score  = r.riskScore || 0;
    const manual = r._manual ? 'true' : 'false';
    const drag   = r._manual ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : '<span class="drag-handle"></span>';
    return `
      <div class="pin-item" data-id="${r.equipmentId}" data-manual="${manual}">
        ${drag}
        <div class="pin-dot ${_dotClass(score)}"></div>
        <div class="pin-info">
          <div class="pin-id">${r.equipmentId}${r._manual ? ' <span class="pin-manual-badge">📌</span>' : ''}</div>
          <div class="pin-meta">${[r.operator, r.domicileSite].filter(Boolean).join(' · ')}</div>
          ${_tag(r.lifecycleReason)}
        </div>
        <div class="pin-score" style="color:${_scoreColor(score)}">${score || '—'}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.pin-item').forEach(item => {
    item.addEventListener('click', () => {
      list.querySelectorAll('.pin-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const unit = _allRows.find(r => r.equipmentId === item.dataset.id);
      if (unit) bus.emit('ui:unit-select', { unit });
    });
  });

  _attachDrag(list);
}

function _setOpen(open) {
  _open = open;
  const drawer = document.getElementById('priority-drawer');
  const icon   = document.getElementById('pts-icon');
  if (!drawer) return;
  drawer.classList.toggle('collapsed', !open);
  if (icon) icon.textContent = open ? '◀' : '▶';
}

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'priority-drawer-wrap';
  _el.innerHTML = `
    <div id="priority-strip" class="priority-strip" title="Toggle priority pins">
      <span id="pts-icon" class="pts-icon">◀</span>
    </div>
    <aside id="priority-drawer" class="priority-drawer">
      <div class="pd-header">
        <span class="pd-title">Priority Pins</span>
        <span class="pd-count" id="pin-count">—</span>
      </div>
      <div class="pd-list" id="pin-list">
        <div class="pin-empty">Waiting for data...<div class="pin-empty-hint">Right-click a row to pin</div></div>
      </div>
    </aside>
  `;
  container.appendChild(_el);

  document.getElementById('priority-strip').addEventListener('click', () => _setOpen(!_open));

  bus.on('state:fleet', (fleetSlice) => {
    _allRows = fleetSlice.rows || [];
    _renderPins(_allRows);
  });

  bus.on('fleet:pins-updated', ({ pinnedIds }) => {
    _syncFromFleet(pinnedIds);
  });

  bus.on('ui:unit-select', ({ unit }) => {
    const list = document.getElementById('pin-list');
    if (!list) return;
    list.querySelectorAll('.pin-item').forEach(i =>
      i.classList.toggle('active', i.dataset.id === unit.equipmentId));
  });

  bus.on('ui:unit-deselect', () => {
    const list = document.getElementById('pin-list');
    if (list) list.querySelectorAll('.pin-item').forEach(i => i.classList.remove('active'));
  });
}
