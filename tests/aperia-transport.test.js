// tests/aperia-transport.test.js — transport allow-list (GET only), 401 handling, WS-token capture from
// Network.webSocketCreated (kept apart from the Bearer), clear/clearAll, and session.reauth single-flight / timeout.
// Fakes only; nothing contacts Aperia.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, jwt, flush } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const C = require('../src/aperia/constants');
const capture = require('../src/aperia/capture');
const session = require('../src/aperia/session');
const T = require('../src/aperia/transport');

const BEARER_HDR = jwt(3600, 'SENTINEL_BEARER');
const BEARER = BEARER_HDR.slice('Bearer '.length);
const WS_TOKEN = jwt(3600, 'SENTINEL_WS').slice('Bearer '.length);
const API = 'https://amazon.aperiatech.com/api/v1/vehicles?page=0&size=500';
const WS_URL = 'wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + encodeURIComponent(WS_TOKEN);

let seq = 0;
/** A capture attached to a fake debugger; seed(token) runs a 2xx portal API call carrying the Bearer. */
function fakeCapture() {
  const fx = createFakeElectron();
  const win = new fx.electron.BrowserWindow({});
  const dbg = win.webContents.debugger;
  const cap = capture.createCapture(win.webContents, {});
  cap.attach();
  return {
    dbg,
    seed(hdr) {
      const id = 'r' + (++seq);
      dbg.emitRequest({ requestId: id, url: API, method: 'GET', headers: { Authorization: hdr } });
      dbg.emitResponse(id, '{}', { status: 200 });
    },
    socket(url) { dbg.emit('message', {}, 'Network.webSocketCreated', { requestId: 'w' + (++seq), url }); },
    cap,
  };
}

function fakeFetchSession(script) {
  const calls = [];
  const ses = {
    async fetch(url, opts) {
      calls.push({ url, opts });
      const s = (script && script(url, opts)) || { status: 200, body: '{"vehicles":[]}' };
      return { status: s.status, text: async () => s.body || '' };
    },
  };
  return { calls, dep: { getSession: () => ses, noteResult: () => {} } };
}

beforeEach(() => { capture._resetForTests(); session._resetForTests(); T._setDeps({}); });
afterEach(() => { vi.useRealTimers(); capture._resetForTests(); session._resetForTests(); T._setDeps({}); });

describe('constants allow-list', () => {
  it('accepts exactly the three path shapes', () => {
    expect(C.isAllowedApiPath('/api/v1/vehicles')).toBe(true);
    expect(C.isAllowedApiPath(C.vehiclesPath(3))).toBe(true);
    expect(C.isAllowedApiPath(C.vehiclePath('8811'))).toBe(true);
    expect(C.isAllowedApiPath(C.issuesByVehiclePath(0))).toBe(true);
    for (const p of ['/api/v1/notifications/token', '/api/v1/notifications', '/api/v1/notifications/5', '/api/v1/accounts', '/api/v1/accounts/7',
      '/api/v1/issues', '/api/v1/issues/by', '/api/v1/vehicles/1/tires', '/api/v1/vehicles/1/x', '/api/v1/login', '/api/v1/vehicles/', '']) {
      expect(C.isAllowedApiPath(p)).toBe(false);
    }
  });

  it('exports the client constants with the exact values', () => {
    expect(C).toMatchObject({
      CONCURRENCY: 6, INDEX_TTL_MS: 6 * 3600e3, INDEX_MISS_REBUILD_MS: 15 * 60e3, REAUTH_WAIT_MS: 120e3, MAX_PAGES: 100, BULK_MAX: 500,
      UNIT_MAX: 40, STALE_MS: 7 * 24 * 3600e3, CRITICAL_RATIO: 0.8, LOW_RATIO: 0.9, HIGH_RATIO: 1.1, GPS_EPS: 1e-4,
      ALERT_POLL_DEFAULT_MIN: 5, ALERT_POLL_MIN: 1, ALERT_POLL_MAX: 60, SEEN_FILE: 'aperia_seen_alerts.json',
      SEEN_MAX_AGE_MS: 60 * 24 * 3600e3, SEEN_MAX: 50000, TZ: 'America/New_York', WS_OPEN_TIMEOUT_MS: 15e3,
    });
    expect(C.PLACEHOLDER_GPS).toEqual({ lat: -11.11111, lng: 11.11111 });
    expect(C.US_BOX).toEqual({ latMin: 24, latMax: 50, lngMin: -125, lngMax: -66 });
    expect(Object.isFrozen(C.PLACEHOLDER_GPS) && Object.isFrozen(C.US_BOX)).toBe(true);
  });
});

