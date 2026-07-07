/**
 * errors.js — Structured error types and global boundary
 * Provides typed errors for scraper failures, auth failures, etc.
 * Ensures all unhandled rejections are logged and never silently swallowed.
 */

'use strict';

const logger = require('./logger')('errors');

// ── Typed error classes ────────────────────────────────────────────────────

class FleetError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name    = 'FleetError';
    this.code    = code || 'FLEET_ERROR';
    this.context = context;
  }
}

class AuthError extends FleetError {
  constructor(message, context) {
    super(message, 'AUTH_ERROR', context);
    this.name = 'AuthError';
  }
}

class ScraperError extends FleetError {
  constructor(message, scraper, context) {
    super(message, 'SCRAPER_ERROR', { scraper, ...context });
    this.name    = 'ScraperError';
    this.scraper = scraper;
  }
}

class NetworkError extends FleetError {
  constructor(message, url, context) {
    super(message, 'NETWORK_ERROR', { url, ...context });
    this.name = 'NetworkError';
    this.url  = url;
  }
}

class ConfigError extends FleetError {
  constructor(message, field, context) {
    super(message, 'CONFIG_ERROR', { field, ...context });
    this.name  = 'ConfigError';
    this.field = field;
  }
}

class TimeoutError extends FleetError {
  constructor(message, durationMs, context) {
    super(message, 'TIMEOUT_ERROR', { durationMs, ...context });
    this.name       = 'TimeoutError';
    this.durationMs = durationMs;
  }
}

// ── Global error boundary ─────────────────────────────────────────────────

function installGlobalBoundary() {
  process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
    // Do NOT exit — Electron apps should stay alive
  });

  process.on('unhandledRejection', (reason, promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error('UNHANDLED REJECTION:', msg);
    if (reason instanceof Error) logger.error(reason.stack);
  });

  logger.info('Global error boundary installed');
}

// ── Utility: wrap async function with error logging ──────────────────────

function safeAsync(fn, onError) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      logger.error('safeAsync caught:', err.message);
      if (onError) onError(err);
      return null;
    }
  };
}

module.exports = {
  FleetError, AuthError, ScraperError, NetworkError, ConfigError, TimeoutError,
  installGlobalBoundary,
  safeAsync,
};
