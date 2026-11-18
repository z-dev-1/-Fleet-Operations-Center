'use strict';
/**
 * carrier-intel/answer.js — parse, grounding gate, mechanical fallback and render (design
 * B8.1–B8.3, B10).
 *
 * parseAnswer(text) -> { ok:true, answer, trends, actions, support, fasInput, badItems, overCap } | { ok:false, code }
 * gateAnswer(parsed, built) -> { sections, removed, removals, mechanical, diag }
 * mechanical(section, model) -> [{ text, units, src?, team?, system? }]
 * render(model, { surface, sections, removed, reason }) -> string (<= REPLY_MAX)
 * `built` is the context.buildContext result. The whole item is removed when any check fails;
 * item text is never edited. Pure: no I/O, no logging; failures are returned as diag entries.
 */

const F = require('../dbr/fleet-dbr');
const EV = require('../dbr/fleet-dbr-evidence');
const G = require('../dbr/fleet-dbr-gate');
const { extractJsonObject } = require('../utils/ai-json');
const { defangMentions } = require('../justme-context/reply-hygiene');
const Fx = require('./facts');
const T = require('./taxonomy');
const Gp = require('./gaps');

const SECTIONS = Object.freeze(['answer', 'trends', 'actions', 'support', 'fasInput']);
const CAPS = Object.freeze({ answer: 3, trends: 5, actions: 6, support: 5, fasInput: 4 });
const FIELD_OF = Object.freeze({ answer: 'details', trends: 'details', actions: 'fasActions', support: 'support', fasInput: 'details' });
const TEXT_MAX = 300;
const UNITS_MAX = 12;
const REPLY_MAX = 3500;
const CI_FAS_QUOTE_MAX = 80;
const CI_FAS_QUOTE_MIN = 8;
const MECH_ACTIONS_MAX = 4;
const MECH_SUPPORT_MAX = 5;
const MECH_SUFFIX = ' (from the extracted facts)';
const NO_FAS_LINE = 'No FAS action logged for these units.';

