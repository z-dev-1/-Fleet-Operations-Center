'use strict';
/**
 * src/zoom/data/client.js — high-level Zoom data operations behind the zoomData:* channels (A1).
 *
 * Policy (design §6.5, §7.4, review F-5):
 *   - status(): cookie GET of recording-info, cached 60 s; emits zoomData:auth-changed only on change.
 *   - lists: 120 s in-memory cache, then replay, then passive capture; single-flight per (path, kind).
 *   - re-warm cap: a capture TRIGGERED BY A REPLAY FAILURE is skipped when another such capture for the
 *     same path|kind ran within REWARM_MIN_INTERVAL_MS; the last result is returned as {source:'cache',
 *     stale:true} (or CAPTURE_TIMEOUT when none). It never returns SIGN_IN_REQUIRED.
 *   - only a capture that lands on sign-in, or a status() cookie GET, may set signedIn:false.
 *
 * In-memory only (never persisted): joinByKey (key -> join URL), transcriptRefs (key -> transcript URL),
 * meetingByKey / recordingByKey item caches. A2 reads these through the exported accessors.
 */
const C = require('../constants');
const { fail } = require('../errors');
const { safeErr } = require('../redact');
const log = require('../../utils/logger')('zoom:data');

const joinByKey = new Map();
const transcriptRefs = new Map();
const meetingByKey = new Map();
const recordingByKey = new Map();

const _lists = new Map();         // pageKind -> { items, at, fetchedAt }
const _flights = new Map();       // path|pageKind -> Promise
const _lastRewarmAt = new Map();  // path|pageKind -> ms of the last capture triggered by a replay failure
let _status = null;               // { signedIn, code, checkedAt, at }
let _lastEmitted;                 // last signedIn value sent to the renderer
let _ctx = null;

function _bind(env) { if (env && env.ctx) _ctx = env.ctx; }
function _now() { return Date.now(); }

function _emitAuth(signedIn, code) {
  if (_lastEmitted === signedIn) return;
  _lastEmitted = signedIn;
  try {
    if (_ctx && typeof _ctx.sendToWindow === 'function') _ctx.sendToWindow('zoomData:auth-changed', { signedIn, code: code || null });
  } catch (e) { log.warn('[zoom] auth-changed', safeErr(e)); }
}

function _setStatus(signedIn, code) {
  const t = _now();
  _status = { signedIn, code: code || null, checkedAt: new Date(t).toISOString(), at: t };
  _emitAuth(signedIn, code);
}

function _statusResult() {
  const r = { ok: true, signedIn: _status.signedIn, checkedAt: _status.checkedAt };
  if (_status.code) r.code = _status.code;
  return r;
}

/** status({force}) -> {ok:true, signedIn:true|false|null, code?, checkedAt} */
async function status(input, env) {
  _bind(env);
  const force = !!(input && input.force);
  if (!force && _status && _now() - _status.at < C.STATUS_CACHE_MS) return _statusResult();
  const session = require('./session');
  await session.ensureSeeded('status');
  const r = await require('./transport').getJson(C.RECORDING_INFO_PATH);
  if (r.ok) _setStatus(true, null);
  else if (r.code === 'SIGN_IN_REQUIRED') _setStatus(false, 'SIGN_IN_REQUIRED');
  else _setStatus(null, r.code);   // NETWORK / TIMEOUT / THROTTLED / HTTP_ERROR / any other code
  return _statusResult();
}

function clearCaches() {
  _lists.clear();
  _lastRewarmAt.clear();
  joinByKey.clear();
  transcriptRefs.clear();
  meetingByKey.clear();
  recordingByKey.clear();
}

/** connect() -> {ok:true, signedIn:true} | {ok:false, code}. Clears caches + captured headers on success. */
async function connect(_input, env) {
  _bind(env);
  const session = require('./session');
  const r = await session.connect(_ctx);
  if (r && r.ok) {
    clearCaches();
    session.clearCaptured();
    _setStatus(true, null);
    return { ok: true, signedIn: true };
  }
  return fail((r && r.code) || 'INTERNAL');
}

function _store(pageKind, mapped) {
  const t = _now();
  const fetchedAt = new Date(t).toISOString();
  const items = Array.isArray(mapped.items) ? mapped.items : [];
  if (pageKind === 'recordings') {
    for (const it of items) recordingByKey.set(it.key, it);
    for (const [k, url] of mapped.refs || []) transcriptRefs.set(k, url);
  } else {
    for (const it of items) meetingByKey.set(it.key, it);
    for (const [k, url] of mapped.joins || []) joinByKey.set(k, url);
  }
  _lists.set(pageKind, { items, at: t, fetchedAt });
  return { items, fetchedAt };
}

function _mapFor(pageKind, envelope) {
  const M = require('./mappers');
  return pageKind === 'recordings' ? M.mapRecordings(envelope) : M.mapMeetings(envelope, pageKind);
}

