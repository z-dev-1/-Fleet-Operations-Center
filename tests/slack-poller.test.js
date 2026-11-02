// tests/slack-poller.test.js — Phase 4 main-process comms poller
// (src/slack/poller.js). createPoller() with a fake scheduler/clock, spy
// engines, spy track and spy ctx.send. No Electron, no network, no real Slack.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'slack-poller-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const pollerMod = require('../src/slack/poller');
const { createPoller, POLL_SPECS, NOT_AUTHED } = pollerMod;

const STANDBY = 'standby — not the production leader';

// ── Fake scheduler + clock ──────────────────────────────────────────────────
function makeClock(opts = {}) {
  let t = 0;
  let seq = 0;
  let calls = 0;
  const timers = new Map();
  const created = [];
  const setTimeout = vi.fn((fn, ms) => {
    calls++;
    if (opts.throwOnCall && calls === opts.throwOnCall) throw new Error('scheduler boom');
    const h = { id: ++seq, at: t + ms, ms, fn, unref: vi.fn() };
    timers.set(h.id, h);
    created.push(h);
    return h;
  });
  const clearTimeout = vi.fn((h) => { if (h) timers.delete(h.id); });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      let next = null;
      for (const h of timers.values()) {
        if (h.at <= end && (!next || h.at < next.at || (h.at === next.at && h.id < next.id))) next = h;
      }
      if (!next) break;
      t = next.at;
      timers.delete(next.id);
      next.fn();
      await flush();
    }
    t = end;
    await flush();
  }
  return { setTimeout, clearTimeout, now: () => t, advance, flush, timers, created, pending: () => timers.size };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okResult = () => ({ repliedCount: 0, escalatedCount: 0, items: [] });

function makeHarness(mode, over = {}) {
  const clock = over.clock || makeClock();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engineLog = vi.fn();
  const engines = {
    channelWatch: vi.fn(async () => okResult()),
    dmAutoReply: vi.fn(async () => okResult()),
    dmNotify: vi.fn(async () => []),
  };
  const track = vi.fn((name, fn) => fn());
  const send = vi.fn();
  const pushBubbleNotification = vi.fn();
  const ctx = { send, pushBubbleNotification };
  const deps = {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
    loadFlags: () => ({ mainProcessPolling: mode, channelWatchClaims: false }),
    mayPollSlack: vi.fn(() => true),
    track, engines,
    inFlight: { channelWatch: vi.fn(() => false), dmAutoReply: vi.fn(() => false) },
    isSlackConfigured: vi.fn(() => true),
    readRaw: vi.fn(() => null),
    logger, engineLog,
    owaStatus: () => null,
  };
  Object.assign(deps, over.deps || {});
  if (over.engines) Object.assign(engines, over.engines);
  const poller = createPoller(deps);
  return { poller, clock, logger, engineLog, engines, track, send, pushBubbleNotification, ctx, deps };
}

const lines = (spy, needle) => spy.mock.calls.filter((c) => String(c[0]).includes(needle));
const pushes = (send, ch) => send.mock.calls.filter((c) => c[0] === ch);

afterEach(() => { vi.restoreAllMocks(); });

describe('POLL_SPECS', () => {
  it('copies the renderer cadence and telemetry names', () => {
    expect(POLL_SPECS.dmNotify).toMatchObject({ intervalMs: 30000, firstDelayMs: 3000, trackName: 'slack.readDmsNotify', stallWarnMs: 120000 });
    expect(POLL_SPECS.channelWatch).toMatchObject({ intervalMs: 10000, firstDelayMs: 4000, trackName: 'slack.pollChannelWatch', stallWarnMs: 300000 });
    expect(POLL_SPECS.dmAutoReply).toMatchObject({ intervalMs: 30000, firstDelayMs: 4000, trackName: 'slack.pollDmAutoReply', stallWarnMs: 300000 });
    expect(Object.isFrozen(NOT_AUTHED)).toBe(true);
    expect(NOT_AUTHED).toEqual([]);
  });
});

