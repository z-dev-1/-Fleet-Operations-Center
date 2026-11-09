'use strict';
/**
 * email-intel/reply/recipients.js — Reply vs Reply All recipient computation (design 6.3; R5.5, R5.6).
 *
 *   computeRecipients(latestMsg, mode, me, opts?) -> {
 *     ok, mode, to:[{ name, address|null, role:'sender'|'to'|'cc' }], cc:[...], toCount, ccCount,
 *     external: n|null, unknownAddress: n, blocked?: 'RECIPIENTS_UNKNOWN'|'NO_RECIPIENTS', selfOnly?: true
 *   }
 *   opts.selfOnlyFallback (apiTransport only): a Reply whose every candidate is me (a self-addressed message)
 *   returns my real address entries instead of NO_RECIPIENTS (what Outlook's createreply addresses). Reply All
 *   is never affected. Without opts the result is unchanged.
 *   recipientKey(entry)            address (lower case) when present, else the normalized display name
 *   compareSets(expected, actual)  -> { equal, missing:[], extra:[] }   order-insensitive, duplicates collapsed
 *
 * Modes:
 *   reply       the sender only (OWA's real Reply applies a Reply-To; the compose verification compares what
 *               OWA produced against this set, so any difference aborts the send). When the latest message is
 *               my own, Reply goes to its To recipients (minus me).
 *   reply-all   sender + original To + original CC, minus me (matched by me.addresses / me.names), de-duplicated by
 *               address (name when there is no address). Requires recipientsKnown and an address on every entry,
 *               otherwise blocked:'RECIPIENTS_UNKNOWN' (Reply All is disabled with an explanation).
 *   new-message the sender only (the unchanged legacy sendReply path, labeled "New message (not threaded)").
 * `external` counts recipients whose domain is not one of the domains of me.addresses (null when no address of
 * mine is configured). CC participants stay in their own list so the dialog can highlight them.
 * Pure: no store, no logging.
 */
const MODES = Object.freeze(['reply', 'reply-all', 'new-message']);

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const normName = (s) => lc(s).replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} .,'-]/gu, '').trim();
const _addr = (e) => { const a = lc(e && e.address); return a && a.includes('@') ? a : ''; };

function recipientKey(entry) {
  const a = _addr(entry);
  return a ? 'a:' + a : 'n:' + normName(entry && entry.name);
}

function _isMe(entry, me) {
  if (!entry || !me) return false;
  const a = _addr(entry); const n = normName(entry.name);
  return (!!a && (me.addresses || []).some((x) => lc(x) === a)) || (!!n && (me.names || []).some((x) => normName(x) === n));
}

function _domains(me) {
  const s = new Set();
  for (const a of ((me && me.addresses) || [])) { const at = String(a).lastIndexOf('@'); if (at > 0) s.add(lc(String(a).slice(at + 1))); }
  return s;
}

const _entry = (e, role) => ({ name: String((e && e.name) || '').slice(0, 120), address: _addr(e) || null, role });

/**
 * Self-addressed Reply (opts.selfOnlyFallback, apiTransport only): every candidate was dropped because it is me
 * (From me, To me only). Outlook's own createreply addresses me in that case, so the real me-entries are returned
 * (address required, never an address-less entry): the original To first, else the sender.
 */
function _selfOnly(m, me) {
  const seen = new Set(); const out = [];
  for (const e of (m.to || [])) {
    if (!_addr(e) || !_isMe(e, me)) continue;
    const k = recipientKey(e);
    if (!seen.has(k)) { seen.add(k); out.push(_entry(e, 'to')); }
  }
  if (!out.length && m.from && _addr(m.from) && _isMe(m.from, me)) out.push(_entry(m.from, 'sender'));
  return out;
}

function computeRecipients(latestMsg, mode, me, opts) {
  const m = latestMsg || {};
  const md = MODES.includes(mode) ? mode : 'reply';
  const from = m.from || null;
  const fromMe = !!(m.flags && m.flags.fromMe) || _isMe(from, me);
  const seen = new Set();
  const add = (list, e, role) => {
    if (!e || (!_addr(e) && !normName(e.name))) return;
    if (_isMe(e, me)) return;
    const k = recipientKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    list.push(_entry(e, role));
  };
  const to = []; const cc = [];
  if (md === 'reply-all') {
    if (from && !fromMe) add(to, from, 'sender');
    for (const e of (m.to || [])) add(to, e, 'to');
    for (const e of (m.cc || [])) add(cc, e, 'cc');
  } else if (fromMe) {
    for (const e of (m.to || [])) add(to, e, 'to');
  } else if (from) {
    add(to, from, 'sender');
  }
  let selfOnly = false;
  if (opts && opts.selfOnlyFallback === true && md === 'reply' && !to.length && !cc.length) {
    const mine = _selfOnly(m, me);
    if (mine.length) { to.push(...mine); selfOnly = true; }
  }
  const all = to.concat(cc);
  const doms = _domains(me);
  const external = doms.size ? all.filter((e) => e.address && !doms.has(e.address.slice(e.address.lastIndexOf('@') + 1))).length : null;
  const unknownAddress = all.filter((e) => !e.address).length;
  const out = { ok: true, mode: md, to, cc, toCount: to.length, ccCount: cc.length, external, unknownAddress };
  if (md === 'reply-all' && (!m.recipientsKnown || unknownAddress > 0)) { out.ok = false; out.blocked = 'RECIPIENTS_UNKNOWN'; }
  else if (!all.length) { out.ok = false; out.blocked = 'NO_RECIPIENTS'; }
  if (selfOnly) out.selfOnly = true;
  return out;
}

/**
 * compareSets(expected, actual): compare by address when both sides have one, else by normalized display name.
 * Returns the entries (as given) that are missing from `actual` and the ones in `actual` that were not expected.
 */
function compareSets(expected, actual) {
  const exp = (expected || []).filter(Boolean);
  const act = (actual || []).filter(Boolean);
  const matches = (a, b) => {
    const x = _addr(a); const y = _addr(b);
    if (x && y) return x === y;
    const n1 = normName(a.name); const n2 = normName(b.name);
    return !!n1 && n1 === n2;
  };
  const dedupe = (list) => {
    const out = [];
    for (const e of list) if (!out.some((o) => matches(o, e))) out.push(e);
    return out;
  };
  const E = dedupe(exp); const A = dedupe(act);
  const missing = E.filter((e) => !A.some((a) => matches(e, a)));
  const extra = A.filter((a) => !E.some((e) => matches(e, a)));
  return { equal: !missing.length && !extra.length, missing, extra };
}

module.exports = { MODES, computeRecipients, compareSets, recipientKey };
