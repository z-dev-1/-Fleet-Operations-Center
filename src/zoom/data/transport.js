'use strict';
/**
 * src/zoom/data/transport.js — windowless portal requests over electron.net on the Zoom partition.
 *
 *   getJson(path)              cookie GET, ALLOWED_GET only (checked before any request)
 *   postReplay(path, pageKind) replays a captured SPA list request byte-for-byte, ALLOWED_POST only
 *
 * Writes are impossible: ALLOWED_POST holds only the two list paths. Redirect URLs, header values and
 * bodies are never stored or logged; one warn line per failure: {op, path, code, status, ms}.
 */
const C = require('../constants');
const { ZoomError } = require('../errors');
const { safeErr } = require('../redact');
const { safeJson } = require('../safe-json');
const log = require('../../utils/logger')('zoom:data');

const SIGNIN_MSG_RE = /log\s?in|sign\s?in|session|expired|unauthor/i;
const ACCEPT_JSON = 'application/json, text/plain, */*';

/**
 * _send({method, url, headers, body, maxBytes}) -> raw {status?, text?, redirect?:{toLogin}, code?, ms}
 * Never throws; every callback body is contained.
 */
function _send({ method, url, headers, body, maxBytes }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let timer = null;
    let req = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      r.ms = Date.now() - t0;
      resolve(r);
    };
    const abort = () => { try { if (req) req.abort(); } catch (_) {} };
    try {
      const session = require('./session');
      const { net } = session._electron();
      req = net.request({
        method, url, session: session.getSession(), useSessionCookies: true, credentials: 'include', redirect: 'manual',
      });
      for (const k of Object.keys(headers || {})) {
        if (headers[k] != null) req.setHeader(k, headers[k]);
      }
      req.on('redirect', (statusCode, _method, redirectUrl) => {
        try {
          // Classify only; the redirect URL is dropped, never stored or logged.
          const u = C.parseUrl(redirectUrl);
          const toLogin = !!u && (C.AUTH_HOST_RE.test(u.hostname) || C.SIGNIN_PATH_RE.test(u.pathname));
          abort();
          finish({ status: typeof statusCode === 'number' ? statusCode : 302, redirect: { toLogin } });
        } catch (e) {
          try { log.warn('[zoom] redirect', safeErr(e)); } catch (_) {}
          abort();
          finish({ code: 'NETWORK' });
        }
      });
      req.on('response', (res) => {
        try {
          const status = res.statusCode;
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            try {
              if (done) return;
              const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              size += b.length;
              if (size > maxBytes) { abort(); finish({ status, code: 'RESPONSE_TOO_LARGE' }); return; }
              chunks.push(b);
            } catch (e) { try { log.warn('[zoom] data', safeErr(e)); } catch (_) {} finish({ code: 'NETWORK' }); }
          });
          res.on('end', () => {
            try { finish({ status, text: Buffer.concat(chunks).toString('utf8') }); } catch (e) { try { log.warn('[zoom] end', safeErr(e)); } catch (_) {} finish({ code: 'NETWORK' }); }
          });
          res.on('error', (e) => { try { log.warn('[zoom] response', safeErr(e)); } catch (_) {} finish({ code: 'NETWORK' }); });
        } catch (e) {
          try { log.warn('[zoom] response', safeErr(e)); } catch (_) {}
          finish({ code: 'NETWORK' });
        }
      });
      req.on('error', (e) => { try { if (!done) log.warn('[zoom] net', safeErr(e)); } catch (_) {} finish({ code: 'NETWORK' }); });
      timer = setTimeout(() => { try { abort(); finish({ code: 'TIMEOUT' }); } catch (_) {} }, C.NET_TIMEOUT_MS);
      if (body != null) req.write(body);
      req.end();
    } catch (e) {
      try { log.warn('[zoom] net', safeErr(e)); } catch (_) {}
      finish({ code: 'NETWORK' });
    }
  });
}

