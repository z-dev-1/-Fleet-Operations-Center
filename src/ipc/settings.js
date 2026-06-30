'use strict';
/**
 * ipc/settings.js - Domicile settings IPC handlers
 * settings:get-domiciles, settings:save-domiciles, settings:reset-domiciles,
 * settings:get-all, settings:save
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #6  MED: settings:save rejects reserved internal keys; key format
 *                    is validated (alphanumeric + _ + : only, max 64 chars).
 *   - Issue #16 LOW: settings:save-domiciles compares new list to current before
 *                    writing/rescanning — no-op if unchanged.
 *   - All handlers migrated to handle() wrapper.
 */

const store   = require('../store');
const logger  = require('../utils/logger')('ipc:settings');
const { DEFAULTS } = require('../config/defaults');
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require('../utils/errors');

// ── Issue #6: reserved internal keys ────────────────────────────────────────
// The renderer must not overwrite these — they are managed by main-process code only.
const RESERVED_SETTINGS_KEYS = new Set([
  'domiciles',          // managed by settings:save-domiciles
  '_version',
  '_migration',
  '_setupComplete',
  '_firstLaunch',
  '_lastSync',
  '_schemaVersion',
  'operators',        // managed by settings:save-operators
]);

const SETTINGS_KEY_RE = /^[A-Za-z0-9_:]{1,64}$/;

function _validateSettingsKey(key) {
  requireString(key, 'key');
  if (!SETTINGS_KEY_RE.test(key)) {
    throw new ConfigError(
      'settings key contains invalid characters (allowed: A-Z a-z 0-9 _ :, max 64 chars)',
      'key'
    );
  }
  if (RESERVED_SETTINGS_KEYS.has(key)) {
    throw new ConfigError('settings key is reserved and cannot be modified via settings:save: ' + key, 'key');
  }
}

function registerSettingsIPC(ctx) {
  handle('settings:get-domiciles', () => {
    const s = store.load('settings', {});
    return s.domiciles || DEFAULTS.DEFAULT_DOMICILES || [];
  });

  // Issue #16: skip write and rescan when list is unchanged
  handle('settings:save-domiciles', (_e, domiciles) => {
    const clean = (domiciles || [])
      .map(d => String(d).trim().toUpperCase())
      .filter(d => d.length > 0);
    if (!clean.length) throw new ConfigError('domicile list cannot be empty', 'domiciles');

    const s       = store.load('settings', {});
    const current = (s.domiciles || []).slice().sort().join(',');
    const next    = clean.slice().sort().join(',');

    if (current === next) {
      logger.info('Domiciles unchanged — skipping rescan');
      return { ok: true, domiciles: clean, changed: false };
    }

    s.domiciles = clean;
    store.save('settings', s);
    logger.info('Domiciles saved:', clean, '- triggering rescan');
    if (ctx.triggerRescan) ctx.triggerRescan(true);
    return { ok: true, domiciles: clean, changed: true };
  });

  handle('settings:reset-domiciles', () => {
    const s = store.load('settings', {});
    delete s.domiciles;
    store.save('settings', s);
    if (ctx.triggerRescan) ctx.triggerRescan(true);
    return { ok: true, domiciles: DEFAULTS.DEFAULT_DOMICILES || [] };
  });

  handle('settings:get-all', () => {
    return store.load('settings', {});
  });

  // Issue #6: key validated and checked against reserved set before any write
  handle('settings:save', (_e, key, value) => {
    _validateSettingsKey(key);
    const s  = store.load('settings', {});
    s[key]   = value;
    store.save('settings', s);
    logger.info('Setting saved:', key);
    return { ok: true };
  });
  // ── Operator configs ──────────────────────────────────────────────────────
  // Stored under the key 'operators' in the settings store.
  // Shape: Array<{ code: string, domicile: string, to: string, cc: string, spUrl: string, atsUrl: string }>
  handle('settings:get-operators', () => {
    const s = store.load('settings', {});
    return Array.isArray(s.operators) ? s.operators : [];
  });

  handle('settings:save-operators', (_e, operators) => {
    if (!Array.isArray(operators)) {
      throw new ConfigError('operators must be an array', 'operators');
    }
    // Sanitise each entry — only allow known shape keys
    const ALLOWED = new Set(['code', 'domicile', 'to', 'cc', 'spUrl', 'atsUrl']);
    const clean = operators.map(function (op) {
      if (!op || typeof op !== 'object') return null;
      const entry = {};
      ALLOWED.forEach(function (k) {
        if (typeof op[k] === 'string') entry[k] = op[k].trim();
      });
      if (!entry.code) return null;       // skip entries with no code
      return entry;
    }).filter(Boolean);

    const s = store.load('settings', {});
    s.operators = clean;
    store.save('settings', s);
    logger.info('Operators saved:', clean.length, 'entries');
    return { ok: true, count: clean.length };
  });



  logger.info('Settings IPC handlers registered');
}

module.exports = { registerSettingsIPC };
