'use strict';
/**
 * email-intel/actions/templates.js — reason and action texts of the My Email Actions items (design 5.3; R4.11).
 *
 *   CATEGORIES / LABELS / TIER_LABELS
 *   build(category, fields) -> { reasonText (<=160), actionText (<=120) }
 *   evidence(text)          -> the escaped-at-render evidence snippet (<=120), the ONLY place model text appears
 *
 * Texts are built from structured fields only: the sender's display name as captured from Outlook, validated
 * unit ids, enums (decision kind, staged reason, fact state, canonical status), a verified amount and a
 * validated date. Model free text (question wording, gists, commitments) is never part of a reason or an action.
 */
const { cleanLabel } = require('../confirm');
const { FACT_LABELS } = require('../understand/schema');

const CATEGORIES = Object.freeze(['reply', 'decision', 'followup', 'review', 'recorded', 'info', 'outofscope']);
const LABELS = Object.freeze({
  reply: 'Reply Needed', decision: 'Decision / Approval Needed', followup: 'Follow-Up Needed', review: 'Review Conflicting Information',
  recorded: 'Unit Update Recorded', info: 'Informational / No Action', outofscope: 'Out of Scope',
});
const TIER_LABELS = Object.freeze({ required: 'Required', suggested: 'Suggested', fyi: 'FYI' });
const REASON_MAX = 160;
const ACTION_MAX = 120;
const DECISION_ACTION = 'Review in the approval system, then reply. The app will not approve for you.';
const NO_ACTION = 'No action needed';

const STAGED_TEXT = Object.freeze({
  'low-confidence': 'Low-confidence update', 'invalid-confidence': 'Update without a usable confidence', stale: 'Older than the unit\'s current state',
  'uncertain-assertion': 'Unconfirmed or second-hand update', 'scope-unknown': 'Unit scope could not be checked', 'freshness-unprovable': 'Could not tell which update is newer',
  'partial-content': 'Update from a partially read email', 'unprocessed-window': 'Part of the email was not analyzed', 'spend-related': 'Spend or estimate update',
  'roster-mismatch': 'Unit may belong to another FAS', 'ambiguous-order': 'Several updates with an unclear order', 'ambiguous-item': 'Could not tell which part this is about',
  'possible-duplicate': 'May already be on the timeline', 'timeline-disabled': 'Timeline writes are off', 'timeline-filtered': 'The timeline filter rejected the line',
  'standby-host': 'Another computer writes the timeline', 'ai-unavailable': 'Not analyzed by AI yet', 'attachment-conflict': 'The attachment disagrees with the email',
  'write-failed': 'The timeline write failed',
});
const OWNER_TEXT = Object.freeze({ 'other-person': 'another person', vendor: 'the vendor', 'other-team': 'another team' });

const clip = (s, n) => cleanLabel(s, n);
const _name = (s) => clip(s || '', 40) || 'Someone';
const _unit = (u) => clip(String(u || ''), 20);

function unitsText(units) {
  const list = Array.from(new Set((units || []).map(_unit).filter(Boolean)));
  if (!list.length) return 'your unit';
  if (list.length === 1) return 'unit ' + list[0];
  return 'units ' + list.slice(0, 4).join(', ') + (list.length > 4 ? ' +' + (list.length - 4) : '');
}
const _state = (s) => clip(String(s || 'unknown').replace(/_/g, ' '), 30);
function _amount(a) {
  if (!a || typeof a.value !== 'number' || !Number.isFinite(a.value)) return '';
  return ' ($' + a.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ')';
}
const KIND_NOUN = Object.freeze({ estimate: 'the estimate', approval: 'the approval', spend: 'the spend' });

/**
 * build(category, f) — f fields by category:
 *   reply:    { type, asker, units, tier, probablyAnswered, partial, basis }
 *   decision: { asker, units, tier, unclear (addressee not me), decisionKind, amount }
 *   followup: { who, dueDate }
 *   review:   { reason, unit, factState, factKind, hasFact, canonical:{status,repairPhase,lastUpdateSource} }
 *   recorded: { units, kinds[] }
 *   info:     { code, units, owner }
 *   outofscope: { count }
 */
