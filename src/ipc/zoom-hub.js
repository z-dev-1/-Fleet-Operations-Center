'use strict';
/**
 * src/ipc/zoom-hub.js — the Zoom AI studio IPC surface (flags zoom.*, all default OFF).
 *
 * Owns the whole channel table, the sender guard, the DISABLED / WRITE_DISABLED / NOT_IMPLEMENTED
 * stubs and the zh() wrapper, which owns IPC redaction: no exception from a Zoom handler ever reaches
 * _safe.safeIPC (it would log err.message / err.stack and return error: err.message).
 *
 * Area gate: anyArea = effective.data || effective.studio. Only when anyArea is true is anything under
 * src/zoom/ required. With no area effective (the flag-OFF parity state, even with zoom.enabled:true)
 * every channel is a fixed-literal stub that requires nothing.
 *
 * Later phases add ONE line per channel to REAL, inside their own block (// A2, // B1, // B2).
 */
const log = require('../utils/logger')('zoom:hub');

const CHANNELS = Object.freeze({
  hub: Object.freeze(['zoomHub:flags']),
  data: Object.freeze([
    'zoomData:status',
    'zoomData:connect',
    'zoomData:list-meetings',
    'zoomData:get-meeting',
    'zoomData:join',
    'zoomData:list-recordings',
    'zoomData:recording-info',
    'zoomData:get-transcript',
    'zoomData:import-transcript',
    'zoomData:summarize',
    'zoomData:ai-consent',
    'zoomData:get-summary',
    'zoomData:link-targets',
    'zoomData:link',
    'zoomData:unlink',
    'zoomData:links',
    'zoomData:write-open',
  ]),
  studio: Object.freeze([
    'zoomStudio:media-status',
    'zoomStudio:open-privacy',
    'zoomStudio:presets-list',
    'zoomStudio:preset-save',
    'zoomStudio:preset-rename',
    'zoomStudio:preset-delete',
    'zoomStudio:preset-select',
    'zoomStudio:library-list',
    'zoomStudio:library-import',
    'zoomStudio:library-read',
    'zoomStudio:library-rename',
    'zoomStudio:library-delete',
    'zoomStudio:launcher-get',
    'zoomStudio:launcher-pick',
    'zoomStudio:launcher-run',
  ]),
});

// Main -> renderer events (sent through ctx.sendToWindow).
const EVENTS = Object.freeze(['zoomData:auth-changed', 'zoomData:summary-progress']);

// channel -> () => implementation(input, {event, ctx}). The getter runs inside the handler, so the
// module is required only when the user acts. Validators live in src/zoom/validate.js (validators[channel]).
const REAL = {
  // A1
  'zoomData:status': () => require('../zoom/data/client').status,
  'zoomData:connect': () => require('../zoom/data/client').connect,
  'zoomData:list-meetings': () => require('../zoom/data/client').listMeetings,
  'zoomData:get-meeting': () => require('../zoom/data/client').getMeeting,
  'zoomData:join': () => require('../zoom/data/client').join,
  'zoomData:list-recordings': () => require('../zoom/data/client').listRecordings,
  'zoomData:recording-info': () => require('../zoom/data/client').recordingInfo,
  // A2
  'zoomData:get-transcript': () => require('../zoom/data/transcript').getTranscript,
  'zoomData:import-transcript': () => require('../zoom/data/transcript').importTranscript,
  'zoomData:summarize': () => require('../zoom/data/summary').summarize,
  'zoomData:ai-consent': () => require('../zoom/data/summary').aiConsent,
  'zoomData:get-summary': () => require('../zoom/data/summary').getSummary,
  'zoomData:link-targets': () => require('../zoom/data/links').linkTargets,
  'zoomData:link': () => require('../zoom/data/links').link,
  'zoomData:unlink': () => require('../zoom/data/links').unlink,
  'zoomData:links': () => require('../zoom/data/links').links,
  'zoomData:write-open': () => require('../zoom/data/write').writeOpen,
  // B1
  'zoomStudio:media-status': () => require('../zoom/studio/media-status').status,
  'zoomStudio:open-privacy': () => require('../zoom/studio/media-status').openPrivacy,
  // B2
};

