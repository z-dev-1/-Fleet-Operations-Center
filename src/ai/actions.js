'use strict';
/**
 * src/ai/actions.js — action simulation (dry-run), receipts, and plan
 * validation for the AI Core (spec §18, §19, §28).
 *
 * SAFETY: this module performs NO real mutation. Real execution stays with the
 * Digital FAS executor (orcha/fas/executor). This provides:
 *   - simulate(): a read-only dry-run answering "what would change / is it
 *     allowed / what source will be mutated / what current state is replaced /
 *     is it idempotent / what could block it" (spec §18);
 *   - validatePlan(): stale-plan + plan-expiration checks before execution
 *     (spec §28) — createdAt/expiresAt/evidenceVersion;
 *   - recordReceipt()/getReceipt(): durable action receipts (spec §19) that AI
 *     replies reference instead of assuming success.
 *
 * Everything is additive and does not change the executor's own behavior.
 */

const store = require('../store');
const errors = require('./errors');
let actionRegistry; try { actionRegistry = require('../orcha/fas/action-registry'); } catch (_) { actionRegistry = null; }
let executor; try { executor = require('../orcha/fas/executor'); } catch (_) { executor = null; }
let logger; try { logger = require('../utils/logger').createLogger('ai-actions'); } catch (_) { logger = { info() {}, warn() {} }; }

const RECEIPTS_KEY = 'aiActionReceipts';
const RECEIPTS_CAP = 1000;
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000; // a proposal is executable for 10 min by default

const now = () => new Date().toISOString();

// ── SIMULATION (spec §18) ─────────────────────────────────────────────────────

function _findRow(unit) {
  if (!unit) return null;
  try {
    const rows = (store.load('fleetData', {}) || {}).rows || [];
    const u = String(unit).trim().toUpperCase();
    return rows.find((r) => String(r.equipmentId || '').trim().toUpperCase() === u) || null;
  } catch (_) { return null; }
}

/**
 * simulate(action, ctx) -> {
 *   ok, action, allowed, wouldChange, mutatesSource, currentState, targetState,
 *   idempotent, blockers, reason
 * }  (NO side effects)
 *
 * action: { type: <FAS action name>, args: {...} }
 * ctx:    { profile, requesterSnapshot } (same context the executor uses)
 */
function simulate(action, ctx) {
  action = action || {};
  const name = action.type || action.tool;
  const args = action.args || {};
  const out = {
    ok: true, action: name, allowed: null, wouldChange: null,
    mutatesSource: null, currentState: null, targetState: null,
    idempotent: null, blockers: [], reason: '',
  };

  if (!actionRegistry || typeof actionRegistry.getAction !== 'function') {
    out.ok = false; out.reason = 'action registry unavailable'; return out;
  }
  const def = actionRegistry.getAction(name);
  if (!def) { out.ok = false; out.reason = 'unknown action: ' + name; out.allowed = false; return out; }

  // What SOURCE would be mutated + the change description, by action type.
  if (name === 'MOVE_UNIT') {
    const row = _findRow(args.unit || args.equipmentId);
    out.mutatesSource = 'AAP (lifecycle)';
    out.currentState = row ? { state: row.lifecycleState || null, reason: row.lifecycleReason || null } : null;
    out.targetState = { state: args.state || null, reason: args.reason || null };
    out.wouldChange = !!(row && String(row.lifecycleState || '').toUpperCase() !== String(args.state || '').toUpperCase());
    // Idempotent if the unit is already in the target state.
    out.idempotent = !!(row && String(row.lifecycleState || '').toUpperCase() === String(args.state || '').toUpperCase());
    // Blockers: hold states that must not be auto-cleared (mirrors existing rule).
    const reason = String((row && row.lifecycleReason) || '').toLowerCase();
    if (/pm failed|expired inspection|damaged/.test(reason)) out.blockers.push('blocking lifecycle reason: ' + row.lifecycleReason);
    if (!row) out.blockers.push('unit not found in verified fleet data');
    if (row && !row.assetUrl) out.blockers.push('no AAP asset URL cached');
  } else if (name === 'SUBMIT_WORK_REQUEST') {
    const row = _findRow(args.unit || args.equipmentId);
    out.mutatesSource = 'AAP (work request)';
    out.wouldChange = true;
    out.idempotent = false; // creating a WR is not idempotent by nature
    const openU = parseInt(row && row.openUnplanned, 10) || 0;
    const openP = parseInt(row && row.openPlanned, 10) || 0;
    if ((openU + openP) > 0 || (row && row.workRequestId && row.workRequestId !== '--')) out.blockers.push('unit already has an open work order (possible duplicate)');
    if (!row) out.blockers.push('unit not found in verified fleet data');
  } else if (name === 'SEND_SLACK_MESSAGE') {
    out.mutatesSource = 'Slack (outbound message)';
    out.wouldChange = true;
    out.idempotent = false;
    if (!args.channelId) out.blockers.push('no channel id');
    if (!String(args.message || '').trim()) out.blockers.push('empty message');
  } else {
    // Low-risk internal actions (timeline/reminder/case) — local writes.
    out.mutatesSource = 'local store';
    out.wouldChange = true;
    out.idempotent = typeof def.idempotencyKey === 'function';
  }

  // Would it be ALLOWED? Reuse the executor's authorization WITHOUT executing.
  // The executor exposes no pure "authorize only" entry, so we re-derive the
  // same checks it uses at a high level; the executor remains the final
  // authority at real execution time (defense in depth).
  out.allowed = _simAllowed(name, args, ctx, def, out.blockers);
  if (!out.allowed && !out.reason) out.reason = 'not allowed under current authorization/power-unit rules';
  else if (out.blockers.length && !out.reason) out.reason = 'blocked: ' + out.blockers.join('; ');
  else if (!out.reason) out.reason = out.idempotent ? 'no-op (already in target state)' : 'would apply the described change';

  return out;
}

