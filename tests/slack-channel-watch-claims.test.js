// tests/slack-channel-watch-claims.test.js
//
// Phase 4 (FEAT-003): partner-channel durable inbound claim in
// slack_channel_watch.pollChannelsOnce, behind comms.channelWatchClaims
// (FLEET_COMMS_CHANNEL_CLAIMS). Drives the REAL pollChannelsOnce with the REAL
// store + REAL inbound-claim in a temp data dir; every other dependency on the
// partner path is a require.cache fake (pattern of tests/slack-justme-queue).
// No network, no Slack, no Electron.
//
// require( sites in slack_channel_watch.js (all covered below):
//   top-level: ../store (real), ../utils/logger (fake recorder),
//     ../orcha/slack-partner-persona (real, constant), ./slack_decision_trace,
//     ../orcha/fas/shadow, ../orcha/fas/runner, ../ai/core, ../slack/gateway,
//     ../orcha/fas/inbound-claim (real), ./slack_inbound_support
//   pollChannelsOnce: ./slack_send, ./orcha_ws, ./pm_alert_reply,
//     ./slack_justme_channel, ./ready_pickup_notify (pmAlert channels only),
//     ../config/perf-flags (real), ../orcha/fas/config, ../orcha/fas/sender-profiles
//   gates/draft: ../orcha/relay, ../orcha/ai-context
//   real ai/core (case 13a) additionally pulls ../orcha/fas/agent (faked).

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger fake (recording) — must be in place before store loads ─────────
const LOGS = [];
function _mkLogger(ns) {
  const rec = (level) => (...a) => { LOGS.push({ ns, level, msg: a.map(String).join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
const _loggerFn = (ns) => _mkLogger(ns);
_loggerFn.createLogger = _mkLogger;
injectFakeModule('../src/utils/logger', _loggerFn);

const tmpDir = path.join(os.tmpdir(), 'cw-claims-' + Date.now() + '-' + Math.random().toString(36).slice(2));
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const claim = require('../src/orcha/fas/inbound-claim');

// ── Per-test scripted state ───────────────────────────────────────────────
const CH = 'C1', ME = 'UME', PART = 'UPART';
const BASE = '1000.000000';
const TS = '1001.000100';
const LEGACY_TEXT = `<@${PART}> legacy answer`;
const FAS_TEXT = `<@${PART}> fas answer`;
let S;
function resetState() {
  S = {
    messages: [], sends: [], sendOk: 0,
    sendImpl: null,
    fasCfg: { enabled: false },
    runnerImpl: async () => ({ mode: 'disabled', letLegacyReply: true, outcome: 'disabled' }),
    coreImpl: null,
    runnerCalls: 0, runnerDeps: null, queued: [], manualReview: [],
    askCalls: 0, gate: 'YES', ctxThrow: 0,
    doLogs: [],
  };
  LOGS.length = 0;
}
resetState();

const fakeSend = async (cid, text, thr) => {
  S.sends.push([cid, text, thr]);
  if (S.sendImpl) return S.sendImpl(cid, text, thr);
  S.sendOk++;
  return { ts: 'R' + S.sendOk };
};
const slackSendFake = {
  checkLiveAuth: async () => ({ authenticated: true, userId: ME, user: 'me' }),
  readMessages: async () => S.messages.slice(),
  readThreadReplies: async () => [],
  sendToChannel: fakeSend,
  uploadFileToChannel: async () => ({}),
  downloadFileBuffer: async () => null,
};
injectFakeModule('../src/scrapers/slack_send', slackSendFake);
const runnerFake = {
  handleInbound: (i, d) => { S.runnerCalls++; S.runnerDeps = d; return S.runnerImpl(i, d); },
  _queueManualReview: (...a) => { S.manualReview.push(a); },
};
injectFakeModule('../src/orcha/fas/runner', runnerFake);
const coreFake = { handleInbound: (i, d) => (S.coreImpl ? S.coreImpl(i, d) : runnerFake.handleInbound(i, d)) };
injectFakeModule('../src/ai/core', coreFake);
injectFakeModule('../src/orcha/fas/agent', {});
injectFakeModule('../src/orcha/fas/config', { get: () => S.fasCfg });
injectFakeModule('../src/orcha/fas/sender-profiles', { resolveSender: () => null });
injectFakeModule('../src/orcha/fas/shadow', { runShadow: () => {} });
injectFakeModule('../src/scrapers/slack_decision_trace', { trace: () => {} });
injectFakeModule('../src/slack/gateway', {
  buildRunnerInput: (raw, extra) => ({ engine: 'channel', channelId: raw.conv.channelId, ts: raw.message.ts,
    threadTs: raw.message.threadTs, text: raw.message.text, slackId: raw.message.userId, ...extra }),
});
injectFakeModule('../src/scrapers/slack_inbound_support', {
  discoverSenders: async () => ({ created: 0, discovered: 0 }),
  isSendBlocked: () => false,
  markSendBlocked: () => {},
  clearSendBlocked: () => {},
  lifecycle: () => {},
  classifySendError: () => ({ kind: 'transient' }),
  REASON: { SEND_BLOCKED: 'send-blocked', SEND_FAILED_RETRY: 'send-failed-retry' },
});
injectFakeModule('../src/scrapers/orcha_ws', { askOrcha: async () => ({ text: '' }) });
injectFakeModule('../src/scrapers/pm_alert_reply', {
  resolveOperatorEntry: () => null, looksLikeAlert: () => false, isTaggedIn: () => false, handleTaggedPmAlert: async () => ({}),
});
injectFakeModule('../src/scrapers/ready_pickup_notify', { handleReadyReplies: async () => {} });
injectFakeModule('../src/scrapers/slack_justme_channel', { channelMode: (ch) => ch.replyMode });
injectFakeModule('../src/orcha/relay', {
  runWithTimeout: async () => ({ text: S.gate }),
  askWithTimeout: async () => { S.askCalls++; return JSON.stringify({ inScope: true, reply: 'legacy answer', category: null, title: 't' }); },
});
injectFakeModule('../src/orcha/ai-context', {
  buildFleetContext: () => { if (S.ctxThrow > 0) { S.ctxThrow--; throw new Error('ctx boom'); } return ''; },
});

const SUT = '../src/scrapers/slack_channel_watch.js';
const CORE = '../src/ai/core';
function loadSut(opts = {}) {
  const coreResolved = require.resolve(CORE);
  delete require.cache[require.resolve(SUT)];
  if (opts.realCore) {
    delete require.cache[coreResolved];
    require(CORE); // real ai/core over the fake runner
  } else {
    require.cache[coreResolved] = { id: coreResolved, filename: coreResolved, loaded: true, exports: coreFake };
  }
  return require(SUT);
}

// ── Fixtures / helpers ────────────────────────────────────────────────────
const ORIG_ENV = process.env.FLEET_COMMS_CHANNEL_CLAIMS;
function claims(on) { if (on) process.env.FLEET_COMMS_CHANNEL_CLAIMS = '1'; else delete process.env.FLEET_COMMS_CHANNEL_CLAIMS; }
function seedConfig(lastSeenTs = BASE, replyMode = 'mentions') {
  store.save('slackChannelWatchConfig', { enabled: true, replyMode,
    channels: [{ id: CH, name: 'partner-a', enabled: true, replyMode, pmAlertAutoReply: false, lastSeenTs }] });
}
function resetDocs() {
  store.save('fasInboundClaims', {});
  store.save('slackChannelReplies', []);
  store.save('slackMentionThreads', {});
  store.save('settings', {});
  seedConfig();
}
const lastSeen = () => store.load('slackChannelWatchConfig').channels[0].lastSeenTs;
const mention = (ts = TS) => ({ ts, text: `<@${ME}> where is unit 42?`, userId: PART, threadTs: null });
const KEY = () => claim.claimKey(CH, TS, null);
const ledger = () => store.load('fasInboundClaims', {}) || {};
const replyEntries = () => (store.load('slackChannelReplies', []) || []).filter(e => e.id === CH + ':' + TS);
const doLog = (m) => { S.doLogs.push(m); };
const logged = (re) => S.doLogs.some(m => re.test(m));
const simulateCrash = () => { store.save('slackChannelReplies', []); seedConfig(BASE); };

// Count (and optionally fail) store.update('fasInboundClaims') calls. plan(n) -> 'throw' fails the nth call.
function claimUpdateSpy(plan) {
  const orig = store.update;
  const calls = { n: 0 };
  vi.spyOn(store, 'update').mockImplementation(function (name, fn, d) {
    if (name === 'fasInboundClaims') {
      calls.n++;
      if (plan && plan(calls.n) === 'throw') throw new Error('ledger down');
    }
    return orig.call(store, name, fn, d);
  });
  return calls;
}

// Reply semantics unchanged: every send carries the same text/thread as flag-off.
function expectSendArgs(text) {
  for (const s of S.sends) expect(s).toEqual([CH, text, TS]);
}

const R = {
  autoSent: async (i, d) => {
    const r = await d.sendToChannel(i.channelId, FAS_TEXT, i.ts);
    return { mode: 'autonomous', outcome: 'auto-sent', sent: r, decision: { reply: 'fas answer' } };
  },
  queued: async () => ({ mode: 'approval', outcome: 'queued' }),
  noReply: async () => ({ mode: 'autonomous', outcome: 'no-reply', decision: { reasonCode: 'NO_RESPONSE_NEEDED' } }),
  autoSendFailed: async (i, d) => {
    try { await d.sendToChannel(i.channelId, FAS_TEXT, i.ts); } catch (_) { S.queued.push(i.ts); }
    return { mode: 'autonomous', outcome: 'auto-send-failed' };
  },
  sendThenThrow: async (i, d) => {
    await d.sendToChannel(i.channelId, FAS_TEXT, i.ts);
    throw new Error('post-send boom');
  },
};

beforeEach(() => { resetState(); resetDocs(); claims(false); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  if (ORIG_ENV === undefined) delete process.env.FLEET_COMMS_CHANNEL_CLAIMS; else process.env.FLEET_COMMS_CHANNEL_CLAIMS = ORIG_ENV;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

// ── Flags-off parity ──────────────────────────────────────────────────────
describe('flag off — identical to today', () => {
  it('case 1: replay after a crash sends twice (documented gap), 0 ledger writes, raw sendToChannel injected', async () => {
    const calls = claimUpdateSpy();
    const watch = loadSut();
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    simulateCrash();
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(2);
    expectSendArgs(LEGACY_TEXT);

    // FAS auto-sent path, flag off
    resetState(); resetDocs();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.autoSent;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expectSendArgs(FAS_TEXT);
    expect(S.runnerDeps.sendToChannel).toBe(slackSendFake.sendToChannel);
    expect(calls.n).toBe(0);
    expect(ledger()).toEqual({});
  });

  it('case 15: exception after the would-be acquire point -> same poll error, 0 ledger writes', async () => {
    const calls = claimUpdateSpy();
    const watch = loadSut();
    S.messages = [mention()];
    S.ctxThrow = 1;
    await watch.pollChannelsOnce(doLog);
    expect(logged(/partner-a: poll error: ctx boom/)).toBe(true);
    expect(S.sends.length).toBe(0);
    expect(lastSeen()).toBe(BASE);
    expect(calls.n).toBe(0);
  });
});

// ── Flag on ───────────────────────────────────────────────────────────────
describe('flag on — durable partner-channel claim', () => {
  beforeEach(() => { claims(true); });

  it('case 2: legacy path, replay after crash -> 1 send total, claim delivered', async () => {
    const watch = loadSut();
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
    simulateCrash();
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expectSendArgs(LEGACY_TEXT);
    expect(logged(/already delivered \(durable claim\) — skipping/)).toBe(true);
  });

  it('case 3: FAS auto-sent via injected send -> delivered; replay 0 extra sends', async () => {
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.autoSent;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
    expect(S.runnerDeps.sendToChannel).not.toBe(slackSendFake.sendToChannel);
    simulateCrash();
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expect(S.runnerCalls).toBe(1);
    expectSendArgs(FAS_TEXT);
  });

  it('case 4: FAS queued -> owned; replay skips', async () => {
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'approval' };
    S.runnerImpl = R.queued;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY()).status).toBe('owned');
    simulateCrash();
    await watch.pollChannelsOnce(doLog);
    expect(S.runnerCalls).toBe(1);
    expect(S.sends.length).toBe(0);
    expect(logged(/already owned \(durable claim\)/)).toBe(true);
  });

  it('case 5: no-reply -> delivered (terminal silence)', async () => {
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.noReply;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'no-reply:NO_RESPONSE_NEEDED' });
    expect(S.sends.length).toBe(0);
    expect(lastSeen()).toBe(TS);
  });

  it('case 6: auto-send-failed -> owned, 1 queued item, watermark advances as flag-off; replay 0 extra sends/items', async () => {
    const failing = () => { throw new Error('slack 500'); };
    // flag-off reference watermark
    claims(false);
    let watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.autoSendFailed; S.sendImpl = failing;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    const offWatermark = lastSeen();
    const offArgs = S.sends.slice();

    resetState(); resetDocs(); claims(true);
    watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.autoSendFailed; S.sendImpl = failing;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY()).status).toBe('owned');
    expect(S.queued.length).toBe(1);
    expect(lastSeen()).toBe(offWatermark);
    expect(lastSeen()).toBe(TS);
    expect(S.sends).toEqual(offArgs);

    simulateCrash();
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expect(S.queued.length).toBe(1);
    expect(S.runnerCalls).toBe(1);
  });

  it('case 6b (legacy): markDelivered throws after send -> 1 send, reply log written, watermark advances, error logged', async () => {
    claimUpdateSpy((n) => (n === 1 ? 'pass' : 'throw'));
    const watch = loadSut();
    S.messages = [mention()];
    const res = await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expectSendArgs(LEGACY_TEXT);
    expect(res.repliedCount).toBe(1);
    expect(replyEntries().length).toBe(1);
    expect(replyEntries()[0].replyTs).toBe('R1');
    expect(lastSeen()).toBe(TS);
    expect(LOGS.some(l => l.level === 'error' && /claim markDelivered failed after confirmed send R1/.test(l.msg))).toBe(true);
  });

  it('case 6b (FAS): markDelivered throws after send -> runner sees success, auto-sent, 0 queued, 1 send', async () => {
    claimUpdateSpy((n) => (n === 1 ? 'pass' : 'throw'));
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    let seen;
    S.runnerImpl = async (i, d) => { const r = await R.autoSent(i, d); seen = r; return r; };
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(seen.outcome).toBe('auto-sent');
    expect(seen.sent).toEqual({ ts: 'R1' });
    expect(S.queued.length).toBe(0);
    expect(S.sends.length).toBe(1);
    expectSendArgs(FAS_TEXT);
  });

  it('case 7: legacy send throws -> failed, watermark held', async () => {
    const watch = loadSut();
    S.sendImpl = () => { throw new Error('timeout'); };
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY())).toMatchObject({ status: 'failed', reason: 'legacy send failed: transient' });
    expect(parseFloat(lastSeen())).toBeLessThan(parseFloat(TS));
    expectSendArgs(LEGACY_TEXT);
  });

  it('case 8: live processing claim held; after lease expiry reconcile -> processed once', async () => {
    const now = Date.now();
    store.save('fasInboundClaims', { [KEY()]: { key: KEY(), channelId: CH, ts: TS, threadTs: null, status: 'processing',
      owner: 'digital-fas', leaseUntil: new Date(now + 60000).toISOString(), deliveredTs: null, attempts: 1 } });
    const watch = loadSut();
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(0);
    expect(parseFloat(lastSeen())).toBeLessThan(parseFloat(TS));
    expect(logged(/already processing \(durable claim, live lease\) — holding for retry/)).toBe(true);

    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60000);
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expect(claim.get(KEY()).status).toBe('delivered');
    expectSendArgs(LEGACY_TEXT);
  });

  it('case 9: expired legacy claim -> resumes as legacy, FAS not called, 1 send', async () => {
    store.save('fasInboundClaims', { [KEY()]: { key: KEY(), channelId: CH, ts: TS, threadTs: null, status: 'legacy',
      owner: 'legacy', leaseUntil: new Date(Date.now() - 1000).toISOString(), deliveredTs: null, attempts: 1 } });
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.autoSent;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.runnerCalls).toBe(0);
    expect(S.sends.length).toBe(1);
    expectSendArgs(LEGACY_TEXT);
    expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
  });

  it('case 10: skipped messages (other-person mention, strict gate NO) create no claim', async () => {
    const calls = claimUpdateSpy();
    const watch = loadSut();
    S.gate = 'NO';
    S.messages = [
      { ts: '1001.000200', text: '<@UOTHER> ping', userId: PART, threadTs: null },
      { ts: '1001.000100', text: 'hello all', userId: PART, threadTs: null },
    ];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(0);
    expect(calls.n).toBe(0);
    expect(ledger()).toEqual({});
  });

  it('case 11: acquire throws -> hold for retry, no send', async () => {
    claimUpdateSpy((n) => (n === 1 ? 'throw' : 'pass'));
    const watch = loadSut();
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(0);
    expect(parseFloat(lastSeen())).toBeLessThan(parseFloat(TS));
    expect(ledger()[KEY()]).toBeUndefined();
    expect(LOGS.some(l => l.level === 'warn' && /claim error 1001\.000100: ledger down — holding/.test(l.msg))).toBe(true);
  });

  it('case 12: markOwnedQueued throws on FAS queued -> logged, flow continues as flag-off', async () => {
    claimUpdateSpy((n) => (n === 1 ? 'pass' : 'throw'));
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'approval' };
    S.runnerImpl = R.queued;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(logged(/claim markOwnedQueued error 1001\.000100: ledger down — continuing/)).toBe(true);
    expect(lastSeen()).toBe(TS);
    expect(replyEntries().length).toBe(1);
    expect(replyEntries()[0].status).toBe('fas-queued');
  });

  for (const retire of [true, false]) {
    it(`case 13a: real ai/core converts post-send throw (retire=${retire}) -> 1 send, no legacy, no manual review`, async () => {
      const watch = loadSut({ realCore: true });
      S.fasCfg = { enabled: true, mode: 'autonomous', retireLegacyReasoning: retire };
      S.runnerImpl = R.sendThenThrow;
      S.messages = [mention()];
      await watch.pollChannelsOnce(doLog);
      expect(S.sends.length).toBe(1);
      expectSendArgs(FAS_TEXT);
      expect(S.askCalls).toBe(0);
      expect(S.manualReview.length).toBe(0);
      expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
      expect(replyEntries().length).toBe(1);
      expect(replyEntries()[0].status).toBe('fas-autonomous-sent');
      expect(lastSeen()).toBe(TS);
    });

    it(`case 13b: throw escapes to the FAS gate catch after the post (retire=${retire}) -> 1 send, no legacy, no manual review`, async () => {
      const watch = loadSut();
      S.fasCfg = { enabled: true, mode: 'autonomous', retireLegacyReasoning: retire };
      S.coreImpl = async (i, d) => { await d.sendToChannel(i.channelId, FAS_TEXT, i.ts); throw new Error('escaped'); };
      S.messages = [mention()];
      await watch.pollChannelsOnce(doLog);
      expect(S.sends.length).toBe(1);
      expectSendArgs(FAS_TEXT);
      expect(S.askCalls).toBe(0);
      expect(S.manualReview.length).toBe(0);
      expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
      expect(replyEntries().length).toBe(1);
      expect(replyEntries()[0].status).toBe('fas-autonomous-sent');
      expect(lastSeen()).toBe(TS);
    });
  }

  it('case 13c: wrapper markDelivered fails, _retryDeliveredMark lands it -> delivered, 1 send', async () => {
    claimUpdateSpy((n) => (n === 2 ? 'throw' : 'pass'));
    const watch = loadSut({ realCore: true });
    S.fasCfg = { enabled: true, mode: 'autonomous' };
    S.runnerImpl = R.sendThenThrow;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expect(claim.get(KEY())).toMatchObject({ status: 'delivered', deliveredTs: 'R1' });
    expect(S.askCalls).toBe(0);
  });

  it('case 14: exception after acquire before any post -> failed, poll error; next poll (no time advance) sends once', async () => {
    const watch = loadSut();
    S.ctxThrow = 1;
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY())).toMatchObject({ status: 'failed', reason: 'exception: ctx boom' });
    expect(S.sends.length).toBe(0);
    expect(logged(/partner-a: poll error: ctx boom/)).toBe(true);
    expect(lastSeen()).toBe(BASE);

    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(1);
    expectSendArgs(LEGACY_TEXT);
    expect(claim.get(KEY()).status).toBe('delivered');
  });

  it('case 14b: claim already owned before a throw -> stays owned; re-poll skips', async () => {
    const watch = loadSut();
    S.fasCfg = { enabled: true, mode: 'approval' };
    S.runnerImpl = R.queued;
    S.messages = [mention()];
    const origSave = store.save;
    const saveSpy = vi.spyOn(store, 'save').mockImplementation(function (k, d) {
      if (k === 'slackChannelReplies') throw new Error('disk full');
      return origSave.call(store, k, d);
    });
    await watch.pollChannelsOnce(doLog);
    expect(claim.get(KEY()).status).toBe('owned');
    expect(logged(/partner-a: poll error: disk full/)).toBe(true);
    saveSpy.mockRestore();

    await watch.pollChannelsOnce(doLog);
    expect(S.runnerCalls).toBe(1);
    expect(S.sends.length).toBe(0);
    expect(logged(/already owned \(durable claim\)/)).toBe(true);
  });

  it('T-F3a: no new messages and no expired entries -> 0 fasInboundClaims transactions', async () => {
    const calls = claimUpdateSpy();
    const watch = loadSut();
    S.messages = [];
    await watch.pollChannelsOnce(doLog);
    S.messages = [{ ts: '999.000000', text: `<@${ME}> old`, userId: PART, threadTs: null }]; // older than watermark
    await watch.pollChannelsOnce(doLog);
    expect(calls.n).toBe(0);
  });

  it('T-F3b: expired processing entry pre-seeded -> reconcile runs once, entry becomes failed', async () => {
    const k = claim.claimKey('C9', '1.000000', null);
    store.save('fasInboundClaims', { [k]: { key: k, channelId: 'C9', ts: '1.000000', threadTs: null, status: 'processing',
      owner: 'digital-fas', leaseUntil: new Date(Date.now() - 1000).toISOString(), deliveredTs: null, attempts: 1 } });
    const spy = vi.spyOn(claim, 'reconcile');
    const watch = loadSut();
    S.messages = [];
    await watch.pollChannelsOnce(doLog);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(claim.get(k).status).toBe('failed');
  });

  it('T-F4 (case 16): delivered claim written under the DM engine key -> 0 sends, already delivered', async () => {
    const k = claim.claimKey(CH, TS, null);
    store.save('fasInboundClaims', { [k]: { key: k, channelId: CH, ts: TS, threadTs: null, status: 'delivered',
      owner: 'digital-fas', leaseUntil: null, deliveredTs: 'DMREPLY', attempts: 1 } });
    const watch = loadSut();
    S.messages = [mention()];
    await watch.pollChannelsOnce(doLog);
    expect(S.sends.length).toBe(0);
    expect(logged(/message 1001\.000100 already delivered \(durable claim\) — skipping/)).toBe(true);
  });
});
