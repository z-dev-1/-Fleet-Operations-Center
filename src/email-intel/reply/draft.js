'use strict';
/**
 * email-intel/reply/draft.js — thread-aware reply drafting (design 6.2; R5.1, R5.2, R5.3, AC-I).
 *
 *   draftThreadReply({ conversationKey, mode:'reply'|'reply-all', guidance?, force? }, { now, _ask, canonicalFor })
 *     -> { ok:true, draft, mode, aiUnavailable, warnings:[{code,label}], recipients, basedOnMessageKey, replyAllAvailable }
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
 */
const stores = require('../stores');
const ledger = require('../ingest/ledger');
const cfgMod = require('../config');
const untrusted = require('../untrusted');
const { buildQuestions } = require('../actions/questions');
const { computeRecipients } = require('./recipients');
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

function buildDraftPrompt(ctxText, guidance, mode) {
  const lines = [untrusted.instructionBlock(), '', RULES, '', 'REPLY MODE: ' + (mode === 'reply-all' ? 'Reply All (everyone on the thread reads it)' : 'Reply (the sender only)'), '', 'CONVERSATION CONTEXT:', ctxText];
  if (guidance) { lines.push(''); lines.push('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):'); lines.push(guidance); }
  lines.push('');
  lines.push('Write the reply body now.');
  return lines.join('\n');
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
  const doc = ledger.ensureDoc(stores.load('messages'));
  const records = ledger.conversation(doc, ck);
  if (!records.length) return { ok: false, code: 'NOT_FOUND' };
  const latest = records[records.length - 1];
  const cfg = cfgMod.normalize(stores.load('config'));
  const me = cfg.me || {};

  let stored = {};
  try { stored = require('../actions/store').load().questions || {}; } catch (_) { stored = {}; }
  const questions = buildQuestions(records, stored, { now });
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

  const recipients = computeRecipients(latest, mode, me);
  const replyAll = computeRecipients(latest, 'reply-all', me);
  if (mode === 'reply-all' && replyAll.blocked === 'RECIPIENTS_UNKNOWN') return { ok: false, code: 'RECIPIENTS_UNKNOWN' };

  const guidance = typeof i.guidance === 'string' ? i.guidance.replace(CTRL_RE, '').trim().slice(0, GUIDANCE_MAX) : '';
  let ledgerEntries = []; let stagedItems = [];
  try { ledgerEntries = Object.values(stores.load('ledger').entries || {}); } catch (_) { ledgerEntries = []; }
  try { stagedItems = Object.values(stores.load('staged').items || {}); } catch (_) { stagedItems = []; }
  const ctx = buildReplyContext({
    records, questions, units: inScopeUnits(records), me, ledgerEntries, stagedItems,
    canonicalFor: o.canonicalFor || ((u) => { try { return require('../../orcha/canonical_state').getCanonical(u); } catch (_) { return null; } }),
  });
  const prompt = buildDraftPrompt(ctx.text, guidance, mode);
  const ask = o._ask || ((p, a) => require('../understand/lane').askIsolated(p, a));
  let r;
  try { r = await ask(prompt, { trigger: 'manual', timeoutMs: DRAFT_TIMEOUT_MS }); } catch (_) { r = { ok: false, error: 'threw' }; }

  let draft = ''; let aiUnavailable = false;
  if (r && r.ok) draft = _cleanOutput(r.text);
  if (!draft || draft.length > DRAFT_MAX) {
    if (r && r.ok) logger.warn('[email-intel] draft output rejected chars=' + String(draft.length));
    draft = _starter(latest, guidance); aiUnavailable = true;
  } else if (findSecret(draft)) {
    logger.warn('[email-intel] draft rejected: secret-like output');
    return { ok: false, code: 'DRAFT_UNSAFE' };
  }
  _persist(ck, latest, draft, mode, now);
  logger.info('[email-intel] draft ready mode=' + mode + ' ai=' + (aiUnavailable ? 'unavailable' : 'ok') + ' chars=' + draft.length + ' messages=' + ctx.messages.length);
  return {
    ok: true, draft, mode, aiUnavailable, warnings: scanRisk(draft), basedOnMessageKey: latest.messageKey,
    recipients: { to: recipients.to, cc: recipients.cc, external: recipients.external, blocked: recipients.blocked || null },
    replyAllAvailable: !replyAll.blocked,
  };
}

module.exports = { draftThreadReply, resolvedGate, buildDraftPrompt, DRAFT_MAX, GUIDANCE_MAX };
