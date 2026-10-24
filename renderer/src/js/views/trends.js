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
import state from '../state.js';

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
      _sel('tr-f-unit', 'All Units') +
      _sel('tr-f-domicile', 'All Domiciles') +
      _sel('tr-f-operator', 'All Operators') +
      _sel('tr-f-vendor', 'All Vendors') +
      _sel('tr-f-make', 'All Makes') +
      _sel('tr-f-category', 'All Categories') +
      _sel('tr-f-component', 'All Components') +
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
    var h = Math.max(6, Math.round((m.count / max) * 100));
    var label = m.month ? m.month.slice(2) : '';
    // stacked segments: completed / in-progress / cancelled / other, sized by share
    function seg(n, cls) { return n ? '<div class="tr-mseg ' + cls + '" style="flex:' + n + '"></div>' : ''; }
    var other = Math.max(0, m.count - (m.completed||0) - (m.inProgress||0) - (m.cancelled||0) - (m.transferred||0));
    var stack = '<div class="tr-mstack" style="height:' + h + '%">' +
      seg(m.completed, 'tr-mseg--done') +
      seg(m.inProgress, 'tr-mseg--prog') +
      seg(m.cancelled, 'tr-mseg--cancel') +
      seg(m.transferred, 'tr-mseg--xfer') +
      seg(other, 'tr-mseg--other') +
    '</div>';
    var tip = m.month + '\n' + m.count + ' repairs \u00b7 ' + (m.unitsAffected||0) + ' units\n' +
      (m.completed||0) + ' completed, ' + (m.inProgress||0) + ' in progress, ' + (m.cancelled||0) + ' cancelled' +
      (m.transferred ? ', ' + m.transferred + ' transferred' : '') + '\n' +
      (m.pm||0) + ' PM \u00b7 ' + (m.partsHold||0) + ' parts-hold' +
      (m.avgDowntimeHours != null ? '\navg downtime ' + m.avgDowntimeHours + 'h (' + m.downtimeCoverage + '% coverage)' : '');
    return '<div class="tr-mbar tr-mbar--click" data-month="' + esc(m.month) + '" title="' + esc(tip) + '">' +
      '<div class="tr-mbar-n">' + m.count + '</div>' +
      stack +
      '<div class="tr-mbar-lbl">' + esc(label) + '</div>' +
    '</div>';
  }).join('');
  var legend = '<div class="tr-mlegend">' +
    '<span class="tr-mlg tr-mlg--done">completed</span>' +
    '<span class="tr-mlg tr-mlg--prog">in progress</span>' +
    '<span class="tr-mlg tr-mlg--cancel">cancelled</span>' +
    '<span class="tr-mlg tr-mlg--xfer">transferred</span>' +
    '<span class="dp-ri-sub-note">click a month for its events</span>' +
  '</div>';
  // Compact per-month numbers table under the chart (the "data right inside").
  var tbl = '<div class="tr-mtable"><div class="tr-mtr tr-mtr--head">' +
    '<span>Month</span><span>Repairs</span><span>Units</span><span>Done</span><span>In prog</span><span>Cancel</span><span>PM</span><span>Parts</span><span>Avg dt</span></div>' +
    monthly.slice().reverse().map(function(m){
      return '<div class="tr-mtr tr-mtr--click" data-month="' + esc(m.month) + '">' +
        '<span>' + esc(m.month) + '</span><span>' + m.count + '</span><span>' + (m.unitsAffected||0) + '</span>' +
        '<span>' + (m.completed||0) + '</span><span>' + (m.inProgress||0) + '</span><span>' + (m.cancelled||0) + '</span>' +
        '<span>' + (m.pm||0) + '</span><span>' + (m.partsHold||0) + '</span>' +
        '<span>' + (m.avgDowntimeHours != null ? m.avgDowntimeHours + 'h' : '\u2014') + '</span></div>';
    }).join('') + '</div>';
  return '<div class="tr-card tr-card--wide"><div class="tr-card-title">Repair volume by month <span class="dp-ri-sub-note">(status breakdown \u00b7 click any month or row)</span></div>' +
    '<div class="tr-mchart">' + bars + '</div>' + legend + tbl + '</div>';
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
    '<span class="dp-ri-sub-note">(' + bo.events + ' events \u00b7 ' + bo.units + ' units \u00b7 ' + bo.pctOfEvents + '% of events)</span>' +
    ' <button class="tr-bo-drill" data-dim="partsOnOrder" title="See every back-ordered event, its component + complaint">view all \u2197</button></div>' +
    '<div class="tr-bo-note">The exact part number is not a structured API field \u2014 these show WHICH system is on hold + the delay reason; each event\u2019s complaint (on drill) names the part when documented.</div>' +
    ((bo.byPart && bo.byPart.length)
      ? '<div class="tr-bo-parts"><span class="tr-slice-sub">Parts named in comments (suspected):</span> ' +
          bo.byPart.map(function(p){ return '<span class="tr-why tr-why--parts">' + esc(p.key) + ' \u00d7' + p.count + '</span>'; }).join(' ') + '</div>'
      : '') +
    '<div class="tr-bo-cols">' +
      miniRank('Delay reason', bo.byReason) +
      miniRank('Component on hold (L1)', bo.byComponent) +
      miniRank('Sub-component on hold (L2)', bo.bySubcomponent) +
      miniRank('By vendor', bo.byVendor) +
    '</div></div>';
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
  // ── cross-unit rollups (the "everything at a glance" for this trend) ──────
  function chips(title, rows, cls) {
    if (!rows || !rows.length) return '';
    var items = rows.slice(0, 10).map(function(r){
      return '<span class="tr-why ' + (cls||'') + '">' + esc(r.key) + ' \u00d7' + r.count + '</span>';
    }).join('');
    return '<div class="tr-roll"><span class="tr-roll-t">' + esc(title) + '</span>' + items + '</div>';
  }
  var rc = res.rootCauseRollup || [];
  var rollups = '<div class="tr-rollups">' +
    (rc.length
      ? chips('Root causes', rc, 'tr-why--root')
      : '<div class="tr-roll"><span class="tr-roll-t">Root causes</span><span class="dp-ri-sub-note">not documented yet for ' + (100 - (res.rootCauseCoverage||0)) + '% of events \u2014 run AI analysis on these units to populate</span></div>') +
    chips('Why (delay / cancel / scope)', res.whyRollup, 'tr-why--delay') +
    chips('Status', res.statusRollup) +
  '</div>';

  var unitsHtml = (res.units || []).map(function(u){
    var evs = u.events.map(function(e){
      var why = [];
      if (e.cancellationReason) why.push('<span class="tr-why tr-why--cancel">Cancelled: ' + esc(e.cancellationReason) + '</span>');
      if (e.delayReason) why.push('<span class="tr-why tr-why--delay">Delay: ' + esc(e.delayReason) + '</span>');
      if (e.backorderedParts && e.backorderedParts.length) {
        why.push('<span class="tr-why tr-why--parts" title="suspected part(s) from the comment thread">\uD83D\uDCE6 Back-ordered: ' + esc(e.backorderedParts.map(function(p){ return p.part; }).join(', ')) + '</span>');
      }
      if (e.outOfScopeReason) why.push('<span class="tr-why tr-why--scope">Out of scope: ' + esc(e.outOfScopeReason) + '</span>');
      if (e.rootCause) why.push('<span class="tr-why tr-why--root">Root cause: ' + esc(e.rootCause) + '</span>');
      if (e.correctiveActions) why.push('<span class="tr-why">Action: ' + esc(e.correctiveActions) + '</span>');
      if (e.outcome) why.push('<span class="tr-why">Outcome: ' + esc(e.outcome) + '</span>');
      if (e.estimateCost != null) why.push('<span class="tr-why">Est $' + e.estimateCost + '</span>');
      var open = e.url
        ? '<button class="tr-ev-open" data-url="' + esc(e.url) + '" title="Open work order in AAP">open WO \u2197</button>'
        : '';
      var offsite = e.offsiteUrl
        ? '<button class="tr-ev-open tr-ev-offsite" data-url="' + esc(e.offsiteUrl) + '" title="Open offsite / dealer event in AAP">offsite \u2197</button>'
        : '';
      return '<div class="tr-ev">' +
        '<div class="tr-ev-head"><span class="tr-ev-date">' + esc(fmtDate(e.reportedAt)) + '</span>' +
          '<span class="tr-ev-status tr-ev-status--' + esc(e.status||'') + '">' + esc(e.status||'') + '</span>' +
          '<span class="tr-ev-cat">' + esc(e.category || '') + (e.component ? ' / ' + esc(e.component) : '') + '</span>' +
          '<span class="tr-ev-vend">' + esc(e.vendor || 'vendor n/a') + '</span>' +
          (e.partsOnOrder ? '<span class="tr-ev-parts">\uD83D\uDCE6 parts</span>' : '') + open + offsite + '</div>' +
        (e.complaint ? '<div class="tr-ev-complaint">' + esc(String(e.complaint).slice(0, 600)) + '</div>' : '<div class="tr-ev-complaint tr-ev-none">No complaint text recorded.</div>') +
        (why.length ? '<div class="tr-ev-why">' + why.join('') + '</div>' : '') +
      '</div>';
    }).join('');
    // per-unit root-cause glance (distinct) + a "scope whole view to this unit"
    var rcChips = (u.rootCauses || []).slice(0, 4).map(function(c){ return '<span class="tr-why tr-why--root">' + esc(c) + '</span>'; }).join('');
    return '<div class="tr-unit">' +
      '<div class="tr-unit-head">' +
        '<button class="tr-unit-open" data-unit="' + esc(u.equipmentId) + '" title="Open this unit\u2019s detail panel">' + esc(u.equipmentId) + '</button>' +
        '<span class="tr-unit-count">' + u.count + ' event' + (u.count === 1 ? '' : 's') + '</span>' +
        '<button class="tr-unit-filter" data-unit="' + esc(u.equipmentId) + '" title="Filter the whole Trends view to this unit">filter view \u2192</button>' +
        (rcChips ? '<span class="tr-unit-rc">' + rcChips + '</span>' : '') +
      '</div>' +
      evs +
    '</div>';
  }).join('');

  host.innerHTML =
    '<div class="tr-drill-head"><span><b>' + esc(val) + '</b> \u2014 ' + res.unitCount + ' unit' + (res.unitCount === 1 ? '' : 's') + ', ' + res.totalEvents + ' event' + (res.totalEvents === 1 ? '' : 's') +
      ' <span class="dp-ri-sub-note">(' + esc(dim) + ' trend \u00b7 click a unit to open it, "filter view" to scope everything to it, or open its work order)</span></span>' +
      '<button class="tr-drill-close">\u2715</button></div>' +
    rollups +
    (unitsHtml || '<div class="dp-empty">No events.</div>');
  _wireDrillClose(host);
  // unit -> open the unit detail panel (same bus event the fleet table uses)
  host.querySelectorAll('.tr-unit-open').forEach(function(btn){
    btn.addEventListener('click', function(){ _openUnit(btn.dataset.unit); });
  });
  // "filter view" -> set the unit filter dropdown and reload the whole view
  host.querySelectorAll('.tr-unit-filter').forEach(function(btn){
    btn.addEventListener('click', function(){
      var sel = _el.querySelector('#tr-f-unit');
      if (sel) { sel.value = btn.dataset.unit; }
      host.style.display = 'none'; host.innerHTML = '';
      _load();
    });
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
  // Reuse the FULL fleet row from renderer state so the detail panel opens
  // populated (same source fleet.js uses). Fall back to a minimal object +
  // a toast so the click is never a silent no-op.
  var row = null;
  try {
    var rows = (state.slice('fleet') && state.slice('fleet').rows) || [];
    row = rows.find(function(r){ return String(r.equipmentId || r.id) === String(unitId); });
  } catch (_) {}
  if (row) {
    bus.emit('ui:unit-select', { unit: row });
  } else {
    // Unit not in the current fleet view (e.g. filtered out / different domicile).
    // Open with what we have and let the detail panel's API refresh hydrate it.
    bus.emit('ui:unit-select', { unit: { equipmentId: unitId, id: unitId, _apiSourced: true } });
    toast.show('info', 'Opening ' + unitId + ' \u2014 loading its live detail\u2026', 2500);
  }
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

  body.innerHTML = stats +
    '<div class="tr-section-title">\uD83C\uDFE5 Unit Health Scoreboard <span class="dp-ri-sub-note">(worst \u2192 best \u00b7 composite maintenance score from real repair signals \u00b7 click a unit)</span>' +
      '<span class="tr-health-toggle" id="tr-health-toggle" title="Show best-health units too">show all</span></div>' +
    '<div id="tr-health"><div class="dp-empty" style="color:var(--mut);font-style:italic">Scoring units\u2026</div></div>' +
    grid +
    '<div class="tr-section-title">\uD83D\uDD0E Repetitive Fault Analysis <span class="dp-ri-sub-note">(same component coming back \u00b7 is it many units once, or one unit many times?)</span></div>' +
    '<div class="tr-slice-controls">' +
      '<label class="tr-slice-lbl">Break down by</label>' +
      '<select id="tr-slice-by" class="tb-select">' +
        '<option value="subcomponent">Sub-component (L2: windshield, air brake assembly\u2026)</option>' +
        '<option value="component">Component (L1: Engine, Brakes\u2026)</option>' +
        '<option value="vendor">Vendor</option>' +
        '<option value="make">Make</option>' +
        '<option value="model">Model</option>' +
      '</select>' +
    '</div>' +
    '<div id="tr-slice"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading deep slice\u2026</div></div>' +
    '<div class="tr-section-title">\u267B\uFE0F Repeat Offenders <span class="dp-ri-sub-note">(units with the same component 2+ times)</span></div>' +
    '<div id="tr-offenders"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading repeat offenders\u2026</div></div>' +
    '<div class="tr-section-title">\uD83D\uDD17 Vendor Network Intelligence <span class="dp-ri-sub-note">(deterministic \u00b7 patterns to review, not proof of fault \u00b7 advisory only)</span></div>' +
    '<div id="tr-network"><div class="dp-empty" style="color:var(--mut);font-style:italic">Loading vendor network\u2026</div></div>';
}

var _healthShowAll = false;
function _renderHealth(res) {
  var host = _el.querySelector('#tr-health');
  if (!host) return;
  if (!res || res.ok === false) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">' + esc((res && res.error) || 'no data') + '</div>'; return; }
  var units = res.units || [];
  if (!units.length) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">No units scored yet.</div>'; return; }

  // Worst-first. By default show the ones that need attention (score>=15),
  // capped at 15 rows; "show all" reveals the healthy tail too.
  var shown = _healthShowAll ? units : units.filter(function(u){ return u.score >= 15; }).slice(0, 15);
  if (!shown.length) shown = units.slice(0, 10); // everything is healthy — show top 10 anyway

  var gradeLabel = { critical: 'CRITICAL', watch: 'WATCH', fair: 'FAIR', good: 'GOOD' };
  var rows = shown.map(function(u, i){
    var meta = [u.make, u.model, u.domicile].filter(Boolean).join(' \u00b7 ');
    var factors = (u.factors || []).map(function(f){ return '<span class="tr-hf">' + esc(f) + '</span>'; }).join('');
    return '<div class="tr-hrow tr-hrow--' + esc(u.grade) + '">' +
      '<div class="tr-hrank">#' + (i + 1) + '</div>' +
      '<div class="tr-hscore"><div class="tr-hscore-num">' + u.score + '</div>' +
        '<div class="tr-hgrade tr-hgrade--' + esc(u.grade) + '">' + gradeLabel[u.grade] + '</div></div>' +
      '<div class="tr-hbarwrap"><div class="tr-hbar tr-hbar--' + esc(u.grade) + '" style="width:' + Math.max(3, u.score) + '%"></div></div>' +
      '<div class="tr-hbody">' +
        '<div class="tr-hhead"><button class="tr-unit-open tr-hunit" data-unit="' + esc(u.equipmentId) + '">' + esc(u.equipmentId) + '</button>' +
          (meta ? '<span class="tr-hmeta">' + esc(meta) + '</span>' : '') +
          (u.topComponent ? '<span class="tr-hmeta">worst: ' + esc(u.topComponent.key) + ' \u00d7' + u.topComponent.count + '</span>' : '') + '</div>' +
        '<div class="tr-hfactors">' + factors + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  var summary = '<div class="tr-hsummary">Scoring ' + res.totalUnits + ' unit' + (res.totalUnits === 1 ? '' : 's') +
    ' \u00b7 ' + units.filter(function(u){return u.grade==='critical';}).length + ' critical, ' +
    units.filter(function(u){return u.grade==='watch';}).length + ' watch \u00b7 ' +
    'score blends repeat failures, corrective volume, open/parts-hold, downtime, cost & recency (higher = needs attention)</div>';
  host.innerHTML = summary + '<div class="tr-htable">' + rows + '</div>';
  host.querySelectorAll('.tr-unit-open').forEach(function(b){ b.addEventListener('click', function(){ _openUnit(b.dataset.unit); }); });
}

function _loadHealth() {
  if (!window.repairIntel || !window.repairIntel.unitHealth) return;
  var host = _el.querySelector('#tr-health');
  if (host) host.innerHTML = '<div class="dp-empty" style="color:var(--mut);font-style:italic">Scoring units\u2026</div>';
  window.repairIntel.unitHealth(_collectFilters()).then(_renderHealth).catch(function(e){ _renderHealth({ ok: false, error: (e && e.message) || 'error' }); });
}

function _renderDeepSlice(res) {
  var host = _el.querySelector('#tr-slice');
  if (!host) return;
  if (!res || res.ok === false) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">' + esc((res && res.error) || 'no data') + '</div>'; return; }
  var groups = res.groups || [];
  if (!groups.length) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">No data.</div>'; return; }
  var rows = groups.map(function(g){
    var ratioCls = g.repeatRatio >= 2 ? 'tr-ratio--hot' : (g.repeatRatio > 1 ? 'tr-ratio--warn' : '');
    var repeatUnits = (g.repeatUnits || []).map(function(u){
      return '<button class="tr-chip-unit" data-unit="' + esc(u.equipmentId) + '" title="Open unit">' + esc(u.equipmentId) + ' \u00d7' + u.count + '</button>';
    }).join('');
    var makes = (g.topMakes || []).map(function(m){ return esc(m.key) + '(' + m.count + ')'; }).join(', ');
    var vendors = (g.topVendors || []).map(function(v){ return esc(v.key) + '(' + v.count + ')'; }).join(', ');
    return '<div class="tr-slice-row">' +
      '<div class="tr-slice-main">' +
        '<button class="tr-slice-key" data-dim="' + esc(res.groupBy === 'subcomponent' ? 'subcomponent' : res.groupBy) + '" data-val="' + esc(g.key) + '" title="Drill into these events">' + esc(g.key) + ' \u2197</button>' +
        '<span class="tr-slice-metrics">' +
          '<span class="tr-slice-m">' + g.events + ' events</span>' +
          '<span class="tr-slice-m">' + g.units + ' unit' + (g.units===1?'':'s') + '</span>' +
          '<span class="tr-slice-ratio ' + ratioCls + '">' + g.repeatRatio.toFixed(2) + '\u00d7 per unit</span>' +
          (g.repeatUnitCount ? '<span class="tr-slice-m tr-slice-m--warn">' + g.repeatUnitCount + ' repeating</span>' : '') +
        '</span>' +
      '</div>' +
      (repeatUnits ? '<div class="tr-slice-units"><span class="tr-slice-sub">Repeating units:</span> ' + repeatUnits + '</div>' : '') +
      ((makes || vendors) ? '<div class="tr-slice-xtab">' + (makes ? '<span class="tr-slice-sub">Makes:</span> ' + makes + '  ' : '') + (vendors ? '<span class="tr-slice-sub">Vendors:</span> ' + vendors : '') + '</div>' : '') +
    '</div>';
  }).join('');
  host.innerHTML = '<div class="tr-card tr-card--wide">' + rows + '</div>';
  // wire unit chips -> open unit
  host.querySelectorAll('.tr-chip-unit').forEach(function(b){ b.addEventListener('click', function(){ _openUnit(b.dataset.unit); }); });
  // wire key -> drill
  host.querySelectorAll('.tr-slice-key').forEach(function(b){ b.addEventListener('click', function(){ _openDrill(b.dataset.dim, b.dataset.val); }); });
}

function _renderOffenders(res) {
  var host = _el.querySelector('#tr-offenders');
  if (!host) return;
  if (!res || res.ok === false) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">' + esc((res && res.error) || 'no data') + '</div>'; return; }
  var off = res.offenders || [];
  if (!off.length) { host.innerHTML = '<div class="dp-empty" style="color:var(--mut)">No unit has repeated the same component yet.</div>'; return; }
  var rows = off.map(function(o){
    return '<div class="tr-off-row">' +
      '<button class="tr-chip-unit" data-unit="' + esc(o.equipmentId) + '">' + esc(o.equipmentId) + '</button>' +
      '<span class="tr-off-comp">' + esc(o.component) + '</span>' +
      '<span class="tr-off-count">\u00d7' + o.count + '</span>' +
      (o.make ? '<span class="tr-off-meta">' + esc(o.make) + '</span>' : '') +
      (o.vendor ? '<span class="tr-off-meta">' + esc(o.vendor) + '</span>' : '') +
    '</div>';
  }).join('');
  host.innerHTML = '<div class="tr-card tr-card--wide">' + rows + '</div>';
  host.querySelectorAll('.tr-chip-unit').forEach(function(b){ b.addEventListener('click', function(){ _openUnit(b.dataset.unit); }); });
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
      '<div class="tr-vn-head"><button class="tr-vn-name tr-rank--click" data-dim="vendor" data-val="' + esc(v.vendor) + '" title="Drill into this vendor\u2019s events">' + esc(v.vendor) + ' \u2197</button>' +
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
    return '<div class="tr-mv-row"><button class="tr-mv-comp tr-rank--click" data-dim="component" data-val="' + esc(c.component) + '" title="Drill into this component\u2019s events">' + esc(c.component) + ' \u2197</button>' +
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
    equipmentId: v('tr-f-unit'),
    domicile: v('tr-f-domicile'), operator: v('tr-f-operator'), vendor: v('tr-f-vendor'),
    make: v('tr-f-make'), category: v('tr-f-category'), component: v('tr-f-component'), woType: v('tr-f-wotype'),
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
    if (data && data.ok !== false && data.totals && data.totals.events) {
      _loadHealth();
      var ht = _el.querySelector('#tr-health-toggle');
      if (ht && !ht._wired) { ht._wired = true; ht.addEventListener('click', function(){ _healthShowAll = !_healthShowAll; ht.textContent = _healthShowAll ? 'show attention only' : 'show all'; _loadHealth(); }); }
      if (window.repairIntel.network) window.repairIntel.network(f).then(_renderNetwork).catch(function(e){ _renderNetwork({ ok: false, error: (e && e.message) || 'error' }); });
      // Deep slice (honor the group-by selector) + repeat offenders.
      var byEl = _el.querySelector('#tr-slice-by');
      var groupBy = byEl ? byEl.value : 'subcomponent';
      if (byEl && !byEl._sliceWired) { byEl._sliceWired = true; byEl.addEventListener('change', function(){ _loadSlice(byEl.value); }); }
      _loadSlice(groupBy);
      if (window.repairIntel.repeatOffenders) window.repairIntel.repeatOffenders(f).then(_renderOffenders).catch(function(e){ _renderOffenders({ ok: false, error: (e && e.message) || 'error' }); });
    }
  }).catch(function(e){
    _render({ ok: false, error: (e && e.message) || 'error' });
  });
}

function _loadSlice(groupBy) {
  if (!window.repairIntel || !window.repairIntel.deepSlice) return;
  var host = _el.querySelector('#tr-slice');
  if (host) host.innerHTML = '<div class="dp-empty" style="color:var(--mut);font-style:italic">Loading deep slice\u2026</div>';
  window.repairIntel.deepSlice(groupBy, _collectFilters()).then(_renderDeepSlice).catch(function(e){ _renderDeepSlice({ ok: false, error: (e && e.message) || 'error' }); });
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
    fill('tr-f-unit', o.units);
    fill('tr-f-domicile', o.domiciles);
    fill('tr-f-operator', o.operators);
    fill('tr-f-vendor', o.vendors);
    fill('tr-f-make', o.makes);
    fill('tr-f-category', o.categories);
    fill('tr-f-component', o.components);
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
    ['tr-f-unit','tr-f-domicile','tr-f-operator','tr-f-vendor','tr-f-make','tr-f-category','tr-f-component','tr-f-wotype'].forEach(function(id){
      var e = _el.querySelector('#' + id); if (e) e.value = '';
    });
    _load();
  });
  _el.querySelectorAll('.tr-filters select').forEach(function(sel){
    sel.addEventListener('change', _load);
  });
  // Delegated click: ranked rows drill by their dimension; month bars/rows drill
  // by month. Everything that represents data is clickable.
  _el.addEventListener('click', function(ev){
    var rank = ev.target.closest && ev.target.closest('.tr-rank--click');
    if (rank && rank.dataset.dim) { _openDrill(rank.dataset.dim, rank.dataset.val); return; }
    var month = ev.target.closest && ev.target.closest('[data-month]');
    if (month && month.dataset.month) { _openDrill('month', month.dataset.month); return; }
    var bo = ev.target.closest && ev.target.closest('.tr-bo-drill');
    if (bo) { _openDrill('partsOnOrder', 'Parts on back-order'); return; }
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
