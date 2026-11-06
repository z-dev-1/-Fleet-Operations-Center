'use strict';
/**
 * email-intel/understand/ownership.js — information relevance, action ownership and reply
 * requirement as three SEPARATE determinations (design 3.8; PG-1, PG-3, R2.1, R2.2, R2.5, R2.8,
 * R2.9, R4.1-R4.9).
 *
 *   recipientRole(record, me) / roleDetail(record, me)   'to-direct'|'to-dl'|'cc'|'cc-dl'|'sender-self'|'unknown'
 *   isDistribution(entry, me)                           true (configured) | 'possible' (heuristic) | false
 *   deriveRelevance({ units, mentions, aiLevel })       NO recipient input: To / CC can never lower relevance
 *   ownerOf(item, ctx)                                  me | other-person | shared | vendor | other-team | none | unknown
 *   determine(result, record, ctx)                      every per-message determination with its own reason
 *
 * Rules: a question to another named person is theirs even when it is about my unit; `me` needs
 * validated evidence (my name / address) or the 1:1 rule (To is exactly me, no CC, not from me,
 * second-person phrasing); distribution-list membership never makes anything mine; my own messages
 * never create an item for me. Relevance comes only from units, facts and the AI level, and the AI
 * level may raise but never lower a deterministic in-scope mention.
 */
const RANK = { none: 0, low: 1, medium: 2, high: 3 };
const LEVELS = ['none', 'low', 'medium', 'high'];
const DL_RE = /^(dl|dist|team|group|all)[-_ ]|@lists\./i;
const VENDOR_RE = /dealer|vendor|parts|service|repair|garage|shop|towing/i;
const SECOND_PERSON_RE = /\b(you|your|yours|yourself)\b/i;
const IMPERATIVE_RE = /^\s*(please|kindly|can|could|would|will|confirm|send|approve|let me know|advise|check|review|sign)\b/i;

const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const hasIdentity = (me) => !!me && (((me.names || []).length > 0) || ((me.addresses || []).length > 0));

function _isMe(entry, me) {
  if (!entry || !me) return false;
  const a = lc(entry.address); const n = lc(entry.name);
  return (!!a && (me.addresses || []).some((x) => lc(x) === a)) || (!!n && (me.names || []).some((x) => lc(x) === n));
}

function isDistribution(entry, me) {
  if (!entry) return false;
  const a = lc(entry.address); const n = lc(entry.name);
  if ((me && me.distributionLists || []).some((d) => { const x = lc(d); return !!x && (x === a || x === n); })) return true;
  if (DL_RE.test(n) || DL_RE.test(a) || DL_RE.test(a.split('@')[0] + ' ')) return 'possible';
  return false;
}

function roleDetail(rec, me) {
  const r = rec || {};
  if (!r.recipientsKnown || !hasIdentity(me)) return { role: 'unknown', viaDistribution: false, meInTo: false, meInCc: false };
  if (r.flags && r.flags.fromMe) return { role: 'sender-self', viaDistribution: false, meInTo: false, meInCc: false };
  const to = Array.isArray(r.to) ? r.to : [];
  const cc = Array.isArray(r.cc) ? r.cc : [];
  const meInTo = to.some((e) => _isMe(e, me));
  const meInCc = cc.some((e) => _isMe(e, me));
  const dlTo = to.map((e) => isDistribution(e, me));
  const dlCc = cc.map((e) => isDistribution(e, me));
  if (meInTo) return { role: 'to-direct', viaDistribution: false, meInTo, meInCc };
  if (dlTo.includes(true)) return { role: 'to-dl', viaDistribution: true, meInTo, meInCc };
  if (meInCc) return { role: 'cc', viaDistribution: false, meInTo, meInCc };
  if (dlCc.includes(true)) return { role: 'cc-dl', viaDistribution: true, meInTo, meInCc };
  if (dlTo.includes('possible')) return { role: 'to-dl', viaDistribution: 'possible', meInTo, meInCc };
  if (dlCc.includes('possible')) return { role: 'cc-dl', viaDistribution: 'possible', meInTo, meInCc };
  return { role: 'unknown', viaDistribution: false, meInTo, meInCc };
}
const recipientRole = (rec, me) => roleDetail(rec, me).role;

