// src/window/api-load-guard.js
// Single-flight guard for the API fleet build (_loadFleetViaApiStartup in
// window/index.js), extracted so it can be unit-tested without Electron.
//
// Only one build runs at a time; a request that arrives while one is in flight
// is coalesced into ONE trailing follow-up. Watchdog: if the in-flight build is
// older than maxAgeMs it is treated as stuck and the next request SUPERSEDES it
// (new generation token). The superseded build's eventual release() is a no-op,
// so it cannot clear the new build's flag or run the new build's follow-up.
//
// Note: superseding does not cancel the stuck build. If it is blocked on the
// aap_api lock, the new build can only progress once that lock is released
// (aap_api bounds every page evaluate with AAP_API_TIMEOUT for that reason).
'use strict';

const API_LOAD_MAX_AGE_MS = 10 * 60 * 1000;

function createApiLoadGuard({ maxAgeMs = API_LOAD_MAX_AGE_MS, now = Date.now } = {}) {
  let busy = false;
  let startedAt = 0;
  let token = 0;          // current generation; bumped on every start
  let pending = null;     // reason for the one coalesced follow-up

  function noteRequested(reason) { pending = reason || 'coalesced'; }

  function tryStart(reason) {
    if (busy) {
      const ageMs = now() - startedAt;
      if (ageMs < maxAgeMs) {
        noteRequested(reason);
        return { started: false, stale: false };
      }
      token += 1;
      startedAt = now();
      return { started: true, token, superseded: true, ageMs };
    }
    busy = true;
    token += 1;
    startedAt = now();
    return { started: true, token, superseded: false };
  }

  function release(t) {
    if (!busy || t !== token) return { released: false, pending: null };
    busy = false;
    startedAt = 0;
    const p = pending;
    pending = null;
    return { released: true, pending: p };
  }

  return {
    tryStart,
    release,
    noteRequested,
    isCurrent: (t) => busy && t === token,
    isBusy: () => busy,
    snapshot: () => ({ busy, startedAt, token, pending }),
  };
}

module.exports = { createApiLoadGuard, API_LOAD_MAX_AGE_MS };
