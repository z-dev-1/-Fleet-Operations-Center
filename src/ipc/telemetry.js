'use strict';
/**
 * ipc/telemetry.js — read-only performance telemetry (Phase 2a).
 *
 *   telemetry:snapshot   current sampler state + recent track() durations
 *
 * Same sender guard as ipc/assistant.js: preload.js is also injected into AAP
 * corp pages, so only the app's own UI may read the snapshot.
 */
const { handle } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const telemetry = require('../telemetry');
const logger = require('../utils/logger')('ipc:telemetry');

const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };

function registerTelemetryIPC() {
  handle('telemetry:snapshot', async (e) => {
    if (!screenContext._isAppSender(e)) {
      logger.debug('[telemetry:snapshot] rejected: sender is not the app UI');
      return NOT_APP_UI;
    }
    return { ok: true, snapshot: telemetry.snapshot() };
  });
}

module.exports = { registerTelemetryIPC };
