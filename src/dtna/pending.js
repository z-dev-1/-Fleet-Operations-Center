'use strict';
/**
 * src/dtna/pending.js — pure DTNA helpers for the team Pending Estimates collector
 * (src/scrapers/pending_est_sources.js; findings §2.2, §5.3, §6b).
 *
 * Works on dtnaCaseCache entries only: no network, no session. Requires only ./constants and ./join.
 * DTNA exposes no estimate amount field and no approval status (discovery D2/D4). A DTNA offsite record
 * has total = the amount of the newest approval post in the case comments ('Approved for $X'; best-effort
 * text extraction, null until one exists), fleetStatus '' and the current stage of the portal's pipeline (constants.CASE_STAGES:
 * Pre-Repair > Arrived > In-Repair > Post-Repair > Ready for Pickup > Closed) as repairStatus.
 * Ready for Pickup and Closed count as done offsite.
 */
const C = require('./constants');
const J = require('./join');

function _str(v) { return v == null ? '' : String(v); }
function _ms(v) {
  const ms = v ? Date.parse(String(v)) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

const CLOSED_RE = /closed|cancel/i;
const DONE_RE = /closed|complete|ready for pick ?up/i;
const DTNA_VENDOR_RE = /FREIGHTLINER|DAIMLER/i;

function _valid(e) { return !!e && typeof e === 'object' && C.CASE_ID_RE.test(_str(e.caseId)); }

const READY_INDEX = C.CASE_STAGES.indexOf('Ready for Pickup');
const CLOSED_INDEX = C.CASE_STAGES.indexOf('Closed');

/**
 * currentStage(entry) -> { name, index } on the portal's stage pipeline (constants.CASE_STAGES) | null.
 * The stepper's 'Current Stage' step wins when the entry has one, then the case status.
 */
function currentStage(entry) {
  const e = entry || {};
  for (const s of (Array.isArray(e.steps) ? e.steps : [])) {
    if (!s || typeof s !== 'object') continue;
    if (/current/i.test(_str(s.status)) || /current stage/i.test(_str(s.name))) {
      const st = C.caseStageOf(s.name);
      if (st) return st;
    }
  }
  return C.caseStageOf(e.caseStatus);
}

/** isCaseClosed(entry) -> the case is at the Closed stage, or its status says closed / cancelled. */
function isCaseClosed(entry) {
  const st = currentStage(entry);
  return (st && st.index === CLOSED_INDEX) || CLOSED_RE.test(_str(entry && entry.caseStatus));
}

/**
 * isCaseDone(entry) -> the dealer is done: stage Ready for Pickup or Closed. When the status is not on the
 * pipeline, falls back to the status text (closed / complete / ready for pickup) or offsiteStage 'ready'.
 */
function isCaseDone(entry) {
  if (!entry) return false;
  const st = currentStage(entry);
  if (st) return st.index >= READY_INDEX;
  return DONE_RE.test(_str(entry.caseStatus)) || _str(entry.offsiteStage) === 'ready';
}

/** isAwaitingApproval(entry) -> no approval status exists, so: the case is not done, closed or cancelled. */
function isAwaitingApproval(entry) {
  if (!_valid(entry)) return false;
  return !isCaseClosed(entry) && !isCaseDone(entry) && !/complete/i.test(_str(entry.caseStatus));
}

/** offsiteRecord(entry) -> the Pending Estimates offsite record for a DTNA case (findings §5.3). */
function offsiteRecord(entry) {
  const e = entry || {};
  const caseId = _str(e.caseId);
  const st = currentStage(e);
  const total = approvedTotal(e);
  return {
    source: 'dtna',
    caseId,
    url: C.CASE_ID_RE.test(caseId) ? C.caseUrl(caseId) : '',
    dealerName: _str(e.dealerName),
    fleetStatus: '',
    // The current stage on the portal's pipeline; the raw status when it is not a pipeline stage.
    repairStatus: st ? st.name : _str(e.caseStatus),
    stageIndex: st ? st.index : null,
    stage: _str(e.offsiteStage),
    stageStatus: '',
    stageSince: _str(e.stageSince),
    // The amount of the newest approval post ('Approved for $X'); null (shown as a dash) until one exists.
    total,
    totalSource: total != null ? 'approved' : 'none',
    updatedAt: _str(e.lastCommentAt),
    scrapedAt: _str(e.pulledAt),
    roNumber: _str(e.repairOrderNo),
    ok: true,
  };
}

/** mismatch(entry, rgOpen) -> { offsiteDone, statusMismatch } (done at the dealer while the RG WR is open). */
function mismatch(entry, rgOpen) {
  const offsiteDone = isCaseDone(entry);
  return { offsiteDone, statusMismatch: offsiteDone && !!rgOpen };
}

/** latestPulledAt(entries) -> newest pulledAt ISO | null. */
function latestPulledAt(entries) {
  let best = 0;
  let iso = null;
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const t = _ms(e && e.pulledAt);
    if (t > best) { best = t; iso = new Date(t).toISOString(); }
  }
  return iso;
}

