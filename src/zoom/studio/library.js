'use strict';
/**
 * src/zoom/studio/library.js — the Studio image library (design §15.3, FEAT-B2).
 *
 *   importImages({kind})   main-process multi-select dialog (PNG/JPEG/WebP). The first 10 files in dialog
 *                          order are processed, the rest -> LIMIT_REACHED; library total capped at 100.
 *                          Per file: lstat (regular file, not a symlink, <= 8 MB), magic bytes must agree
 *                          with the extension, PNG/JPEG via nativeImage (not empty, <= 4096x4096), WebP via
 *                          webpSize only (NEVER nativeImage), copy to <dataDir>/zoom-studio/library/l_<12hex>.<ext>,
 *                          PNG/JPEG thumbnail <id>.thumb.png (160 px wide), WebP thumb:null.
 *                          -> {ok, items:[added], rejected:[{name: basename, code}]}
 *   list()                 -> {ok, items} (thumb as a data: URL or null)
 *   read({id})             -> {ok, dataUrl, w, h}
 *   rename({id, name})     -> {ok, item}
 *   remove({id, force})    -> {ok} | IN_USE {usedBy} (force deletes both files + the entry and clears refs)
 *
 * Source files are only read (lstat, a 64-byte read, nativeImage, copyFile source), never modified.
 * Every fs call is inside a try mapped by e.code (ENOENT -> NOT_FOUND, EACCES/EPERM/EBUSY -> IO_ERROR).
 * Paths and basenames are never logged: logs carry {op, counts, code} only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ZoomError, fail } = require('../errors');
const { safeErr } = require('../redact');
const sniffer = require('./image-sniff');
const log = require('../../utils/logger')('zoom:studio');

const MAX_PER_IMPORT = 10;
const MAX_ITEMS = 100;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIM = 4096;
const THUMB_W = 160;
const KINDS = Object.freeze(['background', 'overlay', 'avatar']);
const EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);

// Test seam: { electron }. Production requires electron lazily.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }
function _store() { return require('../../store'); }

const DEFAULT_DOC = () => ({ version: 1, items: [] });

function libraryDir() {
  return path.join(require('../../config/paths').P.dataDir, 'zoom-studio', 'library');
}

function _normDoc(cur) {
  const d = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  return { version: 1, items: Array.isArray(d.items) ? d.items.filter((i) => i && typeof i.id === 'string') : [] };
}

function _fsCode(e) {
  const c = e && e.code;
  if (c === 'ENOENT' || c === 'ENOTDIR') return 'NOT_FOUND';
  return 'IO_ERROR';
}

function _warn(op, e) {
  try { log.warn('[zoom-studio] library', { op, err: safeErr(e) }); } catch (_) {}
}

function _info(fields) {
  try { log.info('[zoom-studio] library', fields); } catch (_) {}
}

function _newId() { return 'l_' + crypto.randomBytes(6).toString('hex'); }

function _parent(env) {
  try {
    const w = env && env.ctx && env.ctx.mainWindow;
    return w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) ? w : null;
  } catch (_) {
    return null;
  }
}

function _cleanName(base) {
  const n = String(base || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60).trim();
  return n || 'Image';
}

function _rmQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

/** _head(file) -> first 64 bytes (read-only open). */
function _head(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    return buf.subarray(0, n);
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

/** _checkFile(file) -> {type, ext, bytes, w, h, img|null}; throws ZoomError with the per-file code. */
function _checkFile(file) {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '');
  if (!EXTS.includes(ext)) throw new ZoomError('INVALID_FILE');
  let st;
  try { st = fs.lstatSync(file); } catch (e) { throw new ZoomError(_fsCode(e)); }
  if (st.isSymbolicLink() || !st.isFile()) throw new ZoomError('INVALID_FILE');
  if (!(st.size > 0) || st.size > MAX_BYTES) throw new ZoomError('INVALID_FILE');
  let head;
  try { head = _head(file); } catch (e) { throw new ZoomError(_fsCode(e)); }
  const type = sniffer.sniff(head);
  if (!type || type !== sniffer.typeForExt(ext)) throw new ZoomError('INVALID_FILE');
  if (type === 'webp') {
    const sz = sniffer.webpSize(head);
    if (!sz || sz.w > MAX_DIM || sz.h > MAX_DIM) throw new ZoomError('INVALID_FILE');
    return { type, ext, bytes: st.size, w: sz.w, h: sz.h, img: null };
  }
  let img = null;
  try { img = _electron().nativeImage.createFromPath(file); } catch (e) { _warn('decode', e); img = null; }
  if (!img || typeof img.isEmpty !== 'function' || img.isEmpty()) throw new ZoomError('INVALID_FILE');
  let size = null;
  try { size = img.getSize(); } catch (_) { size = null; }
  const w = size && size.width;
  const h = size && size.height;
  if (!(w > 0) || !(h > 0) || w > MAX_DIM || h > MAX_DIM) throw new ZoomError('INVALID_FILE');
  return { type, ext, bytes: st.size, w, h, img };
}

