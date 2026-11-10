// FEAT-003 (plan item 11, AC13): IPC-level secret redaction for the OBS area. The hub is registered with
// {enabled, studio, obs} and the real zh() handlers drive src/zoom/studio/obs.js, which runs on a fake OBS
// client (tests/fixtures/zoom/fake-obs.js), a fake feedServer whose token is a sentinel 64-hex string,
// fake credentials / electron and a recording sendToWindow. Every log line, IPC result and event is scanned.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { createFakeObs } from './fixtures/zoom/fake-obs.js';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

const SENTINEL_PW = 'Sentinel-OBS-Pass-7f3a9c';
const SENTINEL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

let TMP; let logger; let restoreE; let fake; let feed; let creds; let electron; let O; let errors;
let handlers; let wc; let ctx; let event; let sent; let results; let enc;

function createFeedServer() {
  const cbs = new Set();
  const f = {
    running: false, failStart: false,
    async start() {
      if (f.failStart) throw new errors.ZoomError('OBS_FEED_FAILED');
      f.running = true;
      return { port: 5555, token: SENTINEL_TOKEN };
    },
    async stop() { f.running = false; },
    viewUrl: () => (f.running ? 'http://127.0.0.1:5555/obs/' + SENTINEL_TOKEN + '/' : null),
    feedUrl: () => (f.running ? 'ws://127.0.0.1:5555/feed/' + SENTINEL_TOKEN : null),
    onProducer(cb) { cbs.add(cb); return () => cbs.delete(cb); },
    get lastFrameAt() { return 0; },
  };
  return f;
}

function obsDeps() {
  let seq = 0;
  const noop = () => {};
  return {
    createClient: () => fake.client, feedServer: feed, store: require('../src/store'), credentials: creds, electron,
    launch: {
      validateExe: (p) => (p == null ? 'C:/Program Files/obs-studio/bin/64bit/obs64.exe' : p),
      isRunning: async () => false,
      launch: async () => ({ ok: true, already: false }),
    },
    now: () => 1_000_000,
    setTimeout: () => ++seq, clearTimeout: noop, setInterval: () => ++seq, clearInterval: noop,
  };
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-obs-redact-'));
  require('../src/config/paths').setDataDir(TMP);
  freshZoom(require);
  logger = installFakeLogger(require);
  restoreE = installFakeElectron(require, createFakeElectron().electron);
  errors = require('../src/zoom/errors');
  fake = createFakeObs({ scenes: ['Scene', 'Gaming'], program: 'Scene', password: SENTINEL_PW });
  feed = createFeedServer();
  enc = true;
  electron = { app: { on: vi.fn() }, safeStorage: { isEncryptionAvailable: vi.fn(() => enc) } };
  const map = new Map();
  creds = {
    map,
    set: vi.fn(async (k, v) => { map.set(k, v); }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    delete: vi.fn(async (k) => { map.delete(k); }),
  };
  O = require('../src/zoom/studio/obs');
  O._setDeps(obsDeps());
  wc = new EventEmitter();
  wc.id = 1;
  wc.mainFrame = { processId: 2, routingId: 1 };
  wc.setBackgroundThrottling = vi.fn();
  sent = [];
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn((ch, p) => { sent.push({ ch, p }); }) };
  event = { sender: wc, senderFrame: { processId: 2, routingId: 1, url: 'file:///C:/Fleet/renderer/src/index.html' } };
  handlers = new Map();
  const hub = require('../src/ipc/zoom-hub');
  const flags = pf.resolveZoomFlags({ zoom: { enabled: true, studio: true, obs: true } }, {});
  const reg = hub.registerZoomHubIPC(ctx, { flags, handle: (ch, fn) => handlers.set(ch, fn) });
  expect(reg.flags.obs).toBe(true);
  results = [];
});

