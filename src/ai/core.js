'use strict';
/**
 * src/ai/core.js — Unified Internal AI Core (spec #1).
 *
 * ONE API that every AI surface (Slack DM/channel, Fleet Chat UI, DBR, WBR,
 * self-DM, briefings) can enter through:
 *
 *   aiCore.run({ actor, source, message, conversation, entities, task,
 *                permissions, attachments, metadata })
 *
 * ── DESIGN PRINCIPLE (spec: CONNECT + STANDARDIZE, do NOT replace) ──────────
 * AiCore is a THIN ORCHESTRATION FACADE over the already-production Digital FAS
 * layer (src/orcha/fas/*). It does NOT re-implement intent detection, tool
 * calling, evidence building, permissions, idempotency, verification, or
 * cluster claims — those live in the FAS agent/runner/executor and STAY there.
 * AiCore's job is to:
 *   - give the whole app one stable entry point + one structured result shape,
 *   - normalize the various surfaces onto the FAS agent's input contract,
 *   - validate the structured decision (schemas.js) and fail safe,
 *   - record a standardized operational trace (trace.js),
 *   - surface proposed actions (it NEVER executes production writes itself —
 *     Digital FAS is the only authority that mutates; spec #5/#12).
 *
 * Behavior parity: AiCore uses the SAME resolved sender profile / permissions
 * the rest of the app uses (orcha/fas/sender-profiles.resolveSender). The AI
 * can never widen a contact's permissions here (spec #8) — AiCore performs no
 * authorization of its own; it only passes the sender identity to FAS, which
 * enforces scope/category/3-state permissions in code as it does today.
 *
 * This Phase-A module is ADDITIVE. Nothing in the existing Slack/UI/DBR/WBR
 * paths is required to call it yet; it can be adopted surface-by-surface
 * (spec migration Phases B–E) without changing current behavior.
 */

const schemas = require('./schemas');
const trace = require('./trace');
let router; try { router = require('./router'); } catch (_) { router = null; }
let memory; try { memory = require('./memory'); } catch (_) { memory = null; }
let logger; try { logger = require('../utils/logger').createLogger('ai-core'); } catch (_) { logger = { info() {}, warn() {} }; }

// Lazy FAS requires so AiCore never hard-fails to load if a submodule is mid-
// refactor; each is guarded at call time.
function _fas() {
  return {
    agent: _tryReq('../orcha/fas/agent'),
    runner: _tryReq('../orcha/fas/runner'),
    profiles: _tryReq('../orcha/fas/sender-profiles'),
    config: _tryReq('../orcha/fas/config'),
  };
}
function _tryReq(p) { try { return require(p); } catch (_) { return null; } }

/**
 * Known inbound surfaces. Each maps to how the FAS agent/runner should treat
 * the request. AiCore does not invent new behavior per surface — it routes to
 * the SAME FAS path the surface would use today.
 */
const SOURCES = {
  slack_dm: { engine: 'dm', isGroup: false },
  slack_dm_thread: { engine: 'dm', isGroup: false },
  slack_channel: { engine: 'channel', isGroup: true },
  self_dm: { engine: 'dm', isGroup: false, isSelf: true },
  ui: { engine: 'ui', isGroup: false },
  fleet_chat: { engine: 'ui', isGroup: false },
  dbr: { engine: 'report', isGroup: false },
  wbr: { engine: 'report', isGroup: false },
};

function _sourceMeta(source) { return SOURCES[source] || { engine: 'ui', isGroup: false }; }

/**
 * run(request) -> Promise<AiCoreResult>
 *
 * request:
 *   actor        : { slackId?, name?, type? }  — who is asking. AiCore resolves
 *                  this to the SAME permission profile the app uses. The AI can
 *                  never expand it (spec #8).
 *   source       : one of SOURCES keys (slack_dm, ui, dbr, wbr, ...).
 *   message      : the inbound text (string).
 *   conversation : optional array of prior turns (strings or {speaker,text}).
 *   entities     : optional pre-extracted entities (units/sites/vendors). Hint
 *                  only — FAS still extracts/validates its own.
 *   task         : optional task metadata { taskType, complexity, actionRisk,
 *                  requiresVision, latencyClass }. Recorded on the trace and
 *                  available to the model router (spec #6); does not change
 *                  permissions.
 *   permissions  : optional, IGNORED for authorization — FAS resolves the real
 *                  permissions from the Contact Book. Present only so callers
 *                  can pass a hint; it can never widen access.
 *   attachments  : optional inline attachment-context string (links/previews)
 *                  AND/OR `files` array of raw Slack file objects for the FAS
 *                  evidence builder (spec #13 — same normalized evidence path).
 *   metadata     : optional { channelId, channelName, ts, threadTs, requestId,
 *                  covering, mode } passthrough for the runner.
 *
 * Returns a standardized structured result (see _result()). AiCore NEVER sends
 * a Slack message or mutates fleet state — proposed actions are returned for
 * the Digital FAS executor (invoked by the runner/caller), per spec #5/#12.
 */
