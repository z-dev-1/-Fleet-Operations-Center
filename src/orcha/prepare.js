'use strict';
/**
 * prepare.js — Auto-Preparation Engine (Sprint 2, Module 4)
 *
 * Pre-builds work products that the operator reviews and approves:
 *   - Daily Notes drafts (from deep-scan AI)
 *   - Email body drafts (per operator/slot)
 *   - SharePoint row data (pre-staged)
 *   - WR payloads (vendor, urgency, description pre-filled)
 *
 * Runs after tracker in the sync pipeline. Does NOT send/execute anything.
 * Stores drafts in memory + emits to renderer for approval UI.
 *
 * Each draft has:
 *   - type: 'note' | 'email' | 'sp' | 'wr'
 *   - status: 'pending' | 'approved' | 'dismissed'
 *   - payload: pre-built data ready for execution
 *   - createdAt: ISO timestamp
 *   - unit: equipmentId (if applicable)
 */

const logger = require('../utils/logger')('prepare');
const store  = require('../store');

// ── Draft types ──────────────────────────────────────────────────────────────
const DRAFT_TYPE = {
  NOTE:  'note',
  EMAIL: 'email',
  SP:    'sp',
  WR:    'wr',
};

// ── Core preparation logic ───────────────────────────────────────────────────

function _prepareNoteDrafts(mergedRows, notesStore) {
  const drafts = [];
  const unavail = mergedRows.filter(r =>
    (r.lifecycleState || '').toLowerCase().includes('unavail')
  );

  for (const row of unavail) {
    // Only draft notes for units that already have AI analysis but need updating
    const notes = notesStore[row.equipmentId] || {};
    if (!row._orchaProcessed && !notes.notes) continue;  // skip if never analyzed

    // Check if note is stale (> 24h old)
    const noteAge = notes._lastAiCorrection
      ? (Date.now() - new Date(notes._lastAiCorrection).getTime()) / 3600000
      : Infinity;

    if (noteAge < 12) continue;  // fresh enough, no draft needed

    const draft = {
      type: DRAFT_TYPE.NOTE,
      unit: row.equipmentId,
      operator: row.operator || '',
      domicile: row.domicileSite || '',
      status: 'pending',
      summary: row.issueSummary || notes.notes || '',
      repairStatus: row.savedRepairStatus || notes.repairStatus || '',
      vendor: row.vendor || '',
      duration: row.workDuration || row.duration || '',
      createdAt: new Date().toISOString(),
    };
    drafts.push(draft);
  }

  return drafts;
}

function _prepareWRDrafts(mergedRows) {
  const drafts = [];

  for (const row of mergedRows) {
    // Units with high risk score but no open WR — draft a preventive WR
    const risk = parseInt(row.riskScore, 10) || 0;
    const openWR = parseInt(row.openUnplanned, 10) || 0;
    const isAvail = !(row.lifecycleState || '').toLowerCase().includes('unavail');

    if (isAvail && risk >= 70 && openWR === 0) {
      drafts.push({
        type: DRAFT_TYPE.WR,
        unit: row.equipmentId,
        operator: row.operator || '',
        domicile: row.domicileSite || '',
        status: 'pending',
        payload: {
          equipmentId: row.equipmentId,
          urgency: risk >= 85 ? 'High' : 'Medium',
          description: `Predictive maintenance recommended — risk score ${risk}%. ` +
            (row.insightsList && row.insightsList.length
              ? 'Insights: ' + row.insightsList.map(i => i.title || i).join(', ')
              : 'Schedule preventive inspection.'),
          vendor: '',  // user picks
          bodyType: row.bodyType || '',
          fuelType: row.fuelType || '',
        },
        riskScore: risk,
        createdAt: new Date().toISOString(),
      });
    }
  }

  return drafts;
}

function _prepareEmailDraft(mergedRows) {
  // Check if we're within 30 min of a scheduled email slot
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();

  // Load saved slots
  const settings = store.load('settings', {});
  const slots = settings.schedulerSlots && settings.schedulerSlots.email
    ? settings.schedulerSlots.email
    : [{ h: 8, m: 0 }, { h: 15, m: 15 }];

  // Find if we're approaching a slot (within 30 min)
  const approaching = slots.find(s => {
    const slotMin = s.h * 60 + s.m;
    const nowMin  = hh * 60 + mm;
    const diff    = slotMin - nowMin;
    return diff > 0 && diff <= 30;
  });

  if (!approaching) return [];

  // Count unavailable for the draft
  const unavailCount = mergedRows.filter(r =>
    (r.lifecycleState || '').toLowerCase().includes('unavail')
  ).length;

  return [{
    type: DRAFT_TYPE.EMAIL,
    status: 'pending',
    slot: approaching.label || (approaching.h + ':' + String(approaching.m).padStart(2, '0')),
    unitCount: mergedRows.length,
    unavailCount,
    approaching: true,
    minutesUntil: ((approaching.h * 60 + approaching.m) - (hh * 60 + mm)),
    createdAt: new Date().toISOString(),
  }];
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * runPrepare(mergedRows)
 * @returns {{ drafts: Array, summary: { notes, wr, email, sp, total } }}
 */
function runPrepare(mergedRows) {
  const notesStore = store.load('notesStore', {});

  const noteDrafts  = _prepareNoteDrafts(mergedRows, notesStore);
  const wrDrafts    = _prepareWRDrafts(mergedRows);
  const emailDrafts = _prepareEmailDraft(mergedRows);

  const allDrafts = [...noteDrafts, ...wrDrafts, ...emailDrafts];

  const summary = {
    notes: noteDrafts.length,
    wr:    wrDrafts.length,
    email: emailDrafts.length,
    sp:    0,  // SP drafts deferred to future iteration
    total: allDrafts.length,
  };

  if (allDrafts.length > 0) {
    logger.info(
      `Prepare: ${summary.total} drafts | ` +
      `📝${summary.notes} notes | 📋${summary.wr} WRs | 📧${summary.email} emails`
    );
  }

  return { drafts: allDrafts, summary };
}

module.exports = { runPrepare, DRAFT_TYPE };
