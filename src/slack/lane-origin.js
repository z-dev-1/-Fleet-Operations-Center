'use strict';
/**
 * slack/lane-origin.js — origin tag for Slack Web API calls (fair lane).
 *
 * The poller (src/slack/poller.js runPoll) runs each engine inside
 * runWithOrigin(kind, fn). AsyncLocalStorage carries the tag through await,
 * Promise.all and real timers, so slack_send can ask currentOrigin() when a
 * call is enqueued. Attribution only: it never changes a call, its params,
 * order or timing. Anything untagged (UI handlers, standby daemon, ...) is
 * 'other'. Used by the fair lane only when comms.speedup.laneFairness is on.
 */

const ORIGINS = Object.freeze(['dmAutoReply', 'channelWatch', 'dmNotify', 'other']);

let _als = null;
try {
  const { AsyncLocalStorage } = require('async_hooks');
  _als = new AsyncLocalStorage();
} catch (_) { _als = null; }

// Transparent: returns fn()'s value/promise unchanged and rethrows sync throws unchanged.
function runWithOrigin(origin, fn) {
  if (!_als) return fn();
  return _als.run({ origin }, fn);
}

function currentOrigin() {
  try {
    const s = _als ? _als.getStore() : null;
    const o = s && s.origin;
    return ORIGINS.includes(o) ? o : 'other';
  } catch (_) { return 'other'; }
}

module.exports = { ORIGINS, runWithOrigin, currentOrigin, __test__: { reset() {} } };
