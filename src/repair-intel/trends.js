/**
 * repair-intel/trends.js — DETERMINISTIC fleet-wide aggregation for the Trends
 * dashboard. Pure SQL counts/sums over ri_repair_event with optional filters.
 * NO AI. Excluded vendors (Velocity/Fleetnet/Goodyear) are filtered out unless
 * includeExcluded is passed. Durations that cannot be computed are simply not
 * summed (coverage is reported alongside every total so a number is never
 * mistaken for complete data).
 *
 * Filters (all optional, combined with AND):
 *   sinceMs/toMs   rolling window (default last 365 days)
 *   domicile, operator, vendor, make, model, category, status, woType
 *   includeExcluded (default false)
 */

const engine = require('../store/sqlite_engine');
const { ensureSchema } = require('./schema');

const YEAR_MS = 365 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

// Build a parametrized WHERE clause + params object from a filter spec. Only
// whitelisted columns are ever interpolated into SQL (the rest are bound), so
// there is no injection surface from the renderer-supplied filter.
function _where(opts = {}) {
  const clauses = [];
  const params = {};
  const since = opts.sinceMs != null ? opts.sinceMs : (Date.now() - YEAR_MS);
  clauses.push('(reported_at IS NULL OR reported_at >= @since)');
  params.since = since;
  if (opts.toMs != null) { clauses.push('(reported_at IS NULL OR reported_at <= @to)'); params.to = opts.toMs; }
  if (!opts.includeExcluded) clauses.push('excluded_vendor = 0');
  const eqCols = { domicile: 'domicile', operator: 'operator', vendor: 'vendor', make: 'make',
    model: 'model', status: 'status', woType: 'wo_type', category: 'repair_category',
    equipmentId: 'equipment_id', component: 'repair_component' };
  for (const [key, col] of Object.entries(eqCols)) {
    if (opts[key]) { clauses.push(col + ' = @' + key); params[key] = String(opts[key]); }
  }
  return { sql: clauses.length ? (' WHERE ' + clauses.join(' AND ')) : '', params };
}

function _rows(sql, params) {
  const stmt = engine.prepare(sql);
  return stmt ? stmt.all(params) : [];
}
function _one(sql, params) {
  const stmt = engine.prepare(sql);
  return stmt ? stmt.get(params) : null;
}

// Top-N grouping by a whitelisted column.
function _groupBy(col, where, limit) {
  const rows = _rows(
    'SELECT ' + col + ' AS k, COUNT(*) AS n, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN total_elapsed_ms ELSE 0 END) AS dt, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN 1 ELSE 0 END) AS dtn ' +
    'FROM ri_repair_event' + where.sql + (where.sql ? ' AND ' : ' WHERE ') + col + ' IS NOT NULL AND ' + col + " <> '' " +
    'GROUP BY ' + col + ' ORDER BY n DESC LIMIT @_lim',
    Object.assign({ _lim: limit || 10 }, where.params));
  return rows.map(r => ({ key: r.k, count: r.n, downtimeHours: r.dtn ? Math.round(r.dt / HOUR_MS) : null, downtimeCoverage: r.n ? Math.round((r.dtn / r.n) * 100) : 0 }));
}

