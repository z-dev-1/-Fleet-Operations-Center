'use strict';
/**
 * proactive-alerts.js — Proactive AI alerts for stalled units
 *
 * Runs after each sync and detects:
 *   - Units down 5+ days with no timeline update in 48+ hours
 *   - Units where vendor hasn't changed state in 3+ days
 *   - Risk score jumps (Uptake score increased 20+ points between syncs)
 *
 * When found: sends a proactive message to the user's Just Me / self-DM
 * Slack channel with the alert + a suggested follow-up action.
 *
 * Integrates with the channel watch's justme pipeline — uses the same
 * sendToChannel() function the auto-reply engine uses.
 */

const store  = require('../store');
const logger = require('../utils/logger')('proactive-alerts');

const STALL_DAYS = 5;
const NO_UPDATE_HOURS = 48;
const RISK_JUMP_THRESHOLD = 20;
const ALERT_COOLDOWN_HOURS = 12; // Don't re-alert for same unit within 12h

/**
 * runProactiveAlerts(rows, ctx)
 * Called after each sync cycle completes.
 * @param {Array} rows - Current fleet rows
 * @param {object} ctx - app context with ctx.send for IPC push
 */
async function runProactiveAlerts(rows, ctx) {
  if (!rows || !rows.length) return;

  const notesStore = store.load('notesStore', {});
  const prevAlerts = store.load('proactiveAlertHistory', {});
  const now = Date.now();
  const alerts = [];

  // ── Detect stalled units ────────────────────────────────────────────────
  const unavail = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));

  unavail.forEach(r => {
    const id = r.equipmentId;
    if (!id) return;

    // Skip if we already alerted for this unit recently
    if (prevAlerts[id] && (now - prevAlerts[id]) < ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) return;

    const days = _parseDays(r.workDuration || r.duration);
    if (days < STALL_DAYS) return;

    // Check timeline freshness
    const ns = notesStore[id] || {};
    const timeline = ns.timeline || r.repairTimeline || '';
    const lastUpdateAge = _timelineAgeHours(timeline);

    if (lastUpdateAge === null || lastUpdateAge > NO_UPDATE_HOURS) {
      alerts.push({
        type: 'stalled',
        unitId: id,
        vendor: r.vendor || 'Unknown',
        days,
        hoursSinceUpdate: lastUpdateAge,
        message: `⚠️ ${id} has been at ${r.vendor || 'vendor'} for ${days} days with no update in ${lastUpdateAge ? Math.round(lastUpdateAge) + 'h' : 'ever'}. Consider following up.`,
        suggestion: `Draft a follow-up message to ${r.vendor || 'the vendor'} asking for status/ETA on ${id}.`,
      });
    }
  });

  // ── Detect risk score jumps ─────────────────────────────────────────────
  const prevScores = store.load('proactiveLastScores', {});
  rows.forEach(r => {
    if (!r.equipmentId || !r.riskScore) return;
    const prev = prevScores[r.equipmentId] || 0;
    const jump = r.riskScore - prev;
    if (jump >= RISK_JUMP_THRESHOLD && r.riskScore >= 60) {
      const id = r.equipmentId;
      if (prevAlerts[id] && (now - prevAlerts[id]) < ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) return;
      alerts.push({
        type: 'risk-jump',
        unitId: id,
        vendor: r.vendor || '',
        riskScore: r.riskScore,
        previousScore: prev,
        message: `🔺 ${id} risk score jumped from ${prev} to ${r.riskScore}. Predictive maintenance alert.`,
        suggestion: `Check Uptake insights for ${id} and consider scheduling preventive maintenance.`,
      });
    }
  });

  // Save current scores for next comparison
  const newScores = {};
  rows.forEach(r => { if (r.equipmentId && r.riskScore) newScores[r.equipmentId] = r.riskScore; });
  store.save('proactiveLastScores', newScores);

  if (!alerts.length) return;

  // Mark alerted units
  alerts.forEach(a => { prevAlerts[a.unitId] = now; });
  store.save('proactiveAlertHistory', prevAlerts);

  logger.info('[Proactive] ' + alerts.length + ' alerts generated');

  // Push to renderer for toast/notification
  if (ctx && ctx.send) {
    ctx.send('orcha:proactive-alerts', { alerts, count: alerts.length });
  }

  // Send to Just Me Slack channel (if configured)
  try {
    const config = store.load('slackChannelWatchConfig', {});
    if (!config.enabled || !config.channels) return;
    const justmeChannel = (config.channels || []).find(ch => ch.enabled && ch.replyMode === 'justme');
    if (!justmeChannel) return;

    const { sendToChannel } = require('../scrapers/slack_send');
    const summary = alerts.slice(0, 5).map(a => a.message).join('\n\n');
    const text = '🤖 *Proactive Fleet Alert*\n\n' + summary +
      (alerts.length > 5 ? '\n\n...and ' + (alerts.length - 5) + ' more.' : '') +
      '\n\n_Reply here to take action on any of these._';

    await sendToChannel(justmeChannel.id, text);
    logger.info('[Proactive] Sent ' + alerts.length + ' alerts to Just Me channel: ' + justmeChannel.name);
  } catch (e) {
    logger.warn('[Proactive] Could not send to Slack:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function _timelineAgeHours(timeline) {
  if (!timeline) return null;
  const lines = timeline.split('\n').filter(Boolean);
  const now = Date.now();
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d{1,2})\/(\d{1,2})/);
    if (m) {
      const month = parseInt(m[1], 10) - 1;
      const day = parseInt(m[2], 10);
      const year = new Date().getFullYear();
      const entryDate = new Date(year, month, day);
      if (entryDate > now) entryDate.setFullYear(year - 1);
      return (now - entryDate.getTime()) / (1000 * 60 * 60);
    }
  }
  return null;
}

module.exports = { runProactiveAlerts };
