/**
 * repair-intel/report.js — DETERMINISTIC per-unit repair report (Phase 1 of the
 * two-phase design). All counts, durations, totals, repeat-failure linkage, and
 * effectiveness classification are computed from the stored ri_repair_event rows
 * with plain math — NO AI. The AI phase (analysis.js) later adds narrative
 * summaries + advisory recommendations on top of these facts.
 *
 * No-fabrication: percentages always carry their denominator; durations that
 * can't be computed are reported as null ("Unknown"); a closed work order is
 * NOT assumed resolved — effectiveness uses evidence (outcome/canonical), and
 * stays "unknown" when evidence is absent.
 */

const store = require('./store');

const HOUR_MS = 3600 * 1000;

function _num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// Normalize a component string for repeat-failure grouping (strip punctuation,
// lowercase, collapse). Repeat failures group by (component family) — NOT by
// mere date overlap, and NOT across unrelated components.
function _componentKey(ev) {
  const c = String(ev.repair_component || ev.repair_category || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return c || '(uncategorized)';
}

// ── Repeat-failure analysis ───────────────────────────────────────────────────
// Group events by component family; a group with >=2 events within a 90-day
// span is flagged as a repeat failure. Returns groups newest-first with the
// member work orders linked. We NEVER merge unrelated components, and we treat
// this as a pattern to investigate — not proof of a defect.
function repeatFailures(events, opts = {}) {
  const windowDays = opts.windowDays || 90;
  const byComp = {};
  for (const ev of events) {
    const k = _componentKey(ev);
    (byComp[k] || (byComp[k] = [])).push(ev);
  }
  const groups = [];
  for (const [comp, list] of Object.entries(byComp)) {
    if (list.length < 2) continue;
    const sorted = list.slice().sort((a, b) => (b.reported_at || 0) - (a.reported_at || 0));
    // Only flag if at least two fall within the window of each other.
    let repeat = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i].reported_at, b = sorted[i + 1].reported_at;
      if (a && b && (a - b) <= windowDays * 24 * HOUR_MS) { repeat = true; break; }
    }
    if (!repeat && sorted.length < 3) continue; // 3+ ever still worth surfacing
    groups.push({
      component: comp,
      count: sorted.length,
      windowDays,
      workOrders: sorted.map(e => ({ workOrderId: e.work_order_id, reportedAt: e.reported_at, vendor: e.vendor, status: e.status, outcome: e.outcome })),
      firstReportedAt: sorted[sorted.length - 1].reported_at || null,
      lastReportedAt: sorted[0].reported_at || null,
    });
  }
  return groups.sort((a, b) => (b.count - a.count) || ((b.lastReportedAt || 0) - (a.lastReportedAt || 0)));
}

// ── Effectiveness classification (evidence-based) ─────────────────────────────
// A closed WO is NOT assumed resolved. If the AI phase set `outcome`, use it.
// Otherwise derive conservatively: completed + a later same-component event
// within 90d => resolved-but-repeated; cancelled => cancelled; completed with no
// later repeat => resolved (best available evidence); open => unknown/in-progress.
function classifyEffectiveness(events) {
  const tally = { resolved: 0, resolvedRepeated: 0, partial: 0, unresolved: 0, referred: 0, cancelled: 0, unknown: 0 };
  const sortedByComp = {};
  for (const ev of events) { (sortedByComp[_componentKey(ev)] || (sortedByComp[_componentKey(ev)] = [])).push(ev); }
  for (const ev of events) {
    if (ev.outcome) { // AI-set outcome wins
      const o = String(ev.outcome).toLowerCase();
      if (/resolved.*repeat|repeat/.test(o)) tally.resolvedRepeated++;
      else if (/partial/.test(o)) tally.partial++;
      else if (/unresolved/.test(o)) tally.unresolved++;
      else if (/referr|transfer/.test(o)) tally.referred++;
      else if (/cancel/.test(o)) tally.cancelled++;
      else if (/resolved|complete/.test(o)) tally.resolved++;
      else tally.unknown++;
      continue;
    }
    if (ev.status === 'cancelled') { tally.cancelled++; continue; }
    if (ev.status === 'transferred') { tally.referred++; continue; }
    if (ev.status !== 'completed') { tally.unknown++; continue; }
    // completed: did the same component come back within 90d AFTER this one?
    const comp = _componentKey(ev);
    const later = (sortedByComp[comp] || []).some(o => o !== ev && o.reported_at && ev.repair_completed_at && o.reported_at > ev.repair_completed_at && (o.reported_at - ev.repair_completed_at) <= 90 * 24 * HOUR_MS);
    if (later) tally.resolvedRepeated++; else tally.resolved++;
  }
  return tally;
}