// Month buckets (YYYY-MM) with a full status breakdown per month. Everything
// here is a real count from the stored work orders — no fabrication. "inProgress"
// = open/reopened (not completed/cancelled/transferred). "unitsAffected" = how
// many DISTINCT units had a repair reported that month (the closest honest proxy
// for "how many went down that month" — the engine does not store historical
// fleet availability snapshots, so we do NOT claim a fleet-availability %).
function _monthly(where) {
  const rows = _rows(
    "SELECT strftime('%Y-%m', reported_at/1000, 'unixepoch') AS ym, " +
    'COUNT(*) AS n, ' +
    'COUNT(DISTINCT equipment_id) AS units, ' +
    "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, " +
    "SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled, " +
    "SUM(CASE WHEN status='transferred' THEN 1 ELSE 0 END) AS transferred, " +
    "SUM(CASE WHEN status IN ('open','reopened') THEN 1 ELSE 0 END) AS inProgress, " +
    "SUM(CASE WHEN wo_type='PM' THEN 1 ELSE 0 END) AS pm, " +
    "SUM(CASE WHEN parts_on_order=1 THEN 1 ELSE 0 END) AS partsHold, " +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN total_elapsed_ms ELSE 0 END) AS dt, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN 1 ELSE 0 END) AS dtn ' +
    'FROM ri_repair_event' + where.sql + (where.sql ? ' AND ' : ' WHERE ') + 'reported_at IS NOT NULL ' +
    'GROUP BY ym ORDER BY ym ASC',
    where.params);
  return rows.map(r => ({
    month: r.ym,
    count: r.n,
    unitsAffected: r.units,
    completed: r.completed,
    cancelled: r.cancelled,
    transferred: r.transferred,
    inProgress: r.inProgress,
    pm: r.pm,
    partsHold: r.partsHold,
    avgDowntimeHours: r.dtn ? Math.round((r.dt / r.dtn) / HOUR_MS) : null,
    downtimeCoverage: r.n ? Math.round((r.dtn / r.n) * 100) : 0,
  }));
}

// Build the full fleet Trends payload for a filter spec.
function buildTrends(opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const where = _where(opts);

  const totals = _one(
    'SELECT COUNT(*) AS events, COUNT(DISTINCT equipment_id) AS units, COUNT(DISTINCT work_order_id) AS wos, ' +
    "SUM(CASE WHEN wo_type = 'PM' THEN 1 ELSE 0 END) AS pm, " +
    "SUM(CASE WHEN wo_type <> 'PM' THEN 1 ELSE 0 END) AS corrective, " +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN total_elapsed_ms ELSE 0 END) AS dt, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN 1 ELSE 0 END) AS dtn, ' +
    'SUM(CASE WHEN estimate_cost IS NOT NULL THEN estimate_cost ELSE 0 END) AS cost, ' +
    'SUM(CASE WHEN estimate_cost IS NOT NULL THEN 1 ELSE 0 END) AS costn ' +
    'FROM ri_repair_event' + where.sql,
    where.params) || {};

  // Effectiveness tally across the filtered set (uses the AI-set outcome when
  // present; otherwise falls back to the source status — same evidence-based
  // stance as the per-unit report).
  const outcomes = _rows(
    "SELECT COALESCE(NULLIF(outcome,''), 'status:' || COALESCE(status,'unknown')) AS o, COUNT(*) AS n " +
    'FROM ri_repair_event' + where.sql + ' GROUP BY o',
    where.params);

  // Back-order / parts-delay rollup (honest: only events the API flagged via
  // delay reason codes / lifecycle reason; carries its denominator).
  const partsWhere = { sql: where.sql + (where.sql ? ' AND ' : ' WHERE ') + 'parts_on_order = 1', params: where.params };
  const partsTotal = _one('SELECT COUNT(*) AS n, COUNT(DISTINCT equipment_id) AS units FROM ri_repair_event' + partsWhere.sql, partsWhere.params) || {};
  const partsByComponent = _groupBy('repair_component', partsWhere, opts.limit || 10);
  const partsByVendor = _groupBy('vendor', partsWhere, opts.limit || 10);

  const eventsN = totals.events || 0;
  return {
    ok: true,
    window: { sinceMs: where.params.since, toMs: opts.toMs || Date.now() },
    totals: {
      events: eventsN,
      units: totals.units || 0,
      workOrders: totals.wos || 0,
      pm: totals.pm || 0,
      corrective: totals.corrective || 0,
      downtimeHours: totals.dtn ? Math.round(totals.dt / HOUR_MS) : null,
      downtimeCoverage: eventsN ? Math.round((totals.dtn / eventsN) * 100) : 0,
      estimateCostTotal: totals.costn ? Math.round(totals.cost) : null,
      costCoverage: eventsN ? Math.round((totals.costn / eventsN) * 100) : 0,
    },
    byVendor:   _groupBy('vendor', where, opts.limit || 10),
    byCategory: _groupBy('repair_category', where, opts.limit || 10),
    byComponent:_groupBy('repair_component', where, opts.limit || 10),
    byDomicile: _groupBy('domicile', where, opts.limit || 10),
    byOperator: _groupBy('operator', where, opts.limit || 10),
    byMake:     _groupBy('make', where, opts.limit || 10),
    monthly:    _monthly(where),
    outcomes:   outcomes.map(r => ({ key: r.o, count: r.n })),
    backorder: {
      events: partsTotal.n || 0,
      units: partsTotal.units || 0,
      pctOfEvents: eventsN ? Math.round(((partsTotal.n || 0) / eventsN) * 100) : 0,
      byComponent: partsByComponent,
      byVendor: partsByVendor,
    },
  };
}

