// tests/slack-channel-speedup.test.js
//
// Phase 4b T6 (S4 only; S3 thread-reply reuse is deferred): pmAlertSharedHistory
// in the REAL pollChannelsOnce over the REAL slack_send, whose raw transport is
// a scripted fake. Same non-Slack fake set as tests/slack-speedup-parity-channel.test.js
// (the claims-harness fakes except slack_send, plus pm_alert_reply and ../ipc/ai).
// The ready-pickup fake runs between the PM scan read and the main loop, which
// is exactly the S4 snapshot window, so it is used to "post" messages there.
//
// One engine per file (design §9.0). No network, no Slack, no Electron.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slk-ch-speedup-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

const ME = 'UME';
let readyHook = null; // runs inside handleReadyReplies: after the PM scan read, before the main loop
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
injectFake('../src/scrapers/ready_pickup_notify', { handleReadyReplies: async () => { if (readyHook) readyHook(); } });
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
const T = (off) => (NOW_MS / 1000 + off).toFixed(6);
const ENV_KEYS = ['FLEET_SLACK_DM_PEER_CACHE', 'FLEET_SLACK_DM_SKIP_UNCHANGED', 'FLEET_SLACK_PM_SHARED_HISTORY',
  'FLEET_SLACK_LANE_CONCURRENCY', 'FLEET_SLACK_LANE_TIER_PACING', 'FLEET_COMMS_CHANNEL_CLAIMS'];

let fake, ss, engine;

// PM channel P1 (mentions + pmAlertAutoReply): one PM ALERT root whose reply does
// not tag me (the scan fetches that one thread), and tracked mention thread B.
const B = T(-5000);
function seed({ claims = false } = {}) {
  fake = createFakeSlack({ me: ME });
  ss = loadRealSlackSend(require, tmpDir, fake);
  fake.conv = {
    P1: {
      messages: [
        { ts: T(-4000), user: 'UPART', text: 'morning', },
        { ts: B, user: 'UPART', text: 'unit 9 thread', reply_count: 1, latest_reply: T(-4900), thread_ts: B },
        { ts: T(-7000), user: 'UBOT', text: 'PM ALERT unit 42', reply_count: 1, latest_reply: T(-6990), thread_ts: T(-7000) },
      ],
      replies: {
        [B]: [
          { ts: B, user: 'UPART', text: 'unit 9 thread', reply_count: 1, latest_reply: T(-4900), thread_ts: B },
          { ts: T(-4900), user: ME, text: 'looking', thread_ts: B },
        ],
        [T(-7000)]: [
          { ts: T(-7000), user: 'UBOT', text: 'PM ALERT unit 42', reply_count: 1, latest_reply: T(-6990), thread_ts: T(-7000) },
          { ts: T(-6990), user: 'UBOT', text: 'details', thread_ts: T(-7000) },
        ],
      },
    },
  };
  store.save('settings', {});
  store.save('fasInboundClaims', {});
  store.save('slackMentionThreads', { P1: [B] });
  store.save('slackChannelReplies', []);
  store.save('slackChannelWatchConfig', { enabled: true, replyMode: 'mentions', channels: [
    { id: 'P1', name: 'mmfm', enabled: true, replyMode: 'mentions', pmAlertAutoReply: true, lastSeenTs: T(-600) },
  ] });
  setFlags(null, claims);
}
function setFlags(speedup, claims = false) {
  const comms = {};
  if (speedup) comms.speedup = speedup;
  if (claims) comms.channelWatchClaims = true;
  store.save('settings', Object.keys(comms).length ? { comms } : {});
}
const S4 = { pmAlertSharedHistory: true };
const wm = (id) => store.load('slackChannelWatchConfig').channels.find(c => c.id === id).lastSeenTs;
const hist = (id) => fake.calls.filter(c => c[0] === 'conversations.history' && c[1].channel === id).length;
const repl = (id, ts) => fake.calls.filter(c => c[0] === 'conversations.replies' && c[1].channel === id && (!ts || c[1].ts === ts)).length;
const logIds = () => (store.load('slackChannelReplies', []) || []).map(e => e.id);
async function runOnce() {
  const res = await drive(engine.pollChannelsOnce((m) => LOGS.push({ ns: 'run', level: 'info', msg: m })), vi);
  await drive(engine.__test__.waitForAiQueueIdle(60000), vi);
  return res;
}
// Partner "posts" (as Slack would show them on the next read).
function postRoot(ts, text, user = 'UPART') { fake.conv.P1.messages.unshift({ ts, user, text }); }
function postReply(parent, ts, text, user = 'UPART') {
  const c = fake.conv.P1;
  c.replies[parent].push({ ts, user, text, thread_ts: parent });
  const root = c.messages.find(m => m.ts === parent);
  root.reply_count = (root.reply_count || 0) + 1; root.latest_reply = ts;
  c.replies[parent][0] = { ...root };
}

beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  seed();
  delete require.cache[require.resolve('../src/scrapers/slack_channel_watch.js')];
  engine = require('../src/scrapers/slack_channel_watch.js');
});
beforeEach(() => {
  vi.setSystemTime(NOW_MS);
  LOGS.length = 0;
  readyHook = null;
  engine.__test__.resetSpeedup();
});
afterAll(() => {
  vi.useRealTimers();
  try { ss._setRawRequestForTests(null); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe.sequential('S4 pmAlertSharedHistory (real pollChannelsOnce)', () => {
  it('flags off: two PM-channel root reads per run, today\'s 4-argument scan read, no stats, no new log lines', async () => {
    seed();
    await runOnce();
    expect(hist('P1')).toBe(2);
    expect(repl('P1', B)).toBe(1);
    expect(repl('P1', T(-7000))).toBe(1);
    expect(engine.getSpeedupStats()).toMatchObject({ flags: null, lastRun: null, totals: { runs: 0 } });
    expect(LOGS.some(l => /speedup/.test(l.msg))).toBe(false);
    expect(fake.unscripted).toEqual([]);
  });

  it('on, no race: exactly 1 root read per run for the PM channel; same thread fetches; no fallback', async () => {
    seed();
    setFlags(S4);
    for (let i = 0; i < 3; i++) {
      fake.reset();
      await runOnce();
      expect(fake.count('auth.test')).toBe(1);
      expect(hist('P1')).toBe(1);
      expect(repl('P1', B)).toBe(1);                // tracked mention thread still fetched fresh (no S3)
      expect(repl('P1', T(-7000))).toBe(1);         // PM scan thread untouched
      vi.setSystemTime(Date.now() + 10000);
    }
    const st = engine.getSpeedupStats();
    expect(st.flags.pmAlertSharedHistory).toBe(true);
    expect(st.lastRun).toEqual({ threadFetched: 1, rootReadsShared: 1, reasons: { mixedSnapshot: 0, fallbackReadFailed: 0 } });
    expect(st.totals).toMatchObject({ runs: 3, rootReadsShared: 3, threadFetched: 3 });
    expect(wm('P1')).toBe(T(-600));
    expect(fake.posts).toEqual([]);
    // one summary line per 5 min
    expect(LOGS.filter(l => /\[SlackWatch\] speedup: threads fetched 1, roots shared 1, mixed 0, fallback read failed 0/.test(l.msg)).length).toBe(1);
  });

  it('(a) S4 race: root r posted after the scan read, fresh reply y > r in B → guard re-reads; r and y processed once', async () => {
    seed();
    setFlags(S4);
    const r = T(-20), y = T(-10);
    readyHook = () => {
      readyHook = null;
      postRoot(r, `<@${ME}> where is unit 7?`);
      postReply(B, y, `<@${ME}> any update on unit 9?`);
    };
    fake.reset();
    await runOnce();
    const st = engine.getSpeedupStats();
    expect(st.lastRun.reasons.mixedSnapshot).toBe(1);
    expect(st.lastRun.rootReadsShared).toBe(1);
    expect(hist('P1')).toBe(2);                     // scan read + the guard's fresh re-read (today's count)
    expect(repl('P1', B)).toBe(2);                  // fetched, then re-fetched with the fresh roots
    expect(logIds().filter(id => id === 'P1:' + r).length).toBe(1);
    expect(logIds().filter(id => id === 'P1:' + y).length).toBe(1);
    expect(fake.posts.length).toBe(2);
    expect(parseFloat(wm('P1'))).toBeGreaterThanOrEqual(parseFloat(y));
    // next run: nothing new, nothing re-sent
    fake.reset(); vi.setSystemTime(Date.now() + 10000);
    await runOnce();
    expect(fake.posts).toEqual([]);
  });

  it('flags off, same race: today\'s path also processes r and y once (parity of outcome)', async () => {
    seed();
    const r = T(-20), y = T(-10);
    readyHook = () => {
      readyHook = null;
      postRoot(r, `<@${ME}> where is unit 7?`);
      postReply(B, y, `<@${ME}> any update on unit 9?`);
    };
    await runOnce();
    expect(logIds().filter(id => id === 'P1:' + r).length).toBe(1);
    expect(logIds().filter(id => id === 'P1:' + y).length).toBe(1);
    expect(parseFloat(wm('P1'))).toBeGreaterThanOrEqual(parseFloat(y));
  });

  it('(g) the guard\'s re-read throws → fallbackReadFailed, today\'s merge-failure line, snapshot roots only, no poll error; next run catches up once', async () => {
    seed();
    setFlags(S4);
    const r = T(-20), y = T(-10);
    readyHook = () => {
      readyHook = null;
      postRoot(r, `<@${ME}> where is unit 7?`);
      postReply(B, y, `<@${ME}> any update on unit 9?`);
      fake.historyFail.add('P1');                   // the fallback re-read fails
    };
    await runOnce();
    const st = engine.getSpeedupStats();
    expect(st.lastRun.reasons).toEqual({ mixedSnapshot: 1, fallbackReadFailed: 1 });
    expect(LOGS.some(l => /mmfm: thread-reply merge failed \(non-fatal, falling back to root messages only\)/.test(l.msg))).toBe(true);
    expect(LOGS.some(l => /poll error/.test(l.msg))).toBe(false);
    expect(fake.posts).toEqual([]);                 // the snapshot roots hold nothing new
    expect(wm('P1')).toBe(T(-600));                 // watermark not moved past the unseen r / y
    fake.historyFail.clear(); fake.reset(); vi.setSystemTime(Date.now() + 10000);
    await runOnce();
    expect(logIds().filter(id => id === 'P1:' + r).length).toBe(1);
    expect(logIds().filter(id => id === 'P1:' + y).length).toBe(1);
    expect(fake.posts.length).toBe(2);
  });

  it('(d) spurious fallback: a fresh thread whose root is outside the snapshot falls back once; _observedMax covers it next run', async () => {
    seed();
    setFlags(S4);
    // Tracked thread X: root not in the newest-20 window, holds an OLD reply (≤ watermark)
    // that is still newer than every snapshot ts / latestReply.
    const X = T(-90000);
    fake.conv.P1.replies[X] = [
      { ts: X, user: 'UPART', text: 'ancient root', reply_count: 1, latest_reply: T(-700), thread_ts: X },
      { ts: T(-700), user: 'UPART', text: 'old reply', thread_ts: X },
    ];
    store.save('slackMentionThreads', { P1: [B, X] });
    await runOnce();
    expect(engine.getSpeedupStats().lastRun.reasons.mixedSnapshot).toBe(1);
    fake.reset(); vi.setSystemTime(Date.now() + 10000);
    await runOnce();
    expect(engine.getSpeedupStats().lastRun.reasons.mixedSnapshot).toBe(0);
    expect(hist('P1')).toBe(1);
    expect(fake.posts).toEqual([]);
    // resetSpeedup clears _observedMax: the cold cutoff falls back once more
    engine.__test__.resetSpeedup();
    fake.reset(); vi.setSystemTime(Date.now() + 10000);
    await runOnce();
    expect(engine.getSpeedupStats().lastRun.reasons.mixedSnapshot).toBe(1);
    expect(engine.getSpeedupStats().totals.runs).toBe(1);
  });

  it('a PM scan that returns early (no roots) leaves the main loop on today\'s own root read', async () => {
    seed();
    setFlags(S4);
    fake.conv.P1.messages = [];
    await runOnce();
    expect(hist('P1')).toBe(2);
    expect(engine.getSpeedupStats().lastRun.rootReadsShared).toBe(0);
  });

  it('on + claims: exactly one send per inbound across 3 runs', async () => {
    seed({ claims: true });
    setFlags(S4, true);
    const r = T(-20);
    postRoot(r, `<@${ME}> where is unit 7?`);
    for (let i = 0; i < 3; i++) { await runOnce(); vi.setSystemTime(Date.now() + 10000); }
    expect(fake.posts.filter(p => p.channel === 'P1').length).toBe(1);
    expect(fake.posts[0].text).toContain('legacy answer');
    expect(Object.keys(store.load('fasInboundClaims', {}) || {}).length).toBeGreaterThan(0);
  });
});
