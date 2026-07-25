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
    // FEATURE (2026-07-23): replyMode is now a PER-CHANNEL setting so each
    // partner channel can independently be strict ('mentions') or loose
    // ('occasional'). Migration for configs saved before this existed:
    // seed each channel's replyMode from the old global cfg.replyMode so
    // nothing silently changes behavior on upgrade. Idempotent -- once a
    // channel has its own replyMode this is a no-op for it.
    cfg.channels.forEach((ch) => { if (!ch.replyMode) ch.replyMode = cfg.replyMode; });
    return cfg;
  }
  // First run - seed defaults.
  const seeded = { enabled: true, replyMode: 'mentions', channels: DEFAULT_CHANNELS.map(c => ({ ...c, lastSeenTs: null, replyMode: 'mentions' })) };
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

// FEATURE (2026-07-23): 'mentions' (strict) mode gate. Runs ONLY for
// messages in a 'mentions'-mode channel that do NOT contain the literal
// Slack '<@USERID>' mention token. Literal-token detection alone misses
// real phrasing that is obviously directed at the signed-in user --
// addressed by name, a direct reply to something they said, or a
// question with no other plausible addressee. This gate exists to catch
// exactly that, WITHOUT loosening 'mentions' mode into 'occasional' --
// the bar here is 'clearly addressed to this specific person', which is
// stricter than occasional's 'clearly relevant/worth chiming in on'.
// Same safe-failure philosophy as _shouldChimeIn: default to NO on any
// doubt or AI error.
function _directedAtMePrompt(myName) {
  const who = myName ? (' named "' + myName + '"') : '';
  return 'You are monitoring a Slack channel on behalf of a specific person' + who + '. This message does NOT contain a literal @-mention of them, but decide if it is still UNMISTAKABLY addressed to them personally -- e.g. it calls them by name, is a direct reply/response to something they just said, or is a question with no other plausible addressee in context.\n\n' +
    'Only answer YES if a reasonable person reading the channel would say this message is clearly meant for THIS person specifically, not the channel in general.\n\n' +
    'Answer NO for: general channel chatter, messages addressed to someone else or to no one in particular, topics that are merely relevant, or anything where you are not confident it is meant for this specific person.\n\n' +
    'When in doubt, answer NO.\n\n' +
    'Respond with ONLY the single word YES or NO, nothing else.\n\n' +
    'Message: ';
}

async function _isDirectedAtMe(messageText, myName, askOrcha) {
  try {
    const aiResult = await askOrcha(_directedAtMePrompt(myName) + messageText);
    const text = (aiResult && aiResult.text || '').trim().toUpperCase();
    return text.startsWith('YES');
  } catch (e) {
    logger.warn('[SlackWatch] directed-at-me gate check failed, defaulting to NO:', e.message);
    return false; // safe failure mode -- never treat as directed-at-me on an error
  }
}

// ── Thread-mention tracking ─────────────────────────────────────────────
// FEATURE (2026-07-24): when a message @-mentions the signed-in user, the
// thread it belongs to (or starts) is recorded persistently so that any
// future reply in that same thread triggers a mandatory response even when
// the original mention has scrolled past the 20-message fetch window.
// Entries expire after 7 days (Slack ts is Unix seconds as a string).
const MENTION_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function _trackMentionThread(channelId, threadTs) {
  if (!threadTs) return;
  const all = store.load('slackMentionThreads', {});
  if (!all[channelId]) all[channelId] = [];
  if (!all[channelId].includes(threadTs)) all[channelId].push(threadTs);
  // Prune entries older than TTL
  const cutoff = ((Date.now() - MENTION_THREAD_TTL_MS) / 1000).toFixed(6);
  all[channelId] = all[channelId].filter(ts => parseFloat(ts) > parseFloat(cutoff));
  store.save('slackMentionThreads', all);
}

