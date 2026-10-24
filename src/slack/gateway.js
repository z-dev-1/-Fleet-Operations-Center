'use strict';
/**
 * src/slack/gateway.js — Digital FAS Phase 7: the ONE Slack inbound gateway
 * (spec #3).
 *
 * Every inbound Slack message — top-level DM, DM thread reply, self-DM, group
 * DM, watched channel, Slack Connect / partner channel, thread reply, mention —
 * is normalized into ONE canonical shape here, then handed to the FAS runner
 * (via toRunnerInput). This replaces the per-engine, ad-hoc construction of the
 * runner input so there is a SINGLE definition of "an inbound Slack event".
 *
 * ── SCOPE (deliberately NARROW to stay non-breaking) ─────────────────────────
 * The gateway owns NORMALIZATION only. It does NOT poll, dedupe, watermark,
 * claim, rate-limit, batch, or send — that reliability machinery stays in the
 * two transport engines (slack_dm_autoreply.js / slack_channel_watch.js) and is
 * untouched. The engines keep their polling loops; they just build the runner
 * input THROUGH this module instead of inline, so normalization is unified and
 * every surface gets the Phase 1-6 context (isGroup, isSelf, mentioned,
 * participants, surface, isSlackConnect) consistently.
 *
 * Pure + deterministic: no I/O, no Slack calls, never throws on bad input.
 */

// Canonical inbound surfaces (spec #3).
const SURFACES = ['dm', 'self_dm', 'dm_thread', 'group_dm', 'channel', 'slack_connect'];

// Literal Slack mention token test, e.g. "<@U123>".
function _mentionsUser(text, myUserId) {
  if (!text || !myUserId) return false;
  return new RegExp('<@' + myUserId.replace(/[^A-Za-z0-9_]/g, '') + '>').test(String(text));
}

/**
 * normalizeInbound(raw) -> canonical normalized event (spec #3).
 *
 * raw: {
 *   engine        : 'dm' | 'dm-thread' | 'channel' (the transport engine's label)
 *   conv          : the conversation record ({ channelId, name, isGroup, isSelf,
 *                   isSlackConnect? }) — a DM/group/channel record.
 *   message       : the Slack message ({ ts, threadTs?, text, userId/user, files? })
 *   parentTs      : optional parent ts for a thread reply
 *   myUserId      : the signed-in user id (for self + mention detection)
 *   mentioned     : optional explicit mention flag (channel engine computes this)
 *   isThreadReply : optional explicit flag
 *   participants  : optional array of participant slackIds/{slackId,name} who can
 *                   see the response (for the audience resolver)
 * }
 *
 * Returns the canonical shape; callers add `conversation` (history) and
 * `attachments` (inline context) which are engine-built.
 */
function normalizeInbound(raw) {
  raw = raw || {};
  const conv = raw.conv || {};
  const msg = raw.message || {};
  const myUserId = raw.myUserId || '';
  const senderSlackId = msg.userId || msg.user || '';
  const text = typeof msg.text === 'string' ? msg.text : '';
  const threadTs = msg.threadTs || raw.parentTs || null;
  const isThreadReply = raw.isThreadReply != null ? !!raw.isThreadReply
    : !!(threadTs && msg.ts && String(threadTs) !== String(msg.ts)) || raw.engine === 'dm-thread';
  const isSelf = !!conv.isSelf || (!!myUserId && senderSlackId === myUserId);
  const isGroup = !!conv.isGroup || raw.engine === 'channel';
  const isSlackConnect = !!conv.isSlackConnect || !!raw.isSlackConnect;
  const isMentioned = raw.mentioned != null ? !!raw.mentioned : _mentionsUser(text, myUserId);

  const surface = _deriveSurface({ engine: raw.engine, isSelf, isGroup, isSlackConnect, isThreadReply });

  return {
    source: 'slack',
    surface,
    engine: raw.engine || (isGroup ? 'channel' : 'dm'),   // transport engine label (kept for callers)
    channelId: conv.channelId || conv.id || '',
    channelName: conv.name || '',
    messageTs: msg.ts || '',
    threadTs,
    parentTs: raw.parentTs || threadTs || null,
    senderSlackId,
    senderName: conv.name || senderSlackId || '',
    text,
    files: Array.isArray(msg.files) ? msg.files : [],
    mentions: _extractMentions(text),
    isMentioned,
    isThreadReply,
    isSelf,
    isGroup,
    isSlackConnect,
    participants: Array.isArray(raw.participants) ? raw.participants : undefined,
  };
}

function _deriveSurface(f) {
  if (f.isSelf) return 'self_dm';
  if (f.isSlackConnect) return 'slack_connect';
  if (f.isGroup) return 'channel';           // watched channel / group conversation
  if (f.engine === 'dm-thread' || (f.isThreadReply && !f.isGroup)) return 'dm_thread';
  return 'dm';
}

// Extract all <@USER> mention ids from message text (for audience/relevance).
function _extractMentions(text) {
  const out = [];
  const re = /<@([A-Za-z0-9_]+)>/g; let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
  return out;
}

/**
 * toRunnerInput(normalized, extra) -> the FAS runner's native input.
 *
 * Maps the canonical normalized event to the exact shape
 * orcha/fas/runner.handleInbound (and ai/core.handleInbound) already accept, so
 * the engines can swap their inline object for `gateway.toRunnerInput(...)`
 * with ZERO behavior change. `extra` carries engine-built context:
 *   { conversation, attachments, actualReply }
 * (conversation = history turns; attachments = inline link/preview context
 * string; actualReply = the legacy draft, shadow mode only).
 */
function toRunnerInput(normalized, extra) {
  const n = normalized || {};
  const e = extra || {};
  return {
    engine: n.engine || (n.isGroup ? 'channel' : 'dm'),
    surface: n.surface,
    slackId: n.senderSlackId || '',
    senderName: n.senderName || '',
    channelName: n.channelName || '',
    channelId: n.channelId || '',
    threadTs: n.threadTs || null,
    ts: n.messageTs || '',
    text: n.text || '',
    isGroup: !!n.isGroup,
    isSelf: !!n.isSelf,
    isSlackConnect: !!n.isSlackConnect,
    mentioned: !!n.isMentioned,
    participants: n.participants,
    files: Array.isArray(n.files) ? n.files : [],
    conversation: Array.isArray(e.conversation) ? e.conversation : [],
    attachments: e.attachments || '',
    actualReply: e.actualReply,
  };
}

/**
 * buildRunnerInput(raw, extra) -> runner input — convenience one-shot that
 * normalizes then maps. The engines use this single call.
 */
function buildRunnerInput(raw, extra) {
  return toRunnerInput(normalizeInbound(raw), extra);
}

module.exports = { normalizeInbound, toRunnerInput, buildRunnerInput, SURFACES, _deriveSurface, _extractMentions };
