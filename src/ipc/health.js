'use strict';
/**
 * ipc/health.js — read-only Worker Health aggregate (Phase 6, 2026-11-03).
 *
 *   health:snapshot   health/snapshot.buildSnapshot(): workers, AI, auth,
 *                     Slack poller, scheduler and resources, each section
 *                     isolated ({status:'unavailable'} on failure)
 *
 * Same sender guard as ipc/telemetry.js: preload.js is also injected into AAP
 * corp pages, so only the app's own UI may read the snapshot. No input, no
 * mutation, no timers.
 */
const { handle } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const { buildSnapshot } = require('../health/snapshot');
const logger = require('../utils/logger')('ipc:health');
const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };
function registerHealthIPC() {
  handle('health:snapshot', async (e) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[health:snapshot] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    return buildSnapshot();
  });
}
module.exports = { registerHealthIPC };
