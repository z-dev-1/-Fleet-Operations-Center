// DTNA Phase C: src/dtna/session-time.js — SessionTimeServlet parser, read() and the pre-flight.
// fetch and session are fakes; nothing reaches the network.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { freshDtna } from './fixtures/dtna/fake-electron.js';
import { SENTINEL_TOKEN, SENTINEL_EMAIL, SENTINEL_COOKIE } from './fixtures/dtna/sentinels.js';

const require = createRequire(import.meta.url);
let logger;
let st;
let C;
beforeAll(() => {
  logger = installFakeLogger(require);
  freshDtna(require);
  st = require('../src/dtna/session-time.js');
  C = require('../src/dtna/constants.js');
});
afterAll(() => { logger.restore(); freshDtna(require); });

const BODY = (sr, sp = 28800, extra = '') => 'while(1);{"sp":' + sp + ',"sr":' + sr + extra + '}';
function res(status, body, o = {}) {
  return { status, type: o.type || 'basic', headers: { get: (k) => (String(k).toLowerCase() === 'location' ? (o.location || null) : (String(k).toLowerCase() === 'set-cookie' ? 'sid=' + SENTINEL_COOKIE : null)) }, text: async () => body };
}
let session;
function deps(fetch) {
  session = { noteSessionTime: vi.fn(), getSession: () => { throw new Error('must not be used when fetch is injected'); } };
  st._setDeps({ fetch, session, now: () => 1700000000000 });
}

beforeEach(() => { st._resetForTests(); logger.clear(); });

describe('parseSessionTime', () => {
  it('strips while(1); and returns integer seconds', () => {
    expect(st.parseSessionTime('while(1);{"sp":28800,"sr":27123.7}')).toEqual({ ok: true, remainingSec: 27123, periodSec: 28800 });
    expect(st.parseSessionTime('  {"sp":28800,"sr":60}  ')).toEqual({ ok: true, remainingSec: 60, periodSec: 28800 });
    expect(st.parseSessionTime(BODY(-5))).toEqual({ ok: true, remainingSec: 0, periodSec: 28800 });
  });
  it('missing / non-numeric fields and garbage -> DTNA_SHAPE', () => {
    for (const t of ['', null, 'while(1);', 'while(1);{"sp":28800}', '{"sr":"100","sp":28800}', '{"sr":100,"sp":null}', '[1,2]', '<html>', 'x'.repeat(5000), BODY('1e999')]) {
      expect(st.parseSessionTime(t)).toEqual({ ok: false, code: 'DTNA_SHAPE' });
    }
  });
  it('returns exactly the two integers; an id token or email in the body never comes back', () => {
    const r = st.parseSessionTime(BODY(500, 28800, ',"oidcIdToken":"' + SENTINEL_TOKEN + '","email":"' + SENTINEL_EMAIL + '"'));
    expect(Object.keys(r).sort()).toEqual(['ok', 'periodSec', 'remainingSec']);
    expect(JSON.stringify(r)).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(r)).not.toContain(SENTINEL_EMAIL);
  });
});

