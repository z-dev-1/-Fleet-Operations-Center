// tests/fixtures/zoom/fake-media.js — scripted navigator.mediaDevices / MediaStream / AudioContext fakes for
// the Studio tests (FEAT-B1). No real camera is touched.
//
// createFakeMedia({devices, labelsAfterGrant, capabilities}) -> {
//   mediaDevices, calls{enumerate, getUserMedia}, tracks, setDevices(list), emitDeviceChange(),
//   failNext(name), AudioContext, audio{contexts, connections} }
//   devices: [{kind, deviceId, label}]   (labels hidden until the first successful getUserMedia when
//   labelsAfterGrant is true, like Chromium)

export class FakeTrack {
  constructor(kind, deviceId, capabilities) {
    this.kind = kind;
    this.deviceId = deviceId;
    this.readyState = 'live';
    this.stopped = 0;
    this.listeners = {};
    this.constraints = [];
    this._caps = capabilities || {};
    this.rejectConstraints = false;
  }
  stop() { this.stopped++; this.readyState = 'ended'; }
  getSettings() { return { deviceId: this.deviceId }; }
  getCapabilities() { return this._caps; }
  async applyConstraints(c) {
    this.constraints.push(c);
    if (this.rejectConstraints) { const e = new Error('nope'); e.name = 'OverconstrainedError'; throw e; }
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  /** end() — the device went away (fires 'ended' like a real track). */
  end() { this.readyState = 'ended'; for (const fn of (this.listeners.ended || []).slice()) fn({ type: 'ended' }); }
}

export class FakeStream {
  constructor(tracks) { this._tracks = tracks; }
  getTracks() { return this._tracks.slice(); }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
}

export function createFakeMedia(opts = {}) {
  let devices = (opts.devices || []).slice();
  let granted = !opts.labelsAfterGrant;
  let failName = null;
  const calls = { enumerate: 0, getUserMedia: [] };
  const tracks = [];
  const listeners = { devicechange: [] };

  const mediaDevices = {
    async enumerateDevices() {
      calls.enumerate++;
      return devices.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: 'g', label: granted ? d.label : '' }));
    },
    async getUserMedia(constraints) {
      calls.getUserMedia.push(constraints);
      if (failName) { const n = failName; failName = null; const e = new Error('SENTINEL_MEDIA_MESSAGE'); e.name = n; throw e; }
      granted = true;
      const out = [];
      if (constraints.video) {
        const id = constraints.video.deviceId && constraints.video.deviceId.exact;
        const d = devices.find((x) => x.kind === 'videoinput' && (!id || x.deviceId === id));
        if (!d) { const e = new Error('x'); e.name = 'NotFoundError'; throw e; }
        out.push(new FakeTrack('video', d.deviceId, opts.capabilities));
      }
      if (constraints.audio) {
        const id = constraints.audio && constraints.audio.deviceId && constraints.audio.deviceId.exact;
        const d = devices.find((x) => x.kind === 'audioinput' && (!id || x.deviceId === id));
        out.push(new FakeTrack('audio', d ? d.deviceId : 'default'));
      }
      tracks.push(...out);
      return new FakeStream(out);
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
  };

  const audio = { contexts: [], connections: [] };
  class FakeAudioContext {
    constructor() {
      this.closed = 0;
      this.destination = { name: 'destination' };
      audio.contexts.push(this);
    }
    createAnalyser() {
      const node = {
        name: 'analyser', fftSize: 2048,
        getFloatTimeDomainData(buf) { for (let i = 0; i < buf.length; i++) buf[i] = 0.1; },
        connect(to) { audio.connections.push(['analyser', to && to.name]); },
      };
      return node;
    }
    createMediaStreamSource() {
      return { name: 'source', connect(to) { audio.connections.push(['source', to && to.name]); }, disconnect() {} };
    }
    close() { this.closed++; return Promise.resolve(); }
  }

  return {
    mediaDevices,
    calls,
    tracks,
    audio,
    AudioContext: FakeAudioContext,
    listenerCount: (t) => (listeners[t] || []).length,
    setDevices(list) { devices = list.slice(); },
    async emitDeviceChange() { for (const fn of (listeners.devicechange || []).slice()) await fn({ type: 'devicechange' }); },
    failNext(name) { failName = name; },
    liveTracks: () => tracks.filter((t) => t.readyState === 'live'),
  };
}

export const HP_DEVICES = [
  { kind: 'videoinput', deviceId: 'cam-ir', label: 'HP IR Camera' },
  { kind: 'videoinput', deviceId: 'cam-hp', label: 'HP 5MP Camera' },
  { kind: 'videoinput', deviceId: 'cam-emeet', label: 'EMEET SmartCam S600' },
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone Array' },
];
