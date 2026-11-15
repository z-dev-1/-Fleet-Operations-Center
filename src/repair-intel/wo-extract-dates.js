'use strict';
/**
 * repair-intel/wo-extract-dates.js — pure dates / timestamps / amounts for the
 * structured extractor (relay-extract design §5, §6.1, §6.2, §6.3 rule (a)).
 *
 * Calendar rule: every ms -> day conversion uses the process-local calendar
 * (getFullYear/getMonth/getDate), never toISOString().slice(0,10).
 *
 * Vocabulary here is extraction-only (classification keywords, negation extras,
 * parts miss / met markers). It is not a gate token rule. The counted repair-miss
 * marker lives in ../dbr/fleet-dbr (REPAIR_MISS_MARKER_RE / explicitRepairMiss)
 * and is required from there; the negation rule is fleet-dbr's etcKeywordNegated.
 * Counted conservatively by design; met/revision nuance lives in the Details
 * prose, not the counts.
 */

const { etcKeywordNegated, explicitRepairMiss } = require('../dbr/fleet-dbr');

const DAY_MS = 86400000;

function _str(v) { return v == null ? '' : String(v); }
function _pad(n) { return String(n).padStart(2, '0'); }

// ── Calendar helpers ────────────────────────────────────────────────────────
function ymd(ms) {
  if (ms == null || !Number.isFinite(+ms)) return null;
  const d = new Date(+ms);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
}
function md(ymdStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(_str(ymdStr));
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}
function _localMs(y, m, d) { return new Date(y, m - 1, d).getTime(); }
function _validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function _ymdOf(y, m, d) { return _validYmd(y, m, d) ? y + '-' + _pad(m) + '-' + _pad(d) : null; }

// ── Timestamps (§5.1) ───────────────────────────────────────────────────────
const TZ_OFFSET = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };
const DECISIV_TS_RE = /^(\d{2})\/(\d{2})\/(\d{2,4}) (\d{1,2}):(\d{2}) (am|pm) ([ECMP][SD]T)$/i;
const LEGACY_TS_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// '11/10/26 10:28 am EST' -> ms (fixed offsets). Fallback Date.parse; else null.
function parseDecisivTs(s) {
  const t = _str(s).trim();
  if (!t) return null;
  const m = DECISIV_TS_RE.exec(t);
  if (m) {
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    let h = +m[4] % 12;
    if (m[6].toLowerCase() === 'pm') h += 12;
    const off = TZ_OFFSET[m[7].toUpperCase()];
    return Date.UTC(y, +m[1] - 1, +m[2], h - off, +m[5]);
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

// ISO | 'MM/DD/YYYY HH:MM:SS' (UTC) | epoch ms | Decisiv form -> ms | null.
function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = _str(v).trim();
  if (ISO_RE.test(t)) {
    // Trim sub-millisecond digits ('…204881915Z') so every engine parses it.
    const p = Date.parse(t.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isFinite(p) ? p : null;
  }
  const l = LEGACY_TS_RE.exec(t);
  if (l) return Date.UTC(+l[3], +l[1] - 1, +l[2], +l[4], +l[5], +l[6]);
  if (DECISIV_TS_RE.test(t)) return parseDecisivTs(t);
  return null;
}

// ── Year inference (§5.2) ───────────────────────────────────────────────────
// Candidate year(at); date < at-60d -> +1; date > at+300d -> -1.
function inferYear(m, d, atMs) {
  if (atMs == null || !Number.isFinite(+atMs)) return null;
  const at = new Date(+atMs);
  const atDay = _localMs(at.getFullYear(), at.getMonth() + 1, at.getDate());
  let y = at.getFullYear();
  const ms = _localMs(y, m, d);
  if (ms < atDay - 60 * DAY_MS) y += 1;
  else if (ms > atDay + 300 * DAY_MS) y -= 1;
  return y;
}
function _year(m, d, yRaw, atMs) {
  if (yRaw != null && yRaw !== '') {
    const y = +yRaw;
    if (!Number.isFinite(y)) return null;
    return String(yRaw).length <= 2 ? 2000 + y : y;
  }
  return inferYear(m, d, atMs);
}

// ── Relative dates ──────────────────────────────────────────────────────────
const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function _weekdayIdx(w) { return WEEKDAY[_str(w).toLowerCase().slice(0, 3)]; }
// -> { ymd, approx? } | null. Local calendar of at.
function relativeDate(word, atMs) {
  if (atMs == null || !Number.isFinite(+atMs)) return null;
  const w = _str(word).toLowerCase().replace(/\s+/g, ' ').trim();
  const at = new Date(+atMs);
  const base = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const dow = base.getDay();
  const plus = (n) => ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + n).getTime());
  if (w === 'tomorrow') return { ymd: plus(1) };
  if (w === 'early next week') return { ymd: plus(((8 - dow) % 7) || 7), approx: true };
  if (w === 'next week') return { ymd: plus(((8 - dow) % 7) || 7), approx: 'week' };
  if (/^end of (?:the )?week$|^eow$/.test(w)) {
    let n = (5 - dow + 7) % 7;
    if (n === 0) n = 7;
    return { ymd: plus(n) };
  }
  const idx = _weekdayIdx(w);
  if (idx == null) return null;
  let n = (idx - dow + 7) % 7;
  if (n === 0) n = 7;
  return { ymd: plus(n) };
}

