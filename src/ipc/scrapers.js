'use strict';
/**
 * ipc/scrapers.js - Geofence, adaptive scraper, AAP agent/autofill IPC handlers
 * Channels: geofence:scrape, geofence:get-cache, adaptive:extract,
 * adaptive:scan-batch, aap:adaptive, aap:autofill, aap:set-lifecycle, aap:create-wr
 *
 * V-C: mainWindow refs go through ctx.sendToWindow. ROOT_DIR is __dirname based.
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #2: aap:autofill enginePath pinned to scrapers/ directory
 *   - Issue #3: adaptive:scan-batch capped at MAX_SCAN_BATCH units
 *   - Issue #9: aap:create-wr + aap:adaptive module-level re-entrancy locks
 *   - Issue #10: adaptive:extract BrowserWindow always closed via try/finally
 *   - Issue #17: aap:set-lifecycle uses ScraperError + safeIPC wrapper
 *   - All handlers migrated to handle() wrapper
 *
 * Stage 5 Step 2 hardening (2026-06-28):
 *   - H-3: uptake:scrape + relay:scrape IPC handlers with concurrency locks
 */

const { BrowserWindow, session: eSession } = require('electron');
const p      = require('path');
const fs     = require('fs');
const logger = require('../utils/logger')('ipc:scrapers');
const { handle, timeoutAfter, requireString, requireObject, requireArrayMax } = require('./_safe');
const { ScraperError, ConfigError } = require('../utils/errors');

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_SCAN_BATCH = 50;   // Issue #3: cap unbounded BrowserWindow spawning
const GEOFENCE_IPC_TIMEOUT = 90_000; // Stage 5 C-1: IPC belt -- scraper has own 60s timeout

// ── Re-entrancy locks (Issue #9) ──────────────────────────────────────────
// Module-level: survive across IPC calls within the same process lifetime.
let _wrLock       = false;   // aap:create-wr
let _adaptiveLock = false;   // aap:adaptive
let _uptakeLock   = false;   // H-3: uptake:scrape
let _relayLock    = false;   // H-3: relay:scrape