function _isInMentionThread(channelId, threadTs) {
  if (!threadTs) return false;
  const all = store.load('slackMentionThreads', {});
  return !!(all[channelId] && all[channelId].includes(threadTs));
}

// ── AI classify + draft ──────────────────────────────────────────────────
async function _classifyAndDraft(messageText, askOrcha) {
  // Inject local time so the AI uses the correct time-of-day greeting
  // (morning/afternoon/evening) rather than guessing from UTC.
  const _now = new Date();
  const _timeStr = _now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const _dateStr = _now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeContext = '\n\nCurrent local time: ' + _timeStr + ', ' + _dateStr + '.';
  const prompt = PERSONA_SYSTEM_PROMPT + timeContext + '\n\nPartner message:\n' + messageText;
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
    // GUARD: model sometimes confuses itself and embeds the full JSON response
    // inside the reply field. Unwrap one level if that happened.
    let replyText = parsed.reply;
    const innerJson = replyText.trim().match(/^\{[\s\S]*\}$/);
    if (innerJson) {
      try {
        const inner = JSON.parse(innerJson[0]);
        if (typeof inner.reply === 'string' && inner.reply.trim()) {
          logger.warn('[SlackWatch] Model embedded JSON in reply field — unwrapping');
          replyText = inner.reply;
        }
      } catch (_) {}
    }
    return {
      inScope: parsed.inScope === true,
      reply: replyText,
      category: ['alert', 'action', 'workflow'].includes(parsed.category) ? parsed.category : 'workflow',
      title: (typeof parsed.title === 'string' && parsed.title.trim()) ? parsed.title.slice(0, 60) : (messageText || '').slice(0, 60),
    };
  } catch (e) {
    logger.warn('[SlackWatch] AI JSON parse failed, using safe fallback:', e.message);
    return fallback;
  }
}

// ── Main poll cycle ──────────────────────────────────────────────────────

