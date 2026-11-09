// FEAT-B1 / AC-19 (design §14.1, §14.3; FR-8): the Studio panel — honesty banner, OBS tri-state note,
// permission banner, show never calls getUserMedia, Camera on badge, no forbidden phrase anywhere.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFakeMedia, HP_DEVICES } from './fixtures/zoom/fake-media.js';
import { createExtDom, createBus, ExtElement } from './fixtures/zoom/fake-dom-ext.js';

const require = createRequire(import.meta.url);
const panel = await import('../renderer/src/js/zoom/studio-panel.js');
const L = await import('../renderer/src/js/zoom/studio-logic.js');

const FORBIDDEN = ['Go live', 'Send to Zoom', 'Virtual camera: on'];
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function fakeHub(media = { ok: true, camera: 'granted', microphone: 'granted' }) {
  return {
    mediaStatus: vi.fn(async () => media),
    openPrivacy: vi.fn(async () => ({ ok: true })),
    libraryRead: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })),
  };
}

function setup({ devices = HP_DEVICES, labelsAfterGrant = false, media, withTab = true, raf } = {}) {
  const fm = createFakeMedia({ devices, labelsAfterGrant });
  const { document, body } = createExtDom();
  let tab = null;
  if (withTab) {
    tab = document.createElement('button');
    tab.className = 'tb-tab';
    tab.dataset.view = 'zoom';
    body.appendChild(tab);
  }
  const el = document.createElement('div');
  body.appendChild(el);
  const zoomHub = fakeHub(media);
  const win = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); } };
  panel.mount(el, { zoomHub, flags: { studio: true }, bus: createBus(), document, window: win, mediaDevices: fm.mediaDevices, AudioContext: fm.AudioContext, raf: raf || (() => 1), caf: () => {} });
  return { fm, el, zoomHub, document, tab, win, S: panel._state() };
}

const click = (action, extra = {}) => panel._state().wrap.dispatch('click', { target: { dataset: Object.assign({ action }, extra) } });

function allText(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.textContent === 'string') out.push(n.textContent);
    if (typeof n.innerHTML === 'string') out.push(n.innerHTML);
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  return out.join('\n');
}

const bannerText = (S) => S.banner.children.map((c) => c.textContent).join('');

afterEach(() => { panel.destroy(); vi.restoreAllMocks(); });

describe('honesty banner (§14.3)', () => {
  it('is the first element, permanent, non-dismissable, with the exact text', async () => {
    const { S, fm } = setup();
    expect(S.wrap.children[0]).toBe(S.banner);
    expect(bannerText(S)).toBe(L.HONESTY_BANNER);
    expect(S.banner.children[0].tagName).toBe('STRONG');
    expect(S.banner.getAttribute('role')).toBe('note');
    expect(allText(S.banner)).not.toMatch(/dismiss|close/i);
    await panel.show();
    click('start');
    await tick();
    fm.failNext('NotAllowedError');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    click('start');
    await tick();
    panel.stopAll();
    expect(S.wrap.children[0]).toBe(S.banner);
    expect(bannerText(S)).toBe(L.HONESTY_BANNER);
  });
});

