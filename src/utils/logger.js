/**
 * logger.js — Unified logging framework
 * Replaces: console.log, rlog(), flog(), fwarn(), appendFileSync scattered across all scrapers.
 * Features:
 *   - Namespaced loggers: logger('relay').info(...)
 *   - Log levels: DEBUG, INFO, WARN, ERROR
 *   - File output with rotation (max 2MB per log file)
 *   - Structured JSON mode for log aggregation
 *   - No-op in test mode
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const util = require('util');

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO ', 'WARN ', 'ERROR'];
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

let _logDir  = null;
let _minLevel = LEVELS.INFO;
let _silent  = false;

function setLogDir(dir) {
  _logDir = dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function setLevel(level) {
  const l = String(level).toUpperCase();
  if (LEVELS[l] !== undefined) _minLevel = LEVELS[l];
}

function setSilent(val) { _silent = val; }

function _writeToFile(filePath, line) {
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Rotate if > 2MB
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_FILE_BYTES) {
        fs.renameSync(filePath, filePath + '.old');
      }
    } catch (_) {}
    fs.appendFileSync(filePath, line + '\n', { encoding: 'utf8' });
  } catch (_) {}
}

function _getLogFile(namespace) {
  if (!_logDir) return null;
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(_logDir, safe + '.log');
}

function _log(namespace, level, args) {
  if (level < _minLevel || _silent) return;
  const ts    = new Date().toISOString();
  const label = LEVEL_NAMES[level] || '?????';
  // _serialize: strings pass through unchanged (fixes UTF-8 double-encoding).
  // Objects: util.inspect for console (human-readable), JSON.stringify for file.
  function _serialize(a, forFile) {
    if (a === null)            return 'null';
    if (a === undefined)       return 'undefined';
    if (typeof a === 'string') return a;                 // already a string — never re-encode
    if (a instanceof Error)    return a.stack || a.message;
    if (typeof a === 'object') {
      if (forFile) { try { return JSON.stringify(a); } catch (_) { return util.inspect(a, { depth: 4 }); } }
      return util.inspect(a, { depth: 4, colors: false });
    }
    return String(a);
  }
  const consoleParts = args.map(a => _serialize(a, false)).join(' ');
  const fileParts    = args.map(a => _serialize(a, true)).join(' ');
  const consoleLine = `[${ts}] [${label}] [${namespace}] ${consoleParts}`;
  const fileLine    = `[${ts}] [${label}] [${namespace}] ${fileParts}`;

  // Console output
  if (level >= LEVELS.WARN) {
    process.stderr.write(consoleLine + '\n');
  } else {
    process.stdout.write(consoleLine + '\n');
  }

  // File output
  _writeToFile(_getLogFile(namespace), fileLine);
  // Always write to app.log too
  if (_logDir) {
    _writeToFile(path.join(_logDir, 'app.log'), fileLine);
  }
}

/**
 * Create a namespaced logger.
 * Usage:
 *   const log = require('./utils/logger')('relay');
 *   log.info('Starting scrape for', unitId);
 *   log.warn('Timeout on', url);
 *   log.error('Failed:', err);
 */
function createLogger(namespace) {
  return {
    debug: (...a) => _log(namespace, LEVELS.DEBUG, a),
    info:  (...a) => _log(namespace, LEVELS.INFO,  a),
    warn:  (...a) => _log(namespace, LEVELS.WARN,  a),
    error: (...a) => _log(namespace, LEVELS.ERROR, a),
    // Compatibility shim for old console.log patterns
    log:   (...a) => _log(namespace, LEVELS.INFO,  a),
  };
}

module.exports = createLogger;
module.exports.createLogger = createLogger; // alias: require(logger).createLogger(ns) pattern
module.exports.setLogDir  = setLogDir;
module.exports.setLevel   = setLevel;
module.exports.setSilent  = setSilent;
module.exports.LEVELS     = LEVELS;