describe('1. off mode', () => {
  it('start arms no timers; renderer calls run today\'s gate -> track -> engine', async () => {
    const h = makeHarness('off');
    expect(h.poller.start(h.ctx)).toEqual({ started: false, mode: 'off' });
    expect(h.clock.pending()).toBe(0);

    const r1 = await h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx });
    expect(r1).toEqual(okResult());
    expect(h.deps.mayPollSlack).toHaveBeenCalledTimes(1);
    expect(h.track).toHaveBeenCalledTimes(1);
    const [name, , opts] = h.track.mock.calls[0];
    expect(name).toBe('slack.pollChannelWatch');
    expect(opts.skip({ _skipped: true })).toBe(true);
    expect(opts.skip({ repliedCount: 1 })).toBe(false);
    expect(h.engines.channelWatch).toHaveBeenCalledWith(h.engineLog);

    const items = [{ channelName: 'Alice', title: 'Q1' }, { question: 'Q2' }, {}];
    h.engines.dmAutoReply.mockResolvedValueOnce({ repliedCount: 0, escalatedCount: 3, items });
    const r2 = await h.poller.runPoll('dmAutoReply', { origin: 'renderer', ctx: h.ctx });
    expect(r2.items).toBe(items);
    expect(h.track.mock.calls[1][0]).toBe('slack.pollDmAutoReply');
    expect(h.track.mock.calls[1][2].skip({ _skipped: true })).toBe(true);
    expect(h.pushBubbleNotification.mock.calls.map((c) => c[0])).toEqual([
      { title: 'Slack DM: Alice', message: 'Q1', kind: 'slack-dm' },
      { title: 'Slack DM: Unknown', message: 'Q2', kind: 'slack-dm' },
      { title: 'Slack DM: Unknown', message: 'New message needs your reply', kind: 'slack-dm' },
    ]);

    h.engines.dmNotify.mockResolvedValueOnce([{ ts: '1' }]);
    const gateCalls = h.deps.mayPollSlack.mock.calls.length;
    expect(await h.poller.runPoll('dmNotify', { origin: 'renderer', ctx: h.ctx })).toEqual([{ ts: '1' }]);
    expect(h.deps.mayPollSlack.mock.calls.length).toBe(gateCalls); // ungated
    expect(h.track.mock.calls.filter((c) => c[0] === 'slack.readDmsNotify').length).toBe(0);
    expect(h.deps.isSlackConfigured).not.toHaveBeenCalled();

    const st = h.poller.getStatus();
    expect(st.mode).toBe('off');
    for (const k of ['channelWatch', 'dmAutoReply', 'dmNotify']) {
      expect(st.polls[k].renderer).toEqual({ calls: 0, rejected: 0, lastAt: null });
      expect(st.polls[k].runs).toBe(0);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a bubble push that throws does not affect the result or later items', async () => {
    const h = makeHarness('off');
    h.pushBubbleNotification.mockImplementationOnce(() => { throw new Error('gone'); });
    h.engines.dmAutoReply.mockResolvedValueOnce({ escalatedCount: 2, items: [{ title: 'a' }, { title: 'b' }] });
    const r = await h.poller.runPoll('dmAutoReply', { origin: 'renderer', ctx: h.ctx });
    expect(r.items.length).toBe(2);
    expect(h.pushBubbleNotification).toHaveBeenCalledTimes(2);
  });

  it('telemetry snapshot has no comms section for the real singleton in off', () => {
    const prev = process.env.FLEET_COMMS_POLLING;
    delete process.env.FLEET_COMMS_POLLING;
    try {
      pollerMod._resetForTests();
      expect(pollerMod.getMode()).toBe('off');
      expect(pollerMod.start({ send: vi.fn() })).toEqual({ started: false, mode: 'off' });
      const telemetry = require('../src/telemetry');
      expect('comms' in telemetry.snapshot()).toBe(false);
    } finally {
      pollerMod._resetForTests();
      if (prev === undefined) delete process.env.FLEET_COMMS_POLLING; else process.env.FLEET_COMMS_POLLING = prev;
    }
  });
});

describe('2. off, standby', () => {
  it('returns today\'s standby shape and does not call the engine', async () => {
    const h = makeHarness('off');
    h.deps.mayPollSlack.mockReturnValue(false);
    expect(await h.poller.runPoll('channelWatch', { origin: 'renderer' })).toEqual({ skipped: STANDBY });
    expect(await h.poller.runPoll('dmAutoReply', { origin: 'renderer' })).toEqual({ skipped: STANDBY });
    expect(h.engines.channelWatch).not.toHaveBeenCalled();
    expect(h.engines.dmAutoReply).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
  });
});

