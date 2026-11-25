'use strict';
/**
 * src/ai/agent-loop-core.js — the bounded multi-step tool-calling loop with an
 * injectable tool registry (Autopilot V2 §6.1, split from agent-loop.js, approved Q1).
 *
 *   request
 *     -> planner turn (model decides: request tools, final decision, or stop)
 *     -> execute the requested READ tools through `registry`
 *     -> feed results back
 *     -> repeat until a terminal decision OR a budget is exhausted
 *
 * The loop body is the one agent-loop.js ran before the split. `registry`
 * ({ list(), has(name), execute(name, args, ctx) }) replaces the hard-wired
 * src/ai/tools require, and these optional parameters are added. Each one does
 * nothing when absent, so the agent-loop.js wrapper keeps today's behavior:
 *
 *   initialEvidence  [] seeds `evidence`
 *   seen             Set of keys seeded for in-run dedupe
 *   keyOf            (name, args) => key; default name + ':' + JSON.stringify(args)
 *   toolTimeoutMs    race each execute; on expiry a TOOL_TIMEOUT envelope
 *   timeoutFor       (name) => ms; a finite number replaces toolTimeoutMs for that call
 *   stopOnBudget     every request the budget (or the per-turn slice) rejects reaches
 *                    afterTool as SKIPPED BUDGET_<reason> / TOO_MANY_PER_TURN, and a batch
 *                    with 0 executed tools because of the budget stops with the budget reason
 *   maxToolsPerTurn  batch = tools.slice(0, min(remaining, maxToolsPerTurn))
 *   stopOnNoProgress N > 0: N consecutive turns with no executed or reused tool -> 'no_progress';
 *                    an empty request_tools turn then counts as such a turn
 *   hooks            { afterPlan(plan, turnNo), beforeTool(req, idx) -> {env}|null,
 *                      afterTool(req, env), shouldStop(env) -> code|null }
 *
 * A planner decision 'stop' ends the loop with stopped = plan.code || 'planner-stop'.
 * A hook that throws ends it with stopped = 'hook-error' and hookError = { code }.
 * Every execute gets its own ctx copy: Object.assign({}, ctx, { toolSignal }).
 *
 * SAFETY: the loop never executes actions; it only calls registry.execute for
 * names the registry has. Unknown names are reported back as data.
 */

const { Budget } = require('./budget');
let logger; try { logger = require('../utils/logger').createLogger('ai-agent-loop'); } catch (_) { logger = { info() {}, warn() {} }; }

const DEFAULT_CONCURRENCY = 4;

function _defaultKeyOf(name, args) { return name + ':' + JSON.stringify(args); }

/**
 * run({ request, planner, registry, ctx, budget, signal, concurrency, mode, ...options }) -> {
 *   ok, result, evidence, conflicts, budget: <summary>, stopped, toolLog, hookError?
 * }
 */
