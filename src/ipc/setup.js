'use strict';
/**
 * ipc/setup.js - Setup wizard IPC handlers  (V-C)
 *
 * Channels:
 *   setup:get-state   — full status object (steps, required/optional, done flags)
 *   setup:save-step   — mark a step complete and persist its data
 *   setup:verify-step — check if a step can be marked done (light validation)
 *   setup:complete    — mark setup finished, signal main window to open
 *   setup:reset       — clear all setup state (dev / re-onboarding)
 *
 * All state lives in store.load('setupState') via setup/state.js.
 *
 * Stage 4 hardening (2026-06-28):
 *   - Issue #25: all 5 handlers migrated to handle() wrapper
 *   - Issue #25: setup:save-step validates step name against ALL_STEPS allowlist
 *   - Issue #25: setup:save-step requires data to be a plain object
 *   - Issue #25: setup:verify-step validates step name before branching
 *   - Issue #26: store.save('_healthcheck') now works correctly — Bug B fix
 *                added '_healthcheck' to store REGISTRY, so this call is clean.
 */

const logger = require('../utils/logger')('ipc:setup');
const { handle, requireObject } = require('./_safe');
const { ConfigError }           = require('../utils/errors');
const {
  isSetupComplete,
  markStepComplete,
  getStepStatus,
  getFullStatus,
  resetSetup,
  ALL_STEPS,      // exported from setup/state.js — full allowlist
} = require('../../setup/state');

// ── Issue #25: step name validation ─────────────────────────────────────────
const STEP_SET = new Set(ALL_STEPS);

function _validateStep(step) {
  if (typeof step !== 'string' || step.trim() === '') {
    throw new ConfigError('step must be a non-empty string', 'step');
  }
  if (!STEP_SET.has(step)) {
    throw new ConfigError(
      'unknown setup step: "' + step + '" (allowed: ' + ALL_STEPS.join(', ') + ')',
      'step'
    );
  }
}

function registerSetupIPC(ctx) {
  // Return full wizard state
  handle('setup:get-state', () => {
    return getFullStatus();
  });

  // Mark a step as complete and save its payload
  // Issue #25: step allowlisted; data must be a plain object
  handle('setup:save-step', (_e, step, data) => {
    _validateStep(step);
    const safeData = data != null ? data : {};
    requireObject(safeData, 'data');
    markStepComplete(step, safeData);
    logger.info('Step saved:', step);
    return { ok: true, status: getStepStatus(step) };
  });

  // Light validation — can this step be considered complete?
  // Issue #25: step validated before branch
  handle('setup:verify-step', async (_e, step) => {
    _validateStep(step);
    if (step === 'midway') {
      const fs    = require('fs');
      const { P } = require('../config/paths');
      const ok    = fs.existsSync(P.midwayCookie);
      return { ok, reason: ok ? null : 'Midway cookie not found — run mwinit first' };
    }
    if (step === 'database') {
      const store = require('../store');
      // Issue #26: '_healthcheck' is now a registered store key (Bug B fix)
      store.save('_healthcheck', { ts: Date.now() });
      return { ok: true };
    }
    if (step === 'orcha') {
      const { P } = require('../config/paths');
      const fs    = require('fs');
      const ok    = fs.existsSync(P.orchaPort);
      return { ok, reason: ok ? null : 'Orcha port file not found — is the Orcha server running?' };
    }
    // For other steps, check if data was already saved
    const status = getStepStatus(step);
    return { ok: status === 'complete', status };
  });

  // Finalise setup — transitions to main window
  handle('setup:complete', () => {
    markStepComplete('database', {});
    const done = isSetupComplete();
    if (done && ctx.createMainWindow) {
      logger.info('Setup complete - opening main window');
      setTimeout(() => {
        ctx.createMainWindow();
        // BUG FIX (2026-07-22): the wizard window used to close itself
        // from inside the (dead) 'wizard:complete' handler. Now that all
        // real saving happens step-by-step in the renderer via the same
        // bridges Settings uses, this is the one remaining place that
        // needs to close the wizard window once setup is genuinely done.
        if (ctx.closeSetupWizard) ctx.closeSetupWizard();
      }, 200);
    }
    return { ok: done, setupComplete: done };
  });


  // Reset (dev tool / re-onboarding)
  handle('setup:reset', () => {
    resetSetup();
    logger.info('Setup state reset');
    return { ok: true };
  });

  logger.info('Setup IPC handlers registered');
}

module.exports = { registerSetupIPC };
