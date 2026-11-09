// ============================================================================
// longdwell-summary-format.js — deterministic normalizer for the Long Dwell
// AI Fill `summary` (the 7-bullet status block).
//
// WHY: the Long Dwell prompt (longdwell-ai.js _buildAIFillPrompt) is ~40k chars.
// On Windows the Aki lane head-keeps ~32k chars (src/orcha/aki-lane.js
// fitPrompt), which cuts off the 7-field spec and the gold examples, so Aki
// answers with one prose paragraph. The prompt now states the contract up
// front (layer 1); this module is the safety net (layer 2) that makes the
// saved value follow the contract no matter which lane answered:
//
//   • Initial Issue Reported: …
//   • Primary Vendor Rejection: …
//   • Primary Barrier: …
//   • Actions Taken: …
//   • Repair Status: …
//   • ETC: …
//   • Follow-up date: …
//
// RULES
// - PARITY: input that already has the exact 7-line shape is returned
//   byte-identical (Claude / Orcha output never changes).
// - RESTRUCTURE ONLY, NEVER INVENT: output is built only from the model's own
//   words plus two neutral placeholders ("N/A" for Primary Vendor Rejection,
//   "not documented — verify" otherwise). No dates, numbers, vendors or facts
//   are ever added. Nothing is dropped except a label-only "Follow-up date:
//   <Weekday> M/D/YYYY." sentence whose date is moved to the front of the
//   Follow-up value (only the weekday token disappears).
// - CALL-SITE ORDER: callers run normalize -> _stripCosts -> .slice(cap).
//   _stripCosts collapses `\s{2,}`, which would merge `\n\n` / `\r\n`
//   separated bullets into one line, so the normalizer must see the raw line
//   structure first. Its output has single-`\n` lines and no whitespace runs,
//   so _stripCosts leaves it unchanged.
//
// Pure ESM, no imports, no I/O. Used by views/analytics.js and
// views/longdwell-csv.js (both _aiFillRow).
// ============================================================================

export const LD_SUMMARY_LABELS = [
  'Initial Issue Reported', 'Primary Vendor Rejection', 'Primary Barrier',
  'Actions Taken', 'Repair Status', 'ETC', 'Follow-up date',
];
export const LD_PLACEHOLDER_NA = 'N/A';
export const LD_PLACEHOLDER_UNKNOWN = 'not documented \u2014 verify';

const F_INITIAL = 0, F_REJECT = 1, F_BARRIER = 2, F_ACTIONS = 3, F_STATUS = 4, F_ETC = 5, F_FOLLOW = 6;
const BULLET = '\u2022 ';

// True only for the exact contract: no \r, exactly 7 `\n`-separated lines,
// line i = "• " + LABEL_i + ": " + a non-space character.
export function isLongDwellSummaryFormatted(text) {
  if (typeof text !== 'string' || text.indexOf('\r') >= 0) return false;
  const lines = text.split('\n');
  if (lines.length !== LD_SUMMARY_LABELS.length) return false;
  return lines.every((line, i) => {
    const prefix = BULLET + LD_SUMMARY_LABELS[i] + ': ';
    return line.startsWith(prefix) && /\S/.test(line.charAt(prefix.length));
  });
}

// ── Label anchors ───────────────────────────────────────────────────────────
// Label variants (case-insensitive), in canonical field order.
const LABEL_SRC = [
  'initial\\s+issues?(?:\\s+reported)?',
  '(?:primary\\s+)?vendor\\s+rejections?',
  '(?:primary\\s+)?barriers?',
  'actions?\\s+taken',
  'repair\\s+status',
  'ET[CA]',
  'follow[\\s-]?up(?:\\s+date)?',
];
// A label only counts as an anchor when it is followed by a colon AND sits at
// the start of the text, the start of a line, after a sentence/clause end
// (`.` or `;` + space), or after a bullet glyph. That keeps mid-sentence words
// such as "no estimate or ETC." from being read as labels.
//   group 1 = boundary, groups 2..8 = which label matched.
const ROUND_BULLETS = '\\u2022\\u00b7\\u25aa\\u25cf\\u25e6';
const ANCHOR_SRC =
  '(^|\\n|[.;][ \\t]+|[ \\t](?=[' + ROUND_BULLETS + ']))' +
  '[ \\t]*(?:(?:[' + ROUND_BULLETS + '*\\-]|\\d{1,2}[.)])[ \\t]*)?' +
  '(?:\\*\\*|__)?[ \\t]*' +
  '(?:' + LABEL_SRC.map((s) => '(' + s + ')').join('|') + ')' +
  '[ \\t]*(?:\\*\\*|__)?[ \\t]*:(?:[ \\t]*(?:\\*\\*|__))?';