function build(category, f) {
  const x = f || {};
  let reason; let action;
  switch (category) {
    case 'reply': {
      const who = _name(x.asker);
      const about = unitsText(x.units);
      if (x.probablyAnswered) { reason = who + '\'s question about ' + about + ' may already be answered in the thread'; action = 'Check the thread; reply only if it is still open'; break; }
      if (x.basis === 'shared') { reason = who + ' asked the group about ' + about + '; you are in To'; action = 'Reply if you are the right person (Reply or Reply All)'; break; }
      if (x.partial) { reason = who + ' may have asked you about ' + about + ' (only part of the email was read)'; action = 'Open it in Outlook and reply if needed'; break; }
      reason = x.type === 'request' ? who + ' asked you to act on ' + about : who + ' asked you a question about ' + about;
      action = x.type === 'request' ? 'Do the requested step, then reply to ' + who : 'Reply to ' + who + ' (Reply or Reply All)';
      break;
    }
    case 'decision': {
      const who = _name(x.asker);
      const about = unitsText(x.units);
      const noun = KIND_NOUN[x.decisionKind];
      if (x.unclear) {
        const k = noun ? noun.replace(/^the /, '') + ' ' : '';
        reason = (/^[aeiou]/.test(k) ? 'An ' : 'A ') + k + 'decision about ' + about + ' may need you (addressee unclear)' + _amount(x.amount);
      }
      else reason = noun ? who + ' asked you to approve ' + noun + ' for ' + about + _amount(x.amount) : who + ' asked you for a decision about ' + about + _amount(x.amount);
      action = DECISION_ACTION;
      break;
    }
    case 'followup': {
      const who = x.who ? _name(x.who) : 'The other party';
      reason = who + ' said they\'d update by ' + clip(x.dueDate || 'a date', 10) + '; nothing since';
      action = 'Contact ' + (x.who ? _name(x.who) : 'them') + ' for an update';
      break;
    }
    case 'review': {
      const unit = 'unit ' + (_unit(x.unit) || '?');
      const c = x.canonical || {};
      const source = clip(c.lastUpdateSource || 'the app', 20);
      const canon = _state(c.repairPhase || c.status);
      if (x.reason === 'conflict-canonical') reason = 'Email says ' + _state(x.factState) + ' for ' + unit + ', but ' + source + ' shows ' + canon + ' (newer)';
      else if (x.reason === 'conflict-ready') reason = 'Email says ' + unit + ' is ready, but ' + source + ' shows ' + canon;
      else reason = (STAGED_TEXT[x.reason] || 'Update needs review') + ' for ' + unit + (x.factKind && FACT_LABELS[x.factKind] ? ' (' + FACT_LABELS[x.factKind] + ')' : '');
      action = x.hasFact ? 'Review and choose Record anyway or Reject' : 'Review the email; reject when nothing is needed';
      break;
    }
    case 'recorded': {
      const kinds = Array.from(new Set((x.kinds || []).map((k) => FACT_LABELS[k]).filter(Boolean)));
      const n = Math.max(1, Number(x.count) || 0);
      reason = 'Recorded ' + n + ' update' + (n === 1 ? '' : 's') + ' for ' + unitsText(x.units) + (kinds.length ? ': ' + kinds.join(', ') : '');
      action = NO_ACTION;
      break;
    }
    case 'info': {
      const about = unitsText(x.units);
      const t = {
        'group-info': ['Group email with information about ' + about + '; nothing asked of you', NO_ACTION],
        'relevant-info': ['Information about ' + about + '; no action expected from you', NO_ACTION],
        'owned-by-other': ['The next step is with ' + (OWNER_TEXT[x.owner] || 'someone else') + '; no reply needed from you', NO_ACTION],
        answered: ['Already answered in the thread; no reply needed', NO_ACTION],
        'partial-unknown': ['Only part of this email could be read; who it is for is unclear', 'Open it in Outlook to check whether it needs you'],
        'not-analyzed': ['Not analyzed yet; it will be checked on the next scan', NO_ACTION],
        'analysis-failed': ['Could not analyze this email', 'Retry analysis or read it in Outlook'],
        informational: ['Informational; no action expected from you', NO_ACTION],
      }[x.code] || ['Informational; no action expected from you', NO_ACTION];
      reason = t[0]; action = t[1];
      break;
    }
    case 'outofscope': {
      const n = Math.max(0, Number(x.count) || 0);
      reason = 'Only mentions units outside your fleet (' + n + ')';
      action = NO_ACTION;
      break;
    }
    default:
      reason = 'Needs a look'; action = NO_ACTION;
  }
  return { reasonText: clip(reason, REASON_MAX), actionText: clip(action, ACTION_MAX) };
}

/** Evidence snippet (model text or a validated quote): control-stripped and capped; escaped by the renderer. */
function evidence(text) {
  const t = clip(text || '', 120);
  return t || undefined;
}

module.exports = { CATEGORIES, LABELS, TIER_LABELS, STAGED_TEXT, DECISION_ACTION, NO_ACTION, REASON_MAX, ACTION_MAX, unitsText, build, evidence };
