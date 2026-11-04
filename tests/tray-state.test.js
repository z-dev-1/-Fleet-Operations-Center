// tests/tray-state.test.js — tray busy/idle helpers (src/window/tray-state.js,
// perf.trayAnimateOnlyWhenBusy).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isBusy, trayAction, TRAY_FRAME_MS, TRAY_BUSY_POLL_MS } = require('../src/window/tray-state');

describe('tray state', () => {
  it('isBusy: each signal alone is busy; none is idle', () => {
    expect(isBusy({ apiLoadInFlight: true })).toBe(true);
    expect(isBusy({ deepScanRunning: true })).toBe(true);
    expect(isBusy({ rescanInProgress: true })).toBe(true);
    expect(isBusy({ isSyncing: true })).toBe(true);
    expect(isBusy({ apiLoadInFlight: false, deepScanRunning: false, rescanInProgress: false, isSyncing: false })).toBe(false);
    expect(isBusy({})).toBe(false);
    expect(isBusy(undefined)).toBe(false);
  });
  it('trayAction: flag off never changes anything', () => {
    for (const busy of [true, false]) for (const animating of [true, false]) {
      expect(trayAction({ animateOnlyWhenBusy: false, busy, animating })).toBe('none');
    }
  });
  it('trayAction: busy starts, idle stops, steady states do nothing', () => {
    expect(trayAction({ animateOnlyWhenBusy: true, busy: true, animating: false })).toBe('start');
    expect(trayAction({ animateOnlyWhenBusy: true, busy: false, animating: true })).toBe('stop');
    expect(trayAction({ animateOnlyWhenBusy: true, busy: true, animating: true })).toBe('none');
    expect(trayAction({ animateOnlyWhenBusy: true, busy: false, animating: false })).toBe('none');
  });
  it('frame cadence unchanged; busy poll is cheap', () => {
    expect(TRAY_FRAME_MS).toBe(120);
    expect(TRAY_BUSY_POLL_MS).toBeGreaterThanOrEqual(1000);
  });
});
