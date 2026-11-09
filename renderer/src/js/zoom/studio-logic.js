/**
 * zoom/studio-logic.js -- pure camera-studio logic (design §14.1-§14.3, FEAT-B1). No DOM access.
 *
 * Effect math (filters, chroma key, vignette, overlay / cover-fit rectangles, output size, frame
 * budget), media error mapping, default-camera choice, device labels, OBS detection and the exact
 * user-facing strings. Preview only: nothing here sends video anywhere.
 */

// ── UI strings (exact) ──────────────────────────────────────────────────────

export const HONESTY_BANNER_LEAD = 'Preview only.';
export const HONESTY_BANNER = "Preview only. Zoom can't see this video. Sending Fleet's effects into Zoom needs a virtual camera (OBS Virtual Camera or a driver installed by IT), and this PC doesn't have admin rights to install one. In Zoom, pick your real camera and use Zoom's own background/filters, or use your OBS setup below.";

export const OBS_NOTE_UNKNOWN = 'Fleet checks for OBS Virtual Camera after you start the preview once.';
export const OBS_NOTE_FOUND = "OBS Virtual Camera is installed on this PC. Fleet can't send its preview into it yet; OBS still needs its own source (e.g. your Grim Reaper window).";

export const PRIVACY_BANNER_CAMERA = 'Windows is blocking camera access for desktop apps. Turn on Settings › Privacy & security › Camera › Let desktop apps access your camera';
export const PRIVACY_BANNER_MIC = 'Windows is blocking microphone access for desktop apps. Turn on Settings › Privacy & security › Microphone › Let desktop apps access your microphone';
export const PRIVACY_BUTTON_CAMERA = 'Open Windows camera settings';
export const PRIVACY_BUTTON_MIC = 'Open Windows microphone settings';

export const EFFECT_LABELS = Object.freeze({
  none: 'No effect',
  edgeBlur: 'Soft-focus edges — not person-aware',
  nativeBlur: 'Camera blur (from your camera/Windows)',
  chromaKey: 'Green-screen replace — needs a green or blue backdrop',
  image: 'Full-frame image (camera stays off)',
});
export const EFFECT_MODES = Object.freeze(['none', 'edgeBlur', 'nativeBlur', 'chromaKey', 'image']);

export const NATIVE_BLUR_UNSUPPORTED = "This camera doesn't support it";
export const NATIVE_BLUR_NOTE = 'This may also affect other apps that use the camera.';
export const MISSING_IMAGE = 'missing image';
export const CAMERA_ON_BADGE = '● Camera on';

export const STATE_MESSAGES = Object.freeze({
  blocked: 'Camera blocked. Allow camera access, then try again.',
  'in-use': 'Camera is busy — close it in Zoom, OBS or Chrome, or pick another camera',
  'not-found': 'Camera not found. Re-scan or pick another camera.',
  error: 'Camera error',
});

// ── Ranges (mirror of the B2 preset schema, design §15.1; the renderer only mirrors them) ──

export const RANGES = Object.freeze({
  radiusPx: { min: 0, max: 40, step: 1, def: 12 },
  focus: { min: 0.3, max: 0.9, step: 0.05, def: 0.6 },
  tolerance: { min: 0, max: 100, step: 1, def: 50 },
  brightness: { min: 50, max: 150, step: 1, def: 100 },
  contrast: { min: 50, max: 150, step: 1, def: 100 },
  saturation: { min: 0, max: 200, step: 1, def: 100 },
  x: { min: 0, max: 1, step: 0.01, def: 0.5 },
  y: { min: 0, max: 1, step: 0.01, def: 0.5 },
  scale: { min: 0.05, max: 2, step: 0.01, def: 0.3 },
  opacity: { min: 0, max: 1, step: 0.05, def: 1 },
});
export const MAX_OVERLAYS = 3;
export const OUTPUT_MAX_W = 1280;
export const OUTPUT_MAX_H = 720;

function _num(v, r, int) {
  let n = typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : r.def);
  if (n < r.min) n = r.min;
  if (n > r.max) n = r.max;
  return int ? Math.round(n) : n;
}

/** clampRange(name, v) -> v clamped to RANGES[name] (default when not a number). */
export function clampRange(name, v) {
  const r = RANGES[name];
  if (!r) return v;
  return _num(v, r, r.step >= 1);
}

/** clampAdjust(a) -> {brightness, contrast, saturation, mirror} (ints in range, defaults filled). */
export function clampAdjust(a) {
  const o = a && typeof a === 'object' ? a : {};
  return {
    brightness: _num(o.brightness, RANGES.brightness, true),
    contrast: _num(o.contrast, RANGES.contrast, true),
    saturation: _num(o.saturation, RANGES.saturation, true),
    mirror: o.mirror === true,
  };
}

