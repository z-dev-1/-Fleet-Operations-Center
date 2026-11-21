'use strict';
/**
 * src/dtna/pending.js — pure DTNA helpers for the team Pending Estimates collector
 * (src/scrapers/pending_est_sources.js; findings §2.2, §5.3, §6b).
 *
 * Works on dtnaCaseCache entries only: no network, no session. Requires only ./constants and ./join.
 * DTNA exposes no estimate amount and no approval status (discovery D2/D4): a DTNA offsite record has
 * total null, fleetStatus '' and the case status as repairStatus.
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

/** isCaseClosed(entry) -> the case status says closed / cancelled. */
function isCaseClosed(entry) { return CLOSED_RE.test(_str(entry && entry.caseStatus)); }

/** isCaseDone(entry) -> the dealer is done: closed / complete / ready for pickup, or stage 'ready'. */
function isCaseDone(entry) {
  if (!entry) return false;
  return DONE_RE.test(_str(entry.caseStatus)) || _str(entry.offsiteStage) === 'ready';
}

/** isAwaitingApproval(entry) -> no approval status exists, so: the case is not closed / complete / cancelled. */
function isAwaitingApproval(entry) {
  if (!_valid(entry)) return false;
  return !isCaseClosed(entry) && !/complete/i.test(_str(entry.caseStatus));
}

/** offsiteRecord(entry) -> the Pending Estimates offsite record for a DTNA case (findings §5.3). */
function offsiteRecord(entry) {
  const e = entry || {};
  const caseId = _str(e.caseId);
  return {
    source: 'dtna',
    caseId,
    url: C.CASE_ID_RE.test(caseId) ? C.caseUrl(caseId) : '',
    dealerName: _str(e.dealerName),
    fleetStatus: '',
    repairStatus: _str(e.caseStatus),
    stage: _str(e.offsiteStage),
    stageStatus: '',
    stageSince: _str(e.stageSince),
    total: null,
    totalSource: 'none',
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

module.exports = { isCaseClosed, isCaseDone, isAwaitingApproval, offsiteRecord, mismatch, latestPulledAt, joinCasesToWrs, DTNA_VENDOR_RE };