// ── Date mentions (§5.2) ────────────────────────────────────────────────────
const TA_DATE_RE = /\b(\d{1,2}) (\d{1,2}) (\d{4}|\d{2})(?: (\d{1,2}) (\d{2}) ([AP]M))?\b/g;
const NUM_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const FRACTION_AFTER_RE = /^\s{0,3}(?:ton|tons|units?|in|inch|ft|ft-lb|lb|lbs|psi|mm|gal|qt)\b/i;
const MON_SRC = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MON_DAY_RE = new RegExp('\\b' + MON_SRC + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?', 'gi');
const DAY_OF_MON_RE = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+' + MON_SRC + '\\b', 'gi');
const WEEK_OF_BEFORE_RE = /\bweek of\s*$/i;
const RELATIVE_RE = /\b(?:(?:by|on|this|next)\s+)?(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(tomorrow|early next week|next week|end of (?:the )?week|EOW)\b/gid;
const MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function _validSpans(consumed) {
  if (!Array.isArray(consumed)) return [];
  return consumed.filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end));
}

// Sorted span set with an O(log n) overlap test.
function _spanSet(init) {
  const spans = init.map((c) => ({ start: c.start, end: c.end })).sort((a, b) => a.start - b.start);
  let maxEnd = [];
  const rebuild = () => {
    spans.sort((a, b) => a.start - b.start);
    maxEnd = [];
    let mx = -Infinity;
    for (const s of spans) { mx = Math.max(mx, s.end); maxEnd.push(mx); }
  };
  rebuild();
  return {
    overlaps(start, end) {
      // any span with s.start < end && start < s.end
      let lo = 0; let hi = spans.length; // first index with s.start >= end
      while (lo < hi) { const mid = (lo + hi) >> 1; if (spans[mid].start < end) lo = mid + 1; else hi = mid; }
      return lo > 0 && maxEnd[lo - 1] > start;
    },
    add(list) { for (const s of list) spans.push(s); rebuild(); },
  };
}

