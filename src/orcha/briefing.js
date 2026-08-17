'use strict';
/**
 * orcha/briefing.js — Morning briefing, anomaly detection, recommendations, health scoring
 *
 * Extracted from src/app.js (Phase 4) for maintainability and testability.
 * Called by _pushData() on every fleet data push.
 *
 * Returns an object of IPC messages to send (or null for each if nothing to emit):
 *   { alerts, briefing, recommendations, health, transitions }
 */

const logger = require('../utils/logger')('briefing');
const store  = require('../store');
const { runAnomalyDetection } = require('./anomaly');
const repairHistory = require('./repair-history');

/**
 * process(rows, send)
 * @param {Array} rows - Fleet data rows from the current sync push
 * @param {Function} send - IPC send helper: send(channel, payload)
 */
function process(rows, send) {
  if (!rows || !rows.length) return;

  const result = runAnomalyDetection(rows);
  if (!result || !result.alerts || !result.alerts.length) return;

  send('orcha:alerts', result);

  // Morning briefing — once per calendar day
  const _briefingToday = new Date().toISOString().split('T')[0];
  if (global._briefingSent !== _briefingToday) {
    global._briefingSent = _briefingToday;

    // Smart reminders — check due reminders
    const _reminderStore = store.load('reminders', []);
    const _today = new Date().toISOString().split('T')[0];
    const _due = _reminderStore.filter(function(r) { return r.when <= _today; });
    if (_due.length) {
      const reminderMsg = '\u23F0 Reminders due today:\n' + _due.map(function(r) { return '\u2022 ' + r.unit + ': ' + r.note; }).join('\n');
      send('orcha:morning-briefing', { text: reminderMsg, critical: 0, warnings: _due.length, isReminder: true });
      // Remove fired reminders
      const remaining = _reminderStore.filter(function(r) { return r.when > _today; });
      store.save('reminders', remaining);
    }

    // Auto-classify: flag units needing classification
    const needsClassify = rows.filter(function(r) {
      return (r.lifecycleState || '').toLowerCase().includes('unavail') && !r.savedRepairStatus;
    });
    if (needsClassify.length) {
      logger.info('[auto-classify] ' + needsClassify.length + ' units need repair status classification');
    }

    const critical = (result.alerts || []).filter(function(a) { return a.severity === 'critical'; });
    const warnings = (result.alerts || []).filter(function(a) { return a.severity === 'warning'; });
    const briefingText = (critical.length + warnings.length) > 0
      ? '\u2600\uFE0F Morning Briefing: ' + critical.length + ' critical, ' + warnings.length + ' warnings.\n' +
        critical.slice(0, 5).map(function(a) { return '\uD83D\uDD34 ' + a.unit + ' \u2014 ' + a.message; }).join('\n') +
        (warnings.length ? '\n' + warnings.slice(0, 5).map(function(a) { return '\u26A0\uFE0F ' + a.unit + ' \u2014 ' + a.message; }).join('\n') : '')
      : '\u2600\uFE0F Morning Briefing: Fleet is healthy \u2014 no critical issues.';
    send('orcha:morning-briefing', { text: briefingText, critical: critical.length, warnings: warnings.length });
  }

  // Generate action recommendations from alerts
  const recs = (result.alerts || []).filter(a => a.suggestion).map(a => ({
    unit: a.unit,
    type: a.type,
    action: a.suggestion,
    severity: a.severity,
    message: a.message
  }));
  if (recs.length) send('orcha:recommendations', { recommendations: recs });

  // Detect repair completions (unavail -> available transitions)
  try { repairHistory.detectTransitions(rows, global._prevRows || []); } catch (e) {}
  global._prevRows = rows;

  // System health score
  send('orcha:health', {
    overallScore: Math.max(0, 100 - (recs.filter(function(a) { return a.severity === 'critical'; }).length * 5)),
    lastSync: new Date().toISOString(),
    totalUnits: rows.length,
    unavailCount: recs.length,
    integrations: {
      relay: { status: 'green', label: 'Relay' },
      ai:    { status: 'green', label: 'AI' },
      sp:    { status: 'green', label: 'SharePoint' },
      slack: { status: 'green', label: 'Slack' },
    }
  });

  // Proactive AI alerts — check for stalled units and risk jumps
  try {
    const { runProactiveAlerts } = require('./proactive-alerts');
    runProactiveAlerts(rows, { send });
  } catch (e) { /* non-fatal */ }
}

module.exports = { process };