const DISABLED = Object.freeze({ ok: false, code: 'DISABLED' });
const WRITE_DISABLED = Object.freeze({ ok: false, code: 'WRITE_DISABLED' });
const NOT_IMPLEMENTED = Object.freeze({ ok: false, code: 'NOT_IMPLEMENTED' });
const FORBIDDEN = Object.freeze({ ok: false, code: 'FORBIDDEN' });

function _isAppUrl(url) {
  const s = String(url || '');
  if (s.startsWith('http://localhost:5173/')) return true;
  if (!s.startsWith('file:')) return false;
  let p = '';
  try { p = new URL(s).pathname; } catch (_) { return false; }
  return p.endsWith('/renderer/src/index.html') || p.endsWith('/dist/renderer/index.html');
}

/**
 * assertAppSender(ctx, event, channel) -> null when the sender is the app page in the main window's
 * MAIN frame, else {ok:false, code:'FORBIDDEN'}. The same preload is injected into the AAP corp page
 * and into webview guests (a different webContents), so the frame and its URL are checked. Frames are
 * compared by identity fields (processId + routingId), not object identity.
 */
function assertAppSender(ctx, event, channel) {
  let ok = false;
  try {
    const f = event && event.senderFrame;
    const win = ctx && ctx.mainWindow;
    const wc = win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win.webContents : null;
    const main = wc && wc.mainFrame;
    ok = !!(f && wc && main && event.sender === wc &&
      f.processId === main.processId && f.routingId === main.routingId && _isAppUrl(f.url));
  } catch (_) {
    ok = false;
  }
  if (ok) return null;
  try { log.warn('[zoom-hub] sender rejected', { channel, code: 'FORBIDDEN' }); } catch (_) {}
  return FORBIDDEN;
}

function registerZoomHubIPC(ctx, deps = {}) {
  const handle = typeof deps.handle === 'function' ? deps.handle : require('./_safe').handle;
  const flags = deps.flags || require('../config/perf-flags').loadZoom();
  const eff = (flags && flags.effective) || {};
  const effData = eff.data === true;
  const effStudio = eff.studio === true;
  const effWrite = eff.write === true;
  const anyArea = effData || effStudio;

  if (anyArea) {
    require('../zoom/errors');
    require('../zoom/validate');
    require('../zoom/redact');
    require('../zoom/safe-json');
    require('../zoom/flags')._prime(flags);
  } else if (flags && flags.enabled === true) {
    try { log.info('[zoom-hub] enabled-without-area'); } catch (_) {}
  }

  const flagsResult = Object.freeze({
    ok: true,
    enabled: eff.enabled === true,
    data: effData,
    studio: effStudio,
    write: effWrite,
  });

  function stub(channel, result) {
    handle(channel, async (event) => {
      const g = assertAppSender(ctx, event, channel);
      if (g) return g;
      return result;
    });
  }

  function zh(channel, getImpl) {
    handle(channel, async (event, payload) => {
      const g = assertAppSender(ctx, event, channel);
      if (g) return g;
      try {
        const validator = require('../zoom/validate').validators[channel];
        const input = validator(payload);            // throws ZoomError('INVALID_INPUT', {field})
        const fn = getImpl();                         // lazy require happens here
        return await fn(input, { event, ctx });
      } catch (e) {
        let r = { ok: false, code: 'INTERNAL' };
        try { r = require('../zoom/errors').toResult(e); } catch (_) {}
        if (r.code === 'INTERNAL') {
          try { log.error('[' + channel + ']', require('../zoom/redact').safeErr(e)); } catch (_) {}
        }
        return r;
      }
    });
  }

  stub('zoomHub:flags', flagsResult);

  function registerArea(list, on) {
    for (const ch of list) {
      if (!on) { stub(ch, DISABLED); continue; }
      if (ch === 'zoomData:write-open' && !effWrite) { stub(ch, WRITE_DISABLED); continue; }
      const getImpl = REAL[ch];
      if (!getImpl) { stub(ch, NOT_IMPLEMENTED); continue; }
      zh(ch, getImpl);
    }
  }
  registerArea(CHANNELS.data, effData);
  registerArea(CHANNELS.studio, effStudio);

  return { flags: flagsResult, anyArea };
}

module.exports = { registerZoomHubIPC, CHANNELS, EVENTS, REAL, assertAppSender, _isAppUrl };
