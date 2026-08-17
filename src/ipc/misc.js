'use strict';
// ipc/misc.js - Email, files, window, partner, auth, notifications
// V-C: paths use P.* (cross-platform). mwinit is cross-platform.
//
// Stage 3 hardening (2026-06-28):
//   - Issue #12 LOW: email:compose setInterval always cleared
//   - Issue #18 LOW: email:preview uses crypto.randomBytes temp name + cleanup
//
// Stage 4 hardening (2026-06-28):
//   - Issue #27: remaining 18 utility handlers migrated to handle() wrapper —
//     unhandled rejections now caught uniformly by safeIPC
//   - Issue #28: file:read-dataurl validates filePath is within allowed dirs
//     (P.screenshotsDir or P.dataDir) before reading

const { app, BrowserWindow, shell, clipboard, Notification } = require('electron');
const p      = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { P }  = require('../config/paths');
const store  = require('../store');
const logger = require('../utils/logger')('ipc:misc');
const { handle, requireString, requireStringMax } = require('./_safe');
const { ConfigError } = require('../utils/errors');

// ── Issue #28: allowed base directories for file:read-dataurl ───────────────
// Renderer may only request files that live inside one of these directories.
function _assertAllowedFilePath(filePath) {
  requireString(filePath, 'filePath');
  const resolved    = p.resolve(filePath);
  const screensDir  = p.resolve(P.screenshotsDir);
  const dataDir     = p.resolve(P.dataDir);
  const appDataScreens = p.resolve(process.env.APPDATA || '', 'fleet-ops-app', 'screenshots');
  const inScreens   = resolved.startsWith(screensDir + p.sep) || resolved === screensDir || resolved.startsWith(appDataScreens + p.sep) || resolved === appDataScreens;
  const inData      = resolved.startsWith(dataDir + p.sep)    || resolved === dataDir;
  if (!inScreens && !inData) {
    throw new ConfigError(
      'file:read-dataurl path is outside allowed directories',
      'filePath'
    );
  }
}

