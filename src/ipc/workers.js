'use strict';
/**
 * ipc/workers.js — read-only worker supervisor status (Phase 5, 2026-10-30).
 *
 *   workers:status   supervisor.getStatus() (per-worker heartbeats, counts,
 *                    breaker / isolation state, next run, process sample)
 *
 * Same sender guard as ipc/telemetry.js: preload.js is also injected into AAP
 * corp pages, so only the app's own UI may read the status. No input, no
 * mutation (the manual re-enable button is Phase 6).
 */
const { handle } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const supervisor = require('../workers/supervisor');
const logger = require('../utils/logger')('ipc:workers');
const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };
function registerWorkersIPC() {
  handle('workers:status', async (e) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[workers:status] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    return { ok: true, status: supervisor.getStatus() };
  });
}
module.exports = { registerWorkersIPC };
