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
// Microsoft Graph removed (2026-09-02) — email uses SMTP/OWA only.
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
const { registerDailyTasksIPC }  = require('./daily-tasks');
const { registerLongDwellIPC }     = require('./long-dwell');
const { registerLongDwellCsvIPC }  = require('./long-dwell-csv');
const { registerFasRosterIPC }     = require('./fas-roster');
const { registerSchedulerIPC }     = require('./scheduler');
const { registerEmailTriageIPC }   = require('./email-triage');
const { registerRelayReconcileIPC } = require('./relay-reconcile');
const { registerAuthHealthIPC }    = require('./auth-health');
const logger = require('../utils/logger')('ipc');

function registerAllIPC(ctx) {
  registerSettingsIPC(ctx);
  registerNotesIPC();
  registerSlackIPC(ctx);
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
  registerDailyTasksIPC(ctx);
  // DTNA session pre-warm: keep the vendor portal logged in in the background
  // (morning + on-demand) so Split View is ready without a manual sign-in.
  try { require('../scrapers/vendor_session').startWarmScheduler(); } catch (e) { logger.warn('vendor warm scheduler start failed: ' + e.message); }
  registerLongDwellIPC();
  registerLongDwellCsvIPC();
  registerFasRosterIPC();
  const { registerAapApiIPC } = require('./aap-api');
  registerAapApiIPC(ctx);
  registerSchedulerIPC(ctx);
  registerEmailTriageIPC(ctx);
  registerRelayReconcileIPC(ctx);
  const { registerContactsHandlers } = require('./contacts');
  registerContactsHandlers();
  registerAuthHealthIPC(ctx);
  logger.info('All IPC handlers registered');
}

module.exports = { registerAllIPC };
