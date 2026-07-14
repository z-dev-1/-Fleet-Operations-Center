'use strict';
/**
 * patterns.js — Pattern Learning & Prediction (Sprint 3, Module 6)
 *
 * Learns from historical data to predict outcomes:
 *   - Vendor performance: avg repair time per vendor per component
 *   - Stage durations: how long units typically spend in each stage
 *   - Seasonal trends: are certain periods busier?
 *   - Recommendation outcomes: which suggestions get accepted?
 *
 * Builds up over time — the longer it runs, the smarter it gets.
 * Persists learned patterns to patterns_state.json.
 *
 * Does NOT make decisions. Provides data to recommend.js and deep-scan.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('patterns');
const { P }  = require('../config/paths');
const store  = require('../store');

// ── State file ───────────────────────────────────────────────────────────────
const STATE_FILE = path.join(P.dataDir, 'patterns_state.json');

function _loadPatterns() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return {
    vendorPerf: {},        // { vendorName: { totalUnits, totalDays, avgDays, components: {} } }
    stageDurations: {},    // { stageName: { samples, totalHours, avgHours } }
    weekdayLoad: {},       // { 0-6: { unavailCount, totalUnits } }  (0=Sun)
    monthlyLoad: {},       // { 0-11: { unavailCount, totalUnits } }
    recOutcomes: {},       // { actionType: { suggested, accepted, dismissed } }
    lastUpdated: null,
  };
}

function _savePatterns(data) {
  try {
    data.lastUpdated = new Date().toISOString();
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_) {}
}

// ── Duration parser ──────────────────────────────────────────────────────────
function _parseDays(dur) {
  if (!dur || dur === '--') return null;
  const s = String(dur).toLowerCase().trim();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) { const n = parseFloat(s); if (!isNaN(n)) days = n; }
  return days || null;
}

// ── Core learning functions ──────────────────────────────────────────────────

function _learnVendorPerformance(mergedRows, patterns) {
  const unavail = mergedRows.filter(r =>
    (r.lifecycleState || '').toLowerCase().includes('unavail')
  );

  for (const row of unavail) {
    const vendor = (row.vendor || '').trim();
    if (!vendor || vendor === '--' || vendor.toLowerCase() === 'unassigned') continue;

    const dur = _parseDays(row.workDuration || row.duration);
    if (dur === null || dur <= 0) continue;

    if (!patterns.vendorPerf[vendor]) {
      patterns.vendorPerf[vendor] = { totalUnits: 0, totalDays: 0, avgDays: 0, components: {} };
    }

    const vp = patterns.vendorPerf[vendor];
    vp.totalUnits++;
    vp.totalDays += dur;
    vp.avgDays = Math.round((vp.totalDays / vp.totalUnits) * 10) / 10;

    // Track by component if available
    const comp = row.savedPrimaryComponent || '';
    if (comp) {
      if (!vp.components[comp]) vp.components[comp] = { count: 0, totalDays: 0, avgDays: 0 };
      vp.components[comp].count++;
      vp.components[comp].totalDays += dur;
      vp.components[comp].avgDays = Math.round((vp.components[comp].totalDays / vp.components[comp].count) * 10) / 10;
    }
  }
}

function _learnStageDurations(trackerState, patterns) {
  // Read tracker state for stage history data
  try {
    const trackerPath = path.join(P.dataDir, 'tracker_state.json');
    if (!fs.existsSync(trackerPath)) return;
    const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));

    for (const [id, unit] of Object.entries(tracker)) {
      if (!unit.history || unit.history.length < 2) continue;

      for (let i = 1; i < unit.history.length; i++) {
        const prevStage = unit.history[i - 1].stage;
        const entered = new Date(unit.history[i - 1].enteredAt).getTime();
        const exited  = new Date(unit.history[i].enteredAt).getTime();
        const hours = (exited - entered) / 3600000;

        if (hours <= 0 || hours > 720) continue;  // skip invalid (> 30 days in one stage)

        if (!patterns.stageDurations[prevStage]) {
          patterns.stageDurations[prevStage] = { samples: 0, totalHours: 0, avgHours: 0 };
        }
        const sd = patterns.stageDurations[prevStage];
        sd.samples++;
        sd.totalHours += hours;
        sd.avgHours = Math.round((sd.totalHours / sd.samples) * 10) / 10;
      }
    }
  } catch (_) {}
}

function _learnLoadPatterns(mergedRows, patterns) {
  const now = new Date();
  const day = now.getDay();     // 0-6
  const month = now.getMonth(); // 0-11

  const unavailCount = mergedRows.filter(r =>
    (r.lifecycleState || '').toLowerCase().includes('unavail')
  ).length;
  const total = mergedRows.length;

  // Weekday pattern
  if (!patterns.weekdayLoad[day]) patterns.weekdayLoad[day] = { samples: 0, totalUnavail: 0, totalUnits: 0 };
  patterns.weekdayLoad[day].samples++;
  patterns.weekdayLoad[day].totalUnavail += unavailCount;
  patterns.weekdayLoad[day].totalUnits += total;

  // Monthly pattern
  if (!patterns.monthlyLoad[month]) patterns.monthlyLoad[month] = { samples: 0, totalUnavail: 0, totalUnits: 0 };
  patterns.monthlyLoad[month].samples++;
  patterns.monthlyLoad[month].totalUnavail += unavailCount;
  patterns.monthlyLoad[month].totalUnits += total;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * runPatternLearning(mergedRows)
 * @returns {{ vendorStats: Array, stageStats: Object, insights: Array }}
 */