// -> [{ ymd, raw, start, end, approx?, relative? }] sorted by start.
function findDateMentions(text, opts = {}) {
  const t = _str(text);
  const at = opts.at != null ? parseTs(opts.at) : null;
  const ta = !!opts.ta;
  const set = _spanSet(_validSpans(opts.consumed));
  const out = [];
  const run = (re, fn) => {
    const found = [];
    re.lastIndex = 0;
    for (const m of t.matchAll(re)) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (set.overlaps(start, end)) continue;
      const r = fn(m, start, end);
      if (!r) continue;
      found.push({ start, end });
      out.push(Object.assign({ raw: m[0], start, end }, r));
    }
    set.add(found);
  };
  if (ta) {
    run(TA_DATE_RE, (m) => {
      const mo = +m[1]; const da = +m[2];
      if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
      const y = _year(mo, da, m[3], at);
      const d = y != null ? _ymdOf(y, mo, da) : null;
      return d ? { ymd: d } : null;
    });
  }
  run(NUM_DATE_RE, (m, start, end) => {
    const mo = +m[1]; const da = +m[2];
    if (mo > 12 || da > 31 || mo < 1 || da < 1) return null;
    if (FRACTION_AFTER_RE.test(t.slice(end, end + 24))) return null;
    const y = _year(mo, da, m[3], at);
    const d = y != null ? _ymdOf(y, mo, da) : null;
    if (!d) return null;
    const r = { ymd: d };
    if (WEEK_OF_BEFORE_RE.test(t.slice(Math.max(0, start - 12), start))) r.approx = 'weekOf';
    return r;
  });
  const monFn = (moWord, dayStr, yStr) => {
    const mo = MONTH_IDX[_str(moWord).toLowerCase().slice(0, 3)];
    const da = +dayStr;
    if (!mo || !(da >= 1 && da <= 31)) return null;
    const y = _year(mo, da, yStr, at);
    const d = y != null ? _ymdOf(y, mo, da) : null;
    return d ? { ymd: d } : null;
  };
  run(MON_DAY_RE, (m) => monFn(m[1], m[2], m[3]));
  run(DAY_OF_MON_RE, (m) => monFn(m[2], m[1], null));
  // Relative forms: dropped when within 25 chars of an explicit date (approx carries over).
  const explicit = out.slice();
  const rel = [];
  RELATIVE_RE.lastIndex = 0;
  for (const m of t.matchAll(RELATIVE_RE)) {
    const start = m[1] != null ? m.indices[1][0] : m.index;
    const end = m.index + m[0].length;
    if (set.overlaps(start, end)) continue;
    if (at == null) continue;
    const word = (m[1] || m[2] || '').toLowerCase();
    const r = relativeDate(m[2] ? m[2] : m[1], at);
    if (!r || !r.ymd) continue;
    const near = explicit.find((e) => (e.start >= end && e.start - end <= 25) || (start >= e.end && start - e.end <= 25));
    if (near) {
      if (r.approx && !near.approx) near.approx = r.approx;
      continue;
    }
    const x = { ymd: r.ymd, raw: t.slice(start, end), start, end, relative: word };
    if (r.approx) x.approx = r.approx;
    rel.push(x);
  }
  return out.concat(rel).sort((a, b) => a.start - b.start);
}

// TA spaced digits only: '11 07 2026 12 05 PM' / '11 10 26' -> mentions.
function taDigitsToDates(text, opts = {}) {
  return findDateMentions(text, Object.assign({}, opts, { ta: true }))
    .filter((m) => /^\d{1,2} \d{1,2} \d{2,4}/.test(m.raw));
}

// ── Amounts (§5.3) ──────────────────────────────────────────────────────────
const TA_CENTS_RE = /\$\s?(\d{1,3}(?: \d{3})*) (\d{2})\b/g;
// Extraction vocabulary only (not a gate token rule; the gate's AMOUNT_RE lives in fleet-dbr-gate).
const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\s?\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)(?!\d)/g;

