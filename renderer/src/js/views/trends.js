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
    '<div id="tr-body" class="tr-body"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading fleet trends\u2026</div></div>' +
    '<div id="tr-drill" class="tr-drill" style="display:none"></div>';
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
  var dim = opts.dimension || '';
  var items = rows.map(function(r){
    var pct = Math.round((r.count / max) * 100);
    var dt = (opts.showDowntime && r.downtimeHours != null)
      ? '<span class="tr-rank-dt">' + r.downtimeHours + 'h' + (r.downtimeCoverage < 100 ? ' \u00b7 ' + r.downtimeCoverage + '%' : '') + '</span>'
      : '';
    // Clickable when a dimension is given — drills into the units behind it.
    var clickable = dim ? ' tr-rank--click" data-dim="' + esc(dim) + '" data-val="' + esc(r.key) + '"' : '"';
    return '<div class="tr-rank' + clickable + ' title="' + (dim ? 'Click to see the units that trended for this' : '') + '">' +
      '<div class="tr-rank-head"><span class="tr-rank-key">' + esc(r.key) + (dim ? ' \u2197' : '') + '</span>' +
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

function _backorderCard(bo) {
  if (!bo || !bo.events) {
    return '<div class="tr-card tr-card--wide"><div class="tr-card-title">\uD83D\uDCE6 Parts / back-order</div>' +
      '<div class="dp-empty" style="color:var(--mut)">No parts-delay / back-order signals in this window.</div></div>';
  }
  function miniRank(title, rows) {
    if (!rows || !rows.length) return '';
    var max = Math.max.apply(null, rows.map(function(r){ return r.count; })) || 1;
    var items = rows.slice(0, 8).map(function(r){
      var pct = Math.round((r.count / max) * 100);
      return '<div class="tr-rank"><div class="tr-rank-head"><span class="tr-rank-key">' + esc(r.key) + '</span>' +
        '<span class="tr-rank-n">' + r.count + '</span></div>' +
        '<div class="tr-rank-bar"><div class="tr-rank-fill tr-rank-fill--bo" style="width:' + pct + '%"></div></div></div>';
    }).join('');
    return '<div class="tr-bo-col"><div class="tr-bo-subtitle">' + esc(title) + '</div>' + items + '</div>';
  }
  return '<div class="tr-card tr-card--wide"><div class="tr-card-title">\uD83D\uDCE6 Parts / back-order ' +
    '<span class="dp-ri-sub-note">(' + bo.events + ' events \u00b7 ' + bo.units + ' units \u00b7 ' + bo.pctOfEvents + '% of events \u00b7 from delay-reason/lifecycle signals only)</span></div>' +
    '<div class="tr-bo-cols">' + miniRank('By component', bo.byComponent) + miniRank('By vendor', bo.byVendor) + '</div></div>';
}

function fmtDate(ms) {
  if (!ms) return 'Unknown';
  try { var d = new Date(ms); return (d.getMonth()+1)+'/'+d.getDate()+'/'+String(d.getFullYear()).slice(2); }
  catch (_) { return 'Unknown'; }
}

// Render the drill-down: units that trended for the clicked thing, each with its
// events' failure complaint + the "why" (delay/cancel/scope/root cause), and a
// clickable work-order link.
function _renderDrill(res, dim, val) {
  var host = _el.querySelector('#tr-drill');
  if (!host) return;
  host.style.display = 'block';
  if (!res || res.ok === false) {
    host.innerHTML = '<div class="tr-drill-head"><span>' + esc(dim) + ': ' + esc(val) + '</span><button class="tr-drill-close">\u2715</button></div>' +
      '<div class="dp-empty" style="color:var(--mut)">Could not load: ' + esc((res && res.error) || 'error') + '</div>';
    _wireDrillClose(host);
    return;
  }
  var unitsHtml = (res.units || []).map(function(u){
    var evs = u.events.map(function(e){
      var why = [];
      if (e.cancellationReason) why.push('<span class="tr-why tr-why--cancel">Cancelled: ' + esc(e.cancellationReason) + '</span>');
      if (e.delayReason) why.push('<span class="tr-why tr-why--delay">Delay: ' + esc(e.delayReason) + '</span>');
      if (e.outOfScopeReason) why.push('<span class="tr-why tr-why--scope">Out of scope: ' + esc(e.outOfScopeReason) + '</span>');
      if (e.rootCause) why.push('<span class="tr-why tr-why--root">Root cause: ' + esc(e.rootCause) + '</span>');
      if (e.outcome) why.push('<span class="tr-why">Outcome: ' + esc(e.outcome) + '</span>');
      var open = e.url
        ? '<button class="tr-ev-open" data-url="' + esc(e.url) + '" title="Open work order in AAP">open WO \u2197</button>'
        : '';
      return '<div class="tr-ev">' +
        '<div class="tr-ev-head"><span class="tr-ev-date">' + esc(fmtDate(e.reportedAt)) + '</span>' +
          '<span class="tr-ev-status tr-ev-status--' + esc(e.status||'') + '">' + esc(e.status||'') + '</span>' +
          '<span class="tr-ev-vend">' + esc(e.vendor || 'vendor n/a') + '</span>' +
          (e.partsOnOrder ? '<span class="tr-ev-parts">\uD83D\uDCE6 parts</span>' : '') + open + '</div>' +
        (e.complaint ? '<div class="tr-ev-complaint">' + esc(String(e.complaint).slice(0, 400)) + '</div>' : '<div class="tr-ev-complaint tr-ev-none">No complaint text recorded.</div>') +
        (why.length ? '<div class="tr-ev-why">' + why.join('') + '</div>' : '') +
      '</div>';
    }).join('');
    return '<div class="tr-unit">' +
      '<div class="tr-unit-head"><button class="tr-unit-open" data-unit="' + esc(u.equipmentId) + '">' + esc(u.equipmentId) + '</button>' +
        '<span class="tr-unit-count">' + u.count + ' event' + (u.count === 1 ? '' : 's') + '</span></div>' +
      evs +
    '</div>';
  }).join('');
  host.innerHTML =
    '<div class="tr-drill-head"><span><b>' + esc(val) + '</b> \u2014 ' + res.unitCount + ' unit' + (res.unitCount === 1 ? '' : 's') + ', ' + res.totalEvents + ' event' + (res.totalEvents === 1 ? '' : 's') +
      ' <span class="dp-ri-sub-note">(' + esc(dim) + ' trend \u00b7 click a unit to open it, or open its work order)</span></span>' +
      '<button class="tr-drill-close">\u2715</button></div>' +
    (unitsHtml || '<div class="dp-empty">No events.</div>');
  _wireDrillClose(host);
  // unit -> open the unit detail panel (same bus event the fleet table uses)
  host.querySelectorAll('.tr-unit-open').forEach(function(btn){
    btn.addEventListener('click', function(){ _openUnit(btn.dataset.unit); });
  });
  // work order -> open in AAP
  host.querySelectorAll('.tr-ev-open').forEach(function(btn){
    btn.addEventListener('click', function(){
      var url = btn.dataset.url;
      if (url && window.aap && window.aap.openUrl) window.aap.openUrl(url);
      else if (url && window.open) window.open(url, '_blank');
    });
  });
}

function _wireDrillClose(host) {
  var c = host.querySelector('.tr-drill-close');
  if (c) c.addEventListener('click', function(){ host.style.display = 'none'; host.innerHTML = ''; });
}

function _openUnit(unitId) {
  if (!unitId) return;
  // Reuse the fleet row if we have it so the detail panel opens fully populated.
  var row = null;
  try {
    var rows = (window.__fleetRows || (window.fleet && window.fleet._rows)) || [];
    row = rows.find && rows.find(function(r){ return String(r.equipmentId || r.id) === String(unitId); });
  } catch (_) {}
  bus.emit('ui:unit-select', { unit: row || { equipmentId: unitId, id: unitId } });
}

function _openDrill(dim, val) {
  var host = _el.querySelector('#tr-drill');
  if (host) { host.style.display = 'block'; host.innerHTML = '<div class="tr-drill-head"><span>Loading ' + esc(val) + '\u2026</span></div>'; }
  if (!window.repairIntel || !window.repairIntel.drill) { _renderDrill({ ok: false, error: 'bridge unavailable' }, dim, val); return; }
  window.repairIntel.drill(dim, val, _collectFilters()).then(function(res){ _renderDrill(res, dim, val); })
    .catch(function(e){ _renderDrill({ ok: false, error: (e && e.message) || 'error' }, dim, val); });
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
    (data.backorder ? _stat('Parts / back-order', data.backorder.events, data.backorder.pctOfEvents + '% of events') : '') +
  '</div>';

  var grid = '<div class="tr-grid">' +
    _monthlyChart(data.monthly) +
    _outcomes(data.outcomes) +
    _rankList('Top vendors', data.byVendor, { showDowntime: true, dimension: 'vendor' }) +
    _rankList('Top categories', data.byCategory, { showDowntime: true, dimension: 'category' }) +
    _rankList('Top components', data.byComponent, { dimension: 'component' }) +
    _rankList('By domicile', data.byDomicile, { dimension: 'domicile' }) +
    _rankList('By operator', data.byOperator, { dimension: 'operator' }) +
    _rankList('By make', data.byMake, { dimension: 'make' }) +
    _backorderCard(data.backorder) +
  '</div>';

  body.innerHTML = stats + grid +
    '<div class="tr-section-title">\uD83D\uDD17 Vendor Network Intelligence <span class="dp-ri-sub-note">(deterministic \u00b7 patterns to review, not proof of fault \u00b7 advisory only)</span></div>' +
    '<div id="tr-network"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading vendor network\u2026</div></div>';
}

function _renderNetwork(data) {
  var host = _el.querySelector('#tr-network');
  if (!host) return;
  if (!data || data.ok === false) {
    host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">Vendor network unavailable: ' + esc((data && data.error) || 'no data') + '.</div>';
    return;
  }
  var cards = data.scorecards || [];
  if (!cards.length) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">No vendor data yet.</div>'; return; }

  // repeat-rate lookup
  var rrMap = {};
  (data.repeatRates || []).forEach(function(r){ rrMap[r.vendor] = r; });

  var scHtml = cards.slice(0, 20).map(function(v){
    var rr = rrMap[v.vendor];
    var rrCls = rr && rr.repeatRatePct >= 30 ? 'tr-vn-rr--bad' : (rr && rr.repeatRatePct >= 15 ? 'tr-vn-rr--warn' : '');
    var out = (v.outcomes || []).slice(0, 4).map(function(o){ return '<span class="dp-ri-chip">' + esc(o.key) + ' ' + o.count + '</span>'; }).join('');
    return '<div class="tr-vn-card">' +
      '<div class="tr-vn-head"><span class="tr-vn-name">' + esc(v.vendor) + '</span>' +
        '<span class="tr-vn-events">' + v.events + ' events \u00b7 ' + v.units + ' units</span></div>' +
      '<div class="tr-vn-metrics">' +
        '<span>Downtime: ' + (v.downtimeHours != null ? v.downtimeHours + 'h' : 'Unknown') + (v.downtimeCoverage < 100 ? ' (' + v.downtimeCoverage + '%)' : '') + '</span>' +
        (v.avgDowntimeHours != null ? '<span>Avg: ' + v.avgDowntimeHours + 'h</span>' : '') +
        (v.estimateCostTotal != null ? '<span>Est $' + v.estimateCostTotal.toLocaleString() + (v.costCoverage < 100 ? ' (' + v.costCoverage + '%)' : '') + '</span>' : '') +
        (rr ? '<span class="tr-vn-rr ' + rrCls + '">Repeat: ' + rr.repeatRatePct + '% (' + rr.repeats + '/' + rr.basis + ')</span>' : '') +
      '</div>' +
      (out ? '<div class="dp-ri-chips">' + out + '</div>' : '') +
    '</div>';
  }).join('');

  var mv = (data.multiVendor || []).slice(0, 12).map(function(c){
    var vs = c.vendors.slice(0, 5).map(function(x){ return esc(x.vendor) + ' (' + x.count + ')'; }).join(', ');
    return '<div class="tr-mv-row"><span class="tr-mv-comp">' + esc(c.component) + '</span>' +
      '<span class="tr-mv-count">' + c.vendorCount + ' vendors</span>' +
      '<span class="tr-mv-list">' + vs + '</span></div>';
  }).join('');
  var mvBlock = mv
    ? '<div class="tr-card tr-card--wide"><div class="tr-card-title">Components spread across multiple vendors <span class="dp-ri-sub-note">(scope / referral churn signal)</span></div>' + mv + '</div>'
    : '';

  host.innerHTML = '<div class="tr-vn-grid">' + scHtml + '</div>' + mvBlock;
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
  var f = _collectFilters();
  window.repairIntel.trends(f).then(function(data){
    _render(data);
    // Network block only renders when the body produced one (i.e. there is data).
    if (data && data.ok !== false && data.totals && data.totals.events && window.repairIntel.network) {
      window.repairIntel.network(f).then(_renderNetwork).catch(function(e){
        _renderNetwork({ ok: false, error: (e && e.message) || 'error' });
      });
    }
  }).catch(function(e){
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
  // Delegated click: any clickable ranked row drills into the units behind it.
  _el.addEventListener('click', function(ev){
    var row = ev.target.closest && ev.target.closest('.tr-rank--click');
    if (row && row.dataset.dim) { _openDrill(row.dataset.dim, row.dataset.val); }
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
