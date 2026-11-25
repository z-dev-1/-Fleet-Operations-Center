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
 * The loop itself lives in ./agent-loop-core (Autopilot V2 §6.1 split). This
 * wrapper keeps today's contract: the src/ai/tools registry, a required
 * resolved sender profile, and no V2 options (rejected requests on budget
 * exhaustion are dropped silently, as before).
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
 * planner(state) -> Promise<{
 *   decision: 'request_tools' | 'final',
 *   tools?: [{ tool, args }],     // when decision==='request_tools'
 *   result?: <final decision>,    // when decision==='final'
 * }>
 * state = { request, evidence, toolsAvailable, budget, turn, conflicts }
 */

const tools = require('./tools');                 // top-level require, as before the split
const core = require('./agent-loop-core');
const { Budget } = require('./budget');

/**
 * run({ request, profile, planner, budget, signal, concurrency }) -> {
 *   ok, result?, evidence, budget: <summary>, stopped?, toolLog
 * }
 */
async function run(input) {
  input = input || {};
  const budget = input.budget instanceof Budget ? input.budget : new Budget(input.budget || {});
  if (typeof input.planner !== 'function') return { ok: false, error: 'planner function required', evidence: [], budget: budget.summary(), toolLog: [] };
  if (!input.profile) return { ok: false, error: 'resolved sender profile required', evidence: [], budget: budget.summary(), toolLog: [] };
  // Pre-split contract: an unexpected decision (including 'stop') is treated as final. The
  // core's 'stop' branch is for core callers only, so map it back to 'final' here.
  const userPlanner = input.planner;
  const planner = async (state) => {
    const plan = await userPlanner(state);
    return plan && plan.decision === 'stop' ? { decision: 'final', result: plan.result } : plan;
  };
  return core.run(Object.assign({}, input, { planner, budget, registry: tools, ctx: { profile: input.profile, mode: input.mode } }));
}

module.exports = { run };
