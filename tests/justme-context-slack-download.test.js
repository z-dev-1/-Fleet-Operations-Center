// T-SLACK-AUTH + T-SIZE-*: slack_send.downloadFileBounded (design 7.4).
// A fake `https` is injected through opts.https; nothing touches the network.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-dl-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const ss = require('../src/scrapers/slack_send');

const TOKEN = 'xoxc-TESTTOKEN-1234';
const COOKIE = 'd=TESTCOOKIEVALUE';
const FILE = { id: 'F0ABC123', name: 'doc.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/T1-F0ABC123/doc.pdf' };

// Fake https: `script(options, n)` returns { status, headers, chunks[], hang } for the nth request.
function makeHttps(script) {
  const reqs = [];
  const api = {
    reqs,
    request(options, cb) {
      const n = reqs.length;
      const info = { options, destroyed: false };
      reqs.push(info);
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = () => { info.destroyed = true; };
      req.end = () => {
        const r = script(options, n);
        if (r.hang) return;
        setImmediate(() => {
          if (info.destroyed) return;
          const res = new EventEmitter();
          res.statusCode = r.status;
          res.headers = r.headers || {};
          res.resume = () => {};
          cb(res);
          setImmediate(() => {
            for (const c of (r.chunks || [])) { if (info.destroyed) return; res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(c)); }
            if (!info.destroyed) res.emit('end');
          });
        });
      };
      return req;
    },
  };
  return api;
}
const ok200 = (body = 'PDFBYTES', headers = {}) => ({ status: 200, headers: Object.assign({ 'content-type': 'application/pdf' }, headers), chunks: [body] });

