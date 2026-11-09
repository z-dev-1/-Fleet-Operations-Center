// tests/email-api-http.test.js — transport/http.js on fake net.request (design 4.4; FR-1.6 to FR-1.9, AC-2, AC-4,
// AC-5, R4-L7, R4-M5). Fake clock; no network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { createFakeNet, fakeTokens } from './fixtures/email-api/fake-net.js';
import { createTokenWorld, jwt, mailboxSteps } from './fixtures/email-api/fake-token-window.js';
const require = createRequire(import.meta.url);
const { createHttp, parseRetryAfter } = require('../src/email-intel/transport/http');
const { createTokenSource } = require('../src/email-intel/transport/token-source');
const E = require('../src/email-intel/transport/errors');
const { TC } = require('../src/email-intel/transport/constants');
const ep = require('../src/email-intel/transport/endpoints');
const owaRe = require('../src/scrapers/owa-mailer');

const GET = (path, extra) => Object.assign({ op: 'get', method: 'GET', path: path || ep.probe(), timeoutMs: TC.GET_TIMEOUT_MS, maxBytes: TC.JSON_MAX_BYTES, retry: 'read' }, extra || {});
const FINAL = (extra) => Object.assign({ op: 'sendmail', method: 'POST', path: ep.sendMail(), body: { Message: {} }, timeoutMs: TC.POST_TIMEOUT_MS, maxBytes: 1024, retry: 'final' }, extra || {});
const sec = (ms) => Math.floor((Date.now() + ms) / 1000);
function mk(routes, tokens, extra) {
  const fn = createFakeNet(routes);
  const lines = [];
  const log = { info: (s) => lines.push(s), warn: (s) => lines.push(s) };
  const http = createHttp(Object.assign({ electron: fn.electron, tokens: tokens || fakeTokens(), owaRe, log }, extra || {}));
  return { fn, http, lines };
}
async function run(p, ms) {
  let out; let err; let done = false;
  p.then((v) => { out = v; done = true; }, (e) => { err = e; done = true; });
  await vi.advanceTimersByTimeAsync(ms == null ? 100 : ms);
  if (!done) throw new Error('still pending');
  if (err) throw err;
  return out;
}

beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-11-07T08:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

describe('wire format', () => {
  it('GETs on session.defaultSession with session cookies, manual redirects and auth headers; the host is the API host', async () => {
    const { fn, http, lines } = mk([{ re: /inbox/, respond: () => ({ status: 200, json: { value: [] } }) }]);
    const r = await run(http.request(GET()));
    expect(r).toEqual({ status: 200, json: { value: [] } });
    const c = fn.calls[0];
    expect(c.host).toBe('outlook.cloud.microsoft');
    expect(c.options).toEqual({ session: fn.electron.session.defaultSession, useSessionCookies: true, credentials: 'include', redirect: 'manual' });
    expect(c.headerNames.sort()).toEqual(['accept', 'authorization', 'x-anchormailbox']);
    expect(lines).toEqual([expect.stringMatching(/^\[email-api\] op=get status=200 ms=\d+ try=1$/)]);
    expect(lines.join('\n')).not.toMatch(/SENTINEL|api\/v2|mailfolders|inbox/);
  });

  it('refuses a path outside the allow-list before anything is sent', async () => {
    const { fn, http } = mk([]);
    await expect(http.request(GET('/api/beta/me/messages'))).rejects.toBeInstanceOf(E.RequestRefusedError);
    expect(fn.calls).toHaveLength(0);
  });
});

