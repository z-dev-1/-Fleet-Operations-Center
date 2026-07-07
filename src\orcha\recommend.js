'use strict';
/**
 * recommend.js — Orcha Action Recommendation Engine (Sprint 1, Module 3)
 *
 * Takes monitor scores + anomaly alerts + fleet data and produces specific,
 * actionable recommendations for each unit needing attention.
 *
 * Each recommendation has:
 *   - action type (what to do)
 *   - confidence (0-100, how sure)
 *   - reason (why this is recommended)
 *   - one-click payload (pre-built data for orchestrator execution)
 *
 * Action types:
 *   ASSIGN_VENDOR   — unit needs a vendor assigned
 *   ESCALATE        — vendor not responding, escalate
 *   CREATE_WR       — predictive risk high, create preventive WR
 *   FOLLOW_UP       — unit stuck, follow up with vendor
 *   UPDATE_NOTES    — no AI notes, run deep scan
 *   CLOSE_OUT       — unit returned to available, close RCA
 *   SCHEDULE_PM     — PM overdue, schedule maintenance
 *
 * Does NOT execute. Only recommends. Execution requires user approval.
 */

const logger = require('../utils/logger')('recommend');
const store  = require('../store');

// ── Action Types ─────────────────────────────────────────────────────────────
const ACTION = {
  ASSIGN_VENDOR: 'assign_vendor',
  ESCALATE:      'escalate',
  CREATE_WR:     'create_wr',
  FOLLOW_UP:     'follow_up',
  UPDATE_NOTES:  'update_notes',
  CLOSE_OUT:     'close_out',
  SCHEDULE_PM:   'schedule_pm',
};

// ── Action metadata (labels, icons, urgency) ─────────────────────────────────
const ACTION_META = {
  [ACTION.ASSIGN_VENDOR]: { label: 'Assign Vendor',    icon: '🏪', urgency: 'high' },
  [ACTION.ESCALATE]:      { label: 'Escalate',         icon: '🚨', urgency: 'high' },
  [ACTION.CREATE_WR]:     { label: 'Create WR',        icon: '📋', urgency: 'medium' },
  [ACTION.FOLLOW_UP]:     { label: 'Follow Up',        icon: '📞', urgency: 'medium' },
  [ACTION.UPDATE_NOTES]:  { label: 'Update Notes',     icon: '📝', urgency: 'low' },
  [ACTION.CLOSE_OUT]:     { label: 'Close Out',        icon: '✅', urgency: 'low' },
  [ACTION.SCHEDULE_PM]:   { label: 'Schedule PM',      icon: '🔧', urgency: 'medium' },
};

// ── Thresholds ───────────────────────────────────────────────────────────────
const T = {
  ESCALATE_DAYS:      7,    // escalate if stuck > 7 days
  FOLLOW_UP_DAYS:     3,    // follow up if pending > 3 days
  HIGH_RISK:          70,   // create preventive WR above this score
  NO_NOTES_DAYS:      1,    // suggest notes update after 1 day unavailable
};

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

// ── Core recommendation logic ────────────────────────────────────────────────

