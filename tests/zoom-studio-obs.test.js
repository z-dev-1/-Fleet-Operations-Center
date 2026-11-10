// FEAT-002 (plan item 7, design §4.6 + rev-1 findings F1 F2 F3 F4 F5 F10 F11 F13 F14 F15): the OBS
// orchestrator src/zoom/studio/obs.js driven with a fake OBS client (tests/fixtures/zoom/fake-obs.js),
// a fake feedServer, a fake launcher, fake credentials / electron, a temp-dir store and a fake clock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { createFakeObs } from './fixtures/zoom/fake-obs.js';

// Each test does real temp-dir store writes (and some re-run setup()); under a loaded parallel run
// these take far longer than the ~150 ms they take alone, so give every test explicit headroom.
vi.setConfig({ testTimeout: 30000 });

const require = createRequire(import.meta.url);
const DEFAULT_EXE = 'C:/Program Files/obs-studio/bin/64bit/obs64.exe';
const KEYS = ['ok', 'state', 'reason', 'hint', 'canLaunch', 'passwordSaved', 'host', 'port', 'exePath', 'obsVersion',
  'outputLive', 'producer', 'vcamByFleet', 'recoveryPending', 'launchedByFleet'];
const SCENE = 'Fleet Camera';
const INPUT = 'Fleet Camera Feed';

const flushIO = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function createClock(t0 = 1_000_000) {
  const c = { t: t0, seq: 0, timers: new Map() };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.t + ms, every: 0 }); return id; };
  c.setInterval = (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.t + ms, every: ms }); return id; };
  c.clearTimeout = (id) => { c.timers.delete(id); };
  c.clearInterval = (id) => { c.timers.delete(id); };
  c.advance = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      await flushIO();
      let next = null;
      for (const [id, tm] of c.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
      if (!next) break;
      const [id, tm] = next;
      c.t = tm.at;
      if (tm.every) tm.at += tm.every; else c.timers.delete(id);
      tm.fn();
    }
    c.t = end;
    await flushIO();
  };
  return c;
}

let TMP; let logger; let O; let store; let errors; let fake; let feed; let clock; let electron; let creds; let launch;
let ctx; let wc; let events; let hooks; let enc; let running;

function createFakeFeedServer() {
  const cbs = new Set();
  const f = {
    starts: 0, stops: 0, running: false, n: 0, flowing: false, frameAt: 0, failStart: false,
    async start() {
      f.starts++;
      if (f.failStart) throw new errors.ZoomError('OBS_FEED_FAILED');
      if (!f.running) { f.running = true; f.n++; }
      return { port: 5555, token: 'SENTINELTOKEN' + f.n };
    },
    async stop() { f.stops++; f.running = false; },
    viewUrl: () => (f.running ? 'http://127.0.0.1:5555/obs/SENTINELTOKEN' + f.n + '/' : null),
    feedUrl: () => (f.running ? 'ws://127.0.0.1:5555/feed/SENTINELTOKEN' + f.n : null),
    onProducer(cb) { cbs.add(cb); return () => cbs.delete(cb); },
    setProducer(v) { for (const cb of cbs) cb(v); },
    get lastFrameAt() { return f.flowing ? clock.now() : f.frameAt; },
  };
  return f;
}

function deps() {
  return {
    createClient: () => fake.client, feedServer: feed, launch, store, credentials: creds, electron,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  };
}

function setup(obsOpts) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-obs-'));
  require('../src/config/paths').setDataDir(TMP);
  freshZoom(require);
  logger = installFakeLogger(require);
  store = require('../src/store');
  errors = require('../src/zoom/errors');
  clock = createClock();
  fake = createFakeObs(obsOpts || { scenes: ['Scene', 'Gaming'], program: 'Scene' });
  feed = createFakeFeedServer();
  hooks = {};
  enc = true;
  running = false;
  electron = {
    app: { on: vi.fn((ev, cb) => { (hooks[ev] = hooks[ev] || []).push(cb); }) },
    safeStorage: { isEncryptionAvailable: vi.fn(() => enc) },
  };
  const map = new Map();
  creds = {
    map,
    set: vi.fn(async (k, v) => { map.set(k, v); }),
    get: vi.fn(async (k) => (map.has(k) ? map.get(k) : null)),
    delete: vi.fn(async (k) => { map.delete(k); }),
  };
  launch = {
    validateExe: vi.fn((p) => (p == null ? DEFAULT_EXE : p)),
    isRunning: vi.fn(async () => running),
    launch: vi.fn(async () => ({ ok: true, already: false })),
  };
  wc = new EventEmitter();
  wc.setBackgroundThrottling = vi.fn();
  events = [];
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: wc },
    sendToWindow: vi.fn((ch, p) => { if (ch === 'zoomStudio:obs-state') events.push(p); }),
  };
  O = require('../src/zoom/studio/obs');
  O._setDeps(deps());
}

