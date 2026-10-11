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

// ── Breakdown records ─────────────────────────────────────────────────────────
// A unit's repair data (89 status events, archived timelines, the live WR) is
// noisy — buildBreakdowns collapses it into ONE record per down->up repair
// CYCLE so the History tab can show a clean "breakdown by date" list.
//
// Record: { downDate, backDate, days, ongoing, rootCause, vendor, sig, events:[{date,text}] }
//   downDate/backDate: 'YYYY-MM-DD' (backDate null when still down/ongoing)
//   days: whole-day duration (null if unknown)
//   rootCause: best available failure description (WR cause/correction/issue, or
//              first substantive event line) — the mechanical problem, not status
//   sig: a stable fingerprint of the cycle (for caching AI analysis)
//   events: the cleaned per-day lines belonging to this cycle (for AI grounding)

function _ymd(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v).slice(0, 10);
  const t = new Date(v).getTime();
  if (isNaN(t)) return null;
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _daysBetween(a, b) {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / 86400000));
}

// Strip a leading "MM/DD - " prefix and collapse whitespace.
function _cleanLine(s) {
  return String(s || '').replace(/^\s*\d{1,2}\/\d{1,2}\s*[-\u2013]\s*/, '').replace(/\s+/g, ' ').trim();
}

// Does a line describe the actual FAILURE (root cause) vs a status update?
const _CAUSE_RE = /fail|failure|leak|broken|crack|worn|fault|diagnos|replace|harness|engine|transmission|brake|coolant|electrical|wiring|valve|compressor|alternator|starter|clutch|axle|suspension|tire|def\b|aftertreatment|dpf|egr|turbo|injector|sensor/i;

/**
 * buildBreakdowns(equipmentId, row) — group this unit's repair data into one
 * record per breakdown cycle, newest-first. `row` (optional) is the live
 * fleetData row for the current/open WR (dates, vendor, cause).
 */
function buildBreakdowns(equipmentId, row) {
  const cutoff = Date.now() - THREE_MONTHS_MS;

  // Gather dated event lines from BOTH the structured store and archived
  // timelines, each tagged with whether it closes a cycle (outcome 'completed').
  const raw = [];

  const all = store.load('repairHistory', {});
  (all[equipmentId] || []).forEach(function (e) {
    const ts = (e.ts && !isNaN(e.ts)) ? e.ts : new Date(e.date).getTime();
    if (isNaN(ts)) return;
    raw.push({ ts: ts, date: _ymd(e.date) || _ymd(ts), text: _cleanLine(e.summary), vendor: e.vendor || '', closes: e.outcome === 'completed' });
  });

  try {
    const ns = store.load('notesStore', {});
    const u = ns[equipmentId];
    const archives = (u && Array.isArray(u.timelineArchive)) ? u.timelineArchive : [];
    const thisYear = new Date().getFullYear();
    archives.forEach(function (arc) {
      const closeTs = arc.closedAt ? new Date(arc.closedAt).getTime() : Date.now();
      const lines = String(arc.timeline || '').split('\n');
      lines.forEach(function (line, i) {
        const m = line.trim().match(/^(\d{1,2})\/(\d{1,2})\s*[-\u2013]\s*(.+)$/);
        if (!m) return;
        let ts = new Date(thisYear, parseInt(m[1], 10) - 1, parseInt(m[2], 10)).getTime();
        if (isNaN(ts) || ts > Date.now() + 86400000) ts = closeTs;
        raw.push({ ts: ts, date: _ymd(ts), text: _cleanLine(m[3]), vendor: '', closes: i === lines.length - 1 });
      });
    });
  } catch (_) {}

  if (!raw.length && !(row && row.created)) return [];

  raw.sort(function (a, b) { return a.ts - b.ts; });

  // Split the chronological stream into cycles: a 'closes' event ends the
  // current cycle; the next event opens a new one.
  const cycles = [];
  let cur = null;
  raw.forEach(function (ev) {
    if (!cur) cur = { events: [], vendor: '' };
    cur.events.push(ev);
    if (ev.vendor && !cur.vendor) cur.vendor = ev.vendor;
    if (ev.closes) { cycles.push(cur); cur = null; }
  });
  if (cur) cycles.push(cur); // trailing open (ongoing) cycle

  // If there are no event-derived cycles but the row has an open WR, synthesize
  // the current ongoing breakdown from the row.
  if (!cycles.length && row && row.created) {
    cycles.push({ events: [], vendor: row.vendor || '', _fromRow: true });
  }

  const out = cycles.map(function (c) {
    const evs = c.events;
    const first = evs[0], last = evs[evs.length - 1];
    const closed = last && last.closes;
    const downDate = first ? first.date : _ymd(row && row.created);
    const backDate = closed ? last.date : null;
    const days = (downDate && backDate) ? _daysBetween(downDate, backDate) : null;

    // Root cause: prefer a WR cause/correction (for the open cycle), else the
    // first event line that reads like a failure, else the first line.
    let rootCause = '';
    if (c._fromRow || (row && !closed)) {
      rootCause = _cleanLine(row && (row.cause || row.correction)) || '';
    }
    if (!rootCause) {
      const causeLine = evs.find(function (e) { return _CAUSE_RE.test(e.text); });
      rootCause = (causeLine && causeLine.text) || (first && first.text) || _cleanLine(row && (row.issueDetails || row.issueSummary)) || 'Repair';
    }
    rootCause = rootCause.slice(0, 160);

    // Reported issue — the ORIGINAL complaint/symptom at intake (distinct from
    // the root cause that was later found). For the open cycle this is the
    // row's AI issue summary; for a closed cycle it's the earliest recorded
    // event line (what was first reported). Skip bare URLs.
    let reportedIssue = '';
    const _notUrl = function (s) { return s && !/^https?:\/\//i.test(String(s).trim()); };
    if (c._fromRow || (row && !closed)) {
      const cand = (row && (row.issueSummary ||
        (_notUrl(row.issueDetails) ? row.issueDetails : '') ||
        row.lifecycleReason)) || '';
      reportedIssue = _cleanLine(cand);
    }
    if (!reportedIssue && first) reportedIssue = first.text;
    reportedIssue = (reportedIssue || '').slice(0, 180);

    const vendor = c.vendor || (row && row.vendor) || '';
    const events = evs.map(function (e) { return { date: e.date, text: e.text }; }).filter(function (e) { return e.text; });

    // Stable fingerprint for caching the AI analysis.
    const sig = require('crypto').createHash('sha1')
      .update(downDate + '|' + (backDate || 'open') + '|' + events.length + '|' + rootCause.slice(0, 40))
      .digest('hex').slice(0, 12);

    return {
      downDate: downDate,
      backDate: backDate,
      days: days,
      ongoing: !closed,
      reportedIssue: reportedIssue,
      rootCause: rootCause,
      vendor: vendor,
      sig: sig,
      events: events,
    };
  })
  // Keep cycles within the 3-month window (by their most recent activity).
  .filter(function (b) {
    const ref = b.backDate || b.downDate;
    const t = ref ? new Date(ref).getTime() : Date.now();
    return isNaN(t) || t >= cutoff;
  })
  // Newest first.
  .sort(function (a, b) {
    const ta = new Date(a.backDate || a.downDate).getTime() || 0;
    const tb = new Date(b.backDate || b.downDate).getTime() || 0;
    return tb - ta;
  });

  return out;
}

module.exports = { getUnitHistory, addEvent, closeRepair, detectTransitions, getAllHistory, archiveAndClearTimeline, sweepReturnedUnits, buildBreakdowns };
