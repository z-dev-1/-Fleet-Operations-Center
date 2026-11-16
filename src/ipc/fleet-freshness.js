'use strict';
/**
 * ipc/fleet-freshness.js — read-only fleet data freshness.
 *
 *   fleet:get-freshness  -> { ok:true, snapshot, evaluation }
 *                           (health/fleet-freshness getSnapshot/evaluate)
 *
 * Same sender guard as ipc/health.js: preload.js is also injected into AAP
 * corp pages, so only the app's own UI may read it. No input, no mutation.
 * Pushes of the same payload arrive on 'fleet:freshness' (window/index.js).
 */
const { handle } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const logger = require('../utils/logger')('ipc:fleet-freshness');
const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };
function registerFleetFreshnessIPC() {
  handle('fleet:get-freshness', async (e) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[fleet:get-freshness] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    const ff = require('../health/fleet-freshness');
    const now = Date.now();
    return { ok: true, snapshot: ff.getSnapshot(now), evaluation: ff.evaluate(now) };
  });
}
module.exports = { registerFleetFreshnessIPC };
