// fetch-external.js: T-EXT-* and T-EXT-NO-ELECTRON (design §9.4, §19). Fake
// transport + fake dns.lookup; the electron fake throws if touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import zlib from 'zlib';
import fs from 'fs';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const { fetchExternal, makeGuardedLookup, HEADERS } = require('../src/justme-context/fetch-external');
const { REASONS, LIMITS } = require('../src/justme-context/constants');

// Fake http(s) module: routes keyed by "host/path". Each request resolves the host
// through opts.lookup (the guarded lookup under test) before "connecting".
function makeTransport(routes) {
  const calls = [];
  const request = vi.fn((opts) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = vi.fn(() => { req.destroyed = true; });
    calls.push({ opts, req });
    req.end = () => {
      opts.lookup(opts.hostname, {}, (err) => {
        if (err) return req.emit('error', err);
        const key = opts.hostname + opts.path;
        const route = routes[key] || routes['*'];
        if (!route) return req.emit('error', Object.assign(new Error('ENOTFOUND ' + key), { code: 'ENOTFOUND' }));
        if (route.error) return req.emit('error', Object.assign(new Error('boom ' + key), { code: route.error }));
        if (route.hang) return;
        const body = route.chunks ? route.chunks() : [Buffer.from(route.body || '')];
        const res = Readable.from(body);
        res.statusCode = route.status || 200;
        res.headers = route.headers || {};
        setImmediate(() => req.emit('response', res));
      });
    };
    return req;
  });
  return { request, calls };
}
function makeDns(map) {
  return {
    lookup: vi.fn((host, opts, cb) => {
      const v = map[host] !== undefined ? map[host] : ['93.184.216.34'];
      if (v instanceof Error) return setImmediate(() => cb(v));
      setImmediate(() => cb(null, v.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }))));
    }),
  };
}
const throwingElectron = new Proxy({}, { get() { throw new Error('electron touched'); } });

let logger, extractItem, ctx;
beforeEach(() => {
  logger = H.makeLogger(vi);
  extractItem = vi.fn(async (file) => ({ kind: 'pdf', status: 'read', text: 'SENTINEL ' + file.buffer.toString(), chars: 10, truncated: false, reason: '', meta: {} }));
  ctx = { deadline: Date.now() + 60000, jobId: 'jm1' };
});
const mk = (routes, dnsMap) => {
  const t = makeTransport(routes);
  return { t, deps: { https: { request: t.request }, http: { request: t.request }, dns: makeDns(dnsMap || {}), logger, extractItem, electron: throwingElectron } };
};

describe('fetchExternal headers and transport (T-EXT-HEADERS, AC-23)', () => {
  it('sends exactly the fixed header set, agent:false, and a guarded lookup', async () => {
    const { t, deps } = mk({ 'example.com/doc.pdf': { headers: { 'content-type': 'application/pdf' }, body: 'PDFBYTES' } });
    const it2 = await fetchExternal('https://example.com/doc.pdf', ctx, deps);
    expect(it2.status).toBe('read');
    const { opts } = t.calls[0];
    expect(opts.headers).toEqual(HEADERS);
    const lower = Object.keys(opts.headers).map((h) => h.toLowerCase());
    for (const h of ['cookie', 'authorization', 'proxy-authorization', 'referer']) expect(lower).not.toContain(h);
    expect(opts.agent).toBe(false);
    expect(typeof opts.lookup).toBe('function');
    expect(opts.method).toBe('GET');
    expect(extractItem).toHaveBeenCalledTimes(1);
    expect(extractItem.mock.calls[0][0]).toMatchObject({ name: 'doc.pdf', mimetype: 'application/pdf' });
    expect(extractItem.mock.calls[0][1]).toBe(ctx);   // same gather ctx -> shared worker session
  });
  it('decompresses gzip bodies before extraction', async () => {
    const gz = zlib.gzipSync(Buffer.from('hello gz'));
    const { deps } = mk({ 'example.com/a.txt': { headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, body: gz } });
    await fetchExternal('https://example.com/a.txt', ctx, deps);
    expect(extractItem.mock.calls[0][0].buffer.toString()).toBe('hello gz');
  });
});