function teardown() {
  try { O._resetForTests(); O._setDeps(null); } catch (_) {}
  logger.restore();
  freshZoom(require);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

/** a new Fleet session (module state lost, persisted store + OBS model kept) */
function newSession() {
  O._resetForTests();
  O._setDeps(deps());
}

beforeEach(() => setup());
afterEach(() => { vi.restoreAllMocks(); teardown(); });

const env = () => ({ event: {}, ctx });
const call = (fn, input) => O[fn](input, env());
const codeOf = async (p) => { try { await p; return 'no-throw'; } catch (e) { return errors.toResult(e).code; } };
const cfg = () => store.load('zoomStudioObs', null);
const lastEvent = () => events[events.length - 1];
const reqsSince = (n) => fake.obs.requests.slice(n);
const sceneUuid = (name) => (fake.obs.scenes.find((s) => s.sceneName === name) || {}).sceneUuid;

function expectFullShape(r) {
  for (const k of KEYS) expect(Object.prototype.hasOwnProperty.call(r, k)).toBe(true);
}

/** blocks the next request of `type` until release() */
function blockRequest(type) {
  const orig = fake.client.request;
  let release;
  const gate = new Promise((r) => { release = r; });
  fake.client.request = async (t, d) => {
    if (t === type) { fake.client.request = orig; await gate; }
    return orig.call(fake.client, t, d);
  };
  return () => release();
}

async function goLive() {
  const r = await call('start');
  expect(r.ok).toBe(true);
  expect(r.state).toBe('live');
  return r;
}

// ── connect / errors ──────────────────────────────────────────────────────

describe('obs.js connect / errors', () => {
  it('localhost is normalized to 127.0.0.1', async () => {
    const c = await call('configSet', { host: 'localhost', port: 4460 });
    expect(c.host).toBe('127.0.0.1');
    expect(cfg().host).toBe('127.0.0.1');
    store.save('zoomStudioObs', Object.assign(cfg(), { host: 'localhost' }));
    const r = await call('connect');
    expect(r.ok).toBe(true);
    expect(r.state).toBe('connected');
    expect(fake.obs.connectArgs[0]).toMatchObject({ host: '127.0.0.1', port: 4460 });
    expect(r.host).toBe('127.0.0.1');
  });

  it('AC3: ECONNREFUSED with no obs64 -> state error, code OBS_NOT_RUNNING, canLaunch true', async () => {
    fake.obs.connectFail = 'ECONNREFUSED';
    running = false;
    const r = await call('connect');
    expect(r).toMatchObject({ ok: false, code: 'OBS_NOT_RUNNING', state: 'error', reason: 'OBS_NOT_RUNNING', canLaunch: true, hint: false });
    expect(lastEvent()).toEqual(r);
    expect(launch.isRunning).toHaveBeenCalledTimes(1);
  });

  it('AC3: ECONNREFUSED with obs64 running -> OBS_SERVER_DISABLED with hint true; hintShown persisted', async () => {
    fake.obs.connectFail = 'ECONNREFUSED';
    running = true;
    expect(cfg()).toBe(null);
    const r = await call('connect');
    expect(r).toMatchObject({ ok: false, code: 'OBS_SERVER_DISABLED', state: 'error', reason: 'OBS_SERVER_DISABLED', hint: true, canLaunch: false });
    expect(cfg().hintShown).toBe(true);
    running = null;
    const u = await call('connect');
    expect(u).toMatchObject({ ok: false, code: 'OBS_UNREACHABLE', state: 'error', hint: false, canLaunch: false });
  });

  it('AC3: inside the 20 s launch window -> connecting / obs-starting, retried every 1 s', async () => {
    fake.obs.connectFail = 'ECONNREFUSED';
    const l = await call('launch');
    expect(l.ok).toBe(true);
    const r = await call('connect');
    expect(r).toMatchObject({ ok: false, code: 'OBS_UNREACHABLE', state: 'connecting', reason: 'obs-starting' });
    expectFullShape(r);
    expect(fake.obs.connects).toBe(1);
    await clock.advance(1000);
    expect(fake.obs.connects).toBe(2);
    await clock.advance(1000);
    expect(fake.obs.connects).toBe(3);
    expect((await call('status')).state).toBe('connecting');
    expect(launch.isRunning).not.toHaveBeenCalled();
    fake.obs.connectFail = null;
    await clock.advance(1000);
    expect(fake.obs.connects).toBe(4);
    expect((await call('status')).state).toBe('connected');
    expect(lastEvent()).toMatchObject({ ok: true, state: 'connected', launchedByFleet: false });
    await clock.advance(3000);
    expect(fake.obs.connects).toBe(4);
  });

  it('AC3: 4009, password-required and 4010 end the launch-window retry immediately', async () => {
    const cases = [[4009, 'OBS_AUTH_FAILED'], ['password-required', 'OBS_PASSWORD_REQUIRED'], [4010, 'OBS_UNSUPPORTED']];
    for (const [fail, code] of cases) {
      // first attempt
      newSession();
      fake = createFakeObs({ scenes: ['Scene'], program: 'Scene' });
      O._setDeps(deps());
      await call('launch');
      fake.obs.connectFail = fail;
      const r = await call('connect');
      expect(r).toMatchObject({ ok: false, code, state: 'error', reason: code });
      await clock.advance(3000);
      expect(fake.obs.connects).toBe(1);
      // mid-loop
      newSession();
      fake = createFakeObs({ scenes: ['Scene'], program: 'Scene' });
      O._setDeps(deps());
      await call('launch');
      fake.obs.connectFail = (n) => (n === 1 ? 'ECONNREFUSED' : fail);
      const p = await call('connect');
      expect(p.reason).toBe('obs-starting');
      await clock.advance(1000);
      expect(lastEvent()).toMatchObject({ ok: false, code, state: 'error' });
      await clock.advance(3000);
      expect(fake.obs.connects).toBe(2);
      expect(launch.isRunning).not.toHaveBeenCalled();
    }
  });

  it('F4: every failed op returns the full status shape with ok:false, code, state error and reason = code', async () => {
    fake.obs.connectFail = 'ECONNREFUSED';
    const a = await call('connect');
    launch.validateExe.mockImplementationOnce(() => { throw new errors.ZoomError('OBS_NOT_INSTALLED'); });
    const b = await call('launch');
    fake.obs.connectFail = null;
    fake.addScene(SCENE);   // the user's own 'Fleet Camera' scene
    const c = await call('start');
    feed.failStart = true;
    fake.obs.scenes = fake.obs.scenes.filter((s) => s.sceneName !== SCENE);
    const d = await call('start');
    for (const [r, code] of [[a, 'OBS_NOT_RUNNING'], [b, 'OBS_NOT_INSTALLED'], [c, 'OBS_NAME_CONFLICT'], [d, 'OBS_FEED_FAILED']]) {
      expectFullShape(r);
      expect(r).toMatchObject({ ok: false, code, state: 'error', reason: code });
      expect(r.feedUrl).toBeUndefined();
      expect(events.some((e) => e === r || JSON.stringify(e) === JSON.stringify(r))).toBe(true);
    }
  });

  it('F15/D1: OBS_SERVER_DISABLED after a Fleet launch reports launchedByFleet true', async () => {
    const l = await call('launch');
    expect(l.launchedByFleet).toBe(true);
    expect(launch.launch).toHaveBeenCalledWith(DEFAULT_EXE);
    fake.obs.connectFail = 'ECONNREFUSED';
    running = true;
    const r = await call('connect');
    expect(r.reason).toBe('obs-starting');
    await clock.advance(20000);
    expect(lastEvent()).toMatchObject({ ok: false, code: 'OBS_SERVER_DISABLED', hint: true, launchedByFleet: true });
    // already running -> not launched by Fleet; a successful connect clears it
    launch.launch.mockResolvedValueOnce({ ok: true, already: true });
    expect((await call('launch')).launchedByFleet).toBe(false);
    await call('launch');
    fake.obs.connectFail = null;
    const c = await call('connect');
    expect(c).toMatchObject({ ok: true, state: 'connected', launchedByFleet: false });
  });
});

// ── start / stop ─────────────────────────────────────────────────────────

describe('obs.js start / stop', () => {
  it('AC4: Start creates Fleet Camera + Fleet Camera Feed, records UUIDs, switches program, starts vcam; Stop restores Scene; zero mutating requests on user scenes/inputs', async () => {
    fake.addInput('Mic', 'wasapi_input_capture', { device_id: 'default' });
    fake.addItem('Scene', 'Mic');
    const userItems = JSON.stringify(fake.obs.sceneItems.Scene);
    await call('connect');
    const r = await goLive();
    expect(r).toMatchObject({ outputLive: true, vcamByFleet: true, recoveryPending: true });
    expect(r.feedUrl).toBe(feed.feedUrl());
    const sc = fake.obs.scenes.find((s) => s.sceneName === SCENE);
    const inp = fake.obs.inputs.find((i) => i.inputName === INPUT);
    expect(sc).toBeTruthy();
    expect(inp.inputKind).toBe('browser_source');
    expect(inp.inputSettings).toMatchObject({ url: feed.viewUrl(), width: 1280, height: 720, fps_custom: true, fps: 30, shutdown: false, restart_when_active: false, reroute_audio: false });
    expect(cfg().owned).toEqual({ sceneUuid: sc.sceneUuid, inputUuid: inp.inputUuid, createdByFleet: true });
    expect(cfg().recovery).toMatchObject({ prevScene: 'Scene', vcamByFleet: true });
    expect(fake.obs.program).toBe(SCENE);
    expect(fake.obs.vcam).toBe(true);
    const item = fake.obs.sceneItems[SCENE].find((i) => i.sourceName === INPUT);
    expect(item.sceneItemEnabled).toBe(true);
    expect(item.transform).toEqual({ positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: 1920, boundsHeight: 1080 });

    const s = await call('stop');
    expect(s).toMatchObject({ ok: true, state: 'connected', outputLive: false, vcamByFleet: false, recoveryPending: false });
    expect(fake.obs.program).toBe('Scene');
    expect(fake.obs.vcam).toBe(false);
    expect(cfg().recovery).toBe(null);
    expect(feed.stops).toBe(1);
    // nothing Fleet sent mutates a user scene or input
    for (const m of fake.mutating()) {
      if (m.type === 'SetCurrentProgramScene' || m.type === 'StartVirtualCam' || m.type === 'StopVirtualCam') continue;
      const d = m.data || {};
      if (d.sceneName !== undefined) expect(d.sceneName).toBe(SCENE);
      if (d.inputName !== undefined) expect(d.inputName).toBe(INPUT);
      if (d.sourceName !== undefined) expect(d.sourceName).toBe(INPUT);
    }
    expect(JSON.stringify(fake.obs.sceneItems.Scene)).toBe(userItems);
    expect(fake.obs.inputs.find((i) => i.inputName === 'Mic').inputSettings).toEqual({ device_id: 'default' });
    expect(fake.types().filter((t) => /^Remove/.test(t))).toEqual([]);
  });

  it('F5/AC4: Start from idle connects and goes live (also from error and obs-closed)', async () => {
    expect((await call('status')).state).toBe('idle');
    await goLive();
    expect(fake.obs.connects).toBe(1);
    await call('disconnect');
    // from error
    fake.obs.connectFail = 'ECONNREFUSED';
    expect((await call('connect')).state).toBe('error');
    fake.obs.connectFail = null;
    await goLive();
    expect(fake.obs.connects).toBe(3);
    // from obs-closed
    fake.emitEvent('ExitStarted');
    fake.emitClose(1001);
    fake.obs.vcam = false;
    expect((await call('status')).state).toBe('obs-closed');
    await goLive();
    expect(fake.obs.connects).toBe(4);
    // a connect failure from Start returns the failure status
    await call('disconnect');
    fake.obs.connectFail = 4009;
    const f = await call('start');
    expect(f).toMatchObject({ ok: false, code: 'OBS_AUTH_FAILED', state: 'error' });
    expect(feed.running).toBe(false);
  });

  it('AC5: a second Start reuses the owned scene/input by UUID and only calls SetInputSettings for the URL', async () => {
    await goLive();
    await call('stop');
    const nScenes = fake.obs.scenes.length;
    const n = fake.obs.requests.length;
    const r = await goLive();
    const t = reqsSince(n).map((x) => x.type);
    expect(t).not.toContain('CreateScene');
    expect(t).not.toContain('CreateInput');
    expect(t).not.toContain('CreateSceneItem');
    const set = reqsSince(n).filter((x) => x.type === 'SetInputSettings');
    expect(set).toHaveLength(1);
    expect(set[0].data).toMatchObject({ inputName: INPUT, overlay: true, inputSettings: { url: feed.viewUrl() } });
    expect(fake.obs.inputs.find((i) => i.inputName === INPUT).inputSettings.url).toBe(feed.viewUrl());
    expect(feed.viewUrl()).toContain('SENTINELTOKEN2');
    expect(fake.obs.scenes).toHaveLength(nScenes);
    expect(fake.obs.inputs).toHaveLength(1);
    expect(r.feedUrl).toBe(feed.feedUrl());
  });

  it('AC6: vcam already active -> no StartVirtualCam on Start and no StopVirtualCam on Stop', async () => {
    fake.obs.vcam = true;
    const r = await goLive();
    expect(r.vcamByFleet).toBe(false);
    expect(cfg().recovery.vcamByFleet).toBe(false);
    await call('stop');
    expect(fake.types()).not.toContain('StartVirtualCam');
    expect(fake.types()).not.toContain('StopVirtualCam');
    expect(fake.obs.vcam).toBe(true);
  });

  it('AC8: user scene, foreign scene UUID, CreateScene 601 and foreign input -> OBS_NAME_CONFLICT with zero mutating requests', async () => {
    const run = async (prep, allowRefused) => {
      teardown();
      setup();
      prep();
      await call('connect');
      const r = await call('start');
      expect(r).toMatchObject({ ok: false, code: 'OBS_NAME_CONFLICT', state: 'error' });
      // the only "mutating" request allowed is a CreateScene that OBS refused (601), which changed nothing
      expect(fake.mutating().filter((m) => !(allowRefused && m.type === 'CreateScene'))).toEqual([]);
      expect(fake.obs.program).toBe('Scene');
      expect(feed.running).toBe(false);
      return r;
    };
    // the user's own 'Fleet Camera' scene
    await run(() => { fake.addScene(SCENE); });
    // a 'Fleet Camera' scene whose UUID isn't the one Fleet recorded
    await run(() => {
      fake.addScene(SCENE, 'scene-user');
      store.save('zoomStudioObs', Object.assign(O.DEFAULT_CONFIG(), { owned: { sceneUuid: 'scene-fleet-old', inputUuid: null, createdByFleet: true } }));
    });
    // CreateScene refused with 601
    await run(() => { fake.obs.failNext.CreateScene = 601; }, true);
    // a foreign 'Fleet Camera Feed' input (Fleet's own scene exists)
    await run(() => {
      fake.addScene(SCENE, 'scene-fleet');
      fake.addInput(INPUT, 'browser_source', { url: 'https://example.invalid/' }, 'input-user');
      store.save('zoomStudioObs', Object.assign(O.DEFAULT_CONFIG(), { owned: { sceneUuid: 'scene-fleet', inputUuid: 'input-fleet', createdByFleet: true } }));
    });
    // a non-browser 'Fleet Camera Feed' input
    await run(() => {
      fake.addScene(SCENE, 'scene-fleet');
      fake.addInput(INPUT, 'image_source', {}, 'input-fleet');
      store.save('zoomStudioObs', Object.assign(O.DEFAULT_CONFIG(), { owned: { sceneUuid: 'scene-fleet', inputUuid: 'input-fleet', createdByFleet: true } }));
    });
  });

  it('F10: obsWebSocketVersion below 5.3 uses createdByFleet ownership', async () => {
    teardown();
    setup({ version: '5.2.3', noUuids: true, scenes: ['Scene', SCENE], program: 'Scene' });
    const c = await call('start');
    expect(c).toMatchObject({ ok: false, code: 'OBS_NAME_CONFLICT' });
    expect(fake.mutating()).toEqual([]);

    teardown();
    setup({ version: '5.2.3', noUuids: true, scenes: ['Scene'], program: 'Scene' });
    const r = await goLive();
    expect(r.obsVersion).toBe('5.2.3');
    expect(cfg().owned).toEqual({ sceneUuid: null, inputUuid: null, createdByFleet: true });
    await call('stop');
    const n = fake.obs.requests.length;
    await goLive();
    const t = reqsSince(n).map((x) => x.type);
    expect(t).not.toContain('CreateScene');
    expect(t).not.toContain('CreateInput');
    expect(t).not.toContain('GetInputList');
    expect(t).toContain('SetInputSettings');
  });

  it('F11: Start with the program already on Fleet Camera keeps the pending recovery.prevScene', async () => {
    await goLive();
    expect(cfg().recovery.prevScene).toBe('Scene');
    // Fleet dies while live (no quit hook): OBS stays on Fleet Camera with the vcam on
    newSession();
    fake.obs.failNext.GetCurrentProgramScene = 702;   // reconcile fails and leaves recovery for later
    const c = await call('connect');
    expect(c.ok).toBe(true);
    expect(c.recoveryPending).toBe(true);
    expect(fake.obs.program).toBe(SCENE);
    await goLive();
    expect(cfg().recovery.prevScene).toBe('Scene');
    await call('stop');
    expect(fake.obs.program).toBe('Scene');
  });

  it('rollback after a failed step stops feedServer and keeps the owned ids', async () => {
    await call('connect');
    fake.obs.failNext.StartVirtualCam = 702;
    const r = await call('start');
    expect(r).toMatchObject({ ok: false, code: 'OBS_REQUEST_FAILED', state: 'error', outputLive: false });
    expect(feed.running).toBe(false);
    expect(feed.stops).toBe(1);
    expect(fake.obs.program).toBe('Scene');
    expect(cfg().recovery).toBe(null);
    const owned = cfg().owned;
    expect(owned.sceneUuid).toBe(sceneUuid(SCENE));
    expect(owned.inputUuid).toBe(fake.obs.inputs.find((i) => i.inputName === INPUT).inputUuid);
    expect(fake.obs.scenes.some((s) => s.sceneName === SCENE)).toBe(true);
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalledWith(false);
  });

  it('store.save throwing: Stop still restores prevScene (config is an in-memory write-through copy)', async () => {
    const save = vi.spyOn(store, 'save').mockImplementation(() => { throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' }); });
    await goLive();
    expect(save).toHaveBeenCalled();
    expect(fake.obs.program).toBe(SCENE);
    expect((await call('status')).recoveryPending).toBe(true);
    await call('stop');
    expect(fake.obs.program).toBe('Scene');
    expect((await call('status')).recoveryPending).toBe(false);
    expect(logger.lines.some((l) => /store-save/.test(JSON.stringify(l)))).toBe(true);
  });

  it('store.save throwing: a second Start still treats the Fleet scene / input as owned', async () => {
    vi.spyOn(store, 'save').mockImplementation(() => { throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' }); });
    await goLive();
    await call('stop');
    const r = await goLive();
    expect(r.code).toBeUndefined();
    expect(fake.obs.scenes.filter((s) => s.sceneName === SCENE)).toHaveLength(1);
    expect(fake.obs.inputs.filter((i) => i.inputName === INPUT)).toHaveLength(1);
    await call('stop');
    expect(fake.obs.program).toBe('Scene');
  });

  it('stop never switches scene when the user changed it or prevScene no longer exists', async () => {
    await goLive();
    fake.obs.program = 'Gaming';
    let n = fake.obs.requests.length;
    await call('stop');
    expect(reqsSince(n).map((x) => x.type)).not.toContain('SetCurrentProgramScene');
    expect(fake.obs.program).toBe('Gaming');

    fake.obs.program = 'Scene';
    await goLive();
    fake.obs.scenes = fake.obs.scenes.filter((s) => s.sceneName !== 'Scene');
    n = fake.obs.requests.length;
    const s = await call('stop');
    expect(reqsSince(n).map((x) => x.type)).not.toContain('SetCurrentProgramScene');
    expect(fake.obs.program).toBe(SCENE);
    expect(s.state).toBe('connected');
  });

  it('BUSY table: ops outside their allowed states return BUSY; status is always allowed', async () => {
    // idle
    expect(await codeOf(call('disconnect'))).toBe('BUSY');
    expect((await call('stop')).state).toBe('idle');
    // connected
    await call('connect');
    expect(await codeOf(call('connect'))).toBe('BUSY');
    expect(await codeOf(call('launch'))).toBe('BUSY');
    expect((await call('configSet', { port: 4456 })).ok).toBe(true);
    // starting
    const release = blockRequest('GetVideoSettings');
    const p = call('start');
    await flushIO();
    expect((await call('status')).state).toBe('starting');
    for (const op of ['connect', 'start', 'stop', 'disconnect', 'launch', 'configSet']) expect(await codeOf(call(op, {}))).toBe('BUSY');
    release();
    expect((await p).state).toBe('live');
    // live
    for (const op of ['connect', 'launch', 'configSet']) expect(await codeOf(call(op, {}))).toBe('BUSY');
    expect((await call('status')).state).toBe('live');
    // stopping
    const rel2 = blockRequest('StopVirtualCam');
    const q = call('stop');
    await flushIO();
    expect((await call('status')).state).toBe('stopping');
    for (const op of ['connect', 'start', 'stop', 'disconnect', 'launch', 'configSet']) expect(await codeOf(call(op, {}))).toBe('BUSY');
    rel2();
    expect((await q).state).toBe('connected');
    // connecting (launch window)
    await call('disconnect');
    await call('launch');
    fake.obs.connectFail = 'ECONNREFUSED';
    expect((await call('connect')).state).toBe('connecting');
    for (const op of ['connect', 'start', 'stop', 'disconnect', 'launch', 'configSet']) expect(await codeOf(call(op, {}))).toBe('BUSY');
    expect((await call('status')).state).toBe('connecting');
    // BUSY becomes the plain {ok:false, code:'BUSY'} result through toResult
    try { await call('connect'); } catch (e) { expect(errors.toResult(e)).toEqual({ ok: false, code: 'BUSY' }); }
  });

  it('live Start returns the current feedUrl', async () => {
    const a = await goLive();
    const n = fake.obs.requests.length;
    const b = await call('start');
    expect(b).toMatchObject({ ok: true, state: 'live', feedUrl: a.feedUrl });
    expect(fake.obs.requests.length).toBe(n);
    expect(feed.starts).toBe(1);
    // the obs-state event never carries the feedUrl
    expect(events.every((e) => e.feedUrl === undefined)).toBe(true);
  });

  it('VirtualcamStateChanged is ignored in starting/stopping and in live sets vcam-stopped-in-obs', async () => {
    const release = blockRequest('GetVideoSettings');
    const p = call('start');
    await flushIO();
    fake.emitEvent('VirtualcamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    release();
    const r = await p;
    expect(r.vcamByFleet).toBe(true);
    expect(r.reason).toBe(null);

    const n = events.length;
    fake.obs.vcam = false;
    fake.emitEvent('VirtualcamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    expect(events.length).toBe(n + 1);
    expect(lastEvent()).toMatchObject({ state: 'live', reason: 'vcam-stopped-in-obs', vcamByFleet: false });
    expect(cfg().recovery.vcamByFleet).toBe(false);
    await call('stop');
    expect(fake.types()).not.toContain('StopVirtualCam');

    await goLive();
    const rel2 = blockRequest('GetCurrentProgramScene');
    const q = call('stop');
    await flushIO();
    fake.emitEvent('VirtualcamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    rel2();
    const s = await q;
    expect(s.reason).toBe(null);
    expect(events.filter((e) => e.state === 'stopping')).toEqual([]);
  });

  it('setBackgroundThrottling(false) while live and (true) after stop', async () => {
    await goLive();
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    await call('stop');
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    // no webContents method -> no throw
    ctx.mainWindow.webContents = {};
    await goLive();
    await call('stop');
  });
});

// ── lifecycle / recovery ─────────────────────────────────────────────────

describe('obs.js lifecycle / recovery', () => {
  it('AC7: ExitStarted while live -> obs-closed, feedServer stopped, obs-state emitted, recovery kept, nothing throws', async () => {
    await goLive();
    const n = fake.obs.requests.length;
    expect(() => fake.emitEvent('ExitStarted')).not.toThrow();
    await flushIO();
    expect(lastEvent()).toMatchObject({ ok: true, state: 'obs-closed', outputLive: false, producer: false, vcamByFleet: false, recoveryPending: true });
    expect(feed.running).toBe(false);
    expect(feed.stops).toBe(1);
    expect(cfg().recovery).toMatchObject({ prevScene: 'Scene', vcamByFleet: false });
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(fake.obs.requests.length).toBe(n);   // no OBS calls
    const e = events.length;
    expect(() => fake.emitClose(1001)).not.toThrow();
    expect(events.length).toBe(e);
  });

  it('F2/AC7: ExitStarted or a close Fleet did not start persists recovery.vcamByFleet = false', async () => {
    await goLive();
    expect(cfg().recovery.vcamByFleet).toBe(true);
    fake.emitEvent('ExitStarted');
    expect(cfg().recovery).toMatchObject({ prevScene: 'Scene', vcamByFleet: false });

    teardown();
    setup();
    await goLive();
    expect(cfg().recovery.vcamByFleet).toBe(true);
    fake.emitClose(1006);   // OBS crashed: no ExitStarted
    expect((await call('status')).state).toBe('obs-closed');
    expect(cfg().recovery).toMatchObject({ prevScene: 'Scene', vcamByFleet: false });
  });

  it('F2/AC9: OBS exit -> user starts the vcam -> reconnect -> zero StopVirtualCam', async () => {
    await goLive();
    fake.emitEvent('ExitStarted');
    fake.emitClose(1001);
    // OBS restarts on its last scene; the user starts the virtual camera themselves
    fake.obs.vcam = true;
    fake.reset();
    const r = await call('connect');
    expect(r).toMatchObject({ ok: true, state: 'connected', reason: 'recovered', recoveryPending: false });
    expect(fake.types()).not.toContain('StopVirtualCam');
    expect(fake.obs.vcam).toBe(true);
    expect(fake.obs.program).toBe('Scene');
  });

  it('F2: disconnect sets closingByFleet so its own close is not treated as an OBS exit', async () => {
    await goLive();
    const d = await call('disconnect');
    expect(d).toMatchObject({ ok: true, state: 'idle', outputLive: false });
    expect(fake.obs.closes).toBe(1);
    await flushIO();   // the fake socket close arrives after disconnect returned
    expect((await call('status')).state).toBe('idle');
    expect(events.some((e) => e.state === 'obs-closed')).toBe(false);
    expect(fake.obs.program).toBe('Scene');
    expect(cfg().recovery).toBe(null);
  });

  it('AC9: reconcile on connect restores prevScene, stops the Fleet vcam, clears recovery, reason recovered', async () => {
    await goLive();
    hooks['before-quit'][0]({ preventDefault: vi.fn() });   // Fleet quits; the raw frames may never flush
    await flushIO();
    expect(fake.obs.program).toBe(SCENE);
    expect(fake.obs.vcam).toBe(true);
    newSession();
    fake.reset();
    const r = await call('connect');
    expect(r).toMatchObject({ ok: true, state: 'connected', reason: 'recovered', recoveryPending: false });
    expect(lastEvent()).toMatchObject({ reason: 'recovered' });
    expect(fake.types()).toEqual(['GetCurrentProgramScene', 'GetSceneList', 'SetCurrentProgramScene', 'GetVirtualCamStatus', 'StopVirtualCam']);
    expect(fake.obs.program).toBe('Scene');
    expect(fake.obs.vcam).toBe(false);
    expect(cfg().recovery).toBe(null);
  });

  it('AC9: reconcile makes no switch when the user changed scene', async () => {
    store.save('zoomStudioObs', Object.assign(O.DEFAULT_CONFIG(), { recovery: { prevScene: 'Scene', vcamByFleet: false, at: 1 } }));
    fake.obs.program = 'Gaming';
    const r = await call('connect');
    expect(r).toMatchObject({ ok: true, reason: 'recovered', recoveryPending: false });
    expect(fake.types()).not.toContain('SetCurrentProgramScene');
    expect(fake.types()).not.toContain('StopVirtualCam');
    expect(fake.obs.program).toBe('Gaming');
  });

  it('F1: status.recoveryPending mirrors recovery !== null', async () => {
    expect((await call('status')).recoveryPending).toBe(false);
    store.save('zoomStudioObs', Object.assign(O.DEFAULT_CONFIG(), { recovery: { prevScene: 'Scene', vcamByFleet: false, at: 1 } }));
    newSession();   // the config is loaded once per session (in-memory write-through copy)
    expect((await call('status')).recoveryPending).toBe(true);
    expect(O._snapshot().recoveryPending).toBe(true);
    await call('connect');
    expect((await call('status')).recoveryPending).toBe(false);
    await goLive();
    expect((await call('status')).recoveryPending).toBe(true);
    await call('stop');
    expect((await call('status')).recoveryPending).toBe(false);
  });

  it('AC10: producer gone 5 s while live -> stop with reason feed-lost; reconnect within 5 s cancels', async () => {
    await goLive();
    feed.flowing = true;
    feed.setProducer(true);
    expect(lastEvent().producer).toBe(true);
    feed.setProducer(false);
    await clock.advance(4000);
    expect((await call('status')).state).toBe('live');
    feed.setProducer(true);
    await clock.advance(6000);
    expect((await call('status')).state).toBe('live');
    feed.setProducer(false);
    await clock.advance(5000);
    expect(lastEvent()).toMatchObject({ state: 'connected', reason: 'feed-lost', outputLive: false });
    expect(fake.obs.program).toBe('Scene');
    expect(fake.obs.vcam).toBe(false);
    expect(feed.running).toBe(false);
    expect(clock.timers.size).toBe(0);
  });

  it('F3/AC10: producer connected but silent 5 s -> stop with reason feed-lost', async () => {
    await goLive();
    feed.setProducer(true);   // connected, never sends a frame
    await clock.advance(4000);
    expect((await call('status')).state).toBe('live');
    await clock.advance(2000);
    expect(lastEvent()).toMatchObject({ state: 'connected', reason: 'feed-lost' });

    // frames flow, then stall
    await goLive();
    feed.setProducer(true);
    feed.flowing = true;
    await clock.advance(10000);
    expect((await call('status')).state).toBe('live');
    feed.flowing = false;
    feed.frameAt = clock.now();
    await clock.advance(4000);
    expect((await call('status')).state).toBe('live');
    await clock.advance(2000);
    expect((await call('status')).reason).toBe('feed-lost');
  });

  it('render-process-gone / did-start-navigation start the producer-loss timer', async () => {
    await goLive();
    feed.setProducer(true);
    feed.flowing = true;
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    await clock.advance(5000);
    expect((await call('status')).reason).toBe('feed-lost');

    await goLive();
    feed.setProducer(true);
    wc.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true });   // in-page route change
    await clock.advance(6000);
    expect((await call('status')).state).toBe('live');
    wc.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true });  // reload
    await clock.advance(5000);
    expect((await call('status')).reason).toBe('feed-lost');
  });

  it('quit hook sends StopVirtualCam and SetCurrentProgramScene via sendRaw without awaiting', async () => {
    await goLive();
    await call('disconnect');
    await goLive();
    expect(electron.app.on.mock.calls.map((c) => c[0]).sort()).toEqual(['before-quit', 'will-quit']);
    const n = fake.obs.requests.length;
    const ev = { preventDefault: vi.fn() };
    const ret = hooks['before-quit'][0](ev);
    expect(ret).toBeUndefined();
    expect(fake.obs.raw).toEqual([
      { type: 'StopVirtualCam', data: undefined },
      { type: 'SetCurrentProgramScene', data: { sceneName: 'Scene' } },
    ]);
    expect(fake.obs.requests.length).toBe(n);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(feed.running).toBe(false);
    hooks['will-quit'][0]({ preventDefault: vi.fn() });
    expect(fake.obs.raw).toHaveLength(2);
    // the record stays for reconcile on the next connect
    expect(cfg().recovery).toMatchObject({ prevScene: 'Scene', vcamByFleet: true });
  });
});

// ── password ─────────────────────────────────────────────────────────────

describe('obs.js password', () => {
  const PW = 'SENTINEL-PASSWORD-9f2';

  it('F13: password saved via credentials only when encryption is available, else passwordSaved false', async () => {
    fake.obs.password = PW;
    const r = await call('configSet', { password: PW });
    expect(creds.set).toHaveBeenCalledWith('zoomStudioObsPassword', PW);
    expect(r.passwordSaved).toBe(true);
    expect((await call('connect')).ok).toBe(true);
    expect(fake.obs.connectArgs[0].password).toBe(PW);

    teardown();
    setup();
    enc = false;
    fake.obs.password = PW;
    const m = await call('configSet', { password: PW });
    expect(creds.set).not.toHaveBeenCalled();
    expect(m.passwordSaved).toBe(false);
    expect((await call('connect')).ok).toBe(true);
    expect(fake.obs.connectArgs[0].password).toBe(PW);
    expect(fs.readFileSync(path.join(TMP, 'zoom_studio_obs.json'), 'utf8').includes(PW)).toBe(false);
    expect(logger.text().includes(PW)).toBe(false);
    expect(JSON.stringify(events).includes(PW)).toBe(false);
  });

  it("F13: password null or '' -> credentials.delete and the in-memory copy cleared", async () => {
    enc = false;
    await call('configSet', { password: PW });
    const a = await call('configSet', { password: null });
    expect(creds.delete).toHaveBeenCalledWith('zoomStudioObsPassword');
    expect(a.passwordSaved).toBe(null);
    await call('connect');
    expect(fake.obs.connectArgs[0].password).toBeUndefined();
    await call('disconnect');

    enc = true;
    await call('configSet', { password: PW });
    expect(creds.map.get('zoomStudioObsPassword')).toBe(PW);
    const b = await call('configSet', { password: '' });
    expect(creds.delete).toHaveBeenCalledTimes(2);
    expect(creds.map.has('zoomStudioObsPassword')).toBe(false);
    expect(b.passwordSaved).toBe(null);
    await call('connect');
    expect(fake.obs.connectArgs[1].password).toBeUndefined();
  });

  it('F13: credentials.get is skipped on load when encryption is unavailable', async () => {
    creds.map.set('zoomStudioObsPassword', PW);
    enc = false;
    const s = await call('status');
    expect(creds.get).not.toHaveBeenCalled();
    expect(s.passwordSaved).toBe(null);
    await call('connect');
    expect(fake.obs.connectArgs[0].password).toBeUndefined();

    newSession();
    enc = true;
    const t = await call('status');
    expect(creds.get).toHaveBeenCalledWith('zoomStudioObsPassword');
    expect(t.passwordSaved).toBe(true);
    await call('disconnect').catch(() => {});
    await call('connect');
    expect(fake.obs.connectArgs[fake.obs.connectArgs.length - 1].password).toBe(PW);
  });
});
