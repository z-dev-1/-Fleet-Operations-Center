'use strict';
/**
 * email-intel/facts/staged.js — staged facts awaiting review (design 4.5, 1.2; R3.4, R3.7, F-23).
 *
 * Pure document operations (doc = emailIntelStaged { version, items:{stagedId:StagedItem}, expiredCount, overCap })
 * plus store-level wrappers that go through stores.update (synchronous RMW):
 *
 *   stagedIdOf(factKey, messageKey)  'st_' + sha1(factKey|messageKey).slice(0,16)
 *   stage(doc, input) -> { item, created }       upsert by stagedId; repeat sightings update lastSeenAt / corroboratedBy
 *   supersedeOlder(doc, item, now)               a newer fact in the same groupKey supersedes older open items
 *   close(doc, stagedId, state, resolution, now) decided / superseded / resolved-by-canonical
 *   applyCaps(doc, now) -> { expired, pruned, overCap }   only timeline-disabled and low-confidence items expire
 *   list(doc, { state, offset, limit }) / openCount(doc) / openMessageKeys(doc)
 *   stageFact(input) / closeItem(...) / load()   (store wrappers)
 *
 * Decisions are never automatic: approve and reject run only through the confirmation token executors
 * (executors.js). Everything here is code-built text; the only email-derived strings are the validated
 * fact value and evidence quote (both already length-capped and secret-screened by the validator).
 */
const crypto = require('crypto');
const stores = require('../stores');
const im = require('./item-match');
const fk = require('./fact-key');

const DAY = 86_400_000;
const OPEN_CAP = 500;
const RESOLVED_TTL_MS = 30 * DAY;
const EXPIRE_AFTER_MS = 30 * DAY;
const CORROBORATION_MAX = 10;

const REASONS = Object.freeze([
  'low-confidence', 'invalid-confidence', 'stale', 'conflict-canonical', 'conflict-ready', 'uncertain-assertion', 'scope-unknown',
  'freshness-unprovable', 'partial-content', 'unprocessed-window', 'spend-related', 'roster-mismatch', 'ambiguous-order', 'ambiguous-item',
  'possible-duplicate', 'timeline-disabled', 'timeline-filtered', 'standby-host', 'ai-unavailable', 'attachment-conflict', 'write-failed',
]);
// Open items with these reasons are never evicted or expired (F-23).
const PROTECTED = Object.freeze(['conflict-canonical', 'conflict-ready', 'spend-related', 'uncertain-assertion', 'attachment-conflict', 'possible-duplicate', 'ambiguous-item']);
// Only these may expire (by cap, oldest first, timeline-disabled before low-confidence; or after 30 days).
const EXPIRABLE = Object.freeze(['timeline-disabled', 'low-confidence']);

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const nowIso = (now) => new Date(Number.isFinite(now) ? now : Date.now()).toISOString();

function stagedIdOf(factKey, messageKey) { return 'st_' + sha1(String(factKey) + '|' + String(messageKey)).slice(0, 16); }

function ensureDoc(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (!d.items || typeof d.items !== 'object') d.items = {};
  if (!Number.isFinite(d.expiredCount)) d.expiredCount = 0;
  if (d.version == null) d.version = 1;
  return d;
}

function _senderName(msg) {
  const n = String((msg && msg.from && msg.from.name) || '').replace(/\s+/g, ' ').trim();
  return n && !n.includes('@') ? n.slice(0, 30) : '';
}

/**
 * stage(doc, input) — upsert one staged item.
 * input: { fact|null, unit, keys (fact-key.keysOf) | null, msg, reason, detail, canonicalSnapshot, proposedLine, now, source }
 */
function stage(doc, input) {
  const d = ensureDoc(doc);
  const i = input || {};
  const msg = i.msg || {};
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const f = i.fact || null;
  const keys = i.keys || (f ? fk.keysOf(f, i.unit) : { factKey: sha1('mention|' + String(i.unit).toLowerCase() + '|' + i.reason).slice(0, 20), groupKey: String(i.unit).toLowerCase() + '|mention', valueKey: null });
  const stagedId = stagedIdOf(keys.factKey, msg.messageKey || '');
  const reason = REASONS.includes(i.reason) ? i.reason : 'uncertain-assertion';
  const existing = d.items[stagedId];
  if (existing) {
    existing.lastSeenAt = nowIso(now);
    if (existing.state === 'open') {
      existing.reason = reason;
      existing.detail = String(i.detail || '').slice(0, 160);
      if (i.proposedLine) existing.proposedLine = i.proposedLine;
      if (i.canonicalSnapshot) existing.canonicalSnapshot = i.canonicalSnapshot;
      if (f) existing.fact = _factView(f);
    }
    return { item: existing, created: false };
  }
  const item = {
    stagedId, factKey: keys.factKey, groupKey: keys.groupKey, valueKey: keys.valueKey || null, unit: String(i.unit || ''),
    fact: f ? _factView(f) : null,
    provenance: {
      messageKey: msg.messageKey || null, conversationKey: msg.conversationKey || null, legacyId: msg.legacyId || null, source: i.source || 'email',
      senderName: _senderName(msg), receivedAt: msg.receivedAt || null, receivedAtQuality: msg.receivedAtQuality || 'unknown',
      bodyStatus: (msg.body && msg.body.status) || 'unknown',
    },
    reason, detail: String(i.detail || '').slice(0, 160), canonicalSnapshot: i.canonicalSnapshot || null,
    state: 'open', corroboratedBy: [], createdAt: nowIso(now), lastSeenAt: nowIso(now), proposedLine: i.proposedLine || '',
  };
  d.items[stagedId] = item;
  if (f) supersedeOlder(d, item, now);
  return { item, created: true };
}

