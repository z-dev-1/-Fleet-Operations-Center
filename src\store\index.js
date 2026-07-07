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
  chatHistory:      () => path.join(P.dataDir, 'chat-history.json'),
  repairHistory:    () => path.join(P.dataDir, 'repair-history.json'),
  aapLessons:       () => path.join(P.dataDir, 'aap-lessons.json'),
  offlineQueue:     () => path.join(P.dataDir, 'offline-queue.json'),
  orchaPatterns:    () => path.join(P.dataDir, 'orcha-patterns.json'),
  pins:             () => path.join(P.dataDir, 'pins.json'),
  schedules:        () => path.join(P.dataDir, 'schedules.json'),
  dailyNotesLog:    () => P.dailyNotesLog,
  dailyNotesDec:    () => P.dailyNotesDec,
  setupState:       () => P.setupState,
  asanaConfig:      () => P.asanaConfig,
  asanaAuthState:   () => P.asanaAuthState,
  // Bug B fix: _healthcheck now has a proper registered path instead of
  // relying on the removed absolute-path fallback.
  reminders:             () => path.join(P.dataDir, 'reminders.json'),
  contacts:              () => path.join(P.dataDir, 'contacts.json'),
  partnerWRs_review:    () => path.join(P.dataDir, 'partner_review.json'),
  partnerWRs_scheduled: () => path.join(P.dataDir, 'partner_scheduled.json'),
  partnerWRs_processed: () => path.join(P.dataDir, 'partner_processed.json'),
  partnerFormsConfig:   () => path.join(P.dataDir, 'partner_forms_config.json'),
    _healthcheck:     () => path.join(P.dataDir, '_healthcheck.json'),
  vendorHistory:    () => P.vendorHistory,
  heartbeatState:   () => P.heartbeatState,
  rcaStore:         () => P.rcaStore,
  retentionHistory: () => P.retentionHistory,
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
function load(key, fallback) {
  const filePath = _resolvePath(key);
  if (!fs.existsSync(filePath)) return fallback !== undefined ? fallback : null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback !== undefined ? fallback : null;
    return JSON.parse(raw);
  } catch (e) {
    // Corrupted JSON — try backup
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try { return JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch (_) {}
    }
    console.error('[store] Corrupted file:', filePath, e.message);
    return fallback !== undefined ? fallback : null;
  }
}

/**
 * save(name, data) — atomic write (write to .tmp then rename)
 */
function save(key, data) {
  const filePath = _resolvePath(key);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const tmpPath = filePath + '.tmp';
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // Cleanup temp file on failure
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
