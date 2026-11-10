// FEAT-004 / plan item 13 (design §5.2, AC10, AC12; review F3, F8): the renderer OBS output feed.
// Fakes only: fake-media (camera), fake-dom-ext (document), a recording canvas, a fake WebSocket, a
// fake MediaStreamTrackProcessor and manual timers. No real camera, socket or OBS is touched.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeMedia, HP_DEVICES } from './fixtures/zoom/fake-media.js';
import { createExtDom } from './fixtures/zoom/fake-dom-ext.js';
import { createPipeline } from '../renderer/src/js/zoom/studio-pipeline.js';
import * as feedMod from '../renderer/src/js/zoom/obs-feed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { feed } = feedMod;
const TOKEN = '0123456789abcdef'.repeat(4);
const GOOD_URL = `ws://127.0.0.1:50123/feed/${TOKEN}`;
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...a) => { calls.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx, calls };
}

class FakeFrame {
  constructor(n) { this.n = n; this.displayWidth = 640; this.displayHeight = 480; this.closed = 0; }
  close() { this.closed++; }
}

function createFakeMstp() {
  const procs = [];
  class MSTP {
    constructor({ track }) {
      this.track = track;
      this.q = [];
      this.waiters = [];
      this.cancelled = false;
      const self = this;
      this.readable = {
        getReader: () => ({
          read: () => (self.q.length ? Promise.resolve(self.q.shift()) : new Promise((r) => self.waiters.push(r))),
          cancel: async () => { self.cancelled = true; self.end(); },
        }),
      };
      procs.push(this);
    }
    _put(item) { if (this.waiters.length) this.waiters.shift()(item); else this.q.push(item); }
    push(v) { this._put({ value: v, done: false }); }
    end() { this._put({ value: undefined, done: true }); }
  }
  return { MSTP, procs };
}

function setup({ devices = HP_DEVICES, mstp = true } = {}) {
  const fm = createFakeMedia({ devices });
  const { document } = createExtDom();
  const canvases = [];
  const videos = [];
  const blobs = [];
  const orig = document.createElement;
  document.createElement = (tag) => {
    const e = orig(tag);
    if (tag === 'canvas') {
      const r = recorder();
      e.getContext = () => r.ctx;
      e.rec = r;
      e.toBlob = (cb, type, q) => { blobs.push({ cb, type, q }); };
      canvases.push(e);
    }
    if (tag === 'video') { e.play = () => Promise.resolve(); videos.push(e); }
    return e;
  };
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; this.closed = 0; sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.closed++; this.readyState = 3; }
    open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    drop() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }
  }
  let nextId = 1;
  const timers = { intervals: new Map(), timeouts: new Map(), log: [] };
  const deps = {
    document, mediaDevices: fm.mediaDevices, WebSocket: FakeWS,
    setInterval: (fn, ms) => { const id = nextId++; timers.intervals.set(id, { fn, ms }); timers.log.push(['setInterval', ms]); return id; },
    clearInterval: (id) => { timers.intervals.delete(id); },
    setTimeout: (fn, ms) => { const id = nextId++; timers.timeouts.set(id, { fn, ms }); timers.log.push(['setTimeout', ms]); return id; },
    clearTimeout: (id) => { timers.timeouts.delete(id); },
  };
  const m = createFakeMstp();
  deps.MediaStreamTrackProcessor = mstp ? m.MSTP : null;
  const zoomHub = {
    obsStop: vi.fn(async () => ({ ok: true, state: 'connected' })),
    obsStart: vi.fn(), obsConnect: vi.fn(), obsStatus: vi.fn(), obsConfigSet: vi.fn(), obsDisconnect: vi.fn(), obsLaunch: vi.fn(),
  };
  deps.zoomHub = zoomHub;
  feedMod._setDeps(deps);
  const events = [];
  feed.onLiveChange((live, reason) => events.push([live, reason]));
  const runIntervals = () => { for (const t of Array.from(timers.intervals.values())) t.fn(); };
  const runTimeouts = () => { const all = Array.from(timers.timeouts.entries()); timers.timeouts.clear(); for (const [, t] of all) t.fn(); return all.map(([, t]) => t.ms); };
  return { fm, document, canvases, videos, blobs, sockets, timers, runIntervals, runTimeouts, mstp: m, zoomHub, events };
}

