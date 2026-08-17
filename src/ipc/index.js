'use strict';
/**
 * ipc/index.js - Register all IPC handlers
 *
 * Called once from src/app.js during bootstrap (after app.whenReady).
 * ctx is the shared application context object with:
 *   ctx.mainWindow       - getter for the current main BrowserWindow
 *   ctx.sendToWindow(ch, data) - safe send to main window
 *   ctx.triggerRescan(force)   - trigger a full data sync
 *   ctx.runFullSync()          - run full sync pipeline
 *   ctx.lastData               - last fetched fleet data { rows: [] }
 *   ctx.pushData / ctx.pushStatus - sync callbacks
 *   ctx.showBubble()           - show the bubble window (optional)
 */

const { registerSettingsIPC }    = require('./settings');
const { registerNotesIPC }       = require('./notes');
const { registerSlackIPC }       = require('./slack');
const { registerGraphIPC }       = require('./graph');
const { registerSharePointIPC }  = require('./sharepoint');
const { registerAsanaIPC }       = require('./asana');
const { registerAIHandlers }     = require('./ai');
const { registerCredentialIPC }  = require('./credentials');
const { registerOrchaIPC }       = require('./orcha');
const { registerScrapersIPC }    = require('./scrapers');
const { registerMiscIPC }        = require('./misc');
const { registerVendorIPC }   = require('../vendors');
const { registerVendorHistoryIPC } = require('./vendor-history');
const { registerSetupIPC }       = require('./setup');
const { registerWorkflowIntelIPC } = require('./workflow-intel');
const { registerLongDwellIPC }     = require('./long-dwell');
const logger = require('../utils/logger')('ipc');

function registerAllIPC(ctx) {
  registerSettingsIPC(ctx);
  registerNotesIPC();
  registerSlackIPC(ctx);
  registerGraphIPC();
  registerSharePointIPC(ctx);
  registerAsanaIPC();
  registerAIHandlers(ctx);
  registerCredentialIPC();
  registerOrchaIPC(ctx);
  registerScrapersIPC(ctx);
  registerSetupIPC(ctx);
  registerMiscIPC(ctx);
  registerVendorIPC();
  registerVendorHistoryIPC();
  registerWorkflowIntelIPC(ctx);
  registerLongDwellIPC();
  const { registerContactsHandlers } = require('./contacts');
  registerContactsHandlers();
  logger.info('All IPC handlers registered');
}

module.exports = { registerAllIPC };
