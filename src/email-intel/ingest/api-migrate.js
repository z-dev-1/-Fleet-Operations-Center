'use strict';
/**
 * email-intel/ingest/api-migrate.js — derived (DOM-era) -> real (Outlook REST) record matching (design 6.3).
 * Pure: works on the messages document passed in; no I/O, no logging of content.
 *
 *   remapConversation(doc, cap)            apply doc.convAliasIndex[cap.conversationKey] to the capture
 *   matchDerived(doc, cap, seg, ctx)       -> { key, conversationKey, legacyId, crossConversation, text } | null
 *   planGroup(doc, caps, ctx)              -> { conversationKey, legacyIdOverride } | null   (R4-M3)
 *   recordConvAlias(doc, apiConvKey, { conversationKey, legacyId })
 *
 * Candidates: records with messageIdSource 'derived', the same normalized subject and a sender match (the API
 * address, or the normalized API display name). Score: `time` when both times are GOOD quality and within
 * REPEAT_GAP_MS; `text` = Jaccard similarity of the word sets of the first 2,000 normalized characters.
 *   Pass 1 (same conversationKey): accept `time` or text >= 0.8; R4-M1: otherwise a candidate with text >= 0.5
 *     (several -> the highest text; a tie -> no match, counted ambiguous).
 *   Pass 2 (only when pass 1 found nothing, and only with ctx.lookbackDays): other conversations whose
 *     receivedAt || ingestedAt is within now - (lookbackDays + 2 d) (R4-M2); accept text >= 0.9.
 * planGroup runs pass 2 (no writes) over every capture of one API conversation group BEFORE any record is built,
 * so one alias applies to the whole group and a thread never splits across two keys (R4-M3).
 */
const identity = require('./identity');
const { segment } = require('./segmenter');
const { isGood } = require('../capture/received-time');

const DAY = 86_400_000;
const CONV_ALIAS_MAX = 2_000;
const PASS1_TEXT = 0.8;
const PASS1_UNIQUE_TEXT = 0.5;
const PASS2_TEXT = 0.9;

function _words(text) {
  const s = identity.normalizeForHash(text).slice(0, 2000);
  return new Set(s.split(' ').filter(Boolean));
}
function _jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function remapConversation(doc, cap) {
  const a = doc && doc.convAliasIndex && cap ? doc.convAliasIndex[cap.conversationKey] : null;
  if (!a || typeof a.conversationKey !== 'string') return false;
  cap.conversationKey = a.conversationKey;
  if (typeof a.legacyId === 'string' && a.legacyId) cap.legacyIdOverride = a.legacyId;
  return true;
}

function recordConvAlias(doc, apiConvKey, target) {
  if (!doc || !apiConvKey || !target || typeof target.conversationKey !== 'string' || target.conversationKey === apiConvKey) return false;
  const idx = doc.convAliasIndex && typeof doc.convAliasIndex === 'object' ? doc.convAliasIndex : (doc.convAliasIndex = {});
  if (Object.prototype.hasOwnProperty.call(idx, apiConvKey)) delete idx[apiConvKey];
  idx[apiConvKey] = { conversationKey: target.conversationKey, legacyId: typeof target.legacyId === 'string' ? target.legacyId : null };
  const keys = Object.keys(idx);
  for (let i = 0; i < keys.length - CONV_ALIAS_MAX; i++) delete idx[keys[i]];
  return true;
}

function _senderMatches(rec, cap) {
  const s = identity.senderNorm(rec.from);
  if (!s) return false;
  const addr = String((cap.from && cap.from.address) || '').trim().toLowerCase();
  const name = identity.senderNorm({ name: cap.from && cap.from.name });
  return (!!addr && s === addr) || (!!name && s === name);
}

function _score(rec, cap, words) {
  const t1 = Date.parse(cap.receivedAt || '');
  const t0 = Date.parse(rec.receivedAt || '');
  const time = isGood(cap.receivedAtQuality) && isGood(rec.receivedAtQuality) && Number.isFinite(t1) && Number.isFinite(t0) && Math.abs(t1 - t0) <= identity.REPEAT_GAP_MS;
  const text = _jaccard(words, _words((rec.body && rec.body.newContent) || ''));
  return { rec, time, text };
}

function _best(list, stats) {
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => b.text - a.text);
  if (sorted.length > 1 && sorted[0].text === sorted[1].text && !(sorted[0].time && !sorted[1].time)) {
    if (stats) stats.ambiguous = (stats.ambiguous || 0) + 1;
    return null;
  }
  return sorted[0];
}

