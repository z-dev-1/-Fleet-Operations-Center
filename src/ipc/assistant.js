'use strict';
/**
 * ipc/assistant.js — Context-aware assistant IPC (design §D11).
 *
 *   assistant:set-screen-context  renderer heartbeat of what Z is looking at
 *   assistant:get-notes           in-app proactive notes feed { notes, unseen }
 *   assistant:mark-notes-seen     Notes tab opened
 *   assistant:dismiss-note        hide one note
 *
 * Every handler first checks the sender is the app's own UI (file: or the
 * Vite dev server). preload.js is also injected into AAP corp pages, so those
 * pages must not be able to write screen context or read notes.
 */

const { handle, requireStringMax } = require('./_safe');
const screenContext = require('../orcha/awareness/screen-context');
const { getNotifier } = require('../orcha/awareness/notifier');
const logger = require('../utils/logger')('ipc:assistant');

const NOT_APP_UI = { ok: false, code: 'NOT_APP_UI' };

function _guard(channel, e) {
  if (screenContext._isAppSender(e)) return true;
  logger.debug('[' + channel + '] rejected: sender is not the app UI');
  return false;
}

function registerAssistantIPC(ctx) {
  try { getNotifier().configure({ send: ctx && ctx.send }); } catch (e) { logger.warn('notifier configure failed: ' + e.message); }

  handle('assistant:set-screen-context', async (e, payload) => {
    if (!_guard('assistant:set-screen-context', e)) return NOT_APP_UI;
    screenContext.set(payload); // throws ConfigError on invalid payload → safeIPC
    return { ok: true };
  });

  handle('assistant:get-notes', async (e) => {
    if (!_guard('assistant:get-notes', e)) return NOT_APP_UI;
    const feed = getNotifier().getFeed();
    return { ok: true, notes: feed.notes, unseen: feed.unseen };
  });

  handle('assistant:mark-notes-seen', async (e) => {
    if (!_guard('assistant:mark-notes-seen', e)) return NOT_APP_UI;
    getNotifier().markSeen();
    return { ok: true };
  });

  handle('assistant:dismiss-note', async (e, id) => {
    if (!_guard('assistant:dismiss-note', e)) return NOT_APP_UI;
    const noteId = requireStringMax(id, 'id', 64);
    return getNotifier().dismiss(noteId);
  });
}

module.exports = { registerAssistantIPC };
