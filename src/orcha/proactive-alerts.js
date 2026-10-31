'use strict';
/**
 * proactive-alerts.js — Proactive AI alerts for stalled units
 *
 * Runs after each sync and detects:
 *   - Units down 5+ days with no timeline update in 48+ hours
 *   - Units where vendor hasn't changed state in 3+ days
 *   - Risk score jumps (Uptake score increased 20+ points between syncs)
 *
 * When found: hands the alerts to the unified assistant notifier
 * (src/orcha/awareness/notifier.js), which de-dupes, batches, and posts to
 * the Just Me channel.
 */

const store  = require('../store');
const logger = require('../utils/logger')('proactive-alerts');

const STALL_DAYS = 5;
const NO_UPDATE_HOURS = 48;
const RISK_JUMP_THRESHOLD = 20;
const ALERT_COOLDOWN_HOURS = 12; // Don't re-alert for same unit within 12h

/**
 * runProactiveAlerts(rows, ctx, deps)
 * Called after each sync cycle completes.
 * @param {Array} rows - Current fleet rows
 * @param {object} ctx - app context with ctx.send for IPC push
 * @param {object} [deps] - { load, save, notifier } (default store + getNotifier())
 */
async function runProactiveAlerts(rows, ctx, deps = {}) {
  if (!rows || !rows.length) return;
  const load = deps.load || store.load;
  const save = deps.save || store.save;

  const notesStore = load('notesStore', {});
  const prevAlerts = load('proactiveAlertHistory', {});
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
        wr: r.workRequestId || '-',
        vendor: r.vendor || 'Unknown',
        days,
        hoursSinceUpdate: lastUpdateAge,
        message: `⚠️ ${id} has been at ${r.vendor || 'vendor'} for ${days} days with no update in ${lastUpdateAge ? Math.round(lastUpdateAge) + 'h' : 'ever'}. Consider following up.`,
        suggestion: `Draft a follow-up message to ${r.vendor || 'the vendor'} asking for status/ETA on ${id}.`,
      });
    }
  });

  // ── Detect risk score jumps ─────────────────────────────────────────────
  // Baseline fix: a unit with no prior score never "jumps" (first sighting),
  // and a partial push merges into the saved scores instead of wiping them.
  const prevScores = load('proactiveLastScores', {}) || {};
  rows.forEach(r => {
    if (!r.equipmentId || !r.riskScore) return;
    if (!Object.prototype.hasOwnProperty.call(prevScores, r.equipmentId)) return;
    const prev = prevScores[r.equipmentId] || 0;
    const jump = r.riskScore - prev;
    if (jump >= RISK_JUMP_THRESHOLD && r.riskScore >= 60) {
      const id = r.equipmentId;
      if (prevAlerts[id] && (now - prevAlerts[id]) < ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) return;
      alerts.push({
        type: 'risk-jump',
        unitId: id,
        wr: r.workRequestId || '-',
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
  save('proactiveLastScores', Object.assign({}, prevScores, newScores));

  if (!alerts.length) return;

  // Mark alerted units
  alerts.forEach(a => { prevAlerts[a.unitId] = now; });
  save('proactiveAlertHistory', prevAlerts);

  logger.info('[Proactive] ' + alerts.length + ' alerts generated');

  // Push to renderer for toast/notification
  if (ctx && ctx.send) {
    ctx.send('orcha:proactive-alerts', { alerts, count: alerts.length });
  }

  // Hand off to the unified notifier (de-dupe ledger, batching, Just Me only).
  try {
    const notifier = deps.notifier || require('./awareness/notifier').getNotifier();
    notifier.enqueue(alerts.map(_toNote));
  } catch (e) {
    logger.warn('[Proactive] notifier enqueue failed: ' + e.message);
  }
}

// Alert -> notifier note (design §D6). Stalled re-notifies once per WR per
// extra full week stuck; risk once per 10-point band.
function _toNote(a) {
  if (a.type === 'stalled') return {
    key: `${a.unitId}|stalled|${a.wr}|w${Math.floor((a.days - 5) / 7)}`,
    unit: a.unitId, wr: a.wr, family: 'stalled', icon: '⚠️', title: 'Stalled',
    text: a.message, source: 'proactive-alerts', severity: 'medium' };
  return { // 'risk-jump'
    key: `${a.unitId}|risk|${Math.floor(a.riskScore / 10) * 10}`,
    unit: a.unitId, wr: a.wr, family: 'risk', icon: '🔺', title: 'Risk jump',
    text: a.message, source: 'proactive-alerts', severity: 'medium' };
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

module.exports = { runProactiveAlerts, _toNote };
