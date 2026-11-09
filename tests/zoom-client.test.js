// FEAT-A1 / AC-5 + design §6.5, §7.4 (review F-5, F-15): status mapping, cache/replay/capture policy,
// re-warm cap, auth-changed emission, join from the in-memory map only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, settle, portalScript } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TOKEN, SENTINEL_TOPIC, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const LIST = '/rest/meeting/list';
const INFO = '/nws/recording/1.0/recording-info';
const UP = 'https://amazon.zoom.us/meeting#/upcoming';
const REC = 'https://amazon.zoom.us/recording';

let fx; let logger; let restoreE; let client; let S; let ctx; let state; let loads; let netScript;

const meetingsBody = (n, tag = 'u') => ({
  status: true,
  result: { list: Array.from({ length: n }, (_, i) => ({ meetingId: '91234567' + i + '0', topic: SENTINEL_TOPIC + tag + i, startTime: '2026-11-1' + i + 'T15:00:00Z', joinUrl: 'https://amazon.zoom.us/j/91234567' + i + '0?pwd=p' })) },
});

function setup({ net } = {}) {
  freshZoom(require);
  logger = installFakeLogger(require);
  state = { signedIn: true, upcoming: meetingsBody(2) };
  loads = [];
  const script = portalScript({
    signedIn: () => state.signedIn,
    pages: new Proxy({}, {
      get: (_t, url) => {
        if (url === UP) return [{ path: LIST, postData: '{"type":"upcoming"}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN }, body: state.upcoming }];
        if (url === REC) return [{ path: '/nws/recording/1.0/host-list', postData: '{"p":1}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN }, body: { status: true, result: { recordings: [{ uuid: 'R1', topic: SENTINEL_TOPIC, startTime: '2026-11-01T10:00:00Z' }] } } }];
        return [];
      },
    }),
  });
  netScript = net || (() => ({ status: 200, body: { status: true, result: { isShowTranscriptTab: true, email: 'x@y' } } }));
  fx = createFakeElectron({ urlFor: script.urlFor, onLoad: (w, u) => { if (u !== 'about:blank') loads.push(u); script.onLoad(w, u); }, net: (i) => netScript(i) });
  restoreE = installFakeElectron(require, fx.electron);
  S = require('../src/zoom/data/session');
  S._setDeps({ seeder: { seedOrLegacy: async () => ({}) }, auth: { injectCookies: async () => {} } });
  client = require('../src/zoom/data/client');
  ctx = { sendToWindow: vi.fn(), mainWindow: null };
}

afterEach(() => {
  vi.useRealTimers();
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

const authEvents = () => ctx.sendToWindow.mock.calls.filter((c) => c[0] === 'zoomData:auth-changed').map((c) => c[1]);

describe('status()', () => {
  const rows = [
    ['ok', { status: 200, body: { status: true, result: {} } }, { signedIn: true }],
    ['401', { status: 401, body: '' }, { signedIn: false, code: 'SIGN_IN_REQUIRED' }],
    ['redirect to login', { status: 302, redirect: 'https://midway-auth.amazon.com/x' }, { signedIn: false, code: 'SIGN_IN_REQUIRED' }],
    ['network', { error: new Error('x') }, { signedIn: null, code: 'NETWORK' }],
    ['429', { status: 429, body: '' }, { signedIn: null, code: 'THROTTLED' }],
    ['500', { status: 500, body: '' }, { signedIn: null, code: 'HTTP_ERROR' }],
    ['ZOOM_ERROR (any other code)', { status: 200, body: { status: false, errorCode: 1 } }, { signedIn: null, code: 'ZOOM_ERROR' }],
    ['SHAPE_UNRECOGNIZED (any other code)', { status: 200, body: '<html>' }, { signedIn: null, code: 'SHAPE_UNRECOGNIZED' }],
  ];
  for (const [name, script, want] of rows) {
    it(name + ' -> ' + JSON.stringify(want), async () => {
      setup({ net: () => script });
      const r = await client.status({ force: false }, { ctx });
      expect(r).toMatchObject(Object.assign({ ok: true }, want));
      expect(typeof r.checkedAt).toBe('string');
      expect(fx.calls.net[0].url).toBe('https://amazon.zoom.us' + INFO);
    });
  }

  it('caches for 60 s unless force; emits auth-changed only on change', async () => {
    vi.useFakeTimers();
    setup({ net: () => ({ status: 401, body: '' }) });
    await client.status({}, { ctx });
    await client.status({}, { ctx });
    expect(fx.calls.net.length).toBe(1);
    await client.status({ force: true }, { ctx });
    expect(fx.calls.net.length).toBe(2);
    await vi.advanceTimersByTimeAsync(61_000);
    await client.status({}, { ctx });
    expect(fx.calls.net.length).toBe(3);
    expect(authEvents()).toEqual([{ signedIn: false, code: 'SIGN_IN_REQUIRED' }]);
    netScript = () => ({ status: 200, body: { status: true, result: {} } });
    await client.status({ force: true }, { ctx });
    expect(authEvents()).toEqual([{ signedIn: false, code: 'SIGN_IN_REQUIRED' }, { signedIn: true, code: null }]);
  });
});

describe('listMeetings policy', () => {
  it('capture first, cache within 120 s, replay on refresh, single-flight', async () => {
    vi.useFakeTimers();
    setup({ net: (i) => (i.method === 'POST' ? { status: 200, body: meetingsBody(3) } : { status: 200, body: { status: true, result: {} } }) });
    const r1 = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: false }, { ctx }));
    expect(r1).toMatchObject({ ok: true, source: 'capture' });
    expect(r1.items).toHaveLength(2);
    expect(loads).toEqual([UP]);
    const r2 = await client.listMeetings({ kind: 'upcoming', refresh: false }, { ctx });
    expect(r2.source).toBe('cache');
    const pa = client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx });
    const pb = client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx });
    const [r3, r3b] = await settle(vi, Promise.all([pa, pb]));
    expect(r3b).toEqual(r3);
    expect(r3).toMatchObject({ ok: true, source: 'replay' });
    expect(r3.items).toHaveLength(3);
    expect(fx.calls.net.filter((n) => n.method === 'POST').length).toBe(1);
    expect(loads).toEqual([UP]);
    expect(JSON.stringify([r1, r2, r3])).not.toMatch(/https?:/);
    expect(containsSentinel(logger.text())).toBe(null);
  });

  it('AC-5: replay 401 triggers exactly one recapture; recapture landing on sign-in -> SIGN_IN_REQUIRED + exactly one auth-changed {signedIn:false}', async () => {
    vi.useFakeTimers();
    setup({ net: () => ({ status: 401, body: '' }) });
    await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    expect(loads.length).toBe(1);
    state.signedIn = false;
    const r = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r).toEqual({ ok: false, code: 'SIGN_IN_REQUIRED' });
    expect(loads.length).toBe(2);
    expect(fx.calls.net.filter((n) => n.method === 'POST').length).toBe(1);
    expect(authEvents()).toEqual([{ signedIn: false, code: 'SIGN_IN_REQUIRED' }]);
  });

  it('AC-5: replay 401 then a signed-in recapture -> fresh capture data', async () => {
    vi.useFakeTimers();
    setup({ net: () => ({ status: 401, body: '' }) });
    await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    state.upcoming = meetingsBody(4);
    const r = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r).toMatchObject({ ok: true, source: 'capture' });
    expect(r.items).toHaveLength(4);
    expect(loads.length).toBe(2);
    expect(authEvents()).toEqual([]);
  });

  it('F-5: replay 403 after a recent capture never reports signedIn:false; the capped retry returns the stale cache', async () => {
    vi.useFakeTimers();
    setup({ net: () => ({ status: 403, body: '' }) });
    await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    const r1 = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r1.ok).toBe(true);
    const r2 = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r2).toMatchObject({ ok: true, source: 'cache', stale: true });
    expect(r2.items).toHaveLength(2);
    expect(loads.length).toBe(2);   // initial + one re-warm capture, then capped
    expect(authEvents().filter((e) => e.signedIn === false)).toEqual([]);
    // After the interval a re-warm capture may run again.
    await vi.advanceTimersByTimeAsync(600_001);
    const r3 = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r3.source).toBe('capture');
  });

  it('re-warm cap with no cached result -> CAPTURE_TIMEOUT (never SIGN_IN_REQUIRED)', async () => {
    vi.useFakeTimers();
    setup({ net: () => ({ status: 403, body: '' }) });
    await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));   // 403 -> re-warm capture
    const CDP = require('../src/zoom/data/cdp-capture');
    expect(CDP.replayDisabledReason(LIST, 'upcoming')).toBe('rejected');
    client.__test__.dropList('upcoming');
    const r = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r).toEqual({ ok: false, code: 'CAPTURE_TIMEOUT' });
    expect(loads.length).toBe(2);
    expect(authEvents()).toEqual([]);
  });

  it('a capture landing on sign-in sets signedIn:false and emits once', async () => {
    vi.useFakeTimers();
    setup();
    state.signedIn = false;
    const r = await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    expect(r).toEqual({ ok: false, code: 'SIGN_IN_REQUIRED' });
    const r2 = await settle(vi, client.listMeetings({ kind: 'upcoming', refresh: true }, { ctx }));
    expect(r2.code).toBe('SIGN_IN_REQUIRED');
    expect(authEvents()).toEqual([{ signedIn: false, code: 'SIGN_IN_REQUIRED' }]);
  });

  it('listRecordings uses the recordings page and pageKind', async () => {
    vi.useFakeTimers();
    setup();
    const r = await settle(vi, client.listRecordings({ refresh: false }, { ctx }));
    expect(r).toMatchObject({ ok: true, source: 'capture' });
    expect(loads).toEqual([REC]);
    expect(r.items[0].hasTranscript).toBe(null);
  });
});

