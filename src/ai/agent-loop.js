'use strict';
/**
 * src/ai/agent-loop.js — bounded multi-step tool-calling loop (spec §1).
 *
 * Drives the agent cycle through the NORMALIZED tool platform (src/ai/tools):
 *
 *   request
 *     -> planner turn (model decides: request tools OR give final decision)
 *     -> execute the requested authorized READ tools (provenance-normalized)
 *     -> feed results back
 *     -> repeat until a terminal decision OR a budget is exhausted
 *
 * The model requests evidence AS NEEDED — we do NOT pre-dump every source. The
 * loop is BOUNDED by src/ai/budget.js (maxToolCalls/maxModelTurns/maxElapsedMs/
 * maxEvidenceBytes). No infinite loops.
 *
 * SAFETY:
 *   - Tools are READ-ONLY (the normalized platform wraps FAS read tools, which
 *     enforce sender scope/category in code). The loop NEVER executes actions.
 *   - A planner may ONLY request registered tools; unknown names are rejected
 *     and reported back as data, never executed.
 *   - ctx.profile (resolved sender) is required and passed to every tool call,
 *     so permissions are identical to the rest of the app (never widened).
 *   - An AbortSignal / deadline is honored throughout (spec §29): on abort we
 *     stop cleanly and return the evidence gathered so far.
 *
 * The `planner` is INJECTABLE so the loop is testable without a live model. In
 * production AiCore supplies a planner backed by the model router/relay.
 *
 * planner(state) -> Promise<{
 *   decision: 'request_tools' | 'final',
 *   tools?: [{ tool, args }],     // when decision==='request_tools'
 *   result?: <final decision>,    // when decision==='final'
 * }>
 * state = { request, evidence, toolsAvailable, budget, turn, conflicts }
 */

const tools = require('./tools');
const { Budget } = require('./budget');
let logger; try { logger = require('../utils/logger').createLogger('ai-agent-loop'); } catch (_) { logger = { info() {}, warn() {} }; }

const DEFAULT_CONCURRENCY = 4;

/**
 * run({ request, profile, planner, budget, signal, concurrency }) -> {
 *   ok, result?, evidence, budget: <summary>, stopped?, toolLog
 * }
 */
async function run(input) {
  input = input || {};
  const request = input.request || {};
  const profile = input.profile;
  const planner = input.planner;
  const signal = input.signal || null;
  const concurrency = Math.max(1, input.concurrency || DEFAULT_CONCURRENCY);
  const budget = input.budget instanceof Budget ? input.budget : new Budget(input.budget || {});

  if (typeof planner !== 'function') return { ok: false, error: 'planner function required', evidence: [], budget: budget.summary(), toolLog: [] };
  if (!profile) return { ok: false, error: 'resolved sender profile required', evidence: [], budget: budget.summary(), toolLog: [] };

  const ctx = { profile, mode: input.mode };
  const evidence = [];          // accumulated normalized tool results
  const toolLog = [];           // { tool, args, ok, freshness, source, error }
  const seen = new Set();       // dedupe identical tool+args within a request
  let finalResult = null;
  let stopped = null;

  while (true) {
    if (_aborted(signal)) { stopped = 'aborted'; break; }
    if (!budget.canModelTurn()) { stopped = budget.summary().stops.slice(-1)[0] || 'maxModelTurns'; break; }

    budget.countModelTurn();
    let plan;
    try {
      plan = await planner({
        request,
        evidence: evidence.slice(),
        toolsAvailable: tools.list(),
        budget: budget.summary(),
        turn: budget.summary().modelTurns,
        conflicts: _detectConflicts(evidence),
      });
    } catch (e) {
      logger.warn('[ai-agent-loop] planner threw: ' + e.message);
      stopped = 'planner-error';
      break;
    }

    if (!plan || plan.decision === 'final') { finalResult = plan && plan.result != null ? plan.result : null; break; }

    if (plan.decision === 'request_tools' && Array.isArray(plan.tools) && plan.tools.length) {
      // Bound the batch to the remaining tool-call budget.
      const remaining = budget.toolCallsRemaining();
      if (remaining <= 0) { stopped = 'maxToolCalls'; break; }
      const batch = plan.tools.slice(0, remaining);

      // Split dependent vs independent: here all requested tools in one planner
      // turn are treated as INDEPENDENT (the planner expresses dependencies by
      // requesting across turns). Run them with bounded concurrency (spec §14).
      const results = await _runToolsConcurrently(batch, ctx, { budget, signal, seen, concurrency });
      for (const r of results) {
        toolLog.push({ tool: r.env.tool, args: r.args, ok: r.env.ok, freshness: r.env.freshness, source: r.env.source, denied: r.env.denied, error: r.env.error });
        if (r.env.ok) {
          // Evidence-bytes accounting (spec §13 budgeting).
          const sz = _sizeOf(r.env);
          budget.addEvidenceBytes(sz);
          evidence.push(r.env);
        } else {
          // Keep failed/denied as evidence too, so the model knows what it
          // could NOT get (missing/denied is material to a grounded answer).
          evidence.push(r.env);
        }
      }
      continue;
    }

    // Planner returned something unexpected -> treat as final (no tools).
    finalResult = plan.result != null ? plan.result : null;
    break;
  }

  return {
    ok: !stopped || !!finalResult,
    result: finalResult,
    evidence,
    conflicts: _detectConflicts(evidence),
    budget: budget.summary(),
    stopped,
    toolLog,
  };
}

