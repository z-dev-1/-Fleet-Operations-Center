'use strict';
/**
 * jobs/types.js — per-type durable job registry (Phase 7, design §4/§5).
 *
 * sideEffects:
 *   'none-external'      reads + local writes only
 *   'external-delegated' only TRIGGERS owners with their own dedupe
 *   'external'           the body writes externally itself -> recovery_required
 * recovery:
 *   'retry'              orphan -> re-queued (Rule R: recovery never executes)
 *   'retry-on-demand'    orphan -> failed; the next user request starts fresh
 * longDwellAiFill (Phase 7 follow-up): adopted. One job per table per local
 * day (scope '<computed|csv>:<YYYY-MM-DD>'); the renderer drives the AI loop,
 * src/jobs/long-dwell-ai-fill.js arbitrates and commits each unit. The AI call
 * is a read and every write is local + idempotent per unit -> none-external.
 */

const MIN = 60 * 1000;
const H = 60 * MIN;

const _registry = {
  deepScan: Object.freeze({ leaseMs: 10 * MIN, maxRunMs: 3 * H, maxAttempts: 3, resumeMaxAgeMs: 2 * H, sideEffects: 'external-delegated', recovery: 'retry', adopted: true }),
  repairIntel: Object.freeze({ leaseMs: 10 * MIN, maxRunMs: 30 * MIN, maxAttempts: 3, resumeMaxAgeMs: 6 * H, sideEffects: 'none-external', recovery: 'retry', adopted: true }),
  rcaAutofill: Object.freeze({ leaseMs: 5 * MIN, maxRunMs: 10 * MIN, maxAttempts: 1, resumeMaxAgeMs: 0, sideEffects: 'none-external', recovery: 'retry-on-demand', adopted: true }),
  longDwellAiFill: Object.freeze({ leaseMs: 10 * MIN, maxRunMs: 4 * H, maxAttempts: 3, resumeMaxAgeMs: 12 * H, sideEffects: 'none-external', recovery: 'retry', adopted: true }),
  // emailTriage (email-intel): one mailbox scan (scope 'mailbox'). Reads the mailbox and writes local
  // stores only; timeline writes are idempotent (ledger + marker); sends are never jobs.
  emailTriage: Object.freeze({ leaseMs: 10 * MIN, maxRunMs: 30 * MIN, maxAttempts: 3, resumeMaxAgeMs: 2 * H, sideEffects: 'none-external', recovery: 'retry', adopted: true }),
};

const ADOPTED = Object.freeze({ deepScan: true, repairIntel: true, rcaAutofill: true, longDwellAiFill: true, emailTriage: true });

function get(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(_registry, type) ? _registry[type] : null;
}
function names() { return Object.keys(_registry); }

// Test-only: register a synthetic type (e.g. sideEffects 'external' for T4).
function _registerTypeForTests(name, def) {
  _registry[name] = Object.freeze(Object.assign({ leaseMs: 10 * MIN, maxRunMs: H, maxAttempts: 3, resumeMaxAgeMs: H, sideEffects: 'external', recovery: 'retry', adopted: true }, def || {}));
}
function _unregisterTypeForTests(name) {
  if (!Object.prototype.hasOwnProperty.call(ADOPTED, name)) delete _registry[name];
}

module.exports = { get, names, ADOPTED, _registerTypeForTests, _unregisterTypeForTests };