/** buildFilter(adjust, blurPx) -> 'brightness(b%) contrast(c%) saturate(s%)' (+ ' blur(rpx)' when blurPx > 0). */
export function buildFilter(adjust, blurPx) {
  const a = clampAdjust(adjust);
  let f = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`;
  const r = typeof blurPx === 'number' && Number.isFinite(blurPx) ? Math.round(Math.min(Math.max(blurPx, 0), RANGES.radiusPx.max)) : 0;
  if (r > 0) f += ` blur(${r}px)`;
  return f;
}

/** chromaThreshold(tolerance) -> key-strength threshold: tolerance 0..100 maps linearly to 80..10. */
export function chromaThreshold(tolerance) {
  const t = _num(tolerance, RANGES.tolerance, false);
  return 80 - (t / 100) * 70;
}

export const CHROMA_FEATHER = 20;

/**
 * chromaKeyMask(data, color, tolerance) -- in place on RGBA bytes (Uint8ClampedArray).
 * Key strength: green g - max(r,b); blue b - max(r,g). Strength >= threshold -> alpha 0; within
 * CHROMA_FEATHER below the threshold -> linear feather; all other pixels untouched. Returns data.
 */
export function chromaKeyMask(data, color, tolerance) {
  const th = chromaThreshold(tolerance);
  const lo = th - CHROMA_FEATHER;
  const blue = color === 'blue';
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const k = blue ? b - (r > g ? r : g) : g - (r > b ? r : b);
    if (k >= th) data[i + 3] = 0;
    else if (k > lo) data[i + 3] = Math.round(data[i + 3] * ((th - k) / CHROMA_FEATHER));
  }
  return data;
}

/**
 * vignetteStops(focus) -> radial-gradient stops for a gradient of radius min(w,h)/2: alpha 1 from the
 * centre to `focus` of the radius, then a linear feather to 0 at the edge.
 */
export function vignetteStops(focus) {
  const f = _num(focus, RANGES.focus, false);
  return [{ offset: 0, alpha: 1 }, { offset: f, alpha: 1 }, { offset: 1, alpha: 0 }];
}

/** overlayRect({x,y,scale}, imgW, imgH, W, H) -> {x, y, w, h} centred at (x·W, y·H), width scale·W, aspect kept. */
export function overlayRect(o, imgW, imgH, W, H) {
  if (!(imgW > 0) || !(imgH > 0) || !(W > 0) || !(H > 0)) return null;
  const p = o && typeof o === 'object' ? o : {};
  const x = _num(p.x, RANGES.x, false);
  const y = _num(p.y, RANGES.y, false);
  const s = _num(p.scale, RANGES.scale, false);
  const w = s * W;
  const h = w * (imgH / imgW);
  return { x: x * W - w / 2, y: y * H - h / 2, w, h };
}

/** coverFit(srcW, srcH, dstW, dstH) -> source crop {sx, sy, sw, sh} that fills the destination (aspect kept). */
export function coverFit(srcW, srcH, dstW, dstH) {
  if (!(srcW > 0) || !(srcH > 0) || !(dstW > 0) || !(dstH > 0)) return null;
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / scale;
  const sh = dstH / scale;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** outputSize(vw, vh) -> canvas size: the video size capped at 1280×720 with the aspect ratio kept. */
export function outputSize(vw, vh) {
  if (!(vw > 0) || !(vh > 0)) return { w: OUTPUT_MAX_W, h: OUTPUT_MAX_H };
  const k = Math.min(1, OUTPUT_MAX_W / vw, OUTPUT_MAX_H / vh);
  return { w: Math.max(1, Math.round(vw * k)), h: Math.max(1, Math.round(vh * k)) };
}

/**
 * createFrameBudget() -> {record(ms), avg, workWidth}. EMA of draw time; the chroma work width drops
 * 640 -> 320 after the average stays above 45 ms for 60 frames and recovers to 640 after it stays
 * below 20 ms for 120 frames.
 */
export function createFrameBudget(opts = {}) {
  const alpha = typeof opts.alpha === 'number' ? opts.alpha : 0.1;
  let avg = null;
  let width = 640;
  let slow = 0;
  let fast = 0;
  return {
    record(ms) {
      const v = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : 0;
      avg = avg === null ? v : avg + alpha * (v - avg);
      if (avg > 45) { slow++; fast = 0; } else if (avg < 20) { fast++; slow = 0; } else { slow = 0; fast = 0; }
      if (width === 640 && slow >= 60) { width = 320; slow = 0; fast = 0; }
      else if (width === 320 && fast >= 120) { width = 640; slow = 0; fast = 0; }
      return width;
    },
    get avg() { return avg === null ? 0 : avg; },
    get workWidth() { return width; },
  };
}

/** mapMediaError(e) -> {state: blocked|in-use|not-found|error, name} (design §14.1 table). */
export function mapMediaError(e) {
  const name = e && typeof e.name === 'string' && e.name ? e.name.slice(0, 40) : 'Error';
  let state = 'error';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') state = 'blocked';
  else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') state = 'in-use';
  else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') state = 'not-found';
  return { state, name };
}

/** stateMessage({state, name}) -> the user-facing sentence for a media state. */
export function stateMessage(r) {
  const st = r && r.state;
  if (st === 'error') return `${STATE_MESSAGES.error} (${String((r && r.name) || 'Error').replace(/[^A-Za-z0-9_-]/g, '')})`;
  return STATE_MESSAGES[st] || STATE_MESSAGES.error;
}

const IR_RE = /\bIR\b/i;
const OBS_RE = /OBS Virtual Camera/i;

export const isIrLabel = (label) => IR_RE.test(String(label || ''));
export const isObsLabel = (label) => OBS_RE.test(String(label || ''));

const _videos = (devices) => (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === 'videoinput');

/**
 * pickDefaultCamera(devices) -> deviceId of the first videoinput whose label matches neither the IR
 * rule nor OBS Virtual Camera; falls back to the first non-OBS camera; null when there is none.
 * OBS Virtual Camera is never the default.
 */
export function pickDefaultCamera(devices) {
  const cams = _videos(devices);
  const good = cams.find((d) => !isIrLabel(d.label) && !isObsLabel(d.label));
  if (good) return good.deviceId;
  const notObs = cams.find((d) => !isObsLabel(d.label));
  return notObs ? notObs.deviceId : null;
}

/** deviceLabel(d, i) -> 'Camera n' / 'Microphone n' when the label is empty; '(IR)' / '(OBS)' suffixes. */
export function deviceLabel(d, i) {
  const raw = String((d && d.label) || '').trim();
  const n = (typeof i === 'number' ? i : 0) + 1;
  if (!raw) return (d && d.kind === 'audioinput' ? 'Microphone ' : 'Camera ') + n;
  if (d && d.kind === 'videoinput') {
    if (isObsLabel(raw)) return raw + ' (OBS)';
    if (isIrLabel(raw)) return raw + ' (IR)';
  }
  return raw;
}

/** obsState(devices) -> 'unknown' (every camera label empty) | 'found' | 'absent'. */
export function obsState(devices) {
  const cams = _videos(devices);
  if (!cams.some((d) => String(d.label || '').trim() !== '')) return 'unknown';
  return cams.some((d) => isObsLabel(d.label)) ? 'found' : 'absent';
}

/** obsNote(state) -> the note text for an OBS state ('' for absent: the banner already explains it). */
export function obsNote(state) {
  if (state === 'found') return OBS_NOTE_FOUND;
  if (state === 'unknown') return OBS_NOTE_UNKNOWN;
  return '';
}

/** supportsNativeBlur(caps) -> true when track.getCapabilities().backgroundBlur includes true. */
export function supportsNativeBlur(caps) {
  const b = caps && caps.backgroundBlur;
  return Array.isArray(b) ? b.includes(true) : b === true;
}

/** defaultEffect() / normalizeEffect(e) -> the effect state the pipeline uses (preset §15.1 shape). */
export function defaultEffect() {
  return {
    mode: 'none',
    edgeBlur: { radiusPx: RANGES.radiusPx.def, focus: RANGES.focus.def },
    chromaKey: { color: 'green', tolerance: RANGES.tolerance.def, backgroundId: null },
    imageId: null,
  };
}

const _libId = (v) => (typeof v === 'string' && /^l_[0-9a-f]{12}$/.test(v) ? v : null);

export function normalizeEffect(e) {
  const d = defaultEffect();
  const o = e && typeof e === 'object' ? e : {};
  const eb = o.edgeBlur && typeof o.edgeBlur === 'object' ? o.edgeBlur : {};
  const ck = o.chromaKey && typeof o.chromaKey === 'object' ? o.chromaKey : {};
  return {
    mode: EFFECT_MODES.includes(o.mode) ? o.mode : d.mode,
    edgeBlur: { radiusPx: clampRange('radiusPx', eb.radiusPx), focus: clampRange('focus', eb.focus) },
    chromaKey: { color: ck.color === 'blue' ? 'blue' : 'green', tolerance: clampRange('tolerance', ck.tolerance), backgroundId: _libId(ck.backgroundId) },
    imageId: _libId(o.imageId),
  };
}

/** normalizeOverlays(list) -> at most MAX_OVERLAYS {imageId, x, y, scale, opacity} with a valid library id. */
export function normalizeOverlays(list) {
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_OVERLAYS) break;
    const id = _libId(o && o.imageId);
    if (!id) continue;
    out.push({ imageId: id, x: clampRange('x', o.x), y: clampRange('y', o.y), scale: clampRange('scale', o.scale), opacity: clampRange('opacity', o.opacity) });
  }
  return out;
}

/** imageIdsOf(effect, overlays) -> library ids the pipeline needs decoded for this state. */
export function imageIdsOf(effect, overlays) {
  const ids = new Set();
  const e = effect || {};
  if (e.mode === 'image' && e.imageId) ids.add(e.imageId);
  if (e.mode === 'chromaKey' && e.chromaKey && e.chromaKey.backgroundId) ids.add(e.chromaKey.backgroundId);
  for (const o of Array.isArray(overlays) ? overlays : []) if (o && o.imageId) ids.add(o.imageId);
  return [...ids];
}
