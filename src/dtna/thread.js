'use strict';
/**
 * src/dtna/thread.js — pure: DTNA comments -> the text format the rest of the app already reads.
 *
 * One line per comment, newest first:
 *   'September 24, 2026 at 6:56 AM — AFP FAS: [Comment Type] text'
 * which matches DTNA_LINE_RE (src/repair-intel/wo-extract.js) and ENTRY_RE
 * (src/utils/offsite-notes-order.js), so parseDtnaFeedLines / extractDtnaFeed / offsiteNewestFirst
 * work unchanged. Dates are formatted in process local time (same as the old rendered feed).
 */
const { decodeEntities } = require('../repair-intel/wo-extract');
const C = require('./constants');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function _str(v) { return v == null ? '' : String(v); }

/** stripHtml(html) -> single-line plain text (block tags become spaces, entities decoded, whitespace collapsed). */
function stripHtml(html) {
  return decodeEntities(_str(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div)>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function _ms(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/** fmtDtnaDate(iso) -> 'September 24, 2026 at 6:56 AM' (local time) | '' when unparseable. */
function fmtDtnaDate(iso) {
  const ms = _ms(iso);
  if (ms == null) return '';
  const d = new Date(ms);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return MONTH_NAMES[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' at ' + h12 + ':' + mm + ' ' + (h < 12 ? 'AM' : 'PM');
}

function _actor(fromName) {
  const a = _str(fromName).replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  return a || 'DTNA';
}

function _oneLine(s) { return _str(s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** _capLines(lines, max) -> lines joined with '\n', cut at a line boundary so the result is <= max chars. */
function _capLines(lines, max) {
  const out = [];
  let len = 0;
  for (const l of lines) {
    const add = (out.length ? 1 : 0) + l.length;
    if (len + add > max) break;
    out.push(l);
    len += add;
  }
  return out;
}

/**
 * commentsToThread(comments) -> { thread, offsiteText, count }
 * comments: raw Apex rows { CommentText, CommentType, FromName, CreatedDate, LastUpdatedDate }.
 * Comments with no text and no type, or with no parseable date, are skipped (a line without a date
 * would merge into the previous entry). count = number of lines in `thread`.
 */
function commentsToThread(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const items = [];
  list.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    const text = stripHtml(c.CommentText).slice(0, C.COMMENT_MAX);
    const type = _oneLine(c.CommentType).slice(0, 80);
    if (!text && !type) return;
    const ms = _ms(c.CreatedDate) != null ? _ms(c.CreatedDate) : _ms(c.LastUpdatedDate);
    if (ms == null) return;
    const body = (type ? '[' + type + ']' + (text ? ' ' : '') : '') + text;
    items.push({ ms, i, line: fmtDtnaDate(ms) + ' — ' + _actor(c.FromName) + ': ' + body });
  });
  items.sort((a, b) => (b.ms - a.ms) || (a.i - b.i));
  const lines = items.map((x) => x.line);
  const threadLines = _capLines(lines, C.THREAD_MAX);
  const offLines = _capLines(lines, C.OFFSITE_TEXT_MAX);
  return { thread: threadLines.join('\n'), offsiteText: offLines.join('\n'), count: threadLines.length };
}

const STAGE_RE = {
  ready: /closed|complete|ready/i,
  // Decision 11 says /in-?repair|post-?repair/; a space is accepted too ('In Repair').
  repair: /in[-\s]?repair|post[-\s]?repair/i,
  // Pre-Repair is the stepper's first stage (before Arrived): the arrival bucket.
  arrival: /arriv|pre[-\s]?repair/i,
};

/**
 * stageFromCase({ caseStatus, steps, comments, thread }) -> { stage, since }
 * stage: caseStatus first, then the newest comment type ('Ready for Pick Up'), then the old feed-text
 * regexes. since: ISO time of the newest dated step whose name matches the stage, else ''.
 * comments: normalized { type, at }.
 */
function stageFromCase(o) {
  const x = o || {};
  const status = _str(x.caseStatus);
  let stage = '';
  if (STAGE_RE.ready.test(status)) stage = 'ready';
  else if (STAGE_RE.repair.test(status)) stage = 'repair';
  else if (STAGE_RE.arrival.test(status)) stage = 'arrival';
  if (!stage) {
    const cs = (Array.isArray(x.comments) ? x.comments : []).filter((c) => c && typeof c === 'object');
    let newest = null;
    for (const c of cs) {
      const ms = _ms(c.at);
      if (!newest || (ms != null && (newest.ms == null || ms > newest.ms))) newest = { ms, type: _str(c.type) };
    }
    if (newest && /ready for pick ?up/i.test(newest.type)) stage = 'ready';
  }
  if (!stage) {
    const t = _str(x.thread);
    if (/closed this case|to Closed|Repairs?\s+(are\s+)?completed|Asset Ready/i.test(t)) stage = 'ready';
    else if (/In-?Repair|to In-?Repair/i.test(t)) stage = 'repair';
    else if (/Arrived|to Arrived/i.test(t)) stage = 'arrival';
  }
  let since = '';
  if (stage) {
    let best = null;
    for (const s of (Array.isArray(x.steps) ? x.steps : [])) {
      if (!s || typeof s !== 'object') continue;
      const ms = _ms(s.at);
      if (ms == null) continue;
      if (!STAGE_RE[stage].test(_str(s.name))) continue;
      if (best == null || ms > best) best = ms;
    }
    if (best != null) since = new Date(best).toISOString();
  }
  return { stage, since };
}

module.exports = { stripHtml, fmtDtnaDate, commentsToThread, stageFromCase, MONTH_NAMES };
