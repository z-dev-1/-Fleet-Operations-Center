/**
 * fleet.js -- Fleet table view (main screen)
 *
 * Renders a virtualised table of all fleet units.
 * Responds to:
 *   state:fleet      -- re-render with new data
 *   state:sync       -- toggle syncing overlay
 *   ui:filter-change -- apply/clear filter
 *   ui:search        -- apply/clear search
 *   navigate:unit    -- select a unit by ID
 *
 * S9: relay/risk columns, data-lc row coloring, sort, loading/empty states
 */

import bus          from '../bus.js';
import state        from '../state.js';
import { relay }    from '../bridge.js';
import { showContextMenu } from '../components/context-menu.js';
import { aap } from '../bridge.js';

// Current filter/search applied client-side
const _filters = {};
let   _search  = '';

// S9: relay cache map { [equipmentId]: { vendor, woStatus, serviceUUID } }
let _relayMap = {};

// S9: sort state
let _sortKey = null;
let _sortDir = 'asc';

// ── Columns ───────────────────────────────────────────────────────────────
const COLS = [
  { key: 'equipmentId',    label: 'Equipment ID',       width: '130px', sortable: true  },
  { key: 'bodyType',       label: 'Body Type',          width: '110px', sortable: true  },
  { key: 'domicileSite',   label: 'Domicile Site',      width: '120px', sortable: true  },
  { key: 'operator',       label: 'Operator',           width: '120px', sortable: true  },
  { key: 'lifecycleState', label: 'Lifecycle State',    width: '150px', sortable: true  },
  { key: 'lifecycleReason',label: 'State Reason',       width: '170px', sortable: true  },
  { key: 'openUnplanned',  label: 'Open Unplanned WRs', width: '120px', sortable: true  },
  { key: 'openPlanned',    label: 'Open Planned WRs',   width: '120px', sortable: true  },
  { key: 'fuelType',       label: 'Fuel Type',          width: '100px', sortable: true  },
  { key: 'geofence',       label: 'Last Geofence',      width: '180px', sortable: false },
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

// S9: risk badge HTML
function _riskBadge(score) {
  const n = parseInt(score, 10);
  if (isNaN(n)) return '';
  const cls  = n >= 70 ? 'risk-high' : n >= 40 ? 'risk-medium' : 'risk-low';
  return '<span class="badge badge--' + cls + '">' + n + '</span>';
}

// S9: merge relay data into row for virtual columns
function _augmentRow(row) {
  const rel = _relayMap[row.equipmentId] || {};
  return Object.assign({}, row, {
    relayVendor: rel.vendor || '',
  });
}

function _applyFiltersAndSort(rows) {
  // Filter
  let result = rows.filter((row) => {
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

  // S9: sort
  if (_sortKey) {
    result = result.slice().sort((a, b) => {
      const av = String(a[_sortKey] || '');
      const bv = String(b[_sortKey] || '');
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return _sortDir === 'asc' ? cmp : -cmp;
    });
  }

  return result;
}

let _tbodyEl  = null;
let _countEl  = null;
let _wrapEl   = null;
let _theadEl  = null;
let _allRows  = [];

function _renderRows(rows) {
  _allRows = rows;
  if (!_tbodyEl) return;

  // Augment with relay virtual columns
  const augmented = rows.map(_augmentRow);
  const filtered  = _applyFiltersAndSort(augmented);

  if (_countEl) {
    _countEl.textContent = filtered.length + ' / ' + rows.length + ' units';
  }

  // S9: empty state — no data at all (first launch)
  if (rows.length === 0) {
    _tbodyEl.innerHTML = '';
    _showEmptyState(true);
    return;
  }
  _showEmptyState(false);

  // Filter-empty (data exists but nothing matches)
  if (filtered.length === 0) {
    _tbodyEl.innerHTML =
      '<tr><td colspan="' + COLS.length + '" class="fleet-table__empty">No units match the current filters.</td></tr>';
    return;
  }

  _tbodyEl.innerHTML = filtered.map((row) => {
    const lcClass = _lifecycleClass(row.lifecycleState);
    const cells = COLS.map((c) => {
      let val = row[c.key] || '';
      let content = val;

      // S9: risk badge cell
      if (c.key === 'riskScore') {
        content = _riskBadge(val);
      }

      const cls = c.key === 'lifecycleState' ? ' class="' + lcClass + '"' : '';
      // Equipment ID: render as clickable hyperlink opening in-app AAP asset window
      if (c.key === 'equipmentId' && row.assetUrl) {
        content = '<a class="eq-link" href="#" data-url="' + row.assetUrl + '"' +
          ' style="color:#8b949e;text-decoration:none;font-weight:500;border-bottom:1px solid transparent;transition:color .15s"' +
          ' onmouseenter="this.style.color=\'#f0f6fc\';this.style.borderBottomColor=\'#444c56\'"' +
          ' onmouseleave="this.style.color=\'#8b949e\';this.style.borderBottomColor=\'transparent\'"' +
          '>' + val + '</a>';
      }
      // WR counts: link directly to WR list URL scraped from React fiber, fall back to asset page
      if ((c.key === 'openUnplanned' || c.key === 'openPlanned') && val && val !== '0' && val !== '--') {
        var wrUrlKey = c.key === 'openUnplanned' ? 'openUnplannedUrl' : 'openPlannedUrl';
        var wrUrl    = row[wrUrlKey] || row.assetUrl || null;
        if (wrUrl) {
          content = '<a class="wr-link" href="#" data-url="' + wrUrl + '"' +
            ' style="color:#e3b341;text-decoration:none;font-weight:600;border-bottom:1px solid transparent;transition:color .15s"' +
            ' onmouseenter="this.style.color=\'#f0c040\';this.style.borderBottomColor=\'#e3b341\'"' +
            ' onmouseleave="this.style.color=\'#e3b341\';this.style.borderBottomColor=\'transparent\'"' +
            '>' + val + '</a>';
        }
      }
      return '<td' + cls + ' title="' + String(val).replace(/"/g, '&quot;') + '">' + content + '</td>';
    }).join('');

    // S9: data-lc on the <tr> for row-level coloring
    return '<tr class="fleet-table__row" data-id="' + row.equipmentId + '" data-lc="' + lcClass + '">' + cells + '</tr>';
  }).join('');

  // Equipment ID / WR link → open in-app AAP asset window
  _tbodyEl.querySelectorAll('a.eq-link, a.wr-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = a.dataset.url;
      if (!url) return;
      try { aap.openUrl(url); } catch(err) { /* silent */ }
    });
  });

  // Row click → select unit
  _tbodyEl.querySelectorAll('.fleet-table__row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const unitId = tr.dataset.id;
      const unit   = filtered.find((r) => r.equipmentId === unitId);
      if (unit) bus.emit('ui:unit-select', { unit });
    });
      tr.addEventListener('contextmenu', (e) => {
        const unitId = tr.dataset.id;
        const unit   = filtered.find((r) => r.equipmentId === unitId);
        if (!unit) return;
        showContextMenu(e, {
          header: { title: unit.equipmentId, sub: [unit.manufacturer, unit.assetType].filter(Boolean).join(' · ') },
          items: [
            { icon: '🔧', label: 'Start Dealer WO', action: () => {
                bus.emit('ui:unit-select', { unit });
                bus.emit('ui:dealer-wo-request', { unit });
              }
            },
            { sep: true },
            { icon: '📋', label: 'Copy Equipment ID', action: () => {
                navigator.clipboard.writeText(unit.equipmentId).catch(() => {});
                bus.emit('ui:toast', { type: 'info', message: 'Copied: ' + unit.equipmentId, duration: 1800 });
              }
            },
            { icon: '🔍', label: 'View Unit Detail', action: () => {
                bus.emit('ui:unit-select', { unit });
              }
            },
          ],
        });
      });
  });

  // S9: update sort indicators in header
  _updateSortHeaders();
}

