'use strict';
/**
 * jobs/states.js — durable job state machine (Phase 7, design §3).
 *
 * Like scheduler/ledger.js, anything not listed in TRANSITIONS is rejected.
 * Deliberate stricter deviation from ledger.js: a same-state "transition" is
 * rejected too (patches go through renew / setCheckpoint / unitsSettled), so
 * history_json records only real state changes.
 */

const STATES = Object.freeze([
  'queued', 'claimed', 'running',
  'waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval',
  'verifying', 'completed', 'failed', 'cancelled', 'recovery_required',
]);

const TRANSITIONS = Object.freeze({
  queued:                Object.freeze(['claimed', 'cancelled', 'failed']),
  claimed:               Object.freeze(['running', 'queued', 'waiting_on_dependency', 'waiting_on_auth', 'cancelled', 'failed']),
  running:               Object.freeze(['verifying', 'completed', 'failed', 'cancelled',
                                        'waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval',
                                        'queued', 'recovery_required']),
  waiting_on_dependency: Object.freeze(['queued', 'cancelled', 'failed']),
  waiting_on_auth:       Object.freeze(['queued', 'cancelled', 'failed']),
  waiting_on_approval:   Object.freeze(['queued', 'cancelled', 'failed']),
  verifying:             Object.freeze(['completed', 'failed', 'recovery_required', 'queued', 'cancelled']),
  completed:             Object.freeze([]),
  failed:                Object.freeze(['queued']),          // reserved: explicit manual retry only (unused in Phase 7)
  cancelled:             Object.freeze([]),
  recovery_required:     Object.freeze(['queued', 'completed', 'failed', 'cancelled']),  // only via reconcile()
});

const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);
const LEASED = Object.freeze(['claimed', 'running', 'verifying']);
const WAITING = Object.freeze(['waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval']);

function canTransition(from, to) {
  if (from === to) return false;
  const allowed = Object.prototype.hasOwnProperty.call(TRANSITIONS, from) ? TRANSITIONS[from] : null;
  return !!allowed && allowed.includes(to);
}

module.exports = { STATES, TRANSITIONS, TERMINAL, LEASED, WAITING, canTransition };
