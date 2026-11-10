/**
 * zoom/obs-feed.js -- the OBS output feed controller (design §5.2, flag zoom.studio.obs). Module
 * singleton: it survives Studio panel hide / stopAll / destroy so the output keeps running while the
 * user is elsewhere in Fleet.
 *
 * prepare({cameraId, preset, getImage}) opens the camera with its OWN createDevices() instance and
 * runs its own pipeline on a detached <canvas> (review F8: document.createElement('canvas'); the feed
 * never starts the pipeline's animation loop and passes no animation-frame function; frames come only
 * from setInterval(tick) -> drawFrame()). It makes no OBS call. connect(feedUrl) then pushes JPEG
 * frames to Fleet's own loopback feed server.
 *
 * This is the ONLY renderer zoom file that opens a WebSocket, and only to a URL matching FEED_URL_RE
 * (ws://127.0.0.1:<port>/feed/<64 hex>) returned by zoomHub.obsStart().
 *
 * Loss handling (review F3): the camera track ending (devices onLiveChange(false)) or the
 * MediaStreamTrackProcessor reader finishing -> _lost('camera-lost'); the socket closing and not
 * coming back after 3 reconnects 1 s apart -> _lost('feed-lost'). _lost(reason) = stop() +
 * zoomHub.obsStop() + onLiveChange(false, reason).
 */
import { createDevices } from './studio-devices.js';
import { createPipeline } from './studio-pipeline.js';
import { isObsLabel, pickDefaultCamera, NATIVE_BLUR_UNSUPPORTED } from './studio-logic.js';
import { FEED_URL_RE, FEED_INTERVAL_MS, shouldSend } from './obs-logic.js';

const RECONNECTS = 3;
const RECONNECT_MS = 1000;
const JPEG_QUALITY = 0.85;

let deps = {};
let F = _fresh();

function _fresh() {
  return {
    live: false, switching: false, gen: 0, devices: null, pipeline: null, canvas: null, video: null,
    stream: null, reader: null, latest: null, interval: null, ws: null, url: null, attempts: 0,
    reconnectTimer: null, inFlight: false, list: null, zoomHub: null, listeners: new Set(),
  };
}

function _g(name) {
  if (deps[name] !== undefined) return deps[name];
  return typeof globalThis !== 'undefined' ? globalThis[name] : undefined;
}

/** _timer(name, ...args) -- call an (injectable) timer function with the global as `this`. */
function _timer(name, ...args) {
  const f = _g(name);
  return typeof f === 'function' ? f.apply(globalThis, args) : null;
}

function _hub() {
  if (deps.zoomHub) return deps.zoomHub;
  if (F.zoomHub) return F.zoomHub;
  const w = typeof window !== 'undefined' ? window : null;
  return w && w.zoomHub ? w.zoomHub : null;
}

function _emit(live, reason) {
  for (const cb of Array.from(F.listeners)) { try { cb(live, reason || null); } catch (_) {} }
}

function _warn(name) {
  try { console.warn('[zoom-studio]', name); } catch (_) {}
}

function _cameras(list) {
  return list && Array.isArray(list.cameras) ? list.cameras : [];
}

/** The started track's label (falls back to the enumerated label of its device). */
function _label(r) {
  const t = r && r.track;
  if (t && typeof t.label === 'string' && t.label) return t.label;
  const d = _cameras(r && r.list).find((x) => x && x.deviceId === (r && r.deviceId));
  return d && d.label ? d.label : '';
}

/** _open camera with the OBS-loop guard: an explicit OBS pick fails; an automatic pick re-picks once. */
async function _openCamera(devices, cameraId) {
  let r = await devices.start(cameraId);
  if (!r.ok) return { ok: false, state: r.state, name: r.name };
  if (isObsLabel(_label(r))) {
    if (cameraId !== null && cameraId !== undefined) { devices.stopAll(); return { ok: false, state: 'obs-loop' }; }
    const id = pickDefaultCamera(_cameras(r.list));
    if (!id) { devices.stopAll(); return { ok: false, state: 'obs-loop' }; }
    r = await devices.start(id);
    if (!r.ok) return { ok: false, state: r.state, name: r.name };
    if (isObsLabel(_label(r))) { devices.stopAll(); return { ok: false, state: 'obs-loop' }; }
  } else if (cameraId === null || cameraId === undefined) {
    // An automatic pick that differs from what the browser opened restarts once (as startPreview does).
    const id = pickDefaultCamera(_cameras(r.list));
    if (id && r.deviceId && id !== r.deviceId) {
      r = await devices.start(id);
      if (!r.ok) return { ok: false, state: r.state, name: r.name };
      if (isObsLabel(_label(r))) { devices.stopAll(); return { ok: false, state: 'obs-loop' }; }
    }
  }
  return r;
}

