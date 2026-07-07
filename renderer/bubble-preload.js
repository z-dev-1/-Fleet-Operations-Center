'use strict';
/**
 * bubble-preload.js — Context bridge for the always-on-top bubble HUD
 *
 * Minimal surface: only the channels the bubble window actually uses.
 * PUSH channels (main → renderer): badge, notification, fleet data
 * SEND channels (renderer → main): clicked (open main), open-unit (deep-link)
 */

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('bubble', {
  // ── PUSH: main → bubble ──────────────────────────────────────────────────
  onBadge:        (cb) => on('bubble:badge',        cb),
  onNotification: (cb) => on('bubble:notification', cb),
  onFleetData:    (cb) => on('fleet:data',          cb),

  // ── SEND: bubble → main ──────────────────────────────────────────────────
  /** Open the main window and hide the bubble */
  openMain:   ()       => ipcRenderer.send('bubble:clicked'),
  /** Navigate main window to a specific unit and hide the bubble */
  openUnit:   (unitId) => ipcRenderer.send('bubble:open-unit', unitId),
  // ── AI Chat ──
  ask:        (prompt) => ipcRenderer.invoke('ai:orcha-action', prompt),
  // ── Alerts push ──
  onAlerts:   (cb)     => on('orcha:alerts', cb),
  // ── Hide bubble ──
  hide:       ()       => ipcRenderer.send('bubble:hide'),
  resize:     (w, h)   => ipcRenderer.send('bubble:resize', w, h),
  reposition: ()       => ipcRenderer.send('bubble:reposition'),
  repositionMini: ()   => ipcRenderer.send('bubble:reposition-mini'),
});
