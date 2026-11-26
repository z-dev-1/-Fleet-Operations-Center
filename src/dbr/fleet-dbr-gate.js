// Fleet DBR envelope gate — the only path from AI text to the 17 judgment cells (design §3
// outBudget, §5.1-§5.5, §11; plan.md R-M2, R-N4, R-N5, R-N6). Pure: no I/O, no clock (the caller
// passes `today` as 'YYYY-MM-DD'), no logging.
//
// Every AI prose entry (Details, ETC why, FAS Actions, Support ask, map fact) runs through
// gateEntry: E0 envelope shape, E1 unit IDs, E2 FAS provenance (src.fas date + verbatim quote on
// one [FAS] line), E3' prose tokens (dates, refs, tickets, URLs, $, relative dates, ETC-phrase
// dates) against the scoped units' evidence, E4 FAS-claim clauses (every field, `next:` never
// bypasses it), then the soft E6 names / E6b date-binding flags. reconcileEtc lets code own the
// ETC date math, mergeFinal merges review rounds per unit / per barrier, coverage guarantees one
// FAS line per down unit and renderCells is the only producer of AI cell strings.
'use strict';

const { extractJsonObject } = require('../utils/ai-json');
const { inferDate, etcMentionDates, etcKeywordNegated, parseTimelineLines, EXPECT_READY_RE, NOT_ETC_CONTEXT_RE } = require('./fleet-dbr');
const { FAS_ACT_SRC, normQuote, redactEvidence, textEvidence, EVID_PHONE_RE } = require('./fleet-dbr-evidence');

// ── Constants ───────────────────────────────────────────────────────────────
const FIELD_MAX = 16000;
const OUTPUT_TARGET_CHARS = 16000;
const ENV2 = 156;                 // "src":{"fas":[...]} with 2 items and 40-char quotes
const SUP_E = 220;                // one Support entry (ask <= 160, team, <= 2 IDs, keys)
const DETAIL_TEXT_MAX = 400;      // validator clip; render clips to detailCap
const SUPPORT_ASK_MAX = 200;      // validator clip (the contract states <= 160)
const MAP_COMPONENT_MAX = 60;
const MAP_SUPPORT_MAX = 4;
const UNBOUND_MAX = 30;
const ENV_ITEMS_MAX = 4;
const QUOTE_MIN = 8;
const QUOTE_MAX = 80;
const CONTRACT_ITEMS = 2;
const CONTRACT_QUOTE = 40;

const BARRIERS = Object.freeze([
  ['vendor1p', '1P Vendor Barrier'], ['oem', 'OEM Barrier'], ['estimate', 'Estimate Barrier'],
  ['partner', 'Partner Barrier'], ['parts', 'Parts Delay'], ['common', 'Common Repairs'],
].map(([id, label]) => Object.freeze({ id, label, ynCol: id + 'YN', detailsCol: id + 'Details' })));
const BARRIER_IDS = Object.freeze(BARRIERS.map((b) => b.id));
const SUPPORT_TEAMS = Object.freeze(['Uptime Manager', 'MCS', 'Carrier/DSP', 'OEM/dealer', 'Parts', 'Accidents/insurance', 'Vendor', 'Other']);
const SUPPORT_FAILED_TEXT = '\u26a0 AI support asks failed the fact check \u2014 review';
const YES_DROPPED_TEXT = '\u26a0 AI marked Yes but its supporting details failed the fact check \u2014 review: ';
const NO_REASON = '(no verified reason)';
const ETC_CELL_OF = Object.freeze({ today: 'etcToday', missed: 'missedEtc', none: 'noEtc', future: null });
// Fleet Health sheet cells (design §3.8, §5): validation and composer caps.
const SHEET_DETAILS_MAX = 230;
const SHEET_FAS_MAX = 240;
const SHEET_SUPPORT_MAX = 140;
const SHEET_MIN = 20;
const SHEET_CELL_IDS = Object.freeze(BARRIERS.map((b) => b.detailsCol).concat(['fasActions', 'support']));