// Approval posts in the case comments / feed: 'Approved for $3,778.83', 'Estimate Approved - $3,531.02',
// 'Approved $X'. Best-effort text extraction.
const APPROVED_RE = /approved(?:\s+for)?\s*[-:\u2013]?\s*\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i;

/**
 * approvedTotalOf(comments) -> { total, at } | null: the amount in the newest comment ({ text, at })
 * whose text is an approval post. Undated or equal dates keep list order (entry comments are newest first).
 */
function approvedTotalOf(comments) {
  let best = null;
  for (const c of (Array.isArray(comments) ? comments : [])) {
    if (!c || typeof c !== 'object') continue;
    const m = APPROVED_RE.exec(_str(c.text));
    if (!m) continue;
    const total = Math.round(Number(m[1].replace(/,/g, '')) * 100) / 100;
    if (!Number.isFinite(total) || total <= 0) continue;
    const ms = _ms(c.at);
    if (!best || ms > best.ms) best = { total, at: _str(c.at), ms };
  }
  return best ? { total: best.total, at: best.at } : null;
}

/** approvedTotal(entry) -> number | null: the cached approvedTotal, else parsed from the cached comments. */
function approvedTotal(entry) {
  const e = entry || {};
  const n = typeof e.approvedTotal === 'number' ? e.approvedTotal : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  const a = approvedTotalOf(e.comments);
  return a ? a.total : null;
}

const _wrId = (wo) => _str(wo && (wo.workRequestId || wo.id));

/**
 * joinCasesToWrs({ entries, openWos, wrDtnaCase, blockedWrIds, fleetRows }) -> { byWr: Map<wrId, entry>, unjoined }
 * Per case: open WRs whose assetDisplayName equals the case unit; else the open WRs of the fleet row whose
 * VIN last 6 equals the case serial. WRs in blockedWrIds (a Decisiv estimate) are never used.
 * Tie-break: the WR whose comments carry this case URL, then a FREIGHTLINER / DAIMLER vendor, then the
 * newest scheduledDateTime. A WR takes one case: the case its comments name, else a non-closed case,
 * else the newest lastCommentAt / pulledAt. Losing cases go to unjoined.
 */
function joinCasesToWrs(o) {
  const x = o || {};
  const entries = (Array.isArray(x.entries) ? x.entries : []).filter(_valid);
  const wrDtnaCase = x.wrDtnaCase instanceof Map ? x.wrDtnaCase : new Map();
  const blocked = x.blockedWrIds instanceof Set ? x.blockedWrIds : new Set();
  const openWos = (Array.isArray(x.openWos) ? x.openWos : []).filter((w) => w && _wrId(w) && !blocked.has(_wrId(w)));
  const fleetRows = (Array.isArray(x.fleetRows) ? x.fleetRows : []).filter((r) => r && typeof r === 'object');

  const pick = (entry) => {
    const u = J.normUnit(entry.unitId);
    let cands = u ? openWos.filter((w) => J.normUnit(w.assetDisplayName) === u) : [];
    if (!cands.length && entry.serial) {
      const s = J.normUnit(entry.serial);
      const eqs = new Set(fleetRows.filter((r) => J.vinTail(r.vin) && J.vinTail(r.vin) === s).map((r) => J.normUnit(r.equipmentId)).filter(Boolean));
      if (eqs.size) cands = openWos.filter((w) => eqs.has(J.normUnit(w.assetDisplayName)));
    }
    if (!cands.length) return null;
    const a = cands.find((w) => wrDtnaCase.get(_wrId(w)) === entry.caseId);
    if (a) return a;
    const b = cands.filter((w) => DTNA_VENDOR_RE.test(_str(w.vendor)));
    const pool = b.length ? b : cands;
    return pool.slice().sort((p, q) => (Number(q.scheduledDateTime) || 0) - (Number(p.scheduledDateTime) || 0))[0];
  };

  const better = (wrId, a, b) => {
    // true when case a should hold wrId over case b
    const named = wrDtnaCase.get(wrId);
    if (named === a.caseId && named !== b.caseId) return true;
    if (named === b.caseId && named !== a.caseId) return false;
    const ca = isCaseClosed(a);
    const cb = isCaseClosed(b);
    if (ca !== cb) return !ca;
    return _ms(a.lastCommentAt || a.pulledAt) > _ms(b.lastCommentAt || b.pulledAt);
  };

  const byWr = new Map();
  const unjoined = [];
  for (const entry of entries) {
    const wo = pick(entry);
    if (!wo) { unjoined.push(entry); continue; }
    const id = _wrId(wo);
    const cur = byWr.get(id);
    if (!cur) { byWr.set(id, entry); continue; }
    if (better(id, entry, cur)) { byWr.set(id, entry); unjoined.push(cur); } else unjoined.push(entry);
  }
  return { byWr, unjoined };
}

module.exports = { currentStage, isCaseClosed, isCaseDone, isAwaitingApproval, offsiteRecord, mismatch, latestPulledAt, joinCasesToWrs, approvedTotalOf, approvedTotal, DTNA_VENDOR_RE };
