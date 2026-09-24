/**
 * fleet-overview.js — Fleet KPI overview strip (merged from the old Analytics
 * "Overview" tab into the Dashboard/fleet view).
 *
 * Owns the KPI computation + tile renderers + drill-down so both the fleet
 * view and (optionally) other views can mount the same overview without
 * duplicating logic. All stat tiles are CLICKABLE: clicking a number opens a
 * drill-down list of exactly the units behind that number, and each unit in
 * the list opens the global unit-detail panel via bus.emit('ui:unit-select').
 *
 * Data source: state.slice('fleet').rows (re-read at click time so drill-downs
 * always reflect the latest sync — rows are wholly replaced each sync).
 */

import bus   from '../bus.js';
import state from '../state.js';

// ── Helpers ────────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;

// pmB / pmX / dot values come as strings: "3 days", "overdue", "0 days", "--"
function _pmDaysNum(s) {
  if (!s || s === '--') return null;
  const lo = String(s).toLowerCase().trim();
  if (lo === 'overdue' || lo.startsWith('overdue')) return -1;
  if (lo === '0 days' || lo === '0')                return 0;
  const m = lo.match(/^(-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const SOON_DAYS = 14;

// ── Drill-down predicates ──────────────────────────────────────────────────
// A single source of truth: each drill key maps to the SAME predicate used to
// compute its tile count, so the drill-down list can never disagree with the
// number shown. Fuel keys are added dynamically (fuel:<type>) in _predicateFor.
const _BASE_PREDICATES = {
  unavail:   r => (r.lifecycleState || '').toLowerCase().includes('unavailable'),
  avail:     r => { const s = (r.lifecycleState || '').toLowerCase(); return s.includes('available') && !s.includes('un'); },
  highrisk:  r => (r.riskScore || 0) >= 75,
  medrisk:   r => { const s = r.riskScore || 0; return s >= 40 && s < 75; },
  lowrisk:   r => (r.riskScore || 0) < 40,
  'pmB-over': r => { const n = _pmDaysNum(r.pmB); return n !== null && n < 0; },
  'pmB-soon': r => { const n = _pmDaysNum(r.pmB); return n !== null && n >= 0 && n <= SOON_DAYS; },
  'pmX-over': r => { const n = _pmDaysNum(r.pmX); return n !== null && n < 0; },
  'pmX-soon': r => { const n = _pmDaysNum(r.pmX); return n !== null && n >= 0 && n <= SOON_DAYS; },
  'dot-over': r => { const n = _pmDaysNum(r.dot); return n !== null && n < 0; },
  'dot-soon': r => { const n = _pmDaysNum(r.dot); return n !== null && n >= 0 && n <= SOON_DAYS; },
};

function _predicateFor(key) {
  if (_BASE_PREDICATES[key]) return _BASE_PREDICATES[key];
  if (key && key.startsWith('op:')) {
    // op:<NAME>            -> all units for that operator
    // op:<NAME>:unavail    -> that operator's unavailable units
    // op:<NAME>:highrisk   -> that operator's high-risk (>=75) units
    // op:<NAME>:openwr     -> that operator's units with an open unplanned WR
    const rest = key.slice(3);
    const ci = rest.lastIndexOf(':');
    const sub = ci > -1 ? rest.slice(ci + 1) : '';
    const name = ci > -1 && ['unavail', 'highrisk', 'openwr'].includes(sub) ? rest.slice(0, ci) : rest;
    const isOp = r => (r.operator || 'Unknown').toUpperCase().trim() === name;
    if (sub === 'unavail')  return r => isOp(r) && _BASE_PREDICATES.unavail(r);
    if (sub === 'highrisk') return r => isOp(r) && (r.riskScore || 0) >= 75;
    if (sub === 'openwr')   return r => isOp(r) && (r.openUnplanned || 0) > 0;
    return isOp;
  }
  if (key && key.startsWith('vendor:')){ const v = key.slice(7);    return r => (r.vendor || '').trim() === v; }
  if (key && key.startsWith('fuel:'))  { const v = key.slice(5);    return r => (r.fuelType || 'Unknown').trim() === v; }
  if (key && key.startsWith('bt:'))    { const v = key.slice(3);    return r => (r.assetType || r.bodyType || 'Unknown').trim() === v; }
  if (key && key.startsWith('lc:'))    { const v = key.slice(3);    return r => (r.lifecycleState || 'Unknown').trim() === v; }
  return null;
}

const _DRILL_TITLES = {
  unavail: 'Unavailable units', avail: 'Available units',
  highrisk: 'High risk (≥75)', medrisk: 'Medium risk (40–74)', lowrisk: 'Low risk (<40)',
  'pmB-over': 'PM B — Overdue', 'pmB-soon': 'PM B — Due ≤14 days',
  'pmX-over': 'PM X — Overdue', 'pmX-soon': 'PM X — Due ≤14 days',
  'dot-over': 'DOT — Overdue', 'dot-soon': 'DOT — Due ≤14 days',
};
function _drillTitle(key) {
  if (_DRILL_TITLES[key]) return _DRILL_TITLES[key];
  if (key.startsWith('op:')) {
    const rest = key.slice(3);
    const ci = rest.lastIndexOf(':');
    const sub = ci > -1 ? rest.slice(ci + 1) : '';
    if (sub === 'unavail')  return rest.slice(0, ci) + ' — Unavailable';
    if (sub === 'highrisk') return rest.slice(0, ci) + ' — High risk (≥75)';
    if (sub === 'openwr')   return rest.slice(0, ci) + ' — Open WRs';
    return rest + ' — all units';
  }
  if (key.startsWith('vendor:')) return 'Vendor ' + key.slice(7);
  if (key.startsWith('fuel:'))   return key.slice(5) + ' units';
  if (key.startsWith('bt:'))     return key.slice(3) + ' units';
  if (key.startsWith('lc:'))     return key.slice(3) + ' units';
  return 'Units';
}

// ── Core computation ───────────────────────────────────────────────────────
function _compute(rows) {
  const total = rows.length;

  const lcMap = {};
  for (const r of rows) { const lc = (r.lifecycleState || 'Unknown').trim(); lcMap[lc] = (lcMap[lc] || 0) + 1; }
  const lcSorted = Object.entries(lcMap).sort((a, b) => b[1] - a[1]);

  const unavailCount = rows.filter(_BASE_PREDICATES.unavail).length;
  const availCount   = rows.filter(_BASE_PREDICATES.avail).length;

  const highRisk = rows.filter(_BASE_PREDICATES.highrisk).length;
  const medRisk  = rows.filter(_BASE_PREDICATES.medrisk).length;
  const lowRisk  = rows.filter(_BASE_PREDICATES.lowrisk).length;

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

  const vendMap = {};
  for (const r of rows) { const v = (r.vendor || '').trim(); if (v) vendMap[v] = (vendMap[v] || 0) + 1; }
  const vendSorted = Object.entries(vendMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Fuel-type mix (only over units that report a fuel type)
  const fuelMap = {};
  for (const r of rows) { const f = (r.fuelType || '').trim(); if (f) fuelMap[f] = (fuelMap[f] || 0) + 1; }
  const fuelSorted = Object.entries(fuelMap).sort((a, b) => b[1] - a[1]);

  let pmBOver = 0, pmBSoon = 0, pmXOver = 0, pmXSoon = 0, dotOver = 0, dotSoon = 0;
  for (const r of rows) {
    const b = _pmDaysNum(r.pmB), x = _pmDaysNum(r.pmX), d = _pmDaysNum(r.dot);
    if (b !== null) { if (b < 0) pmBOver++; else if (b <= SOON_DAYS) pmBSoon++; }
    if (x !== null) { if (x < 0) pmXOver++; else if (x <= SOON_DAYS) pmXSoon++; }
    if (d !== null) { if (d < 0) dotOver++; else if (d <= SOON_DAYS) dotSoon++; }
  }

  const btMap = {};
  for (const r of rows) { const bt = (r.assetType || r.bodyType || 'Unknown').trim(); btMap[bt] = (btMap[bt] || 0) + 1; }
  const btSorted = Object.entries(btMap).sort((a, b) => b[1] - a[1]);

  const fleetState = state.slice('fleet');
  return {
    total, unavailCount, availCount, highRisk, medRisk, lowRisk,
    lcSorted, opSorted, vendSorted, fuelSorted,
    pmBOver, pmBSoon, pmXOver, pmXSoon, dotOver, dotSoon,
    btSorted,
    syncedAt: fleetState.syncedAt, stale: fleetState.stale,
  };
}

function _bar(value, max, cls) {
  const p = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="an-bar-track"><div class="an-bar-fill an-bar-fill--${cls}" style="width:${p}%"></div></div>`;
}

// A clickable value cell. `n` is the count, `key` the drill key. Zero counts
// are shown but not clickable (nothing to drill into).
function _drill(n, key, extraCls) {
  const cls = 'fo-drill' + (extraCls ? ' ' + extraCls : '') + (n > 0 ? '' : ' fo-drill--empty');
  const attr = n > 0 ? ` data-drill="${key}" role="button" tabindex="0" title="Show units"` : '';
  return `<span class="${cls}"${attr}>${n}</span>`;
}

// A clickable TEXT cell (label is the display text, not a count). Always
// clickable — used for operator/vendor names where the row itself is the link.
function _drillText(label, key) {
  return `<span class="fo-drill fo-drill--text" data-drill="${key}" role="button" tabindex="0" title="Show units">${_safe(label)}</span>`;
}

// ── Tile renderers ─────────────────────────────────────────────────────────
function _renderSummary(c) {
  const staleHtml = c.stale ? `<div class="an-stale-banner">⚠ Data may be stale — trigger a sync for current counts</div>` : '';
  const syncedStr = c.syncedAt
    ? new Date(c.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'never';
  return `
    ${staleHtml}
    <div class="an-summary-bar">
      <div class="an-kpi an-kpi--total">
        <span class="an-kpi__val">${c.total}</span>
        <span class="an-kpi__lbl">Total units</span>
      </div>
      <div class="an-kpi an-kpi--unavail">
        <span class="an-kpi__val">${_drill(c.unavailCount, 'unavail')} <span class="an-kpi__pct">${_pct(c.unavailCount, c.total)}%</span></span>
        <span class="an-kpi__lbl">Unavailable</span>
      </div>
      <div class="an-kpi an-kpi--avail">
        <span class="an-kpi__val">${_drill(c.availCount, 'avail')} <span class="an-kpi__pct">${_pct(c.availCount, c.total)}%</span></span>
        <span class="an-kpi__lbl">Available</span>
      </div>
      <div class="an-kpi an-kpi--risk">
        <span class="an-kpi__val">${_drill(c.highRisk, 'highrisk')} <span class="an-kpi__pct">${_pct(c.highRisk, c.total)}%</span></span>
        <span class="an-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="an-kpi an-kpi--synced">
        <span class="an-kpi__val an-kpi__val--sm">${syncedStr}</span>
        <span class="an-kpi__lbl">Last synced</span>
      </div>
    </div>`;
}

function _renderRisk(c) {
  const total = c.total || 1;
  const items = [
    { label: 'HIGH ≥75',  count: c.highRisk, cls: 'risk-high', key: 'highrisk' },
    { label: 'MED 40–74', count: c.medRisk,  cls: 'risk-med',  key: 'medrisk'  },
    { label: 'LOW <40',   count: c.lowRisk,  cls: 'risk-low',  key: 'lowrisk'  },
  ];
  return `
    <div class="an-risk-wrap">
      ${items.map(item => `
        <div class="an-risk-tier">
          <div class="an-risk-tier__header">
            <span class="an-risk-badge an-risk-badge--${item.cls}">${item.label}</span>
            <span class="an-risk-tier__count">${_drill(item.count, item.key)}</span>
            <span class="an-risk-tier__pct">${_pct(item.count, total)}%</span>
          </div>
          ${_bar(item.count, total, item.cls)}
        </div>`).join('')}
    </div>`;
}

function _renderPM(c) {
  const items = [
    { label: 'PM B', overdue: c.pmBOver, soon: c.pmBSoon, ok: 'pmB-over', ks: 'pmB-soon' },
    { label: 'PM X', overdue: c.pmXOver, soon: c.pmXSoon, ok: 'pmX-over', ks: 'pmX-soon' },
    { label: 'DOT',  overdue: c.dotOver, soon: c.dotSoon, ok: 'dot-over', ks: 'dot-soon' },
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
              <span class="an-pm-val ${item.overdue > 0 ? 'an-pm-val--danger' : ''}">${_drill(item.overdue, item.ok)}</span>
            </div>
            <div class="an-pm-row an-pm-row--soon">
              <span class="an-pm-dot an-pm-dot--soon"></span>
              <span class="an-pm-lbl">Due ≤14 days</span>
              <span class="an-pm-val ${item.soon > 0 ? 'an-pm-val--warn' : ''}">${_drill(item.soon, item.ks)}</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

function _renderOperators(c) {
  if (!c.opSorted.length) return '<span class="an-empty">No data</span>';
  const headerRow = `
    <tr><th>Operator</th><th class="an-tbl--r">Total</th><th class="an-tbl--r">Unavail</th>
    <th class="an-tbl--r">Unavail %</th><th class="an-tbl--r">High risk</th><th class="an-tbl--r">Open WRs</th></tr>`;
  const dataRows = c.opSorted.map(([op, d]) => `
    <tr>
      <td class="an-op-name">${_drillText(op, 'op:' + op)}</td>
      <td class="an-tbl--r">${_drill(d.total, 'op:' + op)}</td>
      <td class="an-tbl--r ${d.unavail > 0 ? 'an-cell--warn' : ''}">${_drill(d.unavail, 'op:' + op + ':unavail')}</td>
      <td class="an-tbl--r">${_pct(d.unavail, d.total)}%</td>
      <td class="an-tbl--r ${d.highRisk > 0 ? 'an-cell--danger' : ''}">${_drill(d.highRisk, 'op:' + op + ':highrisk')}</td>
      <td class="an-tbl--r ${d.openWR > 0 ? 'an-cell--accent' : ''}">${_drill(d.openWR, 'op:' + op + ':openwr')}</td>
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
      <span class="an-vend-count">${_drill(count, 'vendor:' + vendor)}</span>
    </div>`).join('');
  return `<div class="an-vend-chart">${rows}</div>`;
}

function _renderFuel(c) {
  if (!c.fuelSorted.length) return '<span class="an-empty">No fuel-type data</span>';
  const maxCount = c.fuelSorted[0][1];
  const rows = c.fuelSorted.map(([fuel, count]) => `
    <div class="an-bt-row">
      <span class="an-bt-label" title="${_safe(fuel)}">${_safe(fuel)}</span>
      <div class="an-bt-bar-wrap">${_bar(count, maxCount, 'bodytype')}</div>
      <span class="an-bt-count">${_drill(count, 'fuel:' + fuel)}</span>
      <span class="an-bt-pct">${_pct(count, c.total)}%</span>
    </div>`).join('');
  return `<div class="an-bt-chart">${rows}</div>`;
}

function _renderBodyTypes(c) {
  if (!c.btSorted.length) return '<span class="an-empty">No data</span>';
  const maxCount = c.btSorted[0][1];
  const rows = c.btSorted.map(([bt, count]) => `
    <div class="an-bt-row">
      <span class="an-bt-label" title="${_safe(bt)}">${_safe(bt)}</span>
      <div class="an-bt-bar-wrap">${_bar(count, maxCount, 'bodytype')}</div>
      <span class="an-bt-count">${_drill(count, 'bt:' + bt)}</span>
      <span class="an-bt-pct">${_pct(count, c.total)}%</span>
    </div>`).join('');
  return `<div class="an-bt-chart">${rows}</div>`;
}

// ── Drill-down modal ───────────────────────────────────────────────────────
function _openDrill(key) {
  const rows = (state.slice('fleet').rows || []);
  const pred = _predicateFor(key);
  if (!pred) return;
  const matches = rows.filter(pred);
  const title = _drillTitle(key);

  const existing = document.getElementById('fo-drill-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'fo-drill-modal';
  modal.className = 'fo-drill-modal';

  const list = matches.length
    ? matches.map(u => {
        const sub = [u.operator, u.domicileSite, u.vendor].filter(Boolean).join(' · ');
        const st  = (u.lifecycleState || '').toLowerCase().includes('unavail') ? 'down' : 'ok';
        return `<div class="fo-drill-item" data-unit="${_safe(u.equipmentId)}">
          <span class="fo-drill-item__dot fo-drill-item__dot--${st}"></span>
          <span class="fo-drill-item__id">${_safe(u.equipmentId)}</span>
          <span class="fo-drill-item__sub">${_safe(sub)}</span>
          ${u.riskScore ? `<span class="fo-drill-item__risk">${parseInt(u.riskScore, 10)}</span>` : ''}
        </div>`;
      }).join('')
    : '<div class="fo-drill-empty">No units.</div>';

  modal.innerHTML = `
    <div class="fo-drill-backdrop" id="fo-drill-backdrop"></div>
    <div class="fo-drill-panel">
      <div class="fo-drill-head">
        <span class="fo-drill-title">${_safe(title)} <span class="fo-drill-count">${matches.length}</span></span>
        <button class="fo-drill-close" id="fo-drill-close">✕</button>
      </div>
      <div class="fo-drill-list">${list}</div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#fo-drill-close').addEventListener('click', close);
  modal.querySelector('#fo-drill-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  modal.querySelector('.fo-drill-list').addEventListener('click', (e) => {
    const item = e.target.closest('.fo-drill-item');
    if (!item) return;
    const uid = item.dataset.unit;
    const row = (state.slice('fleet').rows || []).find(r => r.equipmentId === uid);
    if (row) { bus.emit('ui:unit-select', { unit: row }); close(); }
  });
}

// ── Public: mount(container) ───────────────────────────────────────────────
// Injects the collapsible overview strip as the FIRST child of `container`
// (so it sits above the fleet table) and wires re-render + drill-down. Safe to
// call once at init; it self-updates on state:fleet.
export function mount(container) {
  if (!container || document.getElementById('fleet-overview')) return;

  const collapsed = localStorage.getItem('fleet_overview_collapsed') === '1';

  const wrap = document.createElement('div');
  wrap.id = 'fleet-overview';
  // Hidden by default — the strip belongs to the "Dashboard" tab. The plain
  // "Fleet" tab shows just the table. Both tabs render view-fleet, so we
  // toggle this strip on the ui:view-change `tab` key rather than the view.
  wrap.className = 'fleet-overview fleet-overview--hidden' + (collapsed ? ' fleet-overview--collapsed' : '');
  wrap.innerHTML = `
    <div class="fo-header" id="fo-header">
      <span class="fo-caret">▾</span>
      <span class="fo-title">Fleet Overview</span>
      <span class="fo-hint">click any number to see the units</span>
    </div>
    <div class="fo-body" id="fo-body">
      <div id="fo-summary"></div>
      <div class="an-grid-2">
        <div class="an-card"><div class="an-card__title">Risk Distribution</div><div id="fo-risk"></div></div>
        <div class="an-card"><div class="an-card__title">PM Due Dates</div><div class="an-card__hint">pmB / pmX / DOT</div><div id="fo-pm"></div></div>
      </div>
      <div class="an-grid-2">
        <div class="an-card"><div class="an-card__title">By Fuel Type</div><div id="fo-fuel"></div></div>
        <div class="an-card"><div class="an-card__title">Asset Type Mix</div><div id="fo-bt"></div></div>
      </div>
      <div class="an-card"><div class="an-card__title">By Operator</div><div id="fo-operators"></div></div>
      <div class="an-card"><div class="an-card__title">Top Vendors</div><div id="fo-vendors"></div></div>
    </div>`;
  container.insertBefore(wrap, container.firstChild);

  // Collapse toggle (persisted)
  wrap.querySelector('#fo-header').addEventListener('click', () => {
    const isCollapsed = wrap.classList.toggle('fleet-overview--collapsed');
    localStorage.setItem('fleet_overview_collapsed', isCollapsed ? '1' : '0');
  });

  // Delegated drill-down: any element carrying data-drill opens the modal.
  wrap.addEventListener('click', (e) => {
    const t = e.target.closest('[data-drill]');
    if (!t) return;
    e.stopPropagation();
    _openDrill(t.dataset.drill);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-drill]');
    if (!t) return;
    e.preventDefault();
    _openDrill(t.dataset.drill);
  });

  const render = () => {
    const c = _compute(state.slice('fleet').rows || []);
    const set = (id, html) => { const el = wrap.querySelector(id); if (el) el.innerHTML = html; };
    set('#fo-summary',   _renderSummary(c));
    set('#fo-risk',      _renderRisk(c));
    set('#fo-pm',        _renderPM(c));
    set('#fo-fuel',      _renderFuel(c));
    set('#fo-bt',        _renderBodyTypes(c));
    set('#fo-operators', _renderOperators(c));
    set('#fo-vendors',   _renderVendors(c));
  };

  bus.on('state:fleet', render);
  render();

  // Show the overview strip only on the Dashboard tab; hide it on the plain
  // Fleet tab (both render view-fleet). Default: hidden until Dashboard opens.
  // When shown, put the fleet view into "dashboard-mode" so the whole view
  // scrolls as one page (overview + table) instead of the table having its own
  // inner scroll — that's what let the overview cards get clipped / cramped.
  const fleetViewEl = container; // mount() was called with the #view-fleet element
  bus.on('ui:view-change', ({ to, tab }) => {
    if (to !== 'fleet') return; // leaving the fleet view entirely
    const showOverview = tab === 'dashboard';
    wrap.classList.toggle('fleet-overview--hidden', !showOverview);
    if (fleetViewEl && fleetViewEl.classList) {
      fleetViewEl.classList.toggle('dashboard-mode', showOverview);
    }
  });
}

export default { mount };
