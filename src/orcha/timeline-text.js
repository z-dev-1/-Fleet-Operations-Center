'use strict';
/**
 * orcha/timeline-text.js — pure text helpers for the deep-scan timeline
 * post-processing chain (src/orcha/deep-scan.js _finishTimeline).
 *
 * No store, no logger. The only clock is an injectable `now` (Date or ms,
 * default new Date()), used for the same year rule as deep-scan's
 * _sortTimelineChronologically: a month later than next month is last year.
 *
 *   cleanTimelineMeta   drop "Next:" / "(AI unavailable)" lines and CONFLICT /
 *                       PM-overdue / status-field clauses; normalize gap lines
 *   reconcileGapRanges  re-split gap ranges so no gap covers a real event day
 *   sourceEventMds      line-start dates of the raw source threads (MM/DD)
 *   carryPriorHistory   keep pre-WR timeline lines across a WR rollover
 */

const GAP_BODY_RE = /^\[?no (?:update|activity) logged\]?\.?$/i;
// 'MM/DD[-MM/DD] - [optional [Planned…]/[Unplanned…] prefix] body' (mirrors
// wo-fact-output TL_LINE_RE; also accepts an en dash as separator).
const LINE_RE = /^(\d{1,2}\/\d{1,2})(?:\s*[-\u2013]\s*(\d{1,2}\/\d{1,2}))?\s+[-\u2013]\s+(?:(\[(?:Unplanned|Planned)[^\]]{0,40}\])\s+)?(.+)$/;
const EM_MARK_RE = /\s*\[em:[0-9a-f]{8}\]\s*$/i;
const GAP_TEXT = '[no update logged]';

const CONFLICT_RE = /\bconflict(?:s|ing)?\b/i;
const PM_META_RE = /\bPM[\s-]?[A-Z0-9]?\b[^.;]{0,60}\b(?:\d+\s+days?\s+overdue|overdue|status noted)\b/i;
const STATUS_FIELD_RE = /\bstatus field\b/i;
const META_LINE_RE = /^\(AI unavailable\)|^(?:scheduled\s+)?next\s*:/i;
const NEXT_TAIL_RE = /\s*(?:\bscheduled\s+)?\bnext\s*:\s.*$/i;

const DAY_MS = 86400000;

function _now(now) {
  if (now instanceof Date) return now;
  if (Number.isFinite(now)) return new Date(now);
  return new Date();
}
const _p2 = (n) => String(n).padStart(2, '0');
function _ymdOfDate(d) { return d.getFullYear() + '-' + _p2(d.getMonth() + 1) + '-' + _p2(d.getDate()); }
function _mdOfDate(d) { return _p2(d.getMonth() + 1) + '/' + _p2(d.getDate()); }
function _padMd(md) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(md || '').trim());
  return m ? _p2(m[1]) + '/' + _p2(m[2]) : '';
}

// 'YYYY-MM-DD' for MM/DD, same year rule as deep-scan _sortTimelineChronologically.
function inferYmd(mm, dd, now) {
  const n = _now(now);
  const m = parseInt(mm, 10);
  const d = parseInt(dd, 10);
  const year = n.getFullYear() + (m > n.getMonth() + 2 ? -1 : 0);
  return year + '-' + _p2(m) + '-' + _p2(d);
}
function _ymdOfMd(md, now) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(md || '').trim());
  return m ? inferYmd(m[1], m[2], now) : '';
}
// Local-noon Date for a 'YYYY-MM-DD' (DST-safe day walking).
function _dateOfYmd(ymd) {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d, 12);
}

