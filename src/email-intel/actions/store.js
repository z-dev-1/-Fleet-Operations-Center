'use strict';
/**
 * email-intel/actions/store.js — the emailIntelActions document (design 1.2, 5.3, 5.6, 5.7; R4.10, R4.12, AC-4).
 *
 * doc = { version, items:{[actionId]:ActionItem}, questions:{[questionId]:QuestionState}, bootstrapped?, overCap? }
 *
 * Pure document operations:
 *   mergeConversation(doc, conversationKey, derived, { now, questions }) -> { created[], escalated[], resolved[], changed }
 *       stable ids: a rescan updates fields and lastChangedAt, never duplicates; user state (dismissed, snoozed,
 *       done-user) is keyed by actionId and survives rescans until a material change (an escalation of the tier,
 *       or for FYI items a newer latest message); items no longer derived close as done-auto (or superseded
 *       when their question was merged / superseded).
 *   applyOp(doc, actionId, op, { snoozeUntil, now }) -> { ok, item } | { ok:false, code:'NOT_FOUND' }
 *   wake(doc, now)                  snoozed items whose snoozeUntil passed are open again
 *   prune(doc, now)                 closed items after 30 days; FYI windows (recorded 14 d, info 7 d, out of scope 3 d);
 *                                   cap 2,000: closed first, then the oldest FYI; open reply / decision / follow-up /
 *                                   review items are never dropped (overCap is set instead)
 *   list(doc, { category, includeClosed, limit, offset }) -> { counts, total, items }
 *   openActionsFor(doc, conversationKey) / openCount(doc) / pinnedMessageKeys(doc)
 * Store wrappers: load(), update(fn).
 */
const stores = require('../stores');
const T = require('./templates');
const { TIER_RANK, FYI_WINDOW_MS } = require('./derive');

const DAY = 86_400_000;
const CAP = 2_000;
const QUESTIONS_CAP = 4_000;
const CLOSED_TTL_MS = 30 * DAY;
const SNOOZE_MAX_MS = 30 * DAY;
const OPS = Object.freeze(['dismiss', 'snooze', 'done', 'reopen', 'retry-analysis']);
const LIVE = new Set(['open', 'snoozed']);
const USER_HELD = new Set(['dismissed', 'snoozed', 'done-user']);
const SYSTEM_CLOSED = new Set(['done-auto', 'superseded', 'expired']);
const FYI = new Set(['recorded', 'info', 'outofscope']);
const PROTECTED = new Set(['reply', 'decision', 'followup', 'review']);
const FIELDS = ['category', 'tier', 'conversationKey', 'messageKey', 'latestMessageKey', 'legacyId', 'subject', 'units', 'questionIds', 'stagedIds', 'factKeys',
  'reasonCode', 'reasonText', 'actionText', 'evidenceQuote', 'due', 'chips', 'recipientsKnown', 'hasFact', 'decisionKind', 'outOfScopeCount'];

const iso = (now) => new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
const _ms = (s) => Date.parse(s || '') || 0;

function ensureDoc(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (!d.items || typeof d.items !== 'object') d.items = {};
  if (!d.questions || typeof d.questions !== 'object') d.questions = {};
  if (d.version == null) d.version = 1;
  return d;
}

const _sig = (x) => JSON.stringify(FIELDS.map((k) => (x[k] === undefined ? null : x[k])));

