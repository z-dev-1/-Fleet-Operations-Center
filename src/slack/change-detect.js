'use strict';
/**
 * slack/change-detect.js — Phase 4b pure change-detection predicates.
 *
 * No I/O and no requires. Every predicate here fails OPEN: anything malformed,
 * unknown or throwing means "fetch" (today's behavior), never "skip". The
 * invariant these own is "a conversation with a newer message is never
 * skipped" (design §4); the engines only consult them when a speed-up flag is
 * not 'off'.
 *
 *   compareTs(a, b)           exact Slack ts compare (-1|0|1), null if either is invalid
 *   maxTs(...vals)            largest valid ts, null if none
 *   skipAgeMs(channelId)      deterministic 5–10 min age bound for S2 skips
 *   dmSkipDecision(...)       S2: may this DM's history fetch be skipped?
 *   snapshotCutoff(...)       S4: newest ts that provably existed at the root snapshot
 *
 * S3 (thread-reply reuse) is deferred to its own round; none of its helpers
 * (threadSig, thread cache, movesWatermark) live here.
 */

const TS_RE = /^\d{1,12}(\.\d{1,6})?$/;

function _validTs(v) { return typeof v === 'string' && TS_RE.test(v); }

// Exact compare: integer part as a Number (≤ 12 digits, exact), fractional part
// right-padded to 6 digits as an integer. Never parseFloat.
function compareTs(a, b) {
  if (!_validTs(a) || !_validTs(b)) return null;
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const an = Number(ai), bn = Number(bi);
  if (an !== bn) return an < bn ? -1 : 1;
  const afn = Number(af.padEnd(6, '0')), bfn = Number(bf.padEnd(6, '0'));
  if (afn === bfn) return 0;
  return afn < bfn ? -1 : 1;
}

function maxTs(...vals) {
  let best = null;
  for (const v of vals) {
    if (!_validTs(v)) continue;
    if (best === null || compareTs(v, best) === 1) best = v;
  }
  return best;
}

function _fnv1a32(s) {
  let h = 0x811c9dc5;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 300000 + (fnv1a32(id) % 300000): deterministic per channel, in [5, 10) min,
// so age refetches of skipped DMs are spread instead of landing on one run.
function skipAgeMs(channelId) { return 300000 + (_fnv1a32(channelId) % 300000); }

/**
 * S2 decision. Skip ONLY when every condition holds; otherwise the first
 * failing reason is returned and the DM is fetched (design §3 S2 table).
 */
function dmSkipDecision({ dm, lastSeenTs, lastFetchedAt, now } = {}) {
  try {
    if (!dm || dm.isSelf === true) return { skip: false, reason: 'self' };
    if (!_validTs(lastSeenTs)) return { skip: false, reason: 'noWatermark' };
    if (dm.unread !== false) return { skip: false, reason: 'unread' };
    if (!_validTs(dm.latestTs)) return { skip: false, reason: 'unknownLatest' };
    const c = compareTs(dm.latestTs, lastSeenTs);
    if (c === null || c > 0) return { skip: false, reason: 'newer' };
    if (typeof lastFetchedAt !== 'number' || !Number.isFinite(lastFetchedAt)) return { skip: false, reason: 'coldStart' };
    const t = typeof now === 'number' ? now : Date.now();
    if (!(t - lastFetchedAt < skipAgeMs(dm.channelId))) return { skip: false, reason: 'stale' };
    return { skip: true, reason: 'unchanged' };
  } catch (_) {
    return { skip: false, reason: 'error' };
  }
}

// S4 mixed-snapshot guard input: max over every root ts / latestReply and the
// prior observed max; '0' if none.
function snapshotCutoff(rootMessages, priorObservedMax) {
  const vals = [priorObservedMax];
  for (const r of (Array.isArray(rootMessages) ? rootMessages : [])) {
    if (r) { vals.push(r.ts); vals.push(r.latestReply); }
  }
  return maxTs(...vals) || '0';
}

module.exports = { compareTs, maxTs, skipAgeMs, dmSkipDecision, snapshotCutoff };