describe('show', () => {
  it('calls mediaStatus + enumerateDevices only, never getUserMedia', async () => {
    const { fm, zoomHub } = setup();
    await panel.show();
    expect(zoomHub.mediaStatus).toHaveBeenCalledTimes(1);
    expect(fm.calls.enumerate).toBe(1);
    expect(fm.calls.getUserMedia).toEqual([]);
    panel.hide();
    await panel.show();
    expect(fm.calls.getUserMedia).toEqual([]);
  });

  it('denied camera -> Windows banner with Open Windows camera settings -> openPrivacy({which:camera})', async () => {
    const { S, zoomHub } = setup({ media: { ok: true, camera: 'denied', microphone: 'granted' } });
    await panel.show();
    expect(S.privacy.innerHTML).toContain('Windows is blocking camera access for desktop apps.');
    expect(S.privacy.innerHTML).toContain('data-action="open-privacy" data-which="camera"');
    expect(S.privacy.innerHTML).toContain('Open Windows camera settings');
    expect(S.privacy.innerHTML).not.toContain('microphone');
    click('open-privacy', { which: 'camera' });
    await tick();
    expect(zoomHub.openPrivacy).toHaveBeenCalledWith({ which: 'camera' });
  });

  it('granted -> no privacy banner; restricted mic -> mic banner', async () => {
    const a = setup();
    await panel.show();
    expect(a.S.privacy.innerHTML).toBe('');
    panel.destroy();
    const b = setup({ media: { ok: true, camera: 'granted', microphone: 'restricted' } });
    await panel.show();
    expect(b.S.privacy.innerHTML).toContain('Open Windows microphone settings');
    click('open-privacy', { which: 'microphone' });
    await tick();
    expect(b.zoomHub.openPrivacy).toHaveBeenCalledWith({ which: 'microphone' });
  });
});

describe('OBS tri-state note', () => {
  const withObs = HP_DEVICES.concat([{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }]);

  it('empty labels -> OBS_NOTE_UNKNOWN, no presence/absence claim; after a successful start that re-enumerates OBS -> found note', async () => {
    const { S, fm } = setup({ devices: [{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }].concat(HP_DEVICES), labelsAfterGrant: true });
    await panel.show();
    expect(S.obs.textContent).toBe(L.OBS_NOTE_UNKNOWN);
    expect(S.obs.textContent).not.toMatch(/is installed|not installed/);
    expect(S.controls.innerHTML).toContain('Camera 1');
    // Unlabeled: the first device is the automatic pick (Chromium hides labels before the first grant).
    // Once labels arrive it turns out to be OBS, so the preview switches once to the real default camera.
    expect(S.cameraId).toBe('cam-obs');
    click('start');
    await tick();
    expect(fm.calls.getUserMedia.map((c) => c.video.deviceId.exact)).toEqual(['cam-obs', 'cam-hp']);
    expect(fm.liveTracks().map((t) => t.deviceId)).toEqual(['cam-hp']);
    expect(S.cameraId).toBe('cam-hp');
    expect(S.obs.textContent).toBe(L.OBS_NOTE_FOUND);
    // After labels arrive, OBS is never the default and is labelled (OBS).
    expect(S.controls.innerHTML).toContain('OBS Virtual Camera (OBS)');
    panel.stopAll();
    S.cameraId = null;
    await panel.show();
    expect(S.cameraId).toBe('cam-hp');
  });

  it('OBS device is never the default but stays selectable', async () => {
    const { S } = setup({ devices: [{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }].concat(HP_DEVICES) });
    await panel.show();
    expect(S.cameraId).toBe('cam-hp');
    expect(S.controls.innerHTML).toContain('<option value="cam-obs">OBS Virtual Camera (OBS)</option>');
    expect(S.obs.textContent).toBe(L.OBS_NOTE_FOUND);
  });

  it('labels present without OBS -> absent: no OBS note', async () => {
    const { S } = setup();
    await panel.show();
    expect(S.obs.textContent).toBe('');
    expect(S.obs.style.display).toBe('none');
  });

  it('devicechange re-evaluates the note', async () => {
    const { S, fm } = setup();
    await panel.show();
    expect(S.obs.textContent).toBe('');
    fm.setDevices(withObs);
    await fm.emitDeviceChange();
    await tick();
    expect(S.obs.textContent).toBe(L.OBS_NOTE_FOUND);
  });
});

