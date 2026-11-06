'use strict';
/**
 * email-intel/facts/canonical-at.js — the canonical change-time parser (design 4.3, F-02; R3.2).
 *
 * canonical_state._lastMeaningfulUpdate returns { source, text, at } where source is only
 * 'offsite' | 'relay' | 'timeline' and `at` is a free-form comment date ("Oct 9, 2026 06:07 PM",
 * "10/12/26"), the row's asistScrapedAt (a scrape time), or '' (timeline source). Only relay and
 * offsite are authoritative; the timeline includes this feature's own email lines and manual notes.
 * updatedAt / syncedAt / scrape times are never used as a source change time, and Date.parse is
 * never applied to free-form text.
 *
 *   parseCanonicalAt(lmu, row) -> { ms:number|null, precision:'minute'|'day'|'none', authoritative, zoneExplicit }
 *   compareFreshness(canon, msg, { tzVerified }) -> 'canonical-newer' | 'email-newer' | 'unprovable' | 'not-comparable'
 */
const C = require('../constants');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NONE = (authoritative) => ({ ms: null, precision: 'none', authoritative, zoneExplicit: false });

function _valid(y, mo, d) {
  const t = new Date(y, mo, d);
  return t.getFullYear() === y && t.getMonth() === mo && t.getDate() === d;
}

function _hm(hh, mm, ap) {
  let h = Number(hh); const m = Number(mm);
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    const pm = /p/i.test(ap);
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  } else if (h > 23) return null;
  return { h, m };
}

function parseCanonicalAt(lmu, row) {
  const authoritative = !!lmu && (lmu.source === 'relay' || lmu.source === 'offsite');
  if (!lmu) return NONE(false);
  const at = String(lmu.at == null ? '' : lmu.at).trim();
  if (!at) return NONE(authoritative);
  if (row && at === String(row.asistScrapedAt == null ? '' : row.asistScrapedAt).trim()) return NONE(authoritative);

  // M/D/YY or M/D/YYYY (same rule as convo_parse._parseCommentDate): local midnight, day precision.
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(at);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const mo = Number(m[1]) - 1; const d = Number(m[2]);
    if (!_valid(y, mo, d)) return NONE(authoritative);
    return { ms: new Date(y, mo, d).getTime(), precision: 'day', authoritative, zoneExplicit: false };
  }
  // "Oct 9, 2026" / "Oct 9, 2026 06:07 PM": local time.
  m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2})(?: ?([AP]M))?)?$/i.exec(at);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = Number(m[3]); const d = Number(m[2]);
    if (mo == null || !_valid(y, mo, d)) return NONE(authoritative);
    if (m[4] == null) return { ms: new Date(y, mo, d).getTime(), precision: 'day', authoritative, zoneExplicit: false };
    const t = _hm(m[4], m[5], m[6]);
    if (!t) return NONE(authoritative);
    return { ms: new Date(y, mo, d, t.h, t.m).getTime(), precision: 'minute', authoritative, zoneExplicit: false };
  }
  // ISO 8601 with a time part.
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(at);
  if (m) {
    const ms = Date.parse(at.replace(' ', 'T'));
    if (!Number.isFinite(ms)) return NONE(authoritative);
    return { ms, precision: 'minute', authoritative, zoneExplicit: !!m[7] };
  }
  return NONE(authoritative);
}

function _dayKey(ms) { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

/**
 * compareFreshness(canon, msg, opts)
 *   canon: parseCanonicalAt result (or null when there is no lmu)
 *   msg:   { receivedAt (ISO), receivedAtPrecision }
 *   opts:  { tzVerified } (config mailboxTzVerified, set only by the P-TZ probe)
 * Minute vs minute compares instants, except (F-27) when neither side carries an explicit zone, the
 * mailbox zone is not verified and the instants are within TZ_UNPROVABLE_WINDOW_MS: unprovable.
 * Any day-precision side compares calendar days; the same day is unprovable.
 */
function compareFreshness(canon, msg, opts) {
  if (!canon || !canon.authoritative) return 'not-comparable';
  if (!Number.isFinite(canon.ms) || canon.precision === 'none') return 'unprovable';
  const em = Date.parse((msg && msg.receivedAt) || '');
  if (!Number.isFinite(em)) return 'unprovable';
  const emailMinute = msg.receivedAtPrecision === 'minute';
  if (canon.precision === 'minute' && emailMinute) {
    const zoneKnown = canon.zoneExplicit === true && msg.zoneExplicit === true;
    if (!zoneKnown && !(opts && opts.tzVerified === true) && Math.abs(canon.ms - em) < C.TZ_UNPROVABLE_WINDOW_MS) return 'unprovable';
    if (canon.ms === em) return 'unprovable';
    return canon.ms > em ? 'canonical-newer' : 'email-newer';
  }
  const cd = _dayKey(canon.ms); const ed = _dayKey(em);
  if (cd === ed) return 'unprovable';
  return cd > ed ? 'canonical-newer' : 'email-newer';
}

module.exports = { parseCanonicalAt, compareFreshness };
