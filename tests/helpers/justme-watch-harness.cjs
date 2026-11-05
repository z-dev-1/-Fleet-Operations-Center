'use strict';
// tests/helpers/justme-watch-harness.cjs — drives the REAL Just Me runner in
// src/scrapers/slack_channel_watch.js (pollChannelsOnce → _pollJustMeChannel →
// job queue → _runJustMeJob) with require.cache fakes, the pattern of
// tests/slack-justme-queue.test.js. Installed once per test file at module scope.
//
// Fakes (real resolved paths):
//   src/store            in-memory; every save recorded as a JSON copy in S.saves
//   src/scrapers/slack_send  readMessages / readThreadReplies / sendToChannel (all args
//                        recorded) / checkLiveAuth (userId 'ME') / SELF_REPLY_MARKER
//   src/ipc/ai           processOrchaAction → S.poa (recorded), confirmSend → S.confirmSend
//   src/utils/logger     records every line (level + text) in S.logs
// opts.realAi: also load the REAL src/ipc/ai.js (S.realAi) with fakes for
//   src/orcha/relay (S.relayAsk, recorded in S.relayCalls; isolatedLaneAvailable → true)
//   and src/orcha/ai-context; set S.poa = S.realAi.processOrchaAction to use it.

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const r = (rel) => require.resolve(path.join(ROOT, rel));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const WATCH = r('src/scrapers/slack_channel_watch.js');

function installWatchFakes(opts = {}) {
  const S = {
    data: {}, saves: [], sent: [], messages: [], logs: [], poaCalls: [], relayCalls: [],
    sendImpl: null, poa: async (text) => ({ ok: true, text: 'answer:' + text }),
    confirmSend: async () => ({ ok: true, message: 'Sent.' }),
    relayAsk: async () => '{"reply":"ok","actions":[]}',
  };
  const put = (resolved, exportsObj) => { require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj }; };

  put(r('src/store'), {
    load: (k, fb) => (k in S.data ? clone(S.data[k]) : fb),
    save: (k, v) => { S.data[k] = clone(v); S.saves.push({ key: k, value: clone(v) }); },
  });
  put(r('src/scrapers/slack_send'), {
    readMessages: async () => S.messages.slice(),
    readThreadReplies: async () => [],
    sendToChannel: async (...args) => {
      S.sent.push({ args, text: args[1] });
      if (S.sendImpl) return S.sendImpl(...args);
      return { ts: 'reply-' + S.sent.length };
    },
    checkLiveAuth: async () => ({ authenticated: true, userId: 'ME' }),
    SELF_REPLY_MARKER: '\u200B\u2060',
  });
  put(r('src/ipc/ai'), {
    processOrchaAction: (...args) => { S.poaCalls.push(args); return S.poa(...args); },
    confirmSend: (...args) => S.confirmSend(...args),
  });
  const mk = () => {
    const rec = (level) => (...a) => { S.logs.push({ level, text: a.map(String).join(' ') }); };
    return { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  };
  const loggerFn = () => mk();
  loggerFn.createLogger = () => mk();
  loggerFn.setLogDir = () => {}; loggerFn.setLevel = () => {}; loggerFn.setSilent = () => {};
  put(r('src/utils/logger'), loggerFn);

  if (opts.realAi) {
    put(r('src/orcha/relay'), {
      ask: (...a) => { S.relayCalls.push({ prompt: a[0], opts: a[1] }); return S.relayAsk(...a); },
      isolatedLaneAvailable: () => true,
    });
    put(r('src/orcha/ai-context'), { buildFleetContext: () => '', resolveEntities: () => ({ units: [], groups: [] }) });
    const aiPath = r('src/ipc/ai');
    const fake = require.cache[aiPath];
    delete require.cache[aiPath];
    S.realAi = require(aiPath);
    require.cache[aiPath] = fake;
  }

  S.reset = () => {
    S.data = {}; S.saves = []; S.sent = []; S.messages = []; S.logs = []; S.poaCalls = []; S.relayCalls = [];
    S.sendImpl = null;
    S.poa = async (text) => ({ ok: true, text: 'answer:' + text });
    S.confirmSend = async () => ({ ok: true, message: 'Sent.' });
    S.relayAsk = async () => '{"reply":"ok","actions":[]}';
  };
  S.loadWatch = () => { delete require.cache[WATCH]; return require(WATCH); };
  S.seedChannel = (lastSeenTs) => {
    S.data.slackChannelWatchConfig = {
      enabled: true, replyMode: 'justme',
      channels: [{ id: 'CJM', name: 'just-me', enabled: true, replyMode: 'justme', lastSeenTs }],
    };
  };
  /** Post `msgs` (oldest first) as new messages and wait for every job to finish. */
  S.run = async (watch, msgs, idleMs) => {
    S.messages = msgs.slice().reverse().concat(S.messages);   // newest-first like conversations.history
    await watch.pollChannelsOnce(() => {});
    await watch.__test__.waitForAiQueueIdle(idleMs || 5000);
  };
  S.replyLog = () => S.data.slackChannelReplies || [];
  S.logText = () => S.logs.map((l) => l.text).join('\n');
  return S;
}

module.exports = { installWatchFakes };
