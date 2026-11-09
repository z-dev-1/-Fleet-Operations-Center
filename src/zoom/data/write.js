'use strict';
/**
 * src/zoom/data/write.js — write hand-off to the Zoom portal (design §12 + review F-15, A2, shipped OFF).
 *
 * Fleet never schedules or deletes anything itself: it confirms, then opens ONE visible portal window on
 * the Zoom partition where the user acts. No API request is made — this module never requires
 * transport.js or electron.net (ALLOWED_POST also makes write calls structurally impossible).
 *
 * writeOpen({action, key}): 1 Validate -> 2 Confirm -> 3 Cancel gives CANCELLED -> 4 Open.
 * A second call while that window is open focuses it instead of opening another.
 */
const C = require('../constants');
const { fail } = require('../errors');
const { safeErr } = require('../redact');
const log = require('../../utils/logger')('zoom:data');

const CONFIRM = Object.freeze({
  schedule: 'Open the Zoom portal to schedule a meeting? Fleet will not create anything itself.',
  'delete-recording': "Open this recording in the Zoom portal? You delete it there; Fleet won't.",
});
const TARGET_URL = Object.freeze({ schedule: C.SCHEDULE_URL, 'delete-recording': C.RECORDINGS_URL });

let _win = null;

function _alive(w) {
  try { return !!w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()); } catch (_) { return false; }
}

function _parent(env) {
  try {
    const w = env && env.ctx && env.ctx.mainWindow;
    return _alive(w) ? w : null;
  } catch (_) { return null; }
}

function _logWrite(action, code) {
  try { log.info('[zoom] write', { op: 'write-open', action, code }); } catch (_) {}
}

/** writeOpen({action, key}, {ctx}) -> {ok:true} | NOT_FOUND | CANCELLED | CAPTURE_FAILED */
async function writeOpen(input, env) {
  const action = input.action;
  // 1. Validate (before any dialog).
  if (action === 'delete-recording') {
    const key = input.key;
    if (typeof key !== 'string' || !require('./client').recordingByKey.has(key)) return fail('NOT_FOUND');
  }
  const session = require('./session');
  // A second call while the portal window is open focuses it.
  if (_alive(_win)) {
    try { _win.focus(); } catch (e) { log.warn('[zoom] write focus', safeErr(e)); }
    _logWrite(action, 'FOCUSED');
    return { ok: true, focused: true };
  }
  const { dialog, BrowserWindow } = session._electron();
  const parent = _parent(env);
  // 2. Confirm.
  const opts = { type: 'question', buttons: ['Open Zoom portal', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true, title: 'Zoom portal', message: CONFIRM[action] };
  let r;
  try {
    r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  } catch (e) {
    log.warn('[zoom] write confirm', safeErr(e));
    r = null;
  }
  // 3. Cancel.
  if (!r || r.response !== 0) { _logWrite(action, 'CANCELLED'); return fail('CANCELLED'); }
  if (_alive(_win)) { try { _win.focus(); } catch (_) {} return { ok: true, focused: true }; }
  // 4. Open exactly one visible window on the partition (§6.4 options + navigation guard).
  try {
    session.getSession();
    await session.ensureSeeded('write');
    const wopts = {
      width: 1100, height: 850, title: 'Zoom portal (Fleet)', show: true, autoHideMenuBar: true,
      webPreferences: session._webPreferences(),
    };
    if (parent) wopts.parent = parent;
    const win = new BrowserWindow(wopts);
    _win = win;
    try { win.setMenuBarVisibility(false); } catch (_) {}
    const wc = win.webContents;
    wc.setWindowOpenHandler((details) => {
      try {
        const url = details && details.url;
        // Popups are always denied; an allowed URL loads in this same window instead.
        if (C.isNavAllowed(url)) Promise.resolve().then(() => win.loadURL(url)).catch(() => {});
      } catch (e) { try { log.warn('[zoom] write window-open', safeErr(e)); } catch (_) {} }
      return { action: 'deny' };
    });
    session._guardNav(wc, 'write');
    win.on('closed', () => { try { if (_win === win) _win = null; } catch (e) { log.warn('[zoom] write closed', safeErr(e)); } });
    session.load(win, TARGET_URL[action]).catch(() => {});
  } catch (e) {
    log.warn('[zoom] write window', safeErr(e));
    _win = null;
    return fail('CAPTURE_FAILED');
  }
  _logWrite(action, 'OK');
  return { ok: true };
}

function _resetForTests() {
  try { if (_alive(_win)) _win.destroy(); } catch (_) {}
  _win = null;
}

module.exports = { writeOpen, CONFIRM, _resetForTests };
