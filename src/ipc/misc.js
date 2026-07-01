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
  const inScreens   = resolved.startsWith(screensDir + p.sep) || resolved === screensDir;
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
  handle('email:preview', (_e, payload) => {
    const rand    = crypto.randomBytes(8).toString('hex');
    const tmpFile = p.join(os.tmpdir(), 'fleet_email_preview_' + rand + '.html');
    fs.writeFileSync(tmpFile, payload.html, 'utf8');
    const win = new BrowserWindow({
      width: 980, height: 860, title: 'Fleet Email Preview',
      backgroundColor: '#f6f8fa', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.loadFile(tmpFile);
    win.once('ready-to-show', () => win.show());
    win.once('closed', () => {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* already gone */ }
    });
  });

  // Issue #12: setInterval always cleared through finish()
  handle('email:compose', async (_e, payload) => {
    const { to, cc, subject, label, operator, domicile, units, slot, testMode, emailNote } = payload;
    let finalHtml = '';
    try {
      const { buildEmail } = require('../../src/scrapers/emailBuilder');
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
      finalHtml = buildEmail({ operator, domicile, units: emailUnits, slot, testMode, relayCache, notesStore, emailNote });
    } catch (e) { logger.error('email:compose build failed:', e.message); return { success: false, error: e.message }; }
    if (!finalHtml || finalHtml.length < 100) return { success: false, error: 'HTML too short' };
    const { session: eSession } = require('electron');
    return new Promise((resolve) => {
      const win = new BrowserWindow({ width: 1100, height: 800, show: true, title: 'Fleet Email', backgroundColor: '#f6f8fa', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, session: eSession.defaultSession } });
      const owaUrl = 'https://outlook.office365.com/mail/deeplink/compose' + '?to=' + encodeURIComponent(to||'') + '&cc=' + encodeURIComponent(cc||'') + '&subject=' + encodeURIComponent(subject||'');
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
    const imgWin = new BrowserWindow({ width: 1440, height: 900, title: 'Uptake - Last Scrape', backgroundColor: '#0d1117', webPreferences: { nodeIntegration: false, contextIsolation: true } });
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

  handle('partner:get-qr', async () => {
    const { getQRCodeDataUrl, getPartnerUrl } = require('../../src/services/partner');
    return { url: getPartnerUrl(), qr: await getQRCodeDataUrl() };
  });

  handle('partner:get-queue', () => {
    const { loadQueue } = require('../../src/services/partner');
    return loadQueue().filter(j => j.status === 'pending');
  });

  handle('partner:update-job', (_e, id, update) => {
    const { loadQueue, saveQueue } = require('../../src/services/partner');
    const queue = loadQueue();
    const job   = queue.find(j => j.id === id);
    if (!job) return { ok: false };
    Object.assign(job, update);
    saveQueue(queue);
    return { ok: true, job };
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
    const { spawn } = require('child_process');
    logger.info('Launching mwinit...');
    const sendMwStatus = (msg) => { if (send) send('auth:mwinit-status', msg); };
    return new Promise((resolve) => {
      sendMwStatus('running');
      let child;
      if (process.platform === 'win32') { child = spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', 'mwinit'], { detached: true, shell: false }); }
      else { child = spawn('open', ['-a', 'Terminal', '--args', 'mwinit'], { detached: true, shell: false }); }
      child.on('error', (err) => { logger.error('mwinit spawn error:', err.message); sendMwStatus('error:' + err.message); resolve({ ok: false, error: err.message }); });
      child.on('close', () => { sendMwStatus('launched'); resolve({ ok: true }); });
    });
  });

  handle('auth:check-midway', () => {
    const ok = fs.existsSync(P.midwayCookie);
    return { ok, reason: ok ? null : 'Midway cookie not found — run mwinit' };
  });

  handle('aap:open-url', async (_e, url) => {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    const { BrowserWindow, session } = require('electron');
    const win = new BrowserWindow({
      width: 1280, height: 860,
      title: 'AAP Asset',
      backgroundColor: '#0d1117',
      center: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: session.defaultSession,  // same Midway cookies as the scraper window
      },
    });
    win.setMenuBarVisibility(false);
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
    const { sendFleetEmail } = require('../../src/scrapers/email_sender');
    return sendFleetEmail(opts, (msg) => { logger.info(msg); if (send) send('email:progress', msg); });
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

  logger.info('Misc IPC handlers registered');
}

module.exports = { registerMiscIPC };
