'use strict';
/**
 * src/zoom/validate.js — pure IPC input validators for every Zoom hub channel.
 *
 * Every validator throws ZoomError('INVALID_INPUT', {field}) (never ConfigError, never a message with
 * the input). Payload rules:
 *   - channels with no input accept undefined or {} only;
 *   - channels with input require a plain object; unknown extra props give field:'payload'
 *     (so a renderer can never smuggle a url / path / body field into any channel);
 *   - channels whose fields are all optional also accept undefined.
 */
const { ZoomError } = require('./errors');

function bad(field) { return new ZoomError('INVALID_INPUT', { field }); }

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// ── Primitives ─────────────────────────────────────────────────────────────
const KEY_RE = /^[A-Za-z0-9_-]+$/;
function key(v, field = 'key') {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128 || !KEY_RE.test(v)) throw bad(field);
  return v;
}

const STUDIO_ID_RE = /^[pl]_[0-9a-f]{12}$/;
/** id(v, prefix) — zoomStudio preset ('p') / library ('l') ids ONLY. */
function id(v, prefix, field = 'id') {
  if (typeof v !== 'string' || !STUDIO_ID_RE.test(v) || v[0] !== prefix) throw bad(field);
  return v;
}

const CTRL_RE = /[\u0000-\u001f\u007f]/;
function name(v, field = 'name') {
  if (typeof v !== 'string') throw bad(field);
  const t = v.trim();
  if (t.length < 1 || t.length > 60 || CTRL_RE.test(t)) throw bad(field);
  return t;
}

function oneOf(v, list, field) {
  for (const x of list) if (v === x) return v;
  throw bad(field);
}

function bool(v, field) {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw bad(field);
  return v;
}

function q(v, field = 'q') {
  if (v === undefined) return '';
  if (typeof v !== 'string' || v.length > 40) throw bad(field);
  return v;
}

const UNIT_ID_RE = /^[A-Za-z0-9-]{3,20}$/;
const CARRIER_ID_RE = /^[A-Z0-9]{2,8}$/;
/** targetId(v, kind) — link targets: unit = /^[A-Za-z0-9-]{3,20}$/; carrier = trimmed upper /^[A-Z0-9]{2,8}$/. */
function targetId(v, kind, field = 'id') {
  if (kind === 'unit') {
    if (typeof v !== 'string' || !UNIT_ID_RE.test(v)) throw bad(field);
    return v;
  }
  if (kind === 'carrier') {
    if (typeof v !== 'string' && typeof v !== 'number') throw bad(field);
    const s = String(v).trim().toUpperCase();
    if (!CARRIER_ID_RE.test(s)) throw bad(field);
    return s;
  }
  throw bad('kind');
}

// ── Payload helpers ────────────────────────────────────────────────────────
function none(p) {
  if (p === undefined) return {};
  if (!isPlain(p) || Object.keys(p).length !== 0) throw bad('payload');
  return {};
}

/** obj(p, allowed, {optional}) — plain object with only `allowed` keys. */
function obj(p, allowed, opts) {
  if (p === undefined && opts && opts.optional) return {};
  if (!isPlain(p)) throw bad('payload');
  for (const k of Object.keys(p)) if (!allowed.includes(k)) throw bad('payload');
  return p;
}

const MEETING_KINDS = ['upcoming', 'previous'];
const LINK_KINDS = ['unit', 'carrier'];
const WRITE_ACTIONS = ['schedule', 'delete-recording'];
const PRIVACY_WHICH = ['camera', 'microphone'];
const LIBRARY_KINDS = ['background', 'overlay', 'avatar'];

