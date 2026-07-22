'use strict';
/**
 * slack_channel_watch.js — Partner Auto-Reply engine (2026-07-21)
 *
 * Watches a configured list of Slack channels (default: the 4 Slack
 * Connect channels shared with external partner orgs the user specified),
 * and for every new message:
 *   1. Sends it to the AI (persona: src/orcha/slack-partner-persona.js) for
 *      classification + a drafted reply.
 *   2. ALWAYS posts a professional threaded reply back -- either the real
 *      answer (in scope) or a warm holding reply (out of scope). Partners
 *      never see silence.
 *   3. If out of scope, ALSO logs a review-queue entry (🚨 Alert / 💡 Action
 *      / 📍 Workflow) for a human to review in the Orcha floater's Review
 *      tab -- in addition to, not instead of, the in-channel reply.
 *
 * SAFETY: see the design-note comment in slack-partner-persona.js for the
 * full reasoning re: this app's existing "Slack always needs human
 * approval" principle and the two compensating safeguards used instead
 * (full reply log + escalation queue). Additional safeguards here:
 *   - First-ever poll of a channel only baselines the "last seen" position
 *     -- it does NOT reply to pre-existing history. Prevents a flood of
 *     replies to old, already-resolved messages the moment this feature
 *     is turned on.
 *   - Never replies to its own previous messages (loop prevention).
 *   - Caps processing to MAX_MESSAGES_PER_POLL new messages per channel
 *     per cycle, and caps the persisted reply log to MAX_LOG_ENTRIES.
 */

const store = require('../store');
const logger = require('../utils/logger').createLogger('slack_channel_watch');
const { PERSONA_SYSTEM_PROMPT } = require('../orcha/slack-partner-persona');

const MAX_MESSAGES_PER_POLL = 5;   // per channel, per poll cycle
const MAX_LOG_ENTRIES       = 500; // persisted reply log cap

// BUG FIX (2026-07-22): re-entrancy lock, mirroring relay.js's _relayLock
// pattern exactly. Real evidence confirmed the bug this prevents: the
// live slackChannelReplies store had THREE separate entries sharing the
// identical id (same channelId + same message ts) -- three different
// AI-drafted replies were actually posted to the real partner channel for
// one message, ~3.5 seconds apart. Root cause: pollChannelsOnce() had no
// guard against overlapping runs. Each new message triggers a full AI
// call before the poll cycle can finish and advance lastSeenTs, so if a
// cycle runs long (slow AI response, or -- as happened today -- multiple
// stray app processes alive at once after a freeze) a second poll can
// start while the first is still mid-flight, both see the same "new"
// message, and both independently draft + send + log it.
// This was ALSO the root cause of "won't click mark handled or dismiss"
// for some review items: updateReviewItem() looks up by id with
// Array.find(), which always resolves to the same single entry when
// duplicates share an id -- so clicking on a different duplicate row
// silently updated the wrong entry instead of the one actually clicked.
let _pollLock = false;

// Default watch list — the 4 channels confirmed live and specified by the
// user. Stored so they can be toggled off individually without code
// changes; new channels can be added the same way via the config store.
const DEFAULT_CHANNELS = [
  { id: 'C0A8WSPA4R3', name: 'avp40-maintenance', enabled: true },
  { id: 'C0BHCHMANP5', name: 'avp40-team',        enabled: true },
  { id: 'C0A7EJEJ6NB', name: 'abe-tuzr',           enabled: true },
  { id: 'C0A7ZKCV50U', name: 'abe-sapb',           enabled: true },
];

function getWatchConfig() {
  const cfg = store.load('slackChannelWatchConfig', null);
  if (cfg && Array.isArray(cfg.channels)) {
    // FEATURE (2026-07-22): backward-compat default for configs saved
    // before replyMode existed -- treat as 'mentions' (the original,
    // stricter behavior) so nothing silently changes behavior for
    // existing users on upgrade.
    if (!cfg.replyMode) cfg.replyMode = 'mentions';
    return cfg;
  }
  // First run - seed defaults.
  const seeded = { enabled: true, replyMode: 'mentions', channels: DEFAULT_CHANNELS.map(c => ({ ...c, lastSeenTs: null })) };
  store.save('slackChannelWatchConfig', seeded);
  return seeded;
}