describe('3. shadow mode', () => {
  it('10 min of ticks: zero engine/track/send/store-write/inbound-claim calls', async () => {
    const store = require('../src/store');
    const claim = require('../src/orcha/fas/inbound-claim');
    const saveSpy = vi.spyOn(store, 'save');
    const updateSpy = vi.spyOn(store, 'update');
    const claimSpies = ['acquire', 'markOwnedQueued', 'markDelivered', 'markFailed', 'transferToLegacy', 'release', 'reconcile']
      .filter((fn) => typeof claim[fn] === 'function')
      .map((fn) => vi.spyOn(claim, fn));
    expect(claimSpies.length).toBeGreaterThan(0);
    // Real read-only store access through readRaw (store.load), nothing else.
    const readRaw = vi.fn((key) => store.load(key, null));
    const h = makeHarness('shadow', { deps: { readRaw } });
    expect(h.poller.start(h.ctx)).toEqual({ started: true, mode: 'shadow' });
    await h.clock.advance(10 * 60 * 1000);
    for (const k of ['channelWatch', 'dmAutoReply', 'dmNotify']) expect(h.engines[k]).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.pushBubbleNotification).not.toHaveBeenCalled();
    expect(readRaw).toHaveBeenCalled();
    expect(readRaw.mock.calls.map((c) => c[0]).every((k) => k === 'slackChannelWatchConfig' || k === 'slackDMAutoReplyConfig')).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    for (const s of claimSpies) expect(s).not.toHaveBeenCalled();
    const st = h.poller.getStatus();
    // channel grid: 4 s, then every 10 s up to 600 s -> 60 plans
    expect(st.polls.channelWatch.shadow.wouldRun).toBe(60);
    expect(st.polls.channelWatch.shadow.enabled).toBe('default');
    h.poller.stop();
  });

  it('wouldRun / wouldSkip follow mayPollSlack, inFlight and the enabled flag', () => {
    const h = makeHarness('shadow');
    h.poller._shadowPlanForTests('channelWatch');
    h.deps.inFlight.channelWatch.mockReturnValue(true);
    h.poller._shadowPlanForTests('channelWatch');
    h.deps.mayPollSlack.mockReturnValue(false);
    h.poller._shadowPlanForTests('channelWatch');
    h.deps.mayPollSlack.mockReturnValue(true);
    h.deps.inFlight.dmAutoReply.mockReturnValue(false);
    h.deps.readRaw.mockReturnValue({ enabled: false });
    h.poller._shadowPlanForTests('dmAutoReply');
    const st = h.poller.getStatus().polls;
    expect(st.channelWatch.shadow.wouldRun).toBe(1);
    expect(st.channelWatch.shadow.wouldSkip).toMatchObject({ busy: 1, standby: 1 });
    expect(st.dmAutoReply.shadow.wouldSkip.disabled).toBe(1);
    expect(st.dmAutoReply.shadow.enabled).toBe(false);
  });

  it('dmNotify plan consults only isSlackConfigured and keeps ticking on its 30 s grid', async () => {
    const h = makeHarness('shadow');
    h.poller._shadowPlanForTests('dmNotify');
    expect(h.deps.isSlackConfigured).toHaveBeenCalledTimes(1);
    expect(h.deps.mayPollSlack).not.toHaveBeenCalled();
    expect(h.deps.inFlight.channelWatch).not.toHaveBeenCalled();
    expect(h.deps.inFlight.dmAutoReply).not.toHaveBeenCalled();
    expect(h.deps.readRaw).not.toHaveBeenCalled();

    const h2 = makeHarness('shadow');
    let n = 0;
    h2.deps.isSlackConfigured.mockImplementation(() => (n++ % 2 === 0));
    h2.poller.start(h2.ctx);
    await h2.clock.advance(10 * 60 * 1000);
    const s = h2.poller.getStatus().polls.dmNotify.shadow;
    expect(s.wouldRun + s.wouldSkip.notAuthed).toBe(20);
    expect(s.wouldSkip.notAuthed).toBeGreaterThan(0);
    expect(h2.logger.error).not.toHaveBeenCalled();
    h2.poller.stop();
  });

  it('a throwing plan counts shadow.errors and the timer is still re-armed', async () => {
    const h = makeHarness('shadow');
    h.deps.readRaw.mockImplementation(() => { throw new Error('read boom'); });
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    const st = h.poller.getStatus().polls.channelWatch;
    expect(st.shadow.errors).toBe(1);
    expect(st.nextRunAt).toBe(14000);
    expect([...h.clock.timers.values()].filter((t) => t.at === 14000).length).toBe(1);
    expect(lines(h.logger.warn, 'channelWatch plan error').length).toBe(1);
    await h.clock.advance(10000);
    expect(h.poller.getStatus().polls.channelWatch.shadow.errors).toBe(2);
    expect(lines(h.logger.warn, 'channelWatch plan error').length).toBe(1); // rate limited
    h.poller.stop();
  });

  it('renderer-origin calls still run the engine and are recorded', async () => {
    const h = makeHarness('shadow');
    await h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx });
    await h.poller.runPoll('dmNotify', { origin: 'renderer', ctx: h.ctx });
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    expect(h.engines.dmNotify).toHaveBeenCalledTimes(1);
    const st = h.poller.getStatus().polls;
    expect(st.channelWatch.renderer.calls).toBe(1);
    expect(st.channelWatch.renderer.lastAt).toBe(0);
    expect(st.dmNotify.renderer.calls).toBe(1);
    // Main-origin in shadow is inert (defense in depth)
    expect(await h.poller.runPoll('channelWatch', { origin: 'main' })).toMatchObject({ _skipped: true });
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
  });

  it('logs one first-plan line per kind, then a 5-min summary', async () => {
    const h = makeHarness('shadow');
    h.poller.start(h.ctx);
    await h.clock.advance(6 * 60 * 1000);
    expect(lines(h.logger.info, '[SlackPoller][shadow] channelWatch first plan').length).toBe(1);
    expect(lines(h.logger.info, '[SlackPoller][shadow] channelWatch 5m:').length).toBe(1);
    h.poller.stop();
  });
});

