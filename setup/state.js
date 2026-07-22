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

// EXPANDED (2026-07-22): wizard now has a real, working screen for every
// functional (non-cosmetic) setting in the app -- see
// renderer/src/setup/setup.js for the full step list and the reasoning
// for what's deliberately left out (per-operator SharePoint mapping and
// the generic Accounts bookmark list both only make sense once real
// sync data exists; theme/appearance and the Forms Google Sheet ID are
// stored in the renderer's own localStorage, which is NOT shared across
// separate BrowserWindows -- putting them in this separate wizard window
// would silently produce the exact same "looks configured, does
// nothing" bug this whole expansion was meant to fix, so they stay in
// Settings, in the same window as everything that actually reads them).
const OPTIONAL_STEPS = [
  'notifications', 'orcha', 'email', 'graph', 'slack', 'sharepoint', 'asana', 'vendorcreds', 'schedulers', 'confirm'
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