describe('getMeeting / join / recordingInfo / connect', () => {
  it('join opens the in-memory URL once; unknown key -> NOT_FOUND without shell', async () => {
    vi.useFakeTimers();
    setup();
    const r = await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    const key = r.items[0].key;
    expect(await client.getMeeting({ key }, { ctx })).toMatchObject({ ok: true, item: { key } });
    expect(await client.getMeeting({ key: 'nope' }, { ctx })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await client.join({ key: 'nope' }, { ctx })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.openExternal.length).toBe(0);
    expect(await client.join({ key }, { ctx })).toEqual({ ok: true });
    expect(fx.calls.openExternal).toEqual([['https://amazon.zoom.us/j/9123456700?pwd=p']]);
    // a tampered cache entry is re-validated
    client.joinByKey.set(key, 'https://evil.test/j/1');
    expect(await client.join({ key }, { ctx })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.openExternal.length).toBe(1);
  });

  it('recordingInfo returns the whitelisted info only', async () => {
    setup();
    const r = await client.recordingInfo(undefined, { ctx });
    expect(r).toEqual({ ok: true, info: { isShowTranscriptTab: true } });
  });

  it('connect success clears caches + captured headers and reports signed in', async () => {
    vi.useFakeTimers();
    setup();
    await settle(vi, client.listMeetings({ kind: 'upcoming' }, { ctx }));
    expect(client.meetingByKey.size).toBe(2);
    expect(Object.keys(S.getCapture().headersFor(LIST))).toEqual(['zoom-csrftoken']);
    const r = await settle(vi, client.connect(undefined, { ctx }));
    expect(r).toEqual({ ok: true, signedIn: true });
    expect(client.meetingByKey.size).toBe(0);
    expect(client.joinByKey.size).toBe(0);
    expect(S.getCapture().headersFor(LIST)).toEqual({});
    expect(authEvents()).toEqual([{ signedIn: true, code: null }]);
  });

  it('connect failure returns the code', async () => {
    vi.useFakeTimers();
    setup();
    state.signedIn = false;
    const p = client.connect(undefined, { ctx });
    let t = 0;
    while (fx.windows.length < 2 && t < 100000) { await vi.advanceTimersByTimeAsync(250); t += 250; }
    fx.windows[1].close();
    expect(await settle(vi, p)).toEqual({ ok: false, code: 'CANCELLED' });
  });
});