afterEach(() => {
  feedMod._resetForTests();
  delete globalThis.requestAnimationFrame;
  vi.restoreAllMocks();
});

describe('studio-pipeline options', () => {
  it('pipeline: fpsReadout:false skips fillText; drawable() is drawn; defaults unchanged', () => {
    const video = { readyState: 4, videoWidth: 640, videoHeight: 480 };
    const mk = () => { const r = recorder(); return { r, canvas: { width: 0, height: 0, getContext: () => r.ctx } }; };
    const a = mk();
    const p1 = createPipeline({ video, canvas: a.canvas, document: null, raf: () => 1, caf: () => {} });
    expect(p1.drawFrame()).toBe(true);
    expect(a.r.calls.some((c) => c[0] === 'fillText')).toBe(true);
    expect(a.r.calls).toContainEqual(['drawImage', video, 0, 0, 640, 480]);
    const b = mk();
    const frame = { id: 'frame' };
    const p2 = createPipeline({ video, canvas: b.canvas, document: null, raf: () => 1, caf: () => {}, fpsReadout: false, drawable: () => frame });
    expect(p2.drawFrame()).toBe(true);
    expect(b.r.calls.some((c) => c[0] === 'fillText')).toBe(false);
    expect(b.r.calls).toContainEqual(['drawImage', frame, 0, 0, 640, 480]);
    expect(b.r.calls.some((c) => c[0] === 'drawImage' && c[1] === video)).toBe(false);
  });
});

