/**
 * credentials.js — Encrypted credential storage using Electron safeStorage
 *
 * All sensitive values (Slack token, email password, SP session cookies,
 * Bedrock keys, etc.) are encrypted at rest using the OS keychain.
 *
 * API:
 *   await creds.set('slack.token', 'xoxc-...');
 *   const token = await creds.get('slack.token');   // null if not set
 *   await creds.delete('slack.token');
 *   await creds.list();   // returns array of keys (values never exposed)
 *
 * Storage: single encrypted JSON file at P.credentialsStore
 * Encryption: Electron safeStorage (AES-256 via OS keychain on Windows/Mac)
 *
 * Migration: reads legacy plaintext JSON files on first run and imports them.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('credentials');

const { P } = require('../config/paths');

let _cache  = null;  // in-memory cache to avoid repeated decrypt calls

function _getSafeStorage() {
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    logger.warn('safeStorage encryption NOT available — falling back to base64 (not secure)');
    return null;
  }
  return safeStorage;
}

function _encrypt(value) {
  const ss = _getSafeStorage();
  if (!ss) return Buffer.from(value, 'utf8').toString('base64');
  return ss.encryptString(value).toString('base64');
}

function _decrypt(encoded) {
  const ss = _getSafeStorage();
  if (!ss) return Buffer.from(encoded, 'base64').toString('utf8');
  return ss.decryptString(Buffer.from(encoded, 'base64'));
}

function _loadStore() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(P.credentialsStore)) {
      _cache = JSON.parse(fs.readFileSync(P.credentialsStore, 'utf8'));
      return _cache;
    }
  } catch (e) {
    logger.warn('Credential store load error:', e.message);
  }
  _cache = {};
  return _cache;
}

function _saveStore(store) {
  const dir = path.dirname(P.credentialsStore);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(P.credentialsStore, JSON.stringify(store, null, 2), { mode: 0o600 });
  _cache = store;
}

// ── Public API ────────────────────────────────────────────────────────────

async function set(key, value) {
  const store = _loadStore();
  store[key]  = _encrypt(String(value));
  _saveStore(store);
  logger.debug('Credential set:', key);
}

async function get(key) {
  const store = _loadStore();
  if (!(key in store)) return null;
  try {
    return _decrypt(store[key]);
  } catch (e) {
    logger.warn('Credential decrypt failed for', key, ':', e.message);
    return null;
  }
}

async function del(key) {
  const store = _loadStore();
  delete store[key];
  _saveStore(store);
  logger.debug('Credential deleted:', key);
}

function list() {
  return Object.keys(_loadStore());
}

function clear() {
  _saveStore({});
  logger.info('All credentials cleared');
}

/**
 * migrate(legacyPath, keyMap) — one-time import from old plaintext JSON
 * keyMap: { jsonField: 'credential.key.name' }
 * Example: migrate(P.oldSlackConfig, { token: 'slack.token', cookieHeader: 'slack.cookie' })
 */
async function migrate(legacyFilePath, keyMap) {
  try {
    if (!fs.existsSync(legacyFilePath)) return;
    const data = JSON.parse(fs.readFileSync(legacyFilePath, 'utf8'));
    let count = 0;
    for (const [jsonField, credKey] of Object.entries(keyMap)) {
      if (data[jsonField]) {
        await set(credKey, data[jsonField]);
        count++;
      }
    }
    logger.info(`Migrated ${count} credentials from ${path.basename(legacyFilePath)}`);
  } catch (e) {
    logger.warn('Credential migration failed:', e.message);
  }
}

module.exports = { set, get, delete: del, list, clear, migrate };
