'use strict';
/**
 * slack_justme_channel.js — single source of truth for "which Slack channel is
 * the user's Just Me channel" (context-aware assistant, 2026-11).
 *
 * The poller decides per channel by replyMode, falling back to the global
 * cfg.replyMode, default 'mentions' (slack_channel_watch.js). `ch.mode` is never
 * written anywhere and must not be used.
 *
 * Pure: no requires. Callers pass store.load('slackChannelWatchConfig', {}).
 */

function channelMode(ch, cfg) { return (ch && ch.replyMode) || (cfg && cfg.replyMode) || 'mentions'; }

function isJustMeChannel(ch, cfg) { return !!(ch && ch.id && ch.enabled !== false && channelMode(ch, cfg) === 'justme'); }

// forSend: stricter rule for anything that POSTS proactively. Requires the channel's
// OWN replyMode === 'justme' (no global fallback) and never a PM-alert auto-reply channel.
function isJustMeSendTarget(ch) { return !!(ch && ch.id && ch.enabled !== false && ch.replyMode === 'justme' && ch.pmAlertAutoReply !== true); }

function findJustMeChannel(cfg, opts) {
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.channels)) return null;
  const pred = (opts && opts.forSend) ? isJustMeSendTarget : (ch) => isJustMeChannel(ch, cfg);
  return cfg.channels.find(pred) || null;
}

module.exports = { channelMode, isJustMeChannel, isJustMeSendTarget, findJustMeChannel };
