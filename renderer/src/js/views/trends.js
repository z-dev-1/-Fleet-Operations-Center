/**
 * trends.js — Fleet Repair Intelligence: Trends dashboard (Phase 5)
 *
 * Fleet-wide DETERMINISTIC view over the 12-month ri_repair_event store. No AI,
 * no fabrication — every number comes from repair-trends:get (plain SQL counts/
 * sums). Durations/costs carry their coverage % so a total is never mistaken for
 * complete data. Excluded vendors (Velocity/Fleetnet/Goodyear) are filtered at
 * the query layer.
 *
 * Self-contained like the other routed views: creates #view-trends on the
 * views-mount and toggles display on ui:view-change. Does NOT touch the
 * Overview/analytics views.
 */

import bus from '../bus.js';
import toast from '../components/toast.js';

let _el = null;
let _loaded = false;
let _filters = {};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function _shellHtml() {
  return '' +
    '<div class="tr-head">' +
      '<div class="tr-title">\uD83D\uDCC8 Fleet Repair Trends <span class="tr-sub">(deterministic \u00b7 last 12 months \u00b7 excludes Velocity / Fleetnet / Goodyear)</span></div>' +
      '<div class="tr-head-actions"><button id="tr-refresh" class="detail-panel__btn">\u21BB Refresh</button></div>' +
    '</div>' +
    '<div class="tr-filters" id="tr-filters">' +
      _sel('tr-f-domicile', 'All Domiciles') +
      _sel('tr-f-operator', 'All Operators') +
      _sel('tr-f-vendor', 'All Vendors') +
      _sel('tr-f-make', 'All Makes') +
      _sel('tr-f-category', 'All Categories') +
      '<select id="tr-f-wotype" class="tb-select"><option value="">All Types</option><option value="PM">PM</option><option value="unplanned">Unplanned</option><option value="planned">Planned</option><option value="dealer">Dealer</option><option value="roadside">Roadside</option><option value="offsite">Offsite</option></select>' +
      '<button id="tr-clear" class="detail-panel__btn detail-panel__btn--ghost">Clear</button>' +
    '</div>' +
    '<div id="tr-body" class="tr-body"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading fleet trends\u2026</div></div>';
}

function _sel(id, placeholder) {
  return '<select id="' + id + '" class="tb-select"><option value="">' + esc(placeholder) + '</option></select>';
}

function _stat(label, val, note) {
  return '<div class="tr-stat"><div class="tr-stat-val">' + esc(String(val)) + '</div>' +
    '<div class="tr-stat-lbl">' + esc(label) + '</div>' +
    (note ? '<div class="tr-stat-note">' + esc(note) + '</div>' : '') + '</div>';
}