function mergeConversation(doc, conversationKey, derived, opts) {
  const d = ensureDoc(doc);
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const out = { created: [], escalated: [], resolved: [], changed: false };
  if (o.questions) {
    for (const [id, q] of Object.entries(d.questions)) if (q.conversationKey === conversationKey && !o.questions[id]) delete d.questions[id];
    for (const [id, q] of Object.entries(o.questions)) {
      const prev = d.questions[id];
      if (!prev || JSON.stringify(prev) !== JSON.stringify(q)) out.changed = true;
      d.questions[id] = q;
    }
  }
  const seen = new Set();
  for (const fresh of derived || []) {
    seen.add(fresh.actionId);
    const ex = d.items[fresh.actionId];
    if (!ex) {
      const item = Object.assign({}, fresh, { state: 'open', firstSeenAt: iso(now), lastChangedAt: iso(now), notifiedAt: null, notifyCount: 0, escalations: 0, notifiedEscalations: 0 });
      d.items[fresh.actionId] = item;
      out.created.push(item); out.changed = true;
      continue;
    }
    const escalated = (TIER_RANK[fresh.tier] || 0) > (TIER_RANK[ex.tier] || 0);
    const newerMessage = FYI.has(fresh.category) && fresh.latestMessageKey !== ex.latestMessageKey;
    const before = _sig(ex);
    for (const k of FIELDS) { if (fresh[k] === undefined) delete ex[k]; else ex[k] = fresh[k]; }
    let touched = before !== _sig(ex);
    if (escalated) { ex.escalations = (ex.escalations || 0) + 1; out.escalated.push(ex); }
    if (SYSTEM_CLOSED.has(ex.state)) { ex.state = 'open'; touched = true; }
    else if (USER_HELD.has(ex.state) && (escalated || newerMessage)) { ex.state = 'open'; delete ex.snoozeUntil; touched = true; }
    if (touched) { ex.lastChangedAt = iso(now); out.changed = true; }
  }
  for (const item of Object.values(d.items)) {
    if (item.conversationKey !== conversationKey || seen.has(item.actionId) || !LIVE.has(item.state)) continue;
    const q = (item.questionIds || []).map((id) => d.questions[id]).find(Boolean);
    item.state = q && (q.mergedInto || q.status === 'superseded') ? 'superseded' : 'done-auto';
    delete item.snoozeUntil;
    item.lastChangedAt = iso(now);
    out.resolved.push(item); out.changed = true;
  }
  return out;
}

/** Close every live item of a conversation (for example after a confirmed delete). */
function closeConversation(doc, conversationKey, state, now) {
  const d = ensureDoc(doc);
  let n = 0;
  for (const item of Object.values(d.items)) {
    if (item.conversationKey !== conversationKey || !LIVE.has(item.state)) continue;
    item.state = state || 'superseded'; delete item.snoozeUntil; item.lastChangedAt = iso(now); n++;
  }
  return n;
}

function applyOp(doc, actionId, op, opts) {
  const d = ensureDoc(doc);
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const item = d.items[actionId];
  if (!item) return { ok: false, code: 'NOT_FOUND' };
  if (op === 'dismiss') item.state = 'dismissed';
  else if (op === 'done') item.state = 'done-user';
  else if (op === 'reopen') item.state = 'open';
  else if (op === 'snooze') { item.state = 'snoozed'; item.snoozeUntil = o.snoozeUntil; }
  else if (op !== 'retry-analysis') return { ok: false, code: 'BAD_ARG', field: 'op' };
  if (op !== 'snooze') delete item.snoozeUntil;
  item.lastChangedAt = iso(now);
  return { ok: true, item };
}

function wake(doc, now) {
  const d = ensureDoc(doc);
  const t = Number.isFinite(now) ? now : Date.now();
  let n = 0;
  for (const item of Object.values(d.items)) {
    if (item.state === 'snoozed' && _ms(item.snoozeUntil) && _ms(item.snoozeUntil) <= t) { item.state = 'open'; delete item.snoozeUntil; item.lastChangedAt = iso(t); n++; }
  }
  return n;
}

