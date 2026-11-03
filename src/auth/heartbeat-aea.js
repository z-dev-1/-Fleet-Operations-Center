'use strict';
/**
 * src/auth/heartbeat-aea.js — Phase 9 (auth.singleOwner.aea): one AEA owner.
 *
 * With the flag on and the AEA keep-alive service running, the app.js Midway
 * heartbeat stops writing AEA itself (no refreshAeaSilently, no injectCookies,
 * no injectAeaFromPostureToken, no probe windows). The keep-alive service
 * (src/auth/aea-keepalive-service.js, unchanged) is the single AEA freshness
 * owner. The heartbeat still logs [AEA-DIAG] (with an owner tag) and, when the
 * keep-alive needs help, hands the recovery decision to the ONE auth supervisor
 * without overriding its retry policy:
 *   - supervisor HEALTHY / UNKNOWN / DEGRADED (no recovery owned yet) or
 *     unreadable → ensureHealthyConverging({ allowPrompt:false }) (one verify
 *     pass; the ladder only if the verify fails)
 *   - COOLDOWN / RECOVERING / OFFLINE / WAITING_FOR_USER → the supervisor already
 *     owns recovery + backoff: only the idempotent ensureRecoveryArmed() watchdog
 *   - a delegation still in flight from an earlier tick is never started again
 *
 * Ordering with the heartbeat's session-expiry branches (app.js expiring branch
 * sets _midwayRenewalInFlight = true at ~:485, expired branch at ~:498): the
 * delegation is awaited inside the tick, so WITHIN THE SAME TICK the expiring
 * branch (allowPrompt:true) runs after the AEA step and never coalesces onto
 * this tick's no-prompt pass. ACROSS TICKS that does not hold: a tick that
 * skips because an earlier tick's delegation is still running (skipped:true)
 * may coalesce its expiring-branch ensureHealthyConverging({ allowPrompt:true })
 * onto that earlier no-prompt pass via the supervisor lock. That defers the
 * prompt to the next tick; no prompt is ever added.
 *
 * Never logs cookie or token values (only minutes and state names).
 */

let _warnedNotRunning = false;   // warn-once per process
let _delegation = null;          // in-flight supervisor delegation from an earlier tick (overlap guard)

// Supervisor states where the supervisor has NOT yet taken ownership of a recovery.
const DELEGATE_STATES = new Set(['HEALTHY', 'UNKNOWN', 'DEGRADED']);

/**
 * ownerFor({ singleOwnerAea, keepalive, log }) -> { owner: 'legacy'|'keepalive', reason }
 * Never throws.
 */
function ownerFor(o) {
  try {
    const { singleOwnerAea, keepalive, log } = o || {};
    if (!singleOwnerAea) return { owner: 'legacy', reason: 'flag-off' };
    let running = false;
    try { running = !!(keepalive && typeof keepalive.getState === 'function' && keepalive.getState().running); }
    catch (_) { running = false; }
    if (!running) {
      if (!_warnedNotRunning && log) {
        _warnedNotRunning = true;
        try { log.warn('[midway] auth.singleOwner.aea is on but aea-keepalive is not running — heartbeat keeps legacy AEA refresh'); } catch (_) {}
      }
      return { owner: 'legacy', reason: 'keepalive-not-running' };
    }
    return { owner: 'keepalive', reason: 'keepalive-running' };
  } catch (_) {
    return { owner: 'legacy', reason: 'error' };
  }
}

/**
 * runKeepaliveOwned({ state, auth, keepalive, supervisor, log })
 *   -> { delegated, deferred?, skipped?, kaState, supState, liveAea }
 * state = auth.checkMwinit() result for this tick (state.ok is true here).
 * Rejects only if supervisor.ensureHealthyConverging rejects (app.js catches).
 */
async function runKeepaliveOwned(o) {
  const { state, auth, keepalive, supervisor, log } = o || {};
  const st = state || {};
  let liveAea = null;
  try { liveAea = await auth.aeaSessionExpiryMin(); } catch (_) { liveAea = null; }
  let k;
  try { k = keepalive.getState() || {}; } catch (_) { k = { state: 'UNKNOWN', consecutiveFailures: null }; }
  const kaState = k.state;
  log.info('[AEA-DIAG] live session AEA(min)=' + liveAea + ' | disk AEA(min)=' + st.aeaExpiresInMin +
    ' | sessionOk=' + st.ok + ' | owner=aea-keepalive keepalive=' + kaState + ' fails=' + k.consecutiveFailures);

  const needsHelp = kaState === 'ACME_DOWN' || kaState === 'DEGRADED' || liveAea == null || liveAea <= 0;
  if (!needsHelp) {
    log.info('[midway] heartbeat: AEA owned by aea-keepalive (state=' + kaState + ') — heartbeat not refreshing AEA');
    return { delegated: false, kaState, supState: null, liveAea };
  }
  if (_delegation) {
    log.info('[midway] heartbeat: AEA keep-alive unhealthy (' + kaState + ') — already delegating to auth supervisor, skipping');
    return { delegated: false, skipped: true, kaState, supState: null, liveAea };
  }
  let s = null;
  if (supervisor && typeof supervisor.getState === 'function') {
    try { s = supervisor.getState(); } catch (_) { s = null; }
  }
  if (!supervisor || typeof supervisor.ensureHealthyConverging !== 'function') {
    log.warn('[midway] heartbeat: AEA keep-alive unhealthy (' + kaState + ') — auth supervisor unavailable, nothing delegated');
    return { delegated: false, kaState, supState: s, liveAea };
  }
  if (s === null || s === undefined || DELEGATE_STATES.has(s)) {
    log.warn('[midway] heartbeat: AEA keep-alive unhealthy (' + kaState + ') — delegating to auth supervisor (state=' + s + ', no prompt)');
    const d = Promise.resolve(supervisor.ensureHealthyConverging({ reason: 'heartbeat:aea-keepalive-degraded', allowPrompt: false }));
    _delegation = d;
    try { await d; } finally { if (_delegation === d) _delegation = null; }
    return { delegated: true, kaState, supState: s, liveAea };
  }
  // COOLDOWN / RECOVERING / OFFLINE / WAITING_FOR_USER: supervisor owns recovery + backoff.
  let armed = false;
  if (typeof supervisor.ensureRecoveryArmed === 'function') {
    try { armed = !!supervisor.ensureRecoveryArmed(); } catch (_) { armed = false; }
  }
  log.info('[midway] heartbeat: AEA keep-alive unhealthy (' + kaState + ') — supervisor ' + s +
    ' already owns recovery' + (armed ? ' (watchdog armed retry)' : '') + '; not escalating');
  return { delegated: false, deferred: true, kaState, supState: s, liveAea };
}

// Tests only.
function _reset() { _warnedNotRunning = false; _delegation = null; }

module.exports = { ownerFor, runKeepaliveOwned, DELEGATE_STATES, _reset };