describe('4. on, cadence', () => {
  it('first delays are 3 s / 4 s / 4 s and tick timers are unref\'d', () => {
    const h = makeHarness('on');
    expect(h.poller.start(h.ctx)).toEqual({ started: true, mode: 'on' });
    expect(h.clock.created.map((t) => t.ms)).toEqual([3000, 4000, 4000]);
    for (const t of h.clock.created) expect(t.unref).toHaveBeenCalled();
    h.poller.stop();
  });

  for (const [kind, interval, expectedNext, expectedCoalesced, first] of [
    ['channelWatch', 10000, 9000, 10, 4000],
    ['dmAutoReply', 30000, 19000, 3, 4000],
    ['dmNotify', 30000, 19000, 3, 3000],
  ]) {
    it(`${kind}: single in flight, grid-preserving next run, coalesced counting`, async () => {
      const h = makeHarness('on');
      const ds = [];
      h.engines[kind].mockImplementation(() => { const d = deferred(); ds.push(d); return d.promise; });
      h.poller.start(h.ctx);
      await h.clock.advance(first);
      expect(h.engines[kind]).toHaveBeenCalledTimes(1);
      await h.clock.advance(101000);
      expect(h.engines[kind]).toHaveBeenCalledTimes(1); // nothing while in flight
      ds[0].resolve(kind === 'dmNotify' ? [] : okResult());
      await h.clock.flush();
      const st = h.poller.getStatus().polls[kind];
      expect(st.skipped.coalesced).toBe(expectedCoalesced);
      expect(st.lastDurationMs).toBe(101000);
      expect(st.nextRunAt).toBe(first + 101000 + expectedNext);
      expect(st.intervalMs).toBe(interval);
      expect(lines(h.logger.warn, `[SlackPoller] ${kind} run took 101.0s`).length).toBe(1);
      await h.clock.advance(expectedNext);
      expect(h.engines[kind]).toHaveBeenCalledTimes(2);
      // a second overrun within 5 min is suppressed
      await h.clock.advance(interval + 1000);
      ds[1].resolve(kind === 'dmNotify' ? [] : okResult());
      await h.clock.flush();
      expect(lines(h.logger.warn, `[SlackPoller] ${kind} run took`).length).toBe(1);
      h.poller.stop();
    });
  }

  it('channelWatch: 120 s with one never-ending run -> exactly one engine call', async () => {
    const h = makeHarness('on');
    h.engines.channelWatch.mockImplementation(() => new Promise(() => {}));
    h.poller.start(h.ctx);
    await h.clock.advance(120000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    h.poller.stop();
  });
});

describe('5. on, owner gate', () => {
  it('two concurrent renderer calls are both inert; renderer.rejected === 2; main tick still runs', async () => {
    const h = makeHarness('on');
    h.poller.start(h.ctx);
    const [a, b] = await Promise.all([
      h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx }),
      h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx }),
    ]);
    const inert = { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true, skipped: 'main-process poller owns polling' };
    expect(a).toEqual(inert);
    expect(b).toEqual(inert);
    expect(await h.poller.runPoll('dmNotify', { origin: 'renderer' })).toEqual([]);
    expect(h.engines.channelWatch).not.toHaveBeenCalled();
    expect(h.engines.dmNotify).not.toHaveBeenCalled();
    expect(h.deps.mayPollSlack).not.toHaveBeenCalled();
    expect(h.poller.getStatus().polls.channelWatch.renderer.rejected).toBe(2);
    expect(lines(h.logger.debug, 'renderer channelWatch call rejected').length).toBe(1); // <= 1/min
    await h.clock.advance(4000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    h.poller.stop();
  });
});