function _rankList(title, rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) return '<div class="tr-card"><div class="tr-card-title">' + esc(title) + '</div><div class="dp-empty">No data.</div></div>';
  var max = Math.max.apply(null, rows.map(function(r){ return r.count; })) || 1;
  var items = rows.map(function(r){
    var pct = Math.round((r.count / max) * 100);
    var dt = (opts.showDowntime && r.downtimeHours != null)
      ? '<span class="tr-rank-dt">' + r.downtimeHours + 'h' + (r.downtimeCoverage < 100 ? ' \u00b7 ' + r.downtimeCoverage + '%' : '') + '</span>'
      : '';
    return '<div class="tr-rank">' +
      '<div class="tr-rank-head"><span class="tr-rank-key">' + esc(r.key) + '</span>' +
        '<span class="tr-rank-n">' + r.count + dt + '</span></div>' +
      '<div class="tr-rank-bar"><div class="tr-rank-fill" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }).join('');
  return '<div class="tr-card"><div class="tr-card-title">' + esc(title) + '</div>' + items + '</div>';
}

function _monthlyChart(monthly) {
  if (!monthly || !monthly.length) return '';
  var max = Math.max.apply(null, monthly.map(function(m){ return m.count; })) || 1;
  var bars = monthly.map(function(m){
    var h = Math.max(2, Math.round((m.count / max) * 100));
    var label = m.month ? m.month.slice(2) : '';
    return '<div class="tr-mbar" title="' + esc(m.month) + ': ' + m.count + ' events">' +
      '<div class="tr-mbar-fill" style="height:' + h + '%"></div>' +
      '<div class="tr-mbar-lbl">' + esc(label) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="tr-card tr-card--wide"><div class="tr-card-title">Repair volume by month</div>' +
    '<div class="tr-mchart">' + bars + '</div></div>';
}

function _outcomes(outcomes) {
  if (!outcomes || !outcomes.length) return '';
  var items = outcomes.sort(function(a,b){ return b.count - a.count; }).map(function(o){
    return '<span class="dp-ri-chip">' + esc(o.key) + ' ' + o.count + '</span>';
  }).join('');
  return '<div class="tr-card tr-card--wide"><div class="tr-card-title">Outcomes / status mix <span class="dp-ri-sub-note">(evidence-based; a closed WO is not assumed resolved)</span></div>' +
    '<div class="dp-ri-chips">' + items + '</div></div>';
}

function _render(data) {
  var body = _el.querySelector('#tr-body');
  if (!body) return;
  if (!data || data.ok === false) {
    body.innerHTML = '<div class="dp-empty" style="color:var(--mut)">Trends unavailable: ' + esc((data && data.error) || 'no data') + '. Build some unit histories first (open a unit \u2192 History \u2192 Build Full History).</div>';
    return;
  }
  var t = data.totals || {};
  if (!t.events) {
    body.innerHTML = '<div class="dp-empty" style="color:var(--mut);font-style:italic">No repair events on record yet. Open a unit \u2192 History tab \u2192 <b>Build Full History</b> to populate the engine, then trends will appear here.</div>';
    return;
  }
  var stats = '<div class="tr-stats">' +
    _stat('Repair events', t.events) +
    _stat('Units', t.units) +
    _stat('Corrective', t.corrective) +
    _stat('PM', t.pm) +
    _stat('Downtime (hrs)', t.downtimeHours != null ? t.downtimeHours : 'Unknown', t.downtimeCoverage + '% coverage') +
    _stat('Est. cost', t.estimateCostTotal != null ? ('$' + t.estimateCostTotal.toLocaleString()) : 'Unknown', t.costCoverage + '% coverage') +
  '</div>';

  var grid = '<div class="tr-grid">' +
    _monthlyChart(data.monthly) +
    _outcomes(data.outcomes) +
    _rankList('Top vendors', data.byVendor, { showDowntime: true }) +
    _rankList('Top categories', data.byCategory, { showDowntime: true }) +
    _rankList('Top components', data.byComponent) +
    _rankList('By domicile', data.byDomicile) +
    _rankList('By operator', data.byOperator) +
    _rankList('By make', data.byMake) +
  '</div>';

  body.innerHTML = stats + grid;
}

function _collectFilters() {
  function v(id) { var e = _el.querySelector('#' + id); return e ? e.value : ''; }
  _filters = {
    domicile: v('tr-f-domicile'), operator: v('tr-f-operator'), vendor: v('tr-f-vendor'),
    make: v('tr-f-make'), category: v('tr-f-category'), woType: v('tr-f-wotype'),
  };
  Object.keys(_filters).forEach(function(k){ if (!_filters[k]) delete _filters[k]; });
  return _filters;
}

function _load() {
  if (!window.repairIntel || !window.repairIntel.trends) {
    _render({ ok: false, error: 'bridge unavailable' });
    return;
  }
  var body = _el.querySelector('#tr-body');
  if (body) body.innerHTML = '<div class="dp-empty" style="color:var(--mut);font-style:italic">Loading fleet trends\u2026</div>';
  window.repairIntel.trends(_collectFilters()).then(_render).catch(function(e){
    _render({ ok: false, error: (e && e.message) || 'error' });
  });
}

function _populateFilters() {
  if (!window.repairIntel || !window.repairIntel.trendFilters) return;
  window.repairIntel.trendFilters().then(function(res){
    if (!res || !res.options) return;
    var o = res.options;
    function fill(id, list) {
      var sel = _el.querySelector('#' + id);
      if (!sel || !list) return;
      var cur = sel.value;
      // keep the first (placeholder) option, append the rest
      var first = sel.querySelector('option');
      sel.innerHTML = '';
      if (first) sel.appendChild(first);
      list.forEach(function(v){ var opt = document.createElement('option'); opt.value = v; opt.textContent = v; sel.appendChild(opt); });
      sel.value = cur;
    }
    fill('tr-f-domicile', o.domiciles);
    fill('tr-f-operator', o.operators);
    fill('tr-f-vendor', o.vendors);
    fill('tr-f-make', o.makes);
    fill('tr-f-category', o.categories);
  }).catch(function(){});
}

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-trends';
  _el.className = 'view view--trends';
  _el.style.display = 'none';
  _el.innerHTML = _shellHtml();
  container.appendChild(_el);

  _el.querySelector('#tr-refresh').addEventListener('click', function(){ _populateFilters(); _load(); });
  _el.querySelector('#tr-clear').addEventListener('click', function(){
    ['tr-f-domicile','tr-f-operator','tr-f-vendor','tr-f-make','tr-f-category','tr-f-wotype'].forEach(function(id){
      var e = _el.querySelector('#' + id); if (e) e.value = '';
    });
    _load();
  });
  _el.querySelectorAll('.tr-filters select').forEach(function(sel){
    sel.addEventListener('change', _load);
  });

  // Lazy-load on first reveal so startup stays fast and empty engines are fine.
  bus.on('ui:view-change', function(ev){
    if (ev && ev.to === 'trends' && !_loaded) {
      _loaded = true;
      _populateFilters();
      _load();
    }
  });
}
