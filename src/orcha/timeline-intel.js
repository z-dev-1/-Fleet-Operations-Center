'use strict';
/**
 * timeline-intel.js — Timeline Intelligence Engine
 *
 * Analyzes ALL fleet timelines to surface:
 *   - Avg repair time per vendor (vendor speed scorecard)
 *   - Repeat failures (units that keep coming back unavailable)
 *   - Common failure patterns (which components fail most, by make)
 *   - Vendor comparison (who's fastest, who's slowest)
 *
 * Runs on demand via IPC (orcha:timeline-intel) and returns structured data
 * the dashboard or a dedicated "Intelligence" tab can render.
 */

const store  = require('../store');
const logger = require('../utils/logger')('timeline-intel');

/**
 * analyzeFleet() — Run full timeline intelligence analysis
 * @returns {object} { vendorSpeed, repeatFailures, componentPatterns, siteBreakdown, summary }
 */
function analyzeFleet() {
  const fd = store.load('fleetData', {});
  const rows = fd.rows || [];
  const notesStore = store.load('notesStore', {});
  const repairHist = store.load('repairHistory', { transitions: [] });

  const result = {
    vendorSpeed: _analyzeVendorSpeed(rows),
    repeatFailures: _findRepeatFailures(rows, repairHist),
    componentPatterns: _analyzeComponents(rows, notesStore),
    siteBreakdown: _analyzeSites(rows),
    makeReliability: _analyzeMakes(rows),
    summary: null,
  };

  // Build text summary
  result.summary = _buildSummary(result);
  logger.info('[Timeline Intel] Analysis complete: ' + result.vendorSpeed.length + ' vendors, ' + result.repeatFailures.length + ' repeat failures');
  return result;
}

// ── Vendor Speed Analysis ─────────────────────────────────────────────────────
function _analyzeVendorSpeed(rows) {
  const vendorStats = {};
  const unavail = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));

  unavail.forEach(r => {
    const vendor = r.vendor || 'Unassigned';
    if (!vendorStats[vendor]) vendorStats[vendor] = { count: 0, totalDays: 0, units: [] };
    const days = _parseDays(r.workDuration || r.duration);
    vendorStats[vendor].count++;
    vendorStats[vendor].totalDays += days;
    vendorStats[vendor].units.push({ id: r.equipmentId, days });
  });

  return Object.entries(vendorStats)
    .map(([vendor, stats]) => ({
      vendor,
      activeCount: stats.count,
      avgDays: stats.count ? Math.round((stats.totalDays / stats.count) * 10) / 10 : 0,
      totalDays: Math.round(stats.totalDays),
      longestUnit: stats.units.sort((a, b) => b.days - a.days)[0] || null,
    }))
    .sort((a, b) => b.avgDays - a.avgDays); // slowest first
}

// ── Repeat Failures ───────────────────────────────────────────────────────────
function _findRepeatFailures(rows, repairHist) {
  // Count how many times each unit has transitioned to unavailable
  const transitions = repairHist.transitions || [];
  const unitCounts = {};

  transitions.forEach(t => {
    if (t.to === 'unavailable' || t.toState === 'Unavailable') {
      const id = t.unitId || t.equipmentId;
      if (id) unitCounts[id] = (unitCounts[id] || 0) + 1;
    }
  });

  // Also check current unavail units that have been seen before
  const unavail = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
  unavail.forEach(r => {
    if (!unitCounts[r.equipmentId]) unitCounts[r.equipmentId] = 1;
  });

  // Filter to units with 2+ incidents
  return Object.entries(unitCounts)
    .filter(([_, count]) => count >= 2)
    .map(([unitId, count]) => {
      const row = rows.find(r => r.equipmentId === unitId);
      return {
        unitId,
        incidentCount: count,
        currentStatus: row ? (row.lifecycleState || 'Unknown') : 'Not in fleet',
        vendor: row ? (row.vendor || '') : '',
        make: row ? (row.manufacturer || '') : '',
      };
    })
    .sort((a, b) => b.incidentCount - a.incidentCount)
    .slice(0, 20);
}