describe('6. on, push', () => {
  it('pushes slack:poll-result only for actionable results', async () => {
    const h = makeHarness('on');
    const esc = { repliedCount: 0, escalatedCount: 2, items: [{ title: 'x' }] };
    h.engines.channelWatch.mockResolvedValueOnce(esc);
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    const p = pushes(h.send, 'slack:poll-result');
    expect(p.length).toBe(1);
    expect(p[0][1]).toEqual({ kind: 'channelWatch', at: 4000, result: esc });
    // escalatedCount 0 (dmAutoReply) and empty dmNotify -> no push
    expect(h.engines.dmAutoReply).toHaveBeenCalledTimes(1);
    expect(h.engines.dmNotify).toHaveBeenCalledTimes(1);
    await h.clock.advance(10000);
    expect(pushes(h.send, 'slack:poll-result').length).toBe(1);
    h.engines.dmNotify.mockResolvedValueOnce([{ ts: '1' }]);
    await h.clock.advance(30000);
    const p2 = pushes(h.send, 'slack:poll-result');
    expect(p2.length).toBe(2);
    expect(p2[1][1]).toMatchObject({ kind: 'dmNotify', result: [{ ts: '1' }] });
    h.poller.stop();
  });
});

describe('7. on, failures and classify', () => {
  it('engine throw: fails++, warn, next tick still scheduled', async () => {
    const h = makeHarness('on');
    h.engines.channelWatch.mockRejectedValueOnce(new Error('boom'));
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    const st = h.poller.getStatus().polls.channelWatch;
    expect(st.fails).toBe(1);
    expect(st.lastError).toBe('boom');
    expect(st.nextRunAt).toBe(14000);
    expect(lines(h.logger.warn, 'channelWatch run failed: boom').length).toBe(1);
    h.poller.stop();
  });

  it('identical errors are rate limited (+N suppressed), a new message warns at once, recovery logs once', async () => {
    const h = makeHarness('on');
    h.engines.dmAutoReply.mockImplementation(async () => { throw new Error('same'); });
    h.poller.start(h.ctx);
    await h.clock.advance(274000); // ticks at 4,34,...,274 s -> 10 failures
    expect(h.poller.getStatus().polls.dmAutoReply.fails).toBe(10);
    expect(lines(h.logger.warn, 'dmAutoReply run failed').length).toBe(1);
    await h.clock.advance(30000); // 304 s: 5 min after the first warn
    const w = lines(h.logger.warn, 'dmAutoReply run failed');
    expect(w.length).toBe(2);
    expect(w[1][0]).toContain('+9 suppressed');
    h.engines.dmAutoReply.mockImplementation(async () => { throw new Error('different'); });
    await h.clock.advance(30000);
    expect(lines(h.logger.warn, 'dmAutoReply run failed: different').length).toBe(1);
    h.engines.dmAutoReply.mockImplementation(async () => okResult());
    await h.clock.advance(30000);
    await h.clock.advance(30000);
    expect(lines(h.logger.info, 'dmAutoReply recovered after 12 failure(s)').length).toBe(1);
    expect(lines(h.logger.info, 'recovered').length).toBe(1);
    h.poller.stop();
  });

  it('_skipped -> skipped.busy; standby -> skipped.standby, engine not called, next scheduled', async () => {
    const h = makeHarness('on');
    h.engines.channelWatch.mockResolvedValueOnce({ repliedCount: 0, escalatedCount: 0, items: [], _skipped: true });
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    expect(h.poller.getStatus().polls.channelWatch.skipped.busy).toBe(1);
    h.deps.mayPollSlack.mockReturnValue(false);
    await h.clock.advance(10000);
    const st = h.poller.getStatus().polls.channelWatch;
    expect(st.skipped.standby).toBe(1);
    expect(st.runs).toBe(0);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    expect(st.nextRunAt).toBe(24000);
    expect(lines(h.logger.info, 'channelWatch skipped — standby').length).toBe(1);
    h.poller.stop();
  });

  it('dmNotify success and notAuthed classification', async () => {
    const h = makeHarness('on');
    h.engines.dmNotify.mockResolvedValueOnce([{ ts: '1' }, { ts: '2' }]);
    h.poller.start(h.ctx);
    await h.clock.advance(3000);
    let st = h.poller.getStatus().polls.dmNotify;
    expect(st.runs).toBe(1);
    expect(st.fails).toBe(0);
    expect(st.lastResult).toEqual({ count: 2 });
    expect(h.track.mock.calls.filter((c) => c[0] === 'slack.readDmsNotify').length).toBe(1);
    h.deps.isSlackConfigured.mockReturnValue(false);
    await h.clock.advance(30000);
    st = h.poller.getStatus().polls.dmNotify;
    expect(st.skipped.notAuthed).toBe(1);
    expect(st.runs).toBe(1);
    expect(h.engines.dmNotify).toHaveBeenCalledTimes(1);
    h.poller.stop();
  });

  it('main-origin dmNotify returns the NOT_AUTHED sentinel when Slack is not configured', async () => {
    const h = makeHarness('on');
    h.deps.isSlackConfigured.mockReturnValue(false);
    expect(h.poller.runPoll('dmNotify', { origin: 'main' })).toBe(NOT_AUTHED);
    expect(h.engines.dmNotify).not.toHaveBeenCalled();
  });

  it('a bookkeeping throw (send throws inside _push) still re-arms the tick', async () => {
    const h = makeHarness('on');
    h.send.mockImplementation(() => { throw new Error('window gone'); });
    h.engines.channelWatch.mockResolvedValueOnce({ escalatedCount: 1, items: [] });
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    expect(h.poller.getStatus().polls.channelWatch.nextRunAt).toBe(14000);
    await h.clock.advance(10000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });
});

describe('8. watchdog', () => {
  it('stall is observed once, no second run, clears when the run settles', async () => {
    const h = makeHarness('on');
    const d = deferred();
    h.engines.channelWatch.mockImplementation(() => d.promise);
    h.poller.start(h.ctx);
    await h.clock.advance(4000 + 300000);
    let st = h.poller.getStatus().polls.channelWatch;
    expect(st.stalled).toBe(true);
    expect(st.inFlight).toBe(true);
    expect(lines(h.logger.error, 'channelWatch in flight > 300s').length).toBe(1);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    d.resolve(okResult());
    await h.clock.flush();
    st = h.poller.getStatus().polls.channelWatch;
    expect(st.stalled).toBe(false);
    expect(st.inFlight).toBe(false);
    expect(st.nextRunAt).not.toBeNull();
    h.poller.stop();
  });

  it('T-F8: the stall watchdog handle is unref\'d', async () => {
    const h = makeHarness('on');
    h.engines.channelWatch.mockImplementation(() => new Promise(() => {}));
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    const wd = h.clock.created.filter((t) => t.ms === 300000);
    expect(wd.length).toBeGreaterThan(0);
    for (const t of wd) expect(t.unref).toHaveBeenCalled();
    const dnWd = h.clock.created.filter((t) => t.ms === 120000);
    for (const t of dnWd) expect(t.unref).toHaveBeenCalled();
    h.poller.stop();
  });
});

describe('9. start fallback', () => {
  it('scheduler throws on the 2nd kind -> 0 pending, mode off, poll-mode push, renderer admitted', async () => {
    const clock = makeClock({ throwOnCall: 2 });
    const h = makeHarness('on', { clock });
    const r = h.poller.start(h.ctx);
    expect(r).toMatchObject({ started: false, mode: 'off', error: 'scheduler boom' });
    expect(clock.pending()).toBe(0);
    expect(h.poller.getMode()).toBe('off');
    expect(pushes(h.send, 'slack:poll-mode')).toEqual([['slack:poll-mode', { mode: 'off' }]]);
    expect(lines(h.logger.error, '[SlackPoller] start failed — falling back to renderer polling: scheduler boom').length).toBe(1);
    expect(h.poller.getStatus().startError).toBe('scheduler boom');
    await h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx });
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    await clock.advance(120000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    expect(h.engines.dmNotify).not.toHaveBeenCalled();
    expect(h.engines.dmAutoReply).not.toHaveBeenCalled();
  });

  it('T-F1b: start throws after getMode() memoized on (logger.info on the started line) -> falls back to off', async () => {
    const h = makeHarness('on');
    h.logger.info.mockImplementation((m) => { if (String(m).includes('[SlackPoller] started')) throw new Error('log boom'); });
    expect(h.poller.getMode()).toBe('on');
    const r = h.poller.start(h.ctx);
    expect(r).toMatchObject({ started: false, mode: 'off' });
    expect(h.clock.pending()).toBe(0);
    expect(h.poller.getMode()).toBe('off');
    expect(h.send).toHaveBeenCalledWith('slack:poll-mode', { mode: 'off' });
    await h.poller.runPoll('channelWatch', { origin: 'renderer', ctx: h.ctx });
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    await h.clock.advance(120000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    expect(h.engines.dmAutoReply).not.toHaveBeenCalled();
    expect(h.engines.dmNotify).not.toHaveBeenCalled();
  });

  it('T-F1c: forceOff after a successful on start clears timers and pushes once; idempotent', async () => {
    const h = makeHarness('on');
    expect(h.poller.start(h.ctx)).toEqual({ started: true, mode: 'on' });
    expect(h.clock.pending()).toBe(3);
    const r = h.poller.forceOff('app wiring failed');
    expect(r).toMatchObject({ started: false, mode: 'off', error: 'app wiring failed' });
    expect(h.clock.pending()).toBe(0);
    expect(pushes(h.send, 'slack:poll-mode').length).toBe(1);
    expect(h.poller.forceOff('again')).toEqual({ started: false, mode: 'off' });
    expect(pushes(h.send, 'slack:poll-mode').length).toBe(1);
    await h.clock.advance(60000);
    expect(h.engines.channelWatch).not.toHaveBeenCalled();
  });

  it('forceOff uses the ctx argument when start never stored one', () => {
    const h = makeHarness('on');
    const send = vi.fn();
    h.poller.forceOff('early', { send });
    expect(send).toHaveBeenCalledWith('slack:poll-mode', { mode: 'off' });
  });
});

describe('10. stop', () => {
  it('no ticks after stop; an in-flight run completing after stop schedules nothing', async () => {
    const h = makeHarness('on');
    const d = deferred();
    h.engines.channelWatch.mockImplementation(() => d.promise);
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    h.poller.stop();
    expect(h.clock.pending()).toBe(0);
    d.resolve(okResult());
    await h.clock.flush();
    expect(h.clock.pending()).toBe(0);
    await h.clock.advance(60000);
    expect(h.engines.channelWatch).toHaveBeenCalledTimes(1);
    h.poller.stop(); // idempotent
  });
});

describe('11. onConfigUpdated', () => {
  it('on: re-phases a pending channel timer; no-op while in flight', async () => {
    const h = makeHarness('on');
    h.poller.start(h.ctx);
    await h.clock.advance(4000);
    expect(h.poller.getStatus().polls.channelWatch.nextRunAt).toBe(14000);
    await h.clock.advance(3000);
    h.poller.onConfigUpdated('channel-watch');
    expect(h.poller.getStatus().polls.channelWatch.nextRunAt).toBe(17000);
    expect([...h.clock.timers.values()].filter((t) => t.at === 14000).length).toBe(0);
    // in flight -> nothing happens
    const d = deferred();
    h.engines.channelWatch.mockImplementation(() => d.promise);
    await h.clock.advance(10000);
    const before = [...h.clock.timers.keys()].join(',');
    h.poller.onConfigUpdated('channel-watch');
    expect([...h.clock.timers.keys()].join(',')).toBe(before);
    d.resolve(okResult());
    await h.clock.flush();
    h.poller.stop();
  });

  for (const mode of ['off', 'shadow']) {
    it(`${mode}: no-op (scheduler entries unchanged)`, async () => {
      const h = makeHarness(mode);
      h.poller.start(h.ctx);
      await h.clock.advance(5000);
      const before = [...h.clock.timers.values()].map((t) => t.id + '@' + t.at).join(',');
      const calls = h.clock.setTimeout.mock.calls.length;
      h.poller.onConfigUpdated('channel-watch');
      expect([...h.clock.timers.values()].map((t) => t.id + '@' + t.at).join(',')).toBe(before);
      expect(h.clock.setTimeout.mock.calls.length).toBe(calls);
      h.poller.stop();
    });
  }
});

describe('12. getStatus', () => {
  it('matches the §4.6 shape', () => {
    const h = makeHarness('on', { deps: { owaStatus: () => ({ mode: 'on', skipped: { busy: 0 } }) } });
    h.poller.start(h.ctx);
    const st = h.poller.getStatus();
    expect(Object.keys(st).sort()).toEqual(['configuredMode', 'flags', 'mode', 'owaTriage', 'polls', 'startError', 'startedAt'].sort());
    expect(st).toMatchObject({ mode: 'on', configuredMode: 'on', startedAt: 0, startError: null, flags: { mainProcessPolling: 'on', channelWatchClaims: false } });
    expect(st.owaTriage).toEqual({ mode: 'on', skipped: { busy: 0 } });
    for (const k of ['channelWatch', 'dmAutoReply', 'dmNotify']) {
      const p = st.polls[k];
      for (const key of ['intervalMs', 'inFlight', 'stalled', 'lastStartAt', 'lastEndAt', 'lastDurationMs', 'nextRunAt', 'runs', 'fails', 'lastError', 'lastResult', 'skipped', 'shadow', 'renderer']) {
        expect(p).toHaveProperty(key);
      }
      expect(Object.keys(p.skipped).sort()).toEqual(['busy', 'coalesced', 'notAuthed', 'standby']);
      expect(Object.keys(p.shadow.wouldSkip).sort()).toEqual(['busy', 'disabled', 'notAuthed', 'standby']);
      expect(Object.keys(p.renderer).sort()).toEqual(['calls', 'lastAt', 'rejected']);
      expect(p).not.toHaveProperty('_timer');
    }
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
    h.poller.stop();
  });
});

describe('13. engineLog', () => {
  it('both origins pass engineLog (identity) to the engines; engine lines never reach the poller logger', async () => {
    const off = makeHarness('off');
    off.engines.channelWatch.mockImplementation(async (log) => { log('[SlackWatch] x'); return okResult(); });
    off.engines.dmAutoReply.mockImplementation(async (log) => { log('[SlackDM] y'); return okResult(); });
    await off.poller.runPoll('channelWatch', { origin: 'renderer' });
    await off.poller.runPoll('dmAutoReply', { origin: 'renderer' });
    expect(off.engines.channelWatch.mock.calls[0][0]).toBe(off.engineLog);
    expect(off.engines.dmAutoReply.mock.calls[0][0]).toBe(off.engineLog);
    expect(off.engineLog.mock.calls.map((c) => c[0])).toEqual(['[SlackWatch] x', '[SlackDM] y']);
    for (const lvl of ['debug', 'info', 'warn', 'error']) expect(lines(off.logger[lvl], '[Slack').filter((c) => /SlackWatch|SlackDM/.test(c[0])).length).toBe(0);

    const on = makeHarness('on');
    on.engines.channelWatch.mockImplementation(async (log) => { log('[SlackWatch] z'); return okResult(); });
    on.poller.start(on.ctx);
    await on.clock.advance(4000);
    expect(on.engines.channelWatch.mock.calls[0][0]).toBe(on.engineLog);
    expect(on.engines.dmAutoReply.mock.calls[0][0]).toBe(on.engineLog);
    expect(on.engineLog).toHaveBeenCalledWith('[SlackWatch] z');
    expect(lines(on.logger.info, '[SlackWatch] z').length).toBe(0);
    on.poller.stop();
  });

  it('default engineLog routes to a logger created with tag ipc:slack', async () => {
    const loggerPath = require.resolve('../src/utils/logger');
    const saved = require.cache[loggerPath];
    const tags = [];
    const infos = [];
    const factory = (tag) => { tags.push(tag); return { debug() {}, info: (m) => infos.push([tag, m]), warn() {}, error() {} }; };
    require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: factory };
    try {
      const h = makeHarness('off');
      const deps = Object.assign({}, h.deps);
      delete deps.engineLog;
      delete deps.logger;
      const p = createPoller(deps);
      expect(tags).toContain('ipc:slack');
      expect(tags).toContain('slack:poller');
      h.engines.channelWatch.mockImplementation(async (log) => { log('[SlackWatch] tagged'); return okResult(); });
      await p.runPoll('channelWatch', { origin: 'renderer' });
      expect(infos).toContainEqual(['ipc:slack', '[SlackWatch] tagged']);
    } finally {
      if (saved) require.cache[loggerPath] = saved; else delete require.cache[loggerPath];
    }
  });
});

describe('14. _tick reads the mode', () => {
  it('after a start fallback a stray tick calls no engine and schedules nothing', async () => {
    const clock = makeClock({ throwOnCall: 2 });
    const h = makeHarness('on', { clock });
    h.poller.start(h.ctx);
    expect(h.poller.getMode()).toBe('off');
    await h.poller._tickForTests('channelWatch');
    await clock.flush();
    expect(h.engines.channelWatch).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});
