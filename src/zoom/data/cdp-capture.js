'use strict';
/**
 * src/zoom/data/cdp-capture.js — passive capture of the portal SPA's own list requests over CDP.
 *
 * Fleet loads the portal page in its hidden window and records the SPA's request + response. Header
 * values (zoom-csrftoken, x-zm-csrf, authorization) and replay templates live in memory only: nothing
 * from a capture is written to disk or to logs. describe() exposes names / booleans / secondsLeft only.
 */
const C = require('../constants');
const { safeErr } = require('../redact');
const { safeJson } = require('../safe-json');
const log = require('../../utils/logger')('zoom:data');

const KEEP_HEADERS = ['zoom-csrftoken', 'x-zm-csrf', 'authorization'];
const CAPTURE_PATHS = new Set([].concat(C.ALLOWED_POST, C.ALLOWED_GET));
const POST_PATHS = new Set(C.ALLOWED_POST);

// Replay disabled for the process: key = path (attribution guard) or path|pageKind (rejected replay).
const _replayDisabled = new Map();
function disableReplay(key, reason) { _replayDisabled.set(String(key), reason || 'disabled'); }
function isReplayDisabled(path, pageKind) {
  return _replayDisabled.has(String(path)) || _replayDisabled.has(String(path) + '|' + String(pageKind));
}
function replayDisabledReason(path, pageKind) {
  return _replayDisabled.get(String(path)) || _replayDisabled.get(String(path) + '|' + String(pageKind)) || null;
}

function _lowerHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const k of Object.keys(h)) out[String(k).toLowerCase()] = h[k];
  return out;
}

/** _jwtExpAt(authorization) -> exp (epoch seconds) | null. Only the exp claim is read. */
function _jwtExpAt(value) {
  try {
    const m = /^\s*bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)\s*$/i.exec(String(value || ''));
    if (!m) return null;
    const json = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const j = safeJson(json);
    if (!j.ok || !j.value || typeof j.value.exp !== 'number') return null;
    return j.value.exp;
  } catch (_) {
    return null;
  }
}

/**
 * createCapture(webContents) -> {attach, detach, headersFor, secondsLeft, waitFor, count, collected,
 *   resetCollection, template, setTemplate, setPageKind, sawChallenge, clear, describe}
 */
