'use strict';
/**
 * src/dtna/channels.js — which DTNA channel a "Post to DTNA" goes to. Pure, no requires.
 *
 * Chatter (the case feed) is available only when CHATTER_POST_PARAMS is configured AND a live feed-model
 * read said isChatterEnabled === true (external communication is on for the case). Unknown (read failed,
 * field missing, feed read not configured) counts as NOT available. The case comment is available when
 * POST_COMMENT_PARAMS is configured and the cached case has a repair order.
 * auto = Chatter when available, else the case comment when available, else null.
 * An explicit pick is honoured only when that channel is available.
 */
const CHANNELS = ['chatter', 'comment'];

/**
 * selectChannel({ chatterConfigured, chatterEnabled, chatterCode?, commentConfigured, hasRepairOrder, pulled? }, explicit?)
 * -> { auto, chosen, chatter:{available, reason}, comment:{available, reason}, refused? }
 * chatterEnabled: true | false | null (unknown). pulled === false: the case is not in the cache.
 */
function selectChannel(state, explicit) {
  const s = state || {};
  let chatterReason = '';
  if (!s.chatterConfigured) chatterReason = 'DTNA_CHATTER_NOT_CONFIGURED';
  else if (s.chatterEnabled === false) chatterReason = 'DTNA_CHATTER_DISABLED';
  else if (s.chatterEnabled !== true) chatterReason = 'DTNA_CHATTER_UNKNOWN';
  let commentReason = '';
  if (!s.commentConfigured) commentReason = 'DTNA_POST_NOT_CONFIGURED';
  else if (s.pulled === false) commentReason = 'DTNA_NOT_PULLED';
  else if (!s.hasRepairOrder) commentReason = 'DTNA_NO_REPAIR_ORDER';
  const chatter = { available: !chatterReason, reason: chatterReason };
  if (chatterReason === 'DTNA_CHATTER_UNKNOWN' && typeof s.chatterCode === 'string' && /^DTNA_[A-Z0-9_]{1,40}$/.test(s.chatterCode)) chatter.code = s.chatterCode;
  const comment = { available: !commentReason, reason: commentReason };
  const auto = chatter.available ? 'chatter' : (comment.available ? 'comment' : null);
  const out = { auto, chosen: auto, chatter, comment };
  if (explicit !== undefined && explicit !== null && explicit !== 'auto') {
    if (!CHANNELS.includes(explicit)) { out.chosen = null; out.refused = 'DTNA_INVALID_INPUT'; }
    else if (out[explicit].available) out.chosen = explicit;
    else { out.chosen = null; out.refused = out[explicit].reason; }
  }
  return out;
}

module.exports = { selectChannel, CHANNELS };
