'use strict';
/**
 * slack/web-api-lane.js — Phase 4b bounded, tier-paced Slack Web API lane.
 *
 * Used by slack_send.slackWebApi ONLY when settings.comms.speedup.laneConcurrency
 * > 1 or laneTierPacing is on (memoized once per process). With the defaults,
 * slack_send keeps today's single serialized chain and this module is unused.
 *
 * Semantics (design §5.2):
 *   1. At most `concurrency` (K) requests in flight.
 *   2. Consecutive starts ≥ minIntervalMs apart across the whole lane.
 *   3. Pacing: each method has a 60 s sliding window of starts capped at its
 *      Slack tier floor (TIER_PER_MIN, else DEFAULT_BUDGET_PER_MIN). A read
 *      whose method is out of budget may be overtaken by other READS only.
 *      K > 1 always forces pacing on.
 *   4. FIFO: without budget skips requests start in enqueue order; eligible
 *      retries go first.
 *   5. Writes (anything not in READ_METHODS) are exclusive barriers: a write
 *      starts only when nothing is in flight and nothing enqueued before it is
 *      still pending, and nothing enqueued after it starts before it settles.
 *   6. 429: lane-wide pause until now + backoff (today's formula), the request
 *      is retried (each attempt is a start); after maxRetries it resolves
 *      { ok:false, error:'ratelimited' } with today's warn text.
 *   7. Network errors / timeouts reject that caller's promise (no retry).
 *   8. One timer at most, unref'd; none left once the queue drains.
 */

// Slack published tier floors (Tier 2 = 20, Tier 3 = 50, Tier 4 = 100) per minute.
const TIER_PER_MIN = Object.freeze({
  'conversations.history': 50, 'conversations.replies': 50, 'conversations.info': 50,
  'conversations.list': 20,
  'conversations.members': 100, 'users.info': 100,
  'users.lookupByEmail': 50,
  'client.counts': 50, 'auth.test': 100, 'search.modules': 20, 'files.info': 100,
});
const DEFAULT_BUDGET_PER_MIN = 50;
// Methods deliberately left to DEFAULT_BUDGET_PER_MIN (all are writes, not reads).
const DEFAULT_BUDGET_METHODS = Object.freeze(['chat.postMessage', 'conversations.open',
  'files.getUploadURLExternal', 'files.completeUploadExternal']);
const READ_METHODS = Object.freeze(new Set([
  'conversations.history', 'conversations.replies', 'conversations.info', 'conversations.list',
  'conversations.members', 'client.counts', 'users.info', 'users.lookupByEmail', 'auth.test',
  'search.modules', 'files.info',
]));
const WINDOW_MS = 60000;

