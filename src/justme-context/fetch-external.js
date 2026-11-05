'use strict';
// src/justme-context/fetch-external.js — clean, credential-free external fetch (design §9.4).
// Node http(s) only, NEVER Electron net/session: no Chromium cookie jar, auth
// cache or client certificate can attach. Fixed header set (no Cookie,
// Authorization, Proxy-Authorization or Referer), agent:false, a DNS lookup that
// refuses private addresses (the socket connects to the checked address), manual
// redirects re-classified on every hop (only `external` is followed), and size
// and time limits. Every body goes to extract-host.extractItem (the worker).

const zlib = require('zlib');
const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');
const { classifyUrl, isBlockedAddress } = require('./url-policy');

const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (FleetOps context reader)',
  Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,*/*;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
});
const THIN_TEXT_CHARS = 500;
const TLS_RE = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;

function _logger(deps) {
  return (deps && deps.logger) || require('../utils/logger').createLogger('justme-context');
}

/**
 * makeGuardedLookup(dns) -> lookup(hostname, options, cb) for http(s).request.
 * Resolves all addresses; any blocked address fails the lookup with EBLOCKED.
 */
function makeGuardedLookup(dnsImpl) {
  return function guarded(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    dnsImpl.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = (Array.isArray(addrs) ? addrs : []).map((a) => (typeof a === 'string' ? { address: a, family: a.includes(':') ? 6 : 4 } : a));
      if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
        const e = new Error('blocked address');
        e.code = 'EBLOCKED';
        return cb(e);
      }
      if (options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}
const guardedLookup = (hostname, options, cb) => makeGuardedLookup(require('dns'))(hostname, options, cb);

const _item = (kind, status, reason, extra) => Object.assign({ kind, status, text: '', chars: 0, truncated: false, reason, meta: {} }, extra || {});

function _decoder(encoding) {
  const e = String(encoding || '').toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

function _nameFrom(u) {
  try { const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || ''; return decodeURIComponent(seg).slice(0, 120); }
  catch (_) { return ''; }
}

// One request, no redirect following. Resolves (never rejects) with
// { type:'redirect', location } | { type:'body', status, mimetype, buffer } |
// { type:'status', status } | { type:'error', reason, status:'failed'|'blocked'|'skipped', tag }.
function _requestOnce(u, ctx, deps, endAt) {
  return new Promise((resolve) => {
    const now = deps.now || Date.now;
    const url = new URL(u);
    const mod = url.protocol === 'http:' ? (deps.http || require('http')) : (deps.https || require('https'));
    let host = url.hostname;
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    let done = false, req = null, res = null, headersTimer = null, totalTimer = null, dec = null;
    const onAbort = () => fail(REASONS.BUDGET, 'skipped', 'abort');
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(headersTimer); clearTimeout(totalTimer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const kill = () => { try { if (dec) dec.destroy(); } catch (_) {} try { if (res) res.destroy(); } catch (_) {} try { if (req) req.destroy(); } catch (_) {} };
    function fail(reason, status, tag) { kill(); finish({ type: 'error', reason, status: status || 'failed', tag }); }
    if (ctx.signal && ctx.signal.aborted) return finish({ type: 'error', reason: REASONS.BUDGET, status: 'skipped', tag: 'abort' });
    const left = endAt - now();
    if (left <= 0) return finish({ type: 'error', reason: REASONS.TIMEOUT, status: 'failed', tag: 'timeout' });
    try {
      req = mod.request({
        protocol: url.protocol, hostname: host, port: url.port || undefined, path: url.pathname + url.search,
        method: 'GET', headers: Object.assign({}, HEADERS), agent: false,
        lookup: deps.lookup || makeGuardedLookup(deps.dns || require('dns')),
      });
    } catch (e) { return finish({ type: 'error', reason: REASONS.UNREACHABLE, status: 'failed', tag: errTag(e) }); }
    headersTimer = setTimeout(() => fail(REASONS.TIMEOUT, 'failed', 'timeout'), Math.min(LIMITS.EXT_HEADERS_TIMEOUT_MS, left));
    totalTimer = setTimeout(() => fail(REASONS.TIMEOUT, 'failed', 'timeout'), left);
    if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => {
      const code = errTag(e);
      if (code === 'EBLOCKED') return fail(REASONS.RESOLVES_PRIVATE, 'blocked', code);
      if (TLS_RE.test(code)) return fail(REASONS.TLS_FAILED, 'failed', code);
      return fail(REASONS.UNREACHABLE, 'failed', code);
    });
    req.on('response', (r) => {
      res = r;
      clearTimeout(headersTimer);
      const status = r.statusCode;
      const loc = r.headers && r.headers.location;
      if (status >= 300 && status < 400 && loc) { kill(); return finish({ type: 'redirect', location: String(Array.isArray(loc) ? loc[0] : loc), status }); }
      if (status !== 200) { kill(); return finish({ type: 'status', status }); }
      const mimetype = String((r.headers && r.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
      const chunks = [];
      let total = 0;
      let stream = r;
      try { dec = _decoder(r.headers && r.headers['content-encoding']); } catch (_) { dec = null; }
      if (dec) { r.pipe(dec); stream = dec; dec.on('error', (e) => fail(REASONS.UNREACHABLE, 'failed', errTag(e))); }
      stream.on('data', (c) => {
        if (done) return;
        total += c.length;
        if (total > LIMITS.MAX_BYTES.external) return fail(REASONS.TOO_LARGE, 'failed', 'too-large');
        chunks.push(c);
      });
      stream.on('end', () => finish({ type: 'body', status, mimetype, buffer: Buffer.concat(chunks) }));
      r.on('error', (e) => fail(REASONS.UNREACHABLE, 'failed', errTag(e)));
    });
    try { req.end(); } catch (e) { fail(REASONS.UNREACHABLE, 'failed', errTag(e)); }
  });
}

/**
 * fetchExternal(url, ctx, deps, hops = 0) -> item { kind, status, text, chars, truncated, reason, meta }
 * ctx = the gather context { signal, deadline, jobId, visionLeft, session } (passed
 * through unchanged to extractItem so the lazily created worker session is shared).
 * hops = redirects already followed (carried over from an internal hand-off).
 */
async function fetchExternal(url, ctx, deps, hops) {
  ctx = ctx || {};
  deps = deps || {};
  const now = deps.now || Date.now;
  const log = _logger(deps);
  const t0 = now();
  let n = hops || 0;
  let cur = url;
  const endAt = Math.min(t0 + LIMITS.EXT_TOTAL_TIMEOUT_MS, Number.isFinite(ctx.deadline) ? ctx.deadline : Infinity);
  let host = '';
  const done = (item, tag) => {
    try { log.info('[jmctx][' + (ctx.jobId || '-') + '] ext ' + host + ' ' + tag + ' ' + (now() - t0) + 'ms'); } catch (_) {}
    return item;
  };
  for (;;) {
    const cls = classifyUrl(cur);
    host = cls.host || host;
    if (cls.kind !== 'external') {
      return done(_item('page', 'blocked', cls.reason || REASONS.REDIRECT_INTERNAL), 'blocked');
    }
    const r = await _requestOnce(cur, ctx, deps, endAt);
    if (r.type === 'error') return done(_item('page', r.status, r.reason), r.tag);
    if (r.type === 'status') return done(_item('page', 'failed', REASONS.HTTP_ERROR, { meta: { status: r.status } }), String(r.status));
    if (r.type === 'redirect') {
      if (n >= LIMITS.EXT_MAX_REDIRECTS) return done(_item('page', 'failed', REASONS.TOO_MANY_REDIRECTS), 'redirects');
      let next;
      try { next = new URL(r.location, cur).href; } catch (_) { return done(_item('page', 'failed', REASONS.UNREACHABLE), 'badlocation'); }
      n++;
      const c2 = classifyUrl(next);
      if (c2.kind !== 'external') return done(_item('page', 'blocked', REASONS.REDIRECT_INTERNAL), 'redirect-blocked');
      cur = next;
      continue;
    }
    // 200 body -> worker
    const extractItem = deps.extractItem || require('./extract-host').extractItem;
    const item = await extractItem({ buffer: r.buffer, name: _nameFrom(cur), mimetype: r.mimetype }, ctx, deps);
    if (item.kind === 'html') {
      item.kind = 'page';
      if (item.status === 'read' && item.chars < THIN_TEXT_CHARS) item.reason = REASONS.NEEDS_JS;
      else if (item.status === 'failed' && item.reason === REASONS.HTML_EMPTY) item.reason = REASONS.NEEDS_JS;
    }
    return done(item, '200 ' + r.buffer.length + 'B');
  }
}

module.exports = { fetchExternal, guardedLookup, makeGuardedLookup, HEADERS };
