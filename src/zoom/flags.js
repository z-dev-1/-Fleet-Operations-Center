'use strict';
/**
 * src/zoom/flags.js — memoized Zoom flags (read once per process; a restart is needed to change them).
 * get() memoizes perf-flags.loadZoom(); the IPC hub primes it with the flags it resolved.
 */
let _memo = null;

function get() {
  if (!_memo) _memo = require('../config/perf-flags').loadZoom();
  return _memo;
}

/** _prime(flags) — set the memo once (no-op when already set). */
function _prime(flags) {
  if (!_memo && flags && typeof flags === 'object') _memo = flags;
}

/** _setForTests(flags|null) — replace or clear the memo. */
function _setForTests(flags) {
  _memo = flags || null;
}

module.exports = { get, _prime, _setForTests };
