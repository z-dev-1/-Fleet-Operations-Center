'use strict';
/**
 * src/zoom/studio/obs.js — OBS orchestrator (design §4.6 + rev-1 findings), main process singleton.
 *
 * Fleet drives OBS over obs-websocket v5: it owns one scene ('Fleet Camera') with one browser source
 * ('Fleet Camera Feed') that shows the frames the renderer pushes to the loopback feedServer, switches
 * the program scene to it, and starts the OBS virtual camera. Only the scene / input / virtual camera
 * Fleet created or started are ever changed; the user's scenes and inputs are never modified.
 *
 *   status, configSet, connect, disconnect, start, stop, launch   each fn(input, {event, ctx})
 *
 * Every op returns the full status shape (F4):
 *   {ok, state, reason, hint, canLaunch, passwordSaved, host, port, exePath, obsVersion,
 *    outputLive, producer, vcamByFleet, recoveryPending, launchedByFleet}
 * A failure is Object.assign(statusSnapshot(), {ok:false, code}) with state 'error' (or 'connecting'
 * with reason 'obs-starting' inside the launch window), reason = code. Only BUSY is thrown
 * (ZoomError('BUSY'); zh()/toResult turns it, INVALID_INPUT and INTERNAL into results).
 * The start success adds feedUrl (and only there). 'zoomStudio:obs-state' events carry the same shape.
 *
 * States: idle | connecting | connected | starting | live | stopping | obs-closed | error
 *   idle, error, obs-closed : connect, launch, config-set, start (auto-connects first, F5)
 *   connecting, starting, stopping : status only
 *   connected : start, disconnect, config-set (applied on the next connect)
 *   live : stop, disconnect, start (returns the current feedUrl)
 *   status is always allowed; stop outside live is an idempotent no-op.
 *
 * Persisted (store 'zoomStudioObs', never a password):
 *   {version:1, host, port, exePath, hintShown, owned:{sceneUuid, inputUuid, createdByFleet},
 *    recovery:null|{prevScene, vcamByFleet, at}}
 * The password lives in credentials ('zoomStudioObsPassword') only when safeStorage encryption is
 * available, otherwise in memory for this session (passwordSaved:false).
 *
 * Logs carry op names and codes only: never the password, the feed token or a URL.
 */
const { ZoomError, MESSAGES } = require('../errors');
const { safeErr } = require('../redact');
const { hasUuidSupport } = require('./obs-auth');
const log = require('../../utils/logger')('zoom:studio');

const STORE_KEY = 'zoomStudioObs';
const CRED_KEY = 'zoomStudioObsPassword';
const EVENT = 'zoomStudio:obs-state';
const SCENE = 'Fleet Camera';
const INPUT = 'Fleet Camera Feed';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4455;
const LAUNCH_WINDOW_MS = 20000;
const RETRY_MS = 1000;
const LOSS_MS = 5000;
const STALL_MS = 5000;
const WATCHDOG_MS = 1000;
const FEED_W = 1280;
const FEED_H = 720;
const FEED_FPS = 30;

function DEFAULT_CONFIG() {
  return {
    version: 1, host: HOST, port: DEFAULT_PORT, exePath: null, hintShown: false,
    owned: { sceneUuid: null, inputUuid: null, createdByFleet: false },
    recovery: null,
  };
}

let _deps = {};
let S = _fresh();

function _fresh() {
  return {
    state: 'idle', reason: null, hint: false, canLaunch: false,
    obsVersion: null, outputLive: false, producer: false, vcamByFleet: false, launchedByFleet: false,
    liveSince: 0, launchUntil: 0, linkUp: false, closingByFleet: false,
    pw: null, passwordSaved: null, pwLoading: null, cfg: null,
    quitHooked: false, quitDone: false, ctx: null, client: null, feedServer: null, hookedWc: null,
    retryTimer: null, lossTimer: null, watchdog: null,
  };
}

function _setDeps(d) { _deps = d || {}; }

