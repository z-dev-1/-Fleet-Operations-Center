// tests/slack-justme-queue.test.js
//
// Regression coverage for the 2026-07-25 "Just Me recurring timeout" fix.
//
// Symptom reported live: the FIRST Slack "Just Me" question worked, the
// SECOND one hung, and after 240s Slack posted the raw
// "processOrchaAction timed out after 240000ms" error. Restarting the app
// "fixed" it temporarily.
//
// Root cause (see fleet-brain.js/relay.js comments for the full writeup):
// fleet-brain's internal WS response timeout was far shorter than real
// Orcha latency, and on timeout it never closed the socket or correlated
// requests -- so a late response for a timed-out request could get
// misattributed to whatever request became active next. Separately,
// _jmHandleMessage() was awaited INSIDE the global Slack poll lock, so a
// slow/hung AI call for one message blocked polling entirely.
//
// This suite exercises the REAL exported pollChannelsOnce() / job-queue
// code in src/scrapers/slack_channel_watch.js (not a hand-rolled mirror).
//
// MOCKING NOTE: slack_channel_watch.js is a plain CommonJS module that
// pulls its dependencies via lazy `require(...)` calls *inside* its own
// functions. This project's Vitest setup (no "type":"module", all-CJS
// source tree) does NOT intercept those nested `require()` calls with
// `vi.mock()` -- confirmed empirically: `vi.mock()` only rewires a
// specifier when the TEST file imports it directly, not when a
// dynamically-`import()`-ed CJS module requires it internally. So instead
// of `vi.mock`, we pre-seed Node's real `require.cache` with fake module
// objects for store / slack_send / ipc-ai, resolved to their real absolute
// paths -- the SUT's own unmodified `require()` calls hit that cache and
// get our fakes without ever executing (or needing to mock-load) the real
// files. This is done once at module scope; `vi.resetModules()` (which
// resets Vite's *separate* SSR module registry, not `require.cache`) is
// still used per-test to get a fresh top-level state of
// slack_channel_watch.js itself (fresh job queue/seq counters etc).

import { describe, it, expect, beforeEach } from 'vitest';

// ── In-memory store fake ────────────────────────────────────────────────
let _storeData;
function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

injectFakeModule('../src/store', {
  load: (key, fallback) => (key in _storeData ? _storeData[key] : fallback),
  save: (key, data) => { _storeData[key] = data; },
});

// ── Slack send/read fake -- fully controlled by each test ──────────────────
let _sentMessages; // [{ channelId, text, threadTs }]
let _fakeMessages;  // messages readMessages() returns
injectFakeModule('../src/scrapers/slack_send', {
  readMessages: async () => _fakeMessages,
  sendToChannel: async (channelId, text, threadTs) => {
    _sentMessages.push({ channelId, text, threadTs });
    return { ts: 'reply-' + _sentMessages.length };
  },
  checkLiveAuth: async () => ({ authenticated: true, userId: 'UTEST' }),
});

// ── AI fake -- controllable per test (fast/slow/hang, isolation-checking) ──
let _processOrchaAction;
injectFakeModule('../src/ipc/ai', {
  processOrchaAction: (...args) => _processOrchaAction(...args),
  confirmSend: async () => ({ ok: true, message: 'Sent.' }),
});

async function loadFreshModule() {
  const resolved = require.resolve('../src/scrapers/slack_channel_watch.js');
  delete require.cache[resolved]; // force the SUT's own top-level state to re-init
  const mod = await import('../src/scrapers/slack_channel_watch.js');
  return mod;
}

function seedJustMeChannel(lastSeenTs) {
  _storeData.slackChannelWatchConfig = {
    enabled: true,
    replyMode: 'justme',
    channels: [
      { id: 'CTEST', name: 'test-justme', enabled: true, replyMode: 'justme', lastSeenTs },
    ],
  };
}

function msg(ts, text) {
  return { ts, text, userId: 'UREAL' };
}

beforeEach(() => {
  _storeData = {};
  _sentMessages = [];
  _fakeMessages = [];
});

