'use strict';
/**
 * email-intel/capture/received-time.js — reliable received-time parser (design 2.6).
 *
 *   parseReceived(raw, { now, tzMinutes }) -> { iso|null, quality, precision, raw, zoneExplicit }
 *
 * quality: exact | parsed-header | inferred-today | inferred-date | unknown
 * precision: 'second' | 'minute' | 'day' | null
 *
 * Never calls Date.parse on a partial token (the year-2001 defect). Relative words
 * ("Yesterday", "Last week", anything else) are `unknown`, never guessed (F-27).
 * When the token carries no explicit offset the local machine zone is assumed (A-4);
 * tests may pass `tzMinutes` (offset of the mailbox zone from UTC, e.g. -300) to be
 * independent of the machine zone.
 */

const QUALITY_RANK = Object.freeze({ exact: 4, 'parsed-header': 3, 'inferred-today': 2, 'inferred-date': 1, unknown: 0 });
const rank = (q) => (Object.prototype.hasOwnProperty.call(QUALITY_RANK, q) ? QUALITY_RANK[q] : 0);
/** GOOD quality: a time we can trust for identity and freshness comparisons. */
const isGood = (q) => q === 'exact' || q === 'parsed-header';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const FUTURE_SLACK_MS = 5 * 60_000;

const RE_ISO_FULL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const RE_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AaPp]\\.?[Mm]\\.?)?';
const RE_TIME_ONLY = new RegExp('^' + TIME + '$');
const WD = '(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\\.?,?';
const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?';
const RE_WD_TIME = new RegExp('^' + WD + '\\s+' + TIME + '$', 'i');
const RE_NUM_DATE_TIME = new RegExp('^(?:' + WD + '\\s+)?(\\d{1,2})/(\\d{1,2})/(\\d{2,4}),?\\s+' + TIME + '$', 'i');
const RE_TEXT_DATE_TIME = new RegExp('^(?:' + WD + '\\s+)?' + MON + '\\s+(\\d{1,2}),?\\s+(\\d{4}),?\\s+(?:at\\s+)?' + TIME + '$', 'i');
const RE_TEXT_DATE_TIME_DMY = new RegExp('^(?:' + WD + '\\s+)?(\\d{1,2})\\s+' + MON + '\\s+(\\d{4}),?\\s+' + TIME + '$', 'i');
const RE_NUM_DATE = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i;
const RE_TEXT_DATE = new RegExp('^(?:' + WD + '\\s+)?' + MON + '\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$', 'i');

function _unknown(raw) { return { iso: null, quality: 'unknown', precision: null, raw, zoneExplicit: false }; }

/** Build the instant for local wall-clock fields in the assumed zone. */
function _instant(y, mo, d, h, mi, s, tzMinutes) {
  if (Number.isFinite(tzMinutes)) return Date.UTC(y, mo, d, h, mi, s || 0) - tzMinutes * 60_000;
  return new Date(y, mo, d, h, mi, s || 0, 0).getTime();
}
/** The wall-clock calendar fields of `ms` in the assumed zone. */
function _fields(ms, tzMinutes) {
  if (Number.isFinite(tzMinutes)) {
    const d = new Date(ms + tzMinutes * 60_000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
  }
  const d = new Date(ms);
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay() };
}

function _hour24(h, mer) {
  if (!mer) return (h >= 0 && h <= 23) ? h : null;
  if (h < 1 || h > 12) return null;
  const pm = /^p/i.test(mer);
  if (pm) return h === 12 ? 12 : h + 12;
  return h === 12 ? 0 : h;
}
function _validDate(y, mo, d) {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d;
}
function _year(y) { const n = parseInt(y, 10); return y.length <= 2 ? 2000 + n : n; }
const _out = (ms, quality, precision, raw, zoneExplicit) => ({ iso: new Date(ms).toISOString(), quality, precision, raw, zoneExplicit: !!zoneExplicit });