// Same normalization as deep-scan _timelineEntrySignature.
function entrySig(line) {
  return String(line || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
}

// { a, b, tag, body, prefix } | null for a dated timeline line.
function _parse(line) {
  const t = String(line || '').trim();
  const m = LINE_RE.exec(t);
  if (!m) return null;
  return { a: m[1], b: m[2] || '', tag: m[3] || '', body: m[4], prefix: t.slice(0, t.length - m[4].length) };
}

/**
 * sourceEventMds(row, now) -> ['MM/DD', ...] (zero-padded, deduped): the dates
 * that START a line in the unit's raw source threads. An ISO stamp with a time
 * is UTC (Decisiv) and maps to its local calendar day. Never throws.
 */
function sourceEventMds(row, now) {
  void now;
  const out = [];
  const seen = new Set();
  const add = (md) => { if (md && !seen.has(md)) { seen.add(md); out.push(md); } };
  try {
    const r = row || {};
    const texts = [r.fullConversation || r.lastConversation || r.conversation || ''];
    if (r._plannedWRData && r._plannedWRData.fullConversation) texts.push(r._plannedWRData.fullConversation);
    if (Array.isArray(r._secondaryWRs)) for (const w of r._secondaryWRs) if (w && w.fullConversation) texts.push(w.fullConversation);
    if (r.asistNotes) texts.push(r.asistNotes);
    for (const raw of texts) {
      const s = String(raw || '');
      let m;
      const usRe = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gm;
      while ((m = usRe.exec(s))) {
        const mm = parseInt(m[1], 10); const dd = parseInt(m[2], 10);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) add(_p2(mm) + '/' + _p2(dd));
      }
      const isoRe = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/gm;
      while ((m = isoRe.exec(s))) {
        const y = +m[1]; const mo = +m[2]; const d = +m[3];
        if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
        if (m[4] != null) {
          const dt = new Date(Date.UTC(y, mo - 1, d, +m[4], +m[5]));
          if (!isNaN(dt.getTime())) add(_mdOfDate(dt));
        } else {
          add(_p2(mo) + '/' + _p2(d));
        }
      }
    }
  } catch (_) { /* never throw */ }
  return out;
}

// Rule (d): drop CONFLICT / PM-overdue / status-field clauses. Returns the kept text.
function _dropMetaClauses(body) {
  const clauses = String(body).split(/(?<=[.;])\s+/);
  const kept = clauses.filter((c) => !(CONFLICT_RE.test(c) || PM_META_RE.test(c) || STATUS_FIELD_RE.test(c)));
  return kept.length === clauses.length ? body : kept.join(' ').trim();
}

/**
 * cleanTimelineMeta(text) -> text with internal meta removed: gap bodies
 * normalized to '[no update logged]'; "Next:" / "(AI unavailable)" lines
 * dropped and "Next: …" tails stripped; CONFLICT / PM-overdue / status-field
 * clauses dropped (line dropped when nothing is left). Unchanged lines are
 * returned byte-for-byte.
 */
function cleanTimelineMeta(text) {
  if (!text || typeof text !== 'string') return text;
  const out = [];
  for (const line of text.split('\n')) {
    const emM = EM_MARK_RE.exec(line);
    const core = emM ? line.slice(0, emM.index) : line;
    const p = _parse(core);
    if (!p) {
      const t = core.trim();
      if (!t) { out.push(line); continue; }
      if (META_LINE_RE.test(t)) continue;
      const kept = _dropMetaClauses(t);
      if (!kept) continue;
      out.push(kept === t ? line : kept + (emM ? emM[0] : ''));
      continue;
    }
    let body = p.body.trim();
    if (GAP_BODY_RE.test(body)) {
      out.push(body === GAP_TEXT ? line : p.prefix + GAP_TEXT + (emM ? emM[0] : ''));
      continue;
    }
    if (META_LINE_RE.test(body)) continue;
    const tail = NEXT_TAIL_RE.exec(body);
    if (tail && tail.index > 0) body = body.slice(0, tail.index).trim();
    body = _dropMetaClauses(body);
    if (!body) continue;
    out.push(body === p.body.trim() ? line : p.prefix + body + (emM ? emM[0] : ''));
  }
  return out.join('\n');
}

