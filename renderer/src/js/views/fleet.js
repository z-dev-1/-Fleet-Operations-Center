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
import { relay, ai } from '../bridge.js';
import { showContextMenu } from '../components/context-menu.js';
import { aap } from '../bridge.js';

// Current filter/search applied client-side
const _filters = {};
let   _search  = '';

// S9: relay cache map { [equipmentId]: { vendor, woStatus, serviceUUID } }
let _relayMap = {};

// S9: sort state
let _sortKey             = null;
let _sortDir             = 'asc';
let _quickFilterHighRisk = false;
let _selectedId          = null;   // persists highlight across re-renders
let _selectedIds         = new Set(); // S28: multi-select for bulk ops
let _heatmapOn           = false;  // S28: risk heatmap overlay
let _breachForecastOn    = false;  // S28: SLA breach forecast overlay
let _SLA_TARGET_DAYS     = parseInt(localStorage.getItem('fleet_sla_target') || '5', 10) || 5;  // S28: configurable SLA threshold

// S28: parse duration text to number of days (e.g. "3d 2h" → 3, "5 days" → 5, "12h" → 0.5)
function _parseDurationDays(dur) {
  if (!dur || dur === '--') return null;
  const s = String(dur).toLowerCase().trim();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  // fallback: plain number assume days
  if (!dm && !hm) {
    const n = parseFloat(s);
    if (!isNaN(n)) days = n;
  }
  return days || null;
}

// Manual pins: Set of equipmentId strings (user right-click pinned)
let _pinnedIds = new Set(JSON.parse(localStorage.getItem('fleet_pinned_ids') || '[]'));
function _savePins() { localStorage.setItem('fleet_pinned_ids', JSON.stringify([..._pinnedIds])); }