function _recommendForUnit(row, notesStore, vendorRules) {
  const recs = [];
  const isUnavail = (row.lifecycleState || '').toLowerCase().includes('unavail');
  const dur = _parseDays(row.workDuration || row.duration);
  const vendor = (row.vendor || '').trim();
  const hasVendor = vendor && vendor !== '--' && vendor.toLowerCase() !== 'unassigned';
  const risk = parseInt(row.riskScore, 10) || 0;
  const notes = notesStore[row.equipmentId] || {};
  const hasNotes = !!(notes.notes && notes.notes.length > 20);
  const reason = (row.lifecycleReason || '').toLowerCase();
  const openWR = parseInt(row.openUnplanned, 10) || 0;

  // ─── ASSIGN VENDOR ───
  if (isUnavail && !hasVendor && dur !== null && dur >= 1) {
    // Try to suggest which vendor based on learned rules
    let suggestedVendor = null;
    let confidence = 70;
    try {
      const { suggestVendor } = require('./learn');
      const suggestion = suggestVendor(row);
      if (suggestion && suggestion.vendor) {
        suggestedVendor = suggestion.vendor;
        confidence = Math.min(95, 60 + (suggestion.confidence || 0) / 3);
      }
    } catch (_) {}

    recs.push({
      action: ACTION.ASSIGN_VENDOR,
      confidence,
      reason: `Unavailable ${Math.round(dur)}d with no vendor — needs assignment`,
      suggestion: suggestedVendor ? `Orcha suggests: ${suggestedVendor}` : 'Open Dealer WO panel to assign',
      payload: { unitId: row.equipmentId, suggestedVendor },
    });
  }

  // ─── ESCALATE ───
  if (isUnavail && hasVendor && dur !== null && dur >= T.ESCALATE_DAYS) {
    const isPending = reason.includes('pending') || reason.includes('waiting') || reason.includes('scheduled');
    if (isPending) {
      recs.push({
        action: ACTION.ESCALATE,
        confidence: 80,
        reason: `At ${vendor} for ${Math.round(dur)}d, still "${row.lifecycleReason}" — escalation recommended`,
        suggestion: `Contact ${vendor} management or reassign to alternative vendor`,
        payload: { unitId: row.equipmentId, vendor, duration: dur },
      });
    }
  }

  // ─── FOLLOW UP ───
  if (isUnavail && hasVendor && dur !== null && dur >= T.FOLLOW_UP_DAYS && dur < T.ESCALATE_DAYS) {
    const isPending = reason.includes('pending') || reason.includes('waiting') || reason.includes('estimate');
    if (isPending) {
      recs.push({
        action: ACTION.FOLLOW_UP,
        confidence: 75,
        reason: `At ${vendor} for ${Math.round(dur)}d in "${row.lifecycleReason}" — follow-up due`,
        suggestion: `Call/message ${vendor} for status update and ETA`,
        payload: { unitId: row.equipmentId, vendor, duration: dur },
      });
    }
  }

  // ─── CREATE PREVENTIVE WR ───
  if (!isUnavail && risk >= T.HIGH_RISK && openWR === 0) {
    recs.push({
      action: ACTION.CREATE_WR,
      confidence: 65,
      reason: `Risk score ${risk}% — predictive failure likely without intervention`,
      suggestion: 'Create preventive Work Request before component fails',
      payload: { unitId: row.equipmentId, riskScore: risk },
    });
  }

  // ─── UPDATE NOTES ───
  if (isUnavail && !hasNotes && dur !== null && dur >= T.NO_NOTES_DAYS) {
    recs.push({
      action: ACTION.UPDATE_NOTES,
      confidence: 85,
      reason: `Unavailable ${Math.round(dur)}d with no documented repair status`,
      suggestion: 'Run Orcha Deep Scan or add manual notes',
      payload: { unitId: row.equipmentId },
    });
  }

  // ─── SCHEDULE PM ───
  if (!isUnavail) {
    const dueDate = (row.dueDate || '').toLowerCase();
    if (dueDate.includes('overdue') || dueDate.includes('past due')) {
      recs.push({
        action: ACTION.SCHEDULE_PM,
        confidence: 90,
        reason: 'PM service overdue — maintenance compliance at risk',
        suggestion: 'Schedule PM appointment or create planned WR',
        payload: { unitId: row.equipmentId, dueDate: row.dueDate },
      });
    }
  }

  // ─── CLOSE OUT ───
  // Detect: unit returned to available but still has open status in notes
  if (!isUnavail && hasNotes) {
    const noteText = (notes.notes || '').toLowerCase();
    const stillTracking = noteText.includes('pending') || noteText.includes('waiting') ||
                          noteText.includes('in progress') || noteText.includes('at vendor');
    if (stillTracking) {
      recs.push({
        action: ACTION.CLOSE_OUT,
        confidence: 60,
        reason: 'Unit now Available but notes still reference active repair',
        suggestion: 'Update notes to reflect completion, close RCA if open',
        payload: { unitId: row.equipmentId },
      });
    }
  }

  return recs;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * runRecommendations(mergedRows)
 * @returns {{ recommendations: Array, summary: { total, byAction, byUrgency } }}
 */
function runRecommendations(mergedRows) {
  const notesStore = store.load('notesStore', {});
  let vendorRules = {};
  try { vendorRules = store.load('orchaVendorRules', {}); } catch (_) {}

  const recommendations = [];

  for (const row of mergedRows) {
    if (!row.equipmentId) continue;
    const recs = _recommendForUnit(row, notesStore, vendorRules);
    for (const rec of recs) {
      recommendations.push({
        ...rec,
        unit: row.equipmentId,
        operator: row.operator || '',
        domicile: row.domicileSite || '',
        meta: ACTION_META[rec.action] || {},
        ts: new Date().toISOString(),
      });
    }
  }

  // Sort by urgency (high first), then confidence (highest first)
  const urgencyOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => {
    const uDiff = (urgencyOrder[a.meta.urgency] || 2) - (urgencyOrder[b.meta.urgency] || 2);
    if (uDiff !== 0) return uDiff;
    return b.confidence - a.confidence;
  });

  // Summary
  const byAction = {};
  const byUrgency = { high: 0, medium: 0, low: 0 };
  for (const rec of recommendations) {
    byAction[rec.action] = (byAction[rec.action] || 0) + 1;
    byUrgency[rec.meta.urgency || 'low']++;
  }

  logger.info(
    `Recommendations: ${recommendations.length} total | ` +
    `🚨${byUrgency.high} high | ⚠️${byUrgency.medium} medium | i️${byUrgency.low} low`
  );

  return {
    recommendations,
    summary: { total: recommendations.length, byAction, byUrgency },
  };
}

module.exports = { runRecommendations, ACTION, ACTION_META };
