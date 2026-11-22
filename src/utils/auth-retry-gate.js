'use strict';
/**
 * src/utils/auth-retry-gate.js — the one rate limiter for background vendor sign-ins (DTNA, Aperia).
 *
 * createRetryGate({ minGapMs, failCooldownMs, actionCooldownMs, actionCodes, now })
 *   -> { run(fn), canStart(), state(), clearAction(), _reset() }
 *
 * - run(fn): single-flight. Concurrent callers share the in-flight promise. When canStart() is false it
 *   resolves { ok:false, code:'AUTH_COOLDOWN', gated:true } without calling fn. Never rejects (a throw
 *   or rejection of fn becomes { ok:false, code:'AUTH_INTERNAL' }).
 * - A result { ok:true } clears every failure state. A code in actionCodes latches actionNeeded (the
 *   result carries firstAction:true only on the false -> true transition). Any other failure is transient.
 * - canStart(): minGapMs since the last start, failCooldownMs after a transient failure, and
 *   actionCooldownMs while latched.
 * Pure: no timers, no requires.
 */

function createRetryGate(opts) {
  const o = opts || {};
  const minGapMs = Number(o.minGapMs) || 0;
  const failCooldownMs = Number(o.failCooldownMs) || 0;
  const actionCooldownMs = Number(o.actionCooldownMs) || 0;
  const actionCodes = o.actionCodes instanceof Set ? o.actionCodes : new Set(o.actionCodes || []);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  let inFlight = null;
  let lastStart = null;
  let lastFailAt = null;
  let actionNeeded = false;
  let actionAt = null;

  function canStart() {
    const t = now();
    if (lastStart != null && t - lastStart < minGapMs) return false;
    if (actionNeeded && actionAt != null && t - actionAt < actionCooldownMs) return false;
    if (lastFailAt != null && t - lastFailAt < failCooldownMs) return false;
    return true;
  }

  function _record(r) {
    const res = r && typeof r === 'object' ? r : { ok: false, code: 'AUTH_INTERNAL' };
    if (res.ok) {
      lastFailAt = null;
      actionNeeded = false;
      actionAt = null;
      return res;
    }
    if (actionCodes.has(res.code)) {
      const first = !actionNeeded;
      actionNeeded = true;
      actionAt = now();
      return first ? Object.assign({}, res, { firstAction: true }) : res;
    }
    lastFailAt = now();
    return res;
  }

  function run(fn) {
    if (inFlight) return inFlight;
    if (!canStart()) return Promise.resolve({ ok: false, code: 'AUTH_COOLDOWN', gated: true });
    lastStart = now();
    let p;
    try { p = Promise.resolve(fn()); } catch (_) { p = Promise.resolve({ ok: false, code: 'AUTH_INTERNAL' }); }
    inFlight = p
      .then((r) => _record(r), () => _record({ ok: false, code: 'AUTH_INTERNAL' }))
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function state() { return { inFlight: !!inFlight, actionNeeded }; }
  function clearAction() { actionNeeded = false; actionAt = null; }
  function _reset() { inFlight = null; lastStart = null; lastFailAt = null; actionNeeded = false; actionAt = null; }

  return { run, canStart, state, clearAction, _reset };
}

module.exports = { createRetryGate };
