'use strict';
/**
 * src/zoom/studio/media-status.js — Windows camera / microphone permission state and the fixed
 * Windows privacy-settings deep links (design §14.1 steps 1-2, FEAT-B1).
 *
 * status()       -> {ok:true, camera, microphone}, each granted|denied|restricted|not-determined|unknown
 *                   (a throwing or missing systemPreferences call gives 'unknown').
 * openPrivacy()  -> maps which ('camera'|'microphone') to a FIXED ms-settings: literal and calls
 *                   shell.openExternal. No renderer string ever reaches openExternal.
 *
 * Preview only: nothing here installs a permission handler on any session, and no driver exists.
 */
const log = require('../../utils/logger')('zoom:studio');
const { ZoomError, fail } = require('../errors');
const { safeErr } = require('../redact');

// Test seam: { electron }. Production requires electron lazily inside the functions.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _electron() { return _deps.electron || require('electron'); }

const STATES = Object.freeze(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);
const PRIVACY_URI = Object.freeze({
  camera: 'ms-settings:privacy-webcam',
  microphone: 'ms-settings:privacy-microphone',
});

function _one(sp, which) {
  try {
    const v = sp.getMediaAccessStatus(which);
    return STATES.includes(v) ? v : 'unknown';
  } catch (e) {
    try { log.warn('[zoom-studio] media-status', { op: 'media-status', which, err: safeErr(e) }); } catch (_) {}
    return 'unknown';
  }
}

/** status() -> {ok:true, camera, microphone}. Never throws. */
async function status() {
  let sp = null;
  try { sp = _electron().systemPreferences; } catch (_) { sp = null; }
  if (!sp || typeof sp.getMediaAccessStatus !== 'function') return { ok: true, camera: 'unknown', microphone: 'unknown' };
  return { ok: true, camera: _one(sp, 'camera'), microphone: _one(sp, 'microphone') };
}

/** openPrivacy({which}) -> {ok:true} | INVALID_INPUT (unknown which) | UNAVAILABLE (openExternal failed). */
async function openPrivacy(input) {
  const which = input && input.which;
  let uri = null;
  if (which === 'camera') uri = PRIVACY_URI.camera;
  else if (which === 'microphone') uri = PRIVACY_URI.microphone;
  if (!uri) throw new ZoomError('INVALID_INPUT', { field: 'which' });
  try {
    await _electron().shell.openExternal(uri);
    return { ok: true };
  } catch (e) {
    try { log.warn('[zoom-studio] open-privacy', { op: 'open-privacy', which, err: safeErr(e) }); } catch (_) {}
    return fail('UNAVAILABLE');
  }
}

module.exports = { status, openPrivacy, PRIVACY_URI, STATES, _setDeps };
