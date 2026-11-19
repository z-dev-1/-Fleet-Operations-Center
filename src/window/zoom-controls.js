'use strict';
/**
 * zoom-controls.js — opt-in zoom for in-app link windows (aap:open-url with { zoom: true }).
 *
 * The app menu is null (src/window/index.js), so there are no built-in zoom
 * accelerators. attachZoom() wires:
 *   - Ctrl/Cmd + '=' / '+'  zoom in, Ctrl/Cmd + '-' zoom out, Ctrl/Cmd + '0' reset
 *   - Ctrl + mouse wheel (webContents 'zoom-changed')
 *   - the on-window overlay (zoom-overlay-preload.js) via ipc 'fleet-zoom:step'
 * Every step calls webContents.setZoomFactor, clamped to [ZOOM.MIN, ZOOM.MAX].
 */
const path = require('path');

const ZOOM = Object.freeze({ MIN: 0.5, MAX: 3, STEP: 0.1, DEFAULT: 1 });
const ZOOM_PRELOAD = path.join(__dirname, 'zoom-overlay-preload.js');

function clampZoom(f) {
  const n = Number(f);
  if (!Number.isFinite(n)) return ZOOM.DEFAULT;
  return Math.min(ZOOM.MAX, Math.max(ZOOM.MIN, Math.round(n * 100) / 100));
}

function stepZoom(cur, dir) {
  if (dir === 'reset') return ZOOM.DEFAULT;
  const base = clampZoom(cur);
  if (dir === 'in') return clampZoom(base + ZOOM.STEP);
  if (dir === 'out') return clampZoom(base - ZOOM.STEP);
  return base;
}

// webContents id -> step(dir), for the windows that opted in.
const _attached = new Map();
let _ipcWired = false;

function _wireIpc(ipcMain) {
  if (_ipcWired || !ipcMain || typeof ipcMain.on !== 'function') return;
  _ipcWired = true;
  ipcMain.on('fleet-zoom:step', (e, dir) => {
    const id = e && e.sender && e.sender.id;
    const step = _attached.get(id);
    if (step && (dir === 'in' || dir === 'out' || dir === 'reset')) step(dir);
  });
}

function attachZoom(wc, deps = {}) {
  if (!wc) return null;
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const step = (dir) => {
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
      const f = stepZoom(wc.getZoomFactor(), dir);
      wc.setZoomFactor(f);
      if (typeof wc.send === 'function') wc.send('fleet-zoom:changed', f);
    } catch (_) { /* window closing */ }
  };

  wc.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const k = input.key;
    let dir = null;
    if (k === '=' || k === '+') dir = 'in';
    else if (k === '-' || k === '_') dir = 'out';
    else if (k === '0') dir = 'reset';
    if (!dir) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    step(dir);
  });
  wc.on('zoom-changed', (_event, direction) => step(direction === 'in' ? 'in' : 'out'));
  if (typeof wc.setVisualZoomLevelLimits === 'function') {
    try { wc.setVisualZoomLevelLimits(1, 3); } catch (_) { /* optional */ }
  }

  _wireIpc(ipcMain);
  const id = wc.id;
  _attached.set(id, step);
  if (typeof wc.once === 'function') wc.once('destroyed', () => { _attached.delete(id); });
  return { step };
}

module.exports = { ZOOM, ZOOM_PRELOAD, clampZoom, stepZoom, attachZoom, __test__: { _attached, reset() { _attached.clear(); _ipcWired = false; } } };
