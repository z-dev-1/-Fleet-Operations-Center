'use strict';
/**
 * src/zoom/errors.js — ZoomError (extends Error, NOT FleetError) with a FIXED message per code,
 * and toResult(e) which turns any thrown value into a safe IPC result.
 *
 * Results never carry an `error` string or a `stack`. Only whitelisted extra fields pass through.
 */

const MESSAGES = Object.freeze({
  DISABLED: 'This Zoom area is turned off.',
  WRITE_DISABLED: 'Zoom write actions are turned off.',
  FORBIDDEN: 'Request not allowed.',
  INVALID_INPUT: 'Invalid input.',
  SIGN_IN_REQUIRED: 'Zoom sign-in required.',
  SSO_WALL: 'A sign-in or challenge page blocked Zoom.',
  SIGN_IN_TIMEOUT: 'Zoom sign-in timed out.',
  CANCELLED: 'Cancelled.',
  NETWORK: 'Network failure.',
  TIMEOUT: 'The request timed out.',
  THROTTLED: 'Zoom is rate limiting requests.',
  HTTP_ERROR: 'Zoom returned an HTTP error.',
  ZOOM_ERROR: 'Zoom reported an error.',
  RESPONSE_TOO_LARGE: 'The Zoom response was too large.',
  SHAPE_UNRECOGNIZED: 'The Zoom response format was not recognised.',
  CAPTURE_TIMEOUT: 'The Zoom page did not load its data in time.',
  CAPTURE_FAILED: 'The Zoom page could not be read.',
  NEEDS_CAPTURE: 'A fresh page capture is needed.',
  NOT_FOUND: 'Not found.',
  TRANSCRIPT_UNAVAILABLE: 'No transcript could be fetched.',
  INVALID_FILE: 'The file is not valid.',
  CONSENT_REQUIRED: 'AI consent is required.',
  AI_UNAVAILABLE: 'The AI summary is unavailable.',
  UNKNOWN_TARGET: 'Unknown unit or carrier.',
  FLEET_DATA_UNAVAILABLE: 'Fleet data is not available.',
  LIMIT_REACHED: 'A size limit was reached.',
  DUPLICATE_NAME: 'That name already exists.',
  UNKNOWN_IMAGE: 'A referenced image is missing.',
  IN_USE: 'The item is in use.',
  IO_ERROR: 'File system error.',
  INVALID_PATH: 'The path is not valid.',
  LAUNCH_FAILED: 'The launcher failed to start.',
  BUSY: 'Busy, try again shortly.',
  UNAVAILABLE: 'Not available.',
  NOT_IMPLEMENTED: 'Not available yet.',
  INTERNAL: 'Something went wrong.',
});

const CODES = Object.freeze(Object.keys(MESSAGES));
const EXTRA_WHITELIST = Object.freeze(['field', 'status', 'errorCode', 'reason', 'usedBy', 'rejected']);

class ZoomError extends Error {
  constructor(code, extra) {
    const c = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : 'INTERNAL';
    super(MESSAGES[c]);
    this.name = 'ZoomError';
    this.code = c;
    this.extra = _pickExtra(extra);
  }
}

function _pickExtra(extra) {
  const out = {};
  if (!extra || typeof extra !== 'object') return out;
  for (const k of EXTRA_WHITELIST) {
    if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
    const v = extra[k];
    if (v === undefined) continue;
    // Only plain scalar values (and arrays of {name, code} for `rejected`) pass.
    if (k === 'rejected') {
      if (Array.isArray(v)) out.rejected = v.map((r) => ({ name: r && typeof r.name === 'string' ? r.name : '', code: r && typeof r.code === 'string' ? r.code : 'INTERNAL' }));
      continue;
    }
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** toResult(e) -> {ok:false, code, ...whitelistedExtra}; anything not a ZoomError -> {ok:false, code:'INTERNAL'}. */
function toResult(e) {
  if (e instanceof ZoomError) return Object.assign({ ok: false, code: e.code }, _pickExtra(e.extra));
  return { ok: false, code: 'INTERNAL' };
}

/** fail(code, extra) -> plain {ok:false, code, ...extra} result (same whitelist, no throw). */
function fail(code, extra) {
  return toResult(new ZoomError(code, extra));
}

module.exports = { ZoomError, toResult, fail, MESSAGES, CODES, EXTRA_WHITELIST };