function normAmount(v) {
  const n = typeof v === 'number' ? v : Number(_str(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// -> [{ value, raw, start, end }] sorted by start.
function findAmounts(text, opts = {}) {
  const t = _str(text);
  const out = [];
  const set = _spanSet([]);
  if (opts.ta) {
    const found = [];
    for (const m of t.matchAll(TA_CENTS_RE)) {
      const v = normAmount(m[1].replace(/ /g, '') + '.' + m[2]);
      if (v == null) continue;
      const s = { value: v, raw: m[0], start: m.index, end: m.index + m[0].length };
      out.push(s); found.push(s);
    }
    set.add(found);
  }
  for (const m of t.matchAll(DOLLAR_RE)) {
    const start = m.index; const end = m.index + m[0].length;
    if (set.overlaps(start, end)) continue;
    const v = normAmount(m[1].replace(/[,\s]/g, ''));
    if (v == null) continue;
    out.push({ value: v, raw: m[0], start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── Classification keywords (§6.1) ──────────────────────────────────────────
// Each: { rule, kind, re (g), taOnly?, tentative?, trailing? }
const KW = [
  { rule: 1, kind: 'partsArrival', re: /\bparts?\s+(?:ETC|ETA)\b/gi },
  { rule: 1, kind: 'partsArrival', re: /\b(?:expected\s+)?arrival\s+date\b/gi },
  { rule: 1, kind: 'partsArrival', re: /\bdue\s+in\s+on\b/gi, trailing: true },
  { rule: 1, kind: 'partsArrival', re: /\beta\s+for\s+parts\b/gi },
  { rule: 1, kind: 'partsArrival', re: /\bparts?\s+(?:will\s+be|to\s+be)\s+(?:in|here)\b/gi },
  { rule: 1, kind: 'partsArrival', re: /\bon order\s+eta\b/gi },
  { rule: 1, kind: 'partsArrival', re: /\bhere by\b/gi },
  { rule: 2, kind: 'partsShip', re: /\b(?:estimated\s+)?ship(?:ping)?\s+date\b|\bexpected\s+to\s+ship\b|\bscheduled\s+to\s+ship\b|\bto\s+ship\s+on\b|\bESD\b|\bsh[il]t\s+out\b/gi },
  { rule: 3, kind: 'updateExpected', re: /\bEXPECTED\s+UPDATE\s+FROM\s+SUPPLIER\b/gi },
  { rule: 4, kind: 'repairStart', re: /\b(?:repairs?\s+(?:are\s+)?scheduled\s+to\s+begin|begin\s+repairs?)\b/gi },
  { rule: 4, kind: 'repairStart', re: /\bweek of\b/gi },
  { rule: 5, kind: 'techOnsite', re: /\btech(?:nician)?\s+ETA\b/gi },
  { rule: 5, kind: 'techOnsite', re: /\bETA\b/g, taOnly: true },
  { rule: 6, kind: 'repairCompletion', re: /(?<!\b[Pp][Aa][Rr][Tt][Ss]?\s)\b(?:ETC|ETR)\b/g },
  { rule: 6, kind: 'repairCompletion', re: /\b(?:unit|repair)\s+ETC\b/gi },
  { rule: 6, kind: 'repairCompletion', re: /\best(?:\.|imated)?\s+(?:time\s+of\s+)?completion|\bexpected\s+completion|\bready\s+by|\bcomplete\s+by\b/gi },
  { rule: 6, kind: 'repairCompletion', re: /\bpossible etc\b/gi, tentative: true },
  { rule: 6, kind: 'repairCompletion', re: /\betc\b(?=\s{0,3}\d)/g, taOnly: true },
];
const NEG_RULES = new Set([1, 2, 5, 6]);

// Extraction-only negation extras (parts/ship negations the builder has no keyword for),
// plus `will advise` -> repairCompletion (Path B). Never a gate rule.
const NEG_EXTRA_RE = /\b(?:No\s+ESD|ETC\s*(?::|-)?\s*(?:TBD|N\/A)|Pending\s+ETC|no\s+eta|no\s+(?:updated\s+)?parts\s+ETA|no\s+information\s+on\s+parts\s+ETC|ETA\s+(?:TBD|N\/A)|will\s+advise)(?![\w/])/gi;

function _keywordMatches(t, ta) {
  const out = [];
  for (const k of KW) {
    if (k.taOnly && !ta) continue;
    k.re.lastIndex = 0;
    for (const m of t.matchAll(k.re)) {
      out.push({ start: m.index, end: m.index + m[0].length, rule: k.rule, kind: k.kind, tentative: !!k.tentative, trailing: !!k.trailing });
    }
  }
  return out;
}

function _negKind(phrase, t, start, end, members) {
  const p = phrase.toLowerCase().replace(/\s+/g, ' ');
  if (/^no esd/.test(p)) return 'partsShip';
  if (/^no (?:updated )?parts eta|^no information on parts etc/.test(p)) return 'partsArrival';
  if (/^will advise/.test(p)) return 'repairCompletion';
  if (/^eta (?:tbd|n\/a)/.test(p)) return 'techOnsite';
  if (/^etc/.test(p) || /^pending etc/.test(p)) {
    // 'Parts ETC: TBD' stays on the parts chain (the R1 keyword owns the span).
    if (members.some((x) => x.rule === 1)) return 'partsArrival';
    return 'repairCompletion';
  }
  if (/^no eta/.test(p)) {
    const around = t.slice(Math.max(0, start - 20), start) + ' ' + t.slice(end, end + 20);
    return /\bparts?\b/i.test(around) ? 'partsArrival' : 'techOnsite';
  }
  return 'repairCompletion';
}

// §6.2 scanner: -> { negated: [{date:null, negated:true, kind, start, end, phrase}], negSpans: [{start,end}] }
function findNegatedMentions(text, opts = {}) {
  const t = _str(text);
  const kws = _keywordMatches(t, !!opts.ta).filter((k) => NEG_RULES.has(k.rule));
  NEG_EXTRA_RE.lastIndex = 0;
  for (const m of t.matchAll(NEG_EXTRA_RE)) {
    kws.push({ start: m.index, end: m.index + m[0].length, rule: 'NEG', phrase: m[0] });
  }
  kws.sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];
  for (const k of kws) {
    const g = groups[groups.length - 1];
    if (g && k.start <= g.end + 1) { g.members.push(k); g.end = Math.max(g.end, k.end); }
    else groups.push({ start: k.start, end: k.end, members: [k] });
  }
  const negated = [];
  const negSpans = [];
  for (const g of groups) {
    const neg = g.members.find((x) => x.rule === 'NEG');
    let chosen = neg;
    if (!chosen) {
      chosen = g.members.slice().sort((a, b) => (b.end - a.end) || (a.rule - b.rule))[0];
    }
    const isNeg = !!neg || etcKeywordNegated(t, chosen.start, chosen.end);
    if (!isNeg) continue;
    const kind = neg ? _negKind(neg.phrase, t, neg.start, neg.end, g.members) : chosen.kind;
    const span = { start: g.start, end: g.end };
    negSpans.push(span);
    negated.push({ date: null, negated: true, kind, start: g.start, end: g.end, phrase: t.slice(g.start, g.end) });
  }
  return { negated, negSpans };
}

function _inSpans(spans, i) { return spans.some((s) => i >= s.start && i < s.end); }

// Keyword index for nearest-keyword lookups (binary search on end).
function _kwIndex(t, ta, negSpans) {
  const list = _keywordMatches(t, ta).filter((k) => !_inSpans(negSpans || [], k.start));
  const byEnd = list.slice().sort((a, b) => a.end - b.end);
  const trailing = list.filter((k) => k.trailing).sort((a, b) => a.start - b.start);
  return { byEnd, trailing };
}

function _classifyWith(idx, m) {
  const cands = [];
  // ends in [m.start-40, m.start)
  const arr = idx.byEnd;
  let lo = 0; let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].end < m.start - 40) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < arr.length && arr[i].end < m.start; i++) cands.push({ k: arr[i], end: arr[i].end });
  for (const k of idx.trailing) {
    if (k.start > m.end && k.start <= m.end + 15) cands.push({ k, end: m.start - 0.5 });
  }
  if (!cands.length) return null;
  let bestEnd = -Infinity;
  for (const c of cands) if (c.end > bestEnd) bestEnd = c.end;
  const top = cands.filter((c) => c.end === bestEnd);
  top.sort((a, b) => a.k.rule - b.k.rule);
  const best = top[0];
  const r = { kind: best.k.kind, rule: best.k.rule };
  if (top.some((c) => c.k.rule === best.k.rule && c.k.tentative)) r.tentative = true;
  return r;
}

// §6.1: nearest ETC keyword for a dated mention -> { kind, rule, tentative? } | null.
function classify(text, m, opts = {}) {
  const t = _str(text);
  const idx = _kwIndex(t, !!opts.ta, opts.negSpans);
  return _classifyWith(idx, m);
}

// ── Markers (§6.3 rule (a)) ─────────────────────────────────────────────────
// Parts miss markers. Cited-date groups 1..5.
const MISS_MARKER_RE = /\b(?:was\s+expected\s+on\s+(\d{1,2}\/\d{1,2})\s+but\s+has\s+not\s+arrived|originally\s+scheduled\s+to\s+ship(?:\s+on)?\s+(\d{1,2}\/\d{1,2})|previously\s+expected\s+to\s+ship\s+on\s+(\d{1,2}\/\d{1,2})|was\s+scheduled\s+to\s+ship\s+on\s+(\d{1,2}\/\d{1,2})[^.]{0,60}\bno\s+(?:tracking|shipping)|expecting\s+the\s+[a-z ]{0,30}to\s+ship\s+on\s+(\d{1,2}\/\d{1,2})[\s\S]{0,160}?\bno\s+(?:shipping|tracking)|missed\s+(?:the\s+)?(?:ETC|ETA)|did\s+not\s+(?:arrive|ship)|has\s+not\s+(?:arrived|shipped))/gid;
const MET_MARKER_RE = /\b(?:all\s+(?:required\s+)?parts\s+(?:have\s+)?(?:arrived|received|are\s+in)|parts?\s+(?:has|have)\s+arrived|parts?\s+(?:arrived|received)(?:\s+on\s+(\d{1,2}\/\d{1,2}))?|repairs?\s+(?:is|are|has\s+been)\s+completed?|unit\s+is\s+ready(?:\s+for\s+pick\s*up)?)\b/gid;
// Before-only guard (Path B: no etcKeywordNegated call; this list already covers no|not|pending).
const MET_GUARD_RE = /\b(?:once|when|until|after|before|if|as\s+soon\s+as|will|to\s+be|waiting\s+(?:for|until|on)|pending|not|no|yet\s+to|expect(?:ed|ing)?)\b/i;

function _citedYmd(raw, atMs) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(_str(raw));
  if (!m) return null;
  const y = inferYear(+m[1], +m[2], atMs);
  return y != null ? _ymdOf(y, +m[1], +m[2]) : null;
}

// -> { miss: [...], met: [...], consumed: [{start,end}] }
function findMarkers(text, opts = {}) {
  const t = _str(text);
  const at = opts.at != null ? parseTs(opts.at) : null;
  const miss = [];
  const met = [];
  const consumed = [];
  // Counted repair-miss markers: the shared fleet-dbr vocabulary.
  const repair = explicitRepairMiss(t, at != null ? ymd(at) : '');
  const repairSpans = [];
  for (const r of repair) {
    miss.push({ type: 'miss', chain: 'repairCompletion', citedDate: r.date, start: r.start, end: r.end, repair: true });
    if (r.date) consumed.push({ start: r.start, end: r.end });
    repairSpans.push(r);
  }
  for (const m of t.matchAll(MISS_MARKER_RE)) {
    const start = m.index; const end = m.index + m[0].length;
    const low = m[0].toLowerCase();
    if (/^missed/.test(low) && /etc$/.test(low)) continue;        // repair side: fleet-dbr marker only
    if (repairSpans.some((r) => r.start < end && start < r.end)) continue;
    let g = null;
    for (let k = 1; k <= 5; k++) if (m[k] != null) { g = k; break; }
    const chain = /^missed/.test(low) ? 'techOnsite' : 'parts';
    const ev = { type: 'miss', chain, citedDate: null, start, end };
    if (g != null) {
      ev.citedDate = _citedYmd(m[g], at);
      consumed.push({ start: m.indices[g][0], end: m.indices[g][1] });
    }
    miss.push(ev);
  }
  for (const m of t.matchAll(MET_MARKER_RE)) {
    const start = m.index; const end = m.index + m[0].length;
    if (m[1] != null) consumed.push({ start: m.indices[1][0], end: m.indices[1][1] });
    let sentStart = 0;
    for (let i = start - 1; i >= 0; i--) { if ('.!?;\n'.includes(t[i])) { sentStart = i + 1; break; } }
    if (MET_GUARD_RE.test(t.slice(Math.max(sentStart, start - 30), start))) continue;
    if (/^\s{0,2}\?/.test(t.slice(end, end + 3))) continue;
    const chain = /^(?:repair|unit)/i.test(m[0]) ? 'repairCompletion' : 'parts';
    met.push({ type: 'met', chain, citedDate: m[1] != null ? _citedYmd(m[1], at) : null, start, end });
  }
  return { miss, met, consumed };
}

// Full per-comment pass: markers -> findDateMentions(consumed) -> findNegatedMentions -> classify.
// -> { mentions: [{ymd, kind, raw, start, end, tentative?, approx?, relative?}], negated, miss, met, events }
// events: mentions + negated + met sorted by offset, then miss markers (by offset).
function scanEtc(text, opts = {}) {
  const t = _str(text);
  const ta = !!opts.ta;
  const mk = findMarkers(t, { at: opts.at });
  const dates = findDateMentions(t, { at: opts.at, ta, consumed: mk.consumed });
  const neg = findNegatedMentions(t, { ta });
  const idx = _kwIndex(t, ta, neg.negSpans);
  const mentions = [];
  for (const d of dates) {
    const c = _classifyWith(idx, d);
    if (!c) continue;
    const x = { ymd: d.ymd, kind: c.kind, raw: d.raw, start: d.start, end: d.end };

    if (c.tentative) x.tentative = true;
    if (d.approx) x.approx = d.approx;
    if (d.relative) x.relative = d.relative;
    mentions.push(x);
  }
  const head = mentions.map((m) => Object.assign({ type: 'mention' }, m))
    .concat(neg.negated.map((n) => Object.assign({ type: 'negated' }, n)))
    .concat(mk.met)
    .sort((a, b) => a.start - b.start);
  const events = head.concat(mk.miss.slice().sort((a, b) => a.start - b.start));
  return { mentions, negated: neg.negated, miss: mk.miss, met: mk.met, events };
}

module.exports = {
  parseTs, parseDecisivTs, findDateMentions, inferYear, taDigitsToDates, findAmounts, normAmount,
  relativeDate, ymd, md, findNegatedMentions, classify, findMarkers, scanEtc,
  MISS_MARKER_RE, MET_MARKER_RE, MET_GUARD_RE, NEG_EXTRA_RE, TZ_OFFSET,
};