function _closeLatest() {
  if (F.latest) { try { F.latest.close(); } catch (_) {} }
  F.latest = null;
}

function _cancelReader() {
  const rd = F.reader;
  F.reader = null;
  if (rd) { try { const p = rd.cancel(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {} }
}

/** Frame source: MediaStreamTrackProcessor when available (frames feed drawable()), else an off-DOM <video>. */
function _attachSource(r) {
  F.stream = r.stream;
  const MSTP = _g('MediaStreamTrackProcessor');
  if (typeof MSTP === 'function' && r.track) {
    const processor = new MSTP({ track: r.track });
    const reader = processor.readable.getReader();
    F.reader = reader;
    const myGen = F.gen;
    (async () => {
      for (;;) {
        let res;
        try { res = await reader.read(); } catch (e) { res = { done: true }; }
        if (F.reader !== reader || F.gen !== myGen) { if (res && res.value) { try { res.value.close(); } catch (_) {} } return; }
        if (res.done) {
          F.reader = null;
          if (F.live && !F.switching) _lost('camera-lost');
          return;
        }
        _closeLatest();
        F.latest = res.value;
      }
    })();
    if (!F.video || !F.video._shim) {
      F.video = {
        _shim: true,
        get readyState() { return F.latest ? 4 : 0; },
        get videoWidth() { return F.latest ? F.latest.displayWidth || 0 : 0; },
        get videoHeight() { return F.latest ? F.latest.displayHeight || 0 : 0; },
        get srcObject() { return F.stream; },
      };
    }
    return { video: F.video, drawable: () => F.latest };
  }
  const doc = _g('document');
  if (!F.video || F.video._shim) {
    F.video = doc.createElement('video');
    F.video.muted = true;
    F.video.playsInline = true;
    F.video.autoplay = true;
  }
  F.video.srcObject = r.stream;
  try { const p = typeof F.video.play === 'function' ? F.video.play() : null; if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
  return { video: F.video, drawable: undefined };
}

function _tick() {
  if (!F.live || !F.pipeline) return;
  let drawn = false;
  try { drawn = F.pipeline.drawFrame(); } catch (e) { _warn(e && e.name); }
  const ws = F.ws;
  if (!drawn || !ws || ws.readyState !== 1) return;
  if (!shouldSend({ inFlight: F.inFlight, bufferedAmount: ws.bufferedAmount })) return;
  if (!F.canvas || typeof F.canvas.toBlob !== 'function') return;
  F.inFlight = true;
  try {
    F.canvas.toBlob(async (blob) => {
      try {
        if (blob && F.ws === ws && ws.readyState === 1) ws.send(await blob.arrayBuffer());
      } catch (e) {
        _warn(e && e.name);
      } finally {
        F.inFlight = false;
      }
    }, 'image/jpeg', JPEG_QUALITY);
  } catch (e) {
    F.inFlight = false;
    _warn(e && e.name);
  }
}

/** prepare({cameraId, preset, getImage}) -> {ok:true, deviceId} | {ok:false, state, name?}. No OBS call. */
export async function prepare(opts = {}) {
  if (F.live) stop();
  if (opts.zoomHub) F.zoomHub = opts.zoomHub;
  const myGen = ++F.gen;
  const devices = createDevices({
    mediaDevices: deps.mediaDevices,
    onLiveChange: (live) => { if (!live && feed.live && !F.switching && F.devices === devices) _lost('camera-lost'); },
  });
  F.devices = devices;
  const cameraId = opts.cameraId === undefined ? null : opts.cameraId;
  const r = await _openCamera(devices, cameraId);
  if (F.gen !== myGen) { devices.stopAll(); return { ok: false, state: 'error', name: 'Cancelled' }; }
  if (!r.ok) { F.devices = null; return r; }
  F.list = r.list || null;
  const doc = _g('document');
  if (!F.canvas) F.canvas = doc.createElement('canvas');   // detached HTMLCanvasElement (review F8)
  const src = _attachSource(r);
  F.pipeline = createPipeline({
    video: src.video, drawable: src.drawable, canvas: F.canvas, document: doc, fpsReadout: false,
    getImage: typeof opts.getImage === 'function' ? opts.getImage : async () => null,
  });
  F.pipeline.setPreset(opts.preset);
  F.interval = _timer('setInterval', _tick, FEED_INTERVAL_MS);
  F.live = true;
  _emit(true, null);
  return { ok: true, deviceId: r.deviceId || null };
}

function _open() {
  const url = F.url;
  if (!F.live || typeof url !== 'string' || !FEED_URL_RE.test(url)) return;
  const WebSocket = _g('WebSocket');
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    _warn(e && e.name);
    _onSocketClosed(null);
    return;
  }
  ws.binaryType = 'arraybuffer';
  F.ws = ws;
  ws.onopen = () => { if (F.ws === ws) F.attempts = 0; };
  ws.onerror = () => {};
  ws.onclose = () => _onSocketClosed(ws);
}

function _onSocketClosed(ws) {
  if (ws && F.ws !== ws) return;
  F.ws = null;
  F.inFlight = false;
  if (!F.live) return;
  if (F.attempts >= RECONNECTS) { _lost('feed-lost'); return; }
  F.attempts++;
  F.reconnectTimer = _timer('setTimeout', () => { F.reconnectTimer = null; _open(); }, RECONNECT_MS);
}

/** connect(feedUrl) -> {ok} -- asserts FEED_URL_RE, then opens the single loopback WebSocket. */
export function connect(feedUrl) {
  if (typeof feedUrl !== 'string' || !FEED_URL_RE.test(feedUrl)) return { ok: false, code: 'INVALID_INPUT' };
  if (!F.live) return { ok: false, code: 'BUSY' };
  F.url = feedUrl;
  F.attempts = 0;
  _open();
  return { ok: true };
}

export function setPreset(p) {
  if (F.pipeline) F.pipeline.setPreset(p);
}

/** switchCamera(id) -> {ok} | {ok:false, state} -- the same OBS check, stop then start inside the feed. */
export async function switchCamera(id) {
  if (!F.live || !F.devices) return { ok: false, state: 'error' };
  const cam = _cameras(F.list).find((d) => d && d.deviceId === id);
  if (cam && isObsLabel(cam.label)) return { ok: false, state: 'obs-loop' };
  const devices = F.devices;
  F.switching = true;
  _cancelReader();
  _closeLatest();
  let r;
  try {
    r = await _openCamera(devices, id || null);
  } finally {
    F.switching = false;
  }
  if (!F.live || F.devices !== devices) { try { devices.stopAll(); } catch (_) {} return { ok: false, state: 'error' }; }
  if (!r.ok) {
    _lost(r.state === 'obs-loop' || r.state === 'in-use' ? r.state : 'camera-lost');
    return r;
  }
  F.list = r.list || F.list;
  _attachSource(r);
  return { ok: true, deviceId: r.deviceId || null };
}

/** applyNativeBlur(on) -> the pipeline result ({ok:false, message} when the camera can't). */
export async function applyNativeBlur(on) {
  if (!F.pipeline) return { ok: false, message: NATIVE_BLUR_UNSUPPORTED };
  return F.pipeline.applyNativeBlur(on);
}

function _halt() {
  const was = F.live;
  F.live = false;
  F.gen++;
  if (F.interval !== null) { try { _timer('clearInterval', F.interval); } catch (_) {} }
  F.interval = null;
  if (F.reconnectTimer !== null) { try { _timer('clearTimeout', F.reconnectTimer); } catch (_) {} }
  F.reconnectTimer = null;
  const ws = F.ws;
  F.ws = null;
  F.url = null;
  if (ws) { try { ws.close(); } catch (_) {} }
  _cancelReader();
  _closeLatest();
  if (F.devices) { try { F.devices.stopAll(); } catch (_) {} }
  F.devices = null;
  if (F.video && !F.video._shim) F.video.srcObject = null;
  F.stream = null;
  F.pipeline = null;
  F.inFlight = false;
  return was;
}

/** stop() -- cancels the reader, closes the last frame, stops the tracks, interval and socket. */
export function stop() {
  if (_halt()) _emit(false, null);
}

function _lost(reason) {
  if (!F.live) return;
  _halt();
  const hub = _hub();
  try {
    const p = hub && typeof hub.obsStop === 'function' ? hub.obsStop() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
  _emit(false, reason);
}

/** onLiveChange(cb(live, reason)) -> unsubscribe. */
export function onLiveChange(cb) {
  if (typeof cb !== 'function') return () => {};
  F.listeners.add(cb);
  return () => { F.listeners.delete(cb); };
}

/** The singleton facade studio-panel / obs-panel use (getters canvas / live). */
export const feed = {
  prepare, connect, setPreset, switchCamera, applyNativeBlur, stop, onLiveChange,
  get canvas() { return F.canvas; },
  get live() { return F.live; },
};

/** Test seams: inject {document, mediaDevices, MediaStreamTrackProcessor, WebSocket, zoomHub, setInterval, clearInterval, setTimeout, clearTimeout}. */
export function _setDeps(d) { deps = Object.assign({}, deps, d || {}); }
export function _resetForTests() {
  try { _halt(); } catch (_) {}
  deps = {};
  F = _fresh();
}
export function _state() { return F; }

export default feed;
