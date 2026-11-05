'use strict';
/**
 * src/auth/auth-report.js — the one accessor for the auth.propagation flag and
 * the reporting entry point used by real traffic (auth.propagation, default OFF).
 *
 *   isEnabled()              memoized flag read (restart to change)
 *   report({ ok, err, source })   -> supervisor.noteApiOutcome   (no-op flag off)
 *   reportStepUp({ source })      -> supervisor.noteStepUpSignal (no-op flag off)
 *   currentStatus()          supervisor.getStatus() when enabled, else null; never throws
 *
 * Cycle rule (F4): the supervisor is required LAZILY inside each function, never
 * at module load, and the supervisor reads isEnabled() at call time. Either
 * module may be required first. No Electron dependency, no cookie values.
 */

let logger; try { logger = require('../utils/logger').createLogger('auth-report'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

let _enabled = null;           // memoized flag (null = not read yet)
let _enabledOverride = null;   // test seam
let _statusOverride;           // test seam: undefined = none; object or function
let _warned = false;

function _sup() { try { return require('./midway-health-supervisor'); } catch (_) { return null; } }

function isEnabled() {
  if (_enabledOverride !== null) return _enabledOverride;
  if (_enabled === null) {
    try { _enabled = require('../config/perf-flags').loadAuthPropagation().enabled === true; }
    catch (_) { _enabled = false; }
  }
  return _enabled;
}

function _warnOnce(where, e) {
  if (_warned) return;
  _warned = true;
  try { logger.warn('[auth-report] ' + where + ' failed: ' + String((e && e.message) || e).slice(0, 200)); } catch (_) {}
}

function report(o) {
  try {
    if (!isEnabled()) return undefined;
    const s = _sup();
    if (s && typeof s.noteApiOutcome === 'function') {
      const x = o || {};
      s.noteApiOutcome({ ok: x.ok, err: x.err, source: x.source });
    }
  } catch (e) { _warnOnce('report', e); }
  return undefined;
}

function reportStepUp(o) {
  try {
    if (!isEnabled()) return undefined;
    const s = _sup();
    if (s && typeof s.noteStepUpSignal === 'function') s.noteStepUpSignal({ source: (o && o.source) || 'unknown' });
  } catch (e) { _warnOnce('reportStepUp', e); }
  return undefined;
}

function currentStatus() {
  try {
    if (!isEnabled()) return null;
    if (_statusOverride !== undefined) {
      const v = typeof _statusOverride === 'function' ? _statusOverride() : _statusOverride;
      return v || null;
    }
    const s = _sup();
    return (s && typeof s.getStatus === 'function') ? (s.getStatus() || null) : null;
  } catch (_) { return null; }
}

// ── Test seams ──────────────────────────────────────────────────────────────
function _setEnabledForTest(v) { _enabledOverride = (typeof v === 'boolean') ? v : null; }
/** Stub what currentStatus() returns while enabled (object, or function returning one). */
function _setStatusForTest(statusOrFn) { _statusOverride = statusOrFn === null ? undefined : statusOrFn; }
function _reset() { _enabled = null; _enabledOverride = null; _statusOverride = undefined; _warned = false; }

module.exports = {
  isEnabled, report, reportStepUp, currentStatus,
  _setEnabledForTest, _setStatusForTest, _reset,
};
