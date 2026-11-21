'use strict';
/**
 * src/dtna/join.js — pure RG <-> DTNA join by unit number (findings §2.2).
 *
 * Unit match first (normUnit), then VIN last 6 vs DTNA serial. A fleet row's offsite is only ever
 * written when it is empty or already a DTNA case URL (canWriteDtnaOffsite).
 */
const C = require('./constants');
const { offsiteUrlOf } = require('../utils/offsite-owner');

function _str(v) { return v == null ? '' : String(v); }

/** normUnit(s) -> trimmed, upper case, no spaces, no leading '#'. Leading zeros are kept. */
function normUnit(s) {
  return _str(s).trim().toUpperCase().replace(/\s+/g, '').replace(/^#+/, '');
}

/** vinTail(vin) -> last 6 chars, upper case ('' when blank). */
function vinTail(vin) {
  const v = normUnit(vin);
  return v ? v.slice(-6) : '';
}

/** caseIdFromUrl(url) -> the DTNA case id in a case URL | ''. */
function caseIdFromUrl(url) {
  const m = C.DTNA_CASE_URL_RE.exec(_str(url));
  return m && C.CASE_ID_RE.test(m[1]) ? m[1] : '';
}

function isDtnaCaseUrl(url) { return !!caseIdFromUrl(url); }

function _ms(v) {
  const ms = v ? Date.parse(String(v)) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function _isClosed(entry) { return /closed/i.test(_str(entry && entry.caseStatus)); }

/**
 * findCaseForRow(row, entries) -> the cached case entry for a fleet row | null.
 * Unit match, else VIN tail vs serial. Tie-break: the row's offsite case id, then a non-closed
 * status, then the newest lastCommentAt / pulledAt.
 */
function findCaseForRow(row, entries) {
  if (!row || !Array.isArray(entries)) return null;
  const list = entries.filter((e) => e && typeof e === 'object' && C.CASE_ID_RE.test(_str(e.caseId)));
  const u = normUnit(row.equipmentId);
  let cands = u ? list.filter((e) => normUnit(e.unitId) === u) : [];
  if (!cands.length) {
    const vt = vinTail(row.vin);
    if (vt) cands = list.filter((e) => (e.serial && normUnit(e.serial) === vt) || (e.vinTail && normUnit(e.vinTail) === vt));
  }
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const rowCase = caseIdFromUrl(offsiteUrlOf(row));
  if (rowCase) {
    const hit = cands.find((e) => e.caseId === rowCase);
    if (hit) return hit;
  }
  const open = cands.filter((e) => !_isClosed(e));
  const pool = open.length ? open : cands;
  return pool.slice().sort((a, b) => (_ms(b.lastCommentAt || b.pulledAt) - _ms(a.lastCommentAt || a.pulledAt)))[0];
}

function _wrsOf(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  out.push({
    row, wrId: _str(row.workRequestId), vendor: _str(row.vendor), created: row.created,
    offsiteUrl: offsiteUrlOf(row), conversation: _str(row.fullConversation),
  });
  for (const w of (Array.isArray(row._secondaryWRs) ? row._secondaryWRs : [])) {
    if (!w || typeof w !== 'object' || !w.workRequestId) continue;
    if (w._wrType === 'planned' || w.completed) continue;
    out.push({ row, wrId: _str(w.workRequestId), vendor: _str(w.vendor), created: w.created, offsiteUrl: '', conversation: _str(w.fullConversation) });
  }
  return out.filter((w) => w.wrId);
}

/**
 * pickWrForCase(entry, rows) -> { row, wrId } | null   (findings §2.2 rules 1-3)
 * 1. rows whose unit equals the case unit; 2. else VIN tail equals the case serial;
 * 3. several open unplanned WRs: (a) the one whose offsite/comments carry this case id,
 *    (b) a FREIGHTLINER/DAIMLER vendor, (c) the newest.
 */
function pickWrForCase(entry, rows) {
  if (!entry || !Array.isArray(rows)) return null;
  const list = rows.filter((r) => r && typeof r === 'object');
  const u = normUnit(entry.unitId);
  let cand = u ? list.filter((r) => normUnit(r.equipmentId) === u) : [];
  if (!cand.length && entry.serial) {
    const s = normUnit(entry.serial);
    cand = list.filter((r) => vinTail(r.vin) && vinTail(r.vin) === s);
  }
  const wrs = [].concat(...cand.map(_wrsOf));
  if (!wrs.length) return null;
  const pick = (w) => ({ row: w.row, wrId: w.wrId });
  if (wrs.length === 1) return pick(wrs[0]);
  const id = _str(entry.caseId);
  if (id) {
    const a = wrs.find((w) => caseIdFromUrl(w.offsiteUrl) === id || (w.conversation && w.conversation.includes(id)));
    if (a) return pick(a);
  }
  const b = wrs.filter((w) => /FREIGHTLINER|DAIMLER/i.test(w.vendor));
  const pool = b.length ? b : wrs;
  return pick(pool.slice().sort((x, y) => _ms(y.created) - _ms(x.created))[0]);
}

/** canWriteDtnaOffsite(row) -> true when the row's offsite is empty or already a DTNA case URL. */
function canWriteDtnaOffsite(row) {
  if (!row || typeof row !== 'object') return false;
  const url = offsiteUrlOf(row);
  return !url || isDtnaCaseUrl(url);
}

module.exports = { normUnit, vinTail, caseIdFromUrl, isDtnaCaseUrl, findCaseForRow, pickWrForCase, canWriteDtnaOffsite };
