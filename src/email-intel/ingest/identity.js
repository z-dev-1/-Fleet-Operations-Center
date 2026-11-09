'use strict';
/**
 * email-intel/ingest/identity.js — message and conversation identity (design 2.4, F-03).
 *
 *   conversationKey = 'cv_' + sha256(convId)[:16]       (convId from data-convid)
 *   legacyId        = 'em_' + owa_reader._hash(seed)    (unchanged legacy id, used by Keep/Delete/Draft)
 *   contentHash     = sha256(normalizeForHash(newContent))[:32]
 *   messageKey      = 'mi_' + sha256('item|' + itemId)[:20]            (messageIdSource 'owa-item')
 *                   | 'md_' + sha256(['v2', conv, sender, subject, contentHash])[:20]   ('derived')
 *
 * F-03: NO time value in the base key (time tokens change across scans). A second message with
 * identical text but a genuinely different, trustworthy time (> 2 min apart, both GOOD quality)
 * gets a stable suffixed key; a better-quality re-capture of the same message upgrades the
 * stored time in place and keeps the key.
 */
const crypto = require('crypto');
const { QUALITY_RANK, rank, isGood } = require('../capture/received-time');

const REPEAT_GAP_MS = 2 * 60_000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function conversationKey(convId) { return 'cv_' + sha(String(convId == null ? '' : convId)).slice(0, 16); }
/** Rows without a data-convid: derive from the first 120 chars of the row aria text. */
function conversationKeyFromAria(aria) { return 'cv_' + sha('aria|' + String(aria == null ? '' : aria).slice(0, 120)).slice(0, 16); }

function legacyId(seed) {
  const owa = require('../../scrapers/owa_reader');
  return 'em_' + owa._hash(seed);
}

/** Lowercase, collapse whitespace, strip punctuation runs. Callers pass the segmenter's newContent. */
function normalizeForHash(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function contentHash(text) { return sha(normalizeForHash(text)).slice(0, 32); }

/** normalizeSubject (owa-mailer) then strip leading re:/fw:/fwd: prefixes. */
function normalizeSubject(subject) {
  const owa = require('../../scrapers/owa-mailer');
  let s = owa.normalizeSubject(subject);
  for (let i = 0; i < 6; i++) {
    const t = s.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '');
    if (t === s) break;
    s = t;
  }
  return s.trim();
}

/** senderNorm: the lowercased address when present, else the normalized display name. */
function senderNorm(from) {
  const f = from || {};
  const a = String(f.address || '').trim().toLowerCase();
  if (a) return a;
  return String(f.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function itemKey(itemId) { return 'mi_' + sha('item|' + itemId).slice(0, 20); }
function baseKeyOf({ conversationKey: cv, sender, subject, contentHash: ch }) {
  return 'md_' + sha(['v2', cv, sender, subject, ch].join('|')).slice(0, 20);
}

/**
 * itemIdFrom({ idAttrs, rowAttrs, url, blockCount }) -> string | null
 * Candidate order: block data-itemid / data-item-id / data-msgid; row attributes matching
 * /^data-(item|msg|message)/i; an ItemID= query parameter in the pane URL (only when exactly one block).
 */
function itemIdFrom(o) {
  o = o || {};
  const ia = o.idAttrs || {};
  for (const k of ['data-itemid', 'data-item-id', 'data-msgid']) {
    const v = String(ia[k] || '').trim();
    if (v) return v.slice(0, 200);
  }
  const ra = o.rowAttrs || {};
  for (const k of Object.keys(ra)) {
    if (/^data-(item|msg|message)/i.test(k)) { const v = String(ra[k] || '').trim(); if (v) return v.slice(0, 200); }
  }
  if (o.blockCount === 1 && o.url) {
    const m = /[?&]ItemID=([^&#]+)/i.exec(String(o.url));
    if (m) { try { return decodeURIComponent(m[1]).slice(0, 200); } catch (_) { return m[1].slice(0, 200); } }
  }
  return null;
}

/**
 * findMessage(ledger, key) -> MessageRecord | null (checks aliases too).
 * `ledger` is the messages document { messages, aliasIndex? }.
 */
function findMessage(ledger, key) {
  if (!ledger || !ledger.messages || !key) return null;
  if (ledger.messages[key]) return ledger.messages[key];
  const real = ledger.aliasIndex && ledger.aliasIndex[key];
  return (real && ledger.messages[real]) || null;
}

/**
 * resolveDerivedKey({ baseKey, receivedAt, receivedAtQuality }, ledger) -> key
 * Deterministic across scans (see header). Never re-keys on inferred-* quality.
 */
function resolveDerivedKey(cap, ledger) {
  const existing = findMessage(ledger, cap.baseKey);
  if (!existing) return cap.baseKey;
  const t1 = Date.parse(cap.receivedAt || '');
  const t0 = Date.parse(existing.receivedAt || '');
  if (isGood(cap.receivedAtQuality) && isGood(existing.receivedAtQuality) && Number.isFinite(t1) && Number.isFinite(t0) && Math.abs(t1 - t0) > REPEAT_GAP_MS) {
    const minute = new Date(t1).toISOString().slice(0, 16);
    return 'md_' + sha(cap.baseKey + '|' + minute).slice(0, 20);
  }
  return cap.baseKey;
}

/**
 * resolveMessageKey(cap, ledger) -> { messageKey, messageIdSource, baseKey|null }
 * cap: { keySeed?, itemId, conversationKey, sender, subject, contentHash, receivedAt, receivedAtQuality }
 */
function resolveMessageKey(cap, ledger) {
  // Outlook REST captures (apiTransport) carry a key seed (InternetMessageId, else the REST id); DOM captures never do.
  if (typeof cap.keySeed === 'string' && cap.keySeed) return { messageKey: itemKey(cap.keySeed), messageIdSource: 'owa-item', baseKey: null };
  if (cap.itemId) return { messageKey: itemKey(cap.itemId), messageIdSource: 'owa-item', baseKey: null };
  const baseKey = baseKeyOf({ conversationKey: cap.conversationKey, sender: cap.sender, subject: cap.subject, contentHash: cap.contentHash });
  return { messageKey: resolveDerivedKey({ baseKey, receivedAt: cap.receivedAt, receivedAtQuality: cap.receivedAtQuality }, ledger), messageIdSource: 'derived', baseKey };
}

/**
 * upgradeTime(existing, cap) -> boolean
 * If the new capture's received-time quality outranks the stored one, update time fields in place
 * (the key never changes). Returns true when something changed.
 */
function upgradeTime(existing, cap) {
  if (!existing || !cap) return false;
  if (rank(cap.receivedAtQuality) <= rank(existing.receivedAtQuality)) return false;
  existing.receivedAt = cap.receivedAt || null;
  existing.receivedAtQuality = cap.receivedAtQuality;
  existing.receivedAtPrecision = cap.receivedAtPrecision || null;
  existing.receivedAtRaw = cap.receivedAtRaw || '';
  return true;
}

module.exports = {
  QUALITY_RANK, REPEAT_GAP_MS,
  conversationKey, conversationKeyFromAria, legacyId, normalizeForHash, contentHash, normalizeSubject, senderNorm,
  itemKey, baseKeyOf, itemIdFrom, findMessage, resolveDerivedKey, resolveMessageKey, upgradeTime,
};