// ── Gate regexes (B8.2) ─────────────────────────────────────────────────────
const CI_TIMES_RE = /(?<![\w.\/])(\d+)\s*(?:×|x\b|times\b)/gi;
const CI_ETC_VERB_RE = /\b(?:earlier|pulled\s+in|pull-?ins?|same-?day|re-?tim\w*|later|slip\w*|pushed|revis\w*|chang\w*|re-?stamp\w*|updat\w*|moved)\b/gi;
const CI_LIST_SEP_RE = /^\s*(?:,\s*(?:and|or)?|and|or)\s*$/i;
const CI_RECUR_RE = /\b(?:came\s+back|returned|recurr\w*|episodes?|repeat\w*)\b/i;
const CI_ETC_NUM_FIRST_RE = /(?<![\d.])(\d+)\s*(?:ETC\s+|completion\s+)?(?:date\s+)?(?:same-?day\s+)?(slips?|pull-?ins?|re-?times?|revisions?|changes?|moves?|updates?)\b/gi;
const CI_MISS_WORD_RE = /\b(?:missed|overdue|past\s+due|blown)\b/gi;
const CI_ETC_WORD_RE = /\b(?:ETC|ETR|completion)\b/gi;
const CI_MISS_NEG_RE = /\b(?:no|not|none|never|zero|0)\b[^.;,]{0,40}$/i;
const CI_FRACTION_RE = /(?<![\d.,\/])(\d+)\s+(?:of|out\s+of)\s+(\d+)\b(?![.\/]\d)/g;
const CI_UNIT_COUNT_RE = /(?<![\d.,\/])(\d+)\s+((?:[A-Za-z][\w-]*\s+){0,2})(?:units?|trucks?|vehicles?)\b(?!-)/g;
const CI_CAUSE_COUNT_RE = /(?<![\d.,\/])(\d+)\s+(?:[A-Za-z][\w-]*\s+){0,2}?(parts?[- ]?holds?|accidents?|impounds?|DSP[- ]holds?)\b/gi;
const CI_CLASS_RE = /(?<![\w.\/])(\d+(?:\.\d+)?)\s*(?:(unit-days)\b|(%)|(days?|d)\b|(hours?|hrs?|h)\b|(weeks?|w)\b)/gi;
const CI_NUM_TOKEN_RE = /(?<![\w.\/])\d+(?:\.\d+)?(?![\w\/]|\.\d)/g;
const CI_DATE_BLANK_RE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi;
const CI_NO_ACTION_RE = /\bno\s+(?:FAS\s+)?(?:action|follow-?up)s?\s+(?:was\s+)?(?:taken|logged|recorded)\b/i;
const CI_GENERIC_VENDOR_WORDS = new Set(['dealer', 'onsite', 'mobile']);
const CI_COUNT_CATS = Object.freeze([
  ['down', /\bdown\b/i], ['total', /\b(?:total|fleet)\b/i],
  ['parts-hold', /\bparts?[- ]?holds?\b|\bon\s+parts\s+hold\b|\bwaiting\s+on\s+parts\b/i],
  ['accident', /\baccidents?\b/i], ['impound', /\bimpound(?:s|ed)?\b/i],
  ['DSP-hold', /\bDSP[- ]holds?\b/i], ['dealer-offsite', /\bdealer[- ]offsite\b|\bat\s+(?:the\s+)?dealer\b/i],
  ['repair', /\brepair\b/i],
  ['owner:DSP', /\bDSP[- ]managed\b/i], ['owner:vendor', /\bvendor(?:\/|\s+or\s+)dealer[- ]side\b|\bvendor[- ]side\b/i],
  ['noEta', /\bno\s+(?:parts\s+)?ETA\b/i], ['etaPassed', /\bETA\s+passed\b|\bpassed\b[^.;]{0,20}\bETA\b/i],
  ['etc:none', /\bno\s+ETC\b/i], ['etc:today', /\bETC\s+(?:of\s+)?today\b|\bdue\s+today\b/i], ['etc:future', /\bfuture\s+ETC\b/i],
  ['DOT', /\bDOT\b/], ['PM_B', /\bPM\s*B\b/i], ['PM_X', /\bPM\s*X\b/i], ['Lift', /\blift\b/i],
  ['pmaStale', /\bPM\s*A\b/i], ['washStale', /\bwash\b/i],
]);
const CI_NAME_ALLOW = new Set([
  'answer', 'trends', 'trend', 'actions', 'action', 'support', 'needed', 'input',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'relay', 'amazon', 'dsp', 'fas', 'mcs', 'aap', 'uptime', 'manager', 'carrier', 'dealer', 'vendor', 'parts', 'estimate',
  'insurance', 'impound', 'lift', 'wash', 'box', 'truck', 'trucks', 'cng', 'etcs',
  ...G.SUPPORT_TEAMS.join(' ').toLowerCase().split(/[\s\/]+/).filter(Boolean),
]);
const VERB_FIELD = Object.freeze([
  [/^(?:earlier|pulled\s+in|pull-?ins?)$/i, 'dayPullIns'],
  [/^(?:same-?day|re-?tim\w*)$/i, 'sameDay'],
  [/^(?:later|slip\w*|pushed)$/i, 'daySlips'],
  [/^(?:revis\w*|chang\w*|re-?stamp\w*|updat\w*)$/i, 'revised'],
  [/^moved$/i, 'daySlips'],
]);
const NOUN_FIELD = Object.freeze([
  [/^(?:slips?|moves?)$/i, 'daySlips'], [/^pull-?ins?$/i, 'dayPullIns'], [/^re-?times?$/i, 'sameDay'],
  [/^(?:revisions?|changes?|updates?)$/i, 'revised'],
]);
// Step 8: claims a selected cue gap says the data can't support (AC-23, AC-24c).
const CI_TECH_WORD = '\\btech(?:nician)?s?\\b(?!\\s+(?:on\\s*site|arriv))';
const CI_REASSIGN_CLAIM_RE = new RegExp('\\bre-?assign\\w*|\\b(?:mov|pull|shift|redeploy|divert|transferr?)\\w*\\b[^.?;]{0,40}' + CI_TECH_WORD +
  '|' + CI_TECH_WORD + '[^.?;]{0,40}\\b(?:trailers?|hostlers?|yard\\s+trucks?)\\b', 'gi');