// ── Regexes (§5.2) ──────────────────────────────────────────────────────────
const NO_FAS_RE = /^\s*No FAS action logged\b/i;
// D7: the "No FAS action logged" lead of a clause; the remainder is checked like any clause.
const NO_FAS_PREFIX_RE = /^\s*No FAS action logged\b[^,;\u2013\u2014-]*[,;\u2013\u2014-]?\s*/i;
const NEXT_PREFIX_RE = /^\s*next\s*:\s*/i;
const CLAUSE_SPLIT_RE = /;\s*|\.\s+(?=[A-Z])|\n+/;
// "I" only as a standalone word (I-Shift / I-81 are not a FAS subject). Case-sensitive "I".
const FAS_SUBJECT_RE = /\bFAS\b|(?<![\w-])I(?![\w-])|\b(?:[Ww]e|me|my|[Oo]ur)\b/;
// A clause led by an action verb, optionally after its date and a connector ("also escalated …").
const LEAD_DATE_SRC = '(?:\\d{1,2}[\\/.-]\\d{1,2}(?:[\\/.-]\\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?)';
const FAS_LEADVERB_RE = new RegExp('^\\s*(?:' + LEAD_DATE_SRC + '\\s*[-:,]?\\s*)?(?:(?:also|and|then|later|again|plus)\\s+)?(?:' + FAS_ACT_SRC + ')\\b', 'i');
const FAS_VERB_RE = new RegExp('\\b(' + FAS_ACT_SRC + ')\\b', 'i');
// Support voice: only FAS / I / we followed within 20 chars by an action verb is a claim.
const FAS_SUBJ_ACT_RE = new RegExp('(?:\\bFAS\\b|(?<![\\w-])I(?![\\w-])|\\b[Ww]e\\b)[^.;\\n]{0,20}?\\b(?:' + FAS_ACT_SRC + ')\\b');
// "today" is deliberately absent: the sheet uses "ETC for today".
const REL_DATE_RE = /\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(?:tomorrow|tonight|yesterday|next\s+week|this\s+week|end\s+of\s+(?:the\s+)?(?:day|week)|EOD|EOW|COB)\b/gi;
const BIND_KW_RE = /\b(?:parts?\s+eta|eta|bay|ready|ship(?:ped|ping|s)?|deliver(?:y|ed|ing)?|arriv(?:e|ed|al|ing))\b/gi;
const BIND_CLASS_RE = Object.freeze({ eta: /\beta\b/, bay: /\bbay\b/, ready: /\bready\b/, ship: /\bship/, deliver: /\bdeliver/, arriv: /\barriv/ });
// Short refs ("RO 4488", "RO-4488", "WR# 1234", "case 7712345"); the lookahead requires a digit,
// so "PO approval" / "claim filed" are not refs.
const REF_RE = /\b(?:RO|WO|WR|PO|SR|SIM|ASIST|case|ticket|claim|ref)\s*(?:#|-|no\.?|number)?\s*:?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,})\b/gi;
const ID_TOKEN_RE = /\b[A-Z]{1,4}\d{4,}[A-Z0-9]*\b|\b\d{5,}\b/g;
const TICKET_RE = /\b[a-z]{2,5}-[a-z0-9]{8,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
// "$4,800", "USD 4,800", "4800 dollars", "4,800 USD". The amount is group 1 or group 2.
const AMOUNT_RE = /(?:\$|\bUSD\b)\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s?(?:dollars|bucks|USD)\b/gi;
// ETC keywords; the date that follows (any form mdDates reads) is found by _etcPhraseDates.
// ETC/ETR uppercase-only (prose "etc." is not an ETC); the long phrases are case-insensitive.
const GATE_ETC_ABBR_RE = /\b(?:ETC|ETR)\b/g;
const GATE_ETC_PHRASE_RE = /\b(?:est(?:\.|imated)?\s+(?:time\s+of\s+)?completion|expected\s+completion|completion\s+(?:date|eta)|repair\s+eta|eta\s+(?:for|on)\s+(?:completion|repair))\b/gi;
const ETC_DATE_WINDOW = 25;
// "11/21" and "11 / 21" (one optional space either side of the slash).
const PROSE_MD_RE = /(?<![\d/])(\d{1,2}) ?\/ ?(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g;
const PROSE_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// Non-numeric date forms (review finding 1): month names either side of the day, dash and dot
// M-D / M.D, and a bare ordinal day after a date preposition ("by the 21st" -> today's month,
// previous month as an alternative). Every one of them goes through the same date rules as M/D.
const MONTH_SRC = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_NUM = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const ORD_SRC = '(?:st|nd|rd|th)';
// "Nov 21" / "Nov-21" and "21 Nov" / "21-Nov" (Excel's d-mmm display).
const PROSE_MONTH_DAY_RE = new RegExp('\\b(' + MONTH_SRC + ')\\.?(?:\\s{0,2}|-)(\\d{1,2})' + ORD_SRC + '?\\b(?:,?\\s+(\\d{4})\\b)?', 'gi');
// D8: no separator too ("parts ETA 21Nov"); the leading \b keeps "A12MAR5" out.
const PROSE_DAY_MONTH_RE = new RegExp('\\b(\\d{1,2})' + ORD_SRC + '?(?:\\s+(?:of\\s+)?|-|)(' + MONTH_SRC + ')\\b\\.?(?:,?\\s+(\\d{4})\\b)?', 'gi');
const PROSE_DASH_RE = /(?<![\w/.$#-])(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?(?![\w/-]|\.\d)/g;
const PROSE_DOT_RE = /(?<![\w/.$#,-])(\d{1,2})\.(\d{2})(?![\w/.%-])/g;
// A bare ordinal after a date preposition or an ETA / ETC / ETR / due keyword ("ETA 21st").
const PROSE_ORD_RE = new RegExp('\\b(?:on|by|until|till|before|after|since|from|the|eta|etc|etr|due)\\s+(?:the\\s+)?(\\d{1,2})' + ORD_SRC + '\\b'
  + '(?!\\s+(?:of\\b|' + MONTH_SRC + '|party|shift|time|thing|attempt|opinion|call|visit|try|tier|gen|generation|axle|floor|level|quarter|week|day|unit|truck|tow|reminder|follow|request|email|escalation|notice|round|stop|load|trip|bay|tech|vendor|place|option|line|step|one|set|part|pass|leg|row|wheel|position|cylinder|gear)\\b)', 'gi');
const FRACTION_UNIT_RE = /^\s{0,3}(?:ton|tons|units?|in|inch|ft|ft-lb|lb|lbs|psi|mm|gal|qt)\b/i;
// D8: a SPACED slash pair followed by a counted thing / done word is a count ("replaced 2 / 4 steer
// tires", "PM 1 / 2 done"). Unspaced pairs never use it ("11/21 tires replaced" stays a date).
const COUNT_AFTER_SPACED_RE = /^\s{0,3}(?:[a-z]+\s+)?(?:tires?|wheels?|axles?|bags?|lights?|mirrors?|doors?|batter(?:y|ies)|injectors?|plugs?|sensors?|bolts?|done|complete(?:d)?|finished|left|remaining|replaced)\b/i;
// Ranges / measures written M-D or M.D ("2-3 days", "1.25 hours") are not dates.
// "5-7 business days" / "3-4 more days" / "2-3 working days" too.
const RANGE_UNIT_RE = /^\s{0,3}(?:(?:business|working|calendar|more|additional|extra)\s+)?(?:ton|tons|units?|in|inch|ft|ft-lb|lb|lbs|psi|mm|gal|qt|days?|d|hours?|hrs?|h|weeks?|wks?|months?|mins?|minutes?|miles?|mi|km|k|trucks?|techs?|bays?|times?|x|percent|am|pm)\b|^\s{0,3}%/i;
// A dash/dot number pair right after a location noun is a range, not a date ("bay 3-4 open").
const RANGE_NOUN_BEFORE_RE = /\b(?:bays?|lanes?|doors?|stalls?|docks?|spots?|slots?|units?|trucks?|techs?|rows?|levels?)\s*$/i;
const ENV_DATE_RE = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*$/;
// Labelled typed refs (relay-extract §14.3.1). Group 1 = label, group 2 = value, group 3 = amz- tow/FleetNet id.
const TYPED_REF_RE = /\b(part\s*(?:#|no\.?|number)|p\/n|order\s*(?:#|no\.?|number)|r\.?o\.?\s*#|(?:sales\s?force|sf)\s*case\s*#?|asist\s*case\s*#?|case\s*#|dealer\s*code)\s*:?\s*((?=[A-Z0-9-]{0,24}\d)[A-Z0-9][A-Z0-9-]{2,24})\b|\b(amz-[a-z0-9]{12,})\b/gi;
const PARTS_LABEL_BEFORE_RE = /\bparts?\s+$/i;      // "Parts ETC 10/26": the keyword is parts-labelled
// Label -> typed kind(s) (typedIndex.byKind keys; 'case.*' = a case namespace).
const TYPED_LABEL_KINDS = Object.freeze([
  [/^(?:part|p\/n)/i, ['part']],
  [/^order/i, ['order']],
  [/^r\.?o/i, ['ro']],
  [/^(?:sales\s?force|sf)/i, ['case.salesforce']],
  [/^asist/i, ['case.decisivCase']],
  [/^case/i, ['case.salesforce', 'case.decisivCase', 'case.oemCase', 'case.unknown']],
  [/^dealer/i, ['dealerCode']],
].map(Object.freeze));
const TYPED_KINDS = Object.freeze(['part', 'order', 'ro', 'dealerCode', 'tow', 'fleetnet',
  'case.salesforce', 'case.decisivCase', 'case.oemCase', 'case.unknown']);
const EMAIL_MARKER_ALL_RE = /\s*\[em:[0-9a-f]{8}\]/gi;
const NAME_TOKEN_RE = /(?<![\w-])[A-Z][A-Za-z]{3,}\b/g;
const CLAUSE_START_RE = /^\s*(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*[-\u2013:,]?\s*$/;
const NAME_ALLOW = new Set([
  'fas', 'mcs', 'etc', 'etr', 'etas', 'oem', 'asist', 'afp', 'mmro', 'pmr', 'sla', 'dsp', 'none',
  'vendor', 'barrier', 'estimate', 'partner', 'parts', 'delay', 'common', 'repairs',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'sept', 'october', 'november', 'december',
  'monday', 'tuesday', 'tues', 'wednesday', 'thursday', 'thur', 'thurs', 'friday', 'saturday', 'sunday',
]);
// Sheet-cell patterns (design §3.8 shortIssue step 3, §5 rule (3)). DR2-8: the shared regexes carry
// the g flag, so .test() uses non-global copies built once here and replace / matchAll use fresh
// global copies; no lastIndex is ever shared between calls.
const _once = (re) => new RegExp(re.source, re.flags.replace('g', ''));
const _every = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
const SHEET_EMAIL_RE = /\S+@\S+\.\S+/;
const SHEET_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AMZ_ID_RE = /\bamz-[\w-]+/i;
const UPS_TRACKING_RE = /\b1Z[0-9A-Z]{16}\b/;
const LONG_DIGITS_RE = /\b\d{12,22}\b/;
const PAREN_DIGIT_RE = /\([^()]*\d[^()]*\)/g;
const HASH_TOKEN_RE = /#\S+/g;
const URL_1 = _once(URL_RE);
const REF_1 = _once(REF_RE);
const TICKET_1 = _once(TICKET_RE);
const TYPED_REF_1 = _once(TYPED_REF_RE);
const PHONE_1 = _once(EVID_PHONE_RE);
const SHEET_FORBIDDEN_RES = Object.freeze([URL_1, REF_1, TYPED_REF_1, SHEET_UUID_RE, SHEET_EMAIL_RE, PHONE_1, AMZ_ID_RE, UPS_TRACKING_RE, LONG_DIGITS_RE]);

// ── Helpers ─────────────────────────────────────────────────────────────────
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const _plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function _s(v) { return v == null ? '' : (typeof v === 'string' ? v : String(v)); }
function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Control chars and code fences stripped, every whitespace run (incl. newlines) -> one space.
function _clean(v) {
  let s = typeof v === 'string' ? v : '';
  s = s.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
function _clip(s, max) { return s.length > max ? (max > 1 ? s.slice(0, max - 1).trimEnd() + '\u2026' : '') : s; }
// Clip at a word boundary with "…" (result <= max).
function _clipWord(s, max) {
  if (s.length <= max) return s;
  if (max <= 1) return '';
  let cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.trimEnd() + '\u2026';
}
function _md(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}
function _mmdd(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? m[1] + '/' + m[2] : '';
}
function _classifyEtc(ymd, today) {
  if (!ymd) return 'none';
  if (ymd === today) return 'today';
  return ymd < today ? 'missed' : 'future';
}
function _amountOf(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : '';
}
function _bounded(tok, text, flags) {
  return new RegExp('(^|[^A-Za-z0-9])' + _escRe(tok) + '($|[^A-Za-z0-9])', flags || '').test(text);
}
function _splitClauses(text) { return text.split(CLAUSE_SPLIT_RE).filter((c) => c && c.trim()); }

function _ymdShift(ymd, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + months, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01';
}
// Every date the gate reads, in any written form: M/D[/Y] (fraction skip: "3/4 ton", "2/3 units",
// "10/12 ft-lb"), ISO, "Nov 21" / "Nov. 21st" / "November 21, 2026", "21 Nov" / "21st of November",
// "11-21" / "11.21" (range / measure skip: "2-3 days", "1.25 hours") and a bare ordinal after a
// date preposition ("by the 21st": today's month, `alts` = the previous month). Invalid month/day
// skipped. opts.loose (evidence side): no unit skips, lowercase "may" counts.
// -> [{ md: 'M/D', ymd, index, len, alts? }]
function mdDates(text, today, opts = {}) {
  const t = _s(text);
  const loose = !!opts.loose;
  const out = [];
  const taken = [];
  const free = (i, len) => !taken.some(([a, b]) => i < b && a < i + len);
  const push = (mo, da, y, index, len, extra) => {
    if (!free(index, len)) return;
    const ymd = inferDate(mo, da, y, today);
    if (!ymd) return;
    taken.push([index, index + len]);
    out.push(Object.assign({ md: (+mo) + '/' + (+da), ymd, index, len }, extra || {}));
  };
  const unitAfter = (re, m) => !loose && re.test(t.slice(m.index + m[0].length));
  let m;
  PROSE_ISO_RE.lastIndex = 0;
  while ((m = PROSE_ISO_RE.exec(t))) push(m[2], m[3], m[1], m.index, m[0].length);
  PROSE_MD_RE.lastIndex = 0;
  while ((m = PROSE_MD_RE.exec(t))) {
    if (unitAfter(FRACTION_UNIT_RE, m)) continue;
    if (/\s/.test(m[0]) && unitAfter(COUNT_AFTER_SPACED_RE, m)) continue;   // D8, !loose only (DR2-14)
    push(m[1], m[2], m[3], m.index, m[0].length);
  }
  for (const [re, moAt, daAt] of [[PROSE_MONTH_DAY_RE, 1, 2], [PROSE_DAY_MONTH_RE, 2, 1]]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const name = m[moAt];
      if (!loose && name === 'may') continue;            // the verb "may", not the month
      push(MONTH_NUM[name.slice(0, 3).toLowerCase()], m[daAt], m[3], m.index, m[0].length);
    }
  }
  PROSE_DASH_RE.lastIndex = 0;
  while ((m = PROSE_DASH_RE.exec(t))) {
    if (unitAfter(RANGE_UNIT_RE, m)) continue;
    if (!loose && RANGE_NOUN_BEFORE_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
    push(m[1], m[2], m[3], m.index, m[0].length);
  }
  PROSE_DOT_RE.lastIndex = 0;
  while ((m = PROSE_DOT_RE.exec(t))) {
    if (unitAfter(RANGE_UNIT_RE, m)) continue;
    push(m[1], m[2], undefined, m.index, m[0].length);
  }
  const tm = /^\d{4}-(\d{2})-\d{2}$/.exec(today || '');
  if (tm) {
    PROSE_ORD_RE.lastIndex = 0;
    while ((m = PROSE_ORD_RE.exec(t))) {
      const at = m.index + m[0].lastIndexOf(m[1]);
      const prev = _ymdShift(today, -1);
      const prevMo = prev ? +prev.slice(5, 7) : 0;
      push(+tm[1], m[1], undefined, at, m[0].length - (at - m.index), prevMo ? { alts: [prevMo + '/' + (+m[1])] } : null);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
// Every evidence date as 'M/D' (any form mdDates reads, loose).
function _evidenceDates(text, today) {
  const out = new Set();
  for (const d of mdDates(text, today, { loose: true })) out.add(d.md);
  return out;
}
function _dateAllowed(d, allowed) {
  return allowed.has(d.md) || (Array.isArray(d.alts) && d.alts.some((a) => allowed.has(a)));
}
// Dates within `window` chars after each match of `re`, skipping matches with `by` in the
// `notPrecededWithin` chars before them; nothing but non-digit, non-newline text may sit between
// the keyword and the date. -> [{ md, ymd, at }] (at = index of the date in text)
function _datesAfterAt(text, re, window, today, opts = {}) {
  const t = _s(text);
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(t))) {
    if (m[0].length === 0) rx.lastIndex += 1;
    if (opts.by && opts.notPrecededWithin && opts.by.test(t.slice(Math.max(0, m.index - opts.notPrecededWithin), m.index))) continue;
    const end = m.index + m[0].length;
    if (opts.skipKeyword && opts.skipKeyword(t, m.index, end)) continue;
    const d = mdDates(t.slice(end, end + window + 30), today, { loose: !!opts.loose })[0];
    if (!d || d.index > window || /[\n\d]/.test(t.slice(end, end + d.index))) continue;
    out.push({ md: d.md, ymd: d.ymd, at: end + d.index, alts: d.alts, kwAt: m.index });
  }
  return out;
}
function datesAfter(text, re, window, opts = {}) {
  const out = [];
  for (const d of _datesAfterAt(text, re, window, opts.today, Object.assign({ loose: true }, opts))) {
    if (!out.includes(d.md)) out.push(d.md);
  }
  return out;
}
// Dates written after an ETC keyword (ETC / ETR / "estimated completion" …), any date form.
// opts.positive: skip keywords the builder treats as negated ("ETC unknown, parts ETA 11/14",
// "no ETC yet; tech visit 11/13"), so the evidence ETC whitelist is never wider than etcMentionDates.
function _etcPhraseDates(text, today, opts = {}) {
  if (opts.positive) opts = Object.assign({}, opts, { skipKeyword: etcKeywordNegated });
  return [GATE_ETC_ABBR_RE, GATE_ETC_PHRASE_RE]
    .flatMap((re) => _datesAfterAt(text, re, ETC_DATE_WINDOW, today, opts));
}
function _refSet(text) {
  const out = new Set();
  for (const m of _s(text).matchAll(/[A-Za-z0-9-]{3,}/g)) {
    const t = m[0].toLowerCase();
    out.add(t);
    for (const p of t.split('-')) if (p.length >= 3) out.add(p);
    out.add(t.replace(/-/g, ''));
  }
  return out;
}
function _amounts(text) {
  const out = new Set();
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(text))) out.add(_amountOf(m[1] || m[2]));
  out.delete('');
  return out;
}
function _urls(text) {
  const out = new Set();
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(text))) out.add(m[0].replace(/[.,;:]+$/, ''));
  return out;
}

// ── Context (§5.1) ──────────────────────────────────────────────────────────
// Builder ids; units without an equipmentId get '(no id #1)', '(no id #2)' … in builder order.
function syntheticIds(units) {
  let k = 0;
  return (Array.isArray(units) ? units : []).map((u) => {
    const id = _s(u && u.id).trim();
    if (!id || id === '(no id)') { k += 1; return '(no id #' + k + ')'; }
    return id;
  });
}
function _newestTimelineLine(raw, today) {
  const lines = parseTimelineLines(raw && raw.repairTimeline, today).filter((l) => l.date)
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)));
  return lines.length ? lines[0].raw.trim() : '';
}

// { row, evidences, fleetIds, today, unitRows?, typed? } -> gate ctx. `evidences` is an array aligned with
// row.units (builder order) or an object keyed by downId; each is a fleet-dbr-evidence block as
// sent to the model (after allocate). `unitRows` (raw fleet rows) feeds the coverage line.
// `typed` (relay-extract §14.3.1) = { [unitId]: wo-facts.typedIndex(...) }: { tokenText, byKind:{part,
// order, ro, dealerCode, tow, fleetnet: Set, case:{salesforce, decisivCase, oemCase, unknown}: Set},
// etcRepair: Set<'M/D'>, partsDates: Set<'M/D'>, factIds }. Units with an entry turn ctx.strict on;
// without `typed` the returned ctx is exactly the pre-relay-extract object.
function gateContext({ row, evidences, fleetIds, today, unitRows, typed } = {}) {
  const r = row || {};
  const units = Array.isArray(r.units) ? r.units : [];
  const downIds = syntheticIds(units);
  const idMap = new Map(downIds.map((id) => [id.toLowerCase(), id]));
  const foreign = new Set();
  for (const x of Array.isArray(fleetIds) ? fleetIds : []) {
    const s = _s(x).trim();
    if (s && !idMap.has(s.toLowerCase())) foreign.add(s);
  }
  const raws = (Array.isArray(unitRows) ? unitRows : []).filter(_plainObj);
  const rawById = new Map();
  const rawNoId = [];
  for (const x of raws) {
    const id = _s(x.equipmentId).trim();
    if (id) { if (!rawById.has(id)) rawById.set(id, x); } else rawNoId.push(x);
  }
  const ctx = {
    today, downIds, idMap, foreign,
    unitEvidence: {}, lines: {}, fasLines: {}, fasDates: {}, dates: {}, etcDates: {},
    amounts: {}, urls: {}, refs: {}, codeEtc: {}, unitInfo: {}, rules: {},
  };
  let noId = 0;
  units.forEach((u, i) => {
    const id = downIds[i];
    const ev = Array.isArray(evidences) ? evidences[i] : (_plainObj(evidences) ? evidences[id] : null);
    const text = ev && typeof ev.text === 'function' ? ev.text() : '';
    ctx.unitEvidence[id] = text;
    // Line dates also read "Nov 14" / "11-14" wording (copies; the evidence objects are shared).
    ctx.lines[id] = (ev && Array.isArray(ev.lines) ? ev.lines : [])
      .map((l) => Object.assign({}, l, { mds: new Set([...(l.mds || []), ..._evidenceDates(_s(l.norm), today)]) }));
    ctx.fasLines[id] = ev && Array.isArray(ev.fasLines) ? ev.fasLines : [];
    ctx.fasDates[id] = ev && ev.fasDates instanceof Set ? ev.fasDates : new Set();
    ctx.dates[id] = _evidenceDates(text, today);
    ctx.etcDates[id] = new Set([
      ...etcMentionDates(text, today),
      ..._etcPhraseDates(text, today, { loose: true, positive: true }).map((d) => d.md),
      ...datesAfter(text, EXPECT_READY_RE, 25, { today, notPrecededWithin: 30, by: NOT_ETC_CONTEXT_RE }),
    ]);
    ctx.amounts[id] = _amounts(text);
    ctx.urls[id] = _urls(text);
    ctx.refs[id] = _refSet(text);
    ctx.codeEtc[id] = _plainObj(u && u.etc) ? u.etc : { state: 'none', date: null, source: null, snippet: '' };
    const isNoId = /^\(no id #\d+\)$/.test(id);
    const raw = isNoId ? rawNoId[noId++] : rawById.get(id);
    let latest = raw ? _newestTimelineLine(raw, today) : '';
    if (!raw && ev && Array.isArray(ev.segments)) {
      const seg = ev.segments.find((s) => s.kind === 'timeline' && s.lines && s.lines.length);
      if (seg) latest = seg.lines[0].text;
    }
    ctx.unitInfo[id] = {
      daysDown: u && u.daysDown != null ? u.daysDown : null,
      status: _s(u && u.status) || _s(raw && raw.savedRepairStatus),
      lifecycleReason: _s(u && u.lifecycleReason) || _s(raw && raw.lifecycleReason),
      vendor: _s(u && u.vendor) || _s(raw && raw.vendor),
      latest,
    };
  });
  const cells = _plainObj(r.cells) ? r.cells : {};
  // DR2-5: rules[b].units = the cell's unit set (builder order): the units whose barriers include b;
  // for common, the units of row.common.groups[].ids and row.common.repeat.
  const cm = _plainObj(r.common) ? r.common : {};
  const commonIds = new Set();
  for (const g of Array.isArray(cm.groups) ? cm.groups : []) for (const x of (g && Array.isArray(g.ids) ? g.ids : [])) commonIds.add(_s(x));
  for (const x of Array.isArray(cm.repeat) ? cm.repeat : []) commonIds.add(_s(x));
  const unitsOf = (pred) => downIds.filter((id, i) => pred(units[i] || {}));
  for (const b of BARRIERS) {
    const ids = b.id === 'common'
      ? unitsOf((u) => commonIds.has(_s(u.id)))
      : unitsOf((u) => Array.isArray(u.barriers) && u.barriers.includes(b.id));
    ctx.rules[b.id] = { yn: cells[b.ynCol] === 'Y' ? 'Y' : 'N', details: _s(cells[b.detailsCol]), units: ids };
  }
  if (_plainObj(typed)) _addTyped(ctx, typed, today);
  ctx.limits = limits(ctx);
  return ctx;
}

// relay-extract §14.3.1 (3): typed evidence per unit; inert for units without an entry.
function _addTyped(ctx, typed, today) {
  for (const id of ctx.downIds) {
    const ti = typed[id];
    if (!_plainObj(ti)) continue;
    if (!ctx.strict) { ctx.strict = true; ctx.typed = {}; ctx.repairEtcDates = {}; ctx.partsDates = {}; }
    ctx.typed[id] = ti;
    const text = ctx.unitEvidence[id] || '';
    const tt = _s(ti.tokenText);
    if (tt) {
      ctx.unitEvidence[id] = text + '\n' + tt;
      for (const d of _evidenceDates(tt, today)) ctx.dates[id].add(d);
      for (const x of _refSet(tt)) ctx.refs[id].add(x);
      for (const x of _amounts(tt)) ctx.amounts[id].add(x);
    }
    const partsLab = (t, s) => PARTS_LABEL_BEFORE_RE.test(t.slice(Math.max(0, s - 8), s));
    const rep = new Set(ti.etcRepair instanceof Set ? ti.etcRepair : []);
    for (const d of _etcPhraseDates(text, today, { loose: true, skipKeyword: (t, s, e) => etcKeywordNegated(t, s, e) || partsLab(t, s) })) rep.add(d.md);
    const parts = new Set(ti.partsDates instanceof Set ? ti.partsDates : []);
    for (const d of _etcPhraseDates(text, today, { loose: true, skipKeyword: (t, s, e) => etcKeywordNegated(t, s, e) || !partsLab(t, s) })) parts.add(d.md);
    ctx.repairEtcDates[id] = rep;
    ctx.partsDates[id] = parts;
    for (const d of (ti.etcRepair instanceof Set ? ti.etcRepair : [])) ctx.etcDates[id].add(d);
  }
}

// ── Limits (§5.4) and output budget (§3) ────────────────────────────────────
function _idLen(ids) { return Math.max(8, ...(ids || []).map((id) => _s(id).length)); }
function _lineCap(n, idLen) { return Math.max(100, Math.min(320, Math.floor(FIELD_MAX / Math.max(1, n)) - (2 + idLen + 2 + 1))); }
function _supportMax(n) { return _clamp(Math.ceil(Math.max(1, n) / 2), 5, 8); }

function limits(ctx) {
  const ids = (ctx && ctx.downIds) || [];
  const n = Math.max(1, ids.length);
  const idLen = _idLen(ids);
  const PREFIX = 2 + idLen + 2 + 1;              // "• " + ID + ": " + "\n"
  const lineCap = _lineCap(n, idLen);
  // Details cap from the ACTUAL rendered prefixes; validation caps cited refs per barrier at 2n.
  const detailCap = (entries, sumPrefix) => _clamp(Math.floor((FIELD_MAX - sumPrefix) / Math.max(1, entries)), 100, 400);
  // Missed ETC line: "• <ID> (ETC M/D): <why>\n", the first line is the count.
  const whyCap = (missed) => _clamp(Math.floor((FIELD_MAX - 10) / Math.max(1, missed)) - (PREFIX + 14), 60, 300);
  return {
    n, idLen, PREFIX, lineCap, detailCap, whyCap,
    contractDetailCap: detailCap(n, 5 * n + 2 * n * (idLen + 2)),
    supportMax: _supportMax(n),
  };
}

// Per-call contract-permitted output (field totals include keys and src). kind: 'single' |
// 'review' (n <= 16) | 'map' (n = batch size k <= 24) | 'reduce' | 'review-mr'.
// extra: { idLen = 12, hits = 0 (reduce / review-mr Details), g = 0 (review-mr gap lines),
// rowN = n (row unit count, for lineCap) }.
// At k >= 20 the reduce Details are limited by map fact length (factOut floor 40; the contract
// states the facts total and that the total wins).
function outBudget(kind, n, extra = {}) {
  const k = Math.max(1, n | 0);
  const idLen = extra.idLen || 12;
  const rowN = Math.max(1, extra.rowN || k);
  const kF = 18 + idLen;
  const kE = 33 + idLen;
  const lineCap = _lineCap(rowN, idLen);
  const supportMax = _supportMax(rowN);
  const detailOutMr = _clamp(Math.floor(9000 / Math.max(1, extra.hits || 0)) - 60, 60, 300);
  const b = {
    kind, n: k, idLen, kF, kE, ENV2, skeleton: 0,
    fasTotal: 0, fasEntryOut: 0, fasOut: 0,
    etcTotal: 0, whyTotal: 0, whyOut: 0,
    detTotal: 0, detailOut: 0, detMax: 0,
    supTotal: 0, supportMax: 0, askOut: 160,
    factFixed: 0, factTotal: 0, factOut: 0, componentOut: MAP_COMPONENT_MAX,
    envItems: CONTRACT_ITEMS, envQuote: CONTRACT_QUOTE, outputMax: OUTPUT_TARGET_CHARS,
  };
  if (kind === 'single' || kind === 'review') {
    b.skeleton = 1000;
    b.detTotal = 4000;
    b.detailOut = 300;
    b.detMax = Math.min(16, 6 * k);
    b.whyTotal = 1600;
    b.whyOut = 150;
    b.etcTotal = k * kE + b.whyTotal;
    b.supportMax = supportMax;
    b.supTotal = supportMax * SUP_E;
    b.fasTotal = OUTPUT_TARGET_CHARS - b.skeleton - b.detTotal - b.etcTotal - b.supTotal;
    b.fasEntryOut = Math.floor(b.fasTotal / k);
    b.fasOut = Math.min(lineCap, _clamp(b.fasEntryOut - kF - ENV2, 120, 280));
  } else if (kind === 'map') {
    b.skeleton = 600;
    b.fasOut = Math.min(lineCap, _clamp(Math.floor(3600 / k), 120, 280));
    b.fasEntryOut = kF + b.fasOut + ENV2;
    b.fasTotal = k * b.fasEntryOut;
    b.whyTotal = 1800;
    b.whyOut = 120;
    b.etcTotal = k * kE + b.whyTotal;
    b.supportMax = MAP_SUPPORT_MAX;
    b.askOut = 120;
    b.supTotal = MAP_SUPPORT_MAX * 180;
    b.factFixed = k * 70;
    b.factTotal = OUTPUT_TARGET_CHARS - b.skeleton - b.fasTotal - b.etcTotal - b.supTotal - b.factFixed;
    b.factOut = _clamp(Math.floor(b.factTotal / (1.5 * k)) - 35, 40, 300);   // R-N4
  } else if (kind === 'reduce') {
    b.skeleton = 600;
    b.supportMax = supportMax;
    b.supTotal = supportMax * SUP_E;
    b.detTotal = OUTPUT_TARGET_CHARS - b.skeleton - b.supTotal;
    b.detailOut = detailOutMr;
    b.detMax = 60;
  } else if (kind === 'review-mr') {
    const g = _clamp(extra.g | 0, 0, 16);
    b.skeleton = 600;
    b.g = g;
    b.fasOut = Math.min(lineCap, 200);
    b.fasEntryOut = kF + b.fasOut + ENV2;
    b.fasTotal = g * b.fasEntryOut;
    b.supportMax = supportMax;
    b.supTotal = supportMax * SUP_E;
    b.detTotal = OUTPUT_TARGET_CHARS - b.skeleton - b.supTotal - b.fasTotal;
    b.detailOut = detailOutMr;
    b.detMax = 40;
  } else {
    throw new Error('outBudget: unknown kind ' + kind);
  }
  b.total = b.skeleton + b.fasTotal + b.etcTotal + b.detTotal + b.supTotal + b.factFixed + b.factTotal;
  return b;
}

// ── E0 envelope (§3, §5.2) ──────────────────────────────────────────────────
// -> { ok:true, fas:[{date, quote, md, norm}], over, missing } | { ok:false, code:'bad-envelope' }
function parseEnvelope(src, field, today) {
  if (src === undefined || src === null) return { ok: true, fas: [], over: false, missing: true };
  if (!_plainObj(src)) return { ok: false, code: 'bad-envelope' };
  if (src.fas === undefined || src.fas === null) return { ok: true, fas: [], over: false, missing: false };
  if (!Array.isArray(src.fas) || src.fas.length > ENV_ITEMS_MAX) return { ok: false, code: 'bad-envelope' };
  const fas = [];
  for (const it of src.fas) {
    if (!_plainObj(it) || typeof it.date !== 'string' || typeof it.quote !== 'string') return { ok: false, code: 'bad-envelope' };
    const m = ENV_DATE_RE.exec(it.date);
    if (!m || !inferDate(m[1], m[2], m[3], today)) return { ok: false, code: 'bad-envelope' };
    const norm = normQuote(it.quote);
    if (norm.length < QUOTE_MIN || norm.length > QUOTE_MAX) return { ok: false, code: 'bad-envelope' };
    fas.push({ date: it.date.trim(), quote: it.quote, md: (+m[1]) + '/' + (+m[2]), norm });
  }
  const capped = field === 'fasActions' || field === 'details';
  const over = capped
    ? (fas.length > CONTRACT_ITEMS || fas.some((f) => f.norm.length > CONTRACT_QUOTE))
    : fas.length > 0;
  return { ok: true, fas, over, missing: false };
}

// E2: each item's date AND verbatim quote sit on ONE [FAS] line of a scoped unit.
function checkFas(env, scope, ctx) {
  for (const f of env.fas) {
    const hit = scope.some((u) => (ctx.fasLines[u] || []).some((l) => l.mds && l.mds.has(f.md) && _s(l.norm).includes(f.norm)));
    if (!hit) return 'unfounded-fas-action';
  }
  return null;
}

// R-M2: the ONE `next:` rule. A `next:` clause exists only in FAS Actions; it is a proposal only
// while it carries no past date. isNext relaxes the date rules only, never E4. Only the LAST
// clause of an entry can be the proposal (the contract's "Last 'next: <next step>'"): a `next:`
// mid-entry is ordinary text with its prefix removed. `last` defaults to true for a lone clause.
function nextClause(c, field, today, last = true) {   // -> { isNext, body }
  if (field !== 'fasActions' || !NEXT_PREFIX_RE.test(c)) return { isNext: false, body: c };
  const body = c.replace(NEXT_PREFIX_RE, '');
  if (!last) return { isNext: false, body };
  const past = mdDates(body, today).some((d) => d.ymd < today);
  return past ? { isNext: false, body } : { isNext: true, body };
}

// E3'(a): every prose date (any written form) is a scope evidence date / validated src.fas date
// (/ a why's reconciled ETC date), except a date >= today inside a FAS `next:` clause or in a
// Support ask.
function freeDateProblem(text, allowed, field, today) {
  const parts = field === 'fasActions' ? _splitClauses(text) : [text];
  for (let i = 0; i < parts.length; i++) {
    const { isNext, body } = nextClause(parts[i], field, today, i === parts.length - 1);
    for (const d of mdDates(body, today)) {
      if (_dateAllowed(d, allowed)) continue;
      if ((isNext || field === 'support') && d.ymd >= today) continue;
      return 'unknown-date';
    }
  }
  return null;
}

function _scopeText(scope, ctx) { return scope.map((u) => ctx.unitEvidence[u] || '').join('\n'); }
function _scopeUnion(scope, map) {
  const out = new Set();
  for (const u of scope) for (const v of (map[u] || [])) out.add(v);
  return out;
}

// E1 (part 'ids') and E3' (part 'tokens'); part 'all' runs both. opts: { field, allowed?,
// fasMds?, extraDates? }. -> null | drop code.
function proseTokens(text, scope, ctx, opts = {}) {
  const field = opts.field || 'details';
  const part = opts.part || 'all';
  const today = ctx.today;
  const ev = _scopeText(scope, ctx);
  let m;
  if (part === 'all' || part === 'ids') {
    ID_TOKEN_RE.lastIndex = 0;
    while ((m = ID_TOKEN_RE.exec(text))) {
      const tok = m[0];
      const canon = ctx.idMap.get(tok.toLowerCase());
      if (canon) { if (!scope.includes(canon)) return 'out-of-scope-id'; continue; }
      if (ctx.foreign.has(tok)) return 'foreign-id';
      if (!_bounded(tok, ev)) return 'unknown-ref';
    }
  }
  if (part === 'ids') return null;
  const fasMds = opts.fasMds || new Set();
  const extra = new Set(opts.extraDates || []);
  const allowed = opts.allowed || new Set([..._scopeUnion(scope, ctx.dates), ...fasMds, ...extra]);
  // (a) dates
  const dp = freeDateProblem(text, allowed, field, today);
  if (dp) return dp;
  // (b) refs, tickets, URLs, amounts
  const refs = _scopeUnion(scope, ctx.refs);
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text))) {
    const cap = m[1].toLowerCase();
    if (!refs.has(cap) && !refs.has(cap.replace(/-/g, ''))) return 'unknown-ref';
  }
  TICKET_RE.lastIndex = 0;
  while ((m = TICKET_RE.exec(text))) {
    if (/\d/.test(m[0]) && !_bounded(m[0], ev, 'i')) return 'unknown-ref';
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (!ev.includes(m[0].replace(/[.,;:]+$/, ''))) return 'unknown-ref';
  }
  const amounts = _scopeUnion(scope, ctx.amounts);
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text))) {
    if (!amounts.has(_amountOf(m[1] || m[2]))) return 'unknown-ref';
  }
  // (c) relative dates outside FAS `next:` clauses and Support asks
  if (field !== 'support') {
    const own = new Set([...mdDates(text, today).map((d) => d.md), ...fasMds]);
    const parts = field === 'fasActions' ? _splitClauses(text) : [text];
    for (let i = 0; i < parts.length; i++) {
      const { isNext, body } = nextClause(parts[i], field, today, i === parts.length - 1);
      if (isNext) continue;
      REL_DATE_RE.lastIndex = 0;
      while ((m = REL_DATE_RE.exec(body))) {
        const phrase = m[0].toLowerCase().replace(/\s+/g, ' ');
        const re = new RegExp('(^|[^a-z0-9])' + _escRe(phrase) + '($|[^a-z0-9])');
        const ok = scope.some((u) => (ctx.lines[u] || []).some((l) => re.test(_s(l.norm))
          && [...(l.mds || [])].some((d) => own.has(d))));
        if (!ok) return 'unknown-rel-date';
      }
    }
  }
  // (d) ETC-phrase dates (any date form) must be ETC dates of the scope (next: clauses included)
  const etc = new Set([..._scopeUnion(scope, ctx.etcDates), ...extra]);
  if (!ctx.strict) {
    for (const d of _etcPhraseDates(text, today)) {
      if (!_dateAllowed(d, etc)) return 'unknown-etc-date';
    }
  } else {
    // relay-extract strict branch: a parts date written as a repair ETC is dropped.
    const rep = _scopeUnion(scope, ctx.repairEtcDates || {});
    const parts = _scopeUnion(scope, ctx.partsDates || {});
    for (const d of _etcPhraseDates(text, today)) {
      const partsLab = PARTS_LABEL_BEFORE_RE.test(text.slice(Math.max(0, d.kwAt - 8), d.kwAt));
      if (partsLab) { if (_dateAllowed(d, parts) || _dateAllowed(d, etc)) continue; return 'unknown-etc-date'; }
      if (_dateAllowed(d, rep)) continue;
      if (_dateAllowed(d, parts)) return 'parts-date-as-etc';
      if (_dateAllowed(d, etc)) continue;
      return 'unknown-etc-date';
    }
  }
  return null;
}

