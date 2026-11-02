// tests/slack-speedup-parity-channel.test.js
//
// Phase 4b step 0 — flags-off GOLDEN parity for the channel-watch engine.
// Drives the REAL pollChannelsOnce over the REAL slack_send, whose raw
// transport is replaced by a scripted fake (tests/helpers/slack-fake-transport).
// Every non-Slack dependency is the tests/slack-channel-watch-claims.test.js
// fake set (except slack_send, which is real here), plus pm_alert_reply and
// ../ipc/ai fakes. Part (a) pins the literal Slack call list (method + params,
// in order), the sends, the watermarks and the reply log that HEAD produced
// with no speed-up flags set. It was captured on HEAD before any speed-up code
// existed and must stay unmodified and green. Part (b) (step 10) is the
// simulated flags-off vs flags-on run comparison.
//
// One engine per file (design §9.0). No network, no Slack, no Electron.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createFakeSlack, loadRealSlackSend, drive } = require('./helpers/slack-fake-transport');

function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
const LOGS = [];
function _mkLogger(ns) {
  const rec = (level) => (...a) => { LOGS.push({ ns, level, msg: a.map(String).join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
const _loggerFn = (ns) => _mkLogger(ns);
_loggerFn.createLogger = _mkLogger;
injectFake('../src/utils/logger', _loggerFn);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-parity-ch-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

const ME = 'UME';
injectFake('../src/orcha/fas/runner', {
  handleInbound: async () => ({ mode: 'disabled', letLegacyReply: true, outcome: 'disabled' }),
  _queueManualReview: () => {},
});
injectFake('../src/ai/core', { handleInbound: async () => ({ mode: 'disabled', letLegacyReply: true, outcome: 'disabled' }) });
injectFake('../src/orcha/fas/agent', {});
injectFake('../src/orcha/fas/config', { get: () => ({ enabled: false }) });
injectFake('../src/orcha/fas/sender-profiles', { resolveSender: () => null });
injectFake('../src/orcha/fas/shadow', { runShadow: () => {} });
injectFake('../src/scrapers/slack_decision_trace', { trace: () => {} });
injectFake('../src/slack/gateway', {
  buildRunnerInput: (raw, extra) => ({ engine: 'channel', channelId: raw.conv.channelId, ts: raw.message.ts,
    threadTs: raw.message.threadTs, text: raw.message.text, slackId: raw.message.userId, ...extra }),
});
injectFake('../src/scrapers/slack_inbound_support', {
  discoverSenders: async () => ({ created: 0, discovered: 0 }),
  isSendBlocked: () => false, markSendBlocked: () => {}, clearSendBlocked: () => {}, lifecycle: () => {},
  classifySendError: () => ({ kind: 'transient' }),
  REASON: { SEND_BLOCKED: 'send-blocked', SEND_FAILED_RETRY: 'send-failed-retry' },
});
injectFake('../src/scrapers/orcha_ws', { askOrcha: async () => ({ text: '' }) });
injectFake('../src/scrapers/pm_alert_reply', {
  looksLikeAlert: (t) => /PM ALERT/.test(t || ''),
  isTaggedIn: (t, me) => (t || '').includes('<@' + me + '>'),
  handleTaggedPmAlert: async () => ({ handled: true, replyTs: 'R', reply: 'ack' }),
  resolveOperatorEntry: () => null,
});
injectFake('../src/scrapers/ready_pickup_notify', { handleReadyReplies: async () => {} });
injectFake('../src/scrapers/slack_justme_channel', { channelMode: (ch) => ch.replyMode });
injectFake('../src/orcha/relay', {
  runWithTimeout: async () => ({ text: 'YES' }),
  askWithTimeout: async () => JSON.stringify({ inScope: true, reply: 'legacy answer', category: null, title: 't' }),
});
injectFake('../src/orcha/ai-context', { buildFleetContext: () => '' });
injectFake('../src/ipc/ai', {
  processOrchaAction: async () => ({ ok: true, text: 'jm answer' }),
  confirmSend: async () => ({ ok: true, message: 'Sent.' }),
});

const NOW_MS = Date.UTC(2026, 10, 2, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const T = (off) => (NOW_S + off).toFixed(6);

const fake = createFakeSlack({ me: ME });
let ss, engine;
const ENV_KEYS = ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED', 'FLEET_SLACK_THREAD_REUSE',
  'FLEET_SLACK_PM_SHARED_HISTORY', 'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING', 'FLEET_COMMS_CHANNEL_CLAIMS'];

function seedPartA() {
  fake.conv = {
    C1: {
      messages: [
        { ts: T(-3000), user: 'UPART', text: 'thread root', reply_count: 2, latest_reply: T(-30), thread_ts: T(-3000) },
        { ts: T(-4000), user: 'UPART', text: 'old' },
      ],
      replies: { [T(-3000)]: [
        { ts: T(-3000), user: 'UPART', text: 'thread root', reply_count: 2, latest_reply: T(-30), thread_ts: T(-3000) },
        { ts: T(-2900), user: 'UPART', text: 'first', thread_ts: T(-3000) },
        { ts: T(-30), user: 'UPART', text: `<@${ME}> any update on unit 42?`, thread_ts: T(-3000) },
      ] },
    },
    C2: {
      messages: [{ ts: T(-5000), user: 'UX', text: 'hello', reply_count: 1, latest_reply: T(-4900), thread_ts: T(-5000) }],
      replies: { [T(-5000)]: [
        { ts: T(-5000), user: 'UX', text: 'hello', reply_count: 1, latest_reply: T(-4900), thread_ts: T(-5000) },
        { ts: T(-4900), user: 'UX', text: 'ok', thread_ts: T(-5000) },
      ] },
    },
    J1: {
      messages: [
        { ts: T(-20), user: ME, text: 'how many units down?' },
        { ts: T(-5000), user: ME, text: 'old q', reply_count: 1, latest_reply: T(-4990), thread_ts: T(-5000) },
      ],
      replies: { [T(-5000)]: [
        { ts: T(-5000), user: ME, text: 'old q', reply_count: 1, latest_reply: T(-4990), thread_ts: T(-5000) },
        { ts: T(-4990), user: ME, text: `<@${ME}> old answer`, thread_ts: T(-5000) },
      ] },
    },
    P1: {
      messages: [{ ts: T(-7000), user: 'UBOT', text: 'PM ALERT unit 42', reply_count: 1, latest_reply: T(-6990), thread_ts: T(-7000) }],
      replies: { [T(-7000)]: [
        { ts: T(-7000), user: 'UBOT', text: 'PM ALERT unit 42', reply_count: 1, latest_reply: T(-6990), thread_ts: T(-7000) },
        { ts: T(-6990), user: 'UBOT', text: 'details', thread_ts: T(-7000) },
      ] },
    },
  };
  store.save('settings', {});
  store.save('fasInboundClaims', {});
  store.save('slackMentionThreads', { C1: [T(-3000)], C2: [T(-5000)] });
  store.save('slackChannelReplies', [
    { id: 'J1:' + T(-5000), channelId: 'J1', channelName: 'fleet-ops', ts: T(-5000), replyTs: 'R0', title: 'Just Me', createdAt: '2026-11-01T00:00:00.000Z', status: 'auto-answered' },
  ]);
  store.save('slackChannelWatchConfig', { enabled: true, replyMode: 'mentions', channels: [
    { id: 'C1', name: 'partner-a', enabled: true, replyMode: 'mentions', pmAlertAutoReply: false, lastSeenTs: T(-600) },
    { id: 'C2', name: 'partner-b', enabled: true, replyMode: 'mentions', pmAlertAutoReply: false, lastSeenTs: T(-600) },
    { id: 'J1', name: 'fleet-ops', enabled: true, replyMode: 'justme', pmAlertAutoReply: false, lastSeenTs: T(-600) },
    { id: 'P1', name: 'mmfm', enabled: true, replyMode: 'mentions', pmAlertAutoReply: true, lastSeenTs: T(-600) },
  ] });
}
const watermarks = () => {
  const o = {}; for (const c of store.load('slackChannelWatchConfig').channels) o[c.id] = c.lastSeenTs; return o;
};
const replyLog = () => (store.load('slackChannelReplies', []) || []).map(e => ({ id: e.id, channelId: e.channelId, ts: e.ts, replyTs: e.replyTs || null, status: e.status }));

async function runOnce() {
  const res = await drive(engine.pollChannelsOnce(() => {}), vi);
  await drive(engine.__test__.waitForAiQueueIdle(60000), vi);
  return { repliedCount: res.repliedCount, escalatedCount: res.escalatedCount, items: (res.items || []).length };
}

beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  seedPartA();
  ss = loadRealSlackSend(require, tmpDir, fake);
  delete require.cache[require.resolve('../src/scrapers/slack_channel_watch.js')];
  engine = require('../src/scrapers/slack_channel_watch.js');
});
afterAll(() => {
  vi.useRealTimers();
  try { ss._setRawRequestForTests(null); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// Literal golden values captured on HEAD (flags off). DO NOT EDIT.
const GOLDEN_RUN1_CALLS = [
  ["auth.test",{}],
  ["conversations.history",{"channel":"C1","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"C1","ts":"1793617800.000000","limit":"20"}],
  ["chat.postMessage",{"channel":"C1","text":"<@UPART> legacy answer","unfurl_links":"true","unfurl_media":"true","thread_ts":"1793620770.000000"}],
  ["conversations.history",{"channel":"C2","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"C2","ts":"1793615800.000000","limit":"20"}],
  ["conversations.history",{"channel":"J1","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"J1","ts":"1793615800.000000","limit":"20"}],
  ["conversations.history",{"channel":"P1","limit":"20","inclusive":"true"}],
  ["chat.postMessage",{"channel":"J1","text":"<@UME> jm answer","unfurl_links":"true","unfurl_media":"true","thread_ts":"1793620780.000000"}],
  ["conversations.replies",{"channel":"P1","ts":"1793613800.000000","limit":"30"}],
  ["conversations.history",{"channel":"P1","limit":"20","inclusive":"true"}],
];
const GOLDEN_RUN1_POSTS = [{"channel":"C1","text":"<@UPART> legacy answer","thread_ts":"1793620770.000000"},{"channel":"J1","text":"<@UME> jm answer","thread_ts":"1793620780.000000"}];
const GOLDEN_RUN1_WATERMARKS = {"C1":"1793620770.000000","C2":"1793620200.000000","J1":"1793620780.000000","P1":"1793620200.000000"};
const GOLDEN_RUN1_LOG = [{"id":"J1:1793620780.000000","channelId":"J1","ts":"1793620780.000000","replyTs":"R2","status":"auto-answered"},{"id":"C1:1793620770.000000","channelId":"C1","ts":"1793620770.000000","replyTs":"R1","status":"auto-answered"},{"id":"J1:1793615800.000000","channelId":"J1","ts":"1793615800.000000","replyTs":"R0","status":"auto-answered"}];
const GOLDEN_RUN1_RESULT = {"repliedCount":1,"escalatedCount":0,"items":0};
const GOLDEN_RUN2_CALLS = [
  ["auth.test",{}],
  ["conversations.history",{"channel":"C1","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"C1","ts":"1793617800.000000","limit":"20"}],
  ["conversations.replies",{"channel":"C1","ts":"1793620770.000000","limit":"20"}],
  ["conversations.history",{"channel":"C2","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"C2","ts":"1793615800.000000","limit":"20"}],
  ["conversations.history",{"channel":"J1","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"J1","ts":"1793620780.000000","limit":"20"}],
  ["conversations.replies",{"channel":"J1","ts":"1793615800.000000","limit":"20"}],
  ["conversations.history",{"channel":"P1","limit":"20","inclusive":"true"}],
  ["conversations.replies",{"channel":"P1","ts":"1793613800.000000","limit":"30"}],
  ["conversations.history",{"channel":"P1","limit":"20","inclusive":"true"}],
];
const GOLDEN_RUN2_POSTS = [];
const GOLDEN_RUN2_WATERMARKS = {"C1":"1793620770.000000","C2":"1793620200.000000","J1":"1793620780.000000","P1":"1793620200.000000"};
const GOLDEN_RUN2_LOG = [{"id":"J1:1793620780.000000","channelId":"J1","ts":"1793620780.000000","replyTs":"R2","status":"auto-answered"},{"id":"C1:1793620770.000000","channelId":"C1","ts":"1793620770.000000","replyTs":"R1","status":"auto-answered"},{"id":"J1:1793615800.000000","channelId":"J1","ts":"1793615800.000000","replyTs":"R0","status":"auto-answered"}];
const GOLDEN_RUN2_RESULT = {"repliedCount":0,"escalatedCount":0,"items":0};


describe.sequential('Channel-watch engine flags-off golden parity (part a)', () => {
  it('run 1 (cold module): literal call list, sends, watermarks, reply log', async () => {
    fake.reset();
    const result = await runOnce();
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBeGreaterThan(0);
    expect(fake.count('conversations.history')).toBeGreaterThan(0);
    expect(fake.calls).toEqual(GOLDEN_RUN1_CALLS);
    expect(fake.posts).toEqual(GOLDEN_RUN1_POSTS);
    expect(watermarks()).toEqual(GOLDEN_RUN1_WATERMARKS);
    expect(replyLog()).toEqual(GOLDEN_RUN1_LOG);
    expect(result).toEqual(GOLDEN_RUN1_RESULT);
  });

  it('run 2 (no new messages): literal call list, sends, watermarks, reply log', async () => {
    fake.reset();
    vi.setSystemTime(Date.now() + 10000);
    const result = await runOnce();
    expect(fake.unscripted).toEqual([]);
    expect(fake.count('auth.test')).toBeGreaterThan(0);
    expect(fake.count('conversations.history')).toBeGreaterThan(0);
    expect(fake.calls).toEqual(GOLDEN_RUN2_CALLS);
    expect(fake.posts).toEqual(GOLDEN_RUN2_POSTS);
    expect(watermarks()).toEqual(GOLDEN_RUN2_WATERMARKS);
    expect(replyLog()).toEqual(GOLDEN_RUN2_LOG);
    expect(result).toEqual(GOLDEN_RUN2_RESULT);
  });
});
