'use strict';
/**
 * src/zoom/studio/preset-schema.js — the Studio preset shape (design §15.1, FEAT-B2). Pure.
 *
 * Single source of truth: main validates every save here; the renderer only mirrors RANGES in its
 * slider min/max attributes (renderer/src/js/zoom/studio-logic.js RANGES).
 *
 *   normalize(input) -> a clean Preset body {name, camera, mic, effect, adjust, overlays, version:1}
 *     - unknown keys are stripped at every level;
 *     - missing optional sub-objects / fields get their defaults;
 *     - a wrong type or out-of-range value throws ZoomError('INVALID_INPUT', {field:'<dotted.path>'}).
 *       Values are NEVER clamped, so a stored value is never silently changed;
 *     - mode 'chromaKey' needs effect.chromaKey.backgroundId, mode 'image' needs effect.imageId.
 *   imageIds(preset) -> every library id the preset references (for the UNKNOWN_IMAGE check).
 *
 * id / createdAt / updatedAt are owned by presets.js (main-generated) and are not part of the body.
 */
const { ZoomError } = require('../errors');

const RANGES = Object.freeze({
  radiusPx: Object.freeze({ min: 0, max: 40, int: true, def: 12 }),
  focus: Object.freeze({ min: 0.3, max: 0.9, int: false, def: 0.6 }),
  tolerance: Object.freeze({ min: 0, max: 100, int: true, def: 50 }),
  brightness: Object.freeze({ min: 50, max: 150, int: true, def: 100 }),
  contrast: Object.freeze({ min: 50, max: 150, int: true, def: 100 }),
  saturation: Object.freeze({ min: 0, max: 200, int: true, def: 100 }),
  x: Object.freeze({ min: 0, max: 1, int: false, def: 0.5 }),
  y: Object.freeze({ min: 0, max: 1, int: false, def: 0.5 }),
  scale: Object.freeze({ min: 0.05, max: 2, int: false, def: 0.3 }),
  opacity: Object.freeze({ min: 0, max: 1, int: false, def: 1 }),
});

const MODES = Object.freeze(['none', 'edgeBlur', 'nativeBlur', 'chromaKey', 'image']);
const COLORS = Object.freeze(['green', 'blue']);
const MAX_OVERLAYS = 3;
const NAME_MAX = 60;
const DEVICE_ID_MAX = 256;
const DEVICE_LABEL_MAX = 120;
const VERSION = 1;

const CTRL_RE = /[\u0000-\u001f\u007f]/;
const LIB_ID_RE = /^l_[0-9a-f]{12}$/;
const PRESET_ID_RE = /^p_[0-9a-f]{12}$/;

function bad(field) { return new ZoomError('INVALID_INPUT', { field }); }

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** _obj(v, field) -> v when a plain object, {} when undefined/null (defaults apply), else INVALID_INPUT. */
function _obj(v, field) {
  if (v === undefined || v === null) return {};
  if (!isPlain(v)) throw bad(field);
  return v;
}

function name(v, field = 'name') {
  if (typeof v !== 'string') throw bad(field);
  const t = v.trim();
  if (t.length < 1 || t.length > NAME_MAX || CTRL_RE.test(t)) throw bad(field);
  return t;
}

function _num(v, key, field) {
  const r = RANGES[key];
  if (v === undefined) return r.def;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(field);
  if (r.int && !Number.isInteger(v)) throw bad(field);
  if (v < r.min || v > r.max) throw bad(field);
  return v;
}

function _str(v, max, field) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max || CTRL_RE.test(v)) throw bad(field);
  return v;
}

function _libId(v, field, required) {
  if (v === undefined || v === null) {
    if (required) throw bad(field);
    return null;
  }
  if (typeof v !== 'string' || !LIB_ID_RE.test(v)) throw bad(field);
  return v;
}

function _bool(v, field) {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw bad(field);
  return v;
}