// ── Component Patterns ────────────────────────────────────────────────────────
function _analyzeComponents(rows, notesStore) {
  const compCounts = {};

  rows.forEach(r => {
    const ns = notesStore[r.equipmentId] || {};
    const comp = ns.primaryComponent || r.savedPrimaryComponent;
    if (comp && comp !== '--') {
      if (!compCounts[comp]) compCounts[comp] = { count: 0, makes: {}, vendors: {} };
      compCounts[comp].count++;
      const make = r.manufacturer || r.make || 'Unknown';
      compCounts[comp].makes[make] = (compCounts[comp].makes[make] || 0) + 1;
      if (r.vendor) compCounts[comp].vendors[r.vendor] = (compCounts[comp].vendors[r.vendor] || 0) + 1;
    }
  });

  return Object.entries(compCounts)
    .map(([component, data]) => ({
      component,
      count: data.count,
      topMake: Object.entries(data.makes).sort((a, b) => b[1] - a[1])[0],
      topVendor: Object.entries(data.vendors).sort((a, b) => b[1] - a[1])[0],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ── Site Breakdown ────────────────────────────────────────────────────────────
function _analyzeSites(rows) {
  const sites = {};
  rows.forEach(r => {
    const site = r.domicileSite || r.operator || 'Unknown';
    if (!sites[site]) sites[site] = { total: 0, unavail: 0, highRisk: 0 };
    sites[site].total++;
    if ((r.lifecycleState || '').toLowerCase().includes('unavail')) sites[site].unavail++;
    if ((r.riskScore || 0) >= 70) sites[site].highRisk++;
  });

  return Object.entries(sites)
    .map(([site, data]) => ({
      site,
      total: data.total,
      unavail: data.unavail,
      unavailPct: data.total ? Math.round((data.unavail / data.total) * 100) : 0,
      highRisk: data.highRisk,
    }))
    .sort((a, b) => b.unavailPct - a.unavailPct);
}

// ── Make Reliability ──────────────────────────────────────────────────────────
function _analyzeMakes(rows) {
  const makes = {};
  rows.forEach(r => {
    const make = r.manufacturer || r.make || 'Unknown';
    if (!makes[make]) makes[make] = { total: 0, unavail: 0, avgDays: 0, totalDays: 0 };
    makes[make].total++;
    if ((r.lifecycleState || '').toLowerCase().includes('unavail')) {
      makes[make].unavail++;
      makes[make].totalDays += _parseDays(r.workDuration || r.duration);
    }
  });

  return Object.entries(makes)
    .filter(([_, d]) => d.total >= 3) // only makes with 3+ units
    .map(([make, data]) => ({
      make,
      total: data.total,
      unavail: data.unavail,
      unavailPct: data.total ? Math.round((data.unavail / data.total) * 100) : 0,
      avgDaysDown: data.unavail ? Math.round((data.totalDays / data.unavail) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.unavailPct - a.unavailPct);
}

// ── Summary Builder ───────────────────────────────────────────────────────────
function _buildSummary(data) {
  const lines = [];

  if (data.vendorSpeed.length) {
    const slowest = data.vendorSpeed[0];
    const fastest = data.vendorSpeed[data.vendorSpeed.length - 1];
    lines.push(`Vendor speed: ${slowest.vendor} is slowest (avg ${slowest.avgDays}d), ${fastest.vendor} is fastest (avg ${fastest.avgDays}d).`);
  }

  if (data.repeatFailures.length) {
    const top = data.repeatFailures[0];
    lines.push(`Repeat failures: ${top.unitId} has had ${top.incidentCount} incidents (${top.make || 'unknown make'}).`);
  }

  if (data.componentPatterns.length) {
    const top = data.componentPatterns[0];
    lines.push(`Most common failure: ${top.component} (${top.count} units${top.topMake ? ', mostly ' + top.topMake[0] : ''}).`);
  }

  if (data.makeReliability.length) {
    const worst = data.makeReliability[0];
    lines.push(`Least reliable make: ${worst.make} (${worst.unavailPct}% unavailable, avg ${worst.avgDaysDown}d when down).`);
  }

  return lines.join(' ');
}

// ── Helper ────────────────────────────────────────────────────────────────────
function _parseDays(duration) {
  if (!duration) return 0;
  const s = String(duration).toLowerCase();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) { const n = parseFloat(s); if (n > 0) days = n; }
  return Math.round(days * 10) / 10;
}

module.exports = { analyzeFleet };
