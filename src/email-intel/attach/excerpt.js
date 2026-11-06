'use strict';
/**
 * email-intel/attach/excerpt.js — bounded, deterministic attachment excerpts for the AI input
 * (design 7.6; R6.5).
 *
 *   selectExcerpt(text, { unitIds })  -> string of at most PER_ATTACHMENT chars: the first HEAD chars
 *                                        plus windows (WINDOWS_TOTAL chars in all) around keyword hits
 *                                        (total, estimate, approve, ETA, parts, labor, $, a unit id)
 *   messageExcerpts(list)             -> the same list with the texts cut so a message never sends more
 *                                        than PER_MESSAGE chars of attachment text (in list order)
 *
 * Excerpts are memory-only (F-14): callers keep them in the scan's analysis context and never store them.
 */
const PER_ATTACHMENT = 6_000;
const PER_MESSAGE = 10_000;
const HEAD = 3_000;
const WINDOWS_TOTAL = 3_000;
const WIN_BEFORE = 150;
const WIN_AFTER = 350;
const GAP = '\n[...]\n';
const KEYWORD_G = /\b(?:totals?|estimates?|approv\w*|eta|parts?|labou?r)\b|\$/gi;

function _escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function selectExcerpt(text, opts) {
  const t = String(text == null ? '' : text);
  if (t.length <= PER_ATTACHMENT) return t;
  const head = t.slice(0, HEAD);
  // Hits past the head: unit ids first (by position), then keywords (by position).
  const unitHits = []; const kwHits = [];
  let m;
  const ids = ((opts && opts.unitIds) || []).map((u) => String(u || '').trim()).filter((u) => u.length >= 3).slice(0, 500);
  if (ids.length) {
    const re = new RegExp('(^|[^A-Za-z0-9])(' + ids.map(_escape).join('|') + ')(?![A-Za-z0-9])', 'gi');
    while ((m = re.exec(t)) !== null) { const at = m.index + m[1].length; if (at >= HEAD) unitHits.push(at); re.lastIndex = m.index + Math.max(1, m[0].length); }
  }
  KEYWORD_G.lastIndex = 0;
  while ((m = KEYWORD_G.exec(t)) !== null) if (m.index >= HEAD) kwHits.push(m.index);
  // Greedy, deterministic: a hit already inside a chosen window adds nothing; stop at WINDOWS_TOTAL chars.
  const chosen = [];
  let used = 0;
  for (const h of unitHits.concat(kwHits)) {
    if (used >= WINDOWS_TOTAL) break;
    if (chosen.some((w) => h >= w.s && h < w.e)) continue;
    const s = Math.max(HEAD, h - WIN_BEFORE);
    const e = Math.min(t.length, h + WIN_AFTER, s + (WINDOWS_TOTAL - used - GAP.length));      // the separator counts too
    if (e <= s) continue;
    chosen.push({ s, e });
    used += e - s + GAP.length;
  }
  chosen.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const w of chosen) {
    const last = merged[merged.length - 1];
    if (last && w.s <= last.e) last.e = Math.max(last.e, w.e); else merged.push({ s: w.s, e: w.e });
  }
  return [head].concat(merged.map((w) => t.slice(w.s, w.e))).join(GAP).slice(0, PER_ATTACHMENT);
}

function messageExcerpts(list) {
  let room = PER_MESSAGE;
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.text !== 'string' || !x.text) continue;
    if (room <= 0) break;
    const text = x.text.slice(0, Math.min(PER_ATTACHMENT, room));
    room -= text.length;
    out.push(Object.assign({}, x, { text, cut: text.length < x.text.length }));
  }
  return out;
}

module.exports = { PER_ATTACHMENT, PER_MESSAGE, HEAD, WINDOWS_TOTAL, selectExcerpt, messageExcerpts };