async function _fetchList(pageKind) {
  const path = C.PAGE_KINDS[pageKind].path;
  const fk = path + '|' + pageKind;
  const transport = require('./transport');
  const rp = await transport.postReplay(path, pageKind);
  if (rp.ok) {
    const m = _mapFor(pageKind, rp.envelope);
    if (m.ok) {
      const s = _store(pageKind, m);
      return { ok: true, items: s.items, source: 'replay', fetchedAt: s.fetchedAt };
    }
    try { log.warn('[zoom] replay map', { op: 'replay', path, pageKind, code: m.code, shape: m.shape }); } catch (_) {}
    return fail(m.code || 'SHAPE_UNRECOGNIZED');
  }
  if (rp.code !== 'NEEDS_CAPTURE') return fail(rp.code, { status: rp.status, errorCode: rp.errorCode });

  // Re-warm cap (review F-5): limits CAPTURES TRIGGERED BY REPLAY FAILURES (a replay rejected now, or
  // replay disabled earlier because it was rejected) to one per REWARM_MIN_INTERVAL_MS per path|kind.
  const replayFailed = rp.why === 'rejected' ||
    (rp.why === 'disabled' && require('./cdp-capture').replayDisabledReason(path, pageKind) === 'rejected');
  if (replayFailed) {
    const last = _lastRewarmAt.get(fk);
    if (typeof last === 'number' && _now() - last < C.REWARM_MIN_INTERVAL_MS) {
      const cached = _lists.get(pageKind);
      try { log.info('[zoom] rewarm capped', { op: 'rewarm-capped', path, pageKind }); } catch (_) {}
      if (cached) return { ok: true, items: cached.items, source: 'cache', stale: true, fetchedAt: cached.fetchedAt };
      return fail('CAPTURE_TIMEOUT');
    }
    _lastRewarmAt.set(fk, _now());
    require('./session').allowReseed();
  }
  const cr = await require('./cdp-capture').captureList(pageKind);
  if (!cr || !cr.ok) {
    const code = (cr && cr.code) || 'CAPTURE_FAILED';
    if (code === 'SIGN_IN_REQUIRED') _setStatus(false, 'SIGN_IN_REQUIRED');
    return fail(code);
  }
  const s = _store(pageKind, cr.mapped);
  return { ok: true, items: s.items, source: 'capture', fetchedAt: s.fetchedAt };
}

function _list(pageKind, refresh) {
  const cached = _lists.get(pageKind);
  if (!refresh && cached && _now() - cached.at < C.LIST_CACHE_MS) {
    return Promise.resolve({ ok: true, items: cached.items, source: 'cache', fetchedAt: cached.fetchedAt });
  }
  const fk = C.PAGE_KINDS[pageKind].path + '|' + pageKind;
  if (_flights.has(fk)) return _flights.get(fk);
  const p = _fetchList(pageKind).finally(() => { _flights.delete(fk); });
  _flights.set(fk, p);
  return p;
}

/** listMeetings({kind, refresh}) -> {ok:true, items, source:'capture'|'replay'|'cache', fetchedAt, stale?} */
async function listMeetings(input, env) {
  _bind(env);
  return _list(input.kind, !!input.refresh);
}

/** listRecordings({refresh}) — same policy with RECORDINGS_URL and pageKind 'recordings'. */
async function listRecordings(input, env) {
  _bind(env);
  return _list('recordings', !!(input && input.refresh));
}

/** getMeeting({key}) -> {ok:true, item} | NOT_FOUND */
async function getMeeting(input, env) {
  _bind(env);
  const item = meetingByKey.get(input.key);
  return item ? { ok: true, item } : fail('NOT_FOUND');
}

function _joinUrlOk(url) {
  const u = C.parseUrl(url);
  return !!(u && u.protocol === 'https:' && C.ZOOM_HOST_RE.test(u.hostname) && /^\/(j|w)\//.test(u.pathname));
}

/** join({key}) — opens the in-memory join URL for that key once. Never a URL from the renderer. */
async function join(input, env) {
  _bind(env);
  const url = joinByKey.get(input.key);
  if (!url || !_joinUrlOk(url)) return fail('NOT_FOUND');
  try {
    await require('./session')._electron().shell.openExternal(url);
  } catch (e) {
    log.warn('[zoom] join', safeErr(e));
    return fail('LAUNCH_FAILED');
  }
  log.info('[zoom] join', { op: 'join', idHash: require('../redact').keyHash(input.key) });
  return { ok: true };
}

/** recordingInfo() -> {ok:true, info} (whitelisted) | {ok:false, code} */
async function recordingInfo(_input, env) {
  _bind(env);
  await require('./session').ensureSeeded('recording-info');
  const r = await require('./transport').getJson(C.RECORDING_INFO_PATH);
  if (!r.ok) return fail(r.code, { status: r.status, errorCode: r.errorCode });
  return { ok: true, info: require('./mappers').mapRecordingInfo(r.result) };
}

/** getItem(key) -> MeetingItem | RecordingItem | null (A2 accessor). */
function getItem(key) { return meetingByKey.get(key) || recordingByKey.get(key) || null; }

function _resetForTests() {
  clearCaches();
  _flights.clear();
  _status = null;
  _lastEmitted = undefined;
  _ctx = null;
}

module.exports = {
  status, connect, listMeetings, listRecordings, getMeeting, join, recordingInfo,
  getItem, clearCaches, joinByKey, transcriptRefs, meetingByKey, recordingByKey, _resetForTests,
  __test__: { dropList: (pageKind) => _lists.delete(pageKind) },
};
