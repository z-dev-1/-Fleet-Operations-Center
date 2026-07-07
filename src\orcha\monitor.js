'use strict';
/**
 * monitor.js — Orcha Unit Monitor (Sprint 1, Module 1)
 *
 * Runs after every sync completion. Scores each unit on:
 *   - Data completeness (0-100): does the unit have all required fields?
 *   - Staleness (0-100): how fresh is the data?
 *   - Intelligence health (composite: completeness + staleness + AI coverage)
 *
 * Outputs:
 *   - Per-unit health scores pushed to renderer via ctx.send('orcha:monitor', results)
 *   - Aggregated fleet intelligence summary
 *   - List of units with critical data gaps
 *
 * Does NOT modify any data. Purely observational.
 */

const logger = require('../utils/logger')('monitor');
const store  = require('../store');

// ── Weights for completeness scoring ─────────────────────────────────────────
const COMPLETENESS_FIELDS = {
  // Field key on merged row → weight (0-10)
  equipmentId:      { weight: 10, required: true },
  lifecycleState:   { weight: 10, required: true },
  lifecycleReason:  { weight: 8,  required: false },
  operator:         { weight: 8,  required: true },
  domicileSite:     { weight: 7,  required: true },
  vendor:           { weight: 9,  required: false },  // critical for unavailable
  workDuration:     { weight: 7,  required: false },
  riskScore:        { weight: 6,  required: false },
  fuelType:         { weight: 3,  required: false },
  bodyType:         { weight: 3,  required: false },
  manufacturer:     { weight: 3,  required: false },
  dueDate:          { weight: 5,  required: false },
  geofence:         { weight: 4,  required: false },
  openUnplanned:    { weight: 4,  required: false },
};

// ── Staleness thresholds (hours) ─────────────────────────────────────────────
const STALENESS = {
  NOTES_STALE_HOURS:      168,   // 7 days
  RELAY_STALE_HOURS:      24,
  AI_ANALYSIS_STALE_HOURS: 72,   // 3 days
  UPTAKE_STALE_HOURS:     48,
};

// ── Score a single unit ──────────────────────────────────────────────────────
function scoreUnit(row, notesStore, relayCache) {
  const id = row.equipmentId;
  const isUnavail = (row.lifecycleState || '').toLowerCase().includes('unavail');
  const notes = notesStore[id] || {};
  const relay = relayCache[id] || null;
  const now = Date.now();

  // ─── Completeness ───
  let totalWeight = 0;
  let earnedWeight = 0;
  const gaps = [];

  for (const [field, cfg] of Object.entries(COMPLETENESS_FIELDS)) {
    // Vendor/duration only matter for unavailable units
    if ((field === 'vendor' || field === 'workDuration') && !isUnavail) continue;

    totalWeight += cfg.weight;
    const val = row[field];
    const hasValue = val !== undefined && val !== null && val !== '' && val !== '--' && val !== '0';

    if (hasValue) {
      earnedWeight += cfg.weight;
    } else if (cfg.required || (isUnavail && cfg.weight >= 7)) {
      gaps.push(field);
    }
  }

  // Bonus: has AI notes?
  if (isUnavail) {
    totalWeight += 8;
    if (notes.notes && notes.notes.length > 10) earnedWeight += 8;
    else gaps.push('aiNotes');
  }

  // Bonus: has relay detail?
  if (isUnavail) {
    totalWeight += 7;
    if (relay && relay.vendor) earnedWeight += 7;
    else gaps.push('relayDetail');
  }

  const completeness = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  // ─── Staleness ───
  let stalenessScore = 100; // 100 = perfectly fresh, 0 = totally stale
  const staleReasons = [];

  if (isUnavail) {
    // Notes staleness
    const notesUpdated = notes._lastAiCorrection || notes.updatedAt;
    if (notesUpdated) {
      const hoursOld = (now - new Date(notesUpdated).getTime()) / 3600000;
      if (hoursOld > STALENESS.NOTES_STALE_HOURS) {
        stalenessScore -= 25;
        staleReasons.push('notes>' + Math.round(hoursOld / 24) + 'd');
      }
    } else if (!notes.notes) {
      stalenessScore -= 30;
      staleReasons.push('no-notes');
    }

    // AI analysis staleness
    if (row._orchaProcessedAt) {
      const hoursOld = (now - new Date(row._orchaProcessedAt).getTime()) / 3600000;
      if (hoursOld > STALENESS.AI_ANALYSIS_STALE_HOURS) {
        stalenessScore -= 20;
        staleReasons.push('ai>' + Math.round(hoursOld / 24) + 'd');
      }
    } else {
      stalenessScore -= 25;
      staleReasons.push('no-ai-scan');
    }

    // Relay staleness (check if relay data exists and is recent)
    if (!relay || !relay.vendor) {
      stalenessScore -= 25;
      staleReasons.push('no-relay');
    }
  }

  stalenessScore = Math.max(0, stalenessScore);

  // ─── Composite health ───
  // Unavailable units: weighted 60% completeness + 40% freshness
  // Available units: 80% completeness + 20% freshness (less urgent)
  const healthScore = isUnavail
    ? Math.round(completeness * 0.6 + stalenessScore * 0.4)
    : Math.round(completeness * 0.8 + stalenessScore * 0.2);

  // ─── Tier ───
  const tier = healthScore >= 80 ? 'good'
             : healthScore >= 50 ? 'fair'
             : 'poor';

  return {
    equipmentId: id,
    completeness,
    staleness: stalenessScore,
    health: healthScore,
    tier,
    gaps,
    staleReasons,
    isUnavail,
  };
}

// ── Run monitor on all units ─────────────────────────────────────────────────
function runMonitor(mergedRows, opts = {}) {
  const notesStore = store.load('notesStore', {});
  const relayCache = store.load('relayCache', {});

  const results = [];
  const summary = { total: 0, unavail: 0, good: 0, fair: 0, poor: 0, criticalGaps: [] };

  for (const row of mergedRows) {
    if (!row.equipmentId) continue;
    const score = scoreUnit(row, notesStore, relayCache);
    results.push(score);

    summary.total++;
    if (score.isUnavail) summary.unavail++;
    summary[score.tier]++;

    // Critical: unavailable unit with health < 40
    if (score.isUnavail && score.health < 40) {
      summary.criticalGaps.push({
        equipmentId: score.equipmentId,
        health: score.health,
        gaps: score.gaps,
      });
    }
  }

  // Sort critical gaps by health (worst first)
  summary.criticalGaps.sort((a, b) => a.health - b.health);

  logger.info(
    `Monitor: ${summary.total} units | ` +
    `good=${summary.good} fair=${summary.fair} poor=${summary.poor} | ` +
    `${summary.criticalGaps.length} critical gaps`
  );

  return { results, summary };
}

module.exports = { runMonitor, scoreUnit };
