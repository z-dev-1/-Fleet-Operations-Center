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
function getDueFollowUps(whenISO) {
  const due = caseStore.dueFollowUps(whenISO);
  return due
    .map(c => ({
      caseId: c.caseId,
      unit: c.unit || null,
      summary: c.currentSummary || '',
      owner: c.responsibleParty || '',
      dueAt: c.nextFollowUpAt,
      openQuestions: (c.openQuestions || []).slice(-3),
      promises: (c.promises || []).slice(-3).map(p => p.text || p),
    }))
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}

// Record the current due list to the audit log so it's visible/traceable.
// Never sends anything. Returns the due list.
function surfaceDueFollowUps() {
  const due = getDueFollowUps();
  if (due.length) {
    try {
      const log = store.load('fasAuditLog', []);
      const arr = Array.isArray(log) ? log : [];
      arr.unshift({ at: new Date().toISOString(), kind: 'followups-due', count: due.length,
        items: due.map(d => ({ caseId: d.caseId, unit: d.unit, dueAt: d.dueAt })) });
      if (arr.length > 500) arr.length = 500;
      store.save('fasAuditLog', arr);
    } catch (e) { logger.warn('[fas-scheduler] audit write failed: ' + e.message); }
    logger.info('[fas-scheduler] ' + due.length + ' follow-up(s) due (surfaced, not contacted)');
  }
  return due;
}

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

module.exports = { getDueFollowUps, surfaceDueFollowUps, startScheduler, stopScheduler };