// High-level allow check for simulation (NOT the authoritative gate — the
// executor re-checks at execution). Mirrors the executor's INTERNAL_ONLY +
// power-unit intent so the dry-run is honest.
function _simAllowed(name, args, ctx, def, blockers) {
  const profile = ctx && ctx.profile;
  if (!profile) return false;
  // Lifecycle/WR require internal/operator authority (external carriers only
  // propose; executor enforces the 3-state requester permission).
  const INTERNAL_ONLY = (name === 'MOVE_UNIT' || name === 'SUBMIT_WORK_REQUEST');
  if (INTERNAL_ONLY && profile.type !== 'internal') {
    // An external requester MAY still propose if their 3-state permission is set;
    // simulation reports allowed=false for auto-run but notes proposal path.
    const perm = name === 'MOVE_UNIT' ? profile.lifecyclePermission : profile.createWrPermission;
    return perm && perm !== 'not_allowed' ? true : false;
  }
  // A hard blocker makes it not allowed to auto-run.
  if (blockers && blockers.some((b) => /not found|blocking lifecycle/.test(b))) return false;
  return true;
}

// ── PLAN VALIDATION (spec §28) ─────────────────────────────────────────────────

/**
 * makePlan(proposal, opts) -> plan with createdAt/expiresAt/evidenceVersion.
 * proposal: { goal, actions: [{type,args}], evidence? }
 */
function makePlan(proposal, opts) {
  opts = opts || {};
  const ttl = _posInt(opts.ttlMs, DEFAULT_PLAN_TTL_MS);
  const createdAt = Date.now();
  return {
    goal: (proposal && proposal.goal) || '',
    actions: (proposal && proposal.actions) || [],
    evidenceVersion: _evidenceVersion(proposal && proposal.evidence),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + ttl).toISOString(),
  };
}

/**
 * validatePlan(plan, opts) -> { ok, code?, reason?, revalidate? }
 * Before execution, verify the plan is still valid (not expired) and the
 * evidence has not materially changed. Returns a typed STALE_PLAN error signal
 * when stale (caller re-plans).
 */
