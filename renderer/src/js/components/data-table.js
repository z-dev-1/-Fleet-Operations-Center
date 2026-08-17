/**
 * data-table.js — Virtual-scrolling data table component
 *
 * Phase 5: Renders only visible rows + buffer (typically 30-50 rows in DOM
 * regardless of dataset size). Eliminates the 28,000 DOM node rebuild on
 * every fleet data push.
 *
 * Usage:
 *   import { DataTable } from '../components/data-table.js';
 *
 *   const table = new DataTable({
 *     container: document.getElementById('fleet-table-wrap'),
 *     columns: [
 *       { key: 'equipmentId', label: 'Unit ID', width: '110px', sortable: true },
 *       { key: 'vendor',      label: 'Vendor',  width: '130px', sortable: true },
 *     ],
 *     rowHeight: 36,          // fixed row height in px
 *     bufferRows: 10,         // extra rows rendered above/below viewport
 *     renderCell: (row, col) => { return { html: '...', cls: '' }; },
 *     onRowClick: (row, e) => {},
 *     onSort: (key, dir) => {},
 *     rowClass: (row) => '',  // optional: add class to <tr>
 *     rowId: (row) => row.equipmentId,  // unique key per row
 *   });
 *
 *   table.setData(filteredRows);  // full replace
 *   table.refresh();              // re-render visible rows (e.g. after selection change)
 *   table.scrollToRow(index);     // programmatic scroll
 *   table.destroy();              // cleanup
 */

const ROW_HEIGHT_DEFAULT = 36;
const BUFFER_DEFAULT     = 10;