function saveWatchConfig(config) {
  if (!config || !Array.isArray(config.channels)) throw new Error('config.channels must be an array');
  store.save('slackChannelWatchConfig', config);
  return { ok: true };
}

function _saveChannelLastSeen(channelId, ts) {
  const cfg = getWatchConfig();
  const ch = cfg.channels.find(c => c.id === channelId);
  if (ch) { ch.lastSeenTs = ts; store.save('slackChannelWatchConfig', cfg); }
}

function _appendReplyLog(entry) {
  const log = store.load('slackChannelReplies', []);
  log.unshift(entry); // newest first
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  store.save('slackChannelReplies', log);
}

function getReviewQueue() {
  const log = store.load('slackChannelReplies', []);
  return log.filter(e => e.inScope === false && e.status === 'open');
}

function getReplyLog(limit) {
  const log = store.load('slackChannelReplies', []);
  return log.slice(0, limit || 100);
}

function updateReviewItem(id, updates) {
  const log = store.load('slackChannelReplies', []);
  // BUG FIX (2026-07-22): update ALL entries matching this id, not just
  // the first (Array.find). This is defense-in-depth for any duplicate
  // entries that already exist (from before the _pollLock fix) or that
  // could theoretically still slip through some other path -- previously,
  // clicking "Mark handled"/"Dismiss" on a duplicate row always silently
  // updated a DIFFERENT entry (whichever matched first), so the row the
  // user actually clicked never disappeared on refresh, looking exactly
  // like "the button doesn't work."
  const matches = log.filter(e => e.id === id);
  if (!matches.length) return { ok: false, error: 'not found' };
  matches.forEach(item => Object.assign(item, updates || {}));
  store.save('slackChannelReplies', log);
  return { ok: true, item: matches[0], updatedCount: matches.length };
}

// BUG FIX (2026-07-22): one-time cleanup for duplicate entries already
// created by the race this session's other fixes close off. Collapses
// entries sharing an id down to a single one, preferring (in order): a
// non-'open' status (something the user already acted on) over 'open',
// then the earliest createdAt (the first genuine attempt). Safe to call
// on every app start -- a no-op once the store is already clean.
function dedupeReplyLog() {
  const log = store.load('slackChannelReplies', []);
  const byId = new Map();
  for (const entry of log) {
    const existing = byId.get(entry.id);
    if (!existing) { byId.set(entry.id, entry); continue; }
    const existingIsOpen = existing.status === 'open';
    const entryIsOpen = entry.status === 'open';
    if (existingIsOpen && !entryIsOpen) { byId.set(entry.id, entry); continue; }
    if (!existingIsOpen && entryIsOpen) continue; // keep existing (already actioned)
    if (new Date(entry.createdAt) < new Date(existing.createdAt)) byId.set(entry.id, entry);
  }
  const deduped = Array.from(byId.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const removedCount = log.length - deduped.length;
  if (removedCount > 0) {
    store.save('slackChannelReplies', deduped);
    logger.info('[SlackWatch] dedupeReplyLog: removed', removedCount, 'duplicate entries');
  }
  return { removedCount };
}

// FEATURE (2026-07-22): "occasional" reply mode gate. Runs ONLY for
// messages that do NOT @-mention the user (mentioned messages always get
// a full reply in both modes -- this gate is never consulted for those).
// A cheap, separate yes/no check, deliberately NOT the same prompt as
// _classifyAndDraft below -- the goal here is restraint: default to NOT
// replying on any doubt, ambiguity, or AI failure, since an unsolicited
// reply in a partner channel is a worse failure mode than staying quiet.
// This keeps "occasionally involved" meaningfully different from
// "replies to everything" -- it should still be the exception, not the
// rule, even with the feature turned on.
const CHIME_IN_GATE_PROMPT = `You are monitoring a Slack channel but were NOT directly addressed in this message. Decide if you should proactively jump in and help anyway.

Only answer YES if the message is CLEARLY something you could meaningfully and confidently help with right now (e.g. a direct question about a specific unit/vendor/process that's gone unanswered, or a clear request for help not addressed to anyone in particular).

Answer NO for: general chatter, messages already directed at/answered by a specific other person, venting, statements with no actual question, or anything where you're not confident you'd add real value.

When in doubt, answer NO.

Respond with ONLY the single word YES or NO, nothing else.

Message: `;

async function _shouldChimeIn(messageText, askOrcha) {
  try {
    const aiResult = await askOrcha(CHIME_IN_GATE_PROMPT + messageText);
    const text = (aiResult && aiResult.text || '').trim().toUpperCase();
    return text.startsWith('YES');
  } catch (e) {
    logger.warn('[SlackWatch] chime-in gate check failed, defaulting to NO:', e.message);
    return false; // safe failure mode -- never chime in on an error
  }
}

// ── AI classify + draft ──────────────────────────────────────────────────
async function _classifyAndDraft(messageText, askOrcha) {
  const prompt = PERSONA_SYSTEM_PROMPT + '\n\nPartner message:\n' + messageText;
  let aiResult;
  try {
    aiResult = await askOrcha(prompt);
  } catch (e) {
    logger.warn('[SlackWatch] AI call threw:', e.message);
    aiResult = { ok: false, error: e.message };
  }

  const fallback = {
    inScope: false,
    reply: "Thanks for reaching out — I want to make sure you get an accurate answer, so I'm looping in the team and we'll follow up shortly.",
    category: 'workflow',
    title: (messageText || '').slice(0, 60),
  };

  if (!aiResult || aiResult.ok === false || !aiResult.text) {
    logger.warn('[SlackWatch] AI call failed or empty, using safe fallback');
    return fallback;
  }

  // Model is instructed to return ONLY a JSON object, but defensively
  // extract the first {...} block in case any stray text surrounds it.
  const raw = aiResult.text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn('[SlackWatch] AI response had no JSON object, using safe fallback. Raw:', raw.slice(0, 200));
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
    logger.warn('[SlackWatch] AI JSON parse failed, using safe fallback:', e.message);
    return fallback;
  }
}

