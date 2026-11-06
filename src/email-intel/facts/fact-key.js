'use strict';
/**
 * email-intel/facts/fact-key.js — fact keys and supersede groups (design 4.2; R3.6, F-07, AC-13).
 *
 *   keysOf(fact, unit)  -> { valueKey, groupKey, factKey, itemNorm, item, marker }
 *     valueKey = sha1(unit|kind|valueTuple).slice(0,20)   item-free; its first 8 hex are the timeline marker [em:xxxxxxxx]
 *     groupKey = unit|kind
 *     factKey  = sha1(valueKey|normItem(item)).slice(0,20) ledger / staged id only, never a dedupe decision
 *   classify(fact, unit, entries) -> { kind:'new'|'duplicate'|'supersede'|'ambiguous-item', entry? }
 *     entries: ledger entries of the same groupKey (any state; only applied / pending ones are considered)
 *
 * Message identity is not part of any key, so forwards, repeated replies and rescans collapse (case H).
 * Item text is compared fuzzily (item-match.js), so "turbo" and "turbocharger" are the same part.
 */
const crypto = require('crypto');
const im = require('./item-match');

// kinds whose facts carry an item; blocker falls back to the value when no item is given
const HAS_ITEM = new Set(['parts_availability', 'parts_eta', 'approval_status', 'blocker']);
// kinds without a supersede group (every distinct value is its own fact)
const NO_SUPERSEDE = new Set(['vendor_status']);

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const _s = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** The item-free value tuple of a fact (design 4.2 table). */
function valueTuple(f) {
  const amt = f.amount && Number.isFinite(f.amount.value) ? String(f.amount.value) : '';
  switch (f.kind) {
    case 'parts_eta': return f.date ? _s(f.date) : _s(f.state);
    case 'estimated_completion': return _s(f.date) + '|' + _s(f.state);
    case 'approval_status': return _s(f.state) + '|' + amt;
    case 'vendor_status': return _s(f.state) + '|' + _s(f.date);
    case 'transportation': return _s(f.state) + '|' + _s(f.date);
    default: return _s(f.state);           // repair_stage, parts_availability, pickup_readiness, blocker
  }
}

/** The item used for fuzzy matching (null for kinds without an item). */
function itemOf(f) {
  if (!HAS_ITEM.has(f.kind)) return null;
  if (f.kind === 'blocker') return f.item || f.value || null;
  return f.item || null;
}

function keysOf(fact, unit) {
  const u = String(unit == null ? '' : unit).trim().toLowerCase();
  const valueKey = sha1(u + '|' + fact.kind + '|' + valueTuple(fact)).slice(0, 20);
  const item = itemOf(fact);
  const itemNorm = im.normItem(item);
  return {
    valueKey, groupKey: u + '|' + fact.kind, factKey: sha1(valueKey + '|' + itemNorm).slice(0, 20),
    item, itemNorm, marker: markerOf(valueKey),
  };
}

function markerOf(valueKey) { return '[em:' + String(valueKey).slice(0, 8) + ']'; }

const ACTIVE = new Set(['applied', 'pending']);

/** Item comparison for a kind: kinds without an item always 'match'. */
function itemRelation(kind, a, b) {
  if (!HAS_ITEM.has(kind)) return 'match';
  return im.itemsMatch(a, b);
}

/**
 * classify(fact, unit, entries) — the 4.2 rules inside one groupKey.
 *  duplicate      an applied/pending entry has the same valueKey and the items are not 'differ'
 *                 (item unknown on either side: only when exactly one entry has that valueKey)
 *  supersede      an applied entry whose item matches (or the kind has no item) has a different valueKey
 *                 (item unknown on either side: only when the group has exactly one applied entry)
 *  ambiguous-item the unknown-item cases with more than one candidate (never guess which part)
 *  new            otherwise (including the same value for a different part)
 */
function classify(fact, unit, entries) {
  const k = keysOf(fact, unit);
  const group = (entries || []).filter((e) => e && e.groupKey === k.groupKey && ACTIVE.has(e.state));
  const sameValue = group.filter((e) => e.valueKey === k.valueKey);
  for (const e of sameValue) {
    const rel = itemRelation(fact.kind, k.item, e.item);
    if (rel === 'match') return { kind: 'duplicate', entry: e, keys: k };
    if (rel === 'unknown') {
      if (sameValue.length === 1) return { kind: 'duplicate', entry: e, keys: k };
      return { kind: 'ambiguous-item', keys: k };
    }
  }
  if (NO_SUPERSEDE.has(fact.kind)) return { kind: 'new', keys: k };
  const applied = group.filter((e) => e.state === 'applied' && !e.supersededBy && e.valueKey !== k.valueKey);
  const matches = applied.filter((e) => itemRelation(fact.kind, k.item, e.item) === 'match');
  const unknown = applied.filter((e) => itemRelation(fact.kind, k.item, e.item) === 'unknown');
  if (matches.length) {
    const newest = matches.slice().sort((a, b) => String(b.observedAt || '').localeCompare(String(a.observedAt || '')))[0];
    return { kind: 'supersede', entry: newest, keys: k };
  }
  if (unknown.length) {
    const allApplied = group.filter((e) => e.state === 'applied' && !e.supersededBy);
    if (allApplied.length === 1) return { kind: 'supersede', entry: unknown[0], keys: k };
    return { kind: 'ambiguous-item', keys: k };
  }
  return { kind: 'new', keys: k };
}

module.exports = { HAS_ITEM, NO_SUPERSEDE, valueTuple, itemOf, keysOf, markerOf, itemRelation, classify, sha1 };
