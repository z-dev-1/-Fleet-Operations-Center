'use strict';
/**
 * ipc/ai.js - AI features IPC handlers
 * ai:suggest, ai:ask, ai:chat
 * orcha:get-config, orcha:save-config, orcha:test, orcha:status, orcha:mwinit, orcha:refresh-creds
 * daily-notes:open-windows, daily-notes:run, daily-notes:get-log
 *
 * V-C: session path uses P.aapCache (cross-platform) instead of hardcoded AppData\Roaming path.
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #8  MED: daily-notes:run caps batch size (MAX_DAILY_NOTES_BATCH = 100) and
 *                    validates each unit has equipmentId before dispatch.
 *   - Issue #13 LOW: ai:chat indicates which path was used (chat vs fallback) in response.
 *   - Issue #15 LOW: ai:ask + ai:suggest cap prompt/unit payload size.
 *   - All handlers migrated to handle() wrapper.
 */

const { BrowserWindow, screen: eScreen, session: eSession } = require('electron');
const store  = require('../store');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('ipc:ai');
const fs     = require('fs');
const { handle, requireString, requireStringMax, requireArrayMax } = require('./_safe');
const { ConfigError } = require('../utils/errors');

// ── Issue #15 / #8: size caps ────────────────────────────────────────────────
const MAX_PROMPT_LEN       = 8192;   // characters — ai:ask, ai:chat
const MAX_DAILY_NOTES_BATCH = 100;   // units    — daily-notes:run
const MAX_SUGGEST_KEYS      = 50;    // keys on unit object for ai:suggest

function registerAIHandlers(ctx) {
  const { suggestDropdowns, askOrcha, sendOrchaChat, loadOrchaConfig, saveOrchaConfig } = require('../../src/scrapers/orcha_ws');
  const relay = require('../orcha/relay');
  const send  = ctx.sendToWindow;

  // Issue #15: prompt length cap
  handle('ai:suggest', async (_e, unit) => {
    if (!unit || typeof unit !== 'object') throw new ConfigError('unit must be an object', 'unit');
    const keyCount = Object.keys(unit).length;
    if (keyCount > MAX_SUGGEST_KEYS) {
      throw new ConfigError('unit object too large (' + keyCount + ' keys, max ' + MAX_SUGGEST_KEYS + ')', 'unit');
    }
    return suggestDropdowns(unit);
  });

  // Issue #15: prompt length cap
  handle('ai:ask', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
    return askOrcha(prompt);
  });

  // Issue #13: response now includes `path` field ('chat' or 'fallback')
  // so the renderer knows which code path ran.
  handle('ai:chat', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
    try {
      const text = await sendOrchaChat(prompt);
      return { ok: true, text, path: 'chat' };
    } catch (e) {
      logger.warn('Fleet Chat fallback to askOrcha:', e.message);
      const result = await askOrcha(prompt);
      // askOrcha may return a string or an object — normalise
      if (typeof result === 'string') return { ok: true, text: result, path: 'fallback' };
      return { ...result, path: 'fallback' };
    }
  });

  // Orcha config
  handle('orcha:get-config',    () => loadOrchaConfig());
  handle('orcha:save-config',   (_e, config) => { saveOrchaConfig(config); return { ok: true }; });

  // Relay health / auth
  handle('orcha:test',          async () => relay.healthCheck());
  handle('orcha:status',        () => relay.getStatus());
  handle('orcha:mwinit',        async () => relay.runMwinit());
  handle('orcha:refresh-creds', () => { relay.refreshCredentials(); return { ok: true }; });

  // Daily Notes - open Relay + Offsite windows side-by-side
  handle('daily-notes:open-windows', async (_e, opts) => {
    const spSes = eSession.defaultSession;
    const { width, height } = eScreen.getPrimaryDisplay().workAreaSize;
    const halfW = Math.floor(width / 2);
    const winH  = Math.floor(height * 0.85);
    const topY  = Math.floor(height * 0.05);
    const windows = [];

    if (opts.relayUrl) {
      const relayWin = new BrowserWindow({
        width: halfW, height: winH, x: 0, y: topY,
        title: 'Relay Garage - ' + (opts.unitId || ''),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes },
      });
      relayWin.loadURL(opts.relayUrl);
      windows.push(relayWin);
    }

    if (opts.offsiteUrl) {
      const offsiteWin = new BrowserWindow({
        width: halfW, height: winH, x: halfW, y: topY,
        title: 'Offsite Event - ' + (opts.unitId || ''),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes },
      });
      offsiteWin.loadURL(opts.offsiteUrl);
      windows.push(offsiteWin);
    }

    if (windows.length === 1) {
      windows[0].setBounds({ x: Math.floor(width * 0.1), y: topY, width: Math.floor(width * 0.8), height: winH });
    }
    return { opened: windows.length };
  });

  // Issue #8: batch size cap + per-unit shape validation
  handle('daily-notes:run', async (_e, units) => {
    if (!Array.isArray(units) || units.length === 0) {
      throw new ConfigError('units must be a non-empty array', 'units');
    }
    if (units.length > MAX_DAILY_NOTES_BATCH) {
      throw new ConfigError(
        'daily-notes:run batch too large (' + units.length + ', max ' + MAX_DAILY_NOTES_BATCH + ')',
        'units'
      );
    }
    // Each element must have a non-empty equipmentId string
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u || typeof u !== 'object') {
        throw new ConfigError('units[' + i + '] must be an object', 'units');
      }
      if (typeof u.equipmentId !== 'string' || u.equipmentId.trim() === '') {
        throw new ConfigError('units[' + i + '].equipmentId must be a non-empty string', 'units');
      }
    }
    const { runDailyNotes } = require('../../src/scrapers/daily_notes');
    // V-C: use P.aapCache instead of hardcoded AppData path
    let session = { cookies: [] };
    try {
      if (fs.existsSync(P.aapCache)) session = JSON.parse(fs.readFileSync(P.aapCache, 'utf8'));
    } catch (_) { /* no session yet - proceed without cookies */ }
    return runDailyNotes(units, session, askOrcha, (msg) => {
      logger.info(msg);
      if (send) send('daily-notes:progress', msg);
    });
  });

  handle('daily-notes:get-log', () => {
    const { loadNotesLog } = require('../../src/scrapers/daily_notes');
    return loadNotesLog();
  });

  logger.info('AI IPC handlers registered');
}

module.exports = { registerAIHandlers };
