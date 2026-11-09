// FEAT-A1 / AC-4, AC-5: cookie GET classification, allow-list, caps, timeout, and POST replay rules (incl. review F-5).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, flush, jwt } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TOKEN, SENTINEL_COOKIE, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const INFO = '/nws/recording/1.0/recording-info';
const LIST = '/rest/meeting/list';
const HOST = '/nws/recording/1.0/host-list';

let fx; let logger; let restoreE; let T; let S; let CDP;

function setup(net) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron({ net });
  restoreE = installFakeElectron(require, fx.electron);
  S = require('../src/zoom/data/session');
  T = require('../src/zoom/data/transport');
  CDP = require('../src/zoom/data/cdp-capture');
}

afterEach(() => {
  vi.useRealTimers();
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

describe('getJson classify table (§7.1)', () => {
  const rows = [
    ['2xx + status:true', { status: 200, body: { status: true, result: { a: 1 } } }, { ok: true }],
    ['2xx + sign-in message', { status: 200, body: { status: false, errorMessage: 'Please sign in again', errorCode: 201 } }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['2xx + session expired', { status: 200, body: { status: false, errorMessage: 'Session expired' } }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['2xx + other error', { status: 200, body: { status: false, errorMessage: 'SENTINEL_TOPIC nope', errorCode: 3001 } }, { ok: false, code: 'ZOOM_ERROR', errorCode: 3001 }],
    ['2xx non-JSON', { status: 200, body: '<html>SENTINEL_TOPIC</html>' }, { ok: false, code: 'SHAPE_UNRECOGNIZED' }],
    ['redirect to login', { status: 302, redirect: 'https://midway-auth.amazon.com/login?SENTINEL_URL' }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['redirect to /signin', { status: 302, redirect: 'https://amazon.zoom.us/signin' }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['redirect elsewhere', { status: 301, redirect: 'https://amazon.zoom.us/other' }, { ok: false, code: 'HTTP_ERROR', status: 301 }],
    ['401', { status: 401, body: '' }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['403', { status: 403, body: '' }, { ok: false, code: 'SIGN_IN_REQUIRED' }],
    ['429', { status: 429, body: '' }, { ok: false, code: 'THROTTLED' }],
    ['500', { status: 500, body: '' }, { ok: false, code: 'HTTP_ERROR', status: 500 }],
    ['404', { status: 404, body: '' }, { ok: false, code: 'HTTP_ERROR', status: 404 }],
    ['net error', { error: Object.assign(new Error('net::ERR_FAILED https://amazon.zoom.us/SENTINEL_URL'), { code: 'ERR_FAILED' }) }, { ok: false, code: 'NETWORK' }],
  ];
  for (const [name, script, want] of rows) {
    it(name, async () => {
      setup(() => script);
      const r = await T.getJson(INFO);
      expect(r).toMatchObject(want);
      expect(containsSentinel(r)).toBe(null);
      expect(containsSentinel(logger.text())).toBe(null);
      expect(r).not.toHaveProperty('error');
      expect(r).not.toHaveProperty('message');
    });
  }

  it('sends a cookie-only GET on the Zoom partition with redirect:manual', async () => {
    setup(() => ({ status: 200, body: { status: true, result: {} } }));
    await T.getJson(INFO);
    const req = fx.calls.net[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://amazon.zoom.us' + INFO);
    expect(req.options).toMatchObject({ useSessionCookies: true, credentials: 'include', redirect: 'manual' });
    expect(req.options.session.partition).toBe('persist:fleet-zoom');
    expect(req.headers.Accept).toMatch(/application\/json/);
    expect(req.headers).not.toHaveProperty('authorization');
  });

  it('rejects a path outside ALLOWED_GET before any request', async () => {
    setup(() => ({ status: 200, body: {} }));
    await expect(T.getJson('/rest/meeting/delete')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(T.getJson(LIST)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fx.calls.net.length).toBe(0);
    expect(fx.calls.fromPartition.length).toBe(0);
  });

  it('caps the body at GET_MAX_BYTES -> RESPONSE_TOO_LARGE and aborts', async () => {
    const big = Buffer.alloc(300 * 1024, 'a');
    setup(() => ({ status: 200, chunks: [big, big] }));
    const r = await T.getJson(INFO);
    expect(r.code).toBe('RESPONSE_TOO_LARGE');
    expect(fx.calls.net[0].aborted).toBe(true);
  });

  it('times out after NET_TIMEOUT_MS -> TIMEOUT', async () => {
    vi.useFakeTimers();
    setup(() => ({ hang: true }));
    const p = T.getJson(INFO);
    await flush();
    await vi.advanceTimersByTimeAsync(20_001);
    const r = await p;
    expect(r.code).toBe('TIMEOUT');
    expect(fx.calls.net[0].aborted).toBe(true);
  });

  it('logs one warn per failure with {op, path, code, status, ms} only', async () => {
    setup(() => ({ status: 500, body: 'SENTINEL_TOPIC' }));
    await T.getJson(INFO);
    const warns = logger.lines.filter((l) => l.level === 'warn');
    expect(warns.length).toBe(1);
    expect(Object.keys(warns[0].args[1]).sort()).toEqual(['code', 'ms', 'op', 'path', 'status']);
  });
});

async function seedCapture({ path = LIST, pageKind = 'upcoming', body = '{"kind":"upcoming","page":1}', headers = {} } = {}) {
  // Real hidden window + real capture, fed by fake CDP events.
  await S.withHiddenWindow(async () => {});
  const win = fx.windows[0];
  const cap = S.getCapture();
  cap.setPageKind(pageKind);
  win.webContents.debugger.emitRequest({
    requestId: 'x1', url: 'https://amazon.zoom.us' + path, method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8', 'zoom-csrftoken': SENTINEL_TOKEN + '-csrf' }, headers),
    postData: body,
  });
  await flush();
  cap.setTemplate(path, pageKind, { body, contentType: 'application/json;charset=UTF-8' });
  return cap;
}

describe('postReplay (§7.3, review F-5)', () => {
  it('replays the exact body with zoom-csrftoken, Origin, Referer and x-zm-csrf; no bearer when none captured', async () => {
    setup(() => ({ status: 200, body: { status: true, result: { list: [] } } }));
    const body = '{"pageSize":30,"type":"upcoming","weird":"\\u00e9 spacing  "}';
    await seedCapture({ body, headers: { 'x-zm-csrf': 'SENTINEL_TOKEN-xzm' } });
    fx.calls.net.length = 0;
    const r = await T.postReplay(LIST, 'upcoming');
    expect(r.ok).toBe(true);
    const req = fx.calls.net[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://amazon.zoom.us' + LIST);
    expect(req.body).toBe(body);
    expect(req.headers['zoom-csrftoken']).toBe(SENTINEL_TOKEN + '-csrf');
    expect(req.headers['x-zm-csrf']).toBe('SENTINEL_TOKEN-xzm');
    expect(req.headers.Origin).toBe('https://amazon.zoom.us');
    expect(req.headers.Referer).toBe('https://amazon.zoom.us/meeting#/upcoming');
    expect(req.headers['Content-Type']).toBe('application/json;charset=UTF-8');
    expect(req.headers).not.toHaveProperty('authorization');
    expect(req.options.redirect).toBe('manual');
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('sends the bearer only when captured for that exact path', async () => {
    setup(() => ({ status: 200, body: { status: true, result: { list: [] } } }));
    await seedCapture({ path: HOST, pageKind: 'recordings', headers: { authorization: jwt(3600) } });
    fx.calls.net.length = 0;
    await T.postReplay(HOST, 'recordings');
    expect(fx.calls.net[0].headers.authorization).toMatch(/^Bearer /);
    expect(fx.calls.net[0].headers.Referer).toBe('https://amazon.zoom.us/recording');
  });

  it('a bearer captured on another path is not sent', async () => {
    setup(() => ({ status: 200, body: { status: true, result: { list: [] } } }));
    const cap = await seedCapture({ path: LIST, pageKind: 'upcoming' });
    fx.windows[0].webContents.debugger.emitRequest({ requestId: 'x2', url: 'https://amazon.zoom.us' + HOST, method: 'POST', headers: { authorization: jwt(3600) }, postData: '{}' });
    await flush();
    expect(cap.headersFor(HOST).authorization).toBeTruthy();
    fx.calls.net.length = 0;
    await T.postReplay(LIST, 'upcoming');
    expect(fx.calls.net[0].headers).not.toHaveProperty('authorization');
  });

  it('expiring bearer (< 60 s) -> NEEDS_CAPTURE without a request', async () => {
    setup(() => ({ status: 200, body: { status: true, result: {} } }));
    await seedCapture({ path: HOST, pageKind: 'recordings', headers: { authorization: jwt(30) } });
    fx.calls.net.length = 0;
    const r = await T.postReplay(HOST, 'recordings');
    expect(r.code).toBe('NEEDS_CAPTURE');
    expect(fx.calls.net.length).toBe(0);
  });

  it('no template / no capture -> NEEDS_CAPTURE without a request', async () => {
    setup(() => ({ status: 200, body: {} }));
    expect((await T.postReplay(LIST, 'previous')).code).toBe('NEEDS_CAPTURE');
    expect(fx.calls.net.length).toBe(0);
  });

  for (const status of [401, 403]) {
    it('replay ' + status + ' -> replay disabled for path|pageKind + NEEDS_CAPTURE (never a sign-in state)', async () => {
      setup(() => ({ status, body: '' }));
      await seedCapture();
      fx.calls.net.length = 0;
      const r = await T.postReplay(LIST, 'upcoming');
      expect(r).toMatchObject({ ok: false, code: 'NEEDS_CAPTURE' });
      expect(CDP.isReplayDisabled(LIST, 'upcoming')).toBe(true);
      expect(CDP.isReplayDisabled(LIST, 'previous')).toBe(false);
      const again = await T.postReplay(LIST, 'upcoming');
      expect(again.code).toBe('NEEDS_CAPTURE');
      expect(fx.calls.net.length).toBe(1);
      const info = logger.lines.find((l) => l.level === 'info' && l.args[1] && l.args[1].op === 'replay-disabled');
      expect(info.args[1]).toMatchObject({ reason: 'rejected', path: LIST });
    });
  }

  it('replay disabled by the attribution guard -> NEEDS_CAPTURE immediately', async () => {
    setup(() => ({ status: 200, body: {} }));
    await seedCapture();
    CDP.disableReplay(LIST, 'attribution');
    fx.calls.net.length = 0;
    expect((await T.postReplay(LIST, 'upcoming')).code).toBe('NEEDS_CAPTURE');
    expect(fx.calls.net.length).toBe(0);
  });

  it('rejects a POST path outside ALLOWED_POST', async () => {
    setup(() => ({ status: 200, body: {} }));
    await expect(T.postReplay('/rest/meeting/delete', 'upcoming')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fx.calls.net.length).toBe(0);
  });

  it('cookie values are never logged', async () => {
    setup(() => ({ error: new Error('cookie ' + SENTINEL_COOKIE) }));
    await T.getJson(INFO);
    expect(containsSentinel(logger.text())).toBe(null);
  });
});
