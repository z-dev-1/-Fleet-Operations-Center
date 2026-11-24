'use strict';
/**
 * autopilot/lifecycle.js — legal case-state transitions (§B4). Pure.
 * RESOLVED is terminal; a later OOS episode opens a new case.
 */

const { STATES: S } = require('./constants');

const NEW = '(new)';

const LEGAL = Object.freeze({
  [NEW]: new Set([S.DETECTED]),
  [S.DETECTED]: new Set([S.QUEUED, S.PAUSED, S.RESOLVED]),
  [S.QUEUED]: new Set([S.INVESTIGATING, S.PAUSED, S.RESOLVED]),
  [S.INVESTIGATING]: new Set([
    S.ANALYZING, S.MONITORING, S.RECOMMENDATION_READY, S.WAITING_FOR_DATA, S.AUTH_REQUIRED,
    S.QUEUED, S.FAILED, S.PAUSED, S.RESOLVED, S.NEEDS_REVIEW,
  ]),
  [S.ANALYZING]: new Set([S.RECOMMENDATION_READY, S.MONITORING, S.NEEDS_REVIEW, S.QUEUED, S.FAILED, S.PAUSED]),
  [S.RECOMMENDATION_READY]: new Set([S.MONITORING, S.QUEUED, S.NEEDS_REVIEW, S.PAUSED, S.RESOLVED]),
  [S.MONITORING]: new Set([S.QUEUED, S.PAUSED, S.RESOLVED, S.NEEDS_REVIEW]),
  [S.WAITING_FOR_DATA]: new Set([S.QUEUED, S.PAUSED, S.RESOLVED, S.NEEDS_REVIEW]),
  [S.AUTH_REQUIRED]: new Set([S.QUEUED, S.PAUSED, S.RESOLVED, S.NEEDS_REVIEW]),
  [S.FAILED]: new Set([S.QUEUED, S.PAUSED, S.RESOLVED]),
  [S.NEEDS_REVIEW]: new Set([S.QUEUED, S.MONITORING, S.PAUSED, S.RESOLVED]),
  [S.PAUSED]: new Set([S.QUEUED, S.RESOLVED]),
  [S.RESOLVED]: new Set(),
});

/** canTransition(from, to). `from` null/undefined means a new case. */
function canTransition(from, to) {
  const key = from == null ? NEW : from;
  const set = LEGAL[key];
  return !!set && set.has(to);
}

function isTerminal(state) { return state === S.RESOLVED; }

module.exports = { LEGAL, NEW, canTransition, isTerminal };
