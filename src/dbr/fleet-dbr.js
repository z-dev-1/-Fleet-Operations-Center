// Fleet DBR builder — the 24-column DBR (SharePoint DBR_Fleet_Health_<date>.xlsx layout)
// computed from the app's own fleet data. Pure: no I/O, no clock (the caller passes `today`
// as 'YYYY-MM-DD'), no logging. Requires only ./review-engine and crypto.
//
// Grain: one row per (Domicile x SCAC) pair present in the fleet data. Domicile metrics are
// domicile-wide, SCAC metrics are SCAC-wide across all domiciles, and every barrier / ETC
// column is computed from the pair's down units only. "Down" = review-engine.isUnavail, the
// same predicate as the Daily Call engine and the Slack DBR lookup.
//
// Every Y/N, count and Details line comes from a real field value or a verbatim (redacted,
// <= 80 char) snippet. Nothing is guessed: no parsed ETC date => NO ETC.
// Also requires the pure ../utils/offsite-notes-order (asistNotes entry dates).
'use strict';

const crypto = require('crypto');
const engine = require('./review-engine');
const { offsiteEntries } = require('../utils/offsite-notes-order');

const _col = (id, header, editable) => Object.freeze({ id, header, editable: !!editable });

const COLUMNS = Object.freeze([
  _col('fasName', 'FAS Name', true),
  _col('domicile', 'Domicile'),
  _col('domicileUptime', 'Domicile Uptime'),
  _col('domicileDown', 'Domicile Units Down'),
  _col('scac', 'SCAC'),
  _col('scacUptime', 'SCAC Uptime'),
  _col('scacDown', 'SCAC Units Down'),
  _col('vendor1pYN', '1P Vendor Barrier Y/N?'),
  _col('vendor1pDetails', '1P Vendor Barrier \u2014 Details', true),
  _col('oemYN', 'OEM Barrier Y/N?'),
  _col('oemDetails', 'OEM Barrier \u2014 Details', true),
  _col('estimateYN', 'Estimate Barrier Y/N?'),
  _col('estimateDetails', 'Estimate Barrier \u2014 Details', true),
  _col('partnerYN', 'Partner Barrier Y/N?'),
  _col('partnerDetails', 'Partner Barrier \u2014 Details', true),
  _col('partsYN', 'Parts Delay Y/N?'),
  _col('partsDetails', 'Parts Delay \u2014 Details', true),
  _col('commonYN', 'Common Repairs Y/N?'),
  _col('commonDetails', 'Common Repairs \u2014 Details', true),
  _col('etcToday', 'Expected units with ETC for Today', true),
  _col('noEtc', 'NO ETC', true),
  _col('missedEtc', 'Missed ETC', true),
  _col('fasActions', 'FAS Actions', true),
  _col('support', 'Where Do You Need Support?', true),
]);

const EDITABLE_IDS = Object.freeze(COLUMNS.filter((c) => c.editable).map((c) => c.id));
// Hard cells are code-computed facts the AI can never write; every other column (6 Y/N,
// 6 Details, the 3 ETC cells, FAS Actions, Support = 17) is an AI judgment cell.
const HARD_CELL_IDS = Object.freeze(['fasName', 'domicile', 'domicileUptime', 'domicileDown', 'scac', 'scacUptime', 'scacDown']);
const AI_CELL_IDS = Object.freeze(COLUMNS.map((c) => c.id).filter((id) => !HARD_CELL_IDS.includes(id)));

// Common Repairs fires when this many of the pair's down units share a SYSTEM_GROUPS system
// (golden sheets; Fleet Health only, the Daily Call engine keeps TREND_MIN_UNITS = 3).
const COMMON_REPAIR_MIN = 2;
// units[].why strings (drill-down only) are capped at this many chars.
const WHY_MAX = 120;
// Free-text heuristics read only the N latest dated repairTimeline lines.
const RECENT_TIMELINE_LINES = 3;
const SNIPPET_MAX = 80;
const BLANK = '(BLANK)';

// ── Basic helpers ────────────────────────────────────────────────────────────
const isDown = (row) => engine.isUnavail(row || {});

function uptimePct(total, down) {
  return total ? Math.round(((total - down) / total) * 1000) / 10 : 100;
}
function fmtPct(n) { return String(n) + '%'; }

function _str(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(_str).filter(Boolean).join(', ');
  return String(v);
}
function normCode(v) {
  const s = _str(v).trim().toUpperCase();
  return s || BLANK;
}
function _domicileOf(row) { return normCode((row && (row.domicileSite || row.domicile)) || ''); }
function _scacOf(row) { return normCode(row && row.operator); }
function groupKey(row) { return _domicileOf(row) + '|' + _scacOf(row); }
function _idOf(row) { return _str(row && row.equipmentId).trim() || '(no id)'; }
function _days(row) { return engine.parseDaysOpen(row || {}); }
function _norm(s) { return _str(s).toLowerCase().replace(/\s*_\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function _codeText(s) { return _str(s).replace(/\s*_\s*/g, ' ').replace(/\s+/g, ' ').trim(); }

const EMAIL_RE = /\S+@\S+\.\S+/g;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
// ISO dates / times ("2026-11-26T04:31Z") are protected from PHONE_RE and restored (D18).
const ISO_DATE_TIME_RE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
function _redact(s) {
  const kept = [];
  const t = s.replace(EMAIL_RE, '[redacted]')
    .replace(ISO_DATE_TIME_RE, (m) => { kept.push(m); return '\u0000' + (kept.length - 1) + '\u0000'; })
    .replace(PHONE_RE, '[redacted]');
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[+i]);
}

// Up to 80 chars around a match, single-lined, emails / phone-like runs redacted.
function _snippet(text, index) {
  const t = _str(text);
  const i = Math.max(0, index | 0);
  // Widen to whitespace so an email / phone token is never cut in half before redaction.
  let start = Math.max(0, i - 30);
  while (start > 0 && start > i - 70 && !/\s/.test(t[start - 1])) start -= 1;
  let end = Math.min(t.length, i + 110);
  while (end < t.length && end < i + 150 && !/\s/.test(t[end])) end += 1;
  let s = t.slice(start, end).replace(/\s+/g, ' ').trim();
  s = _redact(s).trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX).trim() : s;
}

// ── Dates ───────────────────────────────────────────────────────────────────
function _pad(n) { return String(n).padStart(2, '0'); }
function _ymdUtc(y, m, d) { return y + '-' + _pad(m) + '-' + _pad(d); }
function _toUtc(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_str(ymd));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
function _validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const DAY_MS = 86400000;

// M/D[/Y] -> 'YYYY-MM-DD' | null. No year: today's year, shifted -1 when the result is
// > 60 days ahead, +1 when > 300 days behind. Invalid dates (13/02, 2/30) -> null.
function inferDate(m, d, y, today) {
  const mo = parseInt(m, 10);
  const da = parseInt(d, 10);
  const t = _toUtc(today);
  if (!Number.isFinite(mo) || !Number.isFinite(da)) return null;
  if (y != null && y !== '') {
    let yr = parseInt(y, 10);
    if (!Number.isFinite(yr)) return null;
    if (String(y).length <= 2) yr += 2000;
    return _validYmd(yr, mo, da) ? _ymdUtc(yr, mo, da) : null;
  }
  if (!Number.isFinite(t)) return null;
  const yr = new Date(t).getUTCFullYear();
  if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
  const ms = Date.UTC(yr, mo - 1, da);
  let cy = yr;
  if (ms - t > 60 * DAY_MS) cy = yr - 1;
  else if (t - ms > 300 * DAY_MS) cy = yr + 1;
  // Validate against the year actually returned (2/29 differs by year).
  return _validYmd(cy, mo, da) ? _ymdUtc(cy, mo, da) : null;
}

function _md(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}

const TIMELINE_LINE_RE = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*[-\u2013:]\s*(.*)$/;

// repairTimeline -> [{ index, date: 'YYYY-MM-DD'|null, text, raw }] in source order.
function parseTimelineLines(text, today) {
  const out = [];
  const lines = _str(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const m = TIMELINE_LINE_RE.exec(raw);
    const date = m ? inferDate(m[1], m[2], m[3], today) : null;
    out.push({ index: i, date, text: m ? m[4] : raw.trim(), raw });
  }
  return out;
}

function _recentTimeline(row, today) {
  const lines = parseTimelineLines(row.repairTimeline, today);
  const dated = lines.filter((l) => l.date);
  if (!dated.length) return lines.slice(-RECENT_TIMELINE_LINES);
  return dated
    .slice()
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)))
    .slice(0, RECENT_TIMELINE_LINES);
}

// Current-state free text: notes + canonical fields + the 3 latest dated timeline lines.
function _recentText(row, today) {
  const parts = [row.savedNotes, row.canonicalSituation, row.canonicalNextStep, row.canonicalWaitingOn]
    .map(_str).filter((s) => s.trim());
  for (const l of _recentTimeline(row, today)) parts.push(l.raw.trim());
  return parts.join('\n');
}

// ── ETC parsing (best-effort, never fabricated) ─────────────────────────────
const ETC_SOURCES = Object.freeze(['canonicalNextStep', 'canonicalSituation', 'savedNotes', 'repairTimeline', 'asistNotes']);
const _DATE_TAIL = '[^\\n\\d]{0,25}?(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?';
// ETC / ETR are case-sensitive uppercase so "etc." (et cetera) never matches; bare ETA never counts.
const ETC_TOKEN_POS_RE = new RegExp('\\b(?:ETC|ETR)\\b' + _DATE_TAIL, 'g');
const _ETC_PHRASE = '\\b(?:est(?:\\.|imated)?\\s+(?:time\\s+of\\s+)?completion|expected\\s+completion|completion\\s+(?:date|eta)|repair\\s+eta|eta\\s+(?:for|on)\\s+(?:completion|repair))\\b';
const ETC_PHRASE_POS_RE = new RegExp(_ETC_PHRASE + _DATE_TAIL, 'gi');
const ETC_TOKEN_RE = /\b(?:ETC|ETR)\b/g;
const ETC_PHRASE_RE = new RegExp(_ETC_PHRASE, 'gi');
const NEG_BEFORE_RE = /\b(?:no|without|pending|tbd|unknown|n\/a)\s+(?:an?\s+)?(?:(?:new|revised|updated|firm|repair|confirmed)\s+){0,3}$/i;
const NEG_AFTER_RE = /^\s*[:-]?\s*(?:(?:is|was|remains|still|currently)\s+)?(?:tbd|pending|unknown|n\/a|none|not\s+(?:yet\s+)?(?:provided|given|available|known|set|stated|confirmed|reconfirmed)|not\s+known\s+yet)\b/i;
// Expectation phrasing ("dealer says ready 11/12", "should be ready by 11/12", "promised ready
// 11/12") is an ETC. Past-tense events ("diagnosis completed 11/05", "PM done 11/03") never are,
// and neither is a parts / tow / delivery date ("parts delivered and ready 11/12").
const _EXPECT_READY = '\\b(?:expected|expects?|expecting|should\\s+be|will\\s+be|to\\s+be|target(?:ed)?|promised|says|said|est(?:imated)?)\\s+(?:to\\s+be\\s+)?(?:ready|complete|completion|finished)\\b(?:\\s+(?:by|on|for))?';
const EXPECT_READY_RE = new RegExp(_EXPECT_READY, 'gi');
const EXPECT_READY_POS_RE = new RegExp(_EXPECT_READY + _DATE_TAIL, 'gi');
const NOT_ETC_CONTEXT_RE = /\b(?:parts?|tow|ship(?:ped|ping)?|deliver(?:y|ed)?|arriv(?:e|al))\b/i;
const NOT_ETC_WINDOW = 30;