async function run(request) {
  request = request || {};
  const src = _sourceMeta(request.source);
  const meta = request.metadata || {};
  const actor = request.actor || {};

  // TASK-AWARE ROUTING (spec #6): classify the task and record a RECOMMENDED
  // lane/model on the trace. This is ADVISORY observability — it does NOT force
  // the relay to change lanes or duplicate calls; the proven relay fallback
  // cascade still owns actual execution. Best-effort; never blocks a request.
  let routing = null;
  try { if (router) routing = router.route(request); } catch (_) { routing = null; }

  const tr = trace.start({
    requestId: meta.requestId,
    source: request.source || 'unknown',
    actor,
    taskType: (routing && routing.task && routing.task.taskType) || (request.task && request.task.taskType) || null,
    lane: routing && routing.recommendation ? routing.recommendation.lane : null,
  });
  if (routing && routing.recommendation) tr.setModel(routing.recommendation.modelHint, routing.recommendation.lane);

  const fas = _fas();
  if (!fas.agent || typeof fas.agent.runAgent !== 'function') {
    tr.setError('FAS agent unavailable').setOutcome('error').finish({ outcome: 'error' });
    return _result({ ok: false, requestId: tr.requestId, error: 'AI core unavailable (FAS agent not loaded)' });
  }

  // Normalize the inbound into the FAS agent's input contract. We DO NOT
  // resolve permissions here — resolveSender (inside the agent) is the single
  // authority, identical to the rest of the app (spec #8 parity).
  const agentInput = {
    slackId: actor.slackId || '',
    senderName: actor.name || actor.slackId || '',
    text: String(request.message || ''),
    conversation: _normalizeConversation(request.conversation),
    isGroup: !!src.isGroup,
    isSelf: !!src.isSelf,
    attachments: _attachmentString(request.attachments),
    files: _attachmentFiles(request.attachments),
    // mode override only honored by the agent/runner if present (tests/DBR).
    mode: meta.mode || undefined,
  };

  let decision;
  try {
    decision = await fas.agent.runAgent(agentInput);
  } catch (e) {
    logger.warn('[ai-core] agent failed: ' + e.message);
    tr.setError(e).addFallback('agent-error').setOutcome('error').finish({ outcome: 'error' });
    return _result({ ok: false, requestId: tr.requestId, error: 'agent error: ' + e.message });
  }

  // Fold operational telemetry into the trace (tools, evidence sources, proposals).
  tr.foldDecision(decision);

  // Validate the structured output; attempt ONE repair; fail safe (spec #7).
  const validated = schemas.validateOrRepair(decision);
  tr.setValidation(validated.ok, validated.repaired);
  if (validated.repaired) tr.addFallback('schema-repair');
  // Preserve FAS internal telemetry fields on the repaired object so downstream
  // (and the result) still carry evidence/loop/profile context.
  const finalDecision = validated.failSafe
    ? _mergeTelemetry(validated.decision, decision)
    : decision;

  const structured = _toStructuredDecision(finalDecision, request, validated);

  tr.setOutcome(validated.failSafe ? 'failsafe' : (finalDecision.decision || 'answer'))
    .finish({ outcome: validated.failSafe ? 'failsafe' : (finalDecision.decision || 'answer'),
      validated: validated.ok });

  return _result({
    ok: !validated.failSafe,
    requestId: tr.requestId,
    decision: structured,
    raw: finalDecision,          // full FAS decision for callers that need _evidence etc.
    source: request.source || 'unknown',
    failSafe: validated.failSafe,
    routing,                     // advisory task classification + lane recommendation (spec #6)
  });
}

