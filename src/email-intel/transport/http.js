'use strict';
/**
 * email-intel/transport/http.js — electron.net.request wrapper for the Outlook REST transport (design 4.4).
 *
 *   createHttp({ electron, tokens, now, sleep, log, owaRe, timers }) -> {
 *     request(spec) -> { status, json }      json is null for an empty body (202)
 *     get(path, extra) -> request({ method:'GET', retry:'read', ... })
 *     pausedUntil() -> ms | 0                the shared throttle gate
 *   }
 *   spec = { op, method, path, body?, timeoutMs, maxBytes, signal, retry:'read'|'write'|'final', minTtlMs?, deadlineAt?, noRetry? }
 *
 * Per attempt: allow-list -> throttle gate -> semaphore (MAX_INFLIGHT; `final` bypasses it) -> auth (getAuth for
 * read/write, peek for final) -> net.request on session.defaultSession with the session cookies, manual redirects.
 * Outcomes follow the design 4.4 table. 401 (or a redirect to a sign-in host) refreshes once; a refresh that yields
 * the same generation tries one different-rank capture (R4-L7) before ApiAuthBlockedError. 429/503 honour
 * Retry-After (seconds or HTTP date, capped) and set the shared gate; the slot is released while sleeping.
 * R4-M5: no attempt starts at or after spec.deadlineAt and the per-attempt timeout is clamped to it.
 * One log line per attempt with the op enum, status, duration and try number. URLs, ids, headers and bodies are
 * never logged.
 */
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const E = require('./errors');
const { isAuthUrl } = require('./token-source');

const API_CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,59}$/;
const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function parseRetryAfter(value, nowMs) {
  const v = Array.isArray(value) ? value[0] : value;
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let ms;
  if (/^\d+$/.test(s)) ms = parseInt(s, 10) * 1000;
  else {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    ms = t - nowMs;
  }
  return Math.max(0, Math.min(TC.RETRY_AFTER_CAP_MS, ms));
}

function _header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  for (const k of Object.keys(headers)) if (String(k).toLowerCase() === name) return headers[k];
  return null;
}

function _apiCode(json) {
  const c = json && json.error && json.error.code;
  return typeof c === 'string' && API_CODE_RE.test(c) ? c : 'Unknown';
}

