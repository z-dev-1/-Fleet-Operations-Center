'use strict';
/**
 * email-intel/actions/derive.js — action items of one conversation (design 5.3; R2.7, R4.10-R4.12, AC-C, AC-D, AC-I).
 *
 *   actionIdOf(category, conversationKey, ref)   'ac_' + sha1(category|conversationKey|ref).slice(0,16)
 *   deriveActions(view, ctx) -> ActionItem[]      deterministic and idempotent (no state, no clock-dependent ids)
 *
 * view: { conversationKey, records (oldest first), questions:{[questionId]:QuestionState}, staged:[open StagedItem],
 *         applied:[applied ledger entries of the conversation] }
 * ctx:  { now }
 *
 * Categories (labels in templates.js), one message may produce several items:
 *   reply      open question/request owned by me (required); shared question on my unit while I am in To, an unclear
 *              question on a 1:1 message, a probably-answered or partially read question (suggested)
 *   decision   approval/decision owned by me (required); unclear or shared addressee on an in-scope unit (suggested)
 *   followup   a dated commitment by someone else that is overdue with no later activity (required)
 *   review     every open staged item of the conversation (conflict-* required, others suggested)
 *   recorded   facts applied to the timeline, one item per message (fyi, last 14 days)
 *   info       no obligation, no recorded fact: group / informational / owned by someone else / partial / failed (fyi)
 *   outofscope only units outside my fleet (fyi)
 * Questions that are answered, withdrawn or merged create nothing; my own messages never create an item for me;
 * other people's questions (owner other-person / vendor / other-team) never become mine (case D).
 */
const crypto = require('crypto');
const T = require('./templates');
const Q = require('./questions');

const DAY = 86_400_000;
const FYI_WINDOW_MS = Object.freeze({ recorded: 14 * DAY, info: 7 * DAY, outofscope: 3 * DAY });
const TIER_RANK = Object.freeze({ fyi: 0, suggested: 1, required: 2 });
const OPEN_Q = new Set(['open', 'unknown', 'probably-answered']);

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
function actionIdOf(category, conversationKey, ref) {
  return 'ac_' + sha1(String(category) + '|' + String(conversationKey) + '|' + String(ref || '')).slice(0, 16);
}

const _t = (r) => Date.parse((r && (r.receivedAt || r.ingestedAt)) || '') || 0;
function _subject(rec) { return String((rec && rec.subject) || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 120); }

function _base(category, view, rec, ref, extra) {
  const recs = view.records;
  const latest = recs[recs.length - 1];
  return Object.assign({
    actionId: actionIdOf(category, view.conversationKey, ref), category, tier: 'fyi',
    conversationKey: view.conversationKey, messageKey: rec ? rec.messageKey : latest.messageKey, latestMessageKey: latest.messageKey,
    legacyId: latest.legacyId || null, subject: _subject(rec || latest), units: [], questionIds: [], stagedIds: [], factKeys: [],
    reasonCode: category, reasonText: '', actionText: '', evidenceQuote: undefined, due: undefined,
    chips: { partial: false, injection: false, staged: false, notThreaded: false, probablyAnswered: false, analysisFailed: false },
    recipientsKnown: !!(latest && latest.recipientsKnown),
  }, extra || {});
}

function _chips(item, rec) {
  const r = rec || {};
  item.chips.partial = item.chips.partial || ((r.body && r.body.status) || 'unknown') !== 'complete';
  item.chips.injection = item.chips.injection || !!(r.flags && r.flags.injectionSuspected);
  return item;
}

function _stagedAmount(view, unit, messageKey) {
  for (const s of view.staged || []) {
    if (!s.fact || !s.fact.amount || s.unit !== unit) continue;
    if (messageKey && s.provenance && s.provenance.messageKey !== messageKey) continue;
    return s.fact.amount;
  }
  return null;
}

