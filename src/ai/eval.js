'use strict';
/**
 * src/ai/eval.js — Unified AI Core lightweight evaluation + feedback (spec #10).
 *
 * Turns the operational AI traces (src/ai/trace.js -> `aiTraceLog`) plus
 * explicit operator feedback into:
 *   - a feedback recorder (correct/incorrect, reply-edited-before-send, etc.),
 *   - aggregate quality metrics (answer success rate, fallback rate, tool
 *     success rate, average latency, model usage, operator correction rate).
 *
 * DESIGN RULES (from the spec):
 *   - Do NOT automatically change behavior from one isolated correction. This
 *     module ONLY records + aggregates; it never mutates config, permissions,
 *     memory, or routing. Corrections are structured LEARNING DATA for later.
 *   - Reuse the trace as the source of truth; feedback is attached to the SAME
 *     requestId (trace.attachCorrection), so there is one record per request.
 *   - Everything is best-effort and guarded — eval must never break a request.
 *
 * This is additive and read-mostly: the only write is attaching an operator
 * correction to an existing trace (already supported by trace.js).
 */

const trace = require('./trace');
let logger; try { logger = require('../utils/logger').createLogger('ai-eval'); } catch (_) { logger = { info() {}, warn() {} }; }

// Allowed operator feedback verdicts. Free-form notes are also accepted.
const VERDICTS = ['correct', 'incorrect', 'edited', 'stale', 'unsupported', 'escalation_ok', 'escalation_missed'];

/**
 * recordFeedback(requestId, feedback) -> { ok, error? }
 * Attach operator feedback to the trace for `requestId`. `feedback`:
 *   { verdict, note?, editedReply? }
 * verdict is coerced to a known value when possible; unknown verdicts are kept
 * as-is (the spec wants structured learning data, not a hard enum gate). This
 * NEVER changes app behavior — it only records.
 */
function recordFeedback(requestId, feedback) {
  if (!requestId) return { ok: false, error: 'requestId required' };
  feedback = feedback || {};
  const verdict = typeof feedback.verdict === 'string' ? feedback.verdict.trim() : 'noted';
  const ok = trace.attachCorrection(requestId, {
    verdict: VERDICTS.includes(verdict) ? verdict : verdict,
    note: feedback.note || '',
    editedReply: feedback.editedReply,
  });
  return ok ? { ok: true } : { ok: false, error: 'trace not found for ' + requestId };
}

/** Did a trace represent a usable, non-fallback terminal answer? */
function _isAnswerSuccess(rec) {
  if (!rec) return false;
  // An "answer" outcome that validated and didn't fail safe counts as success.
  const terminal = ['answer', 'act', 'clarify', 'escalate'].includes(rec.outcome);
  return terminal && rec.validated !== false && rec.outcome !== 'failsafe' && !rec.error;
}

function _usedFallback(rec) {
  return !!(rec && Array.isArray(rec.fallbacks) && rec.fallbacks.length);
}

// A trace's tool calls succeeded if none of its action outcomes failed. (Read
// tool success is implicit — a failed read surfaces as missing evidence, not an
// action error. We measure ACTION tool success here, which is the operationally
// meaningful one.)
function _toolOutcomeStats(rec) {
  const outs = (rec && Array.isArray(rec.actionOutcomes)) ? rec.actionOutcomes : [];
  let ok = 0, fail = 0;
  outs.forEach((o) => {
    const s = (o && (o.status || o.outcome)) || '';
    if (s === 'done') ok++;
    else if (s === 'error' || s === 'failed' || s === 'unverified' || s === 'blocked') fail++;
    // 'verifying'/'deferred' are neither a success nor a failure yet — skip.
  });
  return { ok, fail, total: ok + fail };
}