function _candidates(doc, cap, subjectNorm) {
  const out = [];
  for (const k of Object.keys((doc && doc.messages) || {})) {
    const r = doc.messages[k];
    if (!r || r.messageIdSource !== 'derived') continue;
    if (identity.normalizeSubject(r.subject) !== subjectNorm) continue;
    if (!_senderMatches(r, cap)) continue;
    out.push(r);
  }
  return out;
}

function _pass1(cands, cap, words, stats) {
  const scored = cands.filter((r) => r.conversationKey === cap.conversationKey).map((r) => _score(r, cap, words));
  const strong = scored.filter((s) => s.time || s.text >= PASS1_TEXT);
  if (strong.length) return _best(strong, stats);
  return _best(scored.filter((s) => s.text >= PASS1_UNIQUE_TEXT), stats);           // R4-M1 uniqueness rule
}

function _pass2(cands, cap, words, ctx, stats) {
  const c = ctx || {};
  if (!Number.isFinite(c.lookbackDays)) return null;                                  // R4-M2: no window -> no pass 2
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const from = now - (c.lookbackDays + 2) * DAY;
  const scored = cands.filter((r) => {
    if (r.conversationKey === cap.conversationKey) return false;
    const t = Date.parse(r.receivedAt || '') || Date.parse(r.ingestedAt || '') || 0;
    return t >= from;
  }).map((r) => _score(r, cap, words)).filter((s) => s.text >= PASS2_TEXT);
  return _best(scored, stats);
}

/** seg: the segmenter result of cap.bodyText (buildRecord already has it). */
function matchDerived(doc, cap, seg, ctx) {
  if (!doc || !cap) return null;
  const subjectNorm = identity.normalizeSubject(cap.subject);
  const cands = _candidates(doc, cap, subjectNorm);
  if (!cands.length) return null;
  const words = _words((seg && seg.newContent) || '');
  const stats = ctx && ctx.stats;
  const p1 = _pass1(cands, cap, words, stats);
  if (p1) return { key: p1.rec.messageKey, conversationKey: p1.rec.conversationKey, legacyId: p1.rec.legacyId, crossConversation: false, text: p1.text };
  const p2 = _pass2(cands, cap, words, ctx, stats);
  if (p2) return { key: p2.rec.messageKey, conversationKey: p2.rec.conversationKey, legacyId: p2.rec.legacyId, crossConversation: true, text: p2.text };
  return null;
}

/**
 * planGroup(doc, caps, ctx) -> { conversationKey, legacyIdOverride } | null. No writes. The existing alias of the
 * group's API conversation wins; otherwise the first accepted cross-conversation match of any capture applies to the
 * whole group. Captures that match different old conversations -> null (ambiguous).
 */
function planGroup(doc, caps, ctx) {
  const list = (Array.isArray(caps) ? caps : []).filter((c) => c && c.source === 'api');
  if (!list.length) return null;
  const apiKey = list[0].conversationKey;
  const al = doc && doc.convAliasIndex ? doc.convAliasIndex[apiKey] : null;
  if (al && typeof al.conversationKey === 'string') return { conversationKey: al.conversationKey, legacyIdOverride: al.legacyId || null };
  const c = ctx || {};
  let hit = null;
  for (const cap of list) {
    if (typeof cap.keySeed === 'string' && identity.findMessage(doc, identity.itemKey(cap.keySeed))) continue;   // already migrated
    const subjectNorm = identity.normalizeSubject(cap.subject);
    const cands = _candidates(doc, cap, subjectNorm);
    if (!cands.length) continue;
    const seg = segment(cap.bodyText, { subject: cap.subject, banners: c.banners });
    const words = _words(seg.newContent);
    if (_pass1(cands, cap, words, null)) continue;                                    // same conversation: no alias needed
    const p2 = _pass2(cands, cap, words, c, c.stats);
    if (!p2) continue;
    if (!hit) { hit = p2; continue; }
    if (hit.rec.conversationKey !== p2.rec.conversationKey) {
      if (c.stats) c.stats.ambiguous = (c.stats.ambiguous || 0) + 1;
      return null;
    }
  }
  return hit ? { conversationKey: hit.rec.conversationKey, legacyIdOverride: hit.rec.legacyId || null } : null;
}

module.exports = { remapConversation, matchDerived, planGroup, recordConvAlias, CONV_ALIAS_MAX };
