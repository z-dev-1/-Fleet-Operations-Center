/**
 * store/index.js — Unified data store
 * Replaces the scattered load/save functions in cache.js (V-B).
 * All reads and writes go through here — one place, consistent error handling.
 *
 * Usage:
 *   const store = require('./store');
 *   const data  = store.load('fleetData');           // returns {} on missing
 *   store.save('fleetData', { rows: [...] });         // atomic write
 *   store.exists('relayCache');                       // boolean
 *
 * Stage 4 Bug B fix (2026-06-28):
 *   - Removed the absolute-path fallback in _resolvePath().
 *     Previously any caller could pass an absolute path and bypass the registry
 *     entirely — no access control, no path containment.
 *   - Added '_healthcheck' to REGISTRY (was previously exploiting the fallback
 *     via setup:verify-step → store.save('_healthcheck', ...)).
 *   - _resolvePath now throws on any name not in REGISTRY.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('store');
const { P }  = require('../config/paths');

// Registry — maps store name → file path
// ALL legitimate store names must be registered here.
// No fallback for unknown names or absolute paths.
const REGISTRY = {
  fleetData:        () => P.fleetData,
  relayCache:       () => P.relayCache,
  uptakeHash:       () => P.uptakeHash,
  notesStore:       () => P.notesStore,
  settings:         () => P.settings,
  opEmails:         () => P.opEmails,
  aapCache:         () => P.aapCache,
  geofenceCache:    () => P.geofenceCache,
  wrQueue:          () => P.wrQueue,
  spConfig:         () => P.spConfig,
  orchaCorrections: () => P.orcaCorrections,
  orchaVendorRules: () => P.orchaVendorRules,
  orchaConfig:      () => P.orchaConfig,
  dailyNotesSnap:   () => P.dailyNotesSnap,
  dailyNotesLog:    () => P.dailyNotesLog,
  dailyNotesDec:    () => P.dailyNotesDec,
  setupState:       () => P.setupState,
  asanaConfig:      () => P.asanaConfig,
  asanaAuthState:   () => P.asanaAuthState,
  // Bug B fix: _healthcheck now has a proper registered path instead of
  // relying on the removed absolute-path fallback.
  _healthcheck:     () => path.join(P.dataDir, '_healthcheck.json'),
  vendorHistory:    () => P.vendorHistory,
};

function _resolvePath(name) {
  if (REGISTRY[name]) return REGISTRY[name]();
  // Bug B fix: absolute-path fallback removed.
  // If you need a new store, add it to REGISTRY above.
  throw new Error(`Unknown store: "${name}" — add it to REGISTRY in store/index.js`);
}

/**
 * load(name, defaultValue?) — reads and parses JSON, returns default on any error
 */
function load(name, defaultValue = null) {
  const filePath = _resolvePath(name);
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    logger.warn(`store.load(${name}) failed:`, e.message, '— returning default');
    return defaultValue;
  }
}

/**
 * save(name, data) — atomic write (write to .tmp then rename)
 */
function save(name, data) {
  const filePath = _resolvePath(name);
  const tmpPath  = filePath + '.tmp';
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    logger.error(`store.save(${name}) failed:`, e.message);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

/**
 * update(name, mergeFn) — read-modify-write with merge function
 * mergeFn receives current value and returns new value.
 */
function update(name, mergeFn, defaultValue = {}) {
  const current = load(name, defaultValue);
  const updated = mergeFn(current);
  save(name, updated);
  return updated;
}

function exists(name) {
  try { return fs.existsSync(_resolvePath(name)); } catch (_) { return false; }
}

function del(name) {
  try { fs.unlinkSync(_resolvePath(name)); } catch (_) {}
}

module.exports = { load, save, update, exists, delete: del, REGISTRY };
