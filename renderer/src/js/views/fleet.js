/**
 * fleet.js -- Fleet table view (main screen)
 *
 * Renders a virtualised table of all fleet units.
 * Responds to:
 *   state:fleet      -- re-render with new data
 *   ui:filter-change -- apply/clear filter
 *   ui:search        -- apply/clear search
 *   navigate:unit    -- select a unit by ID
 */

import bus   from '../bus.js';
import state from '../state.js';

// Current filter/search applied client-side
const _filters = {};
let   _search  = '';

// ── Columns ───────────────────────────────────────────────────────────────
const COLS = [
  { key: 'equipmentId',    label: 'Equipment ID',   width: '130px' },
  { key: 'assetType',      label: 'Type',            width: '100px' },
  { key: 'lifecycleState', label: 'Lifecycle',       width: '140px' },
  { key: 'lifecycleReason',label: 'Reason',          width: '160px' },
  { key: 'domicileSite',   label: 'Domicile',        width: '100px' },
  { key: 'operator',       label: 'Operator',        width: '120px' },
  { key: 'manufacturer',   label: 'Manufacturer',    width: '120px' },
  { key: 'dueDate',        label: 'Due Date',        width: '100px' },
  { key: 'openUnplanned',  label: 'Open WRs',        width: '90px'  },
  { key: 'geofence',       label: 'Last Geofence',   width: '160px' },
];

function _lifecycleClass(val) {
  if (!val) return '';
  const v = val.toLowerCase();
  if (v.includes('available') && !v.includes('un')) return 'lc--available';
  if (v.includes('unavailable'))  return 'lc--unavailable';
  if (v.includes('decommission')) return 'lc--decommissioned';
  if (v.includes('maintenance'))  return 'lc--maintenance';
  return '';
}

function _applyFilters(rows) {
  return rows.filter((row) => {
    // Filters
    for (const [field, value] of Object.entries(_filters)) {
      if (!value) continue;
      const cell = (row[field] || '').toLowerCase();
      if (!cell.includes(value.toLowerCase())) return false;
    }
    // Search
    if (_search) {
      const s = _search.toLowerCase();
      const match = COLS.some((c) => (row[c.key] || '').toLowerCase().includes(s));
      if (!match) return false;
    }
    return true;
  });
}

let _tbodyEl = null;
let _countEl = null;

function _renderRows(rows) {
  if (!_tbodyEl) return;
  const filtered = _applyFilters(rows);

  if (_countEl) {
    _countEl.textContent = filtered.length + ' / ' + rows.length + ' units';
  }

  if (filtered.length === 0) {
    _tbodyEl.innerHTML =
      '<tr><td colspan="' + COLS.length + '" class="fleet-table__empty">No units match the current filters.</td></tr>';
    return;
  }

  _tbodyEl.innerHTML = filtered.map((row) => {
    const cells = COLS.map((c) => {
      const val  = row[c.key] || '';
      const cls  = c.key === 'lifecycleState' ? ' class="' + _lifecycleClass(val) + '"' : '';
      return '<td' + cls + ' title="' + val.replace(/"/g, '&quot;') + '">' + val + '</td>';
    }).join('');
    return '<tr class="fleet-table__row" data-id="' + row.equipmentId + '">' + cells + '</tr>';
  }).join('');

  // Row click -> select unit
  _tbodyEl.querySelectorAll('.fleet-table__row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const unitId = tr.dataset.id;
      const unit   = filtered.find((r) => r.equipmentId === unitId);
      if (unit) bus.emit('ui:unit-select', { unit });
    });
  });
}

export function init(container) {
  const el = document.createElement('div');
  el.id = 'view-fleet';
  el.className = 'view view--fleet';

  // Table header
  const headerCols = COLS.map(
    (c) => '<th style="width:' + c.width + '">' + c.label + '</th>'
  ).join('');

  el.innerHTML = `
    <div class="fleet-table-wrap">
      <div class="fleet-table-meta">
        <span id="fleet-count" class="fleet-table__count">Loading...</span>
      </div>
      <div class="fleet-table-scroll">
        <table class="fleet-table">
          <thead>
            <tr>${headerCols}</tr>
          </thead>
          <tbody id="fleet-tbody">
            <tr><td colspan="${COLS.length}" class="fleet-table__empty">
              Waiting for fleet data...
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
  container.appendChild(el);

  _tbodyEl  = document.getElementById('fleet-tbody');
  _countEl  = document.getElementById('fleet-count');

  // Render on state change
  bus.on('state:fleet', (fleetSlice) => {
    _renderRows(fleetSlice.rows || []);
  });

  // Filter / search
  bus.on('ui:filter-change', ({ field, value }) => {
    if (value) {
      _filters[field] = value;
    } else {
      delete _filters[field];
    }
    _renderRows(state.slice('fleet').rows || []);
  });

  bus.on('ui:search', ({ query }) => {
    _search = query;
    _renderRows(state.slice('fleet').rows || []);
  });

  // Deep-link: navigate to unit
  bus.on('navigate:unit', (unitId) => {
    const row = (state.slice('fleet').rows || []).find((r) => r.equipmentId === unitId);
    if (row) bus.emit('ui:unit-select', { unit: row });
  });

  // Render immediately if data already in state
  const existing = state.slice('fleet');
  if (existing.rows && existing.rows.length) {
    _renderRows(existing.rows);
  }
}
