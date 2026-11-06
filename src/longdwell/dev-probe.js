'use strict';
/**
 * longdwell/dev-probe.js - DEV-ONLY spike helper (inert unless FLEET_LDSP_PROBE_DIR is set).
 *
 * Runs <dir>/probe.js (a read-only DOM probe) in every frame of the Long Dwell
 * sheet side-panel guest when the user presses Ctrl+Shift+F8 over the pane, and
 * writes the combined JSON to <dir>/probe-out-<n>.json. Replaces the DevTools
 * copy/paste steps. The key press is swallowed, so nothing reaches Excel.
 *
 * Only attached to guests already hardened and marked by pane-guard, which is
 * itself installed only when longDwell.sharepointWrite is ON. The probe output
 * holds coordinates/counts/booleans only (see probe.js). Nothing is written to
 * the workbook, the session or any cookie.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger').createLogger('ldsp-probe');

const ENV_DIR = 'FLEET_LDSP_PROBE_DIR';

function _isSpGuest(guest) {
  try {
    const h = new URL(guest.getURL()).hostname.toLowerCase();
    return h.endsWith('.sharepoint.com');
  } catch { return false; }
}

function attachDevProbe(guest, env, info) {
  const dir = (env || process.env)[ENV_DIR];
  if (!dir || !guest || typeof guest.on !== 'function') return false;
  let running = false;
  let n = 0;
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.key !== 'F8' || !input.control || !input.shift || input.alt) return;
    if (!_isSpGuest(guest)) return; // only the SharePoint sheet pane
    event.preventDefault();
    if (running) { logger.info('[ldsp-probe] already running'); return; }
    running = true;
    _run(guest, dir, ++n).catch((e) => logger.warn('[ldsp-probe] failed: ' + (e && e.message)))
      .finally(() => { running = false; });
  });
  logger.info('[ldsp-probe] armed: Ctrl+Shift+F8 over the sheet pane', { markerSeen: !!(info && info.marked) });
  return true;
}

async function _run(guest, dir, n) {
  const src = fs.readFileSync(path.join(dir, 'probe.js'), 'utf8');
  const frames = guest.mainFrame && guest.mainFrame.framesInSubtree ? guest.mainFrame.framesInSubtree : [];
  const results = await Promise.all(frames.map(async (f, i) => {
    let host = '';
    try { host = new URL(f.url).host; } catch { /* no url */ }
    try {
      const r = await f.executeJavaScript(src);
      return { frame: i, isTop: f === guest.mainFrame, host, result: r };
    } catch (e) {
      return { frame: i, isTop: f === guest.mainFrame, host, error: String(e && e.message).slice(0, 200) };
    }
  }));
  const file = path.join(dir, 'probe-out-' + n + '.json');
  let marker = null;
  try { const wp = guest.getLastWebPreferences(); marker = !!(wp && Array.isArray(wp.additionalArguments) && wp.additionalArguments.includes('--fleet-ldsp-pane')); } catch { /* unknown */ }
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), paneMarkerSeen: marker, frames: results }, null, 1));
  logger.info('[ldsp-probe] wrote ' + file + ' (' + results.length + ' frames)');
}

module.exports = { attachDevProbe, ENV_DIR };
