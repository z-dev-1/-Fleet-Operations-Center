'use strict';
/**
 * autopilot/freshness.js — freshness class and display confidence (§B7.4). Pure.
 *
 * One threshold only: relayReconcileConfig.staleDays (default 3, clamp 1..30).
 *   LIVE     fetched in this run
 *   UNKNOWN  observedAt is null
 *   STALE    now - observedAt > staleDays, or now - retrievedAt > staleDays (stale cache)
 *   RECENT   otherwise
 *
 * Confidence (display only): authority index 0 -> 0.9, 1 -> 0.8, others or no
 * rule -> 0.65; untrusted text -> 0.4; email facts use their own confidence
 * clamped 0..1 and capped at 0.7. Multiplied by 0.7 when STALE.
 */

const { FIELD_AUTHORITY } = require('../ai/authority');

const DAY = 86400000;
const DEFAULT_STALE_DAYS = 3;

function clampStaleDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_STALE_DAYS;
  return Math.max(1, Math.min(30, Math.round(n)));
}

function classify(item, now, staleDays) {
  const it = item || {};
  if (it.live === true) return 'LIVE';
  if (it.observedAt == null) return 'UNKNOWN';
  const lim = clampStaleDays(staleDays) * DAY;
  if (now - it.observedAt > lim) return 'STALE';
  if (it.retrievedAt != null && now - it.retrievedAt > lim) return 'STALE';
  return 'RECENT';
}

function _authorityIndex(field, tag) {
  const order = FIELD_AUTHORITY[field];
  if (!order) return null;
  const t = String(tag || '').toLowerCase();
  for (let i = 0; i < order.length; i++) if (t.includes(order[i])) return i;
  return Infinity;
}

/** confidence(item) — item: { source, field, conflictField?, authorityTag, trust, freshness, confidence? } */
function confidence(item) {
  const it = item || {};
  let c;
  if (it.source === 'email' && Number.isFinite(Number(it.confidence))) {
    c = Math.min(0.7, Math.max(0, Math.min(1, Number(it.confidence))));
  } else if (it.trust === 'untrusted_text') {
    c = 0.4;
  } else {
    const idx = _authorityIndex(it.conflictField || it.field, it.authorityTag);
    c = idx === 0 ? 0.9 : (idx === 1 ? 0.8 : 0.65);
  }
  if (it.freshness === 'STALE') c *= 0.7;
  return Math.round(c * 1000) / 1000;
}

module.exports = { classify, confidence, clampStaleDays, DEFAULT_STALE_DAYS };
