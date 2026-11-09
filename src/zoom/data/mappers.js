'use strict';
/**
 * src/zoom/data/mappers.js — pure, defensive, whitelist-based mapping of portal responses.
 *
 * The real response shapes are unrecorded, so each mapper searches a small fixed set of container
 * paths and reads each field from an ordered candidate list. Anything unrecognised becomes
 * SHAPE_UNRECOGNIZED (with a key-names-only shape); nothing is ever invented.
 *
 * URLs never appear in items: join URLs and transcript URLs are returned separately (as [key, url]
 * pairs) for the client's in-memory maps.
 */
const crypto = require('crypto');
const C = require('../constants');
const { keyHash, shapeOf } = require('../redact');

const CONTAINERS = ['list', 'meetings', 'data', 'items', 'recordings'];

function _isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** findArray(envelope) -> array of objects | null (searches envelope.result.X, then envelope.X). */
function findArray(envelope) {
  const roots = [];
  if (_isObj(envelope) && _isObj(envelope.result)) roots.push(envelope.result);
  if (_isObj(envelope) && Array.isArray(envelope.result)) return envelope.result.filter(_isObj);
  if (_isObj(envelope)) roots.push(envelope);
  for (const r of roots) {
    for (const k of CONTAINERS) {
      const v = r[k];
      if (Array.isArray(v) && v.some(_isObj)) return v.filter(_isObj);
    }
  }
  return null;
}

function pick(obj, names) {
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function _str(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** toIso(v) -> normalised ISO string | null (ISO strings, epoch ms or epoch s). */
function toIso(v) {
  let d = null;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v > 1e12 ? v : v * 1000);
  else if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d{9,14}$/.test(s)) { const n = Number(s); d = new Date(n > 1e12 ? n : n * 1000); } else d = new Date(s);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function _num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function _bool(v) { return typeof v === 'boolean' ? v : null; }

function base64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** keyFromRaw(raw) -> base64url(raw) or 'h_' + sha256(raw).hex.slice(0, 40) when over 128 chars. */
function keyFromRaw(raw) {
  const k = base64url(raw);
  if (k.length <= 128) return k;
  return 'h_' + crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex').slice(0, 40);
}

const MEETING_UUID = ['uuid', 'meetingUuid', 'meeting_uuid'];
const MEETING_ID = ['meetingId', 'meeting_id', 'meetingNumber', 'meeting_number', 'number', 'id'];
const RECORDING_UUID = ['uuid', 'meetingUuid', 'meeting_uuid'];
const RECORDING_ID = ['recordingId', 'recording_id', 'meetingId', 'meeting_id', 'id'];
const START = ['startTime', 'start_time', 'startDate', 'time'];
const DURATION = ['duration', 'durationMinutes'];
const TOPIC = ['topic', 'subject', 'title'];
const TZ = ['timezone', 'timeZone', 'time_zone'];
const RECURRING = ['recurring', 'isRecurring', 'is_recurring'];
const JOIN = ['joinUrl', 'join_url', 'joinLink'];
const NUMBER = ['meetingNumber', 'meeting_number', 'number', 'meetingId', 'meeting_id', 'id'];
const FILES = ['recordingFiles', 'files', 'recording_files'];
const FILE_TYPE = ['fileType', 'file_type', 'type'];
const FILE_NAME = ['fileName', 'file_name', 'name'];
const FILE_EXT = ['fileExtension', 'file_extension', 'extension'];
const FILE_URL = ['downloadUrl', 'download_url', 'fileUrl'];

/**
 * itemKey(prefix, raw, startIso) — occurrence-level key. prefix 'm' (meeting) or 'r' (recording).
 * A Zoom uuid identifies one occurrence and is used alone; otherwise id + ':' + startIso.
 * Returns null when no id candidate exists (the item is dropped).
 */
function itemKey(prefix, raw, startIso) {
  if (!_isObj(raw)) return null;
  const uuid = _str(pick(raw, prefix === 'r' ? RECORDING_UUID : MEETING_UUID), 200);
  const other = _str(pick(raw, prefix === 'r' ? RECORDING_ID : MEETING_ID), 200);
  const idPart = uuid || other;
  if (!idPart) return null;
  const rawKey = prefix + ':' + idPart + (uuid ? '' : ':' + (startIso || ''));
  return keyFromRaw(rawKey);
}

/** buildJoinUrl(raw) -> {url, joinNeedsPasscode} | null. */
function buildJoinUrl(raw) {
  if (!_isObj(raw)) return null;
  for (const n of JOIN) {
    const v = raw[n];
    if (typeof v !== 'string') continue;
    const u = C.parseUrl(v);
    if (u && u.protocol === 'https:' && C.ZOOM_HOST_RE.test(u.hostname) && /^\/(j|w)\//.test(u.pathname)) {
      return { url: u.href, joinNeedsPasscode: false };
    }
  }
  const num = meetingNumber(raw);
  if (num) return { url: C.PORTAL_ORIGIN + '/j/' + num, joinNeedsPasscode: true };
  return null;
}

/** meetingNumber(raw) -> 9..12 digit string | null. */
function meetingNumber(raw) {
  for (const n of NUMBER) {
    const v = raw[n];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).replace(/\s+/g, '');
    if (/^\d{9,12}$/.test(s)) return s;
  }
  return null;
}

function _shapeFail(envelope) {
  return { ok: false, code: 'SHAPE_UNRECOGNIZED', shape: shapeOf(envelope) };
}