// ── Main poll cycle ──────────────────────────────────────────────────────
async function pollChannelsOnce(log) {
  const doLog = log || ((msg) => logger.info(msg));

  // BUG FIX (2026-07-22): re-entrancy guard -- see _pollLock declaration
  // above for the full rationale/evidence. Skips silently (same pattern as
  // relay.js's scrapeRelay) rather than throwing, since this is called on
  // an unattended 30s timer -- a thrown error would just spam logs.
  if (_pollLock) {
    doLog('[SlackWatch] Poll already in progress — skipping overlapping call');
    return { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true };
  }
  _pollLock = true;
  try {

  const config = getWatchConfig();
  if (!config.enabled) { doLog('[SlackWatch] Disabled — skipping poll'); return { repliedCount: 0, escalatedCount: 0, items: [] }; }

  const { readMessages, sendToChannel, checkLiveAuth } = require('./slack_send');
  const { askOrcha } = require('./orcha_ws');

  const auth = await checkLiveAuth();
  if (!auth || !auth.authenticated) { doLog('[SlackWatch] Slack not authenticated — skipping poll'); return { repliedCount: 0, escalatedCount: 0, items: [] }; }
  const myUserId = auth.userId || '';

  let repliedCount = 0, escalatedCount = 0;
  const newEscalations = [];

  for (const ch of config.channels) {
    if (ch.enabled === false) continue;
    try {
      const messages = await readMessages(ch.id, 20); // newest-first
      if (!messages.length) continue;

      // FIRST-EVER poll of this channel: baseline only, do not reply to
      // pre-existing history (see file header safety note).
      if (!ch.lastSeenTs) {
        _saveChannelLastSeen(ch.id, messages[0].ts);
        doLog(`[SlackWatch] ${ch.name}: first poll — baselined at ts ${messages[0].ts}, no replies sent for existing history`);
        continue;
      }

      // Only messages strictly newer than lastSeenTs, oldest-first for
      // processing order, capped per cycle.
      // FEATURE (2026-07-22): two reply modes, set via config.replyMode:
      //   'mentions'  -- only ever consider messages that explicitly
      //                  @-mention the signed-in user (original, strict
      //                  behavior, still the default).
      //   'occasional' -- also consider OTHER new messages, but each one
      //                  must separately pass the _shouldChimeIn gate
      //                  (see above) before a real reply is drafted. This
      //                  keeps the feature meaningfully "occasional"
      //                  rather than "replies to everything" -- the gate
      //                  defaults to NO on any doubt.
      // Mentions are detected via Slack's raw "<@USERID>" token in
      // msg.text (not display names) -- reliable regardless of where in
      // the message it appears. Messages are kept in strict chronological
      // order (no reordering by priority) so the lastSeenTs watermark
      // below always advances correctly with no risk of silently skipping
      // an unprocessed message.
      const mentionToken = myUserId ? '<@' + myUserId + '>' : null;
      const isMention = (m) => !!(mentionToken && m.text && m.text.includes(mentionToken));

      const candidateMsgs = messages
        .filter(m => parseFloat(m.ts) > parseFloat(ch.lastSeenTs))
        .filter(m => m.userId && m.userId !== myUserId); // skip our own + system/empty-author messages

      const newMsgs = (config.replyMode === 'occasional' ? candidateMsgs : candidateMsgs.filter(isMention))
        .reverse()
        .slice(0, MAX_MESSAGES_PER_POLL);

      if (!newMsgs.length) continue;

      for (const msg of newMsgs) {
        // BUG FIX (2026-07-22): defense-in-depth dedup check, on top of
        // the _pollLock above. Skip if this exact message (channelId+ts)
        // was already logged -- guards against any overlap path the lock
        // doesn't cover (e.g. a second, entirely separate app process
        // alive at the same time, which is exactly what happened during
        // today's freeze incident -- a lock only protects within one
        // process's memory, not across processes sharing the same file
        // store). Checked fresh from disk, not any in-memory cache.
        const existingLog = store.load('slackChannelReplies', []);
        if (existingLog.some(e => e.id === ch.id + ':' + msg.ts)) {
          doLog(`[SlackWatch] ${ch.name}: message ${msg.ts} already replied to (found in log) — skipping duplicate`);
          continue;
        }

        // FEATURE (2026-07-22): "occasional" mode gate -- only consulted
        // for messages that did NOT mention the user (see filter above).
        // A NO here is a deliberate, logged decision to stay quiet, not a
        // failure -- correctly still advances lastSeenTs since the
        // message WAS considered, just declined.
        const mentioned = isMention(msg);
        if (!mentioned && config.replyMode === 'occasional') {
          const shouldChime = await _shouldChimeIn(msg.text, askOrcha);
          if (!shouldChime) {
            doLog(`[SlackWatch] ${ch.name}: not mentioned, chose not to chime in on ${msg.ts}`);
            continue;
          }
          doLog(`[SlackWatch] ${ch.name}: not mentioned, but chiming in on ${msg.ts} (gate said relevant)`);
        }

        const draft = await _classifyAndDraft(msg.text, askOrcha);

        // FEATURE (2026-07-22): always tag the person being responded to,
        // prepended at send-time rather than asking the AI to include it
        // -- guarantees correctness/consistency instead of depending on
        // the model remembering to do it. msg.userId is the real sender's
        // Slack user ID, already available from readMessages().
        const taggedReply = (msg.userId ? `<@${msg.userId}> ` : '') + draft.reply;

        let replyTs = null;
        try {
          const sendResult = await sendToChannel(ch.id, taggedReply, msg.ts);
          replyTs = sendResult.ts;
          repliedCount++;
        } catch (e) {
          doLog(`[SlackWatch] ${ch.name}: reply send FAILED: ${e.message}`);
        }

        const entry = {
          id: ch.id + ':' + msg.ts,
          channelId: ch.id,
          channelName: ch.name,
          ts: msg.ts,
          replyTs,
          question: msg.text,
          reply: taggedReply,
          wasMentioned: mentioned,
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
          doLog(`[SlackWatch] ${ch.name}: escalated (${draft.category}) — "${draft.title}"`);
        } else {
          doLog(`[SlackWatch] ${ch.name}: answered in-scope question`);
        }
      }

      _saveChannelLastSeen(ch.id, newMsgs[newMsgs.length - 1].ts);
    } catch (e) {
      doLog(`[SlackWatch] ${ch.name}: poll error: ${e.message}`);
    }
  }

  return { repliedCount, escalatedCount, items: newEscalations };
  } finally {
    _pollLock = false;
  }
}

module.exports = {
  DEFAULT_CHANNELS,
  getWatchConfig,
  saveWatchConfig,
  pollChannelsOnce,
  getReviewQueue,
  getReplyLog,
  updateReviewItem,
  dedupeReplyLog,
};