describe('401 handling', () => {
  it('AC-4 a 401 refreshes once and retries once; a second 401 raises ApiAuthBlockedError', async () => {
    const tokens = fakeTokens();
    const { fn, http } = mk([{ re: /inbox/, respond: (req) => ({ status: req.headers.authorization.endsWith('.1') ? 401 : 200, json: {} }) }], tokens);
    expect((await run(http.request(GET()))).status).toBe(200);
    expect(fn.calls).toHaveLength(2);
    expect(tokens.calls.refresh).toBe(1);
    const t2 = fakeTokens();
    const b = mk([{ re: /inbox/, respond: () => ({ status: 401 }) }], t2);
    await expect(run(b.http.request(GET()))).rejects.toBeInstanceOf(E.ApiAuthBlockedError);
    expect(b.fn.calls).toHaveLength(2);
    expect(t2.calls.refresh).toBe(1);
  });

  it('a redirect to a sign-in host counts as a 401; a refresh with the same generation raises without a second request', async () => {
    const tokens = fakeTokens({ refreshSame: true });
    const { fn, http } = mk([{ re: /inbox/, respond: () => ({ status: 302, redirect: 'https://login.microsoftonline.com/common/oauth2/authorize' }) }], tokens);
    await expect(run(http.request(GET()))).rejects.toBeInstanceOf(E.ApiAuthBlockedError);
    expect(fn.calls).toHaveLength(1);
    expect(tokens.calls.alternate).toBe(1);
  });

  it('R4-L7 a same-gen 401 retries once with a different-rank capture before ApiAuthBlockedError', async () => {
    const tokens = fakeTokens({ refreshSame: true, alternate: true });
    const { fn, http } = mk([{ re: /inbox/, respond: (req) => ({ status: /ALT/.test(req.headers.authorization) ? 200 : 401, json: { ok: 1 } }) }], tokens);
    const r = await run(http.request(GET()));
    expect(r.status).toBe(200);
    expect(fn.calls).toHaveLength(2);
    expect(tokens.calls.alternate).toBe(1);
  });

  it('R4-L7 a second 401 after the alternate raises ApiAuthBlockedError', async () => {
    const tokens = fakeTokens({ refreshSame: true, alternate: true });
    const { fn, http } = mk([{ re: /inbox/, respond: () => ({ status: 401 }) }], tokens);
    await expect(run(http.request(GET()))).rejects.toBeInstanceOf(E.ApiAuthBlockedError);
    expect(fn.calls).toHaveLength(2);
  });

  it('AC-2 four concurrent 401s on one token open one window and retry 4 times with gen 2', async () => {
    let w = 0;
    const world = createTokenWorld({ steps: () => { w++; return mailboxSteps({ rank: 3, token: jwt(sec(3600_000), 'w' + w) }); } });
    const tokens = createTokenSource({ electron: world.electron, owaRe, log: { info() {}, warn() {} } });
    const first = await run(tokens.getAuth(), 1000);
    const { fn, http } = mk([{ re: /inbox/, respond: (req) => ({ status: req.headers.authorization === first.headers.authorization ? 401 : 200, json: {}, delayMs: 50 }) }], tokens);
    const ps = [1, 2, 3, 4].map(() => http.request(GET()));
    await vi.advanceTimersByTimeAsync(2000);
    const rs = await Promise.all(ps);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(world.created()).toBe(2);                     // the initial capture + exactly one refresh window
    expect(fn.calls).toHaveLength(8);
    expect(tokens.peek().gen).toBe(2);
  });

  it('FR-1.6 a late 401 on an older gen keeps the newer token', async () => {
    let w = 0;
    const world = createTokenWorld({ steps: () => { w++; return mailboxSteps({ rank: 3, token: jwt(sec(3600_000), 'w' + w) }); } });
    const tokens = createTokenSource({ electron: world.electron, owaRe, log: { info() {}, warn() {} } });
    const first = await run(tokens.getAuth(), 1000);
    const { http } = mk([
      { re: /slow/, respond: (req) => ({ status: req.headers.authorization === first.headers.authorization ? 401 : 200, json: {}, delayMs: 5000 }) },
      { re: /inbox/, respond: (req) => ({ status: req.headers.authorization === first.headers.authorization ? 401 : 200, json: {} }) },
    ], tokens);
    const slow = http.request(GET(ep.message('slow')));
    await vi.advanceTimersByTimeAsync(10);
    const fast = await run(http.request(GET()), 1000);   // 401 -> refresh -> gen 2
    expect(fast.status).toBe(200);
    expect(tokens.peek().gen).toBe(2);
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await slow).status).toBe(200);               // retried with gen 2; gen 2 not discarded
    expect(tokens.peek().gen).toBe(2);
    expect(world.created()).toBe(2);
  });

  it('a final POST on 401 is never retried and is definitive-not-sent', async () => {
    const tokens = fakeTokens();
    const { fn, http } = mk([{ re: /sendmail/, respond: () => ({ status: 401 }) }], tokens);
    await expect(run(http.request(FINAL()))).rejects.toMatchObject({ name: 'ApiAuthBlockedError', definitiveNotSent: true });
    expect(fn.calls).toHaveLength(1);
    expect(tokens.calls.getAuth).toBe(0);
    expect(tokens.calls.peek).toBe(1);
  });
});

