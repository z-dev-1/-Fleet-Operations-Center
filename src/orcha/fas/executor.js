'use strict';
/**
 * orcha/fas/executor.js — Digital FAS Stage 6/7: authorization + execute + verify.
 *
 * Decides, for a proposed action, whether to EXECUTE it now or QUEUE it for
 * human approval, based on: rollout mode, action level, sender authorization,
 * and per-action approval config. Then it runs the real app code and VERIFIES
 * the result through the source system — success is only reported if verify
 * passes.
 *
 * Authorization levels (from action-registry):
 *   - 'low'      : auto-runnable ONLY in autonomous mode, only if sender is
 *                  authorized AND the action is on the approved-automatic list.
 *   - 'approval' : always queued for approval (lifecycle, WR submit, sends,
 *                  overrides). NEVER auto-executed by default.
 *
 * Modes:
 *   - shadow    : execute nothing. Every proposed action is recorded only.
 *   - approval  : execute nothing automatically. All actions -> approval queue.
 *   - autonomous: low-risk + authorized + whitelisted -> execute+verify now;
 *                 everything else -> approval queue.
 *
 * The queue + results are persisted so the UI can approve/reject and see
 * verifying/failed states.
 */

const config = require('./config');
const profiles = require('./sender-profiles');
const actions = require('./action-registry');
const store = require('../../store');
let logger; try { logger = require('../../utils/logger').createLogger('fas-exec'); } catch (_) { logger = { info(){}, warn(){} }; }

const now = () => new Date().toISOString();
const QUEUE_CAP = 300;

// Actions that require internal/operator approval regardless of the sender's
// category permission — a lifecycle change or WR submission must never be
// initiated by an external carrier/vendor even if their profile lists the
// request type. (Part 11: category permission != per-unit authority.)
const INTERNAL_ONLY_ACTIONS = new Set(['MOVE_UNIT', 'SUBMIT_WORK_REQUEST']);

// ── UNIT-LEVEL AUTHORIZATION (Part 11) ───────────────────────────────────────
// Category permission (canRequest) is NOT sufficient. For any unit-specific
// action we must ALSO confirm the TARGET UNIT is within the sender's
// operator/domicile scope, and that lifecycle/WR actions are only initiated by
// internal/operator actors. This is called BOTH at proposal time AND again at
// EXECUTION time (authorization can change between the two).
function _authorizeUnitAction(name, args, profile, action) {
  action = action || actions.getAction(name);
  // 1) Category permission.
  if (action && action.requires && !profiles.canRequest(profile, action.requires)) {
    return { ok: false, reason: 'sender not authorized for request type ' + action.requires };
  }
  // 2) Lifecycle / WR-submission require internal/operator authority.
  const isInternal = !!(profile && (profile.type === 'internal' || profile.type === 'manager'));
  if (INTERNAL_ONLY_ACTIONS.has(name) && !isInternal) {
    return { ok: false, reason: name + ' requires internal/operator approval' };
  }
  // 3) Per-UNIT scope: if the action targets a specific unit, an EXTERNAL
  //    (scoped) sender may only act on units inside their operator/domicile
  //    scope. Internal/manager users have fleet-wide authority, so a unit not
  //    present in the local cache does not block them (it may simply be
  //    un-synced). External senders acting on an unknown or out-of-scope unit
  //    are denied.
  const unit = args && (args.unit || args.equipmentId);
  if (unit && !isInternal) {
    let row = null;
    try {
      const fd = store.load('fleetData', {});
      const rows = (fd && fd.rows) || [];
      const u = String(unit).trim().toUpperCase();
      row = rows.find(r => String(r.equipmentId || '').trim().toUpperCase() === u) || null;
    } catch (_) {}
    if (!row) return { ok: false, reason: 'target unit ' + unit + ' not found / not in sender scope' };
    try {
      if (!profiles.scopeUnitForSender(profile, row)) {
        return { ok: false, reason: 'unit ' + unit + ' is outside sender scope' };
      }
    } catch (_) { return { ok: false, reason: 'unit scope check failed' }; }
  }
  return { ok: true };
}

function _loadQueue() { const q = store.load('fasApprovalQueue', []); return Array.isArray(q) ? q : []; }
function _saveQueue(q) { store.save('fasApprovalQueue', q.slice(0, QUEUE_CAP)); }

function _enqueue(item) {
  const q = _loadQueue();
  q.unshift(item);
  _saveQueue(q);
  return item;
}