function prune(doc, now) {
  const d = ensureDoc(doc);
  const t = Number.isFinite(now) ? now : Date.now();
  let pruned = 0;
  for (const [id, item] of Object.entries(d.items)) {
    const closed = !LIVE.has(item.state);
    if (closed && t - _ms(item.lastChangedAt) > CLOSED_TTL_MS) { delete d.items[id]; pruned++; continue; }
    if (FYI.has(item.category) && t - _ms(item.firstSeenAt) > FYI_WINDOW_MS[item.category]) { delete d.items[id]; pruned++; }
  }
  let all = Object.values(d.items);
  if (all.length > CAP) {
    const order = (a, b) => _ms(a.lastChangedAt) - _ms(b.lastChangedAt);
    const victims = all.filter((x) => !LIVE.has(x.state)).sort(order).concat(all.filter((x) => LIVE.has(x.state) && !PROTECTED.has(x.category)).sort(order));
    for (const v of victims) { if (all.length <= CAP) break; delete d.items[v.actionId]; all = all.filter((x) => x !== v); pruned++; }
  }
  d.overCap = Object.keys(d.items).length > CAP;
  // Question states: drop those of conversations with no remaining item, oldest first beyond the cap.
  const convs = new Set(Object.values(d.items).map((x) => x.conversationKey));
  const qs = Object.values(d.questions).filter((q) => !convs.has(q.conversationKey) && t - _ms(q.updatedAt) > CLOSED_TTL_MS);
  for (const q of qs) delete d.questions[q.questionId];
  const rest = Object.values(d.questions);
  if (rest.length > QUESTIONS_CAP) rest.sort((a, b) => _ms(a.updatedAt) - _ms(b.updatedAt)).slice(0, rest.length - QUESTIONS_CAP).forEach((q) => delete d.questions[q.questionId]);
  return { pruned, overCap: d.overCap };
}

const TIER_ORDER = { required: 0, suggested: 1, fyi: 2 };
function list(doc, o) {
  const d = ensureDoc(doc);
  const opts = o || {};
  const counts = {};
  for (const c of T.CATEGORIES) counts[c] = 0;
  for (const item of Object.values(d.items)) if (item.state === 'open' && counts[item.category] !== undefined) counts[item.category]++;
  const all = Object.values(d.items)
    .filter((x) => (opts.category ? x.category === opts.category : true))
    .filter((x) => (opts.includeClosed ? true : LIVE.has(x.state)))
    .sort((a, b) => (T.CATEGORIES.indexOf(a.category) - T.CATEGORIES.indexOf(b.category))
      || ((a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1))
      || ((TIER_ORDER[a.tier] || 0) - (TIER_ORDER[b.tier] || 0))
      || (_ms(b.firstSeenAt) - _ms(a.firstSeenAt)) || String(a.actionId).localeCompare(String(b.actionId)));
  const offset = Number.isInteger(opts.offset) ? opts.offset : 0;
  const limit = Number.isInteger(opts.limit) ? opts.limit : 50;
  return { counts, total: all.length, items: all.slice(offset, offset + limit) };
}

function openActionsFor(doc, conversationKey) {
  return Object.values(ensureDoc(doc).items).filter((x) => x.conversationKey === conversationKey && LIVE.has(x.state) && PROTECTED.has(x.category)).length;
}
function openCount(doc) { return Object.values(ensureDoc(doc).items).filter((x) => LIVE.has(x.state) && PROTECTED.has(x.category)).length; }
/** Messages referenced by open obligations are never evicted from the message ledger (design 1.2). */
function pinnedMessageKeys(doc) {
  const s = new Set();
  for (const x of Object.values(ensureDoc(doc).items)) {
    if (!LIVE.has(x.state) || !PROTECTED.has(x.category)) continue;
    if (x.messageKey) s.add(x.messageKey);
    if (x.latestMessageKey) s.add(x.latestMessageKey);
  }
  return s;
}

// ── store wrappers ────────────────────────────────────────────────────────────
function load() { return ensureDoc(stores.load('actions')); }
/** update(fn(doc) -> result) -> { ok, result } | { ok:false, code } */
function update(fn) {
  let result;
  const r = stores.update('actions', (doc) => { const d = ensureDoc(doc); result = fn(d); return d; });
  return r.ok ? { ok: true, result } : { ok: false, code: r.code };
}

module.exports = {
  CAP, OPS, SNOOZE_MAX_MS, LIVE, PROTECTED, ensureDoc, mergeConversation, closeConversation, applyOp, wake, prune, list,
  openActionsFor, openCount, pinnedMessageKeys, load, update,
};
