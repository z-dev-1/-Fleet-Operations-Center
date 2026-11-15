'use strict';
// utils/offsite-notes-order.js — pure: order dated offsite note entries newest-first.
//
// Dated entry starts seen in offsite text:
//   Decisiv API  'YYYY-MM-DD HH:MM '
//   DTNA         'Month D, YYYY — ' (optionally 'Month D, YYYY at h:mm AM — ')
//   DOM          'MM/DD/YY h:mm am'
// The live Decisiv API and DTNA text is already newest-first, so
// offsiteNewestFirst is a no-op on it; the helper makes the order an invariant.

const ENTRY_RE = /^(?:(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) |([A-Z][a-z]{2,8} \d{1,2}, \d{4})(?: at \d{1,2}:\d{2} [AP]M)? — |(\d{2}\/\d{2}\/\d{2,4}) \d{1,2}:\d{2}\s?[ap]m\b)/m;
const LINE_START_RE = new RegExp(ENTRY_RE.source, 'gm');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function _atMs(head) {
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(head);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  m = /^([A-Z][a-z]{2,8}) (\d{1,2}), (\d{4})(?: at (\d{1,2}):(\d{2}) ([AP])M)?/.exec(head);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon == null) return null;
    let h = m[4] ? +m[4] % 12 : 0;
    if (m[6] === 'P') h += 12;
    return new Date(+m[3], mon, +m[2], h, m[5] ? +m[5] : 0).getTime();
  }
  m = /^(\d{2})\/(\d{2})\/(\d{2,4}) (\d{1,2}):(\d{2})\s?([ap])m/i.exec(head);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let h = +m[4] % 12;
    if (m[6].toLowerCase() === 'p') h += 12;
    return new Date(y, +m[1] - 1, +m[2], h, +m[5]).getTime();
  }
  return null;
}

// -> [{ start, end, atMs|null }]; text before the first dated start is one undated entry.
function offsiteEntries(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const starts = [];
  LINE_START_RE.lastIndex = 0;
  let m;
  while ((m = LINE_START_RE.exec(s)) !== null) {
    starts.push({ start: m.index, atMs: _atMs(m[0]) });
    if (m[0].length === 0) LINE_START_RE.lastIndex++;
  }
  const out = [];
  if (!starts.length || starts[0].start > 0) {
    out.push({ start: 0, end: starts.length ? starts[0].start : s.length, atMs: null });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].start : s.length;
    const at = Number.isFinite(starts[i].atMs) ? starts[i].atMs : null;
    out.push({ start: starts[i].start, end, atMs: at });
  }
  return out;
}

// >= 2 dated entries: stable sort by atMs desc (undated keep their relative order
// after the dated ones); otherwise the text is returned unchanged.
function offsiteNewestFirst(text) {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  const entries = offsiteEntries(text);
  const dated = entries.filter((e) => e.atMs != null);
  if (dated.length < 2) return text;
  const undated = entries.filter((e) => e.atMs == null);
  const sorted = dated.map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.atMs - a.e.atMs) || (a.i - b.i))
    .map((x) => x.e)
    .concat(undated);
  if (sorted.every((e, i) => e === entries[i])) return text;
  return sorted.map((e) => text.slice(e.start, e.end).replace(/\n+$/, '')).join('\n');
}

module.exports = { offsiteEntries, offsiteNewestFirst, ENTRY_RE };
