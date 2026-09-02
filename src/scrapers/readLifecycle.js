'use strict';
// scrapers/readLifecycle.js — Digital FAS Part 5: authenticated single-unit
// AAP lifecycle READ-BACK.
//
// setLifecycleState() only confirms the edit modal closed after Apply — it does
// NOT read the persisted lifecycle state/reason back. To VERIFY a MOVE_UNIT
// actually took effect we must independently re-read the unit's Overview page
// (the SAME /v2/asset/<id> page setLifecycle mutated) and parse the header's
// "Lifecycle State" / "Lifecycle Reason" labels.
//
// This mirrors setLifecycle.js's proven pattern: a hidden BrowserWindow bound
// to the default Electron session (which already holds injected Midway cookies),
// navigate to assetUrl, then executeJavaScript to read the two labels. Runs in
// the MAIN process only. Never mutates anything.

// electron is required LAZILY inside readLifecycle() so this module can be
// imported/unit-tested outside the Electron runtime.
let logger; try { logger = require('../utils/logger').createLogger('read-lifecycle'); } catch (_) { logger = { info(){}, warn(){} }; }

const TIMEOUT_MS = 30000;
const SETTLE_MS = 3000;

// In-page reader: parse "Lifecycle State" and "Lifecycle Reason" from the
// asset Overview header (label-then-value, same approach as relay's readLabel).
const READ_SCRIPT = String.raw`
(function() {
  function normalize(t){ return String(t||'').replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }
  function getLines(){ return normalize(document.body ? document.body.innerText : '').split('\n').map(function(l){return l.trim();}).filter(Boolean); }
  var KNOWN = new Set(['asset id','asset type','vin','owner name','make','program','domicile site','operator','lifecycle state','lifecycle reason','last completed maintenance','vendor','state','category','last updated','work duration','created by']);
  function readLabel(lines, label){
    var target = label.toLowerCase();
    for (var i=0;i<lines.length;i++){
      if (lines[i].toLowerCase() !== target) continue;
      for (var j=i+1;j<Math.min(lines.length,i+8);j++){
        var v = lines[j];
        if (!v) continue;
        if (KNOWN.has(v.toLowerCase())) continue;
        return v;
      }
    }
    return '';
  }
  var lines = getLines();
  return {
    lifecycleState:  readLabel(lines, 'Lifecycle State'),
    lifecycleReason: readLabel(lines, 'Lifecycle Reason'),
    _url: window.location.href,
  };
})();
`;

/**
 * readLifecycle(assetUrl) -> Promise<{ state, reason } | null>
 * Returns the unit's CURRENT lifecycle state + reason read live from AAP, or
 * null if the session is unavailable / the page could not be read.
 */
async function readLifecycle(assetUrl) {
  if (!assetUrl || !/aap-na\.corp\.amazon\.com/i.test(assetUrl)) {
    logger.warn('[readLifecycle] missing/invalid assetUrl');
    return null;
  }
  // Cheap session gate — do not attempt a read if Midway cookies are gone.
  try {
    const { checkMwinit } = require('./auth');
    const st = checkMwinit();
    if (!st || !st.ok) { logger.warn('[readLifecycle] no valid Midway session: ' + (st && st.reason)); return null; }
  } catch (_) { /* if auth module unavailable, still attempt — worst case null */ }

  return new Promise((resolve) => {
    let settled = false;
    let win;
    const done = (val) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { if (win) win.destroy(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => { logger.warn('[readLifecycle] timeout'); done(null); }, TIMEOUT_MS);

    let BrowserWindow, session;
    try { ({ BrowserWindow, session } = require('electron')); }
    catch (e) { logger.warn('[readLifecycle] electron unavailable: ' + e.message); done(null); return; }
    try {
      win = new BrowserWindow({ show: false, skipTaskbar: true, width: 1400, height: 900,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession } });
    } catch (e) { logger.warn('[readLifecycle] window create failed: ' + e.message); done(null); return; }

    win.webContents.on('did-finish-load', async () => {
      const curUrl = win.webContents.getURL();
      if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) return; // still on auth redirect — wait
      await new Promise(r => setTimeout(r, SETTLE_MS)); // let React render the header
      try {
        const res = await win.webContents.executeJavaScript(READ_SCRIPT);
        if (res && (res.lifecycleState || res.lifecycleReason)) {
          done({ state: res.lifecycleState || '', reason: res.lifecycleReason || '' });
        } else {
          done(null);
        }
      } catch (e) { logger.warn('[readLifecycle] read failed: ' + e.message); done(null); }
    });
    win.webContents.on('did-fail-load', (_, code) => { if (code !== -3) done(null); });

    const baseUrl = String(assetUrl).split('?')[0];
    logger.info('[readLifecycle] loading ' + baseUrl.slice(0, 80));
    win.loadURL(baseUrl);
  });
}

module.exports = { readLifecycle };
