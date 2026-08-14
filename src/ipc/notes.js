'use strict';
/**
 * ipc/notes.js - Unit notes CRUD IPC handlers
 * notes:get-unit, notes:get-all, notes:save-unit, notes:delete-unit
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #7 MED: notes:save-unit applies per-field length caps so an
 *                   unbounded notes blob cannot bloat the store indefinitely.
 *   - All handlers migrated to handle() wrapper.
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:notes');
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require('../utils/errors');

// ── Issue #7: field length caps ──────────────────────────────────────────────
const NOTES_MAX_LENGTHS = {
  equipmentId:         32,
  repairStatus:        128,
  primaryComponent:    128,
  salesforceCase:      64,
  salesforceCaseUrl:   512,
  offsiteShopEvent:    128,
  offsiteShopEventUrl: 512,
  asistSource:         32,
  asistLabel:          256,
  asistSrUrl:          512,
  asistScrapedAt:      32,
  dealerName:          128,
  subVendor:           128,
  notes:               4096,  // free-text field — generous but bounded
};

function _truncateField(val, field) {
  if (val === undefined || val === null) return undefined;
  const s   = String(val);
  const max = NOTES_MAX_LENGTHS[field];
  if (max && s.length > max) {
    logger.warn('notes:save-unit field truncated:', field, s.length, '->', max);
    return s.slice(0, max);
  }
  return s;
}

function registerNotesIPC() {
  handle('notes:get-unit', (_e, equipmentId) => {
    const s = store.load('notesStore', {});
    return s[equipmentId] || {};
  });

  handle('notes:get-all', () => store.load('notesStore', {}));

  handle('notes:add-timeline', async (_e, unitId, entry) => {
    const ns = store.load('notesStore', {});
    const u = ns[unitId] || {};
    u.timeline = u.timeline ? u.timeline + '\n' + entry : entry;
    // Clean up gap fillers
    if (cleanTimeline) u.timeline = cleanTimeline(u.timeline);
    // Track as a manually-confirmed entry (immutable truth) so a later Orcha
    // deep-scan regeneration can merge it back in instead of silently
    // discarding it when it rebuilds the timeline from raw vendor comments.
    u.manualEntries = Array.isArray(u.manualEntries) ? u.manualEntries : [];
    u.manualEntries.push(entry);
    ns[unitId] = u;
    store.save('notesStore', ns);
    // Mirror into fleetData row — this is the field the detail panel actually
    // reads (unit.repairTimeline). Without this, a manual add only lived in
    // notesStore and vanished the next time fleet data reloaded or a sync ran.
    const fd = store.load('fleetData', {});
    if (fd.rows) {
      const row = fd.rows.find(r => r.equipmentId === unitId);
      if (row) row.repairTimeline = u.timeline;
      store.save('fleetData', fd);
    }
    // Notify renderer for instant refresh
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
      if (main) main.webContents.send('notes:updated', { unitId, timeline: u.timeline });
    } catch(e) {}
    return { ok: true, timeline: u.timeline };
  });

  // ── Timeline hide/edit ──────────────────────────────────────────────────
  function _stripLineFromTimeline(timeline, entryText) {
    const sig = String(entryText || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
    if (!timeline || !sig) return timeline;
    return timeline.split('\n').filter(function (line) {
      const lineSig = line.replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
      return lineSig !== sig;
    }).join('\n');
  }

  function _mirrorTimelineToFleetData(unitId, timeline) {
    const fd = store.load('fleetData', {});
    if (fd.rows) {
      const row = fd.rows.find(r => r.equipmentId === unitId);
      if (row) row.repairTimeline = timeline;
      store.save('fleetData', fd);
    }
  }

  function _notifyTimelineUpdated(unitId, timeline) {
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
      if (main) main.webContents.send('notes:updated', { unitId, timeline });
    } catch (e) {}
  }

  // notes:hide-timeline-entry -- permanently suppresses a timeline line. Removes
  // it immediately from the live timeline + manualEntries[], and records its
  // text signature in hiddenEntries[] so src/orcha/deep-scan.js's
  // _filterHiddenEntries() strips any future AI-regenerated line matching the
  // same signature (date-stripped, case-insensitive) -- otherwise a hidden
  // AI-generated line would simply reappear verbatim on the next sync.
  handle('notes:hide-timeline-entry', async (_e, unitId, entryText) => {
    const ns = store.load('notesStore', {});
    const u = ns[unitId] || {};
    u.hiddenEntries = Array.isArray(u.hiddenEntries) ? u.hiddenEntries : [];
    u.hiddenEntries.push(entryText);
    u.timeline = _stripLineFromTimeline(u.timeline, entryText);
    if (Array.isArray(u.manualEntries)) {
      const sig = String(entryText || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
      u.manualEntries = u.manualEntries.filter(function (e) {
        return String(e || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase() !== sig;
      });
    }
    ns[unitId] = u;
    store.save('notesStore', ns);
    _mirrorTimelineToFleetData(unitId, u.timeline);
    _notifyTimelineUpdated(unitId, u.timeline);
    return { ok: true, timeline: u.timeline };
  });

  // notes:edit-timeline-entry -- rewords a timeline line permanently. The old
  // wording is hidden (see above) so it can never resurface from a future AI
  // regeneration, and the new wording is stored as a manual entry so it gets
  // the same rescan-survival guarantee as any other manually-confirmed line.
  handle('notes:edit-timeline-entry', async (_e, unitId, oldEntryText, newEntryText) => {
    const ns = store.load('notesStore', {});
    const u = ns[unitId] || {};

    let newLine = String(newEntryText || '').trim();
    if (!/^\d{2}\/\d{2}\s*[-\u2013]\s*/.test(newLine)) {
      const dateMatch = String(oldEntryText || '').match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*/);
      const now = new Date();
      const todayStr = (now.getMonth() + 1).toString().padStart(2, '0') + '/' + now.getDate().toString().padStart(2, '0');
      newLine = (dateMatch ? dateMatch[1] : todayStr) + ' - ' + newLine;
    }

    u.hiddenEntries = Array.isArray(u.hiddenEntries) ? u.hiddenEntries : [];
    u.hiddenEntries.push(oldEntryText);

    const oldSig = String(oldEntryText || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
    if (u.timeline) {
      let replaced = false;
      u.timeline = u.timeline.split('\n').map(function (line) {
        const lineSig = line.replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
        if (!replaced && lineSig === oldSig) { replaced = true; return newLine; }
        return line;
      }).join('\n');
      if (!replaced) u.timeline = u.timeline + '\n' + newLine;
    } else {
      u.timeline = newLine;
    }

    u.manualEntries = Array.isArray(u.manualEntries) ? u.manualEntries.filter(function (e) {
      return String(e || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase() !== oldSig;
    }) : [];
    u.manualEntries.push(newLine);

    ns[unitId] = u;
    store.save('notesStore', ns);
    _mirrorTimelineToFleetData(unitId, u.timeline);
    _notifyTimelineUpdated(unitId, u.timeline);
    return { ok: true, timeline: u.timeline };
  });

  // Issue #7: each field is length-capped before reaching the store
  handle('notes:save-unit', (_e, payload) => {
    const id = String((payload && payload.equipmentId) || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    if (id.length > NOTES_MAX_LENGTHS.equipmentId) {
      throw new ConfigError('equipmentId too long (max ' + NOTES_MAX_LENGTHS.equipmentId + ')', 'equipmentId');
    }

    store.update('notesStore', (s) => {
      const ex = s[id] || {};
      s[id] = {
        ...ex,
        equipmentId:         id,
        repairStatus:        _truncateField(payload.repairStatus        !== undefined ? payload.repairStatus        : ex.repairStatus        || '', 'repairStatus'),
        primaryComponent:    _truncateField(payload.primaryComponent    !== undefined ? payload.primaryComponent    : ex.primaryComponent    || '', 'primaryComponent'),
        salesforceCase:      _truncateField(payload.salesforceCase      !== undefined ? payload.salesforceCase      : ex.salesforceCase      || '', 'salesforceCase'),
        salesforceCaseUrl:   _truncateField(payload.salesforceCaseUrl   !== undefined ? payload.salesforceCaseUrl   : ex.salesforceCaseUrl   || '', 'salesforceCaseUrl'),
        offsiteShopEvent:    _truncateField(payload.offsiteShopEvent    !== undefined ? payload.offsiteShopEvent    : ex.offsiteShopEvent    || '', 'offsiteShopEvent'),
        offsiteShopEventUrl: _truncateField(payload.offsiteShopEventUrl !== undefined ? payload.offsiteShopEventUrl : ex.offsiteShopEventUrl || '', 'offsiteShopEventUrl'),
        asistSource:         _truncateField(payload.asistSource         !== undefined ? payload.asistSource         : ex.asistSource         || '', 'asistSource'),
        asistLabel:          _truncateField(payload.asistLabel          !== undefined ? payload.asistLabel          : ex.asistLabel          || '', 'asistLabel'),
        asistSrUrl:          _truncateField(payload.asistSrUrl          !== undefined ? payload.asistSrUrl          : ex.asistSrUrl          || '', 'asistSrUrl'),
        asistScrapedAt:      _truncateField(payload.asistScrapedAt      !== undefined ? payload.asistScrapedAt      : ex.asistScrapedAt      || '', 'asistScrapedAt'),
        dealerName:          _truncateField(payload.dealerName          !== undefined ? payload.dealerName          : ex.dealerName          || '', 'dealerName'),
        subVendor:           _truncateField(payload.subVendor           !== undefined ? payload.subVendor           : ex.subVendor           || '', 'subVendor'),
        notes:               _truncateField(payload.notes               !== undefined ? payload.notes               : ex.notes              || '', 'notes'),
        updatedAt:           new Date().toISOString(),
      };
      return s;
    });

    const note = (store.load('notesStore', {}))[id];
    logger.info('Notes saved for unit:', id);
    return { ok: true, note };
  });

  handle('notes:delete-unit', (_e, equipmentId) => {
    const id = String(equipmentId || '').trim();
    if (!id) throw new ConfigError('equipmentId is required', 'equipmentId');
    store.update('notesStore', (s) => { delete s[id]; return s; });
    logger.info('Notes deleted for unit:', id);
    return { ok: true };
  });

  logger.info('Notes IPC handlers registered');
}