/** The 1:1 rule's recipient half: To is exactly my address, no CC, not sent by me. */
function isOneToOne(rec, me) {
  const r = rec || {};
  if (!r.recipientsKnown || !hasIdentity(me)) return false;
  if (r.flags && r.flags.fromMe) return false;
  const to = Array.isArray(r.to) ? r.to : [];
  const cc = Array.isArray(r.cc) ? r.cc : [];
  return to.length === 1 && cc.length === 0 && _isMe(to[0], me);
}
const secondPerson = (text) => SECOND_PERSON_RE.test(String(text || '')) || IMPERATIVE_RE.test(String(text || ''));

/**
 * deriveRelevance({ units:[{unit,scope,facts[]}], mentions:[{id,scope}], aiLevel }) — content only.
 */
function deriveRelevance(input) {
  const i = input || {};
  const units = Array.isArray(i.units) ? i.units : [];
  const mentions = Array.isArray(i.mentions) ? i.mentions : [];
  const inFact = units.filter((u) => u.scope === 'in' && (u.facts || []).length > 0).map((u) => u.unit);
  const inMention = mentions.filter((m) => m.scope === 'in').map((m) => m.id);
  const unknown = mentions.filter((m) => m.scope === 'unknown').map((m) => m.id);
  const out = mentions.filter((m) => m.scope === 'out').map((m) => m.id);
  let det; let code; let reason;
  if (inFact.length) { det = 'high'; code = 'in-scope-fact'; reason = 'New facts for your unit ' + inFact.slice(0, 3).join(', '); }
  else if (inMention.length) { det = 'medium'; code = 'in-scope-mention'; reason = 'Mentions your unit ' + inMention.slice(0, 3).join(', '); }
  else if (unknown.length) { det = 'medium'; code = 'scope-unknown'; reason = 'Mentions unit ' + unknown.slice(0, 3).join(', ') + ' (fleet list unavailable)'; }
  else if (out.length) { det = 'none'; code = 'out-of-scope'; reason = 'Only other units (' + out.length + ')'; }
  else { det = 'none'; code = 'no-units'; reason = 'Informational'; }
  const ai = LEVELS.includes(i.aiLevel) ? i.aiLevel : 'none';
  let level = det;
  if (code === 'out-of-scope') level = RANK[ai] > 0 ? 'low' : 'none';             // other FAS units: at most low
  else if (RANK[ai] > RANK[det]) { level = ai; if (code === 'no-units') code = 'ai'; }   // AI may raise, never lower
  return { level, reasonCode: code, reason, scopeUnknown: code === 'scope-unknown' || unknown.length > 0, outOfScope: code === 'out-of-scope', inScopeUnits: Array.from(new Set(inFact.concat(inMention))) };
}

/** ownerOf(item, { me, role, oneToOne, bodyStatus, fromMe, inScope(ids) }) for a question or request. */
function ownerOf(item, ctx) {
  const c = ctx || {};
  if (c.fromMe) return { owner: 'none', basis: 'sender-self', viaDistribution: false };
  const a = (item && item.addressee) || { kind: 'unclear' };
  const viaDl = c.role === 'to-dl' || c.role === 'cc-dl';
  if (a.kind === 'me') return { owner: 'me', basis: a.basis || 'named', viaDistribution: false };
  if (a.kind === 'named-other') return { owner: 'other-person', basis: 'named-other', viaDistribution: false };
  if (a.kind === 'group') {
    const reached = ['to-direct', 'cc', 'to-dl', 'cc-dl'].includes(c.role);
    if (reached && c.inScope && c.inScope(item.about)) return { owner: 'shared', basis: 'group', viaDistribution: viaDl };
    return { owner: 'none', basis: 'group-not-mine', viaDistribution: viaDl };
  }
  if (c.bodyStatus && c.bodyStatus !== 'complete') return { owner: 'unknown', basis: 'partial-content', viaDistribution: viaDl };
  if (c.oneToOne && secondPerson(item && item.text)) return { owner: 'me', basis: 'direct-1to1', viaDistribution: false };
  return { owner: 'unknown', basis: 'unclear-addressee', viaDistribution: viaDl };
}