// S6 (relay-extract, strict ctx only): a labelled ref must be typed as what its label says.
// -> { code } | { untyped: [value…] }
function typedRefProblem(text, scope, ctx) {
  const sets = {};
  for (const k of TYPED_KINDS) sets[k] = new Set();
  for (const u of scope) {
    const bk = ctx.typed && ctx.typed[u] && ctx.typed[u].byKind;
    if (!_plainObj(bk)) continue;
    for (const k of TYPED_KINDS) {
      const [a, b] = k.split('.');
      const s = b ? (bk[a] && bk[a][b]) : bk[a];
      for (const v of (s instanceof Set ? s : [])) sets[k].add(_s(v).toUpperCase());
    }
  }
  const refs = _scopeUnion(scope, ctx.refs);
  const ev = _scopeText(scope, ctx);
  const untyped = [];
  TYPED_REF_RE.lastIndex = 0;
  let m;
  while ((m = TYPED_REF_RE.exec(text))) {
    const raw = m[2] || m[3];
    let kinds;
    if (m[3]) kinds = ['tow', 'fleetnet'];
    else {
      const hit = TYPED_LABEL_KINDS.find(([re]) => re.test(m[1].trim()));
      kinds = hit ? hit[1] : [];
    }
    const X = raw.toUpperCase();
    const alts = [X, X.replace(/-/g, '')];
    const inKinds = (ks) => ks.some((k) => alts.some((x) => sets[k].has(x)));
    if (inKinds(kinds)) continue;
    if (inKinds(TYPED_KINDS.filter((k) => !kinds.includes(k)))) return { code: 'misclassified-ref' };
    if (alts.some((x) => refs.has(x.toLowerCase())) || _bounded(raw, ev, 'i')) { if (!untyped.includes(X)) untyped.push(X); continue; }
    return { code: 'unknown-ref' };
  }
  return { untyped };
}