/**
 * classify(raw) -> {ok:true, result, envelope} | {ok:false, code, status?, errorCode?}  (design §7.1 table)
 */
function classify(raw) {
  if (!raw) return { ok: false, code: 'NETWORK' };
  if (raw.code) return raw.status ? { ok: false, code: raw.code, status: raw.status } : { ok: false, code: raw.code };
  if (raw.redirect) return raw.redirect.toLogin ? { ok: false, code: 'SIGN_IN_REQUIRED', status: raw.status } : { ok: false, code: 'HTTP_ERROR', status: raw.status };
  const s = raw.status;
  if (s === 401 || s === 403) return { ok: false, code: 'SIGN_IN_REQUIRED', status: s };
  if (s === 429) return { ok: false, code: 'THROTTLED', status: s };
  if (typeof s !== 'number' || s < 200 || s >= 300) return { ok: false, code: 'HTTP_ERROR', status: typeof s === 'number' ? s : 0 };
  const j = safeJson(raw.text);
  if (!j.ok || !j.value || typeof j.value !== 'object' || Array.isArray(j.value)) return { ok: false, code: 'SHAPE_UNRECOGNIZED', status: s };
  const env = j.value;
  if (env.status === true) return { ok: true, result: env.result, envelope: env };
  const msg = typeof env.errorMessage === 'string' ? env.errorMessage : '';
  const ec = env.errorCode;
  if (SIGNIN_MSG_RE.test(msg) || C.AUTH_ERROR_CODES.has(ec)) return { ok: false, code: 'SIGN_IN_REQUIRED', status: s };
  const out = { ok: false, code: 'ZOOM_ERROR', status: s };
  if (typeof ec === 'number' && Number.isFinite(ec)) out.errorCode = ec;
  else if (typeof ec === 'string' && /^[A-Za-z0-9_.-]{1,20}$/.test(ec)) out.errorCode = ec;
  return out;
}

function _logFail(op, path, r, ms, extra) {
  try { log.warn('[zoom] ' + op, Object.assign({ op, path, code: r.code, status: r.status || 0, ms }, extra || {})); } catch (_) {}
}

/** getJson(path) — cookie GET. Rejects with INVALID_INPUT when path is not in ALLOWED_GET (before any request). */
async function getJson(path) {
  if (!C.ALLOWED_GET.includes(path)) throw new ZoomError('INVALID_INPUT', { field: 'path' });
  const raw = await _send({ method: 'GET', url: C.PORTAL_ORIGIN + path, headers: { Accept: ACCEPT_JSON }, maxBytes: C.GET_MAX_BYTES });
  const r = classify(raw);
  if (!r.ok) _logFail('get', path, r, raw.ms);
  return r;
}

/**
 * postReplay(path, pageKind) -> {ok:true, result, envelope} | {ok:false, code, why?}
 * NEEDS_CAPTURE (with internal `why`) when replay is disabled, no template / csrf is captured, the
 * captured bearer is about to expire, or the portal rejects the replay (401/403/SIGN_IN_REQUIRED).
 * A rejected replay never sets signed-in state: it disables replay for path|pageKind for the process.
 */