describe('Camera on badge', () => {
  it('shows in the header and on the toolbar Zoom tab while a track is live; clears on stopAll', async () => {
    const { S, tab } = setup();
    await panel.show();
    expect(S.badge.style.display).toBe('none');
    expect(tab.classList.contains('zs-camera-on')).toBe(false);
    click('start');
    await tick();
    expect(S.badge.textContent).toBe('● Camera on');
    expect(S.badge.style.display).toBe('');
    expect(tab.classList.contains('zs-camera-on')).toBe(true);
    panel.stopAll();
    expect(S.badge.style.display).toBe('none');
    expect(tab.classList.contains('zs-camera-on')).toBe(false);
  });

  it('a track ended clears the badge; beforeunload stops everything', async () => {
    const { S, fm, tab, win } = setup();
    await panel.show();
    click('start');
    await tick();
    fm.tracks[0].end();
    expect(S.badge.style.display).toBe('none');
    expect(tab.classList.contains('zs-camera-on')).toBe(false);
    click('start');
    await tick();
    expect(fm.liveTracks().length).toBe(1);
    for (const fn of win.listeners.beforeunload) fn();
    expect(fm.liveTracks()).toEqual([]);
  });
});

describe('controls', () => {
  it('buttons are type=button with aria-labels; slider ranges mirror §15.1; mic test is off by default', async () => {
    const { S } = setup();
    await panel.show();
    const html = S.controls.innerHTML;
    const buttons = html.match(/<button[^>]*>/g) || [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) { expect(b).toContain('type="button"'); expect(b).toMatch(/aria-label="[^"]+"/); }
    expect(html).toContain('data-key="brightness" min="50" max="150"');
    expect(html).toContain('data-key="saturation" min="0" max="200"');
    expect(html).toContain('data-action="mic-test" aria-pressed="false"');
    S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'edgeBlur' } });
    await tick();
    expect(S.controls.innerHTML).toContain('data-key="radiusPx" min="0" max="40"');
    expect(S.controls.innerHTML).toContain('data-key="focus" min="0.3" max="0.9"');
    expect(S.controls.innerHTML).toContain('Soft-focus edges — not person-aware');
    S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'chromaKey' } });
    await tick();
    expect(S.controls.innerHTML).toContain('data-key="tolerance" min="0" max="100"');
    S.wrap.dispatch('input', { target: { dataset: { role: 'effect', group: 'chromaKey', key: 'tolerance' }, value: '70' } });
    S.wrap.dispatch('input', { target: { dataset: { role: 'adjust', key: 'brightness' }, value: '120' } });
    S.wrap.dispatch('change', { target: { dataset: { role: 'adjust', key: 'mirror' }, checked: true } });
    const st = S.pipeline.getState();
    expect(st.effect.chromaKey.tolerance).toBe(70);
    expect(st.adjust).toEqual({ brightness: 120, contrast: 100, saturation: 100, mirror: true });
  });

  it('mic test shows a level bar and stops on toggle', async () => {
    const { S, fm } = setup();
    await panel.show();
    click('mic-test');
    await tick();
    expect(S.micOn).toBe(true);
    expect(S.meter.style.display).toBe('');
    expect(S.fill.style.width).toBe('30%');
    expect(S.badge.style.display).toBe('');
    click('mic-test');
    expect(fm.liveTracks()).toEqual([]);
    expect(S.meter.style.display).toBe('none');
  });

  it('B2 mount points exist; applyPreset sets controls without starting the camera', async () => {
    const { S, fm } = setup();
    await panel.show();
    const hosts = panel.getHosts();
    expect(hosts.presets.className).toBe('zs-presets-host');
    expect(hosts.launcher.className).toBe('zs-launcher-host');
    const r = panel.applyPreset({ camera: { id: 'stale-id', label: 'EMEET SmartCam S600' }, effect: { mode: 'edgeBlur', edgeBlur: { radiusPx: 20 } }, adjust: { brightness: 90 } });
    expect(r.cameraFound).toBe(true);
    expect(S.cameraId).toBe('cam-emeet');
    expect(fm.calls.getUserMedia).toEqual([]);
    const cur = panel.currentPreset();
    expect(cur.camera).toEqual({ id: 'cam-emeet', label: 'EMEET SmartCam S600' });
    expect(cur.effect.mode).toBe('edgeBlur');
    expect(cur.effect.edgeBlur.radiusPx).toBe(20);
    expect(cur.adjust.brightness).toBe(90);
    expect(panel.applyPreset({ camera: { id: 'x', label: 'Gone Cam' } }).cameraFound).toBe(false);
    expect(panel.getObsState()).toBe('absent');
  });
});