function runPatternLearning(mergedRows) {
  const patterns = _loadPatterns();

  _learnVendorPerformance(mergedRows, patterns);
  _learnStageDurations(null, patterns);
  _learnLoadPatterns(mergedRows, patterns);

  _savePatterns(patterns);

  // Build vendor stats summary (top 10 vendors by volume)
  const vendorStats = Object.entries(patterns.vendorPerf)
    .map(([name, data]) => ({
      vendor: name,
      avgDays: data.avgDays,
      totalUnits: data.totalUnits,
      components: Object.keys(data.components).length,
    }))
    .sort((a, b) => b.totalUnits - a.totalUnits)
    .slice(0, 10);

  // Build insights from patterns
  const insights = [];

  // Insight: slowest vendor
  if (vendorStats.length >= 2) {
    const slowest = vendorStats.reduce((a, b) => a.avgDays > b.avgDays ? a : b);
    const fastest = vendorStats.reduce((a, b) => a.avgDays < b.avgDays ? a : b);
    if (slowest.avgDays > fastest.avgDays * 2) {
      insights.push({
        type: 'vendor_slow',
        message: `${slowest.vendor} averages ${slowest.avgDays}d vs ${fastest.vendor} at ${fastest.avgDays}d`,
        severity: 'info',
      });
    }
  }

  // Insight: stage bottleneck
  const stageStats = patterns.stageDurations;
  const bottleneck = Object.entries(stageStats)
    .filter(([s]) => s !== 'active')
    .sort((a, b) => b[1].avgHours - a[1].avgHours)[0];
  if (bottleneck && bottleneck[1].avgHours > 48) {
    insights.push({
      type: 'stage_bottleneck',
      message: `"${bottleneck[0]}" stage averages ${Math.round(bottleneck[1].avgHours)}h — longest stage`,
      severity: 'info',
    });
  }

  // Insight: today's expected load
  const today = new Date().getDay();
  const todayData = patterns.weekdayLoad[today];
  if (todayData && todayData.samples >= 3) {
    const avgUnavail = Math.round(todayData.totalUnavail / todayData.samples);
    insights.push({
      type: 'load_forecast',
      message: `Typical ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today]} unavail: ${avgUnavail} units (based on ${todayData.samples} samples)`,
      severity: 'info',
    });
  }

  const sampleCount = Object.values(patterns.vendorPerf).reduce((sum, v) => sum + v.totalUnits, 0);
  logger.info(`Patterns: ${sampleCount} vendor samples | ${Object.keys(stageStats).length} stages learned | ${insights.length} insights`);

  return { vendorStats, stageStats, insights, patterns };
}

/**
 * getVendorPrediction(vendor, component) — predict repair duration
 */
function getVendorPrediction(vendor, component) {
  const patterns = _loadPatterns();
  const vp = patterns.vendorPerf[vendor];
  if (!vp) return null;

  if (component && vp.components[component]) {
    return { avgDays: vp.components[component].avgDays, samples: vp.components[component].count, source: 'component' };
  }
  return { avgDays: vp.avgDays, samples: vp.totalUnits, source: 'vendor_overall' };
}

module.exports = { runPatternLearning, getVendorPrediction };
