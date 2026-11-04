'use strict';
/**
 * orcha/wbr_snapshot.js — Weekly Business Review (WBR) metric snapshots + history
 *
 * The WBR previously had ONLY current-week data, so its "Prior-Week / T6W"
 * bullet was hardcoded to "comparison not available — enter manually" and the
 * AI was explicitly told the tool stores no history. This module fixes that at
 * the root: it CAPTURES a weekly snapshot of the per-site + fleet-total down
 * metrics, keyed by ISO Monday-week, so a real week-over-week (WoW) and
 * trailing-6-week (T6W) comparison can be computed later.
 *
 * Week boundary: Monday. A snapshot is labelled by the Monday that starts its
 * ISO week (e.g. "2026-W41" / weekStart "2026-10-05"). Capture is idempotent
 * per ISO week — the latest capture in a given week overwrites that week's
 * entry (latest-wins), so re-syncs during the week keep the snapshot current
 * without creating duplicates.
 *
 * The metrics here MIRROR the renderer's _wbrStats / _getWBRSites / location
 * classification in renderer/src/js/views/daily-call.js so the captured history
 * is apples-to-apples with what the WBR shows live. Snapshots always cover the
 * WHOLE fleet (unscoped) — the UI scope box must not shrink the recorded truth.
 *
 * Persistence: store slice 'wbrHistory' (rolling MAX_WEEKS). Shape:
 *   { weeks: [ WeekSnapshot ... ], updatedAt }
 * WeekSnapshot:
 *   { week: 'YYYY-Www', weekStart: 'YYYY-MM-DD', capturedAt: ISO,
 *     total: SiteMetrics, sites: { '<OP/SITE>': SiteMetrics } }
 * SiteMetrics:
 *   { down, byFuel:{fuel:n}, location:{onsite,oem,unassigned,other},
 *     byVendor:{vendor:n}, pmFlagged:n, pmUnits:[id], canon:{status:n},
 *     canonStale, waitingUs, units:[id] }
 */

const logger = require('../utils/logger')('wbr-snapshot');
const store  = require('../store');

const MAX_WEEKS = 26; // ~6 months of history; T6W needs 6, keep headroom.

// ── Vendor / location classification (kept in lockstep with daily-call.js) ────
const OEM_VENDOR_RE    = /volvo|kenworth|peterbilt|paccar|freightliner|daimler|international|mack|cei|dealer|asist/i;
const ONSITE_VENDOR_RE = /amerit|\bta\b|travel\s*centers|cox|velociti|fleetnet|mobile|onsite|road\s*ready/i;
const PM_RE            = /\bpm\b|prevent? ?maintenance|inspection|pm-?[abx]/i;

function locationClass(vendor) {
  const v = String(vendor || '').trim();
  if (!v || v === '--' || /unassigned/i.test(v)) return 'unassigned';
  if (OEM_VENDOR_RE.test(v)) return 'oem';
  if (ONSITE_VENDOR_RE.test(v)) return 'onsite';
  return 'other';
}

