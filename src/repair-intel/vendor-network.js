/**
 * repair-intel/vendor-network.js — DETERMINISTIC vendor scope / network
 * intelligence (Phase 6). Fleet-wide, SQL-only. Answers:
 *   - Which vendors handle which repairs, how often, with what downtime/cost?
 *   - Which vendors show a high repeat-failure rate (same component back within
 *     90 days AFTER a completed repair by that vendor)?
 *   - Which components get spread across MULTIPLE vendors (a network signal —
 *     possible scope confusion / referral churn, worth a human review)?
 *   - Per-vendor outcome mix (evidence-based; a closed WO is not assumed fixed).
 *
 * Hard rules:
 *   - Excluded vendors (Velocity/Fleetnet/Goodyear) are filtered at the query
 *     layer via excluded_vendor = 0. The exclusion set itself lives in the AAP
 *     mapper chokepoint; this module only reads the already-flagged column.
 *   - No fabrication: a "repeat rate" always carries its denominator; downtime/
 *     cost totals carry coverage %; signals are described as PATTERNS to review,
 *     never as proof of vendor fault.
 *   - Advisory only. Any recommendations produced here never change readiness.
 */

const engine = require('../store/sqlite_engine');
const { ensureSchema } = require('./schema');

const YEAR_MS = 365 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const REPEAT_WINDOW_MS = 90 * 24 * HOUR_MS;

function _rows(sql, params) { const s = engine.prepare(sql); return s ? s.all(params || {}) : []; }

