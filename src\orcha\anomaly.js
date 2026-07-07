'use strict';
/**
 * anomaly.js — Orcha Anomaly & Gap Detection (Sprint 1, Module 2)
 *
 * Runs after monitor.js in the sync pipeline. Detects operational anomalies:
 *   1. No vendor assigned (unavailable > 1 day)
 *   2. Stuck units (relay status "Pending" > 48h)
 *   3. Duration jump (> 2 days increase since last check)
 *   4. High risk without WR (risk > 70, no open work request)
 *   5. Unexplained state change (lifecycle reason changed, no notes)
 *   6. PM overdue (B/X/DOT past due)
 *   7. Stale AI (unavailable > 3 days with no Orcha analysis)
 *
 * Outputs:
 *   - Array of alerts: { id, severity, unit, type, message, suggestion, ts }
 *   - severity: 'critical' | 'warning' | 'info'
 *   - Pushed to renderer via ctx.send('orcha:alerts', alerts)
 *
 * Does NOT modify data. Purely observational + advisory.
 */

const logger = require('../utils/logger')('anomaly');
const store  = require('../store');

// ── Alert Types ──────────────────────────────────────────────────────────────
const ALERT_TYPE = {
  NO_VENDOR:       'no_vendor',
  STUCK:           'stuck',
  DURATION_JUMP:   'duration_jump',
  HIGH_RISK_NO_WR: 'high_risk_no_wr',
  UNEXPLAINED:     'unexplained_change',
  PM_OVERDUE:      'pm_overdue',
  STALE_AI:        'stale_ai',
};

// ── Thresholds ───────────────────────────────────────────────────────────────
const THRESHOLDS = {
  NO_VENDOR_HOURS:         24,    // flag if unavailable > 24h with no vendor
  STUCK_HOURS:             48,    // "Pending" status for > 48h
  DURATION_JUMP_DAYS:      2,     // flag if duration increased by > 2 days between syncs
  HIGH_RISK_SCORE:         70,    // risk score threshold
  STALE_AI_HOURS:          72,    // no AI analysis in 3 days
  PM_OVERDUE_KEYWORDS:     ['overdue', 'past due', 'expired'],
};

// ── Internal state (persisted to avoid repeat alerts) ────────────────────────
const STATE_KEY = 'anomaly_state';
let _prevDurations = {};  // { equipmentId: lastKnownDurationDays }
let _dismissedAlerts = new Set();  // alert IDs dismissed by user (persisted)

function _loadState() {
  try {
    const raw = store.load(STATE_KEY, null);
    if (raw) {
      _prevDurations = raw.prevDurations || {};
      _dismissedAlerts = new Set(raw.dismissed || []);
    }
  } catch (_) {}
}

function _saveState() {
  try {
    // Use direct fs write since 'anomaly_state' may not be in store registry
    const fs = require('fs');
    const path = require('path');
    const { P } = require('../config/paths');
    const filePath = path.join(P.dataDir, 'anomaly_state.json');
    fs.writeFileSync(filePath, JSON.stringify({
      prevDurations: _prevDurations,
      dismissed: [..._dismissedAlerts],
    }, null, 2));
  } catch (_) {}
}

// ── Duration parser (same as renderer) ───────────────────────────────────────
function _parseDays(dur) {
  if (!dur || dur === '--') return null;
  const s = String(dur).toLowerCase().trim();
  let days = 0;
  const dm = s.match(/(\d+)\s*d/);
  if (dm) days += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/);
  if (hm) days += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) {
    const n = parseFloat(s);
    if (!isNaN(n)) days = n;
  }
  return days || null;
}

// ── Generate unique alert ID ─────────────────────────────────────────────────
function _alertId(type, equipmentId) {
  return type + ':' + equipmentId;
}

// ── Core detection rules ─────────────────────────────────────────────────────