// All ETC mentions in one text: [{ start, end, negated, date }]. Invalid dates are ignored
// (not negated). A positive match whose ETC/ETR token or ETC phrase ("estimated completion",
// "repair ETA", ...) lies inside a negated span is discarded. Expectation phrasing counts only
// when no parts / tow / delivery word sits in the 30 chars before it.
function _etcMentions(text, today) {
  const t = _str(text);
  const neg = [];
  let m;
  for (const re of [ETC_TOKEN_RE, ETC_PHRASE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const tokS = m.index;
      const tokE = m.index + m[0].length;
      const before = NEG_BEFORE_RE.exec(t.slice(Math.max(0, tokS - 40), tokS));
      const after = NEG_AFTER_RE.exec(t.slice(tokE));
      if (before || after) {
        neg.push({
          start: before ? tokS - before[0].length : tokS,
          end: after ? tokE + after[0].length : tokE,
          negated: true, date: null,
        });
      }
    }
  }
  const inNeg = (i) => neg.some((n) => i >= n.start && i < n.end);
  const pos = [];
  for (const re of [ETC_TOKEN_POS_RE, ETC_PHRASE_POS_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      if (inNeg(m.index)) continue;
      const date = inferDate(m[1], m[2], m[3], today);
      if (!date) continue;
      pos.push({ start: m.index, end: m.index + m[0].length, negated: false, date });
    }
  }
  EXPECT_READY_POS_RE.lastIndex = 0;
  while ((m = EXPECT_READY_POS_RE.exec(t))) {
    if (inNeg(m.index)) continue;
    if (NOT_ETC_CONTEXT_RE.test(t.slice(Math.max(0, m.index - NOT_ETC_WINDOW), m.index))) continue;
    const date = inferDate(m[1], m[2], m[3], today);
    if (!date) continue;
    pos.push({ start: m.index, end: m.index + m[0].length, negated: false, date });
  }
  return neg.concat(pos).sort((a, b) => a.start - b.start);
}

// True when the ETC keyword at [start, end) is negated by the same rule _etcMentions uses
// ("no ETC", "ETC unknown", "ETR not provided" …). The gate applies it to its own ETC-keyword reads.
function etcKeywordNegated(text, start, end) {
  const t = _str(text);
  return NEG_BEFORE_RE.test(t.slice(Math.max(0, start - 40), start)) || NEG_AFTER_RE.test(t.slice(end));
}

// Explicit repair-completion miss / revision markers (relay-extract Path B). The ONE marker
// vocabulary for a counted "missed" repair ETC; wo-extract-dates requires it from here.
// Missed-date capture groups: 1, 2, 3, 5, 8. New-date groups (never the miss): 4, 6, 7.
const _MISS_D = '(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)';
const REPAIR_MISS_MARKER_RE = new RegExp(
  '\\b(?:missed\\s+(?:the\\s+)?(?:ETC|ETR)\\b(?:\\s+(?:of|on|for|date\\s+of)\\s+' + _MISS_D + ')?'
  + '|did\\s+not\\s+(?:complete|finish)\\b(?:[^.\\n]{0,30}?\\b(?:by|on)\\s+' + _MISS_D + ')?'
  + '|(?:ETC|ETR)\\s+(?:was\\s+)?(?:revised|moved|pushed|changed)\\s+(?:out\\s+)?(?:from\\s+' + _MISS_D + '\\s+)?to\\s+' + _MISS_D
  + '|revised\\s+(?:ETC|ETR)(?:\\s+from\\s+' + _MISS_D + ')?\\s+to\\s+' + _MISS_D
  + '|pushed\\s+(?:out\\s+)?to\\s+' + _MISS_D
  + '|no\\s+longer\\s+(?:expected|on\\s+track)\\s+for\\s+' + _MISS_D + ')',
  'gid');
const _MISS_GROUPS = [1, 2, 3, 5, 8];
const _NEW_GROUPS = [4, 6, 7];

// -> [{ date: 'YYYY-MM-DD'|null, start, end }] for every explicit repair-miss marker in text.
// date = the cited missed date (must be < today; later or invalid cited dates are dropped);
// null when the marker cites none (the caller attaches it to the open repair entry).
// start/end = the cited date's span, else the marker span up to (not including) a new date.
function explicitRepairMiss(text, today) {
  const t = _str(text);
  const out = [];
  if (!t) return out;
  for (const m of t.matchAll(REPAIR_MISS_MARKER_RE)) {
    const g = _MISS_GROUPS.find((k) => m[k] != null);
    if (g != null) {
      const dm = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(m[g]);
      const date = dm ? inferDate(dm[1], dm[2], dm[3], today) : null;
      if (!date || !(date < _str(today))) continue;
      out.push({ date, start: m.indices[g][0], end: m.indices[g][1] });
      continue;
    }
    const n = _NEW_GROUPS.find((k) => m[k] != null);
    const end = n != null ? m.indices[n][0] : m.index + m[0].length;
    out.push({ date: null, start: m.index, end: Math.max(m.index, end) });
  }
  return out;
}

// Every positive (non-negated, valid) ETC date in a text, as unpadded 'M/D', de-duplicated in
// text order. Used by the AI gate's per-unit etcDates (not only the parseEtc winner).
function etcMentionDates(text, today) {
  const out = [];
  for (const m of _etcMentions(text, today)) {
    if (m.negated || !m.date) continue;
    const md = _md(m.date);
    if (md && !out.includes(md)) out.push(md);
  }
  return out;
}

function _classifyEtc(date, today) {
  if (!date) return 'none';
  if (date === today) return 'today';
  return date < today ? 'missed' : 'future';
}

// Bug fix 2 (§15.3): the asistNotes winner is the mention in the newest-dated offsite entry;
// ties and undated text -> the smallest start (the head = newest). -> { m, text } | null
function _newestOffsiteMention(text, today) {
  const ms = _etcMentions(text, today);
  if (!ms.length) return null;
  const entries = offsiteEntries(text);
  const atOf = (i) => {
    const e = entries.find((x) => i >= x.start && i < x.end);
    return e && e.atMs != null ? e.atMs : -Infinity;
  };
  let best = null;
  for (const m of ms) {
    const at = atOf(m.start);
    if (!best || at > best.at || (at === best.at && m.start < best.m.start)) best = { m, at };
  }
  return { m: best.m, text };
}

