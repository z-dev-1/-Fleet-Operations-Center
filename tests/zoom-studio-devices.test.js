// FEAT-B1 / AC-14 (design §14.1 steps 3-7): camera / mic access with a fake mediaDevices.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeMedia, HP_DEVICES } from './fixtures/zoom/fake-media.js';
import { createExtDom, createBus } from './fixtures/zoom/fake-dom-ext.js';
import { createDevices } from '../renderer/src/js/zoom/studio-devices.js';
import { pickDefaultCamera } from '../renderer/src/js/zoom/studio-logic.js';

const panel = await import('../renderer/src/js/zoom/studio-panel.js');

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function mountPanel(fm) {
  const { document } = createExtDom();
  const el = document.createElement('div');
  const zoomHub = { mediaStatus: vi.fn(async () => ({ ok: true, camera: 'granted', microphone: 'granted' })), openPrivacy: vi.fn(async () => ({ ok: true })), libraryRead: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) };
  panel.mount(el, { zoomHub, flags: { studio: true }, bus: createBus(), document, mediaDevices: fm.mediaDevices, AudioContext: fm.AudioContext, raf: () => 1, caf: () => {} });
  return { el, zoomHub, document };
}

const click = (action, extra = {}) => panel._state().wrap.dispatch('click', { target: { dataset: Object.assign({ action }, extra) } });

afterEach(() => { panel.destroy(); vi.restoreAllMocks(); });

describe('studio-devices', () => {
  it('list() splits cameras and mics; IR is not the default camera', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const d = createDevices({ mediaDevices: fm.mediaDevices });
    const l = await d.list();
    expect(l.ok).toBe(true);
    expect(l.cameras.map((c) => c.deviceId)).toEqual(['cam-ir', 'cam-hp', 'cam-emeet']);
    expect(l.mics.map((c) => c.deviceId)).toEqual(['mic-1']);
    expect(pickDefaultCamera(l.cameras)).toBe('cam-hp');
    expect(fm.calls.getUserMedia).toEqual([]);
  });

  it('start() calls getUserMedia once with deviceId:{exact} and audio:false, then re-enumerates', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES, labelsAfterGrant: true });
    const onLive = vi.fn();
    const d = createDevices({ mediaDevices: fm.mediaDevices, onLiveChange: onLive });
    const before = fm.calls.enumerate;
    const r = await d.start('cam-hp');
    expect(r.ok).toBe(true);
    expect(fm.calls.getUserMedia).toEqual([{ video: { deviceId: { exact: 'cam-hp' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false }]);
    expect(fm.calls.enumerate).toBe(before + 1);
    expect(r.list.cameras[0].label).toBe('HP IR Camera');
    expect(d.isLive()).toBe(true);
    expect(onLive).toHaveBeenLastCalledWith(true);
    d.stopAll();
    expect(fm.liveTracks()).toEqual([]);
    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('NotReadableError -> in-use; only the DOMException name is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fm = createFakeMedia({ devices: HP_DEVICES });
    fm.failNext('NotReadableError');
    const d = createDevices({ mediaDevices: fm.mediaDevices });
    const r = await d.start('cam-hp');
    expect(r).toEqual({ ok: false, state: 'in-use', name: 'NotReadableError' });
    expect(warn).toHaveBeenCalledWith('[zoom-studio]', 'NotReadableError');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL_MEDIA_MESSAGE');
  });

  it('a track ended event stops everything', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const d = createDevices({ mediaDevices: fm.mediaDevices });
    await d.start('cam-hp');
    await d.startMic('mic-1');
    fm.tracks[0].end();
    expect(fm.liveTracks()).toEqual([]);
    expect(d.isLive()).toBe(false);
  });

  it('devicechange removing the active camera stops the preview (not-found)', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const d = createDevices({ mediaDevices: fm.mediaDevices });
    const cb = vi.fn();
    const off = d.onDeviceChange(cb);
    await d.start('cam-emeet');
    fm.setDevices(HP_DEVICES.filter((x) => x.deviceId !== 'cam-emeet'));
    await fm.emitDeviceChange();
    expect(fm.liveTracks()).toEqual([]);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ lost: 'not-found' }));
    off();
    expect(fm.listenerCount('devicechange')).toBe(0);
  });

  it('a devicechange that keeps the active camera does not stop it', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const d = createDevices({ mediaDevices: fm.mediaDevices });
    const cb = vi.fn();
    d.onDeviceChange(cb);
    await d.start('cam-hp');
    fm.setDevices(HP_DEVICES.filter((x) => x.deviceId !== 'cam-emeet'));
    await fm.emitDeviceChange();
    expect(fm.liveTracks().length).toBe(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ lost: null }));
  });

  it('mic test: audio-only getUserMedia, analyser level, never connected to the destination; stop closes it', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const d = createDevices({ mediaDevices: fm.mediaDevices, AudioContext: fm.AudioContext });
    const r = await d.startMic('mic-1');
    expect(r.ok).toBe(true);
    expect(fm.calls.getUserMedia).toEqual([{ audio: { deviceId: { exact: 'mic-1' } } }]);
    expect(d.micLevel()).toBeCloseTo(0.1, 5);
    expect(fm.audio.connections).toEqual([['source', 'analyser']]);
    expect(fm.audio.connections.some((c) => c[1] === 'destination')).toBe(false);
    d.stopMic();
    expect(fm.audio.contexts[0].closed).toBe(1);
    expect(fm.liveTracks()).toEqual([]);
    expect(d.micLevel()).toBe(0);
  });

  it('importing / creating the module touches no navigator.mediaDevices', async () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const nav = {};
    const touched = [];
    Object.defineProperty(nav, 'mediaDevices', { get() { touched.push(1); return createFakeMedia({ devices: [] }).mediaDevices; } });
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    try {
      const d = createDevices({});
      expect(touched).toEqual([]);
      await d.list();
      expect(touched.length).toBeGreaterThan(0);
    } finally {
      if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator;
    }
  });
});

