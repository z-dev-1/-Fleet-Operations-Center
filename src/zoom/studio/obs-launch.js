'use strict';
/**
 * src/zoom/studio/obs-launch.js — find / start OBS for the OBS integration (design §4.5).
 *
 * This module owns child_process, so launcher.js keeps its no-spawn contract. Fleet builds no
 * command string: tasklist and obs64.exe are run with an args array and shell:false.
 *
 *   validateExe(p)  -> exe path, or throws ZoomError INVALID_PATH (exeSyntaxOk) | OBS_NOT_INSTALLED
 *                      (p == null -> DEFAULT_EXE)
 *   isRunning()     -> Promise<true | false | null>  (null when tasklist errors)
 *   launch(exe)     -> Promise<{ok:true, already:boolean}> | {ok:false, code: BUSY | INVALID_PATH |
 *                      OBS_NOT_INSTALLED | LAUNCH_FAILED}  (5 s debounce)
 *
 * The path appears in no log line and no error result.
 */
const path = require('path');
const { ZoomError, toResult, fail } = require('../errors');
const { exeSyntaxOk } = require('./obs-auth');
const log = require('../../utils/logger')('zoom:studio');

const DEFAULT_EXE = 'C:/Program Files/obs-studio/bin/64bit/obs64.exe';
const DEBOUNCE_MS = 5000;
const TASKLIST_ARGS = Object.freeze(['/FI', 'IMAGENAME eq obs64.exe', '/NH', '/FO', 'CSV']);
const LAUNCH_ARGS = Object.freeze(['--minimize-to-tray', '--disable-shutdown-check']);

let _deps = {};
let _lastLaunch = 0;
function _setDeps(d) { _deps = d || {}; }
function _resetForTests() { _lastLaunch = 0; }
function _cp() { return _deps.child_process || require('child_process'); }
function _fs() { return _deps.fs || require('fs'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }

function _log(level, fields) {
  try { log[level]('[zoom-studio] obs-launch', fields); } catch (_) {}
}

function validateExe(p) {
  const exe = p == null ? DEFAULT_EXE : p;
  if (!exeSyntaxOk(exe)) throw new ZoomError('INVALID_PATH');
  let st;
  try { st = _fs().statSync(exe); } catch (_) { throw new ZoomError('OBS_NOT_INSTALLED'); }
  if (!st || typeof st.isFile !== 'function' || !st.isFile()) throw new ZoomError('OBS_NOT_INSTALLED');
  return exe;
}

function isRunning() {
  return new Promise((resolve) => {
    try {
      _cp().execFile('tasklist', TASKLIST_ARGS.slice(), { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err) { _log('warn', { op: 'tasklist', code: (err && err.code) || 'ERROR' }); resolve(null); return; }
        resolve(/"obs64\.exe"/i.test(String(stdout || '')));
      });
    } catch (e) {
      _log('warn', { op: 'tasklist', code: (e && e.code) || 'ERROR' });
      resolve(null);
    }
  });
}

function _spawn(exe) {
  return new Promise((resolve) => {
    let child;
    try {
      child = _cp().spawn(exe, LAUNCH_ARGS.slice(), { cwd: path.dirname(exe), detached: true, stdio: 'ignore', shell: false });
    } catch (e) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok); };
    child.once('error', () => finish(false));
    child.once('spawn', () => finish(true));
    try { child.unref(); } catch (_) {}
  });
}

async function launch(exe) {
  const t = _now();
  if (_lastLaunch && t - _lastLaunch < DEBOUNCE_MS) return fail('BUSY');
  _lastLaunch = t;
  let p;
  try { p = validateExe(exe); } catch (e) { return toResult(e); }
  if ((await isRunning()) === true) {
    _log('info', { op: 'launch', already: true });
    return { ok: true, already: true };
  }
  if (!(await _spawn(p))) {
    _log('warn', { op: 'launch', code: 'LAUNCH_FAILED' });
    return fail('LAUNCH_FAILED');
  }
  _log('info', { op: 'launch', already: false });
  return { ok: true, already: false };
}

module.exports = { validateExe, isRunning, launch, DEFAULT_EXE, DEBOUNCE_MS, TASKLIST_ARGS, LAUNCH_ARGS, _setDeps, _resetForTests };
