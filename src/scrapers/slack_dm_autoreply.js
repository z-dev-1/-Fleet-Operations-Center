'use strict';
/**
 * slack_dm_autoreply.js — DM Auto-Reply engine (2026-07-23)
 *
 * Same shape as slack_channel_watch.js (Partner Auto-Reply), applied to
 * Z's personal Slack DMs instead of shared partner channels. For every new
 * incoming DM:
 *   1. Sends it to the AI (persona: src/orcha/slack-dm-persona.js, adaptive
 *      tone) via sendOrchaChat() -- the SAME persistent Fleet Brain session
 *      used elsewhere in the app for unit/site Q&A, so fleet questions get
 *      real answers instead of generic guesses.
 *   2. ALWAYS sends a reply back, in Z's voice -- the real answer if
 *      confident, or a natural holding reply otherwise. The other person
 *      never sees silence or an obviously robotic non-answer.
 *   3. If Z's own judgment/decision/knowledge is actually needed, ALSO logs
 *      a review-queue entry (Alert / Action / Workflow) in the Orcha
 *      floater's Review tab -- in addition to, not instead of, the reply.
 *
 * SAFETY (mirrors slack_channel_watch.js exactly -- see that file's header
 * and src/orcha/slack-partner-persona.js's design note for the full
 * reasoning re: this app's "Slack always needs human approval" rule and why
 * fully-autonomous replies here are a deliberate, explicit exception):
 *   - Default OFF. Must be turned on explicitly in Settings.
 *   - First-ever poll of a DM thread only baselines "last seen" -- does NOT
 *     reply to pre-existing history the moment this is turned on.
 *   - Never replies to its own previous messages (loop prevention via
 *     userId != own userId, same as channel watch).
 *   - Re-entrancy lock, same pattern as channel watch's _pollLock (that file
 *     documents a real incident this prevents: overlapping polls sending
 *     duplicate replies).
 *   - Capped batch size + capped persisted log.
 *   - Every single reply (in-scope or not) is written to a persisted,
 *     reviewable log (store: slackDMReplies) -- nothing is silent.
 */

const store = require('../store');
const logger = require('../utils/logger').createLogger('slack_dm_autoreply');
const { PERSONA_SYSTEM_PROMPT } = require('../orcha/slack-dm-persona');

const MAX_MESSAGES_PER_POLL = 5;   // per DM thread, per poll cycle
const MAX_LOG_ENTRIES       = 500; // persisted reply log cap

let _pollLock = false; // mirrors slack_channel_watch.js's _pollLock exactly

function getDMAutoReplyConfig() {
  const cfg = store.load('slackDMAutoReplyConfig', null);
  if (cfg && typeof cfg === 'object') return cfg;
  const seeded = { enabled: false, threads: {} }; // threads: { [channelId]: { lastSeenTs, name } }
  store.save('slackDMAutoReplyConfig', seeded);
  return seeded;
}

function saveDMAutoReplyConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config must be an object');
  store.save('slackDMAutoReplyConfig', config);
  return { ok: true };
}

function _saveThreadLastSeen(channelId, name, ts) {
  const cfg = getDMAutoReplyConfig();
  if (!cfg.threads) cfg.threads = {};
  cfg.threads[channelId] = { name, lastSeenTs: ts };
  store.save('slackDMAutoReplyConfig', cfg);
}

function _appendReplyLog(entry) {
  const log = store.load('slackDMReplies', []);
  log.unshift(entry); // newest first
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  store.save('slackDMReplies', log);
}

function getDMReviewQueue() {
  const log = store.load('slackDMReplies', []);
  return log.filter(e => e.inScope === false && e.status === 'open');
}

function getDMReplyLog(limit) {
  const log = store.load('slackDMReplies', []);
  return log.slice(0, limit || 100);
}

function updateDMReviewItem(id, updates) {
  const log = store.load('slackDMReplies', []);
  const matches = log.filter(e => e.id === id);
  if (!matches.length) return { ok: false, error: 'not found' };
  matches.forEach(item => Object.assign(item, updates || {}));
  store.save('slackDMReplies', log);
  return { ok: true, item: matches[0], updatedCount: matches.length };
}

// ── AI classify + draft ──────────────────────────────────────────────────
// Uses relay.ask() -- full fallback chain (fleet-brain -> WS -> Claude Code
// -> Bedrock). The DM persona + conversation context are carried in the
// prompt, so no persistent session is required here.
async function _classifyAndDraft(messageText, historyMsgs) {
  // historyMsgs: optional array of strings ("Speaker: text") from recent
  // conversation, oldest-first, to give the AI context before replying.
  let contextBlock = '';
  if (historyMsgs && historyMsgs.length) {
    contextBlock = '\n\nRecent conversation context (for reference):\n' + historyMsgs.join('\n') + '\n';
  }
  const prompt = PERSONA_SYSTEM_PROMPT + contextBlock + '\n\nIncoming DM:\n' + messageText;
  // FIX (2026-07-24): was using sendOrchaChat() (direct WS-only, 90s timeout,
  // no fallback). If the Orcha WS server is not running or slow, EVERY DM call
  // timed out and sent the canned fallback reply. Switch to relay.ask() which
  // has the full chain: fleet-brain -> WS -> Claude Code -> Bedrock.
  let raw;
  try {
    const relay = require('../orcha/relay');
    raw = await relay.ask(prompt);
  } catch (e) {
    logger.warn('[SlackDM] AI call threw:', e.message);
    raw = null;
  }

  const fallback = {
    inScope: false,
    reply: "hey, let me look into that and get back to you shortly",
    category: 'workflow',
    title: (messageText || '').slice(0, 60),
  };

  if (!raw) {
    logger.warn('[SlackDM] AI call failed or empty, using safe fallback');
    return fallback;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn('[SlackDM] AI response had no JSON object, using safe fallback. Raw:', raw.slice(0, 200));
    return fallback;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw new Error('missing reply field');
    return {
      inScope: parsed.inScope === true,
      reply: parsed.reply,
      category: ['alert', 'action', 'workflow'].includes(parsed.category) ? parsed.category : 'workflow',
      title: (typeof parsed.title === 'string' && parsed.title.trim()) ? parsed.title.slice(0, 60) : (messageText || '').slice(0, 60),
    };
  } catch (e) {
    logger.warn('[SlackDM] AI JSON parse failed, using safe fallback:', e.message);
    return fallback;
  }
}