// ── ISO Monday-week helpers ───────────────────────────────────────────────────
// Returns the Monday (00:00 local) that starts the week containing `d`.
function mondayOf(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = dt.getDay();              // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1 - dow); // shift back to Monday
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ISO-8601 week number of the Monday that starts the week.
function isoWeekKey(monday) {
  // Thursday of this week determines the ISO year/week.
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const isoYear = thursday.getFullYear();
  const jan1 = new Date(isoYear, 0, 1);
  const week = Math.ceil((((thursday - jan1) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// Coerce an input to a Date interpreted in LOCAL time. A bare 'YYYY-MM-DD'
// string parses as UTC midnight (JS spec), which in a negative-offset timezone
// lands on the PREVIOUS local day and would pick the wrong Monday-week. Parse
// date-only strings as local midnight; pass everything else through as-is.
function _toLocalDate(date) {
  if (date == null) return new Date();
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return new Date(date);
}

// Public: the week identity for a given date (defaults to now).
function weekIdFor(date) {
  const monday = mondayOf(_toLocalDate(date));
  return { week: isoWeekKey(monday), weekStart: ymd(monday) };
}

// ── Which rows count as "down" (mirrors _getWBRSites OOS gate) ─────────────────
function isDown(r) {
  const lifecycleDown = String(r.lifecycleState || '').toLowerCase().includes('unavail');
  const canonDown =
    !!(r.canonicalFlags && r.canonicalFlags.indexOf && r.canonicalFlags.indexOf('down') > -1) ||
    (r.canonicalStatus && r.canonicalStatus !== 'available' && r.canonicalStatus !== 'unknown' && r.canonicalStale);
  return lifecycleDown || !!canonDown;
}

function siteKeyOf(r) {
  const op = String(r.operator || '').toUpperCase();
  const site = String(r.domicileSite || '').toUpperCase();
  return (op && site) ? op + '/' + site : (site || op || 'Unknown');
}

// ── Metric computation (mirrors _wbrStats) ────────────────────────────────────
function _emptyMetrics() {
  return {
    down: 0,
    byFuel: {},
    location: { onsite: 0, oem: 0, unassigned: 0, other: 0 },
    byVendor: {},
    pmFlagged: 0,
    pmUnits: [],
    canon: {},
    canonStale: 0,
    waitingUs: 0,
    units: [],
  };
}

function _accumulate(m, u) {
  m.down++;
  m.units.push(u.equipmentId);
  const fuel = (String(u.fuelType || 'Unknown').trim()) || 'Unknown';
  m.byFuel[fuel] = (m.byFuel[fuel] || 0) + 1;
  const vendor = (u.vendor && String(u.vendor).trim() && u.vendor !== '--') ? String(u.vendor).trim() : 'Unassigned';
  m.byVendor[vendor] = (m.byVendor[vendor] || 0) + 1;
  const loc = locationClass(u.vendor);
  m.location[loc] = (m.location[loc] || 0) + 1;
  if (PM_RE.test((u.lifecycleReason || '') + ' ' + (u.issueDetails || ''))) {
    m.pmFlagged++;
    m.pmUnits.push(u.equipmentId);
  }
  if (u.canonicalStatus) {
    const s = String(u.canonicalStatus);
    m.canon[s] = (m.canon[s] || 0) + 1;
    if (u.canonicalStale) m.canonStale++;
    if (u.canonicalWaitingOn === 'us') m.waitingUs++;
  }
}

/**
 * computeWeekMetrics(rows) — build per-site + fleet-total down metrics over the
 * WHOLE fleet (unscoped). Returns { total: SiteMetrics, sites: {key:SiteMetrics} }.
 */
function computeWeekMetrics(rows) {
  const total = _emptyMetrics();
  const sites = {};
  for (const r of (rows || [])) {
    if (!isDown(r)) continue;
    _accumulate(total, r);
    const key = siteKeyOf(r);
    if (!sites[key]) sites[key] = _emptyMetrics();
    _accumulate(sites[key], r);
  }
  return { total, sites };
}

// ── History load / capture ─────────────────────────────────────────────────────
function _load() {
  const h = store.load('wbrHistory', null);
  if (h && Array.isArray(h.weeks)) return h;
  return { weeks: [], updatedAt: null };
}

/**
 * getHistory() — the full persisted history { weeks:[...], updatedAt }.
 */
function getHistory() { return _load(); }

/**
 * captureSnapshot(rows, opts) — compute this week's metrics and persist them
 * under the current ISO Monday-week (idempotent per week: latest-wins).
 * Returns { ok, week, weekStart, created, snapshot } or { ok:false, reason }.
 * Best-effort; never throws (callers hook it into the sync path).
 */
function captureSnapshot(rows, opts) {
  opts = opts || {};
  try {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, reason: 'no rows' };
    }
    const when = opts.date ? _toLocalDate(opts.date) : new Date();
    const { week, weekStart } = weekIdFor(when);
    const metrics = computeWeekMetrics(rows);
    const snapshot = {
      week,
      weekStart,
      capturedAt: when.toISOString(),
      total: metrics.total,
      sites: metrics.sites,
    };

    const hist = _load();
    const idx = hist.weeks.findIndex(w => w.week === week);
    const created = idx === -1;
    if (created) hist.weeks.push(snapshot);
    else hist.weeks[idx] = snapshot; // latest-wins within the same ISO week

    // Keep chronological + bounded.
    hist.weeks.sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
    if (hist.weeks.length > MAX_WEEKS) hist.weeks = hist.weeks.slice(-MAX_WEEKS);
    hist.updatedAt = when.toISOString();
    store.save('wbrHistory', hist);

    logger.info(
      `WBR snapshot ${created ? 'created' : 'updated'} ${week} (${weekStart}): ` +
      `${snapshot.total.down} down across ${Object.keys(snapshot.sites).length} sites`
    );
    return { ok: true, week, weekStart, created, snapshot };
  } catch (e) {
    logger.warn('captureSnapshot failed (non-fatal): ' + e.message);
    return { ok: false, reason: e.message };
  }
}

// ── Comparison + unit-movement engine ────────────────────────────────────────
// Given the CURRENT week's live metrics and the persisted history, compute the
// real Prior-Week (WoW) and Trailing-6-Week (T6W) comparison + per-site unit
// movement. Everything is grounded in captured snapshots (never fabricated);
// when there's no prior data yet it returns an honest cold-start result.

function _pct(cur, base) {
  if (base === 0) return cur === 0 ? 0 : 100;
  return Math.round(((cur - base) / base) * 1000) / 10; // one decimal
}

function _signed(n) { return (n > 0 ? '+' : '') + n; }

// Trend read over the last up-to-6 weekly down totals (excluding current).
function _trendRead(series) {
  if (series.length < 2) return '';
  let up = 0, down = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i] > series[i - 1]) up++;
    else if (series[i] < series[i - 1]) down++;
  }
  if (up > down) return `up ${up} of last ${series.length - 1} wks`;
  if (down > up) return `down ${down} of last ${series.length - 1} wks`;
  return 'flat/mixed';
}