async function postReplay(path, pageKind) {
  if (!C.ALLOWED_POST.includes(path)) throw new ZoomError('INVALID_INPUT', { field: 'path' });
  const pk = C.PAGE_KINDS[pageKind];
  if (!pk || pk.path !== path) throw new ZoomError('INVALID_INPUT', { field: 'kind' });
  const cdp = require('./cdp-capture');
  if (cdp.isReplayDisabled(path, pageKind)) return { ok: false, code: 'NEEDS_CAPTURE', why: 'disabled' };
  const cap = require('./session').getCapture();
  if (!cap) return { ok: false, code: 'NEEDS_CAPTURE', why: 'no-template' };
  const tpl = cap.template(path, pageKind);
  const h = cap.headersFor(path);
  if (!tpl || typeof tpl.body !== 'string' || !h['zoom-csrftoken']) return { ok: false, code: 'NEEDS_CAPTURE', why: 'no-template' };
  const left = cap.secondsLeft(path);
  if (h.authorization && typeof left === 'number' && left < 60) return { ok: false, code: 'NEEDS_CAPTURE', why: 'expiring' };
  const headers = {
    'Content-Type': tpl.contentType || 'application/json',
    Accept: ACCEPT_JSON,
    Origin: C.PORTAL_ORIGIN,
    Referer: pk.url,
    'zoom-csrftoken': h['zoom-csrftoken'],
  };
  if (h['x-zm-csrf']) headers['x-zm-csrf'] = h['x-zm-csrf'];
  // Bearer only when one was captured for this exact path (findings §1c: only /nws/recording/*).
  if (h.authorization) headers.authorization = h.authorization;
  const raw = await _send({ method: 'POST', url: C.PORTAL_ORIGIN + path, headers, body: tpl.body, maxBytes: C.CAPTURE_BODY_MAX_BYTES });
  for (const k of Object.keys(headers)) headers[k] = null;
  for (const k of Object.keys(h)) h[k] = null;
  const r = classify(raw);
  if (!r.ok && (r.code === 'SIGN_IN_REQUIRED' || raw.status === 401 || raw.status === 403)) {
    cdp.disableReplay(path + '|' + pageKind, 'rejected');
    try { cap.dropTemplate(path, pageKind); } catch (_) {}
    try { log.info('[zoom] replay', { op: 'replay-disabled', path, pageKind, reason: 'rejected' }); } catch (_) {}
    return { ok: false, code: 'NEEDS_CAPTURE', why: 'rejected' };
  }
  if (!r.ok) _logFail('replay', path, r, raw.ms, { pageKind });
  return r;
}

// ── Transcript file GET (design §7.1a; the single ALLOWED_GET exception, A2) ──
const ACCEPT_TRANSCRIPT = 'text/vtt, text/plain, */*';
const MAX_TRANSCRIPT_HOPS = 3;

/** _zoomHttps(url) -> true only for https: URLs whose hostname matches ZOOM_HOST_RE. */
function _zoomHttps(url) {
  const u = C.parseUrl(url);
  return !!(u && u.protocol === 'https:' && C.ZOOM_HOST_RE.test(u.hostname));
}

function _isSignInUrl(url) {
  const u = C.parseUrl(url);
  return !!u && (C.AUTH_HOST_RE.test(u.hostname) || C.SIGNIN_PATH_RE.test(u.pathname));
}

function _contentType(headers) {
  if (!headers || typeof headers !== 'object') return '';
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() !== 'content-type') continue;
    const v = headers[k];
    return String(Array.isArray(v) ? v[0] : v || '').toLowerCase().trim();
  }
  return '';
}

/**
 * _getTranscriptRaw(url) -> {ok:true, text, status, bytes} | {ok:false, code, reason?, status?, bytes?}
 * GET with redirect:'manual'; each redirect must pass the same https + ZOOM_HOST_RE rule (max 3 hops).
 * Never throws; the URL, redirect targets and body never reach a log line.
 */
