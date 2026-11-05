'use strict';
// src/justme-context/action-gate.js — security control (a), design §11.
// On a Just Me context turn, processOrchaAction runs every AI-proposed action
// through filterActions() before anything executes or is staged. An action
// survives only when Z's own typed text asks for it: a command verb anchored at
// the start of a non-question clause (or, for read-only types, the keyword
// anywhere), the target typed by Z as a whole token, and AI-composed free text
// that passes screenFreeText(). Attached/linked content can never pass the gate
// on its own because only Z's typed text is consulted.

const ig = require('../orcha/fas/injection-guard');   // called, not changed
const { LIMITS, REASONS } = require('./constants');
const { stripForIntent, extractUrls } = require('./url-policy');

const DROP = Object.freeze({
  NO_TEXT: 'no typed request',
  UNKNOWN: 'unknown action',
  NOT_COMMAND: 'not typed as a command',
  TARGET: 'target not in your message',
  INSTRUCTIONS: 'content looked like instructions — type the note yourself',
  LINKS: REASONS.LINKS_ADDED,
});

// ── §11.1 clauses ───────────────────────────────────────────────────────────
const QWORDS = new Set(['what', 'whats', "what's", 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
  'has', 'have', 'any', "isn't", "aren't", "doesn't", "don't"]);

/** splitClauses(t) -> [{ text, question }] (t already lowercased). */
function splitClauses(t) {
  const out = [];
  // A terminator ends a sentence only before whitespace/end, so "bob@example.com" and "1.5" stay whole.
  const sentences = String(t || '').match(/(?:[^.!?;\n]|[.!?;](?=[^\s.!?;]))+[.!?;]*/g) || [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const first = (s.match(/^[^a-z0-9']*([a-z0-9']+)/) || [])[1] || '';
    const question = /\?\s*$/.test(s) || QWORDS.has(first);
    for (const c of s.split(/,?\s+(?:and then|then|and|also|plus)\s+/)) {
      const text = c.replace(/[.!?;\n]+$/, '').replace(/^[,\s]+/, '').trim();
      if (text) out.push({ text, question });
    }
  }
  return out;
}

// ── §11.2 rules ─────────────────────────────────────────────────────────────
const O = '[^.?!;\\n]{0,40}';
const LEAD = '^(?:(?:please|pls|also|then|now|and|ok|okay|go ahead and|just),?\\s+)*';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-token match: the neighbours can't be part of a name, handle, or address.
const tok = (v, t) => new RegExp('(^|[^a-z0-9._@-])' + escapeRe(v) + '($|[^a-z0-9._@-])', 'i').test(t);

const unitInText = (u, t) => typeof u === 'string' && u.trim() !== '' && tok(u.trim().toLowerCase(), t);

const PRONOUNS = new Set(['me', 'my', 'myself', 'i', 'him', 'her', 'them', 'us', 'you', 'it', 'this', 'that', 'these', 'those',
  'everyone', 'everybody', 'all', 'team', 'channel', 'here', 'someone', 'somebody']);

// Copy of the ai.js SLACK contact lookup (src/ipc/ai.js:460 _scContact and :484-488 matchedContact).
function resolveSlackContact(r, contacts) {
  const rl = String(r).toLowerCase().replace(/^@/, '');
  return (contacts || []).find((ct) => ct && ((ct.name && ct.name.toLowerCase().includes(rl)) ||
    (ct.slackId && ct.slackId.toLowerCase() === rl) ||
    (ct.email && ct.email.toLowerCase() === rl))) || null;
}
// Copy of the ai.js EMAIL lookup (src/ipc/ai.js:647-650): only when `to` has no '@'.
function resolveEmailContact(to, contacts) {
  const s = String(to || '').trim();
  if (s.includes('@')) return null;
  return (contacts || []).find((ct) => ct && ct.email && ct.name && ct.name.toLowerCase().includes(s.toLowerCase())) || null;
}
function recipientInText(type, r, t, contacts) {
  const n = String(r || '').trim().toLowerCase().replace(/^@/, '');
  if (n.length < 3 || PRONOUNS.has(n)) return false;
  if (!tok(n, t)) return false;                                   // (i) Z typed the AI's recipient string
  const c = type === 'EMAIL' ? resolveEmailContact(r, contacts) : resolveSlackContact(r, contacts);
  if (!c) return true;                                            // raw address/handle, checked in (i)
  const first = (c.name || '').trim().split(/\s+/)[0] || '';
  return [c.email, c.slackId, c.name, first.length >= 3 ? first : null]   // (ii) the contact ai.js will use is named by Z
    .filter(Boolean).some((v) => tok(String(v).toLowerCase(), t));
}

