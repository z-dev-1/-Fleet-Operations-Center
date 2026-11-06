'use strict';
/**
 * email-intel/facts/item-match.js — fuzzy comparison of the free-text `item` of a fact (design 4.2, F-07).
 *
 * The model chooses the item wording ("turbo" one day, "turbocharger" the next), so item text is never
 * an exact-match key component for dedupe or supersession. Pure functions only:
 *
 *   normItem(s)       lowercase, non-alphanumerics -> space, stopwords dropped, first 5 tokens, sorted, joined
 *   tokens(s)         normItem(s) as a token list
 *   tokMatch(x, y)    equal, or (both >= 3 chars and one is a prefix of the other): turbo ~ turbocharger
 *   overlap(A, B)     share of the smaller list that has a tokMatch partner in the other list
 *   itemsMatch(a, b)  'unknown' when either side is empty, 'match' when overlap >= 0.5, else 'differ'
 *   shareToken(a, b)  any tokMatch pair between two free texts (>= 3 char tokens, no 5-token cap)
 */

const STOPWORDS = Object.freeze(['the', 'a', 'an', 'for', 'of', 'on', 'to', 'part', 'parts', 'unit']);
const STOP = new Set(STOPWORDS);
const MAX_TOKENS = 5;

function _raw(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !STOP.has(t));
}

function tokens(s) { return _raw(s).slice(0, MAX_TOKENS).sort(); }

function normItem(s) { return tokens(s).join(' '); }

function tokMatch(x, y) {
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x));
}

function overlap(A, B) {
  if (!A.length || !B.length) return 0;
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  let n = 0;
  for (const a of small) if (big.some((b) => tokMatch(a, b))) n++;
  return n / small.length;
}

/** itemsMatch(a, b) -> 'match' | 'differ' | 'unknown' (an item that normalizes to nothing counts as missing). */
function itemsMatch(a, b) {
  const A = a == null ? [] : tokens(a);
  const B = b == null ? [] : tokens(b);
  if (!A.length || !B.length) return 'unknown';
  return overlap(A, B) >= 0.5 ? 'match' : 'differ';
}

/** True when the two texts share at least one non-stopword token of 3+ chars (prefix rule included). */
function shareToken(a, b) {
  const A = _raw(a).filter((t) => t.length >= 3);
  const B = _raw(b).filter((t) => t.length >= 3);
  return A.some((x) => B.some((y) => tokMatch(x, y)));
}

module.exports = { STOPWORDS, normItem, tokens, tokMatch, overlap, itemsMatch, shareToken };