function _getTranscriptRaw(url) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let req = null;
    let hops = 0;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const abort = () => { try { if (req) req.abort(); } catch (_) {} };
    try {
      const session = require('./session');
      const { net } = session._electron();
      req = net.request({
        method: 'GET', url, session: session.getSession(), useSessionCookies: true, credentials: 'include', redirect: 'manual',
      });
      req.setHeader('Accept', ACCEPT_TRANSCRIPT);
      req.on('redirect', (_statusCode, _method, redirectUrl) => {
        try {
          if (_isSignInUrl(redirectUrl)) { abort(); finish({ ok: false, code: 'SIGN_IN_REQUIRED' }); return; }
          if (!_zoomHttps(redirectUrl)) { abort(); finish({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'offsite-redirect' }); return; }
          hops += 1;
          if (hops > MAX_TRANSCRIPT_HOPS) { abort(); finish({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'too-many-redirects' }); return; }
          req.followRedirect();
        } catch (e) {
          try { log.warn('[zoom] transcript redirect', safeErr(e)); } catch (_) {}
          abort();
          finish({ ok: false, code: 'NETWORK' });
        }
      });
      req.on('response', (res) => {
        try {
          const status = res.statusCode;
          const ctype = _contentType(res.headers);
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            try {
              if (done) return;
              const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              size += b.length;
              if (size > C.TRANSCRIPT_MAX_BYTES) { abort(); finish({ ok: false, code: 'RESPONSE_TOO_LARGE', status, bytes: size }); return; }
              chunks.push(b);
            } catch (e) { try { log.warn('[zoom] transcript data', safeErr(e)); } catch (_) {} finish({ ok: false, code: 'NETWORK' }); }
          });
          res.on('end', () => {
            try {
              if (status === 401 || status === 403) { finish({ ok: false, code: 'SIGN_IN_REQUIRED', status, bytes: size }); return; }
              if (status === 429) { finish({ ok: false, code: 'THROTTLED', status, bytes: size }); return; }
              if (typeof status !== 'number' || status < 200 || status >= 300) {
                finish({ ok: false, code: 'HTTP_ERROR', status: typeof status === 'number' ? status : 0, bytes: size });
                return;
              }
              const text = Buffer.concat(chunks).toString('utf8');
              const typed = ctype.startsWith('text/vtt') || ctype.startsWith('text/plain');
              if (!typed && !text.replace(/^\uFEFF/, '').startsWith('WEBVTT')) {
                finish({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-transcript', status, bytes: size });
                return;
              }
              finish({ ok: true, text, status, bytes: size });
            } catch (e) { try { log.warn('[zoom] transcript end', safeErr(e)); } catch (_) {} finish({ ok: false, code: 'NETWORK' }); }
          });
          res.on('error', (e) => { try { log.warn('[zoom] transcript response', safeErr(e)); } catch (_) {} finish({ ok: false, code: 'NETWORK' }); });
        } catch (e) {
          try { log.warn('[zoom] transcript response', safeErr(e)); } catch (_) {}
          finish({ ok: false, code: 'NETWORK' });
        }
      });
      req.on('error', (e) => { try { if (!done) log.warn('[zoom] transcript net', safeErr(e)); } catch (_) {} finish({ ok: false, code: 'NETWORK' }); });
      timer = setTimeout(() => { try { abort(); finish({ ok: false, code: 'TIMEOUT' }); } catch (_) {} }, C.NET_TIMEOUT_MS);
      req.end();
    } catch (e) {
      try { log.warn('[zoom] transcript net', safeErr(e)); } catch (_) {}
      finish({ ok: false, code: 'NETWORK' });
    }
  });
}

/**
 * getTranscriptFile(key) -> {ok:true, text, bytes} | {ok:false, code, reason?, status?}
 * The URL comes ONLY from the client's in-memory transcriptRefs (filled from a Zoom listing); the
 * renderer never supplies one. It is rechecked (https + ZOOM_HOST_RE) before any request.
 * Log line: {op:'transcript-get', idHash, code, status, bytes, ms} only.
 */
async function getTranscriptFile(key) {
  const t0 = Date.now();
  const idHash = require('../redact').keyHash(key);
  const done = (r) => {
    const line = { op: 'transcript-get', idHash, code: r.ok ? 'OK' : r.code, status: r.status || 0, bytes: r.bytes || 0, ms: Date.now() - t0 };
    try { if (r.ok) log.info('[zoom] transcript', line); else log.warn('[zoom] transcript', line); } catch (_) {}
    return r;
  };
  const url = require('./client').transcriptRefs.get(key);
  if (typeof url !== 'string' || !url) return done({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-listed' });
  if (!_zoomHttps(url)) return done({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'offsite' });
  const r = await _getTranscriptRaw(url);
  return done(r);
}

module.exports = { getJson, postReplay, classify, _send, getTranscriptFile, SIGNIN_MSG_RE };
