'use strict';
/**
 * autopilot/updates.js — update times and date helpers (§B7.5). Pure.
 *
 *   newestLoggedUpdate(fullConversation, syncedAt) -> ms | null
 *     Lines "MM/DD - <who>: ..." (commentsToTimeline format). Year = year of
 *     syncedAt; a date more than 1 day after syncedAt belongs to the previous year.
 *   newestLiveComment(comments) -> ms | null   (max getService comment timestamp)
 *   newestVendorUpdate(items)   -> { at, source } | null
 *     Vendor platforms only: DTNA, Decisiv, row offsiteStageSince. AAP comments
 *     are not counted because their author cannot be identified as the vendor.
 *   toMs(v), isoDate(v, refMs)
 */

const DAY = 86400000;

function toMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000); // Slack-style seconds
  if (/^\d{12,14}$/.test(s)) return parseInt(s, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function _pad(n) { return String(n).padStart(2, '0'); }
function _localIso(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate());
}

/**
 * isoDate(v, refMs) -> 'YYYY-MM-DD' | null
 * Accepts ISO dates/timestamps, MM/DD/YYYY, MM/DD/YY, MM/DD (year of refMs;
 * a date more than 180 days before refMs rolls to the next year), and epoch ms.
 */
function isoDate(v, refMs) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? _localIso(v) : null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  if (m) {
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let y;
    if (m[3]) {
      y = parseInt(m[3], 10);
      if (y < 100) y += 2000;
    } else {
      const ref = Number.isFinite(refMs) ? refMs : Date.now();
      y = new Date(ref).getFullYear();
      if (new Date(y, mo - 1, da).getTime() < ref - 180 * DAY) y += 1;
    }
    return y + '-' + _pad(mo) + '-' + _pad(da);
  }
  const t = toMs(s);
  return t == null ? null : _localIso(t);
}

const LOG_LINE = /(?:^|\n)\s*(\d{1,2})\/(\d{1,2})\s*-\s*[^:\n]*:/g;

function newestLoggedUpdate(fullConversation, syncedAt) {
  const text = Array.isArray(fullConversation) ? fullConversation.join('\n') : (typeof fullConversation === 'string' ? fullConversation : '');
  if (!text) return null;
  const syncMs = toMs(syncedAt);
  if (syncMs == null) return null;
  const year = new Date(syncMs).getFullYear();
  let best = null;
  LOG_LINE.lastIndex = 0;
  let m;
  while ((m = LOG_LINE.exec(text)) !== null) {
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
    let t = new Date(year, mo - 1, da).getTime();
    if (t - syncMs > DAY) t = new Date(year - 1, mo - 1, da).getTime();
    if (best == null || t > best) best = t;
  }
  return best;
}

function newestLiveComment(comments) {
  let best = null;
  for (const c of comments || []) {
    const t = toMs(c && (c.timestamp || c.createdAt || c.updated));
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

function newestVendorUpdate(items) {
  let best = null;
  for (const it of items || []) {
    if (!it) continue;
    let at = null;
    if (it.source === 'dtna' || it.source === 'decisiv') at = toMs(it.observedAt);
    else if (it.source === 'aap_cache' && it.field === 'offsiteStage' && it.observedFrom === 'offsiteStageSince') at = toMs(it.observedAt);
    else if (it.source === 'aap_cache' && it.field === 'offsiteStageSince') at = toMs(it.value);
    if (at != null && (!best || at > best.at)) best = { at, source: it.source };
  }
  return best;
}

module.exports = { toMs, isoDate, newestLoggedUpdate, newestLiveComment, newestVendorUpdate };
