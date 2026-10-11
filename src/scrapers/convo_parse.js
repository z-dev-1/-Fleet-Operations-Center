'use strict';
/**
 * scrapers/convo_parse.js — ADDITIVE structured parsing of a conversation blob.
 *
 * The Relay Garage and Offsite (Decisiv/ASIST) scrapers capture a conversation
 * as a flat innerText blob (fullConversation / asistNotes). That blob is kept
 * verbatim — nothing here replaces it. This module DERIVES a best-effort
 * structured view from it so downstream reasoning (the reconcile intent engine)
 * can tell WHO sent the last comment and WHETHER we already replied, instead of
 * fuzzy-matching a de-ordered blob.
 *
 * Contract (hard):
 *   - NEVER throws. Returns [] when it can't confidently split the blob — the
 *     caller then falls back to the raw blob exactly as today. So this can only
 *     ADD clarity, never remove data or break a scrape.
 *   - Does not mutate the input.
 *   - Side inference is heuristic (name/role/company substrings). When unsure it
 *     returns side:'unknown' rather than guessing.
 *
 * Comment shape: { author, side:'vendor'|'us'|'unknown', date, text }
 * ordered oldest-first (as the thread renders). lastComment() returns the most
 * recent (last) one.
 */

// Month-name date like "Oct 9, 2026 06:07 PM" or "Jan 3, 2026".
const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},\s+\d{4}/i;
// Numeric date like 10/09/26 or 10/09/2026 (offsite portals often use this).
const NUM_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

// Signals that a line/author belongs to US (Amazon/fleet side) vs the VENDOR.
const US_SIGNALS = [
  'amazon', 'logistics', 'amzl', 'fleet ops', 'fleet operations', 'relay',
  'santiago', 'coordinator', 'internal',
];
const VENDOR_SIGNALS = [
  'service advisor', 'service manager', 'advisor', 'dealer', 'truck', 'trucks',
  'volvo', 'freightliner', 'kenworth', 'peterbilt', 'mack', 'international',
  'cummins', 'navistar', 'paccar', 'ta ', 'travelcenters', 'amerit', 'cox',
  'velociti', 'fleetnet', 'fleet net', 'rush', 'hunter', 'kooner', 'goodyear',
  'penske', 'ryder', 'technician', 'tech ', 'parts', 'estimator',
];

function _lc(s) { return String(s == null ? '' : s).toLowerCase(); }

// Infer which side an author line belongs to from name/role/company substrings.
// opts.usNames: extra operator names (e.g. the signed-in user) treated as us.
function inferSide(authorLine, opts) {
  opts = opts || {};
  const s = _lc(authorLine);
  if (!s) return 'unknown';
  const extraUs = (opts.usNames || []).map(_lc).filter(Boolean);
  for (const sig of extraUs) { if (sig && s.includes(sig)) return 'us'; }
  const usHit = US_SIGNALS.some((sig) => s.includes(sig));
  const vendorHit = VENDOR_SIGNALS.some((sig) => s.includes(sig));
  // "to" direction cue: "Jose (vendor) to Z SANTIAGO - Amazon" — the author is
  // the part BEFORE "to", so if US signals appear only after a " to " they're
  // the recipient, not the author. Weight the author portion.
  if (usHit && !vendorHit) return 'us';
  if (vendorHit && !usHit) return 'vendor';
  if (usHit && vendorHit) {
    // Both present — decide by which appears first (the author is named first).
    const firstUs = Math.min(...US_SIGNALS.map((x) => { const i = s.indexOf(x); return i < 0 ? Infinity : i; }));
    const firstVendor = Math.min(...VENDOR_SIGNALS.map((x) => { const i = s.indexOf(x); return i < 0 ? Infinity : i; }));
    return firstUs <= firstVendor ? 'us' : 'vendor';
  }
  return 'unknown';
}

function _clip(s, n) { return String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, n || 1200); }

