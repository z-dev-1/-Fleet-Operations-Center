'use strict';
/**
 * window/tray-state.js — pure helpers for the tray icon animation
 * (perf.trayAnimateOnlyWhenBusy, Phase 2b). Kept electron-free so they can be
 * unit tested; src/window/index.js owns the timers and the Tray.
 */

const TRAY_FRAME_MS = 120;      // 12-frame pulse at ~8 fps (unchanged)
const TRAY_BUSY_POLL_MS = 2000; // how often the busy state is re-checked when the flag is ON

function isBusy(state) {
  const s = state || {};
  return !!(s.apiLoadInFlight || s.deepScanRunning || s.rescanInProgress || s.isSyncing);
}

// → 'start' | 'stop' | 'none'
function trayAction({ animateOnlyWhenBusy, busy, animating } = {}) {
  if (!animateOnlyWhenBusy) return 'none';
  if (busy && !animating) return 'start';
  if (!busy && animating) return 'stop';
  return 'none';
}

module.exports = { isBusy, trayAction, TRAY_FRAME_MS, TRAY_BUSY_POLL_MS };
