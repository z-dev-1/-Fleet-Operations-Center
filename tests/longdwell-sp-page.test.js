// tests/longdwell-sp-page.test.js - browser-side page functions for the Long
// Dwell weekly sheet (src/scrapers/sp_sheet_page.js), run against a fake fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const page = require('../src/scrapers/sp_sheet_page');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'scrapers', 'sp_sheet_page.js'), 'utf8');

const ORIGIN = 'https://contoso.sharepoint.com';
const SITE = '/sites/Fleet';
const PATH = '/sites/Fleet/Shared Documents/Tracker.xlsx';
const GUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ETAG = '"{AAAAAAAA-0000-0000-0000-000000000001},7"';
const PK = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5]);

function res({ status = 200, json, bytes, headers = {}, url = '', redirected = false } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (json !== undefined && !h['content-type']) h['content-type'] = 'application/json;odata=nometadata';
  return {
    ok: status >= 200 && status < 300, status, url, redirected,
    headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) },
    json: async () => json,
    arrayBuffer: async () => (bytes || new Uint8Array(0)).buffer.slice(0),
  };
}

let calls, routes;
function fakeFetch(url, opts = {}) {
  calls.push({ url, opts });
  for (const r of routes) if (r.match(url, opts)) return Promise.resolve(typeof r.reply === 'function' ? r.reply(url, opts) : r.reply);
  return Promise.resolve(res({ status: 404 }));
}
const route = (match, reply) => routes.push({ match: typeof match === 'function' ? match : (u) => u.includes(match), reply });
const FILE_JSON = { ServerRelativeUrl: PATH, Name: 'Tracker.xlsx', UniqueId: GUID, ETag: ETAG, Length: 1234, TimeLastModified: '2026-11-05T10:00:00Z' };

