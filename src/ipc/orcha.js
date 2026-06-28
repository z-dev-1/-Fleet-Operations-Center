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

// ── Issue #4: URL allowlist for open-popup ────────────────────────────────
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

  // ── orcha:deep-process ───────────────────────────────────────────────────
  // Issue #11: 120s timeout — runOrchaDeepScan cannot hang IPC indefinitely
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

  // ── orcha:record-correction ──────────────────────────────────────────────
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

  // ── orcha:suggest-vendor ─────────────────────────────────────────────────
  handle('orcha:suggest-vendor', async (_e, unit) => {
    const { suggestVendor } = require('../orcha/learn');
    return suggestVendor(unit);
  });

  // ── orcha:get-corrections ────────────────────────────────────────────────
  handle('orcha:get-corrections', async (_e, field, limit) => {
    const { getCorrectionsContext } = require('../orcha/learn');
    return getCorrectionsContext(field, limit);
  });

  // ── open-popup ───────────────────────────────────────────────────────────
  // Issue #4: URL validated against POPUP_ALLOWED_HOSTS before window creation
  handle('open-popup', async (_e, url, title) => {
    requireString(url, 'url');
    const safeUrl = _validatePopupUrl(url); // throws NetworkError if not allowed
    const { attemptAutoLogin } = require('../orcha/auto-login');
    const win = new BrowserWindow({
      width: 1200, height: 800, show: true,
      title: title ? String(title).slice(0, 60) : safeUrl.substring(0, 60),
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.loadURL(safeUrl);
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

  logger.info('Orcha IPC handlers registered');
}

module.exports = { registerOrchaIPC };
