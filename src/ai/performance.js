'use strict';
/**
 * src/ai/performance.js — model performance learning (spec §8).
 *
 * Aggregates the AI traces (src/ai/trace -> aiTraceLog) into per (model|lane +
 * taskType) quality metrics, and exposes an ADVISORY laneScore() the router can
 * use as a tie-break (router.decide's performance hook).
 *
 * SAFETY (spec §8): do NOT auto-reconfigure production behavior from tiny
 * samples. laneScore() returns null below a minimum sample threshold, so the
 * router only nudges when there is real signal. This module never changes
 * config, routing policy, or permissions — it only reads traces and scores.
 */

const trace = require('./trace');

const DEFAULT_MIN_SAMPLES = 20;

function _rate(num, den) { return den > 0 ? num / den : null; }

/**
 * byModelTask(opts) -> { 'model::taskType': stats } aggregated from traces.
 * stats: { samples, successRate, correctionRate, schemaFailureRate,
 *          fallbackRate, avgLatencyMs }
 */
function byModelTask(opts) {
  opts = opts || {};
  const recs = trace.recent(opts.limit || 500);
  const groups = {};
  for (const r of recs) {
    const model = r.model || r.lane || 'unknown';
    const task = r.taskType || 'unknown';
    const key = model + '::' + task;
    const g = groups[key] || (groups[key] = { samples: 0, success: 0, corrections: 0, schemaFail: 0, fallback: 0, latSum: 0, latN: 0, correctionsIncorrect: 0 });
    g.samples++;
    const terminal = ['answer', 'act', 'clarify', 'escalate'].includes(r.outcome);
    if (terminal && r.validated !== false && r.outcome !== 'failsafe' && !r.error) g.success++;
    if (r.validated === false) g.schemaFail++;
    if (Array.isArray(r.fallbacks) && r.fallbacks.length) g.fallback++;
    if (r.correction) { g.corrections++; if (r.correction.verdict === 'incorrect') g.correctionsIncorrect++; }
    if (typeof r.latencyMs === 'number') { g.latSum += r.latencyMs; g.latN++; }
  }
  const out = {};
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    out[key] = {
      samples: g.samples,
      successRate: _round(_rate(g.success, g.samples)),
      correctionRate: _round(_rate(g.corrections, g.samples)),
      incorrectRate: _round(_rate(g.correctionsIncorrect, g.samples)),
      schemaFailureRate: _round(_rate(g.schemaFail, g.samples)),
      fallbackRate: _round(_rate(g.fallback, g.samples)),
      avgLatencyMs: g.latN ? Math.round(g.latSum / g.latN) : null,
    };
  }
  return out;
}

/**
 * laneScore(lane, taskType, opts) -> number in [0,1] | null
 * A composite advisory score for a lane on a task class, or null below the
 * minimum sample threshold (so the router does not act on noise, spec §8).
 * Composite = successRate, penalized by correction/schema-failure rates.
 */
function laneScore(lane, taskType, opts) {
  opts = opts || {};
  const minSamples = opts.minSamples || DEFAULT_MIN_SAMPLES;
  const agg = opts.aggregate || byModelTask({ limit: opts.limit });
  // Sum across any model that ran on this lane for this task (lane is coarser
  // than model; traces record both model + lane).
  let samples = 0, success = 0, corr = 0, schema = 0;
  for (const key of Object.keys(agg)) {
    const [model, task] = key.split('::');
    if (task !== taskType) continue;
    // Match the lane loosely against the model/lane label.
    if (!_laneMatches(lane, model)) continue;
    const g = agg[key];
    samples += g.samples;
    if (g.successRate != null) success += g.successRate * g.samples;
    if (g.correctionRate != null) corr += g.correctionRate * g.samples;
    if (g.schemaFailureRate != null) schema += g.schemaFailureRate * g.samples;
  }
  if (samples < minSamples) return null; // not enough signal — no influence
  const successRate = success / samples;
  const correctionRate = corr / samples;
  const schemaRate = schema / samples;
  // Composite: reward success, penalize corrections + schema failures.
  const score = Math.max(0, Math.min(1, successRate - 0.5 * correctionRate - 0.5 * schemaRate));
  return Number(score.toFixed(3));
}

// Build the performance hook the router consumes: (lane, taskType) -> score|null.
function routerHook(opts) {
  const aggregate = byModelTask({ limit: (opts && opts.limit) });
  return (lane, taskType) => laneScore(lane, taskType, { ...(opts || {}), aggregate });
}

function _laneMatches(lane, modelLabel) {
  const l = String(lane || '').toLowerCase();
  const m = String(modelLabel || '').toLowerCase();
  if (l === 'orcha') return /orcha/.test(m);
  if (l === 'claude') return /claude/.test(m);
  if (l === 'auto') return true;
  return m.includes(l);
}

function _round(v) { return v == null ? null : Number(v.toFixed(3)); }

module.exports = { byModelTask, laneScore, routerHook, DEFAULT_MIN_SAMPLES };
