// tests/slack-lane-origin.test.js
//
// Fair lane design T3: src/slack/lane-origin.js (AsyncLocalStorage origin tag)
// and the poller's runPoll tagging. No Slack, no Electron.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ORIGINS, runWithOrigin, currentOrigin } = require('../src/slack/lane-origin');
const { createPoller } = require('../src/slack/poller');

afterEach(() => { vi.useRealTimers(); });

describe('lane-origin', () => {
  it('ORIGINS is the fixed round-robin order', () => {
    expect(ORIGINS).toEqual(['dmAutoReply', 'channelWatch', 'dmNotify', 'other']);
    expect(Object.isFrozen(ORIGINS)).toBe(true);
  });

  it("'other' outside any context and for an invalid origin value", () => {
    expect(currentOrigin()).toBe('other');
    expect(runWithOrigin('bogus', () => currentOrigin())).toBe('other');
    expect(runWithOrigin(undefined, () => currentOrigin())).toBe('other');
    expect(runWithOrigin('channelWatch', () => currentOrigin())).toBe('channelWatch');
  });

  it('propagates through await and Promise.all (fake timers allowed)', async () => {
    vi.useFakeTimers();
    const seen = [];
    const p = runWithOrigin('dmAutoReply', async () => {
      await Promise.resolve();
      seen.push(currentOrigin());
      await Promise.all([1, 2, 3].map(async () => { await null; seen.push(currentOrigin()); }));
      seen.push(currentOrigin());
    });
    await p;
    expect(seen).toEqual(['dmAutoReply', 'dmAutoReply', 'dmAutoReply', 'dmAutoReply', 'dmAutoReply']);
    expect(currentOrigin()).toBe('other');
  });

  it('propagates through a real setTimeout (5 ms)', async () => {
    vi.useRealTimers();
    const got = await runWithOrigin('channelWatch', () => new Promise((res) => setTimeout(() => res(currentOrigin()), 5)));
    expect(got).toBe('channelWatch');
  });

  it('nested runs restore the outer origin', async () => {
    const seen = await runWithOrigin('dmAutoReply', async () => {
      const inner = await runWithOrigin('dmNotify', async () => { await null; return currentOrigin(); });
      return [inner, currentOrigin()];
    });
    expect(seen).toEqual(['dmNotify', 'dmAutoReply']);
  });

  it('runWithOrigin is transparent: same value, same promise, same error', async () => {
    const v = { a: 1 };
    expect(runWithOrigin('other', () => v)).toBe(v);
    const pr = Promise.resolve(7);
    expect(runWithOrigin('other', () => pr)).toBe(pr);
    const err = new Error('boom');
    let caught = null;
    try { runWithOrigin('other', () => { throw err; }); } catch (e) { caught = e; }
    expect(caught).toBe(err);
    await expect(runWithOrigin('other', async () => { throw err; })).rejects.toBe(err);
  });
});

describe('poller.runPoll tags each engine run', () => {
  function mk(mode) {
    const seen = {};
    const rec = (k) => async () => {
      const entry = currentOrigin();
      await Promise.resolve();
      seen[k] = [entry, currentOrigin()];
      return k === 'dmNotify' ? [] : { repliedCount: 0, escalatedCount: 0, items: [] };
    };
    const poller = createPoller({
      loadFlags: () => ({ mainProcessPolling: mode }),
      mayPollSlack: () => true, isSlackConfigured: () => true,
      track: (name, fn) => fn(),
      engines: { channelWatch: rec('channelWatch'), dmAutoReply: rec('dmAutoReply'), dmNotify: rec('dmNotify') },
      logger: { debug() {}, info() {}, warn() {}, error() {} }, engineLog: () => {},
      owaStatus: () => null, readRaw: () => null,
      setTimeout: () => ({ unref() {} }), clearTimeout: () => {}, now: () => 0,
    });
    return { poller, seen };
  }
  it('renderer origin (mode off): dmNotify / channelWatch / dmAutoReply', async () => {
    const { poller, seen } = mk('off');
    for (const k of ['dmNotify', 'channelWatch', 'dmAutoReply']) await poller.runPoll(k, { origin: 'renderer' });
    expect(seen).toEqual({ dmNotify: ['dmNotify', 'dmNotify'], channelWatch: ['channelWatch', 'channelWatch'], dmAutoReply: ['dmAutoReply', 'dmAutoReply'] });
    expect(currentOrigin()).toBe('other');
  });
  it('main origin (mode on): dmNotify through track', async () => {
    const { poller, seen } = mk('on');
    for (const k of ['dmNotify', 'channelWatch', 'dmAutoReply']) await poller.runPoll(k, { origin: 'main' });
    expect(seen).toEqual({ dmNotify: ['dmNotify', 'dmNotify'], channelWatch: ['channelWatch', 'channelWatch'], dmAutoReply: ['dmAutoReply', 'dmAutoReply'] });
  });
});