// Movement for one site: diff the prior snapshot's down unit set vs current.
function _movementForSite(priorUnits, currentUnits) {
  const prior = new Set(priorUnits || []);
  const cur = new Set(currentUnits || []);
  const newlyDown = [...cur].filter(id => !prior.has(id));
  const returned  = [...prior].filter(id => !cur.has(id));
  const stillDown = [...cur].filter(id => prior.has(id));
  return { newlyDown, returned, stillDown };
}

/**
 * buildComparison(currentMetrics, opts) — the real WoW + T6W + movement result,
 * for the fleet total and per site.
 *
 * currentMetrics: output of computeWeekMetrics(rows) — { total, sites }.
 * opts.canonicalUnits: optional { equipmentId: canonicalRecord } so a newly-down
 *   unit can carry a short "why" (status + statusChangeReason). Grounded only.
 * opts.now / opts.history: injectable for tests.
 *
 * Returns:
 *   { coldStart:boolean, currentWeek, priorWeek, weeksAvailable,
 *     total: SiteComparison, sites: { key: SiteComparison } }
 * SiteComparison:
 *   { down, priorDown, wowDelta, t6wAvg, t6wPct, trend, movement:{newlyDown,
 *     returned, stillDown, newlyDownWhy:[{id,status,reason}]}, text }
 *   (text = the ready-to-use "Prior-Week / T6W" bullet value for this scope)
 */
function buildComparison(currentMetrics, opts) {
  opts = opts || {};
  const hist = opts.history || _load();
  const now = opts.now ? _toLocalDate(opts.now) : new Date();
  const curWeek = weekIdFor(now);
  const canon = opts.canonicalUnits || {};

  // Prior weeks = all captured weeks strictly BEFORE the current ISO week,
  // most-recent last.
  const priorWeeks = (hist.weeks || []).filter(w => w.weekStart < curWeek.weekStart);
  const priorWeek = priorWeeks.length ? priorWeeks[priorWeeks.length - 1] : null;
  const t6w = priorWeeks.slice(-6); // up to 6 most-recent prior weeks

  const coldStart = priorWeeks.length === 0;

  function compareScope(curM, priorM, t6wMetrics) {
    const down = curM ? curM.down : 0;
    const priorDown = priorM ? priorM.down : null;
    const wowDelta = priorDown == null ? null : (down - priorDown);
    const t6wSeries = t6wMetrics.map(m => m.down);
    const t6wAvg = t6wSeries.length
      ? Math.round((t6wSeries.reduce((a, b) => a + b, 0) / t6wSeries.length) * 10) / 10
      : null;
    const t6wPct = t6wAvg == null ? null : _pct(down, t6wAvg);
    const trend = _trendRead(t6wSeries.concat(down));

    const movement = _movementForSite(priorM ? priorM.units : [], curM ? curM.units : []);
    // Attach a grounded "why" for newly-down units from canonical state.
    movement.newlyDownWhy = movement.newlyDown.slice(0, 20).map(id => {
      const rec = canon[id];
      return {
        id,
        status: rec && rec.status ? rec.status : null,
        reason: rec && rec.statusChangeReason ? String(rec.statusChangeReason).slice(0, 120) : null,
      };
    });

    // Build the ready-to-paste bullet text for this scope.
    let text;
    if (priorDown == null) {
      text = `baseline week — no prior snapshot yet (history now being captured; comparison available next week)`;
    } else {
      const parts = [];
      parts.push(`${priorDown} \u2192 ${down} WoW (${_signed(wowDelta)})`);
      if (t6wAvg != null) {
        parts.push(`vs T6W avg ${t6wAvg} (${_signed(t6wPct)}%${trend ? ', ' + trend : ''})`);
      }
      if (movement.newlyDown.length || movement.returned.length) {
        parts.push(`${movement.newlyDown.length} newly down, ${movement.returned.length} returned to service`);
      }
      text = parts.join('; ');
    }

    return { down, priorDown, wowDelta, t6wAvg, t6wPct, trend, movement, text };
  }

  const total = compareScope(
    currentMetrics.total,
    priorWeek ? priorWeek.total : null,
    t6w.map(w => w.total)
  );

  const sites = {};
  for (const [key, curM] of Object.entries(currentMetrics.sites || {})) {
    const priorM = priorWeek && priorWeek.sites ? priorWeek.sites[key] : null;
    const t6wM = t6w.map(w => (w.sites && w.sites[key]) || { down: 0, units: [] });
    sites[key] = compareScope(curM, priorM, t6wM);
  }

  return {
    coldStart,
    currentWeek: curWeek.week,
    priorWeek: priorWeek ? priorWeek.week : null,
    weeksAvailable: priorWeeks.length,
    total,
    sites,
  };
}

module.exports = {
  MAX_WEEKS,
  locationClass,
  mondayOf,
  isoWeekKey,
  weekIdFor,
  isDown,
  siteKeyOf,
  computeWeekMetrics,
  getHistory,
  captureSnapshot,
  buildComparison,
};