// S9: update th sort classes
function _updateSortHeaders() {
  if (!_theadEl) return;
  _theadEl.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.key === _sortKey) {
      th.classList.add(_sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

// S9: empty state panel
let _emptyEl = null;
function _showEmptyState(show) {
  if (!_wrapEl) return;
  if (show) {
    if (!_emptyEl) {
      _emptyEl = document.createElement('div');
      _emptyEl.className = 'fleet-empty';
      _emptyEl.innerHTML = '<p>No fleet data yet.</p><button id="fleet-sync-now" class="detail-panel__btn">Sync Now</button>';
      _wrapEl.appendChild(_emptyEl);
      document.getElementById('fleet-sync-now').addEventListener('click', () => {
        bus.emit('ui:toast', { type: 'info', message: 'Sync triggered...', duration: 2000 });
        import('../bridge.js').then(({ fleet: fleetBridge }) => fleetBridge.forceSync()).catch(() => {});
      });
    }
    _emptyEl.style.display = 'flex';
  } else {
    if (_emptyEl) _emptyEl.style.display = 'none';
  }
}

// S9: load relay cache and re-render
function _loadRelayCache(rows) {
  import('../bridge.js').then(({ relay: relayBridge }) => {
    relayBridge.getCache().then((cache) => {
      _relayMap = (cache && cache.units) ? cache.units : {};
      _renderRows(rows);
    }).catch(() => {
      _relayMap = {};
      _renderRows(rows);
    });
  }).catch(() => {
    _relayMap = {};
    _renderRows(rows);
  });
}

export function init(container) {
  const el = document.createElement('div');
  el.id = 'view-fleet';
  el.className = 'view view--fleet';

  // S9: sortable column headers
  const headerCols = COLS.map(
    (c) => '<th class="sortable" data-key="' + c.key + '" style="width:' + c.width + '">' + c.label + '</th>'
  ).join('');

  el.innerHTML = `
    <div id="fleet-table-wrap" class="fleet-table-wrap">
      <div class="fleet-table-meta">
        <span id="fleet-count" class="fleet-table__count">Loading...</span>
      </div>
      <div class="fleet-table-scroll">
        <table class="fleet-table">
          <thead id="fleet-thead">
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

  _tbodyEl = document.getElementById('fleet-tbody');
  _countEl = document.getElementById('fleet-count');
  _wrapEl  = document.getElementById('fleet-table-wrap');
  _theadEl = document.getElementById('fleet-thead');

  // S9: column sort click
  _theadEl.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (_sortKey === key) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortKey = key;
        _sortDir = 'asc';
      }
      _renderRows(_allRows);
    });
  });

  // Render on fleet state change — load relay cache first
  bus.on('state:fleet', (fleetSlice) => {
    const rows = fleetSlice.rows || [];
    _loadRelayCache(rows);
  });

  // S9: syncing overlay
  bus.on('state:sync', (syncSlice) => {
    if (_wrapEl) {
      _wrapEl.classList.toggle('syncing', !!syncSlice.inProgress);
    }
  });

  // Filter / search
  bus.on('ui:filter-change', ({ field, value }) => {
    if (value) {
      _filters[field] = value;
    } else {
      delete _filters[field];
    }
    _renderRows(_allRows);
  });

  bus.on('ui:search', ({ query }) => {
    _search = query;
    _renderRows(_allRows);
  });

  // Deep-link: navigate to unit
  bus.on('navigate:unit', (unitId) => {
    const row = (state.slice('fleet').rows || []).find((r) => r.equipmentId === unitId);
    if (row) bus.emit('ui:unit-select', { unit: row });
  });

  // Render immediately if data already in state
  const existing = state.slice('fleet');
  if (existing.rows && existing.rows.length) {
    _loadRelayCache(existing.rows);
  }
}
