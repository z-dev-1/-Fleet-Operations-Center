/**
 * vendors.js — Vendor management view (Stage 14)
 *
 * Pure client-side, computed from state.slice('fleet').rows.
 * No new IPC — vendor is a first-class relay-merged field on every fleet row.
 *
 * Layout:
 *   LIST view:
 *     Header: title + search + back button
 *     Summary strip: total vendors, total units at vendors, high-risk at vendors
 *     Vendor table: name / unit count / unavail / high-risk / avg risk / total cost / open WOs
 *     Click row → DRILL view for that vendor
 *
 *   DRILL view (single vendor):
 *     Header: vendor name + back-to-list button + back-to-fleet button
 *     Summary strip: unit count / unavail / high-risk / total WO cost / avg duration
 *     Unit table: ID / operator / site / lifecycle / reason / risk / WO# / cause / cost / SF / offsite
 *     Click ID → navigate:unit (opens detail drawer in fleet view)
 *
 * Reactive: updates on fleet:data bus event.
 * Entering view always re-computes from latest rows.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el         = null;
let _view       = 'list';     // 'list' | 'drill'
let _drillVendor = '';
let _search     = '';

// ── Helpers ───────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;

function _costNum(s) {
  if (!s) return 0;
  const m = String(s).replace(/[$,]/g, '').match(/(\d[\d.]*)/);
  return m ? parseFloat(m[1]) : 0;
}

function _fmtCost(n) {
  if (!n) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function _fmtAvgRisk(n) {
  return n !== null && n !== undefined ? Math.round(n) : '—';
}

function _riskClass(score) {
  if (score >= 75) return 'risk-high';
  if (score >= 40) return 'risk-med';
  return 'risk-low';
}

// ── Compute vendor map from fleet rows ─────────────────────────────────────
function _buildVendorMap(rows) {
  const map = {};
  for (const r of rows) {
    const v = (r.vendor || '').trim();
    if (!v) continue;
    if (!map[v]) map[v] = { units: [], totalCost: 0, unavail: 0, highRisk: 0, riskSum: 0, openWOs: 0 };
    map[v].units.push(r);
    map[v].totalCost += _costNum(r.totalCost);
    if ((r.lifecycleState || '').toLowerCase().includes('unavailable')) map[v].unavail++;
    const rs = r.riskScore || 0;
    if (rs >= 75) map[v].highRisk++;
    map[v].riskSum += rs;
    if ((r.openUnplanned || 0) > 0 || (r.vendorWorkOrderId || '')) map[v].openWOs++;
  }
  return map;
}

// ── LIST view renderers ───────────────────────────────────────────────────
function _renderListSummary(rows, vendorMap) {
  const vendorCount    = Object.keys(vendorMap).length;
  const unitsAtVendors = rows.filter(r => (r.vendor || '').trim()).length;
  const highRiskAtV    = rows.filter(r => (r.vendor || '').trim() && (r.riskScore || 0) >= 75).length;
  return `
    <div class="vm-strip">
      <div class="vm-kpi">
        <span class="vm-kpi__val">${vendorCount}</span>
        <span class="vm-kpi__lbl">Vendors</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${unitsAtVendors}</span>
        <span class="vm-kpi__lbl">Units at vendors</span>
      </div>
      <div class="vm-kpi vm-kpi--risk">
        <span class="vm-kpi__val">${highRiskAtV}</span>
        <span class="vm-kpi__lbl">High risk at vendors</span>
      </div>
    </div>`;
}

function _renderVendorTable(vendorMap, search) {
  let entries = Object.entries(vendorMap).sort((a, b) => b[1].units.length - a[1].units.length);
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(([name]) => name.toLowerCase().includes(q));
  }
  if (!entries.length) {
    return search
      ? `<span class="vm-empty">No vendors match "${_safe(search)}"</span>`
      : `<span class="vm-empty">No vendor data — run a relay sync to populate vendors</span>`;
  }
  const headerRow = `
    <tr>
      <th>Vendor</th>
      <th class="vm-tbl--r">Units</th>
      <th class="vm-tbl--r">Unavail</th>
      <th class="vm-tbl--r">High risk</th>
      <th class="vm-tbl--r">Avg risk</th>
      <th class="vm-tbl--r">Total WO cost</th>
      <th class="vm-tbl--r">Open WOs</th>
    </tr>`;
  const dataRows = entries.map(([name, d]) => {
    const avgRisk   = d.units.length ? Math.round(d.riskSum / d.units.length) : 0;
    const riskCls   = _riskClass(avgRisk);
    return `
      <tr class="vm-vendor-row" data-vendor="${_safe(name)}">
        <td class="vm-vendor-name">${_safe(name)}</td>
        <td class="vm-tbl--r">${d.units.length}</td>
        <td class="vm-tbl--r ${d.unavail   > 0 ? 'vm-cell--warn'   : ''}">${d.unavail}</td>
        <td class="vm-tbl--r ${d.highRisk  > 0 ? 'vm-cell--danger' : ''}">${d.highRisk}</td>
        <td class="vm-tbl--r">
          <span class="vm-risk-badge vm-risk-badge--${riskCls}">${avgRisk}</span>
        </td>
        <td class="vm-tbl--r ${d.totalCost > 0 ? 'vm-cell--cost' : ''}">${_fmtCost(d.totalCost)}</td>
        <td class="vm-tbl--r ${d.openWOs   > 0 ? 'vm-cell--accent' : ''}">${d.openWOs}</td>
      </tr>`;
  }).join('');
  return `
    <table class="vm-table" id="vm-vendor-table">
      <thead>${headerRow}</thead>
      <tbody>${dataRows}</tbody>
    </table>`;
}

// ── DRILL view renderers ──────────────────────────────────────────────────
function _renderDrillSummary(d) {
  const avgRisk   = d.units.length ? Math.round(d.riskSum / d.units.length) : 0;
  const avgDurSec = d.units.filter(r => r.workDuration).length;
  return `
    <div class="vm-strip">
      <div class="vm-kpi">
        <span class="vm-kpi__val">${d.units.length}</span>
        <span class="vm-kpi__lbl">Units</span>
      </div>
      <div class="vm-kpi ${d.unavail > 0 ? 'vm-kpi--warn' : ''}">
        <span class="vm-kpi__val">${d.unavail}</span>
        <span class="vm-kpi__lbl">Unavailable</span>
      </div>
      <div class="vm-kpi ${d.highRisk > 0 ? 'vm-kpi--risk' : ''}">
        <span class="vm-kpi__val">${d.highRisk}</span>
        <span class="vm-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${_fmtAvgRisk(avgRisk)}</span>
        <span class="vm-kpi__lbl">Avg risk score</span>
      </div>
      <div class="vm-kpi ${d.totalCost > 0 ? 'vm-kpi--cost' : ''}">
        <span class="vm-kpi__val">${_fmtCost(d.totalCost)}</span>
        <span class="vm-kpi__lbl">Total WO cost</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${d.openWOs}</span>
        <span class="vm-kpi__lbl">Open WOs</span>
      </div>
    </div>`;
}

function _renderDrillTable(units) {
  if (!units.length) return '<span class="vm-empty">No units</span>';
  const headerRow = `
    <tr>
      <th>ID</th>
      <th>Operator</th>
      <th>Site</th>
      <th>Lifecycle</th>
      <th>Reason</th>
      <th class="vm-tbl--r">Risk</th>
      <th>WO #</th>
      <th>Cause</th>
      <th class="vm-tbl--r">Cost</th>
      <th>SF Case</th>
      <th>Offsite</th>
      <th>Sub Vendor</th>
    </tr>`;
  const dataRows = units.map(r => {
    const rs      = r.riskScore || 0;
    const riskCls = _riskClass(rs);
    const lc      = (r.lifecycleState || '').toLowerCase();
    const lcCls   = lc.includes('unavailable') ? 'lc--unavailable' : lc.includes('available') ? 'lc--available' : '';
    const sfHtml  = (r.savedSalesforceCaseUrl || r.salesforceCaseUrl)
      ? `<a class="vm-link" href="${_safe(r.savedSalesforceCaseUrl || r.salesforceCaseUrl)}" target="_blank" rel="noreferrer">${_safe(r.savedSalesforceCase || r.salesforceCase || 'SF')}</a>`
      : _safe(r.savedSalesforceCase || r.salesforceCase || '—');
    // S25-10: prefer enriched ASIST label/URL over raw service_request URL
    const _offUrl   = r.savedOffsiteUrl || r.offsiteShopEventUrl || '';
    const _offLabel = r.asistLabel || r.savedOffsiteEvent || r.offsiteShopEvent || 'Link';
    const _srcBadge = r.asistSource === 'estimate' ? ' [Est]' : r.asistSource === 'case' ? ' [Case]' : '';
    const offsiteHtml = _offUrl
      ? `<a class="vm-link" href="${_safe(_offUrl)}" target="_blank" rel="noreferrer">${_safe(_offLabel + _srcBadge)}</a>`
      : _safe(r.savedOffsiteEvent || r.offsiteShopEvent || '--');
    return `
      <tr>
        <td><span class="vm-unit-id vm-unit-link" data-unit="${_safe(r.equipmentId)}">${_safe(r.equipmentId)}</span></td>
        <td class="vm-tbl--mono">${_safe((r.operator || '').toUpperCase())}</td>
        <td class="vm-tbl--mono">${_safe(r.domicileSite || '')}</td>
        <td class="${lcCls}">${_safe(r.lifecycleState || '')}</td>
        <td class="vm-tbl--reason">${_safe(r.lifecycleReason || '')}</td>
        <td class="vm-tbl--r"><span class="vm-risk-badge vm-risk-badge--${riskCls}">${rs}</span></td>
        <td class="vm-tbl--mono">${_safe(r.vendorWorkOrderId || '—')}</td>
        <td class="vm-tbl--cause" title="${_safe(r.cause)}">${_safe(r.cause ? r.cause.slice(0, 50) + (r.cause.length > 50 ? '...' : '') : '—')}</td>
        <td class="vm-tbl--r ${r.totalCost ? 'vm-cell--cost' : ''}">${_safe(r.totalCost || '—')}</td>
        <td>${sfHtml}</td>
        <td>${offsiteHtml}</td>
        <td class="vm-tbl--subvendor">${r.subVendor || r.dealerName ? `<span class="vm-sub-vendor-pill">${_safe(r.subVendor || r.dealerName)}</span>` : "<span class=\"vm-sub-vendor-none\">--</span>"}</td>
      </tr>`;
  }).join('');
  return `
    <div class="vm-drill-scroll">
      <table class="vm-table vm-table--drill">
        <thead>${headerRow}</thead>
        <tbody>${dataRows}</tbody>
      </table>
    </div>`;
}

// ── Full view HTML template ───────────────────────────────────────────────
function _viewHtml() {
  return `
    <!-- LIST panel -->
    <div id="vm-list-panel" class="vm-panel">
      <div class="vm-header">
        <div class="vm-header__left">
          <span class="vm-title">Vendors</span>
          <span class="vm-subtitle">All vendors from relay-synced fleet data</span>
        </div>
        <div class="vm-header__actions">
          <input id="vm-search" class="vm-search-input" type="text" placeholder="Search vendors..." autocomplete="off" />
          <button id="vm-back-fleet" class="detail-panel__btn">Back to Fleet</button>
        </div>
      </div>
      <div id="vm-list-summary"></div>
      <div class="vm-body">
        <div id="vm-list-content"></div>
      </div>
    </div>

    <!-- DRILL panel -->
    <div id="vm-drill-panel" class="vm-panel" style="display:none">
      <div class="vm-header">
        <div class="vm-header__left">
          <span class="vm-title" id="vm-drill-title">Vendor</span>
          <span class="vm-subtitle">Units currently at this vendor</span>
        </div>
        <div class="vm-header__actions">
          <button id="vm-drill-back-list"  class="detail-panel__btn detail-panel__btn--secondary">← Vendors</button>
          <button id="vm-drill-back-fleet" class="detail-panel__btn">Back to Fleet</button>
        </div>
      </div>
      <div id="vm-drill-summary"></div>
      <div class="vm-body">
        <div id="vm-drill-content"></div>
      </div>
    </div>
  `;
}

// ── Render helpers ────────────────────────────────────────────────────────
function _showPanel(which) {
  if (!_el) return;
  _el.querySelector('#vm-list-panel').style.display  = which === 'list'  ? 'flex' : 'none';
  _el.querySelector('#vm-drill-panel').style.display = which === 'drill' ? 'flex' : 'none';
}

function _renderList(rows) {
  if (!_el) return;
  const vendorMap = _buildVendorMap(rows);
  const summaryEl = _el.querySelector('#vm-list-summary');
  const contentEl = _el.querySelector('#vm-list-content');
  if (summaryEl) summaryEl.innerHTML = _renderListSummary(rows, vendorMap);
  if (contentEl) contentEl.innerHTML = _renderVendorTable(vendorMap, _search);
  _wireVendorClicks(vendorMap);
}

function _renderDrill(rows, vendorName) {
  if (!_el) return;
  const vendorMap = _buildVendorMap(rows);
  const d = vendorMap[vendorName] || { units: [], totalCost: 0, unavail: 0, highRisk: 0, riskSum: 0, openWOs: 0 };
  const titleEl   = _el.querySelector('#vm-drill-title');
  const summaryEl = _el.querySelector('#vm-drill-summary');
  const contentEl = _el.querySelector('#vm-drill-content');
  if (titleEl)   titleEl.textContent = vendorName;
  if (summaryEl) summaryEl.innerHTML = _renderDrillSummary(d);
  if (contentEl) contentEl.innerHTML = _renderDrillTable(d.units);
  _wireUnitLinks();
}

function _wireVendorClicks(vendorMap) {
  const table = _el ? _el.querySelector('#vm-vendor-table') : null;
  if (!table) return;
  table.querySelectorAll('tr.vm-vendor-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const vendorName = tr.dataset.vendor;
      if (!vendorName || !vendorMap[vendorName]) return;
      _drillVendor = vendorName;
      _view = 'drill';
      _showPanel('drill');
      _renderDrill(state.slice('fleet').rows || [], vendorName);
    });
  });
}

function _wireUnitLinks() {
  const panel = _el ? _el.querySelector('#vm-drill-panel') : null;
  if (!panel) return;
  panel.querySelectorAll('.vm-unit-link').forEach(span => {
    span.addEventListener('click', () => {
      const unitId = span.dataset.unit;
      if (!unitId) return;
      // Navigate to fleet view and open the unit drawer
      bus.emit('ui:view-change', { from: 'vendors', to: 'fleet' });
      setTimeout(() => bus.emit('navigate:unit', unitId), 50);
    });
  });
}

// ── Full update ───────────────────────────────────────────────────────────
function _update(rows) {
  if (_view === 'list') {
    _renderList(rows);
  } else if (_view === 'drill' && _drillVendor) {
    _renderDrill(rows, _drillVendor);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-vendors';
  _el.className = 'view view--vendors';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  // Search input
  _el.querySelector('#vm-search').addEventListener('input', (e) => {
    _search = e.target.value.trim();
    const rows = state.slice('fleet').rows || [];
    _renderList(rows);
  });

  // Back to fleet (list panel)
  _el.querySelector('#vm-back-fleet').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'vendors', to: 'fleet' });
  });

  // Back to list (drill panel)
  _el.querySelector('#vm-drill-back-list').addEventListener('click', () => {
    _view = 'list';
    _showPanel('list');
    _renderList(state.slice('fleet').rows || []);
  });

  // Back to fleet (drill panel)
  _el.querySelector('#vm-drill-back-fleet').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'vendors', to: 'fleet' });
  });

  // Reactive on fleet data push
  bus.on('fleet:data', (data) => {
    _update((data && data.rows) ? data.rows : []);
  });

  // Show/hide + refresh on view change
  bus.on('ui:view-change', ({ to, from }) => {
    _el.style.display = to === 'vendors' ? 'flex' : 'none';
    if (to === 'vendors') {
      // Always return to list when entering from outside
      if (from !== 'vendors') {
        _view = 'list';
        _search = '';
        const inp = _el.querySelector('#vm-search');
        if (inp) inp.value = '';
        _showPanel('list');
      }
      _update(state.slice('fleet').rows || []);
    }
  });

  // Initial render
  _update(state.slice('fleet').rows || []);
}
