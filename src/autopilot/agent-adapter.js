'use strict';
/**
 * autopilot/agent-adapter.js — the read-only multi-turn investigation of one case
 * (V2 design §6.3, review findings 3 and 10).
 *
 *   runAgentInvestigation(input) -> Promise<AgentResult>
 *   trackAiCall(fn), aiInFlight(), adjustQueueForOwn(q, own)  (shared with the V1 single-call path)
 *
 * input: { caseId, runId, rec, row, basePack, analysis, cfg, ports, limiter, signal, now, leaseOwner,
 *          leaseUntilFn, caseStore, reason, aiBusy, resume, deep, changedSlices, docs, priorCases,
 *          syncedAt, buildAtMs, staleDays, isDown, logger }
 *   resume: { steps, toolItems, turnsUsed, toolsUsed, bytesUsed, elapsedUsedMs, liveDone[] } | null
 *
 * AgentResult: { status: 'concluded'|'invalid'|'stopped', stopCode, output, warnings, memory, tier, turns,
 *   toolCalls, reusedCalls, aiCalls, aiLatencyMs[], lane, isolated, model, blockedSources[], evidenceItems,
 *   conflicts }
 *
 * Every step (model turn, tool call, preload, skip, final, stop) is written to ap_step through
 * case-store under the run's lease BEFORE it runs. The adapter never transitions case state and
 * never builds a gateway-lane prompt: every planner prompt is the isolated form, sent with
 * isolated:true. reason() and aiBusy() are injected (this file requires neither ../orcha/reason
 * nor ./investigate). Tools come only from the frozen read-only registry. Logs carry codes,
 * counts, ids and ms only.
 */

const crypto = require('crypto');
const core = require('../ai/agent-loop-core');
const { Budget } = require('../ai/budget');
const untrusted = require('../email-intel/untrusted');
const complexity = require('./complexity');
const memoryMod = require('./memory');
const prompt = require('./prompt');
const validate = require('./validate');
const fingerprint = require('./fingerprint');
const { buildConflicts } = require('./conflicts');
const registryMod = require('./tool-registry');
const evidence = require('./evidence');
const slices = require('./slices');
const { SOURCES: S, OPERATIONAL_CADENCE, LIMITS, ApError, normUnit, localDate } = require('./constants');

const { TOOL_DEFS, TOOL_NAMES } = registryMod;
const PLANNER_INVALID_ERRORS = new Set(['reason-timeout', 'unparseable', 'missing-array']);
const STEP_ARGS_MAX = 900;
const PRELOAD = Object.freeze(['existing_timeline', 'previous_findings']);

// ── own AI calls (process-local; reset on restart when nothing is in flight) ──