// Run a batch of independent tool requests concurrently, bounded by `concurrency`
// and the remaining tool-call budget. Rejects unknown tools as data.
async function _runToolsConcurrently(batch, ctx, opts) {
  const { budget, signal, seen, concurrency } = opts;
  const out = [];
  let i = 0;

  async function worker() {
    while (i < batch.length) {
      if (_aborted(signal)) return;
      const idx = i++;
      const req = batch[idx] || {};
      const name = req.tool;
      const args = req.args || {};
      if (!budget.canCallTool()) return;

      // Unknown tool -> report as data, do not execute (spec: can request tools
      // but cannot invent new tools).
      if (!tools.has(name)) {
        out[idx] = { args, env: { ok: false, tool: String(name || '?'), error: 'unknown tool (not in catalog)', freshness: 'UNKNOWN', confidence: 0, denied: false } };
        continue;
      }
      // Dedupe identical tool+args within one request (spec §15 request cache).
      const key = name + ':' + JSON.stringify(args);
      if (seen.has(key)) {
        out[idx] = { args, env: { ok: false, tool: name, error: 'SKIPPED: already retrieved this exact query', freshness: 'UNKNOWN', confidence: 0, cached: true } };
        continue;
      }
      seen.add(key);
      budget.countToolCall(1);
      let env;
      try { env = await tools.execute(name, args, ctx); }
      catch (e) { env = { ok: false, tool: name, error: e.message, freshness: 'UNKNOWN', confidence: 0 }; }
      out[idx] = { args, env };
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, batch.length); w++) workers.push(worker());
  await Promise.all(workers);
  return out.filter(Boolean);
}

// Detect field-level conflicts across evidence from DIFFERENT sources (spec §4
// surfaces conflicts; deterministic resolution policy lands in a later phase).
function _detectConflicts(evidence) {
  const byField = {};
  for (const env of evidence) {
    if (!env || !env.ok || !env.data || !Array.isArray(env.data.facts)) continue;
    for (const f of env.data.facts) {
      if (!f || f.value == null) continue;
      const k = String(f.field);
      (byField[k] = byField[k] || []).push({ value: _normVal(f.value), source: f.source || env.source, freshness: env.freshness });
    }
  }
  const conflicts = [];
  for (const field of Object.keys(byField)) {
    const vals = byField[field];
    const distinct = Array.from(new Set(vals.map((v) => v.value)));
    if (distinct.length > 1) {
      conflicts.push({ field, values: vals.map((v) => ({ value: v.value, source: v.source, freshness: v.freshness })) });
    }
  }
  return conflicts;
}

function _normVal(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }
function _sizeOf(env) { try { return JSON.stringify(env).length; } catch (_) { return 0; } }
function _aborted(signal) { return !!(signal && signal.aborted); }

module.exports = { run };