/**
 * reconcileGapRanges(text, extraMds, now) -> text whose gap lines never cover
 * an event day (a dated non-gap line in text, or an extraMds 'MM/DD'). Ranges
 * are split into runs of >= 2 event-free days; 1-day runs and single-day gaps
 * on an event day are dropped. Non-gap lines untouched, order preserved.
 */
function reconcileGapRanges(text, extraMds = [], now) {
  if (!text || typeof text !== 'string') return text;
  const n = _now(now);
  const lines = text.split('\n');
  const parsed = lines.map(_parse);
  const events = new Set();
  parsed.forEach((p) => { if (p && !GAP_BODY_RE.test(p.body.trim())) events.add(_ymdOfMd(p.a, n)); });
  for (const md of extraMds || []) { const y = _ymdOfMd(md, n); if (y) events.add(y); }
  const out = [];
  lines.forEach((line, i) => {
    const p = parsed[i];
    if (!p || !GAP_BODY_RE.test(p.body.trim())) { out.push(line); return; }
    const ya = _ymdOfMd(p.a, n);
    if (!p.b) {
      if (!events.has(ya)) out.push(_padMd(p.a) + ' - ' + GAP_TEXT);
      return;
    }
    const yb = _ymdOfMd(p.b, n);
    if (!(ya < yb)) { out.push(line); return; }
    const runs = [];
    let run = null;
    for (let d = _dateOfYmd(ya); _ymdOfDate(d) <= yb; d = new Date(d.getTime() + DAY_MS)) {
      d.setHours(12, 0, 0, 0);
      const y = _ymdOfDate(d);
      if (events.has(y)) { run = null; continue; }
      if (!run) { run = { from: d, to: d }; runs.push(run); } else run.to = d;
    }
    for (const r of runs) {
      if (_ymdOfDate(r.from) === _ymdOfDate(r.to)) continue;
      out.push(_mdOfDate(r.from) + '-' + _mdOfDate(r.to) + ' - ' + GAP_TEXT);
    }
  });
  return out.join('\n');
}

/**
 * carryPriorHistory({ prevTimeline, prevPrior, newTimeline, createdIso,
 * hiddenEntries, now, max }) -> the dated, non-gap lines from before the
 * current WR's created day, deduped, chronological, newest `max` kept.
 */
function carryPriorHistory({ prevTimeline, prevPrior, newTimeline, createdIso, hiddenEntries, now, max = 60 } = {}) {
  const createdMs = Date.parse(String(createdIso || ''));
  if (!Number.isFinite(createdMs)) return String(prevPrior || '');
  const n = _now(now);
  const createdYmd = _ymdOfDate(new Date(createdMs));
  const exclude = new Set();
  for (const l of String(newTimeline || '').split('\n')) { const s = entrySig(l); if (s) exclude.add(s); }
  for (const l of Array.isArray(hiddenEntries) ? hiddenEntries : []) { const s = entrySig(l); if (s) exclude.add(s); }
  const seen = new Set();
  const cand = [];
  const all = String(prevPrior || '').split('\n').concat(String(prevTimeline || '').split('\n'));
  all.forEach((raw) => {
    const line = String(raw || '').trim();
    const p = _parse(line);
    if (!p || GAP_BODY_RE.test(p.body.trim())) return;
    const ymd = _ymdOfMd(p.a, n);
    if (!(ymd < createdYmd)) return;
    const sig = entrySig(line);
    if (!sig || exclude.has(sig) || seen.has(sig)) return;
    seen.add(sig);
    cand.push({ line, ymd, i: cand.length });
  });
  cand.sort((x, y) => (x.ymd < y.ymd ? -1 : x.ymd > y.ymd ? 1 : x.i - y.i));
  const keep = Math.max(0, Math.floor(max));
  return (keep ? cand.slice(-keep) : []).map((c) => c.line).join('\n');
}

module.exports = {
  GAP_BODY_RE, LINE_RE, CONFLICT_RE, PM_META_RE, STATUS_FIELD_RE,
  inferYmd, entrySig, sourceEventMds, cleanTimelineMeta, reconcileGapRanges, carryPriorHistory,
};
