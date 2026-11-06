'use strict';
/**
 * email-intel/reliability/lock.js — single-flight for mailbox scans (design 8.3, R8.2, AC-3).
 *
 *   run(trigger, fn) -> Promise<{ skipped:'busy' } | { coalesced:boolean, value }>
 *
 *  - 'manual' / 'chat': joins a scan that is already running (coalesced:true, same value) or starts one;
 *  - 'scheduled': skips when a scan is running ({ skipped:'busy' });
 *  - always released in a finally (a throwing scan never leaves the lock held);
 *  - independent of the Slack comms mode: the lock lives inside runIntelScan, which runTriage calls first,
 *    so the chat path (ai.js calling runTriage directly) is covered without editing it.
 */
let _inFlight = null;   // { promise, trigger, startedAt }

function isBusy() { return _inFlight !== null; }
function current() { return _inFlight ? { trigger: _inFlight.trigger, startedAt: _inFlight.startedAt } : null; }

async function run(trigger, fn) {
  const t = trigger === 'scheduled' ? 'scheduled' : 'manual';
  if (_inFlight) {
    if (t === 'scheduled') return { skipped: 'busy' };
    const value = await _inFlight.promise;
    return { coalesced: true, value };
  }
  const entry = { trigger: t, startedAt: Date.now(), promise: null };
  entry.promise = (async () => fn())();
  _inFlight = entry;
  try {
    const value = await entry.promise;
    return { coalesced: false, value };
  } finally {
    if (_inFlight === entry) _inFlight = null;
  }
}

function _reset() { _inFlight = null; }

module.exports = { run, isBusy, current, _reset };