const CI_DRIVER_CLAIM_RE = /\bcold[\s-]+starts?\b|\bafter\s+fuel\w*|\bunder\s+(?:a\s+)?load\b|\bdrivers?\s+(?:report|say|said|mention|complain|note|describ)\w*/gi;
const CI_CND_CLAIM_RE = /\b(?:could\s*n[o']?t|can'?t|cannot|unable\s+to|did\s*n[o']?t|failed\s+to)\s+(?:duplicate|replicate|reproduce)\b/gi;
const CI_CLAIM_NEG_RE = /\b(?:no|not|none|never|nothing|cannot|without|unrecorded|unknown|unavailable)\b|n't\b/i;
const CI_CONTRAST_RE = /,\s*(?:but|while|though|although|and)\b|\b(?:but|however|although)\b/gi;
const CI_THEME_LABEL_RE = /\btheme\s+(?:cold\s+start|after\s+fueling|under\s+load|could\s+not\s+duplicate)\b|\bno\s+hits:[^.;\n]*/gi;
const CI_QUOTE_RE = /["\u201C\u201D]([^"\u201C\u201D]{8,})["\u201C\u201D]/g;
const ETC_FIELDS = Object.freeze(['revised', 'daySlips', 'dayPullIns', 'sameDay']);
const CLAUSE_G_RE = new RegExp(G.CLAUSE_SPLIT_RE.source, 'g');

function _s(v) { return v == null ? '' : String(v); }
function _plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Same test as the gate's private _bounded (fleet-dbr-gate.js), case-insensitive.
function _bounded(tok, text) { return new RegExp('(^|[^A-Za-z0-9])' + _esc(tok) + '($|[^A-Za-z0-9])', 'i').test(text); }
function _blank(text, start, end) { return text.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + text.slice(end); }
function _blankAll(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return text.replace(g, (m) => ' '.repeat(m.length));
}
function _fieldOf(table, word) { const hit = table.find(([re]) => re.test(word.trim())); return hit ? hit[1] : null; }
function _plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// ── Parse (B8.1) ────────────────────────────────────────────────────────────
function _item(it) {
  if (!_plain(it) || typeof it.text !== 'string') return null;
  const text = G._cutWord(it.text.trim(), TEXT_MAX);
  if (!text) return null;
  let units = [];
  if (it.units !== undefined && it.units !== null) {
    if (!Array.isArray(it.units) || it.units.length > UNITS_MAX || it.units.some((u) => typeof u !== 'string')) return null;
    units = it.units.map((u) => u.trim()).filter(Boolean);
  }
  const out = { text, units };
  if (it.src !== undefined) out.src = it.src;
  if (typeof it.team === 'string' && G.SUPPORT_TEAMS.includes(it.team.trim())) out.team = it.team.trim();
  return out;
}

function parseAnswer(text) {
  const obj = extractJsonObject(typeof text === 'string' ? text : '');
  if (!obj || !SECTIONS.some((k) => Array.isArray(obj[k]))) return { ok: false, code: 'ai-bad-json' };
  const out = { ok: true, badItems: 0, overCap: 0 };
  for (const k of SECTIONS) {
    out[k] = [];
    if (!Array.isArray(obj[k])) continue;
    for (const raw of obj[k]) {
      const it = _item(raw);
      if (!it) { out.badItems += 1; continue; }
      if (out[k].length >= CAPS[k]) { out.overCap += 1; continue; }
      out[k].push(it);
    }
  }
  return out;
}

// ── Gate (B8.2) ─────────────────────────────────────────────────────────────
function _scopes(units, built) {
  const { ctx, model } = built;
  const SC = model.scac;
  const real = (units || []).map((u) => ctx.idMap.get(String(u).toLowerCase())).filter((id) => id && id !== SC);
  const uniq = [...new Set(real)];
  return { real: uniq, unitScope: uniq.length ? uniq : [SC], scacScope: [...new Set([...uniq, SC])] };
}
function _textOf(scope, built) { return scope.map((u) => built.ciText.get(u) || '').join('\n'); }
function _recs(scope, model) { return scope.map((id) => model.recById && model.recById.get(id)).filter(Boolean); }
function _rollupEtc(model) {
  return (model.detailed || []).filter((r) => r.etcHistory && r.etcHistory.revised > 0).map((r) => r.etcHistory.daySlips);
}

// Step 2: ETC counts. Returns { code } or { masked }.
function _etcCount(text, real, unitScope, model) {
  const recs = _recs(unitScope, model);
  const pseudo = real.length === 0;
  const rollDaySlips = pseudo ? _rollupEtc(model) : [];
  const allowed = (field) => {
    const s = new Set();
    for (const r of recs) if (r.etcHistory) s.add(r.etcHistory[field]);
    if (pseudo && field === 'daySlips') for (const n of rollDaySlips) s.add(n);
    return s;
  };
  const verbless = () => {
    const s = new Set();
    for (const r of recs) if (r.etcHistory) for (const f of ETC_FIELDS) s.add(r.etcHistory[f]);
    for (const n of rollDaySlips) s.add(n);
    return s;
  };
  const episodes = () => {
    const s = new Set();
    const ep = (model.themes && model.themes.episodes) || {};
    const ids = pseudo ? Object.keys(ep) : unitScope;
    for (const id of ids) for (const v of Object.values(ep[id] || {})) s.add(v);
    return s;
  };
  let masked = text;
  let prev = null;
  let m;
  CI_TIMES_RE.lastIndex = 0;
  while ((m = CI_TIMES_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const n = +m[1];
    let verb = null;
    let inherited = false;
    if (prev && CI_LIST_SEP_RE.test(text.slice(prev.end, start))) { verb = prev.verb; inherited = true; }
    if (!inherited) {
      const win = text.slice(Math.max(0, start - 40), start);
      const vr = new RegExp(CI_ETC_VERB_RE.source, 'gi');
      let v;
      while ((v = vr.exec(win))) verb = v[0];
    }
    let ok;
    if (verb) ok = allowed(_fieldOf(VERB_FIELD, verb) || 'daySlips').has(n);
    else {
      ok = verbless().has(n);
      if (!ok && CI_RECUR_RE.test(text.slice(Math.max(0, start - 30), start))) ok = episodes().has(n);
    }
    if (!ok) return { code: 'unknown-etc-count' };
    masked = _blank(masked, start, end);
    prev = { end, verb };
  }
  CI_ETC_NUM_FIRST_RE.lastIndex = 0;
  while ((m = CI_ETC_NUM_FIRST_RE.exec(masked))) {
    const field = _fieldOf(NOUN_FIELD, m[2]) || 'revised';
    if (!allowed(field).has(+m[1])) return { code: 'unknown-etc-count' };
    masked = _blank(masked, m.index, m.index + m[0].length);
    CI_ETC_NUM_FIRST_RE.lastIndex = m.index + m[0].length;
  }
  return { masked };
}

function _clauseStart(text, pos) {
  let start = 0;
  CLAUSE_G_RE.lastIndex = 0;
  let m;
  while ((m = CLAUSE_G_RE.exec(text))) {
    if (m[0].length === 0) { CLAUSE_G_RE.lastIndex += 1; continue; }
    const e = m.index + m[0].length;
    if (e > pos) break;
    start = e;
  }
  return start;
}
function _clauseAt(text, pos) {
  const start = _clauseStart(text, pos);
  CLAUSE_G_RE.lastIndex = pos;
  const m = CLAUSE_G_RE.exec(text);
  return text.slice(start, m ? m.index : text.length);
}

// Step 2b: ETC state.
function _etcState(text, real, unitScope, model, countBy) {
  const anyMissed = real.length === 0
    ? (countBy.get('etc:missed') || 0) > 0
    : _recs(unitScope, model).some((r) => r.etc && r.etc.state === 'missed');
  const etcAt = [];
  const er = new RegExp(CI_ETC_WORD_RE.source, 'gi');
  let m;
  while ((m = er.exec(text))) etcAt.push([m.index, m.index + m[0].length]);
  const mr = new RegExp(CI_MISS_WORD_RE.source, 'gi');
  while ((m = mr.exec(text))) {
    const s = m.index;
    const e = s + m[0].length;
    if (!etcAt.some(([a, b]) => b >= s - 40 && a <= e + 40)) continue;
    const cs = _clauseStart(text, s);
    const pre = text.slice(Math.max(cs, s - 60), s);
    const negated = CI_MISS_NEG_RE.test(pre);
    if (negated ? anyMissed : !anyMissed) return 'etc-state-mismatch';
  }
  return null;
}

// Step 3: counts. Returns { code } or { masked }.
function _counts(masked, built) {
  const countBy = built.countBy;
  const countSet = built.countSet;
  const cats = CI_COUNT_CATS.slice();
  for (const k of countBy.keys()) {
    if (k.startsWith('vendor:') && k.length > 7) cats.push([k, new RegExp('(^|[^A-Za-z0-9])' + _esc(k.slice(7)) + '($|[^A-Za-z0-9])', 'i')]);
    // Theme counts bind to the roll-up's own 'theme <name>:' wording (a theme line's quotes can name a vendor).
    if (k.startsWith('theme:') && k.length > 6) cats.push([k, new RegExp('\\btheme\\s+' + _esc(k.slice(6)) + '\\b', 'i')]);
  }
  const bound = (q, exclude) => {
    const out = new Set();
    for (const [k, re] of cats) if (!exclude.has(k) && countBy.has(k) && re.test(q)) out.add(countBy.get(k));
    return out;
  };
  const okIn = (n, set) => (set.size ? set.has(n) : countSet.has(n));
  const DT = new Set(['down', 'total']);
  let t = masked;
  let m;
  const fr = new RegExp(CI_FRACTION_RE.source, 'g');
  while ((m = fr.exec(t))) {
    if (!countSet.has(+m[2])) return { code: 'unknown-count' };
    if (!okIn(+m[1], bound(_clauseAt(t, m.index), DT))) return { code: 'unknown-count' };
    t = _blank(t, m.index, m.index + m[0].length);
  }
  const ur = new RegExp(CI_UNIT_COUNT_RE.source, 'g');
  while ((m = ur.exec(t))) {
    const words = bound(m[2] || '', new Set());
    const set = words.size ? words : bound(_clauseAt(t, m.index), DT);
    if (!okIn(+m[1], set)) return { code: 'unknown-count' };
    t = _blank(t, m.index, m.index + m[0].length);
  }
  const cr = new RegExp(CI_CAUSE_COUNT_RE.source, 'gi');
  while ((m = cr.exec(t))) {
    const w = m[2].toLowerCase();
    const key = /^parts?/.test(w) ? 'parts-hold' : /^accident/.test(w) ? 'accident' : /^impound/.test(w) ? 'impound' : 'DSP-hold';
    if ((countBy.get(key) || 0) !== +m[1]) return { code: 'unknown-count' };
    t = _blank(t, m.index, m.index + m[0].length);
  }
  return { masked: t };
}

function _classPairs(text) {
  const out = new Set();
  const re = new RegExp(CI_CLASS_RE.source, 'gi');
  let m;
  while ((m = re.exec(text))) out.add(m[1] + '|' + (m[2] ? 'ud' : m[3] ? '%' : m[4] ? 'd' : m[5] ? 'h' : 'w'));
  return out;
}

// Step 4: unit-class numbers. Returns { code } or { masked }.
function _classNumbers(masked, unitScope, scacScope, built) {
  const unitPairs = _classPairs(_textOf(unitScope, built));
  const scacPairs = _classPairs(_textOf(scacScope, built));
  let t = masked;
  const re = new RegExp(CI_CLASS_RE.source, 'gi');
  let m;
  while ((m = re.exec(masked))) {
    const cls = m[2] ? 'ud' : m[3] ? '%' : m[4] ? 'd' : m[5] ? 'h' : 'w';
    const set = cls === '%' || cls === 'ud' ? scacPairs : unitPairs;
    if (!set.has(m[1] + '|' + cls)) return { code: 'unknown-number' };
    t = _blank(t, m.index, m.index + m[0].length);
  }
  return { masked: t };
}

// Step 4b: every remaining number token.
function _catchAll(masked, unitScope, built) {
  let t = masked;
  for (const re of [CI_DATE_BLANK_RE, G.ID_TOKEN_RE, G.REF_RE, G.TICKET_RE, G.AMOUNT_RE, G.URL_RE]) t = _blankAll(t, re);
  const ev = new Set((_textOf(unitScope, built).match(new RegExp(CI_NUM_TOKEN_RE.source, 'g')) || []));
  const toks = t.match(new RegExp(CI_NUM_TOKEN_RE.source, 'g')) || [];
  for (const tok of toks) if (!built.countSet.has(Number(tok)) && !ev.has(tok)) return 'unknown-number';
  return null;
}

// Step 6: vendor / dealer names from the fleet-dbr lexicon.
function _vendorNames(text, unitScope, built) {
  const ev = _textOf(unitScope, built);
  for (const src of [F.OEM_VENDOR_RE, F.ONSITE_VENDOR_RE]) {
    const re = new RegExp(src.source, 'gi');
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      if (CI_GENERIC_VENDOR_WORDS.has(m[0].toLowerCase())) continue;
      if (!_bounded(m[0], ev)) return 'unknown-name';
    }
  }
  return null;
}

function _nameAllow(model) {
  const s = new Set(CI_NAME_ALLOW);
  s.add(_s(model.scac).toLowerCase());
  for (const d of model.domiciles || []) s.add(_s(d).toLowerCase());
  return s;
}

// True when `re` matches outside a negated clause (the match itself is blanked before the
// negation test, so "could not duplicate" is not its own negation).
function _claimed(text, re) {
  const g = new RegExp(re.source, 'gi');
  let m;
  while ((m = g.exec(text))) {
    if (!m[0]) { g.lastIndex += 1; continue; }
    const s = m.index;
    const e = s + m[0].length;
    const cs = _clauseStart(text, s);
    CLAUSE_G_RE.lastIndex = e;
    const ce = CLAUSE_G_RE.exec(text);
    const clause = _blank(text, s, e).slice(cs, ce ? ce.index : text.length);
    const off = s - cs;
    let a = 0;
    let b = clause.length;
    const cr = new RegExp(CI_CONTRAST_RE.source, 'gi');
    let c;
    while ((c = cr.exec(clause))) {
      if (c.index + c[0].length <= off) a = c.index + c[0].length;
      else if (c.index >= off + m[0].length) { b = c.index; break; }
    }
    if (!CI_CLAIM_NEG_RE.test(clause.slice(a, b))) return true;
  }
  return false;
}

// Step 8: an item asserting what a selected cue gap (G-REASSIGN, G-DRIVER, G-CND none) says is
// not in the data. G-DRIVER allows a quote found in the scoped evidence; theme labels are data.
function _cueGapClaim(text, scacScope, built) {
  const m = built.model || {};
  const ids = new Set((m.gaps || built.gaps || []).map((g) => g && g.id));
  if (!ids.size) return null;
  const t = _blankAll(text, CI_THEME_LABEL_RE);
  if (ids.has('G-REASSIGN') && _claimed(t, CI_REASSIGN_CLAIM_RE)) return 'cue-gap-claim';
  if (ids.has('G-DRIVER')) {
    const ev = EV.normQuote(_textOf(scacScope, built));
    const d = t.replace(new RegExp(CI_QUOTE_RE.source, 'g'), (q, inner) => {
      const n = EV.normQuote(inner);
      return n && ev.includes(n) ? ' '.repeat(q.length) : q;
    });
    if (_claimed(d, CI_DRIVER_CLAIM_RE)) return 'cue-gap-claim';
  }
  const cnd = ((m.themes && m.themes.hits) || {})['could not duplicate'] || [];
  if (ids.has('G-CND') && !cnd.length && _claimed(t, CI_CND_CLAIM_RE)) return 'cue-gap-claim';
  return null;
}

/** checkItem(item, section, built) -> null | drop code (checks 1–8: B8.2 order, then cue-gap claims). */
function checkItem(item, section, built) {
  const { ctx, model, countBy } = built;
  const text = _s(item.text);
  const { real, unitScope, scacScope } = _scopes(item.units, built);
  const field = FIELD_OF[section] || 'details';
  const g = G.gateEntry(text, item.src, unitScope, ctx, { field });
  if (!g.ok) return g.code;
  const e = _etcCount(text, real, unitScope, model);
  if (e.code) return e.code;
  const st = _etcState(text, real, unitScope, model, countBy);
  if (st) return st;
  const c = _counts(e.masked, built);
  if (c.code) return c.code;
  const k = _classNumbers(c.masked, unitScope, scacScope, built);
  if (k.code) return k.code;
  const n = _catchAll(k.masked, unitScope, built);
  if (n) return n;
  if (_s(model.fasAlias) === '' && (G.NO_FAS_RE.test(text) || CI_NO_ACTION_RE.test(text))) return 'unfounded-no-action';
  const v = _vendorNames(text, unitScope, built);
  if (v) return v;
  const allow = _nameAllow(model);
  const names = G.nameFlags(text, unitScope, ctx).filter((x) => !allow.has(x.toLowerCase()));
  if (names.length) return 'unknown-name';
  return _cueGapClaim(text, scacScope, built);
}

// ── Mechanical fallback (B8.3) ──────────────────────────────────────────────
function _line(model, prefix) { return _s(model.rollupText).split('\n').find((l) => l.startsWith(prefix)) || ''; }
function _units(text, model) {
  const ids = [...new Set(_s(text).match(G.ID_TOKEN_RE) || [])];
  const map = model.idMap instanceof Map ? model.idMap : new Map();
  return [...new Set(ids.map((t) => map.get(t.toLowerCase())).filter(Boolean))];
}
function _mech(text, model, extra) { return Object.assign({ text: text + MECH_SUFFIX, units: _units(text, model) }, extra || {}); }

function clipQuote(c) {
  let q = _s(c).trim();
  while (EV.normQuote(q).length > CI_FAS_QUOTE_MAX) {
    const sp = q.lastIndexOf(' ');
    if (sp <= 0) { q = ''; break; }
    q = q.slice(0, sp).replace(/[\s,;:\-\u2013\u2014]+$/, '');
  }
  return q;
}

function _shareOf(recs, pick) {
  const known = recs.filter((r) => r.daysDown != null);
  const total = known.reduce((s, r) => s + r.daysDown, 0);
  const part = known.filter(pick).reduce((s, r) => s + r.daysDown, 0);
  return { pct: total > 0 ? Math.round((part / total) * 100) : 0, part, total };
}

function _actions(model) {
  const out = [];
  const logs = model.fasLogs instanceof Map ? model.fasLogs : new Map();
  for (const r of model.detailed || []) {
    const lines = logs.get(r.id) || [];
    for (const l of lines) {
      const clause = clipQuote(l.body.split(G.CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean)[0]);
      if (EV.normQuote(clause).length < CI_FAS_QUOTE_MIN) continue;
      out.push({ text: l.md + ' ' + clause, units: [r.id], src: { fas: [{ date: l.md, quote: clause }] } });
      break;
    }
    if (out.length >= MECH_ACTIONS_MAX) break;
  }
  if (out.length) return out;
  // [FAS] lines exist but none gave an envelope item: gateAnswer shows the "Unit notes for …" line.
  if ((model.detailed || []).some((r) => (logs.get(r.id) || []).length)) return [];
  if (_s(model.fasAlias) !== '') return [{ text: NO_FAS_LINE, units: [] }];
  return [{ text: Gp.GAP_TEXT['G-FASID'], units: [], system: true }];
}

function _blockerLine(rec, model) {
  const re = Fx.BLOCKER_RE[rec.cause] || Fx.BLOCKER_RE.repair;
  const k = (rec.keyLines || []).find((x) => re.test(x.text));
  if (!k) return null;
  const fas = k.who === 'Amazon-side note' || EV.fasNameMatch(k.who, model.fasNames || [], model.fasAlias || '');
  return fas ? null : k;
}

function _support(model) {
  const out = [];
  for (const r of model.detailed || []) {
    if (r.owner === 'DSP' && ['accident', 'impound', 'DSP-hold'].includes(r.cause)) {
      const alts = [];
      const k = _blockerLine(r, model);
      if (k) {
        const kt = _s(k.text).trim();
        const lead = k.md && !kt.startsWith(k.md) ? k.md + ' ' : '';
        alts.push(_mech('Carrier/DSP: ' + r.id + ' \u2014 ' + lead + kt, model));
      }
      alts.push(_mech('Carrier/DSP: ' + r.id + ' \u2014 ' + T.causeLabel(r.cause, r.flags) + ', owner DSP', model));
      out.push({ alts });
    } else if (r.cause === 'parts-hold' && r.parts && r.parts.noEta && r.daysDown != null && r.daysDown > 7) {
      out.push({ alts: [_mech('Vendor: parts ETA for ' + r.id + ' (' + r.vendorLabel + ')', model)] });
    }
  }
  for (const u of (model.compliance && model.compliance.units) || []) {
    const it = (u.items || [])[0];
    if (!it) continue;
    const what = it.cat === 'DOT' ? 'DOT expired ' + Fx.md(it.due) : it.label + ' overdue since ' + Fx.md(it.due);
    out.push({ alts: [_mech('Carrier/DSP: ' + u.id + ' ' + what, model)] });
  }
  return out.slice(0, MECH_SUPPORT_MAX);
}

function _fasInput(model) {
  const recs = model.records || [];
  const out = [];
  const known = recs.filter((r) => r.daysDown != null);
  if (known.length) {
    const by = new Map();
    for (const r of known) by.set(r.cause, (by.get(r.cause) || 0) + r.daysDown);
    const top = [...by.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
    if (top) {
      const sh = _shareOf(recs, (r) => r.cause === top[0]);
      const n = recs.filter((r) => r.cause === top[0]).length;
      out.push(_mech(top[0] + ' holds ' + sh.pct + '% of ' + model.scac + '\'s down-days (' + _plural(n, 'unit', 'units') + ')', model));
    }
    const dsp = recs.filter((r) => r.owner === 'DSP');
    if (dsp.length) {
      const sh = _shareOf(recs, (r) => r.owner === 'DSP');
      if (sh.total > 0) out.push(_mech('DSP-managed units hold ' + sh.pct + '% of ' + model.scac + '\'s down-days (' + _plural(dsp.length, 'unit', 'units') + ')', model));
    }
  }
  const rolling = recs.filter((r) => (r.flags || []).includes('etc-rolling'));
  if (rolling.length >= 2) {
    const vc = new Map();
    for (const r of rolling) vc.set(r.vendorLabel, (vc.get(r.vendorLabel) || 0) + 1);
    const v = [...vc.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0][0];
    out.push(_mech(v + ' re-stamps ETCs daily; parts ETA is the open item', model));
  }
  return out;
}

/** mechanical(section, model) -> deterministic items (B8.3). Support items may carry `alts`. */
function mechanical(section, model) {
  const m = model || {};
  const cues = m.cues || {};
  const split = _line(m, 'down-cause split:');
  const arrival = _line(m, 'tech arrival (');
  const etcH = _line(m, 'ETC history (');
  const parts = _line(m, 'parts:');
  const theme = _s(m.themes && m.themes.text).split('\n').find((l) => l.startsWith('theme ')) || '';
  switch (section) {
    case 'answer': return [split, cues.arrival ? arrival : ''].filter(Boolean).map((t) => _mech(t, m));
    case 'trends': return [split, etcH, parts, cues.symptom ? theme : ''].filter(Boolean).map((t) => _mech(t, m));
    case 'actions': return _actions(m);
    case 'support': return _support(m).map((x) => (x.alts.length === 1 ? x.alts[0] : Object.assign({}, x.alts[0], { alts: x.alts })));
    case 'fasInput': return _fasInput(m);
    default: return [];
  }
}

/**
 * gateAnswer(parsed, built) -> { sections, removed, removals:[{ section, code }], mechanical:[section], diag }.
 * `parsed` from parseAnswer (or { ok:false } to go fully mechanical). Empty sections are filled
 * from mechanical(); a mechanical line that fails the gate is dropped (debug mech-drop).
 */
function gateAnswer(parsed, built) {
  const diag = [];
  const removals = [];
  const sections = {};
  const mechSections = [];
  let gateErr = false;
  const run = (it, sec) => {
    try { return checkItem(it, sec, built); } catch (_) { gateErr = true; return 'gate-error'; }
  };
  const p = parsed && parsed.ok ? parsed : null;
  for (const sec of SECTIONS) {
    const kept = [];
    for (const it of (p && Array.isArray(p[sec]) ? p[sec] : [])) {
      const code = run(it, sec);
      if (code) removals.push({ section: sec, code }); else kept.push(it);
    }
    if (!kept.length) {
      mechSections.push(sec);
      for (const it of mechanical(sec, built.model)) {
        if (it.system) { kept.push(it); continue; }
        const alts = it.alts || [it];
        const ok = alts.find((a) => !run(a, sec));
        if (ok) kept.push({ text: ok.text, units: ok.units, src: ok.src, team: ok.team });
        else diag.push({ code: 'mech-drop', level: 'debug' });
      }
      if (sec === 'actions' && !kept.length) {
        const ids = [...((built.model.fasLogs instanceof Map) ? built.model.fasLogs.entries() : [])].filter(([, l]) => l.length).map(([id]) => id);
        if (ids.length) {
          const it = { text: 'Unit notes for ' + ids.join(', ') + ' hold more detail (see Relay).', units: ids };
          if (!run(it, 'answer')) kept.push(it); else diag.push({ code: 'mech-drop', level: 'debug' });
        }
      }
    }
    sections[sec] = kept;
  }
  if (gateErr) diag.push({ code: 'gate-error', level: 'warn' });
  return { sections, removed: removals.length, removals, mechanical: mechSections, diag };
}

// ── Render (B10) ────────────────────────────────────────────────────────────
function _stamp(iso) {
  const ms = Date.parse(_s(iso));
  if (!Number.isFinite(ms)) return '';
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute + ' ' + _s(p.dayPeriod).toUpperCase() + ' ET';
}

function _cutBody(s, max) {
  if (s.length <= max) return s;
  if (max <= 1) return '';
  let cut = s.slice(0, max - 1);
  const sp = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (sp > 0) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:\-\u2013\u2014]+$/, '') + '\u2026';
}

/**
 * render(model, { surface, sections, removed, reason }) -> reply text (B10).
 * surface 'slack' (default) adds *bold* / _italic_ markers; 'fab' renders the same lines plain.
 */
function render(model, opts = {}) {
  const m = model || {};
  const o = opts || {};
  const fab = o.surface === 'fab';
  const bold = (s) => (fab ? s : '*' + s + '*');
  const ital = (s) => (fab ? s : '_' + s + '_');
  const sec = o.sections || m.sections || {};
  const removed = Number(o.removed != null ? o.removed : m.removed) || 0;
  const reason = o.reason != null ? o.reason : m.reason;
  const st = m.stats || {};
  const doms = (m.domiciles || []).join(', ');
  const up = st.uptime != null && Number.isFinite(Number(st.uptime)) ? ' \u00b7 ' + Number(st.uptime).toFixed(1) + '% uptime' : '';
  const head = [bold(_s(m.scac) + (doms ? ' (' + doms + ')' : '') + ' \u2014 carrier intel') + ' \u00b7 ' + (st.down || 0) + ' of ' + (st.total || 0) + ' down' + up + (m.boxTrucks ? ', box trucks' : '')];
  const stamp = _stamp(m.asOf);
  if (stamp) head.push(ital('Live fleet data as of ' + stamp));
  const header = head.join('\n');

  const items = {};
  for (const k of SECTIONS) items[k] = (Array.isArray(sec[k]) ? sec[k] : []).map((it) => Object.assign({}, it));
  const gaps = (Array.isArray(m.gaps) ? m.gaps : []).map((g) => Object.assign({}, g));

  const itemText = (it, k) => {
    const t = defangMentions(_s(it.text));
    if (it.system) return '\u2022 ' + ital(t);
    return '\u2022 ' + (k === 'support' && it.team ? '(' + it.team + ') ' : '') + t;
  };
  const zero = (st.down || 0) === 0 && !(m.records || []).length;
  const bodyOf = () => {
    const L = [];
    if (zero) {
      L.push('Nothing down at ' + _s(m.scac) + ' right now.');
      if (items.support.length) { L.push('\ud83c\udd98 ' + bold('Support Needed')); for (const it of items.support) L.push(itemText(it, 'support')); }
      return L.join('\n');
    }
    if (items.answer.length) L.push(bold('Answer:') + ' ' + items.answer.map((it) => defangMentions(_s(it.text))).join(' '));
    const block = (k, title) => { if (!items[k].length) return; L.push(title); for (const it of items[k]) L.push(itemText(it, k)); };
    block('trends', '\ud83d\udcc8 ' + bold('Trends'));
    block('actions', '\u2705 ' + bold('Actions'));
    block('support', '\ud83c\udd98 ' + bold('Support Needed'));
    block('fasInput', '\ud83d\udcdd ' + bold('FAS Input'));
    return L.join('\n');
  };
  const tailOf = () => {
    const L = [];
    if (gaps.length) { L.push('\u2139\ufe0f ' + bold('Not in the data:')); for (const g of gaps) L.push('\u2022 ' + defangMentions(_s(g.text))); }
    if (removed > 0) L.push(ital('Fact-check removed ' + removed + ' item(s) that cited details not in the data.'));
    if (!zero) L.push(reason ? ital('Mechanical summary from the extracted facts (' + reason + ').') : ital('AI analysis of extracted Relay/AAP facts.'));
    return L.join('\n');
  };
  const total = () => [header, bodyOf(), tailOf()].filter(Boolean).join('\n').length;

  if (total() > REPLY_MAX) {
    for (const k of ['fasInput', 'trends', 'actions', 'support']) {
      while (items[k].length > 1 && total() > REPLY_MAX) items[k].pop();
    }
    while (items.answer.length > 1 && total() > REPLY_MAX) items.answer.pop();
    while (total() > REPLY_MAX) {
      let i = -1;
      for (let j = gaps.length - 1; j >= 0; j--) if (gaps[j].kind === 'data' && gaps[j].id !== 'G-STALE') { i = j; break; }
      if (i < 0) i = gaps.findIndex((g) => g.kind === 'data');
      if (i < 0) break;
      gaps.splice(i, 1);
    }
  }
  const tail = tailOf();
  let body = bodyOf();
  const room = REPLY_MAX - header.length - tail.length - (body ? 2 : 1);
  if (body.length > room) body = _cutBody(body, Math.max(0, room));
  return [header, body, tail].filter(Boolean).join('\n');
}

module.exports = {
  parseAnswer, gateAnswer, checkItem, mechanical, render, clipQuote,
  SECTIONS, CAPS, REPLY_MAX, CI_FAS_QUOTE_MAX, CI_FAS_QUOTE_MIN, NO_FAS_LINE,
  CI_TIMES_RE, CI_ETC_VERB_RE, CI_LIST_SEP_RE, CI_RECUR_RE, CI_ETC_NUM_FIRST_RE, CI_MISS_WORD_RE, CI_ETC_WORD_RE,
  CI_MISS_NEG_RE, CI_COUNT_CATS, CI_UNIT_COUNT_RE, CI_CAUSE_COUNT_RE, CI_CLASS_RE, CI_NUM_TOKEN_RE, CI_NAME_ALLOW,
  CI_GENERIC_VENDOR_WORDS, CI_REASSIGN_CLAIM_RE, CI_DRIVER_CLAIM_RE, CI_CND_CLAIM_RE, CI_CLAIM_NEG_RE,
};