const _t = {
  now: () => (typeof _deps.now === 'function' ? _deps.now() : Date.now()),
  setTimeout: (fn, ms) => (_deps.setTimeout || setTimeout)(fn, ms),
  clearTimeout: (id) => (_deps.clearTimeout || clearTimeout)(id),
  setInterval: (fn, ms) => (_deps.setInterval || setInterval)(fn, ms),
  clearInterval: (id) => (_deps.clearInterval || clearInterval)(id),
};

function _resetForTests() {
  try { _cancelRetry(); _clearLiveTimers(); } catch (_) {}
  S = _fresh();
}

function _store() { return _deps.store || require('../../store'); }
function _creds() { return _deps.credentials || require('../../security/credentials'); }
function _electron() { return _deps.electron || require('electron'); }
function _launcher() { return _deps.launch || require('./obs-launch'); }

function _log(level, fields) {
  try { log[level]('[zoom-studio] obs', fields); } catch (_) {}
}

// ── config / recovery ────────────────────────────────────────────────────

function _norm(c) {
  const d = DEFAULT_CONFIG();
  if (!c || typeof c !== 'object') return d;
  const o = c.owned && typeof c.owned === 'object' ? c.owned : {};
  const r = c.recovery && typeof c.recovery === 'object' ? c.recovery : null;
  return {
    version: 1,
    host: HOST,   // loopback only; 'localhost' is normalized to 127.0.0.1
    port: Number.isInteger(c.port) && c.port >= 1024 && c.port <= 65535 ? c.port : DEFAULT_PORT,
    exePath: typeof c.exePath === 'string' && c.exePath ? c.exePath : null,
    hintShown: c.hintShown === true,
    owned: {
      sceneUuid: typeof o.sceneUuid === 'string' && o.sceneUuid ? o.sceneUuid : null,
      inputUuid: typeof o.inputUuid === 'string' && o.inputUuid ? o.inputUuid : null,
      createdByFleet: o.createdByFleet === true,
    },
    recovery: r ? {
      prevScene: typeof r.prevScene === 'string' && r.prevScene ? r.prevScene : null,
      vcamByFleet: r.vcamByFleet === true,
      at: Number.isFinite(r.at) ? r.at : 0,
    } : null,
  };
}

/**
 * In-memory write-through copy of the persisted config (code review #1): loaded once per session,
 * mutated in memory, persisted best-effort. Runtime decisions (recovery.prevScene, owned UUIDs,
 * vcamByFleet) always read the memory copy, so one failed store.save can't drop them.
 */
function _cfg() {
  if (!S.cfg) {
    let raw = null;
    try { raw = _store().load(STORE_KEY, DEFAULT_CONFIG()); } catch (e) {
      _log('warn', { op: 'store-load', err: safeErr(e) });
    }
    S.cfg = _norm(raw);
  }
  return S.cfg;
}

function _saveCfg(mut) {
  const c = _cfg();
  mut(c);
  try { _store().save(STORE_KEY, structuredClone(c)); } catch (e) { _log('warn', { op: 'store-save', err: safeErr(e) }); }
  return c;
}

function _setRecovery(rec) { _saveCfg((c) => { c.recovery = rec; }); }

function _patchRecovery(patch) {
  if (!_cfg().recovery) return;
  _saveCfg((c) => { if (c.recovery) Object.assign(c.recovery, patch); });
}

// ── status shape ─────────────────────────────────────────────────────────

function _snapshot() {
  const c = _cfg();
  return {
    ok: true,
    state: S.state,
    reason: S.reason,
    hint: S.hint,
    canLaunch: S.canLaunch,
    passwordSaved: S.passwordSaved,
    host: c.host,
    port: c.port,
    exePath: c.exePath,
    obsVersion: S.obsVersion,
    outputLive: S.outputLive,
    producer: S.producer,
    vcamByFleet: S.vcamByFleet,
    recoveryPending: c.recovery !== null,   // F1
    launchedByFleet: S.launchedByFleet,     // D1 / F15
  };
}

/** _fail(code, {state, reason, hint, canLaunch}) -> full status shape with ok:false, code (F4). */
function _fail(code, o = {}) {
  S.state = o.state || 'error';
  S.reason = o.reason || code;
  S.hint = o.hint === true;
  S.canLaunch = o.canLaunch === true;
  return Object.assign(_snapshot(), { ok: false, code });
}

