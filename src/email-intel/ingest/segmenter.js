'use strict';
/**
 * email-intel/ingest/segmenter.js — conservative quote / signature / banner segmentation
 * (design 2.5). Pure.
 *
 *   segment(text, { subject, banners }) ->
 *     { newContent, segments:[{kind,text,chars}], flags, unitsOnlyInQuoted, newChars, totalChars }
 *
 * The goal is to find the NEWEST content without ever dropping a meaningful newer message:
 *  - the earliest quote boundary wins; forwarded content is KEPT (it carries the facts);
 *  - bottom-posting / inline replies keep everything (`inlineReply:true`);
 *  - stripping that would leave fewer than 15 non-space characters is skipped (`stripSkippedEmpty:true`);
 *  - a trailing signature block is only stripped when it holds no unit id, `$` amount, date/ETA
 *    keyword or question mark;
 *  - unit ids that appear only in quoted/signature text are reported, never dropped.
 *
 * Invariants (property-tested): the segments concatenate to the input modulo whitespace; every unit
 * id in the input is in newContent or in unitsOnlyInQuoted; newContent is non-empty for non-empty input.
 */

const DEFAULT_BANNERS = Object.freeze([
  'CAUTION: This email originated from outside of the organization',
  'EXTERNAL EMAIL',
]);
const MIN_REMAINING = 15;
const INLINE_MIN_CHARS = 40;
const SIG_MAX_LINES = 12;
const SIG_MAX_LINE = 80;

const UNIT_RE = /\b[A-Za-z]?\d{4,7}\b/g;
// Dates carry 4-digit years that look like unit ids; blank them out before looking for ids.
const DATE_RES = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/gi;
const unitsIn = (t) => new Set((String(t).replace(DATE_RES, ' ').match(UNIT_RE) || []).map((s) => s.toLowerCase()));
const nonSpace = (t) => String(t).replace(/\s+/g, '').length;

const RE_ORIGINAL = /^\s*-{3,}\s*original message\s*-{3,}\s*$/i;
const RE_UNDERSCORES = /^\s*_{32,}\s*$/;
const RE_FROM = /^\s*(?:\*\*)?from:\s*\S/i;
const RE_SENT_DATE = /^\s*(?:\*\*)?(sent|date):/i;
const RE_TO_SUBJECT = /^\s*(?:\*\*)?(to|subject):/i;
const RE_WROTE_ON = /^\s*on\b.+\bwrote:\s*$/i;
const RE_WROTE_END = /\bwrote:\s*$/i;
const RE_FWD = /^\s*(?:-{3,}\s*forwarded message\s*-{3,}|begin forwarded message:?|forwarded by\b)/i;
const RE_QUOTE_LINE = /^\s*>/;
const RE_CLOSING = /^\s*(thanks|thank you|many thanks|regards|best regards|kind regards|warm regards|best|sincerely|cheers)[,!.]?\s*$/i;
const RE_SIG_DASH = /^\s*--\s*$/;
const RE_PHONE = /(\+\d[\d\s().-]{8,}\d)|(\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g;
const RE_SIG_MARK = /(\+\d[\d\s().-]{8,}\d)|(\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)|(https?:\/\/|www\.)|(\b(manager|director|supervisor|specialist|engineer|coordinator|analyst|associate|lead|representative|technician|president|vp|operations|fleet)\b)|([\w.+-]+@[\w.-]+\.[a-z]{2,})/i;
const RE_KEEP_SIG = /(\$\s?\d)|\?|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(eta|ready|deliver\w*|arriv\w*|complet\w*|pick-?up|approv\w*|estimate)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

function _isQuoteBoundary(lines, i) {
  const l = lines[i];
  if (RE_ORIGINAL.test(l)) return 'header';
  if (RE_UNDERSCORES.test(l)) {
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) if (RE_FROM.test(lines[j])) return 'header';
    return null;
  }
  if (RE_FROM.test(l)) {
    let sent = false; let tos = false;
    for (let j = i + 1; j <= i + 6 && j < lines.length; j++) {
      if (RE_SENT_DATE.test(lines[j])) sent = true;
      if (RE_TO_SUBJECT.test(lines[j])) tos = true;
    }
    return sent && tos ? 'header' : null;
  }
  if (RE_WROTE_ON.test(l)) return 'wrote';
  if (/^\s*on\b/i.test(l) && i + 1 < lines.length && RE_WROTE_END.test(lines[i + 1]) && !RE_QUOTE_LINE.test(lines[i + 1])) return 'wrote';
  if (RE_QUOTE_LINE.test(l)) {
    let run = 0;
    for (let j = i; j < lines.length && RE_QUOTE_LINE.test(lines[j]); j++) run++;
    if (run >= 3) return 'prefix';
  }
  return null;
}