function _audit(entry) {
  try {
    const log = store.load('fasAuditLog', []);
    const arr = Array.isArray(log) ? log : [];
    arr.unshift({ at: now(), kind: 'action', ...entry });
    if (arr.length > 500) arr.length = 500;
    store.save('fasAuditLog', arr);
  } catch (_) {}
}

/**
 * executeVerified(name, args, ctx) -> { status, verified?, evidence?, error? }
 * Runs the action then verifies. Only status:'done' means truly succeeded.
 */
// Idempotency ledger: maps idempotencyKey -> { status, at, leaseUntil, result }.
// Prevents a retry from re-applying an action that is already done OR currently
// in-flight (claimed/executing/verifying). Uses an atomic claim with a lease so
// a crash mid-flight can be recovered after the lease expires (Part 4).
const IDEM_CAP = 1000;
// How long an in-flight claim is honored before it's considered abandoned and
// eligible for recovery (e.g. the app crashed during a lifecycle write).
const LEASE_MS = 5 * 60 * 1000;              // 5 min in-flight lease
// A verifying action (awaiting AAP read-back) is retained far longer — it must
// be reconciled by a later sync, not re-applied.
const VERIFY_HOLD_MS = 24 * 60 * 60 * 1000;  // 24h

function _loadIdem() { const m = store.load('fasIdempotency', {}); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
function _saveIdem(m) {
  const keys = Object.keys(m);
  if (keys.length > IDEM_CAP) {
    keys.sort((a, b) => Date.parse(m[a].at || 0) - Date.parse(m[b].at || 0));
    for (let i = 0; i < keys.length - IDEM_CAP; i++) delete m[keys[i]];
  }
  store.save('fasIdempotency', m);
}
function _recordIdem(key, entry) {
  if (!key) return;
  const m = _loadIdem();
  m[key] = { ...(m[key] || {}), ...entry, at: now() };
  _saveIdem(m);
}
// Is a key currently blocking (done, or a live in-flight/verifying lease)?
// Returns { blocked, reason, entry } — used to decide whether to run.
function _idemBlock(key) {
  if (!key) return { blocked: false };
  const m = _loadIdem();
  const e = m[key];
  if (!e) return { blocked: false };
  if (e.status === 'done') return { blocked: true, reason: 'already completed (idempotent)', entry: e };
  const leaseUntil = e.leaseUntil ? Date.parse(e.leaseUntil) : 0;
  if ((e.status === 'claimed' || e.status === 'executing') && leaseUntil > Date.now()) {
    return { blocked: true, reason: 'action in-flight (leased)', entry: e };
  }
  if (e.status === 'verifying') {
    const vAge = Date.now() - (Date.parse(e.at || 0) || 0);
    if (vAge < VERIFY_HOLD_MS) return { blocked: true, reason: 'awaiting source verification', entry: e };
  }
  // Otherwise (failed, expired lease, stale verifying) -> not blocking; recoverable.
  return { blocked: false, entry: e };
}
// Atomically claim a key for execution with a lease. Returns false if another
// live claim exists (prevents double execution from two windows / rapid clicks).
function _claimIdem(key) {
  if (!key) return true;
  const m = _loadIdem();
  const e = m[key];
  const leaseUntil = e && e.leaseUntil ? Date.parse(e.leaseUntil) : 0;
  if (e && (e.status === 'done' ||
      ((e.status === 'claimed' || e.status === 'executing') && leaseUntil > Date.now()) ||
      (e.status === 'verifying' && (Date.now() - (Date.parse(e.at || 0) || 0)) < VERIFY_HOLD_MS))) {
    return false; // already terminal or live in-flight
  }
  m[key] = { ...(e || {}), status: 'claimed', at: now(), leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() };
  _saveIdem(m);
  return true;
}

// Reconcile in-flight ledger entries after a restart: expired claims (crash
// mid-flight) are marked 'recoverable' so the operator can retry; verifying
// entries are left for AAP read-back reconciliation. Returns a summary.
function reconcileInFlight() {
  const m = _loadIdem();
  let expired = 0, verifying = 0;
  for (const k of Object.keys(m)) {
    const e = m[k];
    if (!e) continue;
    const leaseUntil = e.leaseUntil ? Date.parse(e.leaseUntil) : 0;
    if ((e.status === 'claimed' || e.status === 'executing') && leaseUntil <= Date.now()) {
      m[k] = { ...e, status: 'recoverable', at: now() };
      expired++;
    } else if (e.status === 'verifying') { verifying++; }
  }
  if (expired) { _saveIdem(m); _audit({ action: '(reconcile)', status: 'recovered-inflight', expired, verifying }); }
  return { expired, verifying };
}

// Allow a genuinely FAILED/recoverable action to be retried on operator demand.
function clearIdem(key) {
  if (!key) return;
  const m = _loadIdem();
  if (m[key] && m[key].status !== 'done' && m[key].status !== 'verifying') { delete m[key]; _saveIdem(m); }
}

async function executeVerified(name, args, ctx) {
  const action = actions.getAction(name);
  if (!action) return { status: 'error', error: 'unknown action: ' + name };

  // ── RE-CHECK AUTHORIZATION AT EXECUTION TIME (Part 11) ────────────────────
  // Authorization is verified again here, not only when the proposal was
  // created — the sender's scope or the unit's ownership may have changed. A
  // blocked action must never execute.
  const authz = _authorizeUnitAction(name, args, ctx && ctx.profile, action);
  if (!authz.ok) {
    _audit({ action: name, status: 'blocked-at-exec', reason: authz.reason });
    return { status: 'blocked', error: authz.reason };
  }

  // ── CENTRAL ARG VALIDATION (Part 15) ──────────────────────────────────────
  // Validate action arguments against the schema before running. Reject
  // malformed args rather than executing on garbage.
  try {
    const schema = require('./arg-schema');
    const v = schema.validateArgs(name, args || {});
    if (!v.ok) {
      _audit({ action: name, status: 'invalid-args', error: v.error });
      return { status: 'failed', error: 'invalid arguments: ' + v.error };
    }
    args = v.cleaned; // use the validated + cleaned args downstream
  } catch (_) { /* validator unavailable -> proceed with raw args */ }

  // ── IDEMPOTENCY + IN-FLIGHT PROTECTION (Part 4) ───────────────────────────
  // Skip if the action is already done, currently in-flight (claimed/executing,
  // live lease), or awaiting verification. Otherwise atomically CLAIM it so a
  // second window / rapid double-click cannot execute it concurrently.
  let idemKey = null;
  if (typeof action.idempotencyKey === 'function') {
    try { idemKey = action.idempotencyKey(args || {}); } catch (_) { idemKey = null; }
  }
  if (idemKey) {
    const block = _idemBlock(idemKey);
    if (block.blocked) {
      _audit({ action: name, status: 'idempotent-skip', idemKey, reason: block.reason });
      const priorDone = block.entry && block.entry.status === 'done';
      return { status: priorDone ? 'done' : (block.entry ? block.entry.status : 'blocked'),
        verified: priorDone, idempotent: true, evidence: block.reason,
        priorResult: block.entry && block.entry.result };
    }
    if (!_claimIdem(idemKey)) {
      _audit({ action: name, status: 'claim-lost', idemKey });
      return { status: 'blocked', error: 'action already in-flight (concurrent claim)' };
    }
    _recordIdem(idemKey, { status: 'executing', leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() });
  }

  let runResult;
  try {
    runResult = await action.run(args || {}, ctx || {});
  } catch (e) {
    _audit({ action: name, status: 'error', error: e.message });
    if (idemKey) _recordIdem(idemKey, { status: 'failed', leaseUntil: null, error: e.message });
    return { status: 'error', error: 'run threw: ' + e.message };
  }
  if (!runResult || !runResult.ok) {
    _audit({ action: name, status: 'failed', error: (runResult && runResult.error) || 'run failed' });
    if (idemKey) _recordIdem(idemKey, { status: 'failed', leaseUntil: null, error: (runResult && runResult.error) || 'run failed' });
    return { status: 'failed', error: (runResult && runResult.error) || 'run failed' };
  }
  // VERIFY through the source system before claiming success.
  let ver;
  try {
    ver = await action.verify(args || {}, ctx || {}, runResult);
  } catch (e) {
    _audit({ action: name, status: 'verify_error', error: e.message });
    if (idemKey) _recordIdem(idemKey, { status: 'verifying', leaseUntil: null, result: runResult && runResult.result });
    return { status: 'verifying', error: 'verify threw: ' + e.message };
  }
  if (ver && ver.verified) {
    _audit({ action: name, status: 'done', evidence: ver.evidence, deferred: !!ver.deferred });
    if (idemKey) _recordIdem(idemKey, { status: 'done', leaseUntil: null, result: runResult && runResult.result });
    return { status: 'done', verified: true, evidence: ver.evidence, deferred: !!ver.deferred };
  }
  // Deferred verification (e.g. MOVE_UNIT awaiting AAP read-back): keep the
  // action in a VERIFYING state — NOT done — until a later sync confirms it.
  if (ver && ver.deferred) {
    _audit({ action: name, status: 'verifying', error: (ver && ver.error) || 'awaiting source read-back', deferred: true });
    // Record as verifying so a retry doesn't re-apply while we await read-back.
    if (idemKey) _recordIdem(idemKey, { status: 'verifying', result: runResult && runResult.result });
    return { status: 'verifying', verified: false, deferred: true, error: (ver && ver.error) || 'awaiting source read-back' };
  }
  _audit({ action: name, status: 'unverified', error: (ver && ver.error) || 'verification failed' });
  if (idemKey) _recordIdem(idemKey, { status: 'failed', leaseUntil: null, error: (ver && ver.error) || 'unverified' });
  return { status: 'unverified', verified: false, error: (ver && ver.error) || 'could not verify' };
}

/**
 * routeAction(name, args, ctx) -> { outcome, detail }
 * outcome: 'executed' | 'queued' | 'blocked' | 'shadow'
 * ctx must include { profile } for authorization.
 */
async function routeAction(name, args, ctx) {
  const cfg = config.get();
  const action = actions.getAction(name);
  if (!action) return { outcome: 'blocked', detail: 'unknown action: ' + name };

  // Authorization (Part 11): category permission AND per-unit operator/domicile
  // scope AND internal-only guard for lifecycle/WR actions.
  const profile = ctx && ctx.profile;
  const authz = _authorizeUnitAction(name, args, profile, action);
  if (!authz.ok) {
    _audit({ action: name, status: 'blocked', reason: authz.reason });
    return { outcome: 'blocked', detail: authz.reason };
  }
  // Permission snapshot captured at proposal time (stored on queued items).
  const permissionSnapshot = profile ? {
    slackId: profile.slackId, type: profile.type,
    operators: (profile.operators || []).slice(), domiciles: (profile.domiciles || []).slice(),
    permittedRequestTypes: (profile.permittedRequestTypes || []).slice(),
    at: now(),
  } : null;

  // Shadow: never execute, never queue — record only.
  if (!cfg.enabled || cfg.mode === 'shadow') {
    _audit({ action: name, status: 'shadow-proposed', args: _safeArgs(args) });
    return { outcome: 'shadow', detail: 'shadow mode — proposed only, not executed' };
  }

  const level = action.level;
  const canAuto = cfg.mode === 'autonomous' && level === 'low' &&
    (cfg.approvedAutomaticActions || []).includes(name);

  if (canAuto) {
    const res = await executeVerified(name, args, ctx);
    return { outcome: 'executed', detail: res };
  }

  // Everything else (approval mode, or any approval-level action, or low-risk
  // not whitelisted) -> queue for human approval. Never auto-executed.
  const item = _enqueue({
    id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    action: name, args: _safeArgs(args), level, requestedBy: profile && profile.slackId,
    permissionSnapshot,
    status: 'pending', createdAt: now(),
  });
  return { outcome: 'queued', detail: { id: item.id } };
}

// Approve a queued action: execute + verify, update its queue status.
async function approveQueued(id, ctx) {
  const q = _loadQueue();
  const item = q.find(x => x.id === id);
  if (!item) return { ok: false, error: 'not found' };
  if (item.status !== 'pending') return { ok: false, error: 'not pending (' + item.status + ')' };
  item.status = 'verifying'; _saveQueue(q);
  const res = await executeVerified(item.action, item.args, ctx || {});
  const q2 = _loadQueue();
  const it2 = q2.find(x => x.id === id);
  if (it2) { it2.status = res.status; it2.result = res; it2.resolvedAt = now(); _saveQueue(q2); }
  return { ok: res.status === 'done', result: res };
}

function rejectQueued(id) {
  const q = _loadQueue();
  const item = q.find(x => x.id === id);
  if (!item) return { ok: false, error: 'not found' };
  item.status = 'rejected'; item.resolvedAt = now();
  _saveQueue(q);
  return { ok: true };
}

function getQueue(status) {
  const q = _loadQueue();
  return status ? q.filter(x => x.status === status) : q;
}

// Strip anything large/sensitive from args before persisting to the queue.
function _safeArgs(args) {
  const a = { ...(args || {}) };
  if (a.payload && a.payload.attachments) a.payload = { ...a.payload, attachments: '[omitted]' };
  return a;
}

module.exports = { routeAction, executeVerified, approveQueued, rejectQueued, getQueue, reconcileInFlight, clearIdem, _idemBlock, _claimIdem };
