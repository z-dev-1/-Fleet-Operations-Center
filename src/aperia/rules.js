'use strict';
/**
 * src/aperia/rules.js — pure tire-flag and GPS rules (plan.md "Constants and shapes").
 *
 * Tire flag order (first match wins): SENSOR FAULT, STALE, NO READING, '' (no target), CRITICAL LOW, LOW,
 * HIGH, OK. Pressure 0 is a dead sensor or a missing reading, never CRITICAL LOW. Times render in
 * America/New_York regardless of the process time zone.
 */
const C = require('./constants');

const FLAG_RANK = Object.freeze({
  'CRITICAL LOW': 7, 'LOW': 6, 'HIGH': 5, 'SENSOR FAULT': 4, 'STALE': 3, 'NO READING': 2, '': 1, 'OK': 0,
});

const _ET = new Intl.DateTimeFormat('en-US', {
  timeZone: C.TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

/** _num(v) -> finite number | NaN (null, '' and non-numeric values are NaN). */
function _num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function _ms(v) {
  if (v == null || v === '') return NaN;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : NaN;
}
function _round1(n) { return Math.round(n * 10) / 10; }
function _str(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).slice(0, max || 200);
}

/** fmtEt(iso) -> 'M/D/YYYY, h:mm AM EST' in America/New_York | '' for an invalid / absent time. */
function fmtEt(iso) {
  const ms = _ms(iso);
  if (!Number.isFinite(ms)) return '';
  return _ET.format(new Date(ms)).replace(/[\u202f\u00a0]/g, ' ');
}

/** tireFlag(sensor, now) -> 'SENSOR FAULT'|'STALE'|'NO READING'|''|'CRITICAL LOW'|'LOW'|'HIGH'|'OK'. */
function tireFlag(sensor, now) {
  const s = sensor && typeof sensor === 'object' ? sensor : {};
  const t = Number.isFinite(now) ? now : Date.now();
  if (s.faulted === true) return 'SENSOR FAULT';
  const at = _ms(s.updatedAt);
  if (Number.isFinite(at) && t - at > C.STALE_MS) return 'STALE';
  const p = _num(s.pressure);
  if (!Number.isFinite(p) || p <= 0) return 'NO READING';
  const sp = _num(s.setPoint);
  if (!Number.isFinite(sp) || sp <= 0) return '';
  const ratio = p / sp;
  if (ratio < C.CRITICAL_RATIO) return 'CRITICAL LOW';
  if (ratio < C.LOW_RATIO) return 'LOW';
  if (ratio > C.HIGH_RATIO) return 'HIGH';
  return 'OK';
}

/** _issueOf(raw) -> whitelisted embedded issue | null. */
function _issueOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const createdAt = _str(raw.createdAt, 40);
  return {
    id: _str(raw.id, 64),
    severity: _str(raw.severity, 20),
    type: _str(raw.type, 60),
    resolveBy: _str(raw.resolveBy, 40),
    actions: (Array.isArray(raw.actions) ? raw.actions : []).filter((a) => typeof a === 'string').slice(0, 5).map((a) => a.slice(0, 300)),
    createdAt,
    createdEt: fmtEt(createdAt),
  };
}

/** tireRow(sensor, now) -> whitelisted tire row (see plan.md item 2). */
function tireRow(sensor, now) {
  const s = sensor && typeof sensor === 'object' ? sensor : {};
  const p = _num(s.pressure);
  const sp = _num(s.setPoint);
  const temp = _num(s.temperature);
  const both = Number.isFinite(p) && p > 0 && Number.isFinite(sp) && sp > 0;
  const updatedAt = _str(s.updatedAt, 40);
  return {
    position: _str(s.position, 20),
    shortPosition: _str(s.shortPosition, 20),
    positionName: _str(s.positionName, 60),
    pressure: Number.isFinite(p) ? p : null,
    setPoint: Number.isFinite(sp) ? sp : null,
    deltaPsi: both ? _round1(p - sp) : null,
    pct: both ? _round1(100 * p / sp) : null,
    temperatureF: Number.isFinite(temp) ? _round1(temp) : null,
    updatedAt,
    readAtEt: fmtEt(updatedAt),
    faulted: s.faulted === true,
    flag: tireFlag(s, now),
    issue: _issueOf(s.issue),
  };
}

/** isPlaceholderGps(lat, lng) -> true within GPS_EPS of the portal's [-11.11111, 11.11111] placeholder. */
function isPlaceholderGps(lat, lng) {
  return Math.abs(lat - C.PLACEHOLDER_GPS.lat) <= C.GPS_EPS && Math.abs(lng - C.PLACEHOLDER_GPS.lng) <= C.GPS_EPS;
}

/** outsideUs(lat, lng) -> true when the point is outside the lower-48 box. */
function outsideUs(lat, lng) {
  const b = C.US_BOX;
  return !(lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax);
}

/** gpsReason(tag) -> 'MISSING' | 'PLACEHOLDER' | 'OK'. */
function gpsReason(tag) {
  if (!tag || typeof tag !== 'object') return 'MISSING';
  const lat = _num(tag.latitude);
  const lng = _num(tag.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'MISSING';
  if (isPlaceholderGps(lat, lng)) return 'PLACEHOLDER';
  return 'OK';
}

function _mapImageUrl(v) {
  const u = C.parseUrl(typeof v === 'string' ? v : '');
  if (!u || u.protocol !== 'https:') return '';
  const h = u.hostname.toLowerCase();
  const ok = h === 'google.com' || h.endsWith('.google.com') || h === 'googleapis.com' || h.endsWith('.googleapis.com');
  return ok ? u.href : '';
}

/** gpsOf(tag) -> { lat, lng, altitude, at, atEt, outsideUs, mapImageUrl, mapsUrl } | null. */
function gpsOf(tag) {
  if (gpsReason(tag) !== 'OK') return null;
  const lat = _num(tag.latitude);
  const lng = _num(tag.longitude);
  const alt = _num(tag.altitude);
  const at = _str(tag.createdAt, 40);
  return {
    lat,
    lng,
    altitude: Number.isFinite(alt) ? alt : null,
    at,
    atEt: fmtEt(at),
    outsideUs: outsideUs(lat, lng),
    mapImageUrl: _mapImageUrl(tag.locationPictureUrl),
    mapsUrl: 'https://www.google.com/maps?q=' + lat + ',' + lng,
  };
}

module.exports = { tireFlag, tireRow, gpsOf, gpsReason, isPlaceholderGps, outsideUs, fmtEt, FLAG_RANK, _issueOf };