function parseReceived(rawIn, opts) {
  opts = opts || {};
  const raw = String(rawIn == null ? '' : rawIn).replace(/\s+/g, ' ').trim();
  if (!raw) return _unknown('');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const tz = Number.isFinite(opts.tzMinutes) ? opts.tzMinutes : null;
  const text = raw.replace(/^(sent|received|date)\s*:\s*/i, '');
  let m;

  // 1. ISO / datetime attribute.
  if ((m = RE_ISO_FULL.exec(text))) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (!_validDate(+y, +mo - 1, +d) || +h > 23 || +mi > 59) return _unknown(raw);
    if (z) {
      const ms = Date.parse(text.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
      if (Number.isFinite(ms)) return _out(ms, 'exact', s ? 'second' : 'minute', raw, true);
      return _unknown(raw);
    }
    return _out(_instant(+y, +mo - 1, +d, +h, +mi, +(s || 0), tz), 'exact', s ? 'second' : 'minute', raw, false);
  }
  if ((m = RE_ISO_DATE.exec(text))) {
    const [, y, mo, d] = m;
    if (!_validDate(+y, +mo - 1, +d)) return _unknown(raw);
    return _out(_instant(+y, +mo - 1, +d, 0, 0, 0, tz), 'inferred-date', 'day', raw, false);
  }

  // 2. Full date and time in a header: parsed-header.
  const full = (y, mo, d, h, mi, s, mer) => {
    const hh = _hour24(+h, mer);
    if (hh == null || +mi > 59 || !_validDate(y, mo, +d)) return null;
    return _out(_instant(y, mo, +d, hh, +mi, s ? +s : 0, tz), 'parsed-header', s ? 'second' : 'minute', raw, false);
  };
  if ((m = RE_NUM_DATE_TIME.exec(text))) {
    const r = full(_year(m[4]), +m[2] - 1, m[3], m[5], m[6], m[7], m[8]);   // groups: 1 wd, 2 month, 3 day, 4 year
    return r || _unknown(raw);
  }
  if ((m = RE_TEXT_DATE_TIME.exec(text))) {
    const r = full(+m[4], MONTHS[m[2].slice(0, 3).toLowerCase()], m[3], m[5], m[6], m[7], m[8]);
    return r || _unknown(raw);
  }
  if ((m = RE_TEXT_DATE_TIME_DMY.exec(text))) {
    const r = full(+m[4], MONTHS[m[3].slice(0, 3).toLowerCase()], m[2], m[5], m[6], m[7], m[8]);
    return r || _unknown(raw);
  }

  // 3. Time only: today (or yesterday when it would be in the future).
  if ((m = RE_TIME_ONLY.exec(text))) {
    const hh = _hour24(+m[1], m[4]);
    if (hh == null || +m[2] > 59) return _unknown(raw);
    const f = _fields(now, tz);
    let ms = _instant(f.y, f.mo, f.d, hh, +m[2], m[3] ? +m[3] : 0, tz);
    if (ms > now + FUTURE_SLACK_MS) {
      const y = _fields(now - 86_400_000, tz);
      ms = _instant(y.y, y.mo, y.d, hh, +m[2], m[3] ? +m[3] : 0, tz);
    }
    return _out(ms, 'inferred-today', 'minute', raw, false);
  }

  // 4. Weekday plus time ("Wed 18:09"): most recent past matching weekday (F-27).
  if ((m = RE_WD_TIME.exec(text))) {
    const wd = WEEKDAYS[m[1].slice(0, 3).toLowerCase()];
    const hh = _hour24(+m[2], m[5]);
    if (hh == null || +m[3] > 59) return _unknown(raw);
    for (let back = 0; back < 8; back++) {
      const f = _fields(now - back * 86_400_000, tz);
      if (f.wd !== wd) continue;
      const ms = _instant(f.y, f.mo, f.d, hh, +m[3], m[4] ? +m[4] : 0, tz);
      if (ms <= now + FUTURE_SLACK_MS) return _out(ms, 'inferred-date', 'minute', raw, false);
    }
    return _unknown(raw);
  }

  // 5. Date only ("Mon 10/6", "Oct 9", "10/6"): most recent past date, day precision.
  let wd = null; let mo = null; let day = null; let yr = null;
  if ((m = RE_NUM_DATE.exec(text))) {
    wd = m[1] ? WEEKDAYS[m[1].slice(0, 3).toLowerCase()] : null; mo = +m[2] - 1; day = +m[3]; yr = m[4] ? _year(m[4]) : null;
  } else if ((m = RE_TEXT_DATE.exec(text))) {
    wd = m[1] ? WEEKDAYS[m[1].slice(0, 3).toLowerCase()] : null; mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; day = +m[3]; yr = m[4] ? +m[4] : null;
  } else {
    return _unknown(raw);
  }
  const today = _fields(now, tz);
  const endOfToday = _instant(today.y, today.mo, today.d, 23, 59, 59, tz);
  const tryYear = (y) => {
    if (!_validDate(y, mo, day)) return null;
    const ms = _instant(y, mo, day, 0, 0, 0, tz);
    if (ms > endOfToday) return null;
    if (wd != null && _fields(ms + 12 * 3_600_000, tz).wd !== wd) return null;
    return ms;
  };
  if (yr != null) {
    const ms = tryYear(yr);
    return ms == null ? _unknown(raw) : _out(ms, 'inferred-date', 'day', raw, false);
  }
  for (let y = today.y; y >= today.y - 7; y--) {
    const ms = tryYear(y);
    if (ms != null) return _out(ms, 'inferred-date', 'day', raw, false);
  }
  return _unknown(raw);
}

module.exports = { QUALITY_RANK, rank, isGood, parseReceived };
