'use strict';
/**
 * email-intel/reply/draft.js — thread-aware reply drafting (design 6.2; R5.1, R5.2, R5.3, AC-I).
 *
 *   draftThreadReply({ conversationKey, mode:'reply'|'reply-all', guidance?, force?, clarify?, answers? }, { now, _ask, canonicalFor })
 *     -> { ok:true, draft, mode, aiUnavailable, warnings:[{code,label}], recipients, basedOnMessageKey, replyAllAvailable }
 *      | { ok:true, needsAnswers:true, questions:[1..3], mode }   (clarify:true with guidance only; nothing persisted)
 *      | { ok:false, code:'NOT_FOUND'|'ALREADY_RESOLVED'|'RECIPIENTS_UNKNOWN'|'DRAFT_UNSAFE', resolvedBy? }
 *   resolvedGate(questions) -> { resolved, resolvedBy? }
 *
 * 1. Gate (R5.2): when the conversation has no open question / request owned by me or possibly mine, and at
 *    least one question exists and every one is answered (or withdrawn), the draft is refused with
 *    ALREADY_RESOLVED and who resolved it, unless force:true (forced drafts are logged as a count only).
 * 2. Context: reply/context.js (last 6 messages fenced, question states, VERIFIED / FROM EMAIL applied /
 *    UNVERIFIED labels).
 * 3. Prompt: static rules (no approval, authorization, spend commitment, date promise or recipient change unless
 *    the user's guidance says so; thread tone; plain text; <= 180 words unless guided), the context, then the
 *    user's own guidance (trusted, <= 1,000 chars). The ONLY AI path is the isolated lane (understand/lane.js).
 * 4. Output: string 1..4,000 chars, control characters stripped; findSecret must be null (else DRAFT_UNSAFE);
 *    risky phrases become warnings (they never block; the user decides in the confirmation).
 * 5. Persist: the draft goes on the conversation's live reply / decision action items ({ text, mode,
 *    basedOnMessageKey, createdAt }) and is mirrored onto the legacy record (replyDraft, replyState 'drafted') so
 *    the legacy overlay stays coherent. An uncertain or sent legacy record is never overwritten.
 * AI unavailable: an editable starter text built from the guidance, aiUnavailable:true (legacy fallback behavior).
 * Outlook REST transport (apiTransport only): after the gate, reply/resolve-recipients reads the real From / To / CC
 * from the API (refreshing or ingesting the ledger record); the reply target is reply/target.replyTarget (the send
 * path's rule) and a self-addressed Reply goes to me (selfOnlyFallback). The result then also carries
 * recipientsSource ('api'|'stored'|null), sendable and, when the message could not be resolved, unresolved:{ reason }
 * with empty To / CC (blocked 'RECIPIENTS_UNRESOLVED'; the draft is still written, sending is off). Flag off: unchanged.
 */
const stores = require('../stores');
const ledger = require('../ingest/ledger');
const cfgMod = require('../config');
const untrusted = require('../untrusted');
const { buildQuestions } = require('../actions/questions');
const { computeRecipients } = require('./recipients');
const { replyTarget } = require('./target');
const { buildReplyContext, inScopeUnits } = require('./context');
const { scanRisk } = require('./risk');
const { findSecret } = require('../../justme-context/secret-scrub');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const DRAFT_MAX = 4_000;
const GUIDANCE_MAX = 1_000;
const DRAFT_TIMEOUT_MS = 45_000;
const MINE = new Set(['me', 'shared', 'unknown']);
const OPENISH = new Set(['open', 'probably-answered', 'unknown']);
const RESOLVED = new Set(['answered', 'withdrawn']);
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

let _forced = 0;

function _apiOn() {
  try { return require('../flags').apiTransport() === true; } catch (_) { return false; }
}

