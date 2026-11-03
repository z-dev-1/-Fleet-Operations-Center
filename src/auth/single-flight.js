'use strict';
/**
 * src/auth/single-flight.js — generic single-flight slot (Phase 9, auth.singleFlight).
 *
 * One attempt in flight at a time; concurrent callers share its settled value
 * (or rejection). Used by src/scrapers/auth.js for probeSession (one hidden
 * BrowserWindow) and refreshAeaSilently (one silent refresh) when the
 * auth.singleFlight flag is on. With the flag off the wrappers never call this.
 *
 * Slot release: the slot clears when the attempt resolves or rejects (identity
 * checked, so a replaced slot can never clear its successor). The helper never
 * releases a slot early — the inner timers of the wrapped function bound normal
 * durations (probe 25 s hard timeout).
 *
 * Bounded waits (FR-5): every JOINER (same generation, not fresh) and every
 * WAITER (generation mismatch or `fresh`) races the slot against a stale
 * deadline at slot.startedAt + staleMs on the injected monotonic clock. At the
 * deadline the first waker logs an error, starts ONE replacement attempt, and
 * the remaining wakers join it.
 *
 * The OWNER — the caller whose run() started an attempt — is NOT released by
 * the stale deadline: it awaits its own attempt exactly as it would calling the
 * implementation directly today (parity). Only joiners and waiters are released.
 *
 * Counters (stats()): started, joined, waited, staleBroken, rejected. Each run()
 * call is counted as joined OR waited at most once, even when it loops (early
 * deadline timer, generation change, fresh).
 *
 * now / setTimer / clearTimer are called through the option functions on every
 * use (never cached) so callers can late-bind them (tests inject fake clocks).
 */

const STALE = Symbol('stale');

/**
 * @param {object} o
 * @param {string} o.name        label for the stale-break log line
 * @param {number} o.staleMs     stale deadline measured from the slot's start
 * @param {object} [o.log]       logger with .error()
 * @param {Function} [o.now]     monotonic ms clock
 * @param {Function} [o.setTimer]   (fn, ms) -> handle
 * @param {Function} [o.clearTimer] (handle) -> void
 * @returns {{ run: Function, inFlight: Function, stats: Function, _reset: Function }}
 *   run(fn, { fresh=false, gen=null }) -> Promise. gen: () => number|null.
 *   The owner (the call that starts an attempt) awaits that attempt with no
 *   deadline; joiners/waiters are released at the stale deadline.
 */
function createSingleFlight(o) {
  const opts = o || {};
  const name = opts.name || 'single-flight';
  const staleMs = opts.staleMs;
  const log = opts.log || { error() {} };
  const now = () => (opts.now ? opts.now() : performance.now());
  const setTimer = (fn, ms) => (opts.setTimer ? opts.setTimer(fn, ms) : setTimeout(fn, ms));
  const clearTimer = (h) => (opts.clearTimer ? opts.clearTimer(h) : clearTimeout(h));

  let slot = null;
  let started = 0, joined = 0, waited = 0, staleBroken = 0, rejected = 0;

  // Resolves STALE at s.startedAt + staleMs. cancel() clears the timer.
  function _untilStale(s) {
    const ms = Math.max(0, s.startedAt + staleMs - now());
    let h;
    const p = new Promise((r) => {
      h = setTimer(() => r(STALE), ms);
      if (h && typeof h.unref === 'function') h.unref();
    });
    return { p, cancel: () => clearTimer(h) };
  }

  // The slot is assigned BEFORE fn() runs, so a synchronous re-entrant run()
  // from inside fn sees it and joins instead of starting a second attempt.
  function _start(fn, curGen) {
    let resolveP, rejectP;
    const promise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    const s = { promise, startedAt: now(), gen: curGen };
    slot = s; started++;
    const clear = () => { if (slot === s) slot = null; };
    promise.then(clear, () => { rejected++; clear(); });
    try { Promise.resolve(fn()).then(resolveP, rejectP); } catch (e) { rejectP(e); }
    return s;
  }

  async function run(fn, runOpts) {
    const fresh = !!(runOpts && runOpts.fresh);
    const gen = (runOpts && typeof runOpts.gen === 'function') ? runOpts.gen : null;
    const requestedAt = now();
    let counted = false;
    for (;;) {
      const curGen = gen ? gen() : null;
      if (!slot) return _start(fn, curGen).promise;                       // owner
      const age = now() - slot.startedAt;
      if (age >= staleMs) {
        log.error('[AuthManager] single-flight ' + name + ' slot stale (age ' + Math.round(age / 1000) +
          's) — starting a new attempt; previous attempt left running');
        staleBroken++;
        return _start(fn, curGen).promise;                                // owner of the replacement
      }
      const joinable = (curGen === null || slot.gen === curGen) && (!fresh || slot.startedAt >= requestedAt);
      const s = slot;
      const d = _untilStale(s);
      if (joinable) {
        if (!counted) { joined++; counted = true; }
        const out = await Promise.race([s.promise.then((v) => ({ v }), (e) => ({ e })), d.p]);
        d.cancel();
        if (out === STALE) continue;   // first waker breaks the stale slot, the rest join its replacement
        if ('e' in out) throw out.e;
        return out.v;
      }
      if (!counted) { waited++; counted = true; }
      await Promise.race([s.promise.then(() => {}, () => {}), d.p]);
      d.cancel();
    }
  }

  return {
    run,
    inFlight: () => !!slot,
    stats: () => ({ started, joined, waited, staleBroken, rejected }),
    _reset: () => { slot = null; started = 0; joined = 0; waited = 0; staleBroken = 0; rejected = 0; },
  };
}

module.exports = { createSingleFlight };
