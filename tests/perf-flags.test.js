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

const { resolveFlags, load, resolveCommsFlags, loadComms, COMMS_POLLING_MODES,
  resolveSlackSpeedupFlags, loadSlackSpeedup, SPEEDUP_MODES, LANE_CONCURRENCY_MAX } = require('../src/config/perf-flags');
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
  // ── Phase 4b: Slack speed-up flags ──
  const SP_DEFAULTS = { dmPeerCache: false, dmSkipUnchanged: 'off', pmAlertSharedHistory: false, laneConcurrency: 1, laneTierPacing: false, laneFairness: false };
  const sp = (o) => ({ comms: { speedup: o } });
  it('speedup defaults: everything off, K = 1, pacing false', () => {
    expect(resolveSlackSpeedupFlags({}, {})).toEqual(SP_DEFAULTS);
    expect(resolveSlackSpeedupFlags(null, null)).toEqual(SP_DEFAULTS);
    expect(resolveSlackSpeedupFlags({ comms: { speedup: 'x' } }, {})).toEqual(SP_DEFAULTS);
    expect(resolveSlackSpeedupFlags({ comms: { mainProcessPolling: 'on', channelWatchClaims: true } }, {})).toEqual(SP_DEFAULTS);
    expect(SPEEDUP_MODES).toEqual(['off', 'shadow', 'on']);
    expect(LANE_CONCURRENCY_MAX).toBe(4);
  });
  it('speedup settings values are honored', () => {
    expect(resolveSlackSpeedupFlags(sp({ dmPeerCache: true, dmSkipUnchanged: 'shadow', pmAlertSharedHistory: true, laneConcurrency: 3, laneTierPacing: true }), {}))
      .toEqual({ dmPeerCache: true, dmSkipUnchanged: 'shadow', pmAlertSharedHistory: true, laneConcurrency: 3, laneTierPacing: true, laneFairness: false });
    expect(resolveSlackSpeedupFlags(sp({ dmSkipUnchanged: 'ON ' }), {})).toMatchObject({ dmSkipUnchanged: 'on' });
    expect(resolveSlackSpeedupFlags(sp({ dmSkipUnchanged: ' Shadow' }), {})).toMatchObject({ dmSkipUnchanged: 'shadow' });
    // S3 is deferred: a threadReplyReuse setting is not a flag and never appears in the output.
    expect(resolveSlackSpeedupFlags(sp({ threadReplyReuse: 'on' }), { FLEET_SLACK_THREAD_REUSE: 'on' })).toEqual(SP_DEFAULTS);
  });
  it('speedup invalid settings fall back to defaults', () => {
    for (const bad of ['yes', true, 1, null, {}, 'onn']) {
      expect(resolveSlackSpeedupFlags(sp({ dmSkipUnchanged: bad }), {})).toMatchObject({ dmSkipUnchanged: 'off' });
    }
    for (const bad of ['true', 1, 'yes']) {
      expect(resolveSlackSpeedupFlags(sp({ dmPeerCache: bad, pmAlertSharedHistory: bad, laneTierPacing: bad }), {})).toEqual(SP_DEFAULTS);
    }
    for (const bad of [0, 5, '2', 2.5, -1, null, true]) {
      expect(resolveSlackSpeedupFlags(sp({ laneConcurrency: bad }), {}).laneConcurrency).toBe(1);
    }
  });
  it('speedup env overrides win over settings; invalid env is ignored', () => {
    const all = sp({ dmPeerCache: true, dmSkipUnchanged: 'on', pmAlertSharedHistory: true, laneConcurrency: 2, laneTierPacing: true });
    expect(resolveSlackSpeedupFlags(all, {
      FLEET_SLACK_DM_PEER_CACHE: '0', FLEET_SLACK_DM_SKIP_UNCHANGED: 'off',
      FLEET_SLACK_PM_SHARED_HISTORY: '0', FLEET_SLACK_LANE_CONCURRENCY: '4', FLEET_SLACK_LANE_TIER_PACING: '0',
    })).toEqual({ dmPeerCache: false, dmSkipUnchanged: 'off', pmAlertSharedHistory: false, laneConcurrency: 4, laneTierPacing: false, laneFairness: false });
    expect(resolveSlackSpeedupFlags({}, { FLEET_SLACK_DM_PEER_CACHE: '1', FLEET_SLACK_PM_SHARED_HISTORY: '1', FLEET_SLACK_LANE_TIER_PACING: '1', FLEET_SLACK_DM_SKIP_UNCHANGED: ' On ' }))
      .toMatchObject({ dmPeerCache: true, pmAlertSharedHistory: true, laneTierPacing: true, dmSkipUnchanged: 'on' });
    const bogus = { FLEET_SLACK_DM_PEER_CACHE: 'yes', FLEET_SLACK_DM_SKIP_UNCHANGED: 'maybe',
      FLEET_SLACK_PM_SHARED_HISTORY: 'true', FLEET_SLACK_LANE_CONCURRENCY: '5', FLEET_SLACK_LANE_TIER_PACING: 'on' };
    expect(resolveSlackSpeedupFlags(all, bogus)).toEqual(resolveSlackSpeedupFlags(all, {}));
    for (const k of ['0', '2.5', 'two', '-1', '']) expect(resolveSlackSpeedupFlags(all, { FLEET_SLACK_LANE_CONCURRENCY: k }).laneConcurrency).toBe(2);
    expect(resolveSlackSpeedupFlags({}, { FLEET_SLACK_LANE_CONCURRENCY: ' 3 ' }).laneConcurrency).toBe(3);
  });
  it('laneFairness: default off; only settings === true; env \'1\'/\'0\' wins; other env ignored', () => {
    expect(resolveSlackSpeedupFlags({}, {}).laneFairness).toBe(false);
    expect(resolveSlackSpeedupFlags(sp({ laneFairness: true }), {}).laneFairness).toBe(true);
    for (const bad of ['true', 1, 'yes', null, {}]) expect(resolveSlackSpeedupFlags(sp({ laneFairness: bad }), {}).laneFairness).toBe(false);
    expect(resolveSlackSpeedupFlags({}, { FLEET_SLACK_LANE_FAIRNESS: '1' }).laneFairness).toBe(true);
    expect(resolveSlackSpeedupFlags(sp({ laneFairness: true }), { FLEET_SLACK_LANE_FAIRNESS: '0' }).laneFairness).toBe(false);
    for (const bad of ['yes', 'true', 'on', '2', '']) {
      expect(resolveSlackSpeedupFlags({}, { FLEET_SLACK_LANE_FAIRNESS: bad }).laneFairness).toBe(false);
      expect(resolveSlackSpeedupFlags(sp({ laneFairness: true }), { FLEET_SLACK_LANE_FAIRNESS: bad }).laneFairness).toBe(true);
    }
    expect(loadSlackSpeedup({ load: () => sp({ laneFairness: true }), env: {} }).laneFairness).toBe(true);
  });
  it('loadSlackSpeedup() uses the injected loader and survives a throwing one', () => {
    expect(loadSlackSpeedup({ load: () => sp({ dmPeerCache: true }), env: {} }).dmPeerCache).toBe(true);
    expect(loadSlackSpeedup({ load: () => { throw new Error('boom'); }, env: {} })).toEqual(SP_DEFAULTS);
  });
  it('resolveCommsFlags output is unchanged by the speedup block', () => {
    expect(resolveCommsFlags(sp({ dmPeerCache: true, laneConcurrency: 3 }), {})).toEqual({ mainProcessPolling: 'off', channelWatchClaims: false });
  });
  describe('ai.aki flags', () => {
    const { resolveAiAkiFlags, loadAiAki, AKI_DEFAULTS } = require('../src/config/perf-flags');
    const ak = (o) => ({ ai: { aki: o } });
    it('defaults: enabled ON, allowUntrusted off, empty profile/model, concurrency 2, timeout 120 s', () => {
      expect(resolveAiAkiFlags({}, {})).toEqual({ enabled: true, allowUntrusted: false, profile: '', model: '', concurrency: 2, timeoutMs: 120000 });
      expect(resolveAiAkiFlags({}, {})).toEqual({ ...AKI_DEFAULTS });
      expect(resolveAiAkiFlags(null, null)).toEqual({ ...AKI_DEFAULTS });
    });
    it('enabled: only === false disables; env \'0\' forces off, \'1\' forces on, junk ignored', () => {
      expect(resolveAiAkiFlags(ak({ enabled: false }), {}).enabled).toBe(false);
      for (const v of [true, 'false', 0, null, undefined]) expect(resolveAiAkiFlags(ak({ enabled: v }), {}).enabled).toBe(true);
      expect(resolveAiAkiFlags({}, { FLEET_AI_AKI: '0' }).enabled).toBe(false);
      expect(resolveAiAkiFlags(ak({ enabled: false }), { FLEET_AI_AKI: '1' }).enabled).toBe(true);
      expect(resolveAiAkiFlags(ak({ enabled: false }), { FLEET_AI_AKI: 'yes' }).enabled).toBe(false);
    });
    it('allowUntrusted only on === true', () => {
      expect(resolveAiAkiFlags(ak({ allowUntrusted: true }), {}).allowUntrusted).toBe(true);
      for (const v of ['true', 1, 'yes', {}, null]) expect(resolveAiAkiFlags(ak({ allowUntrusted: v }), {}).allowUntrusted).toBe(false);
    });
    it('concurrency 1..4 and timeoutMs 10000..600000 integers, else defaults', () => {
      expect(resolveAiAkiFlags(ak({ concurrency: 1, timeoutMs: 10000 }), {})).toMatchObject({ concurrency: 1, timeoutMs: 10000 });
      expect(resolveAiAkiFlags(ak({ concurrency: 4, timeoutMs: 600000 }), {})).toMatchObject({ concurrency: 4, timeoutMs: 600000 });
      for (const bad of [0, 5, 2.5, '3', -1, null]) expect(resolveAiAkiFlags(ak({ concurrency: bad }), {}).concurrency).toBe(2);
      for (const bad of [9999, 600001, 30000.5, '60000', null]) expect(resolveAiAkiFlags(ak({ timeoutMs: bad }), {}).timeoutMs).toBe(120000);
    });
    it('profile/model validated, invalid -> \'\'', () => {
      expect(resolveAiAkiFlags(ak({ profile: 'fleet-specialist', model: 'claude/opus-4.1:v2' }), {}))
        .toMatchObject({ profile: 'fleet-specialist', model: 'claude/opus-4.1:v2' });
      for (const bad of ['-x', 'a b', 'a'.repeat(101), '', 'x;rm', 5, null]) {
        expect(resolveAiAkiFlags(ak({ profile: bad, model: bad }), {})).toMatchObject({ profile: '', model: '' });
      }
      expect(resolveAiAkiFlags(ak({ profile: 'a'.repeat(100) }), {}).profile).toBe('a'.repeat(100));
    });
    it('loadAiAki uses the injected loader and survives a throwing one', () => {
      expect(loadAiAki({ load: () => ak({ concurrency: 3 }), env: {} }).concurrency).toBe(3);
      expect(loadAiAki({ load: () => { throw new Error('boom'); }, env: {} })).toEqual({ ...AKI_DEFAULTS });
    });
  });
  it('telemetryRollup is a registered store key (save does not throw, round-trips)', () => {
    const doc = { version: 1, rollups: [{ at: 1 }] };
    expect(() => store.save('telemetryRollup', doc)).not.toThrow();
    expect(store.load('telemetryRollup', null)).toEqual(doc);
  });
});
