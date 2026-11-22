'use strict';
/**
 * src/aperia/seen-store.js — the alert watcher's seen issue ids on disk (<dataDir>/aperia_seen_alerts.json).
 *
 *   load(now)  -> Map(id -> firstSeenMs): entries older than C.SEEN_MAX_AGE_MS dropped, newest C.SEEN_MAX kept,
 *                 ids must match /^[A-Za-z0-9_-]{1,64}$/. Missing or corrupt file -> empty Map. Never throws.
 *   save(map)  -> boolean. Atomic: writes <file>.tmp then renames. Contents { version:1, ids:{ [id]: ms } }.
 *   filePath() -> the absolute file path (tests).
 *
 * Holds issue ids and first-seen times only; written directly (not through src/store/index.js).
 */
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function filePath() { return path.join(require('../config/paths').getDataDir(), C.SEEN_FILE); }

/** _trim(entries, now) -> [[id, ms]] valid, not older than SEEN_MAX_AGE_MS, newest SEEN_MAX. */
function _trim(entries, now) {
  const cutoff = now - C.SEEN_MAX_AGE_MS;
  const out = [];
  for (const [id, ms] of entries) {
    if (typeof id !== 'string' || !ID_RE.test(id)) continue;
    const t = Number(ms);
    if (!Number.isFinite(t) || t < cutoff) continue;
    out.push([id, t]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.length > C.SEEN_MAX ? out.slice(0, C.SEEN_MAX) : out;
}

function load(now) {
  const n = Number.isFinite(now) ? now : Date.now();
  let text;
  try { text = fs.readFileSync(filePath(), 'utf8'); } catch (_) { return new Map(); }
  const p = safeJson(text);
  const ids = p.ok && p.value && typeof p.value === 'object' && p.value.ids && typeof p.value.ids === 'object' && !Array.isArray(p.value.ids)
    ? p.value.ids : null;
  if (!ids) { log.warn('[aperia] seen-store load', { code: 'APERIA_SEEN_CORRUPT' }); return new Map(); }
  return new Map(_trim(Object.entries(ids), n));
}

function save(map, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  const entries = _trim(map instanceof Map ? map.entries() : [], n);
  const ids = {};
  for (const [id, ms] of entries) ids[id] = ms;
  const file = filePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ids }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log.warn('[aperia] seen-store save', { code: 'APERIA_SEEN_WRITE_FAILED', err: safeErr(e) });
    return false;
  }
}

module.exports = { load, save, filePath, ID_RE };