function isFasClaim(c, field) {
  return field === 'support'
    ? (FAS_SUBJ_ACT_RE.test(c) || FAS_LEADVERB_RE.test(c))
    : (FAS_SUBJECT_RE.test(c) || FAS_LEADVERB_RE.test(c));
}

// The claimed FAS action verb of a claim clause ("called", "escalated", "followed" …, hyphens
// removed): the lead verb, else the verb right after a FAS / I / we subject. '' when the clause is
// a claim by subject alone ("FAS update 11/10: …").
const _verbKey = (v) => v.split(/\s+/)[0].toLowerCase().replace(/-/g, '');
function _claimVerb(body) {
  const m = FAS_LEADVERB_RE.exec(body) || FAS_SUBJ_ACT_RE.exec(body);
  const v = m ? FAS_VERB_RE.exec(m[0]) : null;
  return v ? _verbKey(v[1]) : '';
}
// A further action joined to the clause: ", also escalated", "and escalated", "and then emailed",
// " - escalated". A non-FAS verb after a comma ("bay confirmed for 11/12") is not one.
// D6: ", escalated" / "& escalated" / "/ escalated" are joined actions too.
const JOINED_ACT_RE = new RegExp('(?:(?:,\\s*|\\s+)(?:also|and(?:\\s+then)?|then|plus|later|again)\\s+|\\s*[,&/]\\s*|\\s[-\\u2013]\\s*)(' + FAS_ACT_SRC + ')\\b', 'gi');
// Every claimed FAS action verb of a claim clause: the lead / subject verb plus each joined action.
function _claimVerbs(body) {
  const out = [];
  const lead = _claimVerb(body);
  if (lead) out.push(lead);
  JOINED_ACT_RE.lastIndex = 0;
  let m;
  while ((m = JOINED_ACT_RE.exec(body))) {
    const v = _verbKey(m[1]);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// E4: every FAS-claim clause, in every field, carries a validated src.fas item on one of the
// clause's dates whose quote holds the clause's action verb (so "also escalated … 11/10" is not
// carried by a "called TA" quote). Never skipped for `next:` (R-M2): inside an isNext clause only
// the narrow subject+verb / lead-verb test applies.
function fasClaimProblem(text, env, field, today) {
  const fasMd = new Set(env.fas.map((f) => f.md));
  // D7 (relay-extract): no entry-level "needs src.fas or 'No FAS action logged'" rule; a claim-free
  // entry (status + party update + next:) is valid, and every claim clause is still checked below.
  if (field === 'fasActions' && NO_FAS_RE.test(text) && fasMd.size) return 'bad-envelope';
  const clauses = _splitClauses(text);
  for (let i = 0; i < clauses.length; i++) {
    let c = clauses[i];
    // D7: strip the "No FAS action logged" lead and check what follows it like any clause.
    if (NO_FAS_RE.test(c)) {
      c = c.replace(NO_FAS_PREFIX_RE, '');
      if (!c.trim()) continue;
    }
    const { isNext, body } = nextClause(c, field, today, i === clauses.length - 1);
    const claim = isNext ? (FAS_SUBJ_ACT_RE.test(body) || FAS_LEADVERB_RE.test(body)) : isFasClaim(body, field);
    if (!claim) continue;
    const mds = new Set(mdDates(body, today).map((d) => d.md));
    // Each claimed verb (lead and joined) needs its own src.fas quote on a clause date.
    const onDate = env.fas.filter((f) => mds.has(f.md));
    const verbs = _claimVerbs(body);
    const backed = onDate.length > 0
      && verbs.every((v) => onDate.some((f) => _bounded(v, _s(f.norm).replace(/-/g, ''), 'i')));
    if (!backed) return 'unfounded-fas-action';
  }
  return null;
}

// E6 (soft): capitalized names (>= 4 letters, not a clause's first word, not allow-listed) that
// no scoped evidence line contains. -> string[]
function nameFlags(text, scope, ctx) {
  const ev = _scopeText(scope, ctx);
  const out = [];
  NAME_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = NAME_TOKEN_RE.exec(text))) {
    const name = m[0];
    if (NAME_ALLOW.has(name.toLowerCase())) continue;
    const seg = text.slice(0, m.index).split(/;|\n|\.\s+|:\s+|\u2014|\(/).pop();
    if (CLAUSE_START_RE.test(seg)) continue;
    if (_bounded(name, ev, 'i') || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

// E6b (soft): a date within 25 chars after an ETA/bay/ready/ship/delivery/arrival keyword must sit
// on one scoped evidence line together with a word of that keyword class. Skips FAS `next:`
// clauses, Support asks and ETC-phrase dates. -> [{ date: 'MM/DD', kw: class }]
function dateBindingFlags(text, scope, ctx, field) {
  if (field === 'support') return [];
  const today = ctx.today;
  const out = [];
  const parts = field === 'fasActions' ? _splitClauses(text) : [text];
  for (let i = 0; i < parts.length; i++) {
    const { isNext, body } = nextClause(parts[i], field, today, i === parts.length - 1);
    if (isNext) continue;
    const etcIdx = new Set(_etcPhraseDates(body, today).map((e) => e.at));
    BIND_KW_RE.lastIndex = 0;
    let m;
    while ((m = BIND_KW_RE.exec(body))) {
      const end = m.index + m[0].length;
      const d = mdDates(body.slice(end, end + 35), today)[0];
      if (!d || d.index > 25 || etcIdx.has(end + d.index)) continue;
      const kw = m[0].toLowerCase();
      const cls = /eta$/.test(kw) ? 'eta' : (kw === 'bay' ? 'bay' : (kw === 'ready' ? 'ready'
        : (/^ship/.test(kw) ? 'ship' : (/^deliver/.test(kw) ? 'deliver' : 'arriv'))));
      const bound = scope.some((u) => (ctx.lines[u] || []).some((l) => l.mds && _dateAllowed(d, l.mds) && BIND_CLASS_RE[cls].test(_s(l.norm))));
      if (!bound) out.push({ date: _mmdd(d.ymd), kw: cls });
    }
  }
  return out;
}

// The full gate. -> { ok:true, text, fas:[{date, quote}], envOver, envMissing, names, unbound }
// | { ok:false, code, envOver, envMissing }. opts: { field, extraDates? }.
function gateEntry(text, src, scope, ctx, opts = {}) {
  const field = opts.field || 'details';
  const env = parseEnvelope(src, field, ctx.today);
  if (!env.ok) return { ok: false, code: env.code, envOver: false, envMissing: false };
  const fail = (code) => ({ ok: false, code, envOver: env.over, envMissing: env.missing });
  let p = proseTokens(text, scope, ctx, { field, part: 'ids' });
  if (p) return fail(p);
  p = checkFas(env, scope, ctx);
  if (p) return fail(p);
  const fasMds = new Set(env.fas.map((f) => f.md));
  p = proseTokens(text, scope, ctx, { field, part: 'tokens', fasMds, extraDates: opts.extraDates });
  if (p) return fail(p);
  let tp = null;
  if (ctx.strict) {
    tp = typedRefProblem(text, scope, ctx);
    if (tp.code) return fail(tp.code);
  }
  p = fasClaimProblem(text, env, field, ctx.today);
  if (p) return fail(p);
  const out = {
    ok: true, text,
    fas: env.fas.map((f) => ({ date: f.date, quote: f.quote })),
    envOver: env.over, envMissing: env.missing,
    names: nameFlags(text, scope, ctx),
    unbound: dateBindingFlags(text, scope, ctx, field),
  };
  if (tp) out.untyped = tp.untyped || [];
  return out;
}

// relay-extract §14.3.1 (7): gateEntry's stage order and codes minus E2/E4 (no [FAS] index or
// envelope outside DBR), for the timeline / trends consumers. opts: { field, ownDates }.
function gateProse(text, src, scope, ctx, opts = {}) {
  const field = opts.field || 'details';
  const env = parseEnvelope(src, field, ctx.today);
  if (!env.ok) return { ok: false, code: env.code };
  const p = proseTokens(text, scope, ctx, { field, part: 'all', fasMds: opts.ownDates ? new Set(opts.ownDates) : undefined });
  if (p) return { ok: false, code: p };
  const tp = ctx.strict ? typedRefProblem(text, scope, ctx) : {};
  if (tp.code) return { ok: false, code: tp.code };
  return { ok: true, text, names: nameFlags(text, scope, ctx), unbound: dateBindingFlags(text, scope, ctx, field), untyped: tp.untyped || [] };
}

// relay-extract §14.3.1 (8): a one-unit gate ctx over plain prompt text (timeline / trends).
function textContext({ text, today, typed, id = 'U' } = {}) {
  return gateContext({
    row: { units: [{ id }] }, evidences: [textEvidence(id, _s(text), today)], fleetIds: [], today,
    typed: typed ? { [id]: typed } : undefined,
  });
}

// ── Structural validation (§5.3) ────────────────────────────────────────────
function _meta() {
  return {
    removals: [], dropReasons: {}, envOver: 0, envMissing: 0, notGap: 0,
    etcReconciled: { dateUnknown: 0, reclassified: 0, filled: 0 },
  };
}
function _drop(meta, unit, field, code) {
  meta.removals.push({ unit: unit || '?', field, code });
  meta.dropReasons[code] = (meta.dropReasons[code] || 0) + 1;
}
function _countEnv(meta, g) {
  if (g.envOver) meta.envOver += 1;
  if (g.envMissing) meta.envMissing += 1;
}
// "<unit> · <field> · <code>" (FACT-CHECK REMOVED line; never any text).
function removalLine(r) { return r.unit + ' \u00b7 ' + r.field + ' \u00b7 ' + r.code; }

function _mapId(v, ctx) { return typeof v === 'string' ? (ctx.idMap.get(v.trim().toLowerCase()) || null) : null; }
function _mapUnits(v, ctx) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  const out = [];
  for (const x of list) { const id = _mapId(x, ctx); if (id && !out.includes(id)) out.push(id); }
  return out;
}
function _yn(v) {
  const s = _s(v).trim();
  if (/^(y|yes)$/i.test(s)) return 'Y';
  if (/^(n|no)$/i.test(s)) return 'N';
  return null;
}
function _team(v) {
  const s = _s(v).trim().toLowerCase();
  return SUPPORT_TEAMS.find((t) => t.toLowerCase() === s) || 'Other';
}

// ETC (§5.3 reconcileEtc). list: the AI `etc` array (anything else -> whole block computed).
// -> { entries: { [unit]: { state, date, why, origin, snippet, codeState, codeDate, disagree,
//      bucketMoved, override } }, invalid }
function reconcileEtc(list, ctx, opts = {}) {
  const meta = opts.meta || _meta();
  const units = opts.units || ctx.downIds;
  const today = ctx.today;
  const entries = {};
  const codeEntry = (u) => {
    const c = ctx.codeEtc[u] || {};
    const date = c.date || null;
    return {
      state: c.state || _classifyEtc(date, today), date, why: '', origin: 'code', snippet: _s(c.snippet),
      codeState: c.state || 'none', codeDate: date, disagree: null, bucketMoved: false, override: null,
    };
  };
  const invalid = !Array.isArray(list);
  if (!invalid) {
    const inBatch = new Set(units);
    for (const e of list) {
      if (!_plainObj(e)) continue;
      const u = _mapId(e.unit, ctx);
      if (!u || !inBatch.has(u) || entries[u]) continue;
      const code = codeEntry(u);
      const state = _s(e.state).trim().toLowerCase();
      if (!['today', 'missed', 'future', 'none'].includes(state)) continue;   // -> code fill below
      const why = _clean(e.why);
      const gateWhy = (extraMd, cellState) => {
        if (!why) return '';
        const g = gateEntry(why, e.src, [u], ctx, { field: 'etcWhy', extraDates: extraMd ? [extraMd] : [] });
        if (g.ok) { _countEnv(meta, g); return why; }
        _countEnv(meta, g);
        _drop(meta, u, ETC_CELL_OF[cellState] || 'etc', g.code);
        return null;
      };
      if (state === 'none') {
        if (code.codeDate) {
          const w = gateWhy('', 'none');
          if (!w) { entries[u] = code; continue; }            // empty / gated-out why: code wins
          entries[u] = Object.assign({}, code, {
            state: 'none', date: null, why: w, origin: 'ai', override: { unit: u, code: _mmdd(code.codeDate) },
          });
        } else {
          const w = gateWhy('', 'none');
          entries[u] = Object.assign({}, code, { state: 'none', date: null, why: w || '', origin: 'ai' });
        }
        continue;
      }
      const dm = ENV_DATE_RE.exec(_s(e.date));
      const ymd = dm ? inferDate(dm[1], dm[2], dm[3], today) : null;
      const md = ymd ? _md(ymd) : '';
      if (!ymd || !(ctx.etcDates[u] || new Set()).has(md)) {
        meta.etcReconciled.dateUnknown += 1;
        entries[u] = code;
        continue;
      }
      const st = _classifyEtc(ymd, today);
      if (st !== state) meta.etcReconciled.reclassified += 1;
      const w = gateWhy(md, st);
      const ent = Object.assign({}, code, { state: st, date: ymd, why: w || '', origin: 'ai' });
      if (code.codeDate && code.codeDate !== ymd) {
        ent.disagree = { unit: u, ai: _mmdd(ymd), code: _mmdd(code.codeDate) };
        ent.bucketMoved = st !== _classifyEtc(code.codeDate, today);   // R-N5
      }
      entries[u] = ent;
    }
  }
  for (const u of units) {
    if (entries[u]) continue;
    entries[u] = codeEntry(u);
    if (!invalid) meta.etcReconciled.filled += 1;
  }
  return { entries, invalid };
}

function _parse(input) {
  if (_plainObj(input)) return input;
  const obj = extractJsonObject(typeof input === 'string' ? input : '');
  return _plainObj(obj) ? obj : null;
}

// Gate a list of `{units|unit, text, src}`-ish entries for one Details barrier.
function _barrier(bo, b, ctx, meta, opts) {
  const yn = _plainObj(bo) ? _yn(bo.yn) : null;
  if (!yn) return { valid: false, yn: null, entries: [], cited: [], overLimit: false };
  const out = { valid: true, yn, entries: [], cited: [], overLimit: false };
  if (yn === 'N') return out;
  const n = ctx.downIds.length;
  if (typeof bo.details === 'string') { _drop(meta, '?', b.detailsCol, 'bad-shape'); return out; }
  const list = Array.isArray(bo.details) ? bo.details : [];
  let refs = 0;
  for (const e of list) {
    if (!_plainObj(e)) { _drop(meta, '?', b.detailsCol, 'bad-shape'); continue; }
    const units = _mapUnits(e.units, ctx);
    for (const u of units) if (!out.cited.includes(u)) out.cited.push(u);
    if (!units.length) { _drop(meta, '?', b.detailsCol, 'no-unit'); continue; }
    const label = units.join(', ');
    const text = _clean(e.text);
    if (text.length < 10) { _drop(meta, label, b.detailsCol, 'too-short'); continue; }
    const g = gateEntry(text, e.src, units, ctx, { field: 'details' });
    _countEnv(meta, g);
    if (!g.ok) { _drop(meta, label, b.detailsCol, g.code); continue; }
    if (opts.used.count >= opts.detMax || out.entries.length >= n || refs + units.length > 2 * n) {
      _drop(meta, label, b.detailsCol, 'over-limit');       // R-N6
      out.overLimit = true;
      continue;
    }
    opts.used.count += 1;
    refs += units.length;
    out.entries.push({ units, text: _clip(text, DETAIL_TEXT_MAX), fas: g.fas, names: g.names, unbound: g.unbound });
  }
  return out;
}

function _gateFas(entries, ctx, meta, opts = {}) {
  const lineCap = ctx.limits.lineCap;
  const fas = {};
  const dropped = {};
  for (const e of entries) {
    if (!_plainObj(e)) { _drop(meta, '?', 'fasActions', 'bad-shape'); continue; }
    const u = _mapId(e.unit, ctx);
    if (!u) { _drop(meta, '?', 'fasActions', 'no-unit'); continue; }
    if (opts.gap && !opts.gap.has(u)) { meta.notGap += 1; continue; }
    const text = _clean(e.text);
    if (!text) { _drop(meta, u, 'fasActions', 'too-short'); if (!fas[u]) dropped[u] = dropped[u] || 'too-short'; continue; }
    const g = gateEntry(text, e.src, [u], ctx, { field: 'fasActions' });
    _countEnv(meta, g);
    if (!g.ok) { _drop(meta, u, 'fasActions', g.code); if (!fas[u]) dropped[u] = dropped[u] || g.code; continue; }
    if (fas[u]) {
      fas[u] = {
        text: _clip(fas[u].text + '; ' + text, lineCap), fas: fas[u].fas.concat(g.fas),
        names: fas[u].names.concat(g.names), unbound: fas[u].unbound.concat(g.unbound),
      };
    } else {
      fas[u] = { text: _clip(text, lineCap), fas: g.fas, names: g.names, unbound: g.unbound };
      delete dropped[u];
    }
  }
  return { fas, dropped };
}

function _gateSupport(sup, ctx, meta, max) {
  if (typeof sup === 'string') {
    if (/^\s*none\s*$/i.test(sup)) return { mode: 'none', entries: [] };
    _drop(meta, '?', 'support', 'bad-shape');
    return { mode: 'failed', entries: [] };
  }
  if (!Array.isArray(sup)) return { mode: 'absent', entries: [] };
  if (!sup.length) return { mode: 'none', entries: [] };
  const entries = [];
  for (const e of sup) {
    if (!_plainObj(e)) { _drop(meta, '?', 'support', 'bad-shape'); continue; }
    const units = _mapUnits(e.units, ctx);
    const scope = units.length ? units : ctx.downIds.slice();
    const label = units.length ? units.join(', ') : '?';
    const ask = _clean(e.ask);
    if (ask.length < 5) { _drop(meta, label, 'support', 'too-short'); continue; }
    const g = gateEntry(ask, e.src, scope, ctx, { field: 'support' });
    _countEnv(meta, g);
    if (!g.ok) { _drop(meta, label, 'support', g.code); continue; }
    if (entries.length >= max) { _drop(meta, label, 'support', 'over-limit'); continue; }
    entries.push({ team: _team(e.team), ask: _clip(ask, SUPPORT_ASK_MAX), units, fas: g.fas, names: g.names, unbound: g.unbound });
  }
  return { mode: entries.length ? 'list' : 'failed', entries };
}

// AI answer (string or object) -> gated draft | { ok:false, code:'ai-invalid'|'ai-empty' }.
// opts.kind: 'row' (single draft / single review: barriers, etc, fasActions, support) |
// 'reduce' (barriers, support) | 'review-mr' (barriers, support, fasActions for opts.gapUnits only).
// Unknown keys (hard cells included) are ignored.
function validateRowDraft(input, ctx, opts = {}) {
  const kind = opts.kind || 'row';
  const obj = _parse(input);
  if (!obj) return { ok: false, code: 'ai-invalid' };
  const meta = _meta();
  const n = ctx.downIds.length;
  const budgetKind = kind === 'row' ? 'single' : kind;
  const detMax = opts.detMax || outBudget(budgetKind, n, { idLen: ctx.limits.idLen }).detMax;
  const used = { count: 0 };
  const barriers = {};
  const bo = _plainObj(obj.barriers) ? obj.barriers : {};
  for (const b of BARRIERS) barriers[b.id] = _barrier(bo[b.id], b, ctx, meta, { detMax, used });

  let etc = null;
  let etcBlockInvalid = false;
  if (kind === 'row') {
    const rec = reconcileEtc(obj.etc, ctx, { meta });
    etc = rec.entries;
    etcBlockInvalid = rec.invalid;
  }

  let fas = {};
  let fasDropped = {};
  if (kind === 'row' || kind === 'review-mr') {
    const gap = kind === 'review-mr' ? new Set((opts.gapUnits || []).map((u) => _mapId(u, ctx)).filter(Boolean)) : null;
    if (typeof obj.fasActions === 'string') {
      _drop(meta, '?', 'fasActions', 'bad-shape');
    } else if (Array.isArray(obj.fasActions)) {
      const r = _gateFas(obj.fasActions, ctx, meta, { gap });
      fas = r.fas;
      fasDropped = r.dropped;
    }
  }

  const support = _gateSupport(obj.support, ctx, meta, ctx.limits.supportMax);

  const anyBarrier = BARRIER_IDS.some((b) => barriers[b].valid);
  const anyEtc = !!etc && Object.values(etc).some((e) => e.origin === 'ai');
  const anyFas = Object.keys(fas).length > 0;
  if (kind === 'row' && !anyBarrier && !anyEtc && !anyFas) return { ok: false, code: 'ai-empty', meta };
  if (kind !== 'row' && !anyBarrier && !anyFas && (support.mode === 'absent' || support.mode === 'failed')) {
    return { ok: false, code: 'ai-empty', meta };
  }
  return { ok: true, kind, barriers, etc, etcBlockInvalid, fas, fasDropped, support, meta };
}

// Map-phase validation (§5.3a). batchIds: this batch's down IDs.
// -> { ok:true, units: { [id]: { unit, missing, component, barriers:{[b]:{hit, fact, fas}},
//      fasAction:{text, fas, names, unbound}|null, fasItems, etc, support } }, order, meta }
//    | { ok:false, code:'ai-invalid' }
function validateMapFacts(input, batchIds, ctx) {
  const obj = _parse(input);
  if (!obj || !Array.isArray(obj.units)) return { ok: false, code: 'ai-invalid' };
  const meta = _meta();
  const order = (Array.isArray(batchIds) ? batchIds : []).map((u) => _mapId(u, ctx)).filter(Boolean);
  const batch = new Set(order);
  const units = {};
  const etcList = [];
  for (const e of obj.units) {
    if (!_plainObj(e)) { _drop(meta, '?', 'mapFact', 'bad-shape'); continue; }
    const id = _mapId(e.unit, ctx);
    if (!id || !batch.has(id)) { _drop(meta, '?', 'mapFact', 'no-unit'); continue; }
    if (units[id]) continue;
    const u = { unit: id, missing: false, component: '', barriers: {}, fasAction: null, fasItems: [], etc: null, support: [] };
    const comp = _clean(e.component);
    if (comp && !mdDates(comp, ctx.today).length && !_hasRefToken(comp)) u.component = _clip(comp, MAP_COMPONENT_MAX);
    const bs = _plainObj(e.barriers) ? e.barriers : {};
    for (const b of BARRIERS) {
      const x = bs[b.id];
      if (!_plainObj(x)) continue;
      const hit = x.hit === true || /^(true|y|yes)$/i.test(_s(x.hit).trim());
      let fact = _clean(x.fact);
      let fas = [];
      if (fact) {
        const g = gateEntry(fact, x.src, [id], ctx, { field: 'mapFact' });
        _countEnv(meta, g);
        if (g.ok) { fact = _clip(fact, DETAIL_TEXT_MAX); fas = g.fas; u.fasItems.push(...g.fas); } else { _drop(meta, id, b.detailsCol, g.code); fact = ''; }
      }
      u.barriers[b.id] = { hit, fact, fas };
    }
    if (typeof e.fasAction === 'string') {
      _drop(meta, id, 'fasActions', 'bad-shape');
    } else if (_plainObj(e.fasAction)) {
      const r = _gateFas([Object.assign({}, e.fasAction, { unit: id })], ctx, meta);
      if (r.fas[id]) { u.fasAction = r.fas[id]; u.fasItems.unshift(...r.fas[id].fas); }
    }
    if (_plainObj(e.etc)) etcList.push(Object.assign({}, e.etc, { unit: id }));
    if (Array.isArray(e.support)) {
      for (const s of e.support) {
        if (!_plainObj(s)) continue;
        const ask = _clean(s.ask);
        if (ask.length < 5) continue;
        const g = gateEntry(ask, s.src, [id], ctx, { field: 'support' });
        _countEnv(meta, g);
        if (!g.ok) { _drop(meta, id, 'support', g.code); continue; }
        if (u.support.length >= MAP_SUPPORT_MAX) { _drop(meta, id, 'support', 'over-limit'); continue; }
        u.support.push({ team: _team(s.team), ask: _clip(ask, SUPPORT_ASK_MAX), units: [id], fas: g.fas, names: g.names, unbound: g.unbound });
      }
    }
    units[id] = u;
  }
  for (const id of order) {
    if (!units[id]) units[id] = { unit: id, missing: true, component: '', barriers: {}, fasAction: null, fasItems: [], etc: null, support: [] };
  }
  const rec = reconcileEtc(etcList, ctx, { units: order, meta });
  for (const id of order) units[id].etc = rec.entries[id];
  return { ok: true, units, order, meta };
}
function _hasRefToken(s) {
  REF_RE.lastIndex = 0;
  ID_TOKEN_RE.lastIndex = 0;
  AMOUNT_RE.lastIndex = 0;
  TICKET_RE.lastIndex = 0;
  return REF_RE.test(s) || ID_TOKEN_RE.test(s) || AMOUNT_RE.test(s) || /\d/.test((s.match(TICKET_RE) || []).join(''));
}

// ── Merge (§7 mergeFinal) ───────────────────────────────────────────────────
// cur, next: gated drafts. mode: 'single' | 'mapreduce'. Per unit and per barrier.
function mergeFinal(cur, next, mode) {
  if (!next || !next.ok) return cur;
  const barriers = {};
  for (const b of BARRIER_IDS) {
    const c = cur.barriers[b];
    const x = next.barriers[b];
    if (!x || !x.valid) barriers[b] = c;
    else if (x.yn === 'N' || x.entries.length) barriers[b] = x;
    else if (c && c.valid && c.yn === 'Y' && c.entries.length) barriers[b] = Object.assign({}, x, { entries: c.entries, overLimit: c.overLimit });
    else barriers[b] = x;
  }
  let etc = cur.etc;
  let etcBlockInvalid = cur.etcBlockInvalid;
  const fas = Object.assign({}, cur.fas);
  const fasDropped = Object.assign({}, cur.fasDropped);
  if (mode === 'single') {
    if (next.etc) {
      etc = {};
      const ids = new Set([...Object.keys(cur.etc || {}), ...Object.keys(next.etc)]);
      for (const u of ids) {
        const nx = next.etc[u];
        const cu = cur.etc && cur.etc[u];
        etc[u] = (nx && nx.origin === 'ai') ? nx : (cu || nx);
      }
      etcBlockInvalid = !!cur.etcBlockInvalid && !!next.etcBlockInvalid;
    }
    for (const u of Object.keys(next.fasDropped || {})) if (!fas[u]) fasDropped[u] = next.fasDropped[u];
    for (const u of Object.keys(next.fas || {})) { fas[u] = next.fas[u]; delete fasDropped[u]; }
  } else {
    // map/reduce: cur's (map) entry for every unit; next's only for gap units (validateRowDraft
    // with kind 'review-mr' keeps only gap-unit entries).
    for (const u of Object.keys(next.fas || {})) if (!fas[u]) { fas[u] = next.fas[u]; delete fasDropped[u]; }
  }
  const support = (next.support && (next.support.mode === 'list' || next.support.mode === 'none')) ? next.support : cur.support;
  const meta = _meta();
  for (const m of [cur.meta, next.meta]) {
    if (!m) continue;
    meta.removals.push(...m.removals);
    for (const [k, v] of Object.entries(m.dropReasons)) meta.dropReasons[k] = (meta.dropReasons[k] || 0) + v;
    meta.envOver += m.envOver;
    meta.envMissing += m.envMissing;
    meta.notGap += m.notGap;
    for (const k of Object.keys(meta.etcReconciled)) meta.etcReconciled[k] += (m.etcReconciled[k] || 0);
  }
  return Object.assign({}, cur, { barriers, etc, etcBlockInvalid, fas, fasDropped, support, meta });
}

// ── Coverage (§5.4) ─────────────────────────────────────────────────────────
// Word-boundary cut with NO ellipsis (D7). '' when fewer than 3 chars would remain.
function _cutWord(s, max) {
  const t = _s(s).trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, Math.max(0, max));
  const sp = cut.lastIndexOf(' ');
  if (sp > 0) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:\-\u2013\u2014]+$/, '');
  return cut.length >= 3 ? cut : '';
}
// D7 coverage marker from STRUCTURED fields only (never timeline / conversation text):
// '⚠ <n>d, <status>, <vendor> — awaiting update (review)' or '⚠ needs review'.
function _codeLine(info, lineCap) {
  const red = (s) => redactEvidence(_clean(_s(s).replace(EMAIL_MARKER_ALL_RE, '')));
  const days = info.daysDown == null ? '' : String(info.daysDown) + 'd';
  const status = _cutWord(red(info.status || info.lifecycleReason), 40);
  const vendor = _cutWord(red(info.vendor), 30);
  const head = [days, status, vendor].filter(Boolean).join(', ');
  const W = '\u26a0 ';
  const tail = ' \u2014 awaiting update (review)';
  const line = head ? W + head + tail : W + 'needs review';
  if (!lineCap || line.length <= lineCap) return line;
  const h = head ? _cutWord(head, Math.max(0, lineCap - W.length - tail.length)) : '';
  return h ? W + h + tail : W + 'needs review';
}
// Every down unit without a surviving FAS entry gets a code-built ⚠ line from its own (redacted)
// fields. Idempotent. -> draft with coverageFilled.
function coverage(draft, ctx) {
  const fas = Object.assign({}, draft.fas);
  const filled = (draft.coverageFilled || []).slice();
  for (const u of ctx.downIds) {
    if (fas[u]) continue;
    fas[u] = { text: _codeLine(ctx.unitInfo[u] || {}, ctx.limits.lineCap), fas: [], names: [], unbound: [], coverage: true };
    if (!filled.includes(u)) filled.push(u);
  }
  return Object.assign({}, draft, { fas, coverageFilled: filled });
}

