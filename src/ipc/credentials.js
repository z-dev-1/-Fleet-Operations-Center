'use strict';
/**
 * ipc/credentials.js - Site credential manager IPC handlers
 * credentials:list, credentials:has, credentials:set, credentials:get,
 * credentials:save, credentials:delete, credentials:get-for-url
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #1  HIGH: credentials:get returns a presence-only marker — decrypted
 *                     value no longer crosses the IPC bridge to the renderer.
 *   - Issue #14 LOW:  credentials:set / credentials:save reject key names that
 *                     contain path-traversal or shell-special characters.
 *   - All handlers migrated to handle() wrapper from _safe.js
 */

const creds  = require('../security/credentials');
const logger = require('../utils/logger')('ipc:credentials');
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require('../utils/errors');

// ── Issue #14: key format validation ─────────────────────────────────────────
// Allow alphanumerics, dots, hyphens, colons, underscores — nothing else.
// Blocks path traversal (../ \\ /) and shell-injection chars.
const KEY_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function _validateKey(key) {
  requireString(key, 'key');
  if (!KEY_RE.test(key)) {
    throw new ConfigError(
      'credential key contains invalid characters (allowed: A-Z a-z 0-9 . _ : @ -)',
      'key'
    );
  }
}

function registerCredentialIPC() {
  // List all entries (keys only — values never cross the bridge)
  handle('credentials:list', async () => {
    return creds.list();
  });

  // Check if a credential key exists
  handle('credentials:has', async (_e, key) => {
    const all = await creds.list();
    return all.includes(key);
  });

  // Set a credential
  // Issue #14: key validated before write
  handle('credentials:set', async (_e, key, val) => {
    _validateKey(key);
    const value = typeof val === 'string' ? val : JSON.stringify(val);
    await creds.set(key, value);
    logger.info('Credential set:', key);
    return { ok: true };
  });

  // Issue #1: credentials:get — REDACTED.
  // The renderer only learns whether the credential exists, not its value.
  // All code that needs the actual secret must run in main-process via a
  // purpose-built handler (e.g. credentials:get-for-url, slack:login, etc.).
  handle('credentials:get', async (_e, key) => {
    requireString(key, 'key');
    const val = await creds.get(key);
    if (val === null) return null;
    // Return presence marker only — no decrypted data exposed to renderer
    return { exists: true, key };
  });

  // Save a credential entry (structured: {key, value, url?, ...})
  // Issue #14: key validated before write
  handle('credentials:save', async (_e, entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new ConfigError('entry must be a plain object', 'entry');
    }
    _validateKey(entry.key);
    const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    await creds.set(entry.key, value);
    logger.info('Credential saved:', entry.key);
    return { ok: true, key: entry.key };
  });

  // Delete a credential entry
  handle('credentials:delete', async (_e, key) => {
    requireString(key, 'key');
    await creds.delete(key);
    logger.info('Credential deleted:', key);
    return { ok: true };
  });

  // Look up credential by URL hostname — returns entry object for main-process use.
  // Renderer receives only the matching hostname and whether a record was found.
  handle('credentials:get-for-url', async (_e, url) => {
    requireString(url, 'url');
    const all = await creds.list();
    try {
      const target = new URL(url).hostname;
      for (const key of all) {
        const raw = await creds.get(key);
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw);
          if (entry.url) {
            const eHost = new URL(entry.url).hostname;
            if (eHost === target) {
              // Return sanitised subset — no raw password field
              return { exists: true, key, hostname: eHost, label: entry.label || '' };
            }
          }
        } catch (_) { /* not a URL entry */ }
      }
    } catch (_) { /* invalid URL from renderer */ }
    return null;
  });

  logger.info('Credentials IPC handlers registered');
}

module.exports = { registerCredentialIPC };
