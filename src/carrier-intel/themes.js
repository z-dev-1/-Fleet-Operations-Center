'use strict';
/**
 * carrier-intel/themes.js — deterministic symptom themes over a SCAC's rows (design B6.5).
 *
 * symptomThemes(rows, repairHistory, today) -> { text, units, unitLines, hits, episodes }.
 * Themes are counts of free-text mentions (disclosed by G-SYMPTOM as unverified). A quote is
 * only the sentence holding the match, clipped to 120 chars, never a timeline count / ETA / $.
 * Pure: no I/O, no logging.
 */

const EV = require('../dbr/fleet-dbr-evidence');
const D = require('../repair-intel/wo-extract-dates');
const T = require('./taxonomy');
const Fx = require('./facts');

const THEMES = Object.freeze([
  { name: 'electrical', re: /\b(voltage|charging|alternator|batter(y|ies)|electrical)\b/i },
  { name: 'CNG/methane', re: /\b(cng|methane|natural\s+gas)\b/i },
  { name: 'misfire', re: /\bmisfir\w*/i },
  { name: 'no-start', re: /\b(no[- ]?start|won'?t\s+start|will\s+not\s+start|does\s+not\s+start)\b/i },
  { name: 'after fueling', re: /\bafter\s+fuel\w*/i },
  { name: 'cold start', re: /\bcold[- ]start\w*/i },
  { name: 'under load', re: /\bunder\s+load\b/i },
  { name: 'could not duplicate', re: /\b(could\s*n[o']?t|unable\s+to|can(no|')t)\s+(duplicate|replicate|reproduce)\b|\bno\s+(fault|problem|issue)\s+found\b/i },
  { name: 'vendor found no fault', re: /\b(system\s+is\s+ok|operating\s+as\s+designed|working\s+as\s+intended)\b/i },
]);
const CI_THEMES_MAX = 2000;
const WINDOW_DAYS = 120;
const EPISODE_GAP_DAYS = 7;
const SUMMARY_MAX = 300;
const QUOTE_MAX = 120;
const UNITS_PER_THEME = 5;
const QUOTES_PER_THEME = 2;
const THEME_UNITS_MAX = 20;

function _s(v) { return v == null ? '' : String(v); }
function _ymdOf(v) {
  const s = _s(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = D.parseTs(s);
  return ms == null ? null : D.ymd(ms);
}
function _sentences(text) { return _s(text).split(/[.!?\n;]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean); }
function _plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// Dated text items for one row (B6.5 sources).
function _items(row, repairHistory, today) {
  const id = _s(row.equipmentId);
  const out = [];
  const rh = repairHistory && Array.isArray(repairHistory[id]) ? repairHistory[id] : [];
  for (const e of rh) {
    if (!e || typeof e !== 'object') continue;
    out.push({ date: _ymdOf(e.date), text: _s(e.summary).slice(0, SUMMARY_MAX) });
  }
  for (const line of _s(row.repairTimeline).split('\n')) {
    const m = /^\s*(\d{1,2})\/(\d{1,2})\b(.*)$/.exec(line);
    if (!m) continue;
    out.push({ date: T.ymdOfMd(m[1] + '/' + m[2], today), text: m[3].replace(/^[\s\-–:]+/, '') });
  }
  const created = _ymdOf(row.created);
  for (const k of ['issueSummary', 'issueDetails', 'cause', 'correction']) {
    if (_s(row[k]).trim()) out.push({ date: created, text: _s(row[k]) });
  }
  for (const e of EV.conversationEntries(_s(row.fullConversation))) out.push({ date: T.ymdOfMd(e.date, today), text: e.body });
  return out.filter((x) => x.date && x.text);
}

function _episodes(dates) {
  let e = 0;
  let prev = null;
  for (const d of dates) {
    if (prev == null || T.dayDiff(prev, d) > EPISODE_GAP_DAYS) e += 1;
    prev = d;
  }
  return e;
}
function _cmpId(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * symptomThemes(rows, repairHistory, today) -> {
 *   text,                         // theme lines + 'no hits:' line, <= CI_THEMES_MAX
 *   units,                        // cited unit ids (<= 20)
 *   unitLines: { [id]: string[] },// per-unit theme lines (+ its quote line when quoted)
 *   hits: { [theme]: [{ id, date, quote }] },   // newest first, every theme key present
 *   episodes: { [id]: { [theme]: e } } }
 */
function symptomThemes(rows, repairHistory, today) {
  const hits = {};
  const per = {};          // theme -> id -> { dates:Set, hits:[] }
  for (const th of THEMES) { hits[th.name] = []; per[th.name] = new Map(); }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || !_s(row.equipmentId)) continue;
    const id = _s(row.equipmentId);
    const seen = new Set();
    for (const it of _items(row, repairHistory, today)) {
      const age = T.dayDiff(it.date, today);
      if (age == null || age < 0 || age > WINDOW_DAYS) continue;
      for (const sent of _sentences(it.text)) {
        for (const th of THEMES) {
          if (!th.re.test(sent)) continue;
          const quote = sent.length > QUOTE_MAX ? sent.slice(0, QUOTE_MAX) : sent;
          const sig = th.name + '|' + it.date + '|' + quote;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const h = { id, date: it.date, quote };
          hits[th.name].push(h);
          if (!per[th.name].has(id)) per[th.name].set(id, { dates: new Set(), hits: [] });
          const u = per[th.name].get(id);
          u.dates.add(it.date);
          u.hits.push(h);
        }
      }
    }
  }
  for (const k of Object.keys(hits)) hits[k].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : _cmpId(a.id, b.id)));

  const episodes = {};
  const lines = [];
  const noHits = [];
  const cited = [];
  const unitLines = {};
  const addUnitLine = (id, s) => { (unitLines[id] = unitLines[id] || []).push(s); };
  for (const th of THEMES) {
    const m = per[th.name];
    if (!m.size) { noHits.push(th.name); continue; }
    const us = [...m.entries()].map(([id, u]) => {
      const dates = [...u.dates].sort();
      return { id, dates, first: dates[0], last: dates[dates.length - 1], h: dates.length, e: _episodes(dates), hits: u.hits };
    });
    for (const u of us) { (episodes[u.id] = episodes[u.id] || {})[th.name] = u.e; }
    us.sort((a, b) => (b.h - a.h) || _cmpId(a.id, b.id));
    const shown = us.slice(0, UNITS_PER_THEME);
    const span = (u) => (u.first === u.last ? Fx.md(u.first) : Fx.md(u.first) + '–' + Fx.md(u.last))
      + ' (' + Fx.fmtDays(u.h) + ' with mentions, ' + _plural(u.e, 'episode', 'episodes') + ')';
    // Quotes: newest hit per unit, newest first, one per unit.
    const newest = shown.map((u) => u.hits.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0])
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : _cmpId(a.id, b.id))).slice(0, QUOTES_PER_THEME);
    const quoteOf = (h) => '"' + Fx.md(h.date) + ' ' + h.id + ': ' + h.quote + '"';
    let line = 'theme ' + th.name + ': ' + _plural(us.length, 'unit', 'units') + ' · ' + shown.map((u) => u.id + ' ' + span(u)).join(' · ');
    if (newest.length) line += ' · ' + newest.map(quoteOf).join(' ');
    lines.push(line);
    for (const u of shown) {
      addUnitLine(u.id, u.id + ': theme ' + th.name + ' ' + span(u));
      const q = newest.find((h) => h.id === u.id);
      if (q) addUnitLine(u.id, quoteOf(q));
      if (!cited.includes(u.id)) cited.push(u.id);
    }
  }
  const tail = noHits.length ? 'no hits: ' + noHits.join(', ') : '';
  const body = lines.slice();
  const size = () => body.concat(tail ? [tail] : []).join('\n').length;
  while (body.length && size() > CI_THEMES_MAX) body.pop();
  const units = cited.slice(0, THEME_UNITS_MAX);
  for (const id of Object.keys(unitLines)) if (!units.includes(id)) delete unitLines[id];
  return { text: body.concat(tail ? [tail] : []).join('\n'), units, unitLines, hits, episodes };
}

module.exports = { THEMES, symptomThemes, CI_THEMES_MAX };