// ── Rendering (§5.5) ────────────────────────────────────────────────────────
// Clip text, never lines. items: [{ prefix, text }]; head: optional first line.
function _joinLines(head, items, cap, ctx) {
  const build = (c) => (head != null ? [head] : []).concat(items.map((i) => i.prefix + _clipWord(i.text, c))).join('\n');
  let s = build(cap);
  if (s.length > FIELD_MAX && items.length) {
    const c2 = Math.max(10, Math.floor(FIELD_MAX / items.length) - ctx.limits.PREFIX - 2 * ctx.limits.idLen);
    s = build(Math.min(cap, c2));
  }
  return s;
}

// gated (merged) draft -> { cells, flags, sources, etcUnits, etcDisagreements, etcOverrides,
// provenance, unverifiedNames, unboundDates, coverageFilled, disagreements, removals,
// dropReasons, etcReconciled, envOver, envMissing }. `cells` holds exactly the 17 AI cells.
function renderCells(draft, ctx) {
  const d = coverage(draft, ctx);
  const L = ctx.limits;
  const order = new Map(ctx.downIds.map((id, i) => [id, i]));
  const cells = {};
  const flags = {};
  const sources = {};
  const provenance = {};
  const unverifiedNames = [];
  const unboundDates = [];
  const disagreements = [];
  const flag = (id) => { flags[id] = 'review'; };
  const soft = (e, cell) => {
    for (const name of e.names || []) { unverifiedNames.push({ name, units: e.units || [e.unit], cell }); flag(cell); }
    for (const ub of e.unbound || []) {
      if (unboundDates.length < UNBOUND_MAX) unboundDates.push({ unit: (e.units || [e.unit]).join(', '), cell, date: ub.date, kw: ub.kw });
      flag(cell);
    }
  };
  const prov = (cell, units, fas) => {
    if (!fas || !fas.length) return;
    provenance[cell] = provenance[cell] || {};
    for (const u of units) provenance[cell][u] = (provenance[cell][u] || []).concat(fas.map((f) => ({ date: f.date, quote: f.quote })));
  };

  for (const b of BARRIERS) {
    const bar = d.barriers && d.barriers[b.id];
    const rules = ctx.rules[b.id] || { yn: 'N', details: '' };
    if (!bar || !bar.valid) {
      cells[b.ynCol] = rules.yn;
      cells[b.detailsCol] = rules.details;
      sources[b.ynCol] = sources[b.detailsCol] = 'computed';
      flag(b.ynCol);
      flag(b.detailsCol);
      continue;
    }
    cells[b.ynCol] = bar.yn;
    sources[b.ynCol] = 'ai';
    sources[b.detailsCol] = 'ai';
    if (bar.yn !== rules.yn) disagreements.push(b.id);
    if (bar.yn === 'N') {
      cells[b.detailsCol] = '';
      if (rules.yn === 'Y') flag(b.ynCol);                 // AC37: AI N hides a rules-Y barrier
    } else if (bar.entries.length) {
      const ents = bar.entries.map((e, i) => ({ e, i, k: Math.min(...e.units.map((u) => (order.has(u) ? order.get(u) : 1e9))) }))
        .sort((a, b2) => a.k - b2.k || a.i - b2.i).map((x) => x.e);
      const items = ents.map((e) => ({ prefix: '\u2022 ' + e.units.join(', ') + ': ', text: e.text }));
      const sumPrefix = items.reduce((s, it) => s + it.prefix.length + 1, 0);
      cells[b.detailsCol] = _joinLines(null, items, L.detailCap(items.length, sumPrefix), ctx);
      for (const e of ents) { soft(e, b.detailsCol); prov(b.detailsCol, e.units, e.fas); }
    } else {
      flag(b.ynCol);
      flag(b.detailsCol);
      if (rules.yn === 'Y') { cells[b.detailsCol] = rules.details; sources[b.detailsCol] = 'computed'; } else {
        cells[b.detailsCol] = YES_DROPPED_TEXT + (bar.cited && bar.cited.length ? bar.cited.join(', ') : 'no units cited');
      }
    }
    if (bar.overLimit) flag(b.detailsCol);                 // R-N6
  }

  // ETC: code owns the counts.
  const etc = {};
  for (const u of ctx.downIds) {
    etc[u] = (d.etc && d.etc[u]) || reconcileEtc([], ctx, { units: [u] }).entries[u];
  }
  const by = { today: [], missed: [], future: [], none: [] };
  for (const u of ctx.downIds) (by[etc[u].state] || by.none).push(u);
  cells.etcToday = String(by.today.length);
  cells.noEtc = String(by.none.length);
  const missedItems = by.missed.map((u) => {
    const e = etc[u];
    const why = e.origin === 'ai' ? (e.why || NO_REASON) : (e.snippet ? "'" + e.snippet + "'" : NO_REASON);
    return { prefix: '\u2022 ' + u + ' (ETC ' + _md(e.date) + '): ', text: why };
  });
  cells.missedEtc = _joinLines(String(by.missed.length), missedItems, L.whyCap(by.missed.length), ctx);
  const etcSrc = d.etcBlockInvalid || !d.etc ? 'computed' : 'ai';
  sources.etcToday = sources.noEtc = sources.missedEtc = etcSrc;
  if (d.etcBlockInvalid) { flag('etcToday'); flag('noEtc'); flag('missedEtc'); }
  const etcDisagreements = [];
  const etcOverrides = [];
  for (const u of ctx.downIds) {
    const e = etc[u];
    if (e.disagree) {
      etcDisagreements.push(e.disagree);
      const cell = ETC_CELL_OF[e.state];
      if (e.bucketMoved && cell) flag(cell);               // R-N5: the cell that gained the unit
    }
    if (e.override) etcOverrides.push(e.override);
  }
  const etcUnits = ctx.downIds.map((u) => ({
    unit: u, state: etc[u].state, date: etc[u].date ? _md(etc[u].date) : '', origin: etc[u].origin,
    why: etc[u].origin === 'ai' ? etc[u].why : (etc[u].snippet || ''),
  }));

  // FAS Actions: one line per down unit, builder order.
  const fasItems = ctx.downIds.map((u) => ({ prefix: '\u2022 ' + u + ': ', text: d.fas[u].text }));
  cells.fasActions = _joinLines(null, fasItems, L.lineCap, ctx);
  sources.fasActions = 'ai';
  for (const u of ctx.downIds) {
    const e = d.fas[u];
    if (e.coverage) flag('fasActions');
    soft(Object.assign({ unit: u }, e), 'fasActions');
    prov('fasActions', [u], e.fas);
  }

  // Support.
  const sup = d.support || { mode: 'absent', entries: [] };
  sources.support = 'ai';
  if (sup.mode === 'list' && sup.entries.length) {
    const items = sup.entries.map((e) => ({ prefix: '\u2022 ' + e.team + ': ', text: e.ask + (e.units.length ? ' (' + e.units.join(', ') + ')' : '') }));
    cells.support = _joinLines(null, items, SUPPORT_ASK_MAX + 120, ctx);
    for (const e of sup.entries) soft(e, 'support');
  } else if (sup.mode === 'none') {
    cells.support = 'None';
  } else {
    cells.support = SUPPORT_FAILED_TEXT;
    flag('support');
  }

  const meta = d.meta || _meta();
  return {
    cells, flags, sources, etcUnits, etcDisagreements, etcOverrides, provenance, unverifiedNames, unboundDates,
    coverageFilled: d.coverageFilled || [], disagreements,
    removals: meta.removals, dropReasons: meta.dropReasons, etcReconciled: meta.etcReconciled,
    envOver: meta.envOver, envMissing: meta.envMissing, notGap: meta.notGap,
  };
}