/** _store1(file, info, kind) -> index item; copies the file (+ thumbnail). Partial failure cleans up -> IO_ERROR. */
function _storeFile(file, info, kind) {
  const dir = libraryDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { _warn('mkdir', e); throw new ZoomError('IO_ERROR'); }
  const id = _newId();
  const fileName = id + '.' + info.ext;
  const dest = path.join(dir, fileName);
  try {
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    _warn('copy', e);
    _rmQuiet(dest);
    throw new ZoomError(_fsCode(e));
  }
  let thumb = null;
  if (info.img) {
    const thumbName = id + '.thumb.png';
    try {
      const png = info.img.resize({ width: THUMB_W, quality: 'good' }).toPNG();
      if (!png || !png.length) throw new Error('empty thumbnail');
      fs.writeFileSync(path.join(dir, thumbName), png);
      thumb = thumbName;
    } catch (e) {
      _warn('thumb', e);
      _rmQuiet(path.join(dir, thumbName));
      _rmQuiet(dest);
      throw new ZoomError('IO_ERROR');
    }
  }
  return {
    id,
    name: _cleanName(path.basename(file, path.extname(file))),
    kind,
    file: fileName,
    thumb,
    w: info.w,
    h: info.h,
    bytes: info.bytes,
    addedAt: new Date().toISOString(),
  };
}

function _thumbUrl(item) {
  if (!item || typeof item.thumb !== 'string' || !/^l_[0-9a-f]{12}\.thumb\.png$/.test(item.thumb)) return null;
  try {
    const b = fs.readFileSync(path.join(libraryDir(), item.thumb));
    return 'data:image/png;base64,' + b.toString('base64');
  } catch (e) {
    _warn('thumb-read', e);
    return null;
  }
}

function _format(item) {
  return sniffer.typeForExt(path.extname(String(item && item.file || '')));
}

function _public(item, withThumb) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    format: _format(item),
    thumb: withThumb ? _thumbUrl(item) : null,
    w: item.w,
    h: item.h,
    bytes: item.bytes,
    addedAt: item.addedAt,
  };
}

function _write(fn) {
  try {
    return _store().update('zoomStudioLibrary', fn, DEFAULT_DOC());
  } catch (e) {
    if (e instanceof ZoomError) throw e;
    _warn('store', e);
    throw new ZoomError('IO_ERROR');
  }
}