function createCapture(webContents) {
  const dbg = webContents && webContents.debugger;
  const headers = new Map();      // path -> { values: {name: value}, expAt }
  const templates = new Map();    // path|pageKind -> { body, contentType }
  const reqs = new Map();         // requestId -> { path, pageKind, template, pending }
  const collections = new Map();  // path|pageKind -> [{ value } | { code }]
  const waiters = new Set();      // { key, since, resolve, timer }
  let pageKind = null;
  let challenge = false;
  let listening = false;

  const k2 = (path, pk) => String(path) + '|' + String(pk);

  function _notify() {
    for (const w of Array.from(waiters)) {
      try {
        if ((collections.get(w.key) || []).length > w.since) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(true);
        }
      } catch (e) { log.warn('[zoom] cdp waiter', safeErr(e)); }
    }
  }

  function _push(entry, item) {
    const key = k2(entry.path, entry.pageKind);
    if (!collections.has(key)) collections.set(key, []);
    collections.get(key).push(item);
    _notify();
  }

  function _onRequest(params) {
    const rq = params && params.request;
    if (!rq) return;
    const u = C.parseUrl(rq.url);
    if (!u) return;
    if (C.CHALLENGE_PATH_RE.test(u.pathname)) challenge = true;
    if (!C.ZOOM_HOST_RE.test(u.hostname) || !CAPTURE_PATHS.has(u.pathname)) return;
    const path = u.pathname;
    const h = _lowerHeaders(rq.headers);
    const rec = headers.get(path) || { values: {}, expAt: null };
    for (const name of KEEP_HEADERS) {
      if (typeof h[name] === 'string' && h[name]) {
        rec.values[name] = h[name];
        if (name === 'authorization') rec.expAt = _jwtExpAt(h[name]);
      }
    }
    headers.set(path, rec);
    if (!POST_PATHS.has(path) || String(rq.method || '').toUpperCase() !== 'POST') return;
    const contentType = typeof h['content-type'] === 'string' ? h['content-type'] : 'application/json';
    const entry = { path, pageKind, template: null, pending: null };
    if (typeof rq.postData === 'string' && rq.postData) {
      entry.template = { body: rq.postData, contentType };
    } else if (rq.hasPostData === true) {
      // The inline body was omitted: ask for it. Failure -> no template (the response is still data).
      entry.pending = Promise.resolve()
        .then(() => dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId }))
        .then((r) => { entry.template = r && typeof r.postData === 'string' && r.postData ? { body: r.postData, contentType } : null; })
        .catch((e) => { entry.template = null; log.warn('[zoom] cdp post-data', safeErr(e)); });
    }
    reqs.set(params.requestId, entry);
  }

  async function _onFinished(params) {
    const entry = reqs.get(params && params.requestId);
    if (!entry) return;
    reqs.delete(params.requestId);
    try {
      if (typeof params.encodedDataLength === 'number' && params.encodedDataLength > C.CAPTURE_BODY_MAX_BYTES) {
        _push(entry, { code: 'RESPONSE_TOO_LARGE' });
        return;
      }
      const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      let text = r && typeof r.body === 'string' ? r.body : '';
      if (r && r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
      if (Buffer.byteLength(text, 'utf8') > C.CAPTURE_BODY_MAX_BYTES) { _push(entry, { code: 'RESPONSE_TOO_LARGE' }); return; }
      const j = safeJson(text);
      if (entry.pending) { try { await entry.pending; } catch (_) {} }
      if (!j.ok) { _push(entry, { code: 'SHAPE_UNRECOGNIZED' }); return; }
      _push(entry, { value: j.value, template: entry.template });
    } catch (e) {
      log.warn('[zoom] cdp body', safeErr(e));
      _push(entry, { code: 'CAPTURE_FAILED' });
    }
  }

  function onMessage(_e, method, params) {
    try {
      if (method === 'Network.requestWillBeSent') _onRequest(params);
      else if (method === 'Network.loadingFinished') {
        _onFinished(params).catch((e) => { try { log.warn('[zoom] cdp', safeErr(e)); } catch (_) {} });
      } else if (method === 'Network.loadingFailed') {
        const entry = reqs.get(params && params.requestId);
        if (entry) { reqs.delete(params.requestId); _push(entry, { code: 'CAPTURE_FAILED' }); }
      }
    } catch (e) {
      try { log.warn('[zoom] cdp', safeErr(e)); } catch (_) {}
    }
  }

  return {
    /** attach() — debugger.attach('1.3') + Network.enable. Throws when attach fails (caller -> CAPTURE_FAILED). */
    attach() {
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (!listening) { dbg.on('message', onMessage); listening = true; }
      Promise.resolve()
        .then(() => dbg.sendCommand('Network.enable', { maxPostDataSize: 65536 }))
        .catch((e) => { try { log.warn('[zoom] cdp enable', safeErr(e)); } catch (_) {} });
    },
    detach() {
      try { if (listening) dbg.removeListener('message', onMessage); } catch (e) { log.warn('[zoom] cdp detach', safeErr(e)); }
      listening = false;
      try { if (dbg.isAttached()) dbg.detach(); } catch (e) { log.warn('[zoom] cdp detach', safeErr(e)); }
      this.clear();
    },
    setPageKind(k) { pageKind = k; },
    sawChallenge() { return challenge; },
    /** headersFor(path) -> copy of the captured header values for that exact path. */
    headersFor(path) {
      const rec = headers.get(path);
      return rec ? Object.assign({}, rec.values) : {};
    },
    /** secondsLeft(path) -> seconds until the captured bearer for that path expires | null. */
    secondsLeft(path) {
      const rec = headers.get(path);
      if (!rec || typeof rec.expAt !== 'number') return null;
      return Math.round(rec.expAt - Date.now() / 1000);
    },
    count(path, pk) { return (collections.get(k2(path, pk === undefined ? pageKind : pk)) || []).length; },
    collected(path, pk) { return (collections.get(k2(path, pk === undefined ? pageKind : pk)) || []).slice(); },
    resetCollection(path, pk) { collections.set(k2(path, pk), []); challenge = false; },
    /** waitFor(method, path, ms, since=0) -> true once more than `since` responses are collected. */
    waitFor(method, path, ms, since) {
      const key = k2(path, pageKind);
      const n = since || 0;
      if ((collections.get(key) || []).length > n) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { key, since: n, resolve, timer: null };
        w.timer = setTimeout(() => {
          try { waiters.delete(w); resolve(false); } catch (e) { log.warn('[zoom] cdp wait', safeErr(e)); }
        }, Math.max(0, ms | 0));
        waiters.add(w);
      });
    },
    template(path, pk) { return isReplayDisabled(path, pk) ? null : (templates.get(k2(path, pk)) || null); },
    rawTemplate(path, pk) { return templates.get(k2(path, pk)) || null; },
    setTemplate(path, pk, t) {
      if (t && typeof t.body === 'string') templates.set(k2(path, pk), { body: t.body, contentType: t.contentType || 'application/json' });
      else templates.delete(k2(path, pk));
    },
    dropTemplate(path, pk) { templates.delete(k2(path, pk)); },
    /** clear() — null every captured value (headers, templates, collections, pending waits). */
    clear() {
      for (const rec of headers.values()) { for (const k of Object.keys(rec.values)) rec.values[k] = null; rec.expAt = null; }
      headers.clear();
      for (const t of templates.values()) { t.body = null; }
      templates.clear();
      reqs.clear();
      collections.clear();
      for (const w of Array.from(waiters)) { clearTimeout(w.timer); waiters.delete(w); try { w.resolve(false); } catch (_) {} }
      challenge = false;
    },
    /** describe() -> header NAMES, hasTemplate booleans and secondsLeft only (diagnostics). */
    describe() {
      const headerNames = {};
      const secondsLeft = {};
      for (const [p, rec] of headers.entries()) {
        headerNames[p] = Object.keys(rec.values).filter((k) => rec.values[k]).sort();
        secondsLeft[p] = typeof rec.expAt === 'number' ? Math.round(rec.expAt - Date.now() / 1000) : null;
      }
      const hasTemplate = {};
      for (const k of templates.keys()) {
        const i = k.lastIndexOf('|');
        hasTemplate[k] = !isReplayDisabled(k.slice(0, i), k.slice(i + 1));
      }
      return { headerNames, hasTemplate, secondsLeft, pageKind };
    },
  };
}