function _findAnchors(s) {
  const re = new RegExp(ANCHOR_SRC, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const field = m.slice(2, 2 + LABEL_SRC.length).findIndex((g) => g !== undefined);
    // `index` = where the previous value ends (a boundary "." stays with it).
    const keepDot = m[1].charAt(0) === '.' ? 1 : 0;
    out.push({ field, index: m.index + keepDot, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

// Collapse whitespace; strip trailing bullet glyphs / separators left over
// from the next anchor's line.
function _clean(v) {
  return String(v).replace(/\s+/g, ' ').trim()
    .replace(/[\u2022\u00b7\u25aa\u25cf\u25e6\-*;,\s]+$/, '').trim();
}

const _splitSentences = (s) => s.split(/\n+|(?<=[.!?])\s+(?=[A-Z(])/).map(_clean).filter(Boolean);

// ── Prose mode cue table (first match wins, order matters) ──────────────────
// Conservative keyword cues; anything that matches nothing lands in Repair
// Status, so content is never dropped.
// NOTE: a plain "vendor" is deliberately NOT a Vendor Rejection cue. In real
// Aki prose ("No repair vendor is assigned…", "The carrier owns vendor
// selection…") it would wrongly fill a field that is really N/A. The sentence
// needs rejection language (reject / declined / out of scope / mobile).
const CUES = [
  [F_FOLLOW, (t) => /^(next step|if\b|then\b)/i.test(t) || /\bfollow[\s-]?up\b/i.test(t) || /\bnext step\b/i.test(t)],
  [F_REJECT, (t) => /\breject|\bdeclin|out of scope|\bmobile\b/i.test(t)],
  [F_ETC, (t) => /\bET[CA]\b/.test(t) || /estimated (time of )?completion/i.test(t)],
  [F_BARRIER, (t) => /\bbarrier|\bwaiting\b|pending|\bparts?\b|back ?order|\bestimate|payment|insurance|adjuster|\bclaim\b|\bowns?\b|cannot|approval/i.test(t)],
  [F_ACTIONS, (t) => /escalat|\btow(ed)?\b|relocat|coordinat|submitted|requested|reached out|contacted|\bfiled\b|confirmed|opened|created|reassigned|scheduled/i.test(t)],
  [F_INITIAL, (t, i, fields) => (i === 0 && fields[F_INITIAL].length === 0) || /reported|complaint|damage|symptom|\bfault|leak|noise|warning light/i.test(t)],
];

function _classify(sentence, i, fields) {
  for (const [field, test] of CUES) if (test(sentence, i, fields)) return field;
  return F_STATUS; // fallback: unplaceable content is kept, never dropped
}

// ── Follow-up shaping ───────────────────────────────────────────────────────
// Lead with the first full M/D/YYYY date already present in the text. A date
// without a 4-digit year is left as written (a year is never invented).
const FULL_DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/;
const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?';
const DATE_ONLY = new RegExp('^(?:follow[\\s-]?up(?:\\s+date)?\\s*:\\s*)?(?:' + WEEKDAY + '\\s+)?\\d{1,2}/\\d{1,2}/\\d{4}\\.?$', 'i');
const LEADS_WITH_DATE = new RegExp('^(?:' + WEEKDAY + '\\s+)?\\d{1,2}/\\d{1,2}/\\d{4}\\b', 'i');

function _shapeFollowUp(sentences) {
  const all = sentences.join(' ');
  const dm = all.match(FULL_DATE);
  if (!dm) return all;
  const rest = sentences.filter((s) => !DATE_ONLY.test(s)).join(' ');
  if (!rest) return dm[0];
  if (LEADS_WITH_DATE.test(rest)) return rest;
  return dm[0] + ' \u2014 ' + rest;
}

// ── Length cap ──────────────────────────────────────────────────────────────
// Shorten the currently longest value (cut at a word boundary, append "…")
// until the block fits. A value is never cut below the next-longest one in a
// single step, so the cuts spread over the long fields instead of reducing one
// field (e.g. the Follow-up date) to a stub. Labels and the 7-line shape are
// never cut.
function _build(values) {
  return values.map((v, i) => BULLET + LD_SUMMARY_LABELS[i] + ': ' + v).join('\n');
}
function _fit(values, maxLen) {
  let out = _build(values);
  while (out.length > maxLen) {
    let li = 0;
    values.forEach((v, i) => { if (v.length > values[li].length) li = i; });
    const v = values[li];
    if (v.length <= 2) break; // nothing left to shorten
    const next = Math.max(0, ...values.filter((_, i) => i !== li).map((x) => x.length));
    // -1 leaves room for the "…"; capped at v.length - 2 so every step shrinks.
    const target = Math.max(1, Math.min(v.length - 2, Math.max(v.length - (out.length - maxLen) - 1, next - 1)));
    let cut = v.slice(0, target);
    const sp = cut.lastIndexOf(' ');
    if (sp > 0) cut = cut.slice(0, sp);
    cut = cut.replace(/[\s,;:\-\u2014]+$/, '') || v.charAt(0);
    values[li] = cut + '\u2026';
    out = _build(values);
  }
  return out;
}

// Normalize an AI summary to the 7-bullet contract. See header for the rules.
// opts.maxLen: optional cap on the rebuilt block (callers pass their slice cap).
export function normalizeLongDwellSummary(text, { maxLen } = {}) {
  const raw = String(text == null ? '' : text);
  if (raw.trim() === '') return '';
  if (isLongDwellSummaryFormatted(raw)) return raw; // parity: byte-identical

  const s = raw.replace(/\r\n?/g, '\n');
  const anchors = _findAnchors(s);
  const distinct = new Set(anchors.map((a) => a.field));
  const parts = LD_SUMMARY_LABELS.map(() => []); // per field: list of text chunks

  if (distinct.size >= 3) {
    // STRUCTURED: the model used the labels (wrong bullets, no bullets, bold,
    // \r\n / \n\n separators, all on one line, or labels inside prose). Each
    // value runs from its colon to the next anchor; re-emit in canonical order.
    anchors.forEach((a, k) => {
      const stop = k + 1 < anchors.length ? anchors[k + 1].index : s.length;
      const v = _clean(s.slice(a.end, stop));
      if (v) parts[a.field].push(v);
    });
    const pre = _clean(s.slice(0, anchors[0].index));
    if (pre) {
      if (parts[F_INITIAL].length === 0) parts[F_INITIAL].push(pre);
      else parts[F_STATUS].unshift(pre);
    }
  } else {
    // PROSE (the Aki case): split into sentences and place each one using
    // the cue table. A sentence that starts with a label goes to that field.
    _splitSentences(s).forEach((sent, i) => {
      const lead = _findAnchors(sent)[0];
      if (lead && lead.index === 0) {
        const v = _clean(sent.slice(lead.end));
        if (v) parts[lead.field].push(v);
        return;
      }
      parts[_classify(sent, i, parts)].push(sent);
    });
  }

  const values = parts.map((chunks, i) => {
    if (i === F_FOLLOW && chunks.length) {
      return _shapeFollowUp(chunks.flatMap(_splitSentences));
    }
    // Duplicate labels (structured) are joined with "; ", sentences with " ".
    return chunks.join(distinct.size >= 3 ? '; ' : ' ');
  }).map((v, i) => v || (i === F_REJECT ? LD_PLACEHOLDER_NA : LD_PLACEHOLDER_UNKNOWN));

  return maxLen > 0 ? _fit(values, maxLen) : _build(values);
}
