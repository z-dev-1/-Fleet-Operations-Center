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
const GEOFENCE_IPC_TIMEOUT = 200_000; // Stage 5 C-1: IPC belt -- scraper has own 60s timeout

// ── Re-entrancy locks (Issue #9) ──────────────────────────────────────────
// Module-level: survive across IPC calls within the same process lifetime.
let _wrLock       = false;   // aap:create-wr
let _adaptiveLock = false;   // aap:adaptive
let _activeAutofillWin = null; // aap:autofill -- lets aap:autofill-stop force-close it
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
    const result = await scrapeGeofences(log);
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
  // BUG FIX (2026-07-16): this handler previously resolved the
  // ipcRenderer.invoke('aap:autofill', ...) call as soon as the
  // BrowserWindow was CREATED -- `return { ok: true };` ran immediately,
  // completely independent of whether the did-finish-load listener ever
  // fired, whether the injected script found the right page, or whether
  // CreateWRAutofill.run() actually succeeded. The renderer
  // (_autofillFallback in wr-modal.js) just showed a static 'Opening AAP
  // in autofill mode...' toast and moved on -- there was NO possible way
  // for the user to ever learn whether autofill worked. This is the
  // confirmed root cause of "I click Open in AAP (autofill) and it does
  // nothing but open the link."
  //
  // Also fixed, both confirmed via a working equivalent pattern already
  // in src/scrapers/setLifecycle.js:
  //   1. No domain guard: did-finish-load fires on EVERY navigation
  //      completion in that window, including an intermediate Midway/SSO
  //      auth redirect page BEFORE the real AAP page loads. Injecting on
  //      that intermediate page wastes the engine's entire ~10s
  //      equipment-combobox wait budget on a page that will never have
  //      one, then AAP finishes redirecting to the real page and NOTHING
  //      re-triggers the fill.
  //   2. No 'already handled' guard: since did-finish-load is a
  //      persistent listener (not a one-shot), every subsequent
  //      navigation in that window (including ones after the injected
  //      script already ran) would inject and run the ENTIRE autofill
  //      sequence again.
  //
  // Now: waits for the URL to actually be on aap-na.corp.amazon.com
  // before injecting, injects at most once via a `settled` guard, and
  // resolves the invoke() promise with the REAL result returned by
  // CreateWRAutofill.run() (see aap_autofill_engine.js -- run() now
  // returns a real {ok, message} object at every exit point instead of
  // nothing) so the renderer can show accurate success/failure feedback.
  handle('aap:autofill', async (_e, url, payload) => {
    requireString(url, 'url');
    if (!fs.existsSync(ENGINE_FILE)) {
      throw new ScraperError('Autofill engine not found: ' + ENGINE_FILE, 'aap:autofill');
    }
    return new Promise((resolve) => {
      let settled = false;
      const aapWin = new BrowserWindow({
        width: 1200, height: 850, title: 'AAP - Create Work Request',
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      // Workflow Intelligence: attach capture if a recording is currently
      // active (same gate + technique as open-popup in ipc/orcha.js).
      // Observation-only -- never interferes with the autofill engine below.
      try {
        const { getActiveSessionId } = require('./workflow-intel');
        const activeSession = getActiveSessionId();
        if (activeSession) {
          const { attachCapture } = require('../window/action_capture');
          attachCapture(aapWin, activeSession);
        }
      } catch (e) {
        logger.warn('Workflow Intelligence capture attach failed:', e.message);
      }
      _activeAutofillWin = aapWin;
      // FIX (2026-07-23): AAP's WR wizard form has an unsaved-changes guard.
      // Without this, clicking the native close button (or the new Stop
      // button below) while mid-form can trigger a native "Leave Site?"
      // confirm dialog that renders behind/off the visible window -- making
      // close look like it silently does nothing. This is a user-initiated
      // abort of an in-progress automation, not real data at risk, so
      // always let the close through immediately.
      aapWin.webContents.on('will-prevent-unload', (event) => { event.preventDefault(); });

      // DEBUG (2026-07-23): pipe the in-page engine's this.log() calls
      // (console.log inside the injected script) into our persistent log
      // file. Previously these only went to the hidden aapWin's devtools
      // console, so diagnosing step-by-step failures (e.g. tire subcategory
      // fields not filling) required someone to have devtools open live.
      aapWin.webContents.on('console-message', (_event, _level, message) => {
        logger.info('[aap-autofill-engine] ' + message);
      });

      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(maxTimer);
        if (_activeAutofillWin === aapWin) _activeAutofillWin = null;
        resolve(result);
      };
      const maxTimer = setTimeout(() => {
        logger.warn('Autofill timed out after 90s');
        done({ ok: false, message: 'Autofill timed out after 90 seconds -- AAP page may not have loaded, or the wizard reached an unexpected step.' });
      }, 90000);
      aapWin.loadURL(url);
      aapWin.webContents.on('did-finish-load', async () => {
        if (settled) return;
        const curUrl = aapWin.isDestroyed() ? '' : aapWin.webContents.getURL();
        if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) {
          logger.info('[aap:autofill] Not on AAP yet (auth redirect?) -- waiting for next load...');
          return; // will fire again once the redirect chain settles
        }
        try {
          const engineCode  = fs.readFileSync(ENGINE_FILE, 'utf8');
          const payloadJson = JSON.stringify(payload || {});
          const injectable  = [
            '(async function() {',
            '  window.__fleetAutofillPayload = ' + payloadJson + ';',
            '  ' + engineCode,
            '  if (typeof CreateWRAutofill === \'undefined\' || !CreateWRAutofill.shouldRun || !CreateWRAutofill.shouldRun()) {',
            '    return { ok: false, message: \'Autofill engine did not detect a valid unit in the payload.\' };',
            '  }',
            '  try {',
            '    const r = await CreateWRAutofill.run();',
            '    return (r && typeof r === \'object\') ? r : { ok: true, message: \'Autofill completed.\' };',
            '  } catch (runErr) {',
            '    return { ok: false, message: \'Autofill script error: \' + runErr.message };',
            '  }',
            '})();',
          ].join('\n');
          const result = await aapWin.webContents.executeJavaScript(injectable);
          done(result && typeof result === 'object' ? result : { ok: true, message: 'Autofill completed.' });
        } catch (e) {
          logger.error('Autofill engine load error:', e.message);
          done({ ok: false, message: 'Autofill inject error: ' + e.message });
        }
      });
      aapWin.on('closed', () => {
        done({ ok: false, message: 'AAP window was closed before autofill finished.' });
      });
    });
  });

  // FEATURE (2026-07-23): explicit Stop control for the autofill popup --
  // requested after confirming the native close button can get stuck behind
  // AAP's own "Leave Site?" dialog (see will-prevent-unload fix above). This
  // gives a guaranteed way to abort mid-run regardless of that. Destroying
  // the window fires the 'closed' handler above, which resolves the
  // in-flight aap:autofill promise with a clean, honest failure result.
  handle('aap:autofill-stop', async () => {
    if (_activeAutofillWin && !_activeAutofillWin.isDestroyed()) {
      _activeAutofillWin.destroy();
      return { ok: true };
    }
    return { ok: false, message: 'No autofill window is currently open.' };
  });

  // ── aap:set-lifecycle ───────────────────────────────────────────────────
  // Issue #17: rethrow as ScraperError so safeIPC logs it uniformly
  handle('aap:set-lifecycle', async (_e, { equipmentId, assetUrl, state, reason }) => {
    requireString(equipmentId, 'equipmentId');
    requireString(assetUrl, 'assetUrl');
    requireString(state, 'state');
    const { setLifecycleState } = require('../scrapers/setLifecycle');
    try {
      return await setLifecycleState({ equipmentId, assetUrl, state, reason: reason || '' });
    } catch (e) {
      throw new ScraperError(e.message, 'aap:set-lifecycle', { equipmentId, state });
    }
  });

  // ── aap:create-wr ───────────────────────────────────────────────────────
  // Issue #9: re-entrancy lock prevents duplicate WR submissions
  // FIX (2026-07-23): commit 3c9dcf2 (an ad-hoc "backup working-tree state"
  // commit, not a deliberate feature change) accidentally swapped this
  // handler from the deterministic aap_create_wr.js direct-API flow over to
  // the AI-driven runAdaptiveWR() agent -- the same agent the OTHER button
  // ("Open in AAP (autofill)") uses. That is why Submit WR started needing
  // AI-generated wizard steps and falling back to "fill it in yourself" when
  // the AI response did not parse. Confirmed with Z: Submit WR is supposed to
  // run without AI at all, via the direct 3-step AAP API flow (createRepair ->
  // createDriverConnection -> updateWorkRequest). Reverted to that.
  handle("aap:create-wr", async (_e, payload, unit) => {
    if (_wrLock) {
      throw new ScraperError("aap:create-wr operation already in progress", "aap:create-wr");
    }
    requireObject(payload, "payload");
    _wrLock = true;
    try {
      const { createWorkRequest } = require("../scrapers/aap_create_wr");
      const log = (msg) => {
        logger.info(msg);
        try {
          const wins = require("electron").BrowserWindow.getAllWindows();
          const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes("localhost:5173"));
          if (main) main.webContents.send("wr:progress", { message: msg });
        } catch(e) {}
      };
      const result = await createWorkRequest(payload, unit, log);
      return result;
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
  // vendor:portal-urls -- expose VENDOR_PORTAL_URLS to renderer (for non-Decisiv vendors)
  handle('vendor:portal-urls', () => {
    const { VENDOR_PORTAL_URLS } = require('../../src/scrapers/aap_create_wr');
    return VENDOR_PORTAL_URLS;
  });


  // ── wo:scrape ─────────────────────────────────────────────────────────
  // Scrapes AAP Work Order detail for a single unit via aap_wo_scraper.js
  // Payload: { equipmentId, serviceUrl } — serviceUrl optional (resolved internally)
  let _woLock = false;
  handle('wo:scrape', async (_e, payload) => {
    if (_woLock) {
      throw new ScraperError('wo:scrape operation already in progress', 'wo:scrape');
    }
    requireObject(payload, 'payload');
    requireString(payload.equipmentId, 'payload.equipmentId');
    _woLock = true;
    try {
      const { scrapeWorkOrder } = require('../../src/scrapers/aap_wo_scraper');
      const logs = [];
      const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('wo:progress', msg); };
      const woOpts = {};
      if (payload.serviceUrl) woOpts.serviceUrl = payload.serviceUrl;
      const result = await scrapeWorkOrder(payload.equipmentId, woOpts);
      return { ok: true, result, logs };
    } catch(e) {
      throw new ScraperError(e.message, 'wo:scrape', { equipmentId: payload.equipmentId });
    } finally {
      _woLock = false;
    }
  });
  // ── S28: relay:get-cache + relay:get-unit-cache ──────────────────────────────
  // Wiring fix: exposes stored relay cache to the renderer so unit-detail can
  // display work order cards without needing a live scrape.
  handle('relay:get-cache', () => {
    const store = require('../store');
    return store.load('relayCache', {});
  });

  handle('relay:get-unit-cache', (_e, equipmentId) => {
    const store = require('../store');
    const cache = store.load('relayCache', {});
    return cache[equipmentId] || { workOrders: [] };
  });

  logger.info('Scrapers IPC handlers registered');
}

module.exports = { registerScrapersIPC };
