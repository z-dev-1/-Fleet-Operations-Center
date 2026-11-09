// FEAT-A1 / design §7.2 + §20 row: passive CDP capture (memory only) and captureList policy.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, flush, settle, portalScript, jwt,
} from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TOKEN, SENTINEL_TOPIC, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const LIST = '/rest/meeting/list';
const HOST = '/nws/recording/1.0/host-list';
const UP = 'https://amazon.zoom.us/meeting#/upcoming';
const PREV = 'https://amazon.zoom.us/meeting#/previous';
const REC = 'https://amazon.zoom.us/recording';

let fx; let logger; let restoreE; let S; let CDP;

function setup(opts = {}) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron(opts);
  restoreE = installFakeElectron(require, fx.electron);
  S = require('../src/zoom/data/session');
  S._setDeps({ seeder: { seedOrLegacy: async () => ({}) }, auth: { injectCookies: async () => {} } });
  CDP = require('../src/zoom/data/cdp-capture');
}

afterEach(() => {
  vi.useRealTimers();
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

const meetings = (n, kind = 'u') => ({
  status: true,
  result: { list: Array.from({ length: n }, (_, i) => ({ meetingId: '9' + String(i).padStart(9, '0'), topic: SENTINEL_TOPIC + kind + i, startTime: '2026-11-1' + (i % 9) + 'T15:00:00Z', duration: 30 })) },
});

function bareCapture() {
  const { EventEmitter } = require('node:events');
  const wc = new EventEmitter();
  const dbg = new EventEmitter();
  dbg.attached = false;
  dbg.attach = () => { dbg.attached = true; };
  dbg.isAttached = () => dbg.attached;
  dbg.detach = () => { dbg.attached = false; };
  dbg.bodies = new Map();
  dbg.postData = new Map();
  dbg.commands = [];
  dbg.sendCommand = async (m, p) => {
    dbg.commands.push(m);
    if (m === 'Network.getResponseBody') { if (!dbg.bodies.has(p.requestId)) throw new Error('nope ' + SENTINEL_TOPIC); return dbg.bodies.get(p.requestId); }
    if (m === 'Network.getRequestPostData') { if (!dbg.postData.has(p.requestId)) throw new Error('no post data'); return { postData: dbg.postData.get(p.requestId) }; }
    return {};
  };
  wc.debugger = dbg;
  const req = (requestId, url, o = {}) => dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId, request: Object.assign({ url, method: 'POST', headers: {} }, o) });
  const res = (requestId, body, o = {}) => {
    dbg.bodies.set(requestId, { body: typeof body === 'string' ? body : JSON.stringify(body), base64Encoded: false });
    dbg.emit('message', {}, 'Network.loadingFinished', Object.assign({ requestId }, o));
  };
  const cap = CDP.createCapture(wc);
  cap.attach();
  return { cap, dbg, req, res };
}

