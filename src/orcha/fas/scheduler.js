'use strict';
/**
 * orcha/fas/scheduler.js — Digital FAS follow-up scheduler.
 *
 * Surfaces cases whose nextFollowUpAt is due, WITHOUT automatically contacting
 * anyone. It only produces a list (and, optionally, audit entries) the operator
 * can act on. Sending anything remains an explicit, approval-gated action.
 *
 * This is deliberately passive: it reads case memory, never mutates a source
 * system, never sends Slack/email. It can run on an interval in the main
 * process or be queried on demand by the UI.
 */

const caseStore = require('./case-store');
const store = require('../../store');
let logger; try { logger = require('../../utils/logger').createLogger('fas-scheduler'); } catch (_) { logger = { info(){}, warn(){} }; }

let _timer = null;

/**
 * getDueFollowUps(whenISO?) -> [{ caseId, unit, summary, owner, dueAt,
 *   openQuestions, promises }]
 * Compact, ready for the UI or a briefing. Sorted soonest-due first.
 */
// Minimum gap between re-surfacing the SAME due follow-up (anti-spam).
const RESURFACE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Is follow-up tracking active? Only when FAS is enabled, OR the operator has
// explicitly turned on independent follow-up tracking (config.followUpTracking).
function _trackingActive() {
  try {
    const cfg = require('./config').get();
    return !!(cfg && (cfg.enabled || cfg.followUpTracking));
  } catch (_) { return false; }
}

function getDueFollowUps(whenISO) {
  if (!_trackingActive()) return [];
  const due = caseStore.dueFollowUps(whenISO);
  return due
    .map(c => ({
      caseId: c.caseId,
      unit: c.unit || null,
      summary: c.currentSummary || '',
      owner: c.responsibleParty || '',
      dueAt: c.nextFollowUpAt,
      lastSurfacedAt: c.lastSurfacedAt || null,
      openQuestions: (c.openQuestions || []).slice(-3),
      // The promise that drove this follow-up (most recent), for the UI.
      sourcePromise: ((c.promises || []).slice(-1)[0] || {}).text || null,
      promises: (c.promises || []).slice(-3).map(p => p.text || p),
      // Link to the originating Slack conversation, if any.
      slackRef: (c.relatedSlackMessages || []).slice(-1)[0] || null,
    }))
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}

// Surface due follow-ups to the audit log — but ONLY those not surfaced within
// the resurface interval, and mark each as surfaced so it does NOT re-log every
// cycle (fixes the every-15-min audit-spam). Never contacts anyone.
function surfaceDueFollowUps() {
  if (!_trackingActive()) return [];
  const due = getDueFollowUps();
  const nowMs = Date.now();
  const fresh = due.filter(d => {
    const last = d.lastSurfacedAt ? Date.parse(d.lastSurfacedAt) : 0;
    return isNaN(last) || (nowMs - last) >= RESURFACE_INTERVAL_MS;
  });
  if (fresh.length) {
    try {
      const log = store.load('fasAuditLog', []);
      const arr = Array.isArray(log) ? log : [];
      arr.unshift({ at: new Date().toISOString(), kind: 'followups-due', count: fresh.length,
        items: fresh.map(d => ({ caseId: d.caseId, unit: d.unit, dueAt: d.dueAt })) });
      if (arr.length > 500) arr.length = 500;
      store.save('fasAuditLog', arr);
    } catch (e) { logger.warn('[fas-scheduler] audit write failed: ' + e.message); }
    // Mark surfaced so the next cycle does not re-log the same items.
    fresh.forEach(d => { try { caseStore.markSurfaced(d.caseId); } catch (_) {} });
    logger.info('[fas-scheduler] ' + fresh.length + ' new follow-up(s) surfaced (not contacted)');
  }
  return fresh;
}

// Operator actions (never contact anyone; just adjust the case).
function snooze(caseId, untilISO) { return caseStore.snoozeFollowUp(caseId, untilISO); }
function complete(caseId, note) { return caseStore.completeFollowUp(caseId, note); }
function dismiss(caseId) { return caseStore.dismissFollowUp(caseId); }

/**
 * startScheduler(intervalMs?) — begin periodically surfacing due follow-ups.
 * Idempotent (a second call replaces the prior timer). Returns a stop fn.
 */
function startScheduler(intervalMs) {
  stopScheduler();
  const every = Math.max(60000, intervalMs || 15 * 60 * 1000); // >= 1 min; default 15 min
  _timer = setInterval(() => { try { surfaceDueFollowUps(); } catch (_) {} }, every);
  if (_timer.unref) _timer.unref(); // never keep the process alive just for this
  logger.info('[fas-scheduler] started (every ' + Math.round(every / 60000) + ' min)');
  return stopScheduler;
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { getDueFollowUps, surfaceDueFollowUps, snooze, complete, dismiss, startScheduler, stopScheduler, RESURFACE_INTERVAL_MS };
