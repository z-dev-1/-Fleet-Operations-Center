'use strict';
/**
 * email-intel/ingest/ledger.js — the message event ledger (design 2.8, F2-07).
 *
 *   emptyDoc() -> { version:1, messages:{}, byConv:{}, aliasIndex:{}, bytesEstimate:0 }
 *   buildRecord(capture, doc, ctx) -> { record, created, upgraded }      identity + segmentation, no I/O
 *   upsert(doc, record) -> { created }                                     mutates doc, keeps the header estimate
 *   conversation(doc, conversationKey) -> MessageRecord[] (oldest first)
 *   applyRetention(doc, opts) -> { evicted, trimmed, bytes }              count/age retention + the byte cap
 *
 * Memory bound (F2-07): `bytesEstimate` is a header estimate maintained on every change. Above
 * MAX_MESSAGES_BYTES the oldest unpinned, non-pending messages are evicted until the estimate is at
 * 75% of the cap; bodies of non-pending messages older than 7 days are trimmed to 2,000 characters.
 * Pinned messages (open actions / staged items) and pending-analysis messages are NEVER evicted;
 * pending messages are also never body-trimmed (their text is still needed).
 *
 * Only the NEWEST content is stored (STORED_BODY_CAP); the full raw text is never persisted.
 */
const crypto = require('crypto');
const C = require('../constants');
const identity = require('./identity');
const { segment, unitsIn } = require('./segmenter');
const untrusted = require('../untrusted');

function emptyDoc() { return { version: C.STORE_VERSION, messages: {}, byConv: {}, aliasIndex: {}, bytesEstimate: 0 }; }

/** Make sure a loaded document has every container (older / minimal documents are tolerated). */
function ensureDoc(doc) {
  if (!doc.messages || typeof doc.messages !== 'object') doc.messages = {};
  if (!doc.byConv || typeof doc.byConv !== 'object') doc.byConv = {};
  if (!doc.aliasIndex || typeof doc.aliasIndex !== 'object') doc.aliasIndex = {};
  if (!Number.isFinite(doc.bytesEstimate)) doc.bytesEstimate = recomputeBytes(doc);
  return doc;
}

const isPending = (rec) => !!rec && !!rec.analysis && /^pending/.test(String(rec.analysis.status || ''));
const timeOf = (rec) => Date.parse(rec.receivedAt || '') || Date.parse(rec.ingestedAt || '') || 0;

/** Structural size estimate (characters ~ bytes). Cheap, monotone in what we store. */
function estimateRecordBytes(rec) {
  if (!rec) return 0;
  const b = rec.body || {};
  let n = 700;
  n += String(b.newContent || '').length;
  n += String(rec.subject || '').length + String((rec.from && (rec.from.name || '')) || '').length + 60;
  n += 90 * ((rec.to || []).length + (rec.cc || []).length);
  n += 220 * (rec.attachments || []).length;
  n += 40 * (b.segments || []).length;
  if (rec.analysis && rec.analysis.result) n += 800;
  return n;
}
function recomputeBytes(doc) {
  let n = 0;
  for (const k of Object.keys(doc.messages || {})) n += estimateRecordBytes(doc.messages[k]);
  return n;
}

function _recipientSet(list) { return (list || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean); }

function _isFromMe(from, me) {
  if (!me || !from) return false;
  const addrs = _recipientSet(me.addresses);
  const names = _recipientSet(me.names);
  const a = String(from.address || '').toLowerCase();
  const n = String(from.name || '').trim().toLowerCase();
  return !!((a && addrs.includes(a)) || (n && names.includes(n)));
}
const AUTOMATED_RE = /(^|[._-])(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?|alerts?)([._@-]|$)/i;

function _quotedHash(segments) {
  const text = segments.filter((s) => s.kind === 'quoted').map((s) => s.text).join('\n');
  if (!text.trim()) return '';
  return crypto.createHash('sha256').update(identity.normalizeForHash(text)).digest('hex').slice(0, 16);
}

/**
 * buildRecord(capture, doc, ctx) -> { record, created, upgraded } | null (stub captures yield null)
 * ctx: { me, banners, scanId, now, threadContextIncomplete }
 * When the message is already in the ledger (same key) the stored record is returned and its
 * received time is upgraded in place if the new capture has better quality (key never changes).
 */
