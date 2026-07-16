// tests/sync-interval.test.js
//
// Regression coverage for the "Schedulers – Config → Sync interval
// (minutes)" feature (2026-07-16). Before this feature, that field/button
// existed in the Settings HTML but had zero wiring anywhere -- no click
// handler, no IPC handler, no read path -- so typing a value and clicking
// Save did nothing at all. The actual auto-sync timer ran on a hardcoded
// DEFAULTS.SYNC_INTERVAL_MS constant with no override.
//
// Following the existing project convention (see tests/validation.test.js),
// this mirrors the isolated validation/fallback logic rather than requiring
// the real Electron-coupled modules (src/ipc/settings.js uses ipcMain.handle
// via _safe.js, and src/app.js's _getSyncIntervalMs() is a closure inside
// the main bootstrap function -- neither is easily importable in isolation
// outside a running Electron process). Any future change to the bounds or
// fallback behavior in either src/ipc/settings.js's settings:save-sync-
// interval handler or src/app.js's _getSyncIntervalMs() should be mirrored
// here.

import { describe, it, expect } from 'vitest';

// Mirrors the validation in src/ipc/settings.js's settings:save-sync-interval handler
function validateSyncIntervalMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 360) {
    return { ok: false, error: 'minutes must be a whole number between 1 and 360' };
  }
  return { ok: true, minutes: n };
}

// Mirrors src/app.js's _getSyncIntervalMs() fallback logic
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // matches src/config/defaults.js
function getSyncIntervalMs(settings) {
  const mins = Number(settings.syncIntervalMinutes);
  if (Number.isFinite(mins) && Number.isInteger(mins) && mins >= 1 && mins <= 360) {
    return mins * 60 * 1000;
  }
  return DEFAULT_SYNC_INTERVAL_MS;
}

describe('settings:save-sync-interval validation', () => {
  it('accepts a valid integer within bounds', () => {
    expect(validateSyncIntervalMinutes(10)).toEqual({ ok: true, minutes: 10 });
  });

  it('accepts the minimum boundary (1)', () => {
    expect(validateSyncIntervalMinutes(1).ok).toBe(true);
  });

  it('accepts the maximum boundary (360)', () => {
    expect(validateSyncIntervalMinutes(360).ok).toBe(true);
  });

  it('rejects zero', () => {
    expect(validateSyncIntervalMinutes(0).ok).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(validateSyncIntervalMinutes(-5).ok).toBe(false);
  });

  it('rejects values above the 360 max', () => {
    expect(validateSyncIntervalMinutes(361).ok).toBe(false);
  });

  it('rejects non-integer (decimal) values', () => {
    expect(validateSyncIntervalMinutes(2.5).ok).toBe(false);
  });

  it('rejects NaN / non-numeric strings', () => {
    expect(validateSyncIntervalMinutes('abc').ok).toBe(false);
  });

  it('rejects undefined/null', () => {
    expect(validateSyncIntervalMinutes(undefined).ok).toBe(false);
    expect(validateSyncIntervalMinutes(null).ok).toBe(false);
  });

  it('accepts a numeric string (Number() coercion)', () => {
    expect(validateSyncIntervalMinutes('15')).toEqual({ ok: true, minutes: 15 });
  });
});

describe('_getSyncIntervalMs() fallback behavior (src/app.js)', () => {
  it('uses the custom value when set and valid', () => {
    expect(getSyncIntervalMs({ syncIntervalMinutes: 10 })).toBe(10 * 60 * 1000);
  });

  it('falls back to the 5-minute default when unset', () => {
    expect(getSyncIntervalMs({})).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it('falls back to the default when the stored value is out of bounds (corrupted/tampered settings)', () => {
    expect(getSyncIntervalMs({ syncIntervalMinutes: 9999 })).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(getSyncIntervalMs({ syncIntervalMinutes: 0 })).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(getSyncIntervalMs({ syncIntervalMinutes: -1 })).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it('falls back to the default when the stored value is not a valid number', () => {
    expect(getSyncIntervalMs({ syncIntervalMinutes: 'not-a-number' })).toBe(DEFAULT_SYNC_INTERVAL_MS);
    expect(getSyncIntervalMs({ syncIntervalMinutes: NaN })).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it('falls back to the default when the stored value is a non-integer', () => {
    expect(getSyncIntervalMs({ syncIntervalMinutes: 7.5 })).toBe(DEFAULT_SYNC_INTERVAL_MS);
  });

  it('accepts the minimum (1 min) and maximum (360 min) boundaries', () => {
    expect(getSyncIntervalMs({ syncIntervalMinutes: 1 })).toBe(1 * 60 * 1000);
    expect(getSyncIntervalMs({ syncIntervalMinutes: 360 })).toBe(360 * 60 * 1000);
  });
});