describe('Slack Just Me — sequential requests never inherit stale state', () => {
  it('two consecutive questions each complete independently with correct, isolated results', async () => {
    const watch = await loadFreshModule();
    seedJustMeChannel('1000.000000'); // not first-ever poll

    // Each call answers with its own input echoed back -- if request #2 ever
    // received request #1's answer (the exact misattribution bug), this
    // assertion would catch it immediately.
    _processOrchaAction = (async (text) => ({ ok: true, text: 'ANSWER-FOR:' + text }));

    _fakeMessages = [msg('1001.0', 'question one')];
    await watch.pollChannelsOnce();
    await watch.__test__.waitForAiQueueIdle();

    _fakeMessages = [msg('1002.0', 'question two'), msg('1001.0', 'question one')];
    await watch.pollChannelsOnce();
    await watch.__test__.waitForAiQueueIdle();

    expect(_sentMessages.length).toBe(2);
    expect(_sentMessages[0].text).toContain('ANSWER-FOR:question one');
    expect(_sentMessages[1].text).toContain('ANSWER-FOR:question two');
  });

  it('five consecutive questions each complete independently, none inherits stale state', async () => {
    const watch = await loadFreshModule();
    seedJustMeChannel('2000.000000');

    const seenRequestIds = new Set();
    _processOrchaAction = (async (text, opts) => {
      if (opts && opts.requestId) seenRequestIds.add(opts.requestId);
      return { ok: true, text: 'ANSWER-FOR:' + text };
    });

    for (let i = 1; i <= 5; i++) {
      _fakeMessages = [msg('200' + i + '.0', 'q' + i)];
      await watch.pollChannelsOnce();
      await watch.__test__.waitForAiQueueIdle();
    }

    expect(_sentMessages.length).toBe(5);
    for (let i = 1; i <= 5; i++) {
      expect(_sentMessages[i - 1].text).toContain('ANSWER-FOR:q' + i);
    }
    // Proves no shared/reused in-flight job slot -- every job got its own id.
    expect(seenRequestIds.size).toBe(5);
  });

  it('a deliberately hung AI request is aborted at the safety boundary, cleaned up, and never freezes the next request', async () => {
    const watch = await loadFreshModule();
    watch.__test__.setAiTimeoutMs(50); // shrink the outer safety boundary for the test
    seedJustMeChannel('3000.000000');

    let sawAbort = false;
    _processOrchaAction = ((text, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('Aborted by caller')); });
      }
      // never resolves on its own -- simulates a hung Fleet Brain/WS/CLI call
    }));

    _fakeMessages = [msg('3001.0', 'this will hang')];
    await watch.pollChannelsOnce();
    await watch.__test__.waitForAiQueueIdle(2000);

    expect(sawAbort).toBe(true);
    expect(_sentMessages.length).toBe(1);
    // Slack must NEVER see the raw internal error string.
    expect(_sentMessages[0].text).not.toContain('timed out');
    expect(_sentMessages[0].text).not.toContain('Aborted');
    expect(_sentMessages[0].text).toContain("couldn't complete that request");

    // The NEXT request must run immediately, with no leftover state from the
    // aborted one -- this is the exact acceptance criterion from the bug
    // report ("the next Slack request works immediately after a timeout").
    _processOrchaAction = (async (text) => ({ ok: true, text: 'ANSWER-FOR:' + text }));
    _fakeMessages = [msg('3002.0', 'question after the hang'), msg('3001.0', 'this will hang')];
    await watch.pollChannelsOnce();
    await watch.__test__.waitForAiQueueIdle();

    expect(_sentMessages.length).toBe(2);
    expect(_sentMessages[1].text).toContain('ANSWER-FOR:question after the hang');
  });

  it('the poll lock is released quickly and does not wait for the AI job to finish', async () => {
    const watch = await loadFreshModule();
    seedJustMeChannel('4000.000000');

    let resolveAi;
    _processOrchaAction = (() => new Promise((resolve) => { resolveAi = resolve; }));

    _fakeMessages = [msg('4001.0', 'slow question')];
    const pollPromise = watch.pollChannelsOnce();

    // pollChannelsOnce() must resolve WITHOUT waiting for the AI call --
    // this is the core fix for "AI wait holds the global poll lock".
    const raced = await Promise.race([
      pollPromise.then(() => 'poll-finished'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending-ai'), 200)),
    ]);
    expect(raced).toBe('poll-finished');

    // Clean up the still-open AI call so it doesn't leak into other tests.
    expect(typeof resolveAi).toBe('function');
    resolveAi({ ok: true, text: 'late answer' });
    await watch.__test__.waitForAiQueueIdle();
  });
});
