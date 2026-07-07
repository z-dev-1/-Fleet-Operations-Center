/**
 * analytics.js — Fleet KPI analytics dashboard (Stage 13)
 *
 * Pure client-side computation from state.slice('fleet').rows.
 * No new IPC needed — all data is available in the renderer state.
 *
 * Sections:
 *   1. Summary bar         — total, unavailable %, available %, high-risk
 *   2. Lifecycle breakdown — CSS bar chart per lifecycle state
 *   3. By-operator table   — total / unavail / high-risk / open-WR per op
 *   4. Risk distribution   — HIGH/MEDIUM/LOW tiers with mini bars
 *   5. Top vendors         — ranked vendor counts from row.vendor (relay-merged)
 *   6. PM due dates        — pmB / pmX / DOT overdue/due-soon counts
 *   7. Body-type mix       — asset type distribution bar chart
 *
 * S13-fix: vendor data derived from row.vendor (relay-merged field on every
 * fleet row) — no relay cache IPC needed, relay bridge import removed.
 *
 * Updates reactively on fleet:data bus events.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el = null;

// ── Helpers ────────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;

// ── PM field parser ────────────────────────────────────────────────────────
// pmB / pmX / dot values come as strings: "3 days", "overdue", "0 days", "--"
function _pmDaysNum(s) {
  if (!s || s === '--') return null;
  const lo = s.toLowerCase().trim();
  if (lo === 'overdue' || lo.startsWith('overdue'))  return -1;
  if (lo === '0 days' || lo === '0')                 return 0;
  const m = lo.match(/^(-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Core computation ───────────────────────────────────────────────────────
function _compute(rows) {
  const total = rows.length;

  // — Lifecycle buckets —
  const lcMap = {};
  for (const r of rows) {
    const lc = (r.lifecycleState || 'Unknown').trim();
    lcMap[lc] = (lcMap[lc] || 0) + 1;
  }
  const lcSorted = Object.entries(lcMap).sort((a, b) => b[1] - a[1]);

  const unavailCount = rows.filter(r => {
    const s = (r.lifecycleState || '').toLowerCase();
    return s.includes('unavailable');
  }).length;
  const availCount = rows.filter(r => {
    const s = (r.lifecycleState || '').toLowerCase();
    return s.includes('available') && !s.includes('un');
  }).length;

  // — Risk tiers —
  const highRisk = rows.filter(r => (r.riskScore || 0) >= 75).length;
  const medRisk  = rows.filter(r => { const s = r.riskScore || 0; return s >= 40 && s < 75; }).length;
  const lowRisk  = rows.filter(r => (r.riskScore || 0) < 40).length;

  // — By operator —
  const opMap = {};
  for (const r of rows) {
    const op = (r.operator || 'Unknown').toUpperCase().trim();
    if (!opMap[op]) opMap[op] = { total: 0, unavail: 0, highRisk: 0, openWR: 0 };
    opMap[op].total++;
    if ((r.lifecycleState || '').toLowerCase().includes('unavailable')) opMap[op].unavail++;
    if ((r.riskScore || 0) >= 75) opMap[op].highRisk++;
    if ((r.openUnplanned || 0) > 0) opMap[op].openWR++;
  }
  const opSorted = Object.entries(opMap).sort((a, b) => b[1].total - a[1].total);

  // — Top vendors — derived from row.vendor (relay-merged field on every fleet row)
  const vendMap = {};
  for (const r of rows) {
    const v = (r.vendor || '').trim();
    if (v) vendMap[v] = (vendMap[v] || 0) + 1;
  }
  const vendSorted = Object.entries(vendMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // — PM health —
  let pmBOver = 0, pmBSoon = 0;
  let pmXOver = 0, pmXSoon = 0;
  let dotOver = 0, dotSoon = 0;
  const SOON_DAYS = 14;
  for (const r of rows) {
    const b = _pmDaysNum(r.pmB);
    const x = _pmDaysNum(r.pmX);
    const d = _pmDaysNum(r.dot);
    if (b !== null) { if (b < 0) pmBOver++; else if (b <= SOON_DAYS) pmBSoon++; }
    if (x !== null) { if (x < 0) pmXOver++; else if (x <= SOON_DAYS) pmXSoon++; }
    if (d !== null) { if (d < 0) dotOver++; else if (d <= SOON_DAYS) dotSoon++; }
  }

  // — Body-type mix —
  const btMap = {};
  for (const r of rows) {
    const bt = (r.assetType || r.bodyType || 'Unknown').trim();
    btMap[bt] = (btMap[bt] || 0) + 1;
  }
  const btSorted = Object.entries(btMap).sort((a, b) => b[1] - a[1]);

  // — Sync meta —
  const fleetState = state.slice('fleet');
  const syncedAt   = fleetState.syncedAt;
  const stale      = fleetState.stale;

  return {
    total, unavailCount, availCount, highRisk, medRisk, lowRisk,
    lcSorted, opSorted, vendSorted,
    pmBOver, pmBSoon, pmXOver, pmXSoon, dotOver, dotSoon,
    btSorted,
    syncedAt, stale,
  };
}

// ── Bar render helper ─────────────────────────────────────────────────────
function _bar(value, max, cls) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="an-bar-track"><div class="an-bar-fill an-bar-fill--${cls}" style="width:${pct}%"></div></div>`;
}

// ── HTML renderers ────────────────────────────────────────────────────────

function _renderSummary(c) {
  const unavailPct  = _pct(c.unavailCount, c.total);
  const availPct    = _pct(c.availCount,   c.total);
  const highRiskPct = _pct(c.highRisk,     c.total);
  const staleHtml = c.stale
    ? `<div class="an-stale-banner">⚠ Data may be stale — trigger a sync for current counts</div>`
    : '';
  const syncedStr = c.syncedAt
    ? new Date(c.syncedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : 'never';
  return `
    ${staleHtml}
    <div class="an-summary-bar">
      <div class="an-kpi an-kpi--total">
        <span class="an-kpi__val">${c.total}</span>
        <span class="an-kpi__lbl">Total units</span>
      </div>
      <div class="an-kpi an-kpi--unavail">
        <span class="an-kpi__val">${c.unavailCount} <span class="an-kpi__pct">${unavailPct}%</span></span>
        <span class="an-kpi__lbl">Unavailable</span>
      </div>
      <div class="an-kpi an-kpi--avail">
        <span class="an-kpi__val">${c.availCount} <span class="an-kpi__pct">${availPct}%</span></span>
        <span class="an-kpi__lbl">Available</span>
      </div>
      <div class="an-kpi an-kpi--risk">
        <span class="an-kpi__val">${c.highRisk} <span class="an-kpi__pct">${highRiskPct}%</span></span>
        <span class="an-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="an-kpi an-kpi--synced">
        <span class="an-kpi__val an-kpi__val--sm">${syncedStr}</span>
        <span class="an-kpi__lbl">Last synced</span>
      </div>
    </div>`;
}

function _renderLifecycle(c) {
  if (!c.lcSorted.length) return '<span class="an-empty">No data</span>';
  const maxCount = c.lcSorted[0][1];
  const rows = c.lcSorted.map(([lc, count]) => {
    const lo  = lc.toLowerCase();
    const cls = lo.includes('unavailable') ? 'unavail'
              : lo.includes('available')   ? 'avail'
              : 'other';
    return `
      <div class="an-lc-row">
        <span class="an-lc-label" title="${_safe(lc)}">${_safe(lc)}</span>
        <div class="an-lc-bar-wrap">${_bar(count, maxCount, cls)}</div>
        <span class="an-lc-count">${count}</span>
        <span class="an-lc-pct">${_pct(count, c.total)}%</span>
      </div>`;
  }).join('');
  return `<div class="an-lc-chart">${rows}</div>`;
}

function _renderRisk(c) {
  const total = c.total || 1;
  const items = [
    { label: 'HIGH ≥75',  count: c.highRisk, cls: 'risk-high' },
    { label: 'MED 40–74', count: c.medRisk,  cls: 'risk-med'  },
    { label: 'LOW <40',   count: c.lowRisk,  cls: 'risk-low'  },
  ];
  return `
    <div class="an-risk-wrap">
      ${items.map(item => `
        <div class="an-risk-tier">
          <div class="an-risk-tier__header">
            <span class="an-risk-badge an-risk-badge--${item.cls}">${item.label}</span>
            <span class="an-risk-tier__count">${item.count}</span>
            <span class="an-risk-tier__pct">${_pct(item.count, total)}%</span>
          </div>
          ${_bar(item.count, total, item.cls)}
        </div>`).join('')}
    </div>`;
}

function _renderOperators(c) {
  if (!c.opSorted.length) return '<span class="an-empty">No data</span>';
  const headerRow = `
    <tr>
      <th>Operator</th>
      <th class="an-tbl--r">Total</th>
      <th class="an-tbl--r">Unavail</th>
      <th class="an-tbl--r">Unavail %</th>
      <th class="an-tbl--r">High risk</th>
      <th class="an-tbl--r">Open WRs</th>
    </tr>`;
  const dataRows = c.opSorted.map(([op, d]) => `
    <tr>
      <td class="an-op-name">${_safe(op)}</td>
      <td class="an-tbl--r">${d.total}</td>
      <td class="an-tbl--r ${d.unavail   > 0 ? 'an-cell--warn'   : ''}">${d.unavail}</td>
      <td class="an-tbl--r">${_pct(d.unavail, d.total)}%</td>
      <td class="an-tbl--r ${d.highRisk  > 0 ? 'an-cell--danger' : ''}">${d.highRisk}</td>
      <td class="an-tbl--r ${d.openWR    > 0 ? 'an-cell--accent' : ''}">${d.openWR}</td>
    </tr>`).join('');
  return `<table class="an-table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>`;
}

function _renderVendors(c) {
  if (!c.vendSorted.length) return '<span class="an-empty">No vendor data — run a relay sync first</span>';
  const maxCount = c.vendSorted[0][1];
  const rows = c.vendSorted.map(([vendor, count]) => `
    <div class="an-vend-row">
      <span class="an-vend-name" title="${_safe(vendor)}">${_safe(vendor)}</span>
      <div class="an-vend-bar-wrap">${_bar(count, maxCount, 'vendor')}</div>
      <span class="an-vend-count">${count}</span>
    </div>`).join('');
  return `<div class="an-vend-chart">${rows}</div>`;
}

function _renderPM(c) {
  const items = [
    { label: 'PM B', overdue: c.pmBOver, soon: c.pmBSoon },
    { label: 'PM X', overdue: c.pmXOver, soon: c.pmXSoon },
    { label: 'DOT',  overdue: c.dotOver, soon: c.dotSoon  },
  ];
  return `
    <div class="an-pm-wrap">
      ${items.map(item => `
        <div class="an-pm-card">
          <div class="an-pm-card__title">${item.label}</div>
          <div class="an-pm-card__rows">
            <div class="an-pm-row an-pm-row--over">
              <span class="an-pm-dot an-pm-dot--over"></span>
              <span class="an-pm-lbl">Overdue</span>
              <span class="an-pm-val ${item.overdue > 0 ? 'an-pm-val--danger' : ''}">${item.overdue}</span>
            </div>
            <div class="an-pm-row an-pm-row--soon">
              <span class="an-pm-dot an-pm-dot--soon"></span>
              <span class="an-pm-lbl">Due ≤14 days</span>
              <span class="an-pm-val ${item.soon > 0 ? 'an-pm-val--warn' : ''}">${item.soon}</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

function _renderBodyTypes(c) {
  if (!c.btSorted.length) return '<span class="an-empty">No data</span>';
  const maxCount = c.btSorted[0][1];
  const rows = c.btSorted.map(([bt, count]) => `
    <div class="an-bt-row">
      <span class="an-bt-label" title="${_safe(bt)}">${_safe(bt)}</span>
      <div class="an-bt-bar-wrap">${_bar(count, maxCount, 'bodytype')}</div>
      <span class="an-bt-count">${count}</span>
      <span class="an-bt-pct">${_pct(count, c.total)}%</span>
    </div>`).join('');
  return `<div class="an-bt-chart">${rows}</div>`;
}

// ── Full dashboard HTML ───────────────────────────────────────────────────
function _dashboardHtml() {
  return `
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Analytics</span>
        <span class="an-subtitle">Fleet KPI dashboard — computed from current sync data</span>
      </div>
      <div class="an-header__actions">
        <button id="an-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="an-back"    class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>

    <div class="an-body">

      <!-- Summary bar -->
      <div id="an-summary"></div>

      <!-- Two-col grid: lifecycle + risk -->
      <div class="an-grid-2">
        <div class="an-card">
          <div class="an-card__title">Lifecycle Breakdown</div>
          <div id="an-lifecycle"></div>
        </div>
        <div class="an-card">
          <div class="an-card__title">Risk Distribution</div>
          <div id="an-risk"></div>
        </div>
      </div>

      <!-- PM health + body-type mix -->
      <div class="an-grid-2">
        <div class="an-card">
          <div class="an-card__title">PM Due Dates</div>
          <div class="an-card__hint">Computed from pmB / pmX / DOT fields</div>
          <div id="an-pm"></div>
        </div>
        <div class="an-card">
          <div class="an-card__title">Asset Type Mix</div>
          <div id="an-bodytypes"></div>
        </div>
      </div>

      <!-- Full-width: by-operator -->
      <div class="an-card">
        <div class="an-card__title">By Operator</div>
        <div id="an-operators"></div>
      </div>

      <!-- Full-width: vendor distribution -->
      <div class="an-card">
        <div class="an-card__title">Top Vendors</div>
        <div id="an-vendors"></div>
      </div>

    </div>
  `;
}

// ── Render / update ───────────────────────────────────────────────────────
function _update(rows) {
  if (!_el) return;
  const c = _compute(rows);

  const summaryEl   = _el.querySelector('#an-summary');
  const lifecycleEl = _el.querySelector('#an-lifecycle');
  const riskEl      = _el.querySelector('#an-risk');
  const operatorsEl = _el.querySelector('#an-operators');
  const vendorsEl   = _el.querySelector('#an-vendors');
  const pmEl        = _el.querySelector('#an-pm');
  const btEl        = _el.querySelector('#an-bodytypes');

  if (summaryEl)   summaryEl.innerHTML   = _renderSummary(c);
  if (lifecycleEl) lifecycleEl.innerHTML = _renderLifecycle(c);
  if (riskEl)      riskEl.innerHTML      = _renderRisk(c);
  if (operatorsEl) operatorsEl.innerHTML = _renderOperators(c);
  if (vendorsEl)   vendorsEl.innerHTML   = _renderVendors(c);
  if (pmEl)        pmEl.innerHTML        = _renderPM(c);
  if (btEl)        btEl.innerHTML        = _renderBodyTypes(c);
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-analytics';
  _el.className = 'view view--analytics';
  _el.style.display = 'none';
  _el.innerHTML = _dashboardHtml();
  container.appendChild(_el);

  // Back button
  _el.querySelector('#an-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'analytics', to: 'fleet' });
  });

  // Manual refresh
  _el.querySelector('#an-refresh').addEventListener('click', () => {
    const btn = _el.querySelector('#an-refresh');
    btn.disabled = true; btn.textContent = 'Refreshing...';
    _update(state.slice('fleet').rows || []);
    btn.disabled = false; btn.textContent = '↺ Refresh';
  });

  // Reactive update on fleet data push
  bus.on('fleet:data', (data) => {
    _update((data && data.rows) ? data.rows : []);
  });

  // Show/hide + refresh on view change
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'analytics' ? 'flex' : 'none';
    if (to === 'analytics') {
      _update(state.slice('fleet').rows || []);
    }
  });

  // Initial render (data already in state)
  _update(state.slice('fleet').rows || []);
}