describe('obs-feed prepare', () => {
  it('prepare opens exactly one getUserMedia and makes no OBS call', async () => {
    const t = setup();
    const r = await feed.prepare({ cameraId: 'cam-hp', preset: { effect: { mode: 'none' } } });
    expect(r).toEqual({ ok: true, deviceId: 'cam-hp' });
    expect(t.fm.calls.getUserMedia.length).toBe(1);
    expect(t.fm.liveTracks().map((x) => x.deviceId)).toEqual(['cam-hp']);
    for (const fn of Object.values(t.zoomHub)) expect(fn).not.toHaveBeenCalled();
    expect(t.sockets).toEqual([]);
    expect(feed.live).toBe(true);
    expect(t.events).toEqual([[true, null]]);
    expect(t.timers.log).toContainEqual(['setInterval', 33]);
  });

  it('AC12: the feed pipeline uses fpsReadout:false (no fillText on the feed canvas)', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    t.mstp.procs[0].push(new FakeFrame(1));
    await flush();
    t.runIntervals();
    const c = feed.canvas;
    expect(c.rec.calls.some((x) => x[0] === 'drawImage')).toBe(true);
    expect(c.rec.calls.some((x) => x[0] === 'fillText')).toBe(false);
  });

  it("F8: the feed canvas is a detached document.createElement('canvas') and pipeline.start is never called", async () => {
    globalThis.requestAnimationFrame = vi.fn(() => 1);
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    expect(t.canvases[0]).toBe(feed.canvas);
    expect(feed.canvas.tagName).toBe('CANVAS');
    expect(feed.canvas.parentNode).toBe(null);
    feed.connect(GOOD_URL);
    t.sockets[0].open();
    for (let i = 0; i < 5; i++) { t.mstp.procs[0].push(new FakeFrame(i)); await flush(); t.runIntervals(); }
    // A started pipeline would schedule requestAnimationFrame; the feed only draws from its interval.
    expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
    const src = fs.readFileSync(path.join(ROOT, 'renderer/src/js/zoom/obs-feed.js'), 'utf8');
    expect(src).not.toMatch(/pipeline\.start\(|\.start\(\)/);
    expect(src).not.toMatch(/\braf\s*:/);
    expect(src).toContain("createElement('canvas')");
  });

  it('AC12: MediaStreamTrackProcessor frames feed drawable() and each previous VideoFrame is closed', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    const proc = t.mstp.procs[0];
    expect(proc.track.deviceId).toBe('cam-hp');
    const f1 = new FakeFrame(1);
    const f2 = new FakeFrame(2);
    proc.push(f1);
    await flush();
    t.runIntervals();
    expect(feed.canvas.rec.calls).toContainEqual(['drawImage', f1, 0, 0, 640, 480]);
    proc.push(f2);
    await flush();
    expect(f1.closed).toBe(1);
    expect(f2.closed).toBe(0);
    t.runIntervals();
    expect(feed.canvas.rec.calls).toContainEqual(['drawImage', f2, 0, 0, 640, 480]);
    expect(t.videos).toEqual([]);   // no <video> when MSTP exists
    feed.stop();
    expect(f2.closed).toBe(1);
    expect(proc.cancelled).toBe(true);
  });

  it('AC12: without MediaStreamTrackProcessor the feed falls back to an off-DOM video', async () => {
    const t = setup({ mstp: false });
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    expect(t.videos.length).toBe(1);
    const v = t.videos[0];
    expect(v.parentNode).toBe(null);
    expect(v.srcObject.getVideoTracks()[0].deviceId).toBe('cam-hp');
    expect(v.muted).toBe(true);
    Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
    t.runIntervals();
    expect(feed.canvas.rec.calls).toContainEqual(['drawImage', v, 0, 0, 640, 480]);
    feed.stop();
    expect(v.srcObject).toBe(null);
  });

  it('AC12: an OBS Virtual Camera track -> obs-loop; a null cameraId re-picks once with pickDefaultCamera', async () => {
    const withObs = [{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }].concat(HP_DEVICES);
    const t = setup({ devices: withObs });
    const r = await feed.prepare({ cameraId: 'cam-obs', preset: null });
    expect(r).toEqual({ ok: false, state: 'obs-loop' });
    expect(t.fm.liveTracks()).toEqual([]);
    expect(feed.live).toBe(false);
    expect(t.zoomHub.obsStop).not.toHaveBeenCalled();
    const before = t.fm.calls.getUserMedia.length;
    const r2 = await feed.prepare({ cameraId: null, preset: null });
    expect(r2).toEqual({ ok: true, deviceId: 'cam-hp' });
    const calls = t.fm.calls.getUserMedia.slice(before).map((c) => (c.video.deviceId ? c.video.deviceId.exact : null));
    expect(calls).toEqual([null, 'cam-hp']);   // the browser's default (OBS) once, then the proper default once
    expect(t.fm.liveTracks().map((x) => x.deviceId)).toEqual(['cam-hp']);
    // switchCamera applies the same OBS check without touching the running camera.
    expect(await feed.switchCamera('cam-obs')).toEqual({ ok: false, state: 'obs-loop' });
    expect(t.fm.liveTracks().map((x) => x.deviceId)).toEqual(['cam-hp']);
    expect(await feed.switchCamera('cam-emeet')).toEqual({ ok: true, deviceId: 'cam-emeet' });
    expect(t.fm.liveTracks().map((x) => x.deviceId)).toEqual(['cam-emeet']);
    expect(feed.live).toBe(true);
    expect(t.zoomHub.obsStop).not.toHaveBeenCalled();
  });
});

