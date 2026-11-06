'use strict';
/**
 * email-intel/understand/ai-queue.js — the scan's AI call queue (design 3.10; F-17, R8.4, NFR-9, F2-06).
 *
 *   createQueue({ concurrency, budget, signal, deadlineAt, laneState, now }) -> queue
 *     queue.run(fn, { priority }) -> Promise<{ ok:true, value } | { ok:false, dropped:'aborted'|'degraded'|'budget'|'deadline'|'stopped' }>
 *     queue.stop(reason) / queue.stats()
 *
 * FIFO within a priority (higher priority first) with AI_CONCURRENCY in flight (config 1..2, hard
 * AI_CONCURRENCY_HARD), so a scan holds at most that many Claude pool workers. When a call finishes
 * the next one starts immediately: a scan's calls run back to back (F2-06). Before each dequeue the
 * queue checks, in order: the abort signal, the lane state ('degraded' / 'unavailable' stop AI for
 * the scan), the call budget, and the scan deadline (fewer than AI_CALL_TIMEOUT_MS left). A dropped
 * item never runs; its message stays pending for a later scan. There is no Promise.all anywhere.
 */
const C = require('../constants');

function createQueue(opts) {
  const o = opts || {};
  const concurrency = Math.max(1, Math.min(C.AI_CONCURRENCY_HARD, Number.isFinite(o.concurrency) ? Math.trunc(o.concurrency) : C.AI_CONCURRENCY));
  const budget = Math.max(0, Math.min(C.AI_CALLS_HARD, Number.isFinite(o.budget) ? Math.trunc(o.budget) : C.AI_CALLS_DEFAULT));
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const laneState = typeof o.laneState === 'function' ? o.laneState : () => 'unknown';
  const pending = [];
  let seq = 0;
  let inFlight = 0;
  let started = 0;
  let stopped = null;
  const st = { started: 0, completed: 0, dropped: 0, maxInFlight: 0, droppedBy: {} };

  function _blocker() {
    if (stopped) return stopped;
    if (o.signal && o.signal.aborted) return 'aborted';
    const ls = laneState();
    if (ls === 'degraded' || ls === 'unavailable') return 'degraded';
    if (started >= budget) return 'budget';
    if (Number.isFinite(o.deadlineAt) && now() + C.AI_CALL_TIMEOUT_MS > o.deadlineAt) return 'deadline';
    return null;
  }

  function _drop(item, reason) {
    st.dropped++; st.droppedBy[reason] = (st.droppedBy[reason] || 0) + 1;
    item.resolve({ ok: false, dropped: reason });
  }

  function _pump() {
    while (inFlight < concurrency && pending.length) {
      const why = _blocker();
      if (why) { while (pending.length) _drop(pending.shift(), why); return; }
      const item = pending.shift();
      inFlight++; started++; st.started++;
      st.maxInFlight = Math.max(st.maxInFlight, inFlight);
      let p;
      try { p = Promise.resolve(item.fn()); } catch (e) { p = Promise.reject(e); }
      p.then((value) => { item.resolve({ ok: true, value }); }, (error) => { item.resolve({ ok: false, error }); })
        .then(() => { inFlight--; st.completed++; _pump(); });
    }
  }

  function run(fn, ro) {
    return new Promise((resolve) => {
      const item = { fn, resolve, priority: ro && Number.isFinite(ro.priority) ? ro.priority : 0, seq: seq++ };
      const why = _blocker();
      if (why) { _drop(item, why); return; }
      // Higher priority first; FIFO among equals.
      let i = pending.length;
      while (i > 0 && pending[i - 1].priority < item.priority) i--;
      pending.splice(i, 0, item);
      _pump();
    });
  }

  function stop(reason) { stopped = reason || 'stopped'; while (pending.length) _drop(pending.shift(), stopped); }

  function blocked() { return _blocker(); }

  return { run, stop, blocked, stats: () => Object.assign({ concurrency, budget, inFlight, queued: pending.length }, st, { droppedBy: Object.assign({}, st.droppedBy) }) };
}

module.exports = { createQueue };
