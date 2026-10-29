'use strict';
/**
 * src/utils/offsite-owner.js — an offsite belongs to ONE work request.
 *
 * The offsite (dealer Fleet Estimate / Service Request / DTNA case link) and the
 * dealer notes scraped from it are WR-level data. Before 2026-10-28 they were
 * stored per UNIT and only ever overwritten when a NEW offsite was found, never
 * cleared — so after a WO completed and a new WR opened, the old WO's offsite
 * (and its dealer notes, which feed the AI timeline) stayed on the unit
 * (B12260 / B62049 / B62064). `_offsiteWrId` records which WR the offsite came
 * from; callers keep it only while that WR is the unit's current WR.
 */

// Everything that describes / derives from the offsite link.
const OFFSITE_FIELDS = [
  'offsiteShopEventUrl', 'savedOffsiteUrl', 'offsiteShopEvent', 'savedOffsiteEvent',
  'asistSrUrl', 'asistLabel', 'asistSource', 'asistNotes', 'asistScrapedAt',
  'offsiteStage', 'offsiteStageDetail', 'offsiteStageSince', 'dealerName',
];

function offsiteUrlOf(row) {
  return (row && (row.offsiteShopEventUrl || row.savedOffsiteUrl || row.asistSrUrl)) || '';
}

// Blank every offsite field on the row (in place). Returns the URL that was removed.
function clearOffsite(row) {
  if (!row) return '';
  const was = offsiteUrlOf(row);
  for (const k of OFFSITE_FIELDS) if (k in row) row[k] = '';
  row._offsiteWrId = '';
  return was;
}

module.exports = { OFFSITE_FIELDS, offsiteUrlOf, clearOffsite };