function _factView(f) {
  return {
    kind: f.kind, item: f.item || null, value: f.value, state: f.state, date: f.date || null, amount: f.amount || null,
    assertion: f.assertion, evidenceQuote: String(f.evidence || '').slice(0, 200),
    confidenceEffective: Number.isFinite(f.effectiveConfidence) ? f.effectiveConfidence : 0, caps: Array.isArray(f.caps) ? f.caps.slice(0, 12) : [],
  };
}

/** A newer fact in the same groupKey (items not 'differ') marks older open items superseded. */
function supersedeOlder(doc, item, now) {
  const t = Date.parse((item.provenance && item.provenance.receivedAt) || '');
  if (!Number.isFinite(t) || !item.fact) return 0;
  let n = 0;
  for (const other of Object.values(doc.items)) {
    if (other.stagedId === item.stagedId || other.state !== 'open' || other.groupKey !== item.groupKey || !other.fact) continue;
    if (other.valueKey === item.valueKey) continue;
    if (fk.itemRelation(item.fact.kind, fk.itemOf(item.fact), fk.itemOf(other.fact)) === 'differ') continue;
    const ot = Date.parse((other.provenance && other.provenance.receivedAt) || '');
    if (!Number.isFinite(ot) || ot >= t) continue;
    other.state = 'superseded'; other.resolution = 'newer-fact'; other.supersededBy = item.stagedId; other.decidedAt = nowIso(now);
    n++;
  }
  return n;
}

/** Add a corroborating message to an open item with the same fact key (repeat sightings never duplicate). */
function corroborate(doc, factKey, messageKey) {
  const d = ensureDoc(doc);
  let n = 0;
  for (const it of Object.values(d.items)) {
    if (it.factKey !== factKey || it.state !== 'open' || !messageKey) continue;
    if (it.provenance.messageKey === messageKey || it.corroboratedBy.includes(messageKey)) continue;
    if (it.corroboratedBy.length < CORROBORATION_MAX) { it.corroboratedBy.push(messageKey); n++; }
  }
  return n;
}

function close(doc, stagedId, state, resolution, now) {
  const d = ensureDoc(doc);
  const it = d.items[stagedId];
  if (!it) return null;
  it.state = state; it.decidedAt = nowIso(now);
  if (resolution) it.resolution = resolution;
  if (state === 'approved' || state === 'rejected') it.decidedBy = 'user';
  return it;
}

/**
 * applyCaps(doc, now) — F-23. Resolved items older than 30 days are pruned. Expirable open items older than
 * 30 days expire. Over 500 open items: timeline-disabled expire first, then low-confidence, oldest first.
 * If only protected (or other non-expirable) reasons remain over the cap, the cap is exceeded and overCap is set.
 */
function applyCaps(doc, now) {
  const d = ensureDoc(doc);
  const t = Number.isFinite(now) ? now : Date.now();
  let expired = 0; let pruned = 0;
  for (const [id, it] of Object.entries(d.items)) {
    const decided = Date.parse(it.decidedAt || it.lastSeenAt || it.createdAt || '') || 0;
    if (it.state !== 'open' && t - decided > RESOLVED_TTL_MS) { delete d.items[id]; pruned++; continue; }
    if (it.state === 'open' && EXPIRABLE.includes(it.reason) && t - (Date.parse(it.createdAt || '') || t) > EXPIRE_AFTER_MS) {
      it.state = 'expired'; it.decidedAt = nowIso(t); it.resolution = 'age'; expired++;
    }
  }
  let open = Object.values(d.items).filter((x) => x.state === 'open');
  if (open.length > OPEN_CAP) {
    for (const reason of EXPIRABLE) {
      const cands = open.filter((x) => x.reason === reason).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const it of cands) {
        if (open.length <= OPEN_CAP) break;
        it.state = 'expired'; it.decidedAt = nowIso(t); it.resolution = 'cap'; expired++;
        open = open.filter((x) => x !== it);
      }
    }
  }
  d.expiredCount = (d.expiredCount || 0) + expired;
  d.overCap = open.length > OPEN_CAP;
  return { expired, pruned, overCap: d.overCap };
}

function openCount(doc) { return Object.values(ensureDoc(doc).items).filter((x) => x.state === 'open').length; }
function openMessageKeys(doc) {
  const s = new Set();
  for (const it of Object.values(ensureDoc(doc).items)) if (it.state === 'open' && it.provenance && it.provenance.messageKey) s.add(it.provenance.messageKey);
  return s;
}

function list(doc, o) {
  const opts = o || {};
  const all = Object.values(ensureDoc(doc).items)
    .filter((x) => (opts.state && opts.state !== 'all' ? x.state === opts.state : true))
    .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const limit = Number.isInteger(opts.limit) ? opts.limit : 50;
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

// ── store wrappers ────────────────────────────────────────────────────────────
function load() { return ensureDoc(stores.load('staged')); }

/** stageFact(input) -> { ok, item?, created?, code? } */
function stageFact(input) {
  let res = null;
  const r = stores.update('staged', (doc) => { res = stage(doc, input); return doc; });
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, item: res.item, created: res.created };
}

function closeItem(stagedId, state, resolution, now) {
  let it = null;
  const r = stores.update('staged', (doc) => { it = close(doc, stagedId, state, resolution, now); return doc; });
  return r.ok ? { ok: true, item: it } : { ok: false, code: r.code };
}

module.exports = {
  REASONS, PROTECTED, EXPIRABLE, OPEN_CAP, stagedIdOf, ensureDoc, stage, supersedeOlder, corroborate, close, applyCaps,
  openCount, openMessageKeys, list, load, stageFact, closeItem, itemsMatch: im.itemsMatch,
};
