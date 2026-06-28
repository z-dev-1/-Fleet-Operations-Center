'use strict';
/**
 * ipc/sharepoint.js - SharePoint push IPC handlers
 * sp:push, sp:get-config, sp:save-config
 *
 * Stage 4 hardening (2026-06-28):
 *   - Issue #24: all 3 handlers migrated to handle() wrapper
 *   - Issue #24: sp:push validates units is a non-empty array, capped at 500 entries
 *   - Issue #24: sp:save-config validates workbooks is a non-empty array
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:sharepoint');
const { handle, requireArrayMax } = require('./_safe');
const { ConfigError }             = require('../utils/errors');

const MAX_SP_UNITS = 500;   // hard cap on units per push — prevents unbounded SP writes

function registerSharePointIPC(ctx) {
  const send = ctx.sendToWindow;

  // Issue #24: array validated before any SP write begins
  handle('sp:push', async (_e, units) => {
    requireArrayMax(units, 'units', MAX_SP_UNITS);
    const { pushToSharePoint } = require('../../src/scrapers/sharepoint_push');
    return pushToSharePoint(units, (msg, type) => {
      logger.info('[SP Push]', type || 'info', '|', msg);
      if (send) send('sp:progress', { message: msg, type });
    });
  });

  handle('sp:get-config', () => store.load('spConfig', {}));

  // Issue #24: workbooks must be a non-empty array
  handle('sp:save-config', (_e, workbooks) => {
    if (!Array.isArray(workbooks) || workbooks.length === 0) {
      throw new ConfigError('workbooks must be a non-empty array', 'workbooks');
    }
    store.save('spConfig', workbooks);
    return { ok: true };
  });

  logger.info('SharePoint IPC handlers registered');
}

module.exports = { registerSharePointIPC };
