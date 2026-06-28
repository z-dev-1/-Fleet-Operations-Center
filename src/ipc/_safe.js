'use strict';
/**
 * ipc/_safe.js — Uniform IPC handler wrapper
 *
 * Provides:
 *   safeIPC(channel, fn)  → wrapped async fn suitable for ipcMain.handle()
 *   handle(channel, fn)   → registers the handler in one call
 *   timeoutAfter(ms, msg) → promise that rejects with TimeoutError after ms
 *
 * Rules:
 *   - FleetError subclasses  → logged at WARN, returned as { ok:false, error, code }
 *   - Unknown errors         → logged at ERROR, returned as { ok:false, error, code:'INTERNAL_ERROR' }
 *   - Never throws across the IPC bridge — Electron serialises thrown errors
 *     poorly and the renderer receives an opaque "Error invoking remote method" string.
 *
 * Usage:
 *   const { handle, timeoutAfter } = require('./_safe');
 *   const { ConfigError }          = require('../utils/errors');
 *
 *   handle('notes:save-unit', async (_e, payload) => {
 *     if (!payload?.equipmentId) throw new ConfigError('equipmentId required', 'equipmentId');
 *     // ... handler body
 *   });
 *
 *   // Long-running op with timeout
 *   handle('orcha:deep-process', async (_e, unitIds) => {
 *     return Promise.race([
 *       runDeepScan(unitIds),
 *       timeoutAfter(120_000, 'orcha:deep-process timed out'),
 *     ]);
 *   });
 */

const { FleetError, TimeoutError } = require('../utils/errors');
const logger = require('../utils/logger')('ipc:safe');

// ── Core wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps an async ipcMain handler function.
 * Returns a new async function; does NOT register it — call ipcMain.handle() yourself,
 * or use the handle() convenience below.
 *
 * @param {string}   channel  IPC channel name (used only in log lines)
 * @param {Function} fn       async (event, ...args) => result
 * @returns {Function}        async (event, ...args) => result | { ok:false, error, code }
 */
function safeIPC(channel, fn) {
  return async function safeHandler(event, ...args) {
    try {
      return await fn(event, ...args);
    } catch (err) {
      if (err instanceof FleetError) {
        // Expected typed errors — WARN level, structured context
        logger.warn(
          `[${channel}] ${err.name}: ${err.message}`,
          err.context || {}
        );
        return { ok: false, error: err.message, code: err.code };
      }
      // Unexpected errors — full stack at ERROR level
      logger.error(
        `[${channel}] Unhandled ${err.name || 'Error'}: ${err.message}`,
        err.stack || '(no stack)'
      );
      return { ok: false, error: err.message, code: 'INTERNAL_ERROR' };
    }
  };
}

// ── Registration convenience ──────────────────────────────────────────────

/**
 * Register an ipcMain handler wrapped in safeIPC.
 * Equivalent to: ipcMain.handle(channel, safeIPC(channel, fn))
 *
 * @param {string}   channel
 * @param {Function} fn
 */
function handle(channel, fn) {
  const { ipcMain } = require('electron');
  ipcMain.handle(channel, safeIPC(channel, fn));
}

// ── Timeout promise ───────────────────────────────────────────────────────

/**
 * Returns a promise that rejects with a TimeoutError after `ms` milliseconds.
 * Use with Promise.race() to bound long-running operations.
 *
 * @param {number} ms      Timeout in milliseconds
 * @param {string} [label] Optional label for the TimeoutError message
 * @returns {Promise<never>}
 *
 * @example
 *   return Promise.race([
 *     runOrchaDeepScan(targets, opts),
 *     timeoutAfter(120_000, 'orcha:deep-process'),
 *   ]);
 */
function timeoutAfter(ms, label) {
  return new Promise((_resolve, reject) => {
    const id = setTimeout(() => {
      reject(new TimeoutError(
        label ? `${label} timed out after ${ms}ms` : `Operation timed out after ${ms}ms`,
        ms
      ));
    }, ms);
    // Allow Node to exit cleanly if this is the only pending handle
    if (id.unref) id.unref();
  });
}

// ── Input validators ─────────────────────────────────────────────────────
// Thin helpers used across handlers — keeps validation one-liners.
// All throw ConfigError on failure (caught by safeIPC automatically).

const { ConfigError } = require('../utils/errors');

/** Assert value is a non-empty string. Throws ConfigError otherwise. */
function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${fieldName} must be a non-empty string`, fieldName);
  }
  return value.trim();
}

/** Assert value is a string and cap its length. Throws ConfigError if over limit. */
function requireStringMax(value, fieldName, maxLen) {
  const str = requireString(value, fieldName);
  if (str.length > maxLen) {
    throw new ConfigError(
      `${fieldName} exceeds maximum length of ${maxLen} characters (got ${str.length})`,
      fieldName
    );
  }
  return str;
}

/** Assert value is a non-empty array. Throws ConfigError otherwise. */
function requireArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${fieldName} must be a non-empty array`, fieldName);
  }
  return value;
}

/** Assert array length does not exceed cap. Throws ConfigError otherwise. */
function requireArrayMax(value, fieldName, maxLen) {
  const arr = requireArray(value, fieldName);
  if (arr.length > maxLen) {
    throw new ConfigError(
      `${fieldName} exceeds maximum batch size of ${maxLen} (got ${arr.length})`,
      fieldName
    );
  }
  return arr;
}

/** Assert value is a plain object (not null, not array). Throws ConfigError otherwise. */
function requireObject(value, fieldName) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${fieldName} must be a plain object`, fieldName);
  }
  return value;
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  safeIPC,
  handle,
  timeoutAfter,
  // Validators — re-exported so handlers only need one import
  requireString,
  requireStringMax,
  requireArray,
  requireArrayMax,
  requireObject,
};