let lines;
beforeAll(() => { ss.slackSaveConfig({ token: TOKEN, cookie: 'c', allCookieHeader: COOKIE }); });
beforeEach(() => {
  lines = [];
  const sink = (c) => { lines.push(String(c)); return true; };
  vi.spyOn(process.stdout, 'write').mockImplementation(sink);
  vi.spyOn(process.stderr, 'write').mockImplementation(sink);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

describe('T-SLACK-AUTH: credentials', () => {
  it('attempt 1 sends Bearer only (no Cookie) and returns the bytes', async () => {
    const h = makeHttps(() => ok200('HELLO'));
    const r = await ss.downloadFileBounded(FILE, { maxBytes: 1000, timeoutMs: 2000, https: h });
    expect(r.ok).toBe(true);
    expect(r.buffer.toString()).toBe('HELLO');
    expect(r.mimetype).toBe('application/pdf');
    expect(r.name).toBe('doc.pdf');
    expect(h.reqs).toHaveLength(1);
    expect(h.reqs[0].options.hostname).toBe('files.slack.com');
    expect(h.reqs[0].options.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(h.reqs[0].options.headers.Cookie).toBeUndefined();
  });

  it('prefers url_private_download over url_private', async () => {
    const h = makeHttps(() => ok200());
    await ss.downloadFileBounded(Object.assign({}, FILE, { url_private_download: 'https://files.slack.com/files-pri/T1-F0ABC123/download/doc.pdf' }), { https: h });
    expect(h.reqs[0].options.path).toBe('/files-pri/T1-F0ABC123/download/doc.pdf');
  });

  it('an HTML sign-in page for a non-HTML file triggers attempt 2 with Authorization + Cookie', async () => {
    const h = makeHttps((o, n) => (n === 0 ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: ['<html>sign in</html>'] } : ok200('REAL')));
    const r = await ss.downloadFileBounded(FILE, { https: h });
    expect(r.ok).toBe(true);
    expect(r.buffer.toString()).toBe('REAL');
    expect(h.reqs).toHaveLength(2);
    expect(h.reqs[0].options.headers.Cookie).toBeUndefined();
    expect(h.reqs[1].options.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(h.reqs[1].options.headers.Cookie).toBe(COOKIE);
  });

  it('401/403 then 403 again: "needs re-auth", exactly 2 attempts', async () => {
    const h = makeHttps(() => ({ status: 403, headers: {} }));
    const r = await ss.downloadFileBounded(FILE, { https: h });
    expect(r).toEqual({ ok: false, reason: 'Slack file download needs re-auth' });
    expect(h.reqs).toHaveLength(2);
  });

  it('a genuine HTML file is returned as is (no second attempt)', async () => {
    const h = makeHttps(() => ({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<p>x</p>'] }));
    const r = await ss.downloadFileBounded({ id: 'F1', name: 'p.html', mimetype: 'text/html', url_private: FILE.url_private }, { https: h });
    expect(r.ok).toBe(true);
    expect(h.reqs).toHaveLength(1);
  });

  it('rejects non-Slack, http, and look-alike hosts without any request', async () => {
    for (const url of ['https://evil.example/f.pdf', 'http://files.slack.com/f.pdf', 'https://slack.com.evil.example/f.pdf',
      'https://notslack.com/f.pdf', 'https://files.slack-edge.com/f.pdf', 'not a url', '']) {
      const h = makeHttps(() => ok200());
      const r = await ss.downloadFileBounded({ id: 'F1', mimetype: 'application/pdf', url_private: url }, { https: h });
      expect(r).toEqual({ ok: false, reason: 'not a Slack file URL' });
      expect(h.reqs).toHaveLength(0);
    }
  });

  it('accepts amazon.enterprise.slack.com (a slack.com subdomain)', async () => {
    const h = makeHttps(() => ok200());
    const r = await ss.downloadFileBounded({ id: 'F1', mimetype: 'application/pdf', url_private: 'https://amazon.enterprise.slack.com/files-pri/x' }, { https: h });
    expect(r.ok).toBe(true);
  });
});

describe('T-SLACK-AUTH: redirects', () => {
  const redir = (loc) => ({ status: 302, headers: { location: loc } });

  it('a redirect to another slack.com host keeps credentials', async () => {
    const h = makeHttps((o, n) => (n === 0 ? redir('https://files-edge.slack.com/real') : ok200()));
    const r = await ss.downloadFileBounded(FILE, { https: h });
    expect(r.ok).toBe(true);
    expect(h.reqs[1].options.hostname).toBe('files-edge.slack.com');
    expect(h.reqs[1].options.headers.Authorization).toBe('Bearer ' + TOKEN);
  });

  it('a redirect to slack-edge.com / slack-files.com is followed WITHOUT Authorization or Cookie', async () => {
    for (const host of ['cdn.slack-edge.com', 'x.slack-files.com']) {
      const h = makeHttps((o, n) => (n === 0 ? redir('https://' + host + '/blob?sig=1') : ok200()));
      const r = await ss.downloadFileBounded(FILE, { https: h });
      expect(r.ok).toBe(true);
      expect(h.reqs[1].options.hostname).toBe(host);
      expect(h.reqs[1].options.headers).toEqual({});
    }
  });

  it('a relative redirect resolves against the current URL', async () => {
    const h = makeHttps((o, n) => (n === 0 ? redir('/other/path') : ok200()));
    const r = await ss.downloadFileBounded(FILE, { https: h });
    expect(r.ok).toBe(true);
    expect(h.reqs[1].options.hostname).toBe('files.slack.com');
    expect(h.reqs[1].options.path).toBe('/other/path');
  });

  it('redirects off Slack (including slack-imgs.com and http) are refused with no request', async () => {
    for (const loc of ['https://evil.example/x', 'https://slack-imgs.com/?url=x', 'http://files.slack.com/x', 'https://slack.com.evil.example/x']) {
      const h = makeHttps((o, n) => (n === 0 ? redir(loc) : ok200()));
      const r = await ss.downloadFileBounded(FILE, { https: h });
      expect(r).toEqual({ ok: false, reason: 'redirected off Slack' });
      expect(h.reqs).toHaveLength(1);
    }
  });

  it('at most 3 redirects are followed', async () => {
    let h = makeHttps((o, n) => (n < 3 ? redir('https://files.slack.com/r' + n) : ok200()));
    expect((await ss.downloadFileBounded(FILE, { https: h })).ok).toBe(true);
    expect(h.reqs).toHaveLength(4);
    h = makeHttps((o, n) => (n < 4 ? redir('https://files.slack.com/r' + n) : ok200()));
    expect(await ss.downloadFileBounded(FILE, { https: h })).toEqual({ ok: false, reason: 'too many redirects' });
  });
});

describe('T-SIZE: caps', () => {
  it('declared content-length over maxBytes: too-large, request destroyed, no body read', async () => {
    const h = makeHttps(() => ok200('x'.repeat(10), { 'content-length': '5000' }));
    const r = await ss.downloadFileBounded(FILE, { maxBytes: 1000, https: h });
    expect(r).toEqual({ ok: false, reason: 'too-large' });
    expect(h.reqs[0].destroyed).toBe(true);
  });
  it('streaming past maxBytes without content-length: too-large and destroyed, never truncated', async () => {
    const h = makeHttps(() => ({ status: 200, headers: { 'content-type': 'application/pdf' }, chunks: ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)] }));
    const r = await ss.downloadFileBounded(FILE, { maxBytes: 1000, https: h });
    expect(r).toEqual({ ok: false, reason: 'too-large' });
    expect(r.buffer).toBeUndefined();
    expect(h.reqs[0].destroyed).toBe(true);
  });
  it('exactly maxBytes is accepted in full', async () => {
    const h = makeHttps(() => ok200('z'.repeat(1000)));
    const r = await ss.downloadFileBounded(FILE, { maxBytes: 1000, https: h });
    expect(r.ok).toBe(true);
    expect(r.buffer.length).toBe(1000);
  });
});

describe('failure modes never throw', () => {
  it('non-200 after redirects reports HTTP <code>', async () => {
    for (const status of [404, 500, 429]) {
      const h = makeHttps(() => ({ status, headers: {} }));
      expect(await ss.downloadFileBounded(FILE, { https: h })).toEqual({ ok: false, reason: 'HTTP ' + status });
    }
  });
  it('timeout destroys the request', async () => {
    const h = makeHttps(() => ({ hang: true }));
    const r = await ss.downloadFileBounded(FILE, { timeoutMs: 40, https: h });
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(h.reqs[0].destroyed).toBe(true);
  });
  it('abort signal destroys the request; a pre-aborted signal makes no request', async () => {
    const ac = new AbortController();
    const h = makeHttps(() => ({ hang: true }));
    const p = ss.downloadFileBounded(FILE, { timeoutMs: 5000, signal: ac.signal, https: h });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
    expect(h.reqs[0].destroyed).toBe(true);
    const h2 = makeHttps(() => ok200());
    const pre = new AbortController(); pre.abort();
    expect(await ss.downloadFileBounded(FILE, { signal: pre.signal, https: h2 })).toEqual({ ok: false, reason: 'aborted' });
    expect(h2.reqs).toHaveLength(0);
  });
  it('network errors, a throwing transport, and bad input resolve to { ok:false }', async () => {
    const hErr = { reqs: [], request() { const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {}; req.end = () => setImmediate(() => req.emit('error', new Error('ECONNRESET'))); return req; } };
    expect((await ss.downloadFileBounded(FILE, { https: hErr })).ok).toBe(false);
    const hThrow = { request() { throw new Error('boom'); } };
    expect((await ss.downloadFileBounded(FILE, { https: hThrow })).ok).toBe(false);
    expect((await ss.downloadFileBounded(null, {})).ok).toBe(false);
    expect((await ss.downloadFileBounded(undefined)).ok).toBe(false);
    expect((await ss.downloadFileBounded({})).ok).toBe(false);
  });
});

describe('logging', () => {
  it('logs id, status, size and attempt only: never the token, cookie, or URL', async () => {
    const h = makeHttps((o, n) => (n === 0 ? { status: 403, headers: {} } : ok200('BYTES')));
    const r = await ss.downloadFileBounded(Object.assign({}, FILE, { url_private: FILE.url_private + '?t=SIGNEDQUERY' }), { https: h });
    expect(r.ok).toBe(true);
    const all = lines.join('');
    expect(all).toContain('bounded download id=F0ABC123 status=403 size=0 attempt=1');
    expect(all).toContain('bounded download id=F0ABC123 status=200 size=5 attempt=2');
    for (const secret of [TOKEN, 'TESTTOKEN', COOKIE, 'TESTCOOKIEVALUE', 'SIGNEDQUERY', 'files-pri', 'doc.pdf']) expect(all).not.toContain(secret);
  });
  it('an id that does not look like a Slack file id is not logged', async () => {
    const h = makeHttps(() => ok200());
    await ss.downloadFileBounded({ id: '../evil', mimetype: 'application/pdf', url_private: FILE.url_private }, { https: h });
    const all = lines.join('');
    expect(all).toContain('bounded download id=?');
    expect(all).not.toContain('evil');
  });
});