/**
 * handleInbound(request, deps) -> Promise<result>
 * Convenience wrapper for Slack surfaces that want the FULL runner semantics
 * (mode gating, shadow/approval/autonomous routing, legacy-reply arbitration,
 * action execution through the verified executor). This delegates ENTIRELY to
 * orcha/fas/runner.handleInbound — the SAME path Slack uses today — and simply
 * records a trace around it. It changes NO behavior; it is the standardized
 * seam for spec migration Phase C.
 */
async function handleInbound(request, deps) {
  request = request || {};
  const src = _sourceMeta(request.source);
  const meta = request.metadata || {};
  const actor = request.actor || {};

  const tr = trace.start({
    requestId: meta.requestId,
    source: request.source || 'slack_dm',
    actor,
    taskType: (request.task && request.task.taskType) || null,
  });

  const fas = _fas();
  if (!fas.runner || typeof fas.runner.handleInbound !== 'function') {
    tr.setError('FAS runner unavailable').setOutcome('error').finish({ outcome: 'error' });
    return { mode: 'disabled', letLegacyReply: true, outcome: 'ai-core-unavailable', requestId: tr.requestId };
  }

  const input = {
    engine: src.engine,
    slackId: actor.slackId || '',
    senderName: actor.name || actor.slackId || '',
    channelId: meta.channelId || '',
    channelName: meta.channelName || '',
    ts: meta.ts || '',
    threadTs: meta.threadTs || null,
    text: String(request.message || ''),
    conversation: _normalizeConversation(request.conversation),
    isGroup: !!src.isGroup,
    isSelf: !!src.isSelf,
    attachments: _attachmentString(request.attachments),
    files: _attachmentFiles(request.attachments),
    actualReply: meta.actualReply,
  };

  let res;
  try {
    res = await fas.runner.handleInbound(input, deps);
  } catch (e) {
    logger.warn('[ai-core] runner failed (failing safe to legacy): ' + e.message);
    tr.setError(e).addFallback('legacy').setOutcome('error-failsafe').finish({ outcome: 'error-failsafe' });
    return { mode: 'shadow', letLegacyReply: true, outcome: 'error-failsafe', error: e.message, requestId: tr.requestId };
  }

  if (res && res.decision) tr.foldDecision(res.decision);
  if (res && Array.isArray(res.actionOutcomes)) tr.setActionOutcomes(res.actionOutcomes);
  tr.setOutcome((res && res.outcome) || 'unknown').finish({ outcome: (res && res.outcome) || 'unknown' });

  return { ...res, requestId: tr.requestId };
}

// ── Normalizers ──────────────────────────────────────────────────────────────

function _normalizeConversation(convo) {
  if (!Array.isArray(convo)) return [];
  return convo.map((t) => {
    if (typeof t === 'string') return t;
    if (t && typeof t === 'object') {
      const speaker = t.speaker || t.name || t.role || '';
      const text = t.text || t.message || '';
      return speaker ? (speaker + ': ' + text) : String(text);
    }
    return String(t);
  }).filter(Boolean);
}

// attachments may be: a string (legacy inline context), an array of file
// objects, or { context?: string, files?: [] }. Extract the inline string.
function _attachmentString(att) {
  if (!att) return '';
  if (typeof att === 'string') return att;
  if (Array.isArray(att)) return '';
  if (typeof att === 'object' && typeof att.context === 'string') return att.context;
  return '';
}
// Extract raw file objects for the FAS evidence builder (spec #13).
function _attachmentFiles(att) {
  if (!att) return [];
  if (Array.isArray(att)) return att;
  if (typeof att === 'object' && Array.isArray(att.files)) return att.files;
  return [];
}

