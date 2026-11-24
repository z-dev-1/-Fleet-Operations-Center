'use strict';
/**
 * autopilot/detect.js — deterministic detection (§B6 with plan R1 and R8). Pure.
 *
 * detect(rows, ctx) -> [{ unitId, equipmentId, domicile, reasons[], openedBy|null,
 *                         daysDown, downSince, eta, buildAtMs, syncedAtMs }]
 *   Rows are filtered with scope.inScopeNew FIRST; reason codes, cache lookups
 *   and riRepeat run only for in-scope rows. openedBy is null when no opening
 *   rule applies (the candidate then only tags an existing open case).
 *
 * ctx: {
 *   scope (scope.buildScope), oosDays, features, staleDays, now, today?,
 *   buildAtMs (fleet-freshness lastOkAt, R1), syncedAt (fleetData.syncedAt),
 *   isDown(row), canonical(row) -> record|null,
 *   longDwell: { store: longDwellStore doc, csvRows: longDwellCsv.rows },
 *   cacheIndex: { dtna: Map|fn(unit) -> entries[], decisiv: Map|fn(caseId) -> entry },
 *   riRepeat(equipmentId) -> array (repair-intel repeat offenders for the unit)
 * }
 */

const {
  REASONS: R, isAuthoritativeEtcTag, normUnit, unitIndex, UNIT_KEY_OF, localDate,
} = require('./constants');
const { inScopeNew } = require('./scope');
const { toMs, isoDate, newestLoggedUpdate } = require('./updates');

const DAY = 86400000;

/** "Nd Nh Nm" (any part may be missing) -> days, or null. */
function parseWorkDuration(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const re = /(\d+(?:\.\d+)?)\s*([dhm])/gi;
  let any = false;
  let days = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    any = true;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    days += u === 'd' ? n : (u === 'h' ? n / 24 : n / 1440);
  }
  return any ? days : null;
}

/** R1: workDuration + (now - (buildAtMs ?? syncedAt)); else time since the WR was created; else null. */
function daysDownOf(row, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const base = Number.isFinite(c.buildAtMs) ? c.buildAtMs : toMs(c.syncedAt);
  const wd = parseWorkDuration(row && row.workDuration);
  if (wd != null) return wd + (base != null ? Math.max(0, now - base) / DAY : 0);
  const created = toMs(row && row.created);
  if (created != null) return Math.max(0, now - created) / DAY;
  return null;
}

function _lookup(src, key) {
  if (!src || key == null || key === '') return undefined;
  if (typeof src === 'function') return src(key);
  if (src instanceof Map) return src.get(key);
  if (typeof src === 'object') return src[key];
  return undefined;
}
function _arr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
function _lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function _nonEmpty(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return ['items', 'offenders', 'components'].some((k) => Array.isArray(v[k]) && v[k].length > 0);
  return false;
}

function _dtnaEntries(row, ctx, unit) { return _arr(_lookup(ctx.cacheIndex && ctx.cacheIndex.dtna, unit)); }
function _decisivEntry(row, ctx) {
  const id = row && row.decisivCaseId;
  return id ? _lookup(ctx.cacheIndex && ctx.cacheIndex.decisiv, String(id)) || null : null;
}

/**
 * etaStatus(row, cacheEtcs, today, refMs) -> { status, date, source, statedAt }
 * cacheEtcs: [{ date, source }] from the DTNA / Decisiv caches.
 * Exactly one of VERIFIED_OVERDUE | PAST_UNVERIFIED | TODAY | FUTURE | NEGATED | NOT_PROVIDED.
 */
