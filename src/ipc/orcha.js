'use strict';
/**
 * ipc/orcha.js - Orcha AI deep-process, correction learning, vendor suggest, popup window
 * orcha:deep-process, orcha:record-correction, orcha:suggest-vendor,
 * orcha:get-corrections, open-popup
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #4: open-popup validates URL against POPUP_ALLOWED_HOSTS allowlist
 *   - Issue #11: orcha:deep-process wrapped in 120s timeout race
 *   - Issue #19: orcha:record-correction validates all required correction fields
 *   - orcha:deep-process validates unitIds is a non-empty string array
 *   - All handlers migrated to handle() wrapper
 */

const { BrowserWindow } = require('electron');
const store  = require('../store');
const logger = require('../utils/logger')('ipc:orcha');
const { handle, timeoutAfter, requireString, requireArray } = require('./_safe');
const { ConfigError, NetworkError } = require('../utils/errors');

// â”€â”€ Issue #4: URL allowlist for open-popup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Only these hostnames may be loaded in a managed BrowserWindow with AutoLogin.
// Subdomain matching: any host that ENDS WITH an allowed entry is permitted.
const POPUP_ALLOWED_HOSTS = [
  'relay.amazon.work',
  'aap.amazon.work',
  'amazon.enterprise.slack.com',
  'outlook.office365.com',
  'amazon.sharepoint.com',
  'issues.amazon.com',
];

function _validatePopupUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new NetworkError('open-popup: invalid URL format', rawUrl);
  }
  if (parsed.protocol !== 'https:') {
    throw new NetworkError('open-popup: only https:// URLs are permitted', rawUrl);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = POPUP_ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
  if (!allowed) {
    throw new NetworkError(
      'open-popup: host not in allowlist: ' + host,
      rawUrl,
      { allowlist: POPUP_ALLOWED_HOSTS }
    );
  }
  return parsed.href; // normalised
}

