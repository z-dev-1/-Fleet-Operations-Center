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
let _wrApiLock    = false;   // aap:create-wr-api (VRE recommendation WO create)
let _wrAttachLock = false;   // aap:attach-to-wr (add documents to an open WR)
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
      // autoSubmit defaults to FALSE — the agent fills the wizard reading the
      // live page each step and stops at Review; it only submits if the
      // payload explicitly sets autoSubmit:true.
      const result = await runAdaptiveWR(payload, askOrcha, log, { autoSubmit: payload.autoSubmit === true });
      return { ...result, logs };
    } finally {
      _adaptiveLock = false;
    }
  });

  // ── aap:create-wr-api ─────────────────────────────────────────────────────
  // API-based WO creation via the VRE recommendation endpoint (replaces the
  // "Submit WR" button's old adaptive-agent path). Two-phase:
  //   confirmVendor !== true  → Phase 1: returns a vendor recommendation.
  //   confirmVendor === true  → Phase 2: commits the WO with the chosen vendor.
  // The "Open in AAP (autofill)" backup button (aap:autofill) is untouched.
  handle('aap:create-wr-api', async (_e, payload) => {
    if (_wrApiLock) {
      throw new ScraperError('aap:create-wr-api operation already in progress', 'aap:create-wr-api');
    }
    requireObject(payload, 'payload');
    _wrApiLock = true;
    try {
      const aapApi = require('../../src/scrapers/aap_api');
      const logs = [];
      const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('wr:progress', msg); };
      log(payload.confirmVendor
        ? 'Creating work order in AAP (committing with vendor ' + (payload.vendor || '—') + ')…'
        : 'Asking AAP for a vendor recommendation…');
      const result = await aapApi.createWorkOrder(payload);
      if (result && result.phase === 'recommend') {
        log('AAP recommended vendor: ' + (result.recommendation.vendor || '(none)') +
            (result.recommendation.ruleName ? ' [' + result.recommendation.ruleName + ']' : ''));
      } else if (result && result.phase === 'commit') {
        log('Work order created' + (result.workRequestId ? ': ' + result.workRequestId : ''));
      }
      return { ...result, logs };
    } finally {
      _wrApiLock = false;
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

      _activeAutofillWin = aapWin;

      // ── WR-CREATE NETWORK CAPTURE (observe-only; env-gated AAP_WR_CAPTURE=1)
      // Attaches the Chrome DevTools Protocol network domain to THIS autofill
      // window and records every POST/PUT/PATCH (url + request body + response),
      // flagging the call whose response carries a workRequestId/serviceId —
      // i.e. the real WR-create endpoint. Changes NOTHING about the autofill;
      // it only watches the network so we can wire the API submit path.
      // Captures are appended to logs/aap_wr_capture.json.
      if (String(process.env.AAP_WR_CAPTURE || '').trim() === '1') {
        try {
          const dbg = aapWin.webContents.debugger;
          dbg.attach('1.3');
          const reqs = new Map(); // requestId -> { url, method, body }
          const _isAap = (u) => /aap-na\.corp\.amazon\.com|towtruck|assetlifecycle|serviceaggregate|\bvre\b|work.?request|repair/i.test(String(u || ''));
          dbg.on('message', async (_e, method, params) => {
            try {
              if (method === 'Network.requestWillBeSent') {
                const r = params.request || {};
                if (r.method && r.method !== 'GET' && _isAap(r.url)) {
                  reqs.set(params.requestId, { url: r.url, method: r.method, body: (r.postData || '').slice(0, 20000) });
                }
              } else if (method === 'Network.responseReceived') {
                const info = reqs.get(params.requestId);
                if (info) info.status = params.response && params.response.status;
              } else if (method === 'Network.loadingFinished') {
                const info = reqs.get(params.requestId);
                if (!info) return;
                let bodyText = '';
                try { const b = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }); bodyText = (b && b.body) ? String(b.body).slice(0, 20000) : ''; } catch (_) {}
                const createdWR = /"(workRequestId|serviceId|workOrderId)"\s*:\s*"[^"]+"/i.test(bodyText);
                const rec = { at: new Date().toISOString(), url: info.url, method: info.method, status: info.status, requestBody: info.body, responseBody: bodyText, createdWR };
                try {
                  const _logsDir = require('../config/paths').P.logsDir;
                  const capFile = p.join(_logsDir, 'aap_wr_capture.json');
                  let arr = []; try { arr = JSON.parse(fs.readFileSync(capFile, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (_) {}
                  arr.push(rec); fs.writeFileSync(capFile, JSON.stringify(arr, null, 2));
                } catch (_) {}
                logger.info('[aap-wr-capture] ' + (createdWR ? '★ WR-CREATE ' : '') + rec.method + ' ' + rec.url + ' -> ' + rec.status);
                reqs.delete(params.requestId);
              }
            } catch (_) { /* observer must never affect the autofill */ }
          });
          dbg.sendCommand('Network.enable').catch(() => {});
          logger.info('[aap-wr-capture] attached to autofill window — create the WR and click Submit; captures -> logs/aap_wr_capture.json');
        } catch (e) { logger.warn('[aap-wr-capture] attach failed (non-fatal): ' + e.message); }
      }

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
      // Guard so the engine is injected+run EXACTLY ONCE. The AAP wizard is a
      // SPA; stepping through it (or an in-page section mount) can fire
      // did-finish-load AGAIN while run() is still in progress. Without this
      // guard that second event re-injected the engine and restarted it from
      // STEP 1 -- an infinite loop that looked like "stuck", and left later
      // area rows unfilled. 'settled' only flips after run() RETURNS, so it
      // can't prevent a mid-run re-entry; this dedicated flag can.
      let injected = false;
      aapWin.loadURL(url);
      aapWin.webContents.on('did-finish-load', async () => {
        if (settled || injected) return;
        const curUrl = aapWin.isDestroyed() ? '' : aapWin.webContents.getURL();
        if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) {
          logger.info('[aap:autofill] Not on AAP yet (auth redirect?) -- waiting for next load...');
          return; // will fire again once the redirect chain settles
        }
        injected = true; // from here on, ignore any further did-finish-load events
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
    // PREFERRED PATH (gated by fasConfig.useLifecycleApi, OFF by default): the
    // AAP JSON API — version-locked PUT + source read-back, and auto-clears a
    // blocking DVIR when going ACTIVE. Falls back to the proven browser
    // automation on any failure or when the flag is off. The manual detail-page
    // button and the AI MOVE_UNIT path now share the same API path.
    let useApi = false;
    try { useApi = require('../orcha/fas/config').get().useLifecycleApi === true; } catch (_) { useApi = false; }
    if (useApi) {
      try {
        const api = require('../scrapers/aap_lifecycle_api');
        const wantActive = String(state).trim().toUpperCase() === 'ACTIVE';
        const r = wantActive
          ? await api.setLifecycleActiveWithDvir({ unit: equipmentId, assetUrl, reason: reason || 'HEALTHY' })
          : await api.setLifecycleApi({ unit: equipmentId, assetUrl, state, reason: reason || '' });
        // Explicit, durable write-back line so the result is unambiguous in the
        // log (and the UI toast via `message`): VERIFIED / UNCERTAIN / etc.
        try {
          const L = require('../utils/logger').createLogger('ipc:scrapers');
          L.info('[LIFECYCLE-RESULT] ' + equipmentId + ' -> ' + String(state).toUpperCase() +
            ' : ' + String((r && r.status) || 'unknown').toUpperCase() +
            (r && r.verified ? ' (VERIFIED' + (r.version ? ' v' + r.version : '') + ', via api)' : '') +
            (r && r.dvirCleared && r.dvirCleared.length ? ' [DVIR cleared: ' + r.dvirCleared.length + ']' : ''));
        } catch (_) {}
        // Map to the UI's { success, message } contract.
        if (r && (r.status === 'done' || r.status === 'noop') && r.verified) {
          return { success: true, via: 'api', verifiedState: r.to && r.to.state, newState: r.to && r.to.state, version: r.version,
            message: r.status === 'noop' ? (equipmentId + ' is already ' + (r.to && r.to.state) + ' \u2014 verified, no change') : (equipmentId + ' set to ' + (r.to && r.to.state) + ' \u2014 VERIFIED' + (r.version ? ' (v' + r.version + ')' : '')),
            dvirCleared: r.dvirCleared };
        }
        if (r && r.status === 'execution_uncertain') {
          return { success: false, via: 'api', uncertain: true, message: 'EXECUTION_UNCERTAIN: the change may have applied but could not be verified — re-check before relying on it.' };
        }
        if (r && r.needsWorkOrder) {
          return { success: false, via: 'api', needsWorkOrder: true, message: 'Open DVIR must be cleared but no open work request was found to reference — supply a WR number.' };
        }
        // API failed -> fall through to the browser-automation fallback.
        try { require('../utils/logger').createLogger('ipc:scrapers').warn('[aap:set-lifecycle] API path failed (' + (r && (r.error || r.status)) + '); falling back to browser automation'); } catch (_) {}
      } catch (e) {
        try { require('../utils/logger').createLogger('ipc:scrapers').warn('[aap:set-lifecycle] API path threw (' + e.message + '); falling back'); } catch (_) {}
      }
    }
    // FALLBACK: proven BrowserWindow automation. The UI now sends the AAP
    // reason CODE (e.g. OFFSITE_SHOP_REPAIR) for the API path; the browser
    // automation matches by the dropdown's VISIBLE text, so translate code ->
    // friendly label here. Unknown/plain values pass through unchanged.
    const _REASON_FRIENDLY = {
      HEALTHY: 'Healthy',
      OFFSITE_SHOP_REPAIR: 'Off-site storage',
      PM_FAILED: 'PM Failed',
      PREVENTATIVE_MAINTENANCE: 'Preventative Maintenance',
      PARTS_DELAY: 'Parts Delay',
      DAMAGED_MODERATE: 'Damaged-Moderate',
      SENSOR_DETECTED_DAMAGE: 'Sensor Detected Damage',
      SAFETY_INSPECTION_POST_ACCIDENT: 'Safety Inspection Post Accident',
      LICENSE_OR_PERMIT_ISSUE: 'License or Permit Issue',
      IMPOUNDED_TOW: 'Impounded/Tow',
      GPS_MALFUNCTIONING: 'GPS Malfunctioning',
      CAMPAIGN: 'Campaign',
    };
    const fallbackReason = _REASON_FRIENDLY[String(reason || '').trim().toUpperCase()] || reason || '';
    const { setLifecycleState } = require('../scrapers/setLifecycle');
    try {
      return await setLifecycleState({ equipmentId, assetUrl, state, reason: fallbackReason });
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
      const log = (msg) => {
        logger.info(typeof msg === 'string' ? msg : JSON.stringify(msg));
        try {
          const wins = require("electron").BrowserWindow.getAllWindows();
          const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes("localhost:5173"));
          if (main) main.webContents.send("wr:progress", { message: (typeof msg === 'string' ? msg : JSON.stringify(msg)) });
        } catch(e) {}
      };

      // ROUTE THROUGH THE HARDENED API PATH (2026-10-19). The old
      // aap_create_wr.createWorkRequest uses a browser ses.fetch to /createRepair
      // that returns HTTP 403 (auth) — confirmed live on the TOW submit. The
      // aap_api.createWorkOrder path runs inside the authenticated AAP page with
      // the captured a2z token (works), AND adds vendor resolution + self-healing
      // + business-error messages. Unify every WR (repair AND tow) on it.
      const aapApi = require("../../src/scrapers/aap_api");

      // Map the modal/tow payload into createWorkOrder opts.
      const opts = {
        assetUrl: (unit && unit.assetUrl) || '',
        aaid: (unit && unit.aaid) || undefined,
        title: payload.title,
        issue: payload.issue,
        comments: payload.comments,
        shareWith: payload.shareWith,
        areaPairs: payload.areaPairs || [],
        urgent: payload.urgent,
        urgencyReason: payload.urgencyReason,
        arcClaim: payload.arcClaim,
        simNumber: payload.simNumber,
        vendor: payload.vendor,
        contactName: payload.contactName,
        contactPhone: payload.contactPhone,
        attachments: (payload.attachments || []).map((d, i) => (typeof d === 'string' ? { name: 'attachment-' + (i + 1), dataUrl: d } : d)),
        domicile: (unit && (unit.site || unit.domicileSite)) || payload.domicile || '',
        copiedFromWorkRequestId: payload.copiedFromWorkRequestId || null,
        // TOW: pass the DESTINATION (where the unit is going) + direction so the
        // create body can set AAP's separate `destination` field + transloading
        // flag (AAP stores tow pickup in reportedLocation and the target in a
        // distinct `destination` object — confirmed from a hand-made ref WR).
        towDirection: payload.towDirection || '',
        towToStreet: payload.towStreet || '', towToCity: payload.towCity || '',
        towToState: payload.towState || '', towToZip: payload.towZip || '',
        confirmVendor: true, // modal auto-submits → commit directly
      };

      // TOW LOCATION: for a return-to-yard / yard-to-yard tow the unit is NOT at
      // its home yard — it's at the tow PICKUP (the dealer). Tell createWorkOrder
      // via its off-site address fields so currentLocation reflects where the
      // unit actually is. For a to-dealer tow the unit is still at the home yard,
      // so leave the GPS/domicile location as-is.
      const dir = String(payload.towDirection || '').toLowerCase();
      // DIAGNOSTIC: log exactly what pickup/destination/offSite arrived, so a
      // swapped pickup/destination is unambiguous in the log.
      log('[create-wr] tow fields: dir=' + (dir || 'none') +
        ' | pickup(towFrom)=' + [payload.towFromStreet, payload.towFromCity, payload.towFromState, payload.towFromZip].filter(Boolean).join(', ') +
        ' | destination(tow)=' + [payload.towStreet, payload.towCity, payload.towState, payload.towZip].filter(Boolean).join(', ') +
        ' | offSite=' + payload.offSite + ' loc=' + [payload.locStreet, payload.locCity, payload.locState, payload.locZip].filter(Boolean).join(', '));
      if (dir === 'return-to-yard' || dir === 'yard-to-yard') {
        const pickup = [payload.towFromStreet, payload.towFromCity, payload.towFromState, payload.towFromZip].map(s => String(s || '').trim());
        if (pickup.some(Boolean)) {
          opts.offSite = true;
          opts.locStreet = payload.towFromStreet || '';
          opts.locCity   = payload.towFromCity   || '';
          opts.locState  = payload.towFromState  || '';
          opts.locZip    = payload.towFromZip    || '';
          log('[create-wr] tow direction "' + dir + '" — unit is at pickup, using off-site location: ' + pickup.filter(Boolean).join(', '));
        }
      }

      const result = await aapApi.createWorkOrder(opts);
      // Normalize to the shape the modal expects ({ ok, workRequestId, error }).
      if (result && result.phase === 'commit' && result.workRequestId) {
        log('Work order created: ' + result.workRequestId);
        return { ok: true, workRequestId: result.workRequestId, vendor: result.vendor, raw: result };
      }
      return { ok: false, error: (result && result.error) || 'WR not created', aapMessage: result && result.aapMessage, businessRule: result && result.businessRule, raw: result };
    } finally {
      _wrLock = false;
    }
  });


  // ── aap:attach-to-wr ────────────────────────────────────────────────────
  // Add documents (PNG/JPEG/PDF) to an EXISTING open work request. Same upload
  // the create flow uses after a new WR. Re-entrancy locked so a double click
  // can't upload the same files twice.
  handle('aap:attach-to-wr', async (_e, req) => {
    if (_wrAttachLock) {
      throw new ScraperError('aap:attach-to-wr operation already in progress', 'aap:attach-to-wr');
    }
    requireObject(req, 'req');
    _wrAttachLock = true;
    try {
      const { attachToOpenWr } = require('../scrapers/wr_attach');
      const r = await attachToOpenWr(req);
      logger.info('[attach-to-wr] WR ' + (r.workRequestId || '?') + ': ' +
        (r.ok ? 'all ' + r.results.length + ' uploaded' : (r.partial ? 'partial' : 'failed')) +
        (r.error ? ' (' + r.error + ')' : ''));
      return r;
    } finally {
      _wrAttachLock = false;
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
      const logs = [];
      const log  = (msg) => { logs.push(msg); logger.info(msg); if (send) send('wo:progress', msg); };

      // API-FIRST: the serviceaggregate JSON carries all core WO-detail fields
      // (vendor, state, urgency, issue, L1/L2/L3, altId, vendor WO, offsite URL,
      // full conversation). Instant + robust vs. the 3-phase DOM scrape. Fall
      // back to the browser scraper only if the API path errors or finds no WO
      // (e.g. vendor-PDF doc-scan vendors that need the Documents tab).
      try {
        const api = require('../../src/scrapers/aap_api');
        if (typeof api.getWorkOrderDetailViaApi === 'function') {
          const apiResult = await api.getWorkOrderDetailViaApi(payload.equipmentId);
          if (apiResult && !apiResult.error && !apiResult.noWO) {
            log('[wo:scrape] API-first: resolved WO detail via JSON (no browser) for ' + payload.equipmentId);
            return { ok: true, result: apiResult, logs };
          }
          log('[wo:scrape] API path returned ' + (apiResult && apiResult.error ? ('error: ' + apiResult.error) : 'no open WO') + ' — falling back to DOM scrape');
        }
      } catch (e) {
        log('[wo:scrape] API path threw, falling back to DOM scrape: ' + e.message);
      }

      // Fallback: legacy DOM scrape.
      const { scrapeWorkOrder } = require('../../src/scrapers/aap_wo_scraper');
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

  // ── relay:refresh-unit ───────────────────────────────────────────────────
  // Live re-scrape of ONE unit's Relay Garage / vendor data on demand (used by
  // the Long Dwell "AI Fill" freshness gate: when a unit's cached relay data is
  // older than the freshness window, refresh just that unit before summarizing).
  //
  // Scrapes via relay.scrapeUnitPage (default session — Midway cookies already
  // injected, same as the batch sync path), updates relayCache[id] (incl.
  // _cachedAt), re-merges the fresh relay data into the live fleet rows + saves
  // fleetData, and returns the refreshed merged row so the caller can build its
  // AI prompt from current data. Serialized with the batch scrape's own lock is
  // not needed here (single unit, own window), but we guard against concurrent
  // per-unit refreshes with a small lock.
  let _refreshUnitLock = false;
  handle('relay:refresh-unit', async (_e, equipmentId, opts) => {
    const store = require('../store');
    const id = String(equipmentId || '').trim();
    opts = opts || {};
    // force: bypass the relay TTL cache so this is a GUARANTEED live scrape
    // (used by Split View "refresh on open"). reconcile: re-run canonical state
    // for the unit after the fresh merge so the drafts reflect current data.
    const force = !!opts.force;
    const doReconcile = opts.reconcile !== false; // default on for this path
    if (!id) throw new ScraperError('equipmentId required', 'relay:refresh-unit');
    if (_refreshUnitLock) {
      // Don't hard-fail — return the current cache so the caller can proceed.
      const cache = store.load('relayCache', {});
      return { ok: false, busy: true, unit: null, cache: cache[id] || null };
    }
    _refreshUnitLock = true;
    try {
      const { scrapeUnitPage, mergeRelayIntoRows } = require('../../src/scrapers/relay');
      const relayCache = store.load('relayCache', {});
      // Force a live scrape by dropping this unit's cache entry first — there is
      // no bypass flag on scrapeUnitPage, so deleting the entry is the clean way
      // to guarantee a fresh Relay WR + ASIST pass (scrapeUnitPage runs the
      // ASIST enrich internally, so this refreshes BOTH Relay and Offsite).
      if (force) { delete relayCache[id]; }
      // partition '' == default session (Midway cookies already injected), same
      // as scrapeRelay uses for the batch path.
      const res = await scrapeUnitPage(id, '', relayCache);
      // Persist the refreshed cache entry (scrapeUnitPage stamps _cachedAt).
      if (res && !res._noWR) {
        relayCache[id] = res;
      } else if (res && res._noWR) {
        relayCache[id] = res; // negative-cache marker (also stamped _cachedAt)
      }
      store.save('relayCache', relayCache);

      // Re-merge the single fresh entry into the live fleet rows so the row the
      // renderer reads (and the AI prompt uses) reflects current data.
      const notesStore = store.load('notesStore', {});
      let freshRow = null;
      // Use the LARGER of ctx.lastData.rows vs the persisted fleetData rows as
      // the merge base. During a background rescan, ctx.lastData can transiently
      // be a partial chunk (e.g. 28 of 219 rows); merging over that and pushing
      // it as the fleet is what zeroed out the grid. Never build from the
      // smaller set.
      const liveRows  = (ctx.lastData && Array.isArray(ctx.lastData.rows)) ? ctx.lastData.rows : [];
      const storedFd  = store.load('fleetData', {}) || {};
      const storedRows = Array.isArray(storedFd.rows) ? storedFd.rows : [];
      const baseRows  = liveRows.length >= storedRows.length ? liveRows : storedRows;
      if (baseRows.length) {
        const singleCache = {}; if (res) singleCache[id] = res;
        const merged = mergeRelayIntoRows(baseRows, singleCache, notesStore);
        // Persist the full merged set to state + store (unchanged behavior).
        if (ctx.lastData) ctx.lastData.rows = merged;
        storedFd.rows = merged;
        store.save('fleetData', storedFd);
        freshRow = merged.find(r => String(r.equipmentId || '').trim() === id) || null;
        // Push ONLY the single changed row as a row-level MERGE (partialMerge),
        // not the whole fleet. The renderer overlays it by equipmentId, so a
        // per-unit refresh can never shrink/replace the grid. This is the fix
        // for "AI Fill All zeroed out my units".
        if (ctx.pushData && freshRow) {
          try { ctx.pushData({ rows: [freshRow], partialMerge: true, _partial: 'relay-refresh-unit' }); } catch (_) {}
        }
      }
      // Re-run canonical state for THIS unit off the fresh row so the Split View
      // drafts (relayNote / dealerAsk) and canonical record reflect current data
      // immediately, not the last full-sync snapshot. Reconcile is AI; keep it
      // best-effort and non-fatal — a scrape refresh must never fail because the
      // AI was slow/unavailable. Persists canonicalState + mirrors onto the row.
      if (doReconcile && freshRow) {
        try {
          const reconcile = require('../scrapers/relay_reconcile');
          const canonical = require('../orcha/canonical_state');
          const cfg = reconcile.getConfig();
          let decision = null;
          if (cfg.enabled && reconcile.hasReconcilableData(freshRow)) {
            try { decision = await reconcile.reconcileUnit(freshRow, { cfg }); } catch (_) {}
          }
          const prevCanon = store.load('canonicalState', {}) || {};
          const prior = (prevCanon.units && prevCanon.units[id]) ? { [id]: prevCanon.units[id] } : {};
          const built = canonical.buildAll([freshRow], { decisions: decision ? { [id]: decision } : {}, prior });
          const rec = built.units[id];
          if (rec) {
            // Merge the one unit's record into the canonicalState store.
            const units = Object.assign({}, prevCanon.units || {}, { [id]: rec });
            store.save('canonicalState', { units, updatedAt: new Date().toISOString(), lastReconcileAt: decision ? new Date().toISOString() : (prevCanon.lastReconcileAt || null) });
            // Mirror canonical fields onto the pushed row so the renderer sees them.
            if (freshRow) Object.assign(freshRow, canonical.mirrorFields(rec));
          }
        } catch (ce) { logger.warn('relay:refresh-unit canonical re-run failed (non-fatal): ' + ce.message); }
      }
      logger.info('relay:refresh-unit done for ' + id + (force ? ' [forced]' : '') + (res && res._noWR ? ' (no WR)' : ''));
      return { ok: true, unit: freshRow, cache: relayCache[id] || null };
    } catch (e) {
      throw new ScraperError(e.message, 'relay:refresh-unit', { equipmentId: id });
    } finally {
      _refreshUnitLock = false;
    }
  });

  // ── quicksight:capture-afp / capture-dsp ─────────────────────────────────
  // DBR DATA (Daily Call): opens the AFP/DSP QuickSight dashboards and
  // returns the RENDERED PAGE TEXT (not structured data — QuickSight's
  // pivot-table DOM has no stable selector shape, confirmed via live
  // iteration). The renderer (daily-call.js) hands this text to AI to parse
  // into the DBR table rows. See src/scrapers/quicksight_dbr.js.
  //
  // Caching: quicksight:save-parsed / quicksight:get-cache let the renderer
  // persist whatever STRUCTURED result it got back from AI, so re-opening
  // the DBR panel doesn't need a fresh scrape+AI-call every time.
  let _quicksightLock = false;
  handle('quicksight:capture-afp', async () => {
    if (_quicksightLock) {
      throw new ScraperError('quicksight:capture-afp operation already in progress', 'quicksight:capture-afp');
    }
    _quicksightLock = true;
    try {
      const { captureAfpText } = require('../../src/scrapers/quicksight_dbr');
      return await captureAfpText();
    } catch (e) {
      throw new ScraperError(e.message, 'quicksight:capture-afp');
    } finally {
      _quicksightLock = false;
    }
  });

  let _quicksightDspLock = false;
  handle('quicksight:capture-dsp', async () => {
    if (_quicksightDspLock) {
      throw new ScraperError('quicksight:capture-dsp operation already in progress', 'quicksight:capture-dsp');
    }
    _quicksightDspLock = true;
    try {
      const { captureDspText } = require('../../src/scrapers/quicksight_dbr');
      return await captureDspText();
    } catch (e) {
      throw new ScraperError(e.message, 'quicksight:capture-dsp');
    } finally {
      _quicksightDspLock = false;
    }
  });

  // Renderer calls this after AI successfully parses the captured text, so
  // the structured result survives a panel close/reopen without re-scraping.
  handle('quicksight:save-parsed', (_e, payload) => {
    requireObject(payload, 'payload');
    const store = require('../store');
    if (payload.kind === 'dsp') store.save('quicksightDbrDsp', payload.data);
    else store.save('quicksightDbr', payload.data);
    return { ok: true };
  });

  handle('quicksight:get-cache', () => {
    const store = require('../store');
    return store.load('quicksightDbr', { ok: false, domicile: [], scac: [], scrapedAt: null });
  });

  handle('quicksight:get-cache-dsp', () => {
    const store = require('../store');
    return store.load('quicksightDbrDsp', { ok: false, scac: [], scrapedAt: null });
  });

  // ── WBR weekly snapshot + comparison ────────────────────────────────────────
  // wbr:capture records this week's per-site + fleet-total down metrics (used by
  // the Generate WBR button so a manual run always logs the current week — the
  // sync path also auto-captures). wbr:comparison returns the real Prior-Week /
  // T6W comparison + unit movement computed from captured history + canonical
  // state, so the WBR prompt can use real numbers instead of "enter manually".
  handle('wbr:capture', (_e, payload) => {
    try {
      const wbr = require('../orcha/wbr_snapshot');
      const store = require('../store');
      const rows = (payload && Array.isArray(payload.rows) && payload.rows.length)
        ? payload.rows
        : ((store.load('fleetData', {}) || {}).rows || []);
      return wbr.captureSnapshot(rows);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });

  handle('wbr:comparison', (_e, payload) => {
    try {
      const wbr = require('../orcha/wbr_snapshot');
      const store = require('../store');
      const rows = (payload && Array.isArray(payload.rows) && payload.rows.length)
        ? payload.rows
        : ((store.load('fleetData', {}) || {}).rows || []);
      const current = wbr.computeWeekMetrics(rows);
      // Canonical records (for grounded newly-down "why").
      const canonicalUnits = ((store.load('canonicalState', {}) || {}).units) || {};
      return wbr.buildComparison(current, { canonicalUnits });
    } catch (e) {
      return { coldStart: true, error: e.message, total: { text: 'comparison unavailable' }, sites: {} };
    }
  });

  logger.info('Scrapers IPC handlers registered');
}

module.exports = { registerScrapersIPC };
