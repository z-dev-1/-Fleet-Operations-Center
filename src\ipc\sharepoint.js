'use strict';
/**
 * ipc/sharepoint.js - SharePoint push IPC handlers
 * sp:push, sp:get-config, sp:save-config, sp:get-lists
 *
 * Stage 4 hardening (2026-06-28):
 *   - Issue #24: all handlers use handle() wrapper
 *   - Issue #24: sp:push validates units is a non-empty array, capped at 500 entries
 *   - Issue #24: sp:save-config accepts config object { domiciles, emailHost, ... }
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:sharepoint');
const { handle, requireString, timeoutAfter } = require('./_safe');

const MAX_SP_UNITS = 500;   // hard cap on units per push — prevents unbounded SP writes

function registerSharePointIPC(ctx) {
  const send = ctx.sendToWindow;

  // Issue #24: array validated before any SP write begins
  handle('sp:push', async (_e, units) => {
    const { requireArrayMax } = require('./_safe');
    requireArrayMax(units, 'units', MAX_SP_UNITS);
    const { pushToSharePoint } = require('../scrapers/sharepoint_push');
    return pushToSharePoint(units, (msg, type) => {
      logger.info('[SP Push]', type || 'info', '|', msg);
      if (send) send('sp:progress', { message: msg, type });
    });
  });

  handle('sp:get-config', () => store.load('spConfig', {}));

  // Accepts a plain config object: { domiciles: { [key]: { siteUrl, listName } }, emailHost, ... }
  // Also accepts legacy array format (workbooks) for backwards compatibility.
  handle('sp:save-config', (_e, data) => {
    if (data === null || data === undefined) {
      throw new (require('../utils/errors').ConfigError)('config data must be provided', 'data');
    }
    store.save('spConfig', data);
    return { ok: true };
  });

  // Fetch available SharePoint lists/document libraries for a given site URL.
  // Uses the SP REST API _api/web/lists — returns array of { title, id } objects.
  handle('sp:get-lists', async (_e, siteUrl) => {
    requireString(siteUrl, 'siteUrl');
    const { BrowserWindow, session } = require('electron');
    const spSes = session.defaultSession;

    const fetchLists = new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 800, height: 600, show: false, x: -3000, y: -3000,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes },
      });
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        try { win.close(); } catch (e) {}
        err ? reject(err) : resolve(val);
      };
      win.webContents.on('did-fail-load', (_, code, desc) => {
        if (code !== -3) finish(new Error('SP load failed: ' + desc));
      });
      // Load blank.htm inside the site so SP session cookies apply
      const origin = siteUrl.replace(/\/sites\/.*/, '');
      const sitePath = siteUrl.replace(origin, '');
      win.loadURL(siteUrl);
      win.webContents.on('did-finish-load', async () => {
        try {
          const apiUrl = siteUrl.replace(/\/$/, '') + '/_api/web/lists?$select=Title,Id,Hidden&$filter=Hidden eq false&$orderby=Title';
          const result = await win.webContents.executeJavaScript(`
            fetch(${JSON.stringify(apiUrl)}, {
              credentials: 'include',
              headers: { 'Accept': 'application/json;odata=verbose' }
            })
            .then(r => r.ok ? r.json() : Promise.reject('HTTP ' + r.status))
            .then(d => (d.d && d.d.results ? d.d.results : []).map(l => ({ title: l.Title, id: l.Id })))
            .catch(e => ({ error: String(e) }))
          `);
          if (result && result.error) finish(new Error(result.error));
          else finish(null, result || []);
        } catch (e) { finish(e); }
      });
    });

    return Promise.race([
      fetchLists,
      timeoutAfter(20000, 'sp:get-lists'),
    ]);
  });
  // Push units for a specific operator + domicile on-demand from the renderer.
  // Filters ctx.lastData.rows server-side — renderer just passes { opName, domCode }.
  handle('sp:push-domicile', async (_e, payload) => {
    const { requireObject, requireString } = require('./_safe');
    requireObject(payload, 'payload');
    const opName  = requireString(payload.opName,  'opName');
    const domCode = requireString(payload.domCode, 'domCode');

    const rows = ctx.lastData && ctx.lastData.rows;
    if (!rows || rows.length === 0) {
      return { ok: false, error: 'No fleet data loaded — run a sync first' };
    }

    // Filter to units belonging to this operator AND domicile (strict match)
    const units = rows.filter((u) => {
      const op  = (u.op || u.operator || '').toUpperCase();
      const dom = (u.site || u.domicileSite || '').toUpperCase();
      return op === opName.toUpperCase() && dom === domCode.toUpperCase();
    });

    if (units.length === 0) {
      return { ok: false, error: `No units found for ${opName} / ${domCode}` };
    }

    if (units.length > MAX_SP_UNITS) {
      return { ok: false, error: `Unit count (${units.length}) exceeds push limit of ${MAX_SP_UNITS}` };
    }

    const { pushToSharePoint } = require('../scrapers/sharepoint_push');
    logger.info(`[SP Push Domicile] ${opName}/${domCode} — ${units.length} units`);

    return pushToSharePoint(units, (msg, type) => {
      logger.info('[SP Push Domicile]', type || 'info', '|', msg);
      if (send) send('sp:progress', { message: msg, type });
    });
  });

  logger.info('SharePoint IPC handlers registered');
}

module.exports = { registerSharePointIPC };
