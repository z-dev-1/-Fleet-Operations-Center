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
let _rlUntil  = 0;    // epoch ms — skip all conversations.replies calls until this time
let _threadReplyCount = {}; // cache: channelId:parentTs -> replyCount seen on last fetch
let _sendBlockedChannels = new Set(); // channels that returned restricted_action_read_only_channel — skip sends for the session

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

function _saveThreadLastSeen(channelId, name, ts, isGroup) {
  const cfg = getDMAutoReplyConfig();
  if (!cfg.threads) cfg.threads = {};
  // FEATURE (2026-07-25): persist isGroup alongside name/lastSeenTs so the
  // Settings UI's monitored-thread list can show a "Group" badge instead of
  // silently looking identical to a 1:1 DM.
  cfg.threads[channelId] = { name, lastSeenTs: ts, isGroup: !!isGroup };
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
// ── Extract links and file content from a Slack message for AI context ────
// Returns a string block to append to the prompt, or '' if nothing found.
async function _buildAttachmentContext(msg, downloadFn) {
  const parts = [];

  // 1. Inline URLs in message text (Slack wraps them as <url> or <url|label>)
  const urlMatches = (msg.text || '').match(/<(https?:[^|>]+)(?:\|[^>]+)?>/g) || [];
  const urls = urlMatches
    .map(m => m.replace(/^</, '').replace(/>$/, '').split('|')[0])
    .filter(u => u && u.startsWith('http'));
  if (urls.length) {
    parts.push('Links shared in this message:\n' + urls.map(u => '  - ' + u).join('\n'));
  }

  // 2. Slack attachment blocks (link previews, unfurled URLs from prior sends)
  const attachments = msg.attachments || [];
  for (const a of attachments) {
    const label = a.title || a.service_name || '';
    const link  = a.title_link || a.from_url || '';
    const blurb = a.text || a.fallback || a.pretext || '';
    if (label || link || blurb) {
      parts.push(
        'Linked content preview:' +
        (label ? '\n  Title: '   + label              : '') +
        (link  ? '\n  URL: '     + link               : '') +
        (blurb ? '\n  Excerpt: ' + blurb.slice(0, 400) : '')
      );
    }
  }

  // 3. Shared files — download readable ones (txt, md, csv, json, log)
  const files = msg.files || [];
  for (const file of files) {
    try {
      const result = await downloadFn(file);
      if (result && result.content) {
        const snippet   = result.content.slice(0, 4096); // 4KB cap per file
        const truncated = result.content.length > 4096;
        parts.push(
          'Shared file: ' + result.name +
          '\n--- file content start ---\n' +
          snippet +
          (truncated ? '\n[... truncated at 4KB ...]' : '') +
          '\n--- file content end ---'
        );
      } else if (file.name) {
        // Not a readable format (image, PDF, binary) — name it so AI knows
        parts.push('Shared file (not readable): ' + file.name +
          (file.mimetype ? ' (' + file.mimetype + ')' : ''));
      }
    } catch (_) {
      if (file.name) parts.push('Shared file (fetch failed): ' + file.name);
    }
  }

  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

// ── Auto-flip: detect "flip unit XXXXXX" requests and act on them ──────────
// FEATURE (2026-08-27): the most common actionable DM is a partner asking to
// "flip" a unit back into service (Unavailable -> Active). The app already has
// the machinery to do this (src/scrapers/setLifecycle.js, same automation the
// unit-detail UI + Orcha chat use). This connects the two: when a DM clearly
// asks to flip a specific unit, we flip it automatically to Active (reason
// "Healthy", matching the UI convention) UNLESS the unit's current
// lifecycleReason is a state that must NOT be auto-cleared without a human:
//   - "PM Failed"          (preventive-maintenance failure)
//   - "Expired Inspection" (out-of-date DOT/annual inspection)
//   - "Damaged-Moderate" / "Damaged-Severe" (accident/damage state)
// In those blocked cases we do NOT flip; we send an in-voice reply explaining
// why and queue it for Z's review (category "action").

// lifecycleReason values that block an automatic flip (case-insensitive match).
const FLIP_BLOCK_REASONS = ['pm failed', 'expired inspection', 'damaged-moderate', 'damaged-severe'];

// Human-readable label for why a flip was blocked, keyed off lifecycleReason.
function _flipBlockLabel(reason) {
  const r = (reason || '').toLowerCase();
  if (r.includes('pm failed'))          return 'a failed PM';
  if (r.includes('expired inspection')) return 'an expired inspection';
  if (r.includes('damaged'))            return 'an open damage/accident state';
  return 'its current hold state';
}

// Extract the first plausible unit token from a string (optional letter prefix
// + 4-8 digits, e.g. 321060, B12257, 9010424). Returns the token or null.
function _unitTokenIn(text) {
  const m = (text || '').match(/\b([A-Za-z]?\d{4,8})\b/);
  return m ? m[1] : null;
}

// Find the most recently mentioned unit in the conversation history.
// historyMsgs is an array of "Speaker: text" strings, oldest-first. We scan
// newest-first and return the first unit token found — this is the unit "it"
// most likely refers to in a follow-up like "flip it" or "the truck's fixed".
function _lastUnitFromHistory(historyMsgs) {
  if (!Array.isArray(historyMsgs) || !historyMsgs.length) return null;
  for (let i = historyMsgs.length - 1; i >= 0; i--) {
    const tok = _unitTokenIn(historyMsgs[i]);
    if (tok) return tok;
  }
  return null;
}

// Detect a flip request in the message text. Returns the referenced unit token
// (raw string) if the message is asking to flip/activate/release a unit, else null.
// FEATURE (2026-08-27): when the message has a flip verb but NO explicit unit
// ("can you please flip it?", "put it back in service"), fall back to the last
// unit mentioned in the thread history so implicit follow-ups still resolve.
function _detectFlipRequest(messageText, historyMsgs) {
  const text = (messageText || '').trim();
  if (!text) return null;
  // Must contain a flip-style verb. "flip", "activate", "put back", "release",
  // "make available", "bring back", "reactivate".
  const flipVerb = /\b(flip|reactivate|re-?activate|activate|release|put\s+(?:it\s+)?back|bring\s+(?:it\s+)?back|make\s+(?:it\s+)?available)\b/i;
  if (!flipVerb.test(text)) return null;
  // Prefer an explicit unit in the message; otherwise inherit the thread's unit.
  return _unitTokenIn(text) || _lastUnitFromHistory(historyMsgs);
}

// Resolve a unit token against fleet rows. Returns the matching row or null.
function _findFleetRow(unitToken) {
  if (!unitToken) return null;
  const fd = store.load('fleetData', {});
  const rows = fd.rows || [];
  const q = String(unitToken).toUpperCase();
  return rows.find(r => (r.equipmentId || '').toUpperCase() === q) || null;
}

// Given the resolved fleet row, decide whether an auto-flip is allowed and
// perform it. Returns an object that overrides the draft reply/scope, or null
// if this isn't actually a flip we should handle (let the normal AI reply stand).
async function _maybeAutoFlip(unitToken, tagPrefix) {
  const row = _findFleetRow(unitToken);
  // Unknown unit — let the AI's normal reply handle it (it'll ask for the unit #).
  if (!row) return null;

  const unitId = row.equipmentId;
  const state  = (row.lifecycleState || '');
  const reason = (row.lifecycleReason || '');

  // Already Active — nothing to flip. Confirm gracefully, mark handled.
  if (/active/i.test(state)) {
    return {
      reply: `${unitId} is already active and in service — nothing to flip on my end 👍`,
      inScope: true,
      category: null,
      title: null,
      _flip: { unitId, action: 'noop-already-active' },
    };
  }

  // Blocked state — do NOT auto-flip. Explain and escalate for Z's review.
  const blocked = FLIP_BLOCK_REASONS.some(b => reason.toLowerCase().includes(b));
  if (blocked) {
    const why = _flipBlockLabel(reason);
    return {
      reply: `I can't flip ${unitId} automatically — it's showing ${why} (${reason}). ` +
             `That needs to be cleared before it can go back in service. I'll take a look and follow up.`,
      inScope: false,
      category: 'action',
      title: `Flip blocked: ${unitId} (${reason})`,
      _flip: { unitId, action: 'blocked', reason },
    };
  }

  // No asset URL — can't drive the AAP automation. Escalate.
  if (!row.assetUrl) {
    return {
      reply: `Trying to flip ${unitId} but I don't have its AAP link cached yet — let me sort that and get it flipped shortly.`,
      inScope: false,
      category: 'action',
      title: `Flip pending (no AAP URL): ${unitId}`,
      _flip: { unitId, action: 'no-url' },
    };
  }

  // Allowed — perform the flip to Active / Healthy (UI convention).
  try {
    const { setLifecycleState } = require('./setLifecycle');
    logger.info(`[SlackDM] Auto-flip: ${unitId} ${state}/${reason} -> Active (Healthy)`);
    const res = await setLifecycleState({ equipmentId: unitId, assetUrl: row.assetUrl, state: 'Active', reason: 'Healthy' });
    if (res && res.success) {
      return {
        reply: `Done — ${unitId} is flipped back to active 👍`,
        inScope: true,
        category: null,
        title: null,
        _flip: { unitId, action: 'flipped' },
      };
    }
    // Automation ran but AAP didn't confirm — escalate with the failure detail.
    return {
      reply: `Tried to flip ${unitId} but it didn't go through (${(res && res.message) || 'AAP did not confirm'}). ` +
             `Let me look into it and get it flipped.`,
      inScope: false,
      category: 'action',
      title: `Flip failed: ${unitId}`,
      _flip: { unitId, action: 'failed', message: res && res.message },
    };
  } catch (e) {
    logger.warn(`[SlackDM] Auto-flip threw for ${unitId}: ${e.message}`);
    return {
      reply: `Ran into a snag flipping ${unitId} — I'll get it sorted and follow up.`,
      inScope: false,
      category: 'action',
      title: `Flip error: ${unitId}`,
      _flip: { unitId, action: 'error', message: e.message },
    };
  }
}

async function _classifyAndDraft(messageText, historyMsgs, groupContext) {
  // historyMsgs: optional array of strings ("Speaker: text") from recent
  // conversation, oldest-first, to give the AI context before replying.
  let contextBlock = '';
  if (historyMsgs && historyMsgs.length) {
    contextBlock = '\n\nRecent conversation context (for reference):\n' + historyMsgs.join('\n') + '\n';
  }
  // FEATURE (2026-07-25): group DM awareness. A reply in a group DM is
  // visible to everyone in the thread, not just the person who sent the
  // triggering message -- the model needs to know that (so it doesn't, say,
  // address something privately) and who specifically asked, since
  // "Recent conversation context" alone doesn't make the group nature or
  // current speaker obvious.
  let groupBlock = '';
  if (groupContext && groupContext.isGroup) {
    groupBlock = '\n\nThis is a GROUP direct message (not 1:1) with: ' + groupContext.memberNames.join(', ') +
      '. Your reply will be visible to everyone in this group, not just the person below.' +
      (groupContext.speakerName ? (' The message below was sent by: ' + groupContext.speakerName + '.') : '');
  }
  // Inject local time so the AI uses the correct time-of-day greeting
  // (morning/afternoon/evening) rather than guessing from UTC.
  const _now = new Date();
  const _timeStr = _now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const _dateStr = _now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeContext = '\n\nCurrent local time: ' + _timeStr + ', ' + _dateStr + '.';
  // FIX (2026-07-30): The persistent Claude Code process accumulates conversation
  // history across all relay.ask() callers. Fleet WR classification calls that
  // return REPAIR_STATUS: plain-text format contaminate the context, causing
  // subsequent DM calls to ignore the JSON format instruction and respond in the
  // same fleet-status style. A context-reset prefix breaks that inherited pattern
  // so Claude follows only the instructions in THIS message.
  const _contextReset =
    '=== NEW INDEPENDENT TASK — IGNORE ALL PRIOR CONTEXT AND OUTPUT FORMATS ===\n' +
    'What follows is a completely independent task with its own format requirements. ' +
    'Disregard any prior conversation history, output styles, or response patterns. ' +
    'Follow ONLY the instructions in this message.\n\n';
  // JSON-schema reminder appended last so it is the final instruction the model
  // sees before the actual message — reduces plain-text / "Holding, unchanged." responses.
  const _jsonReminder = '\n\nREMINDER — YOUR ENTIRE RESPONSE MUST BE A SINGLE VALID JSON OBJECT, nothing before or after it:\n{"inScope":true|false,"reply":"...","category":"alert"|"action"|"workflow"|null,"title":"..."|null}';

  // Inject live fleet data context so AI can answer unit/vendor/status questions accurately.
  // IMPLICIT-UNIT FOLLOW-UPS (2026-08-27): if this message has no explicit unit
  // but the thread was just talking about one ("the truck's fixed", "they
  // ordered a part for it", "is it ready?"), inherit that unit so buildFleetContext
  // pulls its data AND the AI is told what "it" refers to — instead of punting.
  const { buildFleetContext } = require('../orcha/ai-context');
  let _fleetLookupText = messageText;
  let _inheritedUnitNote = '';
  if (!_unitTokenIn(messageText)) {
    const inherited = _lastUnitFromHistory(historyMsgs);
    if (inherited) {
      _fleetLookupText = messageText + ' ' + inherited;
      _inheritedUnitNote = '\n\nNOTE: This message has no unit number, but the conversation was just about unit ' +
        inherited + '. If the message says "it"/"the truck"/"that one" or is a follow-up, it almost certainly refers to ' +
        inherited + ' — use that unit\'s data below to answer.';
    }
  }
  const fleetContext = buildFleetContext(_fleetLookupText, { maxUnits: 5, includeTimeline: true, includePM: true, includeRisk: true });

  const prompt = _contextReset + PERSONA_SYSTEM_PROMPT + timeContext + groupBlock + contextBlock + _inheritedUnitNote + fleetContext + _jsonReminder + '\n\nIncoming DM:\n' + messageText;
  // FIX (2026-07-24): was using sendOrchaChat() (direct WS-only, 90s timeout,
  // no fallback). If the Orcha WS server is not running or slow, EVERY DM call
  // timed out and sent the canned fallback reply. Switch to relay.ask() which
  // has the full chain: fleet-brain -> WS -> Claude Code -> Bedrock.
  let raw;
  try {
    const relay = require('../orcha/relay');
    // relay.ask() uses the automatic chain: Orcha (fleet-brain WS) first, then
    // WS -> CLI -> Claude Code -> Bedrock fallback — same behavior as the rest
    // of the app. FIX (2026-08-17): the ONLY change vs. the original is the
    // timeout: raised 20s -> 90s. The old 20s cap was shorter than a real Orcha
    // response (50-90s), so every DM timed out and sent the canned fallback even
    // though Orcha would have answered. 90s matches the transport's own ceiling.
    const _aiTimeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout after 90s')), 90000));
    raw = await Promise.race([relay.ask(prompt), _aiTimeoutP]);
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
    // FEATURE (2026-08-14): AI sometimes returns plain "Holding, unchanged." or
    // similar meta-phrases instead of JSON — it is correctly identifying a repeat
    // message and choosing not to engage. Respect that decision: skip the send
    // entirely rather than spamming the canned fallback reply every 30s.
    if (/^\s*(holding|no\s*change|same\s*(as\s*before)?|unchanged|nothing\s*new|no\s*update)/i.test(raw)) {
      logger.info('[SlackDM] AI held/unchanged response — skipping reply for this message');
      return { ...fallback, _skip: true };
    }
    // FIX (2026-07-30): When the AI returns REPAIR_STATUS: plain-text (fleet status
    // format contamination from prior calls), don't silently fall back to the canned
    // holding reply — extract the actual content and compose a real DM reply from it.
    const statusLine = raw.match(/REPAIR_STATUS:\s*([^\n]+)/);
    const issueLine  = raw.match(/ISSUE:\s*([^\n]+)/);
    if (issueLine || statusLine) {
      const parts = [];
      if (issueLine)  parts.push(issueLine[1].trim());
      if (statusLine) parts.push('currently ' + statusLine[1].trim().toLowerCase());
      const rescuedReply = parts.join(' — ');
      logger.warn('[SlackDM] AI response in fleet-status format (context contamination) -- rescued into DM reply. Raw:', raw.slice(0, 200));
      return { inScope: true, reply: rescuedReply, category: null, title: null };
    }
    logger.warn('[SlackDM] AI response had no JSON object, using safe fallback. Raw:', raw.slice(0, 200));
    return fallback;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw new Error('missing reply field');
    // GUARD: model sometimes embeds the full JSON in the reply field. Unwrap.
    let replyText = parsed.reply;
    const innerJson = replyText.trim().match(/^\{[\s\S]*\}$/);
    if (innerJson) {
      try {
        const inner = JSON.parse(innerJson[0]);
        if (typeof inner.reply === 'string' && inner.reply.trim()) {
          logger.warn('[SlackDM] Model embedded JSON in reply field -- unwrapping');
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
    logger.warn('[SlackDM] AI JSON parse failed, using safe fallback:', e.message);
    return fallback;
  }
}


// ── Auto-save DM senders to the contact book ─────────────────────────────────
// Called once per new sender — deduplicates by slackId (userId).
// FIX (2026-07-25): now resolves the INDIVIDUAL person's real name via
// resolveUserName() instead of using dm.name. For a 1:1 DM those were the
// same thing anyway, but for a GROUP DM dm.name is the joined
// "Alice, Bob, Carol" string for the whole thread -- using that as one
// person's contact name was wrong (every group member would have been
// saved under the same multi-name string). Also dropped the old
// channelId-based dedup: multiple distinct people legitimately share one
// channelId in a group DM, so that check would have silently blocked
// saving the 2nd+ member of the same group thread.
async function _autoSaveContact(dm, userId) {
  if (!userId) return;
  try {
    const contacts = store.load('contacts', []);
    const exists = contacts.some(c => c.slackId && c.slackId === userId);
    if (exists) return;
    const { resolveUserName } = require('./slack_send');
    const name = (await resolveUserName(userId)) || dm.name || userId;
    const contact = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: 'slack',
      name,
      slackId: userId,
      channelId: dm.channelId,
      addedAt: new Date().toISOString(),
      source: 'dm-autoreply',
    };
    contacts.push(contact);
    store.save('contacts', contacts);
    logger.info('[SlackDM] Auto-saved contact: ' + contact.name + ' (' + userId + ')');
    // Notify renderer so the contact book refreshes live
    try {
      const { BrowserWindow } = require('electron');
      const wins = BrowserWindow.getAllWindows();
      if (wins.length) wins[0].webContents.send('contacts:updated', contact);
    } catch (_) {}
  } catch (e) {
    logger.warn('[SlackDM] Failed to auto-save contact:', e.message);
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

  const { listOpenDMs, readMessages, readThreadReplies, sendToChannel, checkLiveAuth, resolveUserName, downloadFileContent } = require('./slack_send');

  const auth = await checkLiveAuth();
  if (!auth || !auth.authenticated) { doLog('[SlackDM] Slack not authenticated — skipping poll'); return { repliedCount: 0, escalatedCount: 0, items: [] }; }
  const myUserId = auth.userId || '';

  let repliedCount = 0, escalatedCount = 0;
  const newEscalations = [];
  // Hard cap: if this poll runs over 25s (e.g. many thread-reply fetches hanging
  // at 8s each), bail out of the thread section and return — the next poll cycle
  // will pick up any missed threads. Keeps the poll lock from being held for minutes.
  const _pollDeadline = Date.now() + 10000; // 10s total — prevents thread fetches from stalling a poll past the 30s interval

  const dms = await listOpenDMs(40, myUserId); // myUserId excludes Z from group-DM display names
  if (!dms.length) return { repliedCount: 0, escalatedCount: 0, items: [] };

  // ── PHASE 1: parallel fetch ──────────────────────────────────────────────
  // Fetch all DM message histories in parallel so hanging Slack API calls
  // (which timeout at 8s each) are paid once in total, not once per DM.
  // Previously these were sequential: 10 hanging calls × 8s = 80s stall;
  // now: max(all fetch times) ≈ 8s total.
  const dmFetchResults = await Promise.all(
    dms.map(dm => {
      if (dm.name === 'Slackbot' || dm.name === 'ATS AI Training SlackBot') return Promise.resolve(null);
      if (_sendBlockedChannels.has(dm.channelId)) return Promise.resolve(null);
      return readMessages(dm.channelId, 20).catch(e => {
        doLog(`[SlackDM] ${dm.name}: readMessages error — ${e.message}`);
        return [];
      });
    })
  );

  // ── PHASE 2: sequential process ──────────────────────────────────────────
  for (let _di = 0; _di < dms.length; _di++) {
    const dm = dms[_di];
    const messages = dmFetchResults[_di];
    // Skip checks (same conditions as the fetch phase above).
    if (dm.name === 'Slackbot' || dm.name === 'ATS AI Training SlackBot') {
      doLog(`[SlackDM] ${dm.name}: skipping (system bot)`);
      continue;
    }
    if (_sendBlockedChannels.has(dm.channelId)) {
      doLog(`[SlackDM] ${dm.name}: skipping (read-only channel, send was blocked)`);
      continue;
    }
    try {
      if (!messages || !messages.length) continue;

      const threads = config.threads || {};
      let seen = threads[dm.channelId];

      // FIRST-EVER poll of this DM thread: baseline only, do not reply to
      // pre-existing history (same safety rule as channel watch).
      if (!seen || !seen.lastSeenTs) {
        // For a 1:1 DM (not a group), a first-ever poll usually means a NEW
        // person just messaged us — they should get a reply, not be silently
        // baselined until their SECOND message. So if the newest message is
        // from the other person and recent (< 10 min old), baseline to the
        // message BEFORE it so the newest one flows into newMsgs and gets a
        // reply. Group DMs keep the safe backlog-baseline behavior.
        const _newest = messages[0];
        const _newestFromOther = _newest && _newest.userId && _newest.userId !== myUserId;
        const _newestAgeMs = _newest ? (Date.now() - parseFloat(_newest.ts) * 1000) : Infinity;
        const _replyToFirst = !dm.isGroup && _newestFromOther && _newestAgeMs < 10 * 60 * 1000;
        if (_replyToFirst) {
          // Baseline to the previous message (or 0 if none) so _newest is "new".
          const _baseTs = messages[1] ? messages[1].ts : '0';
          _saveThreadLastSeen(dm.channelId, dm.name, _baseTs, dm.isGroup);
          seen = { lastSeenTs: _baseTs, name: dm.name, isGroup: dm.isGroup };
          doLog(`[SlackDM] ${dm.name}: first poll (1:1, recent) — replying to new sender's first message ${_newest.ts}`);
          // fall through — do NOT continue — so newMsgs picks up _newest below
        } else {
          _saveThreadLastSeen(dm.channelId, dm.name, messages[0].ts, dm.isGroup);
          doLog(`[SlackDM] ${dm.name}: first poll — baselined at ts ${messages[0].ts}, no replies sent for existing history`);
          continue;
        }
      }
      const _seenNow = seen;

      const newMsgs = messages
        .filter(m => parseFloat(m.ts) > parseFloat(_seenNow.lastSeenTs))
        .filter(m => m.userId && m.userId !== myUserId) // skip our own + system/empty-author messages
        .reverse()
        .slice(0, MAX_MESSAGES_PER_POLL);

      // Even when no new top-level messages exist, active threads may have
      // received new replies -- don't skip the thread-reply poll below.
      const hasNewTopLevel = newMsgs.length > 0;

      const existingLog = store.load('slackDMReplies', []); // hoisted — one disk read for all messages
      if (hasNewTopLevel) { for (const msg of newMsgs) {
        // Defense-in-depth dedup, on top of _pollLock (same rationale as
        // channel watch's identical check — see that file for the real
        // incident it prevents).
        if (existingLog.some(e => e.id === dm.channelId + ':' + msg.ts)) {
          doLog(`[SlackDM] ${dm.name}: message ${msg.ts} already replied to (found in log) — skipping duplicate`);
          continue;
        }

        // FEATURE (2026-07-30): If Z already replied manually in the Slack app
        // after this message, don't auto-reply — the person already has a real
        // answer. messages[] includes ALL senders; a Z-authored message with a
        // newer ts means Z typed a response in Slack directly.
        const zAlreadyRepliedManually = messages.some(
          m => m.userId === myUserId && parseFloat(m.ts) > parseFloat(msg.ts)
        );
        if (zAlreadyRepliedManually) {
          doLog(`[SlackDM] ${dm.name}: Z already replied manually after ${msg.ts} — skipping auto-reply`);
          continue;
        }

        // Grab up to 2 messages that came before this one for context.
        // messages[] is newest-first; filter to older ts, take first 2 (most
        // recent before this msg), then reverse to chronological order.
        //
        // FEATURE (2026-07-25): resolve each message's ACTUAL sender name
        // instead of blanket-labelling every non-Z message with dm.name.
        // For a 1:1 DM dm.name already IS the one counterpart's name, so
        // this is equivalent -- but for a GROUP DM, dm.name is the joined
        // "Alice, Bob, Carol" string for the whole thread, which is wrong
        // to stamp on every individual line. Resolving per-message keeps
        // multi-person context (who said what) intact for the AI.
        const historyMsgs = await Promise.all(
          messages
            .filter(m => parseFloat(m.ts) < parseFloat(msg.ts))
            .slice(0, 2)
            .reverse()
            .map(async m => {
              const who = m.userId === myUserId ? 'You' : ((await resolveUserName(m.userId)) || dm.name || 'Them');
              return who + ': ' + (m.text || '');
            })
        );

        const speakerName = dm.isGroup ? ((await resolveUserName(msg.userId)) || 'Someone in the group') : null;
        const groupContext = dm.isGroup
          ? { isGroup: true, memberNames: (dm.name || '').split(', ').filter(Boolean), speakerName }
          : null;
        // Enrich AI prompt with any links or files attached to this message
        const attachCtx = await _buildAttachmentContext(msg, downloadFileContent);
        const msgTextWithAttach = (msg.text || '') + attachCtx;
        const draft = await _classifyAndDraft(msgTextWithAttach, historyMsgs, groupContext);

        // AI explicitly held (identified a repeat, "Holding, unchanged." etc.) — skip
        // send and log entry; just let the watermark advance past this message.
        if (draft._skip) {
          doLog(`[SlackDM] ${dm.name}: AI held — skipping send for ${msg.ts}`);
          _saveThreadSeen(dm.channelId, dm.name, msg.ts, !!dm.isGroup);
          continue;
        }

        // AUTO-FLIP: if this DM is asking to flip a specific unit back into
        // service, act on it (flip to Active) unless the unit is in a blocked
        // state (PM Failed / Expired Inspection / accident-damage). The result
        // overrides the AI draft so the reply reflects what actually happened.
        const _flipUnit = _detectFlipRequest(msg.text || '', historyMsgs);
        if (_flipUnit) {
          const flipResult = await _maybeAutoFlip(_flipUnit, msg.userId ? `<@${msg.userId}> ` : '');
          if (flipResult) {
            draft.reply    = flipResult.reply;
            draft.inScope  = flipResult.inScope;
            draft.category = flipResult.category;
            draft.title    = flipResult.title;
            const _fa = flipResult._flip ? flipResult._flip.action : 'unknown';
            doLog(`[SlackDM] ${dm.name}: auto-flip ${_flipUnit} -> ${_fa}`);
          }
        }

        let replyTs = null;
        // Declared outside the try so it is in scope for the log entry below
        // regardless of whether the send succeeds or throws.
        const taggedReply = (msg.userId ? `<@${msg.userId}> ` : '') + draft.reply;
        try {
          // Reply in-thread if the incoming message was itself part of a
          // thread (msg.threadTs is null for plain top-level messages, so
          // this is a no-op / unchanged behavior for the common case).
          const sendResult = await sendToChannel(dm.channelId, taggedReply, msg.threadTs || undefined);
          replyTs = sendResult.ts;
          repliedCount++;
        } catch (e) {
          doLog(`[SlackDM] ${dm.name}: reply send FAILED: ${e.message}`);
          if (e.message && e.message.includes('restricted_action')) {
            _sendBlockedChannels.add(dm.channelId);
            doLog(`[SlackDM] ${dm.name}: marked as read-only — will skip sends for this session`);
          }
        }

        const entry = {
          id: dm.channelId + ':' + msg.ts,
          channelId: dm.channelId,
          channelName: dm.name,
          ts: msg.ts,
          replyTs,
          question: msg.text,
          reply: taggedReply,
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
      } } // end if (hasNewTopLevel) / for-of newMsgs

      // ── FEATURE: thread-reply auto-reply ─────────────────────────────────
      // conversations.history only returns top-level messages; thread replies
      // are invisible to it. For every top-level message that has replies
      // (replyCount > 0), fetch the thread via readThreadReplies and process
      // any replies newer than lastSeenTs the same way as top-level messages —
      // but always send the response back into the same thread.
      //
      // BASELINE (same principle as lastSeenTs for top-level messages):
      // On the first time we see a thread, cache its current reply count without
      // fetching. Only threads where replyCount INCREASES on a subsequent poll
      // get fetched. This makes cold-start (empty cache) cost zero extra API calls —
      // no "reply to all existing threads on first run" explosion.
      for (const msg of messages) {
        if (msg.replyCount > 0) {
          const bKey = dm.channelId + ':' + msg.ts;
          if (_threadReplyCount[bKey] === undefined) {
            _threadReplyCount[bKey] = msg.replyCount; // baseline without fetching
          }
        }
      }
      // Only check thread replies for messages posted in the last 7 days.
      // Older threads have already been fully processed; re-fetching them
      // wastes API quota and causes rate-limit errors.
      const _sevenDaysAgo = (Date.now() / 1000) - 7 * 86400;
      const threadsToCheck = messages.filter(m => m.replyCount > 0 && parseFloat(m.ts) > _sevenDaysAgo).slice(0, 5); // cap at 5 per DM
      let latestThreadReplyTs = null;

      // Rate-limit guard: _rlUntil is module-level so it persists across DMs
      // and across poll cycles. If we hit ratelimited, back off 60s globally.
      for (const parentMsg of threadsToCheck) {
        if (Date.now() < _rlUntil) break; // still in cooldown — skip rest of threads
        if (Date.now() > _pollDeadline) { doLog(`[SlackDM] ${dm.name}: poll deadline reached — skipping remaining threads`); break; }
        // Skip the API call entirely if replyCount has not changed since we last fetched.
        const _cacheKey = dm.channelId + ':' + parentMsg.ts;
        if (_threadReplyCount[_cacheKey] === parentMsg.replyCount) continue;
        await new Promise(r => setTimeout(r, 200)); // was 600ms — reduced; rate-limit backoff handles actual limits
        try {
          // conversations.replies always includes the parent as index 0; skip it.
          const replies = await readThreadReplies(dm.channelId, parentMsg.ts, 20);
          _threadReplyCount[_cacheKey] = parentMsg.replyCount; // cache so next poll skips if unchanged
          const newReplies = replies
            .slice(1)
            .filter(r => parseFloat(r.ts) > parseFloat(seen.lastSeenTs))
            .filter(r => r.userId && r.userId !== myUserId);

          for (const reply of newReplies) {
            const replyLogId = dm.channelId + ':' + reply.ts;
            const existingLog = store.load('slackDMReplies', []);
            if (existingLog.some(e => e.id === replyLogId)) {
              doLog(`[SlackDM] ${dm.name}: thread reply ${reply.ts} already in log — skipping`);
              // Advance so lastSeenTs catches up; stops re-processing this reply every poll.
              if (!latestThreadReplyTs || parseFloat(reply.ts) > parseFloat(latestThreadReplyTs)) latestThreadReplyTs = reply.ts;
              continue;
            }

            // FEATURE (2026-07-30): Skip if Z already replied manually in this
            // thread after this reply's timestamp.
            const zAlreadyRepliedInThread = replies.some(
              r => r.userId === myUserId && parseFloat(r.ts) > parseFloat(reply.ts)
            );
            if (zAlreadyRepliedInThread) {
              doLog(`[SlackDM] ${dm.name}: Z already replied manually in thread after ${reply.ts} — skipping auto-reply`);
              // Advance so lastSeenTs catches up.
              if (!latestThreadReplyTs || parseFloat(reply.ts) > parseFloat(latestThreadReplyTs)) latestThreadReplyTs = reply.ts;
              continue;
            }

            // Build context from prior messages in this thread (up to 2).
            const threadContext = await Promise.all(
              replies
                .filter(r => parseFloat(r.ts) < parseFloat(reply.ts))
                .slice(-2)
                .map(async r => {
                  const who = r.userId === myUserId ? 'You' : ((await resolveUserName(r.userId)) || dm.name || 'Them');
                  return who + ': ' + (r.text || '');
                })
            );

            const speakerNameT = dm.isGroup ? ((await resolveUserName(reply.userId)) || 'Someone in the group') : null;
            const groupContextT = dm.isGroup
              ? { isGroup: true, memberNames: (dm.name || '').split(', ').filter(Boolean), speakerName: speakerNameT }
              : null;

            // Enrich AI prompt with any links or files in this thread reply
            const attachCtxT = await _buildAttachmentContext(reply, downloadFileContent);
            const replyTextWithAttach = (reply.text || '') + attachCtxT;
            const draft = await _classifyAndDraft(replyTextWithAttach, threadContext, groupContextT);

            let replyTs = null;
            let taggedReplyT = null;
            try {
              // Reply in the same thread as the parent message.
              taggedReplyT = (reply.userId ? `<@${reply.userId}> ` : '') + draft.reply;
              const sendResult = await sendToChannel(dm.channelId, taggedReplyT, parentMsg.ts);
              replyTs = sendResult.ts;
              repliedCount++;
            } catch (e) {
              doLog(`[SlackDM] ${dm.name}: thread reply send FAILED: ${e.message}`);
              if (e.message && e.message.includes('restricted_action')) {
                _sendBlockedChannels.add(dm.channelId);
                doLog(`[SlackDM] ${dm.name}: marked as read-only — will skip sends for this session`);
              }
            }

            const entry = {
              id: replyLogId,
              channelId: dm.channelId,
              channelName: dm.name,
              ts: reply.ts,
              threadTs: parentMsg.ts,   // distinguishes thread replies in the log
              replyTs,
              question: reply.text,
              reply: taggedReplyT,
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
              doLog(`[SlackDM] ${dm.name}: thread reply escalated (${draft.category}) — "${draft.title}"`);
            } else {
              doLog(`[SlackDM] ${dm.name}: thread reply answered (parent ts ${parentMsg.ts})`);
            }

            if (!latestThreadReplyTs || parseFloat(reply.ts) > parseFloat(latestThreadReplyTs)) {
              latestThreadReplyTs = reply.ts;
            }
          }
        } catch (e) {
          doLog(`[SlackDM] ${dm.name}: thread fetch error (parent ${parentMsg.ts}): ${e.message}`);
          if (e.message && e.message.indexOf('ratelimited') !== -1) {
            _rlUntil = Date.now() + 60000; // back off 60s globally across all DMs + poll cycles
            break;
          }
        }
      }
      // ── end thread-reply block ─────────────────────────────────────────────

      // Advance lastSeenTs to the latest of: newest top-level msg OR newest
      // thread reply, so neither source can re-trigger on the next poll.
      const _topTs      = hasNewTopLevel ? newMsgs[newMsgs.length - 1].ts : seen.lastSeenTs;
      const overallLatest = latestThreadReplyTs && parseFloat(latestThreadReplyTs) > parseFloat(_topTs)
        ? latestThreadReplyTs
        : _topTs;

      _saveThreadLastSeen(dm.channelId, dm.name, overallLatest, dm.isGroup);
      // Auto-save every distinct sender seen in this thread to the contact
      // book. FIX (2026-07-25): a 1:1 DM only ever has one possible sender,
      // so "just the first" was equivalent there -- but in a GROUP DM,
      // multiple different people can each send a first-ever message in the
      // same poll cycle, and only ever saving the first meant every other
      // group member was silently never added as a contact.
      const senderIds = [...new Set(newMsgs.filter(m => m.userId && m.userId !== myUserId).map(m => m.userId))];
      for (const id of senderIds) await _autoSaveContact(dm, id);
    } catch (e) {
      doLog(`[SlackDM] ${dm.name}: poll error: ${e.message}`);
    }
  }

  return { repliedCount, escalatedCount, items: newEscalations };
  } finally {
    // Persist thread-reply count cache so the next app restart doesn't cold-start
    // and re-fetch every thread (avoids 5-10min first-poll stalls).
    try {
      // Trim to last 2000 entries by ts (keys are channelId:ts — sort drops oldest)
      const keys = Object.keys(_threadReplyCount);
      if (keys.length > 2000) {
        const sorted = keys.sort((a, b) => {
          const tsA = parseFloat(a.split(':').pop()) || 0;
          const tsB = parseFloat(b.split(':').pop()) || 0;
          return tsB - tsA; // newest first
        });
        const trimmed = {};
        sorted.slice(0, 2000).forEach(k => { trimmed[k] = _threadReplyCount[k]; });
        _threadReplyCount = trimmed;
      }
      store.save('slackDMThreadReplyCount', _threadReplyCount);
    } catch (_) {}
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