function registerMiscIPC(ctx) {
  const send     = ctx.sendToWindow;
  const ROOT_DIR = p.join(__dirname, '../..');

  // ── Stage 3 guards preserved ────────────────────────────────────────────
  // Issue #18: unpredictable temp file name + cleanup on close
  // BUG FIX (Phase 4): email:preview previously expected payload.html to be pre-built,
  // but the renderer sends the same raw payload as email:compose (operator, units, slot, etc.).
  // Now builds HTML via buildEmail() — same as compose — then opens in a preview window.
  handle('email:preview', (_e, payload) => {
    let html = payload.html || '';
    if (!html) {
      try {
        const { buildEmail } = require('../../src/scrapers/emailBuilder');
        const relayCache     = store.load('relayCache', {});
        const notesStore     = store.load('notesStore', {});
        const { operator, domicile, units, slot, testMode, emailNote } = payload;

        let emailUnits = null;
        if (units && units.length > 0 && units[0].op) { emailUnits = units; }
        if (!emailUnits) {
          const rawRows = (store.load('fleetData', { rows: [] })).rows || [];
          emailUnits = rawRows.map(r => ({
            id: r.equipmentId || '', op: r.operator || '', site: r.domicileSite || '',
            model: (r.manufacturer || r.make || '').trim() || '--',
            bodyType: r.bodyType || r.assetType || '', fuelType: r.fuelType || '',
            atsState: r.lifecycleState || '', relayStatus: r.lifecycleReason || '',
            riskScore: r.riskScore || 0,
            riskTier: r.riskScore >= 75 ? 'HIGH' : r.riskScore >= 50 ? 'MEDIUM' : 'LOW',
            vendor: r.vendor || '', duration: r.workDuration || '',
            issue: r.issueDetails || '', created: r.created || '',
            altId: r.alternativeId || '', serviceUrl: r.serviceUrl || '',
            offsiteShopEvent: r.offsiteShopEvent || '', offsiteShopEventUrl: r.offsiteShopEventUrl || '',
            savedRepairStatus: r.savedRepairStatus || '', savedPrimaryComponent: r.savedPrimaryComponent || '',
            savedNotes: r.savedNotes || '', geofence: r.geofence || '',
            insightsList: r.insightsList || [],
          }));
        }
        html = buildEmail({ operator, domicile, units: emailUnits, slot, testMode, relayCache, notesStore, emailNote });
      } catch (e) {
        logger.error('email:preview build failed:', e.message);
        return { success: false, error: e.message };
      }
    }
    if (!html || html.length < 50) return { success: false, error: 'No HTML generated' };

    const rand    = crypto.randomBytes(8).toString('hex');
    const tmpFile = p.join(os.tmpdir(), 'fleet_email_preview_' + rand + '.html');
    fs.writeFileSync(tmpFile, html, 'utf8');
    const win = new BrowserWindow({
      width: 980, height: 860, title: 'Fleet Email Preview',
      icon: require('../config/app-icon').getAppIconPath(),
      backgroundColor: '#f6f8fa', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.loadFile(tmpFile);
    win.once('ready-to-show', () => win.show());
    win.once('closed', () => {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* already gone */ }
    });
    return { success: true };
  });

  // Issue #12: setInterval always cleared through finish()
  handle('email:compose', async (_e, payload) => {
    const { to, cc, subject, label, operator, domicile, units, slot, testMode, emailNote } = payload;
    let finalHtml = '';
    let _buildEmailRef = null;
    try {
      const { buildEmail } = require('../../src/scrapers/emailBuilder');
      _buildEmailRef = buildEmail;
      const relayCache     = store.load('relayCache', {});
      const notesStore     = store.load('notesStore', {});
      let emailUnits       = null;
      if (units && units.length > 0 && units[0].op) { emailUnits = units; }
      if (!emailUnits) {
        const rawRows = (store.load('fleetData', { rows: [] })).rows || [];
        function parsePMDates(raw) {
          if (!raw) return { pmB: '--', pmX: '--', dot: '--', quarterlyLift: '--' };
          function extract(lbl) {
            const idx = raw.toLowerCase().indexOf(lbl.toLowerCase());
            if (idx === -1) return '--';
            const after = raw.slice(idx + lbl.length);
            const m1 = after.match(/^\s*[I:\d\s]*\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}?,?\s+\d{4})/i);
            if (m1) return m1[1];
            const m2 = after.match(/^\s*[I:\d\s]*\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/i);
            if (m2) return m2[1];
            if (/^\s*Unknown/i.test(after)) return 'Unknown';
            return '--';
          }
          return { pmB: extract('PM B'), pmX: extract('PM X'), dot: extract('DOT'), quarterlyLift: extract('Quarterly Lift') };
        }
        function cleanMake(r) {
          let make = (r.manufacturer || r.make || '').trim().replace(/\n/g, ' ');
          if (/^\d{4}$/.test(make) || /^MODEL\s+YEAR/i.test(make)) make = '';
          if (!make) { const rc = relayCache[r.equipmentId] || {}; make = (rc.make || rc.model || '').trim(); if (/^\d{4}$/.test(make)) make = ''; }
          return make || '--';
        }
        emailUnits = rawRows.map(r => {
          const pm = parsePMDates(r.dueDate || '');
          return { id: r.equipmentId || '', op: r.operator || '', site: r.domicileSite || '', model: cleanMake(r), bodyType: r.bodyType || r.assetType || '', fuelType: r.fuelType || '', atsState: r.lifecycleState || '', relayStatus: r.lifecycleReason || '', riskScore: r.riskScore || 0, riskTier: r.riskScore >= 75 ? 'HIGH' : r.riskScore >= 50 ? 'MEDIUM' : 'LOW', vendor: r.vendor || '', duration: r.workDuration || '', issue: r.issueDetails || '', created: r.created || '', altId: r.alternativeId || '', serviceUrl: r.serviceUrl || '', offsiteShopEvent: r.offsiteShopEvent || '', offsiteShopEventUrl: r.offsiteShopEventUrl || '', asistSource: r.asistSource || '', asistLabel: r.asistLabel || '', asistSrUrl: r.asistSrUrl || '', asistScrapedAt: r.asistScrapedAt || '', dealerName: r.dealerName || '', subVendor: r.subVendor || r.dealerName || r.geofence || '', savedRepairStatus: r.savedRepairStatus || '', savedPrimaryComponent: r.savedPrimaryComponent || '', savedSalesforceCase: r.savedSalesforceCase || r.salesforceCase || '', savedSalesforceCaseUrl: r.savedSalesforceCaseUrl || r.salesforceCaseUrl || '', savedOffsiteEvent: r.savedOffsiteEvent || '', savedOffsiteUrl: r.savedOffsiteUrl || '', savedNotes: r.savedNotes || '', pmB: pm.pmB, pmX: pm.pmX, dot: pm.dot, quarterlyLift: pm.quarterlyLift, insightsList: r.insightsList || [], pmStatus: r.pmStatus || '', uptakeSynced: r.uptakeSynced || false, geofence: r.geofence || '' };
        });
      }
      finalHtml = _buildEmailRef({ operator, domicile, units: emailUnits, slot, testMode, relayCache, notesStore, emailNote });
    } catch (e) { logger.error('email:compose build failed:', e.message); return { success: false, error: e.message }; }
    if (!finalHtml || finalHtml.length < 100) return { success: false, error: 'HTML too short' };

    // Enhance subject with change counts (e.g. "| 42 Unavail | 3 New ↓ | 2 Returned ↑")
    let finalSubject = subject || '';
    if (_buildEmailRef && _buildEmailRef._lastSubjectSuffix) {
      finalSubject += _buildEmailRef._lastSubjectSuffix;
    }

    const { session: eSession } = require('electron');
    return new Promise((resolve) => {
      const win = new BrowserWindow({ width: 1100, height: 800, show: true, title: 'Fleet Email', icon: require('../config/app-icon').getAppIconPath(), backgroundColor: '#f6f8fa', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, session: eSession.defaultSession } });
      const owaUrl = 'https://outlook.office365.com/mail/deeplink/compose' + '?to=' + encodeURIComponent(to||'') + '&cc=' + encodeURIComponent(cc||'') + '&subject=' + encodeURIComponent(finalSubject||'');
      win.loadURL(owaUrl);
      let attempts = 0, done = false;
      let poll = null;
      function finish(r) {
        if (done) return;
        done = true;
        if (poll !== null) { clearInterval(poll); poll = null; }
        setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
        resolve(r);
      }
      setTimeout(() => finish({ success: false, error: 'timeout' }), 60000);
      win.on('closed', () => finish({ success: false, error: 'closed' }));
      const edQ = 'div[aria-label*="Message body"],div.elementToProof[contenteditable="true"]';
      poll = setInterval(() => {
        if (++attempts > 50) { finish({ success: false, error: 'no editor' }); return; }
        if (win.isDestroyed()) { finish({ success: false, error: 'closed' }); return; }
        win.webContents.executeJavaScript('(function(){if(window.__fi)return"already";var ed=document.querySelector(' + JSON.stringify(edQ) + ');if(!ed)return"no-editor";ed.focus();document.execCommand("selectAll",false,null);document.execCommand("delete",false,null);window.__fi=true;return"ready";})();')
          .then((r) => {
            if (r !== 'ready') return;
            if (poll !== null) { clearInterval(poll); poll = null; }
            clipboard.write({ html: finalHtml, text: 'Fleet Report' });
            setTimeout(() => {
              if (win.isDestroyed()) { finish({ success: false }); return; }
              win.webContents.paste();
              let pa = 0;
              const verify = () => {
                if (win.isDestroyed()) { finish({ success: false }); return; }
                win.webContents.executeJavaScript('(function(){var ed=document.querySelector(' + JSON.stringify(edQ) + ');return(!ed)?"no-editor":(ed.innerHTML||"").length>50?"ok":"empty";})();')
                  .then((chk) => {
                    if (chk === 'ok') { setTimeout(() => { win.webContents.executeJavaScript('(function(){var b=document.querySelector("button[aria-label*=\\"Send\\"]");if(b)b.click();return b?"sent":"no-btn";})();').then(() => finish({ success: true })).catch(() => finish({ success: true })); }, 1000); }
                    else if (pa < 3) { pa++; clipboard.write({ html: finalHtml, text: 'Fleet Report' }); setTimeout(() => { win.webContents.paste(); setTimeout(verify, 1500); }, 500); }
                    else { finish({ success: false, error: 'paste-empty' }); }
                  }).catch(() => setTimeout(verify, 1000));
              };
              setTimeout(verify, 2000);
            }, 800);
          }).catch(() => {});
      }, 1000);
    });
  });

  // ── Stage 4: remaining utility handlers migrated to handle() ────────────

  handle('diag:dump-email-config', async () => {
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return { error: 'no window' };
    const outPath = p.join(P.dataDir, 'email_config_dump.json');
    const data = await ctx.mainWindow.webContents.executeJavaScript('JSON.stringify(JSON.parse(localStorage.getItem("fleetOpEmails")||"{}")):');
    fs.writeFileSync(outPath, data, 'utf8'); logger.info('Email config dumped', outPath); return { success: true, path: outPath };
  });

  handle('email:save-op-emails', (_e, data) => {
    try { fs.writeFileSync(P.opEmails, JSON.stringify(data, null, 2), 'utf8'); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  });


  handle('email:load-op-emails', () => {
    try { if (fs.existsSync(P.opEmails)) return JSON.parse(fs.readFileSync(P.opEmails, 'utf8')); } catch (_) {}
    return {};
  });

  // ── Email test mode ───────────────────────────────────────────────────────
  handle('email:get-test-mode', () => {
    const s = store.load('settings', {});
    return !!s.emailTestMode;
  });

  handle('email:set-test-mode', (_e, enabled) => {
    const s = store.load('settings', {});
    s.emailTestMode = !!enabled;
    store.save('settings', s);
    logger.info('Email test mode:', s.emailTestMode ? 'ON' : 'OFF');
    return { ok: true, testMode: s.emailTestMode };
  });


  handle('shell:open-external', async (_e, url) => {
    if (url && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  // Issue #28: path containment check before any file read
  handle('file:read-dataurl', (_e, filePath) => {
    try {
      if (!filePath) return null;
      _assertAllowedFilePath(filePath);         // throws ConfigError if outside allowed dirs
      if (!fs.existsSync(filePath)) return null;
      return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
    } catch (e) {
      logger.warn('file:read-dataurl failed:', e.message);
      return null;
    }
  });

  handle('uptake:open-screenshot', (_e, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
    const imgWin = new BrowserWindow({ width: 1440, height: 900, title: 'Uptake - Last Scrape', icon: require('../config/app-icon').getAppIconPath(), backgroundColor: '#0d1117', webPreferences: { nodeIntegration: false, contextIsolation: true } });
    imgWin.loadFile(filePath);
    return { ok: true };
  });

  handle('uptake:latest-screenshot', () => {
    try {
      if (!fs.existsSync(P.screenshotsDir)) return null;
      const files = fs.readdirSync(P.screenshotsDir).filter(f => f.endsWith('.png')).map(f => ({ f, t: fs.statSync(p.join(P.screenshotsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      return files.length ? p.join(P.screenshotsDir, files[0].f) : null;
    } catch (_) { return null; }
  });

  // S28: Partner portal handlers — module not yet implemented.
  // Guarded to prevent runtime crash. Remove guard when src/services/partner.js exists.
  handle('partner:get-qr', async () => {
    try {
      const { getQRCodeDataUrl, getPartnerUrl } = require('../../src/services/partner');
      return { url: getPartnerUrl(), qr: await getQRCodeDataUrl() };
    } catch (_) { return { url: '', qr: '', error: 'Partner module not yet implemented' }; }
  });

  handle('partner:get-queue', () => {
    try {
      const { loadQueue } = require('../../src/services/partner');
      return loadQueue().filter(j => j.status === 'pending');
    } catch (_) { return []; }
  });

  handle('partner:update-job', (_e, id, update) => {
    try {
      const { loadQueue, saveQueue } = require('../../src/services/partner');
      const queue = loadQueue();
      const job   = queue.find(j => j.id === id);
      if (!job) return { ok: false };
      Object.assign(job, update);
      saveQueue(queue);
      return { ok: true, job };
    } catch (_) { return { ok: false, error: 'Partner module not yet implemented' }; }
  });

  handle('window:action', (_e, action) => {
    const w = ctx.mainWindow;
    if (!w) return;
    if (action === 'minimize')      w.minimize();
    else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
    else if (action === 'close')    { w.hide(); if (ctx.showBubble) ctx.showBubble(); }
  });

  handle('fleet:force-scan', async () => {
    logger.info('Force scan triggered');
    if (ctx.runFullSync) ctx.runFullSync();
    return { ok: true };
  });

  handle('auth:run-mwinit', async () => {
    // FIX (2026-07-21): was its own independent spawn ('powershell -NoExit
    // -Command mwinit'), completely separate from src/scrapers/auth.js's
    // runMwinit() and its in-flight guard. This meant this Settings-button
    // path could open a SECOND, unguarded mwinit terminal at the exact same
    // time as the app's own auto-renewal timer or SSO auth-poller was
    // already running one via auth.js -- two competing mwinit terminals
    // racing for the same Midway session, which is a confirmed direct cause
    // of "AEA verification failed: used_too_late" (one attempt's challenge/
    // certificate timing gets invalidated by the other). Delegating to the
    // one guarded function so every mwinit-launching path in this app now
    // shares the exact same lock -- no more parallel spawns from here.
    logger.info('Launching mwinit (via shared AuthManager)...');
    const sendMwStatus = (msg) => { if (send) send('auth:mwinit-status', msg); };
    sendMwStatus('running');
    try {
      const { runMwinit, injectCookies } = require('../scrapers/auth');
      await runMwinit();
      await injectCookies();
      sendMwStatus('launched');
      return { ok: true };
    } catch (err) {
      logger.error('mwinit failed:', err.message);
      sendMwStatus('error:' + err.message);
      return { ok: false, error: err.message };
    }
  });

  handle('auth:check-midway', () => {
    // FIX (2026-07-28): was only checking fs.existsSync() — reported "expired"
    // even when the session was valid because it never read the actual Unix
    // expiry timestamps in the cookie file. Now delegates to checkMwinit()
    // (the same function used by the app.js heartbeat) which reads real
    // timestamps and returns { ok, expiresInMin } correctly.
    try {
      const { checkMwinit } = require('../scrapers/auth');
      const state = checkMwinit();
      return {
        ok:          state.ok,
        reason:      state.ok ? null : (state.reason || 'Midway cookies expired - run mwinit'),
        expiresInMin: state.expiresInMin || null,
      };
    } catch (e) {
      // Fallback: if auth module fails to load, at least check file existence
      const ok = fs.existsSync(P.midwayCookie);
      return { ok, reason: ok ? null : 'Midway cookie file not found - run mwinit' };
    }
  });

  handle('aap:open-url', async (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    const { BrowserWindow, session } = require('electron');
    const win = new BrowserWindow({
      width: 1280, height: 860,
      title: 'AAP Asset',
      icon: require('../config/app-icon').getAppIconPath(),
      backgroundColor: '#0d1117',
      center: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: session.defaultSession,  // same Midway cookies as the scraper window
      },
    });
    win.setMenuBarVisibility(false);

    // Workflow Intelligence: attach capture if a recording is currently
    // active (same gate + technique as open-popup in ipc/orcha.js).
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
    // Intercept SPA pushState navigation to capture WR tab URLs
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        (function() {
          var _push = history.pushState.bind(history);
          history.pushState = function(state, title, url) {
            _push(state, title, url);
            window.__orchaLogUrl && window.__orchaLogUrl(location.href);
          };
          var _replace = history.replaceState.bind(history);
          history.replaceState = function(state, title, url) {
            _replace(state, title, url);
            window.__orchaLogUrl && window.__orchaLogUrl(location.href);
          };
          window.addEventListener('popstate', function() {
            window.__orchaLogUrl && window.__orchaLogUrl(location.href);
          });
          // Also intercept all clicks on mdn-link anchors
          document.addEventListener('click', function(e) {
            var a = e.target.closest('a[mdn-link], a[data-mdn-interactive]');
            if (a) {
              setTimeout(function() {
                window.__orchaLogUrl && window.__orchaLogUrl('CLICK:' + location.href);
              }, 300);
            }
          }, true);
        })()
      `).catch(function(){});
    });
    // Receive URL from injected spy via ipcRenderer is not available in AAP context,
    // so poll location.href every 500ms for 10s after load and log changes
    win.webContents.on('did-finish-load', () => {
      let _lastUrl = '';
      const _poll = setInterval(() => {
        if (win.isDestroyed()) { clearInterval(_poll); return; }
        win.webContents.executeJavaScript('location.href').then(function(href) {
          if (href && href !== _lastUrl) {
            logger.info('[aap-win] url=' + href);
            _lastUrl = href;
          }
        }).catch(function(){});
      }, 500);
      setTimeout(function() { clearInterval(_poll); }, 30000);
    });
    win.loadURL(url);
    win.show();
    return { ok: true };
  });

  handle('notify', (_e, title, body) => {
    if (!Notification.isSupported()) return { ok: false };
    const safeTitle = String(title  || '').slice(0, 64);
    const safeBody  = String(body   || '').slice(0, 256);
    const n = new Notification({ title: safeTitle, body: safeBody, icon: p.join(ROOT_DIR, 'assets', 'icon.png'), silent: false });
    n.on('click', () => { if (ctx.mainWindow) { ctx.mainWindow.show(); ctx.mainWindow.focus(); } });
    n.show();
    return { ok: true };
  });

  handle('email:send', async (_e, opts) => {
    // Route to the method the user chose in Settings -> Email -> Send Method.
    // 'auto' (default) preserves the original cascade: Graph -> SMTP -> OWA.
    // Any explicit choice goes directly to that method with no silent fallback,
    // so the user knows immediately when something isn't configured right.
    const { sendFleetEmail, loadEmailConfig } = require('../../src/scrapers/email_sender');
    const cfg    = loadEmailConfig();
    const method = cfg.emailMethod || 'auto';
    logger.info('[Email] send method: ' + method);

    // Helper: open OWA compose window (clipboard + deep-link)
    async function openOWA() {
      const { clipboard, BrowserWindow, session: eSess } = require('electron');
      const { getAppIconPath } = require('../config/app-icon');
      const plainText = (opts.htmlBody || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      clipboard.write({ html: opts.htmlBody || '', text: plainText });
      const toAddr  = (opts.to || cfg.defaultTo || '').split(';')[0].trim();
      const owaBase = (cfg.owaUrl || 'https://outlook.office365.com/mail/deeplink/compose').replace(/\/$/, '');
      const owaUrl  = owaBase + '?to=' + encodeURIComponent(toAddr) + '&subject=' + encodeURIComponent(opts.subject || 'Fleet Status Report');
      const owaWin = new BrowserWindow({ width: 1024, height: 768, title: 'Send Email — ' + toAddr, icon: getAppIconPath(), webPreferences: { nodeIntegration: false, contextIsolation: true, session: eSess.defaultSession } });
      owaWin.setMenu(null);
      owaWin.loadURL(owaUrl);
      owaWin.once('ready-to-show', () => owaWin.show());
    }

    // ── Graph ──────────────────────────────────────────────────────────────
    if (method === 'graph' || method === 'auto') {
      try {
        const graphClient = require('../graph/client');
        if (await graphClient.isSignedIn()) {
          logger.info('[Email] Sending via Microsoft Graph...');
          if (send) send('email:progress', '[Email] Sending via Microsoft Graph...');
          const result = await graphClient.sendMail({ to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject || 'Fleet Status Report', htmlBody: opts.htmlBody });
          if (send) send('email:progress', '[Email] Sent via Microsoft Graph.');
          return result;
        } else if (method === 'graph') {
          // Explicit — don't fall through, tell the user
          return { ok: false, error: 'Microsoft Graph: not signed in. Go to Settings -> Outlook (Microsoft Graph) to sign in.' };
        }
      } catch (e) {
        logger.warn('[Email] Graph send failed:', e.message);
        if (method === 'graph') {
          return { ok: false, error: 'Microsoft Graph failed: ' + e.message };
        }
        if (send) send('email:progress', '[Email] Graph failed (' + e.message + ') -- trying SMTP...');
      }
    }

    // ── SMTP ───────────────────────────────────────────────────────────────
    if (method === 'smtp' || method === 'auto') {
      const smtpResult = await sendFleetEmail(opts, (msg) => { logger.info(msg); if (send) send('email:progress', msg); });
      if (smtpResult && smtpResult.ok) return smtpResult;
      if (method === 'smtp') {
        // Explicit — don't fall through to OWA
        return { ok: false, error: smtpResult.error || 'SMTP failed' };
      }
      logger.warn('[Email] SMTP failed (' + (smtpResult && smtpResult.error) + ') — opening OWA compose');
      if (send) send('email:progress', '[Email] SMTP unavailable — opening OWA. Body copied to clipboard, paste with Ctrl+V.');
    }

    // ── OWA ────────────────────────────────────────────────────────────────
    // Reached when method === 'owa', or as the auto-cascade final fallback.
    if (send) send('email:progress', '[Email] Opening OWA compose. Body copied to clipboard — paste with Ctrl+V.');
    try { await openOWA(); } catch (owaErr) { logger.warn('[Email] OWA failed:', owaErr.message); }
    return { ok: false, error: 'OWA compose opened', method: 'owa-opened' };
  });

  handle('email:get-config', () => {
    const { loadEmailConfig } = require('../../src/scrapers/email_sender');
    return loadEmailConfig();
  });

  handle('email:save-config', (_e, config) => {
    const { saveEmailConfig } = require('../../src/scrapers/email_sender');
    saveEmailConfig(config);
    return { ok: true };
  });


  // Split-view: open two URLs side by side in separate windows
  handle('window:split-view', async (_e, data) => {
    const { BrowserWindow, screen, session: eSession } = require('electron');
    const { attachAutoLogin, partitionForUrl } = require('../orcha/auto-login');
    const { leftUrl, rightUrl, leftTitle, rightTitle } = data || {};
        if (!leftUrl && !rightUrl) return { ok: false, error: 'No URLs provided' };

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const halfW = Math.floor(width / 2);

    const opts = (x, title, url) => {
      const partition = url ? partitionForUrl(url) : null;
      const ses = partition ? eSession.fromPartition(partition) : eSession.defaultSession;
      return {
        width: halfW, height: height, x, y: 0,
        title: title || 'Fleet Operations',
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
      };
    };

    if (leftUrl) {
      const left = new BrowserWindow(opts(0, leftTitle || 'Relay Garage', leftUrl));
      left.setMenuBarVisibility(false);
      attachAutoLogin(left, leftUrl, { maxRetries: 3 });
      left.loadURL(leftUrl);
    }
    if (rightUrl) {
      const right = new BrowserWindow(opts(halfW, rightTitle || 'Offsite Shop', rightUrl));
      right.setMenuBarVisibility(false);
      attachAutoLogin(right, rightUrl, { maxRetries: 3 });
      right.loadURL(rightUrl);
    }

    return { ok: true };
  });



  
  // ── SP Discover Sheets (from Excel URL) ──
  handle('sp:discover-sheets', async (_e, url) => {
    const { extractFilePath, discoverSheets } = require('../../src/scrapers/sp_discover');
    const { BrowserWindow } = require('electron');
    // uses existing logger from misc scope
    
    const parsed = extractFilePath(url);
    if (parsed.error) return { ok: false, error: parsed.error };
    logger.info('[SP Discover] Parsed:', JSON.stringify(parsed));

    // Get or create SP window
    let spWin = BrowserWindow.getAllWindows().find(w => 
      w.webContents.getURL().includes('sharepoint.com')
    );
    
    if (!spWin) {
      spWin = new BrowserWindow({ show: false, width: 800, height: 600 });
      // BUG FIX (2026-07-16): previously just loadURL() + a blind 3s sleep,
      // with NO check that SharePoint authentication actually completed.
      // Root cause of "Load sheets" silently returning nothing: the Midway
      // cookie file (~/.midway/cookie, written by mwinit) contains EXACTLY
      // ONE domain -- midway-auth.amazon.com -- not a SharePoint session
      // cookie. SharePoint access requires following an SSO/OAuth redirect
      // chain (same pattern Uptake/AAP already handle via their own
      // did-finish-load "click SSO" logic), which can take longer than 3s
      // and can also land on a login page if the chain hasn't finished --
      // in which case the fetch() calls further down in this handler
      // (GetFileById GUID lookup, getfilebyserverrelativeurl, /_api/search)
      // hit an unauthenticated SharePoint endpoint and just resolve to null,
      // which the code swallows silently and reports as "file not found."
      // sharepoint_push.js's proven-working ensureSpAuth() waits for
      // did-navigate to land on the real SP site (not a login/oauth
      // intermediate) before doing anything else -- replicated here so
      // discoverSheets() below always runs against an authenticated window.
      // BUG FIX (2026-07-16), confirmed via diagnostic logging: the hidden
      // window was landing on login.microsoftonline.com and getting stuck
      // there. Console output captured mid-diagnosis:
      //   "BSSO Telemetry": {"result":"Error","error":"bssoNotSupported",
      //    "traces":["window.navigator.msLaunchUri is not available for
      //    _pullBrowserSsoCookie"]}
      // Microsoft's native Windows-broker silent-SSO (msLaunchUri) is an
      // Edge/IE-only API that Electron's Chromium does not implement, so the
      // silent-auth path always fails here and SharePoint falls back to
      // requiring INTERACTIVE login (password/MFA/"Stay signed in?"). Since
      // this window was created with show:false, that login page could never
      // be seen or completed -- it just sat there until the timeout. Fix:
      // reveal the window the moment we detect we've landed on a Microsoft
      // login/OAuth page, so the user can actually complete sign-in, and
      // extend the wait window accordingly since interactive login takes
      // longer than a silent redirect chain. Re-hide once authenticated.
      let shown = false;
      spWin.webContents.on('did-navigate', (_e, navUrl) => {
        if (!shown && /login\.microsoftonline\.com|oauth2\/authorize|midway-auth/i.test(navUrl)) {
          shown = true;
          logger.info('[SP Discover] Landed on a login page — showing window for interactive sign-in');
          spWin.show();
          spWin.focus();
        }
      });

      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          spWin.webContents.removeListener('did-navigate', onNav);
          clearTimeout(timeoutId);
          if (shown && !spWin.isDestroyed()) spWin.hide(); // re-hide once authenticated
          resolve();
        };
        const onNav = (_e, navUrl) => {
          if (navUrl.includes('amazon.sharepoint.com/sites/') && !navUrl.includes('login') && !navUrl.includes('oauth')) finish();
        };
        // Interactive login needs real time for the user to type a password /
        // approve MFA — 3 minutes instead of the old silent-only 30s.
        const timeoutId = setTimeout(() => {
          if (done) return;
          logger.warn('[SP Discover] SharePoint auth wait timed out after 180s. Final URL: ' + spWin.webContents.getURL());
          finish();
        }, 180000);
        spWin.webContents.on('did-navigate', onNav);
        spWin.webContents.on('did-fail-load', (_e, code, desc, failUrl) => {
          if (code === -3 || done) return;
          logger.warn('[SP Discover] SharePoint load failed: ' + desc + ' (code ' + code + ') url=' + failUrl);
          finish();
        });
        spWin.loadURL('https://amazon.sharepoint.com/sites/AFP-FAS').catch((e) => logger.warn('[SP Discover][diag] loadURL rejected: ' + e.message));
      });
    }

    let filePath = parsed.filePath;
    
    // If we need to search for the file by name
      // First: resolve file via sourcedoc GUID from URL
      const guidMatch = url.match(/sourcedoc=%7B([^%}]+)/i);
      if (guidMatch && !filePath) {
        const guid = decodeURIComponent(guidMatch[1]).replace(/[{}]/g, '');
        logger.info('[SP Discover] GUID lookup: ' + guid);
        try {
          const guidPath = await spWin.webContents.executeJavaScript(
            'fetch("https://amazon.sharepoint.com' + parsed.site + "/_api/web/GetFileById('" + guid + "')?$select=ServerRelativeUrl" + '", ' +
            '{ credentials: "include", headers: { "Accept": "application/json;odata=verbose" } })' +
            '.then(r => r.ok ? r.json() : null).then(d => d && d.d ? d.d.ServerRelativeUrl : null).catch(() => null)'
          );
          if (guidPath) { filePath = guidPath; logger.info('[SP Discover] Resolved via GUID: ' + filePath); }
        } catch(e) { logger.warn('[SP Discover] GUID failed: ' + e.message); }
      }
      
    if (!filePath && parsed.needsSearch) {
      logger.info('[SP Discover] Searching for: ' + parsed.fileName);
      // Try common document library paths
      const tryPaths = [
        parsed.site + '/Shared Documents/' + parsed.fileName,
        parsed.site + '/Shared Documents/AFP- POWER UNIT TRACKERS/' + parsed.fileName,
        parsed.site + '/Shared Documents/DSP- POWER UNIT TRACKERS/' + parsed.fileName,
      ];
      
      for (const tryPath of tryPaths) {
        try {
          const exists = await spWin.webContents.executeJavaScript(`
            fetch("https://amazon.sharepoint.com/_api/web/getfilebyserverrelativeurl('${tryPath.replace(/'/g, "''")}')", 
              { credentials: 'include', headers: { 'Accept': 'application/json;odata=verbose' } })
              .then(r => r.ok)
              .catch(() => false)
          `);
          if (exists) { filePath = tryPath; break; }
        } catch(e) {}
      }
      
      // If still not found, try search API
      if (!filePath) {
        const searchResult = await spWin.webContents.executeJavaScript(`
          fetch("https://amazon.sharepoint.com${parsed.site}/_api/search/query?querytext='" + encodeURIComponent('${parsed.fileName}') + "'&selectproperties='Path'&rowlimit=3",
            { credentials: 'include', headers: { 'Accept': 'application/json;odata=verbose' } })
            .then(r => r.json())
            .then(d => {
              try {
                const rows = d.d.query.PrimaryQueryResult.RelevantResults.Table.Rows.results;
                return rows.map(r => r.Cells.results.find(c => c.Key === 'Path').Value).filter(p => p.includes('.xlsx'));
              } catch(e) { return []; }
            })
            .catch(() => [])
        `);
        if (searchResult && searchResult.length) {
          filePath = searchResult[0].replace('https://amazon.sharepoint.com', '');
        }
      }
      
      if (!filePath) {
        return { ok: false, error: 'Could not find file: ' + parsed.fileName + '. Try pasting the server-relative path (e.g. /sites/AFP-FAS/Shared Documents/folder/file.xlsx)' };
      }
      logger.info('[SP Discover] Resolved path: ' + filePath);
    }

    const result = await discoverSheets(spWin, filePath);
    if (result && result.ok) {
      result.filePath = filePath; // Ensure filePath is always returned
    }
    return result;
  });

  // BUG FIX (2026-07-16): the three handlers below were previously spliced
  // into the middle of the sp:discover-sheets handler's `if (!spWin) {...}`
  // block above (a file-corruption artifact, likely from a bad edit/merge).
  // Because they were nested inside another handler's async callback body,
  // they were NEVER actually registered with ipcMain at app startup -- only
  // conditionally, lazily, and incorrectly if/when sp:discover-sheets itself
  // ran and found no existing SharePoint window. Worse: on any retry within
  // the same app session (e.g. re-clicking "Load sheets"), re-registering
  // 'fleet:repair-history' via ipcMain.handle() a second time throws
  // "Attempted to register a second handler for 'fleet:repair-history'",
  // which rejected the whole sp:discover-sheets promise -- this was the
  // direct cause of "SharePoint not loading when I click Load Sheets" (fails
  // reliably on any retry after the first attempt in a given session), and
  // separately left repair-history/offline-queue features unregistered
  // until the user happened to trigger SP discovery at least once.
  // Restored as normal top-level handler registrations.

  // Repair history (3-month summarized)
  handle('fleet:repair-history', async (_e, equipmentId) => {
    const { getUnitHistory, getAllHistory } = require('../orcha/repair-history');
    if (equipmentId) return getUnitHistory(equipmentId);
    return getAllHistory();
  });

  // Offline queue
  handle('offline:queue', async (_e, equipmentId, rawText) => {
    const { queueTimelineEntry } = require('../orcha/offline');
    queueTimelineEntry(equipmentId, rawText);
    return { ok: true };
  });

  handle('offline:count', async () => {
    const { getQueueCount } = require('../orcha/offline');
    return getQueueCount();
  });

  logger.info('Misc IPC handlers registered');
}

module.exports = { registerMiscIPC };
