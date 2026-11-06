'use strict';
/**
 * email-intel/understand/prescreen.js — cheap deterministic gate in front of the AI (design 3.3,
 * PG-1, R2.1, R2.7, F2-08).
 *
 *   prescreen(record, scan, convState, cfg) -> { aiNeeded, reason, triggers[], priority, deterministic }
 *
 * F2-08 (corrected wording): recipient data never makes a message ineligible and never lowers
 * relevance; it may only raise queue priority or add an AI trigger. Concretely: every trigger
 * except `direct-1to1` ignores To / CC entirely, the 1:1 rule can only ADD a trigger and +2 priority,
 * and the deterministic relevance of a skipped message is computed without recipient data.
 *
 * AI is needed when any of: an in-scope or scope-unknown unit id appears; one of my configured
 * names appears; the conversation has an open question or action on a unit I own; the message is a
 * direct 1:1 to me with 30+ chars of new content; a fleet keyword appears together with any
 * unit-like token. Otherwise the message is `skipped-cheap`: still stored and shown as
 * Informational (R2.7), never deleted.
 *
 * Priority (descending): +4 in-scope unit, +2 open question on a unit I own, +2 direct 1:1,
 * +1 unread; ties are broken newest first by the caller.
 */

const KEYWORD_RE = /\b(estimates?|approv\w*|eta|parts?|repairs?|ready|pick ?up|pickup|tow\w*|invoices?|quotes?|vendors?|dealers?)\b/i;
const UNITISH_RE = /\b[A-Za-z]?\d{4,7}\b/;

function _lc(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function _escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** One of my configured names (2+ chars) appears as a whole word in the text. */
function mentionsMe(text, me) {
  const t = String(text == null ? '' : text);
  for (const n of (me && Array.isArray(me.names) ? me.names : [])) {
    const s = String(n || '').trim();
    if (s.length < 2) continue;
    if (new RegExp('(^|[^A-Za-z0-9])' + _escape(s) + '([^A-Za-z0-9]|$)', 'i').test(t)) return true;
  }
  return false;
}

function _entryIsMe(entry, me) {
  if (!entry || !me) return false;
  const a = _lc(entry.address);
  const n = _lc(entry.name);
  return (!!a && (me.addresses || []).some((x) => _lc(x) === a)) || (!!n && (me.names || []).some((x) => _lc(x) === n));
}

/** Direct 1:1: To is exactly me, no CC, the sender is not me (recipients must be known). */
function isDirectOneToOne(rec, me) {
  if (!rec || !rec.recipientsKnown) return false;
  const to = Array.isArray(rec.to) ? rec.to : [];
  const cc = Array.isArray(rec.cc) ? rec.cc : [];
  if (to.length !== 1 || cc.length !== 0) return false;
  if (rec.flags && rec.flags.fromMe) return false;
  return _entryIsMe(to[0], me);
}

/**
 * prescreen(record, scan, convState, cfg)
 *   scan: scope.scanMessage() output; convState: { openOnMyUnits:boolean }; cfg: { me }
 */
function prescreen(rec, scan, convState, cfg) {
  const me = (cfg && cfg.me) || {};
  const text = String((rec && rec.subject) || '') + '\n' + String((rec && rec.body && rec.body.newContent) || '');
  const units = (scan && scan.all) || [];
  const inScope = units.some((u) => u.scope === 'in');
  const unknownScope = units.some((u) => u.scope === 'unknown');
  const newChars = String((rec && rec.body && rec.body.newContent) || '').trim().length;
  const triggers = [];
  if (inScope) triggers.push('in-scope-unit');
  if (unknownScope) triggers.push('scope-unknown-unit');
  if (mentionsMe(text, me)) triggers.push('mentions-me');
  if (convState && convState.openOnMyUnits) triggers.push('open-item-on-my-unit');
  if (KEYWORD_RE.test(text) && UNITISH_RE.test(text)) triggers.push('keyword-and-unit');
  const oneToOne = isDirectOneToOne(rec, me);
  if (oneToOne && newChars >= 30) triggers.push('direct-1to1');      // recipient data may only ADD a trigger

  let priority = 0;
  if (inScope) priority += 4;
  if (convState && convState.openOnMyUnits) priority += 2;
  if (oneToOne) priority += 2;
  if (rec && rec.flags && rec.flags.unread) priority += 1;

  const aiNeeded = triggers.length > 0;
  // Relevance of a skipped message is computed from content only (no recipient data).
  const outOnly = units.length > 0 && units.every((u) => u.scope === 'out');
  const deterministic = aiNeeded ? null : {
    relevance: outOnly ? 'none' : (KEYWORD_RE.test(text) ? 'low' : 'none'),
    outOfScope: outOnly,
    category: rec && rec.flags && rec.flags.automated ? 'noise' : 'informational',
  };
  return { aiNeeded, reason: aiNeeded ? triggers[0] : 'no-trigger', triggers, priority, deterministic };
}

module.exports = { prescreen, mentionsMe, isDirectOneToOne, KEYWORD_RE };
