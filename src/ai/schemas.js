'use strict';
/**
 * src/ai/schemas.js — Unified AI Core structured-output schema + validator.
 *
 * Spec #7 (standardize structured AI outputs). This does NOT replace the FAS
 * agent's decision contract or arg-schema — it is a THIN, additive validator
 * that describes the canonical AiCore decision shape and can:
 *   - validate a decision object produced by the existing FAS agent,
 *   - attempt ONE structured repair (coerce/clamp/default) rather than throw,
 *   - fail SAFE (never execute actions from an invalid output).
 *
 * The validator is dependency-free (no Ajv/Zod needed) so it adds no new
 * runtime deps and cannot break the existing build. It mirrors the enums and
 * field shapes already enforced in orcha/fas/agent.js (_parseDecision) and
 * orcha/fas/arg-schema.js, so an object that passes the FAS path also passes
 * here. The goal is a single, documented contract other surfaces can rely on —
 * NOT a new source of truth that could diverge from FAS behavior.
 */

// The four terminal decision types + the in-loop research signal. Mirrors
// agent.js exactly so a FAS decision validates unchanged.
const DECISION_TYPES = ['answer', 'research_more', 'act', 'clarify', 'escalate'];

// Canonical AiCore decision schema (documentation + validation reference). This
// is the "main decision schema" from spec #7, expressed over the FIELDS the FAS
// agent already returns. Extra underscore-prefixed fields (_evidence, _loop,
// _profile, _mode, _review, _budget) are internal FAS telemetry and are allowed
// through untouched (never required, never validated for shape).
const DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'reply'],
  properties: {
    // Mapped to the spec's "intent" at the AiCore boundary (see core.js). The
    // FAS agent emits `decision`; AiCore surfaces both `decision` and a derived
    // `intent` without changing the underlying value.
    decision: { type: 'string', enum: DECISION_TYPES },
    confidence: { type: 'number', min: 0, max: 1 },
    reason: { type: 'string', maxLen: 300 },
    reply: { type: 'string' },
    research: { type: 'array', maxItems: 8, items: 'toolCall' },
    actions: { type: 'array', maxItems: 8, items: 'toolCall' },
    followUp: { type: 'object' },
  },
};

function _isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// A tool/action call: { tool: string, args?: object }. Mirrors what the agent
// loop and executor already accept.
function _validateToolCall(tc) {
  if (!_isPlainObject(tc)) return { ok: false, error: 'tool call must be an object' };
  if (typeof tc.tool !== 'string' || !tc.tool.trim()) return { ok: false, error: 'tool call requires a tool name' };
  const args = _isPlainObject(tc.args) ? tc.args : {};
  return { ok: true, value: { tool: tc.tool.trim(), args } };
}

/**
 * validateDecision(obj) -> { ok, decision?, errors? }
 * Strict validation of the canonical decision shape. Does NOT mutate the input.
 * Internal underscore-prefixed telemetry fields are preserved as-is.
 */
function validateDecision(obj) {
  const errors = [];
  if (!_isPlainObject(obj)) return { ok: false, errors: ['decision must be an object'] };

  if (typeof obj.decision !== 'string' || !DECISION_TYPES.includes(obj.decision)) {
    errors.push('decision must be one of ' + DECISION_TYPES.join(', '));
  }
  if (typeof obj.reply !== 'string') errors.push('reply must be a string');
  // A TERMINAL decision (answer/act/clarify/escalate) must carry a non-empty
  // reply — an empty terminal reply is an AI failure, mirroring the FAS runner's
  // _aiFailed rule. (research_more is a non-terminal in-loop signal and may have
  // an empty reply.) This ensures validateOrRepair fails safe on an empty reply
  // rather than passing an unusable "answer".
  else if (typeof obj.decision === 'string' && obj.decision !== 'research_more' && obj.reply.trim().length === 0) {
    errors.push('terminal decision requires a non-empty reply');
  }
  if (obj.confidence != null && (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)) {
    errors.push('confidence must be a number in [0,1]');
  }
  if (obj.reason != null && typeof obj.reason !== 'string') errors.push('reason must be a string');
  if (obj.research != null && !Array.isArray(obj.research)) errors.push('research must be an array');
  if (obj.actions != null && !Array.isArray(obj.actions)) errors.push('actions must be an array');
  (Array.isArray(obj.research) ? obj.research : []).forEach((tc, i) => {
    const r = _validateToolCall(tc); if (!r.ok) errors.push('research[' + i + ']: ' + r.error);
  });
  (Array.isArray(obj.actions) ? obj.actions : []).forEach((tc, i) => {
    const r = _validateToolCall(tc); if (!r.ok) errors.push('actions[' + i + ']: ' + r.error);
  });
  if (obj.followUp != null && !_isPlainObject(obj.followUp)) errors.push('followUp must be an object');

  return errors.length ? { ok: false, errors } : { ok: true, decision: obj };
}

