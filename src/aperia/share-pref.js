'use strict';
/**
 * src/aperia/share-pref.js — the user's "Share underinflation alerts" on/off choice on disk
 * (<dataDir>/aperia_share_pref.json). Same pattern as alerts-pref.js, but OFF by default.
 *
 *   load()          -> { enabled } (missing or corrupt file -> enabled:false: sharing is off by default). Never throws.
 *   save(enabled)   -> boolean. Atomic: writes <file>.tmp then renames. Contents { version:1, enabled }.
 *   filePath()      -> the absolute file path (tests).
 *
 * Written only by the user's share toggle; holds one boolean.
 */
const fs = require('fs');
const path = require('path');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const FILE = 'aperia_share_pref.json';

function filePath() { return path.join(require('../config/paths').getDataDir(), FILE); }

function load() {
  let text;
  try { text = fs.readFileSync(filePath(), 'utf8'); } catch (_) { return { enabled: false }; }
  const p = safeJson(text);
  if (!p.ok || !p.value || typeof p.value !== 'object' || typeof p.value.enabled !== 'boolean') {
    log.warn('[aperia] share-pref load', { code: 'APERIA_PREF_CORRUPT' });
    return { enabled: false };
  }
  return { enabled: p.value.enabled };
}

function save(enabled) {
  const file = filePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, enabled: enabled === true }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log.warn('[aperia] share-pref save', { code: 'APERIA_PREF_WRITE_FAILED', err: safeErr(e) });
    return false;
  }
}

module.exports = { load, save, filePath };
