'use strict';
/**
 * writes/relay-action-writes.js — gated escalation and lifecycle writes for the
 * unit-detail action modals (IPC: relay:escalate / relay:change-lifecycle /
 * relay:lifecycle-options in src/ipc/relay-writes.js).
 *
 * Input is validated by the IPC handler. This module resolves the AAP user
 * (createdBy) before staging, so the gate preview is exactly what is sent, and
 * hands the write to writes/write-gate.requestWrite. It never calls
 * aap_api.updateEscalations or lifecycle_change.changeLifecycle itself; the
 * gate's _send is their only caller here. No new AAP endpoints.
 *
 * Logs: ids / counts only, never the comment text.
 */

const writeGate = require('./write-gate');

function _api() { return require('../scrapers/aap_api'); }
function _lc() { return require('../scrapers/aap_lifecycle_api'); }

let _logger = null;
function _log(msg) {
  try {
    if (!_logger) _logger = require('../utils/logger')('relay-action-writes');
    _logger.info(msg);
  } catch (_) {}
}

// { workRequestId, aaid, add[], remove[], comment, unit, aiDrafted } (validated)
async function escalate(p) {
  const api = _api();
  const { workRequestId, aaid, add, remove, comment } = p;
  const user = await api.getUserDetails();
  if (!api._hasEscalateFeature(user)) {
    return { ok: false, code: 'ESCALATE_NOT_ENABLED', error: 'Escalation is not enabled for this AAP user' };
  }
  const createdBy = api._userAlias(user);
  if (!createdBy) return { ok: false, code: 'NO_USER_ALIAS', error: 'Could not resolve the AAP user alias' };
  try {
    api._validateEscalationChange({ add, remove, comment });
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'ESCALATION_INVALID', error: (e && e.message) || String(e) };
  }
  const r = await writeGate.requestWrite({
    kind: 'updateEscalations',
    workRequestId,
    payload: { workRequestId, aaid, add, remove, comment, createdBy },
    origin: 'unit-detail-escalate',
    unit: String(p.unit || '').slice(0, 40),
    interactive: true,
    aiDrafted: p.aiDrafted === true,
  });
  let current;
  if (r && r.outcome === 'sent') {
    try { current = api._currentEscalations(await api.getService(workRequestId)); } catch (_) { current = undefined; }
    // Assistant action memory: teams only, the comment is never passed or logged.
    try {
      const _al = require('../orcha/awareness/action-log');
      for (const rec of _al.fromEscalationUpdate({ add, remove, workRequestId }, _al.resolveUnit({ workRequestId, aaid }))) _al.record(rec);
    } catch (_) {}
  }
  _log('[relay-action] escalate wr=' + workRequestId + ' add=' + add.length + ' remove=' + remove.length +
    ' outcome=' + (r && r.outcome));
  return { ok: !!(r && r.ok), outcome: r && r.outcome, id: r && r.id, error: (r && r.ok) ? undefined : (r && r.error), current };
}

// { equipmentId, assetUrl, state (label form), reason, fromState } (validated + confirmed)
async function changeLifecycle(p) {
  const { equipmentId, assetUrl, state, reason, fromState } = p;
  const r = await writeGate.requestWrite({
    kind: 'setLifecycle',
    payload: { equipmentId, assetUrl, state, reason, fromState },
    origin: 'unit-detail-lifecycle',
    unit: equipmentId,
    interactive: true,
  });
  if (r && r.outcome === 'sent') {
    try {
      const _al = require('../orcha/awareness/action-log');
      const rec = _al.fromLifecycleResult(r.result, { unitId: equipmentId, state, reason });
      if (rec) _al.record(rec);
    } catch (_) {}
  }
  _log('[relay-action] lifecycle unit=' + equipmentId + ' outcome=' + (r && r.outcome));
  return { ok: !!(r && r.ok), outcome: r && r.outcome, id: r && r.id, error: (r && r.ok) ? undefined : (r && r.error), result: r && r.result };
}

// Read-only: allowed states (END_OF_LIFE never offered) + supported reasons.
async function lifecycleOptions(fleetId) {
  const lc = _lc();
  let states;
  try { states = await lc.getValidStates(fleetId || undefined); } catch (_) { states = null; }
  if (!Array.isArray(states) || !states.length) states = lc.ALLOWED_STATES.slice();
  states = states.filter((s) => !lc.BLOCKED_STATES.includes(s));
  return { ok: true, states, reasons: lc.getSupportedReasons() };
}

module.exports = { escalate, changeLifecycle, lifecycleOptions };