function _localDay(v) {
  const ms = typeof v === 'number' ? v : Date.parse(_str(v));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
}
// An extracted ETC exists (state none + no source + not negated = "no extracted ETC").
function _hasFactEtc(fe) {
  return !!fe && typeof fe === 'object' && !!(fe.source || fe.negated || (fe.state && fe.state !== 'none'));
}
// Legacy winner keeps 'missed' only with an explicit repair-miss marker for that date (or a
// date-less marker on the mention's own line).
function _winnerHasMarker(win, today) {
  const t = _str(win.text);
  const lineOf = (i) => [t.lastIndexOf('\n', i - 1) + 1, (t.indexOf('\n', i) + 1 || t.length + 1) - 1];
  const [ls, le] = lineOf(win.m.start);
  return explicitRepairMiss(t, today).some((x) => (x.date ? x.date === win.m.date : x.start >= ls && x.start <= le));
}
// Newest dated explicit-miss marker on the line holding the winning mention (legacy rows).
function _winnerMarkerDate(win, today) {
  if (!win) return null;
  const t = _str(win.text);
  const ls = t.lastIndexOf('\n', win.m.start - 1) + 1;
  const le = t.indexOf('\n', win.m.start) === -1 ? t.length : t.indexOf('\n', win.m.start);
  const ds = explicitRepairMiss(t.slice(ls, le), today).map((x) => x.date).filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function _ymdBefore(d, today) { return typeof d === 'string' && YMD_RE.test(d) && d < _str(today); }
// User-note fields whose "No ETC" an extracted miss can override (visible marker, §3.5).
const USER_NOTE_FIELDS = Object.freeze(['savedNotes', 'canonicalNextStep', 'canonicalSituation']);
function _structMiss(fe, today) {
  const sm = fe && fe.structuredMiss;
  return sm && typeof sm === 'object' && _ymdBefore(sm.date, today) ? sm : null;
}
function _passedHead(fe, today) {
  const ph = fe && fe.passedHead;
  return ph && typeof ph === 'object' && _ymdBefore(ph.date, today) ? ph : null;
}
// The explicit miss an ETC-Today result carries (design §3.3; read by countedEtc rule 4).
function _todayMissDate(fe, today) {
  const sm = _structMiss(fe, today);
  return (fe && fe.explicitMissDate) || (sm && sm.date) || null;
}
// Extracted ETC re-classified at build time (D3): the stored state is not trusted for dated
// states. An explicit miss (explicitMissDate / structuredMiss, DR2-2, §3.4) stays missed; a
// current 'today' head keeps precedence over it. A passed date with no miss -> none.
function _feEffective(fe, today) {
  if (fe.state === 'missed' && fe.date) return { state: 'missed', date: fe.date, explicitMissDate: fe.explicitMissDate || fe.date, snippet: fe.snippet };
  const live = fe.negated || !fe.date ? 'none' : _classifyEtc(fe.date, today);
  if (live === 'today') return { state: 'today', date: fe.date, explicitMissDate: _todayMissDate(fe, today), snippet: fe.snippet };
  const sm = _structMiss(fe, today);
  if (sm) return { state: 'missed', date: sm.date, explicitMissDate: sm.date, snippet: sm.snippet || fe.snippet };
  if (live === 'missed') {
    if (_ymdBefore(fe.explicitMissDate, today)) return { state: 'missed', date: fe.explicitMissDate, explicitMissDate: fe.explicitMissDate, snippet: fe.snippet };
    return { state: 'none', date: null, missDowngraded: true, passedDate: fe.date, snippet: fe.snippet };
  }
  return { state: live, date: live === 'none' ? null : fe.date, snippet: fe.snippet };
}
// A none result with a passed, unmarked extracted ETC: 'ETR M/D passed, no miss reported'.
function _markPassed(out, fe, today) {
  const ph = _passedHead(fe, today);
  if (out.state !== 'none' || out.missDowngraded || !ph) return out;
  return Object.assign({}, out, { missDowngraded: true, passedDate: ph.date });
}

// relay-extract §14.6 freshness takeover by _factEtc + Path B (only for rows with _factsOn).
// Counted conservatively by design; met/revision nuance lives in the Details prose, not the counts.
function _withFactEtc(res, win, field, r, today) {
  const fe = r._factEtc;
  let take = false;
  if (_hasFactEtc(fe)) {
    const stated = _localDay(fe.statedAt);
    if (!field) take = true;
    else if (field === 'asistNotes') {
      const e = offsiteEntries(win.text).find((x) => win.m.start >= x.start && win.m.start < x.end);
      const day = e && e.atMs != null ? _localDay(e.atMs) : '';
      take = !day || (!!stated && stated >= day);
    } else if (field === 'repairTimeline') {
      take = !!stated && !!win.date && stated >= win.date;
    }
  }
  const statedDay = fe && typeof fe === 'object' ? (_localDay(fe.statedAt) || null) : null;
  if (take) {
    // Precedence today > missed > future > none: a newer negation never hides an explicit miss.
    const eff = _feEffective(fe, today);
    const out = { state: eff.state, date: eff.date, source: 'extracted', snippet: eff.snippet ? _snippet(eff.snippet, 0) : '', statedDay };
    if (eff.explicitMissDate !== undefined) out.explicitMissDate = eff.explicitMissDate;
    if (eff.missDowngraded) Object.assign(out, { missDowngraded: true, passedDate: eff.passedDate });
    return _markPassed(out, fe, today);
  }
  const eff = fe && typeof fe === 'object' ? _feEffective(fe, today) : null;
  const userField = USER_NOTE_FIELDS.includes(res.source);
  const ph = _passedHead(fe, today);
  let out = res;
  if (res.state === 'missed' && !(eff && eff.state === 'missed') && !(win && _winnerHasMarker(win, today))) {
    out = Object.assign({}, res, { state: 'none', date: null, missDowngraded: true });
  } else if (res.state !== 'missed' && eff && eff.state === 'missed') {
    // An explicit repair-completion miss outranks a legacy future/none (precedence today > missed).
    // Deliberate Path-B deviation from design §14.6/AC35: this also applies when the legacy winner
    // is user-authored savedNotes / canonical* (including a user "No ETC"); then it is marked.
    if (res.state !== 'today') {
      out = { state: 'missed', date: eff.date, source: 'extracted', snippet: eff.snippet ? _snippet(eff.snippet, 0) : '', explicitMissDate: eff.explicitMissDate, statedDay };
      if (userField) out.overrode = { field: res.source, was: res.state, userSnippet: res.snippet };
    } else {
      out = Object.assign({}, res, { explicitMissDate: eff.explicitMissDate });
    }
  } else if (userField && win && win.m.negated && ph) {
    // User Q9 rule (design §14): a saved "No ETC" + an extracted ETC whose date already passed
    // flips to Missed ETC, with the visible override marker.
    out = {
      state: 'missed', date: ph.date, source: 'extracted', snippet: fe.snippet ? _snippet(fe.snippet, 0) : '',
      explicitMissDate: null, viaPassedHead: true, statedDay: _localDay(ph.statedAt) || null,
      overrode: { field: res.source, was: 'none', userSnippet: res.snippet },
    };
  }
  if (out.state === 'today' && out.explicitMissDate === undefined) out = Object.assign({}, out, { explicitMissDate: _todayMissDate(fe, today) });
  out = _markPassed(out, fe, today);
  if (_hasFactEtc(fe) && fe.date && res.date && fe.date !== res.date && out.source === res.source) {
    out = Object.assign({}, out, { factConflict: { date: fe.date, source: fe.source || null } });
  }
  return out;
}

// -> { state: 'today'|'missed'|'future'|'none', date: 'YYYY-MM-DD'|null, source, snippet, statedDay,
//      explicitMissDate? (every 'today' result), missDowngraded?, passedDate?, overrode?, viaPassedHead? }
// Rows with _factsOn (relay-extract) also go through _withFactEtc. Legacy rows keep a passed
// date as missed only with an explicit marker (D16).
function parseEtc(row, today) {
  const r = row || {};
  for (const field of ETC_SOURCES) {
    const text = _str(r[field]);
    if (!text.trim()) continue;
    let win = null;
    if (field === 'repairTimeline') {
      // Mention on the latest-dated line wins (ties -> later position); undated lines rank below dated ones.
      for (const line of parseTimelineLines(text, today)) {
        for (const mm of _etcMentions(line.raw, today)) {
          const cand = { m: mm, line, date: line.date, text: line.raw };
          if (!win) { win = cand; continue; }
          const a = cand.date || '';
          const b = win.date || '';
          if (a > b || (a === b && (line.index > win.line.index || (line.index === win.line.index && mm.start > win.m.start)))) win = cand;
        }
      }
    } else if (field === 'asistNotes') {
      win = _newestOffsiteMention(text, today);
    } else {
      const ms = _etcMentions(text, today);
      if (ms.length) win = { m: ms[ms.length - 1], text };
    }
    if (!win) continue;
    const snippet = _snippet(win.text, win.m.start);
    const statedDay = _winnerStatedDay(win, field, today);
    const res = win.m.negated
      ? { state: 'none', date: null, source: field, snippet, statedDay }
      : { state: _classifyEtc(win.m.date, today), date: win.m.date, source: field, snippet, statedDay };
    if (r._factsOn) return _withSlip(_withFactEtc(res, win, field, r, today), r);
    // D16: legacy rows keep a passed date as missed only with an explicit marker.
    if (res.state === 'missed' && !_winnerHasMarker(win, today)) return Object.assign({}, res, { state: 'none', date: null, missDowngraded: true });
    if (res.state === 'today') res.explicitMissDate = _winnerMarkerDate(win, today);
    return res;
  }
  const none = { state: 'none', date: null, source: null, snippet: '', statedDay: null };
  return r._factsOn ? _withSlip(_withFactEtc(none, null, null, r, today), r) : none;
}
// The day the winning mention was stated: timeline line date, the 'M/D - ' prefix of the
// savedNotes line, the offsite entry day; null for undated text (canonical*).
function _winnerStatedDay(win, field, today) {
  if (field === 'repairTimeline') return win.date || null;
  if (field === 'savedNotes') {
    const t = _str(win.text);
    const ls = t.lastIndexOf('\n', win.m.start - 1) + 1;
    const le = t.indexOf('\n', win.m.start) === -1 ? t.length : t.indexOf('\n', win.m.start);
    const m = TIMELINE_LINE_RE.exec(t.slice(ls, le));
    return m ? inferDate(m[1], m[2], m[3], today) : null;
  }
  if (field === 'asistNotes') {
    const e = offsiteEntries(win.text).find((x) => win.m.start >= x.start && win.m.start < x.end);
    return e && e.atMs != null ? (_localDay(e.atMs) || null) : null;
  }
  return null;
}
// Relay history ETC revisions (wo-facts _factEtc.slip) ride along on the parsed ETC; rows
// without them return the same object as before.
function _withSlip(out, r) {
  const s = r._factEtc && r._factEtc.slip;
  if (!s || typeof s !== 'object') return out;
  return Object.assign({}, out, { slip: { count: Number(s.count) || 0, seq: Array.isArray(s.seq) ? s.seq.slice() : [] } });
}

// ── ETC buckets (design §3.2) ───────────────────────────────────────────────
// (a) A newer line says the ETC is gone, unsure or blocked. ETC / ETR stay case-sensitive.
const ETC_UNDERCUT_RES = Object.freeze([
  /\b[Nn]o\s+(?:(?:new|revised|repair|firm|updated|confirmed)\s+){0,3}(?:ETC|ETR)\b/,
  /\b(?:ETC|ETR)\b(?:\s+(?:is|remains|still|has|been|was|currently|yet)){0,3}\s+(?:not\s+(?:yet\s+)?(?:set|stated|known|confirmed|reconfirmed|provided|given|available)|unknown|TBD|tbd|pending)\b/,
  /\b(?:ETC|ETR)\b[^.;\n]{0,30}?\b(?:at\s+risk|has\s+passed|passed|missed|slipp(?:ed|ing))\b/,
  /\b(?:repairs?|completion)\s+(?:remains?\s+|is\s+)?(?:blocked|on\s+hold)\b/i,
]);
// Pattern 3 (index 2) is checked per match: a date between the token and the keyword must be
// the counted ETC date (DR2-3), so "ETR 11/24 missed, new ETR 11/25" does not undercut 11/25.
const _UNDERCUT_P3_G = new RegExp(ETC_UNDERCUT_RES[2].source, 'g');
const _MD_OR_ISO_G = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)|\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const DIAG_NONE_RE = /\bno\s+(?:diagnosis|repair\s+update)\b[^.;\n]{0,30}\b(?:logged|yet|received)\b/i;
const APPT_DATE_RE = /\b(?:appointment|appt|scheduled|tech(?:nician)?\s+(?:expected|arriv\w*|on[- ]?site|visit|callout|dispatch\w*))\b[^.;\n]{0,25}?(\d{1,2}\/\d{1,2})/i;
const NOT_STARTED_STATUSES = Object.freeze(['waiting for vendor', 'under diagnosis', 'vehicle arrived']);
const STALE_ETR_DAYS = 7;
const ROLLING_ETR_SLIPS = 5;

