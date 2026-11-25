'use strict';
/**
 * autopilot/queue.js — worker-pool bookkeeping for the controller (V2 design §8.2, §8.4). Pure.
 *
 *   nextStart({ running, maxConcurrent, remainingMs, minStartRemainingMs })
 *     -> 'start' | 'wait' | 'stop'
 *        stop  when less than minStartRemainingMs of tick time is left (the case stays QUEUED)
 *        wait  when maxConcurrent runs are in flight (await one, then ask again)
 *        start otherwise
 *   planStarts(picked, { maxConcurrent, remainingMs, minStartRemainingMs })
 *     -> { start: [caseId], skipped: [caseId], maxParallel }
 *        the start decisions for a picked list at one point in time: every picked case starts
 *        (at most maxParallel at once) unless the remaining tick time is below the minimum.
 *   promotionCount(maxQueued, queued) -> n = max(0, maxQueued - queued)
 *   runBudgetMs(caseRow, tiers) -> the tier maxElapsedMs a run of this case may use (user decision,
 *        replaces the fixed 150 s rule of FR-8.2): deep request -> complex; else the case's last
 *        complexity; unknown -> complex (the largest, so a start never outruns the tick).
 */

const { LIMITS } = require('./constants');

function _int(v, dflt) { return Number.isFinite(v) ? Math.floor(v) : dflt; }

function nextStart(s) {
  const i = s || {};
  const min = _int(i.minStartRemainingMs, LIMITS.minStartRemainingMs);
  const remaining = Number.isFinite(i.remainingMs) ? i.remainingMs : Infinity;
  if (remaining < min) return 'stop';
  const maxC = Math.max(1, _int(i.maxConcurrent, 1));
  if (_int(i.running, 0) >= maxC) return 'wait';
  return 'start';
}

function planStarts(picked, opts) {
  const o = opts || {};
  const ids = (Array.isArray(picked) ? picked : []).map((c) => (c && typeof c === 'object' ? c.case_id : c)).filter(Boolean);
  const maxParallel = Math.max(1, _int(o.maxConcurrent, 1));
  if (nextStart({ running: 0, maxConcurrent: maxParallel, remainingMs: o.remainingMs, minStartRemainingMs: o.minStartRemainingMs }) === 'stop') {
    return { start: [], skipped: ids, maxParallel };
  }
  return { start: ids, skipped: [], maxParallel };
}

function promotionCount(maxQueued, queued) {
  const m = _int(maxQueued, 0);
  const q = _int(queued, 0);
  return Math.max(0, m - q);
}

const DEFAULT_TIER_MS = Object.freeze({ simple: 120000, standard: 240000, complex: 420000 });

function runBudgetMs(c, tiers) {
  const t = tiers || {};
  const k = c && c.deep_requested_at != null ? 'complex'
    : (c && Object.prototype.hasOwnProperty.call(DEFAULT_TIER_MS, c.complexity) ? c.complexity : 'complex');
  const v = t[k] && Number.isFinite(t[k].maxElapsedMs) ? t[k].maxElapsedMs : DEFAULT_TIER_MS[k];
  return Math.max(0, Math.floor(v));
}

module.exports = { nextStart, planStarts, promotionCount, runBudgetMs };