function _codeOf(e) {
  const c = e && e.code;
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, c) ? c : 'INTERNAL';
}

function _statusOf(e) {
  return e && e.extra && typeof e.extra.status === 'number' ? e.extra.status : null;
}

function _conflict(what) { return new ZoomError('OBS_NAME_CONFLICT', { reason: what }); }

function _emit(payload) {
  const ctx = S.ctx;
  try {
    if (ctx && typeof ctx.sendToWindow === 'function') ctx.sendToWindow(EVENT, payload || _snapshot());
  } catch (e) { _log('warn', { op: 'emit', err: safeErr(e) }); }
}

function _keep(env) { if (env && env.ctx) S.ctx = env.ctx; }

function _busy(allowed) {
  if (!allowed.includes(S.state)) throw new ZoomError('BUSY');
}

// ── collaborators ────────────────────────────────────────────────────────

function _client() {
  if (S.client) return S.client;
  const cl = typeof _deps.createClient === 'function'
    ? _deps.createClient()
    : require('./obs-client').createObsClient();
  cl.on('event', _onEvent);
  cl.on('close', _onClose);
  S.client = cl;
  return cl;
}

function _feed() {
  if (S.feedServer) return S.feedServer;
  const fs = _deps.feedServer || require('./obs-feed-server').createFeedServer();
  fs.onProducer(_onProducer);
  S.feedServer = fs;
  return fs;
}

async function _feedStop() {
  try { await _feed().stop(); } catch (e) { _log('warn', { op: 'feed-stop', err: safeErr(e) }); }
}

function _req(type, data) { return _client().request(type, data); }

function _wc() {
  try {
    const w = S.ctx && S.ctx.mainWindow;
    if (!w || (typeof w.isDestroyed === 'function' && w.isDestroyed())) return null;
    return w.webContents || null;
  } catch (_) { return null; }
}