/**
 * metrics(opts) -> aggregate quality metrics over recent traces.
 * opts.limit (default 200) — how many recent traces to aggregate.
 * opts.sinceMs — only include traces at/after this epoch ms (optional).
 *
 * Returns:
 *   {
 *     sampleSize,
 *     answerSuccessRate,      // usable terminal answers / all requests
 *     fallbackRate,           // requests that used any fallback / all
 *     toolSuccessRate,        // action tool successes / (successes+failures)
 *     avgLatencyMs,
 *     modelUsage: { model: count },
 *     sourceUsage: { source: count },
 *     correctionRate,         // traces with an operator correction / all
 *     correctionBreakdown: { verdict: count },
 *     staleAnswerRate,        // answers backed by any STALE evidence / answers
 *     escalationRate,         // escalate outcomes / all
 *     errorRate,              // traces with an error / all
 *     windowFrom, windowTo
 *   }
 */
function metrics(opts) {
  opts = opts || {};
  const limit = Math.max(1, opts.limit || 200);
  let recs = trace.recent(limit);
  if (opts.sinceMs) recs = recs.filter((r) => Date.parse(r.at || 0) >= opts.sinceMs);

  const n = recs.length;
  const safeRate = (num, den) => (den > 0 ? Number((num / den).toFixed(3)) : null);

  if (!n) {
    return {
      sampleSize: 0, answerSuccessRate: null, fallbackRate: null, toolSuccessRate: null,
      avgLatencyMs: null, modelUsage: {}, sourceUsage: {}, correctionRate: null,
      correctionBreakdown: {}, staleAnswerRate: null, escalationRate: null, errorRate: null,
      windowFrom: null, windowTo: null,
    };
  }

  let answers = 0, fallbacks = 0, toolOk = 0, toolFail = 0, latencySum = 0, latencyCount = 0;
  let corrections = 0, staleAnswers = 0, escalations = 0, errors = 0;
  const modelUsage = {}, sourceUsage = {}, correctionBreakdown = {};

  for (const r of recs) {
    if (_isAnswerSuccess(r)) answers++;
    if (_usedFallback(r)) fallbacks++;
    const ts = _toolOutcomeStats(r);
    toolOk += ts.ok; toolFail += ts.fail;
    if (typeof r.latencyMs === 'number') { latencySum += r.latencyMs; latencyCount++; }
    if (r.model) modelUsage[r.model] = (modelUsage[r.model] || 0) + 1;
    if (r.source) sourceUsage[r.source] = (sourceUsage[r.source] || 0) + 1;
    if (r.correction) {
      corrections++;
      const v = r.correction.verdict || 'noted';
      correctionBreakdown[v] = (correctionBreakdown[v] || 0) + 1;
    }
    // Stale answer: a terminal answer whose evidence freshness recorded a STALE.
    if (_isAnswerSuccess(r) && r.evidenceFreshness && Object.values(r.evidenceFreshness).some((f) => f === 'STALE')) staleAnswers++;
    if (r.outcome === 'escalate') escalations++;
    if (r.error) errors++;
  }

  const times = recs.map((r) => Date.parse(r.at || 0)).filter((t) => !isNaN(t));
  return {
    sampleSize: n,
    answerSuccessRate: safeRate(answers, n),
    fallbackRate: safeRate(fallbacks, n),
    toolSuccessRate: safeRate(toolOk, toolOk + toolFail),
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
    modelUsage,
    sourceUsage,
    correctionRate: safeRate(corrections, n),
    correctionBreakdown,
    staleAnswerRate: safeRate(staleAnswers, answers),
    escalationRate: safeRate(escalations, n),
    errorRate: safeRate(errors, n),
    windowFrom: times.length ? new Date(Math.min(...times)).toISOString() : null,
    windowTo: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

/** recentFeedback(limit) -> traces that carry an operator correction, newest-first. */
function recentFeedback(limit) {
  return trace.recent(Math.max(1, (limit || 50) * 4))
    .filter((r) => r && r.correction)
    .slice(0, limit || 50)
    .map((r) => ({ requestId: r.requestId, at: r.at, source: r.source, outcome: r.outcome, correction: r.correction }));
}

module.exports = { recordFeedback, metrics, recentFeedback, VERDICTS };