function _datesIn(s, today) {
  const out = [];
  _MD_OR_ISO_G.lastIndex = 0;
  let m;
  while ((m = _MD_OR_ISO_G.exec(s))) {
    const d = m[1] ? m[1] + '-' + m[2] + '-' + m[3] : inferDate(m[4], m[5], m[6], today);
    if (d) out.push(d);
  }
  return out;
}
function _undercutHit(line, etcDate, today) {
  for (let i = 0; i < ETC_UNDERCUT_RES.length; i++) {
    if (i !== 2) { if (ETC_UNDERCUT_RES[i].test(line)) return true; continue; }
    _UNDERCUT_P3_G.lastIndex = 0;
    let m;
    while ((m = _UNDERCUT_P3_G.exec(line))) {
      if (_datesIn(m[0], today).every((d) => d === etcDate)) return true;
    }
  }
  return false;
}
// Lines of the counted text source that hold a positive mention of the ETC date (the winning line).
function _winningLines(r, etc, today) {
  if (!etc.source || etc.source === 'extracted' || !ETC_SOURCES.includes(etc.source)) return [];
  const lines = etc.source === 'repairTimeline'
    ? parseTimelineLines(r.repairTimeline, today).filter((l) => !etc.statedDay || l.date === etc.statedDay).map((l) => l.raw)
    : _str(r[etc.source]).split(/\r?\n/);
  return lines.filter((l) => l.trim() && _etcMentions(l, today).some((x) => !x.negated && x.date === etc.date));
}
// Lines read by checks (a) / (c): dated timeline + savedNotes lines and offsite entries on or
// after the stated day (== today when it is unknown), the undated canonical next step /
// situation (current) and the winning line itself.
function _currentLines(r, etc, today) {
  const from = etc.statedDay || null;
  const ok = (d) => !!d && (from ? d >= from : d === today);
  const out = [];
  for (const f of ['repairTimeline', 'savedNotes']) {
    for (const l of parseTimelineLines(r[f], today)) if (ok(l.date)) out.push(l.raw);
  }
  const an = _str(r.asistNotes);
  for (const e of offsiteEntries(an)) {
    if (e.atMs != null && ok(_localDay(e.atMs))) out.push(an.slice(e.start, e.end));
  }
  for (const f of ['canonicalNextStep', 'canonicalSituation']) {
    for (const l of _str(r[f]).split(/\r?\n/)) if (l.trim()) out.push(l);
  }
  for (const l of _winningLines(r, etc, today)) out.push(l);
  return [...new Set(out.map((l) => l.trim()))];
}
function _undercutText(line) {
  const s = _redact(_str(line).replace(/\s+/g, ' ').trim());
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1).trimEnd() + '\u2026' : s;
}
// The first failing ETC-Today check (a)..(f) -> { reason, undercut } | null.
function _etcTodayFails(r, etc, today) {
  const lines = _currentLines(r, etc, today);
  const neg = lines.find((l) => _undercutHit(l, etc.date, today));
  if (neg) return { reason: 'newer-negation', undercut: _undercutText(neg) };
  const pe = _str(r.partsEta).trim();
  if (partsWait(r, today) && !(YMD_RE.test(pe) && pe === today)) return { reason: 'parts-wait', undercut: null };
  if (NOT_STARTED_STATUSES.includes(_norm(r.savedRepairStatus))
    || _norm(r.vendorDelayReason) === 'waiting for diagnosis'
    || _norm(r.delayReasonCodes).includes('waiting for diagnosis')) return { reason: 'not-started', undercut: null };
  const diag = lines.find((l) => DIAG_NONE_RE.test(l));
  if (diag) return { reason: 'not-started', undercut: _undercutText(diag) };
  for (const l of _winningLines(r, etc, today)) {
    const m = APPT_DATE_RE.exec(l);
    if (!m) continue;
    const dm = /^(\d{1,2})\/(\d{1,2})$/.exec(m[1]);
    if (dm && inferDate(dm[1], dm[2], null, today) === etc.date) return { reason: 'appointment', undercut: _undercutText(l) };
  }
  if (etc.slip && Number(etc.slip.count) >= ROLLING_ETR_SLIPS) return { reason: 'rolling-etr', undercut: null };
  const sd = _toUtc(etc.statedDay);
  if (Number.isFinite(sd) && (_toUtc(today) - sd) / DAY_MS > STALE_ETR_DAYS) return { reason: 'stale-etr', undercut: null };
  return null;
}

// Sheet bucket of one down unit (pure): -> { bucket: 'today'|'none'|'missed', reason, undercut }.
// ETC Today needs evidence the repair finishes today; an unsupported ETC Today goes to Missed
// only when an explicit miss was reported in the same episode (etc.explicitMissDate).
function countedEtc(row, etc, today) {
  const r = row || {};
  const e = etc && typeof etc === 'object' ? etc : {};
  if (e.state === 'missed') return { bucket: 'missed', reason: e.viaPassedHead ? 'no-etc-note-passed-etr' : 'explicit-miss', undercut: null };
  if (e.state === 'future') return { bucket: 'none', reason: 'future', undercut: null };
  if (e.state !== 'today') return { bucket: 'none', reason: 'no-etc', undercut: null };
  const fail = _etcTodayFails(r, e, today);
  if (!fail) return { bucket: 'today', reason: 'etc-today', undercut: null };
  return { bucket: e.explicitMissDate ? 'missed' : 'none', reason: fail.reason, undercut: fail.undercut };
}