describe('transport', () => {
  it('rejects non-allow-listed paths with APERIA_PATH_NOT_ALLOWED before any network; forbidden endpoints keep their code', async () => {
    const fc = fakeCapture();
    fc.seed(BEARER_HDR);
    const f = fakeFetchSession();
    T._setDeps({ session: f.dep });
    for (const p of ['/api/v1/notifications/token', '/api/v1/accounts', '/api/v1/notifications', '/api/v1/accounts?page=0', '/api/v1/issues']) {
      expect((await T.getJson(p)).code).toBe('APERIA_PATH_NOT_ALLOWED');
    }
    for (const p of ['/api/v1/vehicles/1/tires', '/api/v1/vehicles/1/sensors', '/api/v1/vehicles/1/pressures', '/api/v1/vehicles/1/telemetry']) {
      expect((await T.getJson(p)).code).toBe('APERIA_FORBIDDEN_ENDPOINT');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('allowed paths are fetched with method GET only and the Bearer', async () => {
    const fc = fakeCapture();
    fc.seed(BEARER_HDR);
    const f = fakeFetchSession();
    T._setDeps({ session: f.dep });
    for (const p of [C.vehiclesPath(0), C.vehiclePath('104'), C.issuesByVehiclePath(2)]) {
      const r = await T.getJson(p);
      expect(r).toMatchObject({ ok: true, status: 200 });
    }
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((c) => c.opts.method === 'GET')).toBe(true);
    expect(f.calls.every((c) => c.opts.body === undefined)).toBe(true);
    expect(f.calls[0].opts.headers.Authorization).toBe('Bearer ' + BEARER);
    expect(f.calls.map((c) => c.url)).toEqual([C.BASE_URL + C.vehiclesPath(0), C.BASE_URL + '/api/v1/vehicles/104', C.BASE_URL + C.issuesByVehiclePath(2)]);
  });

  it('no Bearer -> APERIA_SIGNIN_REQUIRED without network', async () => {
    const f = fakeFetchSession();
    T._setDeps({ session: f.dep });
    expect((await T.getJson(C.vehiclesPath(0))).code).toBe('APERIA_SIGNIN_REQUIRED');
    expect(f.calls).toHaveLength(0);
  });

  it('a 401 clears the token and returns APERIA_SESSION_EXPIRED', async () => {
    const fc = fakeCapture();
    fc.seed(BEARER_HDR);
    expect(capture.current()).toBe(BEARER);
    const f = fakeFetchSession(() => ({ status: 401, body: 'Bearer ' + BEARER }));
    T._setDeps({ session: f.dep });
    const r = await T.getJson(C.vehiclePath('104'));
    expect(r).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED', status: 401 });
    expect(capture.current()).toBeNull();
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });
});

describe('WS-token capture', () => {
  it('Network.webSocketCreated for the events socket sets wsToken() without touching current()', () => {
    const fc = fakeCapture();
    fc.socket(WS_URL);
    expect(capture.wsToken()).toBe(WS_TOKEN);
    expect(capture.current()).toBeNull();
    fc.seed(BEARER_HDR);
    expect(capture.current()).toBe(BEARER);
    expect(capture.wsToken()).toBe(WS_TOKEN);
    const d = capture.describe();
    expect(d).toMatchObject({ hasToken: true, hasWsToken: true });
    expect(JSON.stringify(d)).not.toContain('SENTINEL');
  });

  it('ignores other sockets: ws:, other host, other path, short or missing token', () => {
    const fc = fakeCapture();
    for (const u of [
      'ws://amazon.aperiatech.com/api/ws/events?x-authorization=' + WS_TOKEN,
      'wss://evil.example/api/ws/events?x-authorization=' + WS_TOKEN,
      'wss://amazon.aperiatech.com/api/ws/other?x-authorization=' + WS_TOKEN,
      'wss://amazon.aperiatech.com/api/ws/events?x-authorization=short',
      'wss://amazon.aperiatech.com/api/ws/events',
      'not a url',
    ]) fc.socket(u);
    expect(capture.wsToken()).toBeNull();
    expect(capture.describe().hasWsToken).toBe(false);
  });

  it('an expired socket JWT clears itself', () => {
    const fc = fakeCapture();
    fc.socket('wss://amazon.aperiatech.com/api/ws/events?x-authorization=' + jwt(-10, 'SENTINEL_WS').slice(7));
    expect(capture.wsToken()).toBeNull();
  });

  it('clear() keeps the socket token; clearWs() / clearAll() drop it; clearAll() drops both', () => {
    const fc = fakeCapture();
    fc.seed(BEARER_HDR);
    fc.socket(WS_URL);
    capture.clear();
    expect(capture.current()).toBeNull();
    expect(capture.wsToken()).toBe(WS_TOKEN);
    capture.clearWs();
    expect(capture.wsToken()).toBeNull();
    fc.seed(BEARER_HDR);
    fc.socket(WS_URL);
    capture.clearAll();
    expect(capture.current()).toBeNull();
    expect(capture.wsToken()).toBeNull();
  });

  it('session.logout() and teardownAll() clear both tokens', () => {
    const fc = fakeCapture();
    fc.seed(BEARER_HDR);
    fc.socket(WS_URL);
    session.logout();
    expect(capture.current()).toBeNull();
    expect(capture.wsToken()).toBeNull();
    fc.seed(BEARER_HDR);
    fc.socket(WS_URL);
    session.teardownAll();
    expect(capture.current()).toBeNull();
    expect(capture.wsToken()).toBeNull();
  });
});

describe('session.reauth / notePull', () => {
  it('returns ok immediately when a Bearer is held (no window)', async () => {
    const fx = createFakeElectron();
    session._setDeps({ electron: fx.electron });
    fakeCapture().seed(BEARER_HDR);
    expect(await session.reauth({})).toEqual({ ok: true });
    expect(fx.windows).toHaveLength(0);
  });

  it('single-flight: concurrent callers share one wait and resolve on the next capture', async () => {
    const fx = createFakeElectron();
    session._setDeps({ electron: fx.electron });
    const p1 = session.reauth({});
    const p2 = session.reauth({});
    expect(p2).toBe(p1);
    await flush();
    expect(fx.windows).toHaveLength(1);
    const dbg = fx.windows[0].webContents.debugger;
    dbg.emitRequest({ requestId: 'x1', url: API, method: 'GET', headers: { Authorization: BEARER_HDR } });
    dbg.emitResponse('x1', '{}', { status: 200 });
    expect(await p1).toEqual({ ok: true });
    expect(await p2).toEqual({ ok: true });
    expect(session.status().state).toBe('connected');
  });

  it('reloads an open sign-in window instead of opening a second one', async () => {
    const fx = createFakeElectron();
    session._setDeps({ electron: fx.electron });
    const login = session.openLoginWindow({});
    await flush();
    const win = fx.windows[0];
    const dbg = win.webContents.debugger;
    dbg.emitRequest({ requestId: 'a1', url: API, method: 'GET', headers: { Authorization: BEARER_HDR } });
    dbg.emitResponse('a1', '{}', { status: 200 });
    await login;
    session.noteResult('APERIA_SESSION_EXPIRED');
    expect(capture.current()).toBeNull();
    let reloaded = 0;
    win.webContents.reload = () => { reloaded++; };
    const p = session.reauth({});
    await flush();
    expect(reloaded).toBe(1);
    expect(fx.windows).toHaveLength(1);
    dbg.emitRequest({ requestId: 'a2', url: API, method: 'GET', headers: { Authorization: BEARER_HDR } });
    dbg.emitResponse('a2', '{}', { status: 200 });
    expect(await p).toEqual({ ok: true });
  });

  it('times out with APERIA_SESSION_EXPIRED after REAUTH_WAIT_MS (fake timers)', async () => {
    vi.useFakeTimers();
    const fx = createFakeElectron();
    session._setDeps({ electron: fx.electron });
    let res = null;
    session.reauth({}).then((r) => { res = r; });
    await vi.advanceTimersByTimeAsync(C.REAUTH_WAIT_MS - 1000);
    expect(res).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(res).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    // a new reauth after the timeout starts a new wait
    const p = session.reauth({}, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
  });

  it('notePull sets lastPullAt in status()', () => {
    expect(session.status().lastPullAt).toBeNull();
    session.notePull('2026-11-22T15:00:00.000Z');
    expect(session.status().lastPullAt).toBe('2026-11-22T15:00:00.000Z');
  });
});