afterEach(() => {
  try { O._resetForTests(); O._setDeps(null); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

async function ipc(ch, payload) {
  const r = await handlers.get('zoomStudio:' + ch)(event, payload);
  results.push({ ch, r });
  return r;
}

const j = (v) => String(JSON.stringify(v));

describe('AC13: OBS secrets never leak through the IPC surface', () => {
  it('sentinel password never appears in any log call, IPC result or obs-state event', async () => {
    // Save (encryption available), connect, go live, stop.
    let r = await ipc('obs-config-set', { host: 'localhost', port: 4455, password: SENTINEL_PW });
    expect(r).toMatchObject({ ok: true, passwordSaved: true, host: '127.0.0.1', port: 4455 });
    expect(creds.map.get('zoomStudioObsPassword')).toBe(SENTINEL_PW);
    r = await ipc('obs-connect');
    expect(r).toMatchObject({ ok: true, state: 'connected' });
    expect(fake.obs.connectArgs[0].password).toBe(SENTINEL_PW);   // it really was used
    expect((await ipc('obs-start')).ok).toBe(true);
    await ipc('obs-status');
    await ipc('obs-stop');
    await ipc('obs-disconnect');

    // Wrong password -> OBS_AUTH_FAILED; the sentinel and the wrong one stay out of everything.
    const WRONG = SENTINEL_PW + '-wrong';
    await ipc('obs-config-set', { password: WRONG });
    r = await ipc('obs-connect');
    expect(r).toMatchObject({ ok: false, code: 'OBS_AUTH_FAILED', state: 'error' });

    // Invalid password (NUL) -> INVALID_INPUT {field:'password'} without echoing the input.
    r = await ipc('obs-config-set', { password: SENTINEL_PW + '\u0000' });
    expect(r).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'password' });
    r = await ipc('obs-config-set', { password: SENTINEL_PW.repeat(20) });
    expect(r).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'password' });

    // credentials.set throwing an Error that embeds the password: logged as {name, code} only.
    creds.set.mockImplementationOnce(async (_k, v) => { const e = new Error('safeStorage failed for ' + v); e.code = 'ESAVE'; throw e; });
    r = await ipc('obs-config-set', { password: SENTINEL_PW });
    expect(r).toMatchObject({ ok: true, passwordSaved: false });

    // Encryption unavailable -> memory only; then clear -> OBS_PASSWORD_REQUIRED.
    enc = false;
    r = await ipc('obs-config-set', { password: SENTINEL_PW });
    expect(r).toMatchObject({ ok: true, passwordSaved: false });
    expect((await ipc('obs-connect')).ok).toBe(true);
    await ipc('obs-disconnect');
    r = await ipc('obs-config-set', { password: null });
    expect(r).toMatchObject({ ok: true, passwordSaved: null });
    r = await ipc('obs-connect');
    expect(r).toMatchObject({ ok: false, code: 'OBS_PASSWORD_REQUIRED' });
    await ipc('obs-status');

    expect(results.length).toBeGreaterThan(10);
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.every((s) => s.ch === 'zoomStudio:obs-state')).toBe(true);
    const logs = logger.text();
    expect(logger.lines.length).toBeGreaterThan(0);
    for (const secret of [SENTINEL_PW, WRONG]) {
      expect(logs.includes(secret)).toBe(false);
      for (const { ch, r: res } of results) expect([ch, j(res).includes(secret)]).toEqual([ch, false]);
      for (const s of sent) expect(j(s.p).includes(secret)).toBe(false);
    }
    // The password never reaches the store file either (only credentials).
    const storeText = fs.readdirSync(TMP).map((f) => { try { return fs.readFileSync(path.join(TMP, f), 'utf8'); } catch (_) { return ''; } }).join('\n');
    expect(storeText.includes(SENTINEL_PW)).toBe(false);
  });

  it('sentinel token appears only in the obs-start success feedUrl and the fake OBS CreateInput/SetInputSettings url; absent from logs, error results, obs-status and obs-state', async () => {
    await ipc('obs-config-set', { password: SENTINEL_PW });
    const start = await ipc('obs-start');                   // F5: auto-connects from idle
    expect(start).toMatchObject({ ok: true, state: 'live' });
    expect(start.feedUrl).toBe('ws://127.0.0.1:5555/feed/' + SENTINEL_TOKEN);
    await ipc('obs-status');
    await ipc('obs-stop');

    // Second start reuses the input (SetInputSettings), then fails mid-way -> rollback, error result.
    fake.obs.failNext.SetCurrentProgramScene = 500;
    let r = await ipc('obs-start');
    expect(r).toMatchObject({ ok: false, code: 'OBS_REQUEST_FAILED' });
    // Feed server cannot start -> OBS_FEED_FAILED.
    feed.failStart = true;
    r = await ipc('obs-start');
    expect(r).toMatchObject({ ok: false, code: 'OBS_FEED_FAILED' });
    feed.failStart = false;
    await ipc('obs-status');
    await ipc('obs-disconnect');

    // The token really reached OBS, and only through the browser source url.
    const withToken = fake.obs.requests.filter((q) => j(q.data).includes(SENTINEL_TOKEN));
    expect(withToken.length).toBeGreaterThanOrEqual(2);
    for (const q of withToken) {
      expect(['CreateInput', 'SetInputSettings']).toContain(q.type);
      expect(q.data.inputSettings.url).toBe('http://127.0.0.1:5555/obs/' + SENTINEL_TOKEN + '/');
      const rest = Object.assign({}, q.data, { inputSettings: Object.assign({}, q.data.inputSettings, { url: null }) });
      expect(j(rest).includes(SENTINEL_TOKEN)).toBe(false);
    }
    expect(fake.obs.requests.some((q) => q.type === 'CreateInput' && j(q.data).includes(SENTINEL_TOKEN))).toBe(true);
    expect(fake.obs.requests.some((q) => q.type === 'SetInputSettings' && j(q.data).includes(SENTINEL_TOKEN))).toBe(true);
    expect(j(fake.obs.raw).includes(SENTINEL_TOKEN)).toBe(false);

    // IPC results: only the obs-start success carries it, and only in feedUrl.
    for (const { ch, r: res } of results) {
      const isStartOk = ch === 'obs-start' && res.ok === true;
      if (isStartOk) {
        expect(j(Object.assign({}, res, { feedUrl: null })).includes(SENTINEL_TOKEN)).toBe(false);
      } else {
        expect([ch, j(res).includes(SENTINEL_TOKEN)]).toEqual([ch, false]);
      }
    }
    expect(results.filter((x) => x.ch === 'obs-start' && x.r.ok === true).length).toBe(1);
    // obs-state events and logs never carry it.
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.ch).toBe('zoomStudio:obs-state');
      expect(j(s.p).includes(SENTINEL_TOKEN)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(s.p, 'feedUrl')).toBe(false);
    }
    expect(logger.text().includes(SENTINEL_TOKEN)).toBe(false);
    expect(logger.text().includes('/feed/')).toBe(false);
    expect(logger.text().includes('/obs/')).toBe(false);
  });
});
