'use strict';
/**
 * email-intel/flags.js — process-memoized Email Triage Intelligence flags.
 *
 *   get()      -> { enabled, capture, ..., effective:{capture,multiRecipient,timelineWrites,
 *                  actionsView,threadReplies,attachments}, warnings:[] }
 *   engaged()  -> effective.capture (the master switch for the whole module)
 *   apiTransport() -> apiTransportEffective (Outlook REST transport; outside the six-key effective block)
 *   _setForTests(obj|null)
 *
 * The value is read once per process (restart to change), like the other
 * perf-flags consumers. Legacy hooks call these inside their own try/catch that
 * returns false, so a failure here always means legacy behavior.
 */
const perfFlags = require('../config/perf-flags');

let _memo = null;

function get() {
  if (!_memo) _memo = perfFlags.loadEmailIntel();
  return _memo;
}

function engaged() {
  return get().effective.capture === true;
}

/**
 * _setForTests(null)             -> clear the memo (next get() re-reads settings/env)
 * _setForTests({ ...raw flags }) -> resolved through the real dependency chain
 *                                   (e.g. { enabled:true, capture:true, multiRecipient:true })
 * _setForTests({ effective:{..}}) -> used as given (missing effective keys are false)
 */
function _setForTests(obj) {
  if (obj == null) { _memo = null; return; }
  if (obj.effective && typeof obj.effective === 'object') {
    const eff = {};
    for (const k of ['capture', 'multiRecipient', 'timelineWrites', 'actionsView', 'threadReplies', 'attachments']) eff[k] = obj.effective[k] === true;
    _memo = Object.assign({ enabled: eff.capture, warnings: [] }, obj, { effective: eff });
    // Outlook REST transport: read from the effective block given, but kept out of `effective` (six keys).
    _memo.apiTransportEffective = obj.effective.apiTransport === true && eff.capture;
    _memo.apiTransport = _memo.apiTransportEffective;
    return;
  }
  _memo = perfFlags.resolveEmailIntelFlags({ email: { intel: obj } }, {});
}

/** apiTransport(): the Outlook REST transport is effective (capture && apiTransport). Any failure -> false. */
function apiTransport() {
  try { return get().apiTransportEffective === true; } catch (_) { return false; }
}

module.exports = { get, engaged, apiTransport, _setForTests };