// ── Sheet cells (design §3.8, §3.9, §5) ─────────────────────────────────────
function _hasTicket(t) {
  return TICKET_1.test(t) && [...t.matchAll(_every(TICKET_RE))].some((m) => /\d/.test(m[0]));
}
// Rules (3) and (4) of §5 for one sheet cell: 'sheet-forbidden' for a link, ref, ticket, UUID,
// email, phone, amz- id, UPS tracking number, 12-22 digit run or bullet; 'sheet-ref' for an
// ID_TOKEN_RE token that is not a down unit id; else null. Shared by the composer self-check and
// validateSheet.
function sheetForbidden(text, downIds) {
  const t = _s(text);
  if (!t) return null;
  if (t.includes('\u2022') || SHEET_FORBIDDEN_RES.some((re) => re.test(t)) || _hasTicket(t)) return 'sheet-forbidden';
  const ids = new Set((Array.isArray(downIds) ? downIds : []).map((x) => _s(x).trim().toLowerCase()));
  for (const m of t.matchAll(_every(ID_TOKEN_RE))) if (!ids.has(m[0].toLowerCase())) return 'sheet-ref';
  return null;
}
// shortIssue step 3: every ref / id / contact token removed whole (label and number together), then
// doubled spaces and dangling punctuation collapsed.
function stripRefs(text) {
  let s = _s(text);
  const cut = (re) => { s = s.replace(_every(re), ' '); };
  cut(URL_RE);
  cut(SHEET_EMAIL_RE);
  cut(UUID_RE);
  cut(EVID_PHONE_RE);
  s = s.replace(PAREN_DIGIT_RE, ' ');
  cut(TYPED_REF_RE);
  cut(AMZ_ID_RE);
  cut(REF_RE);
  s = s.replace(_every(TICKET_RE), (m) => (/\d/.test(m) ? ' ' : m));
  cut(UPS_TRACKING_RE);
  cut(LONG_DIGITS_RE);
  cut(ID_TOKEN_RE);
  s = s.replace(HASH_TOKEN_RE, ' ');
  return s.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,;:.!?])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/^[\s,;:\-\u2013\u2014]+|[\s,;:\-\u2013\u2014]+$/g, '').trim();
}

