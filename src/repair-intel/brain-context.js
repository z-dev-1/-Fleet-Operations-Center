/**
 * repair-intel/brain-context.js — a COMPACT, deterministic repair-intelligence
 * snapshot for injection into the Fleet Brain's system context (Phase 7).
 *
 * Purpose: let the AI assistant answer repair-history / trend / vendor questions
 * grounded in the real 12-month engine, WITHOUT rewriting the Brain's query flow
 * and WITHOUT any network/AI work here (pure SQL, fast). Degrades to empty when
 * the engine has no data yet, so it never bloats the prompt for a fresh install.
 *
 * No fabrication: every figure is a real count/rate from ri_repair_event, and
 * the block explicitly tells the model these are advisory patterns, not proof,
 * and that it must not invent root causes/parts/costs the engine does not have.
 * Excluded vendors (Velocity/Fleetnet/Goodyear) are already filtered out by the
 * underlying aggregators.
 */

let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { warn(){} }; }

// Build the snapshot text, or '' when there's nothing on record. Keep it SHORT
// (a few lines) — this rides in every Brain prompt, so brevity matters.
function brainContext(opts = {}) {
  try {
    const trends = require('./trends');
    const vn = require('./vendor-network');
    const t = trends.buildTrends({});
    if (!t || t.ok === false || !t.totals || !t.totals.events) return '';

    const tot = t.totals;
    const lines = [];
    lines.push('\nREPAIR INTELLIGENCE (12-month engine, deterministic, excludes Velocity/Fleetnet/Goodyear):');
    lines.push('- On record: ' + tot.events + ' repair events across ' + tot.units + ' units (' +
      tot.corrective + ' corrective, ' + tot.pm + ' PM)' +
      (tot.downtimeHours != null ? ', ~' + tot.downtimeHours + 'h known downtime (' + tot.downtimeCoverage + '% coverage)' : ''));

    const topCat = (t.byCategory || []).slice(0, 5).map(c => c.key + '(' + c.count + ')').join(', ');
    if (topCat) lines.push('- Top repair categories: ' + topCat);

    const topVendor = (t.byVendor || []).slice(0, 5).map(v => v.key + '(' + v.count + ')').join(', ');
    if (topVendor) lines.push('- Busiest vendors: ' + topVendor);

    // Vendor repeat-failure rates (only surface the notable ones).
    const net = vn.buildNetwork({});
    if (net && net.ok) {
      const rr = (net.repeatRates || []).filter(r => r.basis >= 3 && r.repeatRatePct >= 15).slice(0, 4);
      if (rr.length) lines.push('- Elevated repeat-failure rate (same component back within 90d): ' +
        rr.map(r => r.vendor + ' ' + r.repeatRatePct + '% (' + r.repeats + '/' + r.basis + ')').join(', '));
      const mv = (net.multiVendor || []).filter(c => c.vendorCount >= 3).slice(0, 4);
      if (mv.length) lines.push('- Components spread across 3+ vendors (scope/referral churn to review): ' +
        mv.map(c => c.component + '(' + c.vendorCount + ')').join(', '));
    }

    lines.push('When asked about a specific unit, say the user can open that unit\u2019s History tab for its full 12-month report.');
    lines.push('These are ADVISORY patterns from recorded work orders \u2014 not proof of fault. Do NOT invent root causes, parts, or costs the engine does not list; say "not documented" instead.');
    return lines.join('\n');
  } catch (e) {
    logger.warn('brainContext failed: ' + e.message);
    return '';
  }
}

module.exports = { brainContext };
