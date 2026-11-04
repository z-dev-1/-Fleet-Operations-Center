'use strict';
/**
 * slack/fair-lane.js — fair single-server Slack Web API lane.
 *
 * Used by slack_send.slackWebApi ONLY when comms.speedup.laneFairness is on
 * AND the S5/S6 lane is not selected (laneConcurrency 1, laneTierPacing off).
 * With the flag off this module is never required.
 *
 * It only REORDERS queued calls. Every enqueued job is served exactly once by
 * `serve` (slack_send._fairServe, a verbatim copy of today's attempt loop:
 * 350 ms start spacing, 429 Retry-After backoff slept inside the job, max 4
 * retries). Nothing is skipped, cached, merged or re-sent.
 *
 * Policy:
 *   - at most one job in service (`busy`); retries stay inside the job, so a
 *     429 holds the whole lane exactly as today;
 *   - writes (anything not in READ_METHODS) go to one global FIFO with strict
 *     priority over reads;
 *   - reads go to one FIFO per origin, served plain round-robin in ORIGINS order.
 * Ordering contract: (O1) same-origin reads start in enqueue order; (O2) writes
 * start in global enqueue order; (O3) a read never starts before an
 * earlier-enqueued write (a write may start before earlier reads).
 *
 * Under a saturated lane a sequential origin gets about 1 slot in 2. Its run is
 * shorter only by the backlog it no longer waits behind; its first call starts
 * within one job instead of behind the whole burst. Total rate is unchanged.
 *
 * Errors: a rejection from `serve` (any cause) rejects that job only, no log.
 * '[slack] fair lane error: <msg>' is logged only for exceptions thrown by the
 * lane's own code (selection in _pump, hooks); the lane keeps pumping.
 */

const { ORIGINS } = require('./lane-origin');

function createFairLane(opts = {}) {
  const serve = opts.serve;
  const isWrite = typeof opts.isWrite === 'function' ? opts.isWrite : () => true;
  const now = opts.now || (() => Date.now());
  const logger = opts.logger || { warn() {} };
  const hooks = opts.hooks || {};

  const writeQ = [];
  const queues = new Map(ORIGINS.map((o) => [o, []]));
  let rr = 0;
  let busy = false;
  let current = null;   // the job in service (selected; `started` set by serve at attempt 0)

  function _laneError(e) {
    try { logger.warn('[slack] fair lane error: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
  }
  function _hook(name, ...args) {
    const fn = hooks[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) { _laneError(e); }
  }
  function _readsQueued() {
    for (const q of queues.values()) if (q.length) return true;
    return false;
  }
  function _queuedCount() {
    let n = writeQ.length;
    for (const q of queues.values()) n += q.length;
    return n;
  }

  // Pure selection: strict write priority, then round-robin over origins.
  function _take() {
    if (writeQ.length) {
      const job = writeQ.shift();
      job._overtook = _readsQueued();
      return job;
    }
    for (let i = 0; i < ORIGINS.length; i++) {
      const idx = (rr + i) % ORIGINS.length;
      const q = queues.get(ORIGINS[idx]);
      if (q.length) {
        rr = (idx + 1) % ORIGINS.length;
        const job = q.shift();
        job._overtook = false;
        return job;
      }
    }
    return null;
  }

  function _settle(job, ok, v) {
    if (ok) job.resolve(v); else job.reject(v);
    busy = false; current = null;
    _pump();
  }

  function _pump() {
    if (busy) return;
    let job;
    try { job = _take(); } catch (e) { _laneError(e); return; }
    if (!job) return;
    busy = true; current = job;
    _hook('onDequeue', job.origin, job.isWrite, job._overtook);
    // Microtask hop mirrors today's _slackChain.then(...).
    Promise.resolve().then(() => serve(job)).then(
      (res) => _settle(job, true, res),
      (err) => _settle(job, false, err));
  }

  function enqueue(method, params, origin) {
    const o = ORIGINS.includes(origin) ? origin : 'other';
    return new Promise((resolve, reject) => {
      const job = { method, params, origin: o, isWrite: !!isWrite(method), enqAt: now(), started: false, resolve, reject };
      if (job.isWrite) writeQ.push(job); else queues.get(o).push(job);
      // totalDepth = queued jobs + the selected-but-not-started job (today's _depth).
      _hook('onEnqueue', o, job.isWrite, _queuedCount() + (current && !current.started ? 1 : 0));
      _pump();
    });
  }

  function _snapshot() {
    const q = {};
    for (const [o, arr] of queues) q[o] = arr.length;
    return { busy, writes: writeQ.length, reads: q, rr };
  }

  return { enqueue, _snapshot };
}

module.exports = { createFairLane };
