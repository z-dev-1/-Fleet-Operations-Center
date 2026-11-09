/**
 * zoom/studio-devices.js -- camera / microphone access for the Studio preview (design §14.1 steps 3-7).
 *
 * createDevices({mediaDevices, AudioContext, onLiveChange}) -> {list, start, startMic, micLevel, stopMic,
 * stopVideo, stopAll, onDeviceChange, isLive, videoTrack, activeVideoId}.
 *
 * navigator.mediaDevices is resolved lazily INSIDE the functions (never at import), so loading this
 * module touches nothing. getUserMedia runs only from start() / startMic(), which the panel calls from
 * the user's Start preview / mic test clicks. The mic test never connects to the audio destination.
 * Errors go through mapMediaError and are logged as console.warn('[zoom-studio]', name) only.
 */
import { mapMediaError } from './studio-logic.js';

function _warn(name) {
  try { console.warn('[zoom-studio]', name); } catch (_) {}
}

export function createDevices(opts = {}) {
  const onLiveChange = typeof opts.onLiveChange === 'function' ? opts.onLiveChange : () => {};
  let video = null;      // {stream, track, deviceId, onEnded}
  let mic = null;        // {stream, track, ctx, analyser, buf, onEnded}
  let lastLive = false;

  function md() {
    if (opts.mediaDevices) return opts.mediaDevices;
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    return nav && nav.mediaDevices ? nav.mediaDevices : null;
  }

  function audioCtor() {
    if (opts.AudioContext) return opts.AudioContext;
    if (typeof window !== 'undefined' && window && (window.AudioContext || window.webkitAudioContext)) return window.AudioContext || window.webkitAudioContext;
    return null;
  }

  function isLive() {
    const live = (t) => !!(t && t.readyState !== 'ended');
    return live(video && video.track) || live(mic && mic.track);
  }

  function _emitLive() {
    const now = isLive();
    if (now !== lastLive) {
      lastLive = now;
      try { onLiveChange(now); } catch (_) {}
    }
  }

  function _stopStream(s) {
    if (!s || !s.stream) return;
    try {
      const tracks = typeof s.stream.getTracks === 'function' ? s.stream.getTracks() : [];
      for (const t of tracks) {
        if (s.onEnded && typeof t.removeEventListener === 'function') { try { t.removeEventListener('ended', s.onEnded); } catch (_) {} }
        try { t.stop(); } catch (_) {}
      }
    } catch (_) {}
  }

  async function list() {
    const m = md();
    if (!m || typeof m.enumerateDevices !== 'function') return { ok: false, state: 'not-found', name: 'NoMediaDevices', cameras: [], mics: [], all: [] };
    let all;
    try {
      all = await m.enumerateDevices();
    } catch (e) {
      const r = mapMediaError(e);
      _warn(r.name);
      return Object.assign({ ok: false, cameras: [], mics: [], all: [] }, r);
    }
    const arr = Array.isArray(all) ? all : [];
    return {
      ok: true,
      all: arr,
      cameras: arr.filter((d) => d && d.kind === 'videoinput'),
      mics: arr.filter((d) => d && d.kind === 'audioinput'),
    };
  }

  function stopVideo() {
    if (video) {
      _stopStream(video);
      video = null;
    }
    _emitLive();
  }

  function stopMic() {
    if (mic) {
      _stopStream(mic);
      try { if (mic.source && typeof mic.source.disconnect === 'function') mic.source.disconnect(); } catch (_) {}
      try { if (mic.ctx && typeof mic.ctx.close === 'function') mic.ctx.close(); } catch (_) {}
      mic = null;
    }
    _emitLive();
  }

  function stopAll() {
    stopVideo();
    stopMic();
  }

  /** start(deviceId) -> {ok:true, stream, track, list} | {ok:false, state, name}. User action only. */
  async function start(deviceId) {
    stopVideo();
    const m = md();
    if (!m || typeof m.getUserMedia !== 'function') return { ok: false, state: 'not-found', name: 'NoMediaDevices' };
    const video0 = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const constraints = { video: deviceId ? Object.assign({ deviceId: { exact: deviceId } }, video0) : video0, audio: false };
    let stream;
    try {
      stream = await m.getUserMedia(constraints);
    } catch (e) {
      const r = mapMediaError(e);
      _warn(r.name);
      return Object.assign({ ok: false }, r);
    }
    const tracks = stream && typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    const track = tracks[0] || null;
    let actual = deviceId || null;
    try {
      const st = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
      if (st && st.deviceId) actual = st.deviceId;
    } catch (_) {}
    const entry = { stream, track, deviceId: actual, onEnded: null };
    entry.onEnded = () => {
      if (video !== entry) return;
      stopAll();
    };
    if (track && typeof track.addEventListener === 'function') track.addEventListener('ended', entry.onEnded);
    video = entry;
    _emitLive();
    const l = await list();
    return { ok: true, stream, track, deviceId: actual, list: l };
  }

  /** startMic(deviceId) -> {ok:true} | {ok:false, state, name}. Level via micLevel(); never audible. */
  async function startMic(deviceId) {
    stopMic();
    const m = md();
    if (!m || typeof m.getUserMedia !== 'function') return { ok: false, state: 'not-found', name: 'NoMediaDevices' };
    let stream;
    try {
      stream = await m.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
    } catch (e) {
      const r = mapMediaError(e);
      _warn(r.name);
      return Object.assign({ ok: false }, r);
    }
    const track = (stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [])[0] || null;
    const entry = { stream, track, ctx: null, analyser: null, source: null, buf: null, onEnded: null };
    entry.onEnded = () => { if (mic === entry) stopMic(); };
    if (track && typeof track.addEventListener === 'function') track.addEventListener('ended', entry.onEnded);
    const AC = audioCtor();
    if (AC) {
      try {
        entry.ctx = new AC();
        entry.analyser = entry.ctx.createAnalyser();
        entry.analyser.fftSize = 1024;
        entry.source = entry.ctx.createMediaStreamSource(stream);
        // Source -> analyser ONLY. Never connected to ctx.destination, so the mic is never played back.
        entry.source.connect(entry.analyser);
        entry.buf = new Float32Array(entry.analyser.fftSize);
      } catch (e) {
        _warn(e && e.name);
      }
    }
    mic = entry;
    _emitLive();
    return { ok: true };
  }

  /** micLevel() -> RMS 0..1 of the current mic buffer (0 when the mic test is off). */
  function micLevel() {
    if (!mic || !mic.analyser || !mic.buf) return 0;
    try {
      mic.analyser.getFloatTimeDomainData(mic.buf);
      let sum = 0;
      for (let i = 0; i < mic.buf.length; i++) sum += mic.buf[i] * mic.buf[i];
      const rms = Math.sqrt(sum / (mic.buf.length || 1));
      return Math.max(0, Math.min(1, rms));
    } catch (_) {
      return 0;
    }
  }

  /**
   * onDeviceChange(cb) -> unsubscribe. On every devicechange the list is re-read; when the active
   * camera is gone the preview is stopped and cb gets {list, lost:'not-found'}.
   */
  function onDeviceChange(cb) {
    const m = md();
    if (!m) return () => {};
    const handler = async () => {
      try {
        const l = await list();
        let lost = null;
        if (video && video.deviceId && l.ok && !l.cameras.some((d) => d.deviceId === video.deviceId)) {
          stopAll();
          lost = 'not-found';
        }
        if (typeof cb === 'function') cb({ list: l, lost });
      } catch (e) {
        _warn(e && e.name);
      }
    };
    if (typeof m.addEventListener === 'function') {
      m.addEventListener('devicechange', handler);
      return () => { try { m.removeEventListener('devicechange', handler); } catch (_) {} };
    }
    return () => {};
  }

  return {
    list, start, startMic, micLevel, stopMic, stopVideo, stopAll, onDeviceChange, isLive,
    videoTrack: () => (video ? video.track : null),
    activeVideoId: () => (video ? video.deviceId : null),
    micOn: () => !!mic,
  };
}