function registerOrchaIPC(ctx) {
  const send = ctx.sendToWindow;

  // â”€â”€ orcha:deep-process â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Issue #11: 120s timeout â€” runOrchaDeepScan cannot hang IPC indefinitely
  handle('orcha:deep-process', async (_e, unitIds) => {
    requireArray(unitIds, 'unitIds');
    // Validate each entry is a non-empty string
    for (let i = 0; i < unitIds.length; i++) {
      if (typeof unitIds[i] !== 'string' || unitIds[i].trim() === '') {
        throw new ConfigError('unitIds[' + i + '] must be a non-empty string', 'unitIds');
      }
    }
    const { runOrchaDeepScan } = require('../orcha/deep-scan');
    const allRows = ctx.lastData && ctx.lastData.rows ? ctx.lastData.rows : [];
    const targets = allRows.filter(u => unitIds.includes(u.equipmentId));
    const scanPromise = runOrchaDeepScan(targets, {
      pushData:    ctx.pushData,
      pushStatus:  ctx.pushStatus,
      payload:     { rows: targets },
      uptakeCount: 0,
      relayCount:  0,
    });
    // Race: scan vs 120s timeout
    const result = await Promise.race([
      scanPromise,
      timeoutAfter(120000, 'orcha:deep-process'),
    ]);
    const notes = store.load('notesStore', {});
        // Run anomaly detection and push alerts to renderer
    try {
      const { runAnomalyDetection } = require('../orcha/anomaly');
      const fd = store.load('fleetData', {});
      const alerts = runAnomalyDetection((fd.rows || []).concat(targets));
      if (alerts && alerts.length && ctx.sendToWindow) {
        ctx.sendToWindow('orcha:alerts', { alerts, counts: { critical: alerts.filter(a => a.severity === 'critical').length, warning: alerts.filter(a => a.severity === 'warning').length, info: alerts.filter(a => a.severity === 'info').length } });
      }
    } catch(e) { /* anomaly detection is advisory — don't block */ }

    return {
      processed: result.processed,
      units: targets
        .filter(t => t._orchaProcessed)
        .map(t => ({
          equipmentId:    t.equipmentId,
          issueSummary:   t.issueSummary,
          repairTimeline: t.repairTimeline,
          notes:          (notes[t.equipmentId] || {}).notes || '',
        })),
    };
  });

  // â”€â”€ orcha:record-correction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Issue #19: validate all required fields before writing to learn store
  handle('orcha:record-correction', async (_e, correction) => {
    if (!correction || typeof correction !== 'object') {
      throw new ConfigError('correction must be an object', 'correction');
    }
    requireString(correction.unitId,       'correction.unitId');
    requireString(correction.field,        'correction.field');
    if (correction.orchaSuggested === undefined || correction.orchaSuggested === null) {
      throw new ConfigError('correction.orchaSuggested is required', 'orchaSuggested');
    }
    if (correction.userChose === undefined || correction.userChose === null) {
      throw new ConfigError('correction.userChose is required', 'userChose');
    }
    const { recordCorrection } = require('../orcha/learn');
    recordCorrection(
      correction.unitId, correction.field,
      correction.orchaSuggested, correction.userChose,
      correction.context || {}
    );
    return { ok: true };
  });

  // â”€â”€ orcha:suggest-vendor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('orcha:suggest-vendor', async (_e, unit) => {
    const { suggestVendor } = require('../orcha/learn');
    return suggestVendor(unit);
  });

  // â”€â”€ orcha:get-corrections â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('orcha:get-corrections', async (_e, field, limit) => {
    const { getCorrectionsContext } = require('../orcha/learn');
    return getCorrectionsContext(field, limit);
  });

  // â”€â”€ open-popup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Issue #4: URL validated against POPUP_ALLOWED_HOSTS before window creation
  handle('open-popup', async (_e, url, title) => {
    requireString(url, 'url');
    const safeUrl = _validatePopupUrl(url); // throws NetworkError if not allowed
    const { attemptAutoLogin } = require('../orcha/auto-login');
    const win = new BrowserWindow({
      width: 1200, height: 800, show: true,
      title: title ? String(title).slice(0, 60) : safeUrl.substring(0, 60),
      icon: require('../config/app-icon').getAppIconPath(),
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.loadURL(safeUrl);

    // Workflow Intelligence: attach capture if a recording is currently in
    // progress (Phase 8, Phase 1.4 -- see docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md).
    // Observation-only -- never clicks/fills/navigates, so this carries no
    // execution risk regardless of recording state.
    try {
      const { getActiveSessionId } = require('./workflow-intel');
      const activeSession = getActiveSessionId();
      if (activeSession) {
        const { attachCapture } = require('../window/action_capture');
        attachCapture(win, activeSession);
      }
    } catch (e) {
      logger.warn('Workflow Intelligence capture attach failed:', e.message);
    }
    win.webContents.on('did-finish-load', async () => {
      try {
        const result = await attemptAutoLogin(win.webContents, win.webContents.getURL());
        if (result.filled) logger.info('AutoLogin filled credentials for:', result.site);
      } catch (e) {
        logger.warn('AutoLogin error:', e.message);
      }
    });
    return { success: true };
  });


  // S28-Sprint1: dismiss anomaly alert
  handle('orcha:dismiss-alert', (_e, alertId) => {
    requireString(alertId, 'alertId');
    const { dismissAlert } = require('../orcha/anomaly');
    dismissAlert(alertId);
    return { ok: true };
  });

  // â”€â”€ S28-Sprint3: Execute recommendation via Orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Validates through Guardian, then runs the intent through the full
  // orchestrator pipeline: validate â†’ enrich â†’ plan â†’ execute â†’ verify
  handle('orcha:execute', async (_e, intent) => {
    if (!intent || typeof intent !== 'object') throw new ConfigError('intent must be an object', 'intent');

    const orchestrator = require('../orcha/orchestrator');
    const guardian     = require('../orcha/guardian');
    const context      = require('../orcha/context');

    // Hydrate context with latest fleet data (so orchestrator can enrich)
    if (ctx.lastData && ctx.lastData.rows) {
      for (const row of ctx.lastData.rows) {
        if (row.equipmentId) context.updateUnit(row.equipmentId, row);
      }
    }

    // Step 1: Guardian pre-flight check
    const guardResult = guardian.check({
      type:   intent.type,
      unitId: intent.unitId || intent.unit,
      data:   intent.data || intent.payload || {},
    });

    if (!guardResult.allowed) {
      logger.warn('Guardian BLOCKED intent:', intent.type, guardResult.issues.map(i => i.message).join('; '));
      return {
        success: false,
        blocked: true,
        issues: guardResult.issues,
        message: 'Action blocked by safety checks: ' + guardResult.issues.map(i => i.message).join('; '),
      };
    }

    // Step 2: Execute through orchestrator
    logger.info('Orchestrator executing:', intent.type, 'unit:', intent.unitId || intent.unit || '(fleet-wide)');
    const result = await orchestrator.execute({
      type:   intent.type,
      unitId: intent.unitId || intent.unit,
      data:   intent.data || intent.payload || {},
      source: 'recommendation',
    });

    // Step 3: Push execution result to renderer
    ctx.send('orcha:execution-result', {
      intent: intent.type,
      unit:   intent.unitId || intent.unit,
      result,
      ts:     new Date().toISOString(),
    });

    return result;
  });

  // â”€â”€ S28-Sprint3: Get orchestrator execution log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('orcha:get-execution-log', () => {
    const orchestrator = require('../orcha/orchestrator');
    return orchestrator.getLog(30);
  });

  // â”€â”€ S28: Excel Export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('orcha:export-excel', (_e, { rows, columns }) => {
    const { generateExcel } = require('../utils/excel-export');
    const { app } = require('electron');
    const downloadsPath = app.getPath('downloads');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `fleet-export-${date}.xls`;
    const outputPath = require('path').join(downloadsPath, filename);
    generateExcel(rows, columns, outputPath);
    logger.info('Excel exported:', outputPath);
    return { ok: true, path: outputPath, filename };
  });

  // â”€â”€ S28: RCA Code Auto-Inference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('orcha:infer-rca', (_e, { text, context }) => {
    const { inferRCA } = require('../orcha/rca-infer');
    return inferRCA(text || '', context || {});
  });

  handle('orcha:infer-rca-unit', (_e, row) => {
    const { inferRCAForUnit } = require('../orcha/rca-infer');
    return inferRCAForUnit(row || {});
  });


  logger.info('Orcha IPC handlers registered');
}

module.exports = { registerOrchaIPC };
