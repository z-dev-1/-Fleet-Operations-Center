'use strict';
/**
 * src/zoom/studio/presets.js — Studio presets (design §15.2, FEAT-B2).
 *
 *   list()                 -> {ok, presets, lastPresetId}
 *   save({preset})         -> {ok, preset}  (no id = create; main generates 'p_' + 12 hex)
 *   rename({id, name})     -> {ok, preset}
 *   remove({id})           -> {ok}          (clears lastPresetId when it was selected)
 *   select({id|null})      -> {ok}          (stored in zoomStudioConfig.lastPresetId)
 *   countImageRefs(id) / clearImageRefs(id)  used by library.remove
 *
 * Every write goes through store.update. Deep validation is preset-schema.js (no clamping).
 * Errors: LIMIT_REACHED (51st), DUPLICATE_NAME (case-insensitive), NOT_FOUND, UNKNOWN_IMAGE, IO_ERROR.
 * Logs {op, count} only: preset names are never logged.
 */
const crypto = require('crypto');
const { ZoomError, fail } = require('../errors');
const { safeErr } = require('../redact');
const schema = require('./preset-schema');
const log = require('../../utils/logger')('zoom:studio');

const MAX_PRESETS = 50;

function _store() { return require('../../store'); }

const DEFAULT_DOC = () => ({ version: 1, presets: [] });
const DEFAULT_CONFIG = () => ({ version: 1, launcherPath: null, launcherConfirmed: {}, lastPresetId: null });

function _normDoc(cur) {
  const d = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  return { version: 1, presets: Array.isArray(d.presets) ? d.presets.filter((p) => p && typeof p === 'object' && typeof p.id === 'string') : [] };
}

function _normConfig(cur) {
  const d = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  return Object.assign(DEFAULT_CONFIG(), d, {
    version: 1,
    launcherConfirmed: d.launcherConfirmed && typeof d.launcherConfirmed === 'object' && !Array.isArray(d.launcherConfirmed) ? d.launcherConfirmed : {},
    lastPresetId: typeof d.lastPresetId === 'string' ? d.lastPresetId : null,
  });
}

function _newId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

function _log(op, count) {
  try { log.info('[zoom-studio] presets', { op, count }); } catch (_) {}
}

/** _write(name, fn, def) -> store.update; ZoomErrors thrown by fn pass through, fs errors -> IO_ERROR. */
function _write(name, fn, def) {
  try {
    return _store().update(name, fn, def);
  } catch (e) {
    if (e instanceof ZoomError) throw e;
    try { log.warn('[zoom-studio] presets store', safeErr(e)); } catch (_) {}
    throw new ZoomError('IO_ERROR');
  }
}

function _libraryIds() {
  const lib = _store().load('zoomStudioLibrary', { version: 1, items: [] });
  const items = lib && Array.isArray(lib.items) ? lib.items : [];
  return new Set(items.filter((i) => i && typeof i.id === 'string').map((i) => i.id));
}

const _lc = (s) => String(s).toLowerCase();

async function list() {
  const doc = _normDoc(_store().load('zoomStudioPresets', DEFAULT_DOC()));
  const cfg = _normConfig(_store().load('zoomStudioConfig', DEFAULT_CONFIG()));
  const last = cfg.lastPresetId && doc.presets.some((p) => p.id === cfg.lastPresetId) ? cfg.lastPresetId : null;
  return { ok: true, presets: doc.presets, lastPresetId: last };
}

/** save({preset}) — create (no id) or update (id must exist). */
async function save(input) {
  const raw = input && input.preset;
  const body = schema.normalize(raw);
  const id = raw && raw.id !== undefined && raw.id !== null ? schema.presetId(raw.id) : null;
  const known = _libraryIds();
  for (const ref of schema.imageIds(body)) if (!known.has(ref)) throw new ZoomError('UNKNOWN_IMAGE');
  let out = null;
  let count = 0;
  _write('zoomStudioPresets', (cur) => {
    const d = _normDoc(cur);
    const nm = _lc(body.name);
    if (d.presets.some((p) => p.id !== id && typeof p.name === 'string' && _lc(p.name) === nm)) throw new ZoomError('DUPLICATE_NAME');
    const now = new Date().toISOString();
    if (id) {
      const i = d.presets.findIndex((p) => p.id === id);
      if (i < 0) throw new ZoomError('NOT_FOUND');
      out = Object.assign({ id }, body, { createdAt: d.presets[i].createdAt || now, updatedAt: now });
      d.presets[i] = out;
    } else {
      if (d.presets.length >= MAX_PRESETS) throw new ZoomError('LIMIT_REACHED');
      let nid = _newId();
      while (d.presets.some((p) => p.id === nid)) nid = _newId();
      out = Object.assign({ id: nid }, body, { createdAt: now, updatedAt: now });
      d.presets.push(out);
    }
    count = d.presets.length;
    return d;
  }, DEFAULT_DOC());
  _log(id ? 'update' : 'create', count);
  return { ok: true, preset: out };
}

