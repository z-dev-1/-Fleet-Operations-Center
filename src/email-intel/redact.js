'use strict';
/**
 * email-intel/redact.js — logging redaction helpers (design 1.4).
 *
 * Rules for every module under src/email-intel: log counts, short hashed ids,
 * enum outcomes and durations. NEVER log body text, subjects, attachment text,
 * display names or addresses. Dynamic content reaches a logger only through
 * these helpers.
 */
const crypto = require('crypto');

const ADDRESS_RE = /[\w.+-]+@[\w.-]+/g;

/** rid(x): short, stable, non-reversible id for logs (sha1 prefix, 8 hex chars). */
function rid(x) {
  return crypto.createHash('sha1').update(String(x == null ? '' : x)).digest('hex').slice(0, 8);
}

/**
 * safeErr(e): `Name:code` plus at most 120 chars of the message with address
 * patterns replaced by `[addr]`. Long digit runs are kept (unit ids are not sensitive).
 */
function safeErr(e) {
  if (e == null) return 'Error:';
  const name = (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error';
  const code = (e && typeof e === 'object' && e.code != null) ? String(e.code) : '';
  const raw = (e && typeof e === 'object') ? e.message : e;
  const msg = String(raw == null ? '' : raw).slice(0, 120).replace(ADDRESS_RE, '[addr]');
  return name + ':' + code + (msg ? ' ' + msg : '');
}

/** errName(e): `Name:code` only, no message (for errors that may echo email-derived text, e.g. timeline writes). */
function errName(e) {
  const name = (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error';
  const code = (e && typeof e === 'object' && e.code != null) ? String(e.code) : '';
  return (name + ':' + code).replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 60);
}

/** maskAddress('jane@corp.test') -> 'j***@corp.test' (probe output only, never logs). */
function maskAddress(addr) {
  const s = String(addr == null ? '' : addr).trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}

/** Confirmation tokens are logged by their first 4 hex chars only; anything else (renderer-supplied junk) logs as '----'. */
function tokenTag(token) {
  const m = /^[0-9a-f]{4}/.exec(String(token == null ? '' : token));
  return m ? m[0] : '----';
}

module.exports = { rid, safeErr, errName, maskAddress, tokenTag };
