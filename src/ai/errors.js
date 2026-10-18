'use strict';
/**
 * src/ai/errors.js — standardized typed AI errors (spec §30).
 *
 * Surfaces convert these codes into natural language; code paths never infer
 * behavior from arbitrary error strings. Each error carries a stable `code`,
 * a human `message`, and optional `details`.
 */

const CODES = {
  AI_PROVIDER_UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  ACTION_APPROVAL_REQUIRED: 'ACTION_APPROVAL_REQUIRED',
  ACTION_CONFLICT: 'ACTION_CONFLICT',
  EXECUTION_UNCERTAIN: 'EXECUTION_UNCERTAIN',
  COORDINATOR_UNAVAILABLE: 'COORDINATOR_UNAVAILABLE',
  STALE_PLAN: 'STALE_PLAN',
  SYNC_GAP: 'SYNC_GAP',
};

// Default human phrasings (surfaces may override/localize).
const MESSAGES = {
  AI_PROVIDER_UNAVAILABLE: 'The AI provider is currently unavailable.',
  TOOL_TIMEOUT: 'A data lookup timed out.',
  TOOL_PERMISSION_DENIED: 'The sender is not authorized for that data.',
  EVIDENCE_INSUFFICIENT: 'There isn\u2019t enough verified evidence to answer confidently.',
  SCHEMA_INVALID: 'The AI produced an invalid structured result.',
  ACTION_NOT_ALLOWED: 'That action is not allowed.',
  ACTION_APPROVAL_REQUIRED: 'That action requires approval before it can run.',
  ACTION_CONFLICT: 'The action conflicts with the current state or another in-flight action.',
  EXECUTION_UNCERTAIN: 'The action may have run but could not be verified.',
  COORDINATOR_UNAVAILABLE: 'The cluster coordinator is unavailable.',
  STALE_PLAN: 'The action plan is stale and must be re-validated.',
  SYNC_GAP: 'This instance is behind on shared state and cannot act safely.',
};

class AiError extends Error {
  constructor(code, message, details) {
    const c = CODES[code] ? code : 'SCHEMA_INVALID';
    super(message || MESSAGES[c] || c);
    this.name = 'AiError';
    this.code = c;
    this.details = details || null;
    this.isAiError = true;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}

/** make(code, message?, details?) -> AiError */
function make(code, message, details) { return new AiError(code, message, details); }

/** is(err, code?) -> boolean — typed check without string matching. */
function is(err, code) {
  if (!err || !err.isAiError) return false;
  return code ? err.code === code : true;
}

/** normalize(err) -> AiError — wrap an arbitrary error as a typed one. */
function normalize(err) {
  if (err && err.isAiError) return err;
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  // Best-effort mapping of common lower-level signals to typed codes WITHOUT
  // inferring behavior — only to give surfaces a stable code.
  if (/timeout/i.test(msg)) return make('TOOL_TIMEOUT', msg);
  if (/unauthor|denied|permission/i.test(msg)) return make('TOOL_PERMISSION_DENIED', msg);
  if (/unavailable|not reachable|no backend/i.test(msg)) return make('AI_PROVIDER_UNAVAILABLE', msg);
  return make('SCHEMA_INVALID', msg);
}

module.exports = { AiError, CODES, MESSAGES, make, is, normalize };
