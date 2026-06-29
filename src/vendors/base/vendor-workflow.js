'use strict';
/**
 * vendors/base/vendor-workflow.js -- Abstract base for vendor portal workflows [V-C]
 *
 * S23-1 (2026-06-28):
 *   - createVendorWindow(targetUrl, opts)
 *       BrowserWindow with correct isolated persist: partition + auto-login lifecycle.
 *       Resolves {win, url} on success, rejects on auth failure.
 *   - VendorWorkflow (abstract base class)
 *       Extend, set this.portalUrl, override run(unit, altId).
 *       Provides openPortal(), progress(), close().
 *   - sendToAll(channel, payload) -- broadcast IPC to all renderers.
 *
 * Session isolation:
 *   Each Decisiv portal has its own persist: partition via partitionForUrl().
 *   PACCAR <-> Volvo sessions never bleed. Neither bleeds into AAP/Relay.
 */

const { BrowserWindow } = require("electron");
const logger = require("../../utils/logger")("vendor-workflow");
const { attachAutoLogin, partitionForUrl } = require("../../orcha/auto-login");

const PROGRESS_CHANNEL = "vendor:progress";

function sendToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      try { win.webContents.send(channel, payload); } catch (_) {}
    }
  }
}

/**
 * createVendorWindow(targetUrl, opts)
 * BrowserWindow scoped to correct vendor session partition.
 * Attaches full auto-login lifecycle (detect->fill->redirect->target).
 * @param {string}  targetUrl  Full destination URL on vendor portal
 * @param {object}  [opts]
 * @param {boolean} [opts.show=false]  Show window (default: hidden)
 * @param {number}  [opts.maxRetries=2]
 * @returns {Promise<{win: Electron.BrowserWindow, url: string}>}
 */
function createVendorWindow(targetUrl, opts = {}) {
  const { show = false, maxRetries = 2 } = opts;
  const partition = partitionForUrl(targetUrl);
  if (!partition) {
    return Promise.reject(new Error("createVendorWindow: no partition for URL: " + targetUrl));
  }
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show, width: 1280, height: 900,
      webPreferences: {
        partition, nodeIntegration: false, contextIsolation: true, sandbox: true,
      },
    });
    // Allow Decisiv corporate cert chain
    win.webContents.on("certificate-error", (_e, _u, _err, _cert, cb) => cb(true));
    attachAutoLogin(win, targetUrl, {
      maxRetries,
      onDone: (result) => {
        if (result.success) {
          logger.info("createVendorWindow: session ready for", targetUrl.slice(0,80));
          resolve({ win, url: result.url });
        } else {
          logger.warn("createVendorWindow: auth failed:", result.error, targetUrl.slice(0,80));
          if (!win.isDestroyed()) win.destroy();
          reject(new Error("vendor-auth-failed:" + (result.error || "unknown")));
        }
      },
    });
    win.loadURL(targetUrl);
    logger.info("createVendorWindow: loading", targetUrl.slice(0,80), "| partition:", partition);
  });
}

/**
 * VendorWorkflow -- abstract base class for vendor portal orchestrators.
 *
 * Subclass pattern: extend VendorWorkflow, set this.portalUrl, override run().
 *   constructor() { super(name, portalUrl); }
 *   async run(unit, altId) { ... }
 *
 * Subclass contract:
 *   this.name      vendor display name  e.g. paccar
 *   this.portalUrl base portal URL
 *   run(unit, altId): Promise<{caseNumber, portalUrl}>  must be overridden
 */
class VendorWorkflow {
  constructor(name, portalUrl) {
    if (!name || !portalUrl) throw new Error("VendorWorkflow: name and portalUrl required");
    this.name = name;
    this.portalUrl = portalUrl;
    this._win = null;
  }

  async openPortal(targetUrl, opts = {}) {
    this.progress("opening", { url: targetUrl || this.portalUrl });
    const { win, url } = await createVendorWindow(targetUrl || this.portalUrl, opts);
    this._win = win;
    win.on("closed", () => { this._win = null; });
    return { win, url };
  }

  progress(step, payload = {}) {
    const msg = { vendor: this.name, step, ts: Date.now(), ...payload };
    sendToAll(PROGRESS_CHANNEL, msg);
    logger.info("[" + this.name + "] step:", step, JSON.stringify(payload).slice(0,120));
  }

  close() {
    if (this._win && !this._win.isDestroyed()) {
      this._win.destroy();
      this._win = null;
      logger.info("[" + this.name + "] portal window closed");
    }
  }

  async run(_unit, _altId) {
    throw new Error("VendorWorkflow.run() must be implemented by subclass: " + this.name);
  }
}

module.exports = { VendorWorkflow, createVendorWindow, sendToAll, PROGRESS_CHANNEL };
