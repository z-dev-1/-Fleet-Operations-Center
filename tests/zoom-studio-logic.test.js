// FEAT-B1 / AC-15 (design §14.1-§14.3): pure Studio logic.
import { describe, it, expect } from 'vitest';
import * as L from '../renderer/src/js/zoom/studio-logic.js';

const FORBIDDEN = ['Go live', 'Send to Zoom', 'Virtual camera: on'];

describe('filters and clamps', () => {
  it('buildFilter gives brightness/contrast/saturate, + blur when asked', () => {
    expect(L.buildFilter({ brightness: 110, contrast: 90, saturation: 120 })).toBe('brightness(110%) contrast(90%) saturate(120%)');
    expect(L.buildFilter({}, 12)).toBe('brightness(100%) contrast(100%) saturate(100%) blur(12px)');
    expect(L.buildFilter(null, 0)).toBe('brightness(100%) contrast(100%) saturate(100%)');
  });
  it('clampAdjust clamps to the §15.1 ranges and rounds', () => {
    expect(L.clampAdjust({ brightness: 10, contrast: 999, saturation: -5, mirror: 'yes' })).toEqual({ brightness: 50, contrast: 150, saturation: 0, mirror: false });
    expect(L.clampAdjust({ brightness: 100.6, contrast: '120', saturation: 200, mirror: true })).toEqual({ brightness: 101, contrast: 120, saturation: 200, mirror: true });
    expect(L.clampRange('focus', 2)).toBe(0.9);
    expect(L.clampRange('radiusPx', 'x')).toBe(12);
  });
});

describe('chromaKeyMask', () => {
  const px = (...rgba) => new Uint8ClampedArray(rgba);
  it('pure green -> alpha 0; a skin tone stays 255 at the default tolerance', () => {
    const d = px(0, 255, 0, 255, 224, 172, 140, 255);
    L.chromaKeyMask(d, 'green', 50);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(255);
  });
  it('blue key uses b - max(r,g)', () => {
    const d = px(0, 0, 255, 255, 0, 255, 0, 255);
    L.chromaKeyMask(d, 'blue', 50);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(255);
  });
  it('threshold maps 0..100 -> 80..10; 20-wide linear feather below it', () => {
    expect(L.chromaThreshold(0)).toBe(80);
    expect(L.chromaThreshold(100)).toBe(10);
    expect(L.chromaThreshold(50)).toBe(45);
    // k = g - max(r,b): 45 -> 0, 35 -> half, 25 -> untouched (feather ends), 30 -> 3/4 of its alpha
    const d = px(100, 145, 0, 255, 100, 135, 0, 255, 100, 125, 0, 255, 100, 130, 0, 200);
    L.chromaKeyMask(d, 'green', 50);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(128);
    expect(d[11]).toBe(255);
    expect(d[15]).toBe(150);
  });
});

describe('geometry', () => {
  it('vignetteStops: alpha 1 to focus, 0 at the edge (focus clamped)', () => {
    expect(L.vignetteStops(0.6)).toEqual([{ offset: 0, alpha: 1 }, { offset: 0.6, alpha: 1 }, { offset: 1, alpha: 0 }]);
    expect(L.vignetteStops(5)[1].offset).toBe(0.9);
  });
  it('overlayRect centres at (x·W, y·H) with width scale·W, aspect kept', () => {
    expect(L.overlayRect({ x: 0.5, y: 0.5, scale: 0.5 }, 200, 100, 1280, 720)).toEqual({ x: 320, y: 200, w: 640, h: 320 });
    expect(L.overlayRect({ x: 0, y: 1, scale: 0.25 }, 100, 100, 640, 360)).toEqual({ x: -80, y: 280, w: 160, h: 160 });
    expect(L.overlayRect({ x: 0.5, y: 0.5, scale: 1 }, 0, 10, 640, 360)).toBe(null);
  });
  it('coverFit crops the source to fill the destination', () => {
    expect(L.coverFit(1000, 1000, 1280, 720)).toEqual({ sx: 0, sy: 218.75, sw: 1000, sh: 562.5 });
  });
  it('outputSize caps at 1280x720 keeping the aspect ratio', () => {
    expect(L.outputSize(1920, 1080)).toEqual({ w: 1280, h: 720 });
    expect(L.outputSize(640, 480)).toEqual({ w: 640, h: 480 });
    expect(L.outputSize(2592, 1944)).toEqual({ w: 960, h: 720 });
    expect(L.outputSize(0, 0)).toEqual({ w: 1280, h: 720 });
  });
});

describe('createFrameBudget', () => {
  it('degrades 640 -> 320 after 60 slow frames, recovers after 120 fast frames', () => {
    const b = L.createFrameBudget({ alpha: 1 });
    expect(b.workWidth).toBe(640);
    for (let i = 0; i < 59; i++) b.record(50);
    expect(b.workWidth).toBe(640);
    b.record(50);
    expect(b.workWidth).toBe(320);
    for (let i = 0; i < 119; i++) b.record(10);
    expect(b.workWidth).toBe(320);
    b.record(10);
    expect(b.workWidth).toBe(640);
  });
  it('a mid-range frame resets the run', () => {
    const b = L.createFrameBudget({ alpha: 1 });
    for (let i = 0; i < 59; i++) b.record(50);
    b.record(30);
    for (let i = 0; i < 59; i++) b.record(50);
    expect(b.workWidth).toBe(640);
  });
});