// ── Barrier rules (one table; tune here) ────────────────────────────────────
const OEM_VENDOR_RE = /volvo|asist|freightliner|daimler|peterbilt|paccar|kenworth|\bkwne\b|pete_store|\binternational\b|navistar|\bmack\b|dealer/i;
const ONSITE_VENDOR_RE = /amerit|\bta\b|travel\s*centers|\bcox\b|velociti|fleetnet|\bmobile\b|onsite|road\s*ready|goodyear/i;
const VENDOR_REJECT_RE = /\b(reject(ed)?|declin(ed|ing)|unable to (complete|repair|diagnose)|can(no|')t (complete|repair|fix)|not equipped|beyond (scope|capabilit)|refer(red)? (out|to (a )?(dealer|oem|shop))|send(ing)? (it )?to (the )?(dealer|oem))\b/gi;
// The AAP repair status "Cannot Complete — Parts Ordered" is a parts wait, not a vendor
// rejection: the parts words in the +-25-char context skip the match (the unit still gets
// its Parts Delay hit from the status / code rules).
const AAP_PARTS_STATUS_RE = /\bparts?\s+(ordered|on\s+order|back[\s-]?order(ed)?)\b/i;
const REJECT_CONTEXT_EXCLUDE_RE = new RegExp(/estimate|quote|approval|\bPO\b/.source + '|' + AAP_PARTS_STATUS_RE.source, 'i');
const ESTIMATE_TEXT_RE = /\b(awaiting|pending|waiting (on|for))\s+(an?\s+)?(estimate|approval)\b/i;
// Golden 1P list: any COX / Amerit / TA / … unit (no stall signal). FleetNet is not 1P.
const VENDOR_1P_RE = /\bcox\b|amerit|\bta\b|travel\s*centers|velociti|road\s*ready|goodyear|\bmobile\b|onsite|allegiance|ascend/i;
// The dealer is done and the unit has left (OEM exclusion with status Repair completed).
const RELEASED_RE = /\b(?:asset\s+released|released\s+(?:to|and)|towed\s+out|picked\s+up)\b/i;
const ESTIMATE_APPROVED_RE = /\bestimate\b[^.;\n]{0,30}\bapproved\b|\bapproved\b[^.;\n]{0,20}\bestimate\b/i;
const DSP_VENDOR_RE = /^dsp[_ ]?entered$/i;
const IMPOUND_TEXT_RE = /\bimpound(?:ed)?\b/i;
const PARTNER_TEXT_RE = /\b(?:carrier|dsp)[- ](?:managed|owned|handling|to\s+(?:handle|repair))\b|\bwaiting\s+on\s+(?:the\s+)?(?:carrier|dsp)\b|\bcarrier(?:'s)?\s+(?:shop|estimate|approval)\b/i;
const PARTS_CODE_RE = /parts|sourcing|back ?order/;
const PARTS_TEXT_RE = /back[- ]?order|parts? (delay|on order|eta)|waiting (on|for) parts/i;
const PARTS_WAIT_STATUSES = Object.freeze(['ordered', 'backorder', 'backordered', 'sourcing', 'on order']);
const PARTS_ARRIVED_STATUSES = Object.freeze(['arrived', 'received', 'delivered']);
const FACT_PARTS_WAIT_RE = /\b(?:ordered|back ?order|on order|shipped)\b/i;

const _eq = (a, b) => _str(a).trim().toLowerCase() === b.toLowerCase();

function _vendorRejectWhy(text) {
  VENDOR_REJECT_RE.lastIndex = 0;
  let m;
  while ((m = VENDOR_REJECT_RE.exec(text))) {
    const ctx = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25);
    if (REJECT_CONTEXT_EXCLUDE_RE.test(ctx)) continue; // Amazon rejecting an estimate is an Estimate barrier
    return "vendor can't complete: '" + _snippet(text, m.index) + "'";
  }
  return null;
}

function _oemSignal(r, ctx) {
  const status = _str(r.savedRepairStatus).trim();
  if (_eq(status, 'Waiting for vendor') || _eq(status, 'Under diagnosis')) return 'status ' + status;
  if (/no status set by the dealer/i.test(_str(r.offsiteStageDetail))) return 'offsite: ' + _codeText(r.offsiteStageDetail);
  const codes = _norm(r.delayReasonCodes);
  if (codes.includes('tech shortage')) return 'delay code Tech shortage';
  if (codes.includes('waiting for diagnosis')) return 'delay code Waiting for diagnosis';
  if (ctx.daysDown != null && ctx.daysDown >= 14) return ctx.daysDown + 'd down';
  return null;
}

function _partsCodes(raw) {
  const pieces = _str(raw).split(/[,;|\n]/).map(_codeText).filter(Boolean);
  const hit = pieces.filter((p) => PARTS_CODE_RE.test(_norm(p)));
  return (hit.length ? hit : [_codeText(raw)]).join(', ');
}

// Parts wait (design §3.6): the unit waits on parts that have not arrived. Shared by the
// Parts barrier and the ETC Today check. -> { wait: boolean, why: string } (why '' when no wait).
function _partsCheck(row, today, recentText) {
  const r = row || {};
  const status = _str(r.savedRepairStatus).trim();
  const ps = _norm(r.partsStatus);
  const arrived = PARTS_ARRIVED_STATUSES.includes(ps);
  const pw = _str(r._factPartsWhy).trim();
  const whys = [];
  if (/parts ordered|back ?order/i.test(status)) whys.push('status ' + status);
  else if (_eq(status, 'Parts received')) return { wait: false, why: '' };
  else {
    if (PARTS_WAIT_STATUSES.includes(ps)) whys.push('parts status ' + _codeText(r.partsStatus));
    if (PARTS_CODE_RE.test(_norm(r.delayReasonCodes))) whys.push('delay code ' + _partsCodes(r.delayReasonCodes));
    const vdr = _str(r.vendorDelayReason).trim();
    if (vdr && PARTS_CODE_RE.test(_norm(vdr))) whys.push('vendor delay ' + vdr);
    if (_eq(r.lifecycleReason, 'Parts Delay') && !arrived) whys.push('lifecycle Parts Delay');
    if (pw && FACT_PARTS_WAIT_RE.test(pw) && !arrived) whys.push(pw);
    const text = recentText !== undefined ? _str(recentText) : _recentText(r, today);
    const m = PARTS_TEXT_RE.exec(text);
    if (m) whys.push("'" + _snippet(text, m.index) + "'");
  }
  if (!whys.length) return { wait: false, why: '' };
  // The extracted parts summary extends an existing hit.
  if (pw && !whys.includes(pw)) whys.push(pw);
  return { wait: true, why: whys.join('; ') };
}
// true when the unit is waiting on parts that have not arrived (pure; today = 'YYYY-MM-DD').
function partsWait(row, today) { return _partsCheck(row, today).wait; }
// The why text for a partsWait unit, '' when partsWait is false.
function partsWhy(row, today) { return _partsCheck(row, today).why; }

// Partner kind of a unit: 'dsp' | 'impound' | 'text' with its why, or null.
function _partnerHit(r, ctx) {
  const vendor = _str(r.vendor).trim();
  if (DSP_VENDOR_RE.test(vendor)) return { why: 'DSP-entered (carrier-managed)', kind: 'dsp' };
  const lr = _str(r.lifecycleReason).trim();
  if (/impound/i.test(lr)) return { why: 'lifecycle ' + lr, kind: 'impound' };
  const text = _str(ctx.recentText);
  let m = IMPOUND_TEXT_RE.exec(text);
  if (m) return { why: "'" + _snippet(text, m.index) + "'", kind: 'impound' };
  m = PARTNER_TEXT_RE.exec(text);
  if (m) return { why: "'" + _snippet(text, m.index) + "'", kind: 'text' };
  return null;
}

function _estimateApproved(r, today) {
  if (/approved/i.test(_str(r.estimateStatus))) return true;
  const newest = _recentTimeline(r, today)[0];
  return !!(newest && newest.date && ESTIMATE_APPROVED_RE.test(newest.text));
}

const BARRIER_RULES = Object.freeze([
  Object.freeze({
    id: 'vendor1p', ynCol: 'vendor1pYN', detailsCol: 'vendor1pDetails',
    test(r, ctx) {
      const vendor = _str(r.vendor).trim();
      if (!VENDOR_1P_RE.test(vendor)) return null;
      const p = _partnerHit(r, ctx);
      if (p && (p.kind === 'impound' || p.kind === 'dsp')) return null;
      // No stall signal needed (golden); a stall signal only enriches the why.
      let signal = _vendorRejectWhy(ctx.recentText);
      if (!signal && _eq(r.savedRepairStatus, 'Waiting for vendor')) signal = 'status Waiting for vendor';
      if (!signal && _norm(r.delayReasonCodes).includes('tech shortage')) signal = 'delay code Tech shortage';
      return { why: '1P vendor ' + vendor + (signal ? ': ' + signal : ''), kind: signal ? 'stalled' : 'onsite' };
    },
  }),
  Object.freeze({
    id: 'oem', ynCol: 'oemYN', detailsCol: 'oemDetails',
    test(r, ctx) {
      const vendor = _str(r.vendor).trim();
      const byVendor = OEM_VENDOR_RE.test(vendor);
      if (!(byVendor || _eq(r.lifecycleReason, 'Offsite Shop Repair'))) return null;
      if (_eq(r.savedRepairStatus, 'Repair completed')
        && _recentTimeline(r, ctx.today).some((l) => RELEASED_RE.test(l.text))) return null;
      const signal = _oemSignal(r, ctx);
      // Unanswered dealer calls go to the why text only; they never create an OEM hit.
      const calls = Number(r.dealerCallAttempts) > 0 ? '; ' + Number(r.dealerCallAttempts) + ' unanswered dealer calls' : '';
      return { why: 'at OEM/dealer ' + (vendor || 'no vendor') + (signal ? ': ' + signal : '') + calls, kind: byVendor ? 'dealer' : 'offsite' };
    },
  }),
  Object.freeze({
    id: 'estimate', ynCol: 'estimateYN', detailsCol: 'estimateDetails',
    test(r, ctx) {
      const p = _partnerHit(r, ctx);
      if (p && p.kind === 'dsp') return null;                         // the carrier's estimate is a Partner barrier
      if (_eq(r.serviceState, 'Estimate rejected') || /reject/i.test(_str(r.estimateStatus))) return { why: 'estimate rejected', kind: 'rejected' };
      const fe = _str(r._factEstimateWhy).trim();                    // relay-extract (flag-on rows only)
      if (fe) return { why: 'estimate ' + fe, kind: /reject/i.test(fe) ? 'rejected' : 'pending' };
      if (_estimateApproved(r, ctx.today)) return null;
      const cost = parseFloat(_str(r.estimatePendingCost).replace(/[$,\s]/g, ''));
      if (Number.isFinite(cost) && cost > 0) return { why: 'estimate pending $' + cost, kind: 'pending' };
      const status = _str(r.savedRepairStatus).trim();
      if (_eq(status, 'Awaiting estimate') || _eq(status, 'Awaiting approval')) return { why: 'status ' + status, kind: 'pending' };
      if (_eq(r.offsiteStage, 'approval')) return { why: 'offsite stage approval', kind: 'pending' };
      const esc = _str(r.escalations).trim();
      if (/estimate/i.test(esc)) return { why: 'escalation ' + _snippet(esc, esc.search(/estimate/i)), kind: 'pending' };
      const m = ESTIMATE_TEXT_RE.exec(ctx.recentText);
      if (m) return { why: "'" + _snippet(ctx.recentText, m.index) + "'", kind: 'pending' };
      return null;
    },
  }),
  Object.freeze({
    id: 'partner', ynCol: 'partnerYN', detailsCol: 'partnerDetails',
    test(r, ctx) { return _partnerHit(r, ctx); },
  }),
  Object.freeze({
    id: 'parts', ynCol: 'partsYN', detailsCol: 'partsDetails',
    test(r, ctx) {
      const p = _partsCheck(r, ctx.today, ctx.recentText);
      return p.wait ? { why: p.why, kind: 'wait' } : null;
    },
  }),
]);

// One down unit -> { [ruleId]: { why, kind } | null }
function classifyBarriers(row, ctx = {}) {
  const r = row || {};
  const c = {
    today: ctx.today,
    daysDown: ctx.daysDown !== undefined ? ctx.daysDown : _days(r),
    recentText: ctx.recentText !== undefined ? ctx.recentText : _recentText(r, ctx.today),
  };
  const out = {};
  for (const rule of BARRIER_RULES) out[rule.id] = rule.test(r, c) || null;
  return out;
}

// ── Common Repairs ──────────────────────────────────────────────────────────
function _unitCategories(r) {
  const cats = new Set();
  const text = _str(r.issueSummary) + ' ' + _str(r.issueDetails);
  for (const [label, re] of engine.TREND_TERMS) if (re.test(text)) cats.add(label);
  const lr = _str(r.lifecycleReason).trim();
  if (/^damaged/i.test(lr)) cats.add('Damage repair');
  if (_eq(lr, 'Accident')) cats.add('Accident');
  if (_eq(lr, 'Expired Inspection')) cats.add('Expired inspection');
  return cats;
}

// Fleet-Health-local system groups over issueSummary + issueDetails (design §3.7). Lifecycle
// labels (damage, accident, inspection) are never a group.
const SYSTEM_GROUPS = Object.freeze([
  ['Battery/electrical', /\bbatter(?:y|ies)\b|\balternator\b|\bstarter\b|\bno[- ]start\b|\bwiring\b|\bharness\b|\belectrical\b|\bvoltage\b|\bparasitic\b|\bfuse\b/i],
  ['Engine', /\bmisfire|\bturbo|\binjector|\bcompression\b|\bvalve\s*(?:tap|cover)|\bcylinder\b|\bcrankcase\b|\b(?:engine\s+)?oil\s*(?:leak|pan|pressure|level|gasket|drop)|\bno\s+oil\b|\bgasket\b|\bccv\b|\begr\b|\bignition\s+coil|\bspark\s+plug|\bengine\s+(?:oil|noise|not\s+running)/i],
  ['Air system / 5th wheel', /\bair\s*(?:leak|bag|spring|ride|system|tank|line|dryer|brake|suspension)|\bairbag|\b(?:5th|fifth)[\s-]*wheel/i],
  ['Cooling', /\bcoolant\b|\bradiator\b|\bcooling\b/i],
  ['Aftertreatment', /\bdef\b|\bdpf\b|\bscr\b|\bcatalyst\b|\bnox\b|\bo2\s+sensor/i],
  ['Transmission', /\btransmission\b|\bclutch\b/i],
  ['Axle/differential', /\baxle\b|\bdifferential\b|\bdriveshaft/i],
  ['Brakes', /\bbrakes?\b|\babs\b/i],
  ['Steering', /\bsteering\b|\balignment\b/i],
  ['Suspension', /\bsuspension\b|\bleaf\s*spring|\bshock\s+absorber/i],
  ['Tires/wheels', /\btires?\b|\bwheel\s+seal|\blug\s+nut/i],
  ['Liftgate', /\bliftgate\b/i],
  ['Fuel/CNG', /\bcng\b|\bfuel\s*(?:system|pump|line|tank|leak)/i],
].map(Object.freeze));
// A repeat repair makes one unit common on its own (golden YTSC 11-12).
const REPEAT_RE = /\b(?:repeat(?:ed)?\s+(?:repair|issue|failure)|came\s+back|re-?opened|did\s+not\s+(?:resolve|fix)|didn'?t\s+(?:resolve|fix)|not\s+resolved\s+by|returned\s+for\s+the\s+same|comeback|recurr(?:ing|ent|ed))\b/i;

// All SYSTEM_GROUPS labels of one unit, in table order.
function _unitSystems(r) {
  const text = _str(r && r.issueSummary) + ' ' + _str(r && r.issueDetails);
  return SYSTEM_GROUPS.filter(([, re]) => re.test(text)).map(([label]) => label);
}
function _isRepeat(r, today) {
  const parts = [_str(r.issueSummary), _str(r.issueDetails)];
  for (const l of _recentTimeline(r, today)) parts.push(l.raw.trim());
  return REPEAT_RE.test(parts.join('\n'));
}

// Down rows of one pair -> { yn, details, common: [{ label, ids }], repeat: [ids] }.
// A group is common with >= COMMON_REPAIR_MIN units; a REPEAT_RE unit is common on its own.
function commonRepairs(downRows, today) {
  const byLabel = new Map();
  const repeat = [];
  for (const r of downRows || []) {
    if (!r) continue;
    const id = _idOf(r);
    for (const label of _unitSystems(r)) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(id);
    }
    if (_isRepeat(r, today)) repeat.push(id);
  }
  const common = [...byLabel.entries()]
    .filter(([, ids]) => ids.length >= COMMON_REPAIR_MIN)
    .map(([label, ids]) => ({ label, ids: ids.slice().sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  repeat.sort();
  // 'Label: ids' lines (the row's commonDetails cell comes from composeSheet).
  const lines = common.map((c) => c.label + ': ' + c.ids.join(', '));
  if (repeat.length) lines.push('Repeat repair: ' + repeat.join(', '));
  return { yn: common.length || repeat.length ? 'Y' : 'N', details: lines.join('\n'), common, repeat };
}

// ── Sheet composer (design §3.8) ────────────────────────────────────────────
// The gate requires this module at load time, so the gate is reached only through this call-time
// require (never at module top): stripRefs / sheetForbidden / the sheet caps.
function _gate() { return require('./fleet-dbr-gate'); }

const VENDOR_LABELS = Object.freeze([
  [/\bcox\b/i, 'COX'], [/amerit/i, 'Amerit'], [/\bkwne\b/i, 'KWNE'], [/\bta\b|travel\s*centers/i, 'TA'],
  [/volvo|asist/i, 'Volvo/ASIST'], [/freightliner|daimler/i, 'Freightliner'], [/kenworth|paccar/i, 'Kenworth/PACCAR'],
  [/peterbilt/i, 'Peterbilt'], [/international|navistar/i, 'International'], [/\bmack\b/i, 'Mack'],
  [/^dsp[_ ]?entered$/i, 'DSP'], [/fleetnet/i, 'FleetNet'], [/\bcei\b/i, 'CEI'], [/allegiance|ascend/i, 'Ascendance'],
].map(Object.freeze));
// Raw vendor -> the sheet's vendor label (golden spelling); unknown vendors: '_' -> space,
// parenthetical dropped; empty -> 'no vendor'.
function vendorLabel(v) {
  const s = _str(v).trim();
  if (!s) return 'no vendor';
  for (const [re, label] of VENDOR_LABELS) if (re.test(s)) return label;
  return s.replace(/\([^)]*\)/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'no vendor';
}

const SHORT_ISSUE_MAX = 48;
const SHORT_ISSUE_MIN = 15;
const ISSUE_PREFIX_RE = /^(?:(?:unit|truck|tractor)\s+(?:needs|requires|has)\s+(?:a|an|the)?\s*|reported\s+)/i;
const ISSUE_SEPS = Object.freeze([', ', ' and ', ' due to ', ' with ']);
const ISSUE_STOPWORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'to', 'with', 'on', 'for', 'due', 'at']);
// Text up to the first sentence end ([.!?] then whitespace / end) outside parentheses.
function _firstSentence(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '.' || ch === '!' || ch === '?') && (i + 1 >= s.length || /\s/.test(s[i + 1]))) return s.slice(0, i);
  }
  return s;
}
// A unit's short issue (<= 48 chars) from issueSummary: first sentence, prefix strip, refs
// stripped whole, shortened at a list joint or word boundary, first letter lowercased.
function shortIssue(u) {
  let s = _str(u && u.issueSummary).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = _firstSentence(s);
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi);
  s = _gate().stripRefs(s.trim().replace(ISSUE_PREFIX_RE, ''));
  if (s.length > SHORT_ISSUE_MAX) s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
  if (s.length > SHORT_ISSUE_MAX) {
    let cut = -1;
    for (const sep of ISSUE_SEPS) {
      for (let k = s.indexOf(sep); k >= 0 && k < SHORT_ISSUE_MAX; k = s.indexOf(sep, k + 1)) {
        if (k >= SHORT_ISSUE_MIN && k > cut) cut = k;
      }
    }
    if (cut >= 0) s = s.slice(0, cut);
    else {
      let c = s.slice(0, SHORT_ISSUE_MAX);
      if (s[SHORT_ISSUE_MAX] !== ' ') { const sp = c.lastIndexOf(' '); if (sp > 0) c = c.slice(0, sp); }
      const words = c.trim().split(' ');
      while (words.length > 1 && ISSUE_STOPWORDS.has(words[words.length - 1].toLowerCase().replace(/[,;:]+$/, ''))) words.pop();
      s = words.join(' ');
    }
  }
  s = s.replace(/[\s,;:\-\u2013\u2014]+$/, '').trim();
  const first = s.split(' ')[0] || '';
  const lead = first.split(/[^A-Za-z0-9]/)[0] || '';        // "APU/cab" -> "APU"
  const keep = (lead.length > 1 && lead === lead.toUpperCase() && /[A-Z]/.test(lead)) || /\d/.test(first);
  return s && !keep ? s[0].toLowerCase() + s.slice(1) : s;
}