describe('SSRF DNS guard (T-EXT-DNS)', () => {
  for (const addr of ['10.0.0.5', '169.254.169.254', '::ffff:7f00:1', '127.0.0.1']) {
    it('private resolve ' + addr + ' -> blocked, no response read', async () => {
      const { deps } = mk({ '*': { body: 'x' } }, { 'evil.example': [addr] });
      const r = await fetchExternal('https://evil.example/x', ctx, deps);
      expect(r).toMatchObject({ status: 'blocked', reason: REASONS.RESOLVES_PRIVATE });
      expect(extractItem).not.toHaveBeenCalled();
    });
  }
  it('one private address among public ones still blocks', async () => {
    const { deps } = mk({ '*': { body: 'x' } }, { 'mixed.example': ['8.8.8.8', '10.0.0.1'] });
    expect((await fetchExternal('https://mixed.example/', ctx, deps)).status).toBe('blocked');
  });
  it('makeGuardedLookup answers in the shape Node asked for', async () => {
    const lk = makeGuardedLookup(makeDns({ 'a.example': ['8.8.8.8', '2606:4700::1111'] }));
    const single = await new Promise((r) => lk('a.example', {}, (e, a, f) => r([e, a, f])));
    expect(single).toEqual([null, '8.8.8.8', 4]);
    const all = await new Promise((r) => lk('a.example', { all: true }, (e, a) => r(a)));
    expect(all.map((x) => x.address)).toEqual(['8.8.8.8', '2606:4700::1111']);
  });
});

describe('redirects (T-EXT-REDIRECT-LIMIT)', () => {
  const chain = (n, finalPath) => {
    const routes = {};
    for (let i = 0; i < n; i++) routes['example.com/r' + i] = { status: 302, headers: { location: i + 1 < n ? '/r' + (i + 1) : finalPath } };
    return routes;
  };
  it('follows 5 external redirects', async () => {
    const routes = Object.assign(chain(5, '/end.txt'), { 'example.com/end.txt': { headers: { 'content-type': 'text/plain' }, body: 'end' } });
    const { t, deps } = mk(routes);
    const r = await fetchExternal('https://example.com/r0', ctx, deps);
    expect(r.status).toBe('read');
    expect(t.calls).toHaveLength(6);
  });
  it('refuses the 6th redirect', async () => {
    const routes = Object.assign(chain(6, '/end.txt'), { 'example.com/end.txt': { body: 'end' } });
    const { t, deps } = mk(routes);
    const r = await fetchExternal('https://example.com/r0', ctx, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.TOO_MANY_REDIRECTS });
    expect(t.calls).toHaveLength(6);
    expect(extractItem).not.toHaveBeenCalled();
  });
  it('carries over hops from an internal hand-off', async () => {
    const routes = Object.assign(chain(2, '/end.txt'), { 'example.com/end.txt': { body: 'end' } });
    const { deps } = mk(routes);
    expect((await fetchExternal('https://example.com/r0', ctx, deps, 4)).reason).toBe(REASONS.TOO_MANY_REDIRECTS);
  });
  for (const target of ['https://w.amazon.com/secret', 'http://127.0.0.1/', 'https://fleet.uptake.com/', 'https://x.slack.com/files/U1/F1/a']) {
    it('redirect to ' + target + ' is not followed', async () => {
      const { t, deps } = mk({ 'example.com/go': { status: 301, headers: { location: target } } });
      const r = await fetchExternal('https://example.com/go', ctx, deps);
      expect(r).toMatchObject({ status: 'blocked', reason: REASONS.REDIRECT_INTERNAL });
      expect(t.calls).toHaveLength(1);
    });
  }
});

