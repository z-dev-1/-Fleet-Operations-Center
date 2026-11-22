'use strict';
/**
 * src/aperia/redact.js — log-safe helpers (shared keyHash/safeErr/shapeOf from src/zoom/redact.js) plus
 * Aperia scrubbers. Never returns the REST Bearer, the WebSocket x-authorization JWT, cookies, or contact
 * PII (emails, phone numbers, person names in contact blocks).
 */
const { keyHash, safeErr, shapeOf } = require('../zoom/redact');

const R = '<redacted>';
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const XAUTH_RE = /(x-authorization["']?\s*[=:]\s*["']?)[^&\s"'#,;)}]+/gi;
const COOKIE_RE = /\b((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Separated North-American numbers (555-123-4567, (555) 123-4567, +1 555.123.4567) and E.164 (+15551234567).
// ISO dates/times (4-2-2) and plain integer ids never match.
const PHONE_RE = /(?<![\w.])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w])|(?<![\w])\+\d{10,15}(?![\w])/g;

// Keys whose value is always dropped (auth material and contact PII). `name` alone is business data
// (account.name = domicile), so only person-name keys are listed.
const SENSITIVE_KEY_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-authorization|token|access_?token|id_?token|refresh_?token|oidc\w*|jwt|bearer|password|passwd|secret|client_?secret|api_?key|e-?mail\w*|phone\w*|mobile\w*|cell\w*|fax|first_?name|last_?name|full_?name|display_?name|contacts?|contact_?\w+|managers?|mfa\w*)$/i;

/** redactText(s, secrets?) -> s with secrets, Bearer, x-authorization, cookies, JWTs, emails and phones replaced. */
function redactText(s, secrets) {
  let t = String(s == null ? '' : s);
  for (const x of Array.isArray(secrets) ? secrets : []) {
    if (typeof x === 'string' && x.length >= 6 && t.includes(x)) t = t.split(x).join(R);
  }
  return t
    .replace(BEARER_RE, 'Bearer ' + R)
    .replace(XAUTH_RE, '$1' + R)
    .replace(COOKIE_RE, '$1' + R)
    .replace(JWT_RE, R)
    .replace(EMAIL_RE, '<email>')
    .replace(PHONE_RE, '<phone>');
}

/** redactDeep(value, secrets?) -> deep copy; sensitive keys -> '<redacted>', every string through redactText. */
function redactDeep(v, secrets, depth) {
  const d = depth || 0;
  if (typeof v === 'string') return redactText(v, secrets);
  if (!v || typeof v !== 'object') return v;
  if (d > 40) return '<deep>';
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets, d + 1));
  const o = {};
  for (const k of Object.keys(v)) {
    const key = redactText(k, secrets);
    o[key] = SENSITIVE_KEY_RE.test(k) && v[k] != null && v[k] !== '' && typeof v[k] !== 'boolean' ? R : redactDeep(v[k], secrets, d + 1);
  }
  return o;
}

/** redactUrl(url) -> origin + path with query VALUES dropped ('?page&size'); '' when unparseable. */
function redactUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const names = Array.from(new Set(Array.from(u.searchParams.keys()))).map((k) => redactText(k).slice(0, 60));
    return u.protocol + '//' + u.host + redactText(u.pathname) + (names.length ? '?' + names.join('&') : '');
  } catch (_) {
    return '';
  }
}

/** pathPattern(pathname) -> pathname with numeric / uuid / long-id segments as {id}. */
function pathPattern(pathname) {
  return String(pathname || '').split('/').map((seg) => (
    /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || (/\d/.test(seg) && /^[A-Za-z0-9_-]{16,}$/.test(seg)) ? '{id}' : seg
  )).join('/').slice(0, 200);
}

module.exports = { keyHash, safeErr, shapeOf, redactText, redactDeep, redactUrl, pathPattern, SENSITIVE_KEY_RE };
