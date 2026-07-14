'use strict';
/**
 * src/orcha/repair-history.js
 * 
 * Maintains a 3-month summarized repair history per unit.
 * Each entry is a single-line summary of a repair event.
 * 
 * Shape: { [equipmentId]: [ { date, summary, vendor, duration, outcome, ts } ] }
 * 
 * Called when:
 *   - A unit transitions from unavailable to available (repair complete)
 *   - A timeline entry is added (captures in-progress events)
 *   - On sync when status changes are detected
 */

const store = require('../store');
const logger = require('../utils/logger')('repair-history');

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Get all repair history for a unit
 */
function getUnitHistory(equipmentId) {
  const all = store.load('repairHistory', {});
  return (all[equipmentId] || []).filter(function(e) {
    return (Date.now() - e.ts) < THREE_MONTHS_MS;
  });
}

/**
 * Add a summarized repair event to unit history
 */
function addEvent(equipmentId, event) {
  const all = store.load('repairHistory', {});
  if (!all[equipmentId]) all[equipmentId] = [];
  
  all[equipmentId].push({
    date: event.date || new Date().toISOString().split('T')[0],
    summary: (event.summary || '').substring(0, 120),
    vendor: event.vendor || '',
    duration: event.duration || '',
    outcome: event.outcome || 'in-progress',
    ts: Date.now()
  });
  
  // Purge entries older than 3 months
  all[equipmentId] = all[equipmentId].filter(function(e) {
    return (Date.now() - e.ts) < THREE_MONTHS_MS;
  });
  
  store.save('repairHistory', all);
  logger.info('Added history: ' + equipmentId + ' - ' + (event.summary || '').substring(0, 50));
}

/**
 * Summarize and close a repair when unit becomes available
 */
function closeRepair(equipmentId, details) {
  const vendor = details.vendor || 'unknown vendor';
  const duration = details.duration || '?';
  const issue = details.issue || 'repair';
  const today = new Date().toISOString().split('T')[0];
  
  addEvent(equipmentId, {
    date: today,
    summary: 'Repair complete. ' + issue + '. ' + vendor + '. Down ' + duration + '.',
    vendor: vendor,
    duration: duration,
    outcome: 'completed'
  });
}

/**
 * Check for status transitions (call on every sync)
 * Detects units that went from unavailable to available
 */
function detectTransitions(currentRows, previousRows) {
  if (!previousRows || !previousRows.length) return;
  
  const prevMap = {};
  previousRows.forEach(function(r) { prevMap[r.equipmentId] = r; });
  
  currentRows.forEach(function(r) {
    const prev = prevMap[r.equipmentId];
    if (!prev) return;
    
    const wasUnavail = (prev.lifecycleState || '').toLowerCase().includes('unavail');
    const nowAvail = (r.lifecycleState || '').toLowerCase().includes('available') && 
                     !(r.lifecycleState || '').toLowerCase().includes('unavail');
    
    if (wasUnavail && nowAvail) {
      closeRepair(r.equipmentId, {
        vendor: prev.vendor || r.vendor,
        duration: prev.workDuration || r.workDuration,
        issue: prev.lifecycleReason || prev.issueDetails || 'unknown'
      });
    }
  });
}

/**
 * Get full history (all units) — for analytics
 */
function getAllHistory() {
  const all = store.load('repairHistory', {});
  // Purge old entries
  Object.keys(all).forEach(function(uid) {
    all[uid] = all[uid].filter(function(e) {
      return (Date.now() - e.ts) < THREE_MONTHS_MS;
    });
    if (all[uid].length === 0) delete all[uid];
  });
  store.save('repairHistory', all);
  return all;
}

module.exports = { getUnitHistory, addEvent, closeRepair, detectTransitions, getAllHistory };