describe('studio panel device flow', () => {
  it('Start calls getUserMedia once for the default (non-IR) camera; Stop stops every track', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    mountPanel(fm);
    await panel.show();
    expect(fm.calls.getUserMedia).toEqual([]);
    expect(panel._state().cameraId).toBe('cam-hp');
    click('start');
    await tick();
    expect(fm.calls.getUserMedia.length).toBe(1);
    expect(fm.calls.getUserMedia[0].video.deviceId).toEqual({ exact: 'cam-hp' });
    expect(fm.calls.getUserMedia[0].audio).toBe(false);
    expect(fm.liveTracks().length).toBe(1);
    click('stop');
    expect(fm.liveTracks()).toEqual([]);
    expect(panel._state().video.srcObject).toBe(null);
  });

  it('view hide (hub calls hide/stopAll) stops every track incl. the mic test', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    mountPanel(fm);
    await panel.show();
    click('start');
    await tick();
    click('mic-test');
    await tick();
    expect(fm.liveTracks().length).toBe(2);
    panel.hide();
    expect(fm.liveTracks()).toEqual([]);
    expect(fm.listenerCount('devicechange')).toBe(0);
  });

  it('NotReadableError shows the in-use message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fm = createFakeMedia({ devices: HP_DEVICES });
    mountPanel(fm);
    await panel.show();
    fm.failNext('NotReadableError');
    click('start');
    await tick();
    expect(panel._state().status.innerHTML).toContain('Camera is busy');
    expect(panel._state().previewing).toBe(false);
  });

  it('devicechange removing the active camera stops the preview and shows not-found', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    mountPanel(fm);
    await panel.show();
    click('start');
    await tick();
    fm.setDevices(HP_DEVICES.filter((x) => x.deviceId !== 'cam-hp'));
    await fm.emitDeviceChange();
    await tick();
    expect(fm.liveTracks()).toEqual([]);
    expect(panel._state().status.innerHTML).toContain('Camera not found');
    expect(panel._state().status.innerHTML).toContain('data-action="rescan"');
  });

  it('image mode never calls getUserMedia', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES });
    mountPanel(fm);
    await panel.show();
    panel._state().wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'image' } });
    await tick();
    click('start');
    await tick();
    expect(fm.calls.getUserMedia).toEqual([]);
    expect(panel._state().previewing).toBe(true);
    expect(panel._state().live).toBe(false);
    // Switching to image mode while the camera is live closes the camera.
    panel.stopAll();
    panel._state().wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'none' } });
    await tick();
    click('start');
    await tick();
    expect(fm.liveTracks().length).toBe(1);
    panel._state().wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'image' } });
    await tick();
    expect(fm.liveTracks()).toEqual([]);
    expect(fm.calls.getUserMedia.length).toBe(1);
  });

  it('native blur: offered only when the camera reports it; a rejected constraint reverts to none', async () => {
    const fm = createFakeMedia({ devices: HP_DEVICES, capabilities: { backgroundBlur: [false, true] } });
    mountPanel(fm);
    await panel.show();
    expect(panel._state().controls.innerHTML).not.toContain('value="nativeBlur"');
    click('start');
    await tick();
    expect(panel._state().controls.innerHTML).toContain('value="nativeBlur"');
    fm.tracks[0].rejectConstraints = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    panel._state().wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'nativeBlur' } });
    await tick();
    expect(fm.tracks[0].constraints).toEqual([{ backgroundBlur: true }]);
    expect(panel._state().pipeline.getState().effect.mode).toBe('none');
    expect(panel._state().status.innerHTML).toContain('This camera doesn&#39;t support it');
  });
});
