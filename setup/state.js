/**
 * setup/state.js — Setup wizard state management
 *
 * Tracks which setup steps have been completed.
 * The app checks isSetupComplete() on every launch.
 * If false, it opens the setup wizard before the main window.
 *
 * Steps:
 *   profile        — User name and alias
 *   domiciles      — Station codes to monitor
 *   midway         — Midway auth verified
 *   slack          — Slack token + cookie stored
 *   sharepoint     — SP workbook paths configured
 *   email          — SMTP credentials stored
 *   orcha          — AI engine configured (local WS or Bedrock)
 *   database       — Data directory confirmed writable
 */

'use strict';

const store   = require('../src/store');
const logger  = require('../src/utils/logger')('setup');

const REQUIRED_STEPS = [
  'profile', 'domiciles', 'midway', 'database'
  // slack, sharepoint, email, orcha are optional — can be configured later
];

const OPTIONAL_STEPS = [
  'slack', 'sharepoint', 'email', 'orcha'
];

const ALL_STEPS = [...REQUIRED_STEPS, ...OPTIONAL_STEPS];

function loadState() {
  return store.load('setupState', { completed: [], data: {}, setupComplete: false });
}

function saveState(state) {
  store.save('setupState', state);
}

/**
 * isSetupComplete() — returns true if all required steps are done
 */
function isSetupComplete() {
  const state = loadState();
  if (state.setupComplete) return true;
  const done = new Set(state.completed || []);
  return REQUIRED_STEPS.every(s => done.has(s));
}

/**
 * markStepComplete(step, data?) — records a step as done
 */
function markStepComplete(step, data = {}) {
  const state = loadState();
  if (!state.completed.includes(step)) state.completed.push(step);
  state.data[step] = { ...data, completedAt: new Date().toISOString() };
  state.setupComplete = isSetupComplete();
  saveState(state);
  logger.info(`Setup step completed: ${step}`);
}

/**
 * getStepStatus(step) — returns 'complete' | 'pending' | 'optional'
 */
function getStepStatus(step) {
  const state = loadState();
  const done  = new Set(state.completed || []);
  if (done.has(step)) return 'complete';
  if (REQUIRED_STEPS.includes(step)) return 'pending';
  return 'optional';
}

/**
 * getFullStatus() — returns summary for the Setup Status Dashboard
 */
function getFullStatus() {
  const state = loadState();
  const done  = new Set(state.completed || []);
  return {
    setupComplete: isSetupComplete(),
    requiredComplete: REQUIRED_STEPS.filter(s => done.has(s)).length,
    requiredTotal:   REQUIRED_STEPS.length,
    steps: ALL_STEPS.map(step => ({
      step,
      status:     getStepStatus(step),
      required:   REQUIRED_STEPS.includes(step),
      data:       state.data[step] || null,
    }))
  };
}

/**
 * resetSetup() — clears all setup state (allows re-running wizard)
 */
function resetSetup() {
  saveState({ completed: [], data: {}, setupComplete: false });
  logger.info('Setup state reset');
}

module.exports = {
  isSetupComplete,
  markStepComplete,
  getStepStatus,
  getFullStatus,
  resetSetup,
  REQUIRED_STEPS,
  OPTIONAL_STEPS,
  ALL_STEPS,
};