/**
 * captureList(pageKind) — inside the hidden window: about:blank, then the page (a hash-only change would
 * not reload the SPA), wait for auth, collect matching responses until quiet, pick the response whose
 * mapping has the most items, and keep its request as the replay template for path|pageKind.
 * Fleet issues no request itself here: the SPA's own responses are the data.
 * -> {ok:true, mapped, source:'capture'} | {ok:false, code, shape?}
 */
async function captureList(pageKind) {
  const pk = C.PAGE_KINDS[pageKind];
  if (!pk) return { ok: false, code: 'INVALID_INPUT', field: 'kind' };
  const session = require('./session');
  const M = require('./mappers');
  await session.ensureSeeded('capture');
  return session.withHiddenWindow(async (h) => {
    const cap = h.capture;
    const path = pk.path;
    cap.setPageKind(pageKind);
    cap.resetCollection(path, pageKind);
    await session.load(h.win, 'about:blank');
    const lr = await session.load(h.win, pk.url);
    if (h.crashed) return { ok: false, code: 'CAPTURE_FAILED' };
    if (lr && lr.code) return { ok: false, code: lr.code };
    const a = await session.waitForAuthed(h.win, C.AUTH_WAIT_MS);
    if (h.crashed) return { ok: false, code: 'CAPTURE_FAILED' };
    if (!a.ok) {
      log.info('[zoom] capture', { op: 'capture', pageKind, code: 'SIGN_IN_REQUIRED', lastHostKind: a.lastHostKind });
      return { ok: false, code: 'SIGN_IN_REQUIRED' };
    }
    const started = Date.now();
    const first = await cap.waitFor('POST', path, C.CAPTURE_WAIT_MS, 0);
    if (!first) {
      const code = cap.sawChallenge() ? 'SSO_WALL' : 'CAPTURE_TIMEOUT';
      log.warn('[zoom] capture', { op: 'capture', pageKind, code });
      return { ok: false, code };
    }
    let n = cap.count(path, pageKind);
    for (;;) {
      const left = C.CAPTURE_WAIT_MS - (Date.now() - started);
      if (left <= 0) break;
      const more = await cap.waitFor('POST', path, Math.min(C.CAPTURE_QUIET_MS, left), n);
      if (!more) break;
      n = cap.count(path, pageKind);
    }
    if (h.crashed) return { ok: false, code: 'CAPTURE_FAILED' };
    const mapFn = pageKind === 'recordings' ? (v) => M.mapRecordings(v) : (v) => M.mapMeetings(v, pageKind);
    let best = null;
    let firstErr = null;
    for (const entry of cap.collected(path, pageKind)) {
      if (entry.code) { if (!firstErr) firstErr = { ok: false, code: entry.code }; continue; }
      const m = mapFn(entry.value);
      if (!m.ok) { if (!firstErr) firstErr = m; continue; }
      if (!best || m.items.length > best.m.items.length) best = { m, entry };
    }
    if (!best) {
      const r = firstErr || { ok: false, code: 'SHAPE_UNRECOGNIZED' };
      log.warn('[zoom] capture', { op: 'capture', pageKind, code: r.code, shape: r.shape });
      return r;
    }
    cap.setTemplate(path, pageKind, best.entry.template || null);
    // Attribution guard: identical upcoming/previous bodies mean the body does not encode the list kind.
    if (path === C.MEETING_LIST_PATH && !isReplayDisabled(path, pageKind)) {
      const up = cap.rawTemplate(path, 'upcoming');
      const pr = cap.rawTemplate(path, 'previous');
      if (up && pr && up.body === pr.body) {
        disableReplay(path, 'attribution');
        log.info('[zoom] replay', { op: 'replay-disabled', path });
      }
    }
    log.info('[zoom] capture', { op: 'capture', pageKind, code: 'OK', count: best.m.items.length });
    return { ok: true, mapped: best.m, source: 'capture' };
  });
}

function _resetForTests() { _replayDisabled.clear(); }

module.exports = {
  createCapture, captureList, disableReplay, isReplayDisabled, replayDisabledReason, KEEP_HEADERS, _jwtExpAt, _resetForTests,
};