function _detectNoVendor(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null || dur < (THRESHOLDS.NO_VENDOR_HOURS / 24)) return null;
  const vendor = (row.vendor || '').trim();
  if (vendor && vendor !== '--' && vendor.toLowerCase() !== 'unassigned') return null;

  return {
    id: _alertId(ALERT_TYPE.NO_VENDOR, row.equipmentId),
    severity: 'critical',
    unit: row.equipmentId,
    type: ALERT_TYPE.NO_VENDOR,
    message: `No vendor assigned — unavailable ${Math.round(dur)}d`,
    suggestion: 'Assign a vendor through Dealer WO or manually update relay status',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

function _detectStuck(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const reason = (row.lifecycleReason || '').toLowerCase();
  const isPending = reason.includes('pending') || reason.includes('waiting') || reason.includes('scheduled');
  if (!isPending) return null;

  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null || dur < (THRESHOLDS.STUCK_HOURS / 24)) return null;

  return {
    id: _alertId(ALERT_TYPE.STUCK, row.equipmentId),
    severity: 'warning',
    unit: row.equipmentId,
    type: ALERT_TYPE.STUCK,
    message: `Stuck in "${row.lifecycleReason}" for ${Math.round(dur)}d`,
    suggestion: 'Follow up with vendor — unit may be waiting on parts or approval',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

function _detectDurationJump(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null) return null;

  const prev = _prevDurations[row.equipmentId];
  if (prev !== undefined && prev !== null) {
    const jump = dur - prev;
    if (jump > THRESHOLDS.DURATION_JUMP_DAYS) {
      return {
        id: _alertId(ALERT_TYPE.DURATION_JUMP, row.equipmentId),
        severity: 'info',
        unit: row.equipmentId,
        type: ALERT_TYPE.DURATION_JUMP,
        message: `Duration jumped +${Math.round(jump)}d (was ${Math.round(prev)}d, now ${Math.round(dur)}d)`,
        suggestion: 'Verify repair timeline — unexpected delay may indicate vendor issue',
        operator: row.operator || '',
        domicile: row.domicileSite || '',
      };
    }
  }
  // Track for next cycle
  _prevDurations[row.equipmentId] = dur;
  return null;
}

function _detectHighRiskNoWR(row) {
  const risk = parseInt(row.riskScore, 10) || 0;
  if (risk < THRESHOLDS.HIGH_RISK_SCORE) return null;

  const openWR = parseInt(row.openUnplanned, 10) || 0;
  if (openWR > 0) return null;

  return {
    id: _alertId(ALERT_TYPE.HIGH_RISK_NO_WR, row.equipmentId),
    severity: 'warning',
    unit: row.equipmentId,
    type: ALERT_TYPE.HIGH_RISK_NO_WR,
    message: `Risk score ${risk}% but no open Work Request`,
    suggestion: 'Create a preventive WR before component failure occurs',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

function _detectUnexplained(row, notesStore) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const reason = (row.lifecycleReason || '').trim();
  if (!reason) return null;

  const notes = notesStore[row.equipmentId];
  if (notes && notes.notes && notes.notes.length > 20) return null;  // has notes — explained

  // Only flag if unit has been unavailable (has duration > 12h) but no notes
  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null || dur < 0.5) return null;

  return {
    id: _alertId(ALERT_TYPE.UNEXPLAINED, row.equipmentId),
    severity: 'info',
    unit: row.equipmentId,
    type: ALERT_TYPE.UNEXPLAINED,
    message: `Unavailable (${reason}) with no notes — status unexplained`,
    suggestion: 'Run Orcha Deep Scan or add manual notes to document repair status',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

function _detectPMOverdue(row) {
  const dueDate = (row.dueDate || '').toLowerCase();
  if (!dueDate) return null;

  const isOverdue = THRESHOLDS.PM_OVERDUE_KEYWORDS.some(kw => dueDate.includes(kw));
  if (!isOverdue) return null;

  return {
    id: _alertId(ALERT_TYPE.PM_OVERDUE, row.equipmentId),
    severity: 'warning',
    unit: row.equipmentId,
    type: ALERT_TYPE.PM_OVERDUE,
    message: 'PM service overdue — maintenance compliance at risk',
    suggestion: 'Schedule PM appointment or create planned Work Request',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

function _detectStaleAI(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;

  const processedAt = row._orchaProcessedAt;
  if (processedAt) {
    const hoursAgo = (Date.now() - new Date(processedAt).getTime()) / 3600000;
    if (hoursAgo < THRESHOLDS.STALE_AI_HOURS) return null;  // recent enough
  }
  // No AI analysis or stale
  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null || dur < 1) return null;  // too new to need AI yet

  return {
    id: _alertId(ALERT_TYPE.STALE_AI, row.equipmentId),
    severity: 'info',
    unit: row.equipmentId,
    type: ALERT_TYPE.STALE_AI,
    message: `No recent AI analysis (unavailable ${Math.round(dur)}d)`,
    suggestion: 'Trigger Orcha Deep Scan from unit detail panel',
    operator: row.operator || '',
    domicile: row.domicileSite || '',
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * runAnomalyDetection(mergedRows)
 * @returns {{ alerts: Array, counts: { critical, warning, info } }}
 */
function runAnomalyDetection(mergedRows) {
  _loadState();
  const notesStore = store.load('notesStore', {});
  const alerts = [];
  const now = new Date().toISOString();

  const detectors = [
    _detectNoVendor,
    _detectStuck,
    _detectDurationJump,
    _detectHighRiskNoWR,
    _detectUnexplained,
    _detectPMOverdue,
    _detectStaleAI,
    _detectNoData,
    _detectETCPassed,
    _detectVendorStale,
  ];

  for (const row of mergedRows) {
    if (!row.equipmentId) continue;
    for (const detect of detectors) {
      let alert;
      try {
        alert = detect === _detectUnexplained
          ? detect(row, notesStore)
          : detect(row);
      } catch (e) {
        logger.warn('Detector error:', e.message);
        continue;
      }
      if (alert && !_dismissedAlerts.has(alert.id)) {
        alert.ts = now;
        alerts.push(alert);
      }
    }
  }

  // Save duration state for next cycle
  _saveState();

  // Count by severity
  const counts = { critical: 0, warning: 0, info: 0 };
  alerts.forEach(a => counts[a.severity]++);

  // Sort: critical first, then warning, then info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  logger.info(
    `Anomaly detection: ${alerts.length} alerts | ` +
    `🔴${counts.critical} critical | ⚠️${counts.warning} warning | i️${counts.info} info`
  );

  return { alerts, counts };
}

/**
 * dismissAlert(alertId) — user dismisses an alert (won't re-appear)
 */
function dismissAlert(alertId) {
  _dismissedAlerts.add(alertId);
  _saveState();
}

/**
 * clearDismissed() — reset all dismissed alerts
 */
function clearDismissed() {
  _dismissedAlerts.clear();
  _saveState();
}


/**
 * Detect: Unavailable unit with no repair data (no vendor, no WR, no timeline)
 * This means it just became unavailable and nobody has acted on it.
 */
function _detectNoData(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const vendor = (row.vendor || '').trim();
  const hasVendor = vendor && vendor !== '--' && vendor.toLowerCase() !== 'unassigned';
  const hasTimeline = row.timeline || row.savedNotes || row._orchaProcessed;
  const hasWR = row.serviceUrl || row.openUnplanned > 0;
  
  // If it has none of these, it needs immediate attention
  if (hasVendor || hasTimeline || hasWR) return null;

  return {
    id: 'no_data_' + row.equipmentId,
    severity: 'critical',
    unit: row.equipmentId,
    type: 'no_data',
    message: 'Unavailable with no vendor, no WR, no timeline — needs immediate action',
    suggestion: 'Create a Work Request or assign a vendor',
  };
}


/**
 * #7: ETC Watcher - detect when vendor ETC has passed without completion
 */
function _detectETCPassed(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const etc = row.etc || row.estimatedCompletion || '';
  if (!etc) return null;
  const etcDate = new Date(etc);
  if (isNaN(etcDate.getTime())) return null;
  if (etcDate > new Date()) return null; // not yet passed
  
  return {
    id: 'etc_passed_' + row.equipmentId,
    severity: 'warning',
    unit: row.equipmentId,
    type: 'etc_passed',
    message: 'ETC passed (' + etc + ') without completion confirmation',
    suggestion: 'Request updated ETA from vendor',
  };
}

/**
 * #8: Vendor Response Tracker - no vendor update in 3+ days
 */
function _detectVendorStale(row) {
  if (!(row.lifecycleState || '').toLowerCase().includes('unavail')) return null;
  const vendor = (row.vendor || '').trim();
  if (!vendor || vendor === '--') return null;
  
  const dur = _parseDays(row.workDuration || row.duration);
  if (dur === null || dur < 3) return null;
  
  // Check if there's recent activity (notes updated recently)
  const lastUpdate = row._orchaProcessedAt || row.lastNoteAt;
  if (lastUpdate) {
    const daysSinceUpdate = (Date.now() - new Date(lastUpdate).getTime()) / 86400000;
    if (daysSinceUpdate < 3) return null;
  }
  
  return {
    id: 'vendor_stale_' + row.equipmentId,
    severity: 'warning',
    unit: row.equipmentId,
    type: 'vendor_stale',
    message: vendor + ' — no update in ' + Math.round(dur) + '+ days',
    suggestion: 'Follow up with ' + vendor + ' for status',
  };
}

module.exports = { runAnomalyDetection, dismissAlert, clearDismissed, ALERT_TYPE };
