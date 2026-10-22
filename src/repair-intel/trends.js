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
    model: 'model', status: 'status', woType: 'wo_type', category: 'repair_category' };
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

// Month buckets (YYYY-MM) of repair-event volume over the window.
function _monthly(where) {
  // node:sqlite has strftime; reported_at is epoch ms -> seconds for date().
  const rows = _rows(
    "SELECT strftime('%Y-%m', reported_at/1000, 'unixepoch') AS ym, COUNT(*) AS n " +
    'FROM ri_repair_event' + where.sql + (where.sql ? ' AND ' : ' WHERE ') + 'reported_at IS NOT NULL ' +
    'GROUP BY ym ORDER BY ym ASC',
    where.params);
  return rows.map(r => ({ month: r.ym, count: r.n }));
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
  };
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
  };
}

module.exports = { buildTrends, filterOptions, YEAR_MS };
