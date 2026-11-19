'use strict';
/**
 * zoom-overlay-preload.js — preload for in-app link windows opened with
 * aap:open-url { zoom: true } (src/window/zoom-controls.js). Adds a small fixed
 * "– / 100% / +" overlay; each button sends 'fleet-zoom:step' and main applies
 * webContents.setZoomFactor. Self-contained (sandboxed preloads can only
 * require('electron')) and exposes nothing to the page.
 */
const { ipcRenderer } = require('electron');

(function () {
  const BTN = 'all:initial;cursor:pointer;font:600 12px/1 Segoe UI,Arial,sans-serif;color:#e6edf3;'
    + 'background:#21262d;border:1px solid #30363d;border-radius:4px;padding:4px 8px;min-width:22px;text-align:center;';
  let resetBtn = null;

  function mount() {
    if (document.getElementById('fleet-zoom-overlay')) return;
    const box = document.createElement('div');
    box.id = 'fleet-zoom-overlay';
    box.setAttribute('role', 'toolbar');
    box.setAttribute('aria-label', 'Zoom');
    box.setAttribute('style', 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:4px;'
      + 'padding:4px;background:rgba(13,17,23,.85);border:1px solid #30363d;border-radius:6px;');
    const add = (dir, text, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-zoom', dir);
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
      b.setAttribute('style', BTN);
      b.textContent = text;
      b.addEventListener('click', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        ipcRenderer.send('fleet-zoom:step', dir);
      });
      box.appendChild(b);
      return b;
    };
    add('out', '\u2013', 'Zoom out (Ctrl+-)');
    resetBtn = add('reset', '100%', 'Reset zoom (Ctrl+0)');
    add('in', '+', 'Zoom in (Ctrl+=)');
    (document.body || document.documentElement).appendChild(box);
  }

  ipcRenderer.on('fleet-zoom:changed', (_e, f) => {
    const n = Number(f);
    if (resetBtn && Number.isFinite(n)) resetBtn.textContent = Math.round(n * 100) + '%';
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