describe('pipeline smoke (fake 2D context)', () => {
  function recorder() {
    const calls = [];
    const ctx = new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'getImageData') return (x, y, w, h) => { calls.push(['getImageData', w, h]); return { data: new Uint8ClampedArray(w * h * 4) }; };
        if (k === 'createRadialGradient') return () => ({ addColorStop: (o, c) => calls.push(['stop', o, c]) });
        return (...a) => { calls.push([k, ...a]); };
      },
      set(t, k, v) { t[k] = v; calls.push(['set', k, v]); return true; },
    });
    return { ctx, calls };
  }

  it('draws filter + mirror, edge blur stops, chroma work canvas <= 640 px, overlays skipped when missing', async () => {
    const recs = [];
    const frames = [];
    const { S } = setup({ raf: (fn) => { frames.push(fn); return frames.length; } });
    const mkCanvas = (c) => { const r = recorder(); recs.push(r); c.getContext = () => r.ctx; return r; };
    const main = mkCanvas(S.canvas);
    const origCreate = S.doc.createElement;
    S.doc.createElement = (tag) => { const e = origCreate(tag); if (tag === 'canvas') mkCanvas(e); return e; };
    await panel.show();
    click('start');
    await tick();
    Object.assign(S.video, { readyState: 4, videoWidth: 1920, videoHeight: 1080 });
    S.wrap.dispatch('change', { target: { dataset: { role: 'adjust', key: 'mirror' }, checked: true } });
    expect(S.pipeline.drawFrame()).toBe(true);
    expect(main.calls).toContainEqual(['set', 'filter', 'brightness(100%) contrast(100%) saturate(100%)']);
    expect(main.calls).toContainEqual(['setTransform', -1, 0, 0, 1, 1280, 0]);
    expect(S.canvas.width).toBe(1280);
    expect(S.canvas.height).toBe(720);
    S.pipeline.setEffect({ mode: 'edgeBlur', edgeBlur: { focus: 0.5 } });
    S.pipeline.drawFrame();
    expect(main.calls).toContainEqual(['set', 'filter', 'brightness(100%) contrast(100%) saturate(100%) blur(12px)']);
    const sharp = recs[1];
    expect(sharp.calls).toContainEqual(['set', 'globalCompositeOperation', 'destination-in']);
    expect(sharp.calls).toContainEqual(['stop', 0.5, 'rgba(0,0,0,1)']);
    S.pipeline.setEffect({ mode: 'chromaKey' });
    S.pipeline.setOverlays([{ imageId: 'l_0123456789ab', x: 0.5, y: 0.5, scale: 0.3, opacity: 0.8 }]);
    await tick();
    S.pipeline.drawFrame();
    const work = recs[2];
    expect(work.calls).toContainEqual(['getImageData', 640, 360]);
    expect(S.zoomHub.libraryRead).toHaveBeenCalledWith({ id: 'l_0123456789ab' });
    expect(S.pipeline.warnings()).toEqual(['l_0123456789ab']);
    expect(S.status.innerHTML).toContain('missing image');
    // the rAF loop is scheduled; stopAll ends it
    expect(frames.length).toBeGreaterThan(0);
    panel.stopAll();
    expect(S.pipeline.running).toBe(false);
  });

  it('getOutputStream is never called in v1', () => {
    const dir = path.dirname(require.resolve('../renderer/src/js/zoom/studio-pipeline.js'));
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f === 'studio-pipeline.js') expect(src).toContain('NOT called anywhere in v1');
      else expect(src.includes('getOutputStream(')).toBe(false);
    }
    const hub = fs.readFileSync(require.resolve('../renderer/src/js/views/zoom-hub.js'), 'utf8');
    expect(hub.includes('getOutputStream')).toBe(false);
  });
});