describe('throttling', () => {
  it('AC-5 429 Retry-After seconds waits and retries', async () => {
    let n = 0;
    const sleeps = [];
    const sleep = (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, ms)); };
    const { fn, http } = mk([{ re: /inbox/, respond: () => (++n === 1 ? { status: 429, headers: { 'Retry-After': '7' } } : { status: 200, json: {} }) }], null, { sleep });
    const p = http.request(GET());
    await vi.advanceTimersByTimeAsync(6900);
    expect(fn.calls).toHaveLength(1);
    expect(http.pausedUntil()).toBeGreaterThan(Date.now());
    const r = await run(p, 200);
    expect(r.status).toBe(200);
    expect(sleeps).toEqual([7000]);
    expect(fn.calls).toHaveLength(2);
  });

  it('AC-5 HTTP-date Retry-After is honoured and capped at 60 s', () => {
    const now = Date.now();
    expect(parseRetryAfter(new Date(now + 12_000).toUTCString(), now)).toBe(12_000);
    expect(parseRetryAfter(new Date(now + 3600_000).toUTCString(), now)).toBe(TC.RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('120', now)).toBe(TC.RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter(['3'], now)).toBe(3000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  });

  it('without Retry-After the backoff is exponential and 3 tries end in ThrottledError; 503 behaves the same', async () => {
    const sleeps = [];
    const sleep = (ms) => { sleeps.push(ms); return new Promise((r) => setTimeout(r, ms)); };
    const { fn, http } = mk([{ re: /inbox/, respond: () => ({ status: 429 }) }], null, { sleep });
    await expect(run(http.request(GET()), 10_000)).rejects.toMatchObject({ name: 'ThrottledError', status: 429 });
    expect(fn.calls).toHaveLength(TC.THROTTLE_MAX_TRIES);
    expect(sleeps).toEqual([TC.BACKOFF_BASE_MS, TC.BACKOFF_BASE_MS * 2]);
    const b = mk([{ re: /inbox/, respond: () => ({ status: 503 }) }]);
    await expect(run(b.http.request(GET()), 10_000)).rejects.toMatchObject({ name: 'ThrottledError', status: 503 });
  });

  it('a throttled GET releases its slot while sleeping; the shared gate holds later requests', async () => {
    let n = 0;
    const { fn, http } = mk([
      { re: /messages\/A/, respond: () => (++n === 1 ? { status: 429, headers: { 'retry-after': '5' }, delayMs: 10 } : { status: 200, json: { a: 1 } }) },
      { re: /messages\/B/, respond: () => ({ status: 200, json: { b: 1 }, delayMs: 20 }) },
    ], null, { maxInflight: 1 });
    const a = http.request(GET(ep.message('A')));
    const b = http.request(GET(ep.message('B')));            // queued on the single slot before the 429
    await vi.advanceTimersByTimeAsync(100);
    expect(fn.calls.map((c) => c.path.split('?')[0].split('/').pop())).toEqual(['A', 'B']);
    expect((await b).json).toEqual({ b: 1 });              // completed while A slept
    expect(http._stats().inflight).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await a).json).toEqual({ a: 1 });
  });

  it('AC-5 a final send POST on 429 is never retried', async () => {
    const { fn, http } = mk([{ re: /sendmail/, respond: () => ({ status: 429, headers: { 'retry-after': '1' } }) }]);
    await expect(run(http.request(FINAL()), 5000)).rejects.toMatchObject({ name: 'ThrottledError', definitiveNotSent: true });
    expect(fn.calls).toHaveLength(1);
  });

  it('a final POST while the gate is paused fails before writing; it never waits', async () => {
    let n = 0;
    const { fn, http } = mk([
      { re: /inbox/, respond: () => (++n === 1 ? { status: 429, headers: { 'retry-after': '30' } } : { status: 200, json: {} }) },
      { re: /sendmail/, respond: () => ({ status: 202 }) },
    ]);
    const g = http.request(GET());
    await vi.advanceTimersByTimeAsync(10);
    expect(http.pausedUntil()).toBeGreaterThan(0);
    await expect(http.request(FINAL())).rejects.toMatchObject({ name: 'ThrottledError', definitiveNotSent: true });
    expect(fn.calls.filter((c) => /sendmail/.test(c.path))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(31_000);
    await g;
  });
});

