'use strict';
/**
 * orcha/fas/slack-search.js — Digital FAS: authorized Slack message search.
 *
 * Enterprise Grid restricts Slack's global search.messages for xoxc user
 * tokens (confirmed: "enterprise_is_restricted" in slack_send.js). So this
 * adapter searches a LOCAL INDEX of messages the app already sees on the
 * monitored/authorized DMs and channels, and can optionally augment with live
 * conversations.history for a specific named channel via an injected provider.
 *
 * Security model (enforced in code, not prompt):
 *  - Searches ONLY content Zila's account can access (the monitored surfaces).
 *  - Re-filters results by the REQUESTING sender's operator/domicile scope
 *    before anything is exposed to the model (a carrier can't see another
 *    operator's chatter just because it mentions their unit).
 *  - Treats every message body as UNTRUSTED (the caller wraps it).
 *  - Ranks newer + exact-unit matches above older/partial; caps result count
 *    and total chars so the prompt can't be flooded.
 *
 * This module is pure/deterministic and fully unit-testable: the message
 * source is provided via opts.index (array) and/or opts.liveProvider (fn).
 */

const store = require('../../store');

const DEFAULT_MAX_RESULTS = 12;
const DEFAULT_MAX_CHARS = 4000;
const EXCERPT_CHARS = 240;

// Build the local index from stored monitored messages. Each stored surface
// keeps a slightly different shape; normalize to { ts, userId, senderName,
// channelId, channelName, text, threadTs, permalink, operator, domicile }.
function _loadLocalIndex() {
  const out = [];
  const push = (m, src) => {
    if (!m) return;
    out.push({
      ts: String(m.ts || m.timestamp || ''),
      userId: m.userId || m.user || m.from || '',
      senderName: m.senderName || m.name || '',
      channelId: m.channelId || m.channel || '',
      channelName: m.channelName || m.channel || src,
      text: String(m.text || m.message || m.incoming || ''),
      threadTs: m.threadTs || m.thread_ts || null,
      permalink: m.permalink || m.link || '',
      operator: (m.operator || '').toUpperCase(),
      domicile: (m.domicile || m.domicileSite || '').toUpperCase(),
      _src: src,
    });
  };
  try {
    const dm = store.load('slackDMReplies', []) || [];
    (Array.isArray(dm) ? dm : []).forEach(m => push(m, 'dm'));
  } catch (_) {}
  try {
    const ch = store.load('slackChannelReplies', []) || [];
    (Array.isArray(ch) ? ch : []).forEach(m => push(m, 'channel'));
  } catch (_) {}
  try {
    const mt = store.load('slackMentionThreads', {}) || {};
    Object.values(mt).forEach(v => {
      if (Array.isArray(v)) v.forEach(m => push(m, 'mention'));
      else if (v && Array.isArray(v.messages)) v.messages.forEach(m => push(m, 'mention'));
    });
  } catch (_) {}
  return out.filter(m => m.text);
}

function _tsToMs(ts) {
  // Slack ts is "seconds.micro"; also accept ISO strings.
  const n = parseFloat(ts);
  if (!isNaN(n) && n > 1e8) return Math.round(n * 1000);
  const p = Date.parse(ts);
  return isNaN(p) ? 0 : p;
}

function _excerpt(text, terms) {
  const t = String(text);
  if (t.length <= EXCERPT_CHARS) return t;
  const lc = t.toLowerCase();
  let at = -1;
  for (const term of terms) { const i = lc.indexOf(term); if (i >= 0) { at = i; break; } }
  if (at < 0) return t.slice(0, EXCERPT_CHARS) + '…';
  const start = Math.max(0, at - 60);
  return (start > 0 ? '…' : '') + t.slice(start, start + EXCERPT_CHARS) + (start + EXCERPT_CHARS < t.length ? '…' : '');
}

/**
 * searchSlack(query, profile, opts) -> { ok, results, truncated, total }
 *
 * query: { unit, vendor, operator, domicile, keywords, sender, channel,
 *          fromMs, toMs }
 * profile: the RESOLVED requesting-sender profile (for authorization re-filter)
 * opts: { index?: [], maxResults?, maxChars?, scopeCheck?: fn(profile, {operator,domicile}) -> bool }
 */
