'use strict';
/**
 * tracker.js — Workflow Progress Tracker (Sprint 2, Module 5)
 *
 * Maps each unavailable unit to a repair workflow stage based on relay status
 * + lifecycle reason. Tracks time-in-stage and detects "stuck" units.
 *
 * Stages (linear progression):
 *   DETECTED → ASSIGNED → DIAGNOSED → QUOTED → APPROVED → PARTS → REPAIR → QC → PICKUP → ACTIVE
 *
 * Outputs per unit:
 *   - currentStage (string)
 *   - stageEnteredAt (ISO timestamp)
 *   - timeInStage (hours)
 *   - expectedDuration (hours, per stage average)
 *   - isStuck (boolean: exceeds expected duration)
 *   - progress (0-100%: where in the overall workflow)
 *   - stageHistory (array of past stages with timestamps)
 *
 * Persists stage data to tracker_state.json for cross-session continuity.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('tracker');
const { P }  = require('../config/paths');

// ── Stages ───────────────────────────────────────────────────────────────────
const STAGES = [
  'detected',
  'assigned',
  'diagnosed',
  'quoted',
  'approved',
  'parts',
  'repair',
  'qc',
  'pickup',
  'active',
];

const STAGE_INDEX = {};
STAGES.forEach((s, i) => { STAGE_INDEX[s] = i; });

// ── Expected durations per stage (hours) — based on typical fleet ops ────────
const EXPECTED_HOURS = {
  detected:   12,
  assigned:   24,
  diagnosed:  48,
  quoted:     24,
  approved:   12,
  parts:      72,
  repair:     96,
  qc:         12,
  pickup:     24,
  active:     Infinity,
};

// ── Stage labels for UI ──────────────────────────────────────────────────────
const STAGE_LABELS = {
  detected:   'Detected',
  assigned:   'Assigned',
  diagnosed:  'Diagnosed',
  quoted:     'Quoted',
  approved:   'Approved',
  parts:      'Parts',
  repair:     'Repair',
  qc:         'QC',
  pickup:     'Pickup',
  active:     'Active',
};

// ── Relay reason → stage mapping ─────────────────────────────────────────────
function _mapReasonToStage(reason, hasVendor) {
  const r = (reason || '').toLowerCase();

  if (r.includes('available') && !r.includes('un')) return 'active';
  if (r.includes('pickup') || r.includes('ready for pickup') || r.includes('completed')) return 'pickup';
  if (r.includes('quality') || r.includes('qc') || r.includes('inspection') || r.includes('road test')) return 'qc';
  if (r.includes('in progress') || r.includes('repair') || r.includes('in bay') || r.includes('in shop')) return 'repair';
  if (r.includes('parts') || r.includes('backorder') || r.includes('awaiting part')) return 'parts';
  if (r.includes('approved') || r.includes('authorization')) return 'approved';
  if (r.includes('estimate') || r.includes('quoted') || r.includes('quote')) return 'quoted';
  if (r.includes('diagnos') || r.includes('diag') || r.includes('inspection') || r.includes('evaluation')) return 'diagnosed';
  if (r.includes('pending') || r.includes('scheduled') || r.includes('waiting')) {
    return hasVendor ? 'assigned' : 'detected';
  }
  if (r.includes('offsite') || r.includes('shop')) return hasVendor ? 'assigned' : 'detected';

  // Default: if has vendor, at least assigned
  return hasVendor ? 'assigned' : 'detected';
}

// ── Persistence ──────────────────────────────────────────────────────────────
const STATE_FILE = path.join(P.dataDir, 'tracker_state.json');

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { logger.warn('Load error:', e.message); }
  return {};
}

function _saveState(data) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { logger.warn('Save error:', e.message); }
}

// ── Core tracking logic ──────────────────────────────────────────────────────

/**
 * runTracker(mergedRows)
 * @returns {{ tracked: Array, stuck: Array, summary: Object }}
 */
