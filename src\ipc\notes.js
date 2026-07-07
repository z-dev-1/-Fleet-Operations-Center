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
    ns[unitId] = u;
    store.save('notesStore', ns);
    // Notify renderer for instant refresh
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
      if (main) main.webContents.send('notes:updated', { unitId, timeline: u.timeline });
    } catch(e) {}
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

  // Find the last real update
  let lastRealIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRealUpdate(lines[i])) { lastRealIdx = i; break; }
  }

  if (lastRealIdx === -1) return timeline; // no real updates at all

  // Remove gap fillers that are BEFORE the last real update
  // (keep gap fillers AFTER the last real update — they're current/recent)
  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < lastRealIdx && isGapFiller(lines[i])) continue; // skip old gap fillers
    cleaned.push(lines[i]);
  }

  return cleaned.join('\n');
}

module.exports = {
  cleanTimeline, registerNotesIPC };