function _commitmentOwner(cm, rec) {
  const fromMe = !!(rec && rec.flags && rec.flags.fromMe);
  if (cm.by === 'sender') {
    if (fromMe) return 'me';
    const s = String((rec && rec.from && (rec.from.name + ' ' + rec.from.address)) || '');
    return VENDOR_RE.test(s) ? 'vendor' : 'other-team';
  }
  return cm.who ? 'other-person' : 'other-team';
}

function _today(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * determine(result, record, ctx) — result: validated (merged) analysis or null (deterministic path).
 * ctx: { me, mentions, scopeOf, answered:Set<questionId>, hasQuestionMark, now, aiLevel }
 */
function determine(result, rec, ctx) {
  const c = ctx || {};
  const r = rec || {};
  const res = result || null;
  const me = c.me || {};
  const det = roleDetail(r, me);
  const oneToOne = isOneToOne(r, me);
  const fromMe = !!(r.flags && r.flags.fromMe);
  const bodyStatus = (r.body && r.body.status) || 'unknown';
  const mentions = Array.isArray(c.mentions) ? c.mentions : [];
  const scopeOf = typeof c.scopeOf === 'function' ? c.scopeOf : () => 'unknown';
  const inScope = (about) => {
    const ids = Array.isArray(about) && about.length ? about : mentions.map((m) => m.id);
    return ids.some((id) => scopeOf(id) === 'in' || scopeOf(id) === 'unknown');
  };
  const answered = c.answered instanceof Set ? c.answered : new Set();

  const informationRelevance = deriveRelevance({ units: res ? res.units : [], mentions, aiLevel: res && res.relevance ? res.relevance.level : null });

  const octx = { me, role: det.role, oneToOne, bodyStatus, fromMe, inScope };
  const items = [];
  for (const [type, list] of [['question', res ? res.questions : []], ['request', res ? res.requests : []]]) {
    for (const q of list || []) {
      const o = ownerOf(q, octx);
      items.push({ id: q.id || null, type, owner: o.owner, basis: o.basis, viaDistribution: o.viaDistribution, about: q.about || [], addressee: q.addressee ? q.addressee.kind : 'unclear', isApprovalOrDecision: !!q.isApprovalOrDecision, decisionKind: q.decisionKind || null, state: q.id && answered.has(q.id) ? 'answered' : 'open', inScope: inScope(q.about) });
    }
  }
  for (const cm of (res ? res.commitments : []) || []) items.push({ id: null, type: 'commitment', owner: _commitmentOwner(cm, r), basis: 'commitment-' + cm.by, about: [], dueDate: cm.dueDate || null, state: 'open', inScope: false });
  const open = items.filter((x) => x.state === 'open' && x.type !== 'commitment');
  const allText = String(r.subject || '') + '\n' + String((r.body && r.body.newContent) || '');
  const hasQ = /\?/.test(allText);

  let reply;
  if (fromMe) reply = { value: 'none', reason: 'You sent this message', basis: 'sender-self' };
  else if (open.some((x) => x.owner === 'me')) {
    const x = open.find((y) => y.owner === 'me');
    reply = { value: 'required', reason: x.basis === 'direct-1to1' ? 'Asked of you directly (1:1 message)' : 'Addressed to you by name', basis: x.basis };
  } else if (open.some((x) => x.owner === 'shared' && x.inScope && det.role === 'to-direct')) reply = { value: 'suggested', reason: 'Shared question about your unit; you are in To', basis: 'shared' };
  else if (open.some((x) => x.owner === 'unknown' && x.inScope) && oneToOne) reply = { value: 'suggested', reason: 'Unclear addressee on a direct message about your unit', basis: 'unclear-1to1' };
  else if (bodyStatus !== 'complete' && hasQ) reply = { value: 'unknown', reason: 'Message content is partial and contains a question', basis: 'partial-content' };
  else if (!res && hasQ) reply = { value: 'unknown', reason: 'Not analyzed; the message contains a question', basis: 'not-analyzed' };
  else if (items.some((x) => x.state === 'answered')) reply = { value: 'none', reason: 'Already answered later in the thread', basis: 'answered' };
  else if (open.some((x) => x.owner === 'other-person' || x.owner === 'vendor' || x.owner === 'other-team')) reply = { value: 'none', reason: 'Addressed to someone else', basis: 'owned-by-other' };
  else reply = { value: 'none', reason: 'No question or request for you', basis: 'informational' };

  const dec = open.filter((x) => x.isApprovalOrDecision);
  let decision;
  if (fromMe || !dec.length) decision = { value: 'none', kind: null, reason: dec.length ? 'You sent this message' : 'No decision requested' };
  else if (dec.some((x) => x.owner === 'me')) { const x = dec.find((y) => y.owner === 'me'); decision = { value: 'me', kind: x.decisionKind || 'other', reason: 'Your ' + (x.decisionKind || 'decision') + ' is requested' }; }
  else if (dec.some((x) => (x.owner === 'shared' || x.owner === 'unknown') && x.inScope)) { const x = dec.find((y) => (y.owner === 'shared' || y.owner === 'unknown') && y.inScope); decision = { value: 'suggested', kind: x.decisionKind || 'other', reason: 'A ' + (x.decisionKind || 'decision') + ' about your unit; addressee unclear' }; }
  else decision = { value: 'none', kind: null, reason: 'Decision requested from someone else' };

  const others = items.filter((x) => x.state === 'open' && ['other-person', 'vendor', 'other-team'].includes(x.owner));
  const otherResponsible = { value: others.length > 0, who: others.length ? others[0].owner : null, reason: others.length ? 'Next step is with ' + others[0].owner.replace('-', ' ') : 'No other party named' };

  const today = _today(Number.isFinite(c.now) ? c.now : Date.now());
  const due = items.filter((x) => x.type === 'commitment' && x.owner !== 'me' && x.dueDate);
  const overdue = due.filter((x) => x.dueDate < today);
  const followUpOverdue = { value: overdue.length > 0, reason: overdue.length ? 'A promised step was due ' + overdue[0].dueDate : (due.length ? 'Promised steps not yet due' : 'No dated commitment') };

  const mine = open.some((x) => x.owner === 'me' || x.owner === 'shared') || reply.value === 'required' || reply.value === 'suggested' || decision.value !== 'none';
  const informationalOnly = { value: !mine && reply.value !== 'unknown', reason: mine ? 'Something is expected of you' : 'No action expected from you' };

  return {
    recipientRole: det.role, viaDistribution: det.viaDistribution, oneToOne,
    informationRelevance,
    actionOwnership: { items, reason: items.length ? items.length + ' item(s) with owners' : 'No questions, requests or commitments' },
    replyRequirement: reply, decisionRequirement: decision, otherResponsible, followUpOverdue, informationalOnly,
    hasFleetInfo: informationRelevance.level === 'high' || informationRelevance.level === 'medium',
    hasQuestions: items.some((x) => x.type === 'question') || (!res && hasQ),
  };
}

module.exports = { recipientRole, roleDetail, isDistribution, isOneToOne, secondPerson, deriveRelevance, ownerOf, determine };