function createHttp(deps) {
  const d = deps || {};
  const electron = d.electron;
  const tokens = d.tokens;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const sleep = typeof d.sleep === 'function' ? d.sleep : realSleep;
  const log = d.log || { info() {}, warn() {} };
  const owaRe = d.owaRe || null;
  const timers = d.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  const maxInflight = Number.isInteger(d.maxInflight) && d.maxInflight > 0 ? d.maxInflight : TC.MAX_INFLIGHT;

  let inflight = 0; let finalInflight = 0;
  const waiters = [];
  let gateUntil = 0;

  const pausedUntil = () => (gateUntil > now() ? gateUntil : 0);

  function _stop(spec) {
    if (spec.signal && spec.signal.aborted) throw new E.AbortedError('aborted');
    if (Number.isFinite(spec.deadlineAt) && now() >= spec.deadlineAt) throw new E.AbortedError('deadline');
  }

  function _abortable(p, spec) {
    if (!spec.signal) return p;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new E.AbortedError('aborted'));
      if (spec.signal.aborted) { onAbort(); return; }
      spec.signal.addEventListener('abort', onAbort, { once: true });
      p.then((v) => { spec.signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { spec.signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  async function _gateWait(spec) {
    const until = pausedUntil();
    if (!until) return;
    if (Number.isFinite(spec.deadlineAt) && until >= spec.deadlineAt) throw new E.ThrottledError(429, { reason: 'deadline' });
    await _abortable(Promise.resolve(sleep(until - now())), spec);
  }

  function _acquire(spec) {
    if (inflight < maxInflight) { inflight++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, done: false, timer: null };
      const fail = (err) => { if (w.done) return; w.done = true; if (w.timer) timers.clearTimeout(w.timer); reject(err); };
      w.grant = () => { if (w.done) return false; w.done = true; if (w.timer) timers.clearTimeout(w.timer); resolve(); return true; };
      if (spec.signal) spec.signal.addEventListener('abort', () => fail(new E.AbortedError('aborted')), { once: true });
      if (Number.isFinite(spec.deadlineAt)) w.timer = timers.setTimeout(() => fail(new E.AbortedError('deadline')), Math.max(0, spec.deadlineAt - now()));
      waiters.push(w);
    });
  }
  function _release() {
    inflight = Math.max(0, inflight - 1);
    while (waiters.length) {
      const w = waiters.shift();
      if (!w.done) { inflight++; w.grant(); return; }
    }
  }

  /** One request on the wire. Resolves with an outcome object, never rejects. */
  function _send(spec, auth, tryN) {
    return new Promise((resolve) => {
      const t0 = now();
      let written = false; let settled = false; let req = null; let timer = null;
      let effTimeout = Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : TC.GET_TIMEOUT_MS;
      let clamped = false;
      if (Number.isFinite(spec.deadlineAt) && spec.deadlineAt - now() < effTimeout) { effTimeout = Math.max(1, spec.deadlineAt - now()); clamped = true; }
      const maxBytes = Number.isFinite(spec.maxBytes) ? spec.maxBytes : TC.JSON_MAX_BYTES;
      let onAbort = null;
      const done = (o) => {
        if (settled) return;
        settled = true;
        if (timer) timers.clearTimeout(timer);
        if (onAbort && spec.signal) spec.signal.removeEventListener('abort', onAbort);
        o.ms = now() - t0;
        const err = o.kind === 'response' ? '' : ' err=' + o.kind;
        log.info('[email-api] op=' + String(spec.op || 'req') + ' status=' + (o.status || 0) + ' ms=' + o.ms + ' try=' + tryN + err);
        resolve(o);
      };
      const abortReq = () => { try { if (req) req.abort(); } catch (_) { /* aborting */ } };
      try {
        req = electron.net.request({
          method: spec.method, url: 'https://' + endpoints.API_HOST + spec.path,
          session: electron.session.defaultSession, useSessionCookies: true, credentials: 'include', redirect: 'manual',
        });
      } catch (_) { done({ kind: 'network', written: false }); return; }
      timer = timers.setTimeout(() => { done({ kind: 'timeout', written, clamped }); abortReq(); }, effTimeout);
      if (spec.signal) {
        onAbort = () => { done({ kind: 'abort', written }); abortReq(); };
        spec.signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('redirect', (statusCode, _method, redirectUrl) => {
        done({ kind: 'redirect', status: Number(statusCode) || 302, toAuth: isAuthUrl(redirectUrl, owaRe) });
        abortReq();
      });
      req.on('response', (res) => {
        const chunks = []; let n = 0;
        res.on('data', (c) => {
          if (settled) return;
          n += c.length;
          if (n > maxBytes) { done({ kind: 'too-large', status: res.statusCode }); abortReq(); return; }
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        });
        res.on('end', () => {
          if (settled) return;
          let json = null;
          if (n > 0) { try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { json = null; } }
          chunks.length = 0;
          done({ kind: 'response', status: res.statusCode, headers: res.headers || {}, json });
        });
        res.on('error', () => done({ kind: 'network', written }));
      });
      req.on('abort', () => done({ kind: 'abort', written }));
      req.on('error', () => done({ kind: 'network', written }));
      try {
        req.setHeader('accept', 'application/json');
        req.setHeader('authorization', auth.headers.authorization);
        req.setHeader('x-anchormailbox', auth.headers['x-anchormailbox']);
        if (spec.body !== undefined) {
          req.setHeader('content-type', 'application/json');
          req.write(JSON.stringify(spec.body));
        }
        req.end();
        written = true;
      } catch (_) { done({ kind: 'network', written }); abortReq(); }
    });
  }

  const _authFail = (o) => (o.kind === 'response' && o.status === 401) || (o.kind === 'redirect' && o.toAuth);

  async function request(spec) {
    endpoints.assertAllowed(spec.method, spec.path);
    if (spec.retry === 'final') return _final(spec);
    let tryN = 0; let throttleN = 0; let transientDone = false; let authRetried = false;
    for (;;) {
      _stop(spec);
      await _gateWait(spec);
      _stop(spec);
      await _acquire(spec);
      let o;
      try {
        _stop(spec);
        // peekAuth: best-effort cleanup after `sending` uses the cached token only (never opens a token window).
        let auth = spec.peekAuth ? tokens.peek() : await tokens.getAuth({ minTtlMs: spec.minTtlMs, signal: spec.signal });
        o = await _send(spec, auth, ++tryN);
        while (_authFail(o)) {
          if (authRetried || spec.noRetry) throw new E.ApiAuthBlockedError({ status: 401 });
          authRetried = true;
          tokens.invalidate('401', auth.gen);
          const a2 = await tokens.getAuth({ minTtlMs: spec.minTtlMs, signal: spec.signal });
          let next = a2;
          if (a2.gen === auth.gen) {
            next = typeof tokens.alternate === 'function' ? tokens.alternate(auth.gen) : null;
            if (!next) throw new E.ApiAuthBlockedError({ status: 401 });
          }
          _stop(spec);
          auth = next;
          o = await _send(spec, auth, ++tryN);
        }
      } finally { _release(); }

      if (o.kind === 'response') {
        const st = o.status;
        if (st >= 200 && st < 300) return { status: st, json: o.json };
        if (st === 429 || st === 503) {
          throttleN++;
          if (spec.noRetry || throttleN >= TC.THROTTLE_MAX_TRIES) throw new E.ThrottledError(st);
          const ra = parseRetryAfter(_header(o.headers, 'retry-after'), now());
          const wait = ra != null ? ra : Math.min(TC.RETRY_AFTER_CAP_MS, TC.BACKOFF_BASE_MS * Math.pow(2, throttleN - 1));
          const until = now() + wait;
          if (until > gateUntil) gateUntil = until;
          if (Number.isFinite(spec.deadlineAt) && until >= spec.deadlineAt) throw new E.ThrottledError(st, { reason: 'deadline' });
          await _abortable(Promise.resolve(sleep(wait)), spec);
          continue;
        }
        if (st === 500 || st === 502 || st === 504) {
          if (spec.retry === 'read' && !transientDone && !spec.noRetry) { transientDone = true; await _abortable(Promise.resolve(sleep(TC.TRANSIENT_RETRY_MS)), spec); continue; }
          throw new E.ApiHttpError(st, _apiCode(o.json));
        }
        if (st >= 300 && st < 400) throw new E.ApiHttpError(st, 'Redirect');
        throw new E.ApiHttpError(st, _apiCode(o.json));
      }
      if (o.kind === 'redirect') throw new E.ApiHttpError(o.status, 'Redirect');
      if (o.kind === 'too-large') throw new E.ResponseTooLargeError();
      if (o.kind === 'abort') throw new E.AbortedError('aborted');
      if (o.kind === 'timeout') {
        if (o.clamped) throw new E.ApiTimeoutError({ reason: 'deadline' });
        if (spec.retry === 'read' && !transientDone && !spec.noRetry) { transientDone = true; continue; }
        throw new E.ApiTimeoutError();
      }
      if (spec.retry === 'read' && !transientDone && !spec.noRetry) { transientDone = true; continue; }
      throw new E.ApiNetworkError();
    }
  }

  /** `final` (send-draft, sendmail): never refreshes, never waits, never retried (I-6, I-7). */
  async function _final(spec) {
    let auth;
    try {
      _stop(spec);
      if (pausedUntil()) throw new E.ThrottledError(429, { reason: 'paused' });
      auth = tokens.peek();
    } catch (e) {
      if (e && typeof e === 'object') e.definitiveNotSent = true;
      throw e;
    }
    finalInflight++;
    let o;
    try { o = await _send(spec, auth, 1); } finally { finalInflight--; }
    if (o.kind === 'response') {
      const st = o.status;
      if (st >= 200 && st < 300) return { status: st, json: o.json };
      if (st === 401) throw new E.ApiAuthBlockedError({ status: 401, definitiveNotSent: true });
      if (st === 429) throw new E.ThrottledError(429, { definitiveNotSent: true });
      if (st >= 500) throw new E.ApiHttpError(st, _apiCode(o.json), { uncertain: true });
      if (st >= 300 && st < 400) throw new E.ApiHttpError(st, 'Redirect', { uncertain: false });
      throw new E.ApiHttpError(st, _apiCode(o.json), { definitiveNotSent: true });
    }
    if (o.kind === 'redirect') {
      if (o.toAuth) throw new E.ApiAuthBlockedError({ status: o.status, definitiveNotSent: true });
      throw new E.ApiHttpError(o.status, 'Redirect', { uncertain: false });
    }
    if (o.kind === 'timeout') throw new E.ApiTimeoutError({ uncertain: !!o.written, definitiveNotSent: !o.written, reason: o.clamped ? 'deadline' : undefined });
    if (o.kind === 'abort') throw new E.AbortedError('aborted', { uncertain: !!o.written, definitiveNotSent: !o.written });
    if (o.kind === 'too-large') throw new E.ResponseTooLargeError({ uncertain: true });
    throw new E.ApiNetworkError({ uncertain: !!o.written, definitiveNotSent: !o.written });
  }

  function get(path, extra) {
    return request(Object.assign({ op: 'get', method: 'GET', path, timeoutMs: TC.GET_TIMEOUT_MS, maxBytes: TC.JSON_MAX_BYTES, retry: 'read' }, extra || {}, { path, method: 'GET' }));
  }

  function _stats() { return { inflight, finalInflight, waiting: waiters.filter((w) => !w.done).length }; }

  return { request, get, pausedUntil, _stats };
}

module.exports = { createHttp, parseRetryAfter };