// ── One validator per channel ──────────────────────────────────────────────
const V = {
  'zoomHub:flags': none,

  'zoomData:status': (p) => { const o = obj(p, ['force'], { optional: true }); return { force: bool(o.force, 'force') }; },
  'zoomData:connect': none,
  'zoomData:list-meetings': (p) => {
    const o = obj(p, ['kind', 'refresh']);
    return { kind: oneOf(o.kind, MEETING_KINDS, 'kind'), refresh: bool(o.refresh, 'refresh') };
  },
  'zoomData:get-meeting': (p) => { const o = obj(p, ['key']); return { key: key(o.key) }; },
  'zoomData:join': (p) => { const o = obj(p, ['key']); return { key: key(o.key) }; },
  'zoomData:list-recordings': (p) => { const o = obj(p, ['refresh'], { optional: true }); return { refresh: bool(o.refresh, 'refresh') }; },
  'zoomData:recording-info': none,
  'zoomData:get-transcript': (p) => { const o = obj(p, ['key']); return { key: key(o.key) }; },
  'zoomData:import-transcript': (p) => { const o = obj(p, ['key']); return { key: key(o.key) }; },
  'zoomData:summarize': (p) => { const o = obj(p, ['key', 'force']); return { key: key(o.key), force: bool(o.force, 'force') }; },
  'zoomData:ai-consent': none,
  'zoomData:get-summary': (p) => { const o = obj(p, ['key']); return { key: key(o.key) }; },
  'zoomData:link-targets': (p) => {
    const o = obj(p, ['kind', 'q']);
    return { kind: oneOf(o.kind, LINK_KINDS, 'kind'), q: q(o.q) };
  },
  'zoomData:link': (p) => linkInput(p),
  'zoomData:unlink': (p) => linkInput(p),
  'zoomData:links': none,
  'zoomData:write-open': (p) => {
    const o = obj(p, ['action', 'key']);
    const action = oneOf(o.action, WRITE_ACTIONS, 'action');
    return o.key === undefined ? { action } : { action, key: key(o.key) };
  },

  'zoomStudio:media-status': none,
  'zoomStudio:open-privacy': (p) => { const o = obj(p, ['which']); return { which: oneOf(o.which, PRIVACY_WHICH, 'which') }; },
  'zoomStudio:presets-list': none,
  'zoomStudio:preset-save': (p) => {
    const o = obj(p, ['preset']);
    if (!isPlain(o.preset)) throw bad('preset');
    // Deep validation is preset-schema.js (B2), the single source of truth.
    return { preset: o.preset };
  },
  'zoomStudio:preset-rename': (p) => { const o = obj(p, ['id', 'name']); return { id: id(o.id, 'p'), name: name(o.name) }; },
  'zoomStudio:preset-delete': (p) => { const o = obj(p, ['id']); return { id: id(o.id, 'p') }; },
  'zoomStudio:preset-select': (p) => {
    const o = obj(p, ['id']);
    if (o.id === null) return { id: null };
    return { id: id(o.id, 'p') };
  },
  'zoomStudio:library-list': none,
  'zoomStudio:library-import': (p) => { const o = obj(p, ['kind']); return { kind: oneOf(o.kind, LIBRARY_KINDS, 'kind') }; },
  'zoomStudio:library-read': (p) => { const o = obj(p, ['id']); return { id: id(o.id, 'l') }; },
  'zoomStudio:library-rename': (p) => { const o = obj(p, ['id', 'name']); return { id: id(o.id, 'l'), name: name(o.name) }; },
  'zoomStudio:library-delete': (p) => { const o = obj(p, ['id', 'force']); return { id: id(o.id, 'l'), force: bool(o.force, 'force') }; },
  'zoomStudio:launcher-get': none,
  'zoomStudio:launcher-pick': none,
  'zoomStudio:launcher-run': none,

  // OBS (zoom.studio.obs)
  'zoomStudio:obs-status': none,
  'zoomStudio:obs-config-set': (p) => {
    // F6: require obs-auth lazily, inside this validator body only (no top-level import), so requiring
    // validate.js (eager whenever studio is on) never loads an OBS module.
    const { exeSyntaxOk } = require('./studio/obs-auth');
    return obsConfigInput(p, exeSyntaxOk);
  },
  'zoomStudio:obs-connect': none,
  'zoomStudio:obs-disconnect': none,
  'zoomStudio:obs-start': none,
  'zoomStudio:obs-stop': none,
  'zoomStudio:obs-launch': none,
};

const OBS_HOSTS = ['127.0.0.1', 'localhost'];
const OBS_PASSWORD_MAX = 256;

/** obs-config-set: {host?, port?, exePath?, password?}; only the keys present are returned. */
function obsConfigInput(p, exeSyntaxOk) {
  const o = obj(p, ['host', 'port', 'exePath', 'password'], { optional: true });
  const out = {};
  if (o.host !== undefined) out.host = oneOf(o.host, OBS_HOSTS, 'host');
  if (o.port !== undefined) {
    if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw bad('port');
    out.port = o.port;
  }
  if (o.exePath !== undefined) {
    if (o.exePath !== null && !exeSyntaxOk(o.exePath)) throw bad('exePath');
    out.exePath = o.exePath;
  }
  if (o.password !== undefined) {
    if (o.password !== null &&
      (typeof o.password !== 'string' || o.password.length > OBS_PASSWORD_MAX || o.password.includes('\0'))) {
      throw bad('password');
    }
    out.password = o.password;
  }
  return out;
}

function linkInput(p) {
  const o = obj(p, ['key', 'kind', 'id']);
  const k = key(o.key);
  const kind = oneOf(o.kind, LINK_KINDS, 'kind');
  return { key: k, kind, id: targetId(o.id, kind) };
}

module.exports = {
  key, id, name, oneOf, bool, q, targetId, none, obj, isPlain,
  validators: V,
  MEETING_KINDS, LINK_KINDS, WRITE_ACTIONS, PRIVACY_WHICH, LIBRARY_KINDS,
};