function etaStatus(row, cacheEtcs, today, refMs) {
  const r = row || {};
  const fe = r._factEtc && typeof r._factEtc === 'object' ? r._factEtc : { state: 'none' };
  const rowEtc = isoDate(r.repairEtc, refMs);
  const rowSrc = _lc(r.repairEtcSource) || 'notes';
  const feDate = isoDate(fe.date, refMs);
  const statedAt = fe.statedAt || null;

  if (fe.state === 'missed' || r.etcMissed === true) {
    return { status: 'VERIFIED_OVERDUE', date: feDate || rowEtc, source: fe.state === 'missed' ? (fe.source || 'wo-facts') : rowSrc, statedAt };
  }
  if (rowEtc && rowEtc < today && isAuthoritativeEtcTag(r.repairEtcSource) && !r.completed) {
    return { status: 'VERIFIED_OVERDUE', date: rowEtc, source: rowSrc, statedAt };
  }
  const dates = [];
  if (rowEtc) dates.push({ date: rowEtc, source: rowSrc });
  if (feDate) dates.push({ date: feDate, source: fe.source || 'wo-facts' });
  for (const c of cacheEtcs || []) {
    const d = c && isoDate(c.date, refMs);
    if (d) dates.push({ date: d, source: c.source || 'cache' });
  }
  const past = dates.filter((d) => d.date < today).sort((a, b) => (a.date < b.date ? 1 : -1));
  if (past.length) return { status: 'PAST_UNVERIFIED', date: past[0].date, source: past[0].source, statedAt };
  const future = dates.filter((d) => d.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (future.length) return { status: future[0].date === today ? 'TODAY' : 'FUTURE', date: future[0].date, source: future[0].source, statedAt };
  if (fe.state === 'today' || fe.state === 'future') return { status: fe.state === 'today' ? 'TODAY' : 'FUTURE', date: feDate, source: fe.source || 'wo-facts', statedAt };
  if (fe.negated === true || fe.state === 'negated') return { status: 'NEGATED', date: null, source: fe.source || 'wo-facts', statedAt };
  return { status: 'NOT_PROVIDED', date: null, source: null, statedAt: null };
}

const OOS_OPENING = Object.freeze([R.DWELL_EXCEEDED, R.ETA_OVERDUE_VERIFIED, R.STATUS_CONFLICT, R.REPAIRED_UNVERIFIED]);

function _codes(reasons) { return new Set((reasons || []).map((r) => (r && typeof r === 'object' ? r.code : r))); }

/** Opening rule (§B6): 'oos_rule' | 'hard_condition' | 'long_dwell' | null. */
function openingRule(reasons, features) {
  const f = features || {};
  const c = _codes(reasons);
  if (f.oosInvestigation) {
    if (c.has(R.DWELL_EXCEEDED)) return 'oos_rule';
    if (c.has(R.ETA_OVERDUE_VERIFIED) || c.has(R.STATUS_CONFLICT) || c.has(R.REPAIRED_UNVERIFIED)) return 'hard_condition';
  }
  if (f.longDwellInvestigation && c.has(R.LONG_DWELL_LISTED)) return 'long_dwell';
  return null;
}

/** R8: true when at least one enabled opening rule applies to the current reasons. */
function openingRulesApply(reasons, features) {
  const f = features || {};
  const c = _codes(reasons);
  if (f.oosInvestigation && OOS_OPENING.some((x) => c.has(x))) return true;
  return !!(f.longDwellInvestigation && c.has(R.LONG_DWELL_LISTED));
}

/** reasonsFor(row, ctx, idx) -> { reasons[], daysDown, eta } for one in-scope row. */
function reasonsFor(row, ctx, idx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const today = c.today || localDate(now);
  const staleDays = Number.isFinite(c.staleDays) ? c.staleDays : 3;
  const staleMs = staleDays * DAY;
  const unit = normUnit(row.equipmentId);
  const down = typeof c.isDown === 'function' ? !!c.isDown(row) : false;
  const canon = typeof c.canonical === 'function' ? (c.canonical(row) || null) : null;
  const canonStatus = canon ? canon.status : null;
  const dtna = _dtnaEntries(row, c, unit);
  const dec = _decisivEntry(row, c);
  const out = [];
  const add = (code, fields, detail) => out.push(detail ? { code, fields, detail } : { code, fields });

  const daysDown = daysDownOf(row, c);
  if (down) add(R.OOS, ['lifecycleState']);
  if (down && daysDown == null) add(R.DOWN_SINCE_UNKNOWN, ['workDuration', 'created']);
  if (down && daysDown != null && daysDown >= c.oosDays) add(R.DWELL_EXCEEDED, ['workDuration'], { daysDown: Math.round(daysDown * 100) / 100 });

  const ldStoreKeys = idx.ldStore.get(unit) || [];
  const ldCsvKeys = idx.ldCsv.get(unit) || [];
  if (ldStoreKeys.length || ldCsvKeys.length) add(R.LONG_DWELL_LISTED, ['longDwell']);

  const cacheEtcs = [];
  for (const e of dtna) if (e && (e.repairEtc || e.etc)) cacheEtcs.push({ date: e.repairEtc || e.etc, source: 'offsiteevent' });
  if (dec && (dec.repairEtc || dec.etc)) cacheEtcs.push({ date: dec.repairEtc || dec.etc, source: 'decisiv' });
  const eta = etaStatus(row, cacheEtcs, today, now);
  if (eta.status === 'VERIFIED_OVERDUE') add(R.ETA_OVERDUE_VERIFIED, ['repairEtc', '_factEtc'], { date: eta.date, source: eta.source });
  else if (eta.status === 'PAST_UNVERIFIED') add(R.ETA_PAST_UNVERIFIED, ['repairEtc', '_factEtc'], { date: eta.date, source: eta.source });
  else if (eta.status === 'NOT_PROVIDED' && down) add(R.ETA_NOT_PROVIDED, ['repairEtc', '_factEtc']);

  // Update times: never _convFetchedAt / _stageReadAt (app fetch times).
  const upd = [toMs(row.offsiteStageSince), newestLoggedUpdate(row.fullConversation, c.syncedAt)];
  for (const e of dtna) upd.push(toMs(e && e.lastCommentAt));
  const known = upd.filter((x) => x != null);
  let stale = false;
  if (canon && canon.stale === true) stale = true;
  else if (known.length) stale = now - Math.max(...known) > staleMs;
  else stale = daysDown != null && daysDown >= staleDays;
  if (stale) add(R.UPDATE_STALE, ['offsiteStageSince', 'fullConversation', 'dtna.lastCommentAt']);
  if (down && ldStoreKeys.length) {
    const ats = ldStoreKeys.map((k) => toMs(c.longDwell.store[k] && c.longDwell.store[k].updatedAt)).filter((x) => x != null);
    if (ats.length && now - Math.max(...ats) > staleMs) add(R.ANNOTATION_STALE, ['longDwell.updatedAt']);
  }

  const parts = _lc(row.partsStatus);
  if (canonStatus === 'awaiting_parts' || parts === 'ordered' || parts === 'backorder') add(R.WAITING_PARTS, ['canonical.status', 'partsStatus']);
  const stage = _lc(row.offsiteStage);
  if (canonStatus === 'awaiting_estimate_approval' || stage === 'approval') add(R.WAITING_ESTIMATE_APPROVAL, ['canonical.status', 'offsiteStage']);
  if ((row.serviceState === 'Created' || row.subState === 'Created' || row.subState === 'Waiting for work order') && !stage && !row.vendorWorkOrderId) {
    add(R.AWAITING_SCHEDULING, ['serviceState', 'subState']);
  }

  const dtnaStage = dtna.map((e) => _lc(e && (e.offsiteStage || e.stage))).find(Boolean) || '';
  const decStage = dec ? _lc(dec.stage) : '';
  if ((Number(row.canonicalConflictCount) > 0) || (Number(row.factConflicts) > 0) || (dtnaStage && decStage && dtnaStage !== decStage)) {
    add(R.STATUS_CONFLICT, ['canonicalConflictCount', 'factConflicts', 'dtna.stage', 'decisiv.stage']);
  }
  if (down && (canonStatus === 'ready_for_pickup' || stage === 'ready' || dtnaStage === 'ready' || decStage === 'ready' || !!row.completed)) {
    add(R.REPAIRED_UNVERIFIED, ['canonical.status', 'offsiteStage', 'dtna.stage', 'decisiv.stage', 'completed']);
  }
  if (typeof c.riRepeat === 'function' && _nonEmpty(c.riRepeat(row.equipmentId))) add(R.RECURRING_DEFECT, ['repair_intel.repeat']);

  return { reasons: out, daysDown, eta };
}

function detect(rows, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const scope = c.scope;
  const inScope = [];
  for (const row of rows || []) if (inScopeNew(row, scope, c.isDown)) inScope.push(row);
  if (!inScope.length) return [];
  const ld = c.longDwell || {};
  const idx = {
    ldStore: unitIndex(ld.store, UNIT_KEY_OF.longDwellStore),
    ldCsv: unitIndex(ld.csvRows, UNIT_KEY_OF.longDwellCsvRows),
  };
  const ctx2 = Object.assign({}, c, { now, longDwell: { store: ld.store || {}, csvRows: ld.csvRows || {} } });
  const buildAtMs = Number.isFinite(c.buildAtMs) ? c.buildAtMs : null;
  const syncedAtMs = toMs(c.syncedAt);
  const out = [];
  for (const row of inScope) {
    const r = reasonsFor(row, ctx2, idx);
    out.push({
      unitId: normUnit(row.equipmentId),
      equipmentId: row.equipmentId,
      domicile: normUnit(row.domicileSite) || null,
      reasons: r.reasons,
      openedBy: openingRule(r.reasons, c.features),
      daysDown: r.daysDown,
      downSince: r.daysDown == null ? null : Math.round(now - r.daysDown * DAY),
      eta: r.eta,
      buildAtMs,
      syncedAtMs,
    });
  }
  return out;
}

module.exports = { detect, reasonsFor, etaStatus, daysDownOf, parseWorkDuration, openingRule, openingRulesApply, OOS_OPENING };