// ── Drill-down ────────────────────────────────────────────────────────────────
// Given a dimension + value (what the user clicked on in a ranked list), return
// the actual EVENTS behind that trend — unit #, dates, status, the failure
// complaint, and the "why" fields (delay reason, cancellation reason, scope/root
// cause when the AI layer has filled them). This is what turns "brakes x12" into
// "these 9 units, here's each one's failure + why, click to open the work order".
const _DRILL_COLS = {
  category: 'repair_category',
  component: 'repair_component',
  vendor: 'vendor',
  domicile: 'domicile',
  operator: 'operator',
  make: 'make',
  model: 'model',
  status: 'status',
  outcome: 'outcome',
};

function drillEvents(dimension, value, opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const since = opts.sinceMs != null ? opts.sinceMs : 0; // default: all stored
  const extra = [];
  const params = { val: String(value), since };
  // "month" is not a column — match the YYYY-MM bucket via strftime. Otherwise
  // the dimension must be a whitelisted column.
  let matchClause;
  if (dimension === 'month') {
    matchClause = "strftime('%Y-%m', reported_at/1000, 'unixepoch') = @val";
  } else {
    const col = _DRILL_COLS[dimension];
    if (!col) return { ok: false, error: 'unknown dimension: ' + dimension };
    matchClause = col + ' = @val';
  }
  // optional combined filters (same whitelist as _where)
  const drillCol = _DRILL_COLS[dimension]; // undefined for month
  const eqCols = { domicile: 'domicile', operator: 'operator', vendor: 'vendor', make: 'make',
    model: 'model', category: 'repair_category', woType: 'wo_type', equipmentId: 'equipment_id',
    component: 'repair_component' };
  for (const [key, c] of Object.entries(eqCols)) {
    if (opts[key] && c !== drillCol) { extra.push(c + ' = @f_' + key); params['f_' + key] = String(opts[key]); }
  }
  if (dimension === 'partsOnOrder' || opts.partsOnOrder) extra.push('parts_on_order = 1');
  const sql =
    'SELECT equipment_id, work_order_id, service_id, amz_id, vendor, status, wo_type, ' +
    'repair_category, repair_component, reported_complaint, cancellation_reason, delay_reason_codes, ' +
    'parts_on_order, out_of_scope_reason, in_scope, confirmed_root_cause, suspected_root_cause, ' +
    'outcome, corrective_actions, reported_at, repair_completed_at, estimate_cost, source_refs ' +
    'FROM ri_repair_event WHERE excluded_vendor = 0 AND ' + matchClause + ' ' +
    'AND (reported_at IS NULL OR reported_at >= @since)' +
    (extra.length ? ' AND ' + extra.join(' AND ') : '') +
    ' ORDER BY equipment_id ASC, COALESCE(reported_at, created_at, 0) DESC';
  const rows = _rows(sql, params);
  // Shape for the renderer: one object per event with a stable work-order URL.
  const events = rows.map(r => {
    let url = null;
    try { const sr = JSON.parse(r.source_refs || '{}'); url = sr.relay || null; } catch (_) {}
    if (!url && r.service_id) url = 'https://aap-na.corp.amazon.com/v2/service/' + r.service_id;
    return {
      equipmentId: r.equipment_id,
      workOrderId: r.work_order_id,
      serviceId: r.service_id,
      amzId: r.amz_id,
      vendor: r.vendor,
      status: r.status,
      woType: r.wo_type,
      category: r.repair_category,
      component: r.repair_component,
      complaint: r.reported_complaint,
      // the "why" — honest: these come straight from the source (delay/cancel) or
      // the AI layer (root cause / scope), null when not documented.
      delayReason: r.delay_reason_codes,
      cancellationReason: r.cancellation_reason,
      outOfScopeReason: r.out_of_scope_reason,
      inScope: r.in_scope,
      rootCause: r.confirmed_root_cause || (r.suspected_root_cause ? 'suspected: ' + r.suspected_root_cause : null),
      correctiveActions: r.corrective_actions,
      outcome: r.outcome,
      partsOnOrder: !!r.parts_on_order,
      reportedAt: r.reported_at,
      completedAt: r.repair_completed_at,
      estimateCost: (typeof r.estimate_cost === 'number') ? r.estimate_cost : null,
      url,
    };
  });
  // Unit roll-up: which units trended for this, and how many times each.
  const byUnit = {};
  for (const e of events) { (byUnit[e.equipmentId] || (byUnit[e.equipmentId] = [])).push(e); }
  const units = Object.entries(byUnit)
    .map(([equipmentId, evs]) => ({
      equipmentId,
      count: evs.length,
      // per-unit distinct root causes + statuses so each unit row is a glance.
      rootCauses: _distinctVals(evs.map(e => e.rootCause)),
      statuses: _tallyVals(evs.map(e => e.status)),
      vendors: _distinctVals(evs.map(e => e.vendor)),
      lastReportedAt: Math.max.apply(null, evs.map(e => e.reportedAt || 0)),
      events: evs,
    }))
    .sort((a, b) => b.count - a.count || a.equipmentId.localeCompare(b.equipmentId));

  // Cross-unit rollups for the clicked trend (the "everything" summary).
  const rootCauseRollup = _tallyVals(events.map(e => e.rootCause).filter(Boolean));
  const whyRollup = _tallyVals([].concat(
    events.filter(e => e.delayReason).map(e => 'delay: ' + e.delayReason),
    events.filter(e => e.cancellationReason).map(e => 'cancelled: ' + e.cancellationReason),
    events.filter(e => e.outOfScopeReason).map(e => 'out-of-scope: ' + e.outOfScopeReason)
  ));
  const statusRollup = _tallyVals(events.map(e => e.status));
  const docCoverage = events.length ? Math.round((events.filter(e => e.rootCause).length / events.length) * 100) : 0;

  return {
    ok: true, dimension, value: String(value),
    totalEvents: events.length, unitCount: units.length,
    rootCauseRollup, whyRollup, statusRollup,
    rootCauseCoverage: docCoverage, // % of events with a documented/AI root cause
    units,
  };
}