function searchSlack(query, profile, opts) {
  query = query || {};
  opts = opts || {};
  const index = Array.isArray(opts.index) ? opts.index : _loadLocalIndex();
  const maxResults = opts.maxResults || DEFAULT_MAX_RESULTS;
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;

  const unit = String(query.unit || '').trim().toUpperCase();
  const terms = []
    .concat(query.keywords ? String(query.keywords).toLowerCase().split(/\s+/) : [])
    .concat(query.vendor ? [String(query.vendor).toLowerCase()] : [])
    .concat(unit ? [unit.toLowerCase()] : [])
    .filter(Boolean);
  const wantOperator = String(query.operator || '').trim().toUpperCase();
  const wantDomicile = String(query.domicile || '').trim().toUpperCase();
  const wantSender = String(query.sender || '').trim().toLowerCase();
  const wantChannel = String(query.channel || '').trim().toLowerCase();
  const fromMs = query.fromMs || 0;
  const toMs = query.toMs || Infinity;

  const isInternal = profile && (profile.type === 'internal' || profile.type === 'manager');
  const scopeOk = typeof opts.scopeCheck === 'function' ? opts.scopeCheck : (p, m) => {
    // Default authorization re-filter: internal sees all; external sees only
    // messages tied to THEIR operators/domiciles (when the message carries
    // that tag). Untagged messages are visible only to internal users.
    if (isInternal) return true;
    const ops = ((p && p.operators) || []).map(s => String(s).toUpperCase());
    const doms = ((p && p.domiciles) || []).map(s => String(s).toUpperCase());
    if (m.operator && ops.includes(m.operator)) return true;
    if (m.domicile && doms.includes(m.domicile)) return true;
    return false;
  };

  const scored = [];
  for (const m of index) {
    const ms = _tsToMs(m.ts);
    if (ms < fromMs || ms > toMs) continue;
    if (wantChannel && !String(m.channelName).toLowerCase().includes(wantChannel)) continue;
    if (wantSender && !(String(m.senderName).toLowerCase().includes(wantSender) || String(m.userId).toLowerCase().includes(wantSender))) continue;
    if (wantOperator && m.operator && m.operator !== wantOperator) continue;
    if (wantDomicile && m.domicile && m.domicile !== wantDomicile) continue;

    const lc = m.text.toLowerCase();
    // Content match: must hit at least one term (unless no terms -> filters only).
    let hits = 0; let exactUnit = false;
    if (terms.length) {
      for (const term of terms) { if (lc.includes(term)) hits++; }
      if (!hits) continue;
      if (unit && new RegExp('(^|[^a-z0-9])' + unit.toLowerCase() + '([^a-z0-9]|$)').test(lc)) exactUnit = true;
    }
    // Authorization re-filter — AFTER content match, BEFORE exposing.
    if (!scopeOk(profile, m)) continue;

    // Score: exact-unit >> more term hits >> newer.
    const score = (exactUnit ? 10000 : 0) + hits * 100 + Math.min(99, ms / 1e12);
    scored.push({ m, ms, score, exactUnit });
  }

  scored.sort((a, b) => b.score - a.score || b.ms - a.ms);

  const results = [];
  let chars = 0;
  let truncated = false;
  for (const s of scored) {
    if (results.length >= maxResults) { truncated = true; break; }
    const excerpt = _excerpt(s.m.text, terms);
    if (chars + excerpt.length > maxChars) { truncated = true; break; }
    chars += excerpt.length;
    results.push({
      ts: s.m.ts,
      when: s.ms ? new Date(s.ms).toISOString() : null,
      sender: s.m.senderName || s.m.userId,
      channel: s.m.channelName,
      excerpt,
      permalink: s.m.permalink || null,
      source: 'Slack/' + s.m._src,
      exactUnitMatch: s.exactUnit,
    });
  }
  return { ok: true, results, truncated, total: scored.length };
}

module.exports = { searchSlack, _loadLocalIndex, _tsToMs };