function registerScrapersIPC(ctx) {
  const send     = ctx.sendToWindow;
  // Issue #2: ROOT_DIR is the resolved scrapers directory — used as path allowlist root
  const ROOT_DIR      = p.join(__dirname, '../..');
  const SCRAPERS_DIR  = p.resolve(p.join(ROOT_DIR, 'src', 'scrapers'));
  const ENGINE_FILE   = p.join(SCRAPERS_DIR, 'aap_autofill_engine.js');

  // ── geofence:scrape ─────────────────────────────────────────────────────
  handle('geofence:scrape', async () => {
    const { scrapeGeofences } = require('../../src/scrapers/geofence_scraper');
    const logs = [];
    const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('scan:progress', msg); };
    // Stage 5 C-1: race the scraper's own 60s timeout with a 90s IPC-level cap
    const result = await Promise.race([
      scrapeGeofences(log),
      new Promise(r => setTimeout(
        () => r({ ok: false, error: 'IPC timeout', errorCode: 'IPC_TIMEOUT' }),
        GEOFENCE_IPC_TIMEOUT
      )),
    ]);
    return { ...result, logs };
  });

  // ── geofence:get-cache ──────────────────────────────────────────────────
  handle('geofence:get-cache', () => {
    const { loadGeofenceCache } = require('../../src/scrapers/geofence_scraper');
    return loadGeofenceCache();
  });

  // ── adaptive:extract ────────────────────────────────────────────────────
  // Issue #10: try/finally guarantees window is always closed
  handle('adaptive:extract', async (_e, opts) => {
    requireObject(opts, 'opts');
    const { adaptiveExtract } = require('../../src/scrapers/adaptive_scraper');
    const { askOrcha }        = require('../../src/scrapers/orcha_ws');
    const { pageType, unitId, url } = opts;
    requireString(url, 'opts.url');
    const logs = [];
    const log  = (msg) => { logs.push(msg); logger.info(msg); };
    const win  = new BrowserWindow({
      width: 1200, height: 800, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: eSession.defaultSession },
    });
    try {
      await win.loadURL(url);
      await new Promise(r => setTimeout(r, 4000));
      const data = await adaptiveExtract(win, pageType, unitId, askOrcha, log);
      return { ok: true, data, logs };
    } finally {
      // Always fires — success, throw, or timeout
      if (!win.isDestroyed()) win.close();
    }
  });

  // ── adaptive:scan-batch ─────────────────────────────────────────────────
  // Issue #3: hard cap on batch size
  handle('adaptive:scan-batch', async (_e, units) => {
    requireArrayMax(units, 'units', MAX_SCAN_BATCH);
    const { adaptiveExtract } = require('../../src/scrapers/adaptive_scraper');
    const { askOrcha }        = require('../../src/scrapers/orcha_ws');
    const ses     = eSession.defaultSession;
    const results = [];
    const log     = (msg) => { logger.info(msg); if (send) send('scan:progress', msg); };
    log('[AdaptiveScan] Starting batch for ' + units.length + ' units...');
    for (let i = 0; i < units.length; i++) {
      const u   = units[i];
      const url = u.serviceUrl || '';
      if (!url) { results.push({ unitId: u.id, ok: false, error: 'No service URL' }); continue; }
      log('[AdaptiveScan] (' + (i + 1) + '/' + units.length + ') ' + u.id + '...');
      const win = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
      });
      try {
        await win.loadURL(url);
        await new Promise(r => setTimeout(r, 3500));
        const data = await adaptiveExtract(win, 'relay', u.id, askOrcha, log);
        if (data && data._error === 'wrong_page')  results.push({ unitId: u.id, ok: false, error: 'wrong_page', wrongUnit: data._wrongUnit });
        else if (data && data._mismatch)            results.push({ unitId: u.id, ok: true, data, warning: 'mismatch' });
        else if (data)                              results.push({ unitId: u.id, ok: true, data });
        else                                        results.push({ unitId: u.id, ok: false, error: 'Extraction returned null' });
      } catch (e) {
        results.push({ unitId: u.id, ok: false, error: e.message });
      } finally {
        if (!win.isDestroyed()) win.close();
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    log('[AdaptiveScan] Complete. ' + results.filter(r => r.ok).length + '/' + units.length + ' successful.');
    return results;
  });

  // ── aap:adaptive ────────────────────────────────────────────────────────
  // Issue #9: re-entrancy lock prevents duplicate adaptive submissions
  handle('aap:adaptive', async (_e, payload) => {
    if (_adaptiveLock) {
      throw new ScraperError('aap:adaptive operation already in progress', 'aap:adaptive');
    }
    requireObject(payload, 'payload');
    _adaptiveLock = true;
    try {
      const { runAdaptiveWR } = require('../../src/scrapers/aap_adaptive_agent');
      const { askOrcha }      = require('../../src/scrapers/orcha_ws');
      const logs = [];
      const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('wr:progress', msg); };
      const result = await runAdaptiveWR(payload, askOrcha, log);
      return { ...result, logs };
    } finally {
      _adaptiveLock = false;
    }
  });

  // ── aap:autofill ────────────────────────────────────────────────────────
  // Issue #2: enginePath pinned — renderer cannot supply an arbitrary file path
  handle('aap:autofill', async (_e, url, payload) => {
    requireString(url, 'url');
    // Resolve and pin: enginePath must equal the pre-computed ENGINE_FILE constant.
    // We do NOT use the renderer-supplied path; we always use our own.
    if (!fs.existsSync(ENGINE_FILE)) {
      throw new ScraperError('Autofill engine not found: ' + ENGINE_FILE, 'aap:autofill');
    }
    const aapWin = new BrowserWindow({
      width: 1200, height: 850, title: 'AAP - Create Work Request',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    aapWin.loadURL(url);
    aapWin.webContents.on('did-finish-load', () => {
      try {
        const engineCode  = fs.readFileSync(ENGINE_FILE, 'utf8');
        const payloadJson = JSON.stringify(payload || {});
        const injectable  = [
          '(async function() {',
          '  window.__fleetAutofillPayload = ' + payloadJson + ';',
          '  ' + engineCode,
          '  if (typeof CreateWRAutofill !== \'undefined\' && CreateWRAutofill.shouldRun && CreateWRAutofill.shouldRun()) {',
          '    await CreateWRAutofill.run();',
          '  }',
          '})();',
        ].join('\n');
        aapWin.webContents.executeJavaScript(injectable)
          .catch(err => logger.warn('Autofill inject error:', err.message));
      } catch (e) {
        logger.error('Autofill engine load error:', e.message);
      }
    });
    return { ok: true };
  });

  // ── aap:set-lifecycle ───────────────────────────────────────────────────
  // Issue #17: rethrow as ScraperError so safeIPC logs it uniformly
  handle('aap:set-lifecycle', async (_e, { equipmentId, assetUrl, state, reason }) => {
    requireString(equipmentId, 'equipmentId');
    requireString(assetUrl, 'assetUrl');
    requireString(state, 'state');
    const { setLifecycleState } = require('../../src/scrapers/aap_lifecycle');
    try {
      return await setLifecycleState({ equipmentId, assetUrl, state, reason: reason || '' });
    } catch (e) {
      throw new ScraperError(e.message, 'aap:set-lifecycle', { equipmentId, state });
    }
  });

  // ── aap:create-wr ───────────────────────────────────────────────────────
  // Issue #9: re-entrancy lock prevents duplicate WR submissions
  handle('aap:create-wr', async (_e, payload, unit) => {
    if (_wrLock) {
      throw new ScraperError('aap:create-wr operation already in progress', 'aap:create-wr');
    }
    requireObject(payload, 'payload');
    _wrLock = true;
    try {
      const { createWorkRequest } = require('../../src/scrapers/aap_create_wr');
      const logs = [];
      const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('wr:progress', msg); };
      const result = await createWorkRequest(payload, unit, log);
      return { ...result, logs };
    } finally {
      _wrLock = false;
    }
  });


  // ── uptake:scrape ────────────────────────────────────────────────────────
  // H-3: IPC-level concurrency guard mirrors the scraper's own _uptakeLock.
  // Two checks in series: the IPC lock fires first (synchronous), then the
  // scraper lock fires if a non-IPC caller (e.g. sync/index.js) has already
  // acquired the scraper-level lock. Both return the same error shape.
  handle('uptake:scrape', async () => {
    if (_uptakeLock) {
      throw new ScraperError('uptake:scrape operation already in progress', 'uptake:scrape');
    }
    _uptakeLock = true;
    try {
      const { scrapeUptake } = require('../../src/scrapers/uptake');
      const result = await scrapeUptake();
      return result;
    } finally {
      _uptakeLock = false;
    }
  });

  // ── relay:scrape ─────────────────────────────────────────────────────────
  // H-3: IPC-level concurrency guard mirrors the scraper's own _relayLock.
  // aapRows + relayCache pulled from store — callers do not need to supply them.
  handle('relay:scrape', async () => {
    if (_relayLock) {
      throw new ScraperError('relay:scrape operation already in progress', 'relay:scrape');
    }
    _relayLock = true;
    try {
      const { scrapeRelay } = require('../../src/scrapers/relay');
      const store           = require('../store');
      const relayCache      = store.load('relayCache', {});
      const aapCache        = store.load('aapCache',   { rows: [] });
      const aapRows         = aapCache.rows || [];
      const logs            = [];
      const onBatch = (batch) => { if (send) send('relay:progress', batch); };
      const result  = await scrapeRelay(aapRows, onBatch, relayCache);
      if (result && result.updatedCache) {
        store.save('relayCache', result.updatedCache);
      }
      return result;
    } finally {
      _relayLock = false;
    }
  });
  logger.info('Scrapers IPC handlers registered');
}

module.exports = { registerScrapersIPC };