// ── Columns ───────────────────────────────────────────────────────────────
const COLS = [
  { key: '_select',        label: '☐',            width: '30px',  sortable: false, isCheckbox: true },
  { key: '_health',        label: '',             width: '24px',  sortable: true  },
  { key: 'bodyType',       label: 'Body Type',    width: '100px', sortable: true  },
  { key: 'equipmentId',    label: 'Unit ID',      width: '110px', sortable: true  },
  { key: '_opSite',        label: 'OP / Site',    width: '130px', sortable: true  },
  { key: 'lifecycleState', label: 'Status',       width: '110px', sortable: true  },
  { key: 'lifecycleReason',label: 'Relay Status', width: '150px', sortable: true  },
  { key: 'riskScore',      label: 'Score',        width: '70px',  sortable: true  },
  { key: '_wos',           label: 'WOs',          width: '70px',  sortable: false },
  { key: '_pmDates',       label: 'PM Dates',     width: '120px', sortable: false },
  { key: 'duration',       label: 'Duration',     width: '90px',  sortable: true  },
  { key: 'vendor',         label: 'Vendor',       width: '130px', sortable: true  },
  { key: 'geofence',      label: 'Location',     width: '110px', sortable: true  },
  { key: 'sla',            label: 'SLA',          width: '80px',  sortable: true  },
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

// Status pill — colored pill for lifecycleState column
function _lifecyclePill(val) {
  if (!val) return '<span class="lc-pill lc-pill--unknown">—</span>';
  const v = val.toLowerCase();
  if (v.includes('available') && !v.includes('un'))
    return '<span class="lc-pill lc-pill--available">Active</span>';
  if (v.includes('unavailable'))
    return '<span class="lc-pill lc-pill--unavailable">Unavailable</span>';
  if (v.includes('decommission'))
    return '<span class="lc-pill lc-pill--decommissioned">Decommissioned</span>';
  if (v.includes('maintenance'))
    return '<span class="lc-pill lc-pill--maintenance">Maintenance</span>';
  return '<span class="lc-pill lc-pill--unknown">' + val + '</span>';
}

// Lifecycle reason pill — per-reason colors
function _lifecycleReasonPill(val) {
  if (!val) return '';
  const v = val.toLowerCase();
  let cls = 'lcr-pill--default';
  if (v.includes('offsite shop') || v.includes('shop repair')) cls = 'lcr-pill--offsite';
  else if (v.includes('damaged') && v.includes('moderate'))    cls = 'lcr-pill--damaged';
  else if (v.includes('expired') && v.includes('inspection'))  cls = 'lcr-pill--expired';
  else if (v.includes('accident'))                             cls = 'lcr-pill--accident';
  return '<span class="lcr-pill ' + cls + '">' + val + '</span>';
}

// S9: risk badge HTML
function _riskBadge(score) {
  const n = parseInt(score, 10);
  if (isNaN(n)) return '';
  const cls  = n >= 70 ? 'risk-high' : n >= 40 ? 'risk-medium' : 'risk-low';
  return '<span class="badge badge--' + cls + '">' + n + '</span>';
}

// PM pill — only shown if due ≤60 days OR overdue. Returns '' if >60 days out.
// val is: 'overdue' | 'Jul 8' | 'Aug 3' | '--'
function _pmPill(label, val) {
  if (!val || val === '--') return '';   // hide blanks entirely

  const v = val.toLowerCase();
  let cls;
  let daysOut = null;

  if (v === 'overdue') {
    cls = 'pm-pill--overdue';
  } else {
    const d = new Date(val + ' ' + new Date().getFullYear());
    if (!isNaN(d.getTime())) {
      daysOut = Math.round((d - new Date().setHours(0,0,0,0)) / 86400000);
      if (daysOut > 60) return '';        // >60 days — hide pill
      cls = daysOut <= 0  ? 'pm-pill--overdue'
          : daysOut <= 30 ? 'pm-pill--soon'
          :                 'pm-pill--ok';
    } else {
      cls = 'pm-pill--ok';
    }
  }

  return '<span class="pm-pill ' + cls + '">'
       + '<span class="pm-pill__lbl">' + label + '</span>'
       + '<span class="pm-pill__val">' + val + '</span>'
       + '</span>';
}


// S9: merge relay data into row for virtual columns
function _augmentRow(row) {
  const rel        = _relayMap[row.equipmentId] || {};
  const unplanned  = parseInt(row.openUnplanned, 10) || 0;
  const planned    = parseInt(row.openPlanned,   10) || 0;

  // Build PM pills — only include pills that are within 60 days
  const pills = [
    _pmPill('B',   row.pmB           || '--'),
    _pmPill('X',   row.pmX           || '--'),
    _pmPill('DOT', row.dot           || '--'),
    _pmPill('Q',   row.quarterlyLift || '--'),
  ].filter(Boolean);

  const pmDatesHtml = pills.length
    ? '<div class="pm-pills-row">' + pills.join('') + '</div>'
    : '';

  return Object.assign({}, row, {
    relayVendor: rel.vendor || '',
    vendor:      rel.vendor || row.vendor || '',
    sla:         rel.sla    || row.sla    || '--',
    duration:    rel.workDuration || row.duration || row.workDuration || '--',
    _opSite:     [row.operator, row.domicileSite].filter(Boolean).join(' / '),
    _wos:        unplanned + ' / ' + planned,
    _pmDates:    pmDatesHtml,
  });
}

function _applyFiltersAndSort(rows) {
  let result = rows.filter((row) => {
    // Quick filter: high-risk
    if (_quickFilterHighRisk && (row.riskScore || 0) < 70) return false;

    for (const [field, value] of Object.entries(_filters)) {
      if (!value) continue;
      const cell = (row[field] || '').toLowerCase();
      if (!cell.includes(value.toLowerCase())) return false;
    }
    if (_search) {
      const s = _search.toLowerCase();
      const match = COLS.some((c) => String(row[c.key] || '').toLowerCase().includes(s));
      if (!match) return false;
    }
    return true;
  });

  if (_sortKey) {
    result = result.slice().sort((a, b) => {
      // S28-Sprint1: health column sorts by numeric score
      const resolvedKey = _sortKey === '_health' ? '_healthScore' : _sortKey;
      const av = String(a[resolvedKey] || '');
      const bv = String(b[resolvedKey] || '');
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
    const lcClass   = _lifecycleClass(row.lifecycleState);
    const isSelected = row.equipmentId === _selectedId;
    const cells = COLS.map((c) => {
      // S28: Checkbox column
      if (c.isCheckbox) {
        const checked = _selectedIds.has(row.equipmentId) ? ' checked' : '';
        return '<td style="width:' + c.width + '"><input type="checkbox" class="fleet-cb fleet-row-cb" data-id="' + row.equipmentId + '"' + checked + '></td>';
      }
      let val     = row[c.key] || '';
      let content = String(val);
      let rawHtml = false;

      // S28-Sprint1: Health indicator dot
      if (c.key === '_health') {
        const tier = row._healthTier || 'good';
        const score = row._healthScore || 100;
        const cls = tier === 'poor' ? 'health-dot--poor' : tier === 'fair' ? 'health-dot--fair' : 'health-dot--good';
        content = '<span class="health-dot ' + cls + '" title="Data health: ' + score + '%"></span>';
        rawHtml = true;
      }
      // Risk score badge
      if (c.key === 'riskScore') {
        content = _riskBadge(val); rawHtml = true;
      }
      // PM dates — pre-built HTML pills
      if (c.key === '_pmDates') {
        content = val || ''; rawHtml = true;
      }
      // Unit ID — white bold, clickable link if assetUrl present
      if (c.key === 'equipmentId') {
        // S28: breach forecast flag
        let breachFlag = '';
        if (_breachForecastOn) {
          const _isU = (row.lifecycleState || '').toLowerCase().includes('unavail');
          const _d = _isU ? _parseDurationDays(row.duration || row.workDuration) : null;
          if (_d !== null) {
            const _p = _d / _SLA_TARGET_DAYS;
            if (_p >= 1.0) breachFlag = '<span class="breach-flag breach-flag--over" title="SLA EXCEEDED (' + Math.round(_d) + 'd / ' + _SLA_TARGET_DAYS + 'd)">🔴</span>';
            else if (_p >= 0.6) breachFlag = '<span class="breach-flag breach-flag--warn" title="Breach risk (' + Math.round(_d) + 'd / ' + _SLA_TARGET_DAYS + 'd)">⚠️</span>';
          }
        }
        const inner = '<span class="uid uid--white">' + val + '</span>' + breachFlag;
        if (row.assetUrl) {
          content = '<a class="eq-link" href="#" data-url="' + row.assetUrl + '">' + inner + '</a>';
        } else {
          content = inner;
        }
        rawHtml = true;
      }
      // Asset type (e.g. Day Cab) — white text
      if (c.key === 'assetType' || c.key === 'bodyType' || c.key === 'vehicleType') {
        content = '<span class="cell--white">' + content + '</span>';
        rawHtml = true;
      }
      // Lifecycle state — colored pill
      if (c.key === 'lifecycleState') {
        content = _lifecyclePill(val); rawHtml = true;
      }
      // Lifecycle reason — colored pill
      if (c.key === 'lifecycleReason') {
        content = _lifecycleReasonPill(val); rawHtml = true;
      }
      // WOs — highlight if any open
      if (c.key === '_wos') {
        const total = (parseInt(row.openUnplanned,10)||0) + (parseInt(row.openPlanned,10)||0);
        content = total > 0
          ? '<span class="wo-badge wo-badge--open">' + val + '</span>'
          : '<span class="wo-badge wo-badge--none">' + val + '</span>';
        rawHtml = true;
      }

      const title = rawHtml ? '' : ' title="' + content.replace(/"/g, '&quot;') + '"';
      return '<td' + title + '>' + content + '</td>';
    }).join('');
    const selCls = isSelected ? ' row--selected' : '';

    // S28: heatmap — tint row background by risk score
    let heatStyle = '';
    if (_heatmapOn) {
      const risk = parseInt(row.riskScore, 10) || 0;
      const alpha = (risk / 100 * 0.18).toFixed(3);
      const clr = risk >= 75 ? 'rgba(255,123,114,' + alpha + ')'
                : risk >= 50 ? 'rgba(255,166,87,' + alpha + ')'
                : risk > 0   ? 'rgba(126,231,135,' + alpha + ')'
                : 'transparent';
      heatStyle = ' style="background:' + clr + '"';
    }

    // S28: breach forecast — flag units approaching SLA target
    let breachCls = '';
    if (_breachForecastOn) {
      const isUnavail = (row.lifecycleState || '').toLowerCase().includes('unavail');
      if (isUnavail) {
        const days = _parseDurationDays(row.duration || row.workDuration);
        if (days !== null) {
          const pct = days / _SLA_TARGET_DAYS;
          if (pct >= 1.0)      breachCls = ' row--breached';       // already exceeded
          else if (pct >= 0.6) breachCls = ' row--breach-risk';    // approaching (60-99%)
        }
      }
    }

    return '<tr class="fleet-table__row' + selCls + breachCls + '"' + heatStyle + ' data-id="' + row.equipmentId + '" data-lc="' + lcClass + '">' + cells + '</tr>';
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

  // Row click → select unit + persist highlight
  _tbodyEl.querySelectorAll('.fleet-table__row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const unitId = tr.dataset.id;
      const unit   = filtered.find((r) => r.equipmentId === unitId);
      if (!unit) return;
      _selectedId = unitId;
      // Update highlight immediately without full re-render
      _tbodyEl.querySelectorAll('.fleet-table__row').forEach(r =>
        r.classList.toggle('row--selected', r.dataset.id === unitId));
      bus.emit('ui:unit-select', { unit });
    });

    tr.addEventListener('contextmenu', (e) => {
      const unitId = tr.dataset.id;
      const unit   = filtered.find((r) => r.equipmentId === unitId);
      if (!unit) return;
      const isPinned = _pinnedIds.has(unitId);
      showContextMenu(e, {
        header: { title: unit.equipmentId, sub: [unit.manufacturer, unit.assetType].filter(Boolean).join(' · ') },
        items: [
          { icon: isPinned ? '📌' : '📍',
            label: isPinned ? 'Unpin from Priority' : 'Pin to Priority',
            action: () => {
              if (isPinned) { _pinnedIds.delete(unitId); } else { _pinnedIds.add(unitId); }
              _savePins();
              bus.emit('fleet:pins-updated', { pinnedIds: [..._pinnedIds] });
              bus.emit('ui:toast', {
                type: 'info',
                message: isPinned ? 'Unpinned ' + unitId : 'Pinned ' + unitId,
                duration: 1800
              });
            }
          },
          { sep: true },
          { icon: '🔧', label: 'Start Dealer WO', action: () => {
              bus.emit('ui:unit-select', { unit });
              bus.emit('ui:dealer-wo-request', { unit });
            }
          },
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

  // S28: Checkbox selection — individual row checkboxes
  _tbodyEl.querySelectorAll('.fleet-row-cb').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) _selectedIds.add(id);
      else _selectedIds.delete(id);
      _updateBulkBar();
    });
  });

  // S28: Select-all checkbox
  const selectAll = document.getElementById('fleet-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      if (selectAll.checked) {
        filtered.forEach(r => _selectedIds.add(r.equipmentId));
      } else {
        _selectedIds.clear();
      }
      // Update all row checkboxes
      _tbodyEl.querySelectorAll('.fleet-row-cb').forEach(cb => {
        cb.checked = selectAll.checked;
      });
      _updateBulkBar();
    });
  }

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
    (c) => c.isCheckbox
      ? '<th style="width:' + c.width + '"><input type="checkbox" id="fleet-select-all" class="fleet-cb" title="Select all"></th>'
      : '<th class="sortable" data-key="' + c.key + '" style="width:' + c.width + '">' + c.label + '</th>'
  ).join('');

  el.innerHTML = `
    <div id="fleet-table-wrap" class="fleet-table-wrap">
      <div class="fleet-table-meta">
        <span id="fleet-count" class="fleet-table__count">Loading...</span>
        <button id="fleet-heatmap-toggle" class="fleet-heatmap-btn" title="Toggle Risk Heatmap">\uD83C\uDF21\uFE0F Heatmap</button>
        <button id="fleet-breach-toggle" class="fleet-breach-btn" title="Toggle SLA Breach Forecast">\u26A0\uFE0F Breach</button>
        <button id="fleet-export-csv" class="fleet-export-btn" title="Export to CSV">\uD83D\uDCE5 CSV</button>
        <button id="fleet-export-xlsx" class="fleet-export-btn fleet-export-btn--xl" title="Export to Excel">\uD83D\uDCCA Excel</button>
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

  // S28: Heatmap toggle
  const heatBtn = document.getElementById('fleet-heatmap-toggle');
  if (heatBtn) {
    heatBtn.addEventListener('click', () => {
      _heatmapOn = !_heatmapOn;
      heatBtn.classList.toggle('active', _heatmapOn);
      _renderRows(_allRows);
    });
  }

  // S28: Breach Forecast toggle
  const breachBtn = document.getElementById('fleet-breach-toggle');
  if (breachBtn) {
    breachBtn.addEventListener('click', () => {
      _breachForecastOn = !_breachForecastOn;
      breachBtn.classList.toggle('active', _breachForecastOn);
      _renderRows(_allRows);
    });
  }

  // S28: listen for SLA target changes from Settings
  bus.on('settings:sla-target', ({ days }) => {
    setSlaTarget(days);
  });

  // S28: Export CSV
  const exportBtn = document.getElementById('fleet-export-csv');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => _exportCSV());
  }

  // S28: Export Excel
  const xlBtn = document.getElementById('fleet-export-xlsx');
  if (xlBtn) {
    xlBtn.addEventListener('click', async () => {
      if (!_allRows || _allRows.length === 0) {
        bus.emit('ui:toast', { type: 'warning', message: 'No data to export', duration: 2000 });
        return;
      }
      xlBtn.disabled = true; xlBtn.textContent = '...';
      try {
        const result = await ai.exportExcel({ rows: _allRows, columns: CSV_COLUMNS });
        if (result && result.ok) {
          bus.emit('ui:toast', { type: 'success', message: `Excel saved: ${result.filename}`, duration: 3000 });
        }
      } catch (e) {
        bus.emit('ui:toast', { type: 'error', message: 'Excel export failed', duration: 2500 });
      }
      xlBtn.disabled = false; xlBtn.textContent = '📊 Excel';
    });
  }


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

  // Quick-filter pills (Offsite / High Risk — not in lifecycle dropdown)
  bus.on('ui:quick-filter', ({ filter }) => {
    // Clear all filters first
    Object.keys(_filters).forEach(k => delete _filters[k]);
    _search = '';
    const searchEl = document.getElementById('tb-search');
    if (searchEl) searchEl.value = '';
    if (filter === 'all') {
      // nothing — already cleared
    } else if (filter === 'offsite') {
      _filters['lifecycleReason'] = 'offsite';
    } else if (filter === 'high-risk') {
      _quickFilterHighRisk = true;
    }
    if (filter !== 'high-risk') _quickFilterHighRisk = false;
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

// ── S28: Bulk Action Bar ─────────────────────────────────────────────────────
function _updateBulkBar() {
  let bar = document.getElementById('fleet-bulk-bar');
  const count = _selectedIds.size;

  if (count === 0) {
    if (bar) bar.style.display = 'none';
    return;
  }

  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fleet-bulk-bar';
    bar.className = 'fleet-bulk-bar';
    const wrap = document.getElementById('fleet-table-wrap');
    if (wrap) wrap.prepend(bar);
  }

  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="bulk-count">${count} unit${count > 1 ? 's' : ''} selected</span>
    <button class="bulk-btn bulk-btn--relay" id="bulk-relay">🔄 Bulk Relay Change</button>
    <button class="bulk-btn bulk-btn--export" id="bulk-export-csv">📥 Export Selected</button>
    <button class="bulk-btn bulk-btn--clear" id="bulk-clear">✕ Clear</button>
  `;

  // Wire bulk relay
  document.getElementById('bulk-relay').addEventListener('click', () => {
    _showBulkRelayModal();
  });

  // Wire bulk export
  document.getElementById('bulk-export-csv').addEventListener('click', () => {
    _exportCSV(true); // true = selected only
  });

  // Wire clear
  document.getElementById('bulk-clear').addEventListener('click', () => {
    _selectedIds.clear();
    _tbodyEl.querySelectorAll('.fleet-row-cb').forEach(cb => { cb.checked = false; });
    const selectAll = document.getElementById('fleet-select-all');
    if (selectAll) selectAll.checked = false;
    _updateBulkBar();
  });
}