async function run(input) {
  input = input || {};
  const request = input.request || {};
  const planner = input.planner;
  const registry = input.registry;
  const signal = input.signal || null;
  const concurrency = Math.max(1, input.concurrency || DEFAULT_CONCURRENCY);
  const budget = input.budget instanceof Budget ? input.budget : new Budget(input.budget || {});

  if (typeof planner !== 'function') return { ok: false, error: 'planner function required', evidence: [], budget: budget.summary(), toolLog: [] };
  if (!registry || typeof registry.execute !== 'function' || typeof registry.has !== 'function' || typeof registry.list !== 'function') {
    return { ok: false, error: 'tool registry required', evidence: [], budget: budget.summary(), toolLog: [] };
  }

  const ctx = input.ctx && typeof input.ctx === 'object' ? input.ctx : {};
  const hooks = input.hooks && typeof input.hooks === 'object' ? input.hooks : {};
  const opts = {
    budget, signal, concurrency, registry, ctx, hooks,
    seen: input.seen instanceof Set ? input.seen : new Set(),   // dedupe identical tool+args within a request
    keyOf: typeof input.keyOf === 'function' ? input.keyOf : _defaultKeyOf,
    toolTimeoutMs: Number.isFinite(input.toolTimeoutMs) && input.toolTimeoutMs > 0 ? input.toolTimeoutMs : null,
    timeoutFor: typeof input.timeoutFor === 'function' ? input.timeoutFor : null,
    stopOnBudget: input.stopOnBudget === true,
    hookErr: null,
  };
  const maxPerTurn = Number.isInteger(input.maxToolsPerTurn) && input.maxToolsPerTurn > 0 ? input.maxToolsPerTurn : null;
  const noProgressN = Number.isInteger(input.stopOnNoProgress) && input.stopOnNoProgress > 0 ? input.stopOnNoProgress : 0;

  const evidence = Array.isArray(input.initialEvidence) ? input.initialEvidence.slice() : [];   // accumulated tool results
  const toolLog = [];           // { tool, args, ok, freshness, source, error }
  let finalResult = null;
  let stopped = null;
  let hookError = null;
  let noProgress = 0;

  const hookFail = (e) => { stopped = 'hook-error'; hookError = { code: (e && e.code) || 'HOOK_ERROR' }; };

  while (true) {
    if (_aborted(signal)) { stopped = 'aborted'; break; }
    if (!budget.canModelTurn()) { stopped = budget.summary().stops.slice(-1)[0] || 'maxModelTurns'; break; }

    budget.countModelTurn();
    const turnNo = budget.summary().modelTurns;
    let plan;
    try {
      plan = await planner({
        request,
        evidence: evidence.slice(),
        toolsAvailable: registry.list(),
        budget: budget.summary(),
        turn: turnNo,
        conflicts: _detectConflicts(evidence),
      });
    } catch (e) {
      logger.warn('[ai-agent-loop] planner threw: ' + e.message);
      stopped = 'planner-error';
      break;
    }

    if (typeof hooks.afterPlan === 'function') {
      try { await hooks.afterPlan(plan, turnNo); } catch (e) { hookFail(e); break; }
    }

    if (plan && plan.decision === 'stop') { stopped = plan.code || 'planner-stop'; break; }
    if (!plan || plan.decision === 'final') { finalResult = plan && plan.result != null ? plan.result : null; break; }

    if (plan.decision === 'request_tools' && Array.isArray(plan.tools) && plan.tools.length) {
      // Bound the batch to the remaining tool-call budget (and the per-turn cap).
      const remaining = budget.toolCallsRemaining();
      if (remaining <= 0) {
        if (opts.stopOnBudget) {
          const reqs = plan.tools.map((r) => r || {});
          try { for (const req of reqs) await _skip(req, 'BUDGET_maxToolCalls', opts, toolLog, evidence); } catch (e) { hookFail(e); break; }
        }
        stopped = 'maxToolCalls';
        break;
      }
      const take = maxPerTurn ? Math.min(remaining, maxPerTurn) : remaining;
      const batch = plan.tools.slice(0, take);
      const dropped = plan.tools.slice(take);

      // Split dependent vs independent: here all requested tools in one planner
      // turn are treated as INDEPENDENT (the planner expresses dependencies by
      // requesting across turns). Run them with bounded concurrency (spec §14).
      const results = await _runToolsConcurrently(batch, opts);
      if (opts.hookErr) { hookFail(opts.hookErr); _logResults(results, budget, toolLog, evidence); break; }
      _logResults(results, budget, toolLog, evidence);

      if (opts.stopOnBudget && dropped.length) {
        try {
          for (let k = 0; k < dropped.length; k++) {
            const pos = take + k;
            const code = maxPerTurn && pos >= maxPerTurn ? 'TOO_MANY_PER_TURN' : 'BUDGET_maxToolCalls';
            await _skip(dropped[k] || {}, code, opts, toolLog, evidence);
          }
        } catch (e) { hookFail(e); break; }
      }

      if (typeof hooks.shouldStop === 'function') {
        try {
          for (const r of results) {
            const s = await hooks.shouldStop(r.env);
            if (s != null) { stopped = s; break; }
          }
        } catch (e) { hookFail(e); break; }
        if (stopped) break;
      }

      const progressed = results.some((r) => r.executed || r.reused);
      if (opts.stopOnBudget && !progressed && results.some((r) => r.budgetSkip)) {
        stopped = budget.summary().stops.slice(-1)[0] || 'maxToolCalls';
        break;
      }
      if (noProgressN) {
        noProgress = progressed ? 0 : noProgress + 1;
        if (noProgress >= noProgressN) { stopped = 'no_progress'; break; }
      }
      continue;
    }

    if (noProgressN && plan.decision === 'request_tools') {
      // An empty request is a turn without progress, not a final answer.
      noProgress++;
      if (noProgress >= noProgressN) { stopped = 'no_progress'; break; }
      continue;
    }

    // Planner returned something unexpected -> treat as final (no tools).
    finalResult = plan.result != null ? plan.result : null;
    break;
  }

  const out = {
    ok: !stopped || !!finalResult,
    result: finalResult,
    evidence,
    conflicts: _detectConflicts(evidence),
    budget: budget.summary(),
    stopped,
    toolLog,
  };
  if (hookError) out.hookError = hookError;
  return out;
}

function _logResults(results, budget, toolLog, evidence) {
  for (const r of results) {
    toolLog.push({ tool: r.env.tool, args: r.args, ok: r.env.ok, freshness: r.env.freshness, source: r.env.source, denied: r.env.denied, error: r.env.error });
    if (r.env.ok) {
      // Evidence-bytes accounting (spec §13 budgeting).
      budget.addEvidenceBytes(_sizeOf(r.env));
      evidence.push(r.env);
    } else {
      // Keep failed/denied as evidence too, so the model knows what it
      // could NOT get (missing/denied is material to a grounded answer).
      evidence.push(r.env);
    }
  }
}

