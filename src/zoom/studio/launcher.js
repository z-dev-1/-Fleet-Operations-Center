'use strict';
/**
 * src/zoom/studio/launcher.js — "Virtual-camera setup (outside Fleet)" launcher (design §15.4, FEAT-B2).
 *
 * Runs the user's own .bat/.cmd (default: <Desktop>\Grim Reaper Zoom Face\Start Grim Reaper.bat) through
 * shell.openPath, which uses the OS default verb: Fleet builds no command string, passes no arguments,
 * never waits on the process and never spawns / execs anything. Fleet never opens the file for
 * writing (only fs.statSync is used on it). Fleet ships no virtual camera: this only starts the user's
 * existing OBS-based setup.
 *
 *   get()   -> {ok, path|null, exists, isDefault}
 *              (the default is used only when launcherPath is null AND the default file exists)
 *   pick()  -> {ok, path} | CANCELLED | INVALID_PATH | NOT_FOUND (native dialog; the renderer never
 *              supplies a path string)
 *   run()   -> {ok} | BUSY (5 s debounce) | INVALID_PATH | NOT_FOUND | CANCELLED | LAUNCH_FAILED
 *              (one-time native confirm per sha256(path), stored in zoomStudioConfig.launcherConfirmed)
 *
 * The path appears in no log line and no error result.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ZoomError, fail } = require('../errors');
const { safeErr } = require('../redact');
const presets = require('./presets');
const log = require('../../utils/logger')('zoom:studio');

const DEBOUNCE_MS = 5000;
const MAX_PATH = 260;
const DEFAULT_DIR = 'Grim Reaper Zoom Face';
const DEFAULT_FILE = 'Start Grim Reaper.bat';

let _deps = {};
let _lastRun = 0;
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _store() { return require('../../store'); }
function _resetForTests() { _lastRun = 0; }

function _warn(op, fields) {
  try { log.warn('[zoom-studio] launcher', Object.assign({ op }, fields || {})); } catch (_) {}
}

function _parent(env) {
  try {
    const w = env && env.ctx && env.ctx.mainWindow;
    return w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) ? w : null;
  } catch (_) {
    return null;
  }
}

function _config() {
  return presets._normConfig(_store().load('zoomStudioConfig', presets.DEFAULT_CONFIG()));
}

/** validate(p) -> p, or throws ZoomError INVALID_PATH / NOT_FOUND / IO_ERROR. Never opens the file. */
function validate(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > MAX_PATH) throw new ZoomError('INVALID_PATH');
  if (p.startsWith('\\\\') || p.startsWith('//')) throw new ZoomError('INVALID_PATH');   // UNC or device path
  if (!path.isAbsolute(p)) throw new ZoomError('INVALID_PATH');
  const ext = path.extname(p).toLowerCase();
  if (ext !== '.bat' && ext !== '.cmd') throw new ZoomError('INVALID_PATH');
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    const c = e && e.code;
    if (c === 'ENOENT' || c === 'ENOTDIR') throw new ZoomError('NOT_FOUND');
    if (c === 'EACCES' || c === 'EPERM' || c === 'EBUSY') throw new ZoomError('IO_ERROR');
    throw new ZoomError('INVALID_PATH');
  }
  if (!st || !st.isFile()) throw new ZoomError('NOT_FOUND');
  return p;
}

function _exists(p) {
  try { validate(p); return true; } catch (_) { return false; }
}

function defaultPath() {
  try {
    const desk = _electron().app.getPath('desktop');
    return typeof desk === 'string' && desk ? path.join(desk, DEFAULT_DIR, DEFAULT_FILE) : null;
  } catch (e) {
    _warn('desktop-path', { err: safeErr(e) });
    return null;
  }
}

/** _effective() -> {path|null, exists, isDefault}. */
function _effective() {
  const cfg = _config();
  if (typeof cfg.launcherPath === 'string' && cfg.launcherPath) {
    return { path: cfg.launcherPath, exists: _exists(cfg.launcherPath), isDefault: false };
  }
  const def = defaultPath();
  if (def && _exists(def)) return { path: def, exists: true, isDefault: true };
  return { path: null, exists: false, isDefault: false };
}

async function get() {
  return Object.assign({ ok: true }, _effective());
}

async function pick(_input, env) {
  const { dialog } = _electron();
  const opts = { properties: ['openFile'], filters: [{ name: 'Launcher', extensions: ['bat', 'cmd'] }] };
  const parent = _parent(env);
  let r;
  try {
    r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    _warn('pick-dialog', { err: safeErr(e) });
    return fail('IO_ERROR');
  }
  const p = r && !r.canceled && Array.isArray(r.filePaths) ? r.filePaths[0] : null;
  if (!p) return fail('CANCELLED');
  validate(p);
  try {
    _store().update('zoomStudioConfig', (cur) => Object.assign(presets._normConfig(cur), { launcherPath: p }), presets.DEFAULT_CONFIG());
  } catch (e) {
    _warn('pick-store', { err: safeErr(e) });
    return fail('IO_ERROR');
  }
  try { log.info('[zoom-studio] launcher', { op: 'pick' }); } catch (_) {}
  return { ok: true, path: p };
}

function _hash(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

async function run(_input, env) {
  const t = _now();
  if (_lastRun && t - _lastRun < DEBOUNCE_MS) return fail('BUSY');
  _lastRun = t;
  const eff = _effective();
  if (!eff.path) return fail('NOT_FOUND');
  const p = validate(eff.path);
  const electron = _electron();
  const h = _hash(p);
  const cfg = _config();
  if (!cfg.launcherConfirmed[h]) {
    let res;
    try {
      const opts = {
        type: 'question',
        buttons: ['Run', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Virtual-camera setup (outside Fleet)',
        message: 'Run this file? ' + path.basename(p) + '. It starts your Grim Reaper / OBS setup outside Fleet.',
      };
      const parent = _parent(env);
      res = parent ? await electron.dialog.showMessageBox(parent, opts) : await electron.dialog.showMessageBox(opts);
    } catch (e) {
      _warn('confirm', { err: safeErr(e) });
      return fail('CANCELLED');
    }
    if (!res || res.response !== 0) return fail('CANCELLED');
    try {
      _store().update('zoomStudioConfig', (cur) => {
        const c = presets._normConfig(cur);
        c.launcherConfirmed = Object.assign({}, c.launcherConfirmed, { [h]: new Date().toISOString() });
        return c;
      }, presets.DEFAULT_CONFIG());
    } catch (e) {
      _warn('confirm-store', { err: safeErr(e) });   // the user confirmed: still run; they'll be asked again next time
    }
  }
  let err;
  try {
    err = await electron.shell.openPath(p);
  } catch (e) {
    _warn('run', { code: 'LAUNCH_FAILED', err: safeErr(e) });
    return fail('LAUNCH_FAILED');
  }
  if (typeof err === 'string' && err.length) {
    _warn('run', { code: 'LAUNCH_FAILED' });
    return fail('LAUNCH_FAILED');
  }
  try { log.info('[zoom-studio] launcher', { op: 'run', isDefault: eff.isDefault }); } catch (_) {}
  return { ok: true };
}

module.exports = { get, pick, run, validate, defaultPath, DEBOUNCE_MS, MAX_PATH, _setDeps, _resetForTests };