// A parsed "comment" that is really equipment/service OVERVIEW chrome from the
// Relay WR page header (not an actual thread comment). Identified by telltale
// label text and the absence of real prose. Conservative: only drops lines that
// clearly match page-chrome patterns, so real comments are never removed.
const _OVERVIEW_JUNK_RE = /\b(Asset ID|Asset Type|VIN|Owner Name|Domicile Site|VRID|Dock Status|Work Duration|Service Overview|Equipment Overview|Last Yard Location|Last Completed Maintenance|Lifecycle (State|Reason)|hours? ago|days? ago|minutes? ago|Skip to main|Associate Workspace|Dark mode|Contact us|Toggle Comments)\b/i;
function _isOverviewJunk(c) {
  const t = String((c && c.text) || '').trim();
  if (!t) return true;
  // Pure "N hours/days ago" or very short label-ish fragments.
  if (/^\d+\s+(hours?|days?|minutes?)\s+ago$/i.test(t)) return true;
  if (t.length < 12 && !/[.?!]/.test(t)) {
    // short and no sentence punctuation — likely a label unless it's a URL.
    if (!/https?:\/\//i.test(t)) return _OVERVIEW_JUNK_RE.test(t) || !/[a-z]{4,}/i.test(t);
  }
  // Longer fragments that are dominated by overview labels (tabs/metrics).
  if (_OVERVIEW_JUNK_RE.test(t) && !/[.?!]/.test(t) && t.split(/\s+/).length < 14) return true;
  return false;
}

/**
 * parseConversation(blob, opts) -> [{author, side, date, text}]  (oldest-first)
 * opts: { usNames?: string[], cap?: number }  (cap = max comments kept, newest-biased)
 * Best-effort; returns [] when it can't find at least one author→date→text block.
 */
function parseConversation(blob, opts) {
  opts = opts || {};
  let raw = String(blob == null ? '' : blob);
  if (!raw.trim()) return [];
  // Trim the equipment/service OVERVIEW header that Relay WR pages render before
  // the real thread (Asset ID, VIN, Work Duration, "N hours ago"...), whose
  // date-ish lines otherwise parse as junk comments. The thread begins at the
  // "Conversation" section marker (same anchor deep-scan uses). We trim at the
  // marker that is actually followed by comment structure. If no marker (offsite
  // pages), parse the whole blob and rely on the junk filter below.
  const markerRe = /\n\s*Conversation\s*\n/gi;
  let mm, bestIdx = -1;
  while ((mm = markerRe.exec(raw)) !== null) { bestIdx = mm.index; break; } // first marker
  if (bestIdx > -1) raw = raw.slice(bestIdx);
  const cap = Number.isFinite(opts.cap) ? opts.cap : 25;
  let comments = [];
  try {
    comments = _parseBlocks(raw, opts);
  } catch (_) { return []; } // never throw
  if (!comments.length) return [];
  // Drop junk "comments" that are actually equipment/service OVERVIEW header
  // fragments (Asset ID, VIN, "4 hours ago", VRID/Dock labels, section nav).
  // Relay WR pages render that chrome before the real thread; its date-ish lines
  // otherwise parse as comments. We FILTER rather than hard-trim the blob so we
  // never accidentally drop real comments (a blob can contain the word
  // "Conversation" more than once). A real comment has prose; junk is labels.
  comments = comments.filter((c) => !_isOverviewJunk(c));
  if (!comments.length) return [];
  // Newest-biased cap: keep the LAST `cap` comments (most recent exchange).
  if (comments.length > cap) comments = comments.slice(comments.length - cap);
  return comments;
}

// Core block parser: scan for the username → date → text → (share-type) pattern
// both engines render. Mirrors the renderer's proven _parseComments heuristic,
// generalized to numeric dates and side inference.
function _parseBlocks(raw, opts) {
  const lines = raw.split('\n').map((l) => l.replace(/\u0000/g, '').trimEnd());
  const out = [];
  let i = 0;
  const n = lines.length;
  const isDate = (s) => DATE_RE.test(s) || NUM_DATE_RE.test(s);
  const SHARE = /^(Internal Only|Vendor|Work Request|Service Event|Public)$/i;

  while (i < n) {
    const line = (lines[i] || '').trim();
    if (!line) { i++; continue; }

    // Find the next non-empty line to test for a date.
    let nextIdx = i + 1;
    while (nextIdx < n && !(lines[nextIdx] || '').trim()) nextIdx++;
    const nextNonEmpty = (lines[nextIdx] || '').trim();

    // A comment header can be a MULTI-LINE author block before the date, e.g.
    //   "Jose Mallen - Hunter Truck (Service Advisor) to"
    //   "Z SANTIAGO - Amazon Logistics and 1 MORE CONTACT"
    //   "Oct 9, 2026 06:07 PM"
    // The AUTHOR (sender) is the FIRST line; the following "to <recipient>" /
    // "... and N MORE CONTACT" lines are recipients, not the author. Walk
    // forward collecting header lines until we hit the date line.
    const looksLikeAuthor = line.length > 0 && line.length < 120 && /[a-z]/i.test(line) && !isDate(line) && !SHARE.test(line);
    let dateIdx = -1;
    if (looksLikeAuthor) {
      // Scan up to 3 non-empty lines ahead for the date that closes the header.
      let scan = i, seen = 0;
      while (scan < n && seen < 4) {
        let s2 = scan + 1;
        while (s2 < n && !(lines[s2] || '').trim()) s2++;
        const cand = (lines[s2] || '').trim();
        if (isDate(cand)) { dateIdx = s2; break; }
        // only keep walking while the intervening lines look like header
        // continuation (recipient lines), not message body.
        if (!cand || cand.length > 120 || SHARE.test(cand)) break;
        scan = s2; seen++;
      }
    }
    if (looksLikeAuthor && dateIdx > -1) {
      const author = line; // sender = first header line
      const nextNonEmptyDate = (lines[dateIdx] || '').trim();
      const nextIdxForText = dateIdx;
      const dateMatch = nextNonEmptyDate.match(DATE_RE) || nextNonEmptyDate.match(NUM_DATE_RE);
      const date = dateMatch ? dateMatch[0] : nextNonEmptyDate.replace(/\s*\(.*?\)\s*$/, '');
      // Collect the message text: everything after the date line until the next
      // author→date header or a share-type/system line.
      let j = nextIdxForText + 1;
      const textParts = [];
      let share = '';
      while (j < n) {
        const t = (lines[j] || '').trim();
        if (!t) { j++; continue; }
        if (SHARE.test(t)) { share = t; j++; continue; }
        // stop if a new author→date block begins
        let k = j + 1;
        while (k < n && !(lines[k] || '').trim()) k++;
        const after = (lines[k] || '').trim();
        if (t.length < 90 && /[a-z]/i.test(t) && !isDate(t) && isDate(after)) break;
        if (/^(Enter Comments|Add Comment)/i.test(t)) break;
        textParts.push(t);
        j++;
      }
      const text = _clip(textParts.join(' '), 1200);
      if (text && text !== 'Work Request' && text !== 'Service Event') {
        // Side from the author line + any "Internal Only/Vendor" share cue.
        let side = inferSide(author, opts);
        if (side === 'unknown' && share) {
          if (/vendor/i.test(share)) side = 'vendor';
          else if (/internal/i.test(share)) side = 'us';
        }
        out.push({ author: _clip(author, 120), side, date: _clip(date, 60), text });
      }
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

// The most recent comment (last in oldest-first order), or null.
function lastComment(comments) {
  if (!Array.isArray(comments) || !comments.length) return null;
  return comments[comments.length - 1];
}

// Compact one-line summary of who spoke last — for prompts/logging.
// e.g. "us on Oct 9, 2026: can you provide an est WITH FREIGHT?"
function lastCommentLine(comments, maxText) {
  const c = lastComment(comments);
  if (!c) return '';
  const t = _clip(c.text, maxText || 240);
  return (c.side || 'unknown') + (c.date ? ' on ' + c.date : '') + ': ' + t;
}

module.exports = {
  parseConversation,
  lastComment,
  lastCommentLine,
  inferSide,
  DATE_RE,
  NUM_DATE_RE,
};