describe('createCapture', () => {
  it('keeps zoom-csrftoken / x-zm-csrf / authorization values (case-insensitive) per path, memory only', async () => {
    setup();
    const { cap, req } = bareCapture();
    cap.setPageKind('upcoming');
    req('1', 'https://amazon.zoom.us' + LIST, { headers: { 'Zoom-CsrfToken': SENTINEL_TOKEN, 'X-ZM-CSRF': 'x', Cookie: 'c=1', 'User-Agent': 'ua' }, postData: '{}' });
    expect(cap.headersFor(LIST)).toEqual({ 'zoom-csrftoken': SENTINEL_TOKEN, 'x-zm-csrf': 'x' });
    const d = cap.describe();
    expect(d.headerNames[LIST]).toEqual(['x-zm-csrf', 'zoom-csrftoken']);
    expect(containsSentinel(d)).toBe(null);
  });

  it('ignores non-Zoom hosts and paths outside the allow-lists', async () => {
    setup();
    const { cap, req } = bareCapture();
    req('1', 'https://evil.test' + LIST, { headers: { 'zoom-csrftoken': 'a' }, postData: '{}' });
    req('2', 'https://amazon.zoom.us/rest/meeting/delete', { headers: { 'zoom-csrftoken': 'b' }, postData: '{}' });
    req('3', 'https://amazon.zoom.us.evil.test' + LIST, { headers: { 'zoom-csrftoken': 'c' }, postData: '{}' });
    expect(cap.headersFor(LIST)).toEqual({});
    expect(cap.headersFor('/rest/meeting/delete')).toEqual({});
  });

  it('collects bodies by pageKind via getResponseBody; secondsLeft from the JWT exp only', async () => {
    setup();
    const { cap, req, res, dbg } = bareCapture();
    cap.setPageKind('recordings');
    req('9', 'https://amazon.zoom.us' + HOST, { headers: { authorization: jwt(600) }, postData: '{"p":1}' });
    res('9', { status: true, result: { recordings: [] } });
    await flush();
    expect(dbg.commands).toContain('Network.getResponseBody');
    expect(cap.count(HOST, 'recordings')).toBe(1);
    expect(cap.count(HOST, 'upcoming')).toBe(0);
    expect(cap.collected(HOST, 'recordings')[0].template).toEqual({ body: '{"p":1}', contentType: 'application/json' });
    const left = cap.secondsLeft(HOST);
    expect(left).toBeGreaterThan(590);
    expect(left).toBeLessThanOrEqual(600);
  });

  it('a body over CAPTURE_BODY_MAX_BYTES is dropped as RESPONSE_TOO_LARGE', async () => {
    setup();
    const { cap, req, res } = bareCapture();
    cap.setPageKind('upcoming');
    req('1', 'https://amazon.zoom.us' + LIST, { postData: '{}' });
    res('1', '"' + 'a'.repeat(2 * 1024 * 1024 + 10) + '"');
    await flush();
    expect(cap.collected(LIST, 'upcoming')[0]).toEqual({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('truncated JSON records SHAPE_UNRECOGNIZED and never throws out of the listener', async () => {
    setup();
    const { cap, req, res } = bareCapture();
    cap.setPageKind('upcoming');
    req('1', 'https://amazon.zoom.us' + LIST, { postData: '{}' });
    expect(() => res('1', '{"status":true,"result":{"list":[{"topic":"' + SENTINEL_TOPIC)).not.toThrow();
    await flush();
    expect(cap.collected(LIST, 'upcoming')[0]).toEqual({ code: 'SHAPE_UNRECOGNIZED' });
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('a getResponseBody rejection is contained and logged as safeErr only', async () => {
    setup();
    const { cap, dbg } = bareCapture();
    cap.setPageKind('upcoming');
    dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'r', request: { url: 'https://amazon.zoom.us' + LIST, method: 'POST', headers: {}, postData: '{}' } });
    dbg.emit('message', {}, 'Network.loadingFinished', { requestId: 'r' });
    await flush();
    expect(cap.collected(LIST, 'upcoming')[0]).toEqual({ code: 'CAPTURE_FAILED' });
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('a throwing listener body is contained', () => {
    setup();
    const { dbg } = bareCapture();
    expect(() => dbg.emit('message', {}, 'Network.requestWillBeSent', { get request() { throw new Error(SENTINEL_TOPIC); } })).not.toThrow();
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('hasPostData without postData -> getRequestPostData; failure -> no template', async () => {
    setup();
    const { cap, req, res, dbg } = bareCapture();
    cap.setPageKind('upcoming');
    dbg.postData.set('ok', '{"via":"cdp"}');
    req('ok', 'https://amazon.zoom.us' + LIST, { hasPostData: true });
    res('ok', meetings(1));
    req('bad', 'https://amazon.zoom.us' + LIST, { hasPostData: true });
    res('bad', meetings(1));
    await flush(20);
    const c = cap.collected(LIST, 'upcoming');
    expect(dbg.commands.filter((m) => m === 'Network.getRequestPostData').length).toBe(2);
    expect(c[0].template).toEqual({ body: '{"via":"cdp"}', contentType: 'application/json' });
    expect(c[1].value).toBeTruthy();
    expect(c[1].template).toBe(null);
  });

  it('clear() nulls every captured value', async () => {
    setup();
    const { cap, req, res } = bareCapture();
    cap.setPageKind('upcoming');
    req('1', 'https://amazon.zoom.us' + LIST, { headers: { 'zoom-csrftoken': 't' }, postData: '{}' });
    res('1', meetings(1));
    await flush();
    cap.setTemplate(LIST, 'upcoming', { body: '{}' });
    cap.clear();
    expect(cap.headersFor(LIST)).toEqual({});
    expect(cap.template(LIST, 'upcoming')).toBe(null);
    expect(cap.count(LIST, 'upcoming')).toBe(0);
  });
});

describe('captureList', () => {
  it('loads about:blank then the page, collects until quiet and picks the response with the most items', async () => {
    vi.useFakeTimers();
    const script = portalScript({
      pages: {
        [UP]: [
          { path: LIST, postData: '{"personal":true}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN }, body: meetings(1) },
          { path: LIST, postData: '{"type":"upcoming"}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN }, body: meetings(3) },
        ],
      },
    });
    const loads = [];
    setup({ urlFor: script.urlFor, onLoad: (w, u) => { loads.push(u); script.onLoad(w, u); } });
    const r = await settle(vi, CDP.captureList('upcoming'));
    expect(r.ok).toBe(true);
    expect(r.mapped.items.length).toBe(3);
    expect(loads).toEqual(['about:blank', UP]);
    const cap = S.getCapture();
    expect(cap.template(LIST, 'upcoming')).toEqual({ body: '{"type":"upcoming"}', contentType: 'application/json;charset=UTF-8' });
    expect(containsSentinel(logger.text())).toBe(null);
    // Debugger attached before the first loadURL.
    expect(fx.windows[0].webContents.debugger.version).toBe('1.3');
  });

  it('identical upcoming/previous bodies -> replay disabled for the path, hasTemplate:false', async () => {
    vi.useFakeTimers();
    const same = '{"same":1}';
    const script = portalScript({
      pages: {
        [UP]: [{ path: LIST, postData: same, headers: { 'zoom-csrftoken': 't' }, body: meetings(2) }],
        [PREV]: [{ path: LIST, postData: same, headers: { 'zoom-csrftoken': 't' }, body: meetings(2, 'p') }],
      },
    });
    setup(script);
    expect((await settle(vi, CDP.captureList('upcoming'))).ok).toBe(true);
    expect(CDP.isReplayDisabled(LIST, 'upcoming')).toBe(false);
    expect((await settle(vi, CDP.captureList('previous'))).ok).toBe(true);
    expect(CDP.isReplayDisabled(LIST, 'upcoming')).toBe(true);
    expect(CDP.isReplayDisabled(LIST, 'previous')).toBe(true);
    const d = S.getCapture().describe();
    expect(d.hasTemplate[LIST + '|upcoming']).toBe(false);
    expect(d.hasTemplate[LIST + '|previous']).toBe(false);
    expect(logger.lines.some((l) => l.args[1] && l.args[1].op === 'replay-disabled' && l.args[1].path === LIST)).toBe(true);
  });

  it('different bodies keep replay enabled', async () => {
    vi.useFakeTimers();
    const script = portalScript({
      pages: {
        [UP]: [{ path: LIST, postData: '{"t":"u"}', headers: { 'zoom-csrftoken': 't' }, body: meetings(2) }],
        [PREV]: [{ path: LIST, postData: '{"t":"p"}', headers: { 'zoom-csrftoken': 't' }, body: meetings(2, 'p') }],
      },
    });
    setup(script);
    await settle(vi, CDP.captureList('upcoming'));
    await settle(vi, CDP.captureList('previous'));
    expect(CDP.isReplayDisabled(LIST, 'upcoming')).toBe(false);
    expect(S.getCapture().describe().hasTemplate[LIST + '|previous']).toBe(true);
  });

  it('no matching response -> CAPTURE_TIMEOUT; challenge seen -> SSO_WALL', async () => {
    vi.useFakeTimers();
    setup(portalScript({ pages: {} }));
    expect((await settle(vi, CDP.captureList('recordings'))).code).toBe('CAPTURE_TIMEOUT');
    S._resetForTests(); restoreE(); logger.restore(); freshZoom(require);
    const base = portalScript({ pages: {} });
    setup({
      urlFor: base.urlFor,
      onLoad: (w, u) => { if (u === REC) w.webContents.debugger.emitRequest({ requestId: 'c', url: 'https://amazon.zoom.us/cdn-cgi/challenge-platform/h/b', method: 'GET' }); },
    });
    expect((await settle(vi, CDP.captureList('recordings'))).code).toBe('SSO_WALL');
  });

  it('a page that stays on the sign-in host -> SIGN_IN_REQUIRED', async () => {
    vi.useFakeTimers();
    setup(portalScript({ signedIn: false, pages: {} }));
    const r = await settle(vi, CDP.captureList('upcoming'));
    expect(r.code).toBe('SIGN_IN_REQUIRED');
    const info = logger.lines.find((l) => l.args[1] && l.args[1].code === 'SIGN_IN_REQUIRED');
    expect(info.args[1].lastHostKind).toBe('auth');
  });

  it('only unmappable bodies -> SHAPE_UNRECOGNIZED (no template stored)', async () => {
    vi.useFakeTimers();
    setup(portalScript({ pages: { [UP]: [{ path: LIST, postData: '{}', headers: { 'zoom-csrftoken': 't' }, body: { status: true, result: { weird: { x: 1 } } } }] } }));
    const r = await settle(vi, CDP.captureList('upcoming'));
    expect(r.code).toBe('SHAPE_UNRECOGNIZED');
    expect(S.getCapture().template(LIST, 'upcoming')).toBe(null);
  });

  it('debugger attach failure -> CAPTURE_FAILED', async () => {
    vi.useFakeTimers();
    setup(Object.assign(portalScript({ pages: {} }), { attachThrows: true, attachThrowsMessage: SENTINEL_TOPIC }));
    await expect(settle(vi, CDP.captureList('upcoming'))).rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
    expect(containsSentinel(logger.text())).toBe(null);
  });
});
