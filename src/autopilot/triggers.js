'use strict';
/**
 * autopilot/triggers.js — reinvestigation triggers (§B10.3 with plan R6 LIMITS). Pure.
 *
 * dueTriggers(cases, now, ctx) -> [{ caseId, trigger, date? }]
 *   cases: ap_case rows (eta_json string or parsed `eta`)
 *   ctx: {
 *     cheapFps: Map|object caseId -> current cheap fp (only for evaluated cases),
 *     authState: { midway },
 *     runs: Map|object caseId -> [{ trigger, started_at }] (today's and recent runs),
 *     etaFired: Set of 'caseId|YYYY-MM-DD' already triggered (ap_event eta_due:<date>),
 *   }
 * First matching trigger per case: evidence_changed, eta_due, scheduled,
 * auth_restored, retry_due. Every automatic trigger is limited to one per
 * LIMITS.minAutoSpacingMs after the case's last automatic run and to
 * LIMITS.autoRunsPerDay automatic runs per local day. Harness and manual runs
 * are neither limited by nor charged to those limits.
 */

const { STATES: S, LIMITS, AUTH_DOWN, OPERATIONAL_CADENCE, localDate } = require('./constants');
const { triggerFor, changedSlices } = require('./slices');

const EXEMPT_TRIGGERS = new Set(['harness', 'manual']);
const CHEAP_FP_STATES = new Set([S.MONITORING, S.RECOMMENDATION_READY, S.WAITING_FOR_DATA, S.AUTH_REQUIRED, S.FAILED]);
const REVIEW_STATES = new Set([S.MONITORING, S.RECOMMENDATION_READY, S.WAITING_FOR_DATA, S.AUTH_REQUIRED]);
const RETRY_STATES = new Set([S.AUTH_REQUIRED, S.WAITING_FOR_DATA]);

function _get(src, k) {
  if (!src) return undefined;
  if (src instanceof Map) return src.get(k);
  return src[k];
}
function _eta(c) {
  if (c.eta && typeof c.eta === 'object') return c.eta;
  if (typeof c.eta_json === 'string') { try { return JSON.parse(c.eta_json); } catch (_) { return null; } }
  return null;
}

/** Automatic-run stats for one case: { lastAutoAt, autoToday }. */
function autoRunStats(runs, now) {
  const today = localDate(now);
  let lastAutoAt = null;
  let autoToday = 0;
  for (const r of runs || []) {
    if (!r || EXEMPT_TRIGGERS.has(r.trigger)) continue;
    const t = r.started_at;
    if (!Number.isFinite(t)) continue;
    if (lastAutoAt == null || t > lastAutoAt) lastAutoAt = t;
    if (localDate(t) === today) autoToday++;
  }
  return { lastAutoAt, autoToday };
}

function _limited(stats, now) {
  if (stats.autoToday >= LIMITS.autoRunsPerDay) return true;
  return stats.lastAutoAt != null && now - stats.lastAutoAt < LIMITS.minAutoSpacingMs;
}

function _sliceFps(c) {
  if (c.slice_fps && typeof c.slice_fps === 'object') return c.slice_fps;
  if (typeof c.slice_fps_json === 'string') { try { return JSON.parse(c.slice_fps_json); } catch (_) { return null; } }
  return null;
}
function _awaiting(c) {
  return String(c.awaiting_sources || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * V2 ctx additions (§9.2): sliceFps (Map|object caseId -> current slices; when given, slice
 * triggers replace the V1 cheap-fp evidence_changed), sourceUsable(source, case) and aiCapLeft.
 * Order per case, first match wins: slice-named trigger, eta_due, scheduled, auth_restored,
 * source_restored, ai_capacity (also NEEDS_REVIEW with ai_pending_reason 'cap'), retry_due.
 * A slice trigger also returns changedSlices.
 */
function dueTriggers(cases, now, ctx) {
  const c = ctx || {};
  const today = localDate(now);
  const midway = c.authState && c.authState.midway;
  const authOk = midway != null && !AUTH_DOWN.has(midway);
  const fired = c.etaFired instanceof Set ? c.etaFired : new Set();
  const useSlices = c.sliceFps != null;
  const usable = typeof c.sourceUsable === 'function' ? c.sourceUsable : null;
  const capLeft = Number(c.aiCapLeft);
  const out = [];
  for (const k of cases || []) {
    if (!k || !k.case_id) continue;
    const st = k.state;
    let trig = null;
    let date;
    let changed;
    if (useSlices) {
      const next = _get(c.sliceFps, k.case_id);
      const prev = CHEAP_FP_STATES.has(st) && next != null ? _sliceFps(k) : null;
      if (prev) {
        trig = triggerFor(prev, next);
        if (trig) changed = changedSlices(prev, next);
      }
    } else {
      const fpNow = _get(c.cheapFps, k.case_id);
      if (CHEAP_FP_STATES.has(st) && fpNow != null && fpNow !== k.cheap_fp) trig = 'evidence_changed';
    }
    if (!trig && REVIEW_STATES.has(st)) {
      const eta = _eta(k);
      if (eta && (eta.status === 'FUTURE' || eta.status === 'TODAY') && eta.date && eta.date <= today && !fired.has(k.case_id + '|' + eta.date)) {
        trig = 'eta_due'; date = eta.date;
      }
    }
    if (!trig && REVIEW_STATES.has(st) && Number.isFinite(k.next_review_at) && k.next_review_at <= now) trig = 'scheduled';
    if (!trig && st === S.AUTH_REQUIRED && authOk) trig = 'auth_restored';
    if (!trig && usable && REVIEW_STATES.has(st)) {
      const list = _awaiting(k);
      if (list.length && list.some((s) => { try { return usable(s, k) === true; } catch (_) { return false; } })) trig = 'source_restored';
    }
    // ai_capacity also covers a NEEDS_REVIEW case deferred by the daily cap (user decision): it gets its
    // AI run while it still waits for review (investigate returns it to NEEDS_REVIEW).
    const capReview = st === S.NEEDS_REVIEW && k.ai_pending_reason === 'cap';
    if (!trig && (REVIEW_STATES.has(st) || capReview) && k.ai_pending_reason != null && Number.isFinite(k.ai_retry_at) && k.ai_retry_at <= now
      && Number.isFinite(capLeft) && capLeft > 0) trig = 'ai_capacity';
    if (!trig && RETRY_STATES.has(st) && Number.isFinite(k.next_attempt_at) && k.next_attempt_at <= now) trig = 'retry_due';
    if (!trig) continue;
    if (_limited(autoRunStats(_get(c.runs, k.case_id), now), now)) continue;
    const t = { caseId: k.case_id, trigger: trig };
    if (date) t.date = date;
    if (changed) t.changedSlices = changed;
    out.push(t);
  }
  return out;
}

/**
 * shouldEvalCheapFp({ evaluatedOnce, gens, prevGens, lastEvalAt, now })
 * True on the first evaluation after process start, when any watched
 * generation changed, or every OPERATIONAL_CADENCE.cheapFpEveryMs.
 */
function shouldEvalCheapFp(s) {
  const i = s || {};
  if (!i.evaluatedOnce) return true;
  const g = i.gens || {};
  const p = i.prevGens || {};
  for (const k of Object.keys(g)) if (g[k] !== p[k]) return true;
  return !Number.isFinite(i.lastEvalAt) || i.now - i.lastEvalAt >= OPERATIONAL_CADENCE.cheapFpEveryMs;
}

module.exports = { dueTriggers, autoRunStats, shouldEvalCheapFp, EXEMPT_TRIGGERS, CHEAP_FP_STATES };