describe('obs-feed connect / loss', () => {
  it('connect rejects a URL that fails FEED_URL_RE; sends JPEG 0.85 binary frames gated by shouldSend', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    for (const bad of ['ws://127.0.0.1:50123/feed/xyz', `ws://localhost:50123/feed/${TOKEN}`, `ws://evil.example/feed/${TOKEN}`, null]) {
      expect(feed.connect(bad)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(t.sockets).toEqual([]);
    expect(feed.connect(GOOD_URL)).toEqual({ ok: true });
    expect(t.sockets.length).toBe(1);
    const ws = t.sockets[0];
    expect(ws.url).toBe(GOOD_URL);
    expect(ws.binaryType).toBe('arraybuffer');
    t.mstp.procs[0].push(new FakeFrame(1));
    await flush();
    t.runIntervals();               // socket not open yet -> nothing encoded
    expect(t.blobs).toEqual([]);
    ws.open();
    t.runIntervals();
    expect(t.blobs.length).toBe(1);
    expect([t.blobs[0].type, t.blobs[0].q]).toEqual(['image/jpeg', 0.85]);
    t.runIntervals();               // a frame is still encoding (inFlight) -> skipped
    expect(t.blobs.length).toBe(1);
    const buf = new ArrayBuffer(8);
    t.blobs[0].cb({ arrayBuffer: async () => buf });
    await flush();
    expect(ws.sent).toEqual([buf]);
    ws.bufferedAmount = 2 * 1024 * 1024;   // backed-up socket -> skipped
    t.runIntervals();
    expect(t.blobs.length).toBe(1);
    ws.bufferedAmount = 0;
    t.runIntervals();
    expect(t.blobs.length).toBe(2);
  });

  it('socket loss: 3 reconnects 1 s apart, then feed-lost and obsStop', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    feed.connect(GOOD_URL);
    t.sockets[0].open();
    for (let i = 0; i < 3; i++) {
      t.sockets[t.sockets.length - 1].drop();
      expect(t.zoomHub.obsStop).not.toHaveBeenCalled();
      expect(t.runTimeouts()).toEqual([1000]);
      expect(t.sockets.length).toBe(i + 2);
      expect(t.sockets[i + 1].url).toBe(GOOD_URL);
    }
    t.sockets[3].drop();
    expect(t.timers.timeouts.size).toBe(0);
    expect(t.zoomHub.obsStop).toHaveBeenCalledTimes(1);
    expect(feed.live).toBe(false);
    expect(t.events[t.events.length - 1]).toEqual([false, 'feed-lost']);
    expect(t.fm.liveTracks()).toEqual([]);
    expect(t.timers.intervals.size).toBe(0);
  });

  it('F3/AC10: track ended -> stop + obsStop with reason camera-lost', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    feed.connect(GOOD_URL);
    t.sockets[0].open();
    t.fm.tracks[0].end();
    expect(t.zoomHub.obsStop).toHaveBeenCalledTimes(1);
    expect(t.zoomHub.obsStop.mock.calls[0].length).toBe(0);
    expect(feed.live).toBe(false);
    expect(t.events[t.events.length - 1]).toEqual([false, 'camera-lost']);
    expect(t.sockets[0].closed).toBe(1);
    expect(t.timers.intervals.size).toBe(0);
    expect(t.timers.timeouts.size).toBe(0);   // a Fleet-closed socket never reconnects
    // A normal stop() is not a loss.
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    feed.stop();
    expect(t.zoomHub.obsStop).toHaveBeenCalledTimes(1);
    expect(t.events[t.events.length - 1]).toEqual([false, null]);
  });

  it('F3: MSTP reader done:true -> camera-lost', async () => {
    const t = setup();
    await feed.prepare({ cameraId: 'cam-hp', preset: null });
    feed.connect(GOOD_URL);
    t.sockets[0].open();
    const f1 = new FakeFrame(1);
    t.mstp.procs[0].push(f1);
    await flush();
    t.mstp.procs[0].end();
    await flush();
    expect(t.zoomHub.obsStop).toHaveBeenCalledTimes(1);
    expect(t.events[t.events.length - 1]).toEqual([false, 'camera-lost']);
    expect(feed.live).toBe(false);
    expect(f1.closed).toBe(1);
    expect(t.fm.liveTracks()).toEqual([]);
  });
});
