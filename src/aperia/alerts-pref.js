'use strict';
/**
 * src/aperia/alerts-pref.js — the user's Tire Alerts on/off choice on disk (<dataDir>/aperia_alerts_pref.json).
 *
 *   load()          -> { enabled } (missing or corrupt file -> enabled:true: alerts are on by default). Never throws.
 *   save(enabled)   -> boolean. Atomic: writes <file>.tmp then renames. Contents { version:1, enabled }.
 *   filePath()      -> the absolute file path (tests).
 *
 * Written only by the start/stop alerts IPC (the user's toggle); holds one boolean.
 */
const fs = require('fs');
const path = require('path');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const FILE = 'aperia_alerts_pref.json';

function filePath() { return path.join(require('../config/paths').getDataDir(), FILE); }

function load() {
  let text;
  try { text = fs.readFileSync(filePath(), 'utf8'); } catch (_) { return { enabled: true }; }
  const p = safeJson(text);
  if (!p.ok || !p.value || typeof p.value !== 'object' || typeof p.value.enabled !== 'boolean') {
    log.warn('[aperia] alerts-pref load', { code: 'APERIA_PREF_CORRUPT' });
    return { enabled: true };
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
    log.warn('[aperia] alerts-pref save', { code: 'APERIA_PREF_WRITE_FAILED', err: safeErr(e) });
    return false;
  }
}

module.exports = { load, save, filePath };
