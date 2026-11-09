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

function setup({ devices = HP_DEVICES, labelsAfterGrant = false, media, withTab = true, raf, hub, confirm, patchDoc } = {}) {
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
  const zoomHub = Object.assign(fakeHub(media), hub || {});
  if (patchDoc) patchDoc(document);
  const win = { listeners: {}, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); } };
  panel.mount(el, { zoomHub, flags: { studio: true }, bus: createBus(), document, window: win, confirm, mediaDevices: fm.mediaDevices, AudioContext: fm.AudioContext, raf: raf || (() => 1), caf: () => {} });
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

  it('integration: a preset loaded during a live preview follows the picker rules (image mode closes the camera, a camera change restarts on the new camera)', async () => {
    const { S, fm } = setup();
    await panel.show();
    click('start');
    await tick();
    expect(fm.liveTracks().length).toBe(1);
    const before = fm.calls.getUserMedia.length;
    // Camera change while live: the preview moves to the preset's camera (no new camera while stopped).
    panel.applyPreset({ camera: { id: 'cam-emeet', label: 'EMEET SmartCam S600' }, effect: { mode: 'none' } });
    await tick();
    expect(S.cameraId).toBe('cam-emeet');
    expect(fm.calls.getUserMedia.length).toBe(before + 1);
    expect(fm.liveTracks().length).toBe(1);
    expect(S.previewing).toBe(true);
    // Full-frame image preset while live: the camera is closed, the image preview keeps running.
    panel.applyPreset({ camera: { id: 'cam-emeet', label: 'EMEET SmartCam S600' }, effect: { mode: 'image', imageId: 'l_aaaaaaaaaaaa' } });
    await tick();
    expect(fm.liveTracks()).toEqual([]);
    expect(S.previewing).toBe(true);
    expect(S.pipeline.getState().effect.mode).toBe('image');
    // Back to a camera preset: the preview stops and asks for Start preview (never reopens by itself).
    const n = fm.calls.getUserMedia.length;
    panel.applyPreset({ camera: { id: 'cam-hp', label: 'HP 5MP Camera' }, effect: { mode: 'none' } });
    await tick();
    expect(fm.calls.getUserMedia.length).toBe(n);
    expect(S.previewing).toBe(false);
    expect(S.status.innerHTML).toContain('Press Start preview to open the camera.');
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
    for (const f of ['studio-panel.js', 'studio-logic.js', 'studio-devices.js', 'studio-pipeline.js', 'presets-panel.js', 'library-panel.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const p of FORBIDDEN) expect([f, src.toLowerCase().includes(p.toLowerCase())]).toEqual([f, false]);
    }
  });

  it('no driver / OBS configuration code; no permission handler on defaultSession', () => {
    const files = [
      ...['media-status.js', 'preset-schema.js', 'presets.js', 'library.js', 'image-sniff.js', 'launcher.js'].map((f) => require.resolve('../src/zoom/studio/' + f)),
      ...['studio-panel.js', 'studio-logic.js', 'studio-devices.js', 'studio-pipeline.js', 'presets-panel.js', 'library-panel.js'].map((f) => require.resolve('../renderer/src/js/zoom/' + f)),
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

// ── FEAT-B2: presets, library, launcher (design §15.2-§15.4; review F-8) ──────────────────────────
const LIB_PNG = 'l_aaaaaaaaaaaa';
const LIB_WEBP = 'l_bbbbbbbbbbbb';
const BAT = 'C:\\Users\\me\\Desktop\\Grim Reaper Zoom Face\\Start Grim Reaper.bat';

function b2Hub(over = {}) {
  const preset = {
    id: 'p_111111111111', name: 'Desk', version: 1,
    camera: { id: 'stale-id', label: 'EMEET SmartCam S600' }, mic: { id: null, label: null },
    effect: { mode: 'edgeBlur', edgeBlur: { radiusPx: 22, focus: 0.5 }, chromaKey: { color: 'green', tolerance: 50, backgroundId: null }, imageId: null },
    adjust: { brightness: 110, contrast: 100, saturation: 100, mirror: true }, overlays: [],
  };
  const gone = Object.assign({}, preset, { id: 'p_222222222222', name: 'Old cam', camera: { id: 'x', label: 'Gone Cam' } });
  return Object.assign({
    presetsList: vi.fn(async () => ({ ok: true, presets: [preset, gone], lastPresetId: preset.id })),
    presetSave: vi.fn(async ({ preset: p }) => ({ ok: true, preset: Object.assign({ id: 'p_333333333333' }, p) })),
    presetSelect: vi.fn(async () => ({ ok: true })),
    presetRename: vi.fn(async () => ({ ok: true })),
    presetDelete: vi.fn(async () => ({ ok: true })),
    libraryList: vi.fn(async () => ({ ok: true, items: [
      { id: LIB_PNG, name: 'Wall', kind: 'background', format: 'png', thumb: 'data:image/png;base64,UE5H', w: 640, h: 360 },
      { id: LIB_WEBP, name: 'Logo', kind: 'overlay', format: 'webp', thumb: null, w: 320, h: 180 },
    ] })),
    libraryRead: vi.fn(async ({ id }) => ({ ok: true, dataUrl: 'data:image/webp;base64,' + id, w: 320, h: 180 })),
    libraryImport: vi.fn(async () => ({ ok: true, items: [{ id: 'l_cccccccccccc' }], rejected: [{ name: '<b>x.png</b>', code: 'INVALID_FILE' }] })),
    libraryRename: vi.fn(async () => ({ ok: true })),
    libraryDelete: vi.fn(async () => ({ ok: true })),
    launcherGet: vi.fn(async () => ({ ok: true, path: BAT, exists: true, isDefault: true })),
    launcherPick: vi.fn(async () => ({ ok: true, path: BAT })),
    launcherRun: vi.fn(async () => ({ ok: true })),
  }, over);
}

/** Make <img> decode on src set and give canvases a 2D context + toDataURL (the WebP thumbnail path). */
function decodingDoc(document, { fail = false } = {}) {
  const orig = document.createElement;
  const drawn = [];
  document.createElement = (tag) => {
    const e = orig(tag);
    if (tag === 'img') {
      Object.defineProperty(e, 'src', {
        set(v) { this._src = v; Promise.resolve().then(() => { if (fail) { if (this.onerror) this.onerror(); return; } this.naturalWidth = 320; this.naturalHeight = 180; if (this.onload) this.onload(); }); },
        get() { return this._src; },
      });
    }
    if (tag === 'canvas') {
      e.getContext = () => ({ drawImage: (...a) => drawn.push(a.slice(1)) });
      e.toDataURL = () => 'data:image/png;base64,DRAWN';
    }
    return e;
  };
  return drawn;
}

describe('FEAT-B2 presets panel', () => {
  it('the first show restores lastPresetId onto the controls WITHOUT opening the camera; Load never calls getUserMedia', async () => {
    const hub = b2Hub();
    const { S, fm } = setup({ hub });
    await panel.show();
    await tick();
    expect(fm.calls.getUserMedia).toEqual([]);
    expect(S.cameraId).toBe('cam-emeet');                  // restored by label (the id differs per origin)
    expect(S.pipeline.getState().effect.mode).toBe('edgeBlur');
    expect(S.pipeline.getState().effect.edgeBlur.radiusPx).toBe(22);
    expect(S.pipeline.getState().adjust.mirror).toBe(true);
    const P = S.presetsPanel;
    expect(P._state().selectedId).toBe('p_111111111111');
    expect(P.root.innerHTML).toContain('Preset loaded. Press Start preview to see it.');
    // Load a preset whose camera is gone: default kept, "Saved camera not found".
    P.root.dispatch('click', { target: { dataset: { action: 'preset-load', id: 'p_222222222222' } } });
    await tick();
    expect(fm.calls.getUserMedia).toEqual([]);
    expect(S.cameraId).toBe('cam-emeet');
    expect(P.root.innerHTML).toContain('Saved camera not found');
    expect(hub.presetSelect).toHaveBeenLastCalledWith({ id: 'p_222222222222' });
    // A second show does not re-apply the stored preset over the user's edits.
    S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'none' } });
    panel.hide();
    await panel.show();
    await tick();
    expect(S.pipeline.getState().effect.mode).toBe('none');
    expect(fm.calls.getUserMedia).toEqual([]);
  });

  it('Save as new sends ONE {preset} object built from the current controls; errors use the field-aware message', async () => {
    const hub = b2Hub({ presetsList: vi.fn(async () => ({ ok: true, presets: [], lastPresetId: null })) });
    const { S } = setup({ hub });
    await panel.show();
    await tick();
    const P = S.presetsPanel;
    P.root.dispatch('click', { target: { dataset: { action: 'preset-save-new' } } });
    await tick();
    expect(hub.presetSave).not.toHaveBeenCalled();
    expect(P.root.innerHTML).toContain('Enter a preset name first.');
    P.root.dispatch('input', { target: { dataset: { role: 'preset-name' }, value: 'Office' } });
    S.wrap.dispatch('change', { target: { dataset: { role: 'mode' }, value: 'edgeBlur' } });
    await tick();
    P.root.dispatch('click', { target: { dataset: { action: 'preset-save-new' } } });
    await tick();
    expect(hub.presetSave).toHaveBeenCalledTimes(1);
    const arg = hub.presetSave.mock.calls[0];
    expect(arg.length).toBe(1);
    expect(Object.keys(arg[0])).toEqual(['preset']);
    expect(arg[0].preset).toMatchObject({ name: 'Office', camera: { id: 'cam-hp', label: 'HP 5MP Camera' }, effect: { mode: 'edgeBlur' }, overlays: [] });
    expect(hub.presetSelect).toHaveBeenCalledWith({ id: 'p_333333333333' });
    hub.presetSave.mockImplementationOnce(async () => ({ ok: false, code: 'INVALID_INPUT', field: 'effect.chromaKey.backgroundId' }));
    P.root.dispatch('input', { target: { dataset: { role: 'preset-name' }, value: 'Green' } });
    P.root.dispatch('click', { target: { dataset: { action: 'preset-save-new' } } });
    await tick();
    expect(P.root.innerHTML).toContain('Pick a background image in the Library before saving green-screen replace.');
    hub.presetSave.mockImplementationOnce(async () => ({ ok: false, code: 'DUPLICATE_NAME' }));
    P.root.dispatch('click', { target: { dataset: { action: 'preset-save-new' } } });
    await tick();
    expect(P.root.innerHTML).toContain('A preset with that name already exists.');
  });

  it('inline rename and delete with confirm', async () => {
    const hub = b2Hub();
    const confirm = vi.fn(() => true);
    const { S } = setup({ hub, confirm });
    await panel.show();
    await tick();
    const P = S.presetsPanel;
    P.root.dispatch('click', { target: { dataset: { action: 'preset-rename', id: 'p_111111111111' } } });
    expect(P.root.innerHTML).toContain('data-role="preset-rename"');
    P.root.dispatch('input', { target: { dataset: { role: 'preset-rename', id: 'p_111111111111' }, value: 'Desk 2' } });
    P.root.dispatch('click', { target: { dataset: { action: 'preset-rename-save', id: 'p_111111111111' } } });
    await tick();
    expect(hub.presetRename).toHaveBeenCalledWith({ id: 'p_111111111111', name: 'Desk 2' });
    P.root.dispatch('click', { target: { dataset: { action: 'preset-delete', id: 'p_222222222222' } } });
    await tick();
    expect(confirm).toHaveBeenCalledWith('Delete preset "Old cam"?');
    expect(hub.presetDelete).toHaveBeenCalledWith({ id: 'p_222222222222' });
    confirm.mockReturnValueOnce(false);
    P.root.dispatch('click', { target: { dataset: { action: 'preset-delete', id: 'p_111111111111' } } });
    await tick();
    expect(hub.presetDelete).toHaveBeenCalledTimes(1);
  });
});

describe('FEAT-B2 library panel', () => {
  it('grid with kind filter; WebP thumbnail drawn into a 160-px canvas and cached in memory; cleared on destroy', async () => {
    const hub = b2Hub();
    let drawn = null;
    const { S } = setup({ hub, patchDoc: (d) => { drawn = decodingDoc(d); } });
    await panel.show();
    await tick();
    const Lp = S.libraryPanel;
    expect(hub.libraryRead).toHaveBeenCalledWith({ id: LIB_WEBP });
    expect(hub.libraryRead).not.toHaveBeenCalledWith({ id: LIB_PNG });
    expect(drawn).toContainEqual([0, 0, 160, 90]);
    expect(Lp.cache.get(LIB_WEBP)).toBe('data:image/png;base64,DRAWN');
    expect(Lp.root.innerHTML).toContain('src="data:image/png;base64,DRAWN"');
    expect(Lp.root.innerHTML).toContain('src="data:image/png;base64,UE5H"');
    Lp.root.dispatch('change', { target: { dataset: { role: 'lib-filter' }, value: 'overlay' } });
    expect(Lp.root.innerHTML).toContain('data-id="' + LIB_WEBP + '"');
    expect(Lp.root.innerHTML).not.toContain('data-id="' + LIB_PNG + '" data-kind');
    const cache = Lp.cache;
    panel.destroy();
    expect(cache.size).toBe(0);
  });

  it('an undecodable image shows the broken-thumbnail placeholder with Delete', async () => {
    const hub = b2Hub();
    const { S } = setup({ hub, patchDoc: (d) => decodingDoc(d, { fail: true }) });
    await panel.show();
    await tick();
    const html = S.libraryPanel.root.innerHTML;
    expect(html).toContain('Can&#39;t show this image');
    expect(html).toContain('data-action="lib-delete" data-id="' + LIB_WEBP + '"');
  });

  it('drag onto a slot and the keyboard "Use as…" select assign images without starting the camera', async () => {
    const hub = b2Hub({ presetsList: vi.fn(async () => ({ ok: true, presets: [], lastPresetId: null })) });
    const { S, fm } = setup({ hub });
    await panel.show();
    await tick();
    const Lp = S.libraryPanel;
    const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } };
    Lp.root.dispatch('dragstart', { target: { dataset: { id: LIB_WEBP } }, dataTransfer: dt });
    let prevented = false;
    Lp.root.dispatch('dragover', { target: { dataset: { slot: 'overlay' } }, preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    Lp.root.dispatch('drop', { target: { dataset: { slot: 'overlay' } }, dataTransfer: dt });
    expect(S.pipeline.getState().overlays).toEqual([{ imageId: LIB_WEBP, x: 0.5, y: 0.5, scale: 0.3, opacity: 1 }]);
    Lp.root.dispatch('change', { type: 'change', target: { dataset: { role: 'lib-assign', id: LIB_PNG }, value: 'background' } });
    expect(S.pipeline.getState().effect.chromaKey.backgroundId).toBe(LIB_PNG);
    expect(Lp.root.innerHTML).toContain('Background set. Pick &#39;Green-screen replace&#39; under Effect to use it.');
    Lp.root.dispatch('change', { type: 'change', target: { dataset: { role: 'lib-assign', id: LIB_PNG }, value: 'avatar' } });
    expect(S.pipeline.getState().effect.imageId).toBe(LIB_PNG);
    // Slots render the names; overlay sliders mirror the schema ranges.
    expect(Lp.root.innerHTML).toContain('Background: Wall');
    expect(Lp.root.innerHTML).toContain('data-key="scale" min="0.05" max="2"');
    Lp.root.dispatch('input', { type: 'input', target: { dataset: { role: 'lib-overlay', index: '0', key: 'x' }, value: '0.2' } });
    expect(S.pipeline.getState().overlays[0].x).toBe(0.2);
    // An id that is not in the library (e.g. dragged from elsewhere) is ignored.
    Lp.root.dispatch('drop', { target: { dataset: { slot: 'avatar' } }, dataTransfer: { getData: () => 'l_999999999999' } });
    expect(S.pipeline.getState().effect.imageId).toBe(LIB_PNG);
    Lp.root.dispatch('click', { target: { dataset: { action: 'lib-clear', slot: 'overlay', index: '0' } } });
    expect(S.pipeline.getState().overlays).toEqual([]);
    expect(fm.calls.getUserMedia).toEqual([]);
  });

  it('delete with confirm; IN_USE -> "Used by N presets — delete anyway?" -> force; import shows rejected names escaped', async () => {
    const hub = b2Hub({ libraryDelete: vi.fn() });
    hub.libraryDelete.mockResolvedValueOnce({ ok: false, code: 'IN_USE', usedBy: 2 }).mockResolvedValueOnce({ ok: true });
    const confirm = vi.fn(() => true);
    const { S } = setup({ hub, confirm });
    await panel.show();
    await tick();
    const Lp = S.libraryPanel;
    Lp.root.dispatch('change', { type: 'change', target: { dataset: { role: 'lib-assign', id: LIB_PNG }, value: 'background' } });
    Lp.root.dispatch('click', { target: { dataset: { action: 'lib-delete', id: LIB_PNG } } });
    await tick();
    expect(confirm.mock.calls.map((c) => c[0])).toEqual(['Delete image "Wall"?', 'Used by 2 presets — delete anyway?']);
    expect(hub.libraryDelete.mock.calls).toEqual([[{ id: LIB_PNG }], [{ id: LIB_PNG, force: true }]]);
    expect(S.pipeline.getState().effect.chromaKey.backgroundId).toBe(null);   // dropped from the controls too
    expect(hub.presetsList.mock.calls.length).toBeGreaterThan(1);              // presets refreshed (refs cleared in main)
    Lp.root.dispatch('click', { target: { dataset: { action: 'lib-import' } } });
    await tick();
    expect(hub.libraryImport).toHaveBeenCalledWith({ kind: 'background' });
    expect(Lp.root.innerHTML).toContain('Imported 1 image. Not imported: &lt;b&gt;x.png&lt;/b&gt;');
    expect(Lp.root.innerHTML).not.toContain('<b>x.png');
    Lp.root.dispatch('click', { target: { dataset: { action: 'lib-rename', id: LIB_WEBP } } });
    Lp.root.dispatch('input', { type: 'input', target: { dataset: { role: 'lib-rename', id: LIB_WEBP }, value: 'Brand' } });
    Lp.root.dispatch('click', { target: { dataset: { action: 'lib-rename-save', id: LIB_WEBP } } });
    await tick();
    expect(hub.libraryRename).toHaveBeenCalledWith({ id: LIB_WEBP, name: 'Brand' });
  });
});

describe('FEAT-B2 launcher section (review F-8)', () => {
  it('Launch stops the Fleet preview BEFORE launcherRun; note text; Change… goes through launcherPick', async () => {
    const order = [];
    let fmRef = null;
    const hub = b2Hub({
      launcherRun: vi.fn(async () => { order.push(['run', fmRef.liveTracks().length, fmRef.tracks.map((t) => t.stopped)]); return { ok: true }; }),
    });
    const { S, fm } = setup({ hub });
    fmRef = fm;
    await panel.show();
    await tick();
    const html = S.launcherEl.innerHTML;
    expect(html).toContain(panel.LAUNCHER_TITLE);
    expect(html).toContain('Virtual-camera setup (outside Fleet)');
    expect(html).toContain('Launch virtual-camera setup');
    expect(html).toContain('Change…');
    expect(html).toContain('(default)');
    expect(html).toContain(BAT.replace(/\\/g, '\\'));
    expect(html).toContain("Starts your Grim Reaper page. OBS must capture that window and Start Virtual Camera; then pick &#39;OBS Virtual Camera&#39; in Zoom. Fleet&#39;s preview is stopped so the Grim Reaper page can use the camera.");
    expect(html).not.toContain('OBS Virtual Camera is installed on this PC.');
    click('start');
    await tick();
    expect(fm.liveTracks().length).toBe(1);
    expect(S.badge.style.display).toBe('');
    click('launcher-run');
    await tick();
    expect(order).toEqual([['run', 0, [1]]]);                       // every track already stopped
    expect(S.badge.style.display).toBe('none');
    expect(S.launcherEl.innerHTML).toContain('Launcher started outside Fleet.');
    hub.launcherRun.mockResolvedValueOnce({ ok: false, code: 'BUSY' });
    click('launcher-run');
    await tick();
    expect(S.launcherEl.innerHTML).toContain('Busy. Try again shortly.');
    click('launcher-pick');
    await tick();
    expect(hub.launcherPick).toHaveBeenCalledTimes(1);
    expect(hub.launcherPick.mock.calls[0].length).toBe(0);           // the renderer never supplies a path
    expect(S.launcherEl.innerHTML).toContain('Launcher file updated.');
  });

  it("'Not set' disables Launch; the OBS found sentence is added when OBS Virtual Camera is present", async () => {
    const withObs = HP_DEVICES.concat([{ kind: 'videoinput', deviceId: 'cam-obs', label: 'OBS Virtual Camera' }]);
    const hub = b2Hub({ launcherGet: vi.fn(async () => ({ ok: true, path: null, exists: false, isDefault: false })) });
    const { S } = setup({ hub, devices: withObs });
    await panel.show();
    await tick();
    const html = S.launcherEl.innerHTML;
    expect(html).toContain('Launcher: Not set');
    expect(html).toMatch(/data-action="launcher-run" aria-label="Launch virtual-camera setup" disabled/);
    expect(html).toContain('the camera. OBS Virtual Camera is installed on this PC.');
    expect(panel.launcherNote('found')).toBe(panel.LAUNCHER_NOTE + ' OBS Virtual Camera is installed on this PC.');
    expect(panel.launcherNote('unknown')).toBe(panel.LAUNCHER_NOTE);
  });

  it('no forbidden phrase in any B2 rendered state; the honesty banner stays first', async () => {
    const hub = b2Hub();
    const { S } = setup({ hub, confirm: () => true });
    await panel.show();
    await tick();
    click('launcher-run');
    await tick();
    const snaps = [allText(S.wrap), panel.renderLauncher({ path: null }), panel.renderLauncher({ path: BAT, exists: false, obsState: 'found', message: 'x' })];
    for (const code of ['INVALID_PATH', 'NOT_FOUND', 'LAUNCH_FAILED', 'CANCELLED', 'BUSY']) snaps.push(panel.launcherMessage({ ok: false, code }));
    const text = snaps.join('\n').toLowerCase();
    for (const f of FORBIDDEN) expect(text.includes(f.toLowerCase())).toBe(false);
    expect(S.wrap.children[0]).toBe(S.banner);
    expect(bannerText(S)).toBe(L.HONESTY_BANNER);
  });
});
