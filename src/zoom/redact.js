'use strict';
/**
 * src/zoom/redact.js — log-safe helpers. Never returns an error message, URL, header value or body.
 */
const crypto = require('crypto');

/** keyHash(key) -> first 8 hex chars of sha256(key). */
function keyHash(key) {
  return crypto.createHash('sha256').update(String(key == null ? '' : key)).digest('hex').slice(0, 8);
}

/** safeErr(e) -> {name, code} only (net/fs/URL messages can embed URLs, paths or body text). */
function safeErr(e) {
  const name = e && typeof e.name === 'string' ? e.name.slice(0, 40) : (e === null || e === undefined ? 'null' : typeof e);
  const code = e && (typeof e.code === 'string' || typeof e.code === 'number') ? String(e.code).slice(0, 40) : undefined;
  return code === undefined ? { name } : { name, code };
}

function _typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** shapeOf(obj, depth=2) -> key names and types only (values never included). */
function shapeOf(obj, depth) {
  const d = depth === undefined ? 2 : depth;
  const t = _typeOf(obj);
  if (t === 'array') {
    const first = obj.length ? obj[0] : undefined;
    return d > 0 && first !== undefined ? { type: 'array', length: obj.length, item: shapeOf(first, d - 1) } : { type: 'array', length: obj.length };
  }
  if (t !== 'object') return t;
  if (d <= 0) return 'object';
  const out = {};
  for (const k of Object.keys(obj).slice(0, 40)) {
    const safeKey = String(k).replace(/[^A-Za-z0-9_$-]/g, '_').slice(0, 40);
    out[safeKey] = shapeOf(obj[k], d - 1);
  }
  return out;
}

module.exports = { keyHash, safeErr, shapeOf };
