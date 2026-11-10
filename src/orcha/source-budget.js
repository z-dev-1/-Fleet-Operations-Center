'use strict';
/**
 * orcha/source-budget.js — newest-first trimming of long source text for AI
 * prompts, plus the settings.ai.fullContext flag (default ON).
 *
 * Why: several prompt builders clipped long feeds with a plain head slice, so
 * on a long-running unit the OLDEST comments survived and the newest ones (the
 * current status, who spoke last) were cut. keepNewest() keeps the newest lines
 * (and an optional anchor of the oldest lines, e.g. the original complaint),
 * never splits a line, and inserts a visible marker where lines were dropped so
 * the model knows the feed has a gap.
 *
 * Flag: settings.ai.fullContext !== false -> larger budgets. Env override
 * FLEET_AI_FULL_CONTEXT='1' forces ON, '0' forces OFF (other values ignored).
 * The env override is main-process only (RCA, reconcile, repair-intel): the
 * renderer's Long Dwell fill (longdwell-ai.js) follows settings.ai.fullContext alone.
 * Callers keep the legacy sizes when the flag is OFF; the newest-first
 * direction is unconditional.
 */

// ── Flag ─────────────────────────────────────────────────────────────────────
function resolveFullContext(settings, env) {
  let on = !(settings && settings.ai && settings.ai.fullContext === false);
  const v = env && env.FLEET_AI_FULL_CONTEXT;
  if (v === '1') on = true;
  else if (v === '0') on = false;
  return on;
}

// Read the flag from the settings store. Any failure -> ON (the default).
function loadFullContext({ load, env } = {}) {
  try {
    const ld = load || require('../store').load;
    const settings = ld('settings', {}) || {};
    return resolveFullContext(settings, env || process.env);
  } catch (_) {
    return true;
  }
}

// ── Order detection ──────────────────────────────────────────────────────────
// AAP thread lines: "MM/DD[/YY[YY]] ..." at line start (optionally "[" or "- ").
const NUM_LINE_DATE_RE = /^\s*(?:\[|- )?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?!\d)/;
// DOM scraper date lines: "Oct 9, 2026 06:07 PM".
const MON_DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})\b/i;
const _MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function _lineDate(line) {
  const s = String(line || '');
  let m = s.match(NUM_LINE_DATE_RE);
  if (m) {
    const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = m[3] ? parseInt(m[3], 10) : null;
      if (y != null && y < 100) y += 2000;
      return { y, m: mo, d };
    }
  }
  m = s.match(MON_DATE_RE);
  if (m) return { y: parseInt(m[3], 10), m: _MONTHS[m[1].slice(0, 3).toLowerCase()], d: parseInt(m[2], 10) };
  return null;
}

// 'desc' when the last parseable date is older than the first, else 'asc'.
function detectOrder(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  let first = null, last = null;
  for (const l of arr) { const dt = _lineDate(l); if (dt) { if (!first) first = dt; last = dt; } }
  if (!first || first === last) return 'asc';
  if (first.y != null && last.y != null) {
    const a = first.y * 10000 + first.m * 100 + first.d;
    const b = last.y * 10000 + last.m * 100 + last.d;
    return b < a ? 'desc' : 'asc';
  }
  // Month/day only: a gap over ~6 months is read as a year wrap (12/20 -> 01/05).
  const diff = (last.m * 31 + last.d) - (first.m * 31 + first.d);
  const wrap = Math.abs(diff) > 6 * 31;
  const lastIsOlder = wrap ? diff > 0 : diff < 0;
  return lastIsOlder ? 'desc' : 'asc';
}

// ── Trimming ─────────────────────────────────────────────────────────────────
const TRIM_MARKER_RE = /^\[… \d+ older lines trimmed to fit the AI budget …\]$/m;
const _marker = (n) => `[… ${n} older lines trimmed to fit the AI budget …]`;

// Cut a string to at most n UTF-16 units without splitting a surrogate pair.
function _safeCut(s, n) {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  let k = n;
  const c = s.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k--;
  return s.slice(0, k);
}

/**
 * keepNewest(text, budget, { anchor }) -> { text, dropped, droppedLines }
 * Keeps whole lines: the newest lines that fit, plus up to `anchor` chars of
 * the oldest lines, with a marker line at the gap. droppedLines are newest-first.
 */
function keepNewest(text, budget, { anchor = 0 } = {}) {
  const src = String(text == null ? '' : text);
  const max = Math.max(0, Math.floor(Number(budget) || 0));
  if (src.length <= max) return { text: src, dropped: 0, droppedLines: [] };
  const lines = src.split('\n');
  const order = detectOrder(lines);
  const anchorMax = Math.max(0, Math.min(Math.floor(Number(anchor) || 0), Math.floor(max / 2)));
  const markerLen = _marker(lines.length).length + 1; // worst-case digits + '\n'

  // Oldest side = head for asc, tail for desc. Newest side is the opposite.
  const oldestIdx = (i) => (order === 'asc' ? i : lines.length - 1 - i);
  const newestIdx = (i) => (order === 'asc' ? lines.length - 1 - i : i);

  let anchorCount = 0, anchorUsed = 0;
  while (anchorCount < lines.length) {
    const len = lines[oldestIdx(anchorCount)].length + 1;
    if (anchorUsed + len > anchorMax) break;
    anchorUsed += len; anchorCount++;
  }
  const room = max - anchorUsed - markerLen;
  let newestCount = 0, used = 0;
  while (newestCount + anchorCount < lines.length) {
    const len = lines[newestIdx(newestCount)].length + 1;
    if (used + len > room + 1) break; // the final line carries no trailing '\n'
    used += len; newestCount++;
  }
  let cutLine = null;
  if (newestCount === 0 && anchorCount < lines.length) {
    // The single newest line alone exceeds the room: keep its leading part.
    cutLine = _safeCut(lines[newestIdx(0)], Math.max(0, room));
    newestCount = 1;
  }

  const anchorLines = [], newestLines = [], droppedLines = [];
  for (let i = 0; i < anchorCount; i++) anchorLines.push(lines[oldestIdx(i)]);
  for (let i = 0; i < newestCount; i++) newestLines.push(i === 0 && cutLine != null ? cutLine : lines[newestIdx(i)]);
  for (let i = newestCount; i < lines.length - anchorCount; i++) droppedLines.push(lines[newestIdx(i)]);
  const dropped = droppedLines.length;

  let out;
  if (order === 'asc') {
    out = anchorLines.concat(dropped ? [_marker(dropped)] : [], newestLines.slice().reverse());
  } else {
    out = newestLines.concat(dropped ? [_marker(dropped)] : [], anchorLines.slice().reverse());
  }
  return { text: out.join('\n'), dropped, droppedLines };
}

module.exports = { resolveFullContext, loadFullContext, detectOrder, keepNewest, TRIM_MARKER_RE, NUM_LINE_DATE_RE, MON_DATE_RE };
