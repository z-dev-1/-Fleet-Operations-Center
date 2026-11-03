'use strict';
/**
 * ipc/workers.js — worker supervisor status (Phase 5) + manual re-enable (Phase 6).
 *
 *   workers:status      supervisor.getStatus() (per-worker heartbeats, counts,
 *                       breaker / isolation state, next run, process sample)
 *   workers:re-enable   supervisor.reEnable(name, { runNow:false }) — the only
 *                       mutation. The name is validated against the
 *                       supervisor's NAME_RE before the supervisor is called;
 *                       runNow is always false (the worker resumes on its next
 *                       grid slot and every dependency gate still applies).
 *                       The supervisor owns eligibility (isolated /
 *                       budget-exhausted only); the UI only hides the button.
 *
 * Same sender guard as ipc/telemetry.js: preload.js is also injected into AAP
 * corp pages, so only the app's own UI may read the status or re-enable.
 */
const { handle } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const supervisor = require('../workers/supervisor');
const logger = require('../utils/logger')('ipc:workers');
const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };
const NAME_RE = /^[a-z][A-Za-z0-9]{1,39}$/;
function registerWorkersIPC() {
  handle('workers:status', async (e) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[workers:status] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    return { ok: true, status: supervisor.getStatus() };
  });
  handle('workers:re-enable', async (e, name) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[workers:re-enable] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      logger.debug('[workers:re-enable] rejected: invalid worker name');
      return { ok: false, code: 'INVALID_NAME' };
    }
    if (supervisor.reEnable(name, { runNow: false })) {
      logger.info('[workers:re-enable] ' + name + ' re-enabled by user');
      return { ok: true, reEnabled: true };
    }
    logger.debug('[workers:re-enable] ' + name + ' not eligible');
    return { ok: true, reEnabled: false, reason: 'not-eligible' };
  });
}
module.exports = { registerWorkersIPC };