/** First index of a quote boundary strictly inside the lines, or -1, with its style. */
function _findBoundary(lines) {
  for (let i = 0; i < lines.length; i++) {
    const style = _isQuoteBoundary(lines, i);
    if (style) return { index: i, style };
  }
  return { index: -1, style: null };
}

function _findForward(lines) {
  for (let i = 0; i < lines.length; i++) if (RE_FWD.test(lines[i])) return i;
  return -1;
}

/** For ">"-style quoting: is a meaningful run of non-quoted text found AFTER a quoted run? */
function _hasTextAfterQuotedRun(lines, start) {
  let seenQuote = false;
  let extra = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (RE_QUOTE_LINE.test(l) || RE_WROTE_ON.test(l) || (RE_WROTE_END.test(l) && /^\s*on\b/i.test(lines[i - 1] || ''))) { seenQuote = true; continue; }
    if (!l.trim()) continue;
    if (/^\s*on\b/i.test(l) && i + 1 < lines.length && RE_WROTE_END.test(lines[i + 1])) continue;
    if (seenQuote) extra += l.trim().length;
  }
  return extra >= INLINE_MIN_CHARS;
}

function _stripSignature(headLines) {
  const n = headLines.length;
  // Work on the last SIG_MAX_LINES non-trailing-blank lines.
  let end = n;
  while (end > 0 && !headLines[end - 1].trim()) end--;
  const startWin = Math.max(0, end - SIG_MAX_LINES);
  let s = -1;
  for (let i = startWin; i < end; i++) {
    if (RE_SIG_DASH.test(headLines[i]) || RE_CLOSING.test(headLines[i])) { s = i; break; }
  }
  if (s < 0) return null;
  const block = headLines.slice(s, end);
  if (block.some((l) => l.length > SIG_MAX_LINE)) return null;
  const blockText = block.join('\n');
  // The closing phrase alone is not a signature; the block must look like one.
  const rest = block.slice(1).join('\n');
  if (!RE_SIG_MARK.test(rest) && !RE_SIG_DASH.test(block[0])) return null;
  if (RE_KEEP_SIG.test(blockText) || unitsIn(blockText.replace(RE_PHONE, ' ')).size) return null;
  return { index: s, endIndex: end };
}

function _matchesBanner(line, banners) {
  const t = line.trim().toLowerCase().replace(/^[\[\(*]+|[\]\)*]+$/g, '');
  if (!t) return false;
  return banners.some((b) => { const bb = String(b).trim().toLowerCase().replace(/^[\[\(*]+|[\]\)*]+$/g, ''); return bb && (t === bb || t.startsWith(bb)); });
}

