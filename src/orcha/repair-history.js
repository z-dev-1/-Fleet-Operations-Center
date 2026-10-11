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
 * Get all repair history for a unit.
 *
 * Merges two sources, both filtered to the last 3 months:
 *  1. The structured repairHistory store ({date,summary,vendor,duration,
 *     outcome,ts} events written by deep-scan + closeRepair).
 *  2. ARCHIVED repair timelines (notesStore[id].timelineArchive[]) — when a
 *     unit returns to service its live timeline is archived (archiveAndClear
 *     Timeline) and removed from the Repair tab. The History tab is where that
 *     repair narrative belongs, so each archived "MM/DD - text" line is surfaced
 *     here as a history event (outcome 'completed', since the repair is closed).
 *     Without this the archived narrative was written but never shown anywhere.
 */
function getUnitHistory(equipmentId) {
  const cutoff = Date.now() - THREE_MONTHS_MS;
  const all = store.load('repairHistory', {});
  const events = (all[equipmentId] || []).filter(function(e) { return e.ts > cutoff; });

  // Fold in archived timeline lines (best-effort; never throw).
  try {
    const ns = store.load('notesStore', {});
    const u = ns[equipmentId];
    const archives = (u && Array.isArray(u.timelineArchive)) ? u.timelineArchive : [];
    const thisYear = new Date().getFullYear();
    for (const arc of archives) {
      const closedTs = arc.closedAt ? new Date(arc.closedAt).getTime() : Date.now();
      String(arc.timeline || '').split('\n').forEach(function(line) {
        const m = line.trim().match(/^(\d{1,2})\/(\d{1,2})\s*[-\u2013]\s*(.+)$/);
        if (!m) return;
        // Date the entry by its MM/DD (assume the archive's year), fall back to closedAt.
        let ts = new Date(thisYear, parseInt(m[1], 10) - 1, parseInt(m[2], 10)).getTime();
        if (isNaN(ts) || ts > Date.now() + 86400000) ts = closedTs;
        if (ts <= cutoff) return;
        events.push({
          date: (m[1].padStart(2, '0')) + '/' + (m[2].padStart(2, '0')),
          summary: m[3].trim().substring(0, 120),
          vendor: '',
          duration: '',
          outcome: 'completed',
          ts: ts,
          _archived: true,
        });
      });
    }
  } catch (_) { /* archived timeline is a bonus source — never block history */ }

  return events;
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
 * archiveAndClearTimeline(equipmentId) — when a unit returns to service, move
 * its live repair timeline out of the active record and blank it. Without this,
 * the stored notesStore[id].timeline (mirrored to row.repairTimeline) persisted
 * forever and kept showing on an Active/no-WO unit. We don't DELETE the history
 * — it's archived into notesStore[id].timelineArchive[] (with a closedAt stamp)
 * so it's recoverable and the repairHistory summary trail is untouched — we just
 * stop it from being the unit's live, displayed timeline. manualEntries /
 * hiddenEntries are reset too so a future repair starts clean. Best-effort.
 */
function archiveAndClearTimeline(equipmentId) {
  try {
    const ns = store.load('notesStore', {});
    const u = ns[equipmentId];
    if (!u || !u.timeline || !u.timeline.trim()) return;

    u.timelineArchive = Array.isArray(u.timelineArchive) ? u.timelineArchive : [];
    u.timelineArchive.push({ timeline: u.timeline, closedAt: new Date().toISOString() });
    // Cap the archive so it can't grow unbounded.
    if (u.timelineArchive.length > 10) u.timelineArchive = u.timelineArchive.slice(-10);

    u.timeline = '';
    u.manualEntries = [];
    u.hiddenEntries = [];
    ns[equipmentId] = u;
    store.save('notesStore', ns);

    // Mirror the cleared timeline onto the live fleetData row so the detail
    // panel reflects it immediately (not just after the next merge).
    const fd = store.load('fleetData', {});
    if (fd && fd.rows) {
      const row = fd.rows.find(r => r.equipmentId === equipmentId);
      if (row) { row.repairTimeline = ''; store.save('fleetData', fd); }
    }
    logger.info('Archived + cleared repair timeline on return-to-service: ' + equipmentId);
  } catch (e) {
    logger.warn('archiveAndClearTimeline failed (non-fatal) for ' + equipmentId + ': ' + e.message);
  }
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

  // Now that the completion is logged to repairHistory, retire the live repair
  // timeline so it stops showing on the now-Available unit.
  archiveAndClearTimeline(equipmentId);
}

// Is this row currently in service with no open work order? AAP uses "Active"
// (not "Available") for a returned-to-service unit, and writes "--" for zero
// open WOs (parseInt -> NaN -> 0). Matches the gate in relay.mergeRelayIntoRows.
function _isInServiceNoWR(r) {
  const lc = String((r && (r.lifecycleState || r.atsState)) || '').toLowerCase();
  const inService = /avail|active|in service|ready/.test(lc) && !lc.includes('unavail');
  const openWR = (parseInt(r && r.openUnplanned, 10) || 0) + (parseInt(r && r.openPlanned, 10) || 0);
  return inService && openWR === 0 && !(r && r.serviceUrl) && !(r && r.workRequestId);
}

/**
 * sweepReturnedUnits(rows) — stateless cleanup run on every sync. Any unit that
 * is currently in service with NO open work order but STILL has a stored repair
 * timeline gets archived + cleared (so the narrative moves to the History tab
 * instead of lingering on the Repair tab). Unlike detectTransitions this needs
 * no previous-row comparison, so it also fixes units that returned to service
 * BEFORE this logic existed (or across an app restart, where _prevRows is lost).
 * Idempotent — archiveAndClearTimeline no-ops once the timeline is empty.
 */
function sweepReturnedUnits(currentRows) {
  if (!Array.isArray(currentRows) || !currentRows.length) return 0;
  let cleared = 0;
  try {
    const ns = store.load('notesStore', {});
    for (const r of currentRows) {
      if (!r || !r.equipmentId) continue;
      const u = ns[r.equipmentId];
      if (!u || !u.timeline || !u.timeline.trim()) continue; // nothing stored to clear
      if (_isInServiceNoWR(r)) {
        archiveAndClearTimeline(r.equipmentId);
        cleared++;
      }
    }
  } catch (e) {
    logger.warn('sweepReturnedUnits failed (non-fatal): ' + e.message);
  }
  if (cleared) logger.info('sweepReturnedUnits archived + cleared ' + cleared + ' returned-to-service timeline(s)');
  return cleared;
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

module.exports = { getUnitHistory, addEvent, closeRepair, detectTransitions, getAllHistory, archiveAndClearTimeline, sweepReturnedUnits };
