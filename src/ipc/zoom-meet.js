'use strict';
/**
 * ipc/zoom-meet.js — Meetings tab IPC (zoom.enabled, default OFF).
 *
 * Flag OFF: every channel returns { ok:false, code:'DISABLED' } and no zoom-meet
 * module (view/session) is ever loaded. Flag ON: channels drive the single meeting
 * view in src/zoom-meet/view.js. Only the Fleet main window may call these; the
 * Zoom view itself has no preload, so it cannot reach IPC at all.
 *
 * This is separate from the shipped OAuth ipc/zoom.js (Marketplace route, blocked),
 * which stays untouched.
 */

const { handle, requireStringMax } = require('./_safe');
const logger = require('../utils/logger')('ipc:zoom-meet');

const CHANNELS = Object.freeze([
  'zoomMeet:status', 'zoomMeet:join', 'zoomMeet:open-home', 'zoomMeet:set-bounds',
  'zoomMeet:detach', 'zoomMeet:dock', 'zoomMeet:leave', 'zoomMeet:open-in-zoom-app',
]);

function _num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function _rect(r) {
  if (r === null) return null;
  if (!r || typeof r !== 'object') return undefined;
  const x = _num(r.x), y = _num(r.y), width = _num(r.width), height = _num(r.height);
  if (x === null || y === null || width === null || height === null) return undefined;
  if (width < 1 || height < 1 || width > 20000 || height > 20000) return undefined;
  return { x, y, width, height };
}

function registerZoomMeetIPC(ctx, deps) {
  const d = deps || {};
  const flags = d.flags || require('../config/perf-flags').loadZoomMeet();
  const disabled = { ok: false, code: 'DISABLED', error: 'Zoom Meetings is turned off (zoom.enabled)' };

  if (!flags.enabled) {
    for (const ch of CHANNELS) {
      handle(ch, async () => (ch === 'zoomMeet:status' ? { ok: true, enabled: false } : disabled));
    }
    return;
  }

  const urlUtil = require('../zoom-meet/url');
  const getMainWindow = () => (ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : (ctx && ctx.mainWindow) || null);
  const send = (ch, payload) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload);
  };
  const controller = d.controller || require('../zoom-meet/view').createController({ getMainWindow, send, log: logger });
  const shell = d.shell || require('electron').shell;

  // Only the Fleet main window's renderer may drive the meeting view.
  const fromMain = (e) => {
    const w = getMainWindow();
    return !!(w && !w.isDestroyed() && e && e.sender === w.webContents);
  };
  const guarded = (ch, fn) => handle(ch, async (e, ...args) => {
    if (!fromMain(e)) return { ok: false, code: 'FORBIDDEN', error: 'Not allowed from this window' };
    return fn(...args);
  });

  guarded('zoomMeet:status', async () => Object.assign({ enabled: true, miniPlayer: flags.miniPlayer }, controller.state()));

  guarded('zoomMeet:join', async (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const input = requireStringMax(p.input, 'input', 2048);
    const passcode = typeof p.passcode === 'string' ? p.passcode.slice(0, 64) : '';
    const n = urlUtil.normalizeJoinInput(input, { passcode, webAppHost: flags.webAppHost });
    if (!n.ok) return { ok: false, code: 'BAD_INPUT', error: n.error };
    return controller.open(n.url);
  });

  // Zoom web app home (meetings list / team chat) — observed at <webAppHost>/wc/meetings.
  guarded('zoomMeet:open-home', async () => controller.open('https://' + flags.webAppHost + '/wc/meetings'));

  guarded('zoomMeet:set-bounds', async (rect) => {
    const r = _rect(rect);
    if (r === undefined) return { ok: false, code: 'BAD_INPUT', error: 'bad bounds' };
    return controller.setBounds(r);
  });

  guarded('zoomMeet:detach', async (opts) => controller.detach({ floating: !!(opts && opts.floating) }));
  guarded('zoomMeet:dock', async () => controller.dock());
  guarded('zoomMeet:leave', async () => controller.leave());

  guarded('zoomMeet:open-in-zoom-app', async () => {
    const link = urlUtil.toDeepLink(controller.currentUrl());
    if (!link) return { ok: false, code: 'NO_MEETING', error: 'No meeting ID to open in the Zoom app' };
    await shell.openExternal(link);
    return { ok: true };
  });

  logger.info('[zoom-meet] IPC registered (enabled)');
}

module.exports = { registerZoomMeetIPC, CHANNELS };