describe('limits and errors', () => {
  it('body over 10 MB (post-decompression) aborts the stream', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 97);
    const { t, deps } = mk({ 'example.com/big': { headers: { 'content-type': 'text/plain' }, chunks: () => (function* () { for (let i = 0; i < 12; i++) yield chunk; })() } });
    const r = await fetchExternal('https://example.com/big', ctx, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.TOO_LARGE });
    expect(t.calls[0].req.destroy).toHaveBeenCalled();
    expect(extractItem).not.toHaveBeenCalled();
    expect(LIMITS.MAX_BYTES.external).toBe(10 * 1024 * 1024);
  }, 30000);
  it('gzip bomb is cut at the decompressed size', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(11 * 1024 * 1024));
    const { deps } = mk({ 'example.com/bomb': { headers: { 'content-encoding': 'gzip' }, body: bomb } });
    expect((await fetchExternal('https://example.com/bomb', ctx, deps)).reason).toBe(REASONS.TOO_LARGE);
  }, 30000);   // 11 MB gzip + inflate is slow under the full parallel suite
  it('timeout (T-EXT-TIMEOUT): a hanging server fails at the deadline and the request is destroyed', async () => {
    const { t, deps } = mk({ 'example.com/hang': { hang: true } });
    const t0 = Date.now();
    const r = await fetchExternal('https://example.com/hang', { deadline: Date.now() + 150, jobId: 'jm1' }, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.TIMEOUT });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(t.calls[0].req.destroy).toHaveBeenCalled();
  });
  it('abort -> skipped BUDGET', async () => {
    const { deps } = mk({ 'example.com/hang': { hang: true } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await fetchExternal('https://example.com/hang', { deadline: Date.now() + 60000, signal: ac.signal }, deps);
    expect(r).toMatchObject({ status: 'skipped', reason: REASONS.BUDGET });
  });
  it('TLS errors -> secure connection failed; HTTP status -> fixed reason; messages never logged', async () => {
    const { deps } = mk({ 'example.com/tls': { error: 'CERT_HAS_EXPIRED' }, 'example.com/404': { status: 404 } });
    expect((await fetchExternal('https://example.com/tls', ctx, deps)).reason).toBe(REASONS.TLS_FAILED);
    expect(await fetchExternal('https://example.com/404', ctx, deps)).toMatchObject({ status: 'failed', reason: REASONS.HTTP_ERROR, meta: { status: 404 } });
    expect(H.allLogged(logger)).not.toContain('boom');
    expect(H.allLogged(logger)).toContain('[jmctx][jm1] ext example.com CERT_HAS_EXPIRED');
  });
});

describe('T-EXT-NO-ELECTRON', () => {
  it('source never loads Electron, net or session', () => {
    const src = fs.readFileSync(require.resolve('../src/justme-context/fetch-external'), 'utf8');
    expect(src).not.toMatch(/require\(['"]electron['"]\)/);
    expect(src).not.toMatch(/\bnet\.request|defaultSession|fromPartition/);
  });
  it('a full fetch with a throwing electron fake succeeds and sends no credentials', async () => {
    const { t, deps } = mk({ 'example.com/p.txt': { headers: { 'content-type': 'text/plain' }, body: 'ok' } });
    const r = await fetchExternal('https://example.com/p.txt', ctx, deps);
    expect(r.status).toBe('read');
    for (const c of t.calls) {
      const keys = Object.keys(c.opts.headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain('cookie');
      expect(keys).not.toContain('authorization');
    }
  });
  it('HTML goes through the real worker; a thin page reports NEEDS_JS', async () => {
    const { deps } = mk({ 'example.com/': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><title>t</title><body><p>Short SENTINEL page</p><script>x()</script></body></html>' } });
    delete deps.extractItem;
    deps.spawnWorker = H.spawnRealWorker;
    const gctx = { deadline: Date.now() + 60000, jobId: 'jm1' };
    try {
      const r = await fetchExternal('https://example.com/', gctx, deps);
      expect(r.kind).toBe('page');
      expect(r.status).toBe('read');
      expect(r.text).toContain('Short SENTINEL page');
      expect(r.text).not.toContain('x()');
      expect(r.reason).toBe(REASONS.NEEDS_JS);
    } finally { if (gctx.session) gctx.session.close(); }
  }, 30000);
});