// ── Main poll cycle ──────────────────────────────────────────────────────
async function pollDMAutoReplyOnce(log) {
  const doLog = log || ((msg) => logger.info(msg));

  if (_pollLock) {
    doLog('[SlackDM] Poll already in progress — skipping overlapping call');
    return { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true };
  }
  _pollLock = true;
  try {

  const config = getDMAutoReplyConfig();
  if (!config.enabled) { doLog('[SlackDM] Disabled — skipping poll'); return { repliedCount: 0, escalatedCount: 0, items: [] }; }

  const { listOpenDMs, readMessages, sendToChannel, checkLiveAuth } = require('./slack_send');

  const auth = await checkLiveAuth();
  if (!auth || !auth.authenticated) { doLog('[SlackDM] Slack not authenticated — skipping poll'); return { repliedCount: 0, escalatedCount: 0, items: [] }; }
  const myUserId = auth.userId || '';

  let repliedCount = 0, escalatedCount = 0;
  const newEscalations = [];

  const dms = await listOpenDMs(40);
  if (!dms.length) return { repliedCount: 0, escalatedCount: 0, items: [] };

  for (const dm of dms) {
    try {
      const messages = await readMessages(dm.channelId, 20); // newest-first
      if (!messages.length) continue;

      const threads = config.threads || {};
      const seen = threads[dm.channelId];

      // FIRST-EVER poll of this DM thread: baseline only, do not reply to
      // pre-existing history (same safety rule as channel watch).
      if (!seen || !seen.lastSeenTs) {
        _saveThreadLastSeen(dm.channelId, dm.name, messages[0].ts);
        doLog(`[SlackDM] ${dm.name}: first poll — baselined at ts ${messages[0].ts}, no replies sent for existing history`);
        continue;
      }

      const newMsgs = messages
        .filter(m => parseFloat(m.ts) > parseFloat(seen.lastSeenTs))
        .filter(m => m.userId && m.userId !== myUserId) // skip our own + system/empty-author messages
        .reverse()
        .slice(0, MAX_MESSAGES_PER_POLL);

      if (!newMsgs.length) continue;

      for (const msg of newMsgs) {
        // Defense-in-depth dedup, on top of _pollLock (same rationale as
        // channel watch's identical check — see that file for the real
        // incident it prevents).
        const existingLog = store.load('slackDMReplies', []);
        if (existingLog.some(e => e.id === dm.channelId + ':' + msg.ts)) {
          doLog(`[SlackDM] ${dm.name}: message ${msg.ts} already replied to (found in log) — skipping duplicate`);
          continue;
        }

        // Grab up to 2 messages that came before this one for context.
        // messages[] is newest-first; filter to older ts, take first 2 (most
        // recent before this msg), then reverse to chronological order.
        const historyMsgs = messages
          .filter(m => parseFloat(m.ts) < parseFloat(msg.ts))
          .slice(0, 2)
          .reverse()
          .map(m => (m.userId === myUserId ? 'You' : (dm.name || 'Them')) + ': ' + (m.text || ''));
        const draft = await _classifyAndDraft(msg.text, historyMsgs);

        let replyTs = null;
        try {
          const sendResult = await sendToChannel(dm.channelId, draft.reply);
          replyTs = sendResult.ts;
          repliedCount++;
        } catch (e) {
          doLog(`[SlackDM] ${dm.name}: reply send FAILED: ${e.message}`);
        }

        const entry = {
          id: dm.channelId + ':' + msg.ts,
          channelId: dm.channelId,
          channelName: dm.name,
          ts: msg.ts,
          replyTs,
          question: msg.text,
          reply: draft.reply,
          inScope: draft.inScope,
          category: draft.inScope ? null : draft.category,
          title: draft.title,
          createdAt: new Date().toISOString(),
          status: draft.inScope ? 'auto-answered' : 'open',
        };
        _appendReplyLog(entry);

        if (!draft.inScope) {
          escalatedCount++;
          newEscalations.push(entry);
          doLog(`[SlackDM] ${dm.name}: escalated (${draft.category}) — "${draft.title}"`);
        } else {
          doLog(`[SlackDM] ${dm.name}: answered`);
        }
      }

      _saveThreadLastSeen(dm.channelId, dm.name, newMsgs[newMsgs.length - 1].ts);
    } catch (e) {
      doLog(`[SlackDM] ${dm.name}: poll error: ${e.message}`);
    }
  }

  return { repliedCount, escalatedCount, items: newEscalations };
  } finally {
    _pollLock = false;
  }
}

module.exports = {
  getDMAutoReplyConfig,
  saveDMAutoReplyConfig,
  pollDMAutoReplyOnce,
  getDMReviewQueue,
  getDMReplyLog,
  updateDMReviewItem,
};