let _inFlight = 0;
async function trackAiCall(fn) {
  _inFlight++;
  try { return await fn(); } finally { _inFlight--; }
}
function aiInFlight() { return _inFlight; }
/** Pure: remove this process's own Autopilot calls from the relay queue view. */
function adjustQueueForOwn(q, own) {
  if (!q || typeof q !== 'object') return q;
  const n = Math.max(0, Number(own) || 0);
  const waiting = Number(q.waiting) || 0;
  const ownW = Math.min(n, waiting);
  const ownA = n - ownW;
  return Object.assign({}, q, { waiting: waiting - ownW, active: Math.max(0, (Number(q.active) || 0) - ownA) });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _size(x) { try { return JSON.stringify(x).length; } catch (_) { return 0; } }
function _lc(s) { return String(s || '').toLowerCase(); }
function _backendsDown(st) {
  const b = st && st.backends;
  if (!b || typeof b !== 'object') return false;
  return !Object.keys(b).some((k) => b[k] === true);
}
function _stepArgs(a) {
  const v = a && typeof a === 'object' ? a : {};
  return Buffer.byteLength(fingerprint.stableStringify(v), 'utf8') > STEP_ARGS_MAX ? { truncated: true } : v;
}
function _liveMinAge(source) {
  return source === S.AAP_CACHE || source === S.AAP_LIVE ? OPERATIONAL_CADENCE.aapLiveMinAgeMs : OPERATIONAL_CADENCE.decisivLiveMinAgeMs;
}
function _parse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function _stopped(code, extra) {
  return Object.assign({ status: 'stopped', stopCode: code, output: null, warnings: [] }, extra);
}

/** runAgentInvestigation(input) -> AgentResult. Throws ApError(LEASE_LOST | STORE_BUSY | ...) on a store failure. */
async function runAgentInvestigation(input) {
  const i = input || {};
  const cs = i.caseStore;
  const ports = i.ports;
  const cfg = i.cfg || {};
  const rec = i.rec || {};
  const row = i.row || {};
  const caseId = i.caseId || rec.case_id;
  const runId = i.runId;
  const signal = i.signal || null;
  const now = typeof i.now === 'function' ? i.now : Date.now;
  const reason = i.reason;
  const aiBusy = typeof i.aiBusy === 'function' ? i.aiBusy : () => false;
  const basePack = i.basePack || { items: [], sourceStatus: {}, sourceCalls: [] };
  const analysis = i.analysis || {};
  const resume = i.resume || null;
  const logger = i.logger && typeof i.logger.info === 'function' ? i.logger : null;
  const lease = () => ({ leaseOwner: i.leaseOwner, leaseUntil: typeof i.leaseUntilFn === 'function' ? i.leaseUntilFn() : undefined, now: now() });
  const doneMeta = () => ({ leaseOwner: i.leaseOwner, caseId, now: now() });
  const aborted = () => !!(signal && signal.aborted);
  const aiCfg = cfg.ai || {};
  const turnTimeoutMs = Number.isFinite(aiCfg.turnTimeoutMs) ? aiCfg.turnTimeoutMs : 60000;
  const dailyCap = Number.isFinite(aiCfg.dailyCap) ? aiCfg.dailyCap : (Number.isFinite(cfg.dailyCap) ? cfg.dailyCap : 48);

  // 1. tier and budget.
  let tier = i.deep ? 'complex' : complexity.classify({ rec, row, analysis, basePack, priorCases: i.priorCases, now: now() }).tier;
  const tiers = cfg.complexityTiers || {};
  const budget = new Budget(tiers[tier] || {});
  if (resume) {
    budget.modelTurns = Number(resume.turnsUsed) || 0;
    budget.toolCalls = Number(resume.toolsUsed) || 0;
    budget.evidenceBytes = Number(resume.bytesUsed) || 0;
    budget.startedAt = Date.now() - (Number(resume.elapsedUsedMs) || 0);   // Budget uses Date.now()
  }

  // 2. memory, evidence index, dedupe seeds, tool context.
  let memory = memoryMod.load(rec.memory_json) || memoryMod.init(rec, row);
  const evidenceIndex = new Map();
  for (const it of _arr(basePack.items)) if (it && it.evidenceId) evidenceIndex.set(it.evidenceId, it);
  const resumeItems = resume ? _arr(resume.toolItems).filter((it) => it && it.evidenceId) : [];
  for (const it of resumeItems) evidenceIndex.set(it.evidenceId, it);
  const toolItems = [];   // items added by tools in this run (AgentResult.evidenceItems)
  const keyOf = registryMod.keyOf;
  const seen = new Set();
  const interruptedLive = new Set();
  let seq = 0;
  for (const st of resume ? _arr(resume.steps) : []) {
    if (Number.isInteger(st.seq) && st.seq > seq) seq = st.seq;
    if (st.kind !== 'tool' || !st.tool) continue;
    const args = st.args || _parse(st.args_json) || {};
    const key = keyOf(st.tool, args);
    if (st.status === 'interrupted') { if (st.live === 1 || st.live === true) interruptedLive.add(key); }
    else seen.add(key);
  }
  const liveDone = new Set(resume ? _arr(resume.liveDone)
    : _arr(basePack.sourceCalls).filter((c) => c && Number(c.attempts) > 0).map((c) => c.source));
  // t.woSet = case wo_set ids ∪ evidence.woSetOf(row, riEvents) ids (the base pack's woSet carries the ri part).
  const woSet = new Set(evidence.woSetOf(row, []));
  for (const id of _arr(basePack.woSet)) if (id) woSet.add(String(id));
  for (const w of _arr(_parse(rec.wo_set_json))) if (w && w.id) woSet.add(String(w.id));
  const blockedSources = new Set();
  const pick = (name) => (cs && typeof cs[name] === 'function' ? cs[name].bind(cs) : () => null);
  const t = {
    caseId, unit: normUnit(rec.unit_id || row.equipmentId), row, rec, woSet, ports, limiter: i.limiter || null, cfg,
    now, syncedAt: i.syncedAt, buildAtMs: i.buildAtMs, staleDays: i.staleDays, isDown: !!i.isDown, docs: i.docs || {},
    basePack, evidenceIndex, memory, priorCases: _arr(i.priorCases), blockedSources, liveDone, signal,
    caseStore: Object.freeze({ getRecord: pick('getRecord'), listProposals: pick('listProposals') }),
  };
  const registry = registryMod.createRegistry(t);

  const stats = { aiCalls: 0, aiLatencyMs: [], reusedCalls: 0, answered: 0, model: null };
  const mkResult = (base) => Object.assign({
    memory, tier, turns: stats.aiCalls, toolCalls: budget.toolCalls, reusedCalls: stats.reusedCalls, aiCalls: stats.aiCalls,
    aiLatencyMs: stats.aiLatencyMs.slice(), lane: 'isolated', isolated: true, model: stats.model,
    blockedSources: [...blockedSources], evidenceItems: toolItems.slice(),
    conflicts: buildConflicts([...evidenceIndex.values()].filter((it) => it.trust !== 'derived_ai' && it.trust !== 'prior_conclusion'), { isDown: !!i.isDown }),
  }, base);
  const writeMarker = (kind, status, code) => {
    const b = cs.beginStep({ caseId, runId, seq: ++seq, turn: budget.modelTurns, kind, startedAt: now() }, lease());
    cs.completeStep(b.stepId, { status, code: code || null }, [], doneMeta());
  };
  const finish = (res) => {
    if (logger) logger.info('[autopilot] agent case=' + caseId + ' run=' + runId + ' status=' + res.status + ' stop=' + (res.stopCode || '-')
      + ' tier=' + tier + ' turns=' + res.turns + ' tools=' + res.toolCalls + ' ms=' + budget.elapsedMs());
    return res;
  };

  // 3. AI backends all down -> stop before any reservation.
  let st0 = null;
  try { st0 = ports.aiStatus(); } catch (_) { st0 = null; }
  stats.model = (st0 && st0.model) || null;
  if (_backendsDown(st0)) {
    writeMarker('stop', 'stopped', 'ai_unavailable');
    return finish(mkResult(_stopped('ai_unavailable')));
  }

  // Per-request step bookkeeping (concurrency 1: one pending tool step at a time).
  const begun = new Map();   // req -> { stepId, key, tool, argsHash, startedAt }
  const toolSteps = [];      // prompt view: [{ seq, tool, status, code, items }]
  if (resumeItems.length) toolSteps.push({ seq: 0, tool: 'resumed_results', status: 'ok', code: null, items: resumeItems });
  let curTurn = 0;
  let promoted = false;

  function _normArgs(req) {
    const n = registryMod.normalizeArgs(req.tool, req.args || {});
    return n.ok ? n.args : _stepArgs(req.args || {});
  }
  function _begin(req, extra) {
    const d = TOOL_DEFS[req.tool];
    const args = _normArgs(req);
    const argsHash = _sha1(fingerprint.stableStringify(args));
    const step = Object.assign({
      caseId, runId, seq: ++seq, turn: curTurn, kind: 'tool', tool: String(req.tool || '?').slice(0, 40), args, argsHash,
      source: d ? d.source : null, live: !!(d && d.costClass === 'live'), why: req.why || null, startedAt: now(),
    }, extra || {});
    const b = cs.beginStep(step, lease());
    const info = { stepId: b.stepId, seq: step.seq, tool: step.tool, argsHash, key: keyOf(req.tool, req.args || {}) };
    begun.set(req, info);
    return info;
  }

  function afterTool(req, env) {
    let info = begun.get(req);
    if (!info) info = _begin(req);   // rejected by the core before beforeTool: duplicate, unknown tool or budget
    begun.delete(req);
    const status = env && env.status ? _lc(env.status) : (env && env.code === 'TOOL_TIMEOUT' ? 'timeout' : 'error');
    const code = (env && (env.code || (env.status ? null : env.error))) || null;
    const items = _arr(env && env.items);
    const newItems = items.filter((it) => it && !it.dup && !evidenceIndex.has(it.evidenceId));
    for (const it of newItems) {
      if (!Array.isArray(it.flags)) it.flags = [];
      if (!it.flags.includes('tool')) it.flags.push('tool');
      evidenceIndex.set(it.evidenceId, it);
      toolItems.push(it);
    }
    cs.completeStep(info.stepId, {
      status, code: code ? String(code).slice(0, 60) : null, summary: env && env.summary ? env.summary : null,
      resultBytes: _size(env), reusedStepId: env && env.reusedStepId ? env.reusedStepId : null,
    }, newItems, doneMeta());
    if (env && env.reused === true) stats.reusedCalls++;
    memory = memoryMod.recordTool(memory, { tool: info.tool, argsHash: info.argsHash, status, code, at: now(), sourceFp: env && env.sourceFp, stepId: info.stepId, runId, seq: info.seq });
    t.memory = memory;
    toolSteps.push({ seq: info.seq, tool: info.tool, status, code, items });
    if (tier === 'simple' && !promoted && req.tool === 'compare_conflicting_status' && items.length) {
      promoted = true;
      tier = 'standard';
      Object.assign(budget.limits, new Budget(tiers.standard || {}).limits);
    }
  }

  async function beforeTool(req) {
    const d = TOOL_DEFS[req.tool];
    const key = keyOf(req.tool, req.args || {});
    if (interruptedLive.has(key)) {
      _begin(req);
      return { env: registryMod.envelope(d || { name: req.tool, source: null }, 'SKIPPED', 'INTERRUPTED_LIVE_NOT_REISSUED', []) };
    }
    const live = !!(d && d.costClass === 'live');
    let preFp = null;
    if (live) {
      // §6.2.5: the pre-call slice fp, so call_key does not depend on which tools ran earlier.
      const docOf = (k) => {
        if (t.docs && Object.prototype.hasOwnProperty.call(t.docs, k)) return t.docs[k];
        try { return t.ports.readStore(k); } catch (_) { return null; }
      };
      try { preFp = slices.sliceFp(d.source === S.DECISIV ? 'decisiv' : 'comments', t.row, docOf); } catch (_) { preFp = null; }
    }
    const args = _normArgs(req);
    const argsHash = _sha1(fingerprint.stableStringify(args));
    const callKey = _sha1([caseId, String(req.tool), argsHash, preFp || ''].join('|'));
    let reusable = null;
    if (live && typeof cs.findReusableStep === 'function') reusable = cs.findReusableStep(caseId, callKey, now() - _liveMinAge(d.source));
    _begin(req, { sourceFp: preFp });
    if (reusable) {
      const items = typeof cs.findingsForStep === 'function' ? cs.findingsForStep(reusable.step_id) : [];
      const env = registryMod.envelope(d, 'REUSED', null, items);
      env.reused = true;
      env.reusedStepId = reusable.step_id;
      return { env };
    }
    return null;
  }

  // 3a. turn-0 preload (not charged to toolCalls; bytes count).
  for (const tool of PRELOAD) {
    const req = { tool, args: tool === 'previous_findings' ? { unit: t.unit, scope: 'both' } : { unit: t.unit }, why: 'preload' };
    const key = keyOf(req.tool, req.args);
    if (seen.has(key)) continue;
    seen.add(key);
    _begin(req);
    const env = await core.runToolWithTimeout(registry, tool, req.args, {}, TOOL_DEFS[tool].timeoutMs(cfg), signal);
    budget.addEvidenceBytes(_size(env));
    afterTool(req, env);
  }

  // 4. planner: one reason() per turn.
  let invalidStreak = 0;
  let timeoutStreak = 0;
  let fatal = null;
  const storeStop = (e) => { fatal = e; return { decision: 'stop', code: 'store_error' }; };
  async function planner(state) {
    curTurn = state.turn;
    if (aborted()) return { decision: 'stop', code: 'aborted' };
    let lane = false;
    try { lane = ports.isolatedLaneAvailable() === true; } catch (_) { lane = false; }
    if (!lane) return { decision: 'stop', code: 'lane_unavailable' };
    if (aiCfg.yieldToHighPriority !== false) {
      let q = null;
      try { q = ports.aiQueue(); } catch (_) { q = null; }
      if (aiBusy(adjustQueueForOwn(q, aiInFlight()))) return { decision: 'stop', code: 'ai_busy' };
    }
    let step;
    try {
      step = cs.reserveAiTurn({ caseId, runId, seq: seq + 1, turn: state.turn, kind: 'model', startedAt: now() }, localDate(now()), dailyCap, lease());
    } catch (e) { return storeStop(e); }
    if (!step) return { decision: 'stop', code: 'ai_cap' };
    seq++;
    const requestId = 'ap-' + runId + '-' + seq;
    const pr = prompt.buildPlannerPrompt({
      rec, analysis, memoryView: memoryMod.promptView(memory), evidenceIndex, basePack, steps: toolSteps,
      catalog: registry.list(), tier, turn: state.turn, maxTurns: budget.limits.maxModelTurns,
      toolCallsLeft: budget.toolCallsRemaining(), changedSlices: i.changedSlices, deep: !!i.deep, woCount: woSet.size, isDown: !!i.isDown,
    }, { nonce: untrusted.newNonce() });
    const t1 = now();
    stats.aiCalls++;
    let r;
    try {
      r = await trackAiCall(() => reason({
        prompt: pr.prompt, source: 'autopilot', label: 'autopilot', priority: 'low', timeoutMs: turnTimeoutMs,
        isolated: true, signal: signal || undefined, requestId,
      }));
    } catch (e) { r = { ok: false, error: (e && e.code) || 'reason-threw' }; }
    const latency = Math.max(0, now() - t1);
    stats.aiLatencyMs.push(latency);
    if (aborted()) {
      try { cs.completeStep(step.stepId, { status: 'interrupted', code: 'ABORTED', aiLatencyMs: latency, aiLane: 'isolated', aiRequestId: requestId }, [], doneMeta()); } catch (e) { return storeStop(e); }
      return { decision: 'stop', code: 'aborted' };
    }
    const v = validate.validatePlannerTurn(r, { toolNames: TOOL_NAMES });
    try {
      cs.completeStep(step.stepId, {
        status: v.ok ? 'ok' : 'invalid', code: v.code ? String(v.code).slice(0, 60) : null,
        summary: { decision: v.decision, tools: v.tools.length, clipped: pr.clipped }, aiLatencyMs: latency, aiLane: 'isolated', aiRequestId: requestId,
      }, [], doneMeta());
    } catch (e) { return storeStop(e); }
    if (!(r && r.ok) && !PLANNER_INVALID_ERRORS.has(r && r.error)) return { decision: 'stop', code: 'ai_unavailable' };
    if (!v.ok) {
      invalidStreak++;
      timeoutStreak = r && r.error === 'reason-timeout' ? timeoutStreak + 1 : 0;
      if (invalidStreak >= LIMITS.invalidTurnStreak) return { decision: 'stop', code: timeoutStreak >= LIMITS.invalidTurnStreak ? 'ai_timeout' : 'planner_invalid' };
      return { decision: 'request_tools', tools: [] };
    }
    invalidStreak = 0;
    timeoutStreak = 0;
    stats.answered++;
    memory = memoryMod.mergeTurn(memory, Object.assign({}, v.memory, { turn: state.turn }), { evidenceIndex, runId, at: now() });
    memory.nextPlannedTool = v.tools[0] ? { tool: v.tools[0].tool, args: _stepArgs(v.tools[0].args) } : null;
    memory = memoryMod.trim(memory);
    t.memory = memory;
    try { cs.writeMemory(caseId, memory, lease()); } catch (e) { return storeStop(e); }
    return v.decision === 'final' ? { decision: 'final', result: v.result } : { decision: 'request_tools', tools: v.tools };
  }

  // 6. the loop.
  const out = await core.run({
    request: { caseId }, planner, registry, ctx: {}, budget, signal, concurrency: 1,
    initialEvidence: [], seen, keyOf, toolTimeoutMs: (cfg.tools && cfg.tools.timeoutMs) || 20000,
    timeoutFor: (n) => (TOOL_DEFS[n] && TOOL_NAMES.includes(n) ? TOOL_DEFS[n].timeoutMs(cfg) : null),
    maxToolsPerTurn: LIMITS.maxToolsPerTurn, stopOnNoProgress: LIMITS.noProgressTurns, stopOnBudget: true,
    hooks: { beforeTool, afterTool, shouldStop: () => null },
  });

  // 7. store failures go to the investigate error path.
  if (fatal) throw fatal;
  if (out.hookError) throw new ApError(out.hookError.code || 'HOOK_ERROR');

  // 8. a final answer.
  if (out.result != null && !aborted()) {
    const items = [...evidenceIndex.values()];
    const pack = { items, conflicts: buildConflicts(items, { isDown: !!i.isDown }) };
    const v = validate.validateAiOutput(out.result, pack);
    const supported = v.ok && validate.hasSourceSupport(v.output, pack);
    writeMarker('final', supported ? 'final' : 'invalid', supported ? null : (v.ok ? 'circular_only' : 'invalid_final'));
    if (supported) return finish(mkResult({ status: 'concluded', stopCode: null, output: v.output, warnings: v.warnings || [] }));
    return finish(mkResult({ status: 'invalid', stopCode: v.ok ? 'circular_only' : 'invalid_final', output: null, warnings: v.warnings || [] }));
  }

  // 9. a stop.
  const code = aborted() ? 'aborted' : (out.stopped || 'planner-stop');
  writeMarker('stop', 'stopped', code);
  return finish(mkResult(_stopped(code)));
}

module.exports = { runAgentInvestigation, trackAiCall, aiInFlight, adjustQueueForOwn };