// Normalize a component the SAME way report.js does, so repeat-failure grouping
// is consistent across the per-unit report and the network view.
function _componentKey(ev) {
  const c = String(ev.repair_component || ev.repair_category || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return c || '(uncategorized)';
}

// Per-vendor rollup: volume, downtime (with coverage), estimate cost (with
// coverage), distinct units, and an evidence-based outcome mix.
function vendorScorecards(opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const since = opts.sinceMs != null ? opts.sinceMs : (Date.now() - YEAR_MS);

  const base = _rows(
    'SELECT vendor, COUNT(*) AS events, COUNT(DISTINCT equipment_id) AS units, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN total_elapsed_ms ELSE 0 END) AS dt, ' +
    'SUM(CASE WHEN total_elapsed_ms IS NOT NULL THEN 1 ELSE 0 END) AS dtn, ' +
    'SUM(CASE WHEN estimate_cost IS NOT NULL THEN estimate_cost ELSE 0 END) AS cost, ' +
    'SUM(CASE WHEN estimate_cost IS NOT NULL THEN 1 ELSE 0 END) AS costn ' +
    'FROM ri_repair_event WHERE excluded_vendor = 0 AND vendor IS NOT NULL AND vendor <> \'\' ' +
    'AND (reported_at IS NULL OR reported_at >= @since) GROUP BY vendor ORDER BY events DESC',
    { since });

  // Outcome mix per vendor (uses AI outcome when present, else source status).
  const outcomeRows = _rows(
    "SELECT vendor, COALESCE(NULLIF(outcome,''),'status:'||COALESCE(status,'unknown')) AS o, COUNT(*) AS n " +
    'FROM ri_repair_event WHERE excluded_vendor = 0 AND vendor IS NOT NULL AND vendor <> \'\' ' +
    'AND (reported_at IS NULL OR reported_at >= @since) GROUP BY vendor, o',
    { since });
  const outByVendor = {};
  for (const r of outcomeRows) { (outByVendor[r.vendor] || (outByVendor[r.vendor] = [])).push({ key: r.o, count: r.n }); }

  const cards = base.map(v => ({
    vendor: v.vendor,
    events: v.events,
    units: v.units,
    downtimeHours: v.dtn ? Math.round(v.dt / HOUR_MS) : null,
    downtimeCoverage: v.events ? Math.round((v.dtn / v.events) * 100) : 0,
    avgDowntimeHours: v.dtn ? Math.round((v.dt / v.dtn) / HOUR_MS) : null,
    estimateCostTotal: v.costn ? Math.round(v.cost) : null,
    costCoverage: v.events ? Math.round((v.costn / v.events) * 100) : 0,
    outcomes: (outByVendor[v.vendor] || []).sort((a, b) => b.count - a.count),
  }));
  return { ok: true, since, vendors: cards };
}

// Per-vendor repeat-failure rate. For each completed event by a vendor, did the
// SAME component on the SAME unit come back within 90 days AFTER completion
// (regardless of which vendor handled the return)? repeatRate = repeats / basis.
function vendorRepeatRates(opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const since = opts.sinceMs != null ? opts.sinceMs : (Date.now() - YEAR_MS);

  // Pull the minimal columns for all in-window events (both the completed basis
  // and the potential later returns) — the recurrence check needs unit+component
  // across ALL events, so we compute it in JS (bounded: fleet-year is modest).
  const evs = _rows(
    'SELECT equipment_id, vendor, status, repair_component, repair_category, reported_at, repair_completed_at ' +
    'FROM ri_repair_event WHERE excluded_vendor = 0 AND (reported_at IS NULL OR reported_at >= @since)',
    { since });

  // Index later events by unit+component for fast recurrence lookup.
  const byUnitComp = {};
  for (const e of evs) {
    const k = e.equipment_id + '\u0000' + _componentKey(e);
    (byUnitComp[k] || (byUnitComp[k] = [])).push(e);
  }

  const perVendor = {};
  for (const e of evs) {
    if (e.status !== 'completed' || !e.repair_completed_at) continue; // basis = completed repairs with a completion time
    const v = e.vendor; if (!v) continue;
    const slot = perVendor[v] || (perVendor[v] = { basis: 0, repeats: 0 });
    slot.basis++;
    const k = e.equipment_id + '\u0000' + _componentKey(e);
    const later = (byUnitComp[k] || []).some(o => o !== e && o.reported_at &&
      o.reported_at > e.repair_completed_at && (o.reported_at - e.repair_completed_at) <= REPEAT_WINDOW_MS);
    if (later) slot.repeats++;
  }

  const rows = Object.entries(perVendor).map(([vendor, s]) => ({
    vendor, basis: s.basis, repeats: s.repeats,
    repeatRatePct: s.basis ? Math.round((s.repeats / s.basis) * 100) : 0,
  })).filter(r => r.basis >= (opts.minBasis || 1))
    .sort((a, b) => b.repeatRatePct - a.repeatRatePct || b.repeats - a.repeats);
  return { ok: true, since, windowDays: 90, vendors: rows };
}

// Components repaired by MORE THAN ONE vendor across the fleet — a network
// signal (scope confusion / referral churn) worth a human review. Lists the
// vendors + counts per component. NOT proof of a problem.
function multiVendorComponents(opts = {}) {
  if (!ensureSchema()) return { ok: false, error: 'sqlite unavailable' };
  const since = opts.sinceMs != null ? opts.sinceMs : (Date.now() - YEAR_MS);
  const evs = _rows(
    'SELECT vendor, repair_component, repair_category, COUNT(*) AS n ' +
    'FROM ri_repair_event WHERE excluded_vendor = 0 AND vendor IS NOT NULL AND vendor <> \'\' ' +
    'AND (reported_at IS NULL OR reported_at >= @since) GROUP BY vendor, repair_component, repair_category',
    { since });
  const byComp = {};
  for (const r of evs) {
    const k = _componentKey(r);
    const slot = byComp[k] || (byComp[k] = { component: k, total: 0, vendors: {} });
    slot.total += r.n;
    slot.vendors[r.vendor] = (slot.vendors[r.vendor] || 0) + r.n;
  }
  const out = Object.values(byComp)
    .map(s => ({ component: s.component, total: s.total,
      vendorCount: Object.keys(s.vendors).length,
      vendors: Object.entries(s.vendors).map(([v, n]) => ({ vendor: v, count: n })).sort((a, b) => b.count - a.count) }))
    .filter(s => s.vendorCount > 1)
    .sort((a, b) => b.vendorCount - a.vendorCount || b.total - a.total);
  return { ok: true, since, components: out.slice(0, opts.limit || 25) };
}

// Full network payload for the UI.
function buildNetwork(opts = {}) {
  const scorecards = vendorScorecards(opts);
  if (!scorecards.ok) return scorecards;
  return {
    ok: true,
    since: scorecards.since,
    scorecards: scorecards.vendors,
    repeatRates: vendorRepeatRates(opts).vendors || [],
    multiVendor: multiVendorComponents(opts).components || [],
  };
}

module.exports = { vendorScorecards, vendorRepeatRates, multiVendorComponents, buildNetwork, _componentKey, YEAR_MS };