describe('no forbidden phrase (§14.3)', () => {
  it('in rendered HTML across states and in every exported string of the panel modules', async () => {
    const { S, fm } = setup({ media: { ok: true, camera: 'denied', microphone: 'denied' } });
    await panel.show();
    const snaps = [allText(S.wrap)];
    for (const mode of L.EFFECT_MODES) {
      S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: mode } });
      await tick();
      snaps.push(allText(S.wrap));
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const name of ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'WeirdError']) {
      S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'none' } });
      await tick();
      fm.failNext(name);
      click('start');
      await tick();
      snaps.push(allText(S.wrap));
    }
    for (const st of ['blocked', 'in-use', 'not-found', 'error']) snaps.push(panel.renderState({ state: st, name: 'X' }));
    snaps.push(panel.renderPrivacy({ camera: 'denied', microphone: 'restricted' }));
    const text = snaps.join('\n');
    for (const f of FORBIDDEN) expect(text.toLowerCase().includes(f.toLowerCase())).toBe(false);
    const dir = path.dirname(require.resolve('../renderer/src/js/zoom/studio-panel.js'));
    for (const f of ['studio-panel.js', 'studio-logic.js', 'studio-devices.js', 'studio-pipeline.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const p of FORBIDDEN) expect([f, src.toLowerCase().includes(p.toLowerCase())]).toEqual([f, false]);
    }
  });

  it('no driver / OBS configuration code; no permission handler on defaultSession', () => {
    const files = [
      require.resolve('../src/zoom/studio/media-status.js'),
      ...['studio-panel.js', 'studio-logic.js', 'studio-devices.js', 'studio-pipeline.js'].map((f) => require.resolve('../renderer/src/js/zoom/' + f)),
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/setPermissionRequestHandler|setPermissionCheckHandler|defaultSession/);
      expect(src).not.toMatch(/obs-websocket|basic\.ini|scene_collection|\.sys['"]|DirectShow|regsvr32/i);
      expect(src).not.toMatch(/child_process|spawn\(|execFile/);
    }
  });
});

describe('hub integration', () => {
  it('the real panel mounts in the hub; settings drawer and leaving the view stop the camera', async () => {
    if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
    const view = await import('../renderer/src/js/views/zoom-hub.js');
    view._resetForTests();
    const { document, dom } = createExtDom();
    const fm = createFakeMedia({ devices: HP_DEVICES });
    const bus = createBus();
    const mount = new ExtElement('views-mount', 'div', dom);
    const zoomHub = fakeHub();
    // views/zoom-hub.js passes {zoomHub, flags, bus}; navigator.mediaDevices is the default source.
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: fm.mediaDevices }, configurable: true, writable: true });
    try {
      const h = view.init(mount, { enabled: true, data: false, studio: true }, { bus, addTab: () => {}, zoomHub, document });
      const studioEl = h.root.querySelector('#zh-panel-studio');
      expect(studioEl.querySelector('.zs-honesty')).not.toBe(null);
      bus.emit('ui:view-change', { to: 'zoom' });
      await tick();
      expect(fm.calls.getUserMedia).toEqual([]);
      click('start');
      await tick();
      expect(fm.liveTracks().length).toBe(1);
      bus.emit('ui:view-change', { to: 'settings' });
      expect(fm.liveTracks()).toEqual([]);
      click('start');
      await tick();
      bus.emit('ui:view-change', { to: 'fleet' });
      expect(fm.liveTracks()).toEqual([]);
    } finally {
      if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav); else delete globalThis.navigator;
      view._resetForTests();
    }
  });
});
