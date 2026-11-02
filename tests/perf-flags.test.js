// tests/perf-flags.test.js
// Phase 2a/2b flag resolution (src/config/perf-flags.js) + the telemetryRollup
// store registration (store.save throws for unregistered keys).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'perf-flags-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const { resolveFlags, load, resolveCommsFlags, loadComms, COMMS_POLLING_MODES } = require('../src/config/perf-flags');
const store = require('../src/store');

describe('perf flags', () => {
  it('defaults: telemetry ON, perf flags OFF', () => {
    expect(resolveFlags({}, {})).toEqual({ telemetryEnabled: true, trayAnimateOnlyWhenBusy: false, deepScanMatchPool: false });
  });
  it('settings.telemetry.enabled=false disables telemetry', () => {
    expect(resolveFlags({ telemetry: { enabled: false } }, {}).telemetryEnabled).toBe(false);
  });
  it('settings.perf.* = true enables the perf flags', () => {
    const f = resolveFlags({ perf: { trayAnimateOnlyWhenBusy: true, deepScanMatchPool: true } }, {});
    expect(f.trayAnimateOnlyWhenBusy).toBe(true);
    expect(f.deepScanMatchPool).toBe(true);
  });
  it('truthy non-boolean perf values do not enable (only === true)', () => {
    const f = resolveFlags({ perf: { trayAnimateOnlyWhenBusy: 'yes', deepScanMatchPool: 1 } }, {});
    expect(f.trayAnimateOnlyWhenBusy).toBe(false);
    expect(f.deepScanMatchPool).toBe(false);
  });
  it('env overrides win over settings', () => {
    expect(resolveFlags({ telemetry: { enabled: true } }, { FLEET_TELEMETRY: '0' }).telemetryEnabled).toBe(false);
    expect(resolveFlags({ telemetry: { enabled: false } }, { FLEET_TELEMETRY: '1' }).telemetryEnabled).toBe(true);
    expect(resolveFlags({}, { FLEET_PERF_TRAY_BUSY: '1' }).trayAnimateOnlyWhenBusy).toBe(true);
    expect(resolveFlags({ perf: { deepScanMatchPool: true } }, { FLEET_PERF_DS_MATCH_POOL: '0' }).deepScanMatchPool).toBe(false);
    expect(resolveFlags({}, { FLEET_PERF_DS_MATCH_POOL: 'maybe' }).deepScanMatchPool).toBe(false);
  });
  it('garbage shapes fall back to defaults', () => {
    const d = { telemetryEnabled: true, trayAnimateOnlyWhenBusy: false, deepScanMatchPool: false };
    expect(resolveFlags(null, null)).toEqual(d);
    expect(resolveFlags({ telemetry: 'x', perf: [true] }, {})).toEqual(d);
    expect(resolveFlags('nope', undefined)).toEqual(d);
  });
  it('load() uses the injected loader and survives a throwing one', () => {
    expect(load({ load: () => ({ perf: { deepScanMatchPool: true } }), env: {} }).deepScanMatchPool).toBe(true);
    expect(load({ load: () => { throw new Error('boom'); }, env: {} }).telemetryEnabled).toBe(true);
  });
  // ── Phase 4: comms poller flags ──
  it('comms defaults: mainProcessPolling off, channelWatchClaims false', () => {
    expect(resolveCommsFlags({}, {})).toEqual({ mainProcessPolling: 'off', channelWatchClaims: false });
    expect(resolveCommsFlags(null, null)).toEqual({ mainProcessPolling: 'off', channelWatchClaims: false });
    expect(resolveCommsFlags({ comms: 'x' }, {})).toEqual({ mainProcessPolling: 'off', channelWatchClaims: false });
    expect(COMMS_POLLING_MODES).toEqual(['off', 'shadow', 'on']);
  });
  it('comms settings modes are normalized; invalid values give off', () => {
    expect(resolveCommsFlags({ comms: { mainProcessPolling: 'shadow' } }, {}).mainProcessPolling).toBe('shadow');
    expect(resolveCommsFlags({ comms: { mainProcessPolling: 'ON ' } }, {}).mainProcessPolling).toBe('on');
    for (const bad of [true, 'yes', 1, null, {}, 'onn']) {
      expect(resolveCommsFlags({ comms: { mainProcessPolling: bad } }, {}).mainProcessPolling).toBe('off');
    }
  });
  it('FLEET_COMMS_POLLING overrides settings; invalid env is ignored', () => {
    expect(resolveCommsFlags({ comms: { mainProcessPolling: 'on' } }, { FLEET_COMMS_POLLING: 'off' }).mainProcessPolling).toBe('off');
    expect(resolveCommsFlags({}, { FLEET_COMMS_POLLING: ' Shadow' }).mainProcessPolling).toBe('shadow');
    expect(resolveCommsFlags({ comms: { mainProcessPolling: 'shadow' } }, { FLEET_COMMS_POLLING: 'bogus' }).mainProcessPolling).toBe('shadow');
    expect(resolveCommsFlags({}, { FLEET_COMMS_POLLING: '1' }).mainProcessPolling).toBe('off');
  });
  it('channelWatchClaims: only literal true enables via settings; env 0/1 overrides', () => {
    expect(resolveCommsFlags({ comms: { channelWatchClaims: true } }, {}).channelWatchClaims).toBe(true);
    expect(resolveCommsFlags({ comms: { channelWatchClaims: 'true' } }, {}).channelWatchClaims).toBe(false);
    expect(resolveCommsFlags({ comms: { channelWatchClaims: 1 } }, {}).channelWatchClaims).toBe(false);
    expect(resolveCommsFlags({}, { FLEET_COMMS_CHANNEL_CLAIMS: '1' }).channelWatchClaims).toBe(true);
    expect(resolveCommsFlags({ comms: { channelWatchClaims: true } }, { FLEET_COMMS_CHANNEL_CLAIMS: '0' }).channelWatchClaims).toBe(false);
    expect(resolveCommsFlags({}, { FLEET_COMMS_CHANNEL_CLAIMS: 'yes' }).channelWatchClaims).toBe(false);
  });
  it('loadComms() uses the injected loader and survives a throwing one', () => {
    expect(loadComms({ load: () => ({ comms: { mainProcessPolling: 'on' } }), env: {} }).mainProcessPolling).toBe('on');
    expect(loadComms({ load: () => { throw new Error('boom'); }, env: {} })).toEqual({ mainProcessPolling: 'off', channelWatchClaims: false });
  });
  it('telemetryRollup is a registered store key (save does not throw, round-trips)', () => {
    const doc = { version: 1, rollups: [{ at: 1 }] };
    expect(() => store.save('telemetryRollup', doc)).not.toThrow();
    expect(store.load('telemetryRollup', null)).toEqual(doc);
  });
});