function createLane(opts = {}) {
  const K = Number.isInteger(opts.concurrency) && opts.concurrency >= 1 ? opts.concurrency : 1;
  const pacing = K > 1 ? true : opts.pacing === true;
  const minIntervalMs = typeof opts.minIntervalMs === 'number' ? opts.minIntervalMs : 350;
  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 4;
  const request = opts.request;
  const isRead = typeof opts.isRead === 'function' ? opts.isRead : (m) => READ_METHODS.has(m);
  const budgets = opts.budgets || TIER_PER_MIN;
  const defaultBudget = typeof opts.defaultBudget === 'number' ? opts.defaultBudget : DEFAULT_BUDGET_PER_MIN;
  const now = opts.now || (() => Date.now());
  const st = opts.setTimeout || setTimeout;
  const ct = opts.clearTimeout || clearTimeout;
  const random = opts.random || Math.random;
  const logger = opts.logger || { info() {}, warn() {} };
  const hooks = opts.hooks || {};
  const _hook = (name, ...a) => { try { if (typeof hooks[name] === 'function') hooks[name](...a); } catch (_) {} };

  const queue = [];     // main FIFO
  const retryQ = [];    // retry FIFO (served first among eligible)
  const windows = new Map(); // method -> start times within the last WINDOW_MS
  let seq = 0;
  let inFlight = 0;
  let writeInFlight = false;
  let lastStart = null;
  let pausedUntil = 0;
  let timer = null;

  const budgetOf = (m) => (Object.prototype.hasOwnProperty.call(budgets, m) ? budgets[m] : defaultBudget);

  function _window(m, t) {
    let w = windows.get(m);
    if (!w) { w = []; windows.set(m, w); }
    while (w.length && w[0] <= t - WINDOW_MS) w.shift();
    if (!w.length) windows.delete(m);
    return w;
  }
  // null when the method may start now, else the time its oldest start leaves the window.
  function _budgetBlockedUntil(m, t) {
    if (!pacing) return null;
    const w = _window(m, t);
    if (w.length < budgetOf(m)) return null;
    return w[0] + WINDOW_MS;
  }
  function _pending() { return queue.concat(retryQ); }
  function _orderOk(job, pend) {
    if (job.read) {
      if (writeInFlight) return false;
      return !pend.some(p => p !== job && !p.read && p.seq < job.seq);
    }
    if (inFlight > 0) return false;
    return !pend.some(p => p !== job && p.seq < job.seq);
  }

  function _schedule(at) {
    if (timer) { ct(timer); timer = null; }
    const delay = Math.max(0, at - now());
    timer = st(() => { timer = null; _pump(); }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function _pick(t) {
    const pend = _pending();
    let earliest = null;
    const noteBlocked = (job, until) => {
      if (!job._budgetDelayed) { job._budgetDelayed = true; _hook('onBudgetDelay', job.method); }
      if (earliest === null || until < earliest) earliest = until;
    };
    for (const job of retryQ) {
      if (!_orderOk(job, pend)) continue;
      const until = _budgetBlockedUntil(job.method, t);
      if (until !== null) { noteBlocked(job, until); continue; }
      return { job, from: retryQ };
    }
    for (const job of queue) {
      if (!job.read) {
        if (!_orderOk(job, pend)) break;               // write barrier: never scan past it
        const until = _budgetBlockedUntil(job.method, t);
        if (until !== null) { noteBlocked(job, until); break; }
        return { job, from: queue };
      }
      if (!_orderOk(job, pend)) break;                 // behind a pending write
      const until = _budgetBlockedUntil(job.method, t);
      if (until !== null) { noteBlocked(job, until); continue; }
      return { job, from: queue };
    }
    return earliest !== null ? { waitUntil: earliest } : null;
  }

  function _pump() {
    if (timer) { ct(timer); timer = null; }
    for (;;) {
      if (!queue.length && !retryQ.length) return;
      if (inFlight >= K || writeInFlight) return;
      const t = now();
      if (t < pausedUntil) { _schedule(pausedUntil); return; }
      if (lastStart !== null && t < lastStart + minIntervalMs) { _schedule(lastStart + minIntervalMs); return; }
      const p = _pick(t);
      if (!p) return;                                  // waiting on in-flight work (settle re-pumps)
      if (p.waitUntil !== undefined) { _schedule(p.waitUntil); return; }
      p.from.splice(p.from.indexOf(p.job), 1);
      _start(p.job, t);
    }
  }

  function _start(job, t) {
    inFlight++;
    if (!job.read) writeInFlight = true;
    lastStart = t;
    let w = windows.get(job.method);
    if (!w) { w = []; windows.set(job.method, w); }
    w.push(t);
    _hook('onStart', job.method, job.attempt === 0 ? t - job.enqAt : 0, inFlight, queue.length + retryQ.length);
    let p;
    try { p = Promise.resolve(request(job.method, job.params)); } catch (e) { p = Promise.reject(e); }
    p.then((res) => {
      _settle(job, t);
      if (res && res.__rateLimited) {
        _hook('onRateLimited', job.method);
        if (job.attempt >= maxRetries) {
          _hook('onGiveUp', job.method);
          logger.warn('[slack] ' + job.method + ' rate-limited after ' + (maxRetries + 1) + ' attempts — giving up');
          job.resolve({ ok: false, error: 'ratelimited' });
        } else {
          const backoff = res.retryAfter != null
            ? (res.retryAfter * 1000 + 250)
            : (Math.pow(2, job.attempt) * 1000 + Math.floor(random() * 300));
          logger.info('[slack] ' + job.method + ' 429 — backing off ' + Math.round(backoff) + 'ms (attempt ' + (job.attempt + 1) + ')');
          pausedUntil = Math.max(pausedUntil, now() + backoff);
          job.attempt++;
          _hook('onRetry', job.method);
          retryQ.push(job);
        }
      } else {
        job.resolve(res);
      }
      _pump();
    }, (err) => {
      _settle(job, t);
      job.reject(err);
      _pump();
    });
  }

  function _settle(job, startedAt) {
    inFlight--;
    if (!job.read) writeInFlight = false;
    _hook('onSettle', job.method, now() - startedAt);
  }

  function enqueue(method, params) {
    return new Promise((resolve, reject) => {
      queue.push({ seq: ++seq, method, params, resolve, reject, attempt: 0, read: !!isRead(method), enqAt: now() });
      _hook('onEnqueue', queue.length + retryQ.length);
      _pump();
    });
  }

  function _state() {
    return { inFlight, queued: queue.length, retries: retryQ.length, pausedUntil, hasTimer: !!timer,
      concurrency: K, pacing, writeInFlight };
  }

  return { enqueue, _state, concurrency: K, pacing };
}

module.exports = { createLane, TIER_PER_MIN, DEFAULT_BUDGET_PER_MIN, DEFAULT_BUDGET_METHODS, READ_METHODS, WINDOW_MS };
