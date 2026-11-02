// tests/slack-poller-ipc.test.js — Phase 4: src/ipc/slack.js poll handlers
// routed through src/slack/poller.js, plus the guarded legacy fallback when the
// poller cannot load (T-F1a). Harness: fake electron.ipcMain in require.cache
// (pattern of tests/telemetry-ipc.test.js), isolated data dir, fake engines,
// fake slack_send and cluster. No Electron, no network, no real Slack.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'slack-poller-ipc-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const injected = [];
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  injected.push([resolved, require.cache[resolved]]);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// Recording logger factory (so the once-per-process error line is observable).
const logLines = [];
const fakeLogger = (tag) => {
  const mk = (level) => (...a) => { logLines.push({ tag, level, msg: a.map(String).join(' ') }); };
  return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), log: mk('info') };
};
Object.assign(fakeLogger, { createLogger: fakeLogger, setLogDir() {}, setLevel() {}, setSilent() {}, LEVELS: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } });
injectFake('../src/utils/logger', fakeLogger);

const handlers = {};
injectFake('electron', {
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  BrowserWindow: function () {}, session: { defaultSession: {}, fromPartition: () => ({}) }, shell: {},
});

const cw = {
  pollChannelsOnce: vi.fn(),
  saveWatchConfig: vi.fn((c) => ({ ok: true, config: c })),
  isPollInFlight: () => false,
};
const dm = { pollDMAutoReplyOnce: vi.fn(), isPollInFlight: () => false };
const ss = { readDMs: vi.fn(), isAuthenticated: vi.fn(() => true) };
const cluster = { mayRunProduction: vi.fn(() => true) };
injectFake('../src/scrapers/slack_channel_watch', cw);
injectFake('../src/scrapers/slack_dm_autoreply', dm);
injectFake('../src/scrapers/slack_send', ss);
injectFake('../src/cluster', cluster);

const telemetry = require('../src/telemetry');
const pollerPath = require.resolve('../src/slack/poller');
const pollerMod = require('../src/slack/poller');
const ctx = { send: vi.fn(), pushBubbleNotification: vi.fn() };
require('../src/ipc/slack').registerSlackIPC(ctx);

const STANDBY = 'standby — not the production leader';
const EV = {};
let trackSpy;

function resetFakes() {
  cw.pollChannelsOnce.mockReset().mockImplementation(async (log) => { log('[SlackWatch] tick'); return { repliedCount: 1, escalatedCount: 0, items: [] }; });
  dm.pollDMAutoReplyOnce.mockReset().mockImplementation(async () => ({
    repliedCount: 0, escalatedCount: 2,
    items: [{ channelName: 'Alice', title: 'Need ETA' }, { question: 'Where is unit 5?' }],
  }));
  ss.readDMs.mockReset().mockImplementation(async () => [{ ts: '100.1', text: 'hi' }]);
  cluster.mayRunProduction.mockReset().mockReturnValue(true);
  ctx.send.mockReset();
  ctx.pushBubbleNotification.mockReset();
  if (trackSpy) trackSpy.mockRestore();
  trackSpy = vi.spyOn(telemetry, 'track');
  telemetry._resetForTests();
  logLines.length = 0;
}

// Drive one full scenario through the three handlers and capture outputs +
// observable side effects, so off and legacy can be compared deep-equal.
async function scenario() {
  const out = {};
  out.readDms = await handlers['slack:read-dms'](EV);
  out.readDmsArgs = ss.readDMs.mock.calls.map((c) => c);
  out.channelWatch = await handlers['slack:poll-channel-watch'](EV);
  out.dmAutoReply = await handlers['slack:poll-dm-autoreply'](EV);
  out.bubbles = ctx.pushBubbleNotification.mock.calls.map((c) => c[0]);
  cluster.mayRunProduction.mockReturnValue(false);
  out.cwStandby = await handlers['slack:poll-channel-watch'](EV);
  out.dmStandby = await handlers['slack:poll-dm-autoreply'](EV);
  cluster.mayRunProduction.mockReturnValue(true);
  out.trackNames = trackSpy.mock.calls.map((c) => c[0]);
  out.skipOpts = trackSpy.mock.calls.map((c) => [c[2].skip({ _skipped: true }), c[2].skip({ repliedCount: 1 })]);
  out.engineCalls = { cw: cw.pollChannelsOnce.mock.calls.length, dm: dm.pollDMAutoReplyOnce.mock.calls.length, readDMs: ss.readDMs.mock.calls.length };
  out.engineLogTag = logLines.filter((l) => l.msg === '[SlackWatch] tick').map((l) => [l.tag, l.level]);
  out.sends = ctx.send.mock.calls.map((c) => c);
  return out;
}

const EXPECTED_TODAY = {
  readDms: [{ ts: '100.1', text: 'hi' }],
  readDmsArgs: [[20]],
  channelWatch: { repliedCount: 1, escalatedCount: 0, items: [] },
  dmAutoReply: { repliedCount: 0, escalatedCount: 2, items: [{ channelName: 'Alice', title: 'Need ETA' }, { question: 'Where is unit 5?' }] },
  bubbles: [
    { title: 'Slack DM: Alice', message: 'Need ETA', kind: 'slack-dm' },
    { title: 'Slack DM: Unknown', message: 'Where is unit 5?', kind: 'slack-dm' },
  ],
  cwStandby: { skipped: STANDBY },
  dmStandby: { skipped: STANDBY },
  trackNames: ['slack.pollChannelWatch', 'slack.pollDmAutoReply'],
  skipOpts: [[true, false], [true, false]],
  engineCalls: { cw: 1, dm: 1, readDMs: 1 },
  engineLogTag: [['ipc:slack', 'info']],
  sends: [],
};