let logSpy;
beforeEach(() => {
  calls = []; routes = [];
  globalThis.fetch = vi.fn(fakeFetch);
  logSpy = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => { delete globalThis.fetch; logSpy.forEach((s) => s.mockRestore()); });

describe('source shape', () => {
  it('has no require and only var/function at the top level, guarded module.exports', () => {
    expect(SRC).not.toMatch(/\brequire\s*\(/);
    expect(SRC).not.toMatch(/^(const|let)\s/m);
    expect(SRC).toMatch(/if \(typeof module !== 'undefined'/);
    expect(SRC).not.toMatch(/console\./);
  });
});

describe('buildFileApiUrl', () => {
  it('encodes # & ? % and doubles quotes inside the OData literal', () => {
    const u = page.buildFileApiUrl(ORIGIN, SITE, "/sites/Fleet/Docs/O'Neil #1 & Co? 50%.xlsx", '/$value');
    expect(u).toBe(ORIGIN + SITE + "/_api/web/getfilebyserverrelativeurl('/sites/Fleet/Docs/O''Neil%20%231%20%26%20Co%3F%2050%25.xlsx')/$value");
  });
  it('rejects non-SharePoint origins and bad sites', () => {
    expect(page.buildFileApiUrl('https://evil.example.com', SITE, PATH, '')).toBeNull();
    expect(page.buildFileApiUrl('http://contoso.sharepoint.com', SITE, PATH, '')).toBeNull();
    expect(page.buildFileApiUrl(ORIGIN, '/other/x', PATH, '')).toBeNull();
  });
  it('validates GUIDs', () => {
    expect(page.buildFileByIdUrl(ORIGIN, SITE, '{' + GUID.toUpperCase() + '}', '')).toBe(ORIGIN + SITE + "/_api/web/GetFileById('" + GUID + "')");
    expect(page.buildFileByIdUrl(ORIGIN, SITE, "x') or 1 eq 1", '')).toBeNull();
  });
});

describe('spSheetResolve', () => {
  it('strategy 1 (path) first; Accept json nometadata', async () => {
    route('getfilebyserverrelativeurl', res({ json: FILE_JSON }));
    const r = await page.spSheetResolve({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, fileGuid: GUID, linkUrl: ORIGIN + '/:x:/s/Fleet/abc?e=TOKEN' });
    expect(r).toMatchObject({ ok: true, strategy: 1, host: 'contoso.sharepoint.com', site: SITE, serverRelativeUrl: PATH, uniqueId: GUID, name: 'Tracker.xlsx', etag: ETAG });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.headers.Accept).toBe('application/json;odata=nometadata');
  });
  it('falls back path -> guid -> linking url -> landing url, in order', async () => {
    route((u) => u.includes('GetFileByLinkingUrl'), res({ status: 404 }));
    route((u) => u.includes('GetFileById'), res({ status: 404 }));
    route((u) => u.includes('/:x:/s/'), res({ status: 200, url: ORIGIN + SITE + '/_layouts/15/Doc.aspx?sourcedoc=%7B' + GUID + '%7D&file=Tracker.xlsx', redirected: true, headers: { 'content-type': 'text/html' } }));
    let pathHits = 0;
    route((u) => u.includes('getfilebyserverrelativeurl'), () => { pathHits++; return res({ status: 404 }); });
    const r = await page.spSheetResolve({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, fileGuid: GUID, linkUrl: ORIGIN + '/:x:/s/Fleet/abc?e=TOKEN' });
    const order = calls.map((c) => (c.url.includes('getfilebyserverrelativeurl') ? 1 : c.url.includes('GetFileById') ? 2 : c.url.includes('GetFileByLinkingUrl') ? 3 : 4));
    expect(order.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(pathHits).toBe(1);
    expect(r).toMatchObject({ ok: false, code: 'not-found' });
  });
  it('strategy 4 uses the landing sourcedoc GUID', async () => {
    let n = 0;
    route((u) => u.includes('GetFileById'), () => (++n === 1 ? res({ status: 404 }) : res({ json: FILE_JSON })));
    route((u) => u.includes('GetFileByLinkingUrl'), res({ status: 400 }));
    route((u) => u.includes('/:x:/s/'), res({ status: 200, url: ORIGIN + SITE + '/_layouts/15/Doc.aspx?sourcedoc=%7B' + GUID + '%7D', redirected: true }));
    const r = await page.spSheetResolve({ origin: ORIGIN, site: SITE, fileGuid: GUID, linkUrl: ORIGIN + '/:x:/s/Fleet/abc?e=TOKEN' });
    expect(r).toMatchObject({ ok: true, strategy: 4 });
  });
  it('linking url is encodeURIComponent-encoded with quotes doubled', async () => {
    route('GetFileByLinkingUrl', res({ json: FILE_JSON }));
    await page.spSheetResolve({ origin: ORIGIN, site: SITE, linkUrl: ORIGIN + "/:x:/s/Fleet/a'b?e=T&x=1" });
    expect(calls[0].url).toContain('@a=' + encodeURIComponent("'" + ORIGIN + "/:x:/s/Fleet/a''b?e=T&x=1'"));
  });
  it('login redirect / 401 -> auth-required; non-xlsx -> unsupported-format', async () => {
    route('getfilebyserverrelativeurl', res({ status: 200, redirected: true, url: 'https://login.microsoftonline.com/x', json: {} }));
    expect(await page.spSheetResolve({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ ok: false, code: 'auth-required' });
    routes = [];
    route('getfilebyserverrelativeurl', res({ json: { ...FILE_JSON, Name: 'Tracker.xlsm' } }));
    expect(await page.spSheetResolve({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ ok: false, code: 'unsupported-format' });
  });
  it('each step has its own budget inside a total', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn((url, opts) => { calls.push({ url, opts }); return new Promise((_r, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); }); });
      const p = page.spSheetResolve({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, fileGuid: GUID, linkUrl: ORIGIN + '/:x:/s/F/a' });
      await vi.advanceTimersByTimeAsync(15000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(15000);
      const r = await p;
      expect(calls).toHaveLength(2);
      expect(r.ok).toBe(false);
      expect(r.failures.map((f) => f.code)).toEqual(['network', 'network', 'timeout', 'timeout']);
    } finally { vi.useRealTimers(); }
  });
});

describe('spSheetMeta', () => {
  it('returns the metadata ETag unchanged (quotes included), no-store, plus versioning', async () => {
    route((u) => u.includes('ParentList'), res({ json: { EnableVersioning: true } }));
    route((u) => u.includes('getfilebyserverrelativeurl'), res({ json: { ETag: ETAG, TimeLastModified: '2026-11-05T10:00:00Z', Length: 99, UIVersionLabel: '7.0', CheckOutType: 2, LockedByUser: { Id: 12 } } }));
    const r = await page.spSheetMeta({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH });
    expect(r).toEqual({ ok: true, etag: ETAG, modified: '2026-11-05T10:00:00Z', length: 99, version: '7.0', checkOutType: 2, checkedOut: false, lockedBy: true, versioning: true });
    expect(calls.every((c) => c.opts.cache === 'no-store' && c.opts.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.opts.headers.Accept === 'application/json;odata=nometadata')).toBe(true);
  });
  it('spSheetMeta versioning GET is read-only and null on failure', async () => {
    route((u) => u.includes('ParentList'), res({ status: 500 }));
    route((u) => u.includes('getfilebyserverrelativeurl'), res({ json: { ETag: ETAG, TimeLastModified: 't', CheckOutType: 2 } }));
    const r = await page.spSheetMeta({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH });
    expect(r.ok).toBe(true);
    expect(r.versioning).toBeNull();
    const v = calls.find((c) => c.url.includes('ParentList'));
    expect(v.opts.method).toBe('GET');
    expect(v.url).toContain('/ListItemAllFields/ParentList?$select=EnableVersioning');
  });
  it('maps 401 -> auth-required, 404 -> not-found, 429 -> throttled with Retry-After', async () => {
    route('x', null);
    routes = [{ match: () => true, reply: res({ status: 401 }) }];
    expect(await page.spSheetMeta({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ code: 'auth-required' });
    routes = [{ match: () => true, reply: res({ status: 404 }) }];
    expect(await page.spSheetMeta({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ code: 'not-found' });
    routes = [{ match: () => true, reply: res({ status: 429, headers: { 'Retry-After': '7' } }) }];
    expect(await page.spSheetMeta({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ code: 'throttled', retryAfterMs: 7000 });
  });
});

describe('spSheetGet', () => {
  it('downloads with Accept octet-stream and returns base64', async () => {
    route('$value', res({ bytes: PK, headers: { 'content-type': 'application/octet-stream', 'content-length': String(PK.length) } }));
    const r = await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 100, bust: 5 });
    expect(r).toMatchObject({ ok: true, length: PK.length });
    expect(Buffer.from(r.b64, 'base64')).toEqual(Buffer.from(PK));
    expect(calls[0].opts.headers.Accept).toBe('application/octet-stream');
    expect(calls[0].opts.cache).toBe('no-store');
    expect(calls[0].url).toMatch(/\/\$value\?rb=5$/);
  });
  it('base64 is correct across 32 KiB chunk boundaries', async () => {
    const big = new Uint8Array(100000).map((_, i) => (i * 7) % 256); big[0] = 0x50; big[1] = 0x4b;
    route('$value', res({ bytes: big, headers: { 'content-type': 'application/octet-stream' } }));
    const r = await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 200000 });
    expect(Buffer.from(r.b64, 'base64').equals(Buffer.from(big))).toBe(true);
  });
  it('Content-Length over the cap -> too-large before reading the body', async () => {
    const r0 = res({ bytes: PK, headers: { 'content-type': 'application/octet-stream', 'content-length': '999999' } });
    r0.arrayBuffer = vi.fn(r0.arrayBuffer);
    route('$value', r0);
    expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 100 })).toMatchObject({ ok: false, code: 'too-large' });
    expect(r0.arrayBuffer).not.toHaveBeenCalled();
  });
  it('body over the cap without Content-Length -> too-large; non-PK -> unsupported-workbook; HTML -> auth-required', async () => {
    route('$value', res({ bytes: new Uint8Array(200).fill(0x50), headers: { 'content-type': 'application/octet-stream' } }));
    expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 100 })).toMatchObject({ code: 'too-large' });
    routes = [];
    route('$value', res({ bytes: new Uint8Array([1, 2, 3, 4, 5]), headers: { 'content-type': 'application/octet-stream' } }));
    expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 100 })).toMatchObject({ code: 'unsupported-workbook' });
    routes = [];
    route('$value', res({ bytes: PK, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, maxBytes: 100 })).toMatchObject({ code: 'auth-required' });
  });
  it('403 on GET -> auth-required; 423 -> locked; 503 -> throttled; 500 -> http-500; network -> network', async () => {
    for (const [s, code] of [[403, 'auth-required'], [423, 'locked'], [503, 'throttled'], [500, 'http-500'], [412, 'precondition']]) {
      routes = [{ match: () => true, reply: res({ status: s }) }];
      expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ ok: false, code });
    }
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await page.spSheetGet({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH })).toMatchObject({ ok: false, code: 'network' });
  });
});