const cmd = (src) => ({ kind: 'command', re: new RegExp(LEAD + '(?:' + src + ')', 'i') });
const read = (src) => ({ kind: 'read', re: new RegExp(src, 'i') });
const withTarget = (rule, target) => Object.assign(rule, { target });

const ACTION_RULES = {
  SYNC: cmd('(?:re)?sync\\b|(?:refresh|pull|update)\\b' + O + '\\b(?:fleet|data|latest)\\b'),
  SP_PUSH: cmd('(?:push|update|sync|send)\\b' + O + '\\b(?:sharepoint|sheet|sp)\\b'),
  DBR_PULL: cmd('(?:pull|run|get|fetch|refresh)\\b' + O + '\\bdbr\\b'),
  BRIEFING: withTarget(cmd('(?:send|run|post|push|re-?send)\\b' + O + '\\bbriefings?\\b'),
    (a, t) => a.operator == null || String(a.operator).trim() === '' || tok(String(a.operator).trim().toLowerCase(), t)),
  EMAIL_TRIAGE: cmd('triage\\b|(?:check|scan|go through)\\b' + O + '\\b(?:inbox|e-?mails?|mail|outlook)\\b'),
  DAILY_NOTES: cmd('(?:do|run|add|write|update|generate)\\b' + O + '\\bdaily notes\\b'),
  TIMELINE: withTarget(cmd('(?:add|log|put|append|note|record)\\b' + O + '\\b(?:timeline|notes?)\\b'), (a, t) => unitInText(a.unit, t)),
  CREATE_WR: withTarget(cmd('(?:create|open|submit|file|raise|make)\\b' + O + '\\b(?:wr|work request)\\b'), (a, t) => unitInText(a.unit, t)),
  REMIND: withTarget(cmd('remind me\\b|set (?:a )?reminder\\b'), (a, t) => a.unit == null || a.unit === '' || unitInText(a.unit, t)),
  PIN: withTarget(cmd('pin\\b'), (a, t) => unitInText(a.unit, t)),
  UNPIN: withTarget(cmd('unpin\\b'), (a, t) => unitInText(a.unit, t)),
  SCHEDULE: cmd('(?:schedule|set up)\\b[^.?!;\\n]{0,60}\\b(?:every|daily|weekly|hourly|each|at \\d)'),
  ASK_INTERNAL: cmd('(?:ask|check with)\\b' + O + '\\b(?:internal(?:ly)?|aiteammate)\\b'),
  SLACK: withTarget(cmd('(?:slack|send|message|dm|ping|tell|forward|share|post)\\b'), (a, t, contacts) => recipientInText('SLACK', a.recipient, t, contacts)),
  EMAIL: withTarget(cmd('(?:e-?mail|mail)\\b|(?:send|forward)\\b[^.?!;\\n]{0,60}\\b(?:e-?mail|mail)\\b'), (a, t, contacts) => recipientInText('EMAIL', a.to, t, contacts)),
  MOVE_UNIT: withTarget(cmd('(?:move|flip|mark|set|make)\\b' + O + '\\b(?:available|unavailable|active)\\b'), (a, t) => unitInText(a.unit, t)),
  APPROVE_WR: withTarget(cmd('approve\\b'), (a, t) => a.id != null && String(a.id).trim() !== '' && tok(String(a.id).trim().toLowerCase(), t)),
  REVIEW_QUEUE: read('\\breview\\b'),
  READ_SLACK: read('\\b(?:read|check)\\b[^.?!;\\n]{0,40}\\b(?:slack|messages|dms?)\\b'),
  DRAFT_FOLLOWUPS: read('\\bfollow[\\s-]?ups?\\b'),
};

// ── §11.4 free-text screening ───────────────────────────────────────────────
const FIELDS = {
  TIMELINE: ['entry'], REMIND: ['note'], CREATE_WR: ['issue'], MOVE_UNIT: ['reason'], SCHEDULE: ['action'],
  ASK_INTERNAL: ['question'], SLACK: ['message'], EMAIL: ['subject', 'body'],
};
const SINGLE_LINE = new Set(['TIMELINE.entry', 'REMIND.note', 'CREATE_WR.issue', 'MOVE_UNIT.reason', 'SCHEDULE.action', 'EMAIL.subject']);
const TAGGED = new Set(['TIMELINE.entry', 'REMIND.note', 'CREATE_WR.issue']);
// Round-3 fix 7: fields that leave the app; a URL in them must come from Z's typed text.
const OUTWARD = new Set(['ASK_INTERNAL.question', 'SLACK.message', 'EMAIL.subject', 'EMAIL.body']);
const PROVENANCE = ' [from shared content]';
const PLANTED = [
  /\b(assistant|ai|orcha|fleet brain|bot|claude|gpt)\b[^.\n]{0,40}\b(should|must|always|never|whenever|run|send|post|reply|ignore)\b/i,
  /\b(from now on|in (all )?future (turns|messages|replies)|next time (you|z|the user))\b/i,
];