function buildRecord(cap, doc, ctx) {
  ctx = ctx || {};
  if (!cap || cap.stub) return null;
  ensureDoc(doc);
  const seg = segment(cap.bodyText, { subject: cap.subject, banners: ctx.banners });
  const contentHash = identity.contentHash(seg.newContent);
  const sender = identity.senderNorm(cap.from);
  const subjectNorm = identity.normalizeSubject(cap.subject);
  const resolved = identity.resolveMessageKey({
    itemId: cap.itemId, conversationKey: cap.conversationKey, sender, subject: subjectNorm, contentHash,
    receivedAt: cap.receivedAt, receivedAtQuality: cap.receivedAtQuality,
  }, doc);
  const existing = identity.findMessage(doc, resolved.messageKey);
  if (existing) {
    const upgraded = identity.upgradeTime(existing, cap);
    if (upgraded) doc.byConv[existing.conversationKey] = _resort(doc, existing.conversationKey);
    return { record: existing, created: false, upgraded };
  }
  const aliases = [];
  if (resolved.messageIdSource === 'owa-item') {
    // A message first seen without an item id: link the derived key as an alias (fact dedupe is content-keyed).
    const derived = identity.baseKeyOf({ conversationKey: cap.conversationKey, sender, subject: subjectNorm, contentHash });
    if (doc.messages[derived]) aliases.push(derived);
  }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const stored = seg.newContent.slice(0, C.STORED_BODY_CAP);
  // Unit ids that occur only past the stored cap: the text is not kept, so analysis reports them as
  // unprocessed (design 3.4 / AC-F: a unit mention is never silently lost).
  let beyondCap = [];
  if (seg.newContent.length > C.STORED_BODY_CAP) {
    const kept = unitsIn(stored);
    const cut = seg.newContent.lastIndexOf(' ', C.STORED_BODY_CAP);
    beyondCap = Array.from(unitsIn(seg.newContent.slice(cut > 0 ? cut : C.STORED_BODY_CAP))).filter((u) => !kept.has(u)).slice(0, 20);
  }
  const dl = untrusted.detect(seg.newContent);
  const record = {
    messageKey: resolved.messageKey, messageIdSource: resolved.messageIdSource,
    itemId: cap.itemId || undefined, aliases: aliases.length ? aliases : undefined,
    conversationKey: cap.conversationKey, convIdRaw: cap.convIdRaw || '', convIdSource: cap.convIdSource || 'owa',
    legacyId: identity.legacyId(cap.legacySeed || cap.convIdRaw || ''),
    folder: cap.folder || 'Inbox', foldersSeen: [cap.folder || 'Inbox'],
    from: cap.from, to: cap.to || [], cc: cap.cc || [], toCount: cap.toCount || 0, ccCount: cap.ccCount || 0, recipientsKnown: !!cap.recipientsKnown,
    subject: cap.subject, receivedAt: cap.receivedAt || null, receivedAtQuality: cap.receivedAtQuality || 'unknown',
    receivedAtPrecision: cap.receivedAtPrecision || null, receivedAtRaw: cap.receivedAtRaw || '',
    body: {
      newContent: stored, fullChars: cap.textLen || (cap.bodyText || '').length, newChars: seg.newChars,
      status: cap.bodyStatus, source: cap.bodySource || 'pane', truncatedAt: cap.truncatedAt,
      segments: seg.segments.map((s) => ({ kind: s.kind, chars: s.chars })),
      inlineReply: !!seg.flags.inlineReply, stripSkippedEmpty: !!seg.flags.stripSkippedEmpty,
      quotedHash: _quotedHash(seg.segments), unitsOnlyInQuoted: seg.unitsOnlyInQuoted.slice(0, 20),
      unitsBeyondCap: beyondCap.length ? beyondCap : undefined,
    },
    contentHash,
    attachments: cap.attachments || [],
    flags: {
      unread: !!(cap.flags && cap.flags.unread), fromMe: _isFromMe(cap.from, ctx.me),
      forwarded: !!seg.flags.forwarded || /^\s*(fw|fwd)\s*:/i.test(String(cap.subject || '')),
      automated: AUTOMATED_RE.test(String((cap.from && cap.from.address) || '')),
      injectionSuspected: !!dl.suspicious, threadContextIncomplete: !!ctx.threadContextIncomplete,
    },
    ingestedAt: new Date(now).toISOString(), scanId: ctx.scanId || null,
    analysis: { status: 'pending', attempts: 0, promptVersion: null, analyzedAt: null, result: null, validation: null },
  };
  return { record, created: true, upgraded: false };
}

function _sortKey(rec) { return [timeOf(rec), Date.parse(rec.ingestedAt || '') || 0, rec.messageKey]; }
function _cmp(a, b) {
  const x = _sortKey(a); const y = _sortKey(b);
  for (let i = 0; i < 3; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; }
  return 0;
}
function _resort(doc, convKey) {
  return (doc.byConv[convKey] || []).map((k) => doc.messages[k]).filter(Boolean).sort(_cmp).map((r) => r.messageKey);
}