const _SHEET_FIELD = (id) => (id === 'fasActions' ? 'fasActions' : (id === 'support' ? 'support' : 'details'));
// One AI sheet cell -> { text } | { code } | { skip } (§5 rules (1)-(8), in that order).
function _sheetCell(id, v, ctx) {
  if (typeof v !== 'string') return { code: 'sheet-type' };
  const text = _clean(v);
  const downIds = Array.isArray(ctx.downIds) ? ctx.downIds : [];
  const b = BARRIERS.find((x) => x.detailsCol === id);
  let scope = downIds;
  if (b) {
    if (!text) return { skip: true };
    const rule = (ctx.rules && ctx.rules[b.id]) || {};
    if (rule.yn !== 'Y') return { code: 'sheet-not-yes' };
    if (text.length < SHEET_MIN || text.length > SHEET_DETAILS_MAX) return { code: 'sheet-length' };
    if (!downIds.some((u) => _bounded(u, text, 'i'))) return { code: 'sheet-no-unit' };
    scope = Array.isArray(rule.units) ? rule.units : [];
  } else if (id === 'fasActions') {
    if (text.length < SHEET_MIN || text.length > SHEET_FAS_MAX) return { code: 'sheet-length' };
  } else {
    if (/^none\.?$/i.test(text)) return { text: 'None.' };
    if (!text || text.length > SHEET_SUPPORT_MAX) return { code: 'sheet-length' };
  }
  const f = sheetForbidden(text, downIds);
  if (f) return { code: f };
  const field = _SHEET_FIELD(id);
  if (downIds.some((u) => !scope.includes(u) && _bounded(u, text, 'i'))
    || proseTokens(text, scope, ctx, { field, part: 'ids' })) return { code: 'sheet-units' };
  if (proseTokens(text, scope, ctx, { field, part: 'tokens' })) return { code: 'sheet-tokens' };
  if (nameFlags(text, scope, ctx).length) return { code: 'sheet-name' };
  if (id === 'fasActions' && fasClaimProblem(text, { fas: [] }, 'fasActions', ctx.today)) return { code: 'sheet-claim' };
  return { text };
}
// AI sheet JSON {"sheet":{cellId: text}} (string or object) -> { sheet: {cellId: text} (passing
// cells only), drops: {cellId: code}, invalid } . invalid = no `sheet` object; unknown keys ignored.
function validateSheet(input, ctx) {
  const obj = _parse(input);
  const sheet = {};
  const drops = {};
  if (!obj || !_plainObj(obj.sheet)) return { sheet, drops, invalid: true };
  const c = ctx || {};
  for (const id of SHEET_CELL_IDS) {
    const v = obj.sheet[id];
    if (v === undefined || v === null) continue;
    const r = _sheetCell(id, v, c);
    if (r.code) drops[id] = r.code;
    else if (!r.skip) sheet[id] = r.text;
  }
  return { sheet, drops, invalid: false };
}