/** records (oldest first) order the answers so resolvedBy is the latest answering message. */
function resolvedGate(questions, records) {
  const qs = Object.values(questions || {}).filter((q) => q && !q.mergedInto && q.status !== 'superseded');
  if (!qs.length) return { resolved: false };
  if (qs.some((q) => OPENISH.has(q.status) && MINE.has(q.owner || 'unknown'))) return { resolved: false };
  if (!qs.every((q) => RESOLVED.has(q.status))) return { resolved: false };
  const order = new Map((records || []).map((r, n) => [r.messageKey, n]));
  const last = qs.map((q) => q.answeredBy).filter(Boolean).sort((a, b) => (order.get(a.messageKey) ?? -1) - (order.get(b.messageKey) ?? -1)).pop() || null;
  return { resolved: true, resolvedBy: last };
}

const RULES = [
  'You are drafting a reply in an existing email conversation on behalf of a fleet operations manager.',
  'Write ONLY the reply body as plain text: no subject, no "To:", no markdown, no signature block beyond a simple sign-off.',
  'At most 180 words unless the guidance below asks for more. Match the tone of the thread.',
  'Do NOT approve, authorize, commit to spending, promise dates, or change who is on the thread unless the guidance below explicitly says so.',
  'Do NOT answer a question whose state is "answered": someone already answered it.',
  'State only facts labeled VERIFIED or "FROM EMAIL, applied" as facts. Never state an UNVERIFIED fact as true; if needed, say it is being checked.',
  'If an authority decision is needed (approving a cost, authorizing work) and the facts do not settle it, write that it is under review.',
].join('\n');

function buildDraftPrompt(ctxText, guidance, mode, answers) {
  const lines = [untrusted.instructionBlock(), '', RULES, '', 'REPLY MODE: ' + (mode === 'reply-all' ? 'Reply All (everyone on the thread reads it)' : 'Reply (the sender only)'), '', 'CONVERSATION CONTEXT:', ctxText];
  if (guidance) { lines.push(''); lines.push('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):'); lines.push(guidance); }
  if (answers) { lines.push(''); lines.push(ANSWERS_HEADER); lines.push(answers); }
  lines.push('');
  lines.push('Write the reply body now.');
  return lines.join('\n');
}

// Free-write with clarifying questions (opt-in: clarify:true plus the user's own guidance). Same rules, mode and
// context as buildDraftPrompt; the model either writes the reply or asks 1-3 short questions as strict JSON
// (the Baseball Card interviewer contract). Nothing is persisted while questions are open.
const ANSWERS_HEADER = 'THE USER\'S ANSWERS TO YOUR QUESTIONS (trusted, from the user):';
const QUESTION_MAX = 200;
const CLARIFY_CONTRACT = [
  'If the guidance and context give you enough to write a correct reply, write it. If a fact the reply needs is missing (a date, amount, unit, who approves, what to commit to), ASK 1-3 short questions instead of guessing. Never fabricate specifics.',
  'Respond as STRICT JSON only, one of:',
  '{"done":true,"draft":"<reply body>"}',
  '{"done":false,"questions":["q1","q2"]}',
  'No text outside the JSON.',
].join('\n');

function buildClarifyPrompt(ctxText, guidance, answers, mode) {
  const lines = [untrusted.instructionBlock(), '', RULES, '', 'REPLY MODE: ' + (mode === 'reply-all' ? 'Reply All (everyone on the thread reads it)' : 'Reply (the sender only)'), '', 'CONVERSATION CONTEXT:', ctxText];
  lines.push(''); lines.push('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):'); lines.push(guidance);
  if (answers) { lines.push(''); lines.push(ANSWERS_HEADER); lines.push(answers); }
  lines.push('');
  lines.push(CLARIFY_CONTRACT);
  if (answers) lines.push('The user already answered your questions: ask again only if something critical is still missing.');
  return lines.join('\n');
}

/** -> { questions:[1..3] } | { draft } | { invalid:true } (JSON present but unusable) | null (no JSON at all). */
function _parseClarify(text) {
  const m = /\{[\s\S]*\}/.exec(String(text == null ? '' : text));
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[0]); } catch (_) { return { invalid: true }; }
  if (p && p.done === false && Array.isArray(p.questions)) {
    const questions = p.questions.filter((q) => typeof q === 'string')
      .map((q) => q.replace(CTRL_RE, '').replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX)).filter(Boolean).slice(0, 3);
    if (questions.length) return { questions };
  }
  if (p && p.done === true && typeof p.draft === 'string') return { draft: p.draft };
  return { invalid: true };
}

