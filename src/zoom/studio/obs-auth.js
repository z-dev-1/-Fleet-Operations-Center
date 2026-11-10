'use strict';
/**
 * src/zoom/studio/obs-auth.js — pure helpers for the OBS integration (design §4.2).
 *
 * Requires only crypto + path (never child_process, fs or electron), so validate.js can use
 * exeSyntaxOk without loading anything that spawns.
 *
 *   authString(pw, salt, challenge) -> b64(sha256(b64(sha256(pw + salt)) + challenge))  (obs-websocket v5)
 *   closeCodeToError(code)          -> 'OBS_AUTH_FAILED' (4009) | 'OBS_UNSUPPORTED' (4010) | 'OBS_CLOSED'
 *   isRefused(e)                    -> true for ECONNREFUSED, incl. the AggregateError.errors[0] form
 *   exeSyntaxOk(p)                  -> absolute, not UNC, <= 260 chars, no NUL, basename obs64.exe
 *   hasUuidSupport(v)               -> obs-websocket >= 5.3 (sceneUuid / inputUuid exist)
 */
const crypto = require('crypto');
const path = require('path');

const MAX_PATH = 260;
const EXE_NAME = 'obs64.exe';

function _b64sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('base64');
}

function authString(pw, salt, challenge) {
  return _b64sha256(_b64sha256(String(pw) + String(salt)) + String(challenge));
}

function closeCodeToError(code) {
  if (code === 4009) return 'OBS_AUTH_FAILED';
  if (code === 4010) return 'OBS_UNSUPPORTED';
  return 'OBS_CLOSED';
}

function isRefused(e) {
  return !!e && (e.code === 'ECONNREFUSED' || (Array.isArray(e.errors) && !!e.errors[0] && e.errors[0].code === 'ECONNREFUSED'));
}

function exeSyntaxOk(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > MAX_PATH) return false;
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;   // UNC or device path
  if (!path.win32.isAbsolute(p)) return false;
  return path.win32.basename(p).toLowerCase() === EXE_NAME;
}

/** F10: numeric major.minor compare; anything unparseable -> false. */
function hasUuidSupport(v) {
  const [M, m] = String(v).split('.').map(Number);
  if (!Number.isFinite(M)) return false;
  return M > 5 || (M === 5 && m >= 3);   // NaN minor -> false for 5.x
}

module.exports = { authString, closeCodeToError, isRefused, exeSyntaxOk, hasUuidSupport, MAX_PATH, EXE_NAME };