const _decodeEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const _trimUrl = (u) => u.replace(/[.,;:!?)\]}'"]+$/, '');

/** Every http(s) URL in a field: bare, inside <url|label>, or in a label, after entity decoding. */
function fieldUrls(s) {
  return _decodeEntities(String(s)).match(/https?:\/\/[^\s<>|"']+/gi) || [];
}

/** True when every URL in `value` was typed by Z (raw substring, or same URL.href as a typed link). */
function urlsTyped(value, typedText) {
  const typed = String(typedText || '');
  const typedDecoded = _decodeEntities(typed);
  const hrefs = new Set(extractUrls(typed, Infinity));
  for (const raw of fieldUrls(value)) {
    const u = _trimUrl(raw);
    if (typed.includes(raw) || typed.includes(u) || typedDecoded.includes(u)) continue;
    let href = null;
    try { href = new URL(u).href; } catch (_) { href = null; }
    if (href && hrefs.has(href)) continue;
    return false;
  }
  return true;
}

/**
 * screenFreeText(a, typedText) -> { ok:true } | { ok:false, reason }
 * Mutates the screened fields of `a`: neutralized, single-line where listed,
 * capped at ACTION_FREE_TEXT_MAX, provenance suffix on persisted-and-replayed fields.
 */
function screenFreeText(a, typedText) {
  for (const f of FIELDS[a.type] || []) {
    if (typeof a[f] !== 'string') continue;
    const raw = a[f];
    const key = a.type + '.' + f;
    if (ig.detectInjection(raw).suspicious || PLANTED.some((re) => re.test(raw))) return { ok: false, reason: DROP.INSTRUCTIONS };
    if (OUTWARD.has(key) && !urlsTyped(raw, typedText)) return { ok: false, reason: DROP.LINKS };
    let v = ig.neutralize(raw);
    if (SINGLE_LINE.has(key)) v = v.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    v = v.slice(0, LIMITS.ACTION_FREE_TEXT_MAX);
    if (TAGGED.has(key)) v = v + PROVENANCE;
    a[f] = v;
  }
  return { ok: true };
}

const _typeName = (v) => (String(v || '').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 20) || 'UNKNOWN');

/** Z's typed text in intent form: Slack mailto tokens kept as the bare address, then stripForIntent. */
function intentText(typedText) {
  const s = String(typedText == null ? '' : typedText).replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/gi, ' $1 ');
  return stripForIntent(s).toLowerCase().trim();
}

/**
 * filterActions(actions, { typedText, contacts }) -> { allowed, dropped }
 * allowed: screened copies of the actions Z asked for. dropped: [{ type, reason }].
 */
function filterActions(actions, { typedText, contacts } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const t = intentText(typedText);
  const clauses = t ? splitClauses(t) : [];
  const allowed = [];
  const dropped = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') { dropped.push({ type: 'UNKNOWN', reason: DROP.UNKNOWN }); continue; }
    const type = _typeName(a.type);
    const rule = Object.prototype.hasOwnProperty.call(ACTION_RULES, a.type) ? ACTION_RULES[a.type] : null;
    if (!rule) { dropped.push({ type, reason: DROP.UNKNOWN }); continue; }
    if (!t) { dropped.push({ type, reason: DROP.NO_TEXT }); continue; }
    const asked = rule.kind === 'command'
      ? clauses.some((c) => !c.question && rule.re.test(c.text))
      : clauses.some((c) => rule.re.test(c.text));
    if (!asked) { dropped.push({ type, reason: DROP.NOT_COMMAND }); continue; }
    if (rule.target && !rule.target(a, t, contacts || [])) { dropped.push({ type, reason: DROP.TARGET }); continue; }
    const copy = Object.assign({}, a);
    const s = screenFreeText(copy, typedText);
    if (!s.ok) { dropped.push({ type, reason: s.reason }); continue; }
    allowed.push(copy);
  }
  return { allowed, dropped };
}

module.exports = {
  filterActions, screenFreeText, splitClauses, recipientInText, resolveSlackContact, resolveEmailContact,
  urlsTyped, fieldUrls, intentText, ACTION_RULES, PRONOUNS, DROP, PROVENANCE,
};
