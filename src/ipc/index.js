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
const { registerLongDwellAiIPC }   = require('./long-dwell-ai');
const { registerLongDwellSpIPC }   = require('./long-dwell-sp');
const { registerFleetDbrIPC }      = require('./fleet-dbr');
const { registerBaseballCardIPC }  = require('./baseball-card');
const { registerFasRosterIPC }     = require('./fas-roster');
const { registerPendingEstIPC }    = require('./pending-est');
const { registerSchedulerIPC }     = require('./scheduler');
const { registerEmailTriageIPC }   = require('./email-triage');
const { registerEmailIntelIPC }    = require('./email-intel');
const { registerRelayReconcileIPC } = require('./relay-reconcile');
const { registerRelayWritesIPC }   = require('./relay-writes');
const { registerAuthHealthIPC }    = require('./auth-health');
const { registerRepairIntelIPC }   = require('./repair-intel');
const { registerAssistantIPC }     = require('./assistant');
const { registerTelemetryIPC }     = require('./telemetry');
const { registerWorkersIPC }       = require('./workers');
const { registerHealthIPC }        = require('./health');
const { registerFleetFreshnessIPC } = require('./fleet-freshness');
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
  registerLongDwellAiIPC();   // durable AI Fill arbiter; inert unless jobs.longDwellAiFill.durable
  registerLongDwellSpIPC();   // weekly sheet preview/write; inert unless longDwell.sharepointWrite
  registerFleetDbrIPC(ctx);   // Daily Call Fleet DBR; inert unless dbr.fleetData
  registerBaseballCardIPC();
  registerFasRosterIPC();
  registerPendingEstIPC(ctx);   // team-wide Pending Estimates (read-only)
  const { registerAapApiIPC } = require('./aap-api');
  registerAapApiIPC(ctx);
  registerSchedulerIPC(ctx);
  registerEmailTriageIPC(ctx);
  registerEmailIntelIPC(ctx);
  registerRelayReconcileIPC(ctx);
  registerRelayWritesIPC(ctx);  // Relay write-approval gate (addComment / WR commits)
  const { registerContactsHandlers } = require('./contacts');
  registerContactsHandlers();
  registerAuthHealthIPC(ctx);
  registerRepairIntelIPC(ctx);
  registerAssistantIPC(ctx);
  registerTelemetryIPC(ctx);
  registerWorkersIPC(ctx);
  registerHealthIPC(ctx);
  registerFleetFreshnessIPC(ctx);
  // Meetings tab (zoom.enabled, default OFF): inert DISABLED handlers when off.
  try { require('./zoom-meet').registerZoomMeetIPC(ctx); } catch (e) { logger.warn('Zoom Meetings IPC registration failed: ' + e.message); }
  // AAP Root Cause Analysis form via the Relay template API (History-tab RCA button).
  try { require('./rca').registerRcaIPC(); } catch (e) { logger.warn('RCA IPC registration failed: ' + e.message); }
  try { require('./zoom-hub').registerZoomHubIPC(ctx); } catch (e) { logger.warn('Zoom hub IPC registration failed: ' + (e && e.name)); }
  logger.info('All IPC handlers registered');
}

module.exports = { registerAllIPC };
