'use strict';
/**
 * slack_decision_trace.js — decision-trace debugger for the Slack reply engines.
 *
 * Records, for EVERY inbound Slack message the DM auto-reply and channel-watch
 * engines evaluate, exactly WHAT they saw and WHY they replied (or skipped):
 *   - engine (dm | channel), channel/sender, message text
 *   - the routing decision (replied / skipped) + the reason
 *   - mention/directed-at-me signals
 *   - any inherited unit (and why it was inherited)
 *   - the fleet-data units that were injected into the AI context
 *   - the AI's raw output (truncated) and the final reply text
 *
 * This makes "why did it say that / why did it reply to Melissa's alert"
 * fully diagnosable from one log instead of guessing. Writes to its own
 * logger namespace so it lands in logs/slack_decisions.log.
 */

const logger = require('../utils/logger').createLogger('slack_decisions');

function _short(v, n) {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return s.length > (n || 300) ? s.slice(0, n || 300) + '…' : s;
}

/**
 * trace(entry) — record one decision.
 * @param {object} e
 *   engine:      'dm' | 'channel'
 *   channel:     channel/DM display name
 *   sender:      sender display name or id (optional)
 *   ts:          slack message ts (optional)
 *   text:        the incoming message text
 *   decision:    'replied' | 'skipped' | 'held' | 'escalated' | 'error'
 *   reason:      short human explanation of the decision
 *   mentioned:   bool — literal @-mention of the signed-in user (optional)
 *   directedAtMe: bool | null — AI gate result (optional)
 *   otherMention: string | null — a different user id the message was addressed to (optional)
 *   inheritedUnit: string | null — unit carried in from thread history (optional)
 *   contextUnits: string[] — fleet units injected into the AI context (optional)
 *   aiRaw:       raw AI output (optional)
 *   reply:       final reply text sent (optional)
 */
function trace(e) {
  try {
    const parts = [];
    parts.push('[' + (e.engine || '?') + ']');
    if (e.channel) parts.push(e.channel);
    if (e.sender) parts.push('from=' + e.sender);
    if (e.ts) parts.push('ts=' + e.ts);
    parts.push('DECISION=' + (e.decision || '?'));
    if (e.reason) parts.push('reason=' + e.reason);
    if (e.mentioned != null) parts.push('mentioned=' + e.mentioned);
    if (e.directedAtMe != null) parts.push('directedAtMe=' + e.directedAtMe);
    if (e.otherMention) parts.push('addressedTo=' + e.otherMention);
    if (e.inheritedUnit) parts.push('inheritedUnit=' + e.inheritedUnit);
    if (e.contextUnits && e.contextUnits.length) parts.push('contextUnits=[' + e.contextUnits.join(',') + ']');
    logger.info(parts.join(' | '));
    if (e.text)  logger.info('    MSG:   ' + _short(e.text, 400));
    if (e.aiRaw) logger.info('    AIRAW: ' + _short(e.aiRaw, 400));
    if (e.reply) logger.info('    REPLY: ' + _short(e.reply, 400));
  } catch (_) { /* never let tracing break a reply */ }
}

module.exports = { trace };