const savedEnv = process.env.FLEET_COMMS_POLLING;
beforeEach(() => {
  delete process.env.FLEET_COMMS_POLLING;
  pollerMod._resetForTests();
  resetFakes();
});
afterAll(() => {
  pollerMod._resetForTests();
  if (savedEnv === undefined) delete process.env.FLEET_COMMS_POLLING; else process.env.FLEET_COMMS_POLLING = savedEnv;
  if (trackSpy) trackSpy.mockRestore();
  for (const [p, prev] of injected.reverse()) { if (prev) require.cache[p] = prev; else delete require.cache[p]; }
});

describe('slack IPC poll handlers via the poller', () => {
  it('registers slack:get-poller-status next to the three poll handlers', () => {
    for (const ch of ['slack:read-dms', 'slack:poll-channel-watch', 'slack:poll-dm-autoreply', 'slack:get-poller-status']) {
      expect(typeof handlers[ch]).toBe('function');
    }
  });

  it('off (flag unset): outputs and side effects deep-equal today\'s handlers', async () => {
    const out = await scenario();
    expect(out).toEqual(EXPECTED_TODAY);
    expect(pollerMod.getMode()).toBe('off');
    // renderer calls in off are not recorded
    const st = await handlers['slack:get-poller-status'](EV);
    expect(st.polls.channelWatch.renderer).toEqual({ calls: 0, rejected: 0, lastAt: null });
  });

  it('off: poller.start arms nothing', () => {
    const setSpy = vi.spyOn(global, 'setTimeout');
    expect(pollerMod.start(ctx)).toEqual({ started: false, mode: 'off' });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it('slack:get-poller-status shape', async () => {
    const st = await handlers['slack:get-poller-status'](EV);
    expect(st).toMatchObject({ mode: 'off', configuredMode: 'off', startError: null, flags: { mainProcessPolling: 'off', channelWatchClaims: false } });
    expect(Object.keys(st.polls).sort()).toEqual(['channelWatch', 'dmAutoReply', 'dmNotify']);
    expect(st.polls.channelWatch).toMatchObject({ intervalMs: 10000, runs: 0, fails: 0, inFlight: false });
    expect(st).toHaveProperty('owaTriage');
  });

  it('save-channel-watch-config notifies the poller after the renderer push', async () => {
    const spy = vi.spyOn(pollerMod, 'onConfigUpdated');
    const r = await handlers['slack:save-channel-watch-config'](EV, { enabled: true });
    expect(r).toEqual({ ok: true, config: { enabled: true } });
    expect(ctx.send).toHaveBeenCalledWith('slack:config-updated', { type: 'channel-watch' });
    expect(spy).toHaveBeenCalledWith('channel-watch');
    spy.mockRestore();
  });

  it('on: two concurrent renderer poll-channel-watch calls are both inert, 0 engine calls', async () => {
    process.env.FLEET_COMMS_POLLING = 'on';
    pollerMod._resetForTests();
    const [a, b] = await Promise.all([
      handlers['slack:poll-channel-watch'](EV),
      handlers['slack:poll-channel-watch'](EV),
    ]);
    const inert = { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true, skipped: 'main-process poller owns polling' };
    expect(a).toEqual(inert);
    expect(b).toEqual(inert);
    expect(await handlers['slack:read-dms'](EV)).toEqual([]);
    expect(cw.pollChannelsOnce).not.toHaveBeenCalled();
    expect(ss.readDMs).not.toHaveBeenCalled();
    const st = await handlers['slack:get-poller-status'](EV);
    expect(st.mode).toBe('on');
    expect(st.polls.channelWatch.renderer.rejected).toBe(2);
    pollerMod._resetForTests();
  });
});

describe('T-F1a: poller unavailable -> legacy handler bodies', () => {
  it('a throwing poller module keeps today\'s outputs; status reports unavailable; error logged once', async () => {
    const prev = require.cache[pollerPath];
    const entry = { id: pollerPath, filename: pollerPath, loaded: true };
    Object.defineProperty(entry, 'exports', { get() { throw new Error('poller load boom'); } });
    require.cache[pollerPath] = entry;
    try {
      const out = await scenario();
      expect(out).toEqual(EXPECTED_TODAY);
      expect(await handlers['slack:get-poller-status'](EV)).toEqual({ mode: 'off', unavailable: true });
      // save-channel-watch-config still works
      expect(await handlers['slack:save-channel-watch-config'](EV, { enabled: false })).toEqual({ ok: true, config: { enabled: false } });
      await handlers['slack:read-dms'](EV);
      const errs = logLines.filter((l) => l.level === 'error' && l.msg.includes('[SlackPoller] unavailable, using legacy handlers: poller load boom'));
      expect(errs.length).toBe(1);
      expect(errs[0].tag).toBe('ipc:slack');
    } finally {
      if (prev) require.cache[pollerPath] = prev; else delete require.cache[pollerPath];
    }
  });
});