// A request the core rejected before execution (stopOnBudget only): logged and sent to afterTool.
async function _skip(req, code, opts, toolLog, evidence) {
  const env = { ok: false, tool: String(req.tool || '?'), status: 'SKIPPED', code, error: code, freshness: 'UNKNOWN', confidence: 0 };
  toolLog.push({ tool: env.tool, args: req.args || {}, ok: false, freshness: env.freshness, source: undefined, denied: undefined, error: code });
  evidence.push(env);
  if (typeof opts.hooks.afterTool === 'function') await opts.hooks.afterTool(req, env);
}

/**
 * runToolWithTimeout(registry, name, args, ctx, ms, signal) -> Promise<env>. Never rejects.
 * The tool gets a ctx copy with a per-call toolSignal, aborted on expiry and when `signal` aborts.
 */
async function runToolWithTimeout(registry, name, args, ctx, ms, signal) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  }
  const callCtx = Object.assign({}, ctx || {}, { toolSignal: ac.signal });
  const fail = (e) => ({ ok: false, tool: name, error: e && e.message ? e.message : String(e), freshness: 'UNKNOWN', confidence: 0 });
  let timer = null;
  try {
    const p = Promise.resolve().then(() => registry.execute(name, args, callCtx)).catch(fail);
    if (!(Number.isFinite(ms) && ms > 0)) return await p;
    const t = new Promise((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve({ ok: false, tool: name, error: 'TOOL_TIMEOUT', code: 'TOOL_TIMEOUT', freshness: 'UNKNOWN', confidence: 0 });
      }, ms);
    });
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}

function _timeoutOf(opts, name) {
  if (opts.timeoutFor) {
    let v = null;
    try { v = opts.timeoutFor(name); } catch (_) { v = null; }
    if (Number.isFinite(v) && v > 0) return v;
  }
  return opts.toolTimeoutMs;
}

// Run a batch of independent tool requests concurrently, bounded by `concurrency`
// and the remaining tool-call budget. Rejects unknown tools as data.
async function _runToolsConcurrently(batch, opts) {
  const { budget, signal, seen, concurrency, registry, ctx, hooks, keyOf, stopOnBudget } = opts;
  const out = [];
  let i = 0;
  const after = async (req, env) => { if (typeof hooks.afterTool === 'function') await hooks.afterTool(req, env); };

  async function worker() {
    while (i < batch.length) {
      if (_aborted(signal) || opts.hookErr) return;
      const idx = i++;
      const req = batch[idx] || {};
      const name = req.tool;
      const args = req.args || {};
      try {
        if (!budget.canCallTool()) {
          if (!stopOnBudget) return;
          const code = 'BUDGET_' + (budget.summary().stops.slice(-1)[0] || 'maxToolCalls');
          const env = { ok: false, tool: String(name || '?'), status: 'SKIPPED', code, error: code, freshness: 'UNKNOWN', confidence: 0 };
          out[idx] = { args, env, budgetSkip: true };
          await after(req, env);
          continue;
        }

        // Unknown tool -> report as data, do not execute (spec: can request tools
        // but cannot invent new tools).
        if (!registry.has(name)) {
          const env = { ok: false, tool: String(name || '?'), status: 'DENIED', code: 'UNKNOWN_TOOL', error: 'unknown tool (not in catalog)', freshness: 'UNKNOWN', confidence: 0, denied: false };
          out[idx] = { args, env };
          await after(req, env);
          continue;
        }
        // Dedupe identical tool+args within one request (spec §15 request cache).
        const key = keyOf(name, args);
        if (seen.has(key)) {
          const env = { ok: false, tool: name, status: 'SKIPPED', code: 'DUPLICATE', error: 'SKIPPED: already retrieved this exact query', freshness: 'UNKNOWN', confidence: 0, cached: true };
          out[idx] = { args, env };
          await after(req, env);
          continue;
        }
        seen.add(key);
        budget.countToolCall(1);
        let env = null;
        let executed = false;
        if (typeof hooks.beforeTool === 'function') {
          const pre = await hooks.beforeTool(req, idx);
          if (pre && pre.env) env = pre.env;
        }
        if (env) {
          if (env.reused === true) budget.toolCalls = Math.max(0, budget.toolCalls - 1);   // reuse is not a call
        } else {
          env = await runToolWithTimeout(registry, name, args, ctx, _timeoutOf(opts, name), signal);
          executed = true;
        }
        out[idx] = { args, env, executed, reused: env.reused === true };
        await after(req, env);
      } catch (e) {
        opts.hookErr = e || new Error('hook');
        return;
      }
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

module.exports = { run, runToolWithTimeout };