/**
 * mapMeetings(envelope, kind) -> {ok:true, items:[MeetingItem], joins:[[key,url]]}
 *                               | {ok:false, code:'SHAPE_UNRECOGNIZED', shape}
 */
function mapMeetings(envelope, kind) {
  const arr = findArray(envelope);
  if (!arr || !arr.length) {
    // An explicitly empty container is a valid empty list.
    if (arr && !arr.length) return { ok: true, items: [], joins: [] };
    return _emptyOrFail(envelope);
  }
  const items = [];
  const joins = [];
  let good = 0;
  for (const raw of arr) {
    const startIso = toIso(pick(raw, START));
    const key = itemKey('m', raw, startIso);
    if (!key) continue;
    if (startIso) good++;
    const j = buildJoinUrl(raw);
    if (j) joins.push([key, j.url]);
    items.push({
      key,
      idHash: keyHash(key),
      topic: _str(pick(raw, TOPIC), 200),
      startIso,
      durationMin: _num(pick(raw, DURATION)),
      timezone: _str(pick(raw, TZ), 64),
      recurring: _bool(pick(raw, RECURRING)),
      hasJoin: !!j,
      joinNeedsPasscode: !!(j && j.joinNeedsPasscode),
      kind: kind === 'previous' ? 'previous' : 'upcoming',
    });
  }
  if (good * 2 < arr.length) return _shapeFail(envelope);
  return { ok: true, items, joins };
}

// A container key present with an empty array counts as an empty list; otherwise the shape is unknown.
function _emptyOrFail(envelope) {
  const roots = [];
  if (_isObj(envelope) && _isObj(envelope.result)) roots.push(envelope.result);
  if (_isObj(envelope)) roots.push(envelope);
  for (const r of roots) for (const k of CONTAINERS) if (Array.isArray(r[k]) && r[k].length === 0) return { ok: true, items: [], joins: [], refs: [] };
  return _shapeFail(envelope);
}

function _isTranscriptFile(f) {
  const t = pick(f, FILE_TYPE);
  if (typeof t === 'string' && /transcript|cc|vtt/i.test(t)) return true;
  const nm = pick(f, FILE_NAME);
  if (typeof nm === 'string' && /\.vtt$/i.test(nm.trim())) return true;
  const ext = pick(f, FILE_EXT);
  if (typeof ext === 'string' && /^\.?vtt$/i.test(ext.trim())) return true;
  return false;
}

/** transcriptUrlOk(url) -> https: and a ZOOM_HOST_RE host (any path). */
function transcriptUrlOk(url) {
  const u = C.parseUrl(url);
  return !!(u && u.protocol === 'https:' && C.ZOOM_HOST_RE.test(u.hostname));
}

/**
 * mapRecordings(envelope) -> {ok:true, items:[RecordingItem], refs:[[key,url]]} | SHAPE_UNRECOGNIZED.
 * hasTranscript: true (valid Zoom URL kept in refs), false (none, or offsite URL), null (no file data).
 */
function mapRecordings(envelope) {
  const arr = findArray(envelope);
  if (!arr || !arr.length) {
    if (arr && !arr.length) return { ok: true, items: [], refs: [] };
    const e = _emptyOrFail(envelope);
    return e.ok ? { ok: true, items: [], refs: [] } : e;
  }
  const items = [];
  const refs = [];
  let good = 0;
  for (const raw of arr) {
    const startIso = toIso(pick(raw, START));
    const key = itemKey('r', raw, startIso);
    if (!key) continue;
    if (startIso) good++;
    const files = pick(raw, FILES);
    let fileCount = null;
    let hasTranscript = null;
    if (Array.isArray(files)) {
      const objs = files.filter(_isObj);
      fileCount = objs.length;
      const tf = objs.filter(_isTranscriptFile);
      if (!tf.length) hasTranscript = false;
      else {
        hasTranscript = false;
        for (const f of tf) {
          const url = pick(f, FILE_URL);
          if (typeof url === 'string' && transcriptUrlOk(url)) { refs.push([key, C.parseUrl(url).href]); hasTranscript = true; break; }
        }
      }
    }
    items.push({
      key,
      idHash: keyHash(key),
      topic: _str(pick(raw, TOPIC), 200),
      startIso,
      durationMin: _num(pick(raw, DURATION)),
      fileCount,
      hasTranscript,
      transcriptRef: null,
    });
  }
  if (good * 2 < arr.length) return _shapeFail(envelope);
  return { ok: true, items, refs };
}

const INFO_BOOLS = ['isShowTranscriptTab', 'enableTranscriptHub', 'enableCloudRecording', 'canPlayDownloadRecording', 'canDeleteMeetingTranscript'];
const INFO_NUMS = ['locRecCount', 'autoDeleteDays'];
const INFO_STRS = ['dateFrom', 'dateTo'];

/** mapRecordingInfo(result) -> whitelisted info object (everything else dropped). */
function mapRecordingInfo(result) {
  const r = _isObj(result) ? result : {};
  const out = {};
  for (const k of INFO_BOOLS) if (typeof r[k] === 'boolean') out[k] = r[k];
  for (const k of INFO_NUMS) if (typeof r[k] === 'number' && Number.isFinite(r[k])) out[k] = r[k];
  for (const k of INFO_STRS) if (typeof r[k] === 'string' && r[k].length <= 10) out[k] = r[k];
  return out;
}

module.exports = {
  findArray, toIso, base64url, keyFromRaw, itemKey, buildJoinUrl, meetingNumber, transcriptUrlOk,
  mapMeetings, mapRecordings, mapRecordingInfo, CONTAINERS,
};