const STATUS_PHRASES = Object.freeze({
  'parts ordered': 'parts on order', 'parts backordered': 'parts on order', 'parts back ordered': 'parts on order',
  'backordered': 'parts on order', 'waiting for vendor': 'waiting for vendor', 'under diagnosis': 'under diagnosis',
  'vehicle arrived': 'awaiting diagnosis', 'repair in progress': 'repair in progress',
  'repair completed': 'repair done, awaiting release', 'ready for pickup': 'ready for pickup',
  'parts received': 'parts received, awaiting tech',
});
const ESTIMATE_STATUSES = Object.freeze(['awaiting estimate', 'awaiting approval', 'awaiting estimate / approval', 'awaiting estimate/approval']);
// Status phrase of one composer unit ({ status, barriers, estApproved }).
function _statusPhrase(u) {
  const st = _codeText(u.status);
  if (!st) return 'status not set';
  const n = st.toLowerCase();
  if (STATUS_PHRASES[n]) return STATUS_PHRASES[n];
  if (ESTIMATE_STATUSES.includes(n)) return !u.barriers.includes('estimate') && u.estApproved ? 'estimate approved' : 'awaiting estimate';
  return n.length <= 30 && /^[a-z ]+$/i.test(n) ? n : 'open';
}
function _summary(units) {
  const counts = new Map();
  for (const u of units) counts.set(u.phrase, (counts.get(u.phrase) || 0) + 1);
  if (counts.size === 1) return (units.length > 1 ? 'all ' : '') + units[0].phrase;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, k]) => p + ' (' + k + ')').join(', ');
}
// 'A', 'A and B', 'A, B and C'.
function _list(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
// At most k items, the tail replaced by '+N more'.
function _capItems(items, k) {
  return items.length > k ? items.slice(0, k).concat('+' + (items.length - k) + ' more') : items;
}
// Tier 1 'ID (Nd, issue)', 2 'ID Nd', 3 'ID'; a unit with a forbidden label never shows it.
function _frag(u, tier) {
  const days = u.daysDown == null ? '' : u.daysDown + 'd';
  if (tier === 1 && !u.forceT3) {
    const inner = [days, u.label].filter(Boolean).join(', ');
    return inner ? u.id + ' (' + inner + ')' : u.id;
  }
  if (tier === 2 && !u.forceT3 && days) return u.id + ' ' + days;
  return u.id;
}
// Units grouped by vendor label: count desc, max days desc, label asc (units keep builder order).
function _vendorGroups(units) {
  const by = new Map();
  for (const u of units) {
    if (!by.has(u.vendorLabel)) by.set(u.vendorLabel, []);
    by.get(u.vendorLabel).push(u);
  }
  const maxDays = (us) => Math.max(...us.map((u) => (u.daysDown == null ? -1 : u.daysDown)));
  return [...by.entries()].map(([label, us]) => ({ label, units: us }))
    .sort((a, b) => b.units.length - a.units.length || maxDays(b.units) - maxDays(a.units) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
// Last resort over the cap: cut at the last '; ' / ', ' joint and end with '.'.
function _hardCut(s, cap) {
  if (s.length <= cap) return s;
  let c = s.slice(0, cap - 1);
  const at = Math.max(c.lastIndexOf('; '), c.lastIndexOf(', '));
  if (at > 0) c = c.slice(0, at);
  return c.replace(/[\s,;:\-\u2013\u2014]+$/, '') + '.';
}
// build(tier, k) -> text; tiers T1, T2, T3, then T3 with id lists capped at k (+N more).
function _fitTiers(build, cap, maxN) {
  for (const tier of [1, 2, 3]) {
    const s = build(tier, Infinity);
    if (s.length <= cap) return s;
  }
  for (let k = Math.max(1, maxN - 1); k >= 1; k--) {
    const s = build(3, k);
    if (s.length <= cap) return s;
  }
  return _hardCut(build(3, 1), cap);
}
function _dot(s) { return s ? (/[.!?]$/.test(s) ? s : s + '.') : ''; }
function _cap1(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
const _PARTNER_REASON = {
  impound: () => 'impounded, release/tow pending',
  text: () => 'waiting on carrier/DSP',
  dsp: (u) => [u.lifecycleReason.toLowerCase(), 'DSP_ENTERED', 'waiting on carrier/DSP'].filter(Boolean).join(', '),
};
function _partnerFas(u) {
  const kind = u.kinds.partner;
  if (kind === 'impound') return 'impound release';
  return 'carrier/DSP' + (kind === 'dsp' ? ' ' + (u.lifecycleReason.toLowerCase() || 'repair') : '');
}
function _partnerSupport(u) {
  const kind = u.kinds.partner;
  if (kind === 'impound') return 'impound release';
  if (kind === 'dsp') return (u.daysDown == null ? '' : u.daysDown + 'd ') + 'carrier/DSP ' + (u.lifecycleReason.toLowerCase() || 'repair');
  return 'carrier/DSP';
}
const _PARTNER_ORDER = { impound: 0, dsp: 1, text: 2 };

// One Details cell (barrier id) for its units. -> build(tier, k)
function _detailsBuilder(id, us, common) {
  const has = (u) => u.barriers.includes(id);
  const units = us.filter(has);
  if (id === 'vendor1p' || id === 'oem') {
    const groups = _vendorGroups(units);
    return (tier, k) => _dot(groups.map((g) => {
      const n = g.units.length;
      const frags = _capItems(g.units.map((u) => _frag(u, tier)), k);
      if (id === 'oem') return g.label + ' offsite: ' + (tier === 1 ? _list(frags) : frags.join(', ')) + ' \u2014 ' + _summary(g.units);
      if (n === 1) return g.label + ': ' + frags[0] + ' \u2014 ' + g.units[0].phrase;
      if (tier === 1) return g.label + ' has ' + n + ' units: ' + _list(frags) + ' \u2014 ' + _summary(g.units);
      return g.label + ' has ' + n + ' units (' + frags.join(', ') + '): ' + _summary(g.units);
    }).join('; '));
  }
  if (id === 'estimate') {
    return (tier, k) => _dot(_capItems(units.map((u) => _frag(u, tier) + ' \u2014 '
      + (u.kinds.estimate === 'rejected' ? 'estimate rejected' : 'estimate pending approval')), k).join('; '));
  }
  if (id === 'partner') {
    return (tier, k) => _dot(_capItems(units.map((u) => _frag(u, tier) + ' \u2014 '
      + (_PARTNER_REASON[u.kinds.partner] || _PARTNER_REASON.text)(u)), k).join('; '));
  }
  if (id === 'parts') {
    const groups = _vendorGroups(units);
    return (tier, k) => {
      if (tier === 2 && k === Infinity) {
        return 'Parts ordered: ' + groups.map((g) => g.units.map((u) => u.id).join(', ') + ' (' + g.label + ')').join(', ') + '.';
      }
      const frags = _capItems(units.map((u) => _frag(u, tier)), k);
      return 'Parts ordered: ' + (tier === 1 ? _list(frags) : frags.join(', ')) + '.';
    };
  }
  // common: 'Group: frags' per group, then 'Repeat repair: frags'; joined '. '.
  const byId = new Map(us.map((u) => [u.id, u]));
  const pick = (ids) => us.filter((u) => ids.includes(u.id) && byId.has(u.id));
  const parts = (common.groups || []).map((g) => [g.label, pick(g.ids || [])])
    .concat((common.repeat || []).length ? [['Repeat repair', pick(common.repeat)]] : [])
    .filter(([, list]) => list.length);
  return (tier, k) => _dot(parts.map(([label, list]) => {
    const frags = _capItems(list.map((u) => _frag(u, tier)), k);
    return label + ': ' + (tier === 1 ? _list(frags) : frags.join(', '));
  }).join('. '));
}

// FAS Actions (plan voice, clauses 1-6 of §3.8). -> build(tier, k) (tier unused: ids only)
function _fasBuilder(us) {
  const clauses = [];
  const named = new Set();
  const add = (head, units, tail) => { clauses.push({ head, units, tail }); for (const u of units) named.add(u.id); };
  const p1 = _vendorGroups(us.filter((u) => u.barriers.includes('vendor1p')));
  for (const g of p1) {
    const pw = g.units.filter((u) => u.barriers.includes('parts'));
    if (pw.length) add('following up ' + g.label + ' on parts ETAs (', pw, ')');
  }
  for (const g of p1) {
    const other = g.units.filter((u) => !u.barriers.includes('parts'));
    if (other.length) add('following up ' + g.label + ' on ', other, ' diag/repair progress');
  }
  for (const g of _vendorGroups(us.filter((u) => u.barriers.includes('oem')))) add('pushing ' + g.label + ' on ', g.units, ' diagnosis/ETC');
  const partner = us.filter((u) => u.barriers.includes('partner'));
  if (partner.length) { clauses.push({ partner }); for (const u of partner) named.add(u.id); }
  const est = us.filter((u) => u.barriers.includes('estimate'));
  if (est.length) add('chasing the estimate decision on ', est, '');
  const rest = us.filter((u) => !named.has(u.id));
  if (rest.length) add('tracking ', rest, '');
  return (tier, k) => _dot(_cap1(clauses.map((c) => (c.partner
    ? 'escalating ' + _list(_capItems(c.partner.map((u) => u.id + ' (' + _partnerFas(u) + ')'), k))
    : c.head + _capItems(c.units.map((u) => u.id), k).join('/') + c.tail)).join('; ')));
}

// Support (first rule that applies, §3.8). -> build(tier, k)
function _supportBuilder(us) {
  const partner = us.filter((u) => u.barriers.includes('partner'))
    .map((u, i) => ({ u, i })).sort((a, b) => (_PARTNER_ORDER[a.u.kinds.partner] ?? 3) - (_PARTNER_ORDER[b.u.kinds.partner] ?? 3) || a.i - b.i)
    .map((x) => x.u);
  if (partner.length) return (tier, k) => 'Support on ' + _list(_capItems(partner.map((u) => u.id + ' (' + _partnerSupport(u) + ')'), k)) + '.';
  const rejected = us.filter((u) => u.kinds.estimate === 'rejected');
  if (rejected.length) return (tier, k) => 'MCS support on ' + _capItems(rejected.map((u) => u.id), k).join('/') + ' rejected estimate' + (rejected.length > 1 ? 's' : '') + '.';
  for (const id of ['oem', 'vendor1p']) {
    const slow = us.filter((u) => u.barriers.includes(id) && u.daysDown != null && u.daysDown >= 14);
    if (!slow.length) continue;
    const labels = _vendorGroups(slow).map((g) => g.label);
    return (tier, k) => 'Vendor performance \u2014 ' + _list(labels) + ' turnaround on ' + _capItems(slow.map((u) => u.id), k).join('/') + '.';
  }
  return () => 'None.';
}

// Compose one cell with the self-check: a forbidden / foreign-ref hit drops the offending units to
// T3 and recomposes; then every unit at T3; then ids only; never a failing cell.
function _composeCell(makeBuild, us, cap, downIds) {
  const G = _gate();
  const bad = (s) => !!G.sheetForbidden(s, downIds);
  const maxN = Math.max(1, us.length);
  let s = _fitTiers(makeBuild(us), cap, maxN);
  if (!bad(s)) return s;
  const fixed = us.map((u) => (bad(_frag(u, 1)) ? Object.assign({}, u, { forceT3: true }) : u));
  s = _fitTiers(makeBuild(fixed), cap, maxN);
  if (!bad(s)) return s;
  s = _fitTiers(makeBuild(us.map((u) => Object.assign({}, u, { forceT3: true }))), cap, maxN);
  if (!bad(s)) return s;
  s = _hardCut(us.map((u) => u.id).join(', ') + '.', cap);
  return bad(s) ? '' : s;
}

// Composer units (builder order) + computed Y/N + row.common -> the 8 sheet cells (single-line).
// cu: { id, daysDown, vendorLabel, label, status, lifecycleReason, barriers, kinds, estApproved }.
// Details '' whenever the cell's Y/N is N (I3); a 0-down row -> '' and Support 'None.' (DR2-12).
function composeSheet(units, yn, common) {
  const G = _gate();
  const out = {};
  const ids = ['vendor1p', 'oem', 'estimate', 'partner', 'parts', 'common'];
  const us = (Array.isArray(units) ? units : []).map((u) => Object.assign({}, u, {
    barriers: Array.isArray(u.barriers) ? u.barriers : [], kinds: u.kinds || {}, lifecycleReason: _str(u.lifecycleReason),
    label: _str(u.label), vendorLabel: _str(u.vendorLabel) || 'no vendor',
  }));
  for (const u of us) u.phrase = _statusPhrase(u);
  const downIds = us.map((u) => u.id);
  if (!us.length) {
    for (const id of ids) out[id + 'Details'] = '';
    out.fasActions = '';
    out.support = 'None.';
    return out;
  }
  const cm = common || { groups: [], repeat: [] };
  for (const id of ids) {
    const inCell = id === 'common'
      ? us.filter((u) => (cm.groups || []).some((g) => (g.ids || []).includes(u.id)) || (cm.repeat || []).includes(u.id))
      : us.filter((u) => u.barriers.includes(id));
    out[id + 'Details'] = (yn && yn[id]) === 'Y' && inCell.length
      ? _composeCell((list) => _detailsBuilder(id, list, cm), inCell, G.SHEET_DETAILS_MAX, downIds)
      : '';
  }
  out.fasActions = _composeCell(_fasBuilder, us, G.SHEET_FAS_MAX, downIds);
  out.support = _composeCell(_supportBuilder, us, G.SHEET_SUPPORT_MAX, downIds) || 'None.';
  return out;
}

// ── Guards / hashing ────────────────────────────────────────────────────────
// Units NOT counted as down whose other status signals say otherwise (shown, not counted).
function statusConflicts(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || isDown(r)) continue;
    const signals = [];
    if (/unavail|out of service|down/i.test(_str(r.canonicalAvailability))) signals.push('canonicalAvailability=' + _str(r.canonicalAvailability).trim());
    if (/out of service|offsite|in repair/i.test(_str(r.serviceState))) signals.push('serviceState=' + _str(r.serviceState).trim());
    if (/out of service|offsite|in repair/i.test(_str(r.subState))) signals.push('subState=' + _str(r.subState).trim());
    if (signals.length) out.push({ id: _idOf(r), signals });
  }
  return out;
}

// sha1 over the pair's down fleet rows (order-independent). Drafts store it to detect staleness.
function unitsHash(downRows) {
  const parts = (downRows || []).map((r) => [
    _idOf(r), _str(r.lifecycleReason).trim(), _str(r.vendor).trim(),
    _str(r.savedRepairStatus).trim(), _str(r.serviceState).trim(),
  ].join(':')).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

// sha1 over the evidence the AI draft reads per down unit (order-independent): the free text
// (repairTimeline, savedNotes, fullConversation, asistNotes) and the status fields. A change
// here with an unchanged unitsHash marks a draft stale by evidence.
const EVIDENCE_HASH_FIELDS = Object.freeze([
  'repairTimeline', 'savedNotes', 'fullConversation', 'asistNotes',
  'lifecycleReason', 'vendor', 'savedRepairStatus', 'serviceState', 'subState',
  'delayReasonCodes', 'offsiteStage', 'offsiteStageDetail', 'escalations', 'estimatePendingCost',
]);
function evidenceHash(downRows) {
  // D5 (relay-extract): r._factsSig only when present, so flag-off hashes are unchanged.
  const parts = (downRows || []).map((r) => JSON.stringify(
    [_idOf(r)].concat(EVIDENCE_HASH_FIELDS.map((f) => _str(r && r[f]).trim()), r && r._factsSig ? [_str(r._factsSig)] : []),
  )).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

// ── Builder ─────────────────────────────────────────────────────────────────
function _stats(total, down) { return { total, down, uptime: uptimePct(total, down) }; }
function _byDaysThenId(a, b) {
  const da = a.daysDown == null ? -1 : a.daysDown;
  const db = b.daysDown == null ? -1 : b.daysDown;
  if (da !== db) return db - da;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
// classifyBarriers result -> units[].why { [ruleId]: <= WHY_MAX chars, redacted } (drill-down only).
function _unitWhy(b) {
  const out = {};
  for (const rule of BARRIER_RULES) {
    const hit = b[rule.id];
    if (!hit) continue;
    const s = _redact(_str(hit.why).replace(/\s+/g, ' ').trim());
    out[rule.id] = s.length > WHY_MAX ? s.slice(0, WHY_MAX - 1).trimEnd() + '\u2026' : s;
  }
  return out;
}
function _unitKinds(b) {
  const out = {};
  for (const rule of BARRIER_RULES) if (b[rule.id]) out[rule.id] = b[rule.id].kind || null;
  return out;
}
// One single-line "why" per Missed ETC unit (row.missedWhy; the cell itself is the bare count).
function _missedWhy(u) {
  const e = u.etc;
  let why;
  if (e.explicitMissDate) why = 'ETC ' + _md(e.explicitMissDate) + ' explicitly missed' + (e.snippet ? ": '" + e.snippet + "'" : '');
  else if (e.viaPassedHead) why = 'ETR ' + _md(e.date) + ' passed and the saved note says No ETC';
  else why = e.snippet ? "'" + e.snippet + "'" : '(no verified reason)';
  return { unit: u.id, date: e.date || null, why: (why + _slipSuffix(e.slip)).replace(/\s*\n\s*/g, ' '), overrode: e.overrode || null };
}
// '; ETC moved N× (M/D→M/D→…)' from Relay history (last 6 dates); '' without slips.
function _slipSuffix(slip) {
  if (!slip || !(slip.count > 0)) return '';
  const seq = (Array.isArray(slip.seq) ? slip.seq : []).map(_md).filter(Boolean);
  const shown = seq.length > 6 ? ['\u2026'].concat(seq.slice(-6)) : seq;
  return '; ETC moved ' + slip.count + '\u00d7' + (shown.length ? ' (' + shown.join('\u2192') + ')' : '');
}

function buildFleetDbr(rows, opts = {}) {
  const today = opts.today;
  const fasName = typeof opts.fasName === 'string' ? opts.fasName : '';
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const dom = new Map();
  const scac = new Map();
  const pairs = new Map();
  let downCount = 0;
  const bump = (map, k) => { if (!map.has(k)) map.set(k, { total: 0, down: 0 }); return map.get(k); };
  for (const r of list) {
    const d = _domicileOf(r);
    const s = _scacOf(r);
    const key = d + '|' + s;
    const down = isDown(r);
    if (down) downCount += 1;
    for (const g of [bump(dom, d), bump(scac, s)]) { g.total += 1; if (down) g.down += 1; }
    if (!pairs.has(key)) pairs.set(key, { key, domicile: d, scac: s, total: 0, down: 0, downRows: [] });
    const p = pairs.get(key);
    p.total += 1;
    if (down) { p.down += 1; p.downRows.push(r); }
  }

  const out = [];
  for (const p of pairs.values()) {
    const ds = dom.get(p.domicile);
    const ss = scac.get(p.scac);
    const domicileStats = _stats(ds.total, ds.down);
    const scacStats = _stats(ss.total, ss.down);
    const hits = {};
    for (const rule of BARRIER_RULES) hits[rule.id] = false;
    const etcBuckets = { today: [], missed: [], none: [] };
    const units = p.downRows.map((r) => {
      const daysDown = _days(r);
      const b = classifyBarriers(r, { today, daysDown });
      const etc = parseEtc(r, today);
      const vendor = _str(r.vendor).trim();
      return {
        id: _idOf(r), daysDown,
        lifecycleReason: _str(r.lifecycleReason).trim(), vendor,
        status: _str(r.savedRepairStatus).trim(), serviceState: _str(r.serviceState).trim(),
        etc, barriers: BARRIER_RULES.filter((x) => b[x.id]).map((x) => x.id),
        why: _unitWhy(b), barrierKinds: _unitKinds(b),
        categories: [..._unitCategories(r)], systems: _unitSystems(r),
        label: shortIssue(r), vendorLabel: vendorLabel(vendor), _why: b, _row: r,
      };
    }).sort(_byDaysThenId);
    const composerUnits = [];
    for (const u of units) {
      for (const rule of BARRIER_RULES) if (u._why[rule.id]) hits[rule.id] = true;
      composerUnits.push({
        id: u.id, daysDown: u.daysDown, vendorLabel: u.vendorLabel, label: u.label, status: u.status,
        lifecycleReason: u.lifecycleReason, barriers: u.barriers, kinds: u.barrierKinds,
        estApproved: _estimateApproved(u._row, today),
      });
      // Every down unit lands in exactly one bucket (I1).
      const c = countedEtc(u._row, u.etc, today);
      u.etc = Object.assign({}, u.etc, { bucket: c.bucket, bucketReason: c.reason, undercut: c.undercut });
      etcBuckets[c.bucket].push(u);
      delete u._why;
      delete u._row;
    }
    const missedWhy = etcBuckets.missed.map(_missedWhy);
    const userEtcOverrides = etcBuckets.missed.filter((u) => u.etc.overrode).map((u) => ({
      unit: u.id, date: u.etc.date || null, userSnippet: u.etc.overrode.userSnippet || '', extractedSnippet: u.etc.snippet || '',
    }));
    const etcInvariant = etcBuckets.today.length + etcBuckets.none.length + etcBuckets.missed.length === p.down;
    const common = commonRepairs(p.downRows, today);
    const yn = { common: common.yn };
    for (const rule of BARRIER_RULES) yn[rule.id] = hits[rule.id] ? 'Y' : 'N';
    const rowCommon = { groups: common.common, repeat: common.repeat };
    const sheet = composeSheet(composerUnits, yn, rowCommon);
    const cells = {
      fasName,
      domicile: p.domicile,
      domicileUptime: fmtPct(domicileStats.uptime),
      domicileDown: String(domicileStats.down),
      scac: p.scac,
      scacUptime: fmtPct(scacStats.uptime),
      scacDown: String(scacStats.down),
      commonYN: common.yn,
      commonDetails: sheet.commonDetails,
      etcToday: String(etcBuckets.today.length),
      noEtc: String(etcBuckets.none.length),
      missedEtc: String(etcBuckets.missed.length),
      fasActions: sheet.fasActions,
      support: sheet.support,
    };
    for (const rule of BARRIER_RULES) {
      cells[rule.ynCol] = yn[rule.id];
      cells[rule.detailsCol] = sheet[rule.detailsCol];
    }
    out.push({
      key: p.key, domicile: p.domicile, scac: p.scac,
      pair: { total: p.total, down: p.down }, domicileStats, scacStats,
      cells, units, common: rowCommon,
      missedWhy, userEtcOverrides, etcInvariant,
      unitsHash: unitsHash(p.downRows), evidenceHash: evidenceHash(p.downRows),
    });
  }

  out.sort((a, b) => (a.domicileStats.uptime - b.domicileStats.uptime)
    || (a.domicile < b.domicile ? -1 : a.domicile > b.domicile ? 1 : 0)
    || (b.pair.down - a.pair.down)
    || (a.scac < b.scac ? -1 : a.scac > b.scac ? 1 : 0));

  return { day: today, fleetCount: list.length, downCount, rows: out, conflicts: statusConflicts(list) };
}

// ── Overlays -> view model ──────────────────────────────────────────────────
// Precedence per cell: user edit (editable only) > AI sheet sentence > computed.
// Draft overlay v3: ONLY the DRAFT_SHEET_IDS prose cells (6 Details, FAS Actions, Support), only
// from d.sheet (cells that passed validateSheet), and only when the draft is current (state ok).
// Y/N, ETC counts and hard cells always stay computed (I2/I7). A Details cell is overlaid only
// when its computed Y/N is Y (I3). Drafts are read only when overlays.flags.aiDraft is on: flag off
// -> computed cells, draft state 'none' (drafts stay on disk).
// Stale (checked in this order): unitsHash differs ('units'), the draft predates a now-known FAS
// alias ('identity'), the draft is not version 3 ('format'), evidenceHash differs ('evidence').
// A stale draft is never overlaid. Unit notes (d.unitNotes), AI Y/N disagreements and soft flags
// stay on the row for the drill-down only.
// FAS Name default per row (§3.12): rosterExact[key] -> (roster loaded ? '' : user name).
// rosterFas (site/SCAC fallback) only feeds row.rosterFas and row.rosterHint (screen only).
// The caller passes edits already filtered to today.
const DRAFT_SHEET_IDS = Object.freeze([
  ...COLUMNS.map((c) => c.id).filter((id) => /Details$/.test(id)), 'fasActions', 'support',
]);
const DRAFT_VERSION = 3;
function applyOverlays(built, overlays = {}) {
  const b = built || {};
  const edits = _plain(overlays.edits);
  const drafts = _plain(overlays.drafts);
  const roster = _plain(overlays.rosterFas);
  const exact = _plain(overlays.rosterExact);
  const rosterLoaded = overlays.rosterLoaded === true;
  const override = _str(overlays.fasNameOverride).trim();
  const email = _str(overlays.emailFasName).trim();
  const fasName = override || email || '';
  const fasNameSource = override ? 'panel' : (email ? 'email-intel' : 'none');
  const aiOn = !!(overlays.flags && overlays.flags.aiDraft);
  const fasAliasKnown = overlays.fasAliasKnown === true;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const _n = (s) => _str(s).trim().toLowerCase();

  const rows = (b.rows || []).map((row) => {
    const rosterName = _str(roster[row.key]).trim();
    const exactName = _str(exact[row.key]).trim();
    const fasSource = exactName ? 'roster' : (rosterLoaded ? 'none' : (fasName ? 'you' : 'none'));
    const mine = !!fasName && rosterLoaded && _n(exactName) === _n(fasName);
    const rosterHint = rosterLoaded && !exactName && rosterName ? rosterName : '';
    const base = Object.assign({}, row.cells, { fasName: exactName || (rosterLoaded ? '' : fasName) });
    const source = {};
    for (const c of COLUMNS) source[c.id] = 'computed';
    const d = _plain(drafts[row.key]);
    const useDraft = aiOn && Object.keys(d).length > 0;
    const extra = {
      flags: {}, unitNotes: {}, unitNoteFlags: {}, disagreements: [], etcUnits: [], etcDisagreements: [], etcOverrides: [],
      provenance: {}, unverifiedNames: [], unboundDates: [], reviewSkipped: null,
    };
    let draft = { state: 'none', draftedAt: null };
    if (useDraft) {
      const units = d.unitsHash !== row.unitsHash;
      const identity = !!(d.identity && typeof d.identity === 'object' && d.identity.alias === false && fasAliasKnown);
      const format = d.version !== DRAFT_VERSION;
      const evidence = !!(d.evidenceHash && d.evidenceHash !== row.evidenceHash);
      const staleReason = units ? 'units' : (identity ? 'identity' : (format ? 'format' : (evidence ? 'evidence' : null)));
      draft = staleReason
        ? { state: 'stale', draftedAt: d.draftedAt || null, staleReason }
        : { state: 'ok', draftedAt: d.draftedAt || null };
      if (!staleReason) {
        const sh = _plain(d.sheet);
        for (const id of DRAFT_SHEET_IDS) {
          if (typeof sh[id] !== 'string' || !sh[id].trim()) continue;
          if (/Details$/.test(id) && !/^y/i.test(_str(row.cells && row.cells[id.replace(/Details$/, 'YN')]))) continue;
          base[id] = sh[id]; source[id] = 'ai';
        }
      }
      if (d.version === 2 || d.version === DRAFT_VERSION) {
        const notes = _plain(d.version === 2 ? d.cells : d.unitNotes);
        const df = _plain(d.flags);
        for (const id of DRAFT_SHEET_IDS) {
          if (typeof notes[id] === 'string' && notes[id]) extra.unitNotes[id] = notes[id];
          if (df[id] === 'review') extra.unitNoteFlags[id] = 'review';
        }
        Object.assign(extra, {
          disagreements: arr(d.disagreements), etcUnits: arr(d.etcUnits), etcDisagreements: arr(d.etcDisagreements),
          etcOverrides: arr(d.etcOverrides), provenance: _plain(d.provenance), unverifiedNames: arr(d.unverifiedNames),
          unboundDates: arr(d.unboundDates), reviewSkipped: typeof d.reviewSkipped === 'string' ? d.reviewSkipped : null,
        });
      }
    }
    const cells = Object.assign({}, base);
    const e = _plain(edits[row.key]);
    for (const id of EDITABLE_IDS) {
      if (typeof e[id] === 'string') { cells[id] = e[id]; source[id] = 'edit'; }
    }
    return Object.assign({}, row, extra, { cells, base, source, draft, fasSource, rosterFas: rosterName, rosterHint, mine });
  });

  return {
    day: b.day || overlays.today || null,
    fleetCount: b.fleetCount || 0,
    downCount: b.downCount || 0,
    conflicts: b.conflicts || [],
    builtAt: b.builtAt || null,
    fleetSyncedAt: b.fleetSyncedAt || null,
    columns: COLUMNS,
    fasName, fasNameSource,
    rosterLoaded, userName: fasName,
    flags: { aiDraft: aiOn },
    aiCellIds: AI_CELL_IDS,
    draftSheetIds: DRAFT_SHEET_IDS,
    fasAliasKnown,
    rows,
  };
}
function _plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

module.exports = {
  COLUMNS, EDITABLE_IDS, AI_CELL_IDS, HARD_CELL_IDS, DRAFT_SHEET_IDS, DRAFT_VERSION, BARRIER_RULES, COMMON_REPAIR_MIN, RECENT_TIMELINE_LINES,
  OEM_VENDOR_RE, ONSITE_VENDOR_RE, VENDOR_1P_RE, RELEASED_RE, PARTNER_TEXT_RE, SYSTEM_GROUPS, REPEAT_RE, EMAIL_RE,
  partsWait, partsWhy, EXPECT_READY_RE, NOT_ETC_CONTEXT_RE, AAP_PARTS_STATUS_RE,
  isDown, uptimePct, fmtPct, groupKey, normCode, parseTimelineLines, inferDate, parseEtc, etcMentionDates, etcKeywordNegated,
  REPAIR_MISS_MARKER_RE, explicitRepairMiss, countedEtc, ETC_UNDERCUT_RES, DIAG_NONE_RE, APPT_DATE_RE,
  classifyBarriers, commonRepairs, statusConflicts, buildFleetDbr, applyOverlays, unitsHash, evidenceHash,
  vendorLabel, shortIssue, composeSheet,
};