async function rename(input) {
  const id = input.id;
  const nm = schema.name(input.name);
  let out = null;
  let count = 0;
  _write('zoomStudioPresets', (cur) => {
    const d = _normDoc(cur);
    const i = d.presets.findIndex((p) => p.id === id);
    if (i < 0) throw new ZoomError('NOT_FOUND');
    if (d.presets.some((p) => p.id !== id && typeof p.name === 'string' && _lc(p.name) === _lc(nm))) throw new ZoomError('DUPLICATE_NAME');
    out = Object.assign({}, d.presets[i], { name: nm, updatedAt: new Date().toISOString() });
    d.presets[i] = out;
    count = d.presets.length;
    return d;
  }, DEFAULT_DOC());
  _log('rename', count);
  return { ok: true, preset: out };
}

async function remove(input) {
  const id = input.id;
  let count = 0;
  _write('zoomStudioPresets', (cur) => {
    const d = _normDoc(cur);
    const i = d.presets.findIndex((p) => p.id === id);
    if (i < 0) throw new ZoomError('NOT_FOUND');
    d.presets.splice(i, 1);
    count = d.presets.length;
    return d;
  }, DEFAULT_DOC());
  _write('zoomStudioConfig', (cur) => {
    const c = _normConfig(cur);
    if (c.lastPresetId === id) c.lastPresetId = null;
    return c;
  }, DEFAULT_CONFIG());
  _log('delete', count);
  return { ok: true };
}

async function select(input) {
  const id = input.id === null || input.id === undefined ? null : input.id;
  if (id !== null) {
    const doc = _normDoc(_store().load('zoomStudioPresets', DEFAULT_DOC()));
    if (!doc.presets.some((p) => p.id === id)) return fail('NOT_FOUND');
  }
  _write('zoomStudioConfig', (cur) => Object.assign(_normConfig(cur), { lastPresetId: id }), DEFAULT_CONFIG());
  _log('select', id ? 1 : 0);
  return { ok: true };
}

function _refs(p, id) {
  const e = p && p.effect;
  let n = 0;
  if (e && e.chromaKey && e.chromaKey.backgroundId === id) n++;
  if (e && e.imageId === id) n++;
  for (const o of (p && Array.isArray(p.overlays) ? p.overlays : [])) if (o && o.imageId === id) n++;
  return n;
}

/** countImageRefs(id) -> number of presets that reference library id. */
function countImageRefs(id) {
  const doc = _normDoc(_store().load('zoomStudioPresets', DEFAULT_DOC()));
  return doc.presets.filter((p) => _refs(p, id) > 0).length;
}

/** clearImageRefs(id) -> presets changed (imageId / backgroundId -> null, overlays with id removed). */
function clearImageRefs(id) {
  let changed = 0;
  _write('zoomStudioPresets', (cur) => {
    const d = _normDoc(cur);
    d.presets = d.presets.map((p) => {
      if (_refs(p, id) === 0) return p;
      changed++;
      const e = p.effect && typeof p.effect === 'object' ? p.effect : {};
      const ck = e.chromaKey && typeof e.chromaKey === 'object' ? e.chromaKey : {};
      return Object.assign({}, p, {
        effect: Object.assign({}, e, {
          chromaKey: Object.assign({}, ck, { backgroundId: ck.backgroundId === id ? null : (ck.backgroundId === undefined ? null : ck.backgroundId) }),
          imageId: e.imageId === id ? null : (e.imageId === undefined ? null : e.imageId),
        }),
        overlays: (Array.isArray(p.overlays) ? p.overlays : []).filter((o) => !(o && o.imageId === id)),
        updatedAt: new Date().toISOString(),
      });
    });
    return d;
  }, DEFAULT_DOC());
  return changed;
}

module.exports = {
  list, save, rename, remove, select, countImageRefs, clearImageRefs,
  MAX_PRESETS, DEFAULT_CONFIG, _normConfig,
};