describe('spSheetPut', () => {
  const b64 = Buffer.from(PK).toString('base64');
  beforeEach(() => {
    route('/_api/contextinfo', res({ json: { FormDigestValue: 'DIGEST' } }));
    route('$value', res({ status: 200 }));
  });
  it('digest from the file\'s own site, then PUT with the push headers; no If-Match unless passed', async () => {
    const r = await page.spSheetPut({ origin: ORIGIN, site: '/sites/Other', serverRelativeUrl: '/sites/Other/D/T.xlsx', b64 });
    expect(r).toEqual({ ok: true, http: 200 });
    expect(calls[0].url).toBe(ORIGIN + '/sites/Other/_api/contextinfo');
    expect(calls[0].opts.method).toBe('POST');
    const put = calls[1];
    expect(put.opts.method).toBe('PUT');
    expect(put.url).toMatch(/\/\$value$/);
    expect(put.opts.headers).toMatchObject({ 'X-RequestDigest': 'DIGEST', 'Content-Type': 'application/octet-stream', 'X-HTTP-Method': 'PUT', Accept: 'application/json;odata=nometadata' });
    expect(put.opts.headers['If-Match']).toBeUndefined();
    expect(Buffer.from(put.opts.body)).toEqual(Buffer.from(PK));
  });
  it('If-Match only when passed', async () => {
    await page.spSheetPut({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, b64, ifMatch: ETAG });
    expect(calls[1].opts.headers['If-Match']).toBe(ETAG);
  });
  it('maps 403 -> forbidden, 412 -> precondition, 423 -> locked; never retried', async () => {
    for (const [s, code] of [[403, 'forbidden'], [412, 'precondition'], [423, 'locked'], [429, 'throttled']]) {
      calls = []; routes = [];
      route('/_api/contextinfo', res({ json: { FormDigestValue: 'D' } }));
      route('$value', res({ status: s }));
      expect(await page.spSheetPut({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, b64 })).toMatchObject({ ok: false, code, sent: true });
      expect(calls.filter((c) => c.opts.method === 'PUT')).toHaveLength(1);
    }
  });
  it('network error after sending -> network with sent:true; digest failure -> sent:false and no PUT', async () => {
    globalThis.fetch = vi.fn((url, opts) => { calls.push({ url, opts }); return url.includes('contextinfo') ? Promise.resolve(res({ json: { FormDigestValue: 'D' } })) : Promise.reject(new TypeError('x')); });
    calls = [];
    expect(await page.spSheetPut({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, b64 })).toEqual({ ok: false, code: 'network', sent: true });
    calls = [];
    globalThis.fetch = vi.fn((url, opts) => { calls.push({ url, opts }); return Promise.resolve(res({ status: 401 })); });
    expect(await page.spSheetPut({ origin: ORIGIN, site: SITE, serverRelativeUrl: PATH, b64 })).toMatchObject({ ok: false, code: 'auth-required', sent: false });
    expect(calls.filter((c) => c.opts.method === 'PUT')).toHaveLength(0);
  });
});