/**
 * Clean timeline: remove gap fillers between real updates.
 * Gap fillers = "[no update logged]" and "Requested repair/estimate update from vendor"
 * Rule: once a real update exists after gap fillers, remove the fillers between the two real updates.
 * Keep only the most recent gap fillers (after the last real update).
 */
function cleanTimeline(timeline) {
  if (!timeline) return timeline;
  const lines = timeline.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return timeline;

  const isGapFiller = (line) => {
    const lower = line.toLowerCase();
    return lower.includes('[no update logged]') ||
           lower.includes('requested repair update from vendor') ||
           lower.includes('requested estimate update from vendor') ||
           lower.includes('requested repair status update from vendor') ||
           lower.includes('requested estimate submission') ||
           lower.includes('requested updated etc') ||
           (lower.includes('requested') && lower.includes('update') && lower.includes('vendor'));
  };

  const isRealUpdate = (line) => !isGapFiller(line) && line.length > 5;

  // If any real update exists, drop ALL gap fillers — they add noise once
  // there is substantive content to read.
  const hasAnyReal = lines.some(isRealUpdate);
  if (!hasAnyReal) return timeline; // nothing but gap fillers — keep as-is

  const cleaned = lines.filter(l => !isGapFiller(l));
  return cleaned.join('\n');
}

module.exports = {
  cleanTimeline, registerNotesIPC };