describe('bounds', () => {
  it('FR-1.9 MAX_INFLIGHT semaphore, per-request timeout and byte-cap abort', async () => {
    const { fn, http } = mk([
      { re: /messages\/HANG/, respond: () => ({ hang: true }) },
      { re: /messages\/BIG/, respond: () => ({ status: 200, chunks: ['{"a":"', 'x'.repeat(2000), '"}'] }) },
      { re: /sendmail/, respond: () => ({ status: 202 }) },
      { re: /inbox/, respond: () => ({ status: 200, json: {} }) },
    ]);
    const hangs = [1, 2, 3, 4].map(() => http.request(GET(ep.message('HANG'))));
    hangs.forEach((p) => p.catch(() => {}));
    await vi.advanceTimersByTimeAsync(10);
    expect(http._stats().inflight).toBe(TC.MAX_INFLIGHT);
    const queued = http.request(GET());
    await vi.advanceTimersByTimeAsync(10);
    expect(fn.calls.filter((c) => /inbox/.test(c.path))).toHaveLength(0);   // a read still queues
    const fin = await run(http.request(FINAL()), 10);                        // a final bypasses the semaphore
    expect(fin.status).toBe(202);
    await vi.advanceTimersByTimeAsync(TC.GET_TIMEOUT_MS * 2 + 100);          // timeout + one retry each
    for (const p of hangs) await expect(p).rejects.toBeInstanceOf(E.ApiTimeoutError);
    expect((await queued).status).toBe(200);
    await expect(run(http.request(GET(ep.message('BIG'), { maxBytes: 500 })))).rejects.toBeInstanceOf(E.ResponseTooLargeError);
  });

  it('a 500 is retried once for reads, never for writes; error JSON contributes only a sanitized apiCode', async () => {
    let n = 0;
    const { fn, http } = mk([
      { re: /inbox/, respond: () => ({ status: (++n === 1 ? 500 : 200), json: {} }) },
      { re: /move/, respond: () => ({ status: 500, json: { error: { code: 'ErrorInternal', message: 'SENTINEL secret text' } } }) },
      { re: /messages\/X\?/, respond: () => ({ status: 404, json: { error: { code: 'bad code; drop table', message: 'x' } } }) },
    ]);
    expect((await run(http.request(GET()), 2000)).status).toBe(200);
    await expect(run(http.request({ op: 'move', method: 'POST', path: ep.move('M'), body: { DestinationId: 'deleteditems' }, retry: 'write' }))).rejects.toMatchObject({ name: 'ApiHttpError', status: 500, apiCode: 'ErrorInternal' });
    expect(fn.calls.filter((c) => /move/.test(c.path))).toHaveLength(1);
    const e = await run(http.request(GET(ep.message('X'))).catch((x) => x));
    expect(e).toMatchObject({ name: 'ApiHttpError', status: 404, apiCode: 'Unknown' });
    expect(String(e.message)).not.toMatch(/SENTINEL|drop/);
  });

  it('R4-M5 no attempt starts at or after deadlineAt (AbortedError deadline, zero requests)', async () => {
    const { fn, http } = mk([{ re: /inbox/, respond: () => ({ status: 200, json: {} }) }]);
    await expect(http.request(GET(undefined, { deadlineAt: Date.now() }))).rejects.toMatchObject({ name: 'AbortedError', reason: 'deadline' });
    await expect(http.request(GET(undefined, { deadlineAt: Date.now() - 1 }))).rejects.toMatchObject({ reason: 'deadline' });
    expect(fn.calls).toHaveLength(0);
    // a throttle wait that would pass the deadline fails instead of sleeping
    const b = mk([{ re: /inbox/, respond: () => ({ status: 429, headers: { 'retry-after': '30' } }) }]);
    await expect(run(b.http.request(GET(undefined, { deadlineAt: Date.now() + 10_000 })))).rejects.toBeInstanceOf(E.ThrottledError);
    expect(b.fn.calls).toHaveLength(1);
  });

  it('R4-M5 per-attempt timeout is clamped to deadlineAt', async () => {
    const { fn, http } = mk([{ re: /inbox/, respond: () => ({ status: 200, json: {}, delayMs: 19_000 }) }]);
    const p = http.request(GET(undefined, { deadlineAt: Date.now() + 5_000 }));
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(p).rejects.toMatchObject({ name: 'ApiTimeoutError', reason: 'deadline' });
    expect(fn.calls).toHaveLength(1);                    // no retry past the deadline
  });

  it('an abort signal stops queued and in-flight requests', async () => {
    const ac = new AbortController();
    const { http } = mk([{ re: /inbox/, respond: () => ({ hang: true }) }]);
    const p = http.request(GET(undefined, { signal: ac.signal }));
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).rejects.toBeInstanceOf(E.AbortedError);
  });
});