/** upsert(doc, record): insert a NEW record (an existing key is a no-op) and keep the header estimate. */
function upsert(doc, record) {
  ensureDoc(doc);
  if (doc.messages[record.messageKey]) return { created: false };
  // A record that replaces an alias (derived key) inherits its analysis state and takes its place.
  for (const al of record.aliases || []) {
    const old = doc.messages[al];
    if (!old || al === record.messageKey) continue;
    record.analysis = old.analysis || record.analysis;
    record.foldersSeen = Array.from(new Set([].concat(old.foldersSeen || [], record.foldersSeen || [])));
    _remove(doc, al);
    doc.aliasIndex[al] = record.messageKey;
  }
  doc.messages[record.messageKey] = record;
  const list = doc.byConv[record.conversationKey] || (doc.byConv[record.conversationKey] = []);
  list.push(record.messageKey);
  doc.byConv[record.conversationKey] = _resort(doc, record.conversationKey);
  doc.bytesEstimate += estimateRecordBytes(record);
  return { created: true };
}

function _remove(doc, key) {
  const rec = doc.messages[key];
  if (!rec) return;
  doc.bytesEstimate = Math.max(0, doc.bytesEstimate - estimateRecordBytes(rec));
  delete doc.messages[key];
  const list = (doc.byConv[rec.conversationKey] || []).filter((k) => k !== key);
  if (list.length) doc.byConv[rec.conversationKey] = list; else delete doc.byConv[rec.conversationKey];
}

/** Conversation view: the ledger's records for one conversation, oldest first. */
function conversation(doc, conversationKey) {
  return ((doc && doc.byConv && doc.byConv[conversationKey]) || []).map((k) => doc.messages[k]).filter(Boolean);
}

function _isPinned(rec, pinned) { return !!rec.pinned || (pinned && pinned.has(rec.messageKey)); }

/** Trim bodies of non-pending messages older than 7 days to STORED_BODY_CAP_OLD characters. */
function trimOldBodies(doc, now) {
  let trimmed = 0;
  for (const k of Object.keys(doc.messages)) {
    const rec = doc.messages[k];
    if (isPending(rec) || !rec.body) continue;
    const t = timeOf(rec);
    if (!t || now - t < C.OLD_MESSAGE_AGE_MS) continue;
    const text = String(rec.body.newContent || '');
    if (text.length <= C.STORED_BODY_CAP_OLD) continue;
    doc.bytesEstimate = Math.max(0, doc.bytesEstimate - (text.length - C.STORED_BODY_CAP_OLD));
    rec.body.newContent = text.slice(0, C.STORED_BODY_CAP_OLD);
    rec.body.trimmed = true;
    trimmed++;
  }
  return trimmed;
}

function _evictable(doc, pinned) {
  return Object.keys(doc.messages).map((k) => doc.messages[k]).filter((r) => !_isPinned(r, pinned) && !isPending(r)).sort(_cmp);
}

/**
 * applyRetention(doc, { now, pinned:Set<messageKey> }) -> { evicted, trimmed, bytes }
 * 1. trim old non-pending bodies; 2. drop unpinned, non-pending messages past the age/count limits;
 * 3. over the byte cap: evict the oldest unpinned, non-pending messages down to 75% of the cap.
 */
function applyRetention(doc, opts) {
  opts = opts || {};
  ensureDoc(doc);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cap = Number.isFinite(opts.maxBytes) ? opts.maxBytes : C.MAX_MESSAGES_BYTES;
  const out = { evicted: 0, trimmed: trimOldBodies(doc, now), bytes: 0 };
  for (const rec of _evictable(doc, opts.pinned)) {
    const t = timeOf(rec);
    if (t && now - t > C.MESSAGE_RETENTION_MS) { _remove(doc, rec.messageKey); out.evicted++; }
  }
  let count = Object.keys(doc.messages).length;
  if (count > C.MAX_MESSAGES) {
    for (const rec of _evictable(doc, opts.pinned)) {
      if (count <= C.MAX_MESSAGES) break;
      _remove(doc, rec.messageKey); out.evicted++; count--;
    }
  }
  if (doc.bytesEstimate > cap) {
    const target = Math.floor(cap * C.MESSAGES_EVICT_TARGET_RATIO);
    for (const rec of _evictable(doc, opts.pinned)) {
      if (doc.bytesEstimate <= target) break;
      _remove(doc, rec.messageKey); out.evicted++;
    }
  }
  out.bytes = doc.bytesEstimate;
  return out;
}

module.exports = { emptyDoc, ensureDoc, estimateRecordBytes, recomputeBytes, buildRecord, upsert, conversation, trimOldBodies, applyRetention, isPending };