function _device(v, field) {
  const o = _obj(v, field);
  return { id: _str(o.id, DEVICE_ID_MAX, field + '.id'), label: _str(o.label, DEVICE_LABEL_MAX, field + '.label') };
}

function _effect(v) {
  const o = _obj(v, 'effect');
  let mode = 'none';
  if (o.mode !== undefined) {
    if (!MODES.includes(o.mode)) throw bad('effect.mode');
    mode = o.mode;
  }
  const eb = _obj(o.edgeBlur, 'effect.edgeBlur');
  const ck = _obj(o.chromaKey, 'effect.chromaKey');
  let color = 'green';
  if (ck.color !== undefined) {
    if (!COLORS.includes(ck.color)) throw bad('effect.chromaKey.color');
    color = ck.color;
  }
  return {
    mode,
    edgeBlur: {
      radiusPx: _num(eb.radiusPx, 'radiusPx', 'effect.edgeBlur.radiusPx'),
      focus: _num(eb.focus, 'focus', 'effect.edgeBlur.focus'),
    },
    chromaKey: {
      color,
      tolerance: _num(ck.tolerance, 'tolerance', 'effect.chromaKey.tolerance'),
      backgroundId: _libId(ck.backgroundId, 'effect.chromaKey.backgroundId', mode === 'chromaKey'),
    },
    imageId: _libId(o.imageId, 'effect.imageId', mode === 'image'),
  };
}

function _adjust(v) {
  const o = _obj(v, 'adjust');
  return {
    brightness: _num(o.brightness, 'brightness', 'adjust.brightness'),
    contrast: _num(o.contrast, 'contrast', 'adjust.contrast'),
    saturation: _num(o.saturation, 'saturation', 'adjust.saturation'),
    mirror: _bool(o.mirror, 'adjust.mirror'),
  };
}

function _overlays(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_OVERLAYS) throw bad('overlays');
  return v.map((raw, i) => {
    const f = 'overlays.' + i;
    if (!isPlain(raw)) throw bad(f);
    return {
      imageId: _libId(raw.imageId, f + '.imageId', true),
      x: _num(raw.x, 'x', f + '.x'),
      y: _num(raw.y, 'y', f + '.y'),
      scale: _num(raw.scale, 'scale', f + '.scale'),
      opacity: _num(raw.opacity, 'opacity', f + '.opacity'),
    };
  });
}

/** normalize(input) -> clean preset body; throws ZoomError('INVALID_INPUT', {field}) (dotted path). */
function normalize(input) {
  if (!isPlain(input)) throw bad('preset');
  return {
    name: name(input.name),
    camera: _device(input.camera, 'camera'),
    mic: _device(input.mic, 'mic'),
    effect: _effect(input.effect),
    adjust: _adjust(input.adjust),
    overlays: _overlays(input.overlays),
    version: VERSION,
  };
}

/** presetId(v) -> v when a valid 'p_' + 12 hex id, else INVALID_INPUT field 'id'. */
function presetId(v) {
  if (typeof v !== 'string' || !PRESET_ID_RE.test(v)) throw bad('id');
  return v;
}

/** imageIds(preset) -> unique library ids referenced (background, image, overlays). */
function imageIds(p) {
  const out = new Set();
  const e = p && p.effect;
  if (e && e.chromaKey && typeof e.chromaKey.backgroundId === 'string') out.add(e.chromaKey.backgroundId);
  if (e && typeof e.imageId === 'string') out.add(e.imageId);
  for (const o of (p && Array.isArray(p.overlays) ? p.overlays : [])) if (o && typeof o.imageId === 'string') out.add(o.imageId);
  return [...out];
}

module.exports = {
  RANGES, MODES, COLORS, MAX_OVERLAYS, NAME_MAX, DEVICE_ID_MAX, DEVICE_LABEL_MAX, VERSION,
  LIB_ID_RE, PRESET_ID_RE,
  normalize, presetId, imageIds, name, isPlain,
};