module.exports = {
  FIELD_MAX, OUTPUT_TARGET_CHARS, ENV2, SUP_E, BARRIERS, BARRIER_IDS, SUPPORT_TEAMS, SUPPORT_FAILED_TEXT, YES_DROPPED_TEXT, NO_REASON,
  SHEET_DETAILS_MAX, SHEET_FAS_MAX, SHEET_SUPPORT_MAX, SHEET_CELL_IDS, SHEET_EMAIL_RE, NO_FAS_PREFIX_RE, COUNT_AFTER_SPACED_RE, JOINED_ACT_RE,
  sheetForbidden, stripRefs, validateSheet,
  NO_FAS_RE, NEXT_PREFIX_RE, CLAUSE_SPLIT_RE, FAS_SUBJECT_RE, FAS_LEADVERB_RE, FAS_SUBJ_ACT_RE, REL_DATE_RE, BIND_KW_RE,
  BIND_CLASS_RE, REF_RE, ID_TOKEN_RE, TICKET_RE, URL_RE, AMOUNT_RE, GATE_ETC_ABBR_RE, GATE_ETC_PHRASE_RE, EXPECT_READY_RE,
  mdDates, datesAfter, syntheticIds, gateContext, limits, outBudget,
  parseEnvelope, checkFas, nextClause, freeDateProblem, proseTokens, isFasClaim, fasClaimProblem, nameFlags, dateBindingFlags,
  gateEntry, reconcileEtc, validateRowDraft, validateMapFacts, mergeFinal, coverage, renderCells, removalLine,
  TYPED_REF_RE, PARTS_LABEL_BEFORE_RE, typedRefProblem, gateProse, textContext, _codeLine, _cutWord,
};