describe('verbs and logging', () => {
  it('only GET, contextinfo POST and $value PUT; no console output of values', async () => {
    route('/_api/contextinfo', res({ json: { FormDigestValue: 'D' } }));
    route('$value', (u, o) => (o.method === 'PUT' ? res({ status: 200 }) : res({ bytes: PK, headers: { 'content-type': 'application/octet-stream' } })));
    route('ParentList', res({ json: { EnableVersioning: false } }));
    route('getfilebyserverrelativeurl', res({ json: { ...FILE_JSON, Name: 'SECRET_CELL_TEXT.xlsx' } }));
    const base = { origin: ORIGIN, site: SITE, serverRelativeUrl: PATH };
    await page.spSheetResolve({ ...base, linkUrl: ORIGIN + '/:x:/s/Fleet/abc?e=TOKEN' });
    await page.spSheetMeta(base);
    await page.spSheetGet(base);
    await page.spSheetPut({ ...base, b64: Buffer.from(PK).toString('base64') });
    for (const c of calls) {
      const m = c.opts.method;
      const ok = m === 'GET' || (m === 'POST' && /\/_api\/contextinfo$/.test(c.url)) || (m === 'PUT' && /\/\$value$/.test(c.url));
      expect(ok).toBe(true);
    }
    for (const s of logSpy) expect(s).not.toHaveBeenCalled();
  });
});