async function importImages(input, env) {
  const kind = KINDS.includes(input && input.kind) ? input.kind : null;
  if (!kind) throw new ZoomError('INVALID_INPUT', { field: 'kind' });
  const { dialog } = _electron();
  const opts = {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  };
  const parent = _parent(env);
  let pick;
  try {
    pick = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    _warn('dialog', e);
    return fail('IO_ERROR');
  }
  const files = pick && !pick.canceled && Array.isArray(pick.filePaths) ? pick.filePaths.filter((f) => typeof f === 'string') : [];
  if (!files.length) return fail('CANCELLED');

  const existing = _normDoc(_store().load('zoomStudioLibrary', DEFAULT_DOC())).items.length;
  const added = [];
  const rejected = [];
  files.forEach((file, i) => {
    const name = path.basename(file);
    if (i >= MAX_PER_IMPORT || existing + added.length >= MAX_ITEMS) { rejected.push({ name, code: 'LIMIT_REACHED' }); return; }
    try {
      const info = _checkFile(file);
      added.push(_storeFile(file, info, kind));
    } catch (e) {
      const code = e instanceof ZoomError ? e.code : 'IO_ERROR';
      if (!(e instanceof ZoomError)) _warn('import', e);
      rejected.push({ name, code });
    }
  });

  if (added.length) {
    try {
      _write((cur) => {
        const d = _normDoc(cur);
        d.items = d.items.concat(added);
        return d;
      });
    } catch (e) {
      // The index could not be written: remove the copies so no orphan files remain.
      for (const it of added) {
        _rmQuiet(path.join(libraryDir(), it.file));
        if (it.thumb) _rmQuiet(path.join(libraryDir(), it.thumb));
      }
      return fail(e instanceof ZoomError ? e.code : 'IO_ERROR');
    }
  }
  const codes = {};
  for (const r of rejected) codes[r.code] = (codes[r.code] || 0) + 1;
  _info({ op: 'import', kind, added: added.length, rejected: rejected.length, codes });
  return { ok: true, items: added.map((it) => _public(it, true)), rejected };
}

async function list() {
  const d = _normDoc(_store().load('zoomStudioLibrary', DEFAULT_DOC()));
  return { ok: true, items: d.items.map((it) => _public(it, true)) };
}

function _find(id) {
  return _normDoc(_store().load('zoomStudioLibrary', DEFAULT_DOC())).items.find((it) => it.id === id) || null;
}

function _safeFile(item) {
  const f = String(item && item.file || '');
  return /^l_[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/.test(f) ? f : null;
}

async function read(input) {
  const item = _find(input.id);
  if (!item) return fail('NOT_FOUND');
  const f = _safeFile(item);
  const type = _format(item);
  if (!f || !type) return fail('NOT_FOUND');
  let buf;
  try {
    const p = path.join(libraryDir(), f);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return fail('INVALID_FILE');
    buf = fs.readFileSync(p);
  } catch (e) {
    _warn('read', e);
    return fail(_fsCode(e));
  }
  return { ok: true, dataUrl: 'data:' + sniffer.MIME[type] + ';base64,' + buf.toString('base64'), w: item.w, h: item.h };
}

async function rename(input) {
  const id = input.id;
  const nm = require('./preset-schema').name(input.name);
  let out = null;
  _write((cur) => {
    const d = _normDoc(cur);
    const i = d.items.findIndex((it) => it.id === id);
    if (i < 0) throw new ZoomError('NOT_FOUND');
    d.items[i] = Object.assign({}, d.items[i], { name: nm });
    out = d.items[i];
    return d;
  });
  _info({ op: 'rename', count: 1 });
  return { ok: true, item: _public(out, true) };
}

async function remove(input) {
  const id = input.id;
  const item = _find(id);
  if (!item) return fail('NOT_FOUND');
  const presets = require('./presets');
  const usedBy = presets.countImageRefs(id);
  if (usedBy > 0 && !input.force) return fail('IN_USE', { usedBy });
  const dir = libraryDir();
  for (const f of [_safeFile(item), typeof item.thumb === 'string' && /^l_[0-9a-f]{12}\.thumb\.png$/.test(item.thumb) ? item.thumb : null]) {
    if (!f) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;   // already gone: still drop the entry
      _warn('delete', e);
      return fail('IO_ERROR');
    }
  }
  _write((cur) => {
    const d = _normDoc(cur);
    d.items = d.items.filter((it) => it.id !== id);
    return d;
  });
  const cleared = usedBy > 0 ? presets.clearImageRefs(id) : 0;
  _info({ op: 'delete', count: 1, cleared });
  return { ok: true };
}

module.exports = {
  importImages, list, read, rename, remove, libraryDir,
  MAX_PER_IMPORT, MAX_ITEMS, MAX_BYTES, MAX_DIM, THUMB_W, KINDS,
  _setDeps,
};