/**
 * repairDecision(obj) -> { ok, decision, repaired, errors? }
 * ONE structured repair attempt (spec #7): coerce types, clamp confidence,
 * drop malformed tool calls, default missing optional fields. NEVER invents a
 * reply and NEVER fabricates actions. If the result still has no usable
 * terminal reply, ok:false and the caller must fail safe (no action execution).
 *
 * Repair is conservative:
 *   - unknown decision -> 'clarify' (never an unverified 'answer'/'act')
 *   - malformed actions -> DROPPED (never execute from garbage)
 *   - confidence clamped to [0,1]; missing -> left undefined (caller decides)
 */
function repairDecision(obj) {
  if (!_isPlainObject(obj)) {
    return { ok: false, repaired: true, errors: ['not an object'],
      decision: _failSafe('invalid AI output (not an object)') };
  }
  const out = { ...obj };
  let repaired = false;

  if (typeof out.decision !== 'string' || !DECISION_TYPES.includes(out.decision)) {
    out.decision = typeof out.reply === 'string' && out.reply.trim() ? 'answer' : 'clarify';
    repaired = true;
  }
  if (typeof out.reply !== 'string') { out.reply = ''; repaired = true; }
  if (out.confidence != null) {
    const n = Number(out.confidence);
    if (!isFinite(n)) { delete out.confidence; repaired = true; }
    else { const c = Math.max(0, Math.min(1, n)); if (c !== out.confidence) { out.confidence = c; repaired = true; } }
  }
  if (out.reason != null && typeof out.reason !== 'string') { out.reason = String(out.reason).slice(0, 300); repaired = true; }
  // Drop malformed tool/action calls rather than execute from garbage.
  const clean = (arr) => {
    const kept = [];
    (Array.isArray(arr) ? arr : []).forEach((tc) => { const r = _validateToolCall(tc); if (r.ok) kept.push(r.value); else repaired = true; });
    return kept;
  };
  if (out.research != null) out.research = clean(out.research);
  if (out.actions != null) out.actions = clean(out.actions);
  if (out.followUp != null && !_isPlainObject(out.followUp)) { out.followUp = { required: false }; repaired = true; }

  const v = validateDecision(out);
  // A usable decision needs a real terminal reply (research_more is not terminal).
  const usable = v.ok && out.decision !== 'research_more' && typeof out.reply === 'string' && out.reply.trim().length > 0;
  if (!usable) {
    return { ok: false, repaired, errors: v.errors || ['no usable terminal reply after repair'],
      decision: _failSafe('AI output failed validation and could not be repaired') };
  }
  return { ok: true, repaired, decision: out };
}

// The safe terminal fallback (never asserts a fact, proposes no actions). Used
// when validation+repair both fail, so AiCore never executes from invalid data.
function _failSafe(reason) {
  return {
    decision: 'clarify',
    confidence: 0,
    reason: String(reason || 'invalid AI output').slice(0, 300),
    reply: '',
    research: [],
    actions: [],
    followUp: { required: false, owner: '', dueAt: null },
    _failSafe: true,
  };
}

/**
 * validateOrRepair(obj) -> { ok, decision, repaired, failSafe, errors? }
 * Convenience: validate; on failure do exactly ONE repair; on still-failure
 * return the fail-safe decision with ok:false. This is the contract AiCore
 * uses so an invalid model output can never drive an action.
 */
function validateOrRepair(obj) {
  const v = validateDecision(obj);
  if (v.ok) return { ok: true, decision: v.decision, repaired: false, failSafe: false };
  const r = repairDecision(obj);
  return { ok: r.ok, decision: r.decision, repaired: true, failSafe: !r.ok, errors: r.errors };
}

module.exports = {
  DECISION_TYPES,
  DECISION_SCHEMA,
  validateDecision,
  repairDecision,
  validateOrRepair,
  _failSafe,
};