describe('media errors', () => {
  it('maps the design §14.1 table', () => {
    const m = (name) => L.mapMediaError({ name }).state;
    expect(m('NotAllowedError')).toBe('blocked');
    expect(m('SecurityError')).toBe('blocked');
    for (const n of ['NotReadableError', 'TrackStartError', 'AbortError']) expect(m(n)).toBe('in-use');
    for (const n of ['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError']) expect(m(n)).toBe('not-found');
    expect(L.mapMediaError({ name: 'WeirdError' })).toEqual({ state: 'error', name: 'WeirdError' });
    expect(L.mapMediaError(null).state).toBe('error');
    expect(L.stateMessage({ state: 'in-use' })).toBe('Camera is busy — close it in Zoom, OBS or Chrome, or pick another camera');
    expect(L.stateMessage({ state: 'error', name: 'Weird<b>' })).toBe('Camera error (Weirdb)');
  });
});

describe('devices', () => {
  const v = (deviceId, label) => ({ kind: 'videoinput', deviceId, label });
  it('pickDefaultCamera skips HP IR Camera and OBS Virtual Camera', () => {
    expect(L.pickDefaultCamera([v('ir', 'HP IR Camera'), v('obs', 'OBS Virtual Camera'), v('hp', 'HP 5MP Camera')])).toBe('hp');
    expect(L.pickDefaultCamera([v('obs', 'OBS Virtual Camera'), v('ir', 'HP IR Camera')])).toBe('ir');
    expect(L.pickDefaultCamera([v('obs', 'OBS Virtual Camera')])).toBe(null);
    expect(L.pickDefaultCamera([v('a', ''), v('b', '')])).toBe('a');
    expect(L.pickDefaultCamera([{ kind: 'audioinput', deviceId: 'm', label: 'Mic' }])).toBe(null);
  });
  it('deviceLabel: Camera n when empty, (IR) / (OBS) suffixes', () => {
    expect(L.deviceLabel(v('a', ''), 0)).toBe('Camera 1');
    expect(L.deviceLabel({ kind: 'audioinput', label: '' }, 1)).toBe('Microphone 2');
    expect(L.deviceLabel(v('a', 'HP IR Camera'), 0)).toBe('HP IR Camera (IR)');
    expect(L.deviceLabel(v('a', 'OBS Virtual Camera'), 0)).toBe('OBS Virtual Camera (OBS)');
    expect(L.deviceLabel(v('a', 'EMEET SmartCam S600'), 0)).toBe('EMEET SmartCam S600');
    expect(L.deviceLabel(v('a', 'Infrared-ish Cam'), 0)).toBe('Infrared-ish Cam');
  });
  it('obsState unknown / found / absent', () => {
    expect(L.obsState([v('a', ''), v('b', '')])).toBe('unknown');
    expect(L.obsState([])).toBe('unknown');
    expect(L.obsState([v('a', 'HP 5MP Camera'), v('b', 'OBS Virtual Camera')])).toBe('found');
    expect(L.obsState([v('a', 'HP 5MP Camera')])).toBe('absent');
    expect(L.obsNote('unknown')).toBe(L.OBS_NOTE_UNKNOWN);
    expect(L.obsNote('found')).toBe(L.OBS_NOTE_FOUND);
    expect(L.obsNote('absent')).toBe('');
  });
  it('supportsNativeBlur reads getCapabilities().backgroundBlur', () => {
    expect(L.supportsNativeBlur({ backgroundBlur: [false, true] })).toBe(true);
    expect(L.supportsNativeBlur({ backgroundBlur: [false] })).toBe(false);
    expect(L.supportsNativeBlur(null)).toBe(false);
  });
});

describe('effect state', () => {
  it('normalizeEffect / normalizeOverlays / imageIdsOf', () => {
    const e = L.normalizeEffect({ mode: 'chromaKey', chromaKey: { color: 'blue', tolerance: 200, backgroundId: 'l_0123456789ab' }, imageId: '../x' });
    expect(e).toEqual({ mode: 'chromaKey', edgeBlur: { radiusPx: 12, focus: 0.6 }, chromaKey: { color: 'blue', tolerance: 100, backgroundId: 'l_0123456789ab' }, imageId: null });
    expect(L.normalizeEffect({ mode: 'virtual' }).mode).toBe('none');
    const o = L.normalizeOverlays([1, 2, 3, 4].map((i) => ({ imageId: 'l_00000000000' + i, x: 2, opacity: 0.5 })).concat([{ imageId: 'bad' }]));
    expect(o.length).toBe(3);
    expect(o[0]).toEqual({ imageId: 'l_000000000001', x: 1, y: 0.5, scale: 0.3, opacity: 0.5 });
    expect(L.imageIdsOf(e, o).sort()).toEqual(['l_000000000001', 'l_000000000002', 'l_000000000003', 'l_0123456789ab']);
  });
});

describe('strings (§14.3)', () => {
  it('the honesty banner is the design text verbatim', () => {
    expect(L.HONESTY_BANNER).toBe("Preview only. Zoom can't see this video. Sending Fleet's effects into Zoom needs a virtual camera (OBS Virtual Camera or a driver installed by IT), and this PC doesn't have admin rights to install one. In Zoom, pick your real camera and use Zoom's own background/filters, or use your OBS setup below.");
    expect(L.HONESTY_BANNER.startsWith(L.HONESTY_BANNER_LEAD)).toBe(true);
    expect(L.EFFECT_LABELS.edgeBlur).toBe('Soft-focus edges — not person-aware');
    expect(L.EFFECT_LABELS.nativeBlur).toBe('Camera blur (from your camera/Windows)');
    expect(L.EFFECT_LABELS.chromaKey).toBe('Green-screen replace — needs a green or blue backdrop');
  });
  it('no exported string contains a forbidden phrase', () => {
    const strings = [];
    const walk = (v) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
    };
    for (const k of Object.keys(L)) walk(L[k]);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) for (const f of FORBIDDEN) expect(s.toLowerCase().includes(f.toLowerCase())).toBe(false);
  });
});