// ── "Just Me" mode ──────────────────────────────────────────────────────────
// A channel used ONLY between the signed-in user and this app -- no
// partner, no persona, no escalation queue. Routes straight through the
// SAME action pipeline the in-app FAB and the phone companion use
// (processOrchaAction / confirmSend in ../ipc/ai.js), including the
// mandatory confirm-before-send step for Slack/email actions.
//
// IDENTITY PROBLEM this solves: there is no bot account here -- the app
// posts replies by driving the SAME logged-in Slack session as the user,
// so every message in this channel (the user's questions AND the app's
// own past replies) is authored by the identical Slack user ID. The
// existing "skip messages authored by myUserId" filter used for partner
// channels would therefore filter out EVERYTHING here. Instead, the app
// always tags its own replies with a real "<@myUserId>" self-mention
// (using the exact same reply-tagging line the partner path already has,
// which happens to tag the ORIGINAL SENDER -- here that sender is also
// the user, so it doubles perfectly as a "the app wrote this" marker).
// Any incoming message WITHOUT that tag is therefore a genuine new
// question/command from the user, never a stray echo of a past reply.
//
// NOTE: replies still post under the user's own Slack identity (no bot
// token yet), so this does NOT trigger a phone push notification --
// Slack never notifies you of your own posts. Once a bot/webhook is
// approved, only the send step needs to change; the read/identify logic
// here stays the same.
const _JM_PENDING_TTL_MS = 15 * 60 * 1000;
const _JM_YES_RE = /^\s*(yes|yep|yeah|y|confirm|confirmed|send|send it|go ahead|do it|ok|okay|k)\s*[.!]?\s*$/i;
const _JM_NO_RE  = /^\s*(no|nope|n|cancel|nevermind|never mind|stop|don'?t)\s*[.!]?\s*$/i;

function _jmGetPending(channelId) {
  const all = store.load('slackJustMePendingConfirm', {});
  const p = all[channelId];
  if (!p || !p.items || !p.items.length) return null;
  if (Date.now() - (p.createdAt || 0) > _JM_PENDING_TTL_MS) return null;
  return p;
}

function _jmSetPending(channelId, items) {
  const all = store.load('slackJustMePendingConfirm', {});
  all[channelId] = { items, createdAt: Date.now() };
  store.save('slackJustMePendingConfirm', all);
}

function _jmClearPending(channelId) {
  const all = store.load('slackJustMePendingConfirm', {});
  delete all[channelId];
  store.save('slackJustMePendingConfirm', all);
}

// BUGFIX (2026-07-25): processOrchaAction() was awaited with no upper
// bound. If the underlying AI pipeline hangs (observed: claude-code
// fallback queue can hang indefinitely with no timeout timer), this call
// never resolves -- and since _jmHandleMessage() is awaited inside
// pollChannelsOnce() under _pollLock, the WHOLE Slack "Just Me" poll gets
// stuck forever with zero further logging. Observed live: messages sat
// unanswered for 3+ hours with no self-recovery. Fix: race against a hard
// timeout so a hung AI call can never hold the poll lock past this bound.
// NOTE (2026-07-25): raised from 90s -- normal answers routinely take 90-180s
// because relay.ask() already has its own internal 90s-per-attempt retry/cascade
// (fleet-brain -> WS -> CLI -> Claude Code -> Bedrock). A 90s outer timeout here
// was racing that internal retry and killing good-but-slow answers right as
// attempt 1 was handing off to attempt 2. 240s gives margin above the observed
// worst-case normal latency while still catching genuine multi-minute+ hangs.
let JM_AI_TIMEOUT_MS = 240 * 1000; // let (not const) -- overridable in tests via __test__.setAiTimeoutMs()

// ─── AI JOB QUEUE (Just Me only) ─────────────────────────────────────────────
// BUGFIX (2026-07-25 round 2): _jmHandleMessage() used to be awaited directly
// inside pollChannelsOnce()'s per-channel loop, which runs under _pollLock --
// so a slow/hung AI call for ONE Just Me message held the lock and blocked
// polling for every other watched channel (partner channels included) for up
// to the full 240s. It also meant the second consecutive question could
// never even start until the first one's wait fully resolved.
//
// Fix: pollChannelsOnce() (via _pollJustMeChannel) now only READS messages,
// advances the per-channel watermark, and hands each new message to this
// independent job queue -- then returns immediately, releasing _pollLock.
// The actual AI call + Slack reply happen here, entirely outside the lock.
//
// Concurrency is deliberately 1 (one active AI job at a time) until running
// concurrent Orcha sessions is proven safe -- fleet-brain maintains a single
// shared session, so parallel calls would fight over it. Every job is
// guaranteed to resolve or reject, and the queue is always advanced in a
// `finally` so one failed/timed-out job can never permanently wedge the
// queue for the next Slack message.
const _aiJobQueue = [];
let _aiJobRunning = false;
let _aiJobSeq = 0;

function _jmEnqueueJob(ch, msg, doLog) {
  const jobId = 'jm' + (++_aiJobSeq);
  logger.info(`[SlackWatch][${jobId}] Slack message received (${ch.name} ts=${msg.ts}) -- queued`);
  _aiJobQueue.push({ jobId, ch, msg, doLog });
  _pumpAiJobQueue();
}

function _pumpAiJobQueue() {
  if (_aiJobRunning) return;
  const job = _aiJobQueue.shift();
  if (!job) return;
  _aiJobRunning = true;
  _runJustMeJob(job)
    .catch(e => logger.warn(`[SlackWatch][${job.jobId}] unexpected error escaped job runner: ${e.message}`))
    .finally(() => {
      _aiJobRunning = false;
      logger.info(`[SlackWatch][${job.jobId}] queue advanced`);
      _pumpAiJobQueue();
    });
}

async function _runJustMeJob(job) {
  const { jobId, ch, msg, doLog } = job;
  const startedAt = Date.now();

  // JM_AI_TIMEOUT_MS remains ONLY a final safety boundary -- normal answers
  // (fleet-brain fast path, or the fast-path bypass in ipc/ai.js for simple
  // count/status questions) complete well inside it. If it does fire, we
  // abort the in-flight request end-to-end (WS terminate / CLI kill / Claude
  // Code process kill, depending which tier was active -- see relay.js +
  // fleet-brain.js) rather than merely abandoning the promise, so the next
  // Slack message is never left waiting on stale state.
  const controller = new AbortController();
  const hardTimer = setTimeout(() => {
    logger.warn(`[SlackWatch][${jobId}] hit the ${JM_AI_TIMEOUT_MS}ms final safety boundary -- aborting`);
    controller.abort();
  }, JM_AI_TIMEOUT_MS);

  let replyText;
  try {
    replyText = await _jmHandleMessage(ch.id, msg.text, controller.signal, jobId);
    logger.info(`[SlackWatch][${jobId}] response completed (${Date.now() - startedAt}ms)`);
  } catch (e) {
    logger.warn(`[SlackWatch][${jobId}] processOrchaAction failed after ${Date.now() - startedAt}ms: ${e.message}`);
    // Never surface raw internal errors (e.g. "processOrchaAction timed out
    // after 240000ms") in Slack -- replace with a friendly, actionable message.
    replyText = "I couldn't complete that request because Fleet Brain stopped responding. The AI connection has been reset, so you can try again now.";
  } finally {
    clearTimeout(hardTimer);
  }

  const { sendToChannel } = require('./slack_send');
  const taggedReply = (msg.userId ? `<@${msg.userId}> ` : '') + replyText;
  let replyTs = null;
  try {
    const sendResult = await sendToChannel(ch.id, taggedReply, msg.ts);
    replyTs = sendResult.ts;
  } catch (e) {
    doLog(`[SlackWatch] ${ch.name} (justme): reply send FAILED: ${e.message}`);
  }

  _appendReplyLog({
    id: ch.id + ':' + msg.ts,
    channelId: ch.id,
    channelName: ch.name,
    ts: msg.ts,
    replyTs,
    question: msg.text,
    reply: taggedReply,
    wasMentioned: false,
    wasThreadReply: false,
    inScope: true,
    category: null,
    title: 'Just Me',
    createdAt: new Date().toISOString(),
    status: 'auto-answered',
  });
  logger.info(`[SlackWatch][${jobId}] cleanup completed`);
}

async function _jmHandleMessage(channelId, text, signal, jobId) {
  const { processOrchaAction, confirmSend } = require('../ipc/ai');

  const pending = _jmGetPending(channelId);
  if (pending) {
    if (_JM_YES_RE.test(text)) {
      const outcomes = [];
      for (const item of pending.items) {
        try {
          const r = await confirmSend(item);
          outcomes.push(r && r.ok ? (r.message || 'Sent.') : ('Failed: ' + (r && r.error || 'unknown error')));
        } catch (e) {
          outcomes.push('Failed: ' + e.message);
        }
      }
      _jmClearPending(channelId);
      return outcomes.join('\n');
    }
    if (_JM_NO_RE.test(text)) {
      _jmClearPending(channelId);
      return 'Cancelled -- nothing was sent.';
    }
    // Stale/unrelated reply -- drop the old pending confirm and process
    // this message as a brand new question instead of silently ignoring it.
    _jmClearPending(channelId);
  }

  logger.info(`[SlackWatch][${jobId || '?'}] processOrchaAction started`);
  const result = await processOrchaAction(text, { signal, requestId: jobId });
  // If processOrchaAction returned a hard error (ok===false), throw so
  // _runJustMeJob's catch block replaces it with the friendly fallback message
  // instead of blindly posting "Error:Aborted" (or any other raw error) to Slack.
  if (!result || result.ok === false) {
    throw new Error(result ? result.text : 'processOrchaAction returned no result');
  }
  let replyText = result.text || "Sorry, I couldn't process that.";
  if (result && result.pendingConfirm && result.pendingConfirm.length) {
    _jmSetPending(channelId, result.pendingConfirm);
    replyText += '\n\nReply YES to send, or NO to cancel.';
  }
  return replyText;
}

async function _pollJustMeChannel(ch, myUserId, doLog) {
  const { readMessages } = require('./slack_send');
  const messages = await readMessages(ch.id, 20); // newest-first
  if (!messages.length) return;

  // FIRST-EVER poll: baseline only, do not reply to pre-existing history
  // (same safeguard as the partner path).
  if (!ch.lastSeenTs) {
    _saveChannelLastSeen(ch.id, messages[0].ts);
    doLog(`[SlackWatch] ${ch.name} (justme): first poll — baselined at ts ${messages[0].ts}, no replies sent for existing history`);
    return;
  }

  const mentionToken = myUserId ? '<@' + myUserId + '>' : null;
  const newMsgs = messages
    .filter(m => parseFloat(m.ts) > parseFloat(ch.lastSeenTs))
    .filter(m => !(mentionToken && m.text && m.text.includes(mentionToken))) // skip our own past replies
    .reverse(); // oldest first

  if (!newMsgs.length) {
    // Still need to advance the watermark past any self-tagged replies we
    // just skipped, or the next poll will keep re-seeing them forever.
    const newest = messages.filter(m => parseFloat(m.ts) > parseFloat(ch.lastSeenTs));
    if (newest.length) _saveChannelLastSeen(ch.id, newest[0].ts);
    return;
  }

  // BUGFIX (2026-07-25 round 2): the watermark used to only advance ONCE,
  // after the whole batch (including every AI wait) finished. That meant a
  // hung/slow message #1 blocked message #2 from ever being seen as "new"
  // on a LATER poll too, and held _pollLock for the entire batch. Now: each
  // message's AI processing is handed to the independent job queue above,
  // and the watermark advances immediately per message -- so a slow/hung
  // job can never re-block polling (this channel or any other) and never
  // prevents the next message from being picked up on the next cycle.
  for (const msg of newMsgs.slice(0, MAX_MESSAGES_PER_POLL)) {
    const existingLog = store.load('slackChannelReplies', []);
    if (existingLog.some(e => e.id === ch.id + ':' + msg.ts)) {
      _saveChannelLastSeen(ch.id, msg.ts);
      continue;
    }

    _saveChannelLastSeen(ch.id, msg.ts); // advance watermark BEFORE the AI wait
    _jmEnqueueJob(ch, msg, doLog);       // fire-and-forget -- runs outside _pollLock
  }
}


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

    // FEATURE (2026-07-25): 'justme' mode -- a channel used ONLY between
    // the signed-in user and this app (no partner, no persona, no
    // escalation queue). Fully separate code path so the existing
    // mentions/occasional logic below is completely untouched for every
    // other channel. See _pollJustMeChannel() for the full design note.
    const _earlyMode = ch.replyMode || config.replyMode || 'mentions';
    if (_earlyMode === 'justme') {
      try {
        await _pollJustMeChannel(ch, myUserId, doLog);
      } catch (e) {
        doLog(`[SlackWatch] ${ch.name}: justme poll error: ${e.message}`);
      }
      continue;
    }

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

      // FEATURE (2026-07-23): replyMode is now per-channel (ch.replyMode),
      // falling back to the legacy global config.replyMode, then 'mentions'
      // for channels that somehow have neither (shouldn't happen post
      // getWatchConfig's migration, but keep the safe default anyway).
      const chMode = ch.replyMode || config.replyMode || 'mentions';

      const candidateMsgs = messages
        .filter(m => parseFloat(m.ts) > parseFloat(ch.lastSeenTs))
        .filter(m => m.userId && m.userId !== myUserId); // skip our own + system/empty-author messages

      // Both modes now consider every new candidate message (capped per
      // cycle) -- the mention/gate check happens per-message below. This
      // lets 'mentions' mode also catch messages that don't literally
      // @-mention the user but are clearly still meant for them (see
      // _isDirectedAtMe below), without loosening it into 'occasional'.
      const newMsgs = candidateMsgs
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

        // ── Reply routing ────────────────────────────────────────────────
        // Three tiers, evaluated in order — same for both modes:
        //   TIER 1: literal @mention — always reply.
        //   TIER 2: reply in a thread where user was @mentioned — always reply,
        //           even when the original mention has scrolled past the
        //           20-message window (tracked persistently, 7-day TTL).
        //   TIER 3 (occasional): _isDirectedAtMe or _shouldChimeIn gate.
        //   TIER 3 (mentions):   _isDirectedAtMe strict gate only.
        const mentioned = isMention(msg);

        // Slack: thread_ts == ts on root messages; on replies it is the root ts.
        const msgThreadTs = (msg.thread_ts && msg.thread_ts !== msg.ts) ? msg.thread_ts : null;
        const isThreadReplyToMyMention = !mentioned && !!msgThreadTs && _isInMentionThread(ch.id, msgThreadTs);

        // Persist the thread so future replies in it are also Tier 2.
        if (mentioned) _trackMentionThread(ch.id, msg.thread_ts || msg.ts);

        if (mentioned) {
          // Tier 1: explicit @mention — fall through to draft.
        } else if (isThreadReplyToMyMention) {
          // Tier 2: reply in a thread where I was @mentioned — mandatory.
          doLog(`[SlackWatch] ${ch.name}: reply in thread where I was @mentioned — mandatory reply on ${msg.ts}`);
        } else if (chMode === 'occasional') {
          // Tier 3a (occasional): directed-at-me check first, then chime gate.
          const directedAtMe = await _isDirectedAtMe(msg.text, auth.user, askOrcha);
          if (directedAtMe) {
            doLog(`[SlackWatch] ${ch.name}: not mentioned, but clearly directed at me — replying on ${msg.ts}`);
          } else {
            const shouldChime = await _shouldChimeIn(msg.text, askOrcha);
            if (!shouldChime) {
              doLog(`[SlackWatch] ${ch.name}: not mentioned — chose not to chime in on ${msg.ts}`);
              continue;
            }
            doLog(`[SlackWatch] ${ch.name}: not mentioned, but chiming in on ${msg.ts} (gate said relevant)`);
          }
        } else {
          // Tier 3b (mentions/strict): must be unmistakably directed at me.
          const directedAtMe = await _isDirectedAtMe(msg.text, auth.user, askOrcha);
          if (!directedAtMe) {
            doLog(`[SlackWatch] ${ch.name}: strict mode — not clearly directed at me, skipping ${msg.ts}`);
            continue;
          }
          doLog(`[SlackWatch] ${ch.name}: strict-mode gate says clearly directed at me on ${msg.ts}`);
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
          wasThreadReply: isThreadReplyToMyMention,
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

// Test-only introspection/control -- never used by production code paths.
// Lets the regression suite (tests/slack-justme-queue.test.js) deterministically
// wait for the fire-and-forget AI job queue to drain instead of arbitrary
// sleeps, and shrink the 240s final-safety-boundary timeout so the
// deliberate-hang/abort test doesn't actually take 4 minutes to run.
function _aiQueueIdle() { return !_aiJobRunning && _aiJobQueue.length === 0; }
function _waitForAiQueueIdle(timeoutMs) {
  const limit = timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (_aiQueueIdle()) return resolve();
      if (Date.now() - start > limit) return reject(new Error('AI queue did not drain within ' + limit + 'ms'));
      setTimeout(poll, 5);
    })();
  });
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
  __test__: {
    waitForAiQueueIdle: _waitForAiQueueIdle,
    setAiTimeoutMs: (ms) => { JM_AI_TIMEOUT_MS = ms; },
    getAiTimeoutMs: () => JM_AI_TIMEOUT_MS,
  },
};
