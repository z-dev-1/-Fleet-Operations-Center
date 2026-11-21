'use strict';
/**
 * src/dtna/redact.js — log-safe helpers (shared with src/zoom/redact.js) plus DTNA tags.
 * Logs carry method names, caseTag, counts, ms, HTTP status, codes and exception type names only.
 */
const { keyHash, safeErr, shapeOf } = require('../zoom/redact');
const { CASE_ID_RE } = require('./constants');

/** caseTag(id) -> last 6 chars of a valid case id, else '------'. */
function caseTag(id) {
  const s = typeof id === 'string' ? id : '';
  return CASE_ID_RE.test(s) ? s.slice(-6) : '------';
}

/** maskEmail(s) -> 'a***@domain' ('' when s is not an email). */
function maskEmail(s) {
  const m = /^\s*([^@\s]+)@([^@\s]+)\s*$/.exec(typeof s === 'string' ? s : '');
  if (!m) return '';
  return m[1].charAt(0) + '***@' + m[2];
}

module.exports = { keyHash, safeErr, shapeOf, caseTag, maskEmail };