function runTracker(mergedRows) {
  const state = _loadState();
  const now = Date.now();
  const nowISO = new Date().toISOString();
  const tracked = [];
  const stuck = [];

  for (const row of mergedRows) {
    const id = row.equipmentId;
    if (!id) continue;

    const isUnavail = (row.lifecycleState || '').toLowerCase().includes('unavail');
    const hasVendor = !!(row.vendor && row.vendor !== '--' && row.vendor.toLowerCase() !== 'unassigned');
    const reason = row.lifecycleReason || '';

    // Determine current stage
    let currentStage;
    if (!isUnavail) {
      currentStage = 'active';
    } else {
      currentStage = _mapReasonToStage(reason, hasVendor);
    }

    // Get or create unit tracking state
    let unitState = state[id];
    if (!unitState) {
      unitState = {
        equipmentId: id,
        currentStage,
        stageEnteredAt: nowISO,
        history: [{ stage: currentStage, enteredAt: nowISO }],
      };
      state[id] = unitState;
    }

    // Detect stage transition
    if (unitState.currentStage !== currentStage) {
      // Only advance forward (don't regress unless going to 'active')
      const prevIdx = STAGE_INDEX[unitState.currentStage] || 0;
      const currIdx = STAGE_INDEX[currentStage] || 0;

      if (currIdx > prevIdx || currentStage === 'active') {
        unitState.history.push({ stage: currentStage, enteredAt: nowISO });
        unitState.currentStage = currentStage;
        unitState.stageEnteredAt = nowISO;

        // Keep history manageable (max 20 entries per unit)
        if (unitState.history.length > 20) unitState.history = unitState.history.slice(-20);
      }
    }

    // Calculate time in current stage
    const stageEnteredMs = new Date(unitState.stageEnteredAt).getTime();
    const timeInStageHours = (now - stageEnteredMs) / 3600000;
    const expectedHours = EXPECTED_HOURS[currentStage] || 48;
    const isStuckFlag = isUnavail && timeInStageHours > expectedHours;

    // Progress: 0-100% through the workflow
    const stageIdx = STAGE_INDEX[currentStage] || 0;
    const totalStages = STAGES.length - 1; // 'active' = 100%
    const progress = Math.round((stageIdx / totalStages) * 100);

    const entry = {
      equipmentId: id,
      currentStage,
      stageLabel: STAGE_LABELS[currentStage] || currentStage,
      stageEnteredAt: unitState.stageEnteredAt,
      timeInStageHours: Math.round(timeInStageHours * 10) / 10,
      expectedHours,
      isStuck: isStuckFlag,
      progress,
      vendor: row.vendor || '',
      operator: row.operator || '',
      domicile: row.domicileSite || '',
      historyCount: unitState.history.length,
    };

    tracked.push(entry);
    if (isStuckFlag) stuck.push(entry);
  }

  // Save updated state
  _saveState(state);

  // Summary
  const stageCounts = {};
  STAGES.forEach(s => { stageCounts[s] = 0; });
  tracked.forEach(t => { stageCounts[t.currentStage] = (stageCounts[t.currentStage] || 0) + 1; });

  const summary = {
    total: tracked.length,
    stuck: stuck.length,
    stageCounts,
    avgProgress: tracked.length > 0
      ? Math.round(tracked.reduce((sum, t) => sum + t.progress, 0) / tracked.length)
      : 0,
  };

  logger.info(
    `Tracker: ${tracked.length} units | ${stuck.length} stuck | ` +
    `stages: detected=${stageCounts.detected} assigned=${stageCounts.assigned} ` +
    `repair=${stageCounts.repair} parts=${stageCounts.parts} active=${stageCounts.active}`
  );

  return { tracked, stuck, summary };
}

/**
 * getUnitHistory(equipmentId) — returns the full stage history for a unit
 */
function getUnitHistory(equipmentId) {
  const state = _loadState();
  const unit = state[equipmentId];
  if (!unit) return null;
  return {
    equipmentId,
    currentStage: unit.currentStage,
    stageEnteredAt: unit.stageEnteredAt,
    history: unit.history || [],
  };
}

module.exports = { runTracker, getUnitHistory, STAGES, STAGE_LABELS, STAGE_INDEX };