// Build the standardized AiCore decision from the FAS decision + validation.
// Mirrors the spec #7 "main decision schema" shape, derived (not re-computed)
// from the FAS decision so there is no divergence in meaning.
function _toStructuredDecision(d, request, validated) {
  const ev = (d && d._evidence) || {};
  const entities = _entitiesFrom(d, request);
  return {
    intent: _intentFrom(d),              // derived label; underlying value is d.decision
    decision: d && d.decision,           // FAS terminal decision (answer/act/clarify/escalate)
    entities,
    // Relevant durable memory (spec #4), retrieved ONLY for the resolved
    // entities. Advisory context surfaced on the result; operator-confirmed
    // memory outranks ai-inferred. Best-effort; never blocks.
    relevantMemory: _relevantMemory(entities),
    answer: (d && typeof d.reply === 'string') ? d.reply : '',
    confidence: d && typeof d.confidence === 'number' ? d.confidence : null,
    reason: (d && d.reason) || '',
    evidenceUsed: _evidenceSummary(ev),
    missingEvidence: (ev.missingFacts || []).slice(),
    conflicts: (ev.conflicts || []).slice(),
    // Proposed actions ONLY — AiCore never executes; Digital FAS does (spec #5/#12).
    proposedActions: _proposedActions(d),
    requiresApproval: _requiresApproval(d),
    escalationReason: d && d.decision === 'escalate' ? (d.reason || 'escalated') : null,
    validated: !!validated.ok,
    repaired: !!validated.repaired,
    failSafe: !!validated.failSafe,
  };
}

function _intentFrom(d) {
  // A light, non-authoritative label for the trace/UI. The real control value
  // is d.decision; this never changes behavior.
  if (!d) return 'unknown';
  if (d.decision === 'act') return 'action_request';
  if (d.decision === 'clarify') return 'clarification';
  if (d.decision === 'escalate') return 'escalation';
  return 'answer';
}

function _relevantMemory(entities) {
  if (!memory) return [];
  try {
    return memory.retrieve(
      { units: entities.units, sites: entities.sites, vendors: entities.vendors, includeGlobal: false },
      { limit: 8 }
    );
  } catch (_) { return []; }
}

function _entitiesFrom(d, request) {
  const ev = (d && d._evidence) || {};
  const e = ev.entities || {};
  const hint = request.entities || {};
  const uniq = (a, b) => Array.from(new Set([].concat(a || [], b || []).map(String).filter(Boolean)));
  return {
    units: uniq(e.units, hint.units),
    sites: uniq(e.sites || e.domiciles, hint.sites),
    vendors: uniq(e.vendors, hint.vendors),
  };
}

function _evidenceSummary(ev) {
  const facts = Array.isArray(ev.verifiedFacts) ? ev.verifiedFacts : [];
  // Operational summary only: field + source + freshness. No raw values dumped.
  return facts.slice(0, 50).map((f) => ({
    field: f.field,
    source: f.source || null,
    retrievedAt: f.retrievedAt || null,
    stale: f.stale === true ? true : (f.stale === false ? false : null),
  }));
}

function _proposedActions(d) {
  const actions = (d && Array.isArray(d.actions)) ? d.actions : [];
  return actions.filter((a) => a && a.tool).map((a) => ({ type: a.tool, args: a.args || {} }));
}

// Does this decision require human approval before anything is executed? True
// if it proposes any non-low action, or is an escalate/clarify. This mirrors
// the runner's own gating intent (it is authoritative; AiCore only reports).
function _requiresApproval(d) {
  if (!d) return true;
  if (d.decision === 'escalate' || d.decision === 'clarify') return true;
  try {
    const runner = require('../orcha/fas/runner');
    if (typeof runner._hasApprovalLevelAction === 'function') return runner._hasApprovalLevelAction(d);
  } catch (_) {}
  // Fallback: any proposed action implies approval unless proven low-risk.
  return (Array.isArray(d.actions) && d.actions.length > 0);
}

// When the output fails validation+repair, keep FAS telemetry (evidence/loop)
// on the fail-safe object so the trace + result still carry context.
function _mergeTelemetry(failSafe, original) {
  if (!original || typeof original !== 'object') return failSafe;
  const out = { ...failSafe };
  ['_evidence', '_loop', '_profile', '_mode', '_budget', '_review'].forEach((k) => {
    if (original[k] != null) out[k] = original[k];
  });
  return out;
}

// Standardized AiCore result envelope.
function _result(fields) {
  return {
    ok: !!fields.ok,
    requestId: fields.requestId || null,
    source: fields.source || null,
    decision: fields.decision || null,   // standardized structured decision
    raw: fields.raw || null,             // full FAS decision (for callers needing _evidence)
    failSafe: !!fields.failSafe,
    routing: fields.routing || null,     // { task, recommendation } (advisory)
    error: fields.error || null,
  };
}

module.exports = { run, handleInbound, SOURCES };