// Distinct non-empty values, order-preserving.
function _distinctVals(arr) {
  const seen = new Set(); const out = [];
  for (const v of arr) { if (v && !seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}
// Count occurrences -> [{key,count}] sorted desc.
function _tallyVals(arr) {
  const m = {};
  for (const v of arr) { if (v) m[v] = (m[v] || 0) + 1; }
  return Object.entries(m).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

// ── Deep slice analytics ────────────────────────────────────────────────────
// The repetitive-fault engine. For a grouping column (L1 component, L2
// sub-component, vendor, make, model), compute per group:
//   events        total repair events
//   units         DISTINCT units affected
//   repeatRatio   events / units  (>1 = same units coming back = a REAL pattern)
//   repeatUnits   the units that had this >1 time, with their counts
// This is what separates "10 different units each had an airbag issue once"
// (units=10, ratio=1.0) from "1 unit had 10 airbag repairs" (units=1, ratio=10).
const _SLICE_COLS = {
  component: 'repair_component',       // L1
  subcomponent: 'repair_subcategory',  // L2 (windshield, air brake assembly, ...)
  category: 'repair_category',
  vendor: 'vendor',
  make: 'make',
  model: 'model',
  domicile: 'domicile',
  operator: 'operator',
};

function deepSlice(groupBy, opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const col = _SLICE_COLS[groupBy] || _SLICE_COLS.subcomponent;
  const where = _where(Object.assign({ sinceMs: opts.sinceMs != null ? opts.sinceMs : 0 }, opts));
  // Pull the grouping key + unit for every matching event, compute in JS so we
  // can split a 'A; B' multi-value cell into its parts (suggestedItems join).
  const rows = _rows(
    'SELECT ' + col + ' AS k, equipment_id AS u, make, vendor, status FROM ri_repair_event' +
    where.sql + (where.sql ? ' AND ' : ' WHERE ') + col + " IS NOT NULL AND " + col + " <> '' ",
    where.params);

  const groups = {};
  for (const r of rows) {
    // a cell may hold multiple component families ('Engine; Coolant') — count each
    const keys = String(r.k).split(';').map(s => s.trim()).filter(Boolean);
    for (const key of keys) {
      const g = groups[key] || (groups[key] = { key, events: 0, unitCounts: {}, makeCounts: {}, vendorCounts: {} });
      g.events++;
      g.unitCounts[r.u] = (g.unitCounts[r.u] || 0) + 1;
      if (r.make) g.makeCounts[r.make] = (g.makeCounts[r.make] || 0) + 1;
      if (r.vendor) g.vendorCounts[r.vendor] = (g.vendorCounts[r.vendor] || 0) + 1;
    }
  }

  const out = Object.values(groups).map(g => {
    const units = Object.keys(g.unitCounts);
    const repeatUnits = units.filter(u => g.unitCounts[u] > 1)
      .map(u => ({ equipmentId: u, count: g.unitCounts[u] }))
      .sort((a, b) => b.count - a.count);
    return {
      key: g.key,
      events: g.events,
      units: units.length,
      repeatRatio: units.length ? Math.round((g.events / units.length) * 100) / 100 : 0,
      repeatUnitCount: repeatUnits.length,
      repeatUnits: repeatUnits.slice(0, 10),
      topMakes: _topEntries(g.makeCounts, 4),
      topVendors: _topEntries(g.vendorCounts, 4),
    };
  }).sort((a, b) =>
    // surface the strongest repeat patterns first, then raw volume
    (b.repeatRatio - a.repeatRatio) || (b.events - a.events)
  );

  return { ok: true, groupBy, groups: out.slice(0, opts.limit || 40) };
}

function _topEntries(obj, n) {
  return Object.entries(obj).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, n || 5);
}

// Repeat offenders: units that had the SAME component (L1) 2+ times in the
// window — the clearest "same unit keeps coming back" signal, fleet-wide.
function repeatOffenders(opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const where = _where(Object.assign({ sinceMs: opts.sinceMs != null ? opts.sinceMs : 0 }, opts));
  const rows = _rows(
    'SELECT equipment_id AS u, repair_component AS c, make, vendor FROM ri_repair_event' +
    where.sql + (where.sql ? ' AND ' : ' WHERE ') + "repair_component IS NOT NULL AND repair_component <> '' ",
    where.params);
  const byUnitComp = {};
  for (const r of rows) {
    for (const comp of String(r.c).split(';').map(s => s.trim()).filter(Boolean)) {
      const k = r.u + '\u0000' + comp;
      const e = byUnitComp[k] || (byUnitComp[k] = { equipmentId: r.u, component: comp, count: 0, make: r.make, vendor: r.vendor });
      e.count++;
    }
  }
  const offenders = Object.values(byUnitComp).filter(e => e.count >= 2)
    .sort((a, b) => b.count - a.count || a.equipmentId.localeCompare(b.equipmentId));
  return { ok: true, offenders: offenders.slice(0, opts.limit || 40) };
}

// Distinct values for a whitelisted filter column (to populate dropdowns).
function filterOptions() {
  if (!ensureSchema()) return {};
  function distinct(col) {
    const rows = _rows('SELECT DISTINCT ' + col + ' AS v FROM ri_repair_event WHERE ' + col + " IS NOT NULL AND " + col + " <> '' AND excluded_vendor = 0 ORDER BY v ASC LIMIT 200", {});
    return rows.map(r => r.v);
  }
  return {
    domiciles: distinct('domicile'),
    operators: distinct('operator'),
    vendors:   distinct('vendor'),
    makes:     distinct('make'),
    categories:distinct('repair_category'),
    components:distinct('repair_component'),
    units:     distinct('equipment_id'),
  };
}

module.exports = { buildTrends, filterOptions, drillEvents, deepSlice, repeatOffenders, YEAR_MS };
