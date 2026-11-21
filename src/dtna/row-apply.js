'use strict';
/**
 * src/dtna/row-apply.js — write a pulled DTNA case onto a fleet row (in place).
 *
 * Touches only OFFSITE_FIELDS (src/utils/offsite-owner.js) plus _offsiteWrId, and refuses a row whose
 * offsite belongs to another vendor (Decisiv estimate / service request).
 */
const C = require('./constants');
const { canWriteDtnaOffsite, caseIdFromUrl } = require('./join');

function _str(v) { return v == null ? '' : String(v); }

function _wrCreatedAt(row, wrId) {
  if (wrId && _str(row.workRequestId) !== _str(wrId) && Array.isArray(row._secondaryWRs)) {
    const w = row._secondaryWRs.find((s) => s && _str(s.workRequestId) === _str(wrId));
    if (w) return w.created || null;
  }
  return row.created || null;
}

/**
 * applyCaseToRow(row, entry, {now, wrId, extract}) -> {applied, reason}
 * extract: run extractDtnaFeed into row.offsiteFacts (caller passes the perf-flag value).
 */
function applyCaseToRow(row, entry, opts) {
  const o = opts || {};
  if (!row || typeof row !== 'object' || !entry || !C.CASE_ID_RE.test(_str(entry.caseId))) return { applied: false, reason: 'no-entry' };
  if (!canWriteDtnaOffsite(row)) return { applied: false, reason: 'non-dtna-offsite' };
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
  const url = C.caseUrl(entry.caseId);
  if (!row.offsiteShopEventUrl || caseIdFromUrl(row.offsiteShopEventUrl) !== entry.caseId) row.offsiteShopEventUrl = url;
  if (!row.savedOffsiteUrl || caseIdFromUrl(row.savedOffsiteUrl) !== entry.caseId) row.savedOffsiteUrl = url;
  row.asistSrUrl = url;
  row.asistSource = 'dtna';
  row.asistLabel = 'DTNA Case';
  row.asistNotes = _str(entry.offsiteText);
  row.asistScrapedAt = _str(entry.pulledAt);
  row.offsiteStage = _str(entry.offsiteStage);
  row.offsiteStageDetail = _str(entry.caseStatus);
  row.offsiteStageSince = _str(entry.stageSince);
  row._stageReadAt = new Date(nowMs).toISOString();
  if (!row.dealerName && entry.dealerName) row.dealerName = _str(entry.dealerName);
  if (!row.dealerCode && entry.dealerCode) row.dealerCode = _str(entry.dealerCode);
  const wrId = _str(o.wrId) || _str(row.workRequestId);
  if (o.extract) {
    row.offsiteFacts = require('../repair-intel/wo-extract').extractDtnaFeed(_str(entry.thread), { now: nowMs, wrCreatedAt: _wrCreatedAt(row, wrId) });
  }
  row._offsiteWrId = wrId;
  return { applied: true, reason: 'ok' };
}

module.exports = { applyCaseToRow };