export class DataTable {
  constructor(opts) {
    this._container   = opts.container;
    this._columns     = opts.columns || [];
    this._rowHeight   = opts.rowHeight || ROW_HEIGHT_DEFAULT;
    this._buffer      = opts.bufferRows || BUFFER_DEFAULT;
    this._renderCell  = opts.renderCell || _defaultRenderCell;
    this._onRowClick  = opts.onRowClick || null;
    this._onSort      = opts.onSort || null;
    this._rowClass    = opts.rowClass || (() => '');
    this._rowId       = opts.rowId || ((r, i) => i);
    this._data        = [];
    this._visibleStart = 0;
    this._visibleEnd   = 0;
    this._sortKey      = null;
    this._sortDir      = 'asc';

    this._build();
    this._bindScroll();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Replace all data and re-render */
  setData(rows) {
    this._data = rows || [];
    this._updateSpacer();
    this._renderVisible();
  }

  /** Re-render currently visible rows (selection change, etc.) */
  refresh() {
    this._renderVisible();
  }

  /** Scroll to a specific row index */
  scrollToRow(index) {
    const top = index * this._rowHeight;
    this._scrollEl.scrollTop = top;
  }

  /** Get current sort state */
  getSort() {
    return { key: this._sortKey, dir: this._sortDir };
  }

  /** Set sort state externally */
  setSort(key, dir) {
    this._sortKey = key;
    this._sortDir = dir || 'asc';
    this._updateHeaderSort();
  }

  /** Cleanup */
  destroy() {
    if (this._scrollHandler) {
      this._scrollEl.removeEventListener('scroll', this._scrollHandler);
    }
    this._container.innerHTML = '';
  }

  // ── Build DOM ───────────────────────────────────────────────────────────

  _build() {
    this._container.innerHTML = '';

    // Wrapper table element
    const tableEl = document.createElement('div');
    tableEl.className = 'dt-wrap';
    tableEl.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'dt-header';
    headerEl.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid var(--bdr,#21262d);background:var(--el,#161b22);';
    this._columns.forEach((col) => {
      const th = document.createElement('div');
      th.className = 'dt-th';
      th.dataset.key = col.key;
      th.style.cssText = 'width:' + (col.width || '100px') + ';padding:8px 6px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--mut,#6e7681);cursor:' + (col.sortable !== false ? 'pointer' : 'default') + ';user-select:none;display:flex;align-items:center;gap:4px;flex-shrink:0;';
      th.textContent = col.label || '';
      if (col.sortable !== false) {
        th.addEventListener('click', () => this._handleSort(col.key));
      }
      headerEl.appendChild(th);
    });
    this._headerEl = headerEl;
    tableEl.appendChild(headerEl);

    // Scroll container
    const scrollEl = document.createElement('div');
    scrollEl.className = 'dt-scroll';
    scrollEl.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;position:relative;';

    // Spacer (maintains scroll height for virtual scrolling)
    const spacer = document.createElement('div');
    spacer.className = 'dt-spacer';
    spacer.style.cssText = 'width:1px;position:relative;';
    this._spacerEl = spacer;

    // Visible rows container (positioned absolutely within spacer)
    const viewport = document.createElement('div');
    viewport.className = 'dt-viewport';
    viewport.style.cssText = 'position:absolute;top:0;left:0;right:0;';
    this._viewportEl = viewport;

    spacer.appendChild(viewport);
    scrollEl.appendChild(spacer);
    tableEl.appendChild(scrollEl);

    this._scrollEl = scrollEl;
    this._container.appendChild(tableEl);
  }

  _bindScroll() {
    this._scrollHandler = () => this._renderVisible();
    this._scrollEl.addEventListener('scroll', this._scrollHandler, { passive: true });
  }

  // ── Virtual Scroll Logic ────────────────────────────────────────────────

  _updateSpacer() {
    const totalHeight = this._data.length * this._rowHeight;
    this._spacerEl.style.height = totalHeight + 'px';
  }

  _renderVisible() {
    const scrollTop  = this._scrollEl.scrollTop;
    const viewHeight = this._scrollEl.clientHeight;
    const totalRows  = this._data.length;

    let startIdx = Math.floor(scrollTop / this._rowHeight) - this._buffer;
    let endIdx   = Math.ceil((scrollTop + viewHeight) / this._rowHeight) + this._buffer;

    startIdx = Math.max(0, startIdx);
    endIdx   = Math.min(totalRows, endIdx);

    // Skip re-render if visible range hasn't changed
    if (startIdx === this._visibleStart && endIdx === this._visibleEnd) return;
    this._visibleStart = startIdx;
    this._visibleEnd   = endIdx;

    // Position viewport
    this._viewportEl.style.top = (startIdx * this._rowHeight) + 'px';

    // Build rows
    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
      const row = this._data[i];
      const id  = this._rowId(row, i);
      const cls = this._rowClass(row) || '';
      html += '<div class="dt-row ' + cls + '" data-idx="' + i + '" data-id="' + _escAttr(id) + '" style="display:flex;height:' + this._rowHeight + 'px;align-items:center;border-bottom:1px solid var(--bdr,#21262d);cursor:pointer;transition:background .1s;">';
      for (let c = 0; c < this._columns.length; c++) {
        const col  = this._columns[c];
        const cell = this._renderCell(row, col, i);
        const cellCls = (cell && cell.cls) || '';
        const cellHtml = (cell && cell.html != null) ? cell.html : _escHtml(String(row[col.key] || ''));
        html += '<div class="dt-cell ' + cellCls + '" style="width:' + (col.width || '100px') + ';padding:0 6px;font-size:11px;color:var(--txt2,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">' + cellHtml + '</div>';
      }
      html += '</div>';
    }
    this._viewportEl.innerHTML = html;

    // Bind row click (event delegation on viewport)
    this._viewportEl.onclick = (e) => {
      if (!this._onRowClick) return;
      const rowEl = e.target.closest('.dt-row');
      if (!rowEl) return;
      const idx = parseInt(rowEl.dataset.idx, 10);
      if (idx >= 0 && idx < this._data.length) {
        this._onRowClick(this._data[idx], e);
      }
    };
  }

  // ── Sort ────────────────────────────────────────────────────────────────

  _handleSort(key) {
    if (this._sortKey === key) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortKey = key;
      this._sortDir = 'asc';
    }
    this._updateHeaderSort();
    if (this._onSort) this._onSort(this._sortKey, this._sortDir);
  }

  _updateHeaderSort() {
    // Remove sort indicators from all headers
    this._headerEl.querySelectorAll('.dt-th').forEach((th) => {
      th.style.color = 'var(--mut,#6e7681)';
      const arrow = th.querySelector('.dt-sort-arrow');
      if (arrow) arrow.remove();
    });
    // Add to active
    if (this._sortKey) {
      const active = this._headerEl.querySelector('[data-key="' + this._sortKey + '"]');
      if (active) {
        active.style.color = 'var(--acc,#58a6ff)';
        const arrow = document.createElement('span');
        arrow.className = 'dt-sort-arrow';
        arrow.textContent = this._sortDir === 'asc' ? '▲' : '▼';
        arrow.style.cssText = 'font-size:8px;opacity:.7;';
        active.appendChild(arrow);
      }
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _defaultRenderCell(row, col) {
  return { html: _escHtml(String(row[col.key] || '')), cls: '' };
}