function segment(textIn, opts) {
  opts = opts || {};
  const input = String(textIn == null ? '' : textIn).replace(/\r\n?/g, '\n');
  const banners = DEFAULT_BANNERS.concat(Array.isArray(opts.banners) ? opts.banners : []);
  const flags = { inlineReply: false, stripSkippedEmpty: false, forwarded: false, quoted: false, signatureStripped: false, bannerStripped: false };
  const totalChars = input.length;
  const done = (segments, forwardedText) => {
    let newText = segments.filter((s) => s.kind === 'new').map((s) => s.text).join('\n');
    if (forwardedText) newText = newText ? newText + '\n' + forwardedText : forwardedText;
    let newContent = newText.trim();
    if (!newContent && input.trim()) { newContent = input.trim(); flags.stripSkippedEmpty = true; }
    const inNew = unitsIn(newContent);
    const stripped = segments.filter((s) => s.kind === 'quoted' || s.kind === 'signature').map((s) => s.text).join('\n').replace(RE_PHONE, ' ');
    const only = Array.from(unitsIn(stripped)).filter((u) => !inNew.has(u));
    return {
      newContent,
      segments: segments.map((s) => ({ kind: s.kind, text: s.text, chars: s.text.length })),
      flags, unitsOnlyInQuoted: only, newChars: newContent.length, totalChars,
    };
  };
  if (!input.trim()) return done([{ kind: 'new', text: input }], '');

  let lines = input.split('\n');
  const segs = [];

  // Banner at the very top / bottom only.
  let top = 0;
  while (top < lines.length && !lines[top].trim()) top++;
  if (top < lines.length && _matchesBanner(lines[top], banners)) {
    segs.push({ kind: 'banner', text: lines.slice(0, top + 1).join('\n') });
    lines = lines.slice(top + 1);
    flags.bannerStripped = true;
  }
  let bottomBanner = null;
  {
    let b = lines.length - 1;
    while (b >= 0 && !lines[b].trim()) b--;
    if (b >= 0 && _matchesBanner(lines[b], banners)) {
      bottomBanner = { kind: 'banner', text: lines.slice(b).join('\n') };
      lines = lines.slice(0, b);
      flags.bannerStripped = true;
    }
  }

  const isFwdSubject = /^\s*(fw|fwd)\s*:/i.test(String(opts.subject || ''));
  const fwdAt = _findForward(lines);
  const b = _findBoundary(lines);
  let headLines = lines;
  let tail = null;           // { kind, lines }

  if (fwdAt !== -1 && (b.index === -1 || fwdAt <= b.index)) {
    headLines = lines.slice(0, fwdAt);
    tail = { kind: 'forwarded', lines: lines.slice(fwdAt) };
    flags.forwarded = true;
  } else if (b.index !== -1) {
    if (b.style === 'header' && isFwdSubject && nonSpace(lines.slice(0, b.index).join('')) < 400) {
      // A forwarded message whose boundary is an Outlook header block: the forwarded text carries the facts.
      headLines = lines.slice(0, b.index);
      tail = { kind: 'forwarded', lines: lines.slice(b.index) };
      flags.forwarded = true;
    } else if ((b.style === 'prefix' || b.style === 'wrote') && _hasTextAfterQuotedRun(lines, b.index)) {
      flags.inlineReply = true;
      return finish(segs, [{ kind: 'new', text: lines.join('\n') }], bottomBanner, '');
    } else {
      headLines = lines.slice(0, b.index);
      tail = { kind: 'quoted', lines: lines.slice(b.index) };
      flags.quoted = true;
    }
  }

  // Too little left after stripping: keep everything (bottom post / quote-only mail).
  if (tail && tail.kind === 'quoted' && nonSpace(headLines.join('')) < MIN_REMAINING) {
    flags.stripSkippedEmpty = true; flags.quoted = false; flags.inlineReply = nonSpace(lines.join('')) > 0;
    return finish(segs, [{ kind: 'new', text: lines.join('\n') }], bottomBanner, '');
  }

  // Signature on the head only.
  const sig = _stripSignature(headLines);
  const parts = [];
  if (sig && nonSpace(headLines.slice(0, sig.index).join('')) >= MIN_REMAINING) {
    parts.push({ kind: 'new', text: headLines.slice(0, sig.index).join('\n') });
    parts.push({ kind: 'signature', text: headLines.slice(sig.index).join('\n') });
    flags.signatureStripped = true;
  } else {
    if (sig) flags.stripSkippedEmpty = true;
    parts.push({ kind: 'new', text: headLines.join('\n') });
  }
  let forwardedText = '';
  if (tail) {
    const t = tail.lines.join('\n');
    parts.push({ kind: tail.kind, text: t });
    if (tail.kind === 'forwarded') forwardedText = t;
  }
  return finish(segs, parts, bottomBanner, forwardedText);

  function finish(top2, body, bottom, fwd) {
    const all = top2.concat(body);
    if (bottom) all.push(bottom);
    return done(all, fwd);
  }
}

module.exports = { DEFAULT_BANNERS, segment, unitsIn };