function _throttle(on) {
  const wc = _wc();
  try { if (wc && typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(on); } catch (_) {}
}

function _encOk() {
  try {
    const ss = _electron().safeStorage;
    return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
  } catch (_) { return false; }
}

/** F13: credentials.get only when safeStorage encryption is available; otherwise the password is unset. */
function _loadPassword() {
  if (!S.pwLoading) {
    S.pwLoading = (async () => {
      if (!_encOk()) return;
      try {
        const v = await _creds().get(CRED_KEY);
        if (typeof v === 'string' && v && S.pw === null) { S.pw = v; S.passwordSaved = true; }
      } catch (e) { _log('warn', { op: 'password-load', err: safeErr(e) }); }
    })();
  }
  return S.pwLoading;
}

// ── connect / reconcile ──────────────────────────────────────────────────

function _cancelRetry() {
  if (S.retryTimer) { _t.clearTimeout(S.retryTimer); S.retryTimer = null; }
}

async function _connect() {
  _cancelRetry();
  S.state = 'connecting';
  S.reason = null;
  S.hint = false;
  S.canLaunch = false;
  S.closingByFleet = false;
  await _loadPassword();
  return _attempt();
}

async function _attempt() {
  const c = _cfg();
  let info;
  try {
    info = await _client().connect({ host: c.host, port: c.port, password: S.pw || undefined });
  } catch (e) {
    const code = _codeOf(e);
    if (code === 'OBS_UNREACHABLE' && _t.now() < S.launchUntil) {
      S.retryTimer = _t.setTimeout(_retry, RETRY_MS);
      return _fail(code, { state: 'connecting', reason: 'obs-starting' });
    }
    S.launchUntil = 0;   // OBS_AUTH_FAILED / OBS_PASSWORD_REQUIRED / OBS_UNSUPPORTED end the loop
    if (code === 'OBS_UNREACHABLE') {
      let running = null;
      try { running = await _launcher().isRunning(); } catch (_) { running = null; }
      if (running === true) {
        _saveCfg((x) => { x.hintShown = true; });
        _log('info', { op: 'connect', code: 'OBS_SERVER_DISABLED' });
        return _fail('OBS_SERVER_DISABLED', { hint: true });
      }
      if (running === false) {
        _log('info', { op: 'connect', code: 'OBS_NOT_RUNNING' });
        return _fail('OBS_NOT_RUNNING', { canLaunch: true });
      }
    }
    _log('info', { op: 'connect', code });
    return _fail(code);
  }
  return _onConnected(info);
}

function _retry() {
  S.retryTimer = null;
  if (S.state !== 'connecting') return;
  _attempt().then((r) => {
    if (!(r && r.ok === false && r.reason === 'obs-starting')) _emit(r);
  }, (e) => {
    _log('warn', { op: 'connect-retry', err: safeErr(e) });
    _emit(_fail('INTERNAL'));
  });
}

async function _onConnected(info) {
  S.linkUp = true;
  S.obsVersion = info && info.obsWebSocketVersion != null ? String(info.obsWebSocketVersion) : null;
  S.launchedByFleet = false;
  S.launchUntil = 0;
  _hookQuit();
  const recovered = await _reconcile();
  if (!S.linkUp) return _fail('OBS_CLOSED', { state: 'obs-closed' });
  S.state = 'connected';
  S.reason = recovered ? 'recovered' : null;
  S.hint = false;
  S.canLaunch = false;
  _log('info', { op: 'connect', code: 'OK', recovered });
  return _snapshot();
}

/** Undo what a previous session left behind (Fleet quit / crash while live). Never throws. */
async function _reconcile() {
  const rec = _cfg().recovery;
  if (!rec) return false;
  try {
    if (rec.prevScene) {
      const cur = await _req('GetCurrentProgramScene');
      if (cur && cur.currentProgramSceneName === SCENE) {
        const sl = await _req('GetSceneList');
        const scenes = Array.isArray(sl && sl.scenes) ? sl.scenes : [];
        if (scenes.some((s) => s && s.sceneName === rec.prevScene)) {
          await _req('SetCurrentProgramScene', { sceneName: rec.prevScene });
        }
      }
    }
    // F2: only true when the record survived a Fleet-side exit with OBS still running.
    if (rec.vcamByFleet) {
      const vs = await _req('GetVirtualCamStatus');
      if (vs && vs.outputActive === true) await _req('StopVirtualCam');
    }
  } catch (e) {
    _log('warn', { op: 'reconcile', code: _codeOf(e) });
    return false;
  }
  _setRecovery(null);
  return true;
}

// ── start / stop ─────────────────────────────────────────────────────────

function _inputSettings() {
  return {
    url: _feed().viewUrl(), width: FEED_W, height: FEED_H, fps_custom: true, fps: FEED_FPS,
    shutdown: false, restart_when_active: false, reroute_audio: false,
  };
}

async function _ensureScene(hasUuid) {
  const sl = await _req('GetSceneList');
  const scenes = Array.isArray(sl && sl.scenes) ? sl.scenes : [];
  const owned = _cfg().owned;
  const ex = scenes.find((s) => s && s.sceneName === SCENE);
  if (ex) {
    // F10: below obs-websocket 5.3 there are no UUIDs; ownership comes from owned.createdByFleet.
    const mine = hasUuid ? !!owned.sceneUuid && ex.sceneUuid === owned.sceneUuid : owned.createdByFleet === true;
    if (!mine) throw _conflict('scene');
    return;
  }
  let r;
  try {
    r = await _req('CreateScene', { sceneName: SCENE });
  } catch (e) {
    if (_statusOf(e) === 601) throw _conflict('scene');
    throw e;
  }
  _saveCfg((c) => {
    c.owned.sceneUuid = r && typeof r.sceneUuid === 'string' && r.sceneUuid ? r.sceneUuid : null;
    c.owned.createdByFleet = true;
  });
}

async function _ensureInput(hasUuid) {
  const settings = _inputSettings();
  let info = null;
  try {
    info = await _req('GetInputSettings', { inputName: INPUT });
  } catch (e) {
    if (_statusOf(e) !== 600) throw e;
  }
  if (!info) {
    let r;
    try {
      r = await _req('CreateInput', { sceneName: SCENE, inputName: INPUT, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: true });
    } catch (e) {
      if (_statusOf(e) === 601) throw _conflict('input');
      throw e;
    }
    _saveCfg((c) => {
      c.owned.inputUuid = r && typeof r.inputUuid === 'string' && r.inputUuid ? r.inputUuid : null;
      c.owned.createdByFleet = true;
    });
    return;
  }
  if (info.inputKind !== 'browser_source') throw _conflict('input');
  const owned = _cfg().owned;
  let mine;
  if (hasUuid) {
    const il = await _req('GetInputList', { inputKind: 'browser_source' });
    const inputs = Array.isArray(il && il.inputs) ? il.inputs : [];
    const it = inputs.find((i) => i && i.inputName === INPUT);
    mine = !!(it && owned.inputUuid && it.inputUuid === owned.inputUuid);
  } else {
    mine = owned.createdByFleet === true;
  }
  if (!mine) throw _conflict('input');
  await _req('SetInputSettings', { inputName: INPUT, inputSettings: settings, overlay: true });
}

async function _ensureItems(vid) {
  const r = await _req('GetSceneItemList', { sceneName: SCENE });
  const items = Array.isArray(r && r.sceneItems) ? r.sceneItems : [];
  const mine = items.find((i) => i && i.sourceName === INPUT);
  let id = mine ? mine.sceneItemId : null;
  if (!mine) {
    const c = await _req('CreateSceneItem', { sceneName: SCENE, sourceName: INPUT, sceneItemEnabled: true });
    id = c && c.sceneItemId;
  }
  for (const it of items) {
    if (!it || it === mine) continue;   // Fleet's own scene: hide anything else in it
    await _req('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: it.sceneItemId, sceneItemEnabled: false });
  }
  await _req('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: id, sceneItemEnabled: true });
  const bw = vid && Number.isFinite(vid.baseWidth) && vid.baseWidth > 0 ? vid.baseWidth : FEED_W;
  const bh = vid && Number.isFinite(vid.baseHeight) && vid.baseHeight > 0 ? vid.baseHeight : FEED_H;
  await _req('SetSceneItemTransform', {
    sceneName: SCENE,
    sceneItemId: id,
    sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: bw, boundsHeight: bh },
  });
}

/**
 * Guarded stop steps: StopVirtualCam only if Fleet started it; restore prevScene only if the program
 * is still Fleet Camera and prevScene still exists. recovery is cleared only if both succeeded.
 * OBS errors are logged (code only) and never thrown.
 */
async function _restoreObs(clearRecovery) {
  let ok = true;
  const hadVcam = S.vcamByFleet;
  let vcamFailed = false;
  if (hadVcam) {
    try {
      await _req('StopVirtualCam');
    } catch (e) {
      if (_statusOf(e) !== 501) { ok = false; vcamFailed = true; _log('warn', { op: 'stop-vcam', code: _codeOf(e) }); }
    }
  }
  S.vcamByFleet = false;
  const rec = _cfg().recovery;
  if (rec && rec.prevScene) {
    try {
      const cur = await _req('GetCurrentProgramScene');
      if (cur && cur.currentProgramSceneName === SCENE) {
        const sl = await _req('GetSceneList');
        const scenes = Array.isArray(sl && sl.scenes) ? sl.scenes : [];
        if (scenes.some((s) => s && s.sceneName === rec.prevScene)) {
          await _req('SetCurrentProgramScene', { sceneName: rec.prevScene });
        }
      }
    } catch (e) {
      ok = false;
      _log('warn', { op: 'restore-scene', code: _codeOf(e) });
    }
  }
  if (ok && clearRecovery) _setRecovery(null);
  else if (hadVcam && !vcamFailed && rec && rec.vcamByFleet) _patchRecovery({ vcamByFleet: false });
}

async function _stopSteps() {
  S.state = 'stopping';
  _clearLiveTimers();
  await _restoreObs(true);
  await _feedStop();
  _throttle(true);
  S.outputLive = false;
  S.producer = false;
  if (S.state === 'stopping') S.state = S.linkUp ? 'connected' : 'obs-closed';
  S.reason = null;
}

async function _start() {
  S.state = 'starting';
  S.reason = null;
  S.hint = false;
  S.canLaunch = false;
  const fs = _feed();
  let obsPhase = false;
  let wroteRecovery = false;
  try {
    await fs.start();
    const ver = await _req('GetVersion');
    if (ver && ver.obsWebSocketVersion != null) S.obsVersion = String(ver.obsWebSocketVersion);
    const hasUuid = hasUuidSupport(S.obsVersion);
    const vid = await _req('GetVideoSettings');
    obsPhase = true;
    await _ensureScene(hasUuid);
    await _ensureInput(hasUuid);
    await _ensureItems(vid);
    const cur = await _req('GetCurrentProgramScene');
    const curName = cur && typeof cur.currentProgramSceneName === 'string' ? cur.currentProgramSceneName : null;
    const old = _cfg().recovery;
    // F11: if the program is already Fleet Camera, keep a pending recovery.prevScene.
    const prevScene = curName && curName !== SCENE ? curName : (old && old.prevScene) || null;
    _setRecovery({ prevScene, vcamByFleet: false, at: _t.now() });
    wroteRecovery = true;
    await _req('SetCurrentProgramScene', { sceneName: SCENE });
    const vs = await _req('GetVirtualCamStatus');
    if (vs && vs.outputActive === true) {
      S.vcamByFleet = false;   // the user's virtual camera: never stopped by Fleet
    } else {
      try {
        await _req('StartVirtualCam');
        S.vcamByFleet = true;
      } catch (e) {
        if (_statusOf(e) !== 500) throw e;
        S.vcamByFleet = false;
      }
    }
    _patchRecovery({ vcamByFleet: S.vcamByFleet });
    _throttle(false);
  } catch (e) {
    const code = _codeOf(e);
    _log('warn', { op: 'start', code, status: _statusOf(e) });
    if (obsPhase) await _restoreObs(wroteRecovery);   // rollback; the owned scene / input are kept
    S.vcamByFleet = false;
    await _feedStop();
    _throttle(true);
    S.outputLive = false;
    S.producer = false;
    return S.linkUp ? _fail(code) : _fail(code, { state: 'obs-closed' });
  }
  if (S.state !== 'starting') return _fail('OBS_CLOSED', { state: S.state });
  S.state = 'live';
  S.outputLive = true;
  S.liveSince = _t.now();
  _hookWc();
  _startWatchdog();
  if (!S.producer) _armLoss();
  _log('info', { op: 'start', code: 'OK', vcamByFleet: S.vcamByFleet });
  return Object.assign(_snapshot(), { feedUrl: fs.feedUrl() });
}

// ── producer loss / stall watchdog ───────────────────────────────────────

function _armLoss() {
  if (S.lossTimer || S.state !== 'live') return;
  S.lossTimer = _t.setTimeout(() => { S.lossTimer = null; _lost(); }, LOSS_MS);
}

function _cancelLoss() {
  if (S.lossTimer) { _t.clearTimeout(S.lossTimer); S.lossTimer = null; }
}

function _startWatchdog() {
  _stopWatchdog();
  // F3 / D2: producer connected but no frame for 5 s -> same path as producer loss.
  S.watchdog = _t.setInterval(() => {
    if (S.state !== 'live' || !S.producer) return;
    const last = Math.max(S.liveSince, Number(_feed().lastFrameAt) || 0);
    if (_t.now() - last > STALL_MS) _lost();
  }, WATCHDOG_MS);
}

function _stopWatchdog() {
  if (S.watchdog) { _t.clearInterval(S.watchdog); S.watchdog = null; }
}

function _clearLiveTimers() { _cancelLoss(); _stopWatchdog(); }

function _lost() {
  if (S.state !== 'live') return Promise.resolve();
  _log('info', { op: 'feed-lost' });
  return _stopSteps().then(() => {
    S.reason = 'feed-lost';
    _emit();
  }, (e) => { _log('warn', { op: 'feed-lost', err: safeErr(e) }); });
}

function _onProducer(v) {
  S.producer = !!v;
  if (S.state !== 'live') return;
  if (v) _cancelLoss(); else _armLoss();
  _emit();
}

function _hookWc() {
  const wc = _wc();
  if (!wc || S.hookedWc === wc || typeof wc.on !== 'function') return;
  S.hookedWc = wc;
  wc.on('render-process-gone', () => { if (S.state === 'live') _armLoss(); });
  wc.on('did-start-navigation', (...a) => {
    const d = a[0] && typeof a[0] === 'object' ? a[0] : {};
    const sameDoc = d.isSameDocument === true || a[2] === true;
    const mainFrame = typeof d.isMainFrame === 'boolean' ? d.isMainFrame : a[3];
    if (sameDoc || mainFrame === false) return;   // in-page route changes keep the feed
    if (S.state === 'live') _armLoss();
  });
}

// ── OBS events ───────────────────────────────────────────────────────────

function _onEvent(ev) {
  const type = ev && ev.eventType;
  if (type === 'ExitStarted') { _onObsGone('exit'); return; }
  if (type === 'VirtualcamStateChanged') {
    if (S.state !== 'live') return;   // ignored in starting / stopping
    const d = (ev && ev.eventData) || {};
    if (d.outputActive === false) {
      S.vcamByFleet = false;
      _patchRecovery({ vcamByFleet: false });
      S.reason = 'vcam-stopped-in-obs';
      _emit();
    }
  }
}

function _onClose() {
  if (S.closingByFleet) { S.closingByFleet = false; return; }   // F2: Fleet's own close
  _onObsGone('close');
}

/** OBS exited or closed the socket: tidy up locally (no OBS calls). */
function _onObsGone(src) {
  if (!S.linkUp) return;
  S.linkUp = false;
  _clearLiveTimers();
  _cancelRetry();
  S.outputLive = false;
  S.producer = false;
  S.vcamByFleet = false;
  _feedStop();
  _throttle(true);
  // F2: the virtual camera can't outlive OBS, so a later one isn't Fleet's. Keep prevScene.
  _patchRecovery({ vcamByFleet: false });
  S.state = 'obs-closed';
  S.reason = null;
  S.hint = false;
  S.canLaunch = false;
  _log('info', { op: 'obs-gone', src });
  _emit();
}

// ── quit ─────────────────────────────────────────────────────────────────

function _hookQuit() {
  if (S.quitHooked) return;
  let app = null;
  try { app = _electron().app; } catch (_) { app = null; }
  if (!app || typeof app.on !== 'function') return;
  S.quitHooked = true;
  app.on('before-quit', _onQuit);
  app.on('will-quit', _onQuit);
}

/** Synchronous best effort: no await, no preventDefault. recovery stays for the next connect. */
function _onQuit() {
  if (S.quitDone) return;
  S.quitDone = true;
  try {
    const cl = S.client;
    const active = S.state === 'live' || S.state === 'starting' || S.state === 'stopping';
    if (cl && S.linkUp) {
      if (S.vcamByFleet) cl.sendRaw('StopVirtualCam');
      const rec = active ? _cfg().recovery : null;
      if (rec && rec.prevScene) cl.sendRaw('SetCurrentProgramScene', { sceneName: rec.prevScene });
      S.closingByFleet = true;
      S.linkUp = false;
      cl.close();
    }
  } catch (e) { _log('warn', { op: 'quit', err: safeErr(e) }); }
  _clearLiveTimers();
  _cancelRetry();
  try {
    const fs = S.feedServer;
    if (fs) Promise.resolve(fs.stop()).catch(() => {});
  } catch (_) {}
}

// ── IPC ops ──────────────────────────────────────────────────────────────

async function status(_input, env) {
  _keep(env);
  await _loadPassword();
  return _snapshot();
}

async function configSet(input, env) {
  _keep(env);
  _busy(['idle', 'error', 'obs-closed', 'connected']);
  const p = input && typeof input === 'object' ? input : {};
  await _loadPassword();
  _saveCfg((c) => {
    if (p.host !== undefined) c.host = HOST;
    if (Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535) c.port = p.port;
    if (p.exePath !== undefined) c.exePath = typeof p.exePath === 'string' && p.exePath ? p.exePath : null;
  });
  if (Object.prototype.hasOwnProperty.call(p, 'password')) {
    const pw = p.password;
    if (pw === null || pw === undefined || pw === '') {
      // F13: null and '' both mean "no password": delete it and clear the in-memory copy.
      S.pw = null;
      S.passwordSaved = null;
      try { await _creds().delete(CRED_KEY); } catch (e) { _log('warn', { op: 'password-delete', err: safeErr(e) }); }
    } else {
      S.pw = String(pw);
      S.passwordSaved = false;
      if (_encOk()) {
        try {
          await _creds().set(CRED_KEY, S.pw);
          S.passwordSaved = true;
        } catch (e) { _log('warn', { op: 'password-save', err: safeErr(e) }); }
      }
    }
  }
  _log('info', { op: 'config-set' });
  const out = _snapshot();
  _emit(out);
  return out;
}

async function connect(_input, env) {
  _keep(env);
  _busy(['idle', 'error', 'obs-closed']);
  const r = await _connect();
  _emit(r);
  return r;
}

async function disconnect(_input, env) {
  _keep(env);
  _busy(['connected', 'live']);
  if (S.state === 'live') await _stopSteps();
  // F2: mark the close as Fleet's own before closing.
  S.closingByFleet = true;
  S.linkUp = false;
  try { if (S.client) S.client.close(); } catch (e) { _log('warn', { op: 'disconnect', err: safeErr(e) }); }
  S.state = 'idle';
  S.reason = null;
  S.hint = false;
  S.canLaunch = false;
  S.launchedByFleet = false;
  _log('info', { op: 'disconnect' });
  const out = _snapshot();
  _emit(out);
  return out;
}

async function start(_input, env) {
  _keep(env);
  if (S.state === 'live') return Object.assign(_snapshot(), { feedUrl: _feed().feedUrl() });
  if (S.state === 'idle' || S.state === 'error' || S.state === 'obs-closed') {
    // F5: Start auto-connects (including reconcile) and continues only if that succeeds.
    const c = await _connect();
    if (!c.ok) { _emit(c); return c; }
  } else {
    _busy(['connected']);
  }
  const r = await _start();
  _emit(r.ok ? _snapshot() : r);   // the event never carries feedUrl
  return r;
}

async function stop(_input, env) {
  _keep(env);
  if (S.state !== 'live') {
    _busy(['connected', 'idle', 'error', 'obs-closed']);
    return _snapshot();   // idempotent
  }
  await _stopSteps();
  _log('info', { op: 'stop' });
  const out = _snapshot();
  _emit(out);
  return out;
}

async function launch(_input, env) {
  _keep(env);
  _busy(['idle', 'error', 'obs-closed']);
  const L = _launcher();
  let exe;
  try {
    exe = L.validateExe(_cfg().exePath);
  } catch (e) {
    const f = _fail(_codeOf(e));
    _log('info', { op: 'launch', code: f.code });
    _emit(f);
    return f;
  }
  const r = await L.launch(exe);
  if (!r || r.ok !== true) {
    const code = (r && typeof r.code === 'string' && r.code) || 'LAUNCH_FAILED';
    if (code === 'BUSY') throw new ZoomError('BUSY');
    const f = _fail(_codeOf({ code }));
    _log('info', { op: 'launch', code: f.code });
    _emit(f);
    return f;
  }
  S.launchedByFleet = r.already !== true;   // D1 / F15
  S.launchUntil = _t.now() + LAUNCH_WINDOW_MS;
  S.state = 'idle';
  S.reason = null;
  S.hint = false;
  S.canLaunch = false;
  _log('info', { op: 'launch', already: r.already === true });
  const out = _snapshot();
  _emit(out);
  return out;
}

module.exports = {
  status, configSet, connect, disconnect, start, stop, launch,
  _setDeps, _resetForTests, _snapshot,
  SCENE, INPUT, EVENT, CRED_KEY, STORE_KEY, LAUNCH_WINDOW_MS, RETRY_MS, LOSS_MS, STALL_MS, WATCHDOG_MS,
  DEFAULT_CONFIG,
};
