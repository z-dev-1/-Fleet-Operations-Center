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
async function executeVerified(name, args, ctx) {
  const action = actions.getAction(name);
  if (!action) return { status: 'error', error: 'unknown action: ' + name };
  let runResult;
  try {
    runResult = await action.run(args || {}, ctx || {});
  } catch (e) {
    _audit({ action: name, status: 'error', error: e.message });
    return { status: 'error', error: 'run threw: ' + e.message };
  }
  if (!runResult || !runResult.ok) {
    _audit({ action: name, status: 'failed', error: (runResult && runResult.error) || 'run failed' });
    return { status: 'failed', error: (runResult && runResult.error) || 'run failed' };
  }
  // VERIFY through the source system before claiming success.
  let ver;
  try {
    ver = await action.verify(args || {}, ctx || {}, runResult);
  } catch (e) {
    _audit({ action: name, status: 'verify_error', error: e.message });
    return { status: 'verifying', error: 'verify threw: ' + e.message };
  }
  if (ver && ver.verified) {
    _audit({ action: name, status: 'done', evidence: ver.evidence, deferred: !!ver.deferred });
    return { status: 'done', verified: true, evidence: ver.evidence, deferred: !!ver.deferred };
  }
  _audit({ action: name, status: 'unverified', error: (ver && ver.error) || 'verification failed' });
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

  // Authorization: sender must be permitted to request this action's category.
  const profile = ctx && ctx.profile;
  if (action.requires && !profiles.canRequest(profile, action.requires)) {
    _audit({ action: name, status: 'blocked', reason: 'sender not authorized (needs ' + action.requires + ')' });
    return { outcome: 'blocked', detail: 'sender not authorized for ' + name };
  }

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

module.exports = { routeAction, executeVerified, approveQueued, rejectQueued, getQueue };