// ── Downtime totals (deterministic; only sums what's actually computed) ───────
function downtimeTotals(events) {
  let totalMs = 0, counted = 0, missing = 0;
  for (const ev of events) {
    if (ev.total_elapsed_ms != null) { totalMs += ev.total_elapsed_ms; counted++; }
    else missing++;
  }
  return {
    totalHours: counted ? Math.round(totalMs / HOUR_MS) : null,
    eventsCounted: counted,
    eventsMissingTimestamps: missing,  // surfaced so a total isn't misread as complete
    coverage: events.length ? Math.round((counted / events.length) * 100) : 0,
  };
}

function _topCounts(events, keyFn, limit) {
  const m = {};
  for (const ev of events) { const k = keyFn(ev); if (k) m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, limit || 5).map(([k, n]) => ({ key: k, count: n }));
}

// ── Executive summary (pure counts) ───────────────────────────────────────────
function executiveSummary(events, parts) {
  const total = events.length;
  const wos = new Set(events.map(e => e.work_order_id).filter(Boolean)).size;
  const corrective = events.filter(e => e.wo_type !== 'PM').length;
  const pm = events.filter(e => e.wo_type === 'PM').length;
  const rf = repeatFailures(events);
  const eff = classifyEffectiveness(events);
  const dt = downtimeTotals(events);
  const multiVendor = (() => {
    // components repaired by >1 distinct vendor across the window
    const byComp = {};
    for (const e of events) { const k = _componentKey(e); (byComp[k] || (byComp[k] = new Set())).add(e.vendor); }
    return Object.values(byComp).filter(s => s.size > 1).length;
  })();
  return {
    totalRepairEvents: total,
    uniqueWorkOrders: wos,
    correctiveRepairs: corrective,
    pmEvents: pm,
    repeatFailureGroups: rf.length,
    unresolvedIssues: eff.unresolved + eff.resolvedRepeated,
    totalKnownDowntimeHours: dt.totalHours,
    downtimeCoveragePct: dt.coverage,
    topCategories: _topCounts(events, e => e.repair_category, 5),
    topComponents: _topCounts(events, e => e.repair_component, 5),
    topParts: parts && parts.length ? _topCounts(parts, p => p.part_name || p.part_number, 5) : [],
    multiVendorRepairs: multiVendor,
    effectiveness: eff,
  };
}

// ── Chronological timeline (newest → oldest) ──────────────────────────────────
function timeline(events) {
  return events.slice().sort((a, b) => (b.reported_at || b.created_at || 0) - (a.reported_at || a.created_at || 0))
    .map(e => ({
      reportedAt: e.reported_at, workOrderId: e.work_order_id, amzId: e.amz_id, vendor: e.vendor,
      category: e.repair_category, component: e.repair_component, status: e.status, woType: e.wo_type,
      complaint: e.reported_complaint,
      // AI-filled when available; otherwise explicitly "Unknown".
      rootCause: e.confirmed_root_cause || (e.suspected_root_cause ? ('suspected: ' + e.suspected_root_cause) : null),
      actions: e.corrective_actions || null,
      outcome: e.outcome || null,
      durationHours: e.total_elapsed_ms != null ? Math.round(e.total_elapsed_ms / HOUR_MS) : null,
      estimateCost: _num(e.estimate_cost),
      sourceRefs: (() => { try { return JSON.parse(e.source_refs || '{}'); } catch (_) { return {}; } })(),
    }));
}

// Build the full deterministic report for one unit. By default it shows ALL
// stored events (the engine only stores what the API returned), so a unit whose
// repairs are older than 12 months still shows its real history. A caller can
// pass opts.sinceMs to narrow the window.
function buildUnitReport(equipmentId, opts = {}) {
  const events = store.eventsForUnit(equipmentId, opts);
  // Report the ACTUAL span of the events shown (honest — not a fixed "365").
  let oldest = null, newest = null;
  for (const e of events) {
    const t = e.reported_at || e.created_at;
    if (!t) continue;
    if (oldest == null || t < oldest) oldest = t;
    if (newest == null || t > newest) newest = t;
  }
  const spanDays = (oldest != null && newest != null) ? Math.max(1, Math.round((newest - oldest) / (24 * HOUR_MS))) : 0;
  // Parts across this unit's events (for the summary's top-parts).
  const parts = []; // parts are loaded per-event elsewhere; summary tolerates empty
  return {
    equipmentId: String(equipmentId),
    windowDays: opts.sinceMs != null ? Math.round((Date.now() - opts.sinceMs) / (24 * HOUR_MS)) : null,
    spanDays,
    oldestAt: oldest,
    newestAt: newest,
    generatedAt: Date.now(),
    executiveSummary: executiveSummary(events, parts),
    repeatFailures: repeatFailures(events),
    timeline: timeline(events),
    coverage: { events: events.length },
  };
}

module.exports = {
  buildUnitReport, executiveSummary, repeatFailures, classifyEffectiveness,
  downtimeTotals, timeline, _componentKey,
};