describe('read()', () => {
  it('200: GETs SESSION_TIME_URL?buster= with redirect manual; notes integers only; logs no URL or body', async () => {
    const fetch = vi.fn(async () => res(200, BODY(27120.9, 28800, ',"oidcIdToken":"' + SENTINEL_TOKEN + '"')));
    deps(fetch);
    const r = await st.read();
    expect(r).toEqual({ ok: true, remainingSec: 27120, periodSec: 28800, expired: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url.startsWith(C.SESSION_TIME_URL + '?buster=')).toBe(true);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'manual' });
    expect(init.body).toBeUndefined();
    expect(session.noteSessionTime).toHaveBeenCalledWith({ remainingSec: 27120, periodSec: 28800 });
    const t = logger.text();
    expect(t).toContain('[dtna] session-time');
    expect(t).not.toContain('SessionTimeServlet');
    expect(t).not.toContain('while(1)');
    expect(t).not.toContain(SENTINEL_TOKEN);
    expect(t).not.toContain(SENTINEL_COOKIE);
  });

  it('sr <= 0 -> expired', async () => {
    deps(vi.fn(async () => res(200, BODY(0))));
    expect(await st.read()).toEqual({ ok: true, remainingSec: 0, periodSec: 28800, expired: true });
  });

  it('302 to a login host, 401 and opaqueredirect -> expired; other 3xx / 5xx -> DTNA_HTTP_ERROR', async () => {
    const expired = { ok: true, remainingSec: 0, periodSec: null, expired: true };
    deps(vi.fn(async () => res(302, '', { location: 'https://login.ciam.daimlertruck.com/authorize?x=' + SENTINEL_TOKEN })));
    expect(await st.read()).toEqual(expired);
    deps(vi.fn(async () => res(401, '')));
    expect(await st.read()).toEqual(expired);
    deps(vi.fn(async () => res(0, '', { type: 'opaqueredirect' })));
    expect(await st.read()).toEqual(expired);
    deps(vi.fn(async () => res(302, '', { location: 'https://dtna.my.site.com/elsewhere' })));
    expect(await st.read()).toEqual({ ok: false, code: 'DTNA_HTTP_ERROR' });
    deps(vi.fn(async () => res(500, 'oops ' + SENTINEL_TOKEN)));
    expect(await st.read()).toEqual({ ok: false, code: 'DTNA_HTTP_ERROR' });
    expect(session.noteSessionTime).not.toHaveBeenCalled();
    expect(logger.text()).not.toContain(SENTINEL_TOKEN);
  });

  it('200 with a bad body -> DTNA_SHAPE, nothing noted', async () => {
    deps(vi.fn(async () => res(200, '<html>' + SENTINEL_EMAIL + '</html>')));
    expect(await st.read()).toEqual({ ok: false, code: 'DTNA_SHAPE' });
    expect(session.noteSessionTime).not.toHaveBeenCalled();
    expect(logger.text()).not.toContain(SENTINEL_EMAIL);
  });

  it('abort -> DTNA_TIMEOUT; throw -> DTNA_NETWORK (no message logged)', async () => {
    deps(vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    expect(await st.read()).toEqual({ ok: false, code: 'DTNA_TIMEOUT' });
    deps(vi.fn(async () => { throw new Error('net::ERR_FAILED ' + SENTINEL_COOKIE); }));
    expect(await st.read()).toEqual({ ok: false, code: 'DTNA_NETWORK' });
    expect(logger.text()).not.toContain(SENTINEL_COOKIE);
  });

  it('times out after SESSION_TIME_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      deps(vi.fn((_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))); })));
      const p = st.read();
      await vi.advanceTimersByTimeAsync(C.SESSION_TIME_TIMEOUT_MS);
      expect(await p).toEqual({ ok: false, code: 'DTNA_TIMEOUT' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('preflight()', () => {
  it('blocks below 120 s and when expired; passes at 120 s', async () => {
    deps(vi.fn(async () => res(200, BODY(119))));
    expect(await st.preflight()).toEqual({ block: true, code: 'DTNA_SESSION_LOW', remainingSec: 119 });
    deps(vi.fn(async () => res(200, BODY(120))));
    expect(await st.preflight()).toEqual({ block: false, remainingSec: 120 });
    deps(vi.fn(async () => res(401, '')));
    expect(await st.preflight()).toEqual({ block: true, code: 'DTNA_SESSION_LOW', remainingSec: 0 });
    deps(vi.fn(async () => res(200, BODY(500))));
    expect(await st.preflight(600)).toMatchObject({ block: true, remainingSec: 500 });
  });
  it('fails open when the read fails', async () => {
    deps(vi.fn(async () => { throw new Error('down'); }));
    expect(await st.preflight()).toEqual({ block: false, remainingSec: null });
    deps(vi.fn(async () => res(200, 'garbage')));
    expect(await st.preflight()).toEqual({ block: false, remainingSec: null });
  });
});