/** deriveActions(view, ctx) -> ActionItem[] for one conversation. */
function deriveActions(view, ctx) {
  const v = view || {};
  const recs = Array.isArray(v.records) ? v.records : [];
  if (!recs.length) return [];
  const now = ctx && Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const latest = recs[recs.length - 1];
  const byKey = new Map(recs.map((r) => [r.messageKey, r]));
  const items = [];

  // ── reply / decision from durable question states ──
  const qs = Object.values(v.questions || {}).filter((q) => q.conversationKey === v.conversationKey && !q.mergedInto && OPEN_Q.has(q.status));
  qs.sort((a, b) => (a.origin.index - b.origin.index) || String(a.questionId).localeCompare(String(b.questionId)));
  for (const q of qs) {
    if (q.origin.fromMe) continue;
    const rec = byKey.get(q.originMessageKey);
    const probable = q.status === 'probably-answered';
    const partial = q.status === 'unknown';
    let cat = null; let tier = null; let basis = null;
    if (q.isDecision) {
      if (q.owner === 'me') { cat = 'decision'; tier = probable || partial ? 'suggested' : 'required'; }
      else if ((q.owner === 'shared' || q.owner === 'unknown') && q.inScope) { cat = 'decision'; tier = 'suggested'; }
    } else if (q.owner === 'me') { cat = 'reply'; tier = probable || partial ? 'suggested' : 'required'; }
    else if (q.owner === 'shared' && q.inScope && q.origin.role === 'to-direct') { cat = 'reply'; tier = 'suggested'; basis = 'shared'; }
    else if (q.owner === 'unknown' && q.inScope && q.origin.oneToOne) { cat = 'reply'; tier = 'suggested'; }
    if (!cat) continue;
    const it = _base(cat, v, rec, q.questionId, { tier, units: q.units.slice(), questionIds: [q.questionId], evidenceQuote: T.evidence(q.text) });
    it.reasonCode = cat + '-' + (q.owner === 'me' ? 'me' : (basis || 'possible'));
    it.chips.probablyAnswered = probable;
    it.chips.partial = partial;
    if (cat === 'decision') {
      const amount = q.units.length ? _stagedAmount(v, q.units[0], q.originMessageKey) : null;
      Object.assign(it, T.build('decision', { asker: q.askerName, units: q.units, tier, unclear: q.owner !== 'me', decisionKind: q.decisionKind, amount }));
      it.decisionKind = q.decisionKind || 'other';
    } else {
      Object.assign(it, T.build('reply', { type: q.type, asker: q.askerName, units: q.units, tier, probablyAnswered: probable, partial, basis }));
    }
    it.reasonCode = probable ? it.reasonCode + '-probable' : it.reasonCode;
    items.push(_chips(it, rec));
  }

  // ── follow-ups: dated commitments by someone else, overdue with no later activity (R4.8) ──
  const appliedAt = (v.applied || []).map((e) => e.appliedAt || e.createdAt).filter(Boolean);
  for (const cm of Q.commitmentStates(recs, { now, appliedAt })) {
    if (!cm.overdue) continue;
    const rec = byKey.get(cm.messageKey);
    const it = _base('followup', v, rec, cm.commitId, { tier: 'required', due: cm.dueDate, evidenceQuote: T.evidence(cm.text) });
    it.reasonCode = 'followup-overdue';
    Object.assign(it, T.build('followup', { who: cm.by === 'sender' ? cm.senderName : '', dueDate: cm.dueDate }));
    items.push(_chips(it, rec));
  }

  // ── review: every open staged item of the conversation ──
  const staged = (v.staged || []).filter((s) => s.state === 'open' && s.provenance && s.provenance.conversationKey === v.conversationKey);
  staged.sort((a, b) => String(a.stagedId).localeCompare(String(b.stagedId)));
  for (const s of staged) {
    const rec = byKey.get(s.provenance.messageKey) || null;
    const conflict = /^conflict-/.test(s.reason);
    const it = _base('review', v, rec, s.stagedId, { tier: conflict ? 'required' : 'suggested', units: [s.unit], stagedIds: [s.stagedId], factKeys: s.factKey ? [s.factKey] : [] });
    it.reasonCode = s.reason;
    it.chips.staged = true;
    it.hasFact = !!s.fact;
    it.evidenceQuote = s.fact ? T.evidence(s.fact.evidenceQuote) : undefined;
    Object.assign(it, T.build('review', { reason: s.reason, unit: s.unit, factState: s.fact && s.fact.state, factKind: s.fact && s.fact.kind, hasFact: !!s.fact, canonical: s.canonicalSnapshot || {} }));
    if (rec) _chips(it, rec);
    items.push(it);
  }

  // ── recorded: newly applied facts, one item per message (last 14 days) ──
  const byMsg = new Map();
  for (const e of v.applied || []) {
    if (e.state !== 'applied' || e.conversationKey !== v.conversationKey || !e.messageKey) continue;
    const at = Date.parse(e.appliedAt || e.createdAt || '') || 0;
    if (at && now - at > FYI_WINDOW_MS.recorded) continue;
    if (!byMsg.has(e.messageKey)) byMsg.set(e.messageKey, []);
    byMsg.get(e.messageKey).push(e);
  }
  for (const [mk, list] of Array.from(byMsg.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const rec = byKey.get(mk) || null;
    list.sort((a, b) => String(a.factKey).localeCompare(String(b.factKey)));
    const units = Array.from(new Set(list.map((e) => e.unit)));
    const it = _base('recorded', v, rec, mk, { tier: 'fyi', units, factKeys: list.map((e) => e.factKey) });
    it.messageKey = mk;
    it.reasonCode = 'recorded';
    Object.assign(it, T.build('recorded', { units, kinds: list.map((e) => e.kind), count: list.length }));
    items.push(it);
  }

  // ── out of scope / informational (R2.7: group and informational mail is kept, never hidden) ──
  const analyses = recs.map((r) => r.analysis || {});
  const dets = analyses.map((a) => a.determinations).filter(Boolean);
  const detUnits = [];
  for (const a of analyses) for (const u of ((a.deterministic && a.deterministic.units) || [])) detUnits.push(u);
  const inUnits = Array.from(new Set(detUnits.filter((u) => u.scope === 'in' || u.scope === 'unknown').map((u) => u.unit)));
  const outUnits = Array.from(new Set(detUnits.filter((u) => u.scope === 'out').map((u) => u.unit)));
  const onlyOut = outUnits.length > 0 && !inUnits.length && (!dets.length || dets.every((d) => d.informationRelevance && d.informationRelevance.level !== 'high' && !(d.informationRelevance.inScopeUnits || []).length));
  const age = now - _t(latest);
  if (!items.length && onlyOut) {
    if (!_t(latest) || age <= FYI_WINDOW_MS.outofscope) {
      const it = _base('outofscope', v, latest, '', { tier: 'fyi', units: [] });
      it.reasonCode = 'outofscope';
      it.outOfScopeCount = outUnits.length;
      Object.assign(it, T.build('outofscope', { count: outUnits.length }));
      items.push(_chips(it, latest));
    }
  } else if (!items.length && (!_t(latest) || age <= FYI_WINDOW_MS.info)) {
    const a = latest.analysis || {};
    const d = a.determinations || null;
    const status = String(a.status || 'pending');
    let code = 'informational'; let owner = null;
    const level = d && d.informationRelevance ? d.informationRelevance.level : null;
    const relevant = level === 'high' || level === 'medium';
    const group = !!(latest.flags && latest.flags.fromMe) ? false : (d && d.viaDistribution) || ((Number(latest.toCount) || 0) + (Number(latest.ccCount) || 0) > 1);
    if (status === 'failed-permanent') code = 'analysis-failed';
    else if (/^pending/.test(status)) code = 'not-analyzed';
    else if (d && d.replyRequirement && d.replyRequirement.value === 'unknown') code = 'partial-unknown';
    else if (d && d.replyRequirement && d.replyRequirement.basis === 'answered') code = 'answered';
    else if (d && d.replyRequirement && d.replyRequirement.basis === 'owned-by-other') { code = 'owned-by-other'; owner = d.otherResponsible && d.otherResponsible.who; }
    else if (relevant && group) code = 'group-info';
    else if (relevant) code = 'relevant-info';
    const units = d && d.informationRelevance ? (d.informationRelevance.inScopeUnits || []).slice(0, 10) : inUnits.slice(0, 10);
    const it = _base('info', v, latest, '', { tier: 'fyi', units });
    it.reasonCode = code;
    it.chips.analysisFailed = code === 'analysis-failed';
    Object.assign(it, T.build('info', { code, units, owner }));
    items.push(_chips(it, latest));
  }
  return items;
}

module.exports = { FYI_WINDOW_MS, TIER_RANK, actionIdOf, deriveActions };