// ── S28: Bulk Relay Change Modal ─────────────────────────────────────────────
function _showBulkRelayModal() {
  const count = _selectedIds.size;
  if (count === 0) return;

  // Remove existing modal if open
  const existing = document.getElementById('bulk-relay-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bulk-relay-modal';
  modal.className = 'bulk-modal-overlay';
  modal.innerHTML = `
    <div class="bulk-modal">
      <div class="bulk-modal__header">
        <span class="bulk-modal__icon">🔄</span>
        <span class="bulk-modal__title">Bulk Relay Change</span>
        <button class="bulk-modal__close" id="bulk-modal-close">✕</button>
      </div>
      <div class="bulk-modal__body">
        <p class="bulk-modal__desc">Change relay status for <strong>${count}</strong> selected unit${count > 1 ? 's' : ''}:</p>
        <div class="bulk-modal__units">${[..._selectedIds].slice(0, 8).join(', ')}${count > 8 ? ' + ' + (count - 8) + ' more' : ''}</div>
        <div class="bulk-modal__field">
          <label class="bulk-modal__label">New Relay Status</label>
          <select id="bulk-relay-status" class="bulk-modal__select">
            <option value="">— Select Status —</option>
            <option value="Available">Available</option>
            <option value="Unavailable - Scheduled">Unavailable - Scheduled</option>
            <option value="Unavailable - Unscheduled">Unavailable - Unscheduled</option>
            <option value="In Progress">In Progress</option>
            <option value="Pending Parts">Pending Parts</option>
            <option value="Ready for Pickup">Ready for Pickup</option>
            <option value="Completed">Completed</option>
          </select>
        </div>
        <div class="bulk-modal__field">
          <label class="bulk-modal__label">Reason / Note (optional)</label>
          <input type="text" id="bulk-relay-reason" class="bulk-modal__input" placeholder="e.g. EOD fleet flip, PM complete...">
        </div>
      </div>
      <div class="bulk-modal__footer">
        <button class="bulk-modal__cancel" id="bulk-modal-cancel">Cancel</button>
        <button class="bulk-modal__submit" id="bulk-modal-submit">Apply to ${count} Units</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close handlers
  const close = () => modal.remove();
  document.getElementById('bulk-modal-close').addEventListener('click', close);
  document.getElementById('bulk-modal-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Submit handler
  document.getElementById('bulk-modal-submit').addEventListener('click', async () => {
    const status = document.getElementById('bulk-relay-status').value;
    const reason = document.getElementById('bulk-relay-reason').value.trim();

    if (!status) {
      bus.emit('ui:toast', { type: 'warning', message: 'Select a relay status', duration: 2000 });
      return;
    }

    const submitBtn = document.getElementById('bulk-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    const unitIds = [..._selectedIds];
    let success = 0;
    let failed  = 0;

    for (const id of unitIds) {
      try {
        await ai.execute({
          type: 'flip_state',
          unitId: id,
          unit: id,
          data: { targetState: status, reason },
        });
        success++;
      } catch (_) {
        failed++;
      }
    }

    close();
    _selectedIds.clear();
    _tbodyEl.querySelectorAll('.fleet-row-cb').forEach(cb => { cb.checked = false; });
    const selectAll = document.getElementById('fleet-select-all');
    if (selectAll) selectAll.checked = false;
    _updateBulkBar();

    bus.emit('ui:toast', {
      type: failed === 0 ? 'success' : 'warning',
      message: `Bulk relay: ${success} queued${failed > 0 ? ', ' + failed + ' failed' : ''} — status: ${status}`,
      duration: 3500,
    });
  });
}

// ── S28: Export CSV ──────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  { key: 'equipmentId',     header: 'Unit ID' },
  { key: 'bodyType',        header: 'Body Type' },
  { key: 'operator',        header: 'Operator' },
  { key: 'domicileSite',    header: 'Domicile' },
  { key: 'lifecycleState',  header: 'Lifecycle State' },
  { key: 'lifecycleReason', header: 'Lifecycle Reason' },
  { key: 'riskScore',       header: 'Risk Score' },
  { key: 'vendor',          header: 'Vendor' },
  { key: 'duration',        header: 'Duration' },
  { key: 'manufacturer',    header: 'Make' },
  { key: 'fuelType',        header: 'Fuel Type' },
  { key: 'geofence',        header: 'Geofence' },
  { key: 'openUnplanned',   header: 'Open Unplanned WRs' },
  { key: 'openPlanned',     header: 'Open Planned WRs' },
  { key: 'dueDate',         header: 'PM Due Dates' },
  { key: 'issueSummary',    header: 'Issue Summary' },
  { key: 'savedRepairStatus',     header: 'Repair Status' },
  { key: 'savedPrimaryComponent', header: 'Primary Component' },
];

function _exportCSV(selectedOnly = false) {
  let rows = _allRows;
  if (selectedOnly && _selectedIds.size > 0) {
    rows = rows.filter(r => _selectedIds.has(r.equipmentId));
  }
  if (!rows || rows.length === 0) {
    bus.emit('ui:toast', { type: 'warning', message: 'No data to export', duration: 2000 });
    return;
  }

  // Build CSV content
  const escape = (val) => {
    const s = String(val || '').replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s + '"' : s;
  };

  const header = CSV_COLUMNS.map(c => escape(c.header)).join(',');
  const lines = rows.map(row =>
    CSV_COLUMNS.map(c => escape(row[c.key] || '')).join(',')
  );

  const csv = header + '\n' + lines.join('\n');

  // Trigger download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href     = url;
  a.download = `fleet-export-${date}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);

  bus.emit('ui:toast', { type: 'success', message: `Exported ${rows.length} units to CSV`, duration: 2500 });
}

// Expose IDs for external components
export function getPinnedIds() { return _pinnedIds; }
export function getSelectedIds() { return _selectedIds; }


// S28: SLA target setter — called from settings or bus event
export function setSlaTarget(days) {
  const n = parseInt(days, 10);
  if (n && n > 0 && n <= 30) {
    _SLA_TARGET_DAYS = n;
    localStorage.setItem('fleet_sla_target', String(n));
    if (_breachForecastOn) _renderRows(_allRows);
  }
}
export function getSlaTarget() { return _SLA_TARGET_DAYS; }
