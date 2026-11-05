'use strict';
// src/justme-context/reply-hygiene.js — design §12.2. Applied by
// slack_channel_watch._jmHandleMessage to AI-written text on context turns only
// (never to the "<@Z> " tag prefix or the code-built report).
//
// defangMentions: the reply is posted with Z's user token, where <!channel>,
// <!here>, <!everyone>, <!subteam^…>, <@U…>, <@W…> and <#C…> are live. Content can
// steer the model to emit them, so they become plain text. Round-3 fix 8: a
// labelled link <https://…|label> renders as just "label" in Slack and hides the
// target, so it becomes "label (https://…)" first.

const { LIMITS } = require('./constants');

function defangMentions(s) {
  return String(s == null ? '' : s)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_, u, l) => l + ' (' + u + ')')
    .replace(/<!(channel|here|everyone|subteam\^[A-Z0-9]+)(\|[^>]*)?>/gi, (_, k) => '@' + k.replace(/^subteam\^.*/i, 'group'))
    .replace(/<([@#])([UWC][A-Z0-9]+)(\|([^>]*))?>/g, (_, k, id, _l, label) => k + (label || id))
    .replace(/(^|\s)@(channel|here|everyone)\b/gi, '$1@\u200B$2');
}

const _flat = (s) => String(s == null ? '' : s).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const _fence = (s) => s.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››');
function _cut(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/**
 * confirmPreview(items): one "> To <name>: <preview>" line per staged Slack/email
 * send, so Z never confirms a content-derived body blind (AC-44).
 */
function confirmPreview(items) {
  let out = '';
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || (it.channel !== 'slack' && it.channel !== 'email')) continue;
    const name = _cut(_fence(defangMentions(_flat(it.recipientName || it.to || 'recipient'))), 80);
    const body = it.channel === 'email' && it.subject ? it.subject + ' — ' + (it.body || '') : (it.body || '');
    out += '\n> To ' + name + ': ' + _cut(_fence(defangMentions(_flat(body))), LIMITS.CONFIRM_PREVIEW_MAX);
  }
  return out;
}

module.exports = { defangMentions, confirmPreview };