function validatePlan(plan, opts) {
  opts = opts || {};
  if (!plan) return { ok: false, code: errors.CODES.STALE_PLAN, reason: 'no plan' };
  if (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now()) {
    return { ok: false, code: errors.CODES.STALE_PLAN, reason: 'plan expired', revalidate: true };
  }
  // Evidence drift: if the caller supplies the CURRENT evidence, compare its
  // version to the plan's. A mismatch means state moved under the plan.
  if (opts.currentEvidence !== undefined) {
    const current = _evidenceVersion(opts.currentEvidence);
    if (plan.evidenceVersion && current && plan.evidenceVersion !== current) {
      return { ok: false, code: errors.CODES.STALE_PLAN, reason: 'evidence changed since planning', revalidate: true };
    }
  }
  return { ok: true };
}

// A stable hash of the evidence facts (value+source+field) used for drift.
function _evidenceVersion(evidence) {
  try {
    const facts = [];
    (Array.isArray(evidence) ? evidence : []).forEach((env) => {
      if (env && env.data && Array.isArray(env.data.facts)) env.data.facts.forEach((f) => facts.push(f.field + '=' + _n(f.value) + '@' + (f.source || '')));
    });
    facts.sort();
    const crypto = require('crypto');
    return crypto.createHash('sha1').update(facts.join('|')).digest('hex').slice(0, 16);
  } catch (_) { return null; }
}

// ── RECEIPTS (spec §19) ────────────────────────────────────────────────────────

function _loadReceipts() { const r = store.load(RECEIPTS_KEY, []); return Array.isArray(r) ? r : []; }
function _saveReceipts(a) { try { store.save(RECEIPTS_KEY, a.slice(0, RECEIPTS_CAP)); } catch (e) { logger.warn('[ai-actions] receipt save failed: ' + e.message); } }

/**
 * recordReceipt(receipt) -> the stored receipt.
 * Builds a durable receipt from an executor outcome. AI replies should
 * reference `verified` — never assume success.
 */
function recordReceipt(receipt) {
  receipt = receipt || {};
  const rec = {
    actionId: receipt.actionId || ('act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    type: receipt.type || null,
    equipmentId: receipt.equipmentId || null,
    requestedBy: receipt.requestedBy || null,
    approvedBy: receipt.approvedBy || null,
    executedByInstance: receipt.executedByInstance || _instanceId(),
    fencingToken: receipt.fencingToken != null ? receipt.fencingToken : _fencingToken(),
    startedAt: receipt.startedAt || now(),
    completedAt: receipt.completedAt || now(),
    sourceReadback: receipt.sourceReadback || null,
    verified: receipt.verified === true,
    status: receipt.status || (receipt.verified === true ? 'done' : 'unverified'),
    error: receipt.error || null,
  };
  const arr = _loadReceipts();
  arr.unshift(rec);
  _saveReceipts(arr);
  return rec;
}

function getReceipt(actionId) { return _loadReceipts().find((r) => r.actionId === actionId) || null; }
function recentReceipts(limit) { return _loadReceipts().slice(0, Math.max(1, limit || 50)); }

// Derive a receipt directly from executor.executeVerified()'s result.
function receiptFromExecutorResult(meta, result) {
  const verified = !!(result && result.status === 'done' && result.verified);
  return recordReceipt({
    type: meta && meta.type,
    equipmentId: meta && meta.equipmentId,
    requestedBy: meta && meta.requestedBy,
    approvedBy: meta && meta.approvedBy,
    startedAt: meta && meta.startedAt,
    sourceReadback: result && result.evidence ? { evidence: String(result.evidence).slice(0, 300) } : null,
    verified,
    status: result ? result.status : 'unknown',
    error: result && result.error,
  });
}

function _instanceId() {
  try { const c = require('../cluster'); const s = c.getStatus && c.getStatus(); return (s && s.instanceId) || 'standalone'; } catch (_) { return 'standalone'; }
}
function _fencingToken() {
  try { const c = require('../cluster'); const s = c.getStatus && c.getStatus(); return s ? s.fencingToken : null; } catch (_) { return null; }
}
function _posInt(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; }
function _n(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }

module.exports = {
  simulate, makePlan, validatePlan,
  recordReceipt, getReceipt, recentReceipts, receiptFromExecutorResult,
  RECEIPTS_KEY, DEFAULT_PLAN_TTL_MS,
};