function _starter(latest, guidance) {
  const n = String((latest && latest.from && latest.from.name) || '').trim();
  const who = n && !n.includes('@') ? n.split(/[\s,<]/)[0] : '';
  return 'Hi' + (who ? ' ' + who : '') + ',\n\n' + (guidance ? guidance + '\n\n' : 'Thank you for your email.\n\n\n\n') + 'Best regards';
}

function _cleanOutput(text) {
  let t = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(CTRL_RE, '').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

function _persist(conversationKey, latest, draft, mode, now) {
  const createdAt = new Date(now).toISOString();
  const rec = { text: draft, mode, basedOnMessageKey: latest.messageKey, createdAt };
  try {
    const as = require('../actions/store');
    as.update((doc) => {
      for (const item of Object.values(doc.items)) {
        if (item.conversationKey !== conversationKey || !as.LIVE.has(item.state) || !['reply', 'decision'].includes(item.category)) continue;
        item.draft = rec;
      }
    });
  } catch (_) { /* action items are optional (actionsView may be off) */ }
  try {
    const store = require('../../store');
    const results = store.load('emailTriageResults', null);
    const emails = results && Array.isArray(results.emails) ? results.emails : [];
    let idx = emails.findIndex((e) => e && e.intel && e.intel.conversationKey === conversationKey);
    if (idx === -1) idx = emails.findIndex((e) => e && e.id === latest.legacyId);
    if (idx !== -1 && !['uncertain', 'sent'].includes(emails[idx].replyState)) {
      emails[idx] = Object.assign({}, emails[idx], { replyDraft: draft, replyState: 'drafted' });
      store.save('emailTriageResults', results);
      return results;
    }
  } catch (_) { /* legacy mirror only */ }
  return null;
}

async function draftThreadReply(input, opts) {
  const i = input || {};
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ck = i.conversationKey;
  const mode = i.mode === 'reply-all' ? 'reply-all' : 'reply';
  const api = _apiOn();
  const doc = ledger.ensureDoc(stores.load('messages'));
  let records = ledger.conversation(doc, ck);
  if (!records.length) return { ok: false, code: 'NOT_FOUND' };
  const cfg = cfgMod.normalize(stores.load('config'));
  const me = cfg.me || {};

  let stored = {};
  try { stored = require('../actions/store').load().questions || {}; } catch (_) { stored = {}; }
  let questions = buildQuestions(records, stored, { now });
  const gate = resolvedGate(questions, records);
  if (gate.resolved && i.force !== true) {
    const by = gate.resolvedBy ? records.find((r) => r.messageKey === gate.resolvedBy.messageKey) : null;
    logger.info('[email-intel] draft refused: already resolved');
    return {
      ok: false, code: 'ALREADY_RESOLVED',
      resolvedBy: { messageKey: (gate.resolvedBy && gate.resolvedBy.messageKey) || null, senderName: String((by && by.from && by.from.name) || '').slice(0, 60), receivedAt: (by && by.receivedAt) || null, basis: (gate.resolvedBy && gate.resolvedBy.basis) || null },
    };
  }
  if (gate.resolved) { _forced++; logger.info('[email-intel] forced drafts=' + _forced); }

  // Outlook REST transport: the real From / To / CC come from the API before anything is computed (the resolver
  // refreshes or ingests the ledger record, so the send validator sees the same recipients).
  let resolved = null;
  if (api) {
    try { resolved = await (o._resolve || require('./resolve-recipients').resolveReplyRecipients)({ conversationKey: ck, mode }, { now }); } catch (_) { resolved = null; }
    records = ledger.conversation(ledger.ensureDoc(stores.load('messages')), ck);
    if (!records.length) return { ok: false, code: 'NOT_FOUND' };
    questions = buildQuestions(records, stored, { now });
  }
  const unresolved = api && (!resolved || resolved.ok !== true);
  const latest = replyTarget(records, api);
  let recipients = computeRecipients(latest, mode, me, { selfOnlyFallback: api });
  const replyAll = computeRecipients(latest, 'reply-all', me, { selfOnlyFallback: api });
  if (unresolved) recipients = { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' };
  else if (mode === 'reply-all' && replyAll.blocked === 'RECIPIENTS_UNKNOWN') return { ok: false, code: 'RECIPIENTS_UNKNOWN' };

  const guidance = typeof i.guidance === 'string' ? i.guidance.replace(CTRL_RE, '').trim().slice(0, GUIDANCE_MAX) : '';
  let ledgerEntries = []; let stagedItems = [];
  try { ledgerEntries = Object.values(stores.load('ledger').entries || {}); } catch (_) { ledgerEntries = []; }
  try { stagedItems = Object.values(stores.load('staged').items || {}); } catch (_) { stagedItems = []; }
  const ctx = buildReplyContext({
    records, questions, units: inScopeUnits(records), me, ledgerEntries, stagedItems,
    canonicalFor: o.canonicalFor || ((u) => { try { return require('../../orcha/canonical_state').getCanonical(u); } catch (_) { return null; } }),
  });
  const answers = typeof i.answers === 'string' ? i.answers.replace(CTRL_RE, '').trim().slice(0, GUIDANCE_MAX) : '';
  const clarify = i.clarify === true && !!guidance;
  const prompt = clarify ? buildClarifyPrompt(ctx.text, guidance, answers, mode) : buildDraftPrompt(ctx.text, guidance, mode, answers);
  const ask = o._ask || ((p, a) => require('../understand/lane').askIsolated(p, a));
  let r;
  try { r = await ask(prompt, { trigger: 'manual', timeoutMs: DRAFT_TIMEOUT_MS }); } catch (_) { r = { ok: false, error: 'threw' }; }

  let draft = ''; let aiUnavailable = false;
  if (clarify && r && r.ok) {
    // Questions: nothing is persisted, the user answers inline. A finished draft continues down the normal path;
    // unusable JSON falls back to the editable starter (never stuck asking, never JSON in the reply box).
    const c = _parseClarify(r.text);
    if (c && c.questions) {
      logger.info('[email-intel] draft needs answers mode=' + mode + ' questions=' + c.questions.length);
      return { ok: true, needsAnswers: true, questions: c.questions, mode };
    }
    if (c && c.invalid) logger.warn('[email-intel] clarify output rejected chars=' + String(String(r.text || '').length));
    else draft = _cleanOutput(c ? c.draft : r.text);
  } else if (r && r.ok) draft = _cleanOutput(r.text);
  if (!draft || draft.length > DRAFT_MAX) {
    if (r && r.ok) logger.warn('[email-intel] draft output rejected chars=' + String(draft.length));
    draft = _starter(latest, guidance); aiUnavailable = true;
  } else if (findSecret(draft)) {
    logger.warn('[email-intel] draft rejected: secret-like output');
    return { ok: false, code: 'DRAFT_UNSAFE' };
  }
  _persist(ck, latest, draft, mode, now);
  logger.info('[email-intel] draft ready mode=' + mode + ' ai=' + (aiUnavailable ? 'unavailable' : 'ok') + ' chars=' + draft.length + ' messages=' + ctx.messages.length);
  const out = {
    ok: true, draft, mode, aiUnavailable, warnings: scanRisk(draft), basedOnMessageKey: latest.messageKey,
    recipients: { to: recipients.to, cc: recipients.cc, external: recipients.external, blocked: recipients.blocked || null },
    replyAllAvailable: !unresolved && !replyAll.blocked,
  };
  if (api) {
    out.recipientsSource = unresolved ? null : resolved.source;
    out.sendable = !unresolved && !recipients.blocked && latest.source === 'api' && !!latest.itemId;
    if (unresolved) out.unresolved = { reason: (resolved && resolved.reason) || 'unavailable' };
  }
  return out;
}

module.exports = { draftThreadReply, resolvedGate, buildDraftPrompt, buildClarifyPrompt, DRAFT_MAX, GUIDANCE_MAX };
